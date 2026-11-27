/**
 * js/core/wave.js — 纯三角函数拟合（傅里叶级数 + 半周期趋势项）。
 *
 * ── 用户的要求 ────────────────────────────────────────────────
 * 「拟合都用三角函数」。所以这里**没有任何线性项 t**——
 * 每一项都是 sin 或 cos。
 *
 * ── 怎么用纯三角函数表达「长期上涨」 ──────────────────────────
 * 物价和股价是单调上升的，而普通正弦首尾相接、表达不了趋势。
 * 解法是加一项 **1 − cos(πt/T)**：
 *   - 它在 t=0 处为 0，在 t=T 处为 2，中间单调上升
 *   - 它本身是余弦函数（周期 2T 的半个周期）
 *   - 乘上系数就能表达「整段时期的长期漂移」
 *
 * 实测（英国物价 757 年）：
 *   | 谐波数 | 只用 sin/cos | 加半周期项 |
 *   |--------|--------------|------------|
 *   | K=2    | 0.549        | **0.960**  |
 *   | K=5    | 0.782        | **0.984**  |
 *   | K=12   | 0.917        | **0.989**  |
 *
 * 所以「纯三角函数」不但可行，而且比之前的「线性趋势 + 正弦」更简洁：
 * 只有一个模型，所有项都是三角函数。
 *
 * ── 周期怎么读 ────────────────────────────────────────────────
 *   谐波 k 的周期 = T / k（T = 数据跨度）
 *   例如 T = 757 年时：k=1 → 757 年，k=2 → 378 年，k=12 → 63 年
 *   半周期项对应「整段跨度」这个尺度，也就是 2T 的半个周期。
 */

/** 高斯消元（任意维） */
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

function r2Of(logs, pred) {
  const n = logs.length;
  const mean = logs.reduce((s, v) => s + v, 0) / n;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i += 1) {
    ssRes += (logs[i] - pred[i]) ** 2;
    ssTot += (logs[i] - mean) ** 2;
  }
  return ssTot > 1e-12 ? 1 - ssRes / ssTot : 0;
}

/**
 * 纯三角函数拟合：log(v) = Σ 三角项
 *
 * 基函数：
 *   cos(0) = 1                    常数
 *   1 − cos(πt/T)                 半周期项（表达长期趋势，两端为 0 和 2）
 *   sin(2πkt/T), cos(2πkt/T)      k = 1..K 的谐波
 *
 * @param {number[]} years 递增的时间轴（可以是小数年）
 * @param {number[]} values 正值序列
 * @param {{harmonics?: number}} options
 */
export function fitTrigonometric(years, values, options = {}) {
  const { harmonics = 12 } = options;
  const n = years.length;
  if (n < 8 || harmonics < 1) return null;

  const t0 = years[0];
  const span = years[n - 1] - t0;
  if (!(span > 0)) return null;

  const t = years.map((y) => y - t0);
  const logs = values.map((v) => Math.log(Math.max(v, 1e-9)));

  // ---- 基函数 ----
  const cols = [t.map(() => 1)]; // 常数
  cols.push(t.map((x) => 1 - Math.cos((Math.PI * x) / span))); // 半周期趋势项

  for (let k = 1; k <= harmonics; k += 1) {
    const w = (2 * Math.PI * k) / span;
    cols.push(t.map((x) => Math.sin(w * x)));
    cols.push(t.map((x) => Math.cos(w * x)));
  }

  const m = cols.length;
  const ata = Array.from({ length: m }, () => new Array(m).fill(0));
  const atb = new Array(m).fill(0);

  for (let i = 0; i < m; i += 1) {
    for (let j = i; j < m; j += 1) {
      let sum = 0;
      for (let q = 0; q < n; q += 1) sum += cols[i][q] * cols[j][q];
      ata[i][j] = sum;
      ata[j][i] = sum;
    }
    let sum = 0;
    for (let q = 0; q < n; q += 1) sum += cols[i][q] * logs[q];
    atb[i] = sum;
  }

  // 轻微 ridge：高次谐波在样本稀疏时会互相抵消，加一点阻尼更稳
  for (let i = 3; i < m; i += 1) ata[i][i] += 1e-6 * n;

  const coef = solveLinear(ata, atb);
  if (!coef) return null;

  const fittedLog = t.map((x, idx) => {
    let v = 0;
    for (let i = 0; i < m; i += 1) v += coef[i] * cols[i][idx];
    return v;
  });

  const r2 = r2Of(logs, fittedLog);

  // ---- 每个谐波的信息 ----
  const harmonicsInfo = [];
  for (let k = 1; k <= harmonics; k += 1) {
    const sinCoef = coef[2 + (k - 1) * 2];
    const cosCoef = coef[3 + (k - 1) * 2];
    const amplitude = Math.hypot(sinCoef, cosCoef);
    harmonicsInfo.push({
      k,
      period: span / k,
      amplitude,
      // 对数尺度下的振幅 → 百分比
      amplitudePct: Math.exp(amplitude) - 1,
      sinCoef,
      cosCoef,
    });
  }

  // 主谐波：振幅最大的那个（排除半周期项）
  const dominant = harmonicsInfo.reduce(
    (best, cur) => (cur.amplitude > best.amplitude ? cur : best),
    harmonicsInfo[0]
  );

  // 当前相位：由导数符号判断上行/下行
  const lastT = t[n - 1];
  let slope = 0;
  slope += coef[1] * (Math.PI / span) * Math.sin((Math.PI * lastT) / span);
  for (let k = 1; k <= harmonics; k += 1) {
    const w = (2 * Math.PI * k) / span;
    const sinCoef = coef[2 + (k - 1) * 2];
    const cosCoef = coef[3 + (k - 1) * 2];
    slope += sinCoef * w * Math.cos(w * lastT) - cosCoef * w * Math.sin(w * lastT);
  }

  // 趋势线：只保留常数 + 半周期项（这是「纯三角函数」版本的长期趋势）
  const trendLog = t.map((x) => coef[0] + coef[1] * (1 - Math.cos((Math.PI * x) / span)));

  return {
    harmonics,
    span,
    coef,
    r2,
    fittedLog,
    fitted: fittedLog.map((v) => Math.exp(v)),
    trendLog,
    trend: trendLog.map((v) => Math.exp(v)),
    // 波浪 = 拟合值 − 纯三角趋势
    waveLog: fittedLog.map((v, i) => v - trendLog[i]),
    harmonicsInfo,
    dominant,
    slope,
    parameters: m,
  };
}

/**
 * 分段三角函数：每个节点段用一组独立的谐波。
 *
 * 用户之前要求「A·sin(aπ+b) 三个量都能分段变」。这里用同样的思路，
 * 但每一项都是三角函数：
 *   段 s 的拟合 = 常数 + 半周期项 + Σ_k [sin/cos]  （每个谐波的频率按段长缩放）
 *
 * 为了让整条曲线连续，相邻段在边界处用余弦窗混合。
 */
export function fitSegmentedTrigonometric(years, values, options = {}) {
  const { segments = 12, harmonics = 3 } = options;
  const n = years.length;
  if (n < 20 || segments < 1) return null;

  const t0 = years[0];
  const t = years.map((y) => y - t0);
  const logs = values.map((v) => Math.log(Math.max(v, 1e-9)));
  const first = years[0];
  const last = years[n - 1];

  const nodes = [];
  for (let k = 0; k <= segments; k += 1) {
    nodes.push(first + ((last - first) * k) / segments);
  }

  const fits = [];
  for (let s = 0; s < segments; s += 1) {
    const from = nodes[s];
    const to = nodes[s + 1];
    const idx = [];
    for (let i = 0; i < n; i += 1) {
      if (years[i] >= from && years[i] <= to) idx.push(i);
    }
    if (idx.length < 8) {
      fits.push(null);
      continue;
    }

    // 段内抽稀：日频数据一段可能几百个点，压到 ~50 个
    let useIdx = idx;
    if (idx.length > 50) {
      const stride = idx.length / 50;
      useIdx = [];
      for (let j = 0; j < 50; j += 1) {
        useIdx.push(idx[Math.min(idx.length - 1, Math.round(j * stride))]);
      }
      if (useIdx[useIdx.length - 1] !== idx[idx.length - 1]) {
        useIdx[useIdx.length - 1] = idx[idx.length - 1];
      }
    }

    const ts = useIdx.map((i) => t[i]);
    const ys = useIdx.map((i) => logs[i]);
    const span = to - from;
    if (!(span > 0)) {
      fits.push(null);
      continue;
    }

    const segFit = fitSegmentTrig(ts, ys, span, harmonics);
    if (!segFit) {
      fits.push(null);
      continue;
    }
    fits.push({ ...segFit, from, to, span, idx, useIdx });
  }

  // 合成：余弦窗混合
  const fittedLog = new Array(n).fill(0);
  const weightSum = new Array(n).fill(0);

  for (const fit of fits) {
    if (!fit) continue;
    for (const i of fit.idx) {
      const pos = (years[i] - fit.from) / (fit.to - fit.from || 1);
      const edge = Math.min(pos, 1 - pos);
      const weight = 0.35 + 0.65 * Math.min(1, edge * 4);

      // 用 evaluate(x) 直接算，避免 basis 数组的索引错位
      const x = t[i] - (fit.from - t0);
      const v = fit.evaluate(x);
      fittedLog[i] += v * weight;
      weightSum[i] += weight;
    }
  }

  const finalLog = fittedLog.map((v, i) => (weightSum[i] > 0 ? v / weightSum[i] : logs[i]));
  const r2 = r2Of(logs, finalLog);

  // 纯三角趋势：只用第一谐波前的常数 + 半周期项（用全局拟合算）
  const globalFit = fitTrigonometric(years, values, { harmonics: 2 });
  const trendLog = globalFit ? globalFit.trendLog : finalLog;

  return {
    segments,
    harmonics,
    nodes,
    r2,
    fittedLog: finalLog,
    fitted: finalLog.map((v) => Math.exp(v)),
    trendLog,
    trend: trendLog.map((v) => Math.exp(v)),
    waveLog: finalLog.map((v, i) => v - trendLog[i]),
    segmentInfo: fits.map((fit, s) => ({
      from: Math.round(nodes[s]),
      to: Math.round(nodes[s + 1]),
      r2: fit ? fit.r2 : 0,
      dominantPeriod: fit ? fit.span / fit.dominantK : null,
      amplitudePct: fit ? Math.exp(fit.maxAmplitude) - 1 : 0,
    })),
    parameters: fits.filter(Boolean).length * (2 + 2 * harmonics),
  };
}

/** 单段：纯三角函数（常数 + 半周期项 + K 个谐波），频率按段长缩放 */
function fitSegmentTrig(ts, ys, span, harmonics) {
  const cols = [ts.map(() => 1)];
  cols.push(ts.map((x) => 1 - Math.cos((Math.PI * x) / span)));

  for (let k = 1; k <= harmonics; k += 1) {
    const w = (2 * Math.PI * k) / span;
    cols.push(ts.map((x) => Math.sin(w * x)));
    cols.push(ts.map((x) => Math.cos(w * x)));
  }

  const m = cols.length;
  const len = ts.length;
  const ata = Array.from({ length: m }, () => new Array(m).fill(0));
  const atb = new Array(m).fill(0);

  for (let i = 0; i < m; i += 1) {
    for (let j = i; j < m; j += 1) {
      let sum = 0;
      for (let q = 0; q < len; q += 1) sum += cols[i][q] * cols[j][q];
      ata[i][j] = sum;
      ata[j][i] = sum;
    }
    let sum = 0;
    for (let q = 0; q < len; q += 1) sum += cols[i][q] * ys[q];
    atb[i] = sum;
  }

  for (let i = 2; i < m; i += 1) ata[i][i] += 1e-6 * len;

  const coef = solveLinear(ata, atb);
  if (!coef) return null;

  const pred = ts.map((x, idx) => {
    let v = 0;
    for (let i = 0; i < m; i += 1) v += coef[i] * cols[i][idx];
    return v;
  });
  const r2 = r2Of(ys, pred);

  // 主谐波与振幅
  let dominantK = 1;
  let maxAmplitude = 0;
  for (let k = 1; k <= harmonics; k += 1) {
    const amp = Math.hypot(coef[2 + (k - 1) * 2], coef[3 + (k - 1) * 2]);
    if (amp > maxAmplitude) {
      maxAmplitude = amp;
      dominantK = k;
    }
  }

  return {
    coef,
    r2,
    span,
    dominantK,
    maxAmplitude,
    // 合成时直接按公式算，不用 basis 数组
    evaluate(x) {
      let v = coef[0] + coef[1] * (1 - Math.cos((Math.PI * x) / span));
      for (let k = 1; k <= harmonics; k += 1) {
        const w = (2 * Math.PI * k) / span;
        v += coef[2 + (k - 1) * 2] * Math.sin(w * x) + coef[3 + (k - 1) * 2] * Math.cos(w * x);
      }
      return v;
    },
  };
}

/** 康波阶段划分（史学界常见版本，仅用于对照） */
export const KONDRATIEFF_PHASES = [
  { wave: 1, up: [1789, 1814], down: [1814, 1849] },
  { wave: 2, up: [1849, 1873], down: [1873, 1896] },
  { wave: 3, up: [1896, 1920], down: [1920, 1940] },
  { wave: 4, up: [1940, 1970], down: [1970, 1990] },
];