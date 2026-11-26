/**
 * js/core/inflation.js — 名义收益与实际收益。
 *
 * 站里所有收益原本都是**名义**的。但「年化 7%」在不同通胀环境下是两件事：
 * 2008 年 CPI +5.86% 时，7% 的实际购买力增长只有约 1%；2023 年 CPI +0.2% 时，7% 几乎全是实际增长。
 *
 * CPI 用月度定基指数（见 data_sources/eastmoney_macro.py，2008-01 起，基期 = 2007-12 的 100）。
 * 折成实际收益的做法：把每个交易日的价格除以「当日 CPI / 期初 CPI」。
 *
 * 注意一个容易错的地方：CPI 是**月度**的，要按月份向前填充到每个交易日，
 * 而不是插值——统计局公布的当月 CPI 从月初就代表整个月的价格水平。
 */

/**
 * 把月度 CPI 指数对齐到交易日（按月向前填充）。
 * @param {string[]} dates 交易日（YYYY-MM-DD）
 * @param {{dates: string[], prices: number[]}} cpi
 * @returns {number[]} 与 dates 等长的 CPI 水平；无覆盖处为 NaN
 */
export function alignCpiToDates(dates, cpi) {
  if (!Array.isArray(dates) || !dates.length) return [];
  if (!cpi?.dates?.length) return dates.map(() => Number.NaN);

  const byMonth = new Map();
  for (let i = 0; i < cpi.dates.length; i += 1) {
    byMonth.set(cpi.dates[i].slice(0, 7), cpi.prices[i]);
  }
  const months = [...byMonth.keys()].sort();

  const out = new Array(dates.length);
  let cursor = 0;
  for (let i = 0; i < dates.length; i += 1) {
    const month = dates[i].slice(0, 7);
    // 找不晚于该月的最近一期 CPI
    while (cursor + 1 < months.length && months[cursor + 1] <= month) cursor += 1;
    const level = months[cursor] <= month ? byMonth.get(months[cursor]) : undefined;
    out[i] = level === undefined ? Number.NaN : level;
  }
  return out;
}

/**
 * 把名义价格序列折成实际价格序列（以第一个有效 CPI 为基期）。
 *
 * @param {string[]} dates
 * @param {number[]} prices
 * @param {{dates: string[], prices: number[]}} cpi
 * @returns {{prices: number[], startIndex: number, coverage: number, totalInflation: number|null}}
 *   startIndex：CPI 有覆盖的第一个下标（此前的点无法折算）
 *   coverage：可折算的点数占比
 *   totalInflation：区间内 CPI 累计涨幅
 */
export function deflate(dates, prices, cpi) {
  const levels = alignCpiToDates(dates, cpi);
  let startIndex = levels.findIndex((v) => Number.isFinite(v));
  if (startIndex < 0) {
    return { prices: [], startIndex: -1, coverage: 0, totalInflation: null };
  }

  const base = levels[startIndex];
  const real = [];
  let valid = 0;
  for (let i = startIndex; i < dates.length; i += 1) {
    const level = levels[i];
    if (!Number.isFinite(level) || !(prices[i] > 0)) continue;
    real.push(prices[i] / (level / base));
    valid += 1;
  }

  const lastLevel = [...levels].reverse().find((v) => Number.isFinite(v));
  return {
    prices: real,
    startIndex,
    coverage: valid / Math.max(1, dates.length - startIndex),
    totalInflation: Number.isFinite(lastLevel) ? lastLevel / base - 1 : null,
  };
}

/**
 * 名义年化 → 实际年化（费雪方程的精确形式）。
 * 精确关系：(1+实际) = (1+名义) / (1+通胀)，不是简单相减。
 */
export function realAnnualized(nominal, inflation) {
  if (!Number.isFinite(nominal) || !Number.isFinite(inflation)) return null;
  return (1 + nominal) / (1 + inflation) - 1;
}