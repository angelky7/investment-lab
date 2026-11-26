"""data_sources/sina_fut.py — 新浪全球期货日线（伦敦金 / 伦敦银等）。

端点（无需 Key）：

    https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_=/
        GlobalFuturesService.getGlobalFuturesDailyKLine?symbol={symbol}

返回 `var _=([{"date":"2006-11-27","open":"639.25",...,"close":"640.6","volume":"0"},...])`，
一次请求返回**全部**历史（实测伦敦金 2006-11-27 起 690 KB）。

已知的覆盖边界（写进文档，避免以后又猜）：
    XAU 伦敦金现   2006-11-27 起
    XAG 伦敦银现   2006-11-27 起
    GC  COMEX 黄金 2016-11-28 起
更早的伦敦金定盘价（1968 起）在 LBMA / FRED，但这两个域名在本机网络下不可达。
因此本站的美元金价最长历史仍来自 GLD（2004-11）：伦敦金是**同一资产更纯的口径**，
但时间更短——两个都保留，让人自己选口径。
"""

from __future__ import annotations

import json
import time
import urllib.request
from typing import Optional

from data_sources.common import (
    AssetDef,
    AssetSeries,
    Bar,
    PriceBasis,
    dedupe_sort,
)

URL = (
    "https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_=/"
    "GlobalFuturesService.getGlobalFuturesDailyKLine?symbol={symbol}"
)
REQUEST_TIMEOUT = 30
REQUEST_DELAY = 0.8
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
                url, headers={"User-Agent": UA, "Referer": "https://finance.sina.com.cn/"}
            )
            with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
                return resp.read()
        except Exception as exc:  # noqa: BLE001
            last_error = f"{type(exc).__name__}: {exc}"
            time.sleep(1.5 * (attempt + 1))
    print(f"  [sina_fut] 放弃 {url[:80]} … {last_error}", flush=True)
    return None


def parse_global_futures(text: str) -> list[Bar]:
    """解析 ``var _=([{...}])``。纯函数，便于离线单测。"""
    start = text.find("[")
    end = text.rfind("]")
    if start < 0 or end <= start:
        return []
    try:
        rows = json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return []

    bars: list[Bar] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        date = row.get("date")
        try:
            close = float(row["close"])
        except (KeyError, TypeError, ValueError):
            continue
        if not isinstance(date, str) or len(date) != 10 or not (close > 0):
            continue
        try:
            open_ = float(row.get("open") or 0) or None
            high = float(row.get("high") or 0) or None
            low = float(row.get("low") or 0) or None
        except (TypeError, ValueError):
            open_ = high = low = None
        bars.append(Bar(date=date, price=close, open=open_, high=high, low=low))
    return dedupe_sort(bars)


class SinaGlobalFuturesSource:
    """伦敦金 / 伦敦银等全球期货连续合约日线。"""

    name = "sina_fut"

    def __init__(self, delay: float = REQUEST_DELAY) -> None:
        self.delay = delay

    def fetch(self, asset: AssetDef, until_year: int, since: str = "") -> Optional[AssetSeries]:
        raw = http_get(URL.format(symbol=asset.code))
        time.sleep(self.delay)
        if raw is None:
            return None

        bars = parse_global_futures(raw.decode("utf-8", errors="replace"))
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
            # AssetDef 没有 currency 字段，按市场推断（这些标的都在美国市场报价）
            currency={"US": "USD", "HK": "HKD"}.get(asset.market, "CNY"),
            source=self.name,
            price_basis=PriceBasis.SPOT_CLOSE.value,
            last_close=bars[-1].price,
            bars=bars,
        )