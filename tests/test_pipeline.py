"""tests/test_pipeline.py — 数据管线单元测试（标准库 unittest，无第三方依赖）。

运行：
    python -m unittest discover -s tests -p "test_*.py" -v
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PROJECT_ROOT)

from data_sources.common import (  # noqa: E402
    AssetDef,
    AssetType,
    Bar,
    Market,
    dedupe_sort,
)
from data_sources.eastmoney import parse_fund_nav, parse_kline_json, secid_for  # noqa: E402
from data_sources.tencent import parse_kline, parse_quote_snapshot  # noqa: E402

# 真实响应结构（已裁剪），用 GBK 编码验证解码逻辑
TENCENT_SAMPLE = {
    "code": 0,
    "msg": "",
    "data": {
        "sh600519": {
            "hfqday": [
                ["2024-01-02", "1580.661", "1550.671", "1583.851", "1543.761", "32156.000"],
                ["2024-01-03", "1546.771", "1559.661", "1560.881", "1541.991", "20229.000"],
            ],
            "qt": {
                "sh600519": [
                    "1",
                    "贵州茅台",
                    "600519",
                    "1463.78",
                    "1460.00",
                    "1458.00",
                    "15738",
                    "7889",
                    "7844",
                    "1462.90",
                ]
                + [""] * 20  # 真实响应里名称/价格之后有大量字段，时间戳位于下标 30
                + ["20261125130628"],
            },
            "prec": "1460.00",
            "version": "1",
        }
    },
}

EASTMONEY_KLINE_SAMPLE = {
    "rc": 0,
    "data": {
        "name": "沪深300",
        "klines": [
            "2024-01-02,3391.63,3386.35,3402.68,3380.29,1580000,2000000.00,0.66,0.21,7.12,0.00",
            "2024-01-03,3385.20,3378.11,3390.00,3370.00,1500000,1900000.00,0.59,-0.24,-8.24,0.00",
        ],
    },
}

FUND_SAMPLE = """
var fS_name = "易方达优质精选混合(QDII)";
var Data_netWorthTrend = [{"x":1213804800000,"y":1.0,"equityReturn":0,"unitMoney":""},
                          {"x":1213891200000,"y":1.0001,"equityReturn":0.01,"unitMoney":""}];
var Data_ACWorthTrend = [[1213804800000,1.0],[1213891200000,1.0001]];
"""


class TestTencentParser(unittest.TestCase):
    def test_parses_bars_and_quote(self):
        raw = json.dumps(TENCENT_SAMPLE, ensure_ascii=False).encode("gbk")
        bars, meta = parse_kline(raw)
        self.assertEqual(len(bars), 2)
        self.assertEqual(bars[0].date, "2024-01-02")
        self.assertAlmostEqual(bars[0].price, 1550.671)  # 第三列是收盘价
        self.assertAlmostEqual(bars[0].open, 1580.661)
        self.assertAlmostEqual(bars[0].high, 1583.851)
        self.assertAlmostEqual(bars[0].low, 1543.761)
        self.assertAlmostEqual(meta["last_close"], 1463.78)
        self.assertEqual(meta["name"], "贵州茅台")
        self.assertEqual(meta["quote_time"], "2026-11-25")

    def test_rejects_error_code(self):
        raw = json.dumps({"code": 1, "data": {}}, ensure_ascii=False).encode("gbk")
        bars, meta = parse_kline(raw)
        self.assertEqual(bars, [])
        self.assertEqual(meta, {})

    def test_rejects_garbage(self):
        bars, meta = parse_kline(b"<html>blocked</html>")
        self.assertEqual(bars, [])

    def test_skips_malformed_rows(self):
        payload = {
            "code": 0,
            "data": {
                "sh000001": {
                    "day": [
                        ["2024-01-02", "1", "2", "3", "4", "5"],
                        ["bad-date", "1", "2", "3", "4", "5"],
                        ["2024-01-03", "x", "y", "z", "w", "v"],
                    ]
                }
            },
        }
        raw = json.dumps(payload).encode("gbk")
        bars, _ = parse_kline(raw)
        self.assertEqual(len(bars), 1)
        self.assertEqual(bars[0].date, "2024-01-02")

    def test_falls_back_to_day_key(self):
        payload = {
            "code": 0,
            "data": {"sh000300": {"day": [["2024-01-02", "1", "3400", "3410", "3390", "100"]]}},
        }
        bars, _ = parse_kline(json.dumps(payload).encode("gbk"))
        self.assertEqual(bars[0].price, 3400.0)

    def test_quote_snapshot(self):
        raw = (
            'v_sh600519="1~贵州茅台~600519~1463.78~1460.00~1458.00";\n'
            'v_sz000001="51~平安银行~000001~11.20~11.10~11.05";\n'
        ).encode("gbk")
        snapshot = parse_quote_snapshot(raw)
        self.assertIn("sh600519", snapshot)
        self.assertAlmostEqual(snapshot["sh600519"]["price"], 1463.78)
        self.assertEqual(snapshot["sh600519"]["name"], "贵州茅台")


class TestEastmoneyParser(unittest.TestCase):
    def test_parses_klines(self):
        bars = parse_kline_json(json.dumps(EASTMONEY_KLINE_SAMPLE).encode("utf-8"))
        self.assertEqual(len(bars), 2)
        self.assertAlmostEqual(bars[0].price, 3386.35)
        self.assertAlmostEqual(bars[0].high, 3402.68)

    def test_handles_jsonp_wrapper(self):
        wrapped = ("jQuery1_1(" + json.dumps(EASTMONEY_KLINE_SAMPLE) + ")").encode("utf-8")
        bars = parse_kline_json(wrapped)
        self.assertEqual(len(bars), 2)

    def test_fund_uses_accumulated_nav(self):
        bars, meta = parse_fund_nav(FUND_SAMPLE.encode("utf-8"))
        self.assertEqual(len(bars), 2)
        self.assertEqual(bars[0].date, "2008-06-19")  # 时间戳按东八区换算
        self.assertEqual(meta["name"], "易方达优质精选混合(QDII)")
        self.assertIn("累计净值", meta["price_basis"])

    def test_fund_falls_back_to_unit_nav(self):
        text = 'var Data_netWorthTrend = [{"x":1213804800000,"y":1.0},{"x":1213891200000,"y":1.2}];'
        bars, meta = parse_fund_nav(text.encode("utf-8"))
        self.assertEqual(len(bars), 2)
        self.assertIn("单位净值", meta["price_basis"])

    def test_fund_without_data(self):
        bars, meta = parse_fund_nav(b"var nothing = 1;")
        self.assertEqual(bars, [])
        self.assertEqual(meta, {})

    def test_secid_derivation(self):
        cn_sh = AssetDef("600519", "贵州茅台", AssetType.STOCK, "sh600519", "消费", Market.CN, 2005, "tencent", "1.600519")
        cn_sz = AssetDef("159915", "创业板ETF", AssetType.ETF, "sz159915", "宽基ETF", Market.CN, 2011, "tencent", "0.159915")
        us = AssetDef("us.INX", "标普500", AssetType.INDEX, "us.INX", "海外指数", Market.US, 2010, "tencent", "100.SPX")
        self.assertEqual(secid_for(cn_sh), "1.600519")
        self.assertEqual(secid_for(cn_sz), "0.159915")
        self.assertEqual(secid_for(us), "100.SPX")


class TestDedupeSort(unittest.TestCase):
    def test_dedupes_and_sorts(self):
        bars = [
            Bar("2024-01-03", 3),
            Bar("2024-01-01", 1),
            Bar("2024-01-02", 2),
            Bar("2024-01-02", 99),  # 重复日期保留首次出现
        ]
        out = dedupe_sort(bars)
        self.assertEqual([b.date for b in out], ["2024-01-01", "2024-01-02", "2024-01-03"])
        self.assertEqual(out[1].price, 2)

    def test_drops_invalid_prices(self):
        out = dedupe_sort([Bar("2024-01-01", 0), Bar("2024-01-02", -5), Bar("2024-01-03", 7)])
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0].date, "2024-01-03")


class TestValidate(unittest.TestCase):
    def test_good_payload_has_no_errors(self):
        from scripts.validate import validate_one

        payload = {
            "symbol": "000300",
            "name": "沪深300",
            "count": 3,
            "dates": ["2024-01-02", "2024-01-03", "2024-01-04"],
            "prices": [3400.0, 3410.0, 3420.0],
        }
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "index_000300.json")
            with open(path, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False)
            errors, warnings, info = validate_one(path, "000300")
        self.assertEqual(errors, [])
        self.assertEqual(info["count"], 3)
        # 3 条数据 < 250，应当产生「点数偏少」的提醒
        self.assertTrue(any("建议 ≥" in w for w in warnings))

    def test_unsorted_dates_detected(self):
        from scripts.validate import validate_one

        payload = {
            "name": "x",
            "count": 2,
            "dates": ["2024-01-03", "2024-01-02"],
            "prices": [1.0, 2.0],
        }
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "a.json")
            with open(path, "w", encoding="utf-8") as f:
                json.dump(payload, f)
            errors, _, _ = validate_one(path, "x")
        self.assertTrue(any("严格递增" in e for e in errors))

    def test_non_positive_price_detected(self):
        from scripts.validate import validate_one

        payload = {
            "name": "x",
            "count": 2,
            "dates": ["2024-01-02", "2024-01-03"],
            "prices": [1.0, -2.0],
        }
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "a.json")
            with open(path, "w", encoding="utf-8") as f:
                json.dump(payload, f)
            errors, _, _ = validate_one(path, "x")
        self.assertTrue(any("非正" in e for e in errors))

    def test_corrupt_json_detected(self):
        from scripts.validate import validate_one

        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "a.json")
            with open(path, "w", encoding="utf-8") as f:
                f.write("{not json")
            errors, _, info = validate_one(path, "a")
        self.assertTrue(any("损坏" in e for e in errors))
        self.assertEqual(info["status"], "corrupt")

    def test_missing_file_is_warning(self):
        from scripts.validate import validate_one

        with tempfile.TemporaryDirectory() as tmp:
            errors, warnings, _ = validate_one(os.path.join(tmp, "nope.json"), "nope")
        self.assertEqual(errors, [])
        self.assertTrue(any("缺失" in w for w in warnings))


class TestRegistry(unittest.TestCase):
    def test_registry_is_consistent(self):
        from scripts.registry import load_asset_defs

        assets = load_asset_defs()
        self.assertGreaterEqual(len(assets), 50)
        keys = {(a.type.value, a.symbol) for a in assets}
        self.assertEqual(len(keys), len(assets), "登记表存在重复资产")
        for asset in assets:
            self.assertTrue(asset.name, f"{asset.symbol} 名称为空")
            self.assertTrue(asset.group, f"{asset.symbol} 缺少分组")
            self.assertGreaterEqual(asset.from_year, 1990)
            if asset.type.value != "fund":
                self.assertTrue(asset.em_secid, f"{asset.symbol} 缺少 em_secid")

    def test_periods_config(self):
        from scripts.registry import load_periods

        periods = load_periods()
        self.assertIn("benchmark", periods)
        self.assertGreaterEqual(len(periods["periods"]), 5)
        for period in periods["periods"]:
            self.assertLess(period["start"], period["end"])
            self.assertTrue(period["name"])


if __name__ == "__main__":
    unittest.main()