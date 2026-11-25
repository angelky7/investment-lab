/**
 * js/pages/history.js — 历史时期复盘。
 *
 * 对选定资产逐个历史窗口计算真实区间收益、年化、最大回撤与波动。
 * 窗口定义来自 data/periods.json（构建时由 config/periods.json 复制而来）。
 */

import { initShell, showError, loadingHtml } from "../core/shell.js";
import { findAsset, loadIndex, loadPeriods, loadSeries } from "../core/store.js";
import { dateRangeIndices, sliceLastYears } from "../core/series.js";
import { analyze } from "../core/stats.js";
import { barChart } from "../core/charts.js";
import { assetSelect, typeTabs } from "../ui/picker.js";
import { metricsHtml, notice, tableHtml } from "../ui/cards.js";
import { count, dateLabel, monthLabel, num, pct, rangeLabel, tone } from "../core/format.js";

const state = {
  assets: [],
  periods: null,
  type: "index",
  key: "",
};

let token = 0;

/** 把序列裁到 [start, end] */
function slicePeriod(series, start, end) {
  const { start: from, end: to } = dateRangeIndices(series.dates, start, end);
  if (from > to) return { dates: [], prices: [] };
  return { dates: series.dates.slice(from, to + 1), prices: series.prices.slice(from, to + 1) };
}

function periodResult(series, period) {
  const win = slicePeriod(series, period.start, period.end);
  if (win.prices.length < 2) {
    return { period, insufficient: true, points: win.prices.length };
  }
  const result = analyze(win.prices, win.dates, {});
  return {
    period,
    insufficient: false,
    points: win.prices.length,
    dates: win.dates,
    prices: win.prices,
    totalReturn: result.totalReturn,
    annualizedReturn: result.annualizedReturn,
    volatility: result.volatility,
    maxDrawdown: result.maxDrawdown?.value ?? null,
    drawdownPeak: result.maxDrawdown?.peakDate ?? "",
    drawdownTrough: result.maxDrawdown?.troughDate ?? "",
  };
}

async function render() {
  const local = ++token;
  const host = document.getElementById("history-results");
  const asset = findAsset(state.assets, state.key);
  if (!asset) return;

  host.innerHTML = loadingHtml("正在按历史窗口计算…");

  try {
    const [series, periods] = await Promise.all([
      loadSeries(asset),
      state.periods ? Promise.resolve(state.periods) : loadPeriods(),
    ]);
    if (local !== token) return;

    const defs = periods.periods || [];
    const rows = defs.map((period) => periodResult(series, period));

    const lastYear = sliceLastYears(series.dates, series.prices, 1);
    const recent =
      lastYear.prices.length > 2
        ? {
            period: {
              id: "recent1y",
              name: "最近 12 个月",
              start: lastYear.dates[0],
              end: lastYear.dates[lastYear.dates.length - 1],
              summary: "距离现在最近的完整一年，用来对照「当下」和「历史危机」。",
              lesson: "最近一年的表现最容易影响判断，但它只是长期样本中的一小段。",
              kind: "recent",
            },
            ...(() => {
              const result = analyze(lastYear.prices, lastYear.dates, {});
              return {
                insufficient: false,
                points: lastYear.prices.length,
                dates: lastYear.dates,
                prices: lastYear.prices,
                totalReturn: result.totalReturn,
                annualizedReturn: result.annualizedReturn,
                volatility: result.volatility,
                maxDrawdown: result.maxDrawdown?.value ?? null,
                drawdownPeak: result.maxDrawdown?.peakDate ?? "",
                drawdownTrough: result.maxDrawdown?.troughDate ?? "",
              };
            })(),
          }
        : null;

    const all = recent ? [recent, ...rows] : rows;
    const valid = all.filter((r) => !r.insufficient);
    const worst = valid.length
      ? valid.reduce((a, b) => ((a.maxDrawdown ?? 0) < (b.maxDrawdown ?? 0) ? a : b))
      : null;

    host.innerHTML = `
      <div class="card">
        <div class="chart-head">
          <h3>${asset.name} · 各时期区间收益</h3>
          <span class="hint">${rangeLabel(series.start, series.end)} · 共 ${count(series.count)} 个交易日</span>
        </div>
        ${metricsHtml([
          {
            label: "覆盖时期",
            value: `${valid.length}/${all.length}`,
            sub: valid.length < all.length ? "部分时期该资产尚无数据" : "全部时期均有数据",
          },
          {
            label: "最差时期回撤",
            value: pct(worst?.maxDrawdown ?? null),
            tone: "neg",
            sub: worst ? worst.period.name : "—",
          },
          {
            label: "历史全区间年化",
            value: pct(analyze(series.prices, series.dates, {}).annualizedReturn),
            tone: tone(analyze(series.prices, series.dates, {}).annualizedReturn),
            sub: `${dateLabel(series.start)} 起`,
          },
          {
            label: "价格口径",
            value: series.priceBasis || "—",
            sub: "含分红再投资",
          },
        ])}
      </div>

      <div class="card">
        <div class="chart-head">
          <h3>区间收益对比</h3>
          <span class="hint">红为上涨、绿为下跌（国内习惯）</span>
        </div>
        <div class="chart" id="chart-periods"></div>
      </div>

      <div class="card">
        <h2 class="section-title">明细</h2>
        ${tableHtml({
          columns: [
            { label: "时期", align: "left" },
            { label: "区间" },
            { label: "区间收益" },
            { label: "年化" },
            { label: "最大回撤" },
            { label: "年化波动" },
            { label: "数据点" },
          ],
          rows: all.map((row) =>
            row.insufficient
              ? {
                  cells: [
                    { html: `<strong>${row.period.name}</strong>` },
                    { html: `${row.period.start} ~ ${row.period.end}` },
                    { html: "无数据", cls: "muted" },
                    { html: "—", cls: "muted" },
                    { html: "—", cls: "muted" },
                    { html: "—", cls: "muted" },
                    { html: `${row.points}` },
                  ],
                }
              : {
                  cells: [
                    { html: `<strong>${row.period.name}</strong>` },
                    { html: `${dateLabel(row.dates[0])} ~ ${dateLabel(row.dates[row.dates.length - 1])}` },
                    { html: pct(row.totalReturn), cls: tone(row.totalReturn) },
                    { html: pct(row.annualizedReturn), cls: tone(row.annualizedReturn) },
                    { html: pct(row.maxDrawdown), cls: "neg" },
                    { html: pct(row.volatility, { signed: false }) },
                    { html: `${count(row.points)}` },
                  ],
                }
          ),
          caption:
            "短窗口的年化收益波动极大（例如两个月翻倍会被年化成极高的数字），所以「区间收益」比「年化」更值得看。",
        })}
      </div>

      <div class="stack">
        ${all
          .map(
            (row) => `
          <div class="scenario">
            <div class="scenario-head">
              <span class="scenario-name">${row.period.name}</span>
              <span class="scenario-window">${row.period.start} ~ ${row.period.end}</span>
            </div>
            <p class="scenario-desc">${row.period.summary || ""}</p>
            ${
              row.insufficient
                ? `<p class="caption">该资产在此时期只有 ${row.points} 个数据点，无法计算。</p>`
                : `<div class="metrics" style="margin-top:0.6rem">
                    <div class="metric">
                      <div class="metric-label">区间收益</div>
                      <div class="metric-value ${tone(row.totalReturn)}">${pct(row.totalReturn)}</div>
                    </div>
                    <div class="metric">
                      <div class="metric-label">最大回撤</div>
                      <div class="metric-value neg">${pct(row.maxDrawdown)}</div>
                      <div class="metric-sub">${dateLabel(row.drawdownPeak)} → ${dateLabel(row.drawdownTrough)}</div>
                    </div>
                    <div class="metric">
                      <div class="metric-label">年化波动</div>
                      <div class="metric-value">${pct(row.volatility, { signed: false })}</div>
                    </div>
                  </div>`
            }
            ${row.period.lesson ? `<p class="why">${row.period.lesson}</p>` : ""}
          </div>`
          )
          .join("")}
      </div>`;

    const barLabels = all.map((row) => row.period.name.replace(/\s.*$/, ""));
    const barValues = all.map((row) => (row.insufficient ? 0 : row.totalReturn));
    barChart(document.getElementById("chart-periods"), {
      labels: barLabels,
      values: barValues,
      formatter: (v) => pct(v, { digits: 0 }),
      tipFormatter: (v) => pct(v),
      labelFormatter: (label) => label,
    });
  } catch (err) {
    if (local !== token) return;
    showError(host, err.message);
  }
}

function buildAssetSelect() {
  assetSelect(document.getElementById("history-asset"), {
    assets: state.assets,
    type: state.type,
    value: state.key,
    label: "选择资产",
    onChange: (key) => {
      state.key = key;
      render();
    },
  });
}

function defaultKeyFor(type) {
  const asset = state.assets.find((a) => a.type === type && a.status === "ok");
  return asset ? `${asset.type}:${asset.symbol}` : "";
}

async function main() {
  initShell({ active: "history" });
  try {
    const [assets, periods] = await Promise.all([
      loadIndex(),
      loadPeriods().catch(() => null),
    ]);
    state.assets = assets;
    state.periods = periods;

    const search = new URLSearchParams(location.search);
    state.type = search.get("type") || "index";
    const symbol = search.get("symbol");
    state.key = symbol ? `${state.type}:${symbol}` : defaultKeyFor(state.type);

    typeTabs(document.getElementById("history-type-tabs"), {
      value: state.type,
      onChange: (type) => {
        state.type = type;
        state.key = defaultKeyFor(type);
        buildAssetSelect();
        render();
      },
    });

    buildAssetSelect();
    render();
  } catch (err) {
    showError(document.getElementById("history-results"), `初始化失败：${err.message}`);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}