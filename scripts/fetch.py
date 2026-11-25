"""scripts/fetch.py — 数据采集。

按 config/assets.json 抓取全部资产的历史序列，写入
data/history/{type}_{symbol}.json（列式紧凑 JSON）。

两种模式：
* ``--mode full``（默认）：抓取完整历史，覆盖写入。
* ``--mode incremental``：只抓最近 ``--window-days`` 天，与已有文件合并。
  每日 CI 使用这种模式，请求数从 55 降到 55，单次耗时 < 2 分钟。

多数据源兜底：每个资产按登记表 ``source`` 优先，失败后自动换下一个源。
任何单资产失败都不会中断整体流程；失败清单会打印并写入 data/fetch_report.json。

用法：
    python scripts/fetch.py                       # 全量
    python scripts/fetch.py --mode incremental    # 增量
    python scripts/fetch.py --only 000300,600519  # 只抓指定代码
    python scripts/fetch.py --dry-run             # 只列任务
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from data_sources.common import AssetDef, Bar, dedupe_sort  # noqa: E402
from data_sources.eastmoney import EastmoneyFundSource, EastmoneyKlineSource  # noqa: E402
from data_sources.csindex import CsindexSource  # noqa: E402
from data_sources.sina import SinaForexSource  # noqa: E402
from data_sources.tencent import TencentSource, fetch_quote_prices  # noqa: E402
from scripts.registry import (  # noqa: E402
    DATA_DIR,
    HISTORY_DIR,
    ensure_import_path,
    history_filename,
    load_asset_defs,
)

ensure_import_path()

CST = timezone(timedelta(hours=8))
FETCH_REPORT = os.path.join(DATA_DIR, "fetch_report.json")


def now_cst() -> datetime:
    return datetime.now(CST)


def build_providers() -> dict:
    """数据源链：既按资产类型兜底，也支持登记表里声明的 source。"""
    east_kline = EastmoneyKlineSource()
    tencent = TencentSource()
    east_fund = EastmoneyFundSource()
    sina_fx = SinaForexSource()
    csindex = CsindexSource()
    return {
        "by_type": {
            # 腾讯 newfqkline 当前最稳（一次窗口即可拿到完整历史），东方财富作为兜底
            "index": [tencent, east_kline],
            "stock": [tencent, east_kline],
            "etf": [tencent, east_kline],
            "fund": [east_fund],
            "fx": [sina_fx],
        },
        "by_source": {
            # 资产在登记表里声明的 source 优先：中证指数走官网，新浪走外汇接口
            "csindex": [csindex],
            "sina": [sina_fx],
            "tencent": [tencent, east_kline],
            "eastmoney": [east_kline, east_fund],
        },
    }


def read_existing(path: str) -> dict | None:
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return None


def bars_from_payload(payload: dict) -> list[Bar]:
    dates = payload.get("dates") or []
    prices = payload.get("prices") or []
    return [Bar(date=d, price=p) for d, p in zip(dates, prices)]


def write_json_atomic(path: str, payload: dict) -> None:
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        # 紧凑输出：体积比缩进格式小 60% 以上
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="抓取投资实验室历史行情数据")
    parser.add_argument("--mode", choices=["full", "incremental"], default="full")
    parser.add_argument("--window-days", type=int, default=240, help="增量模式回看天数")
    parser.add_argument("--only", default="", help="只抓这些代码（symbol 或 code），逗号分隔")
    parser.add_argument("--since-year", type=int, default=0, help="调试：把起始年份截断到该年")
    parser.add_argument("--dry-run", action="store_true", help="只列任务，不发请求")
    args = parser.parse_args(argv)

    assets = load_asset_defs()
    if args.only:
        wanted = {s.strip() for s in args.only.split(",") if s.strip()}
        assets = [a for a in assets if a.symbol in wanted or a.code in wanted]
        if not assets:
            print(f"没有匹配 --only={args.only} 的资产")
            return 1

    os.makedirs(HISTORY_DIR, exist_ok=True)
    providers = build_providers()
    until_year = now_cst().year
    since_date = ""
    if args.mode == "incremental":
        since_date = (now_cst() - timedelta(days=args.window_days)).strftime("%Y-%m-%d")

    print(f"模式: {args.mode} | 资产: {len(assets)} | 截止年份: {until_year}", flush=True)
    if since_date:
        print(f"增量起点: {since_date}", flush=True)

    # 一次批量快照，用于补齐「最新真实价格」锚点（决定展示价格折算比例）
    quote_codes = []
    for asset in assets:
        if asset.type.value == "fund":
            quote_codes.append(f"jj{asset.code}")
        elif asset.type.value == "fx" or asset.source == "csindex":
            continue  # 汇率与中证指数序列自带最新价，不需要快照
        elif asset.em_secid and asset.code.startswith(("sh", "sz")):
            quote_codes.append(asset.code)
    quotes = fetch_quote_prices(quote_codes) if not args.dry_run else {}
    print(f"行情快照: {len(quotes)} 条", flush=True)

    ok = merged = failed = 0
    failures: list[dict] = []
    started = time.time()

    for index, asset in enumerate(assets, start=1):
        if args.since_year:
            asset.from_year = max(asset.from_year, args.since_year)

        print(f"\n[{index}/{len(assets)}] {asset.symbol} {asset.name} ({asset.type.value})", flush=True)
        if args.dry_run:
            continue
        if asset.source == "derived":
            print("  [跳过] 派生序列，由 build.py 生成", flush=True)
            continue

        path = os.path.join(HISTORY_DIR, history_filename(asset))
        series = None
        used_source = ""

        if asset.type.value == "fund":
            chain = providers["by_type"]["fund"]
        else:
            chain = providers["by_source"].get(asset.source) or providers["by_type"].get(
                asset.type.value, []
            )
        for provider in chain:
            try:
                series = provider.fetch(asset, until_year=until_year, since=since_date)
            except Exception as exc:  # noqa: BLE001 - 单源失败不致命
                print(f"  [{provider.name}] 异常: {exc}", flush=True)
                series = None

            if series and series.bars:
                used_source = provider.name
                break
            print(f"  [{provider.name}] 无数据，尝试下一个源", flush=True)

        if not series or not series.bars:
            print("  [跳过] 所有数据源均无数据", flush=True)
            failures.append({"symbol": asset.symbol, "name": asset.name, "reason": "所有数据源均失败"})
            failed += 1
            continue

        if args.mode == "incremental":
            existing = read_existing(path)
            if existing:
                old = bars_from_payload(existing)
                merged_bars = dedupe_sort([*old, *series.bars])
                series.bars = merged_bars
                merged += 1

        # 补齐展示锚点
        if not series.last_close:
            quote = quotes.get(asset.code) or quotes.get(f"jj{asset.code}")
            if quote:
                series.last_close = quote["price"]

        payload = series.to_json()
        payload["source"] = used_source
        write_json_atomic(path, payload)
        print(
            f"  -> {payload['count']} 条 {payload['start']} ~ {payload['end']}（{used_source}）",
            flush=True,
        )
        ok += 1

    elapsed = time.time() - started
    report = {
        "generated_at": now_cst().isoformat(timespec="seconds"),
        "mode": args.mode,
        "total": len(assets),
        "ok": ok,
        "merged": merged,
        "failed": failed,
        "failures": failures,
        "elapsed_seconds": round(elapsed, 1),
    }
    write_json_atomic(FETCH_REPORT, report)

    print("\n" + "=" * 60)
    print(f"抓取完成：成功 {ok}，合并 {merged}，失败 {failed}，耗时 {elapsed / 60:.1f} 分钟")
    for f in failures:
        print(f"  - {f['symbol']} {f['name']}: {f['reason']}")
    print("=" * 60)

    # 只要有一个成功就返回 0：CI 继续部署，缺失资产由 validate 报告
    return 0 if ok > 0 else 1


if __name__ == "__main__":
    sys.exit(main())