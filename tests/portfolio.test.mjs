/**
 * tests/portfolio.test.mjs — 组合引擎单元测试。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  bandRebalance,
  correlationMatrix,
  dcaBacktest,
  estimateBeta,
  lumpSumBacktest,
  monthlyBuyIndices,
  rebalanceSimulation,
  stressTest,
  xirr,
} from "../js/core/portfolio.js";

function monthDates(years = 2, startYear = 2020) {
  const dates = [];
  const start = Date.UTC(startYear, 0, 1);
  const end = Date.UTC(startYear + years, 0, 1);
  for (let t = start; t < end; t += 86400000) {
    const d = new Date(t);
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

test("correlationMatrix 识别完全正相关与负相关", () => {
  // 用一组收益率 r 和它的相反数 -r 构造两条序列：
  // 收益率完全成比例，相关系数才恰好是 ±1（收益率恒定会让方差为 0，无法定义相关）。
  const rets = [0.02, -0.01, 0.03, -0.02, 0.015, -0.005];
  const build = (sign) => {
    const prices = [100];
    rets.forEach((r) => prices.push(prices[prices.length - 1] * (1 + sign * r)));
    return prices;
  };
  const up = build(1);
  const mirrored = build(-1);

  const dates = up.map((_, i) => `2024-01-${String(i + 1).padStart(2, "0")}`);
  const { keys, matrix } = correlationMatrix(dates, { a: up, b: up.slice(), c: mirrored });
  assert.deepEqual(keys, ["a", "b", "c"]);
  assert.ok(Math.abs(matrix[0][1] - 1) < 1e-9);
  assert.ok(Math.abs(matrix[0][2] + 1) < 1e-9);
  assert.equal(matrix[0][0], 1);
  assert.equal(matrix[1][0], matrix[0][1]);
});

test("correlationMatrix 少于两项时返回空矩阵", () => {
  const { matrix } = correlationMatrix(["2024-01-01", "2024-01-02"], { a: [1, 2, 3] });
  assert.deepEqual(matrix, []);
});

test("monthlyBuyIndices 每月只买一次", () => {
  const dates = monthDates(2);
  const idx = monthlyBuyIndices(dates, 0, dates.length - 1);
  assert.equal(idx.length, 24);
  const months = new Set(idx.map((i) => dates[i].slice(0, 7)));
  assert.equal(months.size, 24);
});

test("dcaBacktest 在价格恒定时终值等于投入", () => {
  const dates = monthDates(1);
  const prices = dates.map(() => 10);
  const result = dcaBacktest(dates, prices, { monthly: 1000 });
  assert.equal(result.tradeCount, 12);
  assert.equal(result.invested, 12000);
  assert.ok(Math.abs(result.finalValue - 12000) < 1e-6);
  assert.ok(Math.abs(result.totalReturn) < 1e-9);
  assert.ok(Math.abs(result.xirr) < 1e-6);
});

test("dcaBacktest 的逐笔记录与累计投入一致", () => {
  const dates = monthDates(1);
  const prices = dates.map((_, i) => 10 + i * 0.01);
  const result = dcaBacktest(dates, prices, { monthly: 500 });
  const lastTrade = result.trades[result.trades.length - 1];
  assert.ok(Math.abs(lastTrade.totalUnits - result.units) < 1e-9);
  assert.equal(result.invested, 500 * result.tradeCount);
  assert.equal(result.investedSeries[result.endIndex], result.invested);
});

test("dcaBacktest 参数非法时返回 null", () => {
  assert.equal(dcaBacktest([], [], {}), null);
  assert.equal(dcaBacktest(["2020-01-01"], [10], {}), null);
  assert.equal(dcaBacktest(["2020-01-01", "2020-02-01"], [10, 11], { monthly: 0 }), null);
});

test("lumpSumBacktest 投入额等于定投各期之和", () => {
  const dates = monthDates(1);
  const prices = dates.map((_, i) => 10 + i * 0.02);
  const dca = dcaBacktest(dates, prices, { monthly: 1000 });
  const lump = lumpSumBacktest(dates, prices, { monthly: 1000 });
  assert.equal(lump.amount, dca.invested);
  assert.ok(lump.finalValue > 0);
});

test("xirr 对等额现金流给出正确的年化", () => {
  // 2020-01-01 投入 1000，2021-01-01 收回 1100 → 约 10%
  const rate = xirr([
    { date: "2020-01-01", amount: -1000 },
    { date: "2021-01-01", amount: 1100 },
  ]);
  assert.ok(Number.isFinite(rate));
  assert.ok(Math.abs(rate - 0.1) < 2e-3, `xirr ≈ 10%，实际 ${rate}`);
});

test("xirr 现金流符号不足时返回 null", () => {
  assert.equal(xirr([{ date: "2020-01-01", amount: -100 }]), null);
  assert.equal(
    xirr([
      { date: "2020-01-01", amount: -100 },
      { date: "2021-01-01", amount: -100 },
    ]),
    null
  );
});

test("rebalanceSimulation 在等速增长时与不动几乎一致", () => {
  const dates = monthDates(2);
  const prices = dates.map((_, i) => 100 * Math.pow(1.0005, i));
  const result = rebalanceSimulation(dates, { a: prices, b: prices.map((p) => p) }, [0.5, 0.5], {
    everyDays: 63,
    initial: 10000,
  });
  assert.ok(result);
  assert.ok(Math.abs(result.finalValue - result.driftFinal) < 1);
  assert.equal(result.rebalances, Math.floor((dates.length - 1) / 63));
});

test("rebalanceSimulation 返回各档权重序列，且每次调仓后回到目标", () => {
  const dates = monthDates(2);
  // a 单边上涨、b 不动：权重会持续偏离，定期调仓应把它拉回 50%
  const a = dates.map((_, i) => 100 * Math.pow(1.004, i));
  const b = dates.map(() => 100);
  const result = rebalanceSimulation(dates, { a, b }, [0.5, 0.5], { everyDays: 63, initial: 10000 });

  assert.ok(result);
  assert.ok(Array.isArray(result.weightSeries));
  assert.equal(result.weightSeries.length, 2);
  assert.equal(result.weightSeries[0].length, dates.length);

  // 第一天就是目标权重
  assert.ok(Math.abs(result.weightSeries[0][0] - 0.5) < 1e-9);
  // 每次调仓当天（t % 63 === 0）权重回到 50%
  for (const event of result.events) {
    const w = result.weightSeries[0][event.index];
    assert.ok(Math.abs(w - 0.5) < 1e-9, `调仓日 ${event.date} 的权重应回到 50%，实际 ${w}`);
  }
  // 未到调仓日时，上涨资产的权重会高于目标
  const mid = 40;
  assert.ok(result.weightSeries[0][mid] > 0.5);
  // 每档市值之和等于组合总市值
  const sum = result.sleeveValues.reduce((acc, series) => acc + series[mid], 0);
  assert.ok(Math.abs(sum - result.valueSeries[mid]) < 1e-6);
});

test("rebalanceSimulation 拒绝不合法权重", () => {
  const dates = monthDates(1);
  const prices = dates.map(() => 100);
  assert.equal(rebalanceSimulation(dates, { a: prices, b: prices }, [0.5, 0.3]), null);
});

test("estimateBeta 对同一序列给出 1", () => {
  const prices = Array.from({ length: 200 }, (_, i) => 100 * (1 + (i % 7) / 1000));
  const dates = prices.map((_, i) => {
    const d = new Date(Date.UTC(2022, 0, 1) + i * 86400000);
    return d.toISOString().slice(0, 10);
  });
  assert.ok(Math.abs(estimateBeta(dates, prices, dates, prices) - 1) < 1e-9);
});

test("stressTest 用真实历史区间计算资产跌幅", () => {
  const assets = [
    {
      key: "bench",
      name: "基准",
      dates: ["2020-01-01", "2020-01-15", "2020-02-01", "2020-03-01"],
      prices: [100, 90, 80, 120],
    },
    {
      key: "bond",
      name: "债券",
      dates: ["2020-01-01", "2020-01-15", "2020-02-01", "2020-03-01"],
      prices: [100, 101, 102, 103],
    },
  ];
  const scenarios = [
    { id: "s1", name: "冲击", start: "2020-01-01", end: "2020-03-01", description: "" },
  ];
  const rows = stressTest(assets, scenarios, {
    benchmarkKey: "bench",
    weights: { bench: 0.5, bond: 0.5 },
  });
  assert.equal(rows.length, 1);
  const benchRow = rows[0].assets.find((a) => a.key === "bench");
  const bondRow = rows[0].assets.find((a) => a.key === "bond");
  assert.ok(Math.abs(benchRow.return - 0.2) < 1e-9);
  assert.ok(Math.abs(bondRow.return - 0.03) < 1e-9);
  assert.equal(benchRow.estimated, false);
  assert.ok(Math.abs(rows[0].portfolioReturn - 0.115) < 1e-9);
});

test("stressTest 对缺数据的资产用 beta 估算并标注", () => {
  const assets = [
    { key: "bench", name: "基准", dates: ["2020-01-01", "2020-03-01"], prices: [100, 70] },
    { key: "late", name: "新资产", dates: ["2024-01-01", "2024-02-01"], prices: [10, 11] },
  ];
  const scenarios = [{ id: "s", name: "冲击", start: "2020-01-01", end: "2020-03-01" }];
  const rows = stressTest(assets, scenarios, {
    benchmarkKey: "bench",
    weights: { bench: 0.5, late: 0.5 },
    betas: { late: 1.5 },
  });
  const late = rows[0].assets.find((a) => a.key === "late");
  assert.equal(late.estimated, true);
  assert.ok(Math.abs(late.return - 1.5 * -0.3) < 1e-9);
});
const GRID_DATES = (n, startYear = 2020) =>
  Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(startYear, 0, 1) + i * 86400000);
    return d.toISOString().slice(0, 10);
  });

test("bandRebalance 在单档暴涨越过阈值时再平衡", () => {
  const dates = GRID_DATES(300);
  // 四档各 25%，其中 a 每天涨 1%，其余不动 → a 的权重很快越过 35%
  const a = dates.map((_, i) => 100 * Math.pow(1.01, i));
  const flat = dates.map(() => 100);
  const result = bandRebalance(
    dates,
    { a, b: flat, c: flat, d: flat },
    [0.25, 0.25, 0.25, 0.25],
    { lower: 0.15, upper: 0.35 }
  );

  assert.ok(result);
  assert.ok(result.rebalances >= 2, `应多次触发再平衡，实际 ${result.rebalances}`);
  assert.equal(result.events.length, result.rebalances);
  // 每次再平衡的触发档都确实越界了
  for (const event of result.events) {
    assert.ok(event.weight > 0.35 || event.weight < 0.15, `触发时权重 ${event.weight} 应越界`);
  }
  // 再平衡把 a 的权重拉回目标附近：没有再平衡的话它会远高于 35%
  const driftWeight = (() => {
    const units = [0.25, 0.25, 0.25, 0.25].map((w) => (10000 * w) / 100);
    const prices = [a[a.length - 1], 100, 100, 100];
    const values = units.map((u, i) => u * prices[i]);
    return values[0] / values.reduce((x, y) => x + y, 0);
  })();
  const finalWeight = result.sleeveFinal.a / result.finalValue;
  assert.ok(finalWeight < driftWeight, `再平衡后权重 ${finalWeight} 应低于不调整的 ${driftWeight}`);
});

test("bandRebalance 在窄幅波动时不触发", () => {
  const dates = GRID_DATES(200, 2021);
  // 四档都在 100 附近小幅震荡，权重始终在 25%±几个百分点以内
  const wave = (phase) => dates.map((_, i) => 100 + Math.sin(i / 12 + phase) * 2);
  const result = bandRebalance(
    dates,
    { a: wave(0), b: wave(1.5), c: wave(3), d: wave(4.5) },
    [0.25, 0.25, 0.25, 0.25],
    { lower: 0.15, upper: 0.35 }
  );
  assert.ok(result);
  assert.equal(result.rebalances, 0);
});

test("bandRebalance 拒绝不合法输入", () => {
  const dates = ["2024-01-01", "2024-01-02", "2024-01-03"];
  assert.equal(bandRebalance(dates, { a: [1, 2, 3] }, [1], {}), null);
  assert.equal(bandRebalance(dates, { a: [1, 2, 3], b: [1, 2, 3] }, [0.5, 0.4], {}), null);
});
