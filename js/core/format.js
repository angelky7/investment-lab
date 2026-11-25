/**
 * js/core/format.js — 数字、日期与文本格式化。
 *
 * 约定（面向中文用户）：
 * - 涨用红色、跌用绿色，与国内行情软件一致；
 * - 缺失值统一显示为「—」，不显示 0，避免把「无数据」误读成「零收益」；
 * - 所有百分比默认保留两位小数并带正负号。
 */

const DASH = "—";

/** 百分比：v 为小数（0.1234 → +12.34%） */
export function pct(v, { digits = 2, signed = true, dash = DASH } = {}) {
  if (!Number.isFinite(v)) return dash;
  const sign = signed && v > 0 ? "+" : "";
  return `${sign}${(v * 100).toFixed(digits)}%`;
}

/** 百分点形式：v 已经是 12.34 这种数值 */
export function pctPoint(v, { digits = 2, signed = true, dash = DASH } = {}) {
  if (!Number.isFinite(v)) return dash;
  const sign = signed && v > 0 ? "+" : "";
  return `${sign}${v.toFixed(digits)}%`;
}

/** 普通数字 */
export function num(v, { digits = 2, dash = DASH } = {}) {
  if (!Number.isFinite(v)) return dash;
  return v.toFixed(digits);
}

/** 金额，默认取整并加千分位 */
export function money(v, { digits = 0, symbol = "¥", dash = DASH } = {}) {
  if (!Number.isFinite(v)) return dash;
  return (
    symbol +
    v.toLocaleString("zh-CN", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })
  );
}

/** 指数点位 / 价格，自动选择小数位 */
export function price(v, { dash = DASH } = {}) {
  if (!Number.isFinite(v)) return dash;
  const digits = Math.abs(v) >= 1000 ? 1 : Math.abs(v) >= 10 ? 2 : 3;
  return v.toLocaleString("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** 天数，超过一年换成「x.x 年」 */
export function duration(days, { dash = DASH } = {}) {
  if (!Number.isFinite(days)) return dash;
  if (days < 400) return `${Math.round(days)} 天`;
  return `${(days / 365.25).toFixed(1)} 年`;
}

/** "2024-09-30" → "2024/09/30" */
export function dateLabel(iso) {
  if (typeof iso !== "string" || iso.length < 10) return String(iso ?? DASH);
  return `${iso.slice(0, 4)}/${iso.slice(5, 7)}/${iso.slice(8, 10)}`;
}

/** "2024-09-30" → "2024/09"，用于坐标轴 */
export function monthLabel(iso) {
  if (typeof iso !== "string" || iso.length < 7) return String(iso ?? DASH);
  return `${iso.slice(0, 4)}/${iso.slice(5, 7)}`;
}

/** 区间文本 */
export function rangeLabel(start, end) {
  if (!start || !end) return DASH;
  return `${dateLabel(start)} – ${dateLabel(end)}`;
}

/** 涨跌语义 class：正 → pos（红），负 → neg（绿） */
export function tone(v) {
  if (!Number.isFinite(v) || v === 0) return "";
  return v > 0 ? "pos" : "neg";
}

/** 安全注入 HTML 文本 */
export function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]
  );
}

/** 类型中文名 */
export const TYPE_LABEL = {
  index: "指数",
  etf: "ETF",
  stock: "股票",
  fund: "基金",
  fx: "汇率",
};

export function typeLabel(type) {
  return TYPE_LABEL[type] || type || DASH;
}

/** 千分位整数 */
export function count(n, { dash = DASH } = {}) {
  if (!Number.isFinite(n)) return dash;
  return Math.round(n).toLocaleString("zh-CN");
}

export { DASH };