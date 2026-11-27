/**
 * js/core/charts.js — 轻量 Canvas 图表引擎（零依赖）。
 *
 * 特性：
 * - 自动适配 devicePixelRatio 与容器尺寸变化（ResizeObserver）；
 * - 颜色全部取 CSS 变量，跟随 MDUI 明暗主题（监听 il:theme 事件重绘）；
 * - 指针悬停/触摸显示十字线与数值气泡；
 * - 大数据量按像素宽度降采样，5000 个点也不会卡。
 *
 * 有意保持「零依赖」：不引入图表库，首屏不必多下载几百 KB。
 */

import { downsampleIndices } from "./series.js";

const PALETTE = [
  "--il-chart-1",
  "--il-chart-2",
  "--il-chart-3",
  "--il-chart-4",
  "--il-chart-5",
  "--il-chart-6",
];

const FONT = '11px system-ui, -apple-system, "PingFang SC", sans-serif';

function cssVar(name, fallback = "#888") {
  if (typeof getComputedStyle !== "function") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name);
  return value && value.trim() ? value.trim() : fallback;
}

export function paletteColor(index) {
  return cssVar(PALETTE[index % PALETTE.length]);
}

/**
 * 把 "var(--il-chart-1)" 这类 CSS 变量引用解析成真实颜色。
 * Canvas 的渐变与描边只接受具体颜色值，不认 var()，所以必须在使用前解析。
 */
export function resolveColor(color, fallback = "#666") {
  if (typeof color !== "string") return fallback;
  const match = /^var\(\s*(--[\w-]+)/.exec(color.trim());
  if (!match) return color;
  return cssVar(match[1], fallback);
}

/** 计算「好看」的刻度：1 / 2 / 2.5 / 5 × 10^n */
export function niceTicks(min, max, count = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1, ticks: [0, 1] };
  if (min === max) {
    const pad = Math.abs(min) * 0.1 || 1;
    min -= pad;
    max += pad;
  }
  const span = max - min;
  const rawStep = span / count;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / magnitude;
  let step;
  if (norm <= 1) step = magnitude;
  else if (norm <= 2) step = 2 * magnitude;
  else if (norm <= 2.5) step = 2.5 * magnitude;
  else if (norm <= 5) step = 5 * magnitude;
  else step = 10 * magnitude;

  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = niceMin; v <= niceMax + step * 0.5; v += step) {
    ticks.push(Number(v.toFixed(10)));
  }
  return { min: niceMin, max: niceMax, ticks };
}

export function withAlpha(color, alpha) {
  const value = String(color || "").trim();
  if (value.startsWith("#")) {
    const hex = value.slice(1);
    const full =
      hex.length === 3
        ? hex
            .split("")
            .map((c) => c + c)
            .join("")
        : hex;
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    if ([r, g, b].some((n) => Number.isNaN(n))) return value;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  if (/^rgba?\(/i.test(value)) {
    return value.replace(/^rgba?\(([^)]+)\)$/i, (_, inner) => {
      const parts = inner.split(",").map((p) => p.trim());
      return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${alpha})`;
    });
  }
  return value;
}

/** roundRect 的兼容实现（Safari < 16.4 没有 Path2D.roundRect） */
function roundedRect(ctx, x, y, w, h, radii) {
  const [tl, tr, br, bl] = Array.isArray(radii) ? radii : [radii, radii, radii, radii];
  const r = (v) => Math.max(0, Math.min(v, Math.min(w, h) / 2));
  const a = r(tl);
  const b = r(tr);
  const c = r(br);
  const d = r(bl);
  ctx.beginPath();
  ctx.moveTo(x + a, y);
  ctx.lineTo(x + w - b, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + b);
  ctx.lineTo(x + w, y + h - c);
  ctx.quadraticCurveTo(x + w, y + h, x + w - c, y + h);
  ctx.lineTo(x + d, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - d);
  ctx.lineTo(x, y + a);
  ctx.quadraticCurveTo(x, y, x + a, y);
  ctx.closePath();
}

class CanvasChart {
  constructor(host) {
    this.host = host;
    host.classList.add("chart");
    this.canvas = document.createElement("canvas");
    // 无障碍：canvas 对读屏软件是不可见文本，至少给出角色与一句说明
    this.canvas.setAttribute("role", "img");
    this.canvas.setAttribute(
      "aria-label",
      "数据图表（可用鼠标悬停或用键盘方向键查看具体数值）"
    );

    this.tip = document.createElement("div");
    this.tip.className = "chart-tip";
    host.append(this.canvas, this.tip);
    this.ctx = this.canvas.getContext ? this.canvas.getContext("2d") : null;
    this.state = null;
    this.hoverIndex = null;
    // 视窗（缩放/平移）：[from, to] 为索引区间，null 表示全览
    this.view = null;
    this.onViewChange = null;
    this.width = 0;
    this.height = 0;

    this.handleResize = () => this.resize();
    if (typeof ResizeObserver === "function") {
      this.observer = new ResizeObserver(this.handleResize);
      this.observer.observe(host);
    } else if (typeof window !== "undefined") {
      window.addEventListener("resize", this.handleResize);
    }
    this.handleTheme = () => this.draw();
    if (typeof window !== "undefined") {
      window.addEventListener("il:theme", this.handleTheme);
    }

    this.onPointerMove = (event) => this.pointerMove(event);
    this.onPointerLeave = () => {
      this.hoverIndex = null;
      this.tip.classList.remove("show");
      this.draw();
    };
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerdown", this.onPointerMove);
    this.canvas.addEventListener("pointerleave", this.onPointerLeave);
    this.canvas.addEventListener("pointercancel", this.onPointerLeave);

    this.resize();
  }

  setState(state) {
    this.state = state;
    // 有名字的图表就把名字写进 aria-label，读屏软件才知道这是什么图
    const label = state?.ariaLabel || state?.name || state?.title;
    if (label) this.canvas.setAttribute("aria-label", `${label}（数据图表）`);
    this.draw();
  }

  /** 设置可见区间（索引），null 表示全览 */
  setView(from, to) {
    const count = this.state?.labels?.length || 0;
    if (!count) return;
    if (from === null || to === null) {
      this.view = null;
    } else {
      let a = Math.max(0, Math.min(Math.floor(from), count - 2));
      let b = Math.min(count - 1, Math.max(Math.ceil(to), a + 1));
      // 太窄就没意义（至少留 5 个点）
      if (b - a < 4) {
        if (a + 4 <= count - 1) b = a + 4;
        else {
          b = count - 1;
          a = Math.max(0, b - 4);
        }
      }
      this.view = [a, b];
    }
    this.hoverIndex = null;
    this.draw();
    this.onViewChange?.(this.view ? [this.view[0], this.view[1], count] : null);
  }

  /** 以中心点缩放，factor > 1 放大 */
  zoomBy(factor, centerIndex = null) {
    const count = this.state?.labels?.length || 0;
    if (!count) return;
    const [from, to] = this.view || [0, count - 1];
    const span = to - from;
    const center = centerIndex ?? (from + to) / 2;
    const nextSpan = Math.max(4, Math.min(count - 1, Math.round(span / factor)));
    const ratio = (center - from) / (span || 1);
    let a = Math.round(center - nextSpan * ratio);
    let b = a + nextSpan;
    if (a < 0) {
      a = 0;
      b = nextSpan;
    }
    if (b > count - 1) {
      b = count - 1;
      a = Math.max(0, b - nextSpan);
    }
    this.setView(a, b);
  }

  /** 平移，delta 为索引数 */
  panBy(delta) {
    const count = this.state?.labels?.length || 0;
    if (!count) return;
    const [from, to] = this.view || [0, count - 1];
    const span = to - from;
    let a = Math.round(from + delta);
    let b = a + span;
    if (a < 0) {
      a = 0;
      b = span;
    }
    if (b > count - 1) {
      b = count - 1;
      a = Math.max(0, b - span);
    }
    this.setView(a, b);
  }

  /** 当前视窗（供外部显示） */
  getView() {
    const count = this.state?.labels?.length || 0;
    return this.view ? [this.view[0], this.view[1], count] : [0, Math.max(0, count - 1), count];
  }

  resize() {
    if (!this.ctx) return;
    const rect = this.host.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  plotBox() {
    const left = this.state?.leftPad ?? 48;
    return {
      left,
      top: 12,
      right: this.width - 10,
      bottom: this.height - 24,
      width: Math.max(1, this.width - left - 10),
      height: Math.max(1, this.height - 36),
    };
  }

  xForIndex(index, count, box) {
    if (count <= 1) return box.left;
    return box.left + (index / (count - 1)) * box.width;
  }

  draw() {
    const { ctx } = this;
    if (!ctx || !this.width || !this.height) return;
    ctx.clearRect(0, 0, this.width, this.height);
    if (!this.state) return;

    const box = this.plotBox();
    const axisColor = cssVar("--il-axis", "rgba(0,0,0,0.5)");
    const gridColor = cssVar("--il-grid", "rgba(0,0,0,0.08)");

    ctx.font = FONT;
    ctx.textBaseline = "middle";

    if (this.state.kind === "histogram") this.drawHistogram(box, axisColor, gridColor);
    else if (this.state.kind === "bar") this.drawBars(box, axisColor, gridColor);
    else if (this.state.kind === "scatter") this.drawScatter(box, axisColor, gridColor);
    else this.drawLines(box, axisColor, gridColor);
  }

  /* ------------------------------ 折线 / 面积 ----------------------------- */

  drawLines(box, axisColor, gridColor) {
    const { ctx } = this;
    const { labels, series, formatter = (v) => String(v), yLabel = "" } = this.state;
    const count = labels.length;
    if (!count || !series.length) return;

    // 视窗：只统计与绘制可见区间，放大后纵轴自动适配
    const [viewFrom, viewTo] = this.view || [0, count - 1];

    let min = Infinity;
    let max = -Infinity;
    for (const s of series) {
      for (let i = viewFrom; i <= viewTo && i < s.values.length; i += 1) {
        const v = s.values[i];
        if (v === null || v === undefined || !Number.isFinite(v)) continue;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return;
    if (this.state.includeZero) {
      min = Math.min(min, 0);
      max = Math.max(max, 0);
    }
    const scale = niceTicks(min, max, 5);
    const yFor = (value) =>
      box.bottom - ((value - scale.min) / (scale.max - scale.min)) * box.height;

    // 横向网格 + Y 轴刻度
    ctx.strokeStyle = gridColor;
    ctx.fillStyle = axisColor;
    ctx.lineWidth = 1;
    ctx.textAlign = "right";
    for (const tick of scale.ticks) {
      const y = Math.round(yFor(tick)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(box.left, y);
      ctx.lineTo(box.right, y);
      ctx.stroke();
      ctx.fillText(formatter(tick), box.left - 6, y);
    }

    // X 轴标签（最多 6 个）——按视窗范围取
    const labelFormatter = this.state.labelFormatter ?? ((v) => v);
    const maxLabels = Math.max(2, Math.min(6, Math.floor(box.width / 78)));
    const spanCount = viewTo - viewFrom;
    const step = Math.max(1, Math.ceil(spanCount / (maxLabels - 1)));
    ctx.textAlign = "center";
    ctx.fillStyle = axisColor;
    for (let i = viewFrom; i <= viewTo; i += step) {
      const x = this.xForIndex(i - viewFrom, spanCount + 1, box);
      const text = labelFormatter(labels[i], i);
      if (!text) continue;
      if (i === viewFrom) {
        ctx.textAlign = "left";
        ctx.fillText(text, box.left, this.height - 12);
        ctx.textAlign = "center";
      } else {
        ctx.fillText(text, Math.min(x, box.right - 6), this.height - 12);
      }
    }
    {
      // 末尾标签：如果最后一个刻度离右边界太近，就不画（否则会和右端重叠）
      const last = labelFormatter(labels[viewTo], viewTo);
      if (last) {
        const lastDrawnIndex = viewFrom + Math.floor(spanCount / step) * step;
        const distance = viewTo - lastDrawnIndex;
        // 用估算的文字宽度判断：约 0.6em/字符
        const approxWidth = String(last).length * 7;
        if (distance * (box.width / Math.max(1, spanCount)) > approxWidth) {
          ctx.textAlign = "right";
          ctx.fillText(last, box.right, this.height - 12);
          ctx.textAlign = "center";
        }
      }
    }

    if (yLabel) {
      ctx.textAlign = "left";
      ctx.fillStyle = axisColor;
      ctx.fillText(yLabel, box.left, 8);
    }

    // 零轴
    if (scale.min < 0 && scale.max > 0) {
      const zeroY = Math.round(yFor(0)) + 0.5;
      ctx.strokeStyle = withAlpha(axisColor, 0.35);
      ctx.beginPath();
      ctx.moveTo(box.left, zeroY);
      ctx.lineTo(box.right, zeroY);
      ctx.stroke();
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(box.left, box.top - 2, box.width, box.height + 4);
    ctx.clip();

    // 只取视窗内的索引；放大后点更少，drawdown 更细
    const visibleIndices = [];
    for (let i = viewFrom; i <= viewTo; i += 1) visibleIndices.push(i);
    const indices = downsampleIndices(visibleIndices.length, Math.max(60, Math.floor(box.width)))
      .map((pos) => visibleIndices[pos]);

    series.forEach((s, order) => {
      const color = resolveColor(s.color || paletteColor(order));
      const points = [];
      for (const i of indices) {
        const v = s.values[i];
        if (v === null || v === undefined || !Number.isFinite(v)) continue;
        points.push([this.xForIndex(i - viewFrom, spanCount + 1, box), yFor(v)]);
      }
      if (points.length < 2) return;

      if (s.fill !== false) {
        const gradient = ctx.createLinearGradient(0, box.top, 0, box.bottom);
        gradient.addColorStop(0, withAlpha(color, 0.28));
        gradient.addColorStop(1, withAlpha(color, 0.02));
        ctx.beginPath();
        ctx.moveTo(points[0][0], box.bottom);
        for (const [x, y] of points) ctx.lineTo(x, y);
        ctx.lineTo(points[points.length - 1][0], box.bottom);
        ctx.closePath();
        ctx.fillStyle = gradient;
        ctx.fill();
      }

      ctx.beginPath();
      points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      ctx.strokeStyle = color;
      ctx.lineWidth = s.width ?? 1.8;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.stroke();
    });

    // 参考线：支持单条（baseline）与多条（baselines），例如目标权重
    const refLines = [];
    if (this.state.baseline !== undefined) refLines.push({ value: this.state.baseline });
    if (Array.isArray(this.state.baselines)) refLines.push(...this.state.baselines);
    if (refLines.length) {
      ctx.font = '10px system-ui, -apple-system, "PingFang SC", sans-serif';
      refLines.forEach((line, i) => {
        const y = Math.round(yFor(line.value)) + 0.5;
        ctx.strokeStyle = withAlpha(
          line.color ? resolveColor(line.color) : axisColor,
          line.color ? 0.5 : 0.45
        );
        ctx.setLineDash(line.dash || [4, 4]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(box.left, y);
        ctx.lineTo(box.right, y);
        ctx.stroke();
        ctx.setLineDash([]);
        if (line.label) {
          ctx.fillStyle = withAlpha(
            line.color ? resolveColor(line.color) : axisColor,
            0.85
          );
          ctx.textAlign = "right";
          ctx.fillText(line.label, box.right - 4, y - 7);
        }
      });
    }

    // 事件标记（例如再平衡发生的时点）：底部短竖线
    if (Array.isArray(this.state.markers) && this.state.markers.length) {
      ctx.strokeStyle = withAlpha(cssVar("--il-up", "#c62828"), 0.45);
      ctx.lineWidth = 1;
      for (const marker of this.state.markers) {
        const x = Math.round(this.xForIndex(marker.index, count, box)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, box.bottom - 6);
        ctx.lineTo(x, box.bottom);
        ctx.stroke();
      }
    }

    ctx.restore();

    // 图例
    if (series.length > 1 && series.some((s) => s.name)) {
      let x = box.left + 4;
      const y = box.top + 2;
      ctx.textAlign = "left";
      ctx.font = '10px system-ui, -apple-system, "PingFang SC", sans-serif';
      series.forEach((s, i) => {
        if (!s.name) return;
        const color = resolveColor(s.color || paletteColor(i));
        ctx.fillStyle = color;
        ctx.fillRect(x, y, 10, 3);
        ctx.fillStyle = axisColor;
        ctx.fillText(s.name, x + 14, y + 2);
        x += ctx.measureText(s.name).width + 30;
      });
    }

    // 十字线与悬停点
    if (this.hoverIndex !== null) {
      const x = Math.round(this.xForIndex(this.hoverIndex, count, box)) + 0.5;
      ctx.strokeStyle = withAlpha(axisColor, 0.5);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, box.top);
      ctx.lineTo(x, box.bottom);
      ctx.stroke();
      series.forEach((s, i) => {
        const v = s.values[this.hoverIndex];
        if (!Number.isFinite(v)) return;
        ctx.fillStyle = resolveColor(s.color || paletteColor(i));
        ctx.beginPath();
        ctx.arc(x, yFor(v), 3, 0, Math.PI * 2);
        ctx.fill();
      });
    }
  }

  /* -------------------------------- 柱状 -------------------------------- */

  drawBars(box, axisColor, gridColor) {
    const { ctx } = this;
    const { labels, values, formatter = (v) => String(v) } = this.state;
    const count = values.length;
    if (!count) return;

    const scale = niceTicks(Math.min(0, ...values), Math.max(0, ...values), 4);
    const yFor = (v) => box.bottom - ((v - scale.min) / (scale.max - scale.min)) * box.height;

    ctx.strokeStyle = gridColor;
    ctx.fillStyle = axisColor;
    ctx.textAlign = "right";
    for (const tick of scale.ticks) {
      const y = Math.round(yFor(tick)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(box.left, y);
      ctx.lineTo(box.right, y);
      ctx.stroke();
      ctx.fillText(formatter(tick), box.left - 6, y);
    }

    const zeroY = yFor(0);
    const slot = box.width / count;
    const barWidth = Math.max(3, Math.min(38, slot * 0.62));
    const up = cssVar("--il-up", "#c62828");
    const down = cssVar("--il-down", "#1b7f3b");

    values.forEach((v, i) => {
      const x = box.left + slot * i + (slot - barWidth) / 2;
      const y = v >= 0 ? yFor(v) : zeroY;
      const h = Math.max(1, Math.abs(yFor(v) - zeroY));
      ctx.fillStyle = v >= 0 ? up : down;
      roundedRect(ctx, x, y, barWidth, h, [3, 3, 0, 0]);
      ctx.fill();
    });

    ctx.strokeStyle = withAlpha(axisColor, 0.5);
    ctx.beginPath();
    ctx.moveTo(box.left, Math.round(zeroY) + 0.5);
    ctx.lineTo(box.right, Math.round(zeroY) + 0.5);
    ctx.stroke();

    ctx.fillStyle = axisColor;
    ctx.textAlign = "center";
    const labelFormatter = this.state.labelFormatter ?? ((v) => v);
    values.forEach((_, i) => {
      const text = labelFormatter(labels[i], i);
      if (!text) return;
      const x = box.left + slot * i + slot / 2;
      ctx.fillText(text, x, this.height - 12);
    });
  }

  /* ------------------------------- 直方图 ------------------------------- */

  drawHistogram(box, axisColor, gridColor) {
    const { ctx } = this;
    const { edges, counts } = this.state.histogram;
    const formatter = this.state.formatter || ((v) => String(v));
    if (!counts?.length) return;

    const scale = niceTicks(0, Math.max(...counts, 1), 3);

    ctx.strokeStyle = gridColor;
    ctx.fillStyle = axisColor;
    ctx.textAlign = "right";
    for (const tick of scale.ticks) {
      const y = Math.round(box.bottom - (tick / scale.max) * box.height) + 0.5;
      ctx.beginPath();
      ctx.moveTo(box.left, y);
      ctx.lineTo(box.right, y);
      ctx.stroke();
      ctx.fillText(String(Math.round(tick)), box.left - 6, y);
    }

    const slot = box.width / counts.length;
    const up = cssVar("--il-up", "#c62828");
    const down = cssVar("--il-down", "#1b7f3b");
    counts.forEach((c, i) => {
      const h = (c / scale.max) * box.height;
      const x = box.left + slot * i + slot * 0.08;
      const w = Math.max(1, slot * 0.84);
      const centre = (edges[i] + edges[i + 1]) / 2;
      ctx.fillStyle = centre >= 0 ? withAlpha(up, 0.75) : withAlpha(down, 0.75);
      roundedRect(ctx, x, box.bottom - h, w, Math.max(1, h), [2, 2, 0, 0]);
      ctx.fill();
    });

    ctx.fillStyle = axisColor;
    ctx.textAlign = "center";
    const ticks = 5;
    for (let i = 0; i < ticks; i += 1) {
      const idx = Math.round((i / (ticks - 1)) * (edges.length - 1));
      const x = box.left + (idx / (edges.length - 1)) * box.width;
      ctx.fillText(
        formatter(edges[idx]),
        Math.min(Math.max(x, box.left + 22), box.right - 22),
        this.height - 12
      );
    }
  }

  /* -------------------------------- 散点 -------------------------------- */

  drawScatter(box, axisColor, gridColor) {
    const { ctx } = this;
    const { points = [], vLines = [], hLines = [] } = this.state;
    if (!points.length) return;

    const xs = points.map((p) => p.x).concat(vLines.map((v) => v.value));
    const ys = points.map((p) => p.y).concat(hLines.map((v) => v.value));
    const xScale = niceTicks(Math.min(0, ...xs), Math.max(...xs), 5);
    const yScale = niceTicks(Math.min(0, ...ys), Math.max(...ys), 5);

    const xFor = (v) =>
      box.left + ((v - xScale.min) / (xScale.max - xScale.min || 1)) * box.width;
    const yFor = (v) =>
      box.bottom - ((v - yScale.min) / (yScale.max - yScale.min || 1)) * box.height;

    // 网格 + 刻度
    ctx.strokeStyle = gridColor;
    ctx.fillStyle = axisColor;
    ctx.lineWidth = 1;
    ctx.textAlign = "right";
    for (const tick of yScale.ticks) {
      const y = Math.round(yFor(tick)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(box.left, y);
      ctx.lineTo(box.right, y);
      ctx.stroke();
      ctx.fillText(this.state.yFormatter(tick), box.left - 6, y);
    }
    ctx.textAlign = "center";
    for (const tick of xScale.ticks) {
      const x = Math.round(xFor(tick)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, box.top);
      ctx.lineTo(x, box.bottom);
      ctx.stroke();
      ctx.fillText(this.state.xFormatter(tick), x, this.height - 12);
    }

    // 参考线：回撤预算（竖）与收益目标（横）
    for (const line of vLines) {
      const x = Math.round(xFor(line.value)) + 0.5;
      ctx.strokeStyle = withAlpha(cssVar("--il-up", "#c62828"), 0.75);
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(x, box.top);
      ctx.lineTo(x, box.bottom);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = cssVar("--il-up", "#c62828");
      ctx.textAlign = "left";
      ctx.fillText(line.label, Math.min(x + 4, box.right - 60), box.top + 10);
    }
    for (const line of hLines) {
      const y = Math.round(yFor(line.value)) + 0.5;
      ctx.strokeStyle = withAlpha(cssVar("--il-chart-3", "#1d4ed8"), 0.75);
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(box.left, y);
      ctx.lineTo(box.right, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = cssVar("--il-chart-3", "#1d4ed8");
      ctx.textAlign = "left";
      ctx.fillText(line.label, box.left + 4, Math.max(y - 6, box.top + 10));
    }

    // 点
    this.hitPoints = [];
    const style = {
      candidate: { color: "var(--il-axis)", alpha: 0.22, r: 2.1 },
      feasible: { color: "var(--il-chart-1)", alpha: 0.5, r: 2.6 },
      reference: { color: "var(--il-chart-3)", alpha: 0.95, r: 4.2 },
      chosen: { color: "var(--il-up)", alpha: 1, r: 6 },
    };

    // 先画候选，再画选中，保证选中在最上层
    const order = { candidate: 0, feasible: 1, reference: 2, chosen: 3 };
    const sorted = points
      .map((p, index) => ({ p, index }))
      .sort((a, b) => (order[a.p.kind] ?? 0) - (order[b.p.kind] ?? 0));

    for (const { p, index } of sorted) {
      const cfg = style[p.kind] || style.candidate;
      const x = xFor(p.x);
      const y = yFor(p.y);
      ctx.fillStyle = withAlpha(resolveColor(cfg.color), cfg.alpha);
      ctx.beginPath();
      ctx.arc(x, y, cfg.r, 0, Math.PI * 2);
      ctx.fill();
      if (p.kind === "chosen" || p.kind === "reference") {
        ctx.strokeStyle = withAlpha(resolveColor(cfg.color), 0.9);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(x, y, cfg.r + 3, 0, Math.PI * 2);
        ctx.stroke();
      }
      this.hitPoints.push({ index, x, y, point: p });
    }

    // 坐标轴标题：只画横轴的（画在刻度下方），纵轴标题交给页面文案，
    // 否则会和左上角最上方那个刻度标签叠在一起。
    if (this.state.xLabel) {
      ctx.fillStyle = axisColor;
      ctx.textAlign = "right";
      ctx.font = '11px system-ui, -apple-system, "PingFang SC", sans-serif';
      ctx.fillText(this.state.xLabel, box.right, this.height - 2);
      ctx.font = FONT;
    }
  }

  /* -------------------------------- 交互 -------------------------------- */

  pointerMove(event) {
    const state = this.state;
    if (state?.kind === "scatter") {
      if (event.type === "pointermove" && event.pointerType !== "mouse" && event.buttons === 0) return;
      const rect = this.canvas.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      let nearest = null;
      for (const hit of this.hitPoints || []) {
        const dist = Math.hypot(hit.x - px, hit.y - py);
        if (dist < 14 && (!nearest || dist < nearest.dist)) nearest = { ...hit, dist };
      }
      if (!nearest) {
        this.tip.classList.remove("show");
        return;
      }
      this.scatterTip = nearest.index;
      const p = nearest.point;
      this.tip.innerHTML = this.state.tipHtml(p);
      this.positionTip(nearest.x, nearest.y);
      return;
    }
    if (!state || !state.labels?.length) return;
    if (event.type === "pointermove" && event.pointerType !== "mouse" && event.buttons === 0) {
      return;
    }
    const rect = this.canvas.getBoundingClientRect();
    const box = this.plotBox();
    const x = event.clientX - rect.left;
    const count = state.labels.length;
    if (x < box.left - 8 || x > box.right + 8) {
      this.hoverIndex = null;
      this.tip.classList.remove("show");
      this.draw();
      return;
    }
    const ratio = Math.min(1, Math.max(0, (x - box.left) / box.width));
    // 有视窗时，把 0–1 的比例映射到视窗内的索引
    const [vFrom, vTo] = this.view || [0, count - 1];
    const index = Math.round(vFrom + ratio * (vTo - vFrom));
    if (index === this.hoverIndex) return;
    this.hoverIndex = index;
    this.draw();
    this.showTip(index, x);
  }

  showTip(index, x) {
    const state = this.state;
    if (!state) return;
    const box = this.plotBox();
    const label = state.labels[index];
    const rows = [];

    if (state.kind === "histogram") {
      const { edges, counts } = state.histogram;
      const bin = Math.min(
        counts.length - 1,
        Math.max(0, Math.floor((x - box.left) / (box.width / counts.length)))
      );
      const fmt = state.formatter || ((v) => String(v));
      this.tip.innerHTML = `<div class="tip-date">${fmt(edges[bin])} ~ ${fmt(
        edges[bin + 1]
      )}</div><div class="tip-row"><span>出现次数</span><span>${counts[bin]}</span></div>`;
      this.positionTip(x, box.bottom);
      return;
    }

    const dateFormatter = state.tipDateFormatter ?? state.labelFormatter ?? ((v) => v);
    rows.push(`<div class="tip-date">${dateFormatter(label, index)}</div>`);

    if (state.kind === "bar") {
      const fmt = state.tipFormatter || state.formatter || String;
      rows.push(
        `<div class="tip-row"><span>数值</span><span>${fmt(state.values[index])}</span></div>`
      );
    } else {
      for (const s of state.series) {
        const v = s.values[index];
        if (!Number.isFinite(v)) continue;
        const fmt = s.tipFormatter || state.tipFormatter || state.formatter || String;
        rows.push(
          `<div class="tip-row"><span>${s.name ?? ""}</span><span>${fmt(v)}</span></div>`
        );
      }
    }

    this.tip.innerHTML = rows.join("");
    this.positionTip(x, box.top);
  }

  positionTip(x, y) {
    const clamped = Math.min(Math.max(x, 64), Math.max(64, this.width - 64));
    this.tip.style.left = `${clamped}px`;
    this.tip.style.top = `${y}px`;
    this.tip.classList.add("show");
  }

  destroy() {
    this.observer?.disconnect();
    if (typeof window !== "undefined") {
      window.removeEventListener("resize", this.handleResize);
      window.removeEventListener("il:theme", this.handleTheme);
    }
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerdown", this.onPointerMove);
    this.canvas.removeEventListener("pointerleave", this.onPointerLeave);
    this.host.innerHTML = "";
  }
}

/* ------------------------------- 公开 API -------------------------------- */

const registry = new WeakMap();

function mount(host, state) {
  if (!host) return null;
  let chart = registry.get(host);
  if (!chart) {
    chart = new CanvasChart(host);
    registry.set(host, chart);
  }
  chart.setState(state);
  return chart;
}

/**
 * 折线图（可多序列、可填充）。
 * @param {HTMLElement} host
 * @param {{labels: string[], series: {name?: string, values: number[], color?: string,
 *   fill?: boolean, width?: number, tipFormatter?: Function}[], formatter?: Function,
 *   labelFormatter?: Function, tipDateFormatter?: Function, tipFormatter?: Function,
 *   includeZero?: boolean, baseline?: number, yLabel?: string, tall?: boolean}} config
 */
export function lineChart(host, config) {
  host?.classList?.toggle("tall", Boolean(config.tall));
  return mount(host, { kind: "line", ...config });
}

/** 单序列面积图（回撤等） */
export function areaChart(host, config) {
  return mount(host, { kind: "line", ...config });
}

/** 柱状图（可正负） */
export function barChart(host, config) {
  return mount(host, { kind: "bar", ...config });
}

/** 直方图 */
export function histogramChart(host, config) {
  return mount(host, { kind: "histogram", ...config });
}

/**
 * 散点图（用于「风险—收益」候选云）
 * @param {HTMLElement} host
 * @param {{points: {x:number, y:number, kind?: string, key?: string}[],
 *   vLines?: {value:number, label:string}[], hLines?: {value:number, label:string}[],
 *   xFormatter: Function, yFormatter: Function, xLabel: string, yLabel: string,
 *   tipHtml: (point:any)=>string, tall?: boolean}} config
 */
export function scatterChart(host, config) {
  host?.classList?.toggle("tall", Boolean(config.tall));
  return mount(host, { kind: "scatter", ...config });
}

/** 清除图表 */
export function destroyChart(host) {
  const chart = registry.get(host);
  if (chart) {
    chart.destroy();
    registry.delete(host);
  }
}