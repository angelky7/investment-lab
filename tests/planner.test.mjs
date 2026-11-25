/**
 * tests/planner.test.mjs — 配置求解器单元测试。
 *
 * 重点验证三件事：
 * 1. 问卷答案到约束的映射（尤其是「期限」与「行为」如何收紧回撤预算）；
 * 2. 单次评估的数学正确性（年化、波动、最大回撤）；
 * 3. 搜索必须遵守分散边界，且预算过紧时如实返回「无解」而不是硬凑。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  ASSET_CLASSES,
  QUESTIONS,
  buildNarrative,
  constraintsFromAnswers,
  evaluateAllocation,
  searchAllocation,
} from "../js/core/planner.js";

const near = (actual, expected, tolerance = 1e-6) => {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `期望 ${expected}，实际 ${actual}`
  );
};

/** 构造 prices: [天][类] */
function buildPrices(days, factors) {
  return Array.from({ length: days }, (_, t) =>
    factors.map((factor) => 100 * Math.pow(factor, t))
  );
}

test("问卷结构完整：4 题、每题 4 个选项", () => {
  assert.equal(QUESTIONS.length, 4);
  for (const question of QUESTIONS) {
    assert.equal(question.options.length, 4, `${question.id} 应有 4 个选项`);
    assert.ok(question.title);
    assert.ok(question.options.every((o) => o.label));
  }
  assert.equal(ASSET_CLASSES.length, 5);
  assert.equal(ASSET_CLASSES.filter((c) => c.equity).length, 2);
});

test("constraintsFromAnswers：期限短会收紧回撤预算", () => {
  const long = constraintsFromAnswers({ drawdown: 0.3, target: [0.05, 0.07], horizon: 10, behavior: "hold" });
  near(long.drawdownBudget, 0.3);
  assert.equal(long.binding.length, 0);

  const short = constraintsFromAnswers({ drawdown: 0.3, target: [0.05, 0.07], horizon: 1, behavior: "hold" });
  near(short.drawdownBudget, 0.1);
  assert.ok(short.binding.some((b) => b.factor === "horizon"));
  assert.equal(short.statedDrawdown, 0.3);
});

test("constraintsFromAnswers：会割肉的人按更低承受力处理", () => {
  const exit = constraintsFromAnswers({ drawdown: 0.3, target: [0.1, 0.2], horizon: 10, behavior: "exit" });
  near(exit.drawdownBudget, 0.12);
  near(exit.equityCap, 0.2);
  assert.ok(exit.binding.some((b) => b.factor === "behavior"));

  const trim = constraintsFromAnswers({ drawdown: 0.3, target: [0.1, 0.2], horizon: 10, behavior: "trim" });
  near(trim.drawdownBudget, 0.25);
  near(trim.equityCap, 0.4);
});

test("evaluateAllocation：价格不变时年化与回撤都为 0", () => {
  const prices = buildPrices(300, [1, 1, 1, 1, 1]);
  const result = evaluateAllocation([0.2, 0.2, 0.2, 0.2, 0.2], prices, { years: 1.19 });
  assert.ok(result);
  near(result.annualized, 0, 1e-9);
  near(result.maxDrawdown, 0, 1e-9);
  near(result.volatility, 0, 1e-9);
});

test("evaluateAllocation：单一资产翻倍的年化正确", () => {
  // 252 个交易日（约 1 年）里从 100 涨到 200
  const prices = Array.from({ length: 253 }, (_, t) =>
    [100 * Math.pow(2, t / 252), 100, 100, 100, 100]
  );
  const result = evaluateAllocation([1, 0, 0, 0, 0], prices, { years: 1 });
  assert.ok(result);
  near(result.annualized, 1, 1e-4);
});

test("evaluateAllocation：最大回撤捕捉中途腰斩", () => {
  const days = 300;
  const prices = Array.from({ length: days }, (_, t) => {
    const value = t < 100 ? 100 + t : t < 120 ? 200 - (t - 100) * 5 : 100 + (t - 120) * 0.5;
    return [value, 100, 100, 100, 100];
  });
  const result = evaluateAllocation([1, 0, 0, 0, 0], prices, { years: 1.19 });
  assert.ok(result);
  assert.ok(result.maxDrawdown <= -0.45, `应识别出近 50% 的回撤，实际 ${result.maxDrawdown}`);
});

test("searchAllocation 遵守分散边界（每档 10%–40%、至少 3 类）", () => {
  // 明显有赢家：第 2 类一路大涨，其余不动
  const prices = buildPrices(600, [1.0002, 1.0009, 1.0001, 1.0001, 1.0]);
  const search = searchAllocation({
    prices,
    years: 2.3,
    budget: 0.5,
    targetLow: 0.05,
    equityFlags: [true, true, false, false, false],
    step: 0.1,
  });

  assert.ok(search.candidates.length > 0);
  assert.ok(search.chosen);

  for (const candidate of search.candidates) {
    for (const weight of candidate.weights) {
      assert.ok(weight >= search.bounds.minWeight - 1e-9, `权重 ${weight} 低于下限`);
      assert.ok(weight <= search.bounds.maxWeight + 1e-9, `权重 ${weight} 高于上限`);
    }
    const meaningful = candidate.weights.filter((w) => w >= search.bounds.minWeight - 1e-9).length;
    assert.ok(meaningful >= 3, "至少 3 类参与");
  }

  // 赢家类应拿到上限 40%，而不是 100%
  const winnerWeight = search.chosen.weights[1];
  near(winnerWeight, 0.4, 1e-9);
});

test("searchAllocation 在预算过紧时返回无解", () => {
  // 每类都在 40 天内腰斩式下跌：任何配置（每档至少 10%）都会超过 5% 的回撤预算
  const days = 60;
  const prices = Array.from({ length: days }, (_, t) => [100 * Math.pow(0.97, t), 100 * Math.pow(0.97, t), 100 * Math.pow(0.97, t), 100 * Math.pow(0.97, t), 100 * Math.pow(0.97, t)]);
  const search = searchAllocation({
    prices,
    years: 0.24,
    budget: 0.05,
    targetLow: 0.05,
    equityFlags: [true, true, false, false, false],
  });
  assert.equal(search.chosen, null);
  assert.ok(search.bestDrawdown, "应给出回撤最浅的候选作为参考");
  assert.ok(Math.abs(search.bestDrawdown.maxDrawdown) > 0.05);
});

test("searchAllocation 支持排除某些资产类别（不配黄金）", () => {
  const prices = buildPrices(600, [1.0004, 1.0005, 1.0001, 1.0008, 1.0]);
  // 第 4 类（黄金）被排除
  const includeMask = [true, true, true, false, true];
  const search = searchAllocation({
    prices,
    years: 2.3,
    budget: 0.5,
    targetLow: 0.05,
    equityFlags: [true, true, false, false, false],
    includeMask,
  });

  assert.ok(search.chosen, "排除一类后仍应有解");
  assert.equal(search.includedIdx.includes(3), false);
  assert.equal(search.bounds.included, 4);
  for (const candidate of search.candidates) {
    assert.equal(candidate.weights[3], 0, "被排除的类别权重必须为 0");
    const sum = candidate.weights.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `权重之和应为 1，实际 ${sum}`);
  }
  assert.equal(search.chosen.weights[3], 0);
});

test("只勾两类时允许更高单档权重（否则无解）", () => {
  const prices = buildPrices(600, [1.0009, 1.0001, 1.0001, 1.0001, 1.0]);
  const search = searchAllocation({
    prices,
    years: 2.3,
    budget: 0.5,
    targetLow: 0.05,
    equityFlags: [true, true, false, false, false],
    includeMask: [true, true, false, false, false],
  });
  assert.ok(search.chosen, "两类也应能算出配比");
  assert.equal(search.bounds.maxWeight, 0.9);
  const sum = search.chosen.weights.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
  // 赢家类会拿到比 40% 更高的权重（这正是「只配两类」的代价）
  assert.ok(search.chosen.weights[0] > 0.4);
});

test("只勾 1 类时明确返回不可行", () => {
  const prices = buildPrices(100, [1, 1, 1, 1, 1]);
  const search = searchAllocation({
    prices,
    years: 0.3,
    budget: 0.5,
    targetLow: 0.05,
    equityFlags: [true, true, false, false, false],
    includeMask: [true, false, false, false, false],
  });
  assert.equal(search.chosen, null);
  assert.ok(search.reason.includes("至少需要勾选 2 个"));
});

test("searchAllocation 尊重权益上限", () => {
  const prices = buildPrices(600, [1.0008, 1.0009, 1.0001, 1.0001, 1.0]);
  const search = searchAllocation({
    prices,
    years: 2.3,
    budget: 1,
    targetLow: 0.05,
    equityCap: 0.2,
    equityFlags: [true, true, false, false, false],
  });
  assert.ok(search.chosen);
  assert.ok(search.chosen.equity <= 0.2 + 1e-9, `权益暴露 ${search.chosen.equity} 超过 20%`);
});

test("buildNarrative：有解时给出约束解读", () => {
  const constraints = constraintsFromAnswers({ drawdown: 0.2, target: [0.05, 0.07], horizon: 5, behavior: "hold" });
  const search = {
    candidates: new Array(100).fill({}),
    feasible: new Array(20).fill({}),
    chosen: {
      weights: [0.2, 0.2, 0.2, 0.2, 0.2],
      annualized: 0.08,
      maxDrawdown: -0.15,
      volatility: 0.1,
      sharpe: 0.55,
      equity: 0.4,
    },
  };
  const narrative = buildNarrative(constraints, search, search.chosen);
  assert.ok(narrative.bullets.length >= 2);
  assert.ok(narrative.bullets.some((b) => b.includes("回撤")));
  assert.equal(narrative.warnings.length, 0);
});

test("buildNarrative：收益达不到目标时要明说", () => {
  const constraints = constraintsFromAnswers({ drawdown: 0.2, target: [0.12, 0.2], horizon: 10, behavior: "hold" });
  const search = { candidates: new Array(100).fill({}), feasible: new Array(10).fill({}), chosen: { annualized: 0.05, maxDrawdown: -0.18, equity: 0.4, weights: [] } };
  const narrative = buildNarrative(constraints, search, search.chosen);
  assert.ok(narrative.warnings.some((w) => w.includes("没能达到")));
});

test("buildNarrative：无解时给出可操作的解释", () => {
  const constraints = constraintsFromAnswers({ drawdown: 0.05, target: [0.1, 0.2], horizon: 10, behavior: "hold" });
  const search = { candidates: [], feasible: [], chosen: null, bestDrawdown: { maxDrawdown: -0.12 } };
  const narrative = buildNarrative(constraints, search, null);
  assert.equal(narrative.bullets.length, 0);
  assert.ok(narrative.warnings.length >= 1);
  assert.ok(narrative.warnings[0].includes("冲突"));
});