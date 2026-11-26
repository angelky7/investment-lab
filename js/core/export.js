/**
 * js/core/export.js — 把站里的数据交出去。
 *
 * 这个站的核心主张是「别信我说的，你自己算」。但如果不能导出，
 * 这个主张就是空话——所以这里提供两样东西：
 *
 *   1. **CSV 导出**：日期 + 价格（+ 折算后的实际价格），Excel 可直接打开；
 *   2. **序列指纹**：对「日期:价格」串做 SHA-256，取前 12 位。
 *      任何人拿到同一个序列，算出来的指纹必须一致；不一致就说明有一方数据被改过。
 *
 * 指纹在浏览器里用 Web Crypto 计算；非安全上下文（http:// 非 localhost）拿不到
 * crypto.subtle，此时退化为 FNV-1a 并明确标注「弱校验」——不假装等价。
 */

/** FNV-1a 32 位（退化方案，只在没有 Web Crypto 时用） */
function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** 把序列压成待哈希的字符串：日期:价格，用 6 位小数统一格式 */
export function serializeSeries(dates, prices) {
  const parts = new Array(dates.length);
  for (let i = 0; i < dates.length; i += 1) {
    parts[i] = `${dates[i]}:${Number(prices[i]).toFixed(6)}`;
  }
  return parts.join("\n");
}

/**
 * 计算序列指纹。
 * @returns {Promise<{value: string, algorithm: "sha256" | "fnv1a", length: number}>}
 */
export async function fingerprint(dates, prices) {
  const text = serializeSeries(dates, prices);
  const bytes = new TextEncoder().encode(text);
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    try {
      const digest = await subtle.digest("SHA-256", bytes);
      const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
      return { value: hex.slice(0, 12), algorithm: "sha256", length: dates.length };
    } catch {
      /* 落到 FNV */
    }
  }
  return { value: fnv1a(text), algorithm: "fnv1a", length: dates.length };
}

/** 生成 CSV 文本（带 BOM，Excel 打开中文不乱码） */
export function buildCsv(columns, rows) {
  const escape = (value) => {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const header = columns.map((c) => escape(c.label)).join(",");
  const body = rows.map((row) => row.map(escape).join(",")).join("\n");
  return `\ufeff${header}\n${body}\n`;
}

/** 触发浏览器下载 */
export function downloadText(filename, text, mime = "text/csv;charset=utf-8") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * 把一条序列导出成 CSV：日期、名义价格、可选的折算后价格。
 * @param {{symbol:string, name:string, dates:string[], prices:number[],
 *   realPrices?:number[], realStart?:number}} series
 */
export function exportSeriesCsv(series) {
  const hasReal = Array.isArray(series.realPrices) && series.realPrices.length > 0;
  const columns = [{ label: "date" }, { label: "price" }];
  if (hasReal) columns.push({ label: "price_real" });

  const rows = [];
  if (hasReal) {
    const offset = series.realStart ?? 0;
    for (let i = 0; i < series.realPrices.length; i += 1) {
      rows.push([series.dates[offset + i], series.prices[offset + i], series.realPrices[i]]);
    }
  } else {
    for (let i = 0; i < series.dates.length; i += 1) {
      rows.push([series.dates[i], series.prices[i]]);
    }
  }

  const filename = `${series.symbol || series.name}-${series.dates[series.dates.length - 1]}.csv`;
  downloadText(filename, buildCsv(columns, rows));
  return { filename, rows: rows.length };
}