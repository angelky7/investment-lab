/**
 * tests/analysis-extras.test.mjs — 新增分析工具的单元测试。
 *
 * 覆盖三处：
 * 1. annualReturns：按自然年切分、跨年基准价取上年末、部分年份标记；
 * 2. netOfFees：年费率逐日折算，20 年后吃掉多少终值；
 * 3. minDrawdownFor：反推「要拿到目标年化，最少要承受多深回撤」。
 *
 * 这三个函数都是被页面直接调用的，出错时页面不会报错、只会显示错数字——
 * 所以必须在这里钉住。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { annualReturns } from "../js/core/stats.js";
import { netOfFees } from "../js/core/portfolio.js";
import { minDrawdownFor } from "../js/core/planner.js";

const near = (actual, expected, tolerance = 1e-9) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `期望 ${expected}，实际 ${actual}`);
};

/* ----------------------------- annualReturns ---------------------------- */

test("annualReturns：按年切分，跨年基准取上年末收盘", () => {
  const dates = [
    "2020-12-30", "2020-12-31", // 上年最后两天
    "2021-01-04", "2021-06-30", "2021-12-31", // 2021 全年
    "2022-01-04", "2022-12-30", // 2022
  ];
  const prices = [90, 100, 105, 120, 130, 110, 141];

  const rows = annualReturns(dates, prices);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.year), [2020, 2021, 2022]);

  // 2021：100 → 130 = +30%
  near(rows[1].ret, 0.3);
  // 2021 年内最大回撤：从 120 跌到 105? 实际序列 100→105→120→130 单调上行，回撤为 0
  near(rows[1].maxDrawdown, 0);
  // 2022：130 → 141 = +8.46%（不是从 110 算）
  near(rows[2].ret, 141 / 130 - 1, 1e-12);
});

test("annualReturns：年内回撤按年内高点计算", () => {
  const dates = ["2020-12-31", "2021-01-04", "2021-06-30", "2021-12-31"];
  const prices = [100, 100, 150, 90];
  const rows = annualReturns(dates, prices);
  // 年内：100 → 150 → 90，从 150 跌到 90 = -40%
  near(rows[1].maxDrawdown, -0.4);
  near(rows[1].ret, -0.1); // 100 → 90
});

test("annualReturns：首年与未走完的最后一年标记为 partial", () => {
  const dates = ["2021-03-01", "2021-12-31", "2022-06-30"];
  const prices = [100, 120, 130];
  const rows = annualReturns(dates, prices);
  assert.equal(rows[0].partial, true, "首年不是完整年度");
  assert.equal(rows[1].partial, true, "最后一年未到 12-31");
});

test("annualReturns：数据不足时返回空数组", () => {
  assert.deepEqual(annualReturns([], []), []);
  assert.deepEqual(annualReturns(["2021-01-04"], [100]), []);
});

/* ------------------------------- netOfFees ------------------------------ */

test("netOfFees：费率 0 时原样返回", () => {
  const values = [100, 110, 120];
  assert.deepEqual(netOfFees(values, 0), values);
});

test("netOfFees：单年后终值约为 (1-fee)", () => {
  // 252 个交易日，价格恒定，扣 1%/年 → 终值约为 (1-0.01) 的 251/252 次方
  const values = new Array(252).fill(100);
  const out = netOfFees(values, 0.01, 252);
  near(out[251], 100 * Math.pow(0.99, 251 / 252), 1e-6);
});

test("netOfFees：20 年 0.6%/年 会吃掉约 11% 的终值", () => {
  const years = 20;
  const values = new Array(252 * years).fill(100);
  const out = netOfFees(values, 0.006, 252);
  const lost = 1 - out[out.length - 1] / 100;
  assert.ok(lost > 0.10 && lost < 0.13, `20 年 0.6% 应吃掉约 11%，实际 ${(lost * 100).toFixed(2)}%`);
});

test("netOfFees：空输入不炸", () => {
  assert.deepEqual(netOfFees([], 0.01), []);
  assert.deepEqual(netOfFees(null, 0.01), []);
});

/* ---------------------------- minDrawdownFor ---------------------------- */

test("minDrawdownFor：在达到目标年化的候选里挑回撤最浅的", () => {
  const search = {
    candidates: [
      { annualized: 0.05, maxDrawdown: -0.1, weights: [1, 0] },
      { annualized: 0.08, maxDrawdown: -0.35, weights: [1, 0] },
      { annualized: 0.09, maxDrawdown: -0.2, weights: [0, 1] },
      { annualized: 0.12, maxDrawdown: -0.5, weights: [1, 1] },
    ],
  };
  const best = minDrawdownFor(search, 0.08);
  assert.ok(best);
  near(best.maxDrawdown, -0.2, 1e-9);
  near(best.annualized, 0.09, 1e-9);
});

test("minDrawdownFor：没有任何候选达到目标时返回 null", () => {
  const search = { candidates: [{ annualized: 0.03, maxDrawdown: -0.1, weights: [] }] };
  assert.equal(minDrawdownFor(search, 0.1), null);
  assert.equal(minDrawdownFor({ candidates: [] }, 0.05), null);
  assert.equal(minDrawdownFor(null, 0.05), null);
});