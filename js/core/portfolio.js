/**
 * js/core/portfolio.js — 组合分析引擎（纯函数）。
 *
 * 包含：相关性矩阵、定投回测（含 XIRR）、定投 vs 一次性、再平衡模拟、
 * 历史情景压力测试。
 *
 * 与旧版的关键差异：
 * 1. 相关性改用**日期交集**对齐，消除起始日期不同造成的错位；
 * 2. 定投按「每月首个交易日」买入，而不是每 21 个自然行买入；
 * 3. 定投收益同时给出 XIRR（资金加权年化），这才是分期投入的正确年化口径；
 * 4. 压力测试走**真实历史区间**，不再用「指数跌幅 × 1.2」这种拍脑袋系数。
 */

import { TRADING_DAYS, gapAwareReturns, returns } from "./series.js";
import { annualizedReturn, yearsBetween } from "./stats.js";

/* --------------------------------- 相关性 -------------------------------- */

/**
 * Pearson 相关系数矩阵。
 * @param {string[]} dates 已对齐的交易日
 * @param {Record<string, number[]>} values 已对齐的价格序列
 * @returns {{keys: string[], matrix: number[][]}}
 */
export function correlationMatrix(dates, values) {
  const keys = Object.keys(values).filter((k) => values[k].length > 2);
  if (keys.length < 2) return { keys, matrix: [] };

  const returnsMap = {};
  for (const key of keys) {
    // 跳空感知：停牌与数据空洞不应被当成「一天涨跌 30%」污染相关系数
    returnsMap[key] = dates?.length
      ? gapAwareReturns(dates, values[key]).returns
      : returns(values[key]);
  }

  const matrix = keys.map(() => keys.map(() => 0));
  for (let i = 0; i < keys.length; i += 1) {
    matrix[i][i] = 1;
    for (let j = i + 1; j < keys.length; j += 1) {
      const a = returnsMap[keys[i]];
      const b = returnsMap[keys[j]];
      const n = Math.min(a.length, b.length);
      if (n < 3) {
        matrix[i][j] = matrix[j][i] = 0;
        continue;
      }
      const ai = a.slice(-n);
      const bi = b.slice(-n);
      let ma = 0;
      let mb = 0;
      for (let k = 0; k < n; k += 1) {
        ma += ai[k];
        mb += bi[k];
      }
      ma /= n;
      mb /= n;
      let cov = 0;
      let va = 0;
      let vb = 0;
      for (let k = 0; k < n; k += 1) {
        const da = ai[k] - ma;
        const db = bi[k] - mb;
        cov += da * db;
        va += da * da;
        vb += db * db;
      }
      const denom = Math.sqrt(va * vb);
      const r = denom === 0 ? 0 : cov / denom;
      matrix[i][j] = r;
      matrix[j][i] = r;
    }
  }
  return { keys, matrix };
}

/* ---------------------------------- XIRR --------------------------------- */

/**
 * 资金加权年化收益率（内部收益率）。
 * @param {{date: string, amount: number}[]} flows 现金流：投入为负，赎回/终值为正
 */
export function xirr(flows) {
  if (flows.length < 2) return null;
  const hasPositive = flows.some((f) => f.amount > 0);
  const hasNegative = flows.some((f) => f.amount < 0);
  if (!hasPositive || !hasNegative) return null;

  const t0 = Date.parse(`${flows[0].date}T00:00:00Z`);
  const years = flows.map((f) => (Date.parse(`${f.date}T00:00:00Z`) - t0) / (365.25 * 86400000));
  if (!years.some((y) => y > 0)) return null;

  const npv = (rate) => {
    let sum = 0;
    for (let i = 0; i < flows.length; i += 1) {
      sum += flows[i].amount / Math.pow(1 + rate, years[i]);
    }
    return sum;
  };

  let lo = -0.9999;
  let hi = 10;
  let fLo = npv(lo);
  let fHi = npv(hi);
  if (!Number.isFinite(fLo) || !Number.isFinite(fHi) || fLo * fHi > 0) return null;

  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + hi) / 2;
    const fMid = npv(mid);
    if (Math.abs(fMid) < 1e-9) return mid;
    if (fLo * fMid <= 0) {
      hi = mid;
      fHi = fMid;
    } else {
      lo = mid;
      fLo = fMid;
    }
  }
  return (lo + hi) / 2;
}

/* --------------------------------- 定投 ---------------------------------- */

/** 找出每个月的第一个交易日下标 */
export function monthlyBuyIndices(dates, startIndex = 0, endIndex = dates.length - 1) {
  const out = [];
  let lastKey = "";
  for (let i = Math.max(0, startIndex); i <= Math.min(dates.length - 1, endIndex); i += 1) {
    const key = dates[i]?.slice(0, 7);
    if (key && key !== lastKey) {
      out.push(i);
      lastKey = key;
    }
  }
  return out;
}

/**
 * 定投回测。
 * @param {string[]} dates
 * @param {number[]} prices
 * @param {{monthly?: number, startIndex?: number, endIndex?: number}} [options]
 */
export function dcaBacktest(dates, prices, options = {}) {
  const monthly = Number.isFinite(options.monthly) ? options.monthly : 1000;
  if (!dates?.length || prices.length !== dates.length || prices.length < 2 || monthly <= 0) {
    return null;
  }
  const startIndex = Math.max(0, options.startIndex ?? 0);
  const endIndex = Math.min(prices.length - 1, options.endIndex ?? prices.length - 1);
  if (startIndex >= endIndex) return null;

  const buyIndices = monthlyBuyIndices(dates, startIndex, endIndex);
  if (!buyIndices.length) return null;

  const trades = [];
  const investedSeries = new Array(prices.length).fill(0);
  const valueSeries = new Array(prices.length).fill(0);
  const flows = [];

  let units = 0;
  let invested = 0;
  let cursor = 0;

  for (let i = startIndex; i <= endIndex; i += 1) {
    if (cursor < buyIndices.length && buyIndices[cursor] === i) {
      const price = prices[i];
      if (price > 0) {
        const bought = monthly / price;
        units += bought;
        invested += monthly;
        trades.push({ date: dates[i], index: i, price, units: bought, totalUnits: units });
        flows.push({ date: dates[i], amount: -monthly });
      }
      cursor += 1;
    }
    investedSeries[i] = invested;
    valueSeries[i] = units * prices[i];
  }

  // startIndex 之前的点补 0，便于与价格序列同轴绘制
  for (let i = 0; i < startIndex; i += 1) {
    investedSeries[i] = 0;
    valueSeries[i] = 0;
  }

  const finalValue = units * prices[endIndex];
  flows.push({ date: dates[endIndex], amount: finalValue });

  return {
    monthly,
    trades,
    tradeCount: trades.length,
    invested,
    units,
    finalValue,
    profit: finalValue - invested,
    totalReturn: invested > 0 ? finalValue / invested - 1 : null,
    annualizedReturn: annualizedReturn(prices.slice(startIndex, endIndex + 1), dates.slice(startIndex, endIndex + 1)),
    xirr: xirr(flows),
    years: yearsBetween(dates[startIndex], dates[endIndex]),
    investedSeries,
    valueSeries,
    startIndex,
    endIndex,
    startDate: dates[startIndex],
    endDate: dates[endIndex],
  };
}

/** 一次性投入（同期同总额，只在起点买入） */
export function lumpSumBacktest(dates, prices, options = {}) {
  const monthly = Number.isFinite(options.monthly) ? options.monthly : 1000;
  const startIndex = Math.max(0, options.startIndex ?? 0);
  const endIndex = Math.min(prices.length - 1, options.endIndex ?? prices.length - 1);
  const months = monthlyBuyIndices(dates, startIndex, endIndex).length;

  if (startIndex >= endIndex || !months) return null;
  const amount = monthly * months;
  const startPrice = prices[startIndex];
  if (!(startPrice > 0)) return null;

  const units = amount / startPrice;
  const valueSeries = prices.map((p, i) => (i < startIndex ? 0 : units * p));
  const finalValue = units * prices[endIndex];

  return {
    amount,
    units,
    finalValue,
    totalReturn: finalValue / amount - 1,
    years: yearsBetween(dates[startIndex], dates[endIndex]),
    valueSeries,
  };
}

/* --------------------------------- 再平衡 -------------------------------- */

/**
 * 多资产再平衡模拟。
 *
 * @param {string[]} dates 已对齐的交易日
 * @param {Record<string, number[]>} values 各资产价格（已对齐、等长）
 * @param {number[]} weights 目标权重，和约为 1
 * @param {{everyDays?: number, initial?: number}} [options]
 */
export function rebalanceSimulation(dates, values, weights, options = {}) {
  const keys = Object.keys(values);
  if (keys.length < 2 || weights.length !== keys.length) return null;
  const sum = weights.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > 0.01) return null;
  const length = dates.length;
  if (length < 3) return null;

  const everyDays = Math.max(5, options.everyDays ?? 63);
  const initial = options.initial ?? 10000;

  const priceArrays = keys.map((k) => values[k]);
  if (priceArrays.some((arr) => arr.length !== length || !(arr[0] > 0))) return null;

  const holdings = weights.map((w, i) => (initial * w) / priceArrays[i][0]);
  const valueSeries = new Array(length).fill(0);
  const noRebalanceUnits = weights.map((w, i) => (initial * w) / priceArrays[i][0]);
  const noRebalanceSeries = new Array(length).fill(0);
  // 每档的市值与权重序列：用来画「权重漂移」折线图，看清楚再平衡到底在做什么
  const sleeveValues = keys.map(() => new Array(length).fill(0));
  const weightSeries = keys.map(() => new Array(length).fill(0));
  let rebalances = 0;
  const events = [];

  for (let t = 0; t < length; t += 1) {
    let total = 0;
    let driftTotal = 0;
    for (let i = 0; i < keys.length; i += 1) {
      sleeveValues[i][t] = holdings[i] * priceArrays[i][t];
      total += sleeveValues[i][t];
      driftTotal += noRebalanceUnits[i] * priceArrays[i][t];
    }

    // 调仓先于记录：这样「调仓日」记录的权重就是调仓后的目标权重，
    // 权重漂移图上的锯齿会正好在标记处折回，读图不用二次解释。
    if (t > 0 && t % everyDays === 0 && t < length - 1 && total > 0) {
      for (let i = 0; i < keys.length; i += 1) {
        holdings[i] = (total * weights[i]) / priceArrays[i][t];
        sleeveValues[i][t] = total * weights[i];
      }
      rebalances += 1;
      events.push({ date: dates[t], index: t, value: total });
    }

    valueSeries[t] = total;
    noRebalanceSeries[t] = driftTotal;
    for (let i = 0; i < keys.length; i += 1) {
      weightSeries[i][t] = total > 0 ? sleeveValues[i][t] / total : 0;
    }
  }

  const finalValue = valueSeries[length - 1];
  const driftFinal = noRebalanceSeries[length - 1];
  return {
    keys,
    weights,
    everyDays,
    initial,
    rebalances,
    events,
    valueSeries,
    noRebalanceSeries,
    sleeveValues,
    weightSeries,
    finalValue,
    driftFinal,
    totalReturn: finalValue / initial - 1,
    driftReturn: driftFinal / initial - 1,
    annualizedReturn: annualizedReturn(valueSeries, dates),
    driftAnnualized: annualizedReturn(noRebalanceSeries, dates),
    years: yearsBetween(dates[0], dates[dates.length - 1]),
    maxDrawdownProxy: null,
  };
}


/* ------------------------------ 阈值带再平衡 ----------------------------- */

/**
 * 阈值带再平衡（哈里·布朗永久组合的原版规则）。
 *
 * 布朗的规则不是「每年调一次」，而是：任一档的权重偏离目标超过一定幅度就调整回来。
 * 经典设定是每档 25%，跌破 15% 或涨过 35% 时再平衡（即 ±10 个百分点）。
 *
 * @param {string[]} dates 已对齐的交易日
 * @param {Record<string, number[]>} values 各档价格（已对齐、等长）
 * @param {number[]} weights 目标权重
 * @param {{lower?: number, upper?: number, initial?: number}} [options]
 */
export function bandRebalance(dates, values, weights, options = {}) {
  const keys = Object.keys(values);
  if (keys.length !== weights.length || keys.length < 2) return null;
  const sum = weights.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > 0.01) return null;

  const length = dates.length;
  if (length < 3) return null;

  const lower = options.lower ?? 0.15;
  const upper = options.upper ?? 0.35;
  const initial = options.initial ?? 10000;

  const priceArrays = keys.map((k) => values[k]);
  if (priceArrays.some((arr) => arr.length !== length || !(arr[0] > 0))) return null;

  const holdings = weights.map((w, i) => (initial * w) / priceArrays[i][0]);
  const driftUnits = weights.map((w, i) => (initial * w) / priceArrays[i][0]);

  const valueSeries = new Array(length).fill(0);
  const driftSeries = new Array(length).fill(0);
  const events = [];

  let breaches = 0;

  for (let t = 0; t < length; t += 1) {
    let total = 0;
    let driftTotal = 0;
    for (let i = 0; i < keys.length; i += 1) {
      total += holdings[i] * priceArrays[i][t];
      driftTotal += driftUnits[i] * priceArrays[i][t];
    }
    valueSeries[t] = total;
    driftSeries[t] = driftTotal;

    if (t === length - 1 || !(total > 0)) continue;

    // 检查是否越界
    let outOfBand = false;
    let worst = null;
    for (let i = 0; i < keys.length; i += 1) {
      const weight = (holdings[i] * priceArrays[i][t]) / total;
      if (weight < lower || weight > upper) {
        outOfBand = true;
        const deviation = Math.abs(weight - weights[i]);
        if (!worst || deviation > worst.deviation) {
          worst = { key: keys[i], weight, deviation };
        }
      }
    }

    if (outOfBand) {
      for (let i = 0; i < keys.length; i += 1) {
        holdings[i] = (total * weights[i]) / priceArrays[i][t];
      }
      breaches += 1;
      events.push({
        date: dates[t],
        index: t,
        value: total,
        trigger: worst ? worst.key : "",
        weight: worst ? worst.weight : null,
      });
    }
  }

  const finalValue = valueSeries[length - 1];
  const sleeveFinal = {};
  keys.forEach((key, i) => {
    sleeveFinal[key] = holdings[i] * priceArrays[i][length - 1];
  });

  return {
    keys,
    weights,
    lower,
    upper,
    initial,
    rebalances: breaches,
    events,
    valueSeries,
    driftSeries,
    finalValue,
    driftFinal: driftSeries[length - 1],
    totalReturn: finalValue / initial - 1,
    driftReturn: driftSeries[length - 1] / initial - 1,
    annualizedReturn: annualizedReturn(valueSeries, dates),
    driftAnnualized: annualizedReturn(driftSeries, dates),
    years: yearsBetween(dates[0], dates[dates.length - 1]),
    sleeveFinal,
    sleeveFinalWeight: keys.map((key) => (sleeveFinal[key] / finalValue) * 100),
  };
}

/* -------------------------------- 压力测试 ------------------------------- */

/**
 * 历史情景压力测试：对每个情景窗口计算每个资产的**真实**区间收益。
 *
 * 数据覆盖不到的资产不编造数字，而是用基准在该窗口的涨跌 × 资产相对基准的
 * Beta 做保守估计，并明确标记 estimated=true，前端会显示为「估算」。
 *
 * @param {{key: string, name: string, dates: string[], prices: number[]}[]} assets
 * @param {{id: string, name: string, start: string, end: string, description?: string}[]} scenarios
 * @param {{benchmarkKey?: string, weights?: Record<string, number>,
 *   betas?: Record<string, number|null>}} [options]
 */
export function stressTest(assets, scenarios, options = {}) {
  const benchmarkKey = options.benchmarkKey ?? "";
  const weights = options.weights ?? {};
  const betas = options.betas ?? {};

  const sliceReturn = (asset, start, end) => {
    const dates = asset.dates;
    let i = 0;
    while (i < dates.length && dates[i] < start) i += 1;
    let j = dates.length - 1;
    while (j > i && dates[j] > end) j -= 1;
    if (i >= j || dates[i] > end || dates[j] < start) return null;
    const a = asset.prices[i];
    const b = asset.prices[j];
    if (!(a > 0) || !(b > 0)) return null;
    return { ret: b / a - 1, from: dates[i], to: dates[j] };
  };

  const benchmark = assets.find((a) => a.key === benchmarkKey);
  const idToName = Object.fromEntries(assets.map((a) => [a.key, a.name]));

  const rows = scenarios.map((scenario) => {
    const bench = benchmark ? sliceReturn(benchmark, scenario.start, scenario.end) : null;
    const perAsset = assets.map((asset) => {
      const actual = sliceReturn(asset, scenario.start, scenario.end);
      if (actual) {
        return {
          key: asset.key,
          name: asset.name,
          return: actual.ret,
          estimated: false,
          from: actual.from,
          to: actual.to,
        };
      }
      const beta = betas[asset.key];
      if (bench && Number.isFinite(beta)) {
        return {
          key: asset.key,
          name: asset.name,
          return: beta * bench.ret,
          estimated: true,
          from: "",
          to: "",
        };
      }
      return { key: asset.key, name: asset.name, return: null, estimated: true, from: "", to: "" };
    });

    // 组合：按权重加权（只统计有值的资产，并重新归一权重）
    const weighted = perAsset.filter((p) => p.return !== null && weights[p.key] > 0);
    const weightSum = weighted.reduce((acc, p) => acc + weights[p.key], 0);
    const portfolioReturn =
      weightSum > 0
        ? weighted.reduce((acc, p) => acc + p.return * (weights[p.key] / weightSum), 0)
        : null;

    return {
      id: scenario.id,
      name: scenario.name,
      description: scenario.description ?? "",
      start: scenario.start,
      end: scenario.end,
      benchmarkReturn: bench ? bench.ret : null,
      portfolioReturn,
      assets: perAsset,
      coverage: perAsset.filter((p) => !p.estimated).length,
      names: idToName,
    };
  });

  return rows;
}

/**
 * 单资产压力测试：给出该资产在各历史窗口的真实表现，
 * 并把「基准跌幅」折算成该资产的假设冲击（用于假设情景）。
 */
export function assetStress(asset, scenarios, options = {}) {
  const rows = stressTest([asset], scenarios, { ...options, weights: { [asset.key]: 1 } });
  return rows.map((row) => ({
    ...row,
    assetReturn: row.assets[0]?.return ?? null,
    estimated: row.assets[0]?.estimated ?? true,
  }));
}

/**
 * 由日收益估计资产相对基准的 Beta。
 *
 * 按日期交集对齐，而不是「尾部取最短」——恒生、标普与 A 股交易日历不同，
 * 简单尾部对齐会把不同日子的收益错配在一起。
 *
 * @param {string[]} assetDates @param {number[]} assetPrices
 * @param {string[]} benchDates @param {number[]} benchPrices
 */
export function estimateBeta(assetDates, assetPrices, benchDates, benchPrices) {
  const assetRet = gapAwareReturns(assetDates, assetPrices);
  const benchRet = gapAwareReturns(benchDates, benchPrices);
  const benchMap = new Map();
  for (let i = 0; i < benchRet.dates.length; i += 1) benchMap.set(benchRet.dates[i], benchRet.returns[i]);

  const a = [];
  const b = [];
  for (let i = 0; i < assetRet.dates.length; i += 1) {
    const value = benchMap.get(assetRet.dates[i]);
    if (value === undefined) continue;
    a.push(assetRet.returns[i]);
    b.push(value);
  }
  const n = a.length;
  if (n < 30) return null;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i += 1) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let cov = 0;
  let varB = 0;
  for (let i = 0; i < n; i += 1) {
    cov += (a[i] - ma) * (b[i] - mb);
    varB += (b[i] - mb) ** 2;
  }
  return varB === 0 ? null : cov / varB;
}

export { TRADING_DAYS };

/**
 * 按年费率逐日扣减，返回**扣费后**的净值序列。
 *
 * 回测里最容易被忽略、也最容易被吹掉的正是这一项：
 * 0.6%/年 的 ETF 管理费，在 20 年里会吃掉 10% 以上的终值；
 * 再加上调仓摩擦与红利税，「毛收益」和「到手收益」是两个数字。
 *
 * 这里只做管理/托管费这种**连续**成本（逐日按比例扣），
 * 交易摩擦与税是离散事件，用 feeRate 之外的参数单独说明，不在这里假装精确。
 *
 * @param {number[]} values 净值序列
 * @param {number} annualFee 年费率，例如 0.006 表示每年 0.6%
 * @param {number} periodsPerYear 每年交易日数，默认 252
 */
export function netOfFees(values, annualFee, periodsPerYear = 252) {
  if (!Array.isArray(values) || !values.length) return [];
  if (!Number.isFinite(annualFee) || annualFee <= 0) return values.slice();

  const daily = Math.pow(1 - annualFee, 1 / periodsPerYear);
  const out = new Array(values.length);
  let factor = 1;
  for (let i = 0; i < values.length; i += 1) {
    out[i] = values[i] * factor;
    factor *= daily;
  }
  return out;
}
