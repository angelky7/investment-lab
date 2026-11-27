"""data_sources/jst.py — JST Macrohistory Database（1870–2020，18 国年度宏观序列）。

来源：Jordà, Schularick & Taylor, "Macrofinancial History and the New Business Cycle Facts"，
数据主页 https://www.macrohistory.net/database/ ，直链 JSTdatasetR6.xlsx（约 1.4 MB）。

**为什么需要它**：本站原有最长序列是上证指数 1990 起（35 年），
而「长波 / 周期」这类问题需要百年以上尺度。JST 提供 **1870–2020（151 年连续）**，
且字段正好覆盖周期研究的核心：

    cpi          消费者物价指数（长波在价格水平上的表现）
    ltrate       长期国债收益率（利率周期）
    stir         短期利率
    debtgdp      政府债务 / GDP（长债务周期）
    crisisJST    银行危机标记 0/1（危机频率）
    rgdpmad      实际人均 GDP（增长长波）
    hpnom        名义房价
    unemp        失业率

**频率是年度的**，与本站日频/月频管道不同，所以单独产出一个精简 JSON
（`data/longrun.json`），而不是塞进 `data/history/` 的资产体系。

注意：这是**年度**数据。用于「长波」讨论是合适的（一轮康波 50–60 年），
但不适合放到日频图表里做「年化收益」这类计算——年度点太少。
"""

from __future__ import annotations

import json
import time
import urllib.request
from typing import Optional

SOURCE_URL = "https://www.macrohistory.net/app/download/9834512569/JSTdatasetR6.xlsx"
SOURCE_PAGE = "https://www.macrohistory.net/database/"
CITATION = (
    "Jordà, Ò., Schularick, M., & Taylor, A. M. (2017). "
    "Macrofinancial History and the New Business Cycle Facts. "
    "NBER Macroeconomics Annual 2016, vol 31."
)

# 只取做周期研究最必要的国家与字段，控制产物体积
COUNTRIES = ["USA", "GBR", "DEU", "JPN", "FRA"]
INDICATORS = {
    "cpi": "消费者物价指数（基期随国家而异，只用于算变化率）",
    "ltrate": "长期国债收益率（%）",
    "debtgdp": "政府债务 / GDP",
    "rgdpmad": "实际人均 GDP（Maddison 口径）",
    "crisisJST": "系统性银行危机标记（1 = 当年发生）",
}
# 允许缺失但不丢整条序列的字段
OPTIONAL_INDICATORS = {"crisisJST"}

REQUEST_TIMEOUT = 120
RETRIES = 3
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36"


def download(url: str = SOURCE_URL) -> Optional[bytes]:
    """下载原始 xlsx。返回 bytes 或 None。"""
    last = ""
    for attempt in range(RETRIES):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
                return resp.read()
        except Exception as exc:  # noqa: BLE001
            last = f"{type(exc).__name__}: {exc}"
            time.sleep(3 * (attempt + 1))
    print(f"  [jst] 下载失败：{last}", flush=True)
    return None


def extract_series(rows: list[dict]) -> dict:
    """从「每行一个（year, iso, ...）」的行列表里抽出各国的指标序列。

    纯函数，便于离线单测：输入是按年排列的若干 dict，输出是
        { iso: { indicator: {"years": [...], "values": [...]} } }
    缺失值（None / NaN / 空串）会被跳过，不补空、不插值。
    """
    out: dict[str, dict[str, dict[str, list]]] = {}

    for row in rows:
        iso = row.get("iso")
        if iso not in COUNTRIES:
            continue
        year = row.get("year")
        try:
            year = int(year)
        except (TypeError, ValueError):
            continue

        bucket = out.setdefault(iso, {name: {"years": [], "values": []} for name in INDICATORS})
        for name in INDICATORS:
            raw = row.get(name)
            if raw is None:
                continue
            try:
                value = float(raw)
            except (TypeError, ValueError):
                continue
            # 过滤 NaN / inf
            if value != value or value in (float("inf"), float("-inf")):
                continue
            bucket[name]["years"].append(year)
            bucket[name]["values"].append(round(value, 6))

    # 每条序列按年份排序，并丢掉空序列
    cleaned: dict[str, dict[str, dict[str, list]]] = {}
    for iso, indicators in out.items():
        kept = {}
        for name, series in indicators.items():
            if not series["years"]:
                continue
            pairs = sorted(zip(series["years"], series["values"]))
            kept[name] = {
                "years": [p[0] for p in pairs],
                "values": [p[1] for p in pairs],
            }
        if kept:
            cleaned[iso] = kept
    return cleaned


def read_rows_from_xlsx(path: str) -> list[dict]:
    """用 openpyxl 读取 JST 主表为行字典列表。"""
    import openpyxl

    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb[wb.sheetnames[0]]
    rows_iter = ws.iter_rows(values_only=True)
    header = next(rows_iter)
    header = [str(h).strip() if h is not None else "" for h in header]
    rows: list[dict] = []
    for values in rows_iter:
        if not values or values[0] is None:
            continue
        rows.append(dict(zip(header, values)))
    wb.close()
    return rows


def build_payload(series: dict, source_note: str = "") -> dict:
    """把抽取结果包成要写盘的 JSON。"""
    counts = {}
    for iso, indicators in series.items():
        for name, s in indicators.items():
            counts[f"{iso}:{name}"] = len(s["years"])

    return {
        "schema": 1,
        "kind": "longrun-macro",
        "frequency": "annual",
        "source": {
            "name": "JST Macrohistory Database (R6)",
            "url": SOURCE_URL,
            "page": SOURCE_PAGE,
            "citation": CITATION,
            "license_note": "学术公开数据，转载请引用上述论文",
            "retrieved_note": source_note,
        },
        "coverage": {"from": 1870, "to": 2020, "countries": COUNTRIES},
        "indicators": INDICATORS,
        "counts": counts,
        "countries": series,
    }


def write_payload(payload: dict, path: str) -> None:
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")