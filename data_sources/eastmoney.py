"""东方财富数据源（K 线 + 基金净值）。

K 线接口：
    https://push2his.eastmoney.com/api/qt/stock/kline/get
        ?secid={市场.代码}&klt=101&fqt=1&beg={起始}&end={结束}&lmt=1000000
        &fields1=f1,f2,f3,f4,f5,f6
        &fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61

* ``klt=101`` 日线；``fqt=2`` 后复权（``fqt=0`` 不复权，``fqt=1`` 前复权）。
  与腾讯源保持一致，统一使用后复权口径，避免高分红股票出现负数价格。
* ``secid``：沪市 ``1.600519``，深市 ``0.159915``，美股 ``100.SPX``。
* 一次请求即可返回全部历史（实测 5000+ 行），不需要分片。
* 返回 ``klines`` 为逗号分隔字符串：日期,开,收,高,低,量,额,振幅,涨跌幅,涨跌额,换手率。

注意：该接口对高频请求敏感，会直接掐断连接。上层必须有节流与退避。
"""

from __future__ import annotations

import json
import re
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Optional

from data_sources.common import (
    AssetDef,
    AssetSeries,
    AssetType,
    Bar,
    PriceBasis,
    dedupe_sort,
)

KLINE_URL = "https://push2his.eastmoney.com/api/qt/stock/kline/get"
FUND_URL = "https://fund.eastmoney.com/pingzhongdata/{code}.js"
REQUEST_TIMEOUT = 25
CST = timezone(timedelta(hours=8))

# f51..f61 = 日期,开,收,高,低,量,额,振幅,涨跌幅,涨跌额,换手率
FIELDS = "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61"

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


def http_get(
    url: str,
    referer: str = "https://quote.eastmoney.com/",
    retries: int = 4,
    backoff: tuple[float, ...] = (2.0, 6.0, 15.0, 30.0),
) -> Optional[bytes]:
    """带指数退避的 GET。返回 None 表示彻底失败。"""
    last = ""
    for attempt in range(retries):
        try:
            req = urllib.request.Request(
                url,
                headers={
                    "User-Agent": UA,
                    "Referer": referer,
                    "Accept": "*/*",
                    "Accept-Encoding": "identity",  # 避免解压逻辑，响应本身不大
                    "Connection": "close",
                },
            )
            with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
                return resp.read()
        except Exception as exc:  # noqa: BLE001
            last = f"{type(exc).__name__}: {exc}"
            if attempt < retries - 1:
                time.sleep(backoff[min(attempt, len(backoff) - 1)])
    print(f"  [eastmoney] 放弃 {url[:100]} … {last}", flush=True)
    return None


def secid_for(asset: AssetDef) -> str:
    """优先使用登记表里的 em_secid，否则按代码前缀推导。"""
    explicit = getattr(asset, "em_secid", "") or asset.__dict__.get("em_secid", "")
    if explicit:
        return explicit
    code = asset.code
    if code.startswith("sh"):
        return f"1.{code[2:]}"
    if code.startswith("sz"):
        return f"0.{code[2:]}"
    return ""


def parse_kline_json(raw: bytes) -> Optional[list[Bar]]:
    """解析 push2his K 线响应。纯函数，便于离线单测。"""
    text = raw.decode("utf-8", errors="replace").strip()
    # 兼容 JSONP 包装
    if not text.startswith("{"):
        start, end = text.find("{"), text.rfind("}")
        if start < 0 or end < 0:
            return None
        text = text[start : end + 1]
    try:
        obj = json.loads(text)
    except json.JSONDecodeError:
        return None

    data = obj.get("data")
    if not isinstance(data, dict):
        return None
    rows = data.get("klines")
    if not isinstance(rows, list):
        return None

    bars: list[Bar] = []
    for row in rows:
        if not isinstance(row, str):
            continue
        parts = row.split(",")
        if len(parts) < 6:
            continue
        date = parts[0].strip()
        if len(date) != 10:
            continue
        try:
            bars.append(
                Bar(
                    date=date,
                    price=float(parts[2]),  # 收
                    open=float(parts[1]),
                    high=float(parts[3]),
                    low=float(parts[4]),
                    volume=float(parts[5]) if parts[5] not in ("", "-") else None,
                )
            )
        except ValueError:
            continue
    return bars


def parse_fund_nav(raw: bytes) -> tuple[list[Bar], dict]:
    """解析天天基金 ``pingzhongdata`` 脚本里的净值序列，返回 (bars, meta)。

    优先使用 ``Data_ACWorthTrend``（累计净值），因为它把分红计入，
    与股票/ETF 采用的后复权口径一致；缺失时退回 ``Data_netWorthTrend``（单位净值）。

    * ``Data_netWorthTrend`` = ``[{x:毫秒时间戳, y:单位净值, ...}]``
    * ``Data_ACWorthTrend`` = ``[[毫秒时间戳, 累计净值], ...]``
    * ``x`` 是 UTC 毫秒，换算到 Asia/Shanghai 后与官方净值日期一致
      （实测 1795449600000 → 2026-11-24）。
    """
    empty: tuple[list[Bar], dict] = ([], {})
    text = raw.decode("utf-8", errors="replace")

    meta: dict = {}
    name_match = re.search(r'fS_name\s*=\s*"([^"]*)"', text)
    if name_match:
        meta["name"] = name_match.group(1)

    bars: list[Bar] = []
    basis = PriceBasis.FUND_NAV.value

    acc_match = re.search(r"Data_ACWorthTrend\s*=\s*(\[.*?\])\s*;", text, re.S)
    if acc_match:
        try:
            pairs = json.loads(acc_match.group(1))
        except json.JSONDecodeError:
            pairs = []
        for row in pairs if isinstance(pairs, list) else []:
            if not isinstance(row, list) or len(row) < 2:
                continue
            try:
                ts = int(row[0]) / 1000
                nav = float(row[1])
            except (TypeError, ValueError):
                continue
            if nav <= 0:
                continue
            date = datetime.fromtimestamp(ts, tz=CST).strftime("%Y-%m-%d")
            bars.append(Bar(date=date, price=nav))
        if bars:
            basis = PriceBasis.FUND_ACC_NAV.value

    if not bars:
        match = re.search(r"Data_netWorthTrend\s*=\s*(\[.*?\])\s*;", text, re.S)
        if not match:
            return empty
        try:
            rows = json.loads(match.group(1))
        except json.JSONDecodeError:
            return empty
        for row in rows if isinstance(rows, list) else []:
            if not isinstance(row, dict):
                continue
            try:
                ts = int(row["x"]) / 1000
                nav = float(row["y"])
            except (KeyError, TypeError, ValueError):
                continue
            if nav <= 0:
                continue
            date = datetime.fromtimestamp(ts, tz=CST).strftime("%Y-%m-%d")
            bars.append(Bar(date=date, price=nav))

    if not bars:
        return empty
    meta["price_basis"] = basis
    meta["last_close"] = bars[-1].price
    return bars, meta


class EastmoneyKlineSource:
    """东方财富 K 线数据源（后复权）。"""

    name = "eastmoney"

    def __init__(self, delay: float = 1.2) -> None:
        self.delay = delay

    def fetch(self, asset: AssetDef, until_year: int, since: str = "") -> Optional[AssetSeries]:
        secid = secid_for(asset)
        if not secid:
            print(f"  [eastmoney] 缺少 secid: {asset.code}", flush=True)
            return None

        beg = since.replace("-", "") if since else "0"
        url = (
            f"{KLINE_URL}?secid={secid}&klt=101&fqt=2&beg={beg}&end=20500101"
            f"&lmt=1000000&fields1=f1,f2,f3,f4,f5,f6&fields2={FIELDS}"
        )
        raw = http_get(url)
        time.sleep(self.delay)
        if raw is None:
            return None

        bars = parse_kline_json(raw) or []
        bars = [b for b in bars if int(b.date[:4]) >= asset.from_year]
        if asset.from_date:
            bars = [b for b in bars if b.date >= asset.from_date]
        bars = dedupe_sort(bars)
        if not bars:
            return None

        return AssetSeries(
            symbol=asset.symbol,
            name=asset.name,
            type=asset.type,
            market=asset.market,
            group=asset.group,
            currency={"US": "USD", "HK": "HKD"}.get(asset.market.value, "CNY"),
            source=self.name,
            price_basis=(
                PriceBasis.INDEX_CLOSE.value
                if asset.type is AssetType.INDEX
                else PriceBasis.HFQ_CLOSE.value
            ),
            bars=bars,
        )


class EastmoneyFundSource:
    """东方财富基金净值数据源。"""

    name = "eastmoney"

    def __init__(self, delay: float = 1.2) -> None:
        self.delay = delay

    def fetch(self, asset: AssetDef, until_year: int, since: str = "") -> Optional[AssetSeries]:
        raw = http_get(FUND_URL.format(code=asset.code), referer="https://fund.eastmoney.com/")
        time.sleep(self.delay)
        if raw is None:
            return None

        bars, meta = parse_fund_nav(raw)
        bars = [b for b in dedupe_sort(bars) if int(b.date[:4]) >= asset.from_year]
        if since:
            bars = [b for b in bars if b.date >= since]
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
            price_basis=meta.get("price_basis", PriceBasis.FUND_NAV.value),
            last_close=bars[-1].price,
            bars=bars,
        )