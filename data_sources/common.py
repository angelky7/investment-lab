"""数据源统一模型与接口定义。

本模块只定义数据结构与抽象接口，不含任何网络逻辑，便于离线单元测试。
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional

SCHEMA_VERSION = 2


class AssetType(str, Enum):
    """资产类型。字符串枚举便于直接 JSON 序列化。"""

    STOCK = "stock"
    ETF = "etf"
    INDEX = "index"
    FUND = "fund"


class Market(str, Enum):
    CN = "CN"
    HK = "HK"
    US = "US"


class PriceBasis(str, Enum):
    """价格口径，写入数据文件供前端展示。

    统一使用后复权（含分红再投资）口径：
    * 收益率序列正确（分红计入），这是分析股票/ETF 长期收益的唯一正确做法。
    * 前复权在腾讯接口上会给高分红股票返回**负数**历史价（实测 600519 在
      2013-2015 年为 -187 元），无法用于计算。
    * 展示用的价格由前端按「最新真实收盘价」折算，等价于标准前复权。
    """

    HFQ_CLOSE = "后复权收盘价（含分红再投资）"
    INDEX_CLOSE = "指数收盘点位"
    FUND_ACC_NAV = "基金累计净值"
    FUND_NAV = "基金单位净值"


@dataclass
class Bar:
    """单日行情。价格类资产包含 OHLCV，基金只有净值。"""

    date: str  # YYYY-MM-DD
    price: float  # 收盘价 / 点位 / 净值，分析口径
    open: Optional[float] = None
    high: Optional[float] = None
    low: Optional[float] = None
    volume: Optional[float] = None


@dataclass
class AssetSeries:
    """一个资产的完整时间序列。

    存储层使用「数组 + 数组」的列式结构（dates / prices），比对象数组小 40% 左右，
    前端读取后自行展开。
    """

    symbol: str
    name: str
    type: AssetType
    market: Market
    group: str = ""
    currency: str = "CNY"
    source: str = ""
    price_basis: str = ""
    # 最新真实收盘价/净值。序列本身是后复权口径，前端按
    # display(t) = price(t) * last_close / price(last) 折算成「等价前复权」展示。
    last_close: Optional[float] = None
    bars: list[Bar] = field(default_factory=list)

    @property
    def dates(self) -> list[str]:
        return [b.date for b in self.bars]

    @property
    def prices(self) -> list[float]:
        return [b.price for b in self.bars]

    def to_json(self) -> dict:
        return {
            "schema": SCHEMA_VERSION,
            "symbol": self.symbol,
            "name": self.name,
            "type": self.type.value,
            "market": self.market.value,
            "group": self.group,
            "currency": self.currency,
            "source": self.source,
            "price_basis": self.price_basis,
            "last_close": round(self.last_close, 4) if self.last_close else None,
            "start": self.dates[0] if self.bars else "",
            "end": self.dates[-1] if self.bars else "",
            "count": len(self.bars),
            "dates": self.dates,
            "prices": [round(p, 4) for p in self.prices],
        }


@dataclass
class AssetDef:
    """登记表中的一行。"""

    symbol: str
    name: str
    type: AssetType
    code: str
    group: str
    market: Market
    from_year: int
    source: str
    em_secid: str = ""  # 东方财富 secid，如 1.600519 / 0.159915 / 100.SPX


class DataSource(ABC):
    """数据源抽象。新增数据源只需实现本接口。"""

    @property
    @abstractmethod
    def name(self) -> str: ...

    @abstractmethod
    def fetch(self, asset: AssetDef, until_year: int) -> Optional[AssetSeries]:
        """抓取 asset 从 from_year 到 until_year 的全部历史。失败返回 None。"""
        ...


def dedupe_sort(bars: list[Bar]) -> list[Bar]:
    """按日期去重（保留首次出现）并升序排序。

    跨年度分片抓取会在边界产生重复日期，必须去重，否则收益序列会出现 0 收益噪声。
    """
    seen: dict[str, Bar] = {}
    for b in bars:
        if not b.date or b.price is None or b.price <= 0:
            continue
        seen.setdefault(b.date, b)
    return [seen[d] for d in sorted(seen)]