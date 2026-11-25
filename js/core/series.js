/**
 * js/core/series.js — 时间序列工具。
 *
 * 所有函数都是纯函数，不接触 DOM，可以直接在 Node 里做单元测试。
 *
 * 数据约定：dates 为升序的 "YYYY-MM-DD" 字符串数组，prices 与其等长。
 */

export const TRADING_DAYS = 252;

/** 日收益率序列：长度 = prices.length - 1 */
export function returns(prices) {
  const out = new Array(Math.max(0, prices.length - 1));
  for (let i = 1; i < prices.length; i += 1) {
    const prev = prices[i - 1];
    out[i - 1] = prev > 0 ? prices[i] / prev - 1 : 0;
  }
  return out;
}

/** 累计收益（相对首日，返回小数序列） */
export function cumulative(prices) {
  if (!prices.length) return [];
  const base = prices[0];
  return prices.map((p) => (base > 0 ? p / base - 1 : 0));
}

/** 归一化到 base（默认 100） */
export function normalize(prices, base = 100) {
  if (!prices.length) return [];
  const first = prices[0];
  return prices.map((p) => (first > 0 ? (p / first) * base : 0));
}

/** 回撤序列（<= 0 的小数），每个点相对此前最高点 */
export function drawdowns(prices) {
  const out = new Array(prices.length);
  let peak = -Infinity;
  for (let i = 0; i < prices.length; i += 1) {
    if (prices[i] > peak) peak = prices[i];
    out[i] = peak > 0 ? prices[i] / peak - 1 : 0;
  }
  return out;
}

/**
 * 把后复权序列折算成「等价前复权」的展示价：
 * display(t) = price(t) × lastClose / price(last)
 *
 * 后复权序列的收益率是正确的，但绝对价位远高于真实报价
 * （贵州茅台后复权 10000 元 vs 真实 1463 元），直接展示会让人困惑。
 * 缩放后收益率完全不变，末值恰好等于最新真实价，这就是标准前复权。
 */
export function scaleDisplay(prices, lastClose) {
  if (!prices.length) return [];
  const last = prices[prices.length - 1];
  if (!(lastClose > 0) || !(last > 0)) return prices.slice();
  const k = lastClose / last;
  return prices.map((p) => p * k);
}

/**
 * 取最近 years 年的窗口（years = Infinity 表示全部）。
 * @returns {{dates: string[], prices: number[]}}
 */
export function sliceLastYears(dates, prices, years) {
  if (!Number.isFinite(years) || years <= 0) return { dates: dates.slice(), prices: prices.slice() };
  if (!dates.length) return { dates: [], prices: [] };
  const last = dates[dates.length - 1];
  const lastYear = Number(last.slice(0, 4));
  const lastMonth = Number(last.slice(5, 7));
  const lastDay = Number(last.slice(8, 10));
  const target = new Date(Date.UTC(lastYear - years, lastMonth - 1, lastDay));
  const cutoff = target.toISOString().slice(0, 10);
  let start = 0;
  while (start < dates.length - 1 && dates[start] < cutoff) start += 1;
  return { dates: dates.slice(start), prices: prices.slice(start) };
}

/**
 * 按日期对齐多组序列（取交集）。
 *
 * 旧实现按「最短长度尾部切片」对齐，当两个资产起始日期不同时会错位，
 * 相关性因此失真。这里改为真正的日期交集。
 *
 * @param {{key: string, dates: string[], prices: number[]}[]} entries
 * @returns {{dates: string[], values: Record<string, number[]>}}
 */
export function alignByDate(entries) {
  const valid = entries.filter((e) => e && e.dates && e.dates.length);
  if (!valid.length) return { dates: [], values: {} };
  if (valid.length === 1) {
    return { dates: valid[0].dates.slice(), values: { [valid[0].key]: valid[0].prices.slice() } };
  }

  // 以最短序列为基准做交集，减少查找次数
  const sorted = [...valid].sort((a, b) => a.dates.length - b.dates.length);
  const base = sorted[0];
  const lookups = sorted.slice(1).map((entry) => {
    const map = new Map();
    for (let i = 0; i < entry.dates.length; i += 1) map.set(entry.dates[i], entry.prices[i]);
    return { key: entry.key, map };
  });

  const dates = [];
  const collected = valid.map(() => []);
  const indexOf = new Map(valid.map((entry, i) => [entry.key, i]));

  for (let i = 0; i < base.dates.length; i += 1) {
    const date = base.dates[i];
    const hits = [];
    let ok = true;
    for (const lookup of lookups) {
      const value = lookup.map.get(date);
      if (value === undefined) {
        ok = false;
        break;
      }
      hits.push([lookup.key, value]);
    }
    if (!ok) continue;
    dates.push(date);
    for (const [key, value] of hits) collected[indexOf.get(key)].push(value);
    collected[indexOf.get(base.key)].push(base.prices[i]);
  }

  const values = {};
  valid.forEach((entry, i) => {
    values[entry.key] = collected[i];
  });
  return { dates, values };
}

/** 在升序 dates 中查找第一个 >= iso 的下标 */
export function lowerBound(dates, iso) {
  let lo = 0;
  let hi = dates.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] < iso) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * 取 [start, end] 区间（按日期字符串比较）的下标范围。
 * @returns {{start: number, end: number}} 闭区间下标；无数据时返回 start > end
 */
export function dateRangeIndices(dates, start, end) {
  const from = start ? lowerBound(dates, start) : 0;
  let to = dates.length - 1;
  if (end) {
    // 最后一个 <= end 的位置
    let lo = from;
    let hi = dates.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (dates[mid] <= end) lo = mid + 1;
      else hi = mid;
    }
    to = lo - 1;
  }
  return { start: from, end: to };
}

/**
 * 按目标点数降采样，保留首尾极值，避免曲线失真。
 * 返回需要的下标数组。
 */
export function downsampleIndices(length, target) {
  if (length <= target || target < 3) {
    return Array.from({ length }, (_, i) => i);
  }
  const step = (length - 1) / (target - 1);
  const out = [];
  for (let i = 0; i < target; i += 1) out.push(Math.round(i * step));
  // 去重并保证首尾
  const uniq = [...new Set(out)].sort((a, b) => a - b);
  if (uniq[0] !== 0) uniq.unshift(0);
  if (uniq[uniq.length - 1] !== length - 1) uniq.push(length - 1);
  return uniq;
}

/** 由等间隔序列生成直方图分箱 */
export function histogram(values, bins = 30) {
  if (!values.length) return { edges: [], counts: [] };
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { edges: [], counts: [] };
  if (min === max) {
    return { edges: [min, max], counts: [values.length] };
  }
  const width = (max - min) / bins;
  const counts = new Array(bins).fill(0);
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    let idx = Math.floor((v - min) / width);
    if (idx >= bins) idx = bins - 1;
    if (idx < 0) idx = 0;
    counts[idx] += 1;
  }
  const edges = Array.from({ length: bins + 1 }, (_, i) => min + width * i);
  return { edges, counts };
}