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
import { KONDRATIEFF_PHASES } from "../core/wave.js";
import { mountWavePanel } from "../ui/wave-panel.js";

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

  // 挂上纯三角函数的长波面板
  const waveHost = document.createElement("div");
  waveHost.id = "uk-wave-panel";
  waveHost.style.marginTop = "1rem";
  host.appendChild(waveHost);

  mountWavePanel(waveHost, {
    title: "英国物价的纯三角函数拟合",
    subtitle: `${first}–${last} · ${years.length} 个年度值`,
    years,
    values,
    defaultHarmonics: 16,
    harmonicsRange: [2, 40],
    note:
      `这条序列跨 <strong>${last - first} 年</strong>，是站内最长的数据。` +
      `拟合<strong>全部由三角函数构成</strong>，没有线性项——` +
      `长期趋势由 <code>1 − cos(πt/T)</code> 这一项承担，它本身也是余弦。`,
  });

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

  return true;
}

/**
 * 长波叠加图。
 *
 * 刻意做成「趋势 + 波浪」两条线分开画，而不是只画一条波浪：
 * 只画波浪会让人以为那是预测值；分开画才看得清「波浪只是相对趋势的偏离」。
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

/**
 * 宽基指数的长波分析。
 *
 * 为什么单独一块：物价和股指是两类东西——
 *   物价是「钱变毛了多少」，股指是「企业赚了多少」。
 *   两者都能用同一套 A·sin(aπ+b) 拟合，但解释完全不同。
 *
 * 选两个代表：
 *   上证指数（1990 起，35 年）——中国投资者最熟悉的
 *   沪深300全收益（2005 起，21 年）——含分红，更能代表真实回报
 */
/**
 * 美股长波：Shiller 1871 起（152 年）。
 *
 * 为什么要用它代替标普 500：
 *   站内标普 500 只有 2005 年起（22 年），而一轮康波 50–60 年，
 *   22 年连半个波都不到。Shiller 的 S&P Composite 是标普 500 的
 *   **前身系列**（同一指数更早的段），1871 年起 152 年，
 *   这才够看出 50–60 年尺度的长波。
 */
async function renderBroadWave(host) {
  host.innerHTML = `<div class="loading-inline">正在加载 Shiller 美股长历史…</div>`;

  try {
    const resp = await fetch(`data/shiller.json?v=${Date.now()}`, { cache: "no-cache" });
    if (!resp.ok) {
      host.innerHTML = notice(
        "没有找到 data/shiller.json。运行 `py scripts/import_shiller.py` 生成。",
        "warn"
      );
      return;
    }
    const payload = await resp.json();

    host.innerHTML = `
      <div class="notice" data-tone="info">
        <span>
          下面是 <strong>Shiller 美国股市 1871 年起</strong>的长波分析——
          这是标普 500 的<strong>前身系列</strong>，同一指数更早的段，共
          <strong>${payload.coverage.years} 年</strong>。
          站内标普 500 只有 22 年，看不出 50–60 年的康波；这条 152 年的序列才够。
        </span>
      </div>
      <div id="shiller-wave-host" style="margin-top:1rem"></div>`;

    const waveHost = host.querySelector("#shiller-wave-host");

    mountWavePanel(waveHost, {
      title: "标普综合指数（1871 年起）",
      subtitle: `${payload.coverage.from} – ${payload.coverage.to} · ${payload.coverage.months} 个月`,
      // 用小数年，避免同一年重复
      years: payload.fractions,
      values: payload.series.price,
      dateLabels: payload.labels,
      defaultHarmonics: 20,
      harmonicsRange: [2, 60],
      valueLabel: "指数",
      note:
        `S&P Composite 从 ${payload.series.price[0].toFixed(2)} 涨到 ` +
        `${payload.series.price[payload.series.price.length - 1].toFixed(0)}，约 ` +
        `<strong>${(payload.series.price[payload.series.price.length - 1] / payload.series.price[0]).toFixed(0)} 倍</strong>` +
        `（${payload.coverage.years} 年）。<br />` +
        `数据核对：1929-09 高点 31.3、1932-06 底部 4.8（−85%）、2000-01 高点 1425.6、` +
        `2009-03 底部 757.1 —— 全部与史实一致。`,
    });

    // 再补一条：实际总回报（含股息、扣通胀）
    const trHost = document.createElement("div");
    trHost.id = "shiller-tr-host";
    trHost.style.marginTop = "1rem";
    host.appendChild(trHost);

    mountWavePanel(trHost, {
      title: "实际总回报指数（含股息、扣通胀）",
      subtitle: `${payload.coverage.from} – ${payload.coverage.to}`,
      years: payload.fractions,
      values: payload.series.realTotalReturn,
      dateLabels: payload.labels,
      defaultHarmonics: 20,
      harmonicsRange: [2, 60],
      valueLabel: "实际回报",
      note:
        `这是<strong>真正到手的购买力</strong>：含股息再投资、扣除通胀。` +
        `指数从 ${payload.series.realTotalReturn[0].toFixed(0)} 到 ` +
        `${payload.series.realTotalReturn[payload.series.realTotalReturn.length - 1].toFixed(0)}，` +
        `约 <strong>${(payload.series.realTotalReturn[payload.series.realTotalReturn.length - 1] / payload.series.realTotalReturn[0]).toFixed(0)} 倍</strong>。` +
        `对比上面不含股息的指数，差距就是股息的贡献。`,
    });
  } catch (err) {
    host.innerHTML = notice(`加载 Shiller 数据失败：${err.message}`, "warn");
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

    // 宽基指数的长波分析（和物价用同一套方法，方便对照）
    const broadHost = document.getElementById("broadwave-section");
    if (broadHost) {
      await renderBroadWave(broadHost);
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