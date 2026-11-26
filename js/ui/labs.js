/**
 * js/ui/labs.js — 课程页的互动实验室。
 *
 * 课程里最缺的不是字，是「自己动手拖一下、算一遍、被结果打脸一次」。
 * 这里提供四个实验，全部基于站内的真实历史序列（不是示意数字）：
 *
 *   1. 复利实验室     —— 纯数学：本金 / 年化 / 年限 → 终值与翻倍时间
 *   2. 分散实验室     —— 拖动股票权重，看波动如何低于「加权平均」
 *   3. 配比实验室     —— 四类资产滑块，实时给出年化 / 回撤 / 夏普
 *   4. 2008 体验馆    —— 先盲看一条曲线做决定，再揭晓它是什么、后果多少
 *
 * 所有计算都在浏览器里完成，函数是纯的（见 tests/… 里的断言）。
 */

import { loadIndex, loadSeriesMany, findAsset, keyOf } from "../core/store.js";
import { alignByDate, cumulative, sliceLastYears } from "../core/series.js";
import { analyze } from "../core/stats.js";
import { rebalanceSimulation } from "../core/portfolio.js";
import { bootstrap, monthlyReturns } from "../core/simulate.js";
import { lineChart } from "../core/charts.js";
import { money, num, pct, tone } from "../core/format.js";

/* ------------------------------- 共用工具 ------------------------------- */

const CLS = {
  cnStock: "index:H00300",
  bond: "index:000012",
  gold: "index:GOLDCNY",
  cash: "index:H11025",
  usStock: "index:us.INX",
};

const LABELS = {
  cnStock: "A 股（沪深300全收益）",
  bond: "国债（上证国债指数）",
  gold: "黄金（人民币，合成）",
  cash: "现金（货币基金指数）",
  usStock: "美股（标普500）",
};

async function loadMany(entries) {
  const index = await loadIndex();
  const refs = entries
    .map(([role, key]) => ({ role, asset: findAsset(index, key) }))
    .filter((item) => item.asset);
  const seriesList = await loadSeriesMany(refs.map((r) => r.asset));
  const byKey = new Map(seriesList.map((s) => [s.key, s]));
  const out = {};
  for (const ref of refs) {
    const s = byKey.get(keyOf(ref.asset));
    if (s) out[ref.role] = { dates: s.dates, prices: s.prices };
  }
  return { out, index };
}

function metricTile(label, value, sub, cls = "") {
  return `<div class="lab-metric ${cls}">
    <span class="lab-metric-label">${label}</span>
    <span class="lab-metric-value">${value}</span>
    ${sub ? `<span class="lab-metric-sub">${sub}</span>` : ""}
  </div>`;
}

/** 用一组权重跑一次年度再平衡，返回净值序列与指标 */
function simulate(aligned, weights, initial = 10000) {
  const keys = Object.keys(aligned);
  const result = rebalanceSimulation(aligned.dates, aligned.values, weights, {
    everyDays: 252,
    initial,
  });
  if (!result) return null;
  const years =
    (Date.parse(aligned.dates[aligned.dates.length - 1]) - Date.parse(aligned.dates[0])) /
    (365.25 * 86400000);
  const stats = analyze(result.valueSeries, aligned.dates, { riskFreeRate: 0.025 });
  return { result, stats, years, keys, initial };
}

/* ---------------------------- 1. 复利实验室 ----------------------------- */

export function mountCompoundLab(host) {
  if (!host) return;

  host.innerHTML = `
    <div class="lab">
      <div class="lab-controls">
        ${sliderRow("principal", "本金", 10000, 1000000, 10000, 100000, "¥")}
        ${sliderRow("rate", "年化收益", 1, 15, 0.5, 8, "%")}
        ${sliderRow("years", "投资年限", 1, 40, 1, 20, "年")}
      </div>
      <div class="lab-out" id="compound-out"></div>
      <div class="chart" id="chart-compound" style="margin-top:0.9rem"></div>
      <div class="lab-note" id="compound-note"></div>
    </div>`;

  const read = () => ({
    principal: Number(host.querySelector("#in-principal").value),
    rate: Number(host.querySelector("#in-rate").value) / 100,
    years: Number(host.querySelector("#in-years").value),
  });

  const render = () => {
    const { principal, rate, years } = read();

    host.querySelector("#out-principal").textContent = money(principal);
    host.querySelector("#out-rate").textContent = `${(rate * 100).toFixed(1)}%`;
    host.querySelector("#out-years").textContent = `${years} 年`;

    const finalValue = principal * Math.pow(1 + rate, years);
    const doubleYears = rate > 0 ? Math.log(2) / Math.log(1 + rate) : Infinity;
    const gain = finalValue - principal;

    host.querySelector("#compound-out").innerHTML = `
      ${metricTile("期末值", money(finalValue), `${years} 年后`)}
      ${metricTile("总收益", money(gain), `本金 ${money(principal)}`, gain >= 0 ? "pos" : "neg")}
      ${metricTile("翻倍需要", `${doubleYears.toFixed(1)} 年`, "72 法则：72 ÷ 年化", "")}
      ${metricTile("多等 10 年", money(principal * Math.pow(1 + rate, years + 10)), "时间比收益率更有力")}
    `;

    const labels = [];
    const values = [];
    for (let year = 0; year <= years; year += 1) {
      labels.push(`${year}`);
      values.push(principal * Math.pow(1 + rate, year));
    }
    lineChart(host.querySelector("#chart-compound"), {
      labels,
      series: [{ name: "复利曲线", values, color: "var(--il-chart-1)" }],
      formatter: (v) => (v >= 10000 ? `¥${(v / 10000).toFixed(0)}万` : `¥${Math.round(v)}`),
      tipFormatter: (v) => money(v),
      tipDateFormatter: (d) => `第 ${d} 年`,
    });

    host.querySelector("#compound-note").innerHTML =
      rate >= 12
        ? `年化 ${(rate * 100).toFixed(1)}% 很难长期维持——沪深300 全收益 20 年年化约 9.3%。把滑块拉到能长期拿住的水平，往往比追高更划算。`
        : `年化 ${(rate * 100).toFixed(1)}%、${years} 年：期末是本金的 ${(finalValue / principal).toFixed(1)} 倍。注意这条曲线前十年几乎是平的，复利的陡峭感只出现在后半段。`;
  };

  host.querySelectorAll("input[type=range]").forEach((input) => {
    input.addEventListener("input", render);
  });
  render();
}

function sliderRow(id, label, min, max, step, value, unit) {
  return `
    <div class="lab-slider">
      <div class="lab-slider-head">
        <span>${label}</span>
        <strong id="out-${id}"></strong>
      </div>
      <input type="range" id="in-${id}" min="${min}" max="${max}" step="${step}" value="${value}"
             aria-label="${label}" aria-valuemin="${min}" aria-valuemax="${max}" aria-valuenow="${value}" />
    </div>`;
}

/* ---------------------------- 2. 分散实验室 ----------------------------- */

export async function mountDiversifyLab(host) {
  if (!host) return;
  host.innerHTML = `<div class="loading-inline">正在加载两段真实历史…</div>`;

  const { out } = await loadMany([
    ["stock", CLS.cnStock],
    ["bond", CLS.bond],
  ]);
  if (!out.stock || !out.bond) {
    host.innerHTML = `<div class="notice" data-tone="warn"><span>数据不足，暂时无法运行这个实验。</span></div>`;
    return;
  }

  const aligned = alignByDate([
    { key: "stock", dates: out.stock.dates, prices: out.stock.prices },
    { key: "bond", dates: out.bond.dates, prices: out.bond.prices },
  ]);
  const values = { stock: aligned.values.stock, bond: aligned.values.bond };

  host.innerHTML = `
    <div class="lab">
      <div class="lab-controls">
        ${sliderRow("stockweight", "股票权重", 0, 100, 5, 60, "%")}
      </div>
      <div class="lab-out" id="div-out"></div>
      <div class="chart" id="chart-diversify" style="margin-top:0.9rem"></div>
      <div class="lab-note" id="div-note"></div>
    </div>`;

  const range = `${aligned.dates[0]} ~ ${aligned.dates[aligned.dates.length - 1]}`;

  // 股票权重 0→100 扫描：组合波动 vs 加权平均波动
  const curve = [];
  for (let w = 0; w <= 1.0001; w += 0.1) {
    const sim = simulate({ dates: aligned.dates, values }, [w, 1 - w]);
    if (sim) curve.push({ w, vol: sim.stats.annualizedVolatility, ret: sim.stats.annualizedReturn });
  }

  const render = () => {
    const w = Number(host.querySelector("#in-stockweight").value) / 100;
    host.querySelector("#out-stockweight").textContent = `${Math.round(w * 100)}%`;

    const sim = simulate({ dates: aligned.dates, values }, [w, 1 - w]);
    if (!sim) return;

    const stockStats = analyze(values.stock, aligned.dates, { riskFreeRate: 0.025 });
    const bondStats = analyze(values.bond, aligned.dates, { riskFreeRate: 0.025 });
    const weightedVol = w * stockStats.volatility + (1 - w) * bondStats.volatility;
    const saved = weightedVol - sim.stats.volatility;

    host.querySelector("#div-out").innerHTML = `
      ${metricTile("组合年化", pct(sim.stats.annualizedReturn), range, tone(sim.stats.annualizedReturn))}
      ${metricTile("组合波动", pct(sim.stats.volatility, { signed: false }), `加权平均 ${pct(weightedVol, { signed: false })}`)}
      ${metricTile("分散省下的波动", pct(saved, { signed: false, digits: 2 }), "相关性越低，省得越多", saved > 0.002 ? "pos" : "")}
      ${metricTile("最大回撤", pct(sim.stats.maxDrawdown?.value), "历史最深", "neg")}
    `;

    lineChart(host.querySelector("#chart-diversify"), {
      labels: curve.map((p) => `${Math.round(p.w * 100)}% 股票`),
      series: [
        {
          name: "组合实际波动",
          values: curve.map((p) => p.vol),
          color: "var(--il-chart-1)",
        },
        {
          name: "加权平均波动（假设零分散）",
          values: curve.map((p) => p.w * stockStats.volatility + (1 - p.w) * bondStats.volatility),
          color: "var(--il-chart-3)",
          fill: false,
          width: 1.5,
        },
      ],
      formatter: (v) => `${(v * 100).toFixed(0)}%`,
      tipFormatter: (v) => `${(v * 100).toFixed(2)}%`,
      tipDateFormatter: (d) => d,
    });

    host.querySelector("#div-note").innerHTML =
      `两条线之间的缝隙，就是<strong>分散白送的那部分</strong>：组合波动永远低于「按权重加权平均」的那条线，` +
      `因为股票和国债不会同时朝一个方向走。把滑块拖到 100% 或 0%，缝隙就消失了——` +
      `<strong>只有一个资产时，没有分散可言。</strong>`;
  };

  host.querySelectorAll("input[type=range]").forEach((i) => i.addEventListener("input", render));
  render();
}

/* ---------------------------- 3. 配比实验室 ----------------------------- */

const ALLOC_ROLES = [
  ["cnStock", "股票"],
  ["bond", "国债"],
  ["gold", "黄金"],
  ["cash", "现金"],
];

export async function mountAllocationLab(host) {
  if (!host) return;
  host.innerHTML = `<div class="loading-inline">正在加载四类资产的历史…</div>`;

  const { out } = await loadMany(ALLOC_ROLES.map(([role]) => [role, CLS[role]]));
  const missing = ALLOC_ROLES.filter(([role]) => !out[role]);
  if (missing.length) {
    host.innerHTML = `<div class="notice" data-tone="warn"><span>数据不足（缺 ${missing
      .map((m) => m[1])
      .join("、")}），暂时无法运行这个实验。</span></div>`;
    return;
  }

  const aligned = alignByDate(
    ALLOC_ROLES.map(([role]) => ({ key: role, dates: out[role].dates, prices: out[role].prices }))
  );
  const values = {};
  for (const [role] of ALLOC_ROLES) values[role] = aligned.values[role];

  host.innerHTML = `
    <div class="lab">
      <div class="lab-controls">
        ${ALLOC_ROLES.map(([role, label]) =>
          sliderRow(role, label, 0, 100, 5, role === "cnStock" ? 40 : role === "bond" ? 30 : role === "gold" ? 15 : 15, "%")
        ).join("")}
      </div>
      <div class="lab-out" id="alloc-out"></div>
      <div class="chart tall" id="chart-alloc" style="margin-top:0.9rem"></div>
      <div class="lab-note" id="alloc-note"></div>
    </div>`;

  const render = () => {
    const raw = ALLOC_ROLES.map(([role]) => Number(host.querySelector(`#in-${role}`).value));
    const total = raw.reduce((a, b) => a + b, 0) || 1;
    const weights = raw.map((v) => v / total);

    ALLOC_ROLES.forEach(([role], i) => {
      host.querySelector(`#out-${role}`).textContent = `${Math.round(weights[i] * 100)}%`;
    });

    const sim = simulate({ dates: aligned.dates, values }, weights);
    const stockOnly = simulate({ dates: aligned.dates, values }, [1, 0, 0, 0]);
    if (!sim) return;

    host.querySelector("#alloc-out").innerHTML = `
      ${metricTile("历史年化", pct(sim.stats.annualizedReturn), tone(sim.stats.annualizedReturn))}
      ${metricTile("年化波动", pct(sim.stats.volatility, { signed: false }), "")}
      ${metricTile("最大回撤", pct(sim.stats.maxDrawdown?.value), "历史最深", "neg")}
      ${metricTile("夏普比率", num(sim.stats.sharpe), "无风险 2.5%", "")}
      ${metricTile("期末 ¥1 万→", money(sim.result.valueSeries[sim.result.valueSeries.length - 1]), `${sim.years.toFixed(0)} 年`)}
      ${metricTile("100% 股票同期", pct(stockOnly.stats.annualizedReturn), `回撤 ${pct(stockOnly.stats.maxDrawdown?.value)}`, tone(stockOnly.stats.annualizedReturn))}
    `;

    lineChart(host.querySelector("#chart-alloc"), {
      labels: aligned.dates,
      series: [
        { name: "你的组合", values: sim.result.valueSeries, color: "var(--il-chart-1)" },
        {
          name: "100% 股票",
          values: stockOnly.result.valueSeries,
          color: "var(--il-chart-3)",
          fill: false,
          width: 1.5,
        },
      ],
      formatter: (v) => `¥${Math.round(v / 10000)}万`,
      tipFormatter: (v) => money(v),
      tipDateFormatter: (d) => d,
    });

    const note =
      sim.stats.volatility < stockOnly.stats.volatility * 0.6
        ? `你的组合波动只有满仓股票的 ${((sim.stats.volatility / stockOnly.stats.volatility) * 100).toFixed(0)}%，` +
          `代价是年化少了 ${((stockOnly.stats.annualizedReturn - sim.stats.annualizedReturn) * 100).toFixed(1)} 个百分点。` +
          `这就是配置的全部秘密：<strong>它不是免费提高收益，而是按你的承受力重新分配波动。</strong>`
        : `你现在配得比较激进：波动接近满仓股票。如果回撤那一栏的数字让你不舒服，就把股票权重往下调——` +
          `别等到真的跌下来才决定。`;
    host.querySelector("#alloc-note").innerHTML = note;
  };

  host.querySelectorAll("input[type=range]").forEach((i) => i.addEventListener("input", render));
  render();
}

/* --------------------------- 4. 2008 体验馆 ----------------------------- */

export async function mountExperienceLab(host) {
  if (!host) return;
  host.innerHTML = `<div class="loading-inline">正在加载历史上最难受的那一段…</div>`;

  const { out } = await loadMany(ALLOC_ROLES.map(([role]) => [role, CLS[role]]));
  if (ALLOC_ROLES.some(([role]) => !out[role])) {
    host.innerHTML = `<div class="notice" data-tone="warn"><span>数据不足，无法运行这个实验。</span></div>`;
    return;
  }

  // 永久组合 4×25%，阈值带再平衡
  const aligned = alignByDate(
    ALLOC_ROLES.map(([role]) => ({ key: role, dates: out[role].dates, prices: out[role].prices }))
  );
  const values = {};
  for (const [role] of ALLOC_ROLES) values[role] = aligned.values[role];

  const sim = simulate({ dates: aligned.dates, values }, [0.25, 0.25, 0.25, 0.25], 100000);
  if (!sim) {
    host.innerHTML = `<div class="notice" data-tone="warn"><span>模拟失败。</span></div>`;
    return;
  }

  const dates = aligned.dates;
  const series = sim.result.valueSeries;

  // 找一个真实的危机窗口：2007-10 ~ 2012-12
  const startIdx = dates.findIndex((d) => d >= "2007-10-01");
  const endIdx = dates.findIndex((d) => d >= "2012-12-31");
  if (startIdx < 0 || endIdx < 0) {
    host.innerHTML = `<div class="notice" data-tone="warn"><span>数据未覆盖 2008 年。</span></div>`;
    return;
  }

  const windowDates = dates.slice(startIdx, endIdx);
  const windowValues = series.slice(startIdx, endIdx);
  let troughIdx = 0;
  for (let i = 1; i < windowValues.length; i += 1) {
    if (windowValues[i] < windowValues[troughIdx]) troughIdx = i;
  }

  const startValue = windowValues[0];
  const troughValue = windowValues[troughIdx];
  const endValue = windowValues[windowValues.length - 1];
  const drawdown = troughValue / startValue - 1;

  // 卖出后转投货币基金：用现金档的同期涨幅近似
  const cashSeries = values.cash.slice(startIdx, endIdx);
  const cashAfterTrough = cashSeries[cashSeries.length - 1] / cashSeries[troughIdx];

  const outcomes = {
    exit: troughValue * cashAfterTrough,
    half: 0.5 * troughValue * cashAfterTrough + 0.5 * endValue,
    hold: endValue,
    add: (() => {
      // 把现金档的一半换成股票（在最低点），之后按原权重继续
      const tail = { dates: windowDates.slice(troughIdx), cnStock: values.cnStock.slice(startIdx + troughIdx, endIdx), bond: values.bond.slice(startIdx + troughIdx, endIdx), gold: values.gold.slice(startIdx + troughIdx, endIdx), cash: values.cash.slice(startIdx + troughIdx, endIdx) };
      const sub = rebalanceSimulation(tail.dates, { cnStock: tail.cnStock, bond: tail.bond, gold: tail.gold, cash: tail.cash }, [0.375, 0.25, 0.25, 0.125], { everyDays: 252, initial: troughValue * 1.0 });
      return sub ? sub.valueSeries[sub.valueSeries.length - 1] : endValue;
    })(),
  };

  host.innerHTML = `
    <div class="lab">
      <p class="lab-prompt">
        下面是一条真实组合在 <strong>2007-10 到 2012-12</strong> 的净值曲线，先不告诉你它是什么。
        请只看形状，然后回答一个问题。
      </p>
      <div class="chart tall" id="chart-experience"></div>
      <p class="lab-prompt" style="margin-top:1rem">
        如果这是你的钱，跌到最低点时你会怎么做？
      </p>
      <div class="lab-choices" id="exp-choices">
        <button class="lab-choice" data-choice="exit">全部卖出，先躲过去</button>
        <button class="lab-choice" data-choice="half">卖掉一半</button>
        <button class="lab-choice" data-choice="hold">什么都不做</button>
        <button class="lab-choice" data-choice="add">把现金部分加进去</button>
      </div>
      <div id="exp-result"></div>
    </div>`;

  lineChart(host.querySelector("#chart-experience"), {
    labels: windowDates.map((_, i) => `第 ${i + 1} 天`),
    series: [{ name: "净值", values: windowValues, color: "var(--il-chart-1)" }],
    formatter: (v) => `¥${Math.round(v / 10000)}万`,
    tipFormatter: (v) => `¥${Math.round(v).toLocaleString("zh-CN")}`,
    tipDateFormatter: (_, i) => `第 ${i + 1} 天`,
  });

  host.querySelectorAll(".lab-choice").forEach((button) => {
    button.addEventListener("click", () => {
      const choice = button.dataset.choice;
      host.querySelectorAll(".lab-choice").forEach((b) => b.classList.remove("on"));
      button.classList.add("on");

      const result = outcomes[choice];
      const gap = result - outcomes.hold;
      const verdict = {
        exit: "最容易后悔的一种",
        half: "折中，但代价不小",
        hold: "什么都没做，却是最好的",
        add: "理论上最优，实践中最难",
      }[choice];

      host.querySelector("#exp-result").innerHTML = `
        <div class="lab-reveal">
          <p>
            这条曲线是 <strong>哈利·布朗永久组合（4×25%）</strong> 在 2008 年金融危机前后的真实走势：
            从 2007-10 的 ${money(startValue)}，跌到最低点 ${money(troughValue)}（<strong>回撤 ${pct(drawdown)}</strong>），
            到 2012-12 又回到 ${money(endValue)}。
          </p>
          <div class="lab-out">
            ${metricTile("你的选择", verdict, `期末 ${money(result)}`, choice === "hold" || choice === "add" ? "pos" : "neg")}
            ${metricTile("与「什么都不做」相比", `${gap >= 0 ? "+" : ""}${money(gap)}`, gap >= 0 ? "你做得更好" : "你少赚了这些", gap >= 0 ? "pos" : "neg")}
          </div>
          <p class="lab-note">
            ${
              choice === "exit"
                ? `即使这只是一个跌了 ${pct(Math.abs(drawdown), { signed: false })} 的均衡组合，"躲一躲"也让你少赚了 ${money(Math.abs(gap))}。` +
                  `真正的风险不是波动，是<strong>波动发生时的那个决定</strong>。`
                : choice === "half"
                  ? `卖掉一半就锁定了一半的亏损。看起来"做点什么"更安心，但数学上它只是把亏损兑现了一半。`
                  : choice === "add"
                    ? `你现在比"什么都不做"多赚了 ${money(gap)}。注意：这是事后才知道结果，` +
                      `当时所有人都在讨论金融危机会不会演变成大萧条——真敢加仓的人极少。`
                    : `你什么都没做，然后赢了。这不是运气：永久组合的最大回撤就是设计出来的，` +
                      `它让你在最难受的时候<strong>不需要做任何决定</strong>。`
            }
          </p>
          <p class="lab-note">
            去 <a href="portfolio.html#strategy">组合分析 → 策略组合</a> 可以把这条曲线换成任意权重再看一遍。
          </p>
        </div>`;
    });
  });
}

/* --------------------------- 5. 蒙特卡洛实验室 --------------------------- */

/**
 * 课程里写着「蒙特卡洛模拟」，这个实验把它兑现：
 * 拿永久组合的历史月度收益当袋子，有放回地抽 20 年，重复 1000 次。
 *
 * 它回答的不是「未来会怎样」，而是「如果未来只是历史的随机抽样，运气能有多差」。
 */
export async function mountMonteCarloLab(host) {
  if (!host) return;
  host.innerHTML = `<div class="loading-inline">正在准备模拟（读取永久组合的历史月度收益）…</div>`;

  const { out } = await loadMany(ALLOC_ROLES.map(([role]) => [role, CLS[role]]));
  if (ALLOC_ROLES.some(([role]) => !out[role])) {
    host.innerHTML = `<div class="notice" data-tone="warn"><span>数据不足，无法运行模拟。</span></div>`;
    return;
  }

  const aligned = alignByDate(
    ALLOC_ROLES.map(([role]) => ({ key: role, dates: out[role].dates, prices: out[role].prices }))
  );
  const values = {};
  for (const [role] of ALLOC_ROLES) values[role] = aligned.values[role];

  const sim = simulate({ dates: aligned.dates, values }, [0.25, 0.25, 0.25, 0.25], 10000);
  if (!sim) {
    host.innerHTML = `<div class="notice" data-tone="warn"><span>模拟失败。</span></div>`;
    return;
  }

  const monthly = monthlyReturns(aligned.dates, sim.result.valueSeries);
  const YEARS = 20;
  const result = bootstrap(monthly, { years: YEARS, paths: 1000, initial: 10000, seed: 20261126 });
  if (!result.percentiles) {
    host.innerHTML = `<div class="notice" data-tone="warn"><span>月度样本不足，无法模拟。</span></div>`;
    return;
  }

  const { p5, p25, p50, p75, p95 } = result.percentiles;
  const colors = ["var(--il-chart-4)", "var(--il-chart-2)", "var(--il-chart-1)", "var(--il-chart-2)", "var(--il-chart-4)"];

  host.innerHTML = `
    <div class="lab">
      <div class="lab-out">
        ${metricTile("中位结局", money(p50), `${YEARS} 年后`)}
        ${metricTile("最好 5%", money(p95), "运气很好的一端")}
        ${metricTile("最差 5%", money(p5), "运气很差的一端", "neg")}
        ${metricTile("亏损概率", pct(result.lossProbability, { signed: false, digits: 0 }), `终值低于 ${money(10000)}`, "neg")}
        ${metricTile("历史月度样本", `${monthly.length} 个`, "有放回抽样")}
        ${metricTile("路径数", "1,000 条", "固定随机种子，可复现")}
      </div>
      <div class="chart tall" id="chart-mc" style="margin-top:0.9rem"></div>
      <p class="lab-note">
        这是 <strong>自助重抽样（bootstrap）</strong>：把永久组合过去 ${monthly.length} 个月的收益放进一个袋子，
        有放回地抽 ${YEARS}×12 次组成一条路径，重复 1000 次。它不做正态假设，也不预测收益率——
        它只回答一个问题：<strong>如果未来只是历史的随机抽样，最差的情况能有多差。</strong>
        最差 5% 那条线对应的结局是 ${money(p5)}，比中位数少了 ${money(p50 - p5)}。
      </p>
      <p class="lab-note">
        注意它的局限（和历史上的教训）：抽样假设「未来与过去同分布」。真实世界里，
        危机时相关性会一起升高、长期收益率可能整体下移——所以这类模拟给出的是<strong>下限参考</strong>，
        不是「最坏也就这样」的保证。
      </p>
    </div>`;

  const labels = Array.from({ length: YEARS }, (_, i) => `第 ${i + 1} 年`);
  lineChart(host.querySelector("#chart-mc"), {
    labels,
    series: [
      { name: "5% 分位", values: result.bands.p5, color: colors[0], fill: false, width: 1.2 },
      { name: "25% 分位", values: result.bands.p25, color: colors[1], fill: false, width: 1.4 },
      { name: "中位数", values: result.bands.p50, color: colors[2], width: 2 },
      { name: "75% 分位", values: result.bands.p75, color: colors[3], fill: false, width: 1.4 },
      { name: "95% 分位", values: result.bands.p95, color: colors[4], fill: false, width: 1.2 },
    ],
    formatter: (v) => `¥${Math.round(v / 10000)}万`,
    tipFormatter: (v) => money(v),
    tipDateFormatter: (d) => d,
  });
}
