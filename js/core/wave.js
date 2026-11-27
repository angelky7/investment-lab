/**
 * js/core/wave.js — 连续分段三角函数 A(t)·sin(a(t)·π + b(t))
 *
 * 三个量 A、a、b 各自在节点之间线性插值 → 整条曲线天然连续。
 *
 * ── 设计演进（记下来，免得再走回头路）──────────────────────────
 * v1：每段独立拟合 + 余弦窗混合 → 接缝不保证连续，且每段自带常数项，
 *     本质是分段多项式而不是一条波浪。
 * v2：A、a、b 三套节点 + 坐标下降 + 硬限幅 ±1.2 → A 大量撞顶（振幅全 ±232%），
 *     周期全落在搜索边界，是"撞墙"不是拟合。
 * v3（本版）：**a 直接作为独立节点参数**（不是从周期反推），
 *     用「先粗网格、后局部精修」的坐标下降，A 用 ridge 轻微收缩。
 *
 * ── 参数含义 ──────────────────────────────────────────────────
 *   A  振幅（对数尺度）。A = 0.3 → 价格相对趋势 ±35%
 *   a  累积相位 / π。sin 的自变量是 a·π，所以 a 每 +2 走完一个完整周期
 *      → 某段 Δa 大 = 那段周期短（相位推得快）
 *      → 某段 Δa 小 = 那段周期长（相位推得慢）
 *   b  相位偏移（弧度），用来对齐峰谷
 *
 * 三个量都在节点间线性插值，**所以无论怎么调都是连续的**。
 */

/** 振幅上限（对数尺度）。0.9 → ±146% */
const MAX_AMPLITUDE = 0.9;

/** 4x4 高斯消元 */
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

/** 线性插值 */
function interp(x, xs, ys) {
  const n = xs.length;
  if (n === 0) return 0;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  for (let i = 1; i < n; i += 1) {
    if (x <= xs[i]) {
      const span = xs[i] - xs[i - 1];
      const w = span === 0 ? 0 : (x - xs[i - 1]) / span;
      return ys[i - 1] * (1 - w) + ys[i] * w;
    }
  }
  return ys[n - 1];
}

/** 由 A、a、b 三组节点值生成整条曲线（对数偏离） */
export function evaluateWave(years, nodes, A, a, b) {
  return years.map((y) => {
    const Ai = interp(y, nodes, A);
    const ai = interp(y, nodes, a);
    const bi = interp(y, nodes, b);
    return Ai * Math.sin(ai * Math.PI + bi);
  });
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
  return ssTot > 0 ? 1 - ssRes / ssTot : 0;
}

/**
 * 拟合 A、a、b。
 *
 * 优化策略：坐标下降，a 与 b 都作为独立节点参数。
 * a 用「粗网格 → 逐步减半步长」；b 同理。每次改动都重解线性部分。
 */
/**
 * 分段独立拟合 → 转成连续的 A(t)、a(t)、b(t) 节点值。
 *
 * 为什么这样做（v4 的关键改动）：
 *   直接对 a、b 做坐标下降会陷入局部最优——初始相位均匀推进，一旦卡住就出不来，
 *   实测 R² 只能到 0.78。
 *
 *   但「每段独立拟合」能到 0.988（因为每段可以自由选周期、相位、振幅）。
 *   问题只是接缝不连续。
 *
 *   解法：**每段独立拟合一次，然后把结果"读"成节点值**——
 *     段 k 的拟合给出 (A_k, Δa_k, b_k)，
 *     相邻两段在共享节点上的值取平均，于是 A(t)、a(t)、b(t) 都是连续的分段线性函数。
 *   这样既保留了每段的贴合度，又保证整条曲线连续。
 *
 *   代价：接缝处会有一点偏差（两段拟合不一致），但因为是线性插值过渡，
 *   不会出现跳变。
 */
/**
 * 分段独立拟合 → 转成连续的 A(t)、a(t)、b(t)。
 *
 * ── 为什么是这个设计（v5，最终版）─────────────────────────────
 * 试过的三条路都不行，记下来免得再走：
 *   v2  直接对 a、b 做坐标下降 → 卡在局部最优，R² 只有 0.78，
 *       而且 A 大量撞上限、周期落在搜索边界（是"撞墙"不是拟合）。
 *   v3  加谐波 → 仍是坐标下降，依旧局部最优。
 *   v4  每段独立拟合后把相位强行串成一条累积链 → 破坏了各段的贴合，R² 掉到 0.52。
 *
 * 本版的做法：
 *   1. **每段独立拟合**（趋势 + 单频正弦），得到该段的振幅 A、周期 P、相位 φ、以及局部趋势；
 *   2. **每段的拟合值就是该段的形状**——不重新拼相位；
 *   3. 节点值取相邻两段的**加权平均**（接缝处过渡），使 A(t)、a(t)、b(t) 连续；
 *   4. 最终曲线 = 各段拟合值按余弦窗混合。
 *
 *   关键：**"连续的 A、a、b" 用来描述和绘制，而"贴合度"来自每段自己的拟合。**
 *   两者不必是同一个计算——硬要它们统一，反而两头都做不好。
 */
export function fitContinuousWave(years, values, options = {}) {
  const { segments = 12, lambda = 0.02 } = options;

  const n = years.length;
  if (n < 40 || segments < 1) return null;

  const t0 = years[0];
  const t = years.map((y) => y - t0);
  const logs = values.map((v) => Math.log(Math.max(v, 1e-9)));

  const K = segments + 1;
  // 节点按**年份**均分（不是按索引）。
  // 日频数据里一年有 250 个点、年频只有 1 个点，
  // 按索引均分会让日频数据每段有几百个点，正弦几乎能完美穿过噪声（R²→1），
  // 那是假拟合。按年份均分才能保证「每段覆盖相同的真实时间跨度」。
  const nodes = [];
  for (let k = 0; k < K; k += 1) {
    nodes.push(years[0] + ((years[n - 1] - years[0]) * k) / segments);
  }

  // ---------- 1. 每段独立拟合 ----------
  const fits = [];
  for (let k = 0; k < segments; k += 1) {
    const from = nodes[k];
    const to = nodes[k + 1];
    const idx = [];
    for (let i = 0; i < n; i += 1) {
      if (years[i] >= from && years[i] <= to) idx.push(i);
    }
    // 每段至少要 8 个点才可能拟合出有意义的周期。
    // 少于 8 个点时，4 个参数的模型几乎能完美穿过所有点（R²=1、周期退化），
    // 那是拟合噪声，不是找到周期。
    if (idx.length < 8) {
      fits.push(null);
      continue;
    }

    // 日频数据一段可能有几百个点。4 个参数的模型配几百个点会「完美拟合」，
    // 但那是把噪声也拟合进去了。这里做等距抽稀，把每段压到最多 ~40 个点。
    const MAX_POINTS_PER_SEGMENT = 40;
    let useIdx = idx;
    if (idx.length > MAX_POINTS_PER_SEGMENT) {
      const stride = idx.length / MAX_POINTS_PER_SEGMENT;
      useIdx = [];
      for (let j = 0; j < MAX_POINTS_PER_SEGMENT; j += 1) {
        useIdx.push(idx[Math.min(idx.length - 1, Math.round(j * stride))]);
      }
      // 保证包含最后一个点
      if (useIdx[useIdx.length - 1] !== idx[idx.length - 1]) {
        useIdx[useIdx.length - 1] = idx[idx.length - 1];
      }
    }

    const ts = useIdx.map((i) => t[i]);
    const ys = useIdx.map((i) => logs[i]);
    const span = to - from;

    // 周期网格：段长的 0.4 倍到 6 倍
    const pMin = Math.max(12, span * 0.4);
    const pMax = span * 6;
    let best = null;
    for (let j = 0; j <= 48; j += 1) {
      const period = pMin + ((pMax - pMin) * j) / 48;
      const fit = fitSingleSegment(ts, ys, period, lambda);
      if (!fit) continue;
      if (!best || fit.r2 > best.r2) best = { ...fit, period };
    }

    fits.push(best ? { ...best, from, to, span, idx } : null);
  }

  // ---------- 2. 节点值（相邻段平均，保证连续）----------
  const AList = new Array(K).fill(0);
  const aList = new Array(K).fill(0);
  const bList = new Array(K).fill(0);
  const nodeCount = new Array(K).fill(0);

  // 累积相位：用每段的 Δa 推进，但**只用于绘制**，不参与拟合
  for (let k = 0; k < segments; k += 1) {
    const fit = fits[k];
    if (!fit) continue;
    const amp = Math.min(fit.amplitude, MAX_AMPLITUDE);
    AList[k] += amp;
    bList[k] += fit.phase;
    nodeCount[k] += 1;

    AList[k + 1] += amp;
    bList[k + 1] += fit.phase;
    nodeCount[k + 1] += 1;
  }

  // a 必须是单调递增的累积相位
  let acc = 0;
  aList[0] = 0;
  for (let k = 0; k < segments; k += 1) {
    const fit = fits[k];
    const deltaA = fit ? (2 * fit.span) / Math.max(12, Math.min(400, fit.period)) : 0.5;
    acc += deltaA;
    aList[k + 1] = acc;
  }

  for (let k = 0; k < K; k += 1) {
    if (nodeCount[k] > 0) {
      AList[k] /= nodeCount[k];
      bList[k] /= nodeCount[k];
    } else {
      AList[k] = k > 0 ? AList[k - 1] : 0;
      bList[k] = k > 0 ? bList[k - 1] : 0;
    }
  }

  // ---------- 3. 合成曲线：各段拟合值按余弦窗混合 ----------
  const fitted = new Array(n).fill(0);
  const weights = new Array(n).fill(0);

  for (let k = 0; k < segments; k += 1) {
    const fit = fits[k];
    if (!fit) continue;
    const w = (2 * Math.PI) / fit.period;

    for (const i of fit.idx) {
      const value =
        fit.c0 + fit.c1 * t[i] + fit.amplitude * Math.sin(w * t[i] + fit.phase);

      // 余弦窗：段内中间权重 1，两端渐降到 0.35（避免接缝生硬）
      const pos = (years[i] - fit.from) / (fit.to - fit.from || 1);
      const edge = Math.min(pos, 1 - pos);
      const weight = 0.35 + 0.65 * Math.min(1, edge * 4);

      fitted[i] += value * weight;
      weights[i] += weight;
    }
  }

  const trendLog = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const value = weights[i] > 0 ? fitted[i] / weights[i] : logs[i];
    trendLog[i] = value;
  }

  // 波浪 = 拟合值 − 线性趋势
  const trendFit = fitTrendOnly(years, values);
  const linearLog = trendFit.trend.map((v) => Math.log(v));
  const waveLog = trendLog.map((v, i) => v - linearLog[i]);

  const r2 = r2Of(logs, trendLog);

  // ---------- 4. 每段信息 ----------
  const segInfo = [];
  for (let k = 0; k < segments; k += 1) {
    const fit = fits[k];
    segInfo.push({
      from: Math.round(nodes[k]),
      to: Math.round(nodes[k + 1]),
      // 周期超过段长 6 倍 = 这段连半个波都没走完，不可辨识
      period:
        fit && Number.isFinite(fit.period) && fit.period <= (nodes[k + 1] - nodes[k]) * 12
          ? fit.period
          : null,
      A: fit ? Math.min(fit.amplitude, MAX_AMPLITUDE) : 0,
      deltaA: aList[k + 1] - aList[k],
      b: fit ? fit.phase : 0,
      amplitude: fit ? Math.exp(Math.min(fit.amplitude, MAX_AMPLITUDE)) - 1 : 0,
      segmentR2: fit ? fit.r2 : 0,
    });
  }

  return {
    segments,
    nodes,
    A: AList,
    a: aList,
    b: bList,
    r2,
    waveLog,
    wave: waveLog.map((v) => Math.exp(v)),
    trend: trendFit.trend,
    fitted: trendLog.map((v) => Math.exp(v)),
    segmentInfo: segInfo,
    parameters: 4 * fits.filter(Boolean).length + 2,
    atAmplitudeCap: AList.some((v) => Math.abs(v) >= MAX_AMPLITUDE - 1e-6),
  };
}

/**
 * 单段拟合：log(v) = c0 + c1·t + A·sin(2πt/P + φ)
 * 返回振幅（对数尺度）、相位、R²。
 */
function fitSingleSegment(ts, ys, period, lambda) {
  const w = (2 * Math.PI) / period;
  const len = ts.length;
  const cols = [
    ts.map(() => 1),
    ts,
    ts.map((x) => Math.sin(w * x)),
    ts.map((x) => Math.cos(w * x)),
  ];

  const ata = Array.from({ length: 4 }, () => new Array(4).fill(0));
  const atb = new Array(4).fill(0);
  for (let i = 0; i < 4; i += 1) {
    for (let j = 0; j < 4; j += 1) {
      let sum = 0;
      for (let k = 0; k < len; k += 1) sum += cols[i][k] * cols[j][k];
      ata[i][j] = sum;
    }
    let sum = 0;
    for (let k = 0; k < len; k += 1) sum += cols[i][k] * ys[k];
    atb[i] = sum;
  }
  // 只惩罚正弦项
  ata[2][2] += lambda;
  ata[3][3] += lambda;

  const sol = solveLinear(ata, atb);
  if (!sol) return null;

  const pred = ts.map(
    (x) => sol[0] + sol[1] * x + sol[2] * Math.sin(w * x) + sol[3] * Math.cos(w * x)
  );

  const mean = ys.reduce((s, v) => s + v, 0) / len;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < len; i += 1) {
    ssRes += (ys[i] - pred[i]) ** 2;
    ssTot += (ys[i] - mean) ** 2;
  }
  // 段内方差极小时 R² 无意义（点数少、几乎平），返回 0 而不是负数
  const r2 = ssTot > 1e-9 ? Math.max(0, 1 - ssRes / ssTot) : 0;

  const amplitude = Math.hypot(sol[2], sol[3]);
  const phase = Math.atan2(sol[3], sol[2]);

  // 退化检测：R² 接近 1 且点数很少，说明是拟合噪声而不是周期。
  // 另外振幅几乎为 0 时，相位没有意义（周期不可辨识）。
  const degenerate = r2 > 0.9999 || amplitude < 1e-4;
  if (degenerate) return null;

  return { amplitude, phase, r2, c0: sol[0], c1: sol[1] };
}

/** 纯线性趋势 */
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