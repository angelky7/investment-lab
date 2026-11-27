"""scripts/import_shiller.py — 导入 Shiller 美国长期股市数据（1871 起）。

来源：Robert J. Shiller, "U.S. Stock Markets 1871-Present and CAPE Ratio"
      http://www.econ.yale.edu/~shiller/data.htm

字段（Data 工作表，从第 8 行开始是数据）：
    Date              1871.01 格式
    P                 标普综合指数（S&P Composite）当月收盘
    D                 每股股息
    E                 每股收益
    CPI               消费者物价指数
    Fraction          小数年（1871.0417 等）
    Rate GS10         10 年期国债收益率
    Real Price        实际（通胀调整后）价格
    Real Dividend     实际股息
    Real Total Return Price  实际总回报价格指数（含股息再投资）

**为什么需要它**：站内标普 500 只有 2005 年起（22 年），
不足以看出长波。Shiller 提供 **1871 年起 154 年**的月度数据，
是标普 500 的**真正前身**（同一指数系列的更早段）。

产出 `data/shiller.json`，结构与 `longrun.json` 类似，便于前端复用同一套拟合。
"""

from __future__ import annotations

import json
import os
import sys
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from scripts.registry import DATA_DIR  # noqa: E402

OUT_PATH = os.path.join(DATA_DIR, "shiller.json")
RAW_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "raw", "shiller_ie_data.xls"
)

DATA_START_ROW = 7  # 0 基；第 8 行（1 基）是第一条数据

# 列索引（0 基）
COL_DATE = 0
COL_PRICE = 1
COL_DIVIDEND = 2
COL_EARNINGS = 3
COL_CPI = 4
COL_FRACTION = 5
COL_GS10 = 6
COL_REAL_PRICE = 7
COL_REAL_DIVIDEND = 8
COL_REAL_TOTAL_RETURN = 9


def read_shiller(path: str) -> dict:
    """读取 Shiller 的 Data 工作表，返回清洗后的序列。

    纯函数式：不写文件、不打印，便于单测。
    """
    import xlrd

    book = xlrd.open_workbook(path)
    sheet = book.sheet_by_name("Data")

    rows = []
    for r in range(DATA_START_ROW, sheet.nrows):
        date_raw = sheet.cell_value(r, COL_DATE)
        if date_raw in ("", None):
            continue

        # 日期形如 "1871.01" 或 "2023.1"；末行常是 "2023.09" 之后有注释
        try:
            date_str = str(date_raw).strip()
            if not date_str or not date_str[0].isdigit():
                continue
            parts = date_str.split(".")
            year = int(parts[0])
            month = int(parts[1]) if len(parts) > 1 else 1
            if not (1800 <= year <= 2100 and 1 <= month <= 12):
                continue
        except (ValueError, IndexError):
            continue

        def num(col):
            try:
                v = sheet.cell_value(r, col)
                if v in ("", None):
                    return None
                f = float(v)
                if f != f:  # NaN
                    return None
                return f
            except (ValueError, TypeError):
                return None

        price = num(COL_PRICE)
        if price is None or price <= 0:
            continue

        rows.append(
            {
                "year": year,
                "month": month,
                "price": round(price, 4),
                "dividend": round(num(COL_DIVIDEND) or 0, 4),
                "earnings": round(num(COL_EARNINGS) or 0, 4),
                "cpi": round(num(COL_CPI) or 0, 4),
                "gs10": round(num(COL_GS10) or 0, 4),
                "realPrice": round(num(COL_REAL_PRICE) or 0, 4),
                "realDividend": round(num(COL_REAL_DIVIDEND) or 0, 4),
                "realTotalReturn": round(num(COL_REAL_TOTAL_RETURN) or 0, 4),
            }
        )

    # 按时间排序并去重（同一 (year, month) 只保留第一条）
    rows.sort(key=lambda x: (x["year"], x["month"]))
    deduped = []
    seen = set()
    for row in rows:
        key = (row["year"], row["month"])
        if key in seen:
            continue
        seen.add(key)
        deduped.append(row)
    return {"rows": deduped}


def build_payload(data: dict) -> dict:
    rows = data["rows"]
    if not rows:
        raise SystemExit("没有读到任何数据")

    labels = [f"{r['year']}-{r['month']:02d}" for r in rows]
    # 小数年：用于拟合（避免同一年重复）
    fractions = [r["year"] + (r["month"] - 1) / 12 for r in rows]

    return {
        "schema": 1,
        "kind": "shiller-us-stocks",
        "frequency": "monthly",
        "source": {
            "name": "Robert Shiller, U.S. Stock Markets 1871-Present",
            "url": "http://www.econ.yale.edu/~shiller/data/ie_data.xls",
            "page": "http://www.econ.yale.edu/~shiller/data.htm",
            "citation": "Shiller, R. J. Irrational Exuberance (3rd ed.), Princeton University Press, 2015.",
            "note": "S&P Composite 是标普 500 的前身系列；1871 年起月度",
        },
        "coverage": {
            "from": labels[0],
            "to": labels[-1],
            "months": len(rows),
            "years": round(fractions[-1] - fractions[0], 1),
        },
        "series": {
            "price": [r["price"] for r in rows],
            "dividend": [r["dividend"] for r in rows],
            "earnings": [r["earnings"] for r in rows],
            "cpi": [r["cpi"] for r in rows],
            "gs10": [r["gs10"] for r in rows],
            "realPrice": [r["realPrice"] for r in rows],
            "realTotalReturn": [r["realTotalReturn"] for r in rows],
        },
        "labels": labels,
        "fractions": [round(f, 4) for f in fractions],
    }


def main() -> int:
    if not os.path.exists(RAW_PATH):
        print(f"缺少原始文件：{RAW_PATH}")
        print("下载：http://www.econ.yale.edu/~shiller/data/ie_data.xls")
        return 1

    data = read_shiller(RAW_PATH)
    payload = build_payload(data)

    cov = payload["coverage"]
    print(f"读取 {cov['months']} 个月：{cov['from']} – {cov['to']}（约 {cov['years']} 年）")

    # 用公认史实核对
    s = payload["series"]
    labels = payload["labels"]

    def at(label, series):
        if label not in labels:
            return None
        return s[series][labels.index(label)]

    checks = [
        ("1929-09", "price", "大萧条前高点", lambda v: v > 30),
        ("1932-06", "price", "大萧条底部（跌约 80%）", lambda v: v < 10),
        ("2000-01", "price", "互联网泡沫高点", lambda v: v > 1400),
        ("2009-03", "price", "金融危机底部", lambda v: v < 800),
    ]
    print("\n=== 用史实核对 ===")
    ok = True
    for label, series, note, test in checks:
        v = at(label, series)
        if v is None:
            print(f"  ? {label} 缺数据")
            continue
        good = test(v)
        print(f"  {'✓' if good else '✗'} {label} 标普 {v:.1f} · {note}")
        if not good:
            ok = False

    # 总涨幅
    first, last = s["price"][0], s["price"][-1]
    print(f"\n标普综合指数：{first:.2f}（{labels[0]}）→ {last:.1f}（{labels[-1]}），"
          f"{last/first:.1f} 倍")

    if not ok:
        print("\n核对未通过，拒绝写入")
        return 1

    with open(OUT_PATH, "w", encoding="utf-8", newline="\n") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")
    print(f"\n已写入 {OUT_PATH}（{os.path.getsize(OUT_PATH):,} bytes）")
    return 0


if __name__ == "__main__":
    sys.exit(main())