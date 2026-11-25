/**
 * js/pages/data.js — 数据状态页。
 *
 * 把 data/meta.json、data/quality.json、data/assets.json 三份产物摊给用户看：
 * 更新到哪天、每个市场的交易日历有多长、哪些资产存在缺口、缺的是哪几天。
 *
 * 这里刻意不粉饰：数据源确实有空洞（例如腾讯的纳斯达克100 在 2021-05 少了 10 天），
 * 与其藏起来，不如说清楚——统计分析里这些跨度过大的相邻点已经被剔除。
 */

import { initShell, showError } from "../core/shell.js";
import { loadIndex, loadMeta } from "../core/store.js";
import { metricsHtml, notice, tableHtml } from "../ui/cards.js";
import { count, dateLabel, num, pct } from "../core/format.js";

const MARKET_LABEL = { CN: "A 股", HK: "港股", US: "美股" };
const TYPE_LABEL = { index: "指数", etf: "ETF", stock: "股票", fund: "基金", fx: "汇率" };

async function loadQuality() {
  const resp = await fetch(`data/quality.json?v=${Date.now().toString(36)}`, { cache: "no-store" });
  if (!resp.ok) throw new Error(`quality.json HTTP ${resp.status}`);
  return resp.json();
}

function completenessChip(asset) {
  if (asset.status !== "ok") {
    return asset.status === "missing"
      ? `<span class="chip-bad">缺失</span>`
      : `<span class="chip-bad">损坏</span>`;
  }
  if (asset.completeness === "complete") return `<span class="chip-ok">完整</span>`;
  if (asset.completeness === "minor") return `<span class="chip-warn">轻微缺口</span>`;
  return `<span class="chip-bad">有缺口</span>`;
}

function renderSummary(meta, quality, assets) {
  const host = document.getElementById("data-summary");
  const totalPoints = assets.reduce((acc, a) => acc + (a.data_points || 0), 0);
  const earliest = assets
    .map((a) => a.data_start)
    .filter(Boolean)
    .sort()[0];
  const summary = quality?.summary || {};

  const items = [
    {
      label: "数据截止",
      value: dateLabel(meta?.data_date || quality?.data_date),
      sub: "最近一个交易日",
    },
    {
      label: "资产数量",
      value: `${count(meta?.total_assets ?? assets.length)} 项`,
      sub: `可用 ${count(meta?.available_assets ?? 0)} 项`,
    },
    { label: "记录总数", value: count(totalPoints), sub: `最早追溯至 ${earliest || "—"}` },
    {
      label: "完整对齐",
      value: `${count(summary.assets_complete ?? 0)} / ${count(summary.total ?? 0)} 项`,
      sub: `停牌型缺口 ${count(summary.assets_with_suspension_gaps ?? 0)} · 源端空洞 ${count(
        summary.assets_with_source_gaps ?? 0
      )}`,
    },
    {
      label: "校验结果",
      value: quality ? (summary.error_count === 0 ? "通过" : `${summary.error_count} 项错误`) : "—",
      sub: quality ? `${summary.warning_count} 条提醒` : "",
    },
    {
      label: "数据新鲜度",
      value: quality?.stale_days != null ? `${quality.stale_days} 天前` : "—",
      sub: quality?.stale_days > 3 ? "可能未按时更新" : "时效正常",
    },
  ];

  host.innerHTML = metricsHtml(items);
}

/** 各市场交易日历 */
function renderCalendars(quality) {
  const host = document.getElementById("data-calendars");
  if (!host) return;
  const calendars = quality?.calendars || {};
  const keys = Object.keys(calendars);
  if (!keys.length) {
    host.innerHTML = "";
    return;
  }

  host.innerHTML = `
    <div class="card">
      <div class="chart-head">
        <h3>交易日历</h3>
        <span class="hint">每个市场用自己的日历判断缺口，跨市场假期不算缺失</span>
      </div>
      <div class="stack" style="gap:.25rem">
        ${keys
          .map((market) => {
            const info = calendars[market];
            return `<div class="status-row">
              <span class="status-name">${MARKET_LABEL[market] || market}</span>
              <span class="small muted num">${count(info.days)} 个交易日 · ${info.start} ~ ${info.end}</span>
            </div>`;
          })
          .join("")}
      </div>
      <p class="caption">
        缺口判断方法：把资产自己的交易日与所属市场的日历比对，差出来的就是缺口。
        个股停牌、指数数据源空洞都会体现为缺口，但含义不同——下面的明细会区分。
      </p>
    </div>`;
}

/** 有缺口的资产明细 */
function renderGaps(quality) {
  const host = document.getElementById("data-gaps");
  if (!host) return;
  const assets = (quality?.assets || []).filter((a) => a.status === "ok");
  const withGaps = assets
    .filter((a) => (a.max_missing_run || 0) >= 3)
    .sort((a, b) => (b.max_missing_run || 0) - (a.max_missing_run || 0));

  if (!withGaps.length) {
    host.innerHTML = `<div class="card">${notice("所有资产在各自市场日历下都没有超过 3 个交易日的缺口。", "accent")}</div>`;
    return;
  }

  // gap_cause 由 validate.py 依据「市场 + 类型」判定，前端只负责翻译
  const CAUSE_LABEL = {
    suspension: "长期停牌（股改 / 重组 / 停牌潮），市场事实",
    source: "数据源空洞，源端本身没有这段数据",
  };

  host.innerHTML = `
    <div class="card">
      <div class="chart-head">
        <h3>缺口明细（按最长连续缺口排序）</h3>
        <span class="hint">${withGaps.length} 项资产存在 ≥3 个交易日的缺口</span>
      </div>
      ${tableHtml({
        columns: [
          { label: "资产", align: "left" },
          { label: "类型" },
          { label: "最长连续缺口" },
          { label: "缺失交易日" },
          { label: "缺口区间" },
          { label: "可能原因" },
        ],
        rows: withGaps.slice(0, 20).map((asset) => {
          const first = (asset.missing_runs || [])[0] || {};
          const ratio = asset.missing_ratio ?? 0;
          const reason = CAUSE_LABEL[asset.gap_cause] || "短时停牌或数据源空洞";
          return {
            cells: [
              { html: `<strong>${asset.name}</strong> <span class="muted small">${asset.symbol}</span>` },
              { html: TYPE_LABEL[asset.type] || asset.type },
              { html: `${asset.max_missing_run} 天`, cls: asset.max_missing_run >= 10 ? "pos" : "" },
              {
                html: `${asset.missing_trading_days} 天 · ${pct(ratio, { signed: false, digits: 2 })}`,
              },
              {
                html: first.from ? `${first.from} ~ ${first.to}` : "—",
                cls: "small",
              },
              { html: reason, cls: "small muted" },
            ],
          };
        }),
        caption:
          "「缺失交易日」只统计资产存续区间内的交易日。跨度过大的相邻点在统计时会被剔除，" +
          "所以缺口不会污染波动率、夏普比率与胜率。指数与 ETF 不存在停牌，它们的缺口来自数据源。",
      })}
    </div>`;
}

function renderGroups(assets, meta, quality) {
  const host = document.getElementById("data-groups");
  const groups = meta?.groups?.length ? meta.groups : [...new Set(assets.map((a) => a.group))];
  const qualityMap = new Map((quality?.assets || []).map((a) => [`${a.type}:${a.symbol}`, a]));

  host.innerHTML = groups
    .map((group) => {
      const list = assets.filter((a) => a.group === group);
      if (!list.length) return "";
      const total = list.reduce((acc, a) => acc + (a.data_points || 0), 0);
      return `
        <div class="card">
          <div class="chart-head">
            <h3>${group}</h3>
            <span class="hint">${list.length} 项 · ${count(total)} 条记录</span>
          </div>
          <div class="stack" style="gap:.25rem">
            ${list
              .map((asset) => {
                const q = qualityMap.get(`${asset.type}:${asset.symbol}`);
                return `
              <div class="status-row">
                <span class="status-name">${asset.name} <span class="muted small">${asset.symbol}</span></span>
                <span class="small muted num">${
                  asset.data_start ? `${asset.data_start} 起 · ${count(asset.data_points)} 条` : "无数据"
                }</span>
                ${completenessChip({ ...asset, completeness: q?.completeness })}
              </div>`;
              })
              .join("")}
          </div>
        </div>`;
    })
    .join("");
}

function renderTable(assets, quality) {
  const host = document.getElementById("data-table");
  const qualityMap = new Map((quality?.assets || []).map((a) => [`${a.type}:${a.symbol}`, a]));

  host.innerHTML = `<div class="card">${tableHtml({
    columns: [
      { label: "资产", align: "left" },
      { label: "代码" },
      { label: "类型" },
      { label: "起始" },
      { label: "截止" },
      { label: "记录数" },
      { label: "缺口" },
      { label: "状态" },
    ],
    rows: assets.map((asset) => {
      const q = qualityMap.get(`${asset.type}:${asset.symbol}`);
      const missing = q?.missing_trading_days;
      return {
        cells: [
          { html: `<strong>${asset.name}</strong>` },
          { html: asset.symbol },
          { html: TYPE_LABEL[asset.type] || asset.type },
          { html: asset.data_start || "—" },
          { html: asset.data_end || "—" },
          { html: count(asset.data_points) },
          {
            html:
              q == null
                ? "—"
                : missing === 0
                  ? "无"
                  : `${missing} 天`,
            cls: missing > 0 ? "pos" : "muted",
          },
          { html: completenessChip({ ...asset, completeness: q?.completeness }) },
        ],
      };
    }),
    caption:
      "「缺口」是相对该市场交易日历缺了多少个交易日；「状态」按缺失率分档：<0.5% 完整，<3% 轻微缺口，其余有缺口。",
  })}</div>`;
}

async function main() {
  initShell({ active: "data" });
  const host = document.getElementById("data-summary");

  try {
    const [assets, meta, quality] = await Promise.all([
      loadIndex(),
      loadMeta().catch(() => null),
      loadQuality().catch(() => null),
    ]);

    if (!assets.length) {
      host.innerHTML = notice("资产索引为空，说明构建步骤没有产出数据。", "warn");
      return;
    }

    renderSummary(meta, quality, assets);
    renderCalendars(quality);
    renderGaps(quality);
    renderGroups(assets, meta, quality);
    renderTable(assets, quality);
  } catch (err) {
    showError(host, `加载失败：${err.message}`);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}