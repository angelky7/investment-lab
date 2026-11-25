/**
 * js/core/market-check.js — 用真实数据检验「教科书说法」。
 *
 * 起因很直接：站里一直把黄金讲成「通胀对冲」，但最近一年的数据是
 * 黄金 −16.6%、最大回撤 −38.8%，而标普500 +7.4%、回撤 −11.6%——
 * 黄金跌得比美股还快。这类「说法与数据不一致」必须由数据自己指出来，
 * 而不是靠文案口径粉饰。
 *
 * 本模块只做计算，文案由数据生成（数字变了，结论就跟着变）。
 */

/** 参与对照的资产（覆盖股票 / 黄金 / 债券三个方向） */
export const CHECK_ASSETS = [
  { key: "etf:518880", label: "黄金ETF（人民币）" },
  { key: "index:us.INX", label: "标普500" },
  { key: "index:us.NDX", label: "纳斯达克100" },
  { key: "index:000300", label: "沪深300" },
  { key: "etf:511010", label: "国债ETF" },
];

export const CHECK_WINDOWS = [
  { days: 30, label: "近 1 月" },
  { days: 91, label: "近 3 月" },
  { days: 365, label: "近 1 年" },
];

/** 取最近 days 天的窗口 */
export function sliceLastDays(dates, prices, days) {
  if (!dates?.length) return { dates: [], prices: [] };
  const last = Date.parse(`${dates[dates.length - 1]}T00:00:00Z`);
  const cutoff = last - days * 86400000;
  let start = 0;
  for (let i = 0; i < dates.length; i += 1) {
    if (Date.parse(`${dates[i]}T00:00:00Z`) >= cutoff) {
      start = i;
      break;
    }
  }
  return { dates: dates.slice(start), prices: prices.slice(start) };
}

/** 带符号的百分比，用于文案 */
function signed(value) {
  if (!Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
}

/** 窗口收益与最大回撤 */
export function windowStats(dates, prices, days) {
  const win = sliceLastDays(dates, prices, days);
  if (win.prices.length < 2 || !(win.prices[0] > 0)) return null;

  const first = win.prices[0];
  const last = win.prices[win.prices.length - 1];
  let peak = first;
  let maxDrawdown = 0;
  for (const p of win.prices) {
    if (p > peak) peak = p;
    const dd = p / peak - 1;
    if (dd < maxDrawdown) maxDrawdown = dd;
  }
  return {
    days,
    points: win.prices.length,
    start: win.dates[0],
    end: win.dates[win.dates.length - 1],
    totalReturn: last / first - 1,
    maxDrawdown,
  };
}

/** 按日期交集对齐的相关系数（截断到最近 days 天） */
export function correlationOverDays(a, b, days) {
  const winA = days ? sliceLastDays(a.dates, a.prices, days) : { dates: a.dates, prices: a.prices };
  const winB = days ? sliceLastDays(b.dates, b.prices, days) : { dates: b.dates, prices: b.prices };
  const mapB = new Map();
  for (let i = 1; i < winB.dates.length; i += 1) {
    const prev = winB.prices[i - 1];
    if (prev > 0) mapB.set(winB.dates[i], winB.prices[i] / prev - 1);
  }
  const ra = [];
  const rb = [];
  for (let i = 1; i < winA.dates.length; i += 1) {
    const prev = winA.prices[i - 1];
    if (!(prev > 0)) continue;
    const value = mapB.get(winA.dates[i]);
    if (value === undefined) continue;
    ra.push(winA.prices[i] / prev - 1);
    rb.push(value);
  }
  const n = ra.length;
  if (n < 20) return null;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i += 1) {
    ma += ra[i];
    mb += rb[i];
  }
  ma /= n;
  mb /= n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i += 1) {
    const da = ra[i] - ma;
    const db = rb[i] - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  if (va === 0 || vb === 0) return null;
  return cov / Math.sqrt(va * vb);
}

/**
 * 生成对照数据与结论。
 * @param {{key: string, label: string, dates: string[], prices: number[]}[]} series
 */
export function buildCheck(series) {
  const rows = series.map((item) => ({
    label: item.label,
    windows: CHECK_WINDOWS.map((w) => ({
      ...w,
      stats: windowStats(item.dates, item.prices, w.days),
    })),
  }));

  const gold = series.find((s) => s.key === "etf:518880");
  const spx = series.find((s) => s.key === "index:us.INX");
  const bond = series.find((s) => s.key === "etf:511010");

  const goldStats = gold ? windowStats(gold.dates, gold.prices, 365) : null;
  const spxStats = spx ? windowStats(spx.dates, spx.prices, 365) : null;
  const bondStats = bond ? windowStats(bond.dates, bond.prices, 365) : null;
  const corr1y = gold && spx ? correlationOverDays(gold, spx, 365) : null;
  const corrAll = gold && spx ? correlationOverDays(gold, spx, 0) : null;

  const verdicts = [];
  if (goldStats && spxStats) {
    const goldWorse = goldStats.totalReturn < spxStats.totalReturn;
    const ddRatio = spxStats.maxDrawdown !== 0 ? goldStats.maxDrawdown / spxStats.maxDrawdown : null;

    verdicts.push(
      `近一年黄金 ${signed(goldStats.totalReturn)}、标普500 ${signed(
        spxStats.totalReturn
      )}：${goldWorse ? "黄金跌得更多" : "这次黄金确实赢了"}。`
    );

    if (ddRatio !== null && Math.abs(ddRatio) > 1.3) {
      verdicts.push(
        `同期最大回撤：黄金 ${signed(goldStats.maxDrawdown)}，标普500 ${signed(
          spxStats.maxDrawdown
        )}——黄金的回撤是它的 ${Math.abs(ddRatio).toFixed(1)} 倍。` +
          "「避险资产」这四个字，在这段时间里对它完全不成立。"
      );
    } else {
      verdicts.push(
        `同期最大回撤：黄金 ${signed(goldStats.maxDrawdown)}，标普500 ${signed(
          spxStats.maxDrawdown
        )}。`
      );
    }

    if (bondStats) {
      verdicts.push(
        `对照一下国债ETF：近一年 ${signed(bondStats.totalReturn)}、最大回撤 ${signed(
          bondStats.maxDrawdown
        )}，才是真正「跌的时候不怎么跌」的那类资产。`
      );
    }
  }

  if (corr1y !== null) {
    verdicts.push(
      `黄金与标普500 的日收益相关系数：近一年 ${corr1y.toFixed(2)}` +
        (corrAll !== null ? `，全历史 ${corrAll.toFixed(2)}` : "") +
        "。低相关只意味着「不同步」，不意味着「股票跌它就涨」——" +
        "它自己就是一个独立的波动来源。"
    );
  }

  verdicts.push(
    "黄金的对冲作用体现在长期（对抗货币贬值与极端通胀），而不是每一次股票下跌。" +
      "2008 与 2020 的流动性危机初期，黄金同样被抛售换现金；" +
      "把它当成「股票的对冲工具」是对它的误读。"
  );

  return { rows, goldStats, spxStats, bondStats, corr1y, corrAll, verdicts };
}