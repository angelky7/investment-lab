"""data_sources/eastmoney_macro.py — 东方财富数据中心宏观序列（CPI）。

端点（公开、无需 Key）：

    https://datacenter-web.eastmoney.com/api/data/v1/get
        ?reportName=RPT_ECONOMY_CPI&columns=ALL&pageSize=1000
        &pageNumber=1&sortColumns=REPORT_DATE&sortTypes=1

返回一个月一行的 JSON，字段含：

    REPORT_DATE       统计局口径的月份（当月 1 日）
    NATIONAL_SAME     全国 CPI 同比（%）
    NATIONAL_SEQUENTIAL 全国 CPI 环比（%）

本站需要的是「价格指数」而不是百分比。**必须用累计（NATIONAL_ACCUMULATE）而不是环比**：
统计局的月度「环比」是**季节调整后**的数，把它逐月复利串起来与年度累计对不上
（实测 2008 年：环比串起来只有 +1.26%，而当年累计是 +5.86%）。

累计的定义是「本年至今相对上年 12 月」，所以它可以精确地还原成月度指数：

    index_t = index_{上年12月} × 累计_t / 100
    index_{次年1月} 的基数 = 上年 12 月的指数

覆盖边界实测为 **2008-01 起**（更早的月份东方财富没有），所以在页面上如实标注
「实际收益自 2008-01 起」，而不是拿年度数字去凑。
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

BASE = "https://datacenter-web.eastmoney.com/api/data/v1/get"
REPORT = "RPT_ECONOMY_CPI"
REQUEST_TIMEOUT = 40
RETRIES = 3
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


def http_get(url: str) -> Optional[bytes]:
    last = ""
    for attempt in range(RETRIES):
        try:
            req = urllib.request.Request(
                url, headers={"User-Agent": UA, "Referer": "https://data.eastmoney.com/"}
            )
            with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
                return resp.read()
        except Exception as exc:  # noqa: BLE001
            last = f"{type(exc).__name__}: {exc}"
            time.sleep(2.0 * (attempt + 1))
    print(f"  [em_macro] 放弃：{last}", flush=True)
    return None


def build_cpi_index(rows: list[dict], base_value: float = 100.0) -> list[Bar]:
    """用「累计」还原月度 CPI 指数。纯函数，便于离线单测。

    规则：
      index_t = 上年 12 月的指数 × 累计_t / 100
      下一年 1 月的基数 = 本年 12 月的指数
    起始点设为第一条记录所在年之前的 12 月 = base_value。
    """
    parsed = []
    for row in rows:
        raw_date = row.get("REPORT_DATE")
        accum = row.get("NATIONAL_ACCUMULATE")
        if not isinstance(raw_date, str) or len(raw_date) < 10:
            continue
        try:
            accum_value = float(accum)
        except (TypeError, ValueError):
            continue
        if accum_value <= 0:
            continue
        parsed.append({"month": raw_date[:7], "year": int(raw_date[:4]), "accum": accum_value})

    parsed.sort(key=lambda r: r["month"])
    if not parsed:
        return []

    bars: list[Bar] = []
    year_base = base_value          # 上年 12 月的指数水平
    current_year = parsed[0]["year"]

    for row in parsed:
        if row["year"] != current_year:
            # 跨年：去年 12 月的指数就是今年的基数
            last_dec = next(
                (b.price for b in reversed(bars) if b.date.startswith(f"{current_year}-12")),
                year_base,
            )
            year_base = last_dec
            current_year = row["year"]
        level = year_base * row["accum"] / 100
        bars.append(Bar(date=f"{row['month']}-01", price=round(level, 6)))

    return dedupe_sort(bars)


def _month_index(month: str) -> int:
    year, mon = month.split("-")
    return int(year) * 12 + int(mon) - 1


def _month_distance(a: str, b: str) -> int:
    return _month_index(b) - _month_index(a)


def _is_next_month(a: str, b: str) -> bool:
    return _month_distance(a, b) == 1


class EastmoneyMacroSource:
    """宏观月度序列（目前只有 CPI）。"""

    name = "em_macro"

    def fetch(self, asset: AssetDef, until_year: int, since: str = "") -> Optional[AssetSeries]:
        url = (
            f"{BASE}?reportName={REPORT}&columns=ALL&pageSize=1000&pageNumber=1"
            "&sortColumns=REPORT_DATE&sortTypes=1"
        )
        raw = http_get(url)
        if raw is None:
            return None

        try:
            payload = json.loads(raw.decode("utf-8", errors="replace"))
        except json.JSONDecodeError:
            return None

        rows = ((payload.get("result") or {}).get("data")) or []
        bars = build_cpi_index(rows)
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
            price_basis=PriceBasis.CPI_INDEX.value,
            last_close=bars[-1].price,
            bars=bars,
        )