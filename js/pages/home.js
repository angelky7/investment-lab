/**
 * js/pages/home.js — 首页。
 *
 * 首页只做一件事：给出一组「当下真实的数据事实」，让人相信后面那些页面是算出来的，
 * 而不是写死的文案。
 */

import { initShell, showError } from "../core/shell.js";
import { loadIndex, loadMeta, loadSeries } from "../core/store.js";
import { sliceLastYears } from "../core/series.js";
import { totalReturn } from "../core/stats.js";
import { metricsHtml } from "../ui/cards.js";
import { pct, price, tone, dateLabel, count } from "../core/format.js";

const HIGHLIGHTS = [
  { key: "index:000300", label: "沪深300", showPoints: true },
  { key: "index:us.INX", label: "标普500", showPoints: true },
  { key: "index:hkHSI", label: "恒生指数", showPoints: true },
  { key: "index:000510", label: "中证A500", showPoints: true },
  { key: "etf:518880", label: "黄金ETF", showPoints: false },
];

function parseKey(key) {
  const [type, ...rest] = key.split(":");
  return { type, symbol: rest.join(":"), key };
}

function oneYearReturn(series) {
  const { prices } = sliceLastYears(series.dates, series.prices, 1);
  if (prices.length < 2) return null;
  return totalReturn(prices);
}

async function renderStrip() {
  const host = document.getElementById("market-strip");
  if (!host) return;

  try {
    const [assets, meta] = await Promise.all([loadIndex(), loadMeta()]);

    const picked = HIGHLIGHTS.map((item) => {
      const target = parseKey(item.key);
      const asset = assets.find((a) => a.type === target.type && a.symbol === target.symbol);
      return asset ? { ...item, asset } : null;
    }).filter(Boolean);

    const seriesList = await Promise.all(
      picked.map((item) => loadSeries(item.asset).catch(() => null))
    );

    const cards = picked.map((item, index) => {
      const series = seriesList[index];
      if (!series) {
        return { label: item.label, value: "—", sub: "数据不可用" };
      }
      const yearReturn = oneYearReturn(series);
      const latest = series.lastClose ?? series.prices[series.prices.length - 1];
      return {
        label: item.label,
        value: item.showPoints ? price(latest) : pct(yearReturn),
        tone: item.showPoints ? "" : tone(yearReturn),
        sub: item.showPoints
          ? `近一年 ${pct(yearReturn)} · ${dateLabel(series.end)}`
          : `最新 ${price(latest)}`,
      };
    });

    const facts = meta
      ? {
          label: "数据覆盖",
          value: `${count(meta.total_assets)} 项`,
          sub: `截止 ${dateLabel(meta.data_date)} · 每日自动更新`,
        }
      : null;

    host.innerHTML = metricsHtml([...cards, ...(facts ? [facts] : [])]);
  } catch (err) {
    showError(host, `首页数据加载失败：${err.message}`);
  }
}

function main() {
  initShell({ active: "home" });
  renderStrip();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}