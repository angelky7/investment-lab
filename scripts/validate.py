"""scripts/validate.py — 数据质量校验。

三类检查：

* errors   —— 数据本身坏了（JSON 损坏、日期乱序/重复、价格非正、长度不一致）。
              出现即退出码 1，CI 会标红。
* gaps     —— 相对「该市场自己的交易日历」缺了哪些交易日。
              这是最有用的检查：它能把「停牌」「数据源空洞」「跨市场假期」区分开，
              而不是笼统地说「中间少了一段」。
* warnings —— 数据可用但不完美（缺失资产、点数偏少、整体过期）。

输出 data/quality.json，前端「数据状态」页直接读取。
"""

from __future__ import annotations

import json
import os
import sys
from datetime import date, datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from scripts.registry import (  # noqa: E402
    HISTORY_DIR,
    QUALITY_FILE,
    ensure_import_path,
    history_filename,
    load_asset_defs,
)

ensure_import_path()

MIN_OK_POINTS = 250
STALE_DAYS = 6
CST = timezone(timedelta(hours=8))

# 各市场交易日历的参照资产：优先用流动性最好的指数，避免个别停牌污染日历
# 各市场用来代表交易日历的参照资产。
# CN 用两个锚的**并集**：000001（上证指数，1990-12 起）覆盖早期，
# 000300（沪深300，2005 起）覆盖此后的统一交易日历。
# 之前只用 000300，导致 1990–2004 这 15 年的完整性根本没被检查过。
CALENDAR_ANCHORS = {"CN": ["000001", "000300"], "HK": ["hkHSI"], "US": ["us.INX"]}
# 缺失率分档
COMPLETE_RATIO = 0.005
MINOR_RATIO = 0.03
# 指数/ETF 不可能停牌，缺口超过这个交易日数就值得怀疑数据源
SUSPICIOUS_RUN = 10


def load_history(path: str) -> dict | None:
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def check_integrity(payload: dict, symbol: str) -> tuple[list[str], list[str]]:
    """结构与数值层面的硬错误。"""
    errors: list[str] = []
    warnings: list[str] = []

    dates = payload.get("dates")
    prices = payload.get("prices")
    if not isinstance(dates, list) or not isinstance(prices, list):
        return [f"{symbol}: 缺少 dates/prices 列"], warnings
    if len(dates) != len(prices):
        errors.append(f"{symbol}: dates({len(dates)}) 与 prices({len(prices)}) 长度不一致")
    if not dates:
        return errors + [f"{symbol}: 空序列"], warnings
    if int(payload.get("count", -1)) != len(dates):
        errors.append(f"{symbol}: count 字段与序列长度不一致")
    if not payload.get("name"):
        errors.append(f"{symbol}: 名称为空")

    for i in range(1, len(dates)):
        if dates[i] <= dates[i - 1]:
            errors.append(f"{symbol}: 日期非严格递增（{dates[i - 1]} → {dates[i]}）")
            break

    bad_prices = sum(
        1 for p in prices if not isinstance(p, (int, float)) or p <= 0
    )
    if bad_prices:
        errors.append(f"{symbol}: 存在 {bad_prices} 个非正/非数值价格")

    if len(dates) < MIN_OK_POINTS:
        warnings.append(f"{symbol}: 仅 {len(dates)} 条数据（建议 ≥ {MIN_OK_POINTS}）")

    return errors, warnings


def missing_analysis(dates: list[str], calendar: set[str]) -> dict:
    """相对市场交易日历，找出缺失的交易日与最长连续缺口。"""
    if not dates or not calendar:
        return {"missing": 0, "missing_ratio": 0.0, "max_run": 0, "runs": []}

    own = set(dates)
    start, end = dates[0], dates[-1]
    span = sorted(d for d in calendar if start <= d <= end)
    if not span:
        return {"missing": 0, "missing_ratio": 0.0, "max_run": 0, "runs": []}

    # 按交易日历顺序扫描，连续缺失合并成一段
    runs: list[dict] = []
    current: dict | None = None
    missing = 0
    for day in span:
        if day in own:
            current = None
            continue
        missing += 1
        if current is None:
            current = {"from": day, "to": day, "days": 1}
            runs.append(current)
        else:
            current["to"] = day
            current["days"] += 1

    runs.sort(key=lambda r: -r["days"])
    return {
        "missing": missing,
        "missing_ratio": missing / len(span),
        "max_run": runs[0]["days"] if runs else 0,
        "runs": runs[:5],
        "span_days": len(span),
    }


def main() -> int:
    assets = load_asset_defs()
    all_errors: list[str] = []
    all_warnings: list[str] = []
    reports: list[dict] = []
    payloads: dict[str, dict] = {}
    latest_end = ""

    # 第一轮：读取 + 结构校验
    for asset in assets:
        path = os.path.join(HISTORY_DIR, history_filename(asset))
        payload = load_history(path) if os.path.exists(path) else None
        info: dict = {
            "symbol": asset.symbol,
            "name": asset.name,
            "type": asset.type.value,
            "group": asset.group,
            "market": asset.market.value,
        }
        if payload is None:
            info["status"] = "missing" if not os.path.exists(path) else "corrupt"
            if not os.path.exists(path):
                all_warnings.append(f"{asset.symbol}: 数据文件缺失")
            else:
                all_errors.append(f"{asset.symbol}: JSON 损坏")
            reports.append(info)
            continue

        errors, warnings = check_integrity(payload, asset.symbol)
        all_errors.extend(errors)
        all_warnings.extend(warnings)
        payloads[(asset.type.value, asset.symbol)] = payload
        info.update(
            {
                "status": "ok",
                "count": payload.get("count", 0),
                "start": payload.get("start", ""),
                "end": payload.get("end", ""),
            }
        )
        reports.append(info)
        if payload.get("end", "") > latest_end:
            latest_end = payload.get("end", "")

    # 第二轮：每个市场建一个交易日历（参照指数优先）
    calendars: dict[str, set[str]] = {}
    for market, anchors in CALENDAR_ANCHORS.items():
        dates: set[str] = set()
        for anchor in (anchors if isinstance(anchors, (list, tuple)) else [anchors]):
            payload = payloads.get(("index", anchor))
            if payload:
                dates.update(payload["dates"])
        if dates:
            calendars[market] = dates
    # 参照资产缺失时，退化为该市场所有资产的日期并集
    by_market: dict[str, set[str]] = {}
    for asset in assets:
        payload = payloads.get((asset.type.value, asset.symbol))
        if not payload:
            continue
        by_market.setdefault(asset.market.value, set()).update(payload["dates"])
    for market, day_union in by_market.items():
        calendars.setdefault(market, day_union)

    # 支撑数过滤：把「只有一两个资产有数据」的日期从日历里剔除。
    # 典型来源是跨市场序列（例如由 GLD 派生的人民币金价）带着美股节假日，
    # 或某个数据源在休市日仍返回一行。没有这一步，节假日会被误报成「缺数据」。
    support: dict[str, dict[str, int]] = {}
    spans: dict[str, tuple[str, str]] = {}
    for market in calendars:
        support[market] = {}
        spans[market] = ("9999-12-31", "0000-01-01")
    for asset in assets:
        payload = payloads.get((asset.type.value, asset.symbol))
        if not payload or not payload.get("dates"):
            continue
        market = asset.market.value
        if market not in calendars:
            continue
        ds = payload["dates"]
        spans[market] = (
            min(spans[market][0], ds[0]),
            max(spans[market][1], ds[-1]),
        )
        for day in ds:
            support[market][day] = support[market].get(day, 0) + 1

    # 每天「覆盖该日期的资产数」（只看区间覆盖，不看是否有数据），
    # 用来决定这一天的支撑阈值：1990 年只有上证指数一个资产，
    # 阈值必须降到 1，否则会把上证最早那 3 个月从日历里删掉。
    covering: dict[str, dict[str, int]] = {market: {} for market in calendars}
    for asset in assets:
        payload = payloads.get((asset.type.value, asset.symbol))
        if not payload or not payload.get("dates"):
            continue
        market = asset.market.value
        if market not in calendars:
            continue
        ds = payload["dates"]
        for day in calendars[market]:
            if ds[0] <= day <= ds[-1]:
                covering[market][day] = covering[market].get(day, 0) + 1

    for market, days in calendars.items():
        kept: set[str] = set()
        for day in days:
            need = min(3, max(1, covering[market].get(day, 0)))
            if support[market].get(day, 0) >= need:
                kept.add(day)
        calendars[market] = kept

    gap_assets = 0
    source_gap_assets = 0
    suspension_gap_assets = 0
    for info in reports:
        if info.get("status") != "ok":
            continue
        asset = next(
            a
            for a in assets
            if a.symbol == info["symbol"] and a.type.value == info["type"]
        )
        payload = payloads[(info["type"], info["symbol"])]
        gaps = missing_analysis(payload["dates"], calendars.get(asset.market.value, set()))
        info.update(
            {
                "missing_trading_days": gaps["missing"],
                "missing_ratio": round(gaps["missing_ratio"], 5),
                "max_missing_run": gaps["max_run"],
                "missing_runs": gaps["runs"],
            }
        )
        ratio = gaps["missing_ratio"]
        if ratio < COMPLETE_RATIO:
            info["completeness"] = "complete"
        elif ratio < MINOR_RATIO:
            info["completeness"] = "minor"
        else:
            info["completeness"] = "gaps"
            gap_assets += 1
        # 成因判定：个股/基金的长缺口是停牌（市场事实）；指数与 ETF 不可能停牌，
        # 同理源端空洞才是数据问题
        if gaps["max_run"] >= SUSPICIOUS_RUN:
            # 只有 A 股的个股与场外基金存在「长时间停牌 / 暂停估值」这种市场事实；
            # 港股、美股个股与所有指数、ETF 的长期缺口只能是数据源问题。
            can_suspend = asset.market.value == "CN" and asset.type.value in ("stock", "fund")
            if can_suspend:
                info["gap_cause"] = "suspension"
                suspension_gap_assets += 1
            else:
                info["gap_cause"] = "source"
                source_gap_assets += 1

        # 指数与 ETF 不存在停牌，长缺口几乎只能是数据源空洞
        if asset.type.value in ("index", "etf") and gaps["max_run"] >= SUSPICIOUS_RUN:
            first = gaps["runs"][0]
            all_warnings.append(
                f"{asset.name}（{asset.type.value} {asset.symbol}）: 连续缺 {first['days']} 个交易日"
                f"（{first['from']} ~ {first['to']}），指数/ETF 不会停牌，疑似数据源空洞"
            )
        elif gaps["max_run"] >= SUSPICIOUS_RUN:
            first = gaps["runs"][0]
            all_warnings.append(
                f"{asset.name}（{asset.type.value} {asset.symbol}）: 连续缺 {first['days']} 个交易日"
                f"（{first['from']} ~ {first['to']}），多为停牌或数据源空洞"
            )

    # 过期检查
    today = datetime.now(CST).date()
    stale_days = None
    if latest_end:
        try:
            stale_days = (today - date.fromisoformat(latest_end)).days
        except ValueError:
            all_errors.append(f"最新日期非法: {latest_end}")
        if stale_days is not None and stale_days > STALE_DAYS:
            all_warnings.append(
                f"全部数据最新到 {latest_end}，距今 {stale_days} 天（> {STALE_DAYS} 天，可能采集任务未运行）"
            )
    else:
        all_errors.append("没有任何可用数据")

    ok = sum(1 for r in reports if r.get("status") == "ok")
    missing = sum(1 for r in reports if r.get("status") == "missing")

    report = {
        "schema": 3,
        "generated_at": datetime.now(CST).isoformat(timespec="seconds"),
        "data_date": latest_end,
        "stale_days": stale_days,
        "calendars": {
            market: {"days": len(days), "start": min(days) if days else "", "end": max(days) if days else ""}
            for market, days in calendars.items()
        },
        "summary": {
            "total": len(reports),
            "files_ok": ok,
            "missing": missing,
            "error_count": len(all_errors),
            "warning_count": len(all_warnings),
            "total_points": sum(r.get("count", 0) for r in reports),
            "assets_with_gaps": gap_assets,
            "assets_with_suspension_gaps": suspension_gap_assets,
            "assets_with_source_gaps": source_gap_assets,
            "assets_complete": sum(1 for r in reports if r.get("completeness") == "complete"),
        },
        "errors": all_errors,
        "warnings": all_warnings,
        "assets": reports,
    }

    tmp = f"{QUALITY_FILE}.tmp"
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    os.replace(tmp, QUALITY_FILE)

    print("=" * 64)
    print(f"数据质量：{ok}/{len(reports)} 个资产可用，共 {report['summary']['total_points']} 条记录")
    print(f"最新数据日期：{latest_end or '无'}（距今 {stale_days if stale_days is not None else '?'} 天）")
    print(
        f"完整性：完全对齐 {report['summary']['assets_complete']} 项；"
        f"停牌型缺口 {suspension_gap_assets} 项（市场事实），"
        f"疑似源端空洞 {source_gap_assets} 项（数据问题）"
    )
    for market, info in report["calendars"].items():
        print(f"  {market} 交易日历：{info['days']} 天 {info['start']} ~ {info['end']}")
    print(f"错误 {len(all_errors)} 项，警告 {len(all_warnings)} 项 → data/quality.json")
    for e in all_errors:
        print(f"  [错误] {e}")
    for w in all_warnings[:12]:
        print(f"  [警告] {w}")
    if len(all_warnings) > 12:
        print(f"  [警告] … 另有 {len(all_warnings) - 12} 条")
    print("=" * 64)

    return 1 if all_errors else 0


if __name__ == "__main__":
    sys.exit(main())