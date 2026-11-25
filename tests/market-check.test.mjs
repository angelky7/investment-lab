/**
 * tests/market-check.test.mjs — 「说法 vs 数据」检验模块的单元测试。
 *
 * 这个模块的价值全在数字与结论一致：结论必须由数字生成，不能写死。
 * 所以测试重点验证：
 * 1. 窗口统计（收益 / 最大回撤）的正确性；
 * 2. 下跌跟随度（区分「防御性」与「避险」的核心指标）；
 * 3. 结论文案会随数据改变而改变（同一函数、不同输入 → 不同结论）。
 *
 * 注意：相关系数与下跌跟随度都要求至少 20 个样本，因此下面的夹具都造够天数。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCheck,
  buildDefensiveCheck,
  correlationOverDays,
  downsideFollow,
  sliceLastDays,
  windowStats,
} from "../js/core/market-check.js";

const near = (actual, expected, tolerance = 1e-9) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `期望 ${expected}，实际 ${actual}`);
};

/**
 * 按日收益率因子造一条序列。
 * @param {string} key @param {string} label
 * @param {number[]} factors 每日收益因子
 * @param {number} initial 起始价
 */
function makeSeries(key, label, factors, initial = 100) {
  const dates = factors.map((_, i) => {
    const d = new Date(Date.UTC(2020, 0, 1) + i * 86400000);
    return d.toISOString().slice(0, 10);
  });
  const prices = [initial];
  let value = initial;
  for (const f of factors) {
    value *= 1 + f;
    prices.push(value);
  }
  return { key, label, dates, prices };
}

/* ------------------------------ 基础工具 ------------------------------- */

test("sliceLastDays：days<=0 返回全区间", () => {
  const dates = ["2024-01-01", "2024-01-02", "2024-01-03"];
  const prices = [1, 2, 3];
  // 窗口是「起点包含、终点包含」的闭区间：days=1 会带上截止日当天
  assert.equal(sliceLastDays(dates, prices, 0).dates.length, 3);
  assert.equal(sliceLastDays(dates, prices, 1).dates.length, 2);
  assert.equal(sliceLastDays(dates, prices, 0.5).dates.length, 1);
});

test("windowStats：收益与最大回撤", () => {
  const dates = ["2024-01-01", "2024-01-02", "2024-01-03", "2024-01-04"];
  const prices = [100, 80, 90, 120];
  const stats = windowStats(dates, prices, 0);
  near(stats.totalReturn, 0.2);
  near(stats.maxDrawdown, -0.2);
  assert.equal(stats.points, 4);
});

/* ----------------------------- 下跌跟随度 ------------------------------ */

/** 基准：每 3 天一次 -2%，其余 +0.5%（40 个下跌日，满足样本量要求） */
function benchFactors(days = 120) {
  return Array.from({ length: days }, (_, i) => (i % 3 === 0 ? -0.02 : 0.005));
}

test("downsideFollow：跟随一半跌幅算「防御性」而不是「避险」", () => {
  const base = benchFactors();
  const bench = makeSeries("bench", "基准", base);
  const candidate = makeSeries(
    "x",
    "防御型",
    base.map((f) => (f < 0 ? f / 2 : f))
  );

  const follow = downsideFollow(candidate, bench, -0.01);
  assert.ok(follow);
  assert.equal(follow.days, 40);
  near(follow.avgReturn, -0.01, 1e-9); // 基准 -2% 的一半
  near(follow.downShare, 1); // 全部同向下跌
});

test("downsideFollow：不相关资产在下跌日平均接近 0", () => {
  const base = benchFactors();
  const bench = makeSeries("bench", "基准", base);
  const flat = makeSeries("flat", "横盘", new Array(base.length).fill(0));

  const follow = downsideFollow(flat, bench, -0.01);
  assert.ok(follow);
  near(follow.avgReturn, 0, 1e-12);
  near(follow.downShare, 0);
});

test("downsideFollow：样本太少返回 null", () => {
  const bench = makeSeries("bench", "基准", [0.001, 0.001, -0.02, 0.001, -0.02]);
  assert.equal(downsideFollow(bench, bench, -0.01), null);
});

/* ------------------------------- 相关性 -------------------------------- */

test("correlationOverDays：完全同步为 1，反向为 -1", () => {
  const base = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 0.01 : -0.008));
  const same = makeSeries("a", "A", base);
  const opposite = makeSeries("b", "B", base.map((f) => -f));
  near(correlationOverDays(same, same, 0), 1, 1e-9);
  near(correlationOverDays(same, opposite, 0), -1, 1e-9);
});

/* --------------------------- 防御性检验结论 ---------------------------- */

test("buildDefensiveCheck：基准排第一、自身相关性为 1、结论随数据生成", () => {
  const base = benchFactors();
  const bench = makeSeries("index:000300", "沪深300（参照）", base);

  // 红利低波：上涨跟 80%，下跌只跌 40%
  const div = makeSeries(
    "etf:512890",
    "红利低波ETF",
    base.map((f) => (f < 0 ? f * 0.4 : f * 0.8))
  );
  // 国债：下跌日反而小涨
  const bond = makeSeries("etf:511010", "国债ETF", base.map((f) => (f < 0 ? 0.001 : 0.0002)));

  const result = buildDefensiveCheck([div, bond], bench);

  assert.equal(result.rows[0].label, "沪深300（参照）");
  assert.equal(result.rows[0].isBench, true);
  near(result.rows[0].correlation, 1);

  const divRow = result.rows.find((r) => r.label === "红利低波ETF");
  assert.ok(divRow.correlation > 0.5, "红利低波应与基准中高相关");
  assert.ok(divRow.follow.avgReturn < 0, "红利低波在下跌日应下跌");
  assert.ok(divRow.follow.downShare > 0.9);

  const bondRow = result.rows.find((r) => r.label === "国债ETF");
  assert.ok(bondRow.follow.avgReturn > 0, "国债在下跌日应不跌");

  assert.ok(result.verdicts.length >= 3);
  assert.ok(result.verdicts.some((v) => v.includes("防御性")));
  assert.ok(result.verdicts.some((v) => v.includes("避险")));
});

/* ---------------------------- 黄金检验结论 ----------------------------- */

test("buildCheck：黄金跌得更多时，结论必须直说", () => {
  const gold = makeSeries("etf:518880", "黄金ETF（人民币）", new Array(400).fill(-0.0008));
  const spx = makeSeries("index:us.INX", "标普500", new Array(400).fill(0.0006));

  const check = buildCheck([gold, spx]);
  assert.ok(check.goldStats);
  assert.ok(check.spxStats);
  assert.ok(check.goldStats.totalReturn < check.spxStats.totalReturn);
  assert.ok(check.verdicts.some((v) => v.includes("黄金跌得更多")));
});

test("buildCheck：黄金跑赢时结论也要跟着翻过来", () => {
  const gold = makeSeries("etf:518880", "黄金ETF（人民币）", new Array(400).fill(0.0009));
  const spx = makeSeries("index:us.INX", "标普500", new Array(400).fill(-0.0006));

  const check = buildCheck([gold, spx]);
  assert.ok(check.verdicts.some((v) => v.includes("这次黄金确实赢了")));
});