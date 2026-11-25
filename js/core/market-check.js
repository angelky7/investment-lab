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

/** 取最近 days 天的窗口；days <= 0 表示全区间 */
export function sliceLastDays(dates, prices, days) {
  if (!dates?.length) return { dates: [], prices: [] };
  if (!(days > 0)) return { dates: dates.slice(), prices: prices.slice() };
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

/* ----------------------- 防御性检验：低波 ≠ 避险 ----------------------- */

/**
 * 参与「是不是避险」对照的资产。
 * 沪深300 只作参照，不参与排序。
 */
export const DEFENSIVE_ASSETS = [
  // 用 2005-12 起的「全收益」指数：含分红、20 年历史。
  // 对应的 ETF（512890 / 515100）只有 2019 年起，做行为检验太短。
  { key: "index:H20269", label: "红利低波（全收益指数）" },
  { key: "index:H20955", label: "红利低波100（全收益指数）" },
  { key: "etf:512890", label: "红利低波ETF（2019 起）" },
  { key: "index:GOLDCNY", label: "黄金（人民币计价，合成）" },
  { key: "etf:511010", label: "国债ETF" },
];

/**
 * 下跌跟随度：在基准单日跌幅超过 threshold 的日子里，
 * 候选资产平均涨跌多少、有多大比例同向下跌。
 *
 * 这是区分「防御性」（跌得慢）与「避险」（不跌甚至上涨）的关键指标——
 * 只看年化波动率会把两者混为一谈。
 */
export function downsideFollow(candidate, bench, threshold = -0.01) {
  const benchReturns = new Map();
  for (let i = 1; i < bench.dates.length; i += 1) {
    const prev = bench.prices[i - 1];
    if (prev > 0) benchReturns.set(bench.dates[i], bench.prices[i] / prev - 1);
  }

  const samples = [];
  for (let i = 1; i < candidate.dates.length; i += 1) {
    const prev = candidate.prices[i - 1];
    if (!(prev > 0)) continue;
    const benchReturn = benchReturns.get(candidate.dates[i]);
    if (benchReturn === undefined || benchReturn > threshold) continue;
    samples.push(candidate.prices[i] / prev - 1);
  }
  if (samples.length < 20) return null;

  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  const down = samples.filter((r) => r < 0).length;
  return {
    days: samples.length,
    avgReturn: avg,
    downShare: down / samples.length,
    threshold,
  };
}

/**
 * 生成「防御性检验」的表格与结论。
 * @param {{key:string,label:string,dates:string[],prices:number[]}[]} series
 * @param {{key:string,label:string,dates:string[],prices:number[]}} bench 沪深300
 */
export function buildDefensiveCheck(series, bench) {
  const rows = [];
  const push = (label, item, isBench = false) => {
    const all = windowStats(item.dates, item.prices, 0) || {
      totalReturn: null,
      maxDrawdown: null,
    };
    const years = (Date.parse(item.dates[item.dates.length - 1]) - Date.parse(item.dates[0])) / (365.25 * 86400000);
    const annualized =
      all.totalReturn !== null && years > 0 ? Math.pow(1 + all.totalReturn, 1 / years) - 1 : null;

    // 年化波动（日收益标准差 × √252）
    const rets = [];
    for (let i = 1; i < item.prices.length; i += 1) {
      const prev = item.prices[i - 1];
      if (prev > 0) rets.push(item.prices[i] / prev - 1);
    }
    const mean = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
    const variance = rets.length > 1
      ? rets.reduce((acc, r) => acc + (r - mean) ** 2, 0) / (rets.length - 1)
      : 0;
    const volatility = Math.sqrt(variance) * Math.sqrt(252);

    rows.push({
      label,
      isBench,
      start: item.dates[0],
      annualized,
      volatility,
      maxDrawdown: all.maxDrawdown,
      correlation: isBench ? 1 : correlationOverDays(item, bench, 0),
      follow: isBench ? null : downsideFollow(item, bench),
    });
  };

  push(bench.label || "沪深300（参照）", bench, true);
  // 候选按「被检验的对象在前、参照物在后」的顺序排列，读表更顺
  const ordered = DEFENSIVE_ASSETS
    .map((item) => series.find((s) => s.key === item.key))
    .filter(Boolean);
  for (const item of ordered) push(item.label, item);

  const byLabel = new Map(rows.map((r) => [r.label, r]));
  const div = rows.find((r) => r.label.includes("红利低波") && !r.label.includes("100"));
  const div100 = rows.find((r) => r.label.includes("红利低波100"));
  const bond = byLabel.get("国债ETF");
  const gold = rows.find((r) => r.label.includes("黄金"));
  const benchRow = rows[0];

  const verdicts = [];
  if (div && benchRow) {
    const volRatio = benchRow.volatility > 0 ? div.volatility / benchRow.volatility : 1;
    const ddRatio20 =
      benchRow.maxDrawdown !== 0 ? div.maxDrawdown / benchRow.maxDrawdown : 1;

    // 20 年窗口里「低波」到底成不成立？差距不明显就必须说清楚，而不是复读标签
    if (volRatio < 0.85) {
      verdicts.push(
        `红利低波的长期波动 ${(div.volatility * 100).toFixed(1)}%，明显低于沪深300 的 ${(
          benchRow.volatility * 100
        ).toFixed(1)}%——在这段历史里它确实是「更稳的股票」。`
      );
    } else {
      verdicts.push(
        `把窗口拉到 ${div.start} 起的全历史，红利低波的波动是 ${(div.volatility * 100).toFixed(
          1
        )}%，沪深300 是 ${(benchRow.volatility * 100).toFixed(1)}%——**两者几乎一样**。` +
          `最大回撤 ${(div.maxDrawdown * 100).toFixed(1)}% 对 ${(benchRow.maxDrawdown * 100).toFixed(
            1
          )}%，也只是略浅。` +
          "也就是说：<strong>「低波」并不是这个策略在长周期里的固有属性</strong>。"
      );
    }

    if (ddRatio20 > 0.9 && volRatio >= 0.85) {
      verdicts.push(
        `那为什么很多人觉得它很稳？因为看的是近几年：红利低波ETF（2019 起）的波动只有 ${((
          byLabel.get("红利低波ETF（2019 起）")?.volatility ?? 0
        ) * 100).toFixed(1)}%。` +
          "同一个策略、不同的窗口，性格完全不同——这正是「用一段行情给资产下定义」的典型陷阱。"
      );
    }

    if (div.follow) {
      verdicts.push(
        `但在沪深300 单日跌超 1% 的 ${div.follow.days} 天里，红利低波平均 ${(
          div.follow.avgReturn * 100
        ).toFixed(2)}%，其中 ${(div.follow.downShare * 100).toFixed(0)}% 的日子同样下跌。` +
          "也就是说：<strong>它跌得慢一点，但照样跌</strong>——这是「防御性」，不是「避险」。"
      );
    }

    if (bond && bond.follow) {
      verdicts.push(
        `对照真正的避险资产（国债ETF）：同样的下跌日里它平均 ${(bond.follow.avgReturn * 100).toFixed(
          2
        )}%，只有 ${(bond.follow.downShare * 100).toFixed(0)}% 的日子同向下跌，` +
          `与沪深300 的相关系数 ${bond.correlation.toFixed(2)}。这才能叫「不跟着跌」。`
      );
    }

    verdicts.push(
      `判断标准可以收成一句话：<strong>相关系数接近 0 或为负、下跌日不跟跌 → 避险；` +
        `相关系数中高（红利低波 ${div.correlation.toFixed(2)}）、下跌日照跟 → 防御性权益。</strong>` +
        "红利低波属于后者：它优化的是「同样涨、跌得少」，而不是「不跌」。"
    );

    if (div.start > "2018-12-31") {
      verdicts.push(
        `注意它的历史只有 ${div.start} 起，且这几年正好是红利风格占优的阶段；` +
          "换成成长风格主导的年份，它可能跑输得很明显——风格轮动本身也是一种风险。"
      );
    }
    if (div100) {
      verdicts.push(
        `红利低波100 的表现与之接近（波动 ${(div100.volatility * 100).toFixed(1)}%、回撤 ${(
          div100.maxDrawdown * 100
        ).toFixed(1)}%、下跌日平均 ${((div100.follow?.avgReturn ?? 0) * 100).toFixed(2)}%），` +
          "两者是同一类策略的两个版本，差异主要在成分股数量与权重规则。"
      );
    }
    if (gold && gold.follow) {
      verdicts.push(
        `顺带对照黄金：同样下跌日里它平均 ${(gold.follow.avgReturn * 100).toFixed(2)}%、` +
          `${(gold.follow.downShare * 100).toFixed(0)}% 的日子同向下跌——` +
          "「跌得少」但绝不「不跌」，而且它自己还可能在别的时段独立大跌。"
      );
    }
  }

  return { rows, verdicts };
}
