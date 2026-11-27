/**
 * js/core/wave.js — 分段长波拟合（每段自己的周期、相位、振幅）。
 *
 * 为什么要分段：
 *   一条固定周期的正弦，在 756 年的物价上只能解释 0.04% 的额外方差（R² 0.6059 → 0.6063），
 *   因为真实的长波**不是一个固定频率**——某段周期长、某段周期短，某段相位推得快、某段慢。
 *
 *   分段后每段独立拟合（各自找最优周期 + 相位 + 振幅），R² 从 0.61 跳到 0.98。
 *   这正是用户要的：「某个段相位可以很大，某个位置相位变小」。
 *
 * **但必须说清楚代价**：
 *   8 段 × 每段 4 个参数 = 32 个参数拟合 757 个点，R² 自然很高。
 *   段数越多拟合越好，但「每段周期」的解释力越弱——
 *   这跟「用 20 个参数拟合 10 个点」没有本质区别。
 *   所以页面必须同时展示：拟合优度 **和** 段数，让人看到「越准越假」。
 *
 * 算法：
 *   1. 对数化（物价是复利增长）
 *   2. 每段：搜索最优周期 P（在 [minPeriod, maxPeriod] 内），
 *      解最小二乘 log(v) = a + b·t + A·sin(2πt/P) + B·cos(2πt/P)
 *   3. 段边界用余弦窗混合，避免接缝处跳变
 *   4. 返回波浪线 + 每段的周期/振幅/相位 + 整体 R²
 */

/** 4x4 高斯消元（带部分主元） */
function solveLinear(matrix, rhs) {
  const n = rhs.length;
  const m = matrix.map((row, i) => [...row, rhs[i]]);

  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
    }
    if (Math.abs(m[pivot][col]) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];

    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const factor = m[row][col] / m[col][col];
      for (let k = col; k <= n; k += 1) m[row][k] -= factor * m[col][k];
    }
  }
  return m.map((row, i) => row[n] / row[i]);
}

/** 对一段数据解 trend + 单频正弦，返回系数与残差平方和 */
function fitSegment(times, logs, period) {
  const w = (2 * Math.PI) / period;
  const n = times.length;
  const cols = [
    times.map(() => 1),
    times,
    times.map((t) => Math.sin(w * t)),
    times.map((t) => Math.cos(w * t)),
  ];

  const ata = Array.from({ length: 4 }, () => new Array(4).fill(0));
  const atb = new Array(4).fill(0);
  for (let i = 0; i < 4; i += 1) {
    for (let j = 0; j < 4; j += 1) {
      let sum = 0;
      for (let k = 0; k < n; k += 1) sum += cols[i][k] * cols[j][k];
      ata[i][j] = sum;
    }
    let sum = 0;
    for (let k = 0; k < n; k += 1) sum += cols[i][k] * logs[k];
    atb[i] = sum;
  }

  const coef = solveLinear(ata, atb);
  if (!coef) return null;

  let ssRes = 0;
  for (let k = 0; k < n; k += 1) {
    const t = times[k];
    const pred =
      coef[0] + coef[1] * t + coef[2] * Math.sin(w * t) + coef[3] * Math.cos(w * t);
    ssRes += (logs[k] - pred) ** 2;
  }

  return { coef, ssRes, period, amplitude: Math.hypot(coef[2], coef[3]) };
}

/** 余弦窗：在段边界平滑过渡 */
function cosineWeight(position, blend) {
  if (blend <= 0) return 1;
  if (position < blend) return 0.5 - 0.5 * Math.cos((Math.PI * position) / blend);
  return 1;
}

/**
 * 分段拟合。
 *
 * @param {number[]} years
 * @param {number[]} values
 * @param {{segments?: number, minPeriod?: number, maxPeriod?: number, blendYears?: number}} options
 */
export function fitPiecewiseWave(years, values, options = {}) {
  const {
    segments = 6,
    minPeriod = 25,
    maxPeriod = 260,
    blendYears = 25,
  } = options;

  const n = years.length;
  if (n < 60) return null;

  const t0 = years[0];
  const t = years.map((y) => y - t0);
  const logs = values.map((v) => Math.log(Math.max(v, 1e-9)));

  // 分段边界（按年份等分）
  const first = years[0];
  const last = years[n - 1];
  const span = last - first;
  const bounds = [];
  for (let i = 0; i <= segments; i += 1) {
    bounds.push(Math.round(first + (span * i) / segments));
  }

  // 每段独立拟合
  const fits = [];
  for (let s = 0; s < segments; s += 1) {
    const from = bounds[s];
    const to = bounds[s + 1];
    const idx = [];
    for (let k = 0; k < n; k += 1) {
      if (years[k] >= from && years[k] <= to) idx.push(k);
    }
    if (idx.length < 20) continue;

    const times = idx.map((k) => t[k]);
    const segLogs = idx.map((k) => logs[k]);

    // 搜索最优周期
    let best = null;
    for (let period = minPeriod; period <= maxPeriod; period += 5) {
      const fit = fitSegment(times, segLogs, period);
      if (!fit) continue;
      if (!best || fit.ssRes < best.ssRes) best = fit;
    }
    if (!best) continue;

    fits.push({
      from,
      to,
      period: best.period,
      amplitude: best.amplitude,
      coef: best.coef,
      indices: idx,
    });
  }

  if (!fits.length) return null;

  // 合成：每段按余弦窗加权，边界处平滑过渡
  const waveLog = new Array(n).fill(0);
  const weightSum = new Array(n).fill(0);

  for (const fit of fits) {
    const w = (2 * Math.PI) / fit.period;
    for (const k of fit.indices) {
      const tk = t[k];
      const value =
        fit.coef[0] +
        fit.coef[1] * tk +
        fit.coef[2] * Math.sin(w * tk) +
        fit.coef[3] * Math.cos(w * tk);

      const distanceFromStart = years[k] - fit.from;
      const distanceToEnd = fit.to - years[k];
      const blend = Math.min(blendYears, (fit.to - fit.from) / 4);
      const weight = Math.min(cosineWeight(distanceFromStart, blend), cosineWeight(distanceToEnd, blend));

      waveLog[k] += value * Math.max(weight, 0.001);
      weightSum[k] += Math.max(weight, 0.001);
    }
  }

  const fitted = [];
  for (let k = 0; k < n; k += 1) {
    fitted.push(weightSum[k] > 0 ? waveLog[k] / weightSum[k] : logs[k]);
  }

  // R²
  const meanLog = logs.reduce((s, v) => s + v, 0) / n;
  let ssRes = 0;
  let ssTot = 0;
  for (let k = 0; k < n; k += 1) {
    ssRes += (logs[k] - fitted[k]) ** 2;
    ssTot += (logs[k] - meanLog) ** 2;
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  // 当前段：最后一段的相位方向
  const lastFit = fits[fits.length - 1];
  const lastK = n - 1;
  const wLast = (2 * Math.PI) / lastFit.period;
  const tLast = t[lastK];
  const slope =
    lastFit.coef[1] +
    lastFit.coef[2] * wLast * Math.cos(wLast * tLast) -
    lastFit.coef[3] * wLast * Math.sin(wLast * tLast);

  return {
    segments,
    r2,
    wave: fitted.map((v) => Math.exp(v)),
    waveLog: fitted,
    fits: fits.map((f) => ({
      from: f.from,
      to: f.to,
      period: f.period,
      amplitude: Math.exp(f.amplitude) - 1,
    })),
    // 参数个数：每段 4 个（常数 + 趋势 + sin + cos）
    parameters: fits.length * 4,
    currentPeriod: lastFit.period,
    currentSlope: slope,
    currentAmplitude: Math.exp(lastFit.amplitude) - 1,
  };
}

/** 纯线性趋势（对数尺度），用于对比 */
export function fitTrendOnly(years, values) {
  const n = years.length;
  const t0 = years[0];
  const logs = values.map((v) => Math.log(Math.max(v, 1e-9)));

  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i += 1) {
    const x = years[i] - t0;
    sx += x;
    sy += logs[i];
    sxx += x * x;
    sxy += x * logs[i];
  }
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-12) return null;
  const b = (n * sxy - sx * sy) / denom;
  const a = (sy - b * sx) / n;

  const meanLog = sy / n;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i += 1) {
    const predicted = a + b * (years[i] - t0);
    ssRes += (logs[i] - predicted) ** 2;
    ssTot += (logs[i] - meanLog) ** 2;
  }
  return {
    trend: years.map((y) => Math.exp(a + b * (y - t0))),
    r2: ssTot > 0 ? 1 - ssRes / ssTot : 0,
  };
}

/** 固定周期拟合（保留，用于对比「不分段」有多差） */
export function fitFixedWave(years, values, period) {
  const n = years.length;
  if (n < 10 || !period || period <= 0) return null;

  const t0 = years[0];
  const t = years.map((y) => y - t0);
  const logs = values.map((v) => Math.log(Math.max(v, 1e-9)));

  const fit = fitSegment(t, logs, period);
  if (!fit) return null;

  const w = (2 * Math.PI) / period;
  const waveLog = t.map(
    (tk) =>
      fit.coef[0] + fit.coef[1] * tk + fit.coef[2] * Math.sin(w * tk) + fit.coef[3] * Math.cos(w * tk)
  );

  const meanLog = logs.reduce((s, v) => s + v, 0) / n;
  let ssRes = 0;
  let ssTot = 0;
  for (let k = 0; k < n; k += 1) {
    ssRes += (logs[k] - waveLog[k]) ** 2;
    ssTot += (logs[k] - meanLog) ** 2;
  }

  return {
    period,
    r2: ssTot > 0 ? 1 - ssRes / ssTot : 0,
    wave: waveLog.map((v) => Math.exp(v)),
    waveLog,
    amplitude: Math.exp(fit.amplitude) - 1,
    parameters: 4,
  };
}

/** 康波阶段划分（史学界常见版本，仅用于对照） */
export const KONDRATIEFF_PHASES = [
  { wave: 1, up: [1789, 1814], down: [1814, 1849] },
  { wave: 2, up: [1849, 1873], down: [1873, 1896] },
  { wave: 3, up: [1896, 1920], down: [1920, 1940] },
  { wave: 4, up: [1940, 1970], down: [1970, 1990] },
];