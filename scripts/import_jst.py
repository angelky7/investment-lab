"""scripts/import_jst.py — 把 JST 长历史宏观数据导入为 `data/longrun.json`。

用法：
    py scripts/import_jst.py                # 有缓存就用缓存，没有就下载
    py scripts/import_jst.py --refresh      # 强制重新下载
    py scripts/import_jst.py --verify       # 只做历史事实核对，不写文件

产物 `data/longrun.json` 会被提交进仓库，所以 CI 不需要访问第三方站点。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from data_sources import jst  # noqa: E402
from scripts.registry import DATA_DIR  # noqa: E402

OUT_PATH = os.path.join(DATA_DIR, "longrun.json")
CACHE_PATH = os.path.join(tempfile.gettempdir(), "JSTdatasetR6.xlsx")

# 用公认的历史事实核对数据质量：对不上就说明数据坏了，不许静默通过。
FACT_CHECKS = [
    # (国家, 指标, 起始年, 结束年, 期望方向, 说明)
    ("USA", "cpi", 1913, 1920, "up", "一战通胀：物价应大幅上升"),
    ("USA", "cpi", 1929, 1933, "down", "大萧条：物价应通缩"),
    ("USA", "cpi", 1973, 1980, "up", "大通胀：物价应大幅上升"),
]


def load_rows(refresh: bool) -> list[dict]:
    path = CACHE_PATH
    if refresh or not os.path.exists(path):
        print(f"下载 {jst.SOURCE_URL} …", flush=True)
        data = jst.download()
        if data is None:
            raise SystemExit("下载失败，且没有本地缓存。")
        with open(path, "wb") as f:
            f.write(data)
        print(f"  已缓存 {len(data):,} bytes → {path}", flush=True)
    else:
        print(f"使用缓存 {path}", flush=True)
    return jst.read_rows_from_xlsx(path)


def value_at(series: dict, year: int):
    years = series["years"]
    if year in years:
        return series["values"][years.index(year)]
    return None


def verify(series: dict) -> bool:
    print("\n=== 用历史事实核对 ===")
    ok = True

    for iso, indicator, y0, y1, direction, note in FACT_CHECKS:
        s = series.get(iso, {}).get(indicator)
        if not s:
            print(f"  ✗ {iso} 缺少 {indicator}")
            ok = False
            continue
        a, b = value_at(s, y0), value_at(s, y1)
        if a is None or b is None:
            print(f"  ✗ {iso} {indicator} {y0}/{y1} 缺值")
            ok = False
            continue
        change = b / a - 1
        good = (change > 0) if direction == "up" else (change < 0)
        mark = "✓" if good else "✗"
        print(f"  {mark} {iso} {indicator} {y0}→{y1}: {a:.2f} → {b:.2f}（{change:+.1%}）· {note}")
        if not good:
            ok = False

    # 长端利率的绝对水平也应合理（1981 年美国约 13–14%）
    us_rate = series.get("USA", {}).get("ltrate")
    if us_rate:
        peak_year, peak_value = max(zip(us_rate["years"], us_rate["values"]), key=lambda p: p[1])
        print(f"  · 美国长端利率最高：{peak_year} 年 {peak_value:.2f}%（历史上应在 1981 年前后、约 13–15%）")
        if not (1978 <= peak_year <= 1985 and 12 <= peak_value <= 16):
            print("    ⚠ 与公认史实不符，需要检查")
            ok = False

    return ok


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--refresh", action="store_true", help="强制重新下载")
    parser.add_argument("--verify", action="store_true", help="只核对，不写文件")
    args = parser.parse_args()

    rows = load_rows(args.refresh)
    print(f"读取 {len(rows):,} 行", flush=True)

    series = jst.extract_series(rows)
    print(f"抽取国家 {len(series)} 个：{', '.join(sorted(series))}")

    if not verify(series):
        print("\n核对未通过，拒绝写入。")
        return 1

    if args.verify:
        print("\n（--verify）核对通过，未写入文件。")
        return 0

    payload = jst.build_payload(series)
    jst.write_payload(payload, OUT_PATH)
    size = os.path.getsize(OUT_PATH)
    print(f"\n已写入 {OUT_PATH}（{size:,} bytes）")

    total = sum(payload["counts"].values())
    print(f"共 {total:,} 个年度观测值，覆盖 {payload['coverage']['from']}–{payload['coverage']['to']}")
    for iso in sorted(series):
        parts = [f"{k}:{len(v['years'])}" for k, v in sorted(series[iso].items())]
        print(f"  {iso}: {', '.join(parts)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())