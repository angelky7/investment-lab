"""scripts/build.py — 生成前端索引与元数据。

输入：data/history/*.json + config/assets.json + config/periods.json
输出：
  data/assets.json  — 资产列表索引（前端首屏只加载这一个文件）
  data/meta.json    — 数据版本、更新时间、资产统计、分组
  data/periods.json — 历史时期与压力测试情景

不做任何网络请求，因此可以随时安全重跑。
"""

from __future__ import annotations

import json
import os
import sys
from collections import Counter, OrderedDict
from datetime import datetime, timezone, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from scripts.registry import (  # noqa: E402
    ASSETS_FILE,
    HISTORY_DIR,
    META_FILE,
    PERIODS_OUT,
    ensure_import_path,
    history_filename,
    load_asset_defs,
    load_periods,
)

ensure_import_path()

CST = timezone(timedelta(hours=8))
MIN_OK_POINTS = 250


def read_history(path: str) -> dict | None:
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return None


def write_json(path: str, payload, *, pretty: bool = False) -> None:
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        if pretty:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        else:
            json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


def main() -> int:
    assets = load_asset_defs()
    periods = load_periods()

    index: list[dict] = []
    group_order: list[str] = []
    status_counter: Counter[str] = Counter()
    latest_date = ""

    for asset in assets:
        payload = read_history(os.path.join(HISTORY_DIR, history_filename(asset)))
        if asset.group not in group_order:
            group_order.append(asset.group)

        entry = {
            "symbol": asset.symbol,
            "name": asset.name,
            "type": asset.type.value,
            "group": asset.group,
            "market": asset.market.value,
            "currency": {"US": "USD", "HK": "HKD"}.get(asset.market.value, "CNY"),
            "source": asset.source,
        }

        if payload and payload.get("count"):
            count = int(payload["count"])
            entry.update(
                {
                    "data_start": payload.get("start", ""),
                    "data_end": payload.get("end", ""),
                    "data_points": count,
                    "price_basis": payload.get("price_basis", ""),
                    "status": "ok" if count >= MIN_OK_POINTS else "insufficient",
                }
            )
            if payload.get("end", "") > latest_date:
                latest_date = payload.get("end", "")
        else:
            entry.update(
                {
                    "data_start": "",
                    "data_end": "",
                    "data_points": 0,
                    "price_basis": "",
                    "status": "unavailable",
                }
            )

        status_counter[entry["status"]] += 1
        index.append(entry)

    # assets.json 保持稳定顺序：先按分组顺序，再按类型，最后按代码
    type_order = {"index": 0, "etf": 1, "stock": 2, "fund": 3, "fx": 4}
    index.sort(
        key=lambda e: (
            group_order.index(e["group"]),
            type_order.get(e["type"], 9),
            e["symbol"],
        )
    )

    now = datetime.now(CST)
    meta = {
        "schema": 2,
        "generated_at": now.isoformat(timespec="seconds"),
        "data_date": latest_date,
        "benchmark": periods.get("benchmark", "000300"),
        "total_assets": len(index),
        "available_assets": status_counter["ok"],
        "insufficient_assets": status_counter["insufficient"],
        "unavailable_assets": status_counter["unavailable"],
        "groups": group_order,
        "types": ["index", "etf", "stock", "fund", "fx"],
        "sources": sorted({a.source for a in assets}),
        "min_ok_points": MIN_OK_POINTS,
        "period_count": len(periods.get("periods", [])),
        "scenario_count": len(periods.get("stress_scenarios", [])),
    }

    write_json(ASSETS_FILE, index)
    write_json(META_FILE, meta, pretty=True)
    write_json(PERIODS_OUT, periods)

    print(f"资产索引 {len(index)} 项 → data/assets.json")
    print(f"  可用 {status_counter['ok']} / 数据偏少 {status_counter['insufficient']} / 缺失 {status_counter['unavailable']}")
    print(f"  数据截止 {latest_date or '（无数据）'}")
    print(f"元信息 → data/meta.json")
    print(f"时期与情景 {len(periods.get('periods', []))}+{len(periods.get('stress_scenarios', []))} → data/periods.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())