"""
tests/test_jst.py — JST 长历史数据的解析与产物校验。

两类测试：
1. `extract_series` 的纯函数行为（fixture 手工构造，不依赖网络与第三方文件）；
2. 已提交的 `data/longrun.json` 是否仍然可用——它被前端读取，
   结构坏了页面不会报错，只会画不出图。
"""

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from data_sources.jst import COUNTRIES, INDICATORS, extract_series  # noqa: E402

LONGRUN = ROOT / "data" / "longrun.json"


def row(iso, year, **fields):
    base = {"iso": iso, "year": year}
    base.update(fields)
    return base


class TestExtractSeries(unittest.TestCase):
    def test_extracts_only_configured_countries(self):
        rows = [
            row("USA", 1900, cpi=10, ltrate=3.5),
            row("ZZZ", 1900, cpi=99, ltrate=9.9),
        ]
        out = extract_series(rows)
        self.assertIn("USA", out)
        self.assertNotIn("ZZZ", out)
        self.assertTrue(set(out) <= set(COUNTRIES))

    def test_sorts_by_year_and_skips_missing(self):
        rows = [
            row("USA", 1902, cpi=12),
            row("USA", 1900, cpi=10),
            row("USA", 1901, cpi=None),
            row("USA", 1903),  # 完全没有 cpi 字段
        ]
        out = extract_series(rows)
        series = out["USA"]["cpi"]
        self.assertEqual(series["years"], [1900, 1902])
        self.assertEqual(series["values"], [10.0, 12.0])

    def test_filters_nan_and_inf(self):
        rows = [
            row("USA", 1900, cpi=float("nan")),
            row("USA", 1901, cpi=float("inf")),
            row("USA", 1902, cpi=11.5),
        ]
        out = extract_series(rows)
        self.assertEqual(out["USA"]["cpi"]["years"], [1902])

    def test_drops_empty_indicators_and_empty_countries(self):
        rows = [row("USA", 1900, ltrate=4.2)]
        out = extract_series(rows)
        self.assertIn("ltrate", out["USA"])
        self.assertNotIn("cpi", out["USA"], "没有数据的指标不应留下空壳")

        empty = extract_series([row("USA", 1900)])
        self.assertEqual(empty, {}, "全部指标为空时该国家应被丢弃")

    def test_accepts_string_numbers_and_rejects_garbage(self):
        rows = [
            row("USA", 1900, cpi="10.5"),
            row("USA", 1901, cpi="n/a"),
        ]
        out = extract_series(rows)
        self.assertEqual(out["USA"]["cpi"]["values"], [10.5])

    def test_rejects_non_integer_years(self):
        rows = [
            row("USA", "1900", cpi=10),
            row("USA", "abc", cpi=11),
            row("USA", None, cpi=12),
        ]
        out = extract_series(rows)
        # "1900" 能转成 int，保留；其余丢弃
        self.assertEqual(out["USA"]["cpi"]["years"], [1900])

    def test_indicator_set_is_limited_to_configured(self):
        rows = [row("USA", 1900, cpi=10, unknown_field=12345)]
        out = extract_series(rows)
        for name in out["USA"]:
            self.assertIn(name, INDICATORS)


class TestCommittedProduct(unittest.TestCase):
    """已提交的 data/longrun.json 必须可被前端使用。"""

    @classmethod
    def setUpClass(cls):
        if not LONGRUN.exists():
            raise unittest.SkipTest("data/longrun.json 不存在（尚未运行 import_jst.py）")
        cls.payload = json.loads(LONGRUN.read_text(encoding="utf-8"))

    def test_schema_and_coverage(self):
        p = self.payload
        self.assertEqual(p["schema"], 1)
        self.assertEqual(p["kind"], "longrun-macro")
        self.assertEqual(p["frequency"], "annual")
        self.assertEqual(p["coverage"]["from"], 1870)
        self.assertEqual(p["coverage"]["to"], 2020)

    def test_source_provenance_present(self):
        src = self.payload["source"]
        for field in ("name", "url", "page", "citation"):
            self.assertTrue(src.get(field), f"缺少来源字段 {field}")

    def test_every_series_is_sorted_and_aligned(self):
        for iso, indicators in self.payload["countries"].items():
            for name, series in indicators.items():
                self.assertEqual(
                    len(series["years"]), len(series["values"]),
                    f"{iso}:{name} 年份与数值长度不一致",
                )
                self.assertEqual(
                    series["years"], sorted(series["years"]),
                    f"{iso}:{name} 年份未排序",
                )
                self.assertGreater(len(series["years"]), 100, f"{iso}:{name} 样本过少")
                for year in series["years"]:
                    self.assertGreaterEqual(year, 1870)
                    self.assertLessEqual(year, 2020)
                    self.assertIsInstance(year, int)

    def test_counts_match_actual_lengths(self):
        counts = self.payload["counts"]
        for iso, indicators in self.payload["countries"].items():
            for name, series in indicators.items():
                self.assertEqual(counts[f"{iso}:{name}"], len(series["years"]))

    def test_known_historical_facts(self):
        """用公认史实钉住数据质量——数据源换了或解析写错了，这里会立刻响。"""
        usa = self.payload["countries"]["USA"]

        def at(indicator, year):
            s = usa[indicator]
            return s["values"][s["years"].index(year)]

        # 大萧条：1929→1933 物价应通缩
        self.assertLess(at("cpi", 1933), at("cpi", 1929))
        # 一战通胀：1913→1920 物价翻倍以上
        self.assertGreater(at("cpi", 1920) / at("cpi", 1913), 1.8)
        # 沃尔克峰值：1981 年长端利率应在 12%–16%
        self.assertGreater(at("ltrate", 1981), 12)
        self.assertLess(at("ltrate", 1981), 16)
        # 二战债务峰值：1945 年债务/GDP 应超过 100%
        self.assertGreater(at("debtgdp", 1945), 1.0)


if __name__ == "__main__":
    unittest.main()