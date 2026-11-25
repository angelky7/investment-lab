/**
 * js/pages/portfolio.js — 组合分析页。
 *
 * 四个子模块共用一套取数逻辑，但假设条件各不相同，页面里都写清楚了。
 * 所有计算来自 js/core/portfolio.js，本文件只做取数、排版和把结论翻译成人话。
 */

import { initShell, showError, loadingHtml } from "../core/shell.js";
import {
  findAsset,
  loadIndex,
  loadMeta,
  loadPeriods,
  loadSeries,
  loadSeriesMany,
  benchmarkFor,
} from "../core/store.js";
import { alignByDate, sliceLastYears } from "../core/series.js";
import {
  bandRebalance,
  correlationMatrix,
  dcaBacktest,
  estimateBeta,
  lumpSumBacktest,
  rebalanceSimulation,
  stressTest,
} from "../core/portfolio.js";
import { annualizedVolatility, maxDrawdown, sharpeRatio } from "../core/stats.js";
import { STRATEGIES, findStrategy } from "../core/strategies.js";
import { lineChart } from "../core/charts.js";
import {
  assetSelect,
  checklist,
  rangeTabs,
  weightRows,
  yearsOf,
} from "../ui/picker.js";
import { metricsHtml, notice, tableHtml } from "../ui/cards.js";
import {
  count,
  dateLabel,
  money,
  num,
  pct,
  rangeLabel,
  tone,
} from "../core/format.js";

const BENCHMARK_KEY = "index:000300";

const state = {
  assets: [],
  meta: null,
  periods: null,
  mode: "corr",
  range: "5",
  compareRange: "5",
  corrKeys: ["index:000300", "index:000905", "etf:511010", "etf:518880"],
  dcaKey: "index:000300",
  dcaMonthly: 1000,
  dcaRange: "5",
  stressKeys: ["index:000300", "etf:511010", "etf:518880"],
  stressWeights: null,
  rebalanceKeys: ["index:000300", "etf:511010", "etf:518880"],
  rebalanceWeights: [50, 30, 20],
  rebalanceInterval: 63,
  strategyId: "permanent",
};

const tokens = { corr: 0, dca: 0, stress: 0, rebalance: 0, strategy: 0 };

const benchCache = new Map();

/** 按基准键加载序列，结果缓存（压力测试里会用到三个市场的基准） */
function benchmark(assets, key = BENCHMARK_KEY) {
  if (!benchCache.has(key)) {
    const asset = findAsset(assets, key);
    benchCache.set(key, asset ? loadSeries(asset).catch(() => null) : Promise.resolve(null));
  }
  return benchCache.get(key);
}

function assetName(assets, key) {
  const asset = findAsset(assets, key);
  return asset ? asset.name : key;
}

/**
 * 等权分配，并把 100 的余数补给前几项，保证合计恰好 100（避免 33+33+33=99 的尴尬）。
 */
function evenWeights(count) {
  if (count <= 0) return [];
  const base = Math.floor(100 / count);
  const remainder = 100 - base * count;
  return Array.from({ length: count }, (_, i) => base + (i < remainder ? 1 : 0));
}

function normalizeWeights(weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  if (!total) return weights.map(() => 1 / Math.max(1, weights.length));
  return weights.map((w) => w / total);
}

/* ------------------------------- 相关性 -------------------------------- */

function heatmapHtml(keys, names, matrix) {
  const upVar = "var(--il-up-rgb)";
  const coolVar = "var(--il-cool-rgb)";
  // 列数交给 CSS 变量：窄屏时单元格会自动变小，而不是把卡片撑宽
  let html = `<div class="heatmap" style="--hm-cols:${keys.length}">`;
  html += `<div class="hm-head"></div>`;
  keys.forEach((key, j) => {
    html += `<div class="hm-head">${names[j]}</div>`;
  });
  matrix.forEach((row, i) => {
    html += `<div class="hm-head row-head">${names[i]}</div>`;
    row.forEach((value, j) => {
      if (i === j) {
        html += `<div class="hm-cell" style="background:rgb(var(--mdui-color-surface-container-high));opacity:.6">1</div>`;
        return;
      }
      const intensity = Math.min(1, Math.abs(value));
      const alpha = (0.08 + intensity * 0.72).toFixed(2);
      const rgb = value >= 0 ? upVar : coolVar;
      html += `<div class="hm-cell" title="${names[i]} × ${names[j]} = ${value.toFixed(3)}"
        style="background:rgba(${rgb}, ${alpha})">
        ${value.toFixed(2)}</div>`;
    });
  });
  html += `</div>`;
  return html;
}

async function renderCorrelation() {
  const token = ++tokens.corr;
  const host = document.getElementById("corr-result");
  if (state.mode !== "corr") return;

  const keys = state.corrKeys;
  if (keys.length < 2) {
    host.innerHTML = notice("请至少选择 2 项资产。", "warn");
    return;
  }

  host.innerHTML = loadingHtml("正在对齐日期并计算相关系数…");
  const assetsSel = keys.map((k) => findAsset(state.assets, k)).filter(Boolean);

  try {
    const seriesList = await loadSeriesMany(assetsSel);
    if (token !== tokens.corr) return;
    if (seriesList.length < 2) {
      host.innerHTML = notice("数据加载失败，请换一组资产试试。", "warn");
      return;
    }

    const years = yearsOf(state.compareRange);
    const entries = seriesList.map((s) => {
      const win = sliceLastYears(s.dates, s.prices, years);
      return { key: s.key, name: s.name, dates: win.dates, prices: win.prices };
    });

    const aligned = alignByDate(entries);
    if (aligned.dates.length < 30) {
      host.innerHTML = notice(
        `所选资产共同交易日只有 ${aligned.dates.length} 个，无法计算相关性。请缩短区间或更换资产。`,
        "warn"
      );
      return;
    }

    const { keys: matrixKeys, matrix } = correlationMatrix(aligned.dates, aligned.values);
    if (!matrix.length) {
      host.innerHTML = notice("数据不足，无法计算相关性。", "warn");
      return;
    }

    const nameMap = Object.fromEntries(entries.map((e) => [e.key, e.name]));
    const names = matrixKeys.map((k) => nameMap[k] || k);

    // 平均相关性（对角线以外）
    let sum = 0;
    let n = 0;
    for (let i = 0; i < matrix.length; i += 1) {
      for (let j = i + 1; j < matrix.length; j += 1) {
        sum += matrix[i][j];
        n += 1;
      }
    }
    const avg = n ? sum / n : null;

    const lowest = [];
    for (let i = 0; i < matrix.length; i += 1) {
      for (let j = i + 1; j < matrix.length; j += 1) {
        lowest.push({ i, j, value: matrix[i][j] });
      }
    }
    lowest.sort((a, b) => a.value - b.value);

    host.innerHTML = `
      <div class="card">
        <div class="chart-head">
          <h3>相关系数矩阵</h3>
          <span class="hint">共同交易日 ${count(aligned.dates.length)} 个 · ${rangeLabel(
            aligned.dates[0],
            aligned.dates[aligned.dates.length - 1]
          )}</span>
        </div>
        <div class="hscroll">${heatmapHtml(matrixKeys, names, matrix)}</div>
        <p class="caption">颜色越深表示相关性绝对值越大。红色为正相关（同涨同跌），蓝色为负相关（走势相反）。</p>
      </div>

      <div class="card">
        <h2 class="section-title">结论</h2>
        ${metricsHtml([
          {
            label: "平均相关性",
            value: num(avg),
            sub: avg !== null && avg > 0.8 ? "组合分散效果有限" : "存在分散空间",
          },
          {
            label: "最低相关性组合",
            value: num(lowest[0]?.value),
            sub:
              lowest[0] !== undefined
                ? `${names[lowest[0].i]} × ${names[lowest[0].j]}`
                : "—",
          },
          {
            label: "最高相关性组合",
            value: num(lowest[lowest.length - 1]?.value),
            sub:
              lowest.length > 1
                ? `${names[lowest[lowest.length - 1].i]} × ${names[lowest[lowest.length - 1].j]}`
                : "—",
          },
          { label: "资产数量", value: `${matrixKeys.length} 项`, sub: "相关性系数个数 n(n−1)/2" },
        ])}
        <p class="section-desc" style="margin-top:0.9rem">
          ${correlationAdvice(avg, lowest, names)}
        </p>
      </div>

      <div class="card">
        <h2 class="section-title">矩阵明细</h2>
        ${tableHtml({
          columns: [{ label: "资产", align: "left" }, ...names.map((n) => ({ label: n }))],
          rows: matrix.map((row, i) => ({
            cells: [
              { html: `<strong>${names[i]}</strong>` },
              ...row.map((v) => ({ html: v.toFixed(2), cls: v >= 0.7 ? "pos" : v <= -0.3 ? "neg" : "" })),
            ],
          })),
          caption: "对角线恒为 1。相关性高于 0.7 的资产放在一起，几乎等于重复持有一个东西。",
        })}
      </div>`;
  } catch (err) {
    if (token !== tokens.corr) return;
    showError(host, err.message);
  }
}

function correlationAdvice(avg, lowest, names) {
  if (avg === null) return "";
  if (avg > 0.8) {
    return `这组资产的平均相关性是 ${avg.toFixed(2)}，几乎同涨同跌。把它们放在一起并不会降低风险，
      只是把同一个风险复制了几份。想真正分散，需要引入走势逻辑不同的资产类别（例如债券、黄金、海外市场）。`;
  }
  if (avg > 0.5) {
    return `平均相关性 ${avg.toFixed(2)}，说明有分散效果但不强。注意：相关性会随市场环境变化，
      在极端下跌时往往会一起升高——即所谓「相关性在危机中趋同」。`;
  }
  return `平均相关性 ${avg.toFixed(2)}，分散效果比较明显。
    不过历史相关性不代表未来相关性，配置时更应该问「这两类资产的涨跌逻辑是否来自同一个原因」。`;
}

/* --------------------------------- 定投 --------------------------------- */

async function renderDca() {
  const token = ++tokens.dca;
  const host = document.getElementById("dca-result");
  if (state.mode !== "dca") return;

  const asset = findAsset(state.assets, state.dcaKey);
  if (!asset) return;

  host.innerHTML = loadingHtml("正在模拟每月定投…");

  try {
    const [series, bench] = await Promise.all([loadSeries(asset), benchmark(state.assets)]);
    if (token !== tokens.dca) return;

    const years = yearsOf(state.dcaRange);
    const win = sliceLastYears(series.dates, series.prices, years);
    if (win.prices.length < 30) {
      host.innerHTML = notice("所选区间内数据太少，无法模拟定投。", "warn");
      return;
    }

    const dca = dcaBacktest(win.dates, win.prices, { monthly: state.dcaMonthly });
    const lump = lumpSumBacktest(win.dates, win.prices, { monthly: state.dcaMonthly });
    if (!dca || !lump) {
      host.innerHTML = notice("无法完成回测，请检查参数。", "warn");
      return;
    }

    const winner = dca.finalValue >= lump.finalValue ? "定投" : "一次性投入";
    const diff = Math.abs(dca.finalValue - lump.finalValue);

    host.innerHTML = `
      <div class="card">
        <div class="chart-head">
          <h3>${asset.name} · 每月 ${money(state.dcaMonthly)}</h3>
          <span class="hint">${rangeLabel(dca.startDate, dca.endDate)} · 共 ${dca.tradeCount} 次买入</span>
        </div>
        ${metricsHtml([
          {
            label: "定投终值",
            value: money(dca.finalValue),
            sub: `累计投入 ${money(dca.invested)}`,
          },
          {
            label: "定投总收益",
            value: pct(dca.totalReturn),
            tone: tone(dca.totalReturn),
            sub: `盈亏 ${money(dca.profit)}`,
          },
          {
            label: "XIRR（资金加权年化）",
            value: pct(dca.xirr),
            tone: tone(dca.xirr),
            sub: "分期投入的正确年化口径",
          },
          {
            label: "同期一次性投入",
            value: pct(lump.totalReturn),
            tone: tone(lump.totalReturn),
            sub: `终值 ${money(lump.finalValue)}`,
          },
          {
            label: "谁更划算",
            value: winner,
            sub: `相差 ${money(diff)}`,
          },
          {
            label: "持有年数",
            value: `${dca.years.toFixed(1)} 年`,
            sub: `定投年化 ${pct(dca.annualizedReturn)}`,
          },
        ])}
      </div>

      <div class="card">
        <div class="chart-head">
          <h3>投入 vs 市值</h3>
          <span class="hint">两线之间的垂直距离就是浮盈或浮亏</span>
        </div>
        <div class="chart" id="chart-dca"></div>
      </div>

      <div class="card">
        <h2 class="section-title">这说明什么</h2>
        <p class="section-desc">
          这段历史里，<strong>${winner}</strong> 的最终价值更高，两者相差 ${money(diff)}。
          ${dcaAdvice(winner, dca, lump)}
        </p>
        ${tableHtml({
          columns: [{ label: "对比项", align: "left" }, { label: "定投" }, { label: "一次性投入" }],
          rows: [
            {
              cells: [
                { html: "投入本金" },
                { html: money(dca.invested) },
                { html: money(lump.amount) },
              ],
            },
            {
              cells: [
                { html: "期末市值" },
                { html: money(dca.finalValue) },
                { html: money(lump.finalValue) },
              ],
            },
            {
              cells: [
                { html: "总收益率" },
                { html: pct(dca.totalReturn), cls: tone(dca.totalReturn) },
                { html: pct(lump.totalReturn), cls: tone(lump.totalReturn) },
              ],
            },
            {
              cells: [
                { html: "年化（资金加权 / 简单）" },
                { html: pct(dca.xirr) },
                { html: pct(lump.totalReturn === null ? null : Math.pow(1 + lump.totalReturn, 1 / (lump.years || 1)) - 1) },
              ],
            },
          ],
          caption: "定投的年化用 XIRR，一次性投入用简单年化；这样两者才可比。",
        })}
      </div>`;

    const labelFormatter = years <= 3 ? (d) => d.slice(2, 7) : (d) => d.slice(0, 4);
    lineChart(document.getElementById("chart-dca"), {
      labels: win.dates,
      series: [
        {
          name: "累计投入",
          values: dca.investedSeries,
          color: "var(--il-chart-3)",
          fill: false,
          width: 1.5,
        },
        {
          name: "持仓市值",
          values: dca.valueSeries,
          color: "var(--il-chart-1)",
        },
      ],
      formatter: (v) => `¥${Math.round(v / 1000)}k`,
      tipFormatter: (v) => money(v),
      labelFormatter,
      tipDateFormatter: dateLabel,
    });
  } catch (err) {
    if (token !== tokens.dca) return;
    showError(host, err.message);
  }
}

function dcaAdvice(winner, dca, lump) {
  if (winner === "定投") {
    return `在这段区间里，资产整体是波动或下跌的，分期买入摊低了成本。
      但要注意：定投真正的作用是降低「买在高点」的择时风险，而不是提高收益的上限。
      如果这段区间是单边上涨，结论会完全反过来。`;
  }
  return `在这段区间里，资产整体是上涨的，越早把钱投进去越占便宜。
      这正说明定投的代价：在一路上涨的市场里，它会持续把钱投在更高的价格上。
      所以「定投还是梭哈」没有普适答案，取决于你能承受多大的择时不确定性。`;
}

/* ------------------------------- 压力测试 ------------------------------- */

async function renderStress() {
  const token = ++tokens.stress;
  const host = document.getElementById("stress-result");
  if (state.mode !== "stress") return;

  const keys = state.stressKeys;
  if (keys.length < 1) {
    host.innerHTML = notice("请至少选择 1 项资产。", "warn");
    return;
  }

  host.innerHTML = loadingHtml("正在按历史区间计算真实跌幅…");

  try {
    const [seriesList, bench, periods] = await Promise.all([
      loadSeriesMany(keys.map((k) => findAsset(state.assets, k)).filter(Boolean)),
      benchmark(state.assets),
      state.periods ? Promise.resolve(state.periods) : loadPeriods(),
    ]);
    if (token !== tokens.stress) return;

    const scenarios = periods.stress_scenarios || [];
    if (!scenarios.length) {
      host.innerHTML = notice("缺少压力测试情景配置。", "warn");
      return;
    }

    const named = seriesList.map((s) => ({
      key: s.key,
      name: s.name,
      dates: s.dates,
      prices: s.prices,
    }));

    const weights = {};
    const raw = state.stressWeights || named.map(() => 100 / named.length);
    const normalized = normalizeWeights(raw.slice(0, named.length));
    named.forEach((s, i) => {
      weights[s.key] = normalized[i] ?? 0;
    });

    // Beta 按各资产所属市场各自的基准估算：美股用标普500、港股用恒生，
    // 否则「美股个股相对 A 股」的回归系数没有解释力。
    const betas = {};
    const benchCache = new Map();
    for (const item of named) {
      const assetRef = findAsset(state.assets, item.key);
      const info = benchmarkFor(assetRef || {});
      if (!benchCache.has(info.key)) {
        benchCache.set(info.key, await benchmark(state.assets, info.key));
      }
      const marketBench = await benchCache.get(info.key);
      if (marketBench) {
        betas[item.key] = estimateBeta(
          item.dates,
          item.prices,
          marketBench.dates,
          marketBench.prices
        );
      }
    }

    const rows = stressTest(named, scenarios, {
      benchmarkKey: bench?.key || "",
      weights,
      betas,
    });

    host.innerHTML = `
      <div class="card">
        <h2 class="section-title">当前组合</h2>
        <div id="stress-summary"></div>
      </div>
      ${rows
        .map(
          (row) => `
        <div class="scenario">
          <div class="scenario-head">
            <span class="scenario-name">${row.name}</span>
            <span class="scenario-window">${row.start} ~ ${row.end}</span>
          </div>
          <p class="scenario-desc">${row.description}</p>
          <div class="scenario-bars">
            ${scenarioBars(row, named, weights)}
          </div>
        </div>`
        )
        .join("")}
      <div class="card">
        <h2 class="section-title">怎么用这张表</h2>
        <p class="section-desc">
          不要只看最坏的那个数字，要看「你能不能拿得住」。如果一次 40% 的回撤会让你的组合市值腰斩，
          说明当前的仓位或资产结构超出了你的承受能力——这个问题应该在没有亏钱的时候解决。
          表中「估算」表示该资产在那一时期还没有数据，用它对沪深300 的 Beta 折算得出，仅供参考。
        </p>
      </div>`;

    const summaryHost = document.getElementById("stress-summary");
    if (summaryHost) {
      summaryHost.innerHTML = metricsHtml([
        { label: "参与资产", value: `${named.length} 项`, sub: named.map((s) => s.name).join("、") },
        {
          label: "最坏情景",
          value: pct(worstPortfolio(rows)),
          tone: "neg",
          sub: worstScenarioName(rows),
        },
        {
          label: "平均情景跌幅",
          value: pct(avgPortfolio(rows)),
          tone: "neg",
          sub: `${rows.length} 个历史危机窗口`,
        },
        {
          label: "数据覆盖",
          value: `${rows.reduce((a, r) => a + r.coverage, 0)}/${rows.length * named.length}`,
          sub: "真实历史数据 / 全部资产×情景",
        },
      ]);
    }
  } catch (err) {
    if (token !== tokens.stress) return;
    showError(host, err.message);
  }
}

function worstPortfolio(rows) {
  const values = rows.map((r) => r.portfolioReturn).filter((v) => Number.isFinite(v));
  return values.length ? Math.min(...values) : null;
}

function worstScenarioName(rows) {
  let worst = null;
  for (const row of rows) {
    if (!Number.isFinite(row.portfolioReturn)) continue;
    if (!worst || row.portfolioReturn < worst.portfolioReturn) worst = row;
  }
  return worst ? worst.name : "—";
}

function avgPortfolio(rows) {
  const values = rows.map((r) => r.portfolioReturn).filter((v) => Number.isFinite(v));
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function scenarioBars(row, named, weights) {
  const items = [];
  items.push({
    name: "基准 沪深300",
    value: row.benchmarkReturn,
    strong: false,
  });
  for (const asset of named) {
    const found = row.assets.find((a) => a.key === asset.key);
    items.push({
      name: `${asset.name}${Math.round((weights[asset.key] || 0) * 100)}%`,
      value: found?.return ?? null,
      estimated: found?.estimated,
      strong: false,
    });
  }
  items.push({ name: "组合", value: row.portfolioReturn, strong: true });

  const maxAbs = Math.max(...items.map((i) => Math.abs(i.value || 0)), 0.01);

  return items
    .map((item) => {
      if (!Number.isFinite(item.value)) {
        return `<div class="scenario-bar"><span>${item.name}</span><div class="bar-track"></div><span class="muted">无数据</span></div>`;
      }
      const width = Math.max(2, (Math.abs(item.value) / maxAbs) * 100);
      const color = item.value >= 0 ? "var(--il-up)" : "var(--il-down)";
      return `<div class="scenario-bar">
        <span>${item.name}${item.estimated ? "（估算）" : ""}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${width}%;background:${color};opacity:${
          item.strong ? 1 : 0.55
        }"></div></div>
        <span class="${tone(item.value)}" style="font-weight:${item.strong ? 700 : 400}">${pct(item.value)}</span>
      </div>`;
    })
    .join("");
}

/* -------------------------------- 再平衡 -------------------------------- */

async function renderRebalance() {
  const token = ++tokens.rebalance;
  const host = document.getElementById("rebalance-result");
  if (state.mode !== "rebalance") return;

  const keys = state.rebalanceKeys;
  if (keys.length < 2) {
    host.innerHTML = notice("再平衡至少需要 2 项资产。", "warn");
    return;
  }

  host.innerHTML = loadingHtml("正在模拟再平衡…");

  try {
    const seriesList = await loadSeriesMany(keys.map((k) => findAsset(state.assets, k)).filter(Boolean));
    if (token !== tokens.rebalance) return;
    if (seriesList.length < 2) {
      host.innerHTML = notice("数据加载失败。", "warn");
      return;
    }

    const years = yearsOf(state.range);
    const entries = seriesList.map((s) => {
      const win = sliceLastYears(s.dates, s.prices, years);
      return { key: s.key, name: s.name, dates: win.dates, prices: win.prices };
    });
    const aligned = alignByDate(entries);
    if (aligned.dates.length < 30) {
      host.innerHTML = notice("共同交易日太少，无法模拟再平衡。", "warn");
      return;
    }

    const names = entries.map((e) => e.name);
    const weights = normalizeWeights(
      (state.rebalanceWeights || entries.map(() => 100 / entries.length)).slice(0, entries.length)
    );

    const result = rebalanceSimulation(
      aligned.dates,
      aligned.values,
      weights,
      { everyDays: state.rebalanceInterval, initial: 100000 }
    );
    if (!result) {
      host.innerHTML = notice("权重之和不等于 100%，或数据不完整。", "warn");
      return;
    }

    const diff = result.finalValue - result.driftFinal;

    host.innerHTML = `
      <div class="card">
        <div class="chart-head">
          <h3>再平衡组合</h3>
          <span class="hint">${rangeLabel(aligned.dates[0], aligned.dates[aligned.dates.length - 1])} · 共 ${result.rebalances} 次再平衡</span>
        </div>
        ${metricsHtml([
          { label: "初始投入", value: money(result.initial), sub: "模拟本金" },
          {
            label: "再平衡终值",
            value: money(result.finalValue),
            sub: `年化 ${pct(result.annualizedReturn)}`,
          },
          {
            label: "一直不动终值",
            value: money(result.driftFinal),
            sub: `年化 ${pct(result.driftAnnualized)}`,
          },
          {
            label: "差异",
            value: `${diff >= 0 ? "+" : "−"}${money(Math.abs(diff))}`,
            tone: tone(diff),
            sub: diff >= 0 ? "再平衡更好" : "不动作更好",
          },
          {
            label: "持有年数",
            value: `${result.years.toFixed(1)} 年`,
            sub: `每 ${result.everyDays} 个交易日调整一次`,
          },
          {
            label: "调整次数",
            value: `${result.rebalances} 次`,
            sub: "每次都是「卖强买弱」",
          },
        ])}
        <p class="section-desc" style="margin-top:0.9rem">
          ${rebalanceAdvice(diff, result, names, weights)}
        </p>
      </div>

      <div class="card">
        <div class="chart-head">
          <h3>净值曲线对比</h3>
          <span class="hint">同样本金、同样资产，唯一区别是有没有定期调回目标权重</span>
        </div>
        <div class="chart" id="chart-rebalance"></div>
      </div>

      <div class="card">
        <h2 class="section-title">目标权重</h2>
        ${tableHtml({
          columns: [{ label: "资产", align: "left" }, { label: "目标权重" }, { label: "定位" }],
          rows: names.map((name, i) => ({
            cells: [
              { html: `<strong>${name}</strong>` },
              { html: pct(weights[i], { signed: false }) },
              { html: WEIGHT_ROLE(weights[i]) },
            ],
          })),
          caption: "再平衡的收益来自波动本身：高波动、低相关的资产越多，再平衡越有机会「低买高卖」。",
        })}
      </div>`;

    lineChart(document.getElementById("chart-rebalance"), {
      labels: aligned.dates,
      series: [
        {
          name: "定期再平衡",
          values: result.valueSeries,
          color: "var(--il-chart-1)",
        },
        {
          name: "买入后不动",
          values: result.noRebalanceSeries,
          color: "var(--il-chart-3)",
          fill: false,
          width: 1.5,
        },
      ],
      formatter: (v) => `¥${Math.round(v / 10000)}万`,
      tipFormatter: (v) => money(v),
      labelFormatter: years <= 3 ? (d) => d.slice(2, 7) : (d) => d.slice(0, 4),
      tipDateFormatter: dateLabel,
    });
  } catch (err) {
    if (token !== tokens.rebalance) return;
    showError(host, err.message);
  }
}

function WEIGHT_ROLE(weight) {
  if (weight >= 0.5) return "核心仓";
  if (weight >= 0.2) return "卫星仓";
  return "分散/对冲";
}

function rebalanceAdvice(diff, result, names, weights) {
  const base = `在 ${result.years.toFixed(1)} 年、每 ${result.everyDays} 个交易日调整一次的假设下，
    再平衡组合的终值比买入后不动 ${diff >= 0 ? "高" : "低"} ${money(Math.abs(diff))}。`;
  const tail =
    diff >= 0
      ? `资产之间波动越大、相关性越低，再平衡越容易产生额外收益，同时它把组合的风险水平维持在设定值，
         避免某类资产上涨后悄悄占满整个组合。`
      : `这次再平衡跑输了「买入后不动」，这很正常：在单边上涨的行情里，少调整反而让最强的资产继续跑。
         再平衡的价值主要不是多赚钱，而是把风险控制在你能承受的水平。`;
  return `${base}${tail}`;
}

/* -------------------------------- 策略组合 ------------------------------- */

const RULE_TEXT = {
  band: (s) => `阈值带：任一档低于 ${Math.round(s.rule.lower * 100)}% 或高于 ${Math.round(s.rule.upper * 100)}% 时调回目标`,
  annual: () => "每年（252 个交易日）调回目标权重",
  none: () => "不调仓",
};

function normalizeTo(prices, initial) {
  const base = prices[0];
  return prices.map((p) => (base > 0 ? (p / base) * initial : 0));
}

async function renderStrategy() {
  const token = ++tokens.strategy;
  const host = document.getElementById("strategy-result");
  const intro = document.getElementById("strategy-intro");
  const ruleHost = document.getElementById("strategy-rule");
  if (state.mode !== "strategy") return;

  const strategy = findStrategy(state.strategyId);
  ruleHost.textContent = (RULE_TEXT[strategy.rule.type] || (() => "—"))(strategy);

  intro.innerHTML = `
    <p class="section-desc" style="margin:0 0 .5rem"><strong>${strategy.tagline}</strong></p>
    <p class="section-desc" style="margin:0">${strategy.description}</p>`;

  host.innerHTML = loadingHtml("正在对齐各档交易日并对策略回测…");

  try {
    const sleeveAssets = strategy.sleeves
      .map((sleeve) => ({ ...sleeve, asset: findAsset(state.assets, sleeve.key) }))
      .filter((s) => s.asset);

    if (sleeveAssets.length !== strategy.sleeves.length) {
      host.innerHTML = notice("策略里有资产不在数据索引中，请检查登记表。", "warn");
      return;
    }

    // 对照组：100% 沪深300ETF
    const stockAsset = findAsset(state.assets, "etf:510300");
    const all = sleeveAssets.map((s) => s.asset);
    if (stockAsset && !all.some((a) => a.type === stockAsset.type && a.symbol === stockAsset.symbol)) {
      all.push(stockAsset);
    }

    const seriesList = await loadSeriesMany(all);
    if (token !== tokens.strategy) return;

    const byKey = new Map(seriesList.map((s) => [s.key, s]));
    const sleeves = sleeveAssets.map((s) => ({ ...s, series: byKey.get(s.key) }));
    const stock = stockAsset ? byKey.get(`${stockAsset.type}:${stockAsset.symbol}`) : null;

    if (sleeves.some((s) => !s.series) || !stock) {
      host.innerHTML = notice("所选策略的部分资产数据加载失败。", "warn");
      return;
    }

    const entries = sleeves.map((s) => ({
      key: s.key,
      dates: s.series.dates,
      prices: s.series.prices,
    }));
    entries.push({ key: "stock", dates: stock.dates, prices: stock.prices });

    const aligned = alignByDate(entries);
    if (aligned.dates.length < 250) {
      host.innerHTML = notice(
        `四档资产共同的交易日只有 ${aligned.dates.length} 天，不足以回测。请稍后再试或更换策略。`,
        "warn"
      );
      return;
    }

    const initial = 10000;
    const weights = strategy.sleeves.map((s) => s.weight / 100);
    const values = {};
    strategy.sleeves.forEach((s) => {
      values[s.key] = aligned.values[s.key];
    });

    let result;
    if (strategy.rule.type === "band") {
      result = bandRebalance(aligned.dates, values, weights, {
        lower: strategy.rule.lower,
        upper: strategy.rule.upper,
        initial,
      });
    } else if (strategy.rule.type === "annual") {
      const sim = rebalanceSimulation(aligned.dates, values, weights, {
        everyDays: 252,
        initial,
      });
      result = sim
        ? { ...sim, rebalances: sim.rebalances, driftSeries: sim.noRebalanceSeries, driftFinal: sim.driftFinal, sleeveFinal: {} }
        : null;
    } else {
      // 不调仓，单档满仓
      const series = aligned.values[strategy.sleeves[0].key];
      result = {
        valueSeries: normalizeTo(series, initial),
        driftSeries: normalizeTo(series, initial),
        rebalances: 0,
        finalValue: 0,
        driftFinal: 0,
        sleeveFinal: {},
        sleeveFinalWeight: [100],
      };
      result.finalValue = result.valueSeries[result.valueSeries.length - 1];
      result.driftFinal = result.finalValue;
    }

    if (!result) {
      host.innerHTML = notice("回测失败，请检查策略权重配置。", "warn");
      return;
    }

    const dates = aligned.dates;
    const stockSeries = normalizeTo(aligned.values.stock, initial);
    const stats = (series) => {
      const total = series[series.length - 1] / initial - 1;
      const years = (Date.parse(`${dates[dates.length - 1]}T00:00:00Z`) - Date.parse(`${dates[0]}T00:00:00Z`)) / (365.25 * 86400000);
      return {
        annualized: years > 0 ? Math.pow(1 + total, 1 / years) - 1 : null,
        volatility: annualizedVolatility(series, dates),
        sharpe: sharpeRatio(series, 0.025, dates),
        maxDrawdown: maxDrawdown(series, dates)?.value ?? null,
        total,
      };
    };

    const mine = stats(result.valueSeries);
    const stocks = stats(stockSeries);

    const sleeveRows = strategy.sleeves.map((sleeve, i) => {
      const series = byKey.get(sleeve.key);
      const finalValue = result.sleeveFinal?.[sleeve.key];
      const finalWeight = result.sleeveFinalWeight?.[i];
      return {
        name: sleeve.label,
        weight: sleeve.weight,
        role: sleeve.role,
        since: series ? series.dates[0] : "—",
        finalValue,
        finalWeight,
      };
    });

    host.innerHTML = `
      <div class="card">
        <div class="chart-head">
          <h3>${strategy.name} · 净值曲线</h3>
          <span class="hint">${rangeLabel(dates[0], dates[dates.length - 1])} · ${aligned.dates.length} 个共同交易日</span>
        </div>
        ${metricsHtml([
          {
            label: "年化收益",
            value: pct(mine.annualized),
            tone: tone(mine.annualized),
            sub: `区间累计 ${pct(mine.total)}`,
          },
          {
            label: "年化波动",
            value: pct(mine.volatility, { signed: false }),
            sub: `同区间 100% 股票 ${pct(stocks.volatility, { signed: false })}`,
          },
          {
            label: "最大回撤",
            value: pct(mine.maxDrawdown),
            tone: "neg",
            sub: `同区间 100% 股票 ${pct(stocks.maxDrawdown)}`,
          },
          {
            label: "夏普比率",
            value: num(mine.sharpe),
            sub: `同区间 100% 股票 ${num(stocks.sharpe)}`,
          },
          {
            label: "再平衡次数",
            value: strategy.rule.type === "none" ? "0 次" : `${result.rebalances} 次`,
            sub: RULE_TEXT[strategy.rule.type]?.(strategy) || "",
          },
          {
            label: "期末市值",
            value: money(result.finalValue),
            sub: `初始投入 ${money(initial)}`,
          },
        ])}
        <p class="section-desc" style="margin-top:0.9rem">
          ${strategyConclusion(strategy, mine, stocks)}
        </p>
        <div class="chart" id="chart-strategy"></div>
      </div>

      <div class="card">
        <h2 class="section-title">四档配置</h2>
        ${tableHtml({
          columns: [
            { label: "资产", align: "left" },
            { label: "目标权重" },
            { label: "作用" },
            { label: "期末权重" },
            { label: "数据起点" },
          ],
          rows: sleeveRows.map((row) => ({
            cells: [
              { html: `<strong>${row.name}</strong>` },
              { html: pct(row.weight / 100, { signed: false }) },
              { html: row.role, cls: "small muted" },
              {
                html: Number.isFinite(row.finalWeight) ? pct(row.finalWeight / 100, { signed: false }) : "—",
                cls: Number.isFinite(row.finalWeight) && Math.abs(row.finalWeight - row.weight) > 10 ? "pos" : "",
              },
              { html: row.since, cls: "small" },
            ],
          })),
          caption:
            "目标权重是纪律，期末权重是市场投票的结果。期末与目标偏离越多，" +
            "说明这段时间里某类资产的偏离越剧烈——正是再平衡要处理的情况。",
        })}
      </div>

      <div class="card">
        <h2 class="section-title">这套方法的代价</h2>
        <ul class="section-desc" style="margin:0;padding-left:1.1rem;line-height:1.9">
          ${strategy.notes.map((n) => `<li>${n}</li>`).join("")}
          <li>回测忽略交易成本与税费；阈值带再平衡会比年度再平衡更频繁，摩擦成本略高。</li>
          <li>策略的收益完全取决于所选资产的历史，未来四种经济状态的相对表现可能完全不同。</li>
        </ul>
      </div>`;

    const colors = ["var(--il-chart-1)", "var(--il-chart-3)"];
    lineChart(document.getElementById("chart-strategy"), {
      labels: dates,
      series: [
        { name: strategy.name, values: result.valueSeries, color: colors[0] },
        { name: "100% 股票", values: stockSeries, color: colors[1], fill: false, width: 1.5 },
      ],
      formatter: (v) => `¥${Math.round(v / 10000)}万`,
      tipFormatter: (v) => money(v),
      labelFormatter: (d) => d.slice(0, 4),
      tipDateFormatter: dateLabel,
      tall: true,
    });
  } catch (err) {
    if (token !== tokens.strategy) return;
    showError(host, err.message);
  }
}

function strategyConclusion(strategy, mine, stocks) {
  if (strategy.rule.type === "none") {
    return `这是标尺：${pct(mine.annualized)} 的年化、${pct(mine.maxDrawdown)} 的最大回撤。下面所有配置方案都要和它比。`;
  }
  const betterReturn = (mine.annualized ?? -1) > (stocks.annualized ?? -1);
  const lessRisk =
    Math.abs(mine.maxDrawdown ?? 0) < Math.abs(stocks.maxDrawdown ?? 0);
  const retDiff = Math.abs((mine.annualized ?? 0) - (stocks.annualized ?? 0));
  const ddDiff = Math.abs(Math.abs(mine.maxDrawdown ?? 0) - Math.abs(stocks.maxDrawdown ?? 0));

  if (lessRisk && !betterReturn) {
    return `与 100% 股票相比，这套配置的年化低了 ${pct(retDiff, { signed: false })}，
      但最大回撤浅了 ${pct(ddDiff, { signed: false })}。换句话说，它用一部分收益换来了「拿得住」——
      这正是配置类策略的真实交易：不是提高收益，而是降低你被迫在最低点卖出的概率。`;
  }
  if (betterReturn && lessRisk) {
    return `这段历史里它既提高了年化（多 ${pct(retDiff, { signed: false })}），
      又降低了最大回撤（浅 ${pct(ddDiff, { signed: false })}）。这种「两头都赢」通常来自资产之间的低相关性，
      但也要警惕：它可能只是这十几年的特定行情，而不是永久规律。`;
  }
  if (!lessRisk && betterReturn) {
    return `它的年化更高（多 ${pct(retDiff, { signed: false })}），但回撤也更深（深 ${pct(ddDiff, { signed: false })}）。
      这就是「承担更多风险换取更多收益」的常规形态，没有免费的午餐。`;
  }
  return `这段历史里它的年化更低、回撤更深，说明这个配比在 A 股的特定阶段并不占优。
    配置不是万灵药——它解决的是「你不知道未来哪种资产会涨」的问题，而不是「保证赚更多」。`;
}

/* --------------------------------- 启动 --------------------------------- */

function buildControls() {
  const corrHost = document.getElementById("corr-picker");
  checklist(corrHost, {
    assets: state.assets,
    selected: state.corrKeys,
    max: 8,
    onChange: (keys) => {
      state.corrKeys = keys;
      renderCorrelation();
    },
  });

  assetSelect(document.getElementById("dca-asset"), {
    assets: state.assets,
    value: state.dcaKey,
    label: "选择定投资产",
    onChange: (key) => {
      state.dcaKey = key;
      renderDca();
    },
  });

  const monthly = document.getElementById("dca-monthly");
  monthly.addEventListener("input", () => {
    const value = Number(monthly.value);
    state.dcaMonthly = value > 0 ? value : 1000;
    renderDca();
  });

  rangeTabs(document.getElementById("dca-range"), {
    value: state.dcaRange,
    onChange: (value) => {
      state.dcaRange = value;
      renderDca();
    },
  });

  checklist(document.getElementById("stress-picker"), {
    assets: state.assets,
    selected: state.stressKeys,
    max: 6,
    onChange: (keys) => {
      state.stressKeys = keys;
      buildStressWeights();
      renderStress();
    },
  });

  checklist(document.getElementById("rebalance-picker"), {
    assets: state.assets,
    selected: state.rebalanceKeys,
    max: 5,
    onChange: (keys) => {
      state.rebalanceKeys = keys;
      buildRebalanceWeights();
      renderRebalance();
    },
  });

  const strategyHost = document.getElementById("strategy-select");
  strategyHost.innerHTML = `
    <mdui-select id="strategy-picker" variant="outlined" label="选择策略" style="width:100%">
      ${STRATEGIES.map(
        (item) =>
          `<mdui-menu-item value="${item.id}">${item.name} · ${item.tagline}</mdui-menu-item>`
      ).join("")}
    </mdui-select>`;
  const strategyPicker = strategyHost.querySelector("mdui-select");
  strategyPicker.value = state.strategyId;
  strategyPicker.addEventListener("change", () => {
    state.strategyId = strategyPicker.value;
    renderStrategy();
  });

  const interval = document.getElementById("rebalance-interval");
  interval.addEventListener("change", () => {
    state.rebalanceInterval = Number(interval.value) || 63;
    renderRebalance();
  });

  buildStressWeights();
  buildRebalanceWeights();

  const tabs = document.getElementById("mode-tabs");
  tabs.addEventListener("change", () => setMode(tabs.value));
}

function buildStressWeights() {
  const host = document.getElementById("stress-weights");
  const keys = state.stressKeys.map((key) => ({
    key,
    name: assetName(state.assets, key),
  }));
  state.stressWeights = evenWeights(keys.length);
  weightRows(host, {
    keys,
    weights: state.stressWeights,
    onChange: (weights) => {
      state.stressWeights = weights;
      renderStress();
    },
  });
}

function buildRebalanceWeights() {
  const host = document.getElementById("rebalance-weights");
  const keys = state.rebalanceKeys.map((key) => ({
    key,
    name: assetName(state.assets, key),
  }));
  state.rebalanceWeights =
    keys.length === 3 ? [50, 30, 20] : evenWeights(keys.length);

  weightRows(host, {
    keys,
    weights: state.rebalanceWeights,
    onChange: (weights) => {
      state.rebalanceWeights = weights;
      renderRebalance();
    },
  });
}

function setMode(mode) {
  state.mode = mode;
  for (const name of ["corr", "dca", "stress", "rebalance", "strategy"]) {
    document.getElementById(`panel-${name}`).classList.toggle("hidden", mode !== name);
  }
  if (mode === "corr") renderCorrelation();
  if (mode === "dca") renderDca();
  if (mode === "stress") renderStress();
  if (mode === "rebalance") renderRebalance();
  if (mode === "strategy") renderStrategy();
}

async function main() {
  initShell({ active: "portfolio" });
  try {
    const [assets, meta, periods] = await Promise.all([
      loadIndex(),
      loadMeta().catch(() => null),
      loadPeriods().catch(() => null),
    ]);
    state.assets = assets;
    state.meta = meta;
    state.periods = periods;
    buildControls();
    setMode(state.mode);
  } catch (err) {
    showError(document.getElementById("corr-result"), `初始化失败：${err.message}`);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}