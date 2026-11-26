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
        cn_sh = AssetDef(
            symbol="600519", name="贵州茅台", type=AssetType.STOCK, code="sh600519",
            group="消费", market=Market.CN, from_year=2005, source="tencent",
            em_secid="1.600519",
        )
        cn_sz = AssetDef(
            symbol="159915", name="创业板ETF", type=AssetType.ETF, code="sz159915",
            group="宽基ETF", market=Market.CN, from_year=2011, source="tencent",
            em_secid="0.159915",
        )
        us = AssetDef(
            symbol="us.INX", name="标普500", type=AssetType.INDEX, code="us.INX",
            group="海外指数", market=Market.US, from_year=2005, source="tencent",
            em_secid="100.SPX",
        )
        self.assertEqual(secid_for(cn_sh), "1.600519")
        self.assertEqual(secid_for(cn_sz), "0.159915")
        self.assertEqual(secid_for(us), "100.SPX")


FUND_FX_SAMPLE = (
    '/*<script>location.href=\'//sina.com\';</script>*/\n'
    'var _=fx_susdcny("'
    "2005-07-20,8.2765,8.2765,8.2765,8.2765,|"
    "2005-07-21,8.2765,8.2765,8.2765,8.2765,|"
    "2005-07-22,8.1100,8.1100,8.1100,8.1100,|"
    "2015-08-11,6.3101,6.2856,6.3286,6.3248,|"
    "2026-11-25,6.6613,6.6581,6.6760,6.6751,"
    '");'
)


class TestSinaForexParser(unittest.TestCase):
    def test_parses_close_and_ohlc(self):
        from data_sources.sina import parse_forex

        bars = parse_forex(FUND_FX_SAMPLE)
        self.assertEqual(len(bars), 5)
        self.assertEqual(bars[0].date, "2005-07-20")
        # 第 5 个字段是收盘（自检：实时快照最新价 6.6751 与末行一致）
        self.assertAlmostEqual(bars[-1].price, 6.6751)
        row = bars[3]  # 2015-08-11
        self.assertEqual(row.date, "2015-08-11")
        self.assertAlmostEqual(row.open, 6.3101)
        self.assertAlmostEqual(row.low, 6.2856)
        self.assertAlmostEqual(row.high, 6.3286)
        self.assertAlmostEqual(row.price, 6.3248)
        # 低必须不高于开/收，高必须不低于开/收
        for bar in bars:
            self.assertLessEqual(bar.low, min(bar.open, bar.price) + 1e-9)
            self.assertGreaterEqual(bar.high, max(bar.open, bar.price) - 1e-9)

    def test_parses_2005_reform_step(self):
        from data_sources.sina import parse_forex

        bars = parse_forex(FUND_FX_SAMPLE)
        by_date = {b.date: b.price for b in bars}
        # 2005-07-21 汇改：8.2765 → 8.11，这是真实历史跳变
        self.assertAlmostEqual(by_date["2005-07-21"], 8.2765)
        self.assertAlmostEqual(by_date["2005-07-22"], 8.11)

    def test_rejects_garbage(self):
        from data_sources.sina import parse_forex

        self.assertEqual(parse_forex("<html>blocked</html>"), [])
        self.assertEqual(parse_forex('var _=fx("");'), [])


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
    def _write(self, tmp, payload=None, raw=None):
        path = os.path.join(tmp, "a.json")
        with open(path, "w", encoding="utf-8") as f:
            if raw is not None:
                f.write(raw)
            else:
                json.dump(payload, f, ensure_ascii=False)
        return path

    def test_good_payload_has_no_errors(self):
        from scripts.validate import check_integrity

        payload = {
            "symbol": "000300",
            "name": "沪深300",
            "count": 3,
            "dates": ["2024-01-02", "2024-01-03", "2024-01-04"],
            "prices": [3400.0, 3410.0, 3420.0],
        }
        errors, warnings = check_integrity(payload, "000300")
        self.assertEqual(errors, [])
        # 3 条 < MIN_OK_POINTS，应当提醒点数偏少
        self.assertTrue(any("建议 ≥" in w for w in warnings))

    def test_unsorted_dates_detected(self):
        from scripts.validate import check_integrity

        payload = {
            "name": "x",
            "count": 2,
            "dates": ["2024-01-03", "2024-01-02"],
            "prices": [1.0, 2.0],
        }
        errors, _ = check_integrity(payload, "x")
        self.assertTrue(any("严格递增" in e for e in errors))

    def test_non_positive_price_detected(self):
        from scripts.validate import check_integrity

        payload = {
            "name": "x",
            "count": 2,
            "dates": ["2024-01-02", "2024-01-03"],
            "prices": [1.0, -2.0],
        }
        errors, _ = check_integrity(payload, "x")
        self.assertTrue(any("非正" in e for e in errors))

    def test_length_mismatch_detected(self):
        from scripts.validate import check_integrity

        payload = {
            "name": "x",
            "count": 2,
            "dates": ["2024-01-02", "2024-01-03"],
            "prices": [1.0],
        }
        errors, _ = check_integrity(payload, "x")
        self.assertTrue(any("长度不一致" in e for e in errors))

    def test_empty_name_detected(self):
        from scripts.validate import check_integrity

        payload = {"name": "", "count": 2, "dates": ["2024-01-02", "2024-01-03"], "prices": [1, 2]}
        errors, _ = check_integrity(payload, "x")
        self.assertTrue(any("名称为空" in e for e in errors))

    def test_missing_columns_detected(self):
        from scripts.validate import check_integrity

        errors, _ = check_integrity({"name": "x"}, "x")
        self.assertTrue(any("缺少 dates/prices" in e for e in errors))

    def test_missing_analysis_finds_runs(self):
        from scripts.validate import missing_analysis

        calendar = {f"2024-01-{d:02d}" for d in range(2, 13)}  # 11 个交易日
        dates = ["2024-01-02", "2024-01-03", "2024-01-06", "2024-01-07", "2024-01-12"]
        gaps = missing_analysis(dates, calendar)
        self.assertEqual(gaps["missing"], 6)
        self.assertEqual(gaps["max_run"], 4)  # 01-08 ~ 01-11 连续 4 天
        self.assertAlmostEqual(gaps["missing_ratio"], 6 / 11, places=4)

    def test_missing_analysis_no_gap(self):
        from scripts.validate import missing_analysis

        calendar = {"2024-01-02", "2024-01-03"}
        gaps = missing_analysis(["2024-01-02", "2024-01-03"], calendar)
        self.assertEqual(gaps["missing"], 0)
        self.assertEqual(gaps["max_run"], 0)

    def test_missing_analysis_respects_own_span(self):
        from scripts.validate import missing_analysis

        # 资产起始晚于日历起点时，日历更早的日子不应算成缺口
        calendar = {"2023-12-01", "2024-01-02", "2024-01-03"}
        gaps = missing_analysis(["2024-01-02", "2024-01-03"], calendar)
        self.assertEqual(gaps["missing"], 0)


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
            # 恒生指数自 1986 年起（腾讯接口给到 1989-01），所以下限放到 1980
            self.assertGreaterEqual(asset.from_year, 1980, f"{asset.symbol} 起始年份异常")
            # 基金、汇率、中证指数与派生序列都不走东方财富的 secid
            # 走自有接口的数据源（中证官网 / 新浪全球期货 / 派生）都不需要东财的 secid
            needs_secid = asset.type.value not in ("fund", "fx") and asset.source not in (
                "csindex",
                "derived",
                "sina_fut",
                "em_macro",
            )
            if needs_secid:
                self.assertTrue(asset.em_secid, f"{asset.symbol} 缺少 em_secid")
            if asset.source != "derived":
                self.assertTrue(asset.code, f"{asset.symbol} 缺少抓取代码")

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