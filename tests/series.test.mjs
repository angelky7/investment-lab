/**
 * tests/series.test.mjs — 序列工具单元测试。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  alignByDate,
  cumulative,
  dateRangeIndices,
  drawdowns,
  downsampleIndices,
  histogram,
  lowerBound,
  normalize,
  returns,
  scaleDisplay,
  sliceLastYears,
} from "../js/core/series.js";

test("returns 与 cumulative 互补", () => {
  const prices = [100, 110, 99];
  const rets = returns(prices);
  assert.equal(rets.length, 2);
  assert.ok(Math.abs(rets[0] - 0.1) < 1e-12);
  assert.ok(Math.abs(rets[1] - -0.1) < 1e-12);
  const cum = cumulative(prices);
  assert.equal(cum[0], 0);
  assert.ok(Math.abs(cum[2] - -0.01) < 1e-12);
});

test("normalize 归一到指定基准", () => {
  const out = normalize([50, 100, 75], 100);
  assert.deepEqual(out, [100, 200, 150]);
});

test("drawdowns 恒不为正", () => {
  const dd = drawdowns([100, 120, 60, 130]);
  assert.ok(dd.every((v) => v <= 0));
  assert.ok(Math.abs(dd[2] - -0.5) < 1e-12);
  assert.equal(dd[3], 0);
});

test("scaleDisplay 保持收益率不变，末值等于最新价", () => {
  const hfq = [9822.88 / 6.7, 5000, 9822.88];
  const display = scaleDisplay(hfq, 1463.78);
  assert.ok(Math.abs(display[display.length - 1] - 1463.78) < 1e-6);
  const r1 = hfq[2] / hfq[0] - 1;
  const r2 = display[2] / display[0] - 1;
  assert.ok(Math.abs(r1 - r2) < 1e-9);
});

test("alignByDate 取日期交集，不错位", () => {
  const a = { key: "a", dates: ["2020-01-01", "2020-01-02", "2020-01-03", "2020-01-06"], prices: [1, 2, 3, 4] };
  const b = { key: "b", dates: ["2020-01-02", "2020-01-03", "2020-01-06"], prices: [10, 20, 40] };
  const aligned = alignByDate([a, b]);
  assert.deepEqual(aligned.dates, ["2020-01-02", "2020-01-03", "2020-01-06"]);
  assert.deepEqual(aligned.values.a, [2, 3, 4]);
  assert.deepEqual(aligned.values.b, [10, 20, 40]);
});

test("alignByDate 单序列直接返回自身", () => {
  const a = { key: "a", dates: ["2020-01-01"], prices: [5] };
  const aligned = alignByDate([a]);
  assert.deepEqual(aligned.dates, ["2020-01-01"]);
  assert.deepEqual(aligned.values.a, [5]);
});

test("sliceLastYears 按自然年回溯", () => {
  const dates = ["2018-06-30", "2019-06-30", "2020-06-30", "2021-06-30"];
  const prices = [1, 2, 3, 4];
  const sliced = sliceLastYears(dates, prices, 2);
  assert.deepEqual(sliced.dates, ["2019-06-30", "2020-06-30", "2021-06-30"]);
  const all = sliceLastYears(dates, prices, Infinity);
  assert.equal(all.dates.length, 4);
});

test("lowerBound 与 dateRangeIndices 定位正确", () => {
  const dates = ["2020-01-01", "2020-02-01", "2020-03-01"];
  assert.equal(lowerBound(dates, "2020-02-01"), 1);
  assert.equal(lowerBound(dates, "2020-02-15"), 2);
  const range = dateRangeIndices(dates, "2020-01-15", "2020-02-15");
  assert.equal(range.start, 1);
  assert.equal(range.end, 1);
});

test("downsampleIndices 保留首尾且不超过目标点数", () => {
  const idx = downsampleIndices(5000, 500);
  assert.equal(idx[0], 0);
  assert.equal(idx[idx.length - 1], 4999);
  assert.ok(idx.length <= 502);
  assert.equal(new Set(idx).size, idx.length);
});

test("histogram 分箱总数守恒", () => {
  const values = Array.from({ length: 1000 }, (_, i) => (i - 500) / 10000);
  const { counts, edges } = histogram(values, 20);
  assert.equal(counts.length, 20);
  assert.equal(edges.length, 21);
  assert.equal(
    counts.reduce((a, b) => a + b, 0),
    1000
  );
});

test("histogram 处理全等值", () => {
  const { counts } = histogram([0.01, 0.01, 0.01], 10);
  assert.equal(counts.reduce((a, b) => a + b, 0), 3);
});