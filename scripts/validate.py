"""scripts/validate.py — 数据质量校验。

两类问题分开处理：
* errors   —— 数据本身坏了（JSON 损坏、日期乱序/重复、价格非正、长度不一致）。
              出现即退出码 1，CI 会标红。
* warnings —— 数据可用但不完美（缺失资产、点数偏少、日期断档、整体过期）。
              CI 不阻塞，但仍写入报告并打印，便于人工发现漂移。

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
MAX_GAP_DAYS = 20
STALE_DAYS = 6
CST = timezone(timedelta(hours=8))


def is_weekend_or_long_holiday_gap(prev: str, cur: str) -> int:
    d1 = date.fromisoformat(prev)
    d2 = date.fromisoformat(cur)
    return (d2 - d1).days


def validate_one(path: str, symbol: str) -> tuple[list[str], list[str], dict]:
    """返回 (errors, warnings, info)。"""
    errors: list[str] = []
    warnings: list[str] = []
    info: dict = {"symbol": symbol}

    if not os.path.exists(path):
        return [], [f"{symbol}: 数据文件缺失"], {"symbol": symbol, "status": "missing"}

    try:
        with open(path, encoding="utf-8") as f:
            payload = json.load(f)
    except (json.JSONDecodeError, OSError) as exc:
        return [f"{symbol}: JSON 损坏 {exc}"], [], {"symbol": symbol, "status": "corrupt"}

    dates = payload.get("dates")
    prices = payload.get("prices")
    if not isinstance(dates, list) or not isinstance(prices, list):
        return [f"{symbol}: 缺少 dates/prices 列"], [], {"symbol": symbol, "status": "corrupt"}

    if len(dates) != len(prices):
        errors.append(f"{symbol}: dates({len(dates)}) 与 prices({len(prices)}) 长度不一致")
    if not dates:
        return errors + [f"{symbol}: 空序列"], [], {"symbol": symbol, "status": "empty"}

    if int(payload.get("count", -1)) != len(dates):
        errors.append(f"{symbol}: count 字段与序列长度不一致")

    if not payload.get("name"):
        errors.append(f"{symbol}: 名称为空")

    for i in range(1, len(dates)):
        if dates[i] <= dates[i - 1]:
            errors.append(f"{symbol}: 日期非严格递增（{dates[i - 1]} → {dates[i]}）")
            break

    flat_prices = [p for p in prices if not isinstance(p, (int, float)) or p <= 0]
    if flat_prices:
        errors.append(f"{symbol}: 存在 {len(flat_prices)} 个非正/非数值价格")

    gaps = []
    for i in range(1, len(dates)):
        try:
            gap = is_weekend_or_long_holiday_gap(dates[i - 1], dates[i])
        except ValueError:
            errors.append(f"{symbol}: 非法日期格式 {dates[i]}")
            break
        if gap > MAX_GAP_DAYS:
            gaps.append({"from": dates[i - 1], "to": dates[i], "days": gap})

    if gaps:
        warnings.append(f"{symbol}: {len(gaps)} 处日期断档 > {MAX_GAP_DAYS} 天")
    if len(dates) < MIN_OK_POINTS:
        warnings.append(f"{symbol}: 仅 {len(dates)} 条数据（建议 ≥ {MIN_OK_POINTS}）")

    info.update(
        {
            "status": "ok",
            "count": len(dates),
            "start": dates[0],
            "end": dates[-1],
            "gaps": gaps[:5],
            "gap_count": len(gaps),
        }
    )
    return errors, warnings, info


def main() -> int:
    assets = load_asset_defs()
    all_errors: list[str] = []
    all_warnings: list[str] = []
    reports: list[dict] = []
    latest_end = ""

    for asset in assets:
        path = os.path.join(HISTORY_DIR, history_filename(asset))
        errors, warnings, info = validate_one(path, asset.symbol)
        info["name"] = asset.name
        info["type"] = asset.type.value
        info["group"] = asset.group
        all_errors.extend(errors)
        all_warnings.extend(warnings)
        reports.append(info)
        if info.get("end", "") > latest_end:
            latest_end = info.get("end", "")

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
        "schema": 2,
        "generated_at": datetime.now(CST).isoformat(timespec="seconds"),
        "data_date": latest_end,
        "stale_days": stale_days,
        "summary": {
            "total": len(reports),
            "files_ok": ok,
            "missing": missing,
            "error_count": len(all_errors),
            "warning_count": len(all_warnings),
            "total_points": sum(r.get("count", 0) for r in reports),
        },
        "errors": all_errors,
        "warnings": all_warnings,
        "assets": reports,
    }

    tmp = f"{QUALITY_FILE}.tmp"
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    os.replace(tmp, QUALITY_FILE)

    print("=" * 60)
    print(f"数据质量：{ok}/{len(reports)} 个资产可用，共 {report['summary']['total_points']} 条记录")
    print(f"最新数据日期：{latest_end or '无'}（距今 {stale_days if stale_days is not None else '?'} 天）")
    print(f"错误 {len(all_errors)} 项，警告 {len(all_warnings)} 项 → data/quality.json")
    for e in all_errors:
        print(f"  [错误] {e}")
    for w in all_warnings:
        print(f"  [警告] {w}")
    print("=" * 60)

    return 1 if all_errors else 0


if __name__ == "__main__":
    sys.exit(main())