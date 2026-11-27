/**
 * js/ui/wave-panel.js — 纯三角函数长波面板。
 *
 * 设计要点（按用户要求调整）：
 *   1. **拟合全部用三角函数**：log(值) = c₀ + c₁·(1−cos(πt/T)) + Σₖ[aₖsin + bₖcos]
 *      没有任何线性项。1−cos(πt/T) 这一项本身是余弦，负责表达长期趋势。
 *   2. **不做偏离图**：用户明确说不在乎，只保留原始价格 + 拟合曲线。
 *   3. 谐波数用滑条实时调。
 *   4. 图表可缩放。
 */

import { fitTrigonometric } from "../core/wave.js";
import { lineChart } from "../core/charts.js";

/**
 * @param {HTMLElement} host
 * @param {{title, subtitle, years, values, dateLabels, defaultHarmonics,
 *          harmonicsRange, note, valueLabel, formatter}} config
 */
export function mountWavePanel(host, config) {
  if (!host) return;

  const {
    title,
    subtitle,
    years,
    values,
    dateLabels,
    defaultHarmonics = 12,
    harmonicsRange = [2, 40],
    note = "",
    valueLabel = "价格",
    formatter = (v) => (Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(1)),
    defaultLog = true,
  } = config;

  const [minH, maxH] = harmonicsRange;
  const labels = dateLabels || years.map((y) => String(y));
  const uid = host.id || `wp${Math.random().toString(36).slice(2, 7)}`;

  host.innerHTML = `
    <div class="card">
      <div class="chart-head">
        <h3>${title}</h3>
        <span class="hint">${subtitle}</span>
      </div>
      ${note ? `<p class="section-desc">${note}</p>` : ""}

      <div class="wave-slider-wrap">
        <div class="wave-slider-head">
          <label for="wn-${uid}">谐波数</label>
          <strong id="wnout-${uid}">${defaultHarmonics}</strong>
        </div>
        <input type="range" id="wn-${uid}" min="${minH}" max="${maxH}" step="1"
               value="${defaultHarmonics}" aria-label="谐波数"
               aria-valuemin="${minH}" aria-valuemax="${maxH}" aria-valuenow="${defaultHarmonics}" />
        <div class="wave-slider-scale">
          <span>${minH} · 只剩最慢的波</span>
          <span>${maxH} · 越细越接近描图</span>
        </div>
        <div class="row" style="gap:.4rem;flex-wrap:wrap;margin-top:.35rem">
          ${[minH, Math.round((minH + maxH) / 3), Math.round((2 * (minH + maxH)) / 3), maxH]
            .filter((v, i, arr) => arr.indexOf(v) === i && v >= minH && v <= maxH)
            .map((v) => `<button class="wave-preset" data-nodes="${v}">${v}</button>`)
            .join("")}
        </div>
        <div class="small muted" id="wnstat-${uid}"></div>
      </div>

      <div class="chart tall" id="wprice-${uid}" style="height:24rem"></div>
      <div class="wave-toolbar">
        <button class="wave-btn" data-act="in">＋</button>
        <button class="wave-btn" data-act="out">－</button>
        <button class="wave-btn" data-act="left">←</button>
        <button class="wave-btn" data-act="right">→</button>
        <button class="wave-btn" data-act="reset">全览</button>
        <button class="wave-btn" data-act="scale" id="wscale-${uid}">
          ${defaultLog ? "对数纵轴" : "线性纵轴"}
        </button>
        <span class="small muted" id="wview-${uid}"></span>
      </div>
      <p class="caption" id="wcap-${uid}"></p>

      <div id="wtable-${uid}" style="margin-top:.8rem"></div>
      <div class="notice" data-tone="warn" style="margin-top:.7rem">
        <span id="whonest-${uid}"></span>
      </div>
    </div>`;

  const slider = host.querySelector(`#wn-${uid}`);
  const sliderOut = host.querySelector(`#wnout-${uid}`);
  const statHost = host.querySelector(`#wnstat-${uid}`);
  const viewHost = host.querySelector(`#wview-${uid}`);
  const priceHost = host.querySelector(`#wprice-${uid}`);
  const tableHost = host.querySelector(`#wtable-${uid}`);
  const honestHost = host.querySelector(`#whonest-${uid}`);
  const capHost = host.querySelector(`#wcap-${uid}`);

  let chart = null;
  let useLog = defaultLog;

  const updateView = () => {
    if (!viewHost || !chart) return;
    const [from, to, total] = chart.getView();
    viewHost.textContent = `${labels[from]}–${labels[to]}（共 ${total} 点，显示 ${to - from + 1}）`;
  };

  const draw = (harmonics) => {
    const fit = fitTrigonometric(years, values, { harmonics });
    if (!fit) return;

    const series = [
      { name: `实际${valueLabel}`, values, color: "var(--il-chart-1)", fill: false, width: 1.1 },
      { name: "三角趋势", values: fit.trend, color: "var(--il-chart-4)", fill: false, width: 1.3 },
      { name: `${harmonics} 项拟合`, values: fit.fitted, color: "var(--il-chart-3)", fill: false, width: 2.2 },
    ];

    if (chart) {
      chart.setState({
        labels,
        series,
        formatter,
        tipFormatter: (v) => v.toFixed(2),
        ariaLabel: title,
        logScale: useLog,
      });
      chart.draw();
    } else {
      chart = lineChart(priceHost, {
        labels,
        series,
        formatter,
        tipFormatter: (v) => v.toFixed(2),
        ariaLabel: title,
        logScale: useLog,
      });
      if (chart) chart.onViewChange = updateView;
    }
    updateView();

    const rising = fit.slope > 0;
    const devNow = fit.waveLog[fit.waveLog.length - 1];
    const above = devNow >= 0;

    if (statHost) {
      statHost.innerHTML =
        `${harmonics} 个谐波 · R² <strong>${fit.r2.toFixed(4)}</strong> · ` +
        `主周期 <strong>${fit.dominant.period.toFixed(0)} 年</strong> · ` +
        `当前<strong>${rising ? "上行" : "下行"}</strong>段 · ` +
        `相对趋势 <strong>${above ? "+" : "−"}${Math.abs((Math.exp(Math.abs(devNow)) - 1) * 100).toFixed(0)}%</strong>`;
    }

    if (capHost) {
      capHost.innerHTML =
        `细线是实际${valueLabel}，紫线是<strong>三角趋势</strong>（只含常数 + 半周期余弦项），` +
        `粗线是 ${harmonics} 项三角拟合。<strong>所有曲线都由 sin/cos 构成</strong>，没有线性项。` +
        (useLog
          ? `<br /><strong>纵轴是对数尺度</strong>——这样 1871 年的 4.44 和今天的 4516 能同时看清；` +
            `线性尺度下早期 100 年会被压成一条贴底的平线。`
          : `<br /><strong>纵轴是线性尺度</strong>——适合看绝对涨跌，但早期数据会被压扁。`);
    }

    if (tableHost) {
      const rows = fit.harmonicsInfo.slice(0, 16).map((h) => ({
        cells: [
          { html: `k = ${h.k}`, cls: "small" },
          { html: `${h.period.toFixed(0)} 年` },
          { html: `${h.sinCoef >= 0 ? "+" : ""}${h.sinCoef.toFixed(3)}` },
          { html: `${h.cosCoef >= 0 ? "+" : ""}${h.cosCoef.toFixed(3)}` },
          { html: `±${(h.amplitudePct * 100).toFixed(0)}%` },
        ],
      }));
      tableHost.innerHTML = `
        <table class="tbl">
          <thead><tr>
            <th style="text-align:left">谐波</th><th>周期</th><th>sin 系数</th><th>cos 系数</th><th>振幅</th>
          </tr></thead>
          <tbody>${rows
            .map((r) => `<tr>${r.cells.map((c) => `<td class="${c.cls || ""}">${c.html}</td>`).join("")}</tr>`)
            .join("")}</tbody>
        </table>
        <p class="caption">
          <code>log(值) = c₀ + c₁·(1−cos(πt/T)) + Σₖ[aₖ·sin(2πkt/T) + bₖ·cos(2πkt/T)]</code>。
          谐波 k 的周期 = 数据跨度 ÷ k。
        </p>`;
    }

    if (honestHost) {
      const minYear = Math.min(...years);
      const maxYear = Math.max(...years);
      const shortest = fit.span / harmonics;
      honestHost.innerHTML = `
        数据跨 <strong>${(maxYear - minYear + 1).toFixed(0)} 年</strong>，
        所以 ${harmonics} 个谐波时<strong>最短能分辨的周期是 ${shortest.toFixed(1)} 年</strong>。
        要看出「康波」（50–60 年一轮），至少需要 <strong>3–4 轮 = 150–240 年</strong>的数据。
        ${(maxYear - minYear + 1) >= 150
          ? "这条序列<strong>够长</strong>，可以看 50–60 年尺度。"
          : "这条序列<strong>不够长</strong>，50–60 年尺度只能看出 1–2 个波，统计意义很弱。"}
      `;
    }
  };

  let pending = null;
  const schedule = (h) => {
    if (sliderOut) sliderOut.textContent = String(h);
    slider?.setAttribute("aria-valuenow", String(h));
    if (pending) cancelAnimationFrame(pending);
    pending = requestAnimationFrame(() => {
      pending = null;
      draw(h);
    });
  };

  draw(defaultHarmonics);
  slider?.addEventListener("input", () => schedule(Number(slider.value)));
  host.querySelectorAll(".wave-preset").forEach((button) => {
    button.addEventListener("click", () => {
      const h = Number(button.dataset.nodes);
      if (slider) slider.value = String(h);
      schedule(h);
    });
  });

  const bind = (act, fn) => {
    host.querySelector(`[data-act="${act}"]`)?.addEventListener("click", () => {
      if (!chart) return;
      fn(chart);
    });
  };
  bind("in", (c) => c.zoomBy(1.8));
  bind("out", (c) => c.zoomBy(1 / 1.8));
  bind("left", (c) => {
    const [from, to] = c.getView();
    c.panBy(-Math.max(1, Math.round((to - from) * 0.25)));
  });
  bind("right", (c) => {
    const [from, to] = c.getView();
    c.panBy(Math.max(1, Math.round((to - from) * 0.25)));
  });
  bind("reset", (c) => c.setView(null, null));

  // 对数 / 线性纵轴切换
  const scaleBtn = host.querySelector(`#wscale-${uid}`);
  scaleBtn?.addEventListener("click", () => {
    useLog = !useLog;
    scaleBtn.textContent = useLog ? "对数纵轴" : "线性纵轴";
    const current = slider ? Number(slider.value) : defaultHarmonics;
    draw(current);
  });
}