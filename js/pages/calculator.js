/**
 * js/pages/calculator.js — 投资计算器页。
 *
 * 四个模块互不依赖，输入变化即重算。数学部分全部在 js/core/calc.js。
 */

import { initShell } from "../core/shell.js";
import { annuity, compoundGrowth, drawdownRecovery, monthsToTarget, rebalancePlan } from "../core/calc.js";
import { lineChart } from "../core/charts.js";
import { metricsHtml, notice, tableHtml } from "../ui/cards.js";
import { money, num, pct, tone } from "../core/format.js";

const els = {};

function numField(id, fallback = 0) {
  const el = document.getElementById(id);
  const value = Number(el.value);
  return Number.isFinite(value) && el.value !== "" ? value : fallback;
}

/* --------------------------------- 复利 --------------------------------- */

function renderCompound() {
  const result = compoundGrowth({
    principal: numField("cp-principal"),
    monthly: numField("cp-monthly"),
    annualRate: numField("cp-rate", 7) / 100,
    years: numField("cp-years", 20),
  });

  const host = document.getElementById("cp-result");
  const growthMultiple = result.totalInvested > 0 ? result.finalValue / result.totalInvested : null;
  const target = monthsToTarget({
    monthly: numField("cp-monthly"),
    annualRate: numField("cp-rate", 7) / 100,
    target: 1_000_000,
  });

  host.innerHTML = `
    <div class="card">
      <div class="chart-head">
        <h3>增长曲线</h3>
        <span class="hint">${result.years} 年 · 年化 ${pct(result.annualRate, { signed: false })}</span>
      </div>
      ${metricsHtml([
        { label: "期末总资产", value: money(result.finalValue) },
        { label: "累计投入", value: money(result.totalInvested) },
        {
          label: "累计收益",
          value: money(result.gain),
          tone: result.gain >= 0 ? "pos" : "neg",
          sub: `总收益率 ${pct(result.totalReturn)}`,
        },
        {
          label: "本金膨胀倍数",
          value: growthMultiple ? `${growthMultiple.toFixed(2)} 倍` : "—",
          sub: "终值 ÷ 累计投入",
        },
        {
          label: "攒到 100 万",
          value: target ? `${(target / 12).toFixed(1)} 年` : "60 年内达不到",
          sub: "按当前参数继续投入",
        },
      ])}
      <div class="chart" id="chart-compound" style="margin-top:0.9rem"></div>
    </div>
    <div class="card">
      <h2 class="section-title">关键提醒</h2>
      <p class="section-desc">
        这 ${result.years} 年里，你一共投入 ${money(result.totalInvested)}，
        最终变成 ${money(result.finalValue)}。其中真正靠「复利」赚到的部分，
        在初期几乎为零——它的绝大部分来自最后几年。
        这也解释了为什么长期投资最难的部分不是选资产，而是熬时间。
      </p>
    </div>`;

  const labels = result.rows.map((row) => `${Math.floor(row.month / 12)}年`);
  lineChart(document.getElementById("chart-compound"), {
    labels,
    series: [
      { name: "累计投入", values: result.rows.map((r) => r.invested), color: "var(--il-chart-3)", fill: false, width: 1.5 },
      { name: "账户市值", values: result.rows.map((r) => r.value), color: "var(--il-chart-1)" },
    ],
    formatter: (v) => `¥${Math.round(v / 10000)}万`,
    tipFormatter: (v) => money(v),
    labelFormatter: (label, i) => (i % 12 === 0 ? label : ""),
    tipDateFormatter: (label) => label,
  });
}

/* --------------------------------- 定投 --------------------------------- */

function renderAnnuity() {
  const freq = Number(document.getElementById("an-freq").value) || 12;
  const result = annuity({
    amount: numField("an-amount"),
    annualRate: numField("an-rate", 8) / 100,
    years: numField("an-years", 15),
    timesPerYear: freq,
  });

  const host = document.getElementById("an-result");
  const freqLabel = { 12: "每月", 52: "每周", 4: "每季", 1: "每年" }[freq] || `${freq} 次/年`;

  host.innerHTML = `
    <div class="card">
      ${metricsHtml([
        { label: "期末终值", value: money(result.finalValue) },
        { label: "累计投入", value: money(result.invested), sub: `${result.periods} 期 · ${freqLabel}` },
        {
          label: "累计收益",
          value: money(result.gain),
          tone: result.gain >= 0 ? "pos" : "neg",
          sub: `总收益率 ${pct(result.totalReturn)}`,
        },
        {
          label: "收益占比",
          value: result.finalValue > 0 ? pct(result.gain / result.finalValue, { signed: false }) : "—",
          sub: "终值里有多少是赚来的",
        },
      ])}
      <p class="section-desc" style="margin-top:0.9rem">
        投入越频繁，资金在场内的平均时间越长，所以「每周投」和「每年投」在同一收益率下
        终值会有差别。这也是为什么一次性投入在上涨市场里通常优于此前的分期投入——
        但它的代价是你必须一次承受住择时风险。
      </p>
    </div>`;
}

/* -------------------------------- 回撤 ---------------------------------- */

function renderDrawdown() {
  const high = numField("dd-high");
  const low = numField("dd-low");
  const host = document.getElementById("dd-result");
  const result = drawdownRecovery(high, low);

  if (!result) {
    host.innerHTML = notice("请输入有效价格：高点必须大于 0，低点必须为正且不高于高点。", "warn");
    return;
  }

  const ladder = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9].map((dd) => ({
    dd,
    recovery: dd / (1 - dd),
  }));

  host.innerHTML = `
    <div class="card">
      ${metricsHtml([
        {
          label: "回撤幅度",
          value: pct(result.drawdown, { signed: false }),
          tone: "neg",
          sub: `${money(result.high)} → ${money(result.low)}`,
        },
        {
          label: "回本所需涨幅",
          value: pct(result.recovery, { signed: false }),
          tone: "pos",
          sub: "回到原点需要涨这么多",
        },
        {
          label: "不对称倍数",
          value: result.ratio ? `${result.ratio.toFixed(2)} 倍` : "—",
          sub: "回本涨幅 ÷ 回撤幅度",
        },
        {
          label: "少赚的钱",
          value: money(result.high - result.low),
          tone: "neg",
          sub: "每 1 元本金的账面亏损",
        },
      ])}
    </div>
    <div class="card">
      <h2 class="section-title">回撤—回本对照表</h2>
      ${tableHtml({
        columns: [{ label: "回撤", align: "left" }, { label: "回本所需涨幅" }, { label: "直觉上的错觉" }],
        rows: ladder.map((row) => ({
          cells: [
            { html: `跌 ${(row.dd * 100).toFixed(0)}%` },
            { html: `<strong>涨 ${(row.recovery * 100).toFixed(1)}%</strong>`, cls: "pos" },
            {
              html:
                row.dd >= 0.8
                  ? "已经几乎不可能靠「等一下」修复"
                  : row.dd >= 0.5
                    ? "需要一轮完整的牛市"
                    : row.dd >= 0.3
                      ? "需要明显超过平均水平的上涨"
                      : "正常波动范围",
            },
          ],
        })),
        caption: "这就是为什么风险管理里，先想「能亏多少」比先想「能赚多少」更重要。",
      })}
    </div>`;
}

/* -------------------------------- 再平衡 --------------------------------- */

const rbState = {
  items: [
    { name: "沪深300ETF", current: 60000, target: 50 },
    { name: "国债ETF", current: 30000, target: 30 },
    { name: "黄金ETF", current: 30000, target: 20 },
  ],
};

function renderRebalanceInputs() {
  const host = document.getElementById("rb-inputs");
  host.innerHTML = rbState.items
    .map(
      (item, i) => `
      <div class="row" style="margin-bottom:0.5rem;align-items:flex-end">
        <div style="flex:2 1 10rem">
          <mdui-text-field data-i="${i}" data-k="name" label="资产名称" value="${item.name}" variant="outlined"></mdui-text-field>
        </div>
        <div style="flex:1 1 8rem">
          <mdui-text-field data-i="${i}" data-k="current" label="当前市值" type="number" value="${item.current}" prefix="¥" min="0" step="1000" variant="outlined"></mdui-text-field>
        </div>
        <div style="flex:1 1 7rem">
          <mdui-text-field data-i="${i}" data-k="target" label="目标权重" type="number" value="${item.target}" suffix="%" min="0" max="100" step="5" variant="outlined"></mdui-text-field>
        </div>
      </div>`
    )
    .join("");

  host.querySelectorAll("mdui-text-field").forEach((field) => {
    field.addEventListener("input", () => {
      const index = Number(field.dataset.i);
      const key = field.dataset.k;
      const raw = field.value;
      rbState.items[index][key] = key === "name" ? raw : Number(raw) || 0;
      renderRebalanceResult();
    });
  });
}

function renderRebalanceResult() {
  const host = document.getElementById("rb-result");
  const totalInput = document.getElementById("rb-total");
  const declaredTotal = Number(totalInput.value);
  const result = rebalancePlan({
    total: Number.isFinite(declaredTotal) && declaredTotal > 0 ? declaredTotal : undefined,
    items: rbState.items,
  });

  if (!result.valid) {
    host.innerHTML = notice(
      `目标权重合计 ${result.targetSum}%，必须等于 100%。请调整后再看结果。`,
      "warn"
    );
    return;
  }

  const buys = result.rows.filter((r) => r.action === "buy");
  const sells = result.rows.filter((r) => r.action === "sell");

  host.innerHTML = `
    <div class="card">
      ${metricsHtml([
        { label: "组合总额", value: money(result.total) },
        { label: "需要买入", value: money(buys.reduce((a, b) => a + b.delta, 0)), tone: "pos", sub: `${buys.length} 项` },
        { label: "需要卖出", value: money(Math.abs(sells.reduce((a, b) => a + b.delta, 0))), tone: "neg", sub: `${sells.length} 项` },
        {
          label: "当前偏离度",
          value: pct(result.drift, { signed: false }),
          sub: "各资产权重偏离目标的一半之和",
        },
      ])}
    </div>
    <div class="card">
      <h2 class="section-title">调整明细</h2>
      ${tableHtml({
        columns: [
          { label: "资产", align: "left" },
          { label: "当前市值" },
          { label: "当前权重" },
          { label: "目标权重" },
          { label: "目标市值" },
          { label: "操作" },
        ],
        rows: result.rows.map((row) => ({
          cells: [
            { html: `<strong>${row.name}</strong>` },
            { html: money(row.current) },
            { html: result.total > 0 ? pct(row.current / result.total, { signed: false }) : "—" },
            { html: pct(row.target / 100, { signed: false }) },
            { html: money(row.targetAmount) },
            {
              html:
                row.action === "buy"
                  ? `买入 ${money(row.delta)}`
                  : row.action === "sell"
                    ? `卖出 ${money(-row.delta)}`
                    : "无需调整",
              cls: row.action === "buy" ? "pos" : row.action === "sell" ? "neg" : "muted",
            },
          ],
        })),
        caption:
          "再平衡的实质是「卖强买弱」，它强迫你在上涨后减仓、下跌后加仓，从而把风险维持在目标水平。",
      })}
    </div>`;
}

/* --------------------------------- 启动 --------------------------------- */

function bindTabs() {
  const tabs = document.getElementById("calc-tabs");
  const panels = ["compound", "dca", "drawdown", "rebalance"];
  const show = (value) => {
    panels.forEach((name) => {
      document.getElementById(`panel-${name}`).classList.toggle("hidden", name !== value);
    });
    if (value === "compound") renderCompound();
    if (value === "dca") renderAnnuity();
    if (value === "drawdown") renderDrawdown();
    if (value === "rebalance") renderRebalanceResult();
  };
  tabs.addEventListener("change", () => show(tabs.value));
  show(tabs.value || "compound");
}

function main() {
  initShell({ active: "calculator" });

  ["cp-principal", "cp-monthly", "cp-rate", "cp-years"].forEach((id) => {
    document.getElementById(id).addEventListener("input", renderCompound);
  });
  ["an-amount", "an-rate", "an-years"].forEach((id) => {
    document.getElementById(id).addEventListener("input", renderAnnuity);
  });
  document.getElementById("an-freq").addEventListener("change", renderAnnuity);
  ["dd-high", "dd-low"].forEach((id) => {
    document.getElementById(id).addEventListener("input", renderDrawdown);
  });
  document.getElementById("rb-total").addEventListener("input", renderRebalanceResult);
  document.getElementById("rb-add").addEventListener("click", () => {
    rbState.items.push({ name: `资产 ${rbState.items.length + 1}`, current: 0, target: 0 });
    renderRebalanceInputs();
    renderRebalanceResult();
  });

  renderRebalanceInputs();
  bindTabs();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}