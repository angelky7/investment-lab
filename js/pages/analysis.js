/**
 * js/pages/analysis.js — 资产分析页。
 *
 * 交互模型：控件一变就重算，不需要点按钮。所有数字都来自 js/core/stats.js，
 * 本文件只负责取数、排版和画图。
 */

import { initShell, showError, loadingHtml } from "../core/shell.js";
import {
  loadIndex,
  loadMeta,
  loadSeries,
  loadSeriesMany,
  findAsset,
  benchmarkFor,
} from "../core/store.js";
import {
  alignByDate,
  cumulative,
  dateRangeIndices,
  histogram,
  sliceLastYears,
} from "../core/series.js";
import { analyze, compare as compareSeries } from "../core/stats.js";
import { areaChart, histogramChart, lineChart } from "../core/charts.js";
import { typeTabs, assetSelect, checklist, rangeTabs, yearsOf } from "../ui/picker.js";
import { metricsHtml, tableHtml, notice } from "../ui/cards.js";
import {
  count,
  dateLabel,
  duration,
  monthLabel,
  num,
  pct,
  price,
  rangeLabel,
  tone,
} from "../core/format.js";

const state = {
  assets: [],
  meta: null,
  mode: "single",
  type: "index",
  key: "",
  range: "5",
  riskFree: 0.025,
  compareKeys: [],
};

let seq = 0; // 防止并发渲染交错
const benchCache = new Map();

/** 按资产所属市场加载对应基准，同市场只请求一次 */
function benchmarkSeries(assets, asset) {
  const info = benchmarkFor(asset);
  if (!benchCache.has(info.key)) {
    const bench = findAsset(assets, info.key) || null;
    benchCache.set(
      info.key,
      bench ? loadSeries(bench).catch(() => null) : Promise.resolve(null)
    );
  }
  return Promise.all([benchCache.get(info.key), Promise.resolve(info)]);
}

/** 按日期窗口裁切工具 */
function sliceWindow(dates, prices, start, end) {
  const { start: from, end: to } = dateRangeIndices(dates, start, end);
  if (from > to) return { dates: [], prices: [] };
  return { dates: dates.slice(from, to + 1), prices: prices.slice(from, to + 1) };
}

/* ------------------------------- 页面构建 ------------------------------- */

function chartCard(id, title, hint = "") {
  return `
    <div class="card">
      <div class="chart-head">
        <h3>${title}</h3>
        ${hint ? `<span class="hint">${hint}</span>` : ""}
      </div>
      <div class="chart" id="${id}"></div>
    </div>`;
}

function placeholderChart(hostId, message) {
  const host = document.getElementById(hostId);
  if (host) host.innerHTML = `<div class="chart-empty">${message}</div>`;
}

/* --------------------------------- 初始化 -------------------------------- */

function readParams() {
  const search = new URLSearchParams(location.search);
  state.mode = search.get("mode") === "compare" ? "compare" : "single";
  state.type = search.get("type") || "index";
  state.range = search.get("range") || "5";
  const symbol = search.get("symbol") || "";
  if (symbol) state.key = `${state.type}:${symbol}`;
  const compare = search.get("compare");
  if (compare) state.compareKeys = compare.split(",").filter(Boolean).slice(0, 6);
}

function writeParams() {
  const search = new URLSearchParams();
  search.set("mode", state.mode);
  search.set("range", state.range);
  if (state.mode === "single" && state.key) {
    const [type, symbol] = state.key.split(":");
    search.set("type", type);
    search.set("symbol", symbol);
  }
  if (state.mode === "compare" && state.compareKeys.length) {
    search.set("compare", state.compareKeys.join(","));
  }
  history.replaceState(null, "", `${location.pathname}?${search.toString()}`);
}

function defaultKeyFor(type) {
  const asset = state.assets.find((a) => a.type === type && a.status === "ok");
  return asset ? `${asset.type}:${asset.symbol}` : "";
}

function buildControls() {
  const singleHost = document.getElementById("single-type-tabs");
  typeTabs(singleHost, {
    value: state.type,
    onChange: (type) => {
      state.type = type;
      state.key = defaultKeyFor(type);
      buildAssetSelect();
      writeParams();
      renderSingle();
    },
  });

  rangeTabs(document.getElementById("single-range"), {
    value: state.range,
    onChange: (value) => {
      state.range = value;
      writeParams();
      renderSingle();
      renderCompare();
    },
  });

  rangeTabs(document.getElementById("compare-range"), {
    value: state.range,
    onChange: (value) => {
      state.range = value;
      writeParams();
      renderSingle();
      renderCompare();
    },
  });

  const rfField = document.getElementById("rf-input");
  rfField.addEventListener("input", () => {
    const value = Number(rfField.value);
    state.riskFree = Number.isFinite(value) ? value / 100 : 0.025;
    renderSingle();
    renderCompare();
  });

  buildAssetSelect();

  const picker = document.getElementById("compare-picker");
  checklist(picker, {
    assets: state.assets,
    selected: state.compareKeys.length ? state.compareKeys : ["index:000300", "index:000905"],
    max: 6,
    onChange: (keys) => {
      state.compareKeys = keys;
      writeParams();
      renderCompare();
    },
  });

  const tabs = document.getElementById("mode-tabs");
  tabs.addEventListener("change", () => setMode(tabs.value));
}

function buildAssetSelect() {
  const host = document.getElementById("single-asset");
  assetSelect(host, {
    assets: state.assets,
    type: state.type,
    value: state.key,
    label: "选择资产",
    onChange: (key) => {
      if (!key) return;
      state.key = key;
      writeParams();
      renderSingle();
    },
  });
}

function setMode(mode) {
  state.mode = mode;
  document.getElementById("panel-single").classList.toggle("hidden", mode !== "single");
  document.getElementById("panel-compare").classList.toggle("hidden", mode !== "compare");
  document.getElementById("single-results").classList.toggle("hidden", mode !== "single");
  document.getElementById("compare-results").classList.toggle("hidden", mode !== "compare");
  writeParams();
  if (mode === "single") renderSingle();
  else renderCompare();
}

/* --------------------------------- 单资产 -------------------------------- */

async function renderSingle() {
  if (state.mode !== "single") return;
  const token = ++seq;
  const metricsHost = document.getElementById("single-metrics");
  const chartsHost = document.getElementById("single-charts");
  const asset = findAsset(state.assets, state.key);
  if (!asset) return;

  metricsHost.innerHTML = loadingHtml();
  chartsHost.innerHTML = "";

  try {
    const [series, benchResult] = await Promise.all([
      loadSeries(asset),
      benchmarkSeries(state.assets, asset),
    ]);
    const [bench, benchInfo] = benchResult;
    if (token !== seq) return;

    const years = yearsOf(state.range);
    const win = sliceLastYears(series.dates, series.prices, years);
    const displayWin = sliceLastYears(series.dates, series.display, years).prices;

    if (win.prices.length < 2) {
      metricsHost.innerHTML = notice(
        `该资产在所选区间内只有 ${win.prices.length} 个数据点，无法计算。请把区间改为「全部」。`,
        "warn"
      );
      return;
    }

    const benchWin =
      bench && bench.dates.length
        ? sliceWindow(bench.dates, bench.prices, win.dates[0], win.dates[win.dates.length - 1])
        : null;

    let aligned = null;
    if (benchWin && benchWin.prices.length > 30) {
      aligned = alignByDate([
        { key: "asset", dates: win.dates, prices: win.prices },
        { key: "bench", dates: benchWin.dates, prices: benchWin.prices },
      ]);
      if (aligned.dates.length < 30) aligned = null;
    }

    const useDates = aligned ? aligned.dates : win.dates;
    const usePrices = aligned ? aligned.values.asset : win.prices;
    const benchPrices = aligned ? aligned.values.bench : null;

    const result = analyze(usePrices, useDates, {
      riskFreeRate: state.riskFree,
      benchmark: benchPrices ? { prices: benchPrices, dates: useDates } : null,
    });

    if (!result.ok) {
      metricsHost.innerHTML = notice(result.reason, "warn");
      return;
    }

    const isBenchmark = state.key === benchInfo.key;
    metricsHost.innerHTML = metricsHtml(metricsFor(result, series, benchInfo.name, isBenchmark));

    chartsHost.innerHTML = [
      chartCard("chart-price", "价格走势", `${series.name} · ${rangeLabel(win.dates[0], win.dates[win.dates.length - 1])}`),
      chartCard(
        "chart-cum",
        "累计收益对比",
        benchPrices ? `与${benchInfo.name} 同窗口对齐` : "无基准数据"
      ),
      chartCard("chart-dd", "回撤曲线", "每个点相对此前最高点"),
      chartCard("chart-roll", "滚动一年年化收益", "看收益的时间稳定性，而不是只有一个数字"),
      chartCard("chart-dist", "日收益分布", "直方图 · 越集中说明日常波动越小"),
    ].join("");

    const labelFormatter = years <= 3 ? (d) => monthLabel(d) : (d) => d.slice(0, 4);

    lineChart(document.getElementById("chart-price"), {
      labels: win.dates,
      series: [{ name: series.name, values: displayWin, color: "var(--il-chart-1)" }],
      formatter: (v) => price(v),
      tipFormatter: (v) => price(v),
      labelFormatter,
      tipDateFormatter: dateLabel,
    });

    const cumSeries = [{ name: series.name, values: cumulative(usePrices), color: "var(--il-chart-1)" }];
    if (benchPrices) {
      cumSeries.push({
        name: benchInfo.name,
        values: cumulative(benchPrices),
        color: "var(--il-chart-3)",
      });
    }
    lineChart(document.getElementById("chart-cum"), {
      labels: useDates,
      series: cumSeries,
      formatter: (v) => pct(v, { digits: 0 }),
      tipFormatter: (v) => pct(v),
      labelFormatter,
      tipDateFormatter: dateLabel,
      baseline: 0,
      includeZero: true,
    });

    areaChart(document.getElementById("chart-dd"), {
      labels: useDates,
      series: [
        {
          name: "回撤",
          values: result.drawdownSeries,
          color: "var(--il-drawdown)",
        },
      ],
      formatter: (v) => pct(v, { digits: 0 }),
      tipFormatter: (v) => pct(v),
      labelFormatter,
      tipDateFormatter: dateLabel,
      baseline: 0,
    });

    lineChart(document.getElementById("chart-roll"), {
      labels: useDates,
      series: [
        {
          name: "滚动一年年化",
          values: result.rolling1y.map((v) => (v === null ? null : v)),
          color: "var(--il-chart-4)",
          fill: false,
          width: 1.5,
        },
      ],
      formatter: (v) => pct(v, { digits: 0 }),
      tipFormatter: (v) => pct(v),
      labelFormatter,
      tipDateFormatter: dateLabel,
      baseline: 0,
      includeZero: true,
    });

    const dailyReturns = [];
    for (let i = 1; i < usePrices.length; i += 1) {
      const prev = usePrices[i - 1];
      if (prev > 0) dailyReturns.push(usePrices[i] / prev - 1);
    }
    histogramChart(document.getElementById("chart-dist"), {
      labels: useDates.slice(1),
      histogram: histogram(dailyReturns, 41),
      formatter: (v) => pct(v, { digits: 1, signed: false }),
    });
  } catch (err) {
    if (token !== seq) return;
    showError(metricsHost, err.message);
  }
}

/* -------------------------------- 多资产 -------------------------------- */

async function renderCompare() {
  const token = ++seq;
  const tableHost = document.getElementById("compare-table");
  const chartHost = document.getElementById("compare-chart");
  if (state.mode !== "compare") return;

  const keys = state.compareKeys.length ? state.compareKeys : ["index:000300", "index:000905"];
  const assets = keys.map((key) => findAsset(state.assets, key)).filter(Boolean);

  if (assets.length < 2) {
    tableHost.innerHTML = notice("至少选择 2 项资产才能对比。", "warn");
    chartHost.innerHTML = "";
    return;
  }

  tableHost.innerHTML = loadingHtml("正在对齐交易日期并对比较指标…");
  chartHost.innerHTML = "";

  try {
    const seriesList = await loadSeriesMany(assets);
    if (token !== seq) return;
    if (seriesList.length < 2) {
      tableHost.innerHTML = notice("所选资产的数据加载失败。", "warn");
      return;
    }

    const years = yearsOf(state.range);
    const entries = seriesList.map((s) => {
      const win = sliceLastYears(s.dates, s.prices, years);
      return { key: s.key, name: s.name, dates: win.dates, prices: win.prices };
    });

    const aligned = alignByDate(entries);
    if (aligned.dates.length < 30) {
      tableHost.innerHTML = notice(
        `所选资产在同一时间窗口内只有 ${aligned.dates.length} 个共同交易日，无法对比。请缩短区间或换一组资产。`,
        "warn"
      );
      return;
    }

    const list = entries.map((entry) => ({
      key: entry.key,
      name: entry.name,
      prices: aligned.values[entry.key],
      dates: aligned.dates,
    }));

    const rows = compareSeries(list, { riskFreeRate: state.riskFree });

    tableHost.innerHTML = `
      <div class="card">
        <div class="chart-head">
          <h3>指标对比</h3>
          <span class="hint">共同交易日 ${count(aligned.dates.length)} 个 · ${rangeLabel(
            aligned.dates[0],
            aligned.dates[aligned.dates.length - 1]
          )}</span>
        </div>
        ${tableHtml({
          columns: [
            { label: "资产", align: "left" },
            { label: "累计收益" },
            { label: "年化收益" },
            { label: "年化波动" },
            { label: "夏普" },
            { label: "索提诺" },
            { label: "最大回撤" },
          ],
          rows: rows.map((row) => ({
            cells: [
              { html: `<strong>${row.name}</strong>` },
              { html: pct(row.totalReturn), cls: tone(row.totalReturn) },
              { html: pct(row.annualizedReturn), cls: tone(row.annualizedReturn) },
              { html: pct(row.volatility, { signed: false }) },
              { html: num(row.sharpe) },
              { html: num(row.sortino) },
              { html: pct(row.maxDrawdown), cls: "neg" },
            ],
          })),
          caption:
            "对比前已把各资产的交易日期取交集，因此所有数字都基于同一段时间，可以直接横向比较。",
        })}
      </div>`;

    chartHost.innerHTML = chartCard("chart-compare", "累计收益对比", "同起点归一，越陡说明涨得越快");

    const colors = ["--il-chart-1", "--il-chart-2", "--il-chart-3", "--il-chart-4", "--il-chart-5", "--il-chart-6"];
    lineChart(document.getElementById("chart-compare"), {
      labels: aligned.dates,
      series: list.map((entry, i) => ({
        name: entry.name,
        values: cumulative(entry.prices),
        color: `var(${colors[i % colors.length]})`,
      })),
      formatter: (v) => pct(v, { digits: 0 }),
      tipFormatter: (v) => pct(v),
      labelFormatter: years <= 3 ? (d) => monthLabel(d) : (d) => d.slice(0, 4),
      tipDateFormatter: dateLabel,
      baseline: 0,
      includeZero: true,
    });
  } catch (err) {
    if (token !== seq) return;
    showError(tableHost, err.message);
  }
}

/* --------------------------------- 启动 --------------------------------- */

async function main() {
  initShell({ active: "analysis" });
  readParams();

  try {
    const [assets, meta] = await Promise.all([loadIndex(), loadMeta().catch(() => null)]);
    state.assets = assets;
    state.meta = meta;

    if (!state.key) state.key = defaultKeyFor(state.type);
    if (state.key && state.key.split(":")[0] !== state.type) {
      state.type = state.key.split(":")[0];
    }
    if (!state.compareKeys.length) {
      state.compareKeys = ["index:000300", "index:000905"];
    }

    buildControls();
    // 让 tab 的选中态与 URL 参数一致：mdui-tabs 初始化时会以自身 value 为准，
    // 若不显式同步，?mode=compare 会被默认的 single 覆盖掉。
    const tabs = document.getElementById("mode-tabs");
    if (tabs) tabs.value = state.mode;
    setMode(state.mode);
  } catch (err) {
    showError(document.getElementById("single-metrics"), `初始化失败：${err.message}`);
  }
}

function metricsFor(result, series, benchName = "沪深300", isBenchmark = false) {
  const mdd = result.maxDrawdown;
  const recovery = mdd?.recoveryDays;
  const items = [
    {
      label: "年化收益",
      value: pct(result.annualizedReturn),
      tone: tone(result.annualizedReturn),
      sub: `${result.years.toFixed(1)} 年 · 累计 ${pct(result.totalReturn)}`,
    },
    {
      label: "年化波动",
      value: pct(result.volatility, { signed: false }),
      sub: "日收益标准差 × √252",
    },
    {
      label: "夏普比率",
      value: num(result.sharpe),
      sub: (result.sharpe ?? 0) >= 1 ? "风险调整后收益优秀" : (result.sharpe ?? 0) > 0 ? "一般" : "跑输无风险利率",
    },
    { label: "索提诺比率", value: num(result.sortino), sub: "只惩罚下跌波动" },
    { label: "卡玛比率", value: num(result.calmar), sub: "年化收益 ÷ 最大回撤" },
    {
      label: "最大回撤",
      value: pct(mdd?.value ?? null),
      tone: "neg",
      sub: mdd ? `${dateLabel(mdd.peakDate)} → ${dateLabel(mdd.troughDate)}` : "—",
    },
    {
      label: "回撤修复",
      value: recovery === null || recovery === undefined ? "尚未修复" : duration(recovery),
      sub: "谷底回到前高所需时间",
    },
    {
      label: "胜率",
      value: result.winLoss ? pct(result.winLoss.winRate, { signed: false }) : "—",
      sub: result.winLoss ? `${result.winLoss.upDays} 涨 / ${result.winLoss.downDays} 跌` : "—",
    },
    { label: "最佳单日", value: pct(result.winLoss?.bestDay ?? null), tone: "pos", sub: "单日最大涨幅" },
    { label: "最差单日", value: pct(result.winLoss?.worstDay ?? null), tone: "neg", sub: "单日最大跌幅" },
    {
      label: "Beta",
      value: isBenchmark ? "1.00" : num(result.beta),
      sub: isBenchmark ? "该资产本身即基准" : `相对${benchName}的敏感度`,
    },
    {
      label: "Alpha（年化）",
      value: pct(result.alpha),
      tone: tone(result.alpha),
      sub: "扣除 Beta 解释后的超额",
    },
    {
      label: "与基准相关性",
      value: isBenchmark ? "1.00" : num(result.correlation),
      sub: isBenchmark ? "该资产本身即基准" : `与${benchName}的日收益相关系数`,
    },
    {
      label: "最新价格",
      value: price(series.lastClose ?? series.prices[series.prices.length - 1]),
      sub: series.priceBasis || "",
    },
    {
      label: "样本区间",
      value: `${count(result.points)} 天`,
      sub: `${dateLabel(result.start)} 起`,
    },
  ];
  return items;
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}