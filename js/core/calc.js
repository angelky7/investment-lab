/**
 * js/core/calc.js — 计算器的纯数学部分。
 *
 * 全部按月复利，不涉及任何历史数据，因此可以完全单元测试。
 * 注意：这里的「收益率」是假设的常数收益率，用来演示复利机制，绝不是预测。
 */

/**
 * 复利 + 每月定投的增长路径。
 * @param {{principal?: number, monthly?: number, annualRate?: number, years?: number}} input
 * @returns {{rows: {month: number, value: number, invested: number}[], finalValue: number,
 *   totalInvested: number, gain: number, totalReturn: number, years: number,
 *   annualRate: number}}
 */
export function compoundGrowth(input = {}) {
  const principal = Math.max(0, input.principal ?? 0);
  const monthly = Math.max(0, input.monthly ?? 0);
  const annualRate = input.annualRate ?? 0;
  const years = Math.max(0, input.years ?? 0);

  const months = Math.round(years * 12);
  const monthlyRate = annualRate / 12;
  const rows = [];
  let balance = principal;
  let invested = principal;

  rows.push({ month: 0, value: balance, invested });
  for (let m = 1; m <= months; m += 1) {
    balance = balance * (1 + monthlyRate) + monthly;
    invested += monthly;
    rows.push({ month: m, value: balance, invested });
  }

  const finalValue = balance;
  const totalInvested = invested;
  const gain = finalValue - totalInvested;
  return {
    rows,
    finalValue,
    totalInvested,
    gain,
    totalReturn: totalInvested > 0 ? gain / totalInvested : null,
    years,
    annualRate,
  };
}

/**
 * 年金终值（定投）。
 * @param {{amount?: number, annualRate?: number, years?: number, timesPerYear?: number}} input
 */
export function annuity(input = {}) {
  const amount = Math.max(0, input.amount ?? 0);
  const annualRate = input.annualRate ?? 0;
  const years = Math.max(0, input.years ?? 0);
  const timesPerYear = input.timesPerYear ?? 12;

  const periods = Math.round(years * timesPerYear);
  const rate = annualRate / timesPerYear;
  let finalValue;
  if (rate === 0) finalValue = amount * periods;
  else finalValue = amount * ((Math.pow(1 + rate, periods) - 1) / rate);

  const invested = amount * periods;
  return {
    finalValue,
    invested,
    gain: finalValue - invested,
    totalReturn: invested > 0 ? (finalValue - invested) / invested : null,
    periods,
    timesPerYear,
  };
}

/**
 * 回撤与回本。
 *
 * 两个不对称的方向：
 * 回撤 = (高点 − 低点) / 高点
 * 回本所需涨幅 = (高点 − 低点) / 低点 = 回撤 / (1 − 回撤)
 */
export function drawdownRecovery(high, low) {
  if (!(high > 0) || !(low > 0) || low > high) return null;
  const drawdown = (high - low) / high;
  const recovery = (high - low) / low;
  return { high, low, drawdown, recovery, ratio: drawdown > 0 ? recovery / drawdown : null };
}

/**
 * 再平衡调整表。
 * @param {{total?: number, items?: {name: string, current?: number, target?: number}[]}} input
 *   current 为当前持有金额，target 为目标权重（百分数，0-100）。
 */
export function rebalancePlan(input = {}) {
  const items = input.items || [];
  const targetSum = items.reduce((acc, item) => acc + (Number(item.target) || 0), 0);
  const currentSum = items.reduce((acc, item) => acc + (Number(item.current) || 0), 0);
  const total = Number.isFinite(input.total) && input.total > 0 ? input.total : currentSum;

  let drift = 0;
  for (const item of items) {
    const current = Number(item.current) || 0;
    if (currentSum > 0) {
      drift += Math.abs(current / currentSum - (Number(item.target) || 0) / 100);
    }
  }

  const rows = items.map((item) => {
    const target = Number(item.target) || 0;
    const current = Number(item.current) || 0;
    const targetAmount = (total * target) / 100;
    const delta = targetAmount - current;
    return {
      name: item.name || "未命名",
      current,
      target,
      targetAmount,
      delta,
      action: delta > 0.5 ? "buy" : delta < -0.5 ? "sell" : "hold",
    };
  });

  return {
    total,
    rows,
    targetSum,
    valid: Math.abs(targetSum - 100) < 0.01,
    drift: currentSum > 0 ? drift / 2 : 0,
  };
}

/** 假设年化收益下，每月定投多少年能到目标（简单数值求解） */
export function monthsToTarget({ monthly = 1000, annualRate = 0.06, target = 1000000 } = {}) {
  if (monthly <= 0 || target <= 0) return null;
  const rate = annualRate / 12;
  let balance = 0;
  for (let m = 1; m <= 1200; m += 1) {
    balance = balance * (1 + rate) + monthly;
    if (balance >= target) return m;
  }
  return null;
}