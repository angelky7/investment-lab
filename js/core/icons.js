/**
 * js/core/icons.js — 内联 SVG 图标（24×24，描边风格）。
 *
 * 刻意不引入 Material Symbols 字体：那需要在运行时从 Google Fonts 拉
 * 数百 KB 字体，国内网络常常加载失败，还会造成首屏图标闪烁。
 * 这里用少量手写描边路径，体积可忽略，且能 100% 离线渲染。
 */

const PATHS = {
  menu: "M3.5 6h17M3.5 12h17M3.5 18h17",
  close: "M6 6l12 12M18 6L6 18",
  moon: "M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7z",
  sun: "M12 7.6A4.4 4.4 0 1 0 12 16.4a4.4 4.4 0 0 0 0-8.8zM12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4",
  home: "M4 10.8L12 4l8 6.8V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z",
  book: "M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5zM9 7h7M9 10.5h5",
  chart: "M4 20V4M4 20h16M7.5 15.5l3.5-4.5 3 2.8 4.5-6.3",
  pie: "M12 3a9 9 0 1 0 9 9h-9zM14.5 2.6A9 9 0 0 1 21.4 9.5H14.5z",
  calculator:
    "M6.5 3h11a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM8.5 7h7M8.5 11.5h1.5M12 11.5h1.5M15.5 11.5h1.5M8.5 15h1.5M12 15h1.5M15.5 15h1.5M8.5 18.3h1.5M12 18.3h1.5",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7.5V12l3.2 2",
  database:
    "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6",
  chevron: "M9 6l6 6-6 6",
  info: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v5.5M12 7.8v.6",
  warn: "M12 3.6l8.5 15.2H3.5zM12 9.6v4.4M12 16.6v.6",
  refresh: "M4.5 12a7.5 7.5 0 0 1 12.6-5.5L20 9M19.5 12a7.5 7.5 0 0 1-12.6 5.5L4 15M20 4v5h-5M4 20v-5h5",
  download: "M12 3.5v11M7.5 10.5L12 15l4.5-4.5M4.5 19.5h15",
  search: "M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM15.2 15.2L20 20",
  spark: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z",
  flag: "M6 20V4M6 4h10l-1.5 3.5L16 11H6",
  check: "M5 12.8l4.3 4.2L19 6.5",
  arrow: "M12 19V5M6 11l6-6 6 6",
};

/**
 * 生成图标 HTML。
 * @param {keyof typeof PATHS} name
 * @param {{size?: number, cls?: string, strokeWidth?: number}} [options]
 */
export function icon(name, options = {}) {
  const { size = 20, cls = "", strokeWidth = 1.7 } = options;
  const d = PATHS[name];
  if (!d) return "";
  return `<svg class="icon ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24"
    fill="none" stroke="currentColor" stroke-width="${strokeWidth}"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
    focusable="false"><path d="${d}"/></svg>`;
}

/** 直接返回 SVG 元素（用于需要 appending 的场景） */
export function iconNode(name, options = {}) {
  const wrapper = document.createElement("span");
  wrapper.innerHTML = icon(name, options);
  return wrapper.firstElementChild;
}

export { PATHS as ICON_PATHS };