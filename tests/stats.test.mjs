/**
 * tests/stats.test.mjs — 指标引擎单元测试。
 *
 * 用「可以手算」的小样本验证公式，避免出现「数字好看但算错」的情况。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  annualizedReturn,
  annualizedVolatility,
  betaAlpha,
  calmarRatio,
  downsideDeviation,
  maxDrawdown,
  sortinoRatio,
  sharpeRatio,
  totalReturn,
  winLoss,
  yearsBetween,
  analyze,
  DEFAULT_RISK_FREE,
} from "../js/core/stats.js";

const near = (actual, expected, tolerance = 1e-6) => {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `期望 ${expected}，实际 ${actual}（允许误差 ${tolerance}）`
  );
};

test("yearsBetween 用自然日计算年数", () => {
  near(yearsBetween("2020-01-01", "2021-01-01"), 366 / 365.25, 1e-9);
  assert.equal(yearsBetween("2021-01-01", "2020-01-01"), 0);
  assert.equal(yearsBetween("", "2020-01-01"), 0);
});

test("totalReturn 与 annualizedReturn 的基本关系", () => {
  const dates = ["2020-01-01", "2020-12-31"];
  const prices = [100, 110];
  near(totalReturn(prices), 0.1);
  const ann = annualizedReturn(prices, dates);
  const years = yearsBetween(dates[0], dates[1]);
  near(ann, Math.pow(1.1, 1 / years) - 1, 1e-9);
});

test("数据点过少时不返回年化数字", () => {
  assert.equal(annualizedReturn([100], ["2020-01-01"]), null);
  assert.equal(annualizedReturn([100, 110], ["2020-01-01", "2020-01-02"]), null);
  assert.equal(annualizedVolatility([100]), null);
});

test("maxDrawdown 找出回撤区间与修复天数", () => {
  const prices = [100, 120, 60, 90, 121];
  const dates = ["d1", "d2", "d3", "d4", "d5"];
  const mdd = maxDrawdown(prices, dates);
  near(mdd.value, -0.5); // 120 → 60
  assert.equal(mdd.peakIndex, 1);
  assert.equal(mdd.troughIndex, 2);
  assert.equal(mdd.recoveryIndex, 4);
  assert.equal(mdd.recoveryDays, 2);
});

test("未修复的回撤返回 null 修复天数", () => {
  const mdd = maxDrawdown([100, 50, 60], ["d1", "d2", "d3"]);
  near(mdd.value, -0.5);
  assert.equal(mdd.recoveryIndex, null);
  assert.equal(mdd.recoveryDays, null);
});

test("零波动的序列不产生夏普比率", () => {
  const flat = Array(40).fill(100);
  assert.equal(annualizedVolatility(flat), 0);
  assert.equal(sharpeRatio(flat, DEFAULT_RISK_FREE, []), null);
});

test("下行波动只统计下跌部分", () => {
  const prices = [100, 110, 99, 108.9];
  const down = downsideDeviation(prices);
  const vol = annualizedVolatility(prices);
  assert.ok(down !== null && vol !== null);
  assert.ok(down >= 0);
  // 上行收益不应增加下行波动：把奇数日换成大涨，下行波动不应变大太多
  const upOnly = [100, 150, 100, 150];
  assert.ok(downsideDeviation(upOnly) <= downsideDeviation([100, 150, 50, 150]) + 1e-9);
});

test("索提诺与卡玛在正常数据上可计算", () => {
  const prices = [100];
  for (let i = 1; i <= 400; i += 1) {
    prices.push(prices[i - 1] * (i % 7 === 0 ? 0.985 : 1.0025));
  }
  const dates = prices.map((_, i) => {
    const d = new Date(Date.UTC(2020, 0, 1) + i * 86400000);
    return d.toISOString().slice(0, 10);
  });
  const sortino = sortinoRatio(prices, 0.025, dates);
  const calmar = calmarRatio(prices, dates);
  assert.ok(Number.isFinite(sortino));
  assert.ok(Number.isFinite(calmar));
});

test("winLoss 统计涨跌天数与极值", () => {
  const stats = winLoss([100, 110, 99, 108.9]);
  assert.equal(stats.days, 3);
  assert.equal(stats.upDays, 2);
  assert.equal(stats.downDays, 1);
  near(stats.bestDay, 0.1);
  near(stats.worstDay, -0.1); // 浮点误差来自 99/110-1 的计算路径
});

test("betaAlpha 对完全同步的资产给出 beta≈1、alpha≈0", () => {
  const bench = [100];
  for (let i = 1; i <= 300; i += 1) bench.push(bench[i - 1] * (1 + (i % 5 === 0 ? -0.01 : 0.002)));
  const dates = bench.map((_, i) => {
    const d = new Date(Date.UTC(2020, 0, 1) + i * 86400000);
    return d.toISOString().slice(0, 10);
  });
  const { beta, alpha, correlation } = betaAlpha(bench, bench, 0.025, dates);
  near(beta, 1, 1e-9);
  near(alpha, 0, 1e-9);
  near(correlation, 1, 1e-9);
});

test("analyze 数据不足时给出明确原因", () => {
  const result = analyze([100], ["2020-01-01"]);
  assert.equal(result.ok, false);
  assert.match(result.reason, /数据不足/);
});

test("analyze 输出各主要字段且无 NaN", () => {
  const prices = [100];
  for (let i = 1; i <= 800; i += 1) {
    prices.push(prices[i - 1] * (1 + ((i % 11) - 5) / 900));
  }
  const dates = prices.map((_, i) => {
    const d = new Date(Date.UTC(2018, 0, 1) + i * 86400000);
    return d.toISOString().slice(0, 10);
  });
  const result = analyze(prices, dates, { riskFreeRate: 0.03 });
  assert.equal(result.ok, true);
  for (const key of ["totalReturn", "annualizedReturn", "volatility", "sharpe", "sortino", "calmar"]) {
    assert.ok(Number.isFinite(result[key]), `${key} 应为有限数值，实际 ${result[key]}`);
  }
  assert.equal(result.points, prices.length);
  assert.ok(result.drawdownSeries.length === prices.length);
  assert.ok(result.rolling1y.length === prices.length);
});