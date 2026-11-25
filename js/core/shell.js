/**
 * js/core/shell.js — 全站外壳：导航抽屉、主题切换、页脚与全局提示。
 *
 * 页面 HTML 里只需要：
 *   <mdui-top-app-bar>...静态标题与按钮...</mdui-top-app-bar>
 *   <div id="site-nav"></div>
 * 其余（抽屉、页脚）由本模块注入，避免 7 个页面重复同一段标记。
 */

import { icon } from "./icons.js";
import { loadMeta } from "./store.js";

const THEME_KEY = "investment-lab:theme";
const SCHEME_SEED = "#00695c"; // 深青绿：金融感的稳定色，Material You 会据此生成整套配色

export const NAV = [
  { id: "home", href: "index.html", label: "首页", icon: "home", desc: "全站概览" },
  { id: "learn", href: "learn.html", label: "投资课程", icon: "book", desc: "三级课程与测验" },
  { id: "analysis", href: "analysis.html", label: "资产分析", icon: "chart", desc: "单资产与多资产对比" },
  { id: "portfolio", href: "portfolio.html", label: "组合分析", icon: "pie", desc: "相关性/定投/压力测试" },
  { id: "history", href: "history.html", label: "历史时期", icon: "clock", desc: "关键市场窗口复盘" },
  { id: "calculator", href: "calculator.html", label: "投资计算器", icon: "calculator", desc: "复利/定投/回撤/再平衡" },
  { id: "data", href: "data.html", label: "数据状态", icon: "database", desc: "数据来源与质量" },
];

const md = () => (typeof window !== "undefined" ? window.mdui : undefined);

/* --------------------------------- 主题 ---------------------------------- */

let mduiReady = false;

function ensureMdui() {
  if (mduiReady) return;
  const api = md();
  if (!api) return;
  try {
    api.setColorScheme?.(SCHEME_SEED);
  } catch {
    /* 配色方案失败不影响可用性 */
  }
  mduiReady = true;
}

export function currentTheme() {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === "light" || stored === "dark") return stored;
  const prefersDark =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  return prefersDark ? "dark" : "light";
}

export function applyTheme(theme) {
  const root = document.documentElement;
  root.classList.remove("mdui-theme-light", "mdui-theme-dark");
  root.classList.add(`mdui-theme-${theme}`);
  root.style.colorScheme = theme;
  localStorage.setItem(THEME_KEY, theme);
  syncThemeIcon(theme);
  // 图表颜色来自 CSS 变量，主题切换后需要重绘
  window.dispatchEvent(new CustomEvent("il:theme", { detail: { theme } }));
}

function syncThemeIcon(theme) {
  const btn = document.getElementById("theme-toggle");
  if (!btn) return;
  const next = theme === "dark" ? "light" : "dark";
  // 图标本身由 CSS 依据主题类切换（见 app.css 的 .btn-theme 规则），
  // 这里只同步无障碍标签，避免依赖自定义元素的插槽重绘时机。
  btn.setAttribute("aria-label", next === "dark" ? "切换到深色主题" : "切换到浅色主题");
  btn.setAttribute("title", next === "dark" ? "切换到深色主题" : "切换到浅色主题");
}

export function toggleTheme() {
  applyTheme(currentTheme() === "dark" ? "light" : "dark");
}

/* --------------------------------- 抽屉 ---------------------------------- */

function renderDrawer(activeId) {
  const items = NAV.map(
    (item) => `
      <mdui-list-item
        href="${item.href}"
        ${item.id === activeId ? "active" : ""}
        headline="${item.label}"
        description="${item.desc}"
        rounded
      >
        <mdui-icon slot="icon">${icon(item.icon, { size: 22 })}</mdui-icon>
      </mdui-list-item>`
  ).join("");

  return `
    <mdui-navigation-drawer id="nav-drawer" modal close-on-esc close-on-overlay-click>
      <div class="nav-brand">
        <span class="brand-mark">${icon("spark", { size: 18 })}</span>
        <span class="brand-text">投资实验室<small>授人以渔，而不是授人以鱼</small></span>
      </div>
      <mdui-divider></mdui-divider>
      <mdui-list>${items}</mdui-list>
      <mdui-divider></mdui-divider>
      <div class="drawer-foot" id="drawer-foot">数据加载中…</div>
    </mdui-navigation-drawer>`;
}

/* --------------------------------- 页脚 ---------------------------------- */

function renderFooter() {
  return `
    <footer class="site-footer">
      <div class="notice" data-tone="info" style="margin-bottom:0.75rem">
        <span>
          <strong>免责声明：</strong>本站用于投资知识学习、历史数据分析与模拟研究，
          不构成投资、税务或法律建议。历史收益不代表未来收益，回测结果不代表未来实际表现。
        </span>
      </div>
      <p class="small muted center" style="margin:0">
        投资实验室 · 开源学习项目 ·
        <a href="https://github.com/angelky7/investment-lab" target="_blank" rel="noopener">GitHub</a>
      </p>
    </footer>`;
}

/* --------------------------------- 初始化 -------------------------------- */

/**
 * @param {{active?: string, title?: string}} [options]
 *   active 取 NAV 里的 id，用于高亮当前页。
 */
export function initShell(options = {}) {
  const { active = "" } = options;

  ensureMdui();
  applyTheme(currentTheme());

  const navHost = document.getElementById("site-nav");
  if (navHost && !document.getElementById("nav-drawer")) {
    navHost.innerHTML = renderDrawer(active);
  }

  const layoutMain = document.querySelector("mdui-layout-main") || document.body;
  if (!document.getElementById("site-footer")) {
    const holder = document.createElement("div");
    holder.id = "site-footer";
    holder.innerHTML = renderFooter();
    layoutMain.appendChild(holder);
  }

  const drawer = document.getElementById("nav-drawer");
  const openBtn = document.getElementById("nav-open");
  openBtn?.addEventListener("click", () => {
    if (drawer) drawer.open = true;
  });

  const themeBtn = document.getElementById("theme-toggle");
  themeBtn?.addEventListener("click", toggleTheme);
  syncThemeIcon(currentTheme());

  // 抽屉里的导航项被点击后自动关闭（SPA 式体验，但仍是真正的换页）
  drawer?.addEventListener("click", (event) => {
    const item = event.target.closest("mdui-list-item[href]");
    if (item) drawer.open = false;
  });

  // 页脚/抽屉里展示数据版本，让「数据有多新」始终可见
  loadMeta()
    .then((meta) => {
      const foot = document.getElementById("drawer-foot");
      if (!foot) return;
      const date = meta?.data_date || "未知";
      foot.innerHTML = `数据截止 ${date} · 共 ${meta?.total_assets ?? "?"} 项资产<br />数据源：腾讯行情 / 东方财富`;
    })
    .catch(() => {
      const foot = document.getElementById("drawer-foot");
      if (foot) foot.textContent = "数据信息加载失败";
    });

  return { theme: currentTheme() };
}

/* --------------------------------- 提示 ---------------------------------- */

/**
 * 轻提示。优先用 MDUI snackbar，不可用时退回控制台 + 页面内 toast。
 */
export function toast(message, options = {}) {
  const api = md();
  if (api?.snackbar) {
    try {
      api.snackbar({ message, placement: "bottom", ...options });
      return;
    } catch {
      /* 落到下面的兜底 */
    }
  }
  // eslint-disable-next-line no-console
  console.info(`[investment-lab] ${message}`);
}

/** 统一的错误展示：页面内联 + 轻提示 */
export function showError(container, message) {
  if (container) {
    container.innerHTML = `<div class="notice" data-tone="warn"><span><strong>出错了：</strong>${message}</span></div>`;
  }
  toast(message);
}

/** 载入态 */
export function loadingHtml(text = "正在加载数据…") {
  return `<div class="loading-state">
    <div class="spin">${icon("refresh", { size: 22 })}</div>
    <div>${text}</div>
  </div>`;
}