/**
 * tests/inflation-simulate-export.test.mjs — 新增核心模块的单元测试。
 *
 * 这三个模块有一个共同点：它们**改变数字的含义**，而不是改变界面。
 * CPI 折算错一个月，实际收益就整体偏移；蒙特卡洛种子不确定，用户看到的就是随机数；
 * 指纹算法换一次，别人手里的校验值就全失效。所以必须有断言钉住。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { alignCpiToDates, deflate, realAnnualized } from "../js/core/inflation.js";
import { bootstrap, monthlyReturns, mulberry32, percentile } from "../js/core/simulate.js";
import { buildCsv, fingerprint, serializeSeries } from "../js/core/export.js";

const near = (actual, expected, tolerance = 1e-9) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `期望 ${expected}，实际 ${actual}`);
};

/* -------------------------------- inflation ------------------------------ */

test("alignCpiToDates：按月向前填充，而不是插值", () => {
  const cpi = { dates: ["2024-01-01", "2024-02-01", "2024-03-01"], prices: [100, 101, 102] };
  const dates = ["2024-01-15", "2024-01-31", "2024-02-01", "2024-02-20", "2024-03-05"];
  const levels = alignCpiToDates(dates, cpi);
  assert.deepEqual(levels, [100, 100, 101, 101, 102]);
});

test("alignCpiToDates：早于第一条 CPI 的日期返回 NaN", () => {
  const cpi = { dates: ["2024-02-01"], prices: [105] };
  const levels = alignCpiToDates(["2024-01-05", "2024-02-05"], cpi);
  assert.ok(Number.isNaN(levels[0]));
  near(levels[1], 105);
});

test("deflate：用期初 CPI 折算，累计通胀算得对", () => {
  const dates = ["2024-01-01", "2024-06-01", "2024-12-01"];
  const prices = [100, 110, 120];
  const cpi = { dates: ["2024-01-01", "2024-12-01"], prices: [100, 110] };

  const real = deflate(dates, prices, cpi);
  assert.equal(real.prices.length, 3);
  near(real.totalInflation, 0.1, 1e-12);
  // 价格涨 20%，通胀 10% → 实际涨 120/110 = 1.0909
  near(real.prices[2], 120 / 1.1, 1e-12);
  // 第一期实际价格永远等于名义价格
  near(real.prices[0], 100);
});

test("deflate：CPI 覆盖不足时截掉前面的点并标记 startIndex", () => {
  const dates = ["2023-01-01", "2023-06-01", "2024-01-01", "2024-06-01"];
  const prices = [100, 105, 110, 120];
  const cpi = { dates: ["2024-01-01"], prices: [200] };
  const real = deflate(dates, prices, cpi);
  assert.equal(real.startIndex, 2);
  assert.equal(real.prices.length, 2);
});

test("deflate：没有 CPI 数据时返回空", () => {
  const real = deflate(["2024-01-01"], [100], { dates: [], prices: [] });
  assert.equal(real.startIndex, -1);
  assert.deepEqual(real.prices, []);
  assert.equal(real.totalInflation, null);
});

test("realAnnualized：费雪方程是相除不是相减", () => {
  // 名义 10%、通胀 10% → 实际恰好 0（相减也是 0，这里取更有区分度的例子）
  near(realAnnualized(0.1, 0.1), 0, 1e-12);
  // 名义 7%、通胀 5% → 实际 1.9%，不是 2%
  near(realAnnualized(0.07, 0.05), 1.07 / 1.05 - 1, 1e-12);
  assert.equal(realAnnualized(null, 0.02), null);
});

/* -------------------------------- simulate ------------------------------- */

test("monthlyReturns：每月结算一次，最后一个月也要补上", () => {
  const dates = ["2024-01-01", "2024-01-31", "2024-02-29", "2024-03-29"];
  const prices = [100, 110, 121, 121];
  const rets = monthlyReturns(dates, prices);
  // 三个月 = 三个收益：1 月 110/100、2 月 121/110、3 月 121/121
  assert.equal(rets.length, 3);
  near(rets[0], 110 / 100 - 1, 1e-12);
  near(rets[1], 121 / 110 - 1, 1e-12);
  near(rets[2], 0, 1e-12);
});

test("percentile：线性插值", () => {
  const sorted = [1, 2, 3, 4, 5];
  near(percentile(sorted, 0.5), 3);
  near(percentile(sorted, 0.25), 2);
  near(percentile(sorted, 0), 1);
  near(percentile(sorted, 1), 5);
});

test("bootstrap：确定性种子 → 同输入同输出", () => {
  const returns = [0.01, -0.02, 0.03, -0.01, 0.02, 0.0];
  const a = bootstrap(returns, { years: 5, paths: 200, initial: 10000, seed: 42 });
  const b = bootstrap(returns, { years: 5, paths: 200, initial: 10000, seed: 42 });
  assert.deepEqual(a.terminal, b.terminal);
  assert.equal(a.terminal.length, 200);
  // 分位数必须单调
  assert.ok(a.percentiles.p5 <= a.percentiles.p50);
  assert.ok(a.percentiles.p50 <= a.percentiles.p95);
});

test("bootstrap：全为负收益时亏损概率 100%", () => {
  const result = bootstrap([-0.01, -0.02, -0.005], { years: 10, paths: 100, seed: 1 });
  near(result.lossProbability, 1, 1e-12);
});

test("bootstrap：全为正收益时亏损概率 0，且终值高于本金", () => {
  const result = bootstrap([0.01, 0.02, 0.005], { years: 10, paths: 100, seed: 7 });
  near(result.lossProbability, 0, 1e-12);
  assert.ok(result.percentiles.p5 > 10000);
});

test("bootstrap：空样本不炸", () => {
  const result = bootstrap([], { years: 5 });
  assert.deepEqual(result.terminal, []);
  assert.equal(result.percentiles, null);
});

test("mulberry32：值域在 [0,1) 且可复现", () => {
  const a = mulberry32(123);
  const b = mulberry32(123);
  for (let i = 0; i < 5; i += 1) {
    const v = a();
    assert.ok(v >= 0 && v < 1);
    near(v, b());
  }
});

/* --------------------------------- export -------------------------------- */

test("serializeSeries：格式固定为 日期:6位小数", () => {
  const text = serializeSeries(["2024-01-01", "2024-01-02"], [1.5, 2]);
  assert.equal(text, "2024-01-01:1.500000\n2024-01-02:2.000000");
});

test("fingerprint：同数据同指纹，改一个数指纹就变，长度 12", async () => {
  const a = await fingerprint(["2024-01-01", "2024-01-02"], [1, 2]);
  const b = await fingerprint(["2024-01-01", "2024-01-02"], [1, 2]);
  const c = await fingerprint(["2024-01-01", "2024-01-02"], [1, 3]);
  assert.equal(a.value, b.value);
  assert.notEqual(a.value, c.value);
  assert.equal(a.value.length, 12);
  assert.equal(a.length, 2);
  assert.ok(["sha256", "fnv1a"].includes(a.algorithm));
});

test("buildCsv：带 BOM、逗号与引号正确转义", () => {
  const csv = buildCsv(
    [{ label: "date" }, { label: "note" }],
    [
      ["2024-01-01", "含,逗号"],
      ["2024-01-02", '含"引号'],
    ]
  );
  assert.ok(csv.startsWith("\ufeff"));
  assert.ok(csv.includes('"含,逗号"'));
  assert.ok(csv.includes('"含""引号"'));
  assert.equal(csv.trim().split("\n").length, 3);
});