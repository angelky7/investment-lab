"""data_sources/csindex.py — 中证指数官网数据源。

接口（公开、无需 Key）：

    https://www.csindex.com.cn/csindex-home/perf/index-perf
        ?indexCode={code}&startDate={yyyymmdd}&endDate={yyyymmdd}

一次请求返回该指数**全部**历史日行情（实测 2005-12-30 起 5000+ 行），
字段包含 open / high / low / close / changePct / consNumber。

为什么需要它：交易所 ETF 往往只有近年数据（红利低波 ETF 2019 年才上市），
而对应的中证指数可以回溯到 2005 年。全收益版本（`H` 前缀，如 H20269、H00300）
还把分红再投资算进去了——做长期回测时，这比价格指数正确得多。

注意：接口偶尔会掐断连接，必须带重试；单次响应可达 2 MB，超时要给足。
"""

from __future__ import annotations

import json
import time
import urllib.request
from typing import Optional

from data_sources.common import (
    AssetDef,
    AssetSeries,
    AssetType,
    Bar,
    PriceBasis,
    dedupe_sort,
)

BASE_URL = (
    "https://www.csindex.com.cn/csindex-home/perf/index-perf"
    "?indexCode={code}&startDate={start}&endDate={end}"
)
DEFAULT_START = "20051230"
REQUEST_TIMEOUT = 90
REQUEST_DELAY = 2.0
RETRIES = 3
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


def http_get(url: str) -> Optional[bytes]:
    last_error = ""
    for attempt in range(RETRIES):
        try:
            req = urllib.request.Request(
                url,
                headers={
                    "User-Agent": UA,
                    "Referer": "https://www.csindex.com.cn/",
                    "Accept": "application/json",
                },
            )
            with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
                return resp.read()
        except Exception as exc:  # noqa: BLE001
            last_error = f"{type(exc).__name__}: {exc}"
            time.sleep(3.0 * (attempt + 1))
    print(f"  [csindex] 放弃 {url[:90]} … {last_error}", flush=True)
    return None


def parse_index_payload(raw: bytes) -> tuple[list[Bar], dict]:
    """解析中证指数响应，返回 (bars, meta)。纯函数，便于离线单测。"""
    empty: tuple[list[Bar], dict] = ([], {})
    try:
        obj = json.loads(raw.decode("utf-8", errors="replace"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return empty

    rows = obj.get("data")
    if not isinstance(rows, list) or not rows:
        return empty

    meta: dict = {}
    bars: list[Bar] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        trade_date = row.get("tradeDate")
        if not isinstance(trade_date, str) or len(trade_date) != 8:
            continue
        date = f"{trade_date[0:4]}-{trade_date[4:6]}-{trade_date[6:8]}"
        try:
            close = float(row["close"])
        except (KeyError, TypeError, ValueError):
            continue
        if not (close > 0):
            continue
        try:
            open_ = float(row.get("open") or 0) or None
            high = float(row.get("high") or 0) or None
            low = float(row.get("low") or 0) or None
        except (TypeError, ValueError):
            open_ = high = low = None
        bars.append(Bar(date=date, price=close, open=open_, high=high, low=low))
        if not meta.get("name") and row.get("indexNameCnAll"):
            meta["name"] = str(row["indexNameCnAll"])

    return dedupe_sort(bars), meta


class CsindexSource:
    """中证指数官网数据源。"""

    name = "csindex"

    def __init__(self, delay: float = REQUEST_DELAY) -> None:
        self.delay = delay

    def fetch(self, asset: AssetDef, until_year: int, since: str = "") -> Optional[AssetSeries]:
        start = (since or DEFAULT_START).replace("-", "")
        end = "20500101"
        raw = http_get(BASE_URL.format(code=asset.code, start=start, end=end))
        time.sleep(self.delay)
        if raw is None:
            return None

        bars, meta = parse_index_payload(raw)
        if not bars:
            return None

        if asset.from_date:
            bars = [b for b in bars if b.date >= asset.from_date]
        if not bars:
            return None

        return AssetSeries(
            symbol=asset.symbol,
            name=asset.name,
            type=asset.type,
            market=asset.market,
            group=asset.group,
            currency="CNY",
            source=self.name,
            price_basis=PriceBasis.INDEX_TOTAL_RETURN.value,
            last_close=bars[-1].price,
            bars=bars,
        )