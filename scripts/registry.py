"""scripts/registry.py — 读取权威资产登记表。"""

from __future__ import annotations

import json
import os
import sys
from typing import Any

from data_sources.common import AssetDef, AssetType, Market

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REGISTRY_FILE = os.path.join(PROJECT_ROOT, "config", "assets.json")
PERIODS_FILE = os.path.join(PROJECT_ROOT, "config", "periods.json")

DATA_DIR = os.path.join(PROJECT_ROOT, "data")
HISTORY_DIR = os.path.join(DATA_DIR, "history")
ASSETS_FILE = os.path.join(DATA_DIR, "assets.json")
META_FILE = os.path.join(DATA_DIR, "meta.json")
QUALITY_FILE = os.path.join(DATA_DIR, "quality.json")
PERIODS_OUT = os.path.join(DATA_DIR, "periods.json")


def ensure_import_path() -> None:
    if PROJECT_ROOT not in sys.path:
        sys.path.insert(0, PROJECT_ROOT)


def history_filename(asset: AssetDef) -> str:
    return f"{asset.type.value}_{asset.symbol}.json"


def load_registry() -> dict[str, Any]:
    with open(REGISTRY_FILE, encoding="utf-8") as f:
        return json.load(f)


def load_periods() -> dict[str, Any]:
    with open(PERIODS_FILE, encoding="utf-8") as f:
        return json.load(f)


def load_asset_defs() -> list[AssetDef]:
    raw = load_registry()
    assets: list[AssetDef] = []
    seen: set[str] = set()
    for item in raw["assets"]:
        key = f'{item["type"]}:{item["symbol"]}'
        if key in seen:
            raise ValueError(f"登记表存在重复资产: {key}")
        seen.add(key)
        assets.append(
            AssetDef(
                symbol=item["symbol"],
                name=item["name"],
                type=AssetType(item["type"]),
                code=item["code"],
                group=item["group"],
                market=Market(item.get("market", "CN")),
                from_year=int(item["from"]),
                source=item.get("source", "tencent"),
                em_secid=item.get("em_secid", ""),
            )
        )
    return assets