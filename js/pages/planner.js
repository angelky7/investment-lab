/**
 * js/pages/planner.js — 配置求解器页面。
 *
 * 页面只做三件事：收集答案、调用 js/core/planner.js、把结果解释清楚。
 * 所有计算都是纯函数，可以在 Node 里单独测试（见 tests/planner.test.mjs）。
 */

import { initShell, showError, loadingHtml } from "../core/shell.js";
import { loadIndex, loadSeries, loadSeriesMany, findAsset } from "../core/store.js";
import { alignByDate } from "../core/series.js";
import {
  ASSET_CLASSES,
  QUESTIONS,
  buildNarrative,
  constraintsFromAnswers,
  evaluateAllocation,
  minDrawdownFor,
  searchAllocation,
  windowNote,
} from "../core/planner.js";
import { lineChart, scatterChart } from "../core/charts.js";
import { metricsHtml, notice, tableHtml } from "../ui/cards.js";
import { dateLabel, money, num, pct, rangeLabel, tone } from "../core/format.js";

const state = {
  assets: [],
  // 用户勾选的资产类别（至少保留 2 类）。黄金、海外股票这些不想要就可以不配。
  included: ASSET_CLASSES.map((c) => c.id),
  // 优化目标：收益最高 / 性价比最高（夏普）/ 回撤最小
  objective: "return",
  answers: {
    drawdown: 0.2,
    target: [0.05, 0.07],
    horizon: 5,
    behavior: "hold",
  },
};

let solving = false;
const seq = { current: 0 };

/** 叙述文本里的 **强调** 转成 <strong>（内容由本项目生成，不含用户输入） */
function md(text) {
  return String(text).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

/* ------------------------------ 资产类别选择 ----------------------------- */

function renderClassPicker() {
  const host = document.getElementById("class-picker");
  if (!host) return;

  host.innerHTML = `
    <p class="question-hint" style="margin-bottom:0.6rem">
      不想要的类别可以直接取消勾选——例如不想配黄金、或不想承担海外股票的汇率风险。
      至少保留 2 类，否则没法构成组合。
    </p>
    <div class="choice-list">
      ${ASSET_CLASSES.map(
        (item) => `
        <label class="choice ${state.included.includes(item.id) ? "on" : ""}" data-class="${item.id}">
          <input type="checkbox" ${state.included.includes(item.id) ? "checked" : ""} />
          <span class="choice-label">${item.label}</span>
          <span class="choice-note">${item.role}</span>
        </label>`
      ).join("")}
    </div>
    <p class="small muted" id="class-status" style="margin:0.5rem 0 0"></p>`;

  const update = () => {
    const status = host.querySelector("#class-status");
    const excluded = ASSET_CLASSES.filter((c) => !state.included.includes(c.id));
    status.textContent =
      state.included.length < 2
        ? "至少要保留 2 个类别"
        : excluded.length
          ? `已排除：${excluded.map((c) => c.label).join("、")}`
          : "全部 5 个类别都参与";
  };
  update();

  host.querySelectorAll(".choice").forEach((label) => {
    label.addEventListener("click", (event) => {
      event.preventDefault();
      const id = label.dataset.class;
      const isOn = state.included.includes(id);
      if (isOn && state.included.length <= 2) {
        update();
        return;
      }
      state.included = isOn
        ? state.included.filter((x) => x !== id)
        : [...state.included, id];
      label.classList.toggle("on", !isOn);
      label.querySelector("input").checked = !isOn;
      update();
      window.setTimeout(runSolve, 60);
    });
  });
}

/* ------------------------------- 问卷渲染 ------------------------------- */

function renderQuestions() {
  const host = document.getElementById("questions");
  host.innerHTML = QUESTIONS.map((question, index) => {
    const current = state.answers[question.id];
    return `
      <div class="question" data-question="${question.id}">
        <p class="question-title">${index + 1}. ${question.title}</p>
        <p class="question-hint">${question.hint}</p>
        <div class="choice-list">
          ${question.options
            .map((option, optionIndex) => {
              const selected = Array.isArray(current)
                ? Array.isArray(option.value) && option.value[0] === current[0]
                : option.value === current;
              return `
              <label class="choice ${selected ? "on" : ""}" data-index="${optionIndex}">
                <input type="radio" name="q-${question.id}" ${
                  selected ? "checked" : ""
                } value="${optionIndex}" />
                <span class="choice-label">${option.label}</span>
                <span class="choice-note">${option.note || ""}</span>
              </label>`;
            })
            .join("")}
        </div>
      </div>`;
  }).join("");

  host.querySelectorAll(".choice").forEach((label) => {
    label.addEventListener("click", () => {
      const wrapper = label.closest("[data-question]");
      const questionId = wrapper.dataset.question;
      const question = QUESTIONS.find((q) => q.id === questionId);
      const option = question.options[Number(label.dataset.index)];

      state.answers[questionId] = Array.isArray(option.value)
        ? option.value.slice()
        : option.value;

      wrapper.querySelectorAll(".choice").forEach((el) => el.classList.remove("on"));
      label.classList.add("on");
      // 选项一变就重算（这是探索工具，不该逼用户反复点按钮）
      window.setTimeout(runSolve, 60);
    });
  });
}

/* -------------------------------- 求解 ---------------------------------- */

async function runSolve() {
  if (solving) return;
  solving = true;
  const token = ++seq.current;
  const host = document.getElementById("planner-result");
  const status = document.getElementById("solve-status");
  const button = document.getElementById("btn-solve");

  button.disabled = true;
  status.textContent = "正在加载数据…";
  host.innerHTML = loadingHtml("正在配对资产、枚举候选配比并逐个回测…");

  try {
    const assets = await loadIndex();
    state.assets = assets;

    const classes = ASSET_CLASSES.map((item) => ({
      ...item,
      asset: findAsset(assets, item.key),
    })).filter((item) => item.asset);

    if (classes.length !== ASSET_CLASSES.length) {
      host.innerHTML = notice(
        "有资产类别不在数据索引中（可能是登记表被改动）。请检查 config/assets.json。",
        "warn"
      );
      return;
    }

    const seriesList = await loadSeriesMany(classes.map((c) => c.asset));
    if (token !== seq.current) return;
    if (seriesList.length !== classes.length) {
      host.innerHTML = notice("数据加载失败，请稍后重试。", "warn");
      return;
    }

    const byKey = new Map(seriesList.map((s) => [s.key, s]));
    const entries = classes.map((c) => ({
      key: c.id,
      dates: byKey.get(c.key).dates,
      prices: byKey.get(c.key).prices,
    }));
    const aligned = alignByDate(entries);
    if (aligned.dates.length < 500) {
      host.innerHTML = notice("共同交易日太少，无法计算。", "warn");
      return;
    }

    status.textContent = "正在枚举与回测候选配置…";
    const prices = aligned.dates.map((_, t) =>
      classes.map((c) => aligned.values[c.id][t])
    );

    const dateStart = Date.parse(`${aligned.dates[0]}T00:00:00Z`);
    const dateEnd = Date.parse(`${aligned.dates[aligned.dates.length - 1]}T00:00:00Z`);
    const years = (dateEnd - dateStart) / (365.25 * 86400000);

    const constraints = constraintsFromAnswers(state.answers);
    const includeMask = classes.map((c) => state.included.includes(c.id));
    const started = performance.now();
    const search = searchAllocation({
      prices,
      years,
      budget: constraints.drawdownBudget,
      targetLow: constraints.targetLow,
      equityCap: constraints.equityCap,
      equityFlags: classes.map((c) => c.equity),
      includeMask,
      step: 0.1,
      objective: state.objective,
    });
    const elapsed = Math.round(performance.now() - started);

    if (token !== seq.current) return;

    const chosen = search.chosen;
    const narrative = buildNarrative(constraints, search, chosen);

    // 反推：把「你想要的收益」当输入，看历史上最少要承受多少回撤
    const reached = minDrawdownFor(search, constraints.targetLow);
    if (reached) {
      const reachedWeights = classes
        .map((c, i) => (reached.weights[i] > 0 ? `${c.label} ${Math.round(reached.weights[i] * 100)}%` : ""))
        .filter(Boolean)
        .join(" · ");
      narrative.bullets.push(
        `反过来问：要达到你期望的 ${(constraints.targetLow * 100).toFixed(0)}% 年化，` +
          `历史上最少要承受 <strong>${pct(Math.abs(reached.maxDrawdown), { signed: false })}</strong> 的回撤（实际年化 ${pct(
            reached.annualized
          )}）。` +
          `对应的配比是 ${reachedWeights}；和你当前的预算 ` +
          `${(constraints.drawdownBudget * 100).toFixed(0)}% 对比一下，就知道这个收益目标离你有多远。`
      );
    } else {
      narrative.warnings.push(
        `你期望的 ${(constraints.targetLow * 100).toFixed(0)}% 年化，在历史数据里没有任何一组候选配置做到过。` +
          "这不是算法保守，是这段历史里不存在——继续坚持这个目标，等于假设未来会比过去好。"
      );
    }
    status.textContent = `已回测 ${search.candidates.length} 组合法配比，用时 ${elapsed} ms`;

    if (!chosen) {
      host.innerHTML = `
        <div class="card">
          <h2 class="section-title">没有可行解</h2>
          ${notice(
            search.reason ||
              "在历史数据里，没有任何一组配比能同时满足你的回撤预算与权益上限。" +
                "这通常意味着约束过紧（例如要求回撤 < 5% 却又想要 10% 年化），或者勾选的类别太少、彼此又太相似。",
            "warn"
          )}
          <p class="section-desc" style="margin-top:0.9rem">${windowNote(classes, classes.map((c) => byKey.get(c.key).dates[0]))}</p>
        </div>`;
      return;
    }

    // 选中组合的完整回测（初始 1 万元，便于对照）
    const chosenValues = evaluateAllocation(chosen.weights, prices, {
      years,
      initial: 10000,
    });
    const stockIndex = classes.findIndex((c) => c.id === "cnStock");
    const stockWeights = classes.map((_, i) => (i === stockIndex ? 1 : 0));
    const stockValues = evaluateAllocation(stockWeights, prices, { years, initial: 10000 });

    // 选中组合的净值曲线（用于画图）
    const curve = (weights) => {
      const units = weights.map((w, i) => (w * 10000) / prices[0][i]);
      const out = [];
      for (let t = 0; t < prices.length; t += 1) {
        let total = 0;
        for (let i = 0; i < units.length; i += 1) total += units[i] * prices[t][i];
        out.push(total);
        if (t > 0 && t < prices.length - 1 && t % 252 === 0) {
          for (let i = 0; i < units.length; i += 1) {
            units[i] = (total * weights[i]) / prices[t][i];
          }
        }
      }
      return out;
    };

    host.innerHTML = `
      <div class="card">
        <div class="chart-head">
          <h3>计算结果</h3>
          <span class="hint">${rangeLabel(aligned.dates[0], aligned.dates[aligned.dates.length - 1])} · ${aligned.dates.length} 个共同交易日 · 候选 ${search.candidates.length} 组</span>
        </div>
        ${metricsHtml([
          {
            label: "历史年化",
            value: pct(chosen.annualized),
            tone: tone(chosen.annualized),
            sub: `目标 ${(constraints.targetLow * 100).toFixed(0)}%–${(constraints.targetHigh * 100).toFixed(0)}%`,
          },
          {
            label: "最大回撤",
            value: pct(chosen.maxDrawdown),
            tone: "neg",
            sub: `预算 ${(constraints.drawdownBudget * 100).toFixed(0)}%`,
          },
          {
            label: "年化波动",
            value: pct(chosen.volatility, { signed: false }),
            sub: "组合层面的日收益标准差年化",
          },
          {
            label: "夏普比率",
            value: num(chosen.sharpe),
            sub: "无风险利率按 2.5% 计",
          },
          {
            label: "权益暴露",
            value: pct(chosen.equity, { signed: false }),
            sub: constraints.equityCap < 1 ? `上限 ${(constraints.equityCap * 100).toFixed(0)}%` : "无额外上限",
          },
          {
            label: "候选数",
            value: `${search.feasible.length}/${search.candidates.length}`,
            sub: "满足回撤预算的组合数",
          },
        ])}
        <div class="stack" style="margin-top:0.9rem;gap:.5rem">
          ${narrative.bullets
            .map((text) => `<div class="notice" data-tone="info"><span>${md(text)}</span></div>`)
            .join("")}
          ${narrative.warnings
            .map((text) => `<div class="notice" data-tone="warn"><span>${md(text)}</span></div>`)
            .join("")}
        </div>
      </div>

      <div class="card">
        <h2 class="section-title">这组配置的构成</h2>
        ${
          classes.filter((c) => !state.included.includes(c.id)).length
            ? `<p class="section-desc" style="margin:0 0 .7rem">你排除了：${classes
                .filter((c) => !state.included.includes(c.id))
                .map((c) => c.label)
                .join("、")}——它们的权重被固定为 0，不参与本次搜索。</p>`
            : ""
        }
        <div class="stack" style="gap:.4rem">
          ${classes
            .filter((c) => state.included.includes(c.id))
            .map((c) => {
              const i = classes.indexOf(c);
              const weight = chosen.weights[i];
              return `
              <div class="weight-bar-row">
                <span class="weight-bar-name">${c.label}</span>
                <div class="weight-bar-track">
                  <div class="weight-bar-fill" style="width:${(weight * 100).toFixed(0)}%"></div>
                </div>
                <span class="weight-bar-value num">${pct(weight, { signed: false, digits: 0 })}</span>
              </div>`;
            })
            .join("")}
        </div>
        ${tableHtml({
          columns: [
            { label: "资产类别", align: "left" },
            { label: "代码" },
            { label: "权重" },
            { label: "作用" },
            { label: "数据起点" },
          ],
          rows: classes
            .filter((c) => state.included.includes(c.id))
            .map((c) => ({ c, i: classes.indexOf(c) }))
            .map(({ c, i }) => ({
            cells: [
              { html: `<strong>${c.label}</strong>` },
              { html: c.asset.symbol, cls: "small" },
              { html: pct(chosen.weights[i], { signed: false, digits: 0 }) },
              { html: c.role, cls: "small muted" },
              { html: byKey.get(c.key).dates[0], cls: "small" },
            ],
          })),
          caption:
            `本次参与 ${search.bounds.included} 类，每档限制在 ${(search.bounds.minWeight * 100).toFixed(0)}%–${(
              search.bounds.maxWeight * 100
            ).toFixed(0)}%。` +
            "为什么要加这个限制：不加边界时，搜索会把权重全压到「这段历史里涨得最好的那两档」，" +
            "那是过拟合而不是配置。步长 10%，更细的网格只会让过拟合更精准。",
        })}
      </div>

      <div class="card">
        <div class="chart-head">
          <h3>风险—收益候选云</h3>
          <span class="hint">横轴＝历史最大回撤，纵轴＝历史年化；红线左＝在预算内，蓝线上＝达到收益目标</span>
        </div>
        <div class="chart tall" id="chart-cloud"></div>
        <p class="caption">
          看懂这张图比看结论更重要：<strong>越往左上越好，但左上角的区域通常是空的</strong>。
          回撤预算（红线左侧）与收益目标（蓝线上方）的交集越小，说明你的要求越接近「没有免费午餐」的地带。
        </p>
      </div>

      <div class="card">
        <div class="chart-head">
          <h3>这组配置的历史净值</h3>
          <span class="hint">每年调回目标权重；对照为 100% A 股宽基</span>
        </div>
        <div class="chart tall" id="chart-curve"></div>
        <p class="section-desc" style="margin-top:0.7rem">
          期末：本配置 ${money(chosenValues.finalValue)}，100% A 股宽基 ${money(
      stockValues.finalValue
    )}（初始均为 1 万元）。两条线的间距，就是「分散」在这段历史里给出的全部东西。
        </p>
      </div>

      <div class="card">
        <h2 class="section-title">这次计算的边界</h2>
        <p class="section-desc" style="margin:0 0 .6rem">${windowNote(classes, classes.map((c) => byKey.get(c.key).dates[0]))}</p>
        <ul class="section-desc" style="margin:0;padding-left:1.1rem;line-height:1.9">
          <li>候选配比按 ${(search.bounds.step * 100).toFixed(0)}% 步长枚举，每档限制在 ${(
            search.bounds.minWeight * 100
          ).toFixed(0)}%–${(search.bounds.maxWeight * 100).toFixed(0)}%、至少 ${search.bounds.minClasses} 类参与，共 ${
            search.candidates.length
          } 组；每年调回目标权重，未考虑调仓摩擦。</li>
          <li>「可行」的判定是历史最大回撤不超过你的预算，而不是「未来回撤不会超过」。</li>
          <li>收益目标只用于解释结果，不参与优化目标——先满足回撤约束，再谈收益，这是刻意的次序。</li>
          <li>五个类别的 ETF 都是后复权序列，分红与票息已经再投资。</li>
        </ul>
      </div>`;

    // 散点图：候选云 + 预算线 + 目标线 + 选中点 + 100% 股票参考点
    const points = search.candidates.map((p) => ({
      x: Math.abs(p.maxDrawdown) * 100,
      y: (p.annualized ?? 0) * 100,
      kind: Math.abs(p.maxDrawdown) <= constraints.drawdownBudget ? "feasible" : "candidate",
      key: p.weights.map((w) => Math.round(w * 100)).join("/"),
      label: p.weights
        .map((w, i) => (w > 0 ? `${classes[i].label} ${Math.round(w * 100)}%` : ""))
        .filter(Boolean)
        .join(" · "),
    }));
    points.push({
      x: Math.abs(chosen.maxDrawdown) * 100,
      y: (chosen.annualized ?? 0) * 100,
      kind: "chosen",
      label: "计算结果",
      key: "chosen",
    });
    if (stockValues) {
      points.push({
        x: Math.abs(stockValues.maxDrawdown) * 100,
        y: (stockValues.annualized ?? 0) * 100,
        kind: "reference",
        label: "100% A 股宽基",
        key: "ref",
      });
    }

    scatterChart(document.getElementById("chart-cloud"), {
      points,
      vLines: [
        {
          value: constraints.drawdownBudget * 100,
          label: `回撤预算 ${(constraints.drawdownBudget * 100).toFixed(0)}%`,
        },
      ],
      hLines: [
        { value: constraints.targetLow * 100, label: `收益目标 ${(constraints.targetLow * 100).toFixed(0)}%` },
      ],
      xFormatter: (v) => `${v.toFixed(0)}%`,
      yFormatter: (v) => `${v.toFixed(0)}%`,
      tipHtml: (p) => `
        <div class="tip-date">${p.kind === "chosen" ? "计算结果" : p.kind === "reference" ? "参考组合" : "候选配比"}</div>
        <div class="tip-row"><span>年化</span><span>${p.y.toFixed(1)}%</span></div>
        <div class="tip-row"><span>最大回撤</span><span>−${p.x.toFixed(1)}%</span></div>
        <div class="tip-row" style="white-space:normal;max-width:16rem"><span>${p.label || ""}</span></div>`,
    });

    const chosenCurve = curve(chosen.weights);
    const stockCurve = curve(stockWeights);
    lineChart(document.getElementById("chart-curve"), {
      labels: aligned.dates,
      series: [
        { name: "计算结果", values: chosenCurve, color: "var(--il-chart-1)" },
        { name: "100% A 股宽基", values: stockCurve, color: "var(--il-chart-3)", fill: false, width: 1.5 },
      ],
      formatter: (v) => `¥${Math.round(v / 10000)}万`,
      tipFormatter: (v) => money(v),
      labelFormatter: (d) => d.slice(0, 4),
      tipDateFormatter: dateLabel,
    });
  } catch (err) {
    if (token !== seq.current) return;
    showError(host, err.message);
  } finally {
    solving = false;
    if (token === seq.current) {
      button.disabled = false;
      if (!status.textContent.includes("已回测")) status.textContent = "";
    }
  }
}

/* --------------------------------- 启动 --------------------------------- */

function main() {
  initShell({ active: "planner" });
  renderClassPicker();
  renderQuestions();
  document.getElementById("btn-solve").addEventListener("click", runSolve);

  const group = document.getElementById("objective-group");
  if (group) {
    group.addEventListener("change", () => {
      state.objective = group.value;
      runSolve();
    });
  }
  runSolve();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}