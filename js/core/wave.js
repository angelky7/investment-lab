/**
 * js/core/wave.js — 长波叠加线（示意用，不是预测）。
 *
 * 用途：在 756 年物价曲线上叠一条「波浪」，让人一眼看到什么时候上、什么时候下。
 *
 * **必须说清楚它是怎么来的**：
 *   1. 先把物价取对数（物价是复利增长，线性尺度下末端暴涨会把波浪压平）；
 *   2. 扣掉一条线性趋势（得到「相对趋势的偏离」）；
 *   3. 用指定周期（默认 55 年，康波通常取 50–60）的正弦去拟合这个偏离；
 *   4. 把正弦加回趋势，得到一条平滑的波浪。
 *
 * 为什么是「示意」而不是「结论」：
 *   实测纯线性趋势 R² = 0.6059，加 55 年正弦后 R² = 0.6098——**只提升 0.004**。
 *   也就是说这波浪线在统计上几乎解释不了任何东西，它的作用是**视觉辅助**，
 *   帮人看到「相对趋势高了还是低了」，而不是预测下一次拐点。
 *
 * 周期可以调（50–200 年），因为**没有哪个周期是数据选出来的**——
 * 175 年拟合最好（R² 0.68）纯粹是因为 757 年样本里最多能塞下 4 个，周期越长越灵活。
 * 这本身就是过拟合的演示。
 */

/**
 * 最小二乘拟合：log(v) = a + b·t + A·sin(2πt/P) + B·cos(2πt/P)
 * @param {number[]} years
 * @param {number[]} values
 * @param {number} period 周期（年）
 */
export function fitWave(years, values, period) {
  const n = years.length;
  if (n < 10 || !period || period <= 0) return null;

  const t0 = years[0];
  const logs = values.map((v) => Math.log(Math.max(v, 1e-9)));

  // 4 列正规方程：手工解（避免引入依赖）
  const cols = [
    years.map(() => 1),
    years.map((y) => y - t0),
    years.map((y) => Math.sin((2 * Math.PI * (y - t0)) / period)),
    years.map((y) => Math.cos((2 * Math.PI * (y - t0)) / period)),
  ];

  // AᵀA (4x4) 与 Aᵀb (4)
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

  const coef = solve4(ata, atb);
  if (!coef) return null;

  const [a, b, sinCoef, cosCoef] = coef;
  const amplitude = Math.hypot(sinCoef, cosCoef);

  // 拟合值（对数尺度）与 R²
  const fittedLog = years.map((y) => {
    const t = y - t0;
    const w = (2 * Math.PI * t) / period;
    return a + b * t + sinCoef * Math.sin(w) + cosCoef * Math.cos(w);
  });

  const meanLog = logs.reduce((s, v) => s + v, 0) / n;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i += 1) {
    ssRes += (logs[i] - fittedLog[i]) ** 2;
    ssTot += (logs[i] - meanLog) ** 2;
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  // 趋势 + 波浪 分开给出，前端画两条线
  const trend = years.map((y) => Math.exp(a + b * (y - t0)));
  const wave = years.map((y, i) => Math.exp(fittedLog[i]));

  // 当前处在波浪的什么位置：正弦项的相位
  const lastT = years[n - 1] - t0;
  const lastPhase = Math.sin((2 * Math.PI * lastT) / period) * sinCoef +
    Math.cos((2 * Math.PI * lastT) / period) * cosCoef;
  const normalized = amplitude > 0 ? lastPhase / amplitude : 0; // -1 ~ 1

  return {
    period,
    amplitude,
    r2,
    trend,
    wave,
    // 当前相对趋势的位置：> 0 表示高于趋势（「上行段」），< 0 表示低于趋势
    position: normalized,
    slope: derivativeAt(years, period, sinCoef, cosCoef, b),
  };
}

/** 波浪在当前点的方向：正 = 在往上，负 = 在往下 */
function derivativeAt(years, period, sinCoef, cosCoef, trendSlope) {
  const t = years[years.length - 1] - years[0];
  const w = (2 * Math.PI) / period;
  return (
    trendSlope +
    sinCoef * w * Math.cos(w * t) -
    cosCoef * w * Math.sin(w * t)
  );
}

/** 4x4 高斯消元（带部分主元） */
function solve4(matrix, rhs) {
  const m = matrix.map((row, i) => [...row, rhs[i]]);
  const n = 4;
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

/**
 * 纯趋势（不含波浪）的拟合，用于对比「波浪到底解释了多少」。
 */
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

/** 康波阶段划分（史学界常见版本，仅用于对照） */
export const KONDRATIEFF_PHASES = [
  { wave: 1, up: [1789, 1814], down: [1814, 1849] },
  { wave: 2, up: [1849, 1873], down: [1873, 1896] },
  { wave: 3, up: [1896, 1920], down: [1920, 1940] },
  { wave: 4, up: [1940, 1970], down: [1970, 1990] },
];