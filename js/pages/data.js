/**
 * js/pages/data.js — 数据状态页。
 *
 * 把 data/meta.json、data/quality.json、data/assets.json 三份产物摊给用户看：
 * 更新到哪天、每个市场的交易日历有多长、哪些资产存在缺口、缺的是哪几天。
 *
 * 这里刻意不粉饰：数据源确实有空洞（例如腾讯的纳斯达克100 在 2021-05 少了 10 天），
 * 与其藏起来，不如说清楚——统计分析里这些跨度过大的相邻点已经被剔除。
 */

import { initShell, showError } from "../core/shell.js";
import { loadIndex, loadMeta } from "../core/store.js";
import { metricsHtml, notice, tableHtml } from "../ui/cards.js";
import { count, dateLabel, num, pct } from "../core/format.js";
import { lineChart } from "../core/charts.js";
import { fitWave, fitTrendOnly, KONDRATIEFF_PHASES } from "../core/wave.js";

const MARKET_LABEL = { CN: "A 股", HK: "港股", US: "美股" };
const TYPE_LABEL = { index: "指数", etf: "ETF", stock: "股票", fund: "基金", fx: "汇率" };

async function loadQuality() {
  const resp = await fetch(`data/quality.json?v=${Date.now().toString(36)}`, { cache: "no-store" });
  if (!resp.ok) throw new Error(`quality.json HTTP ${resp.status}`);
  return resp.json();
}

function completenessChip(asset) {
  if (asset.status !== "ok") {
    return asset.status === "missing"
      ? `<span class="chip-bad">缺失</span>`
      : `<span class="chip-bad">损坏</span>`;
  }
  if (asset.completeness === "complete") return `<span class="chip-ok">完整</span>`;
  if (asset.completeness === "minor") return `<span class="chip-warn">轻微缺口</span>`;
  return `<span class="chip-bad">有缺口</span>`;
}

function renderSummary(meta, quality, assets) {
  const host = document.getElementById("data-summary");
  const totalPoints = assets.reduce((acc, a) => acc + (a.data_points || 0), 0);
  const earliest = assets
    .map((a) => a.data_start)
    .filter(Boolean)
    .sort()[0];
  const summary = quality?.summary || {};

  const items = [
    {
      label: "数据截止",
      value: dateLabel(meta?.data_date || quality?.data_date),
      sub: "最近一个交易日",
    },
    {
      label: "资产数量",
      value: `${count(meta?.total_assets ?? assets.length)} 项`,
      sub: `可用 ${count(meta?.available_assets ?? 0)} 项`,
    },
    { label: "记录总数", value: count(totalPoints), sub: `最早追溯至 ${earliest || "—"}` },
    {
      label: "完整对齐",
      value: `${count(summary.assets_complete ?? 0)} / ${count(summary.total ?? 0)} 项`,
      sub: `停牌型缺口 ${count(summary.assets_with_suspension_gaps ?? 0)} · 源端空洞 ${count(
        summary.assets_with_source_gaps ?? 0
      )}`,
    },
    {
      label: "校验结果",
      value: quality ? (summary.error_count === 0 ? "通过" : `${summary.error_count} 项错误`) : "—",
      sub: quality ? `${summary.warning_count} 条提醒` : "",
    },
    {
      label: "数据新鲜度",
      value: quality?.stale_days != null ? `${quality.stale_days} 天前` : "—",
      sub: quality?.stale_days > 3 ? "可能未按时更新" : "时效正常",
    },
  ];

  host.innerHTML = metricsHtml(items);
}

/** 各市场交易日历 */
function renderCalendars(quality) {
  const host = document.getElementById("data-calendars");
  if (!host) return;
  const calendars = quality?.calendars || {};
  const keys = Object.keys(calendars);
  if (!keys.length) {
    host.innerHTML = "";
    return;
  }

  host.innerHTML = `
    <div class="card">
      <div class="chart-head">
        <h3>交易日历</h3>
        <span class="hint">每个市场用自己的日历判断缺口，跨市场假期不算缺失</span>
      </div>
      <div class="stack" style="gap:.25rem">
        ${keys
          .map((market) => {
            const info = calendars[market];
            return `<div class="status-row">
              <span class="status-name">${MARKET_LABEL[market] || market}</span>
              <span class="small muted num">${count(info.days)} 个交易日 · ${info.start} ~ ${info.end}</span>
            </div>`;
          })
          .join("")}
      </div>
      <p class="caption">
        缺口判断方法：把资产自己的交易日与所属市场的日历比对，差出来的就是缺口。
        个股停牌、指数数据源空洞都会体现为缺口，但含义不同——下面的明细会区分。
      </p>
    </div>`;
}

/** 有缺口的资产明细 */
function renderGaps(quality) {
  const host = document.getElementById("data-gaps");
  if (!host) return;
  const assets = (quality?.assets || []).filter((a) => a.status === "ok");
  const withGaps = assets
    .filter((a) => (a.max_missing_run || 0) >= 3)
    .sort((a, b) => (b.max_missing_run || 0) - (a.max_missing_run || 0));

  if (!withGaps.length) {
    host.innerHTML = `<div class="card">${notice("所有资产在各自市场日历下都没有超过 3 个交易日的缺口。", "accent")}</div>`;
    return;
  }

  // gap_cause 由 validate.py 依据「市场 + 类型」判定，前端只负责翻译
  const CAUSE_LABEL = {
    suspension: "长期停牌（股改 / 重组 / 停牌潮），市场事实",
    source: "数据源空洞，源端本身没有这段数据",
  };

  host.innerHTML = `
    <div class="card">
      <div class="chart-head">
        <h3>缺口明细（按最长连续缺口排序）</h3>
        <span class="hint">${withGaps.length} 项资产存在 ≥3 个交易日的缺口</span>
      </div>
      ${tableHtml({
        columns: [
          { label: "资产", align: "left" },
          { label: "类型" },
          { label: "最长连续缺口" },
          { label: "缺失交易日" },
          { label: "缺口区间" },
          { label: "可能原因" },
        ],
        rows: withGaps.slice(0, 20).map((asset) => {
          const first = (asset.missing_runs || [])[0] || {};
          const ratio = asset.missing_ratio ?? 0;
          const reason = CAUSE_LABEL[asset.gap_cause] || "短时停牌或数据源空洞";
          return {
            cells: [
              { html: `<strong>${asset.name}</strong> <span class="muted small">${asset.symbol}</span>` },
              { html: TYPE_LABEL[asset.type] || asset.type },
              { html: `${asset.max_missing_run} 天`, cls: asset.max_missing_run >= 10 ? "pos" : "" },
              {
                html: `${asset.missing_trading_days} 天 · ${pct(ratio, { signed: false, digits: 2 })}`,
              },
              {
                html: first.from ? `${first.from} ~ ${first.to}` : "—",
                cls: "small",
              },
              { html: reason, cls: "small muted" },
            ],
          };
        }),
        caption:
          "「缺失交易日」只统计资产存续区间内的交易日。跨度过大的相邻点在统计时会被剔除，" +
          "所以缺口不会污染波动率、夏普比率与胜率。指数与 ETF 不存在停牌，它们的缺口来自数据源。",
      })}
    </div>`;
}

function renderGroups(assets, meta, quality) {
  const host = document.getElementById("data-groups");
  const groups = meta?.groups?.length ? meta.groups : [...new Set(assets.map((a) => a.group))];
  const qualityMap = new Map((quality?.assets || []).map((a) => [`${a.type}:${a.symbol}`, a]));

  host.innerHTML = groups
    .map((group) => {
      const list = assets.filter((a) => a.group === group);
      if (!list.length) return "";
      const total = list.reduce((acc, a) => acc + (a.data_points || 0), 0);
      return `
        <div class="card">
          <div class="chart-head">
            <h3>${group}</h3>
            <span class="hint">${list.length} 项 · ${count(total)} 条记录</span>
          </div>
          <div class="stack" style="gap:.25rem">
            ${list
              .map((asset) => {
                const q = qualityMap.get(`${asset.type}:${asset.symbol}`);
                return `
              <div class="status-row">
                <span class="status-name">${asset.name} <span class="muted small">${asset.symbol}</span></span>
                <span class="small muted num">${
                  asset.data_start ? `${asset.data_start} 起 · ${count(asset.data_points)} 条` : "无数据"
                }</span>
                ${completenessChip({ ...asset, completeness: q?.completeness })}
              </div>`;
              })
              .join("")}
          </div>
        </div>`;
    })
    .join("");
}

function renderTable(assets, quality) {
  const host = document.getElementById("data-table");
  const qualityMap = new Map((quality?.assets || []).map((a) => [`${a.type}:${a.symbol}`, a]));

  host.innerHTML = `<div class="card">${tableHtml({
    columns: [
      { label: "资产", align: "left" },
      { label: "代码" },
      { label: "类型" },
      { label: "起始" },
      { label: "截止" },
      { label: "记录数" },
      { label: "缺口" },
      { label: "状态" },
    ],
    rows: assets.map((asset) => {
      const q = qualityMap.get(`${asset.type}:${asset.symbol}`);
      const missing = q?.missing_trading_days;
      return {
        cells: [
          { html: `<strong>${asset.name}</strong>` },
          { html: asset.symbol },
          { html: TYPE_LABEL[asset.type] || asset.type },
          { html: asset.data_start || "—" },
          { html: asset.data_end || "—" },
          { html: count(asset.data_points) },
          {
            html:
              q == null
                ? "—"
                : missing === 0
                  ? "无"
                  : `${missing} 天`,
            cls: missing > 0 ? "pos" : "muted",
          },
          { html: completenessChip({ ...asset, completeness: q?.completeness }) },
        ],
      };
    }),
    caption:
      "「缺口」是相对该市场交易日历缺了多少个交易日；「状态」按缺失率分档：<0.5% 完整，<3% 轻微缺口，其余有缺口。",
  })}</div>`;
}



/* ---------------------- 跨 757 年的物价序列（1264–2020） ---------------------- */

/**
 * 这条序列是拼出来的，所以页面必须**把拼接方式写出来**：
 * 1264–1830 来自 Allen (2001) 伦敦 CPI，1870–2020 来自 JST，
 * 中间 1831–1869 是几何插值（不是原始观测）。
 *
 * 不写清楚这三段，读者会以为 1831–1869 也是实测数据——那就是编数据。
 */
function renderUkPriceIndex(host, payload) {
  const uk = payload?.uk_price_index;
  if (!host || !uk?.years?.length) return false;

  const years = uk.years;
  const values = uk.values;
  const interpolated = uk.interpolated;
  const first = years[0];
  const last = years[years.length - 1];

  const at = (year) => {
    const index = years.indexOf(year);
    return index < 0 ? null : values[index];
  };

  // 关键节点
  const nodes = [
    [1264, "序列起点"],
    [1348, "黑死病"],
    [1500, "价格革命前"],
    [1600, "价格革命后"],
    [1700, "18 世纪初"],
    [1800, "工业革命中"],
    [1870, "JST 起点"],
    [1914, "一战前"],
    [2020, "现在"],
  ].filter(([y]) => years.includes(y));

  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = `
    <div class="chart-head">
      <h3>英国物价：跨 ${last - first} 年（${first}–${last}）</h3>
      <span class="hint">${years.length} 个年度值 · 拼接自两个学术数据源</span>
    </div>
    <p class="section-desc">
      这是本站能拿到的<strong>最长连续序列</strong>：从 1264 年（南宋末年、英格兰爱德华一世时期）
      到 2020 年，共 <strong>${last - first} 年</strong>。
      它比上证指数的 35 年长 20 倍，也是讨论「长波 / 周期」唯一够用的尺度。
    </p>

    <div class="chart tall" id="chart-uk-price" style="margin-top:0.8rem"></div>

    <p class="caption">
      <strong>怎么读：</strong>纵轴是物价指数（1264 = 1）。
      注意 1264–1500 的 236 年里物价几乎没有净变化（年均 −0.09%），
      而 1500–1600 的 100 年里涨了 <strong>2.34 倍</strong>（年均 +0.85%）——
      这就是史学界说的「价格革命」：美洲白银大量流入欧洲。
      之后 1700–1800 又涨 2.54 倍。
      <strong>同一个经济体，在不同世纪里的「正常通胀率」可以差十倍。</strong>
    </p>

    <h4 class="section-title" style="font-size:1rem;margin-top:1.4rem">叠加一条长波（示意）</h4>
    <p class="section-desc" style="margin-top:0.2rem">
      下面这张图把「趋势」和「波浪」分开画：<strong>细线是趋势</strong>（对数线性拟合），
      <strong>粗波浪线是在趋势上叠了一个正弦</strong>。它只回答一个问题：
      <em>当前物价相对长期趋势，处在偏高的位置还是偏低的位置</em>。
    </p>

    <div class="row" style="gap:.5rem;flex-wrap:wrap;align-items:center;margin:0.5rem 0">
      <span class="small muted">波浪周期</span>
      <mdui-segmented-button-group id="wave-period" value="55" selects="single">
        <mdui-segmented-button value="45">45 年</mdui-segmented-button>
        <mdui-segmented-button value="55">55 年</mdui-segmented-button>
        <mdui-segmented-button value="70">70 年</mdui-segmented-button>
        <mdui-segmented-button value="100">100 年</mdui-segmented-button>
        <mdui-segmented-button value="175">175 年</mdui-segmented-button>
      </mdui-segmented-button-group>
      <span class="small muted" id="wave-stat"></span>
    </div>

    <div class="chart tall" id="chart-uk-wave"></div>
    <p class="caption" id="wave-caption"></p>

    <p class="section-desc" style="margin-top:1rem">
      上面那张图里，实际物价在最后 100 年涨得太猛，把波浪压成了一条直线——
      这正是<strong>线性尺度</strong>的问题。下面换成「相对趋势的偏离」（对数差），
      波浪的形状才看得清：<strong>高于 0 = 物价高于长期趋势</strong>。
    </p>
    <div class="chart" id="chart-uk-deviation" style="height:18rem"></div>
    <p class="caption" id="dev-caption"></p>

    <div class="notice" data-tone="warn" style="margin-top:0.7rem">
      <span id="wave-honest"></span>
    </div>

    <h4 class="section-title" style="font-size:1rem;margin-top:1.4rem">公认的康波四波，对上数据了吗</h4>
    <p class="section-desc" style="margin-top:0.2rem">
      史学界常把 1789 年以来的价格划成四波、每波分上行与下行。既然手上有 756 年数据，
      就直接把每一段的实际涨跌算出来——<strong>如果康波在价格上成立，
      上行段应普遍为正、下行段应普遍为负</strong>。
    </p>
    ${tableHtml({
      columns: [
        { label: "波次", align: "left" },
        { label: "上行段" },
        { label: "实际涨跌" },
        { label: "下行段" },
        { label: "实际涨跌" },
      ],
      rows: KONDRATIEFF_PHASES.map((p) => {
        const upA = at(p.up[0]);
        const upB = at(p.up[1]);
        const downA = at(p.down[0]);
        const downB = at(p.down[1]);
        const upChg = upA && upB ? upB / upA - 1 : null;
        const downChg = downA && downB ? downB / downA - 1 : null;
        const cls = (v) => (v === null ? "" : v > 0 ? "pos" : "neg");
        return {
          cells: [
            { html: `<strong>第 ${p.wave} 波</strong>` },
            { html: `${p.up[0]}–${p.up[1]}`, cls: "small muted" },
            { html: upChg === null ? "—" : pct(upChg), cls: cls(upChg) },
            { html: `${p.down[0]}–${p.down[1]}`, cls: "small muted" },
            { html: downChg === null ? "—" : pct(downChg), cls: cls(downChg) },
          ],
        };
      }),
      caption:
        "「上行段为正、下行段为负」本该是康波在价格上的基本预测。实际：四段下行里只有两段下跌，" +
        "第四波的下行段（1970–1990）物价反而涨了近五倍——那是石油危机与大通胀，不是萧条。",
    })}

    <div class="notice" data-tone="warn" style="margin-top:0.7rem">
      <span>
        <strong>这说明了什么：</strong>
        康波四波是<strong>事后划分</strong>的——把 1929、1973、2008 放进「哪个阶段」，
        不同作者给出的答案并不一致。当一段「下行期」里物价涨了 477%，
        要么是划分错了，要么是这个框架不适用于价格。
        <strong>无论哪种，它都不能用来判断「现在处在哪一阶段」。</strong>
      </span>
    </div>

    <h4 class="section-title" style="font-size:1rem;margin-top:1.1rem">这条序列是怎么拼出来的</h4>
    ${tableHtml({
      columns: [
        { label: "区间", align: "left" },
        { label: "来源" },
        { label: "性质" },
      ],
      rows: [
        {
          cells: [
            { html: `<strong>1264 – 1830</strong>` },
            { html: "Allen (2001) 伦敦消费者物价指数" },
            { html: "原始观测", cls: "small" },
          ],
        },
        {
          cells: [
            { html: `<strong>1831 – 1869</strong>` },
            { html: "两端几何插值" },
            { html: '<span class="muted">插值，非原始观测</span>', cls: "small" },
          ],
        },
        {
          cells: [
            { html: `<strong>1870 – 2020</strong>` },
            { html: "JST Macrohistory R6" },
            { html: "原始观测", cls: "small" },
          ],
        },
      ],
      caption:
        `两段用比值 ${uk.splice_scale} 缩放到同一基准（接近 1，说明基期本就相近）。` +
        "插值段在图上用不同颜色标出——<strong>不标注就等于把插值冒充观测</strong>。",
    })}

    <h4 class="section-title" style="font-size:1rem;margin-top:1.1rem">关键节点</h4>
    ${tableHtml({
      columns: [
        { label: "年份", align: "left" },
        { label: "事件" },
        { label: "物价指数" },
        { label: "相对 1264" },
      ],
      rows: nodes.map(([year, label]) => ({
        cells: [
          { html: `<strong>${year}</strong>` },
          { html: label, cls: "small muted" },
          { html: at(year)?.toFixed(3) ?? "—" },
          { html: `${(at(year) / at(first)).toFixed(1)} 倍` },
        ],
      })),
      caption:
        "1348 年黑死病之后人口锐减，工资上涨、物价相对下跌——这在数据里能直接看到。" +
        "但注意：<strong>单点数字的对比不等于趋势</strong>，中世纪数据的年份间波动极大。",
    })}

    <div class="notice" data-tone="info" style="margin-top:0.9rem">
      <span>
        <strong>它证明了什么、没证明什么：</strong>
        它证明了「物价水平在长周期上会经历几十年的单向阶段」——
        1264–1500 平、1500–1600 暴涨、1600–1700 平、1700–1800 又涨。
        但它<strong>没有</strong>证明这些阶段有固定周期：段长分别是 236 / 100 / 100 / 100 年，
        各不相同，也找不到「每 50–60 年一轮」的规律。
        <strong>看得见波动 ≠ 存在可预测的周期。</strong>
      </span>
    </div>

    <p class="caption">
      来源：${payload.source.allen.citation} · ${payload.source.jst.citation}
    </p>`;

  host.appendChild(card);

  // 图上把插值段标出来：整条线 + 一条虚线覆盖插值区间
  const labels = years.map((y) => String(y));
  const series = [
    { name: "英国物价指数", values, color: "var(--il-chart-1)" },
  ];

  if (interpolated) {
    const [gapStart, gapEnd] = interpolated;
    // 插值段单独一条线（前端用不同颜色，视觉上区分）
    const gapValues = years.map((y) =>
      y >= gapStart && y <= gapEnd ? values[years.indexOf(y)] : null
    );
    if (gapValues.some((v) => v !== null)) {
      series.push({
        name: `插值段（${gapStart}–${gapEnd}）`,
        values: gapValues,
        color: "var(--il-chart-3)",
        fill: false,
        width: 2.2,
      });
    }
  }

  lineChart(document.getElementById("chart-uk-price"), {
    labels,
    series,
    formatter: (v) => `${v.toFixed(0)}`,
    tipFormatter: (v) => v.toFixed(3),
    tipDateFormatter: (d) => `${d} 年`,
    ariaLabel: `英国物价指数 ${first} 至 ${last}`,
  });

  mountWaveChart(years, values);
  return true;
}

/**
 * 长波叠加图。
 *
 * 刻意做成「趋势 + 波浪」两条线分开画，而不是只画一条波浪：
 * 只画波浪会让人以为那是预测值；分开画才看得清「波浪只是相对趋势的偏离」。
 */
function mountWaveChart(years, values) {
  const chartHost = document.getElementById("chart-uk-wave");
  const statHost = document.getElementById("wave-stat");
  const captionHost = document.getElementById("wave-caption");
  const honestHost = document.getElementById("wave-honest");
  const group = document.getElementById("wave-period");
  if (!chartHost) return;

  const trendOnly = fitTrendOnly(years, values);

  const draw = (period) => {
    const fit = fitWave(years, values, period);
    if (!fit) return;

    const labels = years.map((y) => String(y));
    lineChart(chartHost, {
      labels,
      series: [
        {
          name: "实际物价",
          values,
          color: "var(--il-chart-1)",
          fill: false,
          width: 1.2,
        },
        {
          name: "趋势（对数线性）",
          values: fit.trend,
          color: "var(--il-chart-4)",
          fill: false,
          width: 1.6,
        },
        {
          name: `${period} 年长波`,
          values: fit.wave,
          color: "var(--il-chart-3)",
          fill: false,
          width: 2.6,
        },
      ],
      formatter: (v) => `${v.toFixed(0)}`,
      tipFormatter: (v) => v.toFixed(2),
      tipDateFormatter: (d) => `${d} 年`,
      ariaLabel: `英国物价叠加 ${period} 年长波`,
    });

    // 当前位置：相对趋势偏高还是偏低、在往上还是往下
    const above = fit.position >= 0;
    const rising = fit.slope > 0;
    const positionText = above ? "高于趋势" : "低于趋势";
    const directionText = rising ? "上行段" : "下行段";
    const gap = Math.exp(fit.amplitude * fit.position) - 1;

    if (statHost) {
      statHost.innerHTML = `当前位置：<strong>${positionText} ${Math.abs(gap * 100).toFixed(0)}%</strong> · <strong>${directionText}</strong>`;
    }

    if (captionHost) {
      captionHost.innerHTML =
        `粗线是 ${period} 年周期的正弦拟合，细线是对数线性趋势，最细那条是实际值。` +
        `波浪的振幅约 <strong>±${((Math.exp(fit.amplitude) - 1) * 100).toFixed(0)}%</strong>` +
        `（相对趋势）。` +
        (above
          ? `当前物价<strong>高于</strong>长期趋势约 ${Math.abs(gap * 100).toFixed(0)}%，按这条波浪看属于<strong>偏高位置</strong>。`
          : `当前物价<strong>低于</strong>长期趋势约 ${Math.abs(gap * 100).toFixed(0)}%，按这条波浪看属于<strong>偏低位置</strong>。`);
    }

    // 偏离图：log(实际) - log(趋势)，波浪就看得清了
    const devHost = document.getElementById("chart-uk-deviation");
    if (devHost) {
      const devActual = values.map((v, i) => Math.log(v) - Math.log(fit.trend[i]));
      const devWave = fit.wave.map((v, i) => Math.log(v) - Math.log(fit.trend[i]));
      lineChart(devHost, {
        labels,
        series: [
          { name: "实际偏离", values: devActual, color: "var(--il-chart-1)", fill: false, width: 1.2 },
          { name: `${period} 年长波`, values: devWave, color: "var(--il-chart-3)", fill: false, width: 2.6 },
        ],
        baselines: [{ value: 0, label: "趋势" }],
        formatter: (v) => `${(Math.exp(v) - 1 >= 0 ? "+" : "")}${((Math.exp(v) - 1) * 100).toFixed(0)}%`,
        tipFormatter: (v) => `${(Math.exp(v) - 1 >= 0 ? "+" : "")}${((Math.exp(v) - 1) * 100).toFixed(1)}%`,
        tipDateFormatter: (d) => `${d} 年`,
        ariaLabel: `英国物价相对趋势的偏离，叠加 ${period} 年长波`,
      });

      const devCaption = document.getElementById("dev-caption");
      if (devCaption) {
        devCaption.innerHTML =
          `0 线是长期趋势。曲线在 0 以上表示物价高于趋势，在 0 以下表示低于趋势。` +
          `粗波浪线的峰谷就是「什么时候上、什么时候下」——` +
          `但它同时显示：实际偏离的<strong>毛刺很大</strong>，波浪只抓到了最粗的那层形状。`;
      }
    }

    if (honestHost) {
      const gain = fit.r2 - trendOnly.r2;
      honestHost.innerHTML = `
        <strong>这条波浪线有多可信？</strong>
        纯趋势的 R² = <strong>${trendOnly.r2.toFixed(4)}</strong>，
        加上 ${period} 年正弦后 R² = <strong>${fit.r2.toFixed(4)}</strong>，
        <strong>只提升了 ${gain.toFixed(4)}</strong>。
        也就是说：这条波浪在统计上几乎解释不了任何东西，
        它的作用是<strong>视觉辅助</strong>——帮你看到「相对趋势高了还是低了」，
        <strong>不是</strong>预测下一次拐点在哪一年。
        换一个周期（45 / 70 / 175 年），形状和「当前位置」都会变——这本身就说明它不唯一。`;
    }
  };

  draw(Number(group?.value) || 55);

  group?.addEventListener("change", () => draw(Number(group.value)));
}

/* --------------------------- 长历史宏观（JST） --------------------------- */

const LONGRUN_COUNTRY_LABEL = { USA: "美国", GBR: "英国", DEU: "德国", JPN: "日本", FRA: "法国" };

async function loadLongrun() {
  try {
    const resp = await fetch(`data/longrun.json?v=${Date.now()}`, { cache: "no-cache" });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

/**
 * 长历史宏观：1870–2020 的年度序列。
 *
 * 为什么它单独一块而不是混进资产表：它只有 151 个年度点，
 * 和日频资产的「年化收益 / 波动率」不是一回事，放在资产表里会误导。
 */
function renderLongrun(host, payload, options = {}) {
  if (!host) return;
  const { skipIfShown = false } = options;
  if (!payload) {
    host.innerHTML = notice(
      "没有找到长历史宏观数据（data/longrun.json）。运行 `py scripts/import_jst.py` 生成。",
      "warn"
    );
    return;
  }

  const usa = payload.countries?.USA;
  const gbr = payload.countries?.GBR;
  if (!usa) {
    if (skipIfShown) return;
    host.innerHTML = notice("长历史数据里缺少美国序列。", "warn");
    return;
  }

  const cov = payload.coverage || {};
  const counts = payload.counts || {};
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  const at = (indicator, year) => {
    const series = usa[indicator];
    if (!series) return null;
    const index = series.years.indexOf(year);
    return index < 0 ? null : series.values[index];
  };

  // 年度 → 日期字符串（用于图表标签）
  const toLabels = (series) => series.years.map((y) => String(y));

  const wrapper = document.createElement("div");
  wrapper.className = "card";
  wrapper.innerHTML = `
      <div class="chart-head">
        <h3>长历史宏观序列</h3>
        <span class="hint">${cov.from}–${cov.to} 年度 · ${Object.keys(payload.countries).length} 国 · ${total.toLocaleString("zh-CN")} 个观测值</span>
      </div>
      <p class="section-desc">
        本站原有的最长序列是上证指数 1990 年起（35 年）。讨论「长波 / 周期」这个尺度不够，
        所以接入了 <strong>JST Macrohistory Database</strong>：1870–2020 连续 151 年，
        含物价、长期利率、政府债务 / GDP、银行危机标记、实际人均 GDP。
        <strong>频率是年度的</strong>——它适合看长周期，不适合算日频的波动率或年化收益。
      </p>

      ${metricsHtml([
        { label: "覆盖区间", value: `${cov.from}–${cov.to}`, sub: `${cov.to - cov.from + 1} 个年度` },
        {
          label: "国家",
          value: `${Object.keys(payload.countries).length} 个`,
          sub: Object.keys(payload.countries).map((iso) => LONGRUN_COUNTRY_LABEL[iso] || iso).join(" / "),
        },
        { label: "观测值", value: total.toLocaleString("zh-CN"), sub: "5 项指标合计" },
        { label: "美国 CPI 累计", value: pct(at("cpi", 2020) / at("cpi", 1870) - 1, { signed: false, digits: 0 }), sub: "1870 → 2020" },
      ])}

      <div class="chart tall" id="chart-longrun-cpi" style="margin-top:1rem"></div>
      <p class="caption">
        美国物价指数（1870 = 1）。三个明显的段落：
        1870–1913 的<strong>缓慢通缩</strong>、1913–1980 的<strong>持续通胀</strong>、
        1980 之后又趋于平缓。这种「几十年一个方向」的形态，
        就是「长波」讨论在价格层面的原始证据。
      </p>

      <div class="chart tall" id="chart-longrun-rate" style="margin-top:1rem"></div>
      <p class="caption">
        美国长期国债收益率。1929 年约 3.3%、1981 年峰值 <strong>13.91%</strong>、2020 年 0.89%。
        利率站在 40 年尺度上也是「单向走几十年再掉头」——这比物价更直观地显示了长周期。
      </p>

      <h4 class="section-title" style="font-size:1rem;margin-top:1.2rem">用公认史实核对这份数据</h4>
      ${tableHtml({
        columns: [
          { label: "事件", align: "left" },
          { label: "区间" },
          { label: "本数据的数值" },
          { label: "公认史实" },
        ],
        rows: [
          {
            cells: [
              { html: "<strong>一战通胀</strong>" },
              { html: "1913 → 1920" },
              { html: `${at("cpi", 1913).toFixed(2)} → ${at("cpi", 1920).toFixed(2)}（${pct(at("cpi", 1920) / at("cpi", 1913) - 1)}）` },
              { html: "物价翻倍以上", cls: "small muted" },
            ],
          },
          {
            cells: [
              { html: "<strong>大萧条通缩</strong>" },
              { html: "1929 → 1933" },
              { html: `${at("cpi", 1929).toFixed(2)} → ${at("cpi", 1933).toFixed(2)}（${pct(at("cpi", 1933) / at("cpi", 1929) - 1)}）` },
              { html: "物价下跌约四分之一", cls: "small muted" },
            ],
          },
          {
            cells: [
              { html: "<strong>大通胀</strong>" },
              { html: "1973 → 1980" },
              { html: `${at("cpi", 1973).toFixed(2)} → ${at("cpi", 1980).toFixed(2)}（${pct(at("cpi", 1980) / at("cpi", 1973) - 1)}）` },
              { html: "油价冲击后的高通胀", cls: "small muted" },
            ],
          },
          {
            cells: [
              { html: "<strong>沃尔克峰值</strong>" },
              { html: "1981 长端利率" },
              { html: `${num(at("ltrate", 1981))}%` },
              { html: "约 13%–15%", cls: "small muted" },
            ],
          },
          {
            cells: [
              { html: "<strong>二战债务峰值</strong>" },
              { html: "1945 债务/GDP" },
              { html: pct(at("debtgdp", 1945), { signed: false }) },
              { html: "超过 100%", cls: "small muted" },
            ],
          },
        ],
        caption:
          "这些数字全部与公认史实对得上，所以可以相信其余年份。" +
          "同一套核对也写进了 scripts/import_jst.py 与 tests/test_jst.py——" +
          "数据源换了或解析写错，测试会立刻失败。",
      })}

      <div class="notice" data-tone="info" style="margin-top:0.9rem">
        <span>
          <strong>它能说什么、不能说什么：</strong>
          151 年足够<strong>描述</strong>「物价与利率有几十年一轮的方向性阶段」，
          但一轮康波 50–60 年，这里只有约 2.5 轮——
          <strong>不够做统计推断</strong>。所以本站不会用它给任何「周期定位」或拐点日期，
          只用它把长周期画出来、并说明为什么「看得见」不等于「算得出」。
        </span>
      </div>

      <p class="caption">
        来源：${payload.source.jst?.citation || payload.source.citation} ·
        <a href="${payload.source.jst?.page || payload.source.page}" target="_blank" rel="noopener">数据主页</a>
      </p>`;
  host.appendChild(wrapper);

  // 物价（对数感的线性展示即可——151 个点不至于看不清）
  lineChart(document.getElementById("chart-longrun-cpi"), {
    labels: toLabels(usa.cpi),
    series: [{ name: "美国 CPI", values: usa.cpi.values, color: "var(--il-chart-1)" }],
    formatter: (v) => `${v.toFixed(0)}`,
    tipFormatter: (v) => v.toFixed(2),
    tipDateFormatter: (d) => `${d} 年`,
    ariaLabel: "美国物价指数 1870 至 2020",
  });

  lineChart(document.getElementById("chart-longrun-rate"), {
    labels: toLabels(usa.ltrate),
    series: [{ name: "美国长期国债收益率", values: usa.ltrate.values, color: "var(--il-chart-3)" }],
    formatter: (v) => `${v.toFixed(1)}%`,
    tipFormatter: (v) => `${v.toFixed(2)}%`,
    tipDateFormatter: (d) => `${d} 年`,
    ariaLabel: "美国长期国债收益率 1870 至 2020",
  });

  // 英国作为对照，仅在有数据时补一条
  if (gbr?.cpi) {
    const host2 = document.getElementById("chart-longrun-cpi");
    if (host2) {
      lineChart(host2, {
        labels: toLabels(usa.cpi),
        series: [
          { name: "美国 CPI", values: usa.cpi.values, color: "var(--il-chart-1)" },
          { name: "英国 CPI", values: gbr.cpi.values, color: "var(--il-chart-3)", fill: false, width: 1.4 },
        ],
        formatter: (v) => `${v.toFixed(0)}`,
        tipFormatter: (v) => v.toFixed(2),
        tipDateFormatter: (d) => `${d} 年`,
        ariaLabel: "美国与英国物价指数 1870 至 2020",
      });
    }
  }
}

async function main() {
  initShell({ active: "data" });
  const host = document.getElementById("data-summary");

  try {
    const [assets, meta, quality] = await Promise.all([
      loadIndex(),
      loadMeta().catch(() => null),
      loadQuality().catch(() => null),
    ]);

    if (!assets.length) {
      host.innerHTML = notice("资产索引为空，说明构建步骤没有产出数据。", "warn");
      return;
    }

    renderSummary(meta, quality, assets);
    renderCalendars(quality);

    // 长历史宏观数据（独立于资产体系，年度频率）
    const longrunHost = document.getElementById("longrun-section");
    if (longrunHost) {
      const payload = await loadLongrun();
      // 优先展示跨 757 年的英国物价；没有就退回 JST 的 151 年展示
      const shown = renderUkPriceIndex(longrunHost, payload);
      renderLongrun(longrunHost, payload, { skipIfShown: shown });
    }

    renderGaps(quality);
    renderGroups(assets, meta, quality);
    renderTable(assets, quality);
  } catch (err) {
    showError(host, `加载失败：${err.message}`);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}