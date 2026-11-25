/**
 * js/core/stats.js — 指标计算引擎（纯函数，零依赖）。
 *
 * 设计原则：
 * 1. 只用历史数据，绝不外推、绝不预测；
 * 2. 数据不足时返回 null，而不是编造 0；前端据此显示「—」；
 * 3. 年化统一按**自然日**折算（首尾日期差），不再用「条数 / 252」，
 *    否则遇到停牌、长假、非交易日历不同的资产会系统性高估；
 * 4. 明确区分「波动」与「下行波动」，Sortino 只用下行部分。
 */

import { drawdowns, gapAwareReturns, returns } from "./series.js";

export const TRADING_DAYS = 252;
export const DEFAULT_RISK_FREE = 0.025;

function mean(values) {
  if (!values.length) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function stdev(values, avg) {
  if (values.length < 2) return 0;
  const m = avg ?? mean(values);
  let acc = 0;
  for (const v of values) acc += (v - m) ** 2;
  return Math.sqrt(acc / (values.length - 1));
}

/** 自然日年数 */
export function yearsBetween(startIso, endIso) {
  if (!startIso || !endIso) return 0;
  const start = Date.parse(`${startIso}T00:00:00Z`);
  const end = Date.parse(`${endIso}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return (end - start) / (365.25 * 24 * 3600 * 1000);
}

/** 区间总收益（小数） */
export function totalReturn(prices) {
  if (prices.length < 2 || !(prices[0] > 0)) return null;
  return prices[prices.length - 1] / prices[0] - 1;
}

/** 年化收益率；不足 1 个月视为无效，返回 null */
export function annualizedReturn(prices, dates) {
  const total = totalReturn(prices);
  if (total === null) return null;
  const years = yearsBetween(dates?.[0], dates?.[dates.length - 1]);
  if (years < 0.04) return null;
  if (total <= -1) return -1;
  return Math.pow(1 + total, 1 / years) - 1;
}

/**
 * 年化波动率 = 日收益标准差 × √252
 *
 * dates 用于剔除跨度过大的相邻点（数据空洞、停牌），
 * 否则「两个月涨 20%」会被当成「一天涨 20%」。
 */
export function annualizedVolatility(prices, dates, options = {}) {
  const rets = dates?.length
    ? gapAwareReturns(dates, prices, options).returns
    : returns(prices);
  if (rets.length < 2) return null;
  return stdev(rets) * Math.sqrt(TRADING_DAYS);
}

/** 年化下行波动（只统计低于目标收益的部分） */
export function downsideDeviation(prices, dates, target = 0, options = {}) {
  const rets = dates?.length
    ? gapAwareReturns(dates, prices, options).returns
    : returns(prices);
  if (rets.length < 2) return null;
  let acc = 0;
  for (const r of rets) {
    const short = Math.min(r - target, 0);
    acc += short * short;
  }
  return Math.sqrt(acc / rets.length) * Math.sqrt(TRADING_DAYS);
}

/** 夏普比率 */
export function sharpeRatio(prices, riskFree = DEFAULT_RISK_FREE, dates) {
  const ann = annualizedReturn(prices, dates);
  const vol = annualizedVolatility(prices, dates);
  if (ann === null || !vol) return null;
  return (ann - riskFree) / vol;
}

/** 索提诺比率 */
export function sortinoRatio(prices, riskFree = DEFAULT_RISK_FREE, dates) {
  const ann = annualizedReturn(prices, dates);
  const down = downsideDeviation(prices, dates);
  if (ann === null || !down) return null;
  return (ann - riskFree) / down;
}

/**
 * 最大回撤。
 * @returns {null | {value: number, peakIndex: number, troughIndex: number,
 *   recoveryIndex: number|null, recoveryDays: number|null, peakDate: string,
 *   troughDate: string}}
 */
export function maxDrawdown(prices, dates) {
  if (prices.length < 2) return null;
  let peak = prices[0];
  let peakIdx = 0;
  let worst = 0;
  let worstPeakIdx = 0;
  let worstTroughIdx = 0;

  for (let i = 1; i < prices.length; i += 1) {
    if (prices[i] > peak) {
      peak = prices[i];
      peakIdx = i;
    }
    const dd = peak > 0 ? prices[i] / peak - 1 : 0;
    if (dd < worst) {
      worst = dd;
      worstTroughIdx = i;
      worstPeakIdx = peakIdx;
    }
  }

  let recoveryIdx = null;
  const peakPrice = prices[worstPeakIdx];
  for (let i = worstTroughIdx + 1; i < prices.length; i += 1) {
    if (prices[i] >= peakPrice) {
      recoveryIdx = i;
      break;
    }
  }

  return {
    value: worst,
    peakIndex: worstPeakIdx,
    troughIndex: worstTroughIdx,
    recoveryIndex: recoveryIdx,
    recoveryDays: recoveryIdx === null ? null : recoveryIdx - worstTroughIdx,
    peakDate: dates?.[worstPeakIdx] ?? "",
    troughDate: dates?.[worstTroughIdx] ?? "",
  };
}

/** 卡玛比率 = 年化收益 / |最大回撤| */
export function calmarRatio(prices, dates) {
  const ann = annualizedReturn(prices, dates);
  const mdd = maxDrawdown(prices, dates);
  if (ann === null || !mdd || !mdd.value) return null;
  return ann / Math.abs(mdd.value);
}

/** 胜率与平均盈亏（同样剔除跨度过大的相邻点） */
export function winLoss(prices, dates, options = {}) {
  const rets = dates?.length
    ? gapAwareReturns(dates, prices, options).returns
    : returns(prices);
  if (!rets.length) return null;
  const up = rets.filter((r) => r > 0);
  const down = rets.filter((r) => r < 0);
  return {
    days: rets.length,
    upDays: up.length,
    downDays: down.length,
    flatDays: rets.length - up.length - down.length,
    winRate: rets.length ? up.length / rets.length : null,
    avgGain: up.length ? mean(up) : 0,
    avgLoss: down.length ? mean(down) : 0,
    bestDay: rets.length ? Math.max(...rets) : null,
    worstDay: rets.length ? Math.min(...rets) : null,
  };
}

/**
 * 相对基准的 Beta 与 Alpha（年化）。
 * beta = cov(asset, bench) / var(bench)；alpha = Ra - [Rf + beta × (Rb - Rf)]
 */
export function betaAlpha(
  assetPrices,
  benchPrices,
  riskFree = DEFAULT_RISK_FREE,
  dates,
  benchDates = dates
) {
  const assetRet = gapAwareReturns(dates, assetPrices);
  const benchRet = gapAwareReturns(benchDates || dates, benchPrices);

  // 按日期交集对齐日收益，避免「一边有停牌、一边没有」时错位
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
  if (n < 30) return { beta: null, alpha: null, correlation: null };

  const ma = mean(a);
  const mb = mean(b);
  let cov = 0;
  let varB = 0;
  let varA = 0;
  for (let i = 0; i < n; i += 1) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  if (varB === 0) return { beta: null, alpha: null, correlation: null };
  const beta = cov / varB;
  const correlation = varA > 0 ? cov / Math.sqrt(varA * varB) : null;

  const annA = annualizedReturn(assetPrices, dates);
  const annB = annualizedReturn(benchPrices, benchDates || dates);
  const alpha =
    annA === null || annB === null ? null : annA - (riskFree + beta * (annB - riskFree));

  return { beta, alpha, correlation };
}

/**
 * 滚动年化收益：对每个点计算「过去 windowDays 个交易日」的年化收益。
 * 用于展示收益的时间稳定性，比单区间数字诚实得多。
 */
export function rollingAnnualized(prices, windowDays = TRADING_DAYS) {
  const out = new Array(prices.length).fill(null);
  for (let i = windowDays; i < prices.length; i += 1) {
    const from = prices[i - windowDays];
    const to = prices[i];
    if (from > 0) {
      out[i] = Math.pow(to / from, TRADING_DAYS / windowDays) - 1;
    }
  }
  return out;
}

/**
 * 完整分析。
 * @param {number[]} prices
 * @param {string[]} dates
 * @param {{riskFreeRate?: number, benchmark?: {prices: number[], dates: string[]}}} [options]
 */
export function analyze(prices, dates, options = {}) {
  const rf = Number.isFinite(options.riskFreeRate) ? options.riskFreeRate : DEFAULT_RISK_FREE;

  if (!Array.isArray(prices) || prices.length < 2) {
    return {
      ok: false,
      reason: `数据不足（${prices?.length ?? 0} 个数据点），至少需要 2 个。`,
    };
  }

  const mdd = maxDrawdown(prices, dates);
  const years = yearsBetween(dates[0], dates[dates.length - 1]);
  const result = {
    ok: true,
    points: prices.length,
    start: dates[0],
    end: dates[dates.length - 1],
    years,
    totalReturn: totalReturn(prices),
    annualizedReturn: annualizedReturn(prices, dates),
    volatility: annualizedVolatility(prices, dates),
    downside: downsideDeviation(prices, dates),
    sharpe: sharpeRatio(prices, rf, dates),
    sortino: sortinoRatio(prices, rf, dates),
    calmar: calmarRatio(prices, dates),
    maxDrawdown: mdd,
    winLoss: winLoss(prices, dates),
    rolling1y: rollingAnnualized(prices, TRADING_DAYS),
    drawdownSeries: drawdowns(prices),
    beta: null,
    alpha: null,
    correlation: null,
    benchmarkReturn: null,
  };

  if (options.benchmark && options.benchmark.prices?.length > 1) {
    const { beta, alpha, correlation } = betaAlpha(
      prices,
      options.benchmark.prices,
      rf,
      dates,
      options.benchmark.dates
    );
    result.beta = beta;
    result.alpha = alpha;
    result.correlation = correlation;
    result.benchmarkReturn = annualizedReturn(
      options.benchmark.prices,
      options.benchmark.dates || dates
    );
  }

  return result;
}

/**
 * 多资产指标对比。输入已对齐的序列，保证可比性。
 * @param {{key: string, name: string, prices: number[], dates: string[]}[]} list
 */
export function compare(list, options = {}) {
  return list.map((item) => {
    const res = analyze(item.prices, item.dates, options);
    return {
      key: item.key,
      name: item.name,
      ok: res.ok,
      reason: res.reason ?? "",
      points: res.points ?? 0,
      start: res.start ?? "",
      end: res.end ?? "",
      annualizedReturn: res.annualizedReturn ?? null,
      volatility: res.volatility ?? null,
      sharpe: res.sharpe ?? null,
      sortino: res.sortino ?? null,
      maxDrawdown: res.maxDrawdown?.value ?? null,
      totalReturn: res.totalReturn ?? null,
    };
  });
}

export { mean, stdev };