/**
 * js/ui/wave-panel.js — 可复用的「长波分析」面板。
 *
 * 用在两处：
 *   1. 英国物价 1264–2020（756 年）
 *   2. 宽基指数（上证 1990 起 / 沪深300全收益 2005 起）
 *
 * 关键概念必须讲清楚，否则用户会问「为什么有负数」：
 *
 *   **原始价格图**：纵轴是价格本身，永远为正。
 *   **偏离图**：纵轴是 log(实际) − log(趋势)，**低于长期趋势就是负数**。
 *     负数不是「价格为负」，而是「相对趋势偏低 X%」。
 *     这是对数尺度下的标准做法——把「涨了 100 倍」压成可比的偏离量。
 */

import { fitContinuousWave, fitTrendOnly } from "../core/wave.js";
import { lineChart } from "../core/charts.js";

/**
 * @param {HTMLElement} host
 * @param {{title: string, subtitle: string, years: number[], values: number[],
 *          labels: string[], dateLabels?: string[], defaultNodes?: number,
 *          nodesRange?: [number, number], note?: string}} config
 */
export function mountWavePanel(host, config) {
  if (!host) return;

  const {
    title,
    subtitle,
    years,
    values,
    dateLabels,
    defaultNodes = 12,
    nodesRange = [6, 80],
    note = "",
  } = config;

  const [minNodes, maxNodes] = nodesRange;
  const labels = dateLabels || years.map((y) => String(y));

  host.innerHTML = `
    <div class="card">
      <div class="chart-head">
        <h3>${title}</h3>
        <span class="hint">${subtitle}</span>
      </div>
      ${note ? `<p class="section-desc">${note}</p>` : ""}

      <div class="wave-slider-wrap">
        <div class="wave-slider-head">
          <label for="wn-${host.id}">节点数</label>
          <strong id="wnout-${host.id}">${defaultNodes}</strong>
        </div>
        <input type="range" id="wn-${host.id}" min="${minNodes}" max="${maxNodes}" step="1"
               value="${defaultNodes}" aria-label="分段节点数"
               aria-valuemin="${minNodes}" aria-valuemax="${maxNodes}" aria-valuenow="${defaultNodes}" />
        <div class="wave-slider-scale">
          <span>${minNodes} 个节点 · 只看大趋势</span>
          <span>${maxNodes} 个节点 · 更细</span>
        </div>
        <div class="row" style="gap:.4rem;flex-wrap:wrap;margin-top:.35rem">
          ${[minNodes, Math.round((minNodes + maxNodes) / 2), maxNodes]
            .filter((v, i, arr) => arr.indexOf(v) === i && v >= minNodes && v <= maxNodes)
            .map((v) => `<button class="wave-preset" data-nodes="${v}">${v}</button>`)
            .join("")}
        </div>
        <div class="small muted" id="wnstat-${host.id}"></div>
      </div>

      <h4 class="section-title" style="font-size:1rem;margin-top:.6rem">偏离图（这里会出现负数）</h4>
      <p class="section-desc" style="margin-top:.1rem">
        纵轴是 <code>log(实际) − log(趋势)</code>。<b>0 线 = 长期趋势</b>；
        <b>负数是「低于长期趋势」，不是「价格为负」</b>。
        对数尺度下这样才能把「涨了几百倍」和「跌了一半」放在同一根轴上比较。
      </p>
      <div class="chart tall" id="wdev-${host.id}" style="height:20rem"></div>

      <div class="wave-toolbar">
        <button class="wave-btn" data-act="in">＋</button>
        <button class="wave-btn" data-act="out">－</button>
        <button class="wave-btn" data-act="left">←</button>
        <button class="wave-btn" data-act="right">→</button>
        <button class="wave-btn" data-act="reset">全览</button>
        <span class="small muted" id="wview-${host.id}"></span>
      </div>
      <p class="caption" id="wcap-${host.id}"></p>

      <h4 class="section-title" style="font-size:1rem;margin-top:1rem">原始价格（这里不会有负数）</h4>
      <div class="chart tall" id="wprice-${host.id}" style="height:18rem"></div>
      <p class="caption" id="wpcap-${host.id}"></p>

      <div id="wtable-${host.id}" style="margin-top:.8rem"></div>
      <div class="notice" data-tone="warn" style="margin-top:.7rem">
        <span id="whonest-${host.id}"></span>
      </div>
    </div>`;

  const slider = host.querySelector(`#wn-${host.id}`);
  const sliderOut = host.querySelector(`#wnout-${host.id}`);
  const statHost = host.querySelector(`#wnstat-${host.id}`);
  const viewHost = host.querySelector(`#wview-${host.id}`);
  const devHost = host.querySelector(`#wdev-${host.id}`);
  const priceHost = host.querySelector(`#wprice-${host.id}`);
  const tableHost = host.querySelector(`#wtable-${host.id}`);
  const honestHost = host.querySelector(`#whonest-${host.id}`);

  const trendOnly = fitTrendOnly(years, values);
  let devChart = null;
  let priceChart = null;

  const updateView = () => {
    if (!viewHost || !devChart) return;
    const [from, to, total] = devChart.getView();
    viewHost.textContent = `${labels[from]}–${labels[to]}（共 ${total} 点，显示 ${to - from + 1}）`;
  };

  const draw = (nodes) => {
    const fit = fitContinuousWave(years, values, { segments: nodes });
    if (!fit) return;

    // ---------- 偏离图 ----------
    const devActual = values.map((v, i) => Math.log(v) - Math.log(trendOnly.trend[i]));
    devChart = lineChart(devHost, {
      labels,
      series: [
        { name: "实际偏离", values: devActual, color: "var(--il-chart-1)", fill: false, width: 1.1 },
        { name: "长波", values: fit.waveLog, color: "var(--il-chart-3)", fill: false, width: 2.3 },
      ],
      baselines: [{ value: 0, label: "趋势" }],
      formatter: (v) => `${(Math.exp(v) - 1 >= 0 ? "+" : "")}${((Math.exp(v) - 1) * 100).toFixed(0)}%`,
      tipFormatter: (v) => `${(Math.exp(v) - 1 >= 0 ? "+" : "")}${((Math.exp(v) - 1) * 100).toFixed(1)}%`,
      ariaLabel: `${title} 相对趋势的偏离`,
    });
    if (devChart) {
      devChart.onViewChange = updateView;
      updateView();
    }

    // ---------- 原始价格 ----------
    if (priceChart) {
      priceChart.setState({
        labels,
        series: [
          { name: "实际价格", values, color: "var(--il-chart-1)", fill: false, width: 1.1 },
          { name: "趋势", values: trendOnly.trend, color: "var(--il-chart-4)", fill: false, width: 1.4 },
          { name: "长波拟合", values: fit.fitted, color: "var(--il-chart-3)", fill: false, width: 2.3 },
        ],
        formatter: (v) => (Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(1)),
        tipFormatter: (v) => v.toFixed(2),
        ariaLabel: `${title} 原始价格`,
      });
      if (devChart) priceChart.view = devChart.view;
      priceChart.draw();
    } else {
      priceChart = lineChart(priceHost, {
        labels,
        series: [
          { name: "实际价格", values, color: "var(--il-chart-1)", fill: false, width: 1.1 },
          { name: "趋势", values: trendOnly.trend, color: "var(--il-chart-4)", fill: false, width: 1.4 },
          { name: "长波拟合", values: fit.fitted, color: "var(--il-chart-3)", fill: false, width: 2.3 },
        ],
        formatter: (v) => (Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(1)),
        tipFormatter: (v) => v.toFixed(2),
        ariaLabel: `${title} 原始价格`,
      });
    }

    // ---------- 状态 ----------
    const lastSeg = fit.segmentInfo[fit.segmentInfo.length - 1];
    // waveLog 本身就是「拟合值 − 趋势」（对数偏离），不能再减一次趋势
    const devNow = fit.waveLog[fit.waveLog.length - 1];
    const above = devNow >= 0;
    const validPeriods = fit.segmentInfo.filter((s) => s.period).length;
    const totalSegs = fit.segmentInfo.length;

    if (statHost) {
      statHost.innerHTML =
        `${nodes} 个节点 · R² <strong>${fit.r2.toFixed(4)}</strong> · ` +
        `末段周期 <strong>${lastSeg.period ? `${lastSeg.period.toFixed(0)} 年` : "不可辨识"}</strong> · ` +
        `当前${above ? "高于" : "低于"}趋势 <strong>${Math.abs((Math.exp(devNow) - 1) * 100).toFixed(0)}%</strong>` +
        (validPeriods < totalSegs ? ` · <span class="muted">${totalSegs - validPeriods} 段周期不可辨识</span>` : "");
    }

    const capHost = host.querySelector(`#wcap-${host.id}`);
    if (capHost) {
      capHost.innerHTML =
        `0 线是长期趋势，曲线在 0 以下就是「<strong>低于趋势</strong>」。` +
        `当前 ${above ? "高于" : "低于"}趋势 ${Math.abs((Math.exp(devNow) - 1) * 100).toFixed(0)}%。`;
    }

    const pcapHost = host.querySelector(`#wpcap-${host.id}`);
    if (pcapHost) {
      pcapHost.innerHTML = `纵轴是价格本身，<strong>全部为正</strong>——和上面的偏离图是两回事。`;
    }

    // ---------- 参数表 ----------
    if (tableHost) {
      const rows = fit.segmentInfo.slice(0, 30).map((seg) => ({
        cells: [
          { html: `${seg.from}${config.dateLabels ? "" : "–" + seg.to}`, cls: "small" },
          { html: seg.period ? `${seg.period.toFixed(0)} 年` : '<span class="muted">—</span>' },
          { html: `${seg.A >= 0 ? "+" : ""}${seg.A.toFixed(3)}` },
          { html: seg.segmentR2.toFixed(2), cls: "small muted" },
          { html: `±${(seg.amplitude * 100).toFixed(0)}%` },
        ],
      }));
      tableHost.innerHTML = `
        <table class="tbl">
          <thead><tr>
            <th style="text-align:left">区间</th><th>等效周期</th><th>A</th><th>段内 R²</th><th>振幅</th>
          </tr></thead>
          <tbody>${rows.map((r) => `<tr>${r.cells.map((c) => `<td class="${c.cls || ""}">${c.html}</td>`).join("")}</tr>`).join("")}</tbody>
        </table>
        <p class="caption">${
          fit.segmentInfo.length > 30 ? `只显示前 30 段（共 ${fit.segmentInfo.length} 段）。` : ""
        }「—」表示该段周期不可辨识（正弦退化，只是跟着趋势走）。</p>`;
    }

    // ---------- 诚实说明 ----------
    const minYear = Math.min(...years);
    const maxYear = Math.max(...years);
    if (honestHost) {
      honestHost.innerHTML = `
        <strong>这段数据跨 ${maxYear - minYear + 1} 年</strong>（${labels[0]}–${labels[labels.length - 1]}），
        所以「周期」能识别的范围很有限：至少要 3–4 个完整周期才谈得上规律，
        也就是<strong>最长只能看 ${Math.round((maxYear - minYear + 1) / 4)} 年左右的周期</strong>。
        节点数越多 R² 越高，但每段的周期越不可辨识——
        这是<strong>样本长度</strong>的限制，不是算法问题。
      `;
    }
  };

  let pending = null;
  const schedule = (nodes) => {
    if (sliderOut) sliderOut.textContent = String(nodes);
    slider?.setAttribute("aria-valuenow", String(nodes));
    if (pending) cancelAnimationFrame(pending);
    pending = requestAnimationFrame(() => {
      pending = null;
      draw(nodes);
    });
  };

  draw(defaultNodes);
  slider?.addEventListener("input", () => schedule(Number(slider.value)));
  host.querySelectorAll(".wave-preset").forEach((button) => {
    button.addEventListener("click", () => {
      const nodes = Number(button.dataset.nodes);
      if (slider) slider.value = String(nodes);
      schedule(nodes);
    });
  });

  // 缩放
  const bind = (act, fn) => {
    host.querySelector(`[data-act="${act}"]`)?.addEventListener("click", () => {
      if (!devChart) return;
      fn(devChart);
      if (priceChart) {
        priceChart.view = devChart.view;
        priceChart.draw();
      }
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
}