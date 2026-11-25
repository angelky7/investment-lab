"""腾讯行情数据源（日 K 线，后复权）。

接口（公开、无需 Key）：

    https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get?param={code},day,{start},{end},{count},{复权方式}

实测结论（2026-11 校验，勿凭直觉改动）：

1. ``web.ifzq.gtimg.cn/appstock/app/fqkline/get`` 现已对部分 IP 返回 501，
   而 ``/newfqkline/get`` 正常，因此主用 newfqkline。
2. 区间请求返回的是「结束日之前最后 count 行」，不是区间内的全部行。
   必须按窗口切片：窗口 count 要略大于窗口内交易日数，否则会从窗口中间开始。
   2 年窗口约 490 个交易日，用 count=520 安全。
3. count 上限不稳定（640 可用、900 有时只回 640），所以窗口不要开太大。
4. **必须用 hfq（后复权）**：qfq 对高分红股票会返回负数历史价
   （实测 600519 在 2013-2015 年为 -187 元），根本没法算收益率。
   后复权值恒为正，且包含分红再投资，是长期收益分析的正确口径。
   展示用价格由前端按 last_close 折算，等价于标准前复权。
5. 响应是 GBK 编码 JSON，K 线行格式 [日期, 开, 收, 高, 低, 量]；
   同一个响应里的 ``qt`` 块含实时快照，index 3 就是最新真实价。
6. 美股指数用 us.IXIC / us.INX / us.DJI 这类代码，同样走该接口。
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
    Market,
    PriceBasis,
    dedupe_sort,
)

HOSTS = ("proxy.finance.qq.com/ifzqgtimg", "web.ifzq.gtimg.cn")
KLINE_PATH = "appstock/app/newfqkline/get"
REQUEST_TIMEOUT = 25
REQUEST_DELAY = 0.45
RETRIES = 3
# 2 年窗口 ≈ 490 个交易日，520 留足余量
WINDOW_YEARS = 2
WINDOW_COUNT = 520
ADJUST = "hfq"

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


def http_get(url: str, referer: str = "https://gu.qq.com/") -> Optional[bytes]:
    """带重试的 GET。失败返回 None，不向调用方抛异常。"""
    last_error = ""
    for attempt in range(RETRIES):
        try:
            req = urllib.request.Request(
                url,
                headers={"User-Agent": UA, "Referer": referer, "Accept": "*/*"},
            )
            with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
                return resp.read()
        except Exception as exc:  # noqa: BLE001 - 网络异常一律重试
            last_error = f"{type(exc).__name__}: {exc}"
            time.sleep(1.5 * (attempt + 1))
    print(f"  [http] 放弃 {url[:100]} … {last_error}", flush=True)
    return None


def parse_kline(raw: bytes) -> tuple[list[Bar], dict]:
    """解析腾讯 K 线响应，返回 (bars, meta)。

    meta 可能包含 ``last_close``（实时快照最新价）、``name``、``quote_time``。
    纯函数，便于用固定 fixture 做离线单测。
    """
    empty: tuple[list[Bar], dict] = ([], {})
    try:
        obj = json.loads(raw.decode("gbk", errors="replace"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return empty
    if not isinstance(obj, dict) or obj.get("code") != 0:
        return empty

    data_block = obj.get("data")
    if not isinstance(data_block, dict) or not data_block:
        return empty

    stock_key = next(iter(data_block))
    stock_data = data_block[stock_key]
    if not isinstance(stock_data, dict):
        return empty

    rows = (
        stock_data.get("hfqday")
        or stock_data.get("qfqday")
        or stock_data.get("day")
        or []
    )
    if not isinstance(rows, list):
        return empty

    bars: list[Bar] = []
    for row in rows:
        if not isinstance(row, list) or len(row) < 6:
            continue
        date = str(row[0]).strip()
        if len(date) != 10 or date[4] != "-" or date[7] != "-":
            continue
        try:
            bars.append(
                Bar(
                    date=date,
                    price=float(row[2]),   # 收
                    open=float(row[1]),    # 开
                    high=float(row[3]),    # 高
                    low=float(row[4]),     # 低
                    volume=float(row[5]) if row[5] not in ("", None) else None,
                )
            )
        except (TypeError, ValueError):
            continue

    meta: dict = {}
    quote = stock_data.get("qt")
    if isinstance(quote, dict) and stock_key in quote:
        fields = quote[stock_key]
        if isinstance(fields, list) and len(fields) > 4:
            try:
                price = float(fields[3])
                if price > 0:
                    meta["last_close"] = price
            except (TypeError, ValueError):
                pass
            if len(fields) > 1 and isinstance(fields[1], str):
                meta["name"] = fields[1]
            if len(fields) > 30 and isinstance(fields[30], str) and len(fields[30]) >= 8:
                ts = fields[30]
                meta["quote_time"] = f"{ts[0:4]}-{ts[4:6]}-{ts[6:8]}"

    return bars, meta


def parse_quote_snapshot(raw: bytes) -> dict[str, dict]:
    """解析 ``qt.gtimg.cn`` 批量快照。返回 {code: {name, price, change_pct}}。

    每行形如 ``v_sh600519="1~贵州茅台~600519~1463.78~...";``，
    字段 3 为最新价，字段 32 为涨跌幅。基金（jj 前缀）字段布局不同，
    这里只取名称与最新净值，够用于展示。
    """
    out: dict[str, dict] = {}
    try:
        text = raw.decode("gbk", errors="replace")
    except UnicodeDecodeError:
        return out
    for line in text.strip().splitlines():
        line = line.strip()
        if not line.startswith("v_") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        fields = value.strip().strip(";").strip('"').split("~")
        if len(fields) < 5:
            continue
        code = key[2:]
        if code.startswith("jj"):
            # 基金：1=名称 5=单位净值 7=涨跌幅
            price = fields[5] if len(fields) > 5 else ""
            name = fields[1] if len(fields) > 1 else ""
            pct = fields[7] if len(fields) > 7 else ""
        else:
            price = fields[3]
            name = fields[1]
            pct = fields[32] if len(fields) > 32 else ""
        try:
            price_f = float(price)
        except (TypeError, ValueError):
            continue
        if price_f <= 0:
            continue
        try:
            pct_f = float(pct)
        except (TypeError, ValueError):
            pct_f = None
        out[code] = {"name": name, "price": price_f, "change_pct": pct_f}
    return out


def fetch_quote_prices(codes: list[str]) -> dict[str, dict]:
    """批量抓取最新快照（一次请求）。失败返回空字典。"""
    if not codes:
        return {}
    # 一次请求上限约 60 个代码，分批更稳
    result: dict[str, dict] = {}
    for i in range(0, len(codes), 50):
        chunk = codes[i : i + 50]
        raw = http_get(f"https://qt.gtimg.cn/q={','.join(chunk)}", referer="https://gu.qq.com/")
        if raw is None:
            continue
        result.update(parse_quote_snapshot(raw))
        time.sleep(REQUEST_DELAY)
    return result


class TencentSource:
    """腾讯行情数据源（股票 / ETF / 指数）。"""

    name = "tencent"

    def __init__(self, delay: float = REQUEST_DELAY) -> None:
        self.delay = delay

    def fetch_window(self, code: str, start_year: int, end_year: int) -> tuple[list[Bar], dict]:
        """抓取 [start_year, end_year] 窗口。空列表代表该窗口无数据。"""
        param = (
            f"{code},day,{start_year}-01-01,{end_year}-12-31,"
            f"{WINDOW_COUNT},{ADJUST}"
        )
        for host in HOSTS:
            raw = http_get(f"https://{host}/{KLINE_PATH}?param={param}")
            if raw is None:
                continue
            bars, meta = parse_kline(raw)
            time.sleep(self.delay)
            if bars:
                return bars, meta
        return [], {}

    def fetch(self, asset: AssetDef, until_year: int, since: str = "") -> Optional[AssetSeries]:
        start_year = asset.from_year
        if since:
            start_year = max(start_year, int(since[:4]))

        buckets: list[Bar] = []
        meta: dict = {}
        empty_windows = 0
        year = start_year
        while year <= until_year:
            end_year = min(year + WINDOW_YEARS - 1, until_year)
            window_bars, window_meta = self.fetch_window(asset.code, year, end_year)
            if window_bars:
                buckets.extend(window_bars)
                empty_windows = 0
                # 最新窗口的快照更可信，用它覆盖旧的
                meta.update(window_meta)
            else:
                empty_windows += 1
                if empty_windows >= 2:
                    if buckets:
                        print(f"  [{asset.code}] 连续 {empty_windows} 个窗口无数据，提前结束", flush=True)
                        break
                    # 还没有任何数据：可能是「from 年份早于上市年份」的新资产，
                    # 只要距起始年份还没超过 6 年就继续往后找，避免把晚报资产直接判死。
                    if year - asset.from_year < 6:
                        empty_windows = 0
                    else:
                        print(f"  [{asset.code}] 连续 {empty_windows} 个窗口无数据，代码可能有误", flush=True)
                        return None
            print(f"  [{asset.code}] {year}-{end_year}: {len(window_bars)} 条", flush=True)
            year = end_year + 1

        bars = dedupe_sort(buckets)
        if since:
            bars = [b for b in bars if b.date >= since]
        if asset.from_date:
            bars = [b for b in bars if b.date >= asset.from_date]
        if not bars:
            return None

        is_index = asset.type is AssetType.INDEX
        return AssetSeries(
            symbol=asset.symbol,
            name=asset.name,
            type=asset.type,
            market=asset.market,
            group=asset.group,
            currency={"US": "USD", "HK": "HKD"}.get(asset.market.value, "CNY"),
            source=self.name,
            price_basis=(
                PriceBasis.INDEX_CLOSE.value if is_index else PriceBasis.HFQ_CLOSE.value
            ),
            last_close=meta.get("last_close"),
            bars=bars,
        )