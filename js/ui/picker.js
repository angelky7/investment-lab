/**
 * js/ui/picker.js — 资产选择控件（MDUI 组件 + 少量增强）。
 *
 * 三种形态：
 * 1. typeTabs    —— 指数 / ETF / 股票 / 基金 切换（mdui-tabs）
 * 2. assetSelect —— 单资产下拉（mdui-select）
 * 3. checklist   —— 可搜索的多选清单（用于对比、相关性、组合）
 */

import { icon } from "../core/icons.js";
import { typeLabel, escapeHtml } from "../core/format.js";
import { searchAssets, usableAssets } from "../core/store.js";

const TYPES = ["index", "etf", "stock", "fund", "fx"];

/** 类型切换标签 */
export function typeTabs(host, { value = "index", onChange, types = TYPES } = {}) {
  if (!host) return null;
  host.innerHTML = `
    <mdui-tabs value="${value}" variant="secondary">
      ${types
        .map(
          (t) =>
            `<mdui-tab value="${t}" style="min-width:auto">${typeLabel(t)}</mdui-tab>`
        )
        .join("")}
    </mdui-tabs>`;
  const tabs = host.querySelector("mdui-tabs");
  tabs.addEventListener("change", () => onChange?.(tabs.value));
  return tabs;
}

/**
 * 单资产下拉。
 * @param {HTMLElement} host
 * @param {{assets: any[], type?: string, value?: string, onChange?: Function,
 *   label?: string, placeholder?: string}} options
 */
export function assetSelect(host, options = {}) {
  if (!host) return null;
  const { assets = [], type = "", value = "", onChange, label = "选择资产" } = options;
  const list = usableAssets(type ? assets.filter((a) => a.type === type) : assets);

  host.innerHTML = `
    <mdui-select
      id="asset-select"
      variant="outlined"
      label="${label}"
      placeholder="请选择"
      style="width:100%"
    >
      ${list
        .map(
          (a) =>
            `<mdui-menu-item value="${escapeHtml(a.type)}:${escapeHtml(a.symbol)}">${
              escapeHtml(a.name)
            } · ${escapeHtml(a.symbol)}</mdui-menu-item>`
        )
        .join("")}
    </mdui-select>`;

  const select = host.querySelector("mdui-select");
  if (value) select.value = value;
  else if (list.length) select.value = `${list[0].type}:${list[0].symbol}`;
  select.addEventListener("change", () => onChange?.(select.value, findAsset(assets, select.value)));
  // 首次回调，保证界面与默认选中项一致
  queueMicrotask(() => onChange?.(select.value, findAsset(assets, select.value)));
  return select;
}

export function findAsset(assets, key) {
  if (!key) return null;
  const [type, ...rest] = key.split(":");
  const symbol = rest.join(":");
  return assets.find((a) => a.type === type && a.symbol === symbol) || null;
}

/**
 * 可搜索多选清单。
 *
 * @param {HTMLElement} host
 * @param {{assets: any[], selected?: string[], max?: number,
 *   onChange?: (keys: string[]) => void,
 *   filters?: string[], placeholder?: string}} options
 */
export function checklist(host, options = {}) {
  if (!host) return null;
  const {
    assets = [],
    selected = [],
    max = 8,
    onChange,
    filters = TYPES,
    placeholder = "搜索名称或代码",
  } = options;

  const chosen = new Set(selected);
  const state = { query: "", type: filters.length === 1 ? filters[0] : "all" };

  host.innerHTML = `
    <div class="row" style="align-items:center;margin-bottom:0.65rem">
      <mdui-text-field
        id="pick-search"
        variant="outlined"
        placeholder="${placeholder}"
        clearable
        style="flex:1 1 12rem;min-width:9rem"
      >
        <mdui-icon slot="icon">${icon("search", { size: 18 })}</mdui-icon>
      </mdui-text-field>
      ${
        filters.length > 1
          ? `<mdui-tabs id="pick-tabs" value="all" variant="secondary" style="flex:0 0 auto">
              <mdui-tab value="all" style="min-width:auto">全部</mdui-tab>
              ${filters
                .map((t) => `<mdui-tab value="${t}" style="min-width:auto">${typeLabel(t)}</mdui-tab>`)
                .join("")}
            </mdui-tabs>`
          : ""
      }
    </div>
    <div class="pick-count small muted" id="pick-count"></div>
    <div class="pick-list" id="pick-list"></div>`;

  const listEl = host.querySelector("#pick-list");
  const countEl = host.querySelector("#pick-count");
  const searchEl = host.querySelector("#pick-search");
  const tabsEl = host.querySelector("#pick-tabs");

  const emit = () => onChange?.([...chosen]);

  function render() {
    let pool = usableAssets(assets);
    if (state.type !== "all") pool = pool.filter((a) => a.type === state.type);
    pool = searchAssets(pool, state.query);

    countEl.textContent = `已选 ${chosen.size} 项${max ? `，最多 ${max} 项` : ""}`;
    if (!pool.length) {
      listEl.innerHTML = `<div class="small muted center" style="padding:1.25rem">没有匹配的资产</div>`;
      return;
    }

    listEl.innerHTML = pool
      .map((a) => {
        const key = `${a.type}:${a.symbol}`;
        const checked = chosen.has(key);
        const disabled = !checked && max && chosen.size >= max;
        return `
        <label class="pick-item ${checked ? "on" : ""} ${disabled ? "dis" : ""}">
          <input type="checkbox" value="${escapeHtml(key)}" ${checked ? "checked" : ""} ${
            disabled ? "disabled" : ""
          } />
          <span class="pick-name">${escapeHtml(a.name)}</span>
          <span class="pick-meta">${escapeHtml(a.symbol)} · ${
            a.data_start ? a.data_start.slice(0, 7) : "—"
          } 起</span>
        </label>`;
      })
      .join("");
  }

  listEl.addEventListener("change", (event) => {
    const input = event.target.closest("input[type=checkbox]");
    if (!input) return;
    if (input.checked) {
      if (max && chosen.size >= max) {
        input.checked = false;
        return;
      }
      chosen.add(input.value);
    } else {
      chosen.delete(input.value);
    }
    render();
    emit();
  });

  searchEl?.addEventListener("input", () => {
    state.query = searchEl.value || "";
    render();
  });

  tabsEl?.addEventListener("change", () => {
    state.type = tabsEl.value;
    render();
  });

  render();

  return {
    get value() {
      return [...chosen];
    },
    set value(keys) {
      chosen.clear();
      (keys || []).forEach((k) => chosen.add(k));
      render();
      emit();
    },
  };
}

/** 权重输入行（用于组合权重） */
export function weightRows(host, { keys, weights, onChange } = {}) {
  if (!host) return null;
  const list = keys || [];
  const initial = weights || list.map(() => Math.round((1 / Math.max(1, list.length)) * 100));

  const render = () => {
    const total = initial.reduce((a, b) => a + (Number(b) || 0), 0);
    host.innerHTML = `
      ${list
        .map(
          (item, i) => `
        <div class="weight-row">
          <span class="weight-name">${escapeHtml(item.name)}</span>
          <mdui-text-field
            data-index="${i}"
            type="number"
            min="0"
            max="100"
            step="5"
            value="${initial[i]}"
            suffix="%"
            variant="outlined"
            style="width:7rem"
          ></mdui-text-field>
        </div>`
        )
        .join("")}
      <div class="small ${total === 100 ? "muted" : "pos"}" style="padding-top:0.35rem">
        合计 ${total}%${total === 100 ? "" : "（需要等于 100%）"}
      </div>`;
    host.querySelectorAll("mdui-text-field").forEach((field) => {
      field.addEventListener("input", () => {
        initial[Number(field.dataset.index)] = Number(field.value) || 0;
        onChange?.(initial.slice());
        const totalNow = initial.reduce((a, b) => a + (Number(b) || 0), 0);
        const info = host.querySelector(".weight-row + .small, div.small");
        if (info) {
          info.textContent = `合计 ${totalNow}%${totalNow === 100 ? "" : "（需要等于 100%）"}`;
          info.className = `small ${totalNow === 100 ? "muted" : "pos"}`;
        }
      });
    });
  };
  render();

  return {
    get value() {
      return initial.slice();
    },
    set keys(next) {
      list.length = 0;
      (next || []).forEach((k) => list.push(k));
      initial.length = 0;
      list.forEach(() => initial.push(Math.round(100 / Math.max(1, list.length))));
      render();
      onChange?.(initial.slice());
    },
  };
}
/** 统计区间选择（近 1/3/5/10 年、全部） */
// 标签刻意用短词：5 个中文标签在 390px 竖屏上放不下「近 X 年」的写法
export const RANGES = [
  { value: "1", label: "1 年", years: 1 },
  { value: "3", label: "3 年", years: 3 },
  { value: "5", label: "5 年", years: 5 },
  { value: "10", label: "10 年", years: 10 },
  { value: "all", label: "全部", years: Infinity },
];

export function yearsOf(rangeValue) {
  const found = RANGES.find((r) => r.value === rangeValue);
  return found ? found.years : Infinity;
}

export function rangeTabs(host, { value = "5", onChange } = {}) {
  if (!host) return null;
  host.innerHTML = `
    <mdui-tabs value="${value}" variant="secondary" style="min-width:auto">
      ${RANGES.map(
        (r) => `<mdui-tab value="${r.value}" style="min-width:auto;padding:0 .62rem">${r.label}</mdui-tab>`
      ).join("")}
    </mdui-tabs>`;
  const tabs = host.querySelector("mdui-tabs");
  tabs.addEventListener("change", () => onChange?.(tabs.value));
  return tabs;
}
