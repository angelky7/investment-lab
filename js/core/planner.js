/**
 * js/core/planner.js — 配置求解器（纯计算，不接触 DOM）。
 *
 * 设计思想（与直接给一张「风险等级 → 配比」对照表的做法不同）：
 *
 * 1. **不预设答案**。不使用「进取型 = 70% 股票」这类写死的映射，
 *    而是在真实历史数据上把候选配置**逐个回测**，再挑出满足约束的那个。
 * 2. **约束优先，收益其次**。先用「你能承受的最大回撤」筛掉不能拿住的组合，
 *    再在这个可行集里找收益最高的。因为拿不住的组合，它的理论收益与你无关。
 * 3. **行为优先于数学**。如果用户说「跌 20% 我会全部卖出」，
 *    那么任何回撤超过 20% 的组合对他都是无效的——这一点会被显式写进约束。
 * 4. **算不出来就说算不出来**。如果历史数据里没有任何配置能在约束内达到目标收益，
 *    就如实报告最接近的那个与其差距，而不是把数字凑上去。
 * 5. **明确不是推荐**。本模块的所有输出都在描述「历史若重演会怎样」，
 *    而不是「你应该买什么」。
 * 6. **必须加分散边界**。这是实现过程中被真实数据逼出来的教训：
 *    完全无约束的网格搜索会把 100% 权重压到「这段历史里涨得最好的两档」上
 *    （实测会给出 60% 海外股票 + 40% 黄金、A 股/国债/现金全为 0），
 *    那是**对窗口的过拟合**，而不是配置。因此每档限定 10%–40%、且至少三类各占 10% 以上。
 */

export const ASSET_CLASSES = [
  { id: "cnStock", key: "etf:510300", label: "A 股宽基", role: "主要收益来源", equity: true },
  { id: "overseas", key: "etf:513500", label: "海外股票", role: "地域分散", equity: true },
  { id: "bond", key: "etf:511010", label: "国债", role: "压低波动", equity: false },
  // 黄金的角色常被简化成「通胀对冲」，但它短期同样会大跌（近一年回撤比标普500 深得多），
  // 所以这里的描述刻意写成有条件的两段式
  { id: "gold", key: "etf:518880", label: "黄金", role: "长期对冲通胀（短期也会跌）", equity: false },
  { id: "cash", key: "etf:511880", label: "现金", role: "流动性与弹药", equity: false },
];

/** 问卷：每个选项带「对约束的影响」，而不是给一个风险分档 */
export const QUESTIONS = [
  {
    id: "drawdown",
    title: "这笔钱最多能承受多大亏损？",
    hint: "指账面浮亏。请按「真实发生时会睡不着」的下限来选，不要按理想值。",
    options: [
      { value: 0.05, label: "5% 以内", note: "接近纯债/货基的波动" },
      { value: 0.1, label: "10% 左右", note: "可接受一次正常回调" },
      { value: 0.2, label: "20% 左右", note: "能扛住一轮熊市的前半段" },
      { value: 0.3, label: "30% 以上", note: "接受腰斩级别的一半" },
    ],
  },
  {
    id: "target",
    title: "你希望的年化收益是多少？",
    hint: "收益是对风险的补偿。这里选的是「期望」，不是「保证」。",
    options: [
      { value: [0.03, 0.05], label: "3%–5%", note: "略高于存款与货基" },
      { value: [0.05, 0.07], label: "5%–7%", note: "接近长期股债混合的常见区间" },
      { value: [0.07, 0.1], label: "7%–10%", note: "需要权益资产承担主要角色" },
      { value: [0.1, 0.2], label: "10% 以上", note: "历史上只有少数时段与少数配置做到过" },
    ],
  },
  {
    id: "horizon",
    title: "这笔钱多久内不会用到？",
    hint: "时间是最有效的风险缓冲：期限越短，回撤就越可能变成真实损失。",
    options: [
      { value: 1, label: "1 年以内", note: "本质上是短期资金" },
      { value: 3, label: "1–3 年", note: "能容忍一次中等回撤的修复" },
      { value: 5, label: "3–5 年", note: "可以承担权益配置" },
      { value: 10, label: "5 年以上", note: "时间是你的朋友" },
    ],
  },
  {
    id: "behavior",
    title: "如果半年内浮亏 20%，你会怎么做？",
    hint: "这一题比前几题更重要：拿不住的组合，收益与你无关。",
    options: [
      { value: "add", label: "继续买入", note: "把下跌当作机会" },
      { value: "hold", label: "什么都不做", note: "能靠纪律拿住" },
      { value: "trim", label: "卖掉一部分", note: "会让实际收益偏离回测" },
      { value: "exit", label: "全部卖出", note: "任何深度回撤的配置对你都无效" },
    ],
  },
];

/** 由答案推导约束 */
export function constraintsFromAnswers(answers = {}) {
  const drawdown = Number.isFinite(answers.drawdown) ? answers.drawdown : 0.2;
  const target = Array.isArray(answers.target) ? answers.target : [0.05, 0.07];
  const horizon = Number.isFinite(answers.horizon) ? answers.horizon : 5;
  const behavior = answers.behavior || "hold";

  // 期限上限：短期资金不该承担大回撤
  const horizonCap = horizon <= 1 ? 0.1 : horizon <= 3 ? 0.2 : horizon <= 5 ? 0.35 : 1;
  // 行为上限：会割肉的人，实际承受力比自称的低
  const behaviorCap = behavior === "exit" ? 0.12 : behavior === "trim" ? 0.25 : 1;

  const budget = Math.min(drawdown, horizonCap, behaviorCap);

  // 行为约束：会卖出的人要限制权益上限
  const equityCap = behavior === "exit" ? 0.2 : behavior === "trim" ? 0.4 : 1;

  const binding = [];
  if (horizonCap < drawdown) binding.push({ factor: "horizon", value: horizonCap });
  if (behaviorCap < drawdown) binding.push({ factor: "behavior", value: behaviorCap });

  return {
    drawdownBudget: budget,
    statedDrawdown: drawdown,
    targetLow: target[0],
    targetHigh: target[1],
    horizon,
    behavior,
    equityCap,
    binding,
  };
}

/** 单次评估：固定权重、每年调回目标，返回收益/风险指标 */
export function evaluateAllocation(weights, prices, options = {}) {
  const n = prices.length;
  if (!n || weights.length !== prices[0].length) return null;
  const rebalanceEvery = options.rebalanceEvery ?? 252;
  const initial = options.initial ?? 1;

  const units = weights.map((w, i) => (prices[0][i] > 0 ? (w * initial) / prices[0][i] : 0));
  if (units.some((u) => !Number.isFinite(u))) return null;

  let peak = 0;
  let maxDrawdown = 0;
  let prevValue = null;
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  let finalValue = 0;

  for (let t = 0; t < n; t += 1) {
    let total = 0;
    for (let i = 0; i < units.length; i += 1) total += units[i] * prices[t][i];
    finalValue = total;

    if (total > peak) peak = total;
    if (peak > 0) {
      const dd = (total - peak) / peak;
      if (dd < maxDrawdown) maxDrawdown = dd;
    }
    if (prevValue !== null && prevValue > 0) {
      const r = total / prevValue - 1;
      sum += r;
      sumSq += r * r;
      count += 1;
    }
    prevValue = total;

    if (t > 0 && t < n - 1 && rebalanceEvery > 0 && t % rebalanceEvery === 0) {
      for (let i = 0; i < units.length; i += 1) {
        if (prices[t][i] > 0) units[i] = (total * weights[i]) / prices[t][i];
      }
    }
  }

  const meanReturn = count > 0 ? sum / count : 0;
  const variance = count > 1 ? (sumSq - count * meanReturn * meanReturn) / (count - 1) : 0;
  const volatility = Math.sqrt(Math.max(0, variance)) * Math.sqrt(252);
  const annualized =
    finalValue > 0 && options.years > 0 ? Math.pow(finalValue / initial, 1 / options.years) - 1 : null;
  const riskFree = options.riskFreeRate ?? 0.025;

  return {
    weights,
    finalValue,
    annualized,
    volatility,
    maxDrawdown,
    sharpe: volatility > 0 && annualized !== null ? (annualized - riskFree) / volatility : null,
    totalReturn: finalValue / initial - 1,
  };
}

/**
 * 在给定约束下搜索配置。
 *
 * 候选集为「各档权重以 step 为步长、合计 100%」的全部组合（默认 10% 一档）。
 * 先用回撤预算筛出可行集，再取其中年化收益最高的。
 *
 * @param {{prices: number[][], years: number, budget: number, targetLow: number,
 *   equityCap?: number, equityFlags: boolean[], step?: number}} input
 */
export function searchAllocation(input) {
  const {
    prices,
    years,
    budget,
    targetLow,
    equityCap = 1,
    equityFlags,
    includeMask,
    step = 0.1,
    riskFreeRate = 0.025,
    minWeight = 0.1,
    maxWeight,
  } = input;

  const n = prices.length;
  const classes = prices[0].length;
  const allIdx = Array.from({ length: classes }, (_, i) => i);
  // 只枚举用户勾选的类别：没勾的权重恒为 0（而不是给一个 10% 的底线）
  const includedIdx = includeMask
    ? allIdx.filter((i) => includeMask[i])
    : allIdx;
  const included = includedIdx.length;

  const empty = {
    candidates: [],
    feasible: [],
    chosen: null,
    bestDrawdown: null,
    includedIdx,
    bounds: { minWeight, maxWeight, step, included },
    reason: included < 2 ? "至少需要勾选 2 个资产类别" : "",
  };
  if (!n || !classes || included < 2) return empty;

  const steps = Math.round(1 / step);
  const minSteps = Math.max(1, Math.round(minWeight / step));
  // 单档上限：
  //   勾 2 类 → 允许最高 90%（用户是明确选择"只配两类"，此时再卡 40% 会导致无解）
  //   勾 3 类及以上 → 仍卡 40%，防止退化成「押注单一资产」
  const effectiveMax =
    Number.isFinite(maxWeight) && maxWeight > 0
      ? maxWeight
      : included <= 2
        ? 1 - minWeight
        : 0.4;
  const maxSteps = Math.round(effectiveMax / step);

  if (minSteps * included > steps) return empty;

  const all = [];
  const feasible = [];
  const current = new Array(classes).fill(0);

  const walk = (k, remaining) => {
    const idx = includedIdx[k];
    if (k === included - 1) {
      if (remaining < minSteps || remaining > maxSteps) return;
      current[idx] = remaining / steps;

      const weights = current.map((v) => v);
      let equity = 0;
      for (let i = 0; i < classes; i += 1) if (equityFlags[i]) equity += weights[i];
      if (equity > equityCap + 1e-9) return;

      const result = evaluateAllocation(weights, prices, { years, riskFreeRate });
      if (!result) return;
      const point = { weights, equity, ...result };
      all.push(point);
      if (Math.abs(result.maxDrawdown) <= budget + 1e-9) feasible.push(point);
      return;
    }

    // 给后面的每一档留够最小步数
    const remainingAfter = included - k - 1;
    const upper = Math.min(maxSteps, remaining - minSteps * remainingAfter);
    for (let s = minSteps; s <= upper; s += 1) {
      current[idx] = s / steps;
      walk(k + 1, remaining - s);
    }
    current[idx] = 0;
  };

  walk(0, steps);

  feasible.sort((a, b) => {
    const diff = (b.annualized ?? -1) - (a.annualized ?? -1);
    if (Math.abs(diff) > 1e-6) return diff;
    return (a.volatility ?? 0) - (b.volatility ?? 0);
  });

  const chosen = feasible[0] || null;
  const bestDrawdown = all.length
    ? all.reduce((best, p) => (Math.abs(p.maxDrawdown) < Math.abs(best.maxDrawdown) ? p : best), all[0])
    : null;

  return {
    candidates: all,
    feasible,
    chosen,
    bestDrawdown,
    includedIdx,
    bounds: { minWeight, maxWeight: effectiveMax, step, included },
    reason: "",
  };
}

/** 把结果翻译成人话（不夸大、不推荐） */
export function buildNarrative(constraints, search, chosen) {
  const bullets = [];
  const warnings = [];

  if (!chosen) {
    const fallback = search.bestDrawdown;
    if (fallback) {
      warnings.push(
        `在历史数据里，没有任何一组配置能把最大回撤压到 ${(constraints.drawdownBudget * 100).toFixed(0)}% 以内。` +
          `回撤最浅的一组约为 ${(Math.abs(fallback.maxDrawdown) * 100).toFixed(1)}%，` +
          "这说明你的回撤要求与「把大部分钱放在能涨的资产上」是冲突的——要么放低收益预期，要么接受更大波动。"
      );
    }
    return { bullets, warnings };
  }

  const dd = Math.abs(chosen.maxDrawdown) * 100;
  const ann = (chosen.annualized ?? 0) * 100;

  bullets.push(
    `这组配置的历史年化约 ${ann.toFixed(1)}%，最大回撤约 ${dd.toFixed(1)}%，` +
      `落在你设定的 ${(constraints.drawdownBudget * 100).toFixed(0)}% 回撤预算之内。`
  );

  if (ann < constraints.targetLow * 100) {
    warnings.push(
      `注意：它没能达到你期望的 ${(constraints.targetLow * 100).toFixed(0)}%–${(
        constraints.targetHigh * 100
      ).toFixed(0)}% 年化。` +
        `在不超过 ${(constraints.drawdownBudget * 100).toFixed(0)}% 回撤的前提下，` +
        "这已经是历史数据里收益最高的组合之一。这不是算法不够聪明，而是「低回撤 + 高收益」在真实数据里很少同时出现。"
    );
  } else {
    bullets.push(
      "它在筛选规则内同时满足了回撤预算与收益预期——但请记住，这是**历史**满足，不是未来承诺。"
    );
  }

  // 回撤预算是紧还是松？这决定了「是什么在塑造答案」
  const share = search.candidates.length
    ? search.feasible.length / search.candidates.length
    : 0;
  if (share > 0.8) {
    bullets.push(
      `你的回撤预算其实很松：${search.feasible.length}/${search.candidates.length} 组候选配置都能满足它。` +
        "所以真正决定这组答案的不是风险约束，而是收益排序——换句话说，你还可以把预算往下压，代价会更小。"
    );
  } else if (share < 0.25) {
    bullets.push(
      `你的回撤预算很紧：只有 ${search.feasible.length}/${search.candidates.length} 组候选能满足它。` +
        "答案主要由这条约束塑造，收益排序只起次要作用——这正是「先定能亏多少」该有的样子。"
    );
  }

  if (constraints.binding.length) {
    const map = { horizon: "投资期限", behavior: "你的下跌应对方式" };
    const names = constraints.binding.map((b) => map[b.factor]).join("、");
    bullets.push(
      `真正收紧约束的不是你填的 ${(constraints.statedDrawdown * 100).toFixed(0)}%，而是${names}：` +
        "前者被自动下调到了更保守的水平。这两项之所以优先，是因为它们决定了「你实际能不能拿住」，而不是「理论上能承受多少」。"
    );
  }

  if (constraints.behavior === "exit") {
    warnings.push(
      "你选择了「浮亏 20% 就全部卖出」。这种情况下任何深度回撤的组合对你都会变成实际亏损，" +
        "所以这里把权益上限压到了 20%。与其找一个更激进的配置，不如先改掉这个行为——它比选资产重要得多。"
    );
  }

  bullets.push(
    "这组权重来自「用真实历史数据逐个回测、再按你的约束筛选」，不是预设的风险等级对照表；" +
      "换一段历史窗口，答案通常会变。"
  );

  return { bullets, warnings };
}

/** 历史窗口说明：回测起点由最短的资产决定 */
export function windowNote(classes, startDates) {
  const start = startDates.filter(Boolean).sort().pop();
  return `五个资产类别中数据最晚开始的一项是 ${start || "—"}，因此本次计算的历史窗口从这里开始；
更早的时段这几类资产并不同时存在，硬凑会把结论建立在不同区间上。`;
}