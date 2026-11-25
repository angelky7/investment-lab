/**
 * js/core/store.js — 数据访问层。
 *
 * 只做三件事：拼 URL、fetch、缓存。所有业务计算都在 stats/portfolio 里，
 * 这样界面代码不需要知道数据文件的具体格式。
 *
 * 缓存策略：
 * - 资产索引、元信息、时期配置在页面生命周期内缓存一次；
 * - 单个资产的历史序列按 key 缓存，重复分析同一资产不再请求；
 * - 请求 URL 带上 `v=<数据版本>`，数据更新后浏览器缓存自动失效。
 */

import { scaleDisplay } from "./series.js";

const BASE = "data";
const indexCache = new Map();

let assetsPromise = null;
let metaPromise = null;
let periodsPromise = null;

/** 数据版本号：取 meta.data_date，用于打穿浏览器缓存 */
let dataVersion = "";

async function fetchJson(path) {
  const url = dataVersion ? `${path}${path.includes("?") ? "&" : "?"}v=${dataVersion}` : path;
  const resp = await fetch(url, { cache: "default" });
  if (!resp.ok) throw new Error(`${path} 加载失败（HTTP ${resp.status}）`);
  return resp.json();
}

/** 数据版本（拿到 meta 之后才可用） */
export async function loadMeta() {
  if (!metaPromise) {
    metaPromise = fetchJson(`${BASE}/meta.json`)
      .then((meta) => {
        dataVersion = meta?.data_date ? String(meta.data_date).replace(/-/g, "") : "";
        return meta;
      })
      .catch((err) => {
        metaPromise = null;
        throw err;
      });
  }
  return metaPromise;
}

/** 资产索引（数组，按分组排序） */
export async function loadIndex() {
  if (!assetsPromise) {
    assetsPromise = Promise.all([fetchJson(`${BASE}/assets.json`), loadMeta().catch(() => null)])
      .then(([assets]) => assets)
      .catch((err) => {
        assetsPromise = null;
        throw err;
      });
  }
  return assetsPromise;
}

/** 历史时期与压力情景 */
export async function loadPeriods() {
  if (!periodsPromise) {
    periodsPromise = fetchJson(`${BASE}/periods.json`).catch((err) => {
      periodsPromise = null;
      throw err;
    });
  }
  return periodsPromise;
}

/** 资产唯一键：同代码的指数与股票要能区分（例如 000001） */
export function keyOf(asset) {
  return `${asset.type}:${asset.symbol}`;
}

export function findAsset(assets, key) {
  return assets.find((a) => keyOf(a) === key) || null;
}

/**
 * 加载单个资产的序列。
 * @param {{symbol: string, type: string, name: string}} asset
 * @returns {Promise<{key, symbol, name, type, group, currency, dates, prices,
 *   display, lastClose, priceBasis, source, start, end}>}
 */
export async function loadSeries(asset) {
  const key = keyOf(asset);
  if (indexCache.has(key)) return indexCache.get(key);

  const filename = `${asset.type}_${asset.symbol}.json`;
  const promise = fetchJson(`${BASE}/history/${filename}`)
    .then((payload) => {
      const dates = payload.dates || [];
      const prices = payload.prices || [];
      const lastClose = payload.last_close ?? null;
      return {
        key,
        symbol: asset.symbol,
        name: asset.name || payload.name || asset.symbol,
        type: asset.type,
        group: asset.group || payload.group || "",
        currency: asset.currency || payload.currency || "CNY",
        priceBasis: payload.price_basis || "",
        source: payload.source || "",
        start: payload.start || dates[0] || "",
        end: payload.end || dates[dates.length - 1] || "",
        count: dates.length,
        lastClose,
        dates,
        prices,
        // 展示价：按最新真实价折算，等价前复权
        display: scaleDisplay(prices, lastClose),
      };
    })
    .catch((err) => {
      indexCache.delete(key);
      throw err;
    });

  indexCache.set(key, promise);
  return promise;
}

/** 并行加载多个资产，失败的返回 null 而不是整体失败 */
export async function loadSeriesMany(assets) {
  const results = await Promise.all(
    assets.map((asset) => loadSeries(asset).catch(() => null))
  );
  return results.filter(Boolean);
}

/** 可用资产（status === 'ok'） */
export function usableAssets(assets) {
  return assets.filter((a) => a.status === "ok");
}

/** 按类型筛选 */
export function byType(assets, type) {
  return assets.filter((a) => a.type === type);
}

/** 按分组聚合，保持索引顺序 */
export function groupAssets(assets) {
  const groups = [];
  const map = new Map();
  for (const asset of assets) {
    const name = asset.group || "其他";
    if (!map.has(name)) {
      map.set(name, []);
      groups.push({ name, assets: map.get(name) });
    }
    map.get(name).push(asset);
  }
  return groups;
}

/** 搜索：代码、名称、分组都能匹配 */
export function searchAssets(assets, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return assets;
  return assets.filter((a) => {
    const haystack = `${a.symbol} ${a.name} ${a.group} ${a.type}`.toLowerCase();
    return haystack.includes(q);
  });
}

/** 预置缓存（测试或 SSR 场景） */
export function primeCache(key, value) {
  indexCache.set(key, Promise.resolve(value));
}

export function clearCache() {
  indexCache.clear();
  assetsPromise = null;
  metaPromise = null;
  periodsPromise = null;
  dataVersion = "";
}