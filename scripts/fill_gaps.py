"""scripts/fill_gaps.py — 用第二数据源补「源端空洞」，并做缩放与连续性校验。

背景：腾讯的美股序列偶尔缺整段（例如纳指 100 的 2021-05-10~05-21、
道指的 2009-07-02~07-29），东方财富在本机网络下不可达，repair.py 补不上。

这个脚本改用**新浪美股日线**补洞（`.DJI` / `.INX` / `.NDX` / 个股代码都能取到）。
两个必须处理的问题：

1. **量纲对齐**：新浪给的是未复权名义价，而站内美股是腾讯的后复权序列。
   对同一资产，两条序列在重叠区间应当只差一个常数因子，所以用重叠日期的
   中位比值做缩放——`scale = median(existing / sina)`。
2. **连续性校验**：补完之后检查拼接处有没有异常跳变（>40%）。
   有跳变说明缩放或数据有问题，那就**拒绝写入**，宁可留洞也不污染序列。

用法：
    py scripts/fill_gaps.py               # 补 quality.json 里所有美股源端空洞
    py scripts/fill_gaps.py --only us.NDX # 只补指定资产
    py scripts/fill_gaps.py --dry-run
"""

from __future__ import annotations

import argparse
import json
import os
import re
import statistics
from datetime import date
import sys
import time
import urllib.request
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from scripts.registry import DATA_DIR, HISTORY_DIR, ensure_import_path, load_asset_defs  # noqa: E402

ensure_import_path()

QUALITY = os.path.join(DATA_DIR, "quality.json")
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
SINA_URL = (
    "https://stock.finance.sina.com.cn/usstock/api/jsonp.php/var%20_=/"
    "US_MinKService.getDailyK?symbol={symbol}"
)
# 腾讯代码 → 新浪代码（指数要用点号前缀）
SINA_SYMBOL = {
    "us.INX": ".INX",
    "us.DJI": ".DJI",
    "us.NDX": ".NDX",
    "us.IXIC": ".IXIC",
}
MAX_JUMP = 0.40  # 拼接处允许的最大单日跳变


def http_get(url: str, retries: int = 3) -> Optional[bytes]:
    last = ""
    for attempt in range(retries):
        try:
            req = urllib.request.Request(
                url, headers={"User-Agent": UA, "Referer": "https://finance.sina.com.cn/"}
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.read()
        except Exception as exc:  # noqa: BLE001
            last = f"{type(exc).__name__}: {exc}"
            time.sleep(1.5 * (attempt + 1))
    print(f"  [fill] 放弃 {url[-40:]} … {last}", flush=True)
    return None


def fetch_sina(symbol: str) -> dict[str, float]:
    raw = http_get(SINA_URL.format(symbol=symbol))
    if raw is None:
        return {}
    text = raw.decode("utf-8", errors="replace")
    start, end = text.find("["), text.rfind("]")
    if start < 0 or end <= start:
        return {}
    try:
        rows = json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return {}

    out: dict[str, float] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        date = row.get("d")
        try:
            close = float(row["c"])
        except (KeyError, TypeError, ValueError):
            continue
        if isinstance(date, str) and len(date) == 10 and close > 0:
            out[date] = close
    return out


def sina_symbol_for(asset) -> str:
    if asset.code in SINA_SYMBOL:
        return SINA_SYMBOL[asset.code]
    # us.AAPL.OQ → AAPL
    parts = asset.code.split(".")
    return parts[1] if len(parts) > 1 else asset.code


def collect_gaps(quality: dict) -> dict[str, list[dict]]:
    """从 quality.json 的警告里挑出「源端空洞」，只保留美股（新浪能补的就是美股）。"""
    pattern = re.compile(
        r"（(?P<kind>\w+) (?P<symbol>[\w.]+)）.*?连续缺 (?P<missing>\d+) 个交易日"
        r"（(?P<start>\d{4}-\d{2}-\d{2}) ~ (?P<end>\d{4}-\d{2}-\d{2})）"
    )
    gaps: dict[str, list[dict]] = {}
    for warning in quality.get("warnings", []):
        # 指数/ETF 的措辞是「疑似数据源空洞」，个股是「多为停牌或数据源空洞」。
        # 美股个股不存在涨跌停式停牌，所以两种措辞都收，只要标的是美股。
        if "数据源空洞" not in warning:
            continue
        match = pattern.search(warning)
        if not match:
            continue
        symbol = match.group("symbol")
        # 只处理美股：新浪的美股接口补不了中证指数与 A 股
        if not symbol.startswith("us."):
            continue
        gaps.setdefault(symbol, []).append(
            {
                "missing": int(match.group("missing")),
                "start": match.group("start"),
                "end": match.group("end"),
            }
        )
    return gaps


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", default="", help="逗号分隔的资产代码，例如 us.NDX,us.DJI")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    assets = {(a.type.value, a.symbol): a for a in load_asset_defs()}
    quality = json.load(open(QUALITY, encoding="utf-8"))
    gaps = collect_gaps(quality)
    wanted = [x.strip() for x in args.only.split(",") if x.strip()]
    if wanted:
        gaps = {k: v for k, v in gaps.items() if k in wanted}

    if not gaps:
        print("没有需要补的源端空洞。")
        return 0

    total_filled = 0
    total_skipped = 0
    for symbol, runs in sorted(gaps.items()):
        asset = assets.get(("index", symbol)) or assets.get(("stock", symbol)) or assets.get(("etf", symbol))
        if not asset:
            print(f"[跳过] {symbol}：登记表里找不到")
            continue

        path = os.path.join(HISTORY_DIR, f"{asset.type.value}_{symbol}.json")
        if not os.path.exists(path):
            print(f"[跳过] {symbol}：没有历史文件")
            continue
        payload = json.load(open(path, encoding="utf-8"))
        existing = dict(zip(payload["dates"], payload["prices"]))

        sina = fetch_sina(sina_symbol_for(asset))
        time.sleep(0.6)
        if not sina:
            print(f"[失败] {symbol}：新浪没有数据")
            continue

        overlap = [d for d in existing if d in sina]
        if len(overlap) < 30:
            print(f"[跳过] {symbol}：与新浪的重叠只有 {len(overlap)} 天，无法可靠缩放")
            total_skipped += len(runs)
            continue

        global_scale = statistics.median(existing[d] / sina[d] for d in overlap if sina[d] > 0)
        print(f"[{symbol}] 重叠 {len(overlap)} 天，全局比值中位数 {global_scale:.6f}，待补 {len(runs)} 段")

        filled = 0
        for run in runs:
            # 洞两侧的锚点：用邻域的比值做线性漂移校正。
            # 个股有拆股（TSLA 2020 5:1、2022 3:1），整段时间的比值不是常数，
            # 但在洞的邻域内是常数——所以只能局部锚定，不能全局缩放。
            before = max((d for d in existing if d < run["start"]), default=None)
            after = min((d for d in existing if d > run["end"]), default=None)
            if not before or not after or before not in sina or after not in sina:
                print(f"    {run['start']} ~ {run['end']}：找不到两侧锚点，跳过")
                total_skipped += 1
                continue

            r0 = existing[before] / sina[before]
            r1 = existing[after] / sina[after]
            t0 = date.fromisoformat(before).toordinal()
            t1 = date.fromisoformat(after).toordinal()

            def ratio_at(d: str) -> float:
                weight = (date.fromisoformat(d).toordinal() - t0) / max(1, t1 - t0)
                return r0 * (r1 / r0) ** weight

            added = [
                (d, p * ratio_at(d))
                for d, p in sina.items()
                if run["start"] <= d <= run["end"] and d not in existing
            ]
            if not added:
                print(f"    {run['start']} ~ {run['end']}：新浪也没有这段")
                total_skipped += 1
                continue

            merged = dict(existing)
            merged.update(dict(added))
            dates = sorted(merged)

            # 连续性校验：整条序列的最大单日跳变不能超过阈值
            worst = 0.0
            worst_date = ""
            for i in range(1, len(dates)):
                prev, cur = merged[dates[i - 1]], merged[dates[i]]
                if prev <= 0:
                    continue
                jump = abs(cur / prev - 1)
                if jump > worst:
                    worst, worst_date = jump, dates[i]

            if worst > MAX_JUMP:
                print(
                    f"    {run['start']} ~ {run['end']}：补入 {len(added)} 天后出现 {worst:.1%} 的跳变"
                    f"（{worst_date}），拒绝写入"
                )
                total_skipped += 1
                continue

            existing = merged
            filled += len(added)
            print(f"    {run['start']} ~ {run['end']}：补入 {len(added)} 天（最大跳变 {worst:.1%}）")

        if filled and not args.dry_run:
            dates = sorted(existing)
            payload["dates"] = dates
            payload["prices"] = [round(existing[d], 6) for d in dates]
            payload["start"] = dates[0]
            payload["end"] = dates[-1]
            payload["count"] = len(dates)
            payload["last_close"] = payload["prices"][-1]
            with open(path, "w", encoding="utf-8", newline="\n") as f:
                json.dump(payload, f, ensure_ascii=False)
                f.write("\n")
            print(f"    → 已写入 {symbol}：{len(dates)} 条")
        total_filled += filled

    print()
    print("=" * 56)
    print(f"补洞完成：补入 {total_filled} 条，跳过 {total_skipped} 段" + ("（dry-run，未写入）" if args.dry_run else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())