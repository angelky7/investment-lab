/**
 * js/pages/analysis.js — 资产分析页。
 *
 * 交互模型：控件一变就重算，不需要点按钮。所有数字都来自 js/core/stats.js，
 * 本文件只负责取数、排版和画图。
 */

import { initShell, showError, loadingHtml, toast } from "../core/shell.js";
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
import {
  analyze,
  annualReturns,
  annualizedReturn,
  betaAlpha,
  compare as compareSeries,
} from "../core/stats.js";
import { areaChart, histogramChart, lineChart } from "../core/charts.js";
import { deflate } from "../core/inflation.js";
import { exportSeriesCsv, fingerprint } from "../core/export.js";
import { gapAwareReturns } from "../core/series.js";
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
  // 收益口径：nominal 名义 / real 实际（扣 CPI）
  basis: "nominal",
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

/**
 * 名义 / 实际 口径切换。
 *
 * 实际口径只在 CPI 覆盖的区间内可用（中国 CPI 自 2008-01 起），
 * 页面会显示 CPI 的可得区间与区间累计通胀，并把无法折算的早期交易日截掉。
 */
function renderBasisToggle() {
  const host = document.getElementById("single-basis");
  if (!host) return;

  host.innerHTML = `
    <div class="row" style="gap:.4rem;align-items:center;margin-top:.5rem">
      <span class="small muted">收益口径</span>
      <mdui-segmented-button-group id="basis-group" value="${state.basis}" selects="single">
        <mdui-segmented-button value="nominal">名义</mdui-segmented-button>
        <mdui-segmented-button value="real">实际（扣 CPI）</mdui-segmented-button>
      </mdui-segmented-button-group>
      <span class="small muted">${
        state.basis === "real" ? "按中国 CPI 折算，2008-01 起可得" : "未扣通胀"
      }</span>
    </div>`;

  const group = host.querySelector("#basis-group");
  if (group) {
    group.addEventListener("change", () => {
      state.basis = group.value;
      renderSingle();
    });
  }
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

  renderBasisToggle();

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
    const isFx = asset.type === "fx";
    const [series, benchResult] = await Promise.all([
      loadSeries(asset),
      isFx
        ? Promise.resolve([null, benchmarkFor(asset)])
        : benchmarkSeries(state.assets, asset),
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

    let benchWin =
      !isFx && bench && bench.dates.length
        ? sliceWindow(bench.dates, bench.prices, win.dates[0], win.dates[win.dates.length - 1])
        : null;

    // 关键：资产的指标要在**它自己的完整窗口**上算。
    // 基准（沪深300 只有 2005 起）不能反过来把上证指数（1990 起）的统计区间截短。
    // 实际口径：把价格序列除以「当日 CPI / 期初 CPI」。
    // CPI 是月度的，已按月向前填充；无覆盖的早期区间会被截掉，并在页面上说明。
    let basisInfo = null;
    let basisPrices = win.prices;
    let basisDates = win.dates;
    if (state.basis === "real") {
      const cpiAsset = findAsset(state.assets, "index:CPI");
      if (!cpiAsset) {
        basisInfo = {
          fallback: true,
          reason: "数据索引里没有 CPI 序列（可能未构建）。已退回名义口径。",
        };
      }
      if (cpiAsset) {
        const cpiSeries = await loadSeries(cpiAsset);
        const cpi = { dates: cpiSeries.dates, prices: cpiSeries.prices };
        const real = deflate(win.dates, win.prices, cpi);
        if (real.prices.length <= 30) {
          basisInfo = {
            fallback: true,
            reason: `CPI 覆盖不足（该区间只有 ${real.prices.length} 个可折算点），已退回名义口径。`,
          };
        }
        if (real.prices.length > 30) {
          basisPrices = real.prices;
          basisDates = win.dates.slice(real.startIndex);
          basisInfo = {
            ...real,
            cpiStart: cpiSeries.dates[0],
            cpiEnd: cpiSeries.dates[cpiSeries.dates.length - 1],
          };
          // 基准也必须同步折算，否则就成了「实际资产 vs 名义基准」
          if (benchWin) {
            const realBench = deflate(benchWin.dates, benchWin.prices, cpi);
            if (realBench.prices.length > 30) {
              benchWin = {
                dates: benchWin.dates.slice(realBench.startIndex),
                prices: realBench.prices,
              };
            }
          }
        }
      }
    }

    const useDates = basisDates;
    const usePrices = basisPrices;

    const result = analyze(usePrices, useDates, { riskFreeRate: state.riskFree });

    // 相对基准的指标单独算：betaAlpha 内部按日期交集对齐，所以只覆盖可比区间
    let benchPrices = null;
    let benchAlignedDates = null;
    if (benchWin && benchWin.prices.length > 30) {
      const relative = betaAlpha(
        usePrices,
        benchWin.prices,
        state.riskFree,
        useDates,
        benchWin.dates
      );
      result.beta = relative.beta;
      result.alpha = relative.alpha;
      result.correlation = relative.correlation;
      result.benchmarkReturn = annualizedReturn(benchWin.prices, benchWin.dates);

      const aligned = alignByDate([
        { key: "asset", dates: useDates, prices: usePrices },
        { key: "bench", dates: benchWin.dates, prices: benchWin.prices },
      ]);
      if (aligned.dates.length >= 30) {
        benchPrices = aligned.values.bench;
        benchAlignedDates = aligned.dates;
        result.relativeStart = aligned.dates[0];
      }
    }

    if (!result.ok) {
      metricsHost.innerHTML = notice(result.reason, "warn");
      return;
    }

    const isBenchmark = state.key === benchInfo.key;
    metricsHost.innerHTML =
      (basisInfo
        ? basisInfo.fallback
          ? `<div class="notice" data-tone="warn"><span>${basisInfo.reason}</span></div>`
          : `<div class="notice" data-tone="info"><span>
              当前是 <strong>实际口径</strong>：已用中国 CPI 折算（${basisInfo.cpiStart} ~ ${basisInfo.cpiEnd} 可得），
              区间内 CPI 累计 <strong>${pct(basisInfo.totalInflation)}</strong>。
              ${basisInfo.startIndex > 0 ? `CPI 覆盖之前的 ${basisInfo.startIndex} 个交易日无法折算，已从图上截掉。` : ""}
             </span></div>`
        : "") +
      metricsHtml(metricsFor(result, series, benchInfo.name, isBenchmark, isFx)) +
      `<div class="card" style="margin-top:0.8rem">
        <div class="chart-head">
          <h3>把这条序列拿走自己算</h3>
          <span class="hint">指纹一致 = 我们给你的数据和页面上的完全一样</span>
        </div>
        <div class="row" style="align-items:center;gap:.6rem;flex-wrap:wrap">
          <mdui-button variant="tonal" id="btn-export-csv" icon="download">下载 CSV</mdui-button>
          <span class="small muted" id="series-fingerprint">正在计算序列指纹…</span>
        </div>
        <p class="caption" style="margin-top:.5rem">
          指纹是对「日期:价格」逐行做 SHA-256 的前 12 位。别人拿到同一份数据算出的指纹必须一致——
          不一致，就说明有一方被改过。
        </p>
      </div>`;

    chartsHost.innerHTML = [
      chartCard(
        "chart-price",
        state.basis === "real" ? "实际价格走势（扣 CPI）" : "价格走势",
        `${series.name} · ${rangeLabel(useDates[0], useDates[useDates.length - 1])}`
      ),
      chartCard(
        "chart-cum",
        isFx ? "汇率走势（累计变化）" : "累计收益对比",
        isFx ? "汇改前后的台阶式跳变是真实历史" : benchPrices ? `与${benchInfo.name} 同窗口对齐` : "无基准数据"
      ),
      chartCard("chart-dd", "回撤曲线", "每个点相对此前最高点"),
      chartCard("chart-roll", "滚动一年年化收益", "看收益的时间稳定性，而不是只有一个数字"),
      chartCard("chart-dist", "日收益分布", "直方图 · 越集中说明日常波动越小"),
      `<div class="card">
        <div class="chart-head">
          <h3>年度收益</h3>
          <span class="hint">按自然年切分；每年取「上年末收盘 → 本年末收盘」</span>
        </div>
        ${annualTableHtml(
          annualReturns(useDates, usePrices),
          benchPrices ? annualReturns(benchAlignedDates || useDates, benchPrices) : null,
          benchInfo.name
        )}
      </div>`,
    ].join("");

    const labelFormatter = years <= 3 ? (d) => monthLabel(d) : (d) => d.slice(0, 4);

    // 序列指纹与 CSV 导出：让「你自己验证」变成可执行的动作，而不是一句口号
    const exportSeries = {
      symbol: `${series.type}:${series.symbol}`,
      name: series.name,
      dates: useDates,
      prices: usePrices,
      realPrices: state.basis === "real" && basisInfo && !basisInfo.fallback ? usePrices : null,
      realStart: state.basis === "real" && basisInfo && !basisInfo.fallback ? basisInfo.startIndex : 0,
    };
    const skippedInfo = gapAwareReturns(useDates, usePrices);
    const fpHost = document.getElementById("series-fingerprint");
    fingerprint(useDates, usePrices).then((fp) => {
      if (!fpHost) return;
      fpHost.innerHTML =
        `指纹 <strong>${fp.value}</strong>（${fp.algorithm === "sha256" ? "SHA-256" : "FNV-1a 弱校验"} · ` +
        `${fp.length.toLocaleString("zh-CN")} 个交易日）` +
        (skippedInfo.skipped > 0
          ? `；收益计算跳过了 <strong>${skippedInfo.skipped}</strong> 个跨缺口样本（占 ${
              ((skippedInfo.skipped / (skippedInfo.returns.length + skippedInfo.skipped)) * 100).toFixed(1)
            }%）`
          : "");
    });
    document.getElementById("btn-export-csv")?.addEventListener("click", () => {
      const { rows } = exportSeriesCsv(exportSeries);
      toast(`已导出 ${rows.toLocaleString("zh-CN")} 行 CSV`);
    });

    lineChart(document.getElementById("chart-price"), {
      labels: win.dates,
      series: [{ name: series.name, values: displayWin, color: "var(--il-chart-1)" }],
      formatter: (v) => price(v),
      tipFormatter: (v) => price(v),
      labelFormatter,
      tipDateFormatter: dateLabel,
    });

    const cumSeries = [{ name: series.name, values: cumulative(usePrices), color: "var(--il-chart-1)" }];
    if (benchPrices && benchAlignedDates && !isFx) {
      cumSeries.push({
        name: benchInfo.name,
        values: cumulative(benchPrices),
        color: "var(--il-chart-3)",
      });
    }
    const cumLabels = benchPrices && benchAlignedDates ? benchAlignedDates : useDates;
    lineChart(document.getElementById("chart-cum"), {
      labels: cumLabels,
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

/**
 * 年度收益表：一年一行。
 * 一条 20 年的曲线看不出「哪一年最难受」，这张表能。
 */
function annualTableHtml(rows, benchRows, benchName) {
  if (!rows || !rows.length) return notice("数据不足，无法按年切分。", "warn");
  const benchByYear = new Map((benchRows || []).map((r) => [r.year, r]));

  const body = rows
    .slice()
    .reverse()
    .map((row) => {
      const bench = benchByYear.get(row.year);
      const diff = bench && bench.ret !== null && row.ret !== null ? row.ret - bench.ret : null;
      return [
        { html: `<strong>${row.year}</strong>${row.partial ? ' <span class="muted small">部分</span>' : ""}` },
        { html: row.ret === null ? "—" : pct(row.ret), cls: row.ret === null ? "muted" : tone(row.ret) },
        { html: pct(row.maxDrawdown), cls: "neg" },
        { html: bench && bench.ret !== null ? pct(bench.ret) : "—", cls: bench && bench.ret !== null ? tone(bench.ret) : "muted" },
        { html: diff === null ? "—" : pct(diff), cls: diff === null ? "muted" : tone(diff) },
      ];
    });

  return tableHtml({
    columns: [
      { label: "年份", align: "left" },
      { label: "本年收益" },
      { label: "年内最大回撤" },
      { label: benchName || "基准" },
      { label: "相对基准" },
    ],
    rows: body.map((cells) => ({ cells })),
    caption:
      "「年内最大回撤」是指这一年之内从高点到低点的跌幅——它比年度收益更能说明持有体验：" +
      "有些年份最终是涨的，但中途跌掉了三成。",
  });
}

function metricsFor(result, series, benchName = "沪深300", isBenchmark = false, isFx = false) {
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
      value: isFx ? "—" : isBenchmark ? "1.00" : num(result.beta),
      sub: isFx
        ? "汇率不适用相对基准指标"
        : isBenchmark
          ? "该资产本身即基准"
          : `相对${benchName}的敏感度${result.relativeStart ? `（${result.relativeStart.slice(0, 4)} 起可比）` : ""}`,
    },
    {
      label: "Alpha（年化）",
      value: pct(result.alpha),
      tone: tone(result.alpha),
      sub: "扣除 Beta 解释后的超额",
    },
    {
      label: "与基准相关性",
      value: isFx ? "—" : isBenchmark ? "1.00" : num(result.correlation),
      sub: isFx
        ? "汇率不适用相对基准指标"
        : isBenchmark
          ? "该资产本身即基准"
          : `与${benchName}的日收益相关系数${result.relativeStart ? `（${result.relativeStart.slice(0, 4)} 起可比）` : ""}`,
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