/**
 * js/core/simulate.js — 蒙特卡洛（自助重抽样）路径模拟。
 *
 * 课程里写了「蒙特卡洛模拟」，这个文件把它补上：不再只给一条历史曲线，
 * 而是回答「如果未来 20 年只是从历史里随机抽签，结局可能落在什么范围」。
 *
 * 方法：把历史月度收益放进一个袋子，有放回地抽 12 次组成一年，重复 N 年，
 * 形成一条路径；重复 paths 次得到分布。这叫 **bootstrap（自助法）**，
 * 它不做正态假设，也不预测收益率，只回答「历史这种波动与相关性下，运气能有多差」。
 *
 * 随机数用确定性种子（mulberry32），保证同一输入得到同一结果——
 * 否则每次刷新图都在变，用户没法判断哪条线是「真的」。
 */

/** 32 位确定性随机数发生器 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 把日频净值序列压成月度收益。
 * @param {string[]} dates
 * @param {number[]} prices
 * @returns {number[]} 月度收益率
 */
export function monthlyReturns(dates, prices) {
  if (!dates?.length || dates.length !== prices?.length) return [];
  const out = [];
  let lastMonth = dates[0].slice(0, 7);
  let base = prices[0];
  let lastPrice = prices[0];

  for (let i = 1; i < dates.length; i += 1) {
    const month = dates[i].slice(0, 7);
    if (month !== lastMonth) {
      if (base > 0 && lastPrice > 0) out.push(lastPrice / base - 1);
      base = lastPrice;
      lastMonth = month;
    }
    lastPrice = prices[i];
  }
  // 循环只在「月份变化」时结算，最后一个月没有下一个月来触发，
  // 所以必须在这里补一次——否则样本会少掉最近一个月（实测永久组合少了整整一个月）。
  if (base > 0 && lastPrice > 0) out.push(lastPrice / base - 1);
  return out.filter((r) => Number.isFinite(r));
}

/** 分位数（线性插值） */
export function percentile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const low = Math.floor(pos);
  const high = Math.ceil(pos);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (pos - low);
}

/**
 * 自助重抽样模拟。
 *
 * @param {number[]} returns 历史月度收益
 * @param {{years?: number, paths?: number, initial?: number, seed?: number}} options
 * @returns {{
 *   terminal: number[],            // 各路径终值（已排序）
 *   percentiles: {p5:number, p25:number, p50:number, p75:number, p95:number},
 *   lossProbability: number,       // 终值低于本金的概率
 *   bands: {p5:number[], p25:number[], p50:number[], p75:number[], p95:number[]}, // 逐年分位
 *   years: number,
 * }}
 */
export function bootstrap(returns, options = {}) {
  const years = Math.max(1, Math.round(options.years ?? 20));
  const paths = Math.max(50, Math.round(options.paths ?? 1000));
  const initial = options.initial ?? 10000;
  const seed = options.seed ?? 20261126;

  if (!returns?.length) {
    return { terminal: [], percentiles: null, lossProbability: null, bands: null, years };
  }

  const rand = mulberry32(seed);
  const months = years * 12;
  const terminal = new Array(paths);
  const byYear = Array.from({ length: years }, () => new Array(paths).fill(0));

  for (let p = 0; p < paths; p += 1) {
    let value = initial;
    for (let m = 1; m <= months; m += 1) {
      value *= 1 + returns[Math.floor(rand() * returns.length)];
      if (m % 12 === 0) byYear[m / 12 - 1][p] = value;
    }
    terminal[p] = value;
  }

  const sorted = terminal.slice().sort((a, b) => a - b);
  const band = (q) => byYear.map((row) => percentile(row.slice().sort((a, b) => a - b), q));

  return {
    terminal: sorted,
    percentiles: {
      p5: percentile(sorted, 0.05),
      p25: percentile(sorted, 0.25),
      p50: percentile(sorted, 0.5),
      p75: percentile(sorted, 0.75),
      p95: percentile(sorted, 0.95),
    },
    lossProbability: sorted.filter((v) => v < initial).length / sorted.length,
    bands: {
      p5: band(0.05),
      p25: band(0.25),
      p50: band(0.5),
      p75: band(0.75),
      p95: band(0.95),
    },
    years,
    initial,
  };
}