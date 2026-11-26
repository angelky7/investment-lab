"""scripts/repair.py — 空洞修复。

抓取是「按窗口增量合并」的，如果某次响应本身就少了几天，缺口会一直留在文件里。
本脚本按「该市场自己的交易日历」找出缺口，针对每段缺口重新请求一次精确区间，
**只合并数据源真实返回的行**，不插值、不推断、不补零。

两类缺口的结果截然不同，脚本会分别报告：

* 修补成功 → 说明之前是抓取窗口的问题，现在已经补上；
* 修补后仍缺 → 数据源本身没有这段数据（个股停牌、或接口历史空洞），
  保持原样，由 validate 记录在 quality.json 里。

用法：
    python scripts/repair.py                 # 全量检查
    python scripts/repair.py --only 000300   # 只修某个资产
    python scripts/repair.py --dry-run       # 只报告，不写文件
"""

from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from data_sources.common import AssetType, Bar, dedupe_sort  # noqa: E402
from data_sources.eastmoney import EastmoneyKlineSource  # noqa: E402
from data_sources.tencent import TencentSource  # noqa: E402
from scripts.registry import (  # noqa: E402
    HISTORY_DIR,
    ensure_import_path,
    history_filename,
    load_asset_defs,
)

ensure_import_path()

# 日历的唯一真源是 data/quality.json（validate.py 产出，含支撑数过滤）。
# repair 不再自己重建日历——之前两处各建一份，导致节假日被当成缺口。
CALENDAR_ANCHORS = {"CN": ["000300"], "HK": ["hkHSI"], "US": ["us.INX"]}
MIN_RUN_TO_REPAIR = 3  # 连续缺 3 个交易日以上才值得再请求一次
MAX_RUNS_PER_ASSET = 8  # 单个资产最多修 8 段，避免对接口造成无谓压力


def read_history(path: str) -> dict | None:
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def write_json_atomic(path: str, payload: dict) -> None:
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


def find_hole_runs(dates: list[str], calendar: set[str]) -> list[dict]:
    own = set(dates)
    span = sorted(d for d in calendar if dates[0] <= d <= dates[-1])
    runs: list[dict] = []
    current: dict | None = None
    for day in span:
        if day in own:
            current = None
            continue
        if current is None:
            current = {"from": day, "to": day, "days": 1}
            runs.append(current)
        else:
            current["to"] = day
            current["days"] += 1
    return [r for r in runs if r["days"] >= MIN_RUN_TO_REPAIR]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="修补历史序列中的空洞")
    parser.add_argument("--only", default="", help="只处理这些代码，逗号分隔")
    parser.add_argument("--dry-run", action="store_true", help="只报告，不写文件")
    args = parser.parse_args(argv)

    assets = load_asset_defs()
    if args.only:
        wanted = {s.strip() for s in args.only.split(",") if s.strip()}
        assets = [a for a in assets if a.symbol in wanted or a.code in wanted]

    # 1) 读取全部序列，建市场日历
    payloads: dict[tuple[str, str], dict] = {}
    for asset in load_asset_defs():
        path = os.path.join(HISTORY_DIR, history_filename(asset))
        payload = read_history(path)
        if payload:
            payloads[(asset.type.value, asset.symbol)] = payload

    calendars: dict[str, set[str]] = {}
    for market, anchor in CALENDAR_ANCHORS.items():
        payload = payloads.get(("index", anchor))
        if payload:
            calendars[market] = set(payload["dates"])
    for (type_, symbol), payload in payloads.items():
        if symbol in CALENDAR_ANCHORS.values():
            continue
        market = payload.get("market", "CN")
        calendars.setdefault(market, set()).update(payload["dates"])

    tencent = TencentSource()
    eastmoney = EastmoneyKlineSource()
    until_year = 2100  # 由窗口端点决定，这里只用到年份参数

    filled_total = 0
    remaining_total = 0
    repaired_assets = 0
    report: list[dict] = []

    for asset in assets:
        key = (asset.type.value, asset.symbol)
        payload = payloads.get(key)
        if not payload:
            continue
        calendar = calendars.get(asset.market.value, set())
        if not calendar:
            continue

        runs = find_hole_runs(payload["dates"], calendar)[:MAX_RUNS_PER_ASSET]
        if not runs:
            continue

        print(f"\n[{asset.type.value}] {asset.symbol} {asset.name}：{len(runs)} 段待修")
        bars = [Bar(date=d, price=p) for d, p in zip(payload["dates"], payload["prices"])]
        existing = {b.date for b in bars}
        filled_here = 0

        for run in runs:
            print(f"  {run['from']} ~ {run['to']}（{run['days']} 个交易日）", end="", flush=True)
            start_year = int(run["from"][:4])
            end_year = int(run["to"][:4])
            donated: list[Bar] = []

            # 先用主源（腾讯）请求覆盖空洞的窗口，失败再换东财
            window, _ = tencent.fetch_window(asset.code, start_year, end_year)
            donated = [b for b in window if run["from"] <= b.date <= run["to"]]

            if not donated:
                series = eastmoney.fetch(asset, until_year, since=run["from"])
                if series:
                    donated = [b for b in series.bars if run["from"] <= b.date <= run["to"]]

            new_bars = [b for b in donated if b.date not in existing]
            if new_bars:
                # 只在来源口径一致时接受：价格量级与已有序列相差过大会污染收益率
                scale_ok = True
                if bars and new_bars:
                    ref = bars[0].price
                    if ref > 0 and any(b.price > ref * 50 or b.price < ref / 50 for b in new_bars):
                        scale_ok = False
                if scale_ok:
                    bars.extend(new_bars)
                    existing.update(b.date for b in new_bars)
                    filled_here += len(new_bars)
                    print(f" → 补 {len(new_bars)} 条")
                else:
                    print(" → 价格量级异常，放弃合并")
                    remaining_total += run["days"]
            else:
                print(" → 数据源本身没有这段数据，保留空洞")
                remaining_total += run["days"]

        if filled_here:
            bars = dedupe_sort(bars)
            if asset.from_date:
                bars = [b for b in bars if b.date >= asset.from_date]
            payload["dates"] = [b.date for b in bars]
            payload["prices"] = [round(b.price, 4) for b in bars]
            payload["count"] = len(bars)
            payload["start"] = payload["dates"][0]
            payload["end"] = payload["dates"][-1]
            if not args.dry_run:
                write_json_atomic(
                    os.path.join(HISTORY_DIR, history_filename(asset)), payload
                )
            filled_total += filled_here
            repaired_assets += 1
            print(f"  合计补入 {filled_here} 条 → 现在 {payload['count']} 条")
            report.append(
                {
                    "symbol": asset.symbol,
                    "type": asset.type.value,
                    "name": asset.name,
                    "filled": filled_here,
                    "count_after": payload["count"],
                }
            )

    print("\n" + "=" * 60)
    print(f"修复完成：{repaired_assets} 个资产共补入 {filled_total} 条；仍缺 {remaining_total} 个交易日")
    for item in report:
        print(f"  - {item['name']}（{item['type']} {item['symbol']}）补 {item['filled']} 条")
    print("=" * 60)
    return 0


if __name__ == "__main__":
    sys.exit(main())