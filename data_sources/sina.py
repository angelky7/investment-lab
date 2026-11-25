"""data_sources/sina.py — 新浪财经外汇数据源（美元兑人民币等）。

接口（公开、无需 Key）：

    https://vip.stock.finance.sina.com.cn/forex/api/jsonp.php/var%20_={symbol}/NewForexService.getDayKLine?symbol={symbol}

* 返回 JSONP 风格的超长字符串，一次即可拿到全部历史（实测 USD/CNY 从 1994-08-30 起 8000+ 行）；
* 每行格式实测为 `日期,开,低,高,收`（注意：低在高之前，与常见 OHLC 顺序不同）。
  校验方法：任取一行都有 `低 <= min(开, 收)` 且 `高 >= max(开, 收)`；
  另外实时快照里的最新价与该行第 5 个字段（收）一致。
* 只用收盘价作为序列价格，与其它资产的「收盘价」口径保持一致。

汇率序列的用途：
1. 直接作为可分析资产（波动率、长期趋势、汇改前后的跳跃）；
2. 说明「以美元计价的资产，人民币视角的收益还要叠加汇率变化」。
"""

from __future__ import annotations

import json
import re
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

REQUEST_TIMEOUT = 30
REQUEST_DELAY = 0.6
BASE_URL = (
    "https://vip.stock.finance.sina.com.cn/forex/api/jsonp.php/"
    "var%20_={symbol}/NewForexService.getDayKLine?symbol={symbol}"
)
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


def http_get(url: str, referer: str = "https://finance.sina.com.cn/") -> Optional[bytes]:
    last_error = ""
    for attempt in range(3):
        try:
            req = urllib.request.Request(
                url, headers={"User-Agent": UA, "Referer": referer, "Accept": "*/*"}
            )
            with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
                return resp.read()
        except Exception as exc:  # noqa: BLE001
            last_error = f"{type(exc).__name__}: {exc}"
            time.sleep(1.5 * (attempt + 1))
    print(f"  [sina] 放弃 {url[:90]} … {last_error}", flush=True)
    return None


def parse_forex(text: str) -> list[Bar]:
    """解析新浪外汇日 K。纯函数，便于离线单测。

    行格式：``1994-08-30,8.5616,8.5616,8.5616,8.5616,`` → 日期,开,低,高,收。
    """
    match = re.search(r'var\s+\w+\s*=\s*\w+\("(.*)"\)', text, re.S)
    payload = match.group(1) if match else ""
    if not payload:
        # 兼容没有 JSONP 包装的情况
        match = re.search(r'"(\d{4}-\d{2}-\d{2},[^"]+)"', text, re.S)
        payload = match.group(1) if match else ""

    bars: list[Bar] = []
    for chunk in payload.split("|"):
        parts = [p.strip() for p in chunk.split(",") if p.strip() != ""]
        if len(parts) < 5:
            continue
        date = parts[0]
        if len(date) != 10 or date[4] != "-" or date[7] != "-":
            continue
        try:
            open_ = float(parts[1])
            low = float(parts[2])
            high = float(parts[3])
            close = float(parts[4])
        except ValueError:
            continue
        if not (close > 0):
            continue
        bars.append(
            Bar(date=date, price=close, open=open_, high=high, low=low, volume=None)
        )
    return bars


class SinaForexSource:
    """外汇日 K 数据源。"""

    name = "sina"

    def __init__(self, delay: float = REQUEST_DELAY) -> None:
        self.delay = delay

    def fetch(self, asset: AssetDef, until_year: int, since: str = "") -> Optional[AssetSeries]:
        raw = http_get(BASE_URL.format(symbol=asset.code))
        time.sleep(self.delay)
        if raw is None:
            return None

        bars = parse_forex(raw.decode("utf-8", errors="replace"))
        bars = dedupe_sort(bars)
        if since:
            bars = [b for b in bars if b.date >= since]
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
            price_basis=PriceBasis.FX_CLOSE.value,
            last_close=bars[-1].price,
            bars=bars,
        )