/**
 * js/pages/data.js — 数据状态页。
 *
 * 把 data/meta.json、data/quality.json、data/assets.json 三份产物直接摊给用户看：
 * 更新到哪天、多少项可用、有哪些断档、校验有没有报错。
 */

import { initShell, showError } from "../core/shell.js";
import { loadIndex, loadMeta } from "../core/store.js";
import { metricsHtml, notice, tableHtml } from "../ui/cards.js";
import { count, dateLabel, num, pct } from "../core/format.js";

async function loadQuality() {
  const resp = await fetch(`data/quality.json?v=${Date.now().toString(36)}`, { cache: "no-store" });
  if (!resp.ok) throw new Error(`quality.json HTTP ${resp.status}`);
  return resp.json();
}

function statusChip(status) {
  if (status === "ok") return `<span class="chip-ok">可用</span>`;
  if (status === "insufficient") return `<span class="chip-warn">数据偏少</span>`;
  return `<span class="chip-bad">缺失</span>`;
}

function renderSummary(meta, quality, assets) {
  const host = document.getElementById("data-summary");
  const totalPoints = assets.reduce((acc, a) => acc + (a.data_points || 0), 0);
  const earliest = assets
    .map((a) => a.data_start)
    .filter(Boolean)
    .sort()[0];

  const items = [
    { label: "数据截止", value: dateLabel(meta?.data_date || quality?.data_date), sub: "最近一个交易日" },
    {
      label: "资产数量",
      value: `${count(meta?.total_assets ?? assets.length)} 项`,
      sub: `可用 ${count(meta?.available_assets ?? 0)} 项`,
    },
    {
      label: "记录总数",
      value: count(totalPoints),
      sub: `最早追溯至 ${earliest || "—"}`,
    },
    {
      label: "校验结果",
      value: quality ? (quality.summary.error_count === 0 ? "通过" : `${quality.summary.error_count} 项错误`) : "—",
      sub: quality ? `${quality.summary.warning_count} 条提醒` : "",
    },
    {
      label: "数据新鲜度",
      value: quality?.stale_days != null ? `${quality.stale_days} 天前` : "—",
      sub: quality?.stale_days > 3 ? "可能未按时更新" : "时效正常",
    },
    {
      label: "更新频率",
      value: "每交易日",
      sub: "GitHub Actions 自动抓取",
    },
  ];

  const warnings = quality?.warnings || [];
  host.innerHTML = `
    ${metricsHtml(items)}
    ${
      warnings.length
        ? notice(
            `<strong>数据提醒（${warnings.length}）：</strong>${warnings
              .slice(0, 6)
              .map((w) => String(w).replace(/[<>]/g, ""))
              .join("；")}${warnings.length > 6 ? " …" : ""}`,
            "info"
          )
        : ""
    }`;
}

function renderGroups(assets, meta) {
  const host = document.getElementById("data-groups");
  const groups = meta?.groups?.length
    ? meta.groups
    : [...new Set(assets.map((a) => a.group))];

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
              .map(
                (a) => `
              <div class="status-row">
                <span class="status-name">${a.name} <span class="muted small">${a.symbol}</span></span>
                <span class="small muted">${
                  a.data_start ? `${a.data_start} 起 · ${count(a.data_points)} 条` : "无数据"
                }</span>
                ${statusChip(a.status)}
              </div>`
              )
              .join("")}
          </div>
        </div>`;
    })
    .join("");
}

function renderTable(assets, quality) {
  const host = document.getElementById("data-table");
  const qualityMap = new Map((quality?.assets || []).map((item) => [item.symbol, item]));

  host.innerHTML = `<div class="card">${tableHtml({
    columns: [
      { label: "资产", align: "left" },
      { label: "代码" },
      { label: "类型" },
      { label: "起始" },
      { label: "截止" },
      { label: "记录数" },
      { label: "断档提醒" },
      { label: "状态" },
    ],
    rows: assets.map((a) => {
      const q = qualityMap.get(a.symbol);
      return {
        cells: [
          { html: `<strong>${a.name}</strong>` },
          { html: a.symbol },
          { html: a.type },
          { html: a.data_start || "—" },
          { html: a.data_end || "—" },
          { html: count(a.data_points) },
          { html: q?.gap_count ? `${q.gap_count} 处` : "—", cls: q?.gap_count ? "pos" : "muted" },
          { html: statusChip(a.status) },
        ],
      };
    }),
    caption:
      "「断档」指相邻两个数据点之间超过 20 个自然日，多数来自个股停牌或长假，属于正常现象。",
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
    renderGroups(assets, meta);
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