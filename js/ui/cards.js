/**
 * js/ui/cards.js — 指标卡与表格渲染。
 *
 * 只负责把已经算好的数字摆到页面上，不做任何计算，
 * 这样计算逻辑可以单独测试，界面调整不会引入数值错误。
 */

import { escapeHtml, num, pct, tone } from "../core/format.js";

/**
 * 指标卡网格。
 * @param {{label: string, value: string, tone?: 'pos'|'neg'|'', sub?: string,
 *   hint?: string}[]} items
 */
export function metricsHtml(items) {
  return `<div class="metrics">${items
    .map(
      (item) => `
      <div class="metric">
        <div class="metric-label">${escapeHtml(item.label)}</div>
        <div class="metric-value ${item.tone || ""}">${item.value}</div>
        ${
          item.sub
            ? `<div class="metric-sub">${escapeHtml(item.sub)}</div>`
            : ""
        }
      </div>`
    )
    .join("")}</div>`;
}

/** 百分比指标卡（自动红绿） */
export function pctMetric(label, value, sub = "") {
  return {
    label,
    value: pct(value),
    tone: tone(value),
    sub,
  };
}

/** 数字指标卡 */
export function numMetric(label, value, digits = 2, sub = "") {
  return { label, value: num(value, { digits }), sub };
}

/**
 * 表格。
 * @param {{columns: {label: string, align?: 'left'|'right'}[],
 *   rows: {cells: (string|{html: string, cls?: string})[]}[], caption?: string}} config
 */
export function tableHtml(config) {
  const { columns = [], rows = [], caption = "" } = config;
  const head = columns
    .map((c) => `<th style="text-align:${c.align || "right"}">${escapeHtml(c.label)}</th>`)
    .join("");
  const body = rows
    .map((row) => {
      const cells = row.cells
        .map((cell, i) => {
          const align = columns[i]?.align || "right";
          if (typeof cell === "string") {
            return `<td style="text-align:${align}">${cell}</td>`;
          }
          return `<td class="${cell.cls || ""}" style="text-align:${align}">${cell.html}</td>`;
        })
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");
  return `
    <div class="tbl-wrap">
      <table class="tbl">
        <thead><tr>${head}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    ${caption ? `<p class="caption">${caption}</p>` : ""}`;
}

/** 章节标题 */
export function sectionTitle(title, desc = "") {
  return `<h2 class="section-title">${escapeHtml(title)}</h2>${
    desc ? `<p class="section-desc">${desc}</p>` : ""
  }`;
}

/** 提示条 */
export function notice(text, tone = "info") {
  return `<div class="notice" data-tone="${tone}"><span>${text}</span></div>`;
}