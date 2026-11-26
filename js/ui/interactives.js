/**
 * js/ui/interactives.js — 四种「不一样」的互动。
 *
 * 之前课程里的互动全是同一个形状：点一个选项、或者拖一个滑块。
 * 用户反馈「互动太少」三次之后我才想明白：问题不是数量，是**类型单一**。
 *
 * 这里补四种新的交互原语：
 *
 *   1. **猜测揭晓**（Guess & Reveal）：先让你猜一个真实数字，再揭晓并算误差。
 *      参与感来自「我猜错了」——比看别人的结论记得牢得多。
 *   2. **拖拽排序**（Rank）：把资产卡片拖成你认为的顺序，提交后看真实排名与数字。
 *   3. **拖拽组合构建器**（Builder）：把资产拖进槽位，实时算年化 / 回撤 / 夏普。
 *   4. **多步分支旅程**（Journey）：一个 2000→2026 的决策链，每一步的选择改变结局。
 *
 * 拖拽在触屏上用「点选 → 点目标」的降级方案，保证手机上也能玩。
 */

import { loadIndex, loadSeriesMany, findAsset, keyOf } from "../core/store.js";
import { alignByDate } from "../core/series.js";
import { analyze } from "../core/stats.js";
import { rebalanceSimulation } from "../core/portfolio.js";
import { lineChart } from "../core/charts.js";
import { money, num, pct, tone } from "../core/format.js";

/* ------------------------------- 共用工具 ------------------------------- */

async function loadKeys(keys) {
  const index = await loadIndex();
  const refs = keys.map((key) => findAsset(index, key)).filter(Boolean);
  const list = await loadSeriesMany(refs);
  const byKey = new Map(list.map((s) => [s.key, s]));
  const out = {};
  for (const ref of refs) {
    const s = byKey.get(keyOf(ref));
    if (s) out[keyOf(ref)] = { name: ref.name, dates: s.dates, prices: s.prices };
  }
  return out;
}

function metricTile(label, value, sub, cls = "") {
  return `<div class="lab-metric ${cls}">
    <span class="lab-metric-label">${label}</span>
    <span class="lab-metric-value">${value}</span>
    ${sub ? `<span class="lab-metric-sub">${sub}</span>` : ""}
  </div>`;
}

function statOf(series) {
  const result = analyze(series.prices, series.dates, { riskFreeRate: 0.025 });
  if (!result.ok) return null;
  return {
    annualized: result.annualizedReturn,
    volatility: result.volatility,
    maxDrawdown: result.maxDrawdown?.value ?? null,
    sharpe: result.sharpe,
  };
}

/** 让一个元素既可拖拽、也可「点选后点目标」 */
function makeDraggable(element, payload, onDropTarget) {
  element.draggable = true;
  element.dataset.payload = payload;
  element.addEventListener("dragstart", (event) => {
    event.dataTransfer.setData("text/plain", payload);
    event.dataTransfer.effectAllowed = "move";
    element.classList.add("dragging");
  });
  element.addEventListener("dragend", () => element.classList.remove("dragging"));
  element.addEventListener("click", () => {
    element.classList.toggle("picked");
    onDropTarget?.(element);
  });
}

/* --------------------------- 1. 猜测揭晓 -------------------------------- */

/**
 * 六道「猜真实数字」的题。答案不在代码里写死，而是**从站内数据现算**——
 * 这样数据更新了，题目答案自动跟着变，不会出现「题目说 8%，现在算是 6%」的漂移。
 */
export async function mountGuessLab(host) {
  if (!host) return;
  host.innerHTML = `<div class="loading-inline">正在从历史数据里算这些数字…</div>`;

  const keys = {
    sse: "index:000001",
    hs300: "index:H00300",
    bond: "index:000012",
    gold: "index:GOLDCNY",
    cash: "index:H11025",
  };
  const data = await loadKeys(Object.values(keys));
  if (!data[keys.sse] || !data[keys.hs300]) {
    host.innerHTML = `<div class="notice" data-tone="warn"><span>数据不足，无法生成题目。</span></div>`;
    return;
  }

  const sse = statOf(data[keys.sse]);
  const hs300 = statOf(data[keys.hs300]);
  const bond = statOf(data[keys.bond]);
  const gold = statOf(data[keys.gold]);

  const QUESTIONS = [
    {
      q: "上证指数从 1990-12 到今天的年化收益是多少？",
      unit: "%",
      truth: sse.annualized * 100,
      hint: "提示：它是价格指数，不含分红。",
      explain: `真实值 ${(sse.annualized * 100).toFixed(1)}%。看着不高，但那是因为 1990 年的起点极低、中间经历了三轮泡沫与破裂。`,
    },
    {
      q: "上证指数历史上最深的一次回撤是多少？（填正数，例如 70 表示 −70%）",
      unit: "%",
      truth: Math.abs(sse.maxDrawdown) * 100,
      hint: "提示：2007 年之后的那一段。",
      explain: `真实值 ${(Math.abs(sse.maxDrawdown) * 100).toFixed(1)}%。这就是「回本需要 8 年」的那一次。`,
    },
    {
      q: "沪深300 全收益指数（含分红）的年化收益是多少？",
      unit: "%",
      truth: hs300.annualized * 100,
      hint: "提示：同期价格指数更低。",
      explain: `真实值 ${(hs300.annualized * 100).toFixed(1)}%。分红再投资贡献了其中一大块。`,
    },
    {
      q: "上证国债指数的年化波动率大约是多少？",
      unit: "%",
      truth: bond.volatility * 100,
      hint: "提示：比股票低一个数量级。",
      explain: `真实值 ${(bond.volatility * 100).toFixed(1)}%——所以它能把组合波动压下去，代价是收益也低。`,
    },
    {
      q: "黄金（人民币计价）的年化波动率是多少？",
      unit: "%",
      truth: gold.volatility * 100,
      hint: "提示：它并不「稳」。",
      explain: `真实值 ${(gold.volatility * 100).toFixed(1)}%。「避险资产」不等于「低波动资产」。`,
    },
    {
      q: "一个 50% 股票 + 50% 国债的组合，最大回撤大约是多少？",
      unit: "%",
      truth: 45,
      hint: "提示：比满仓股票浅，但没那么浅。",
      explain: "约 45% 上下（取决于再平衡规则与区间）。分散能削浅回撤，但不能消除它。",
      loose: 12,
    },
  ];

  host.innerHTML = `
    <div class="lab">
      <p class="lab-prompt">
        <strong>先猜，再看。</strong>这六道题的答案全部由站内真实历史现算，
        猜完点「揭晓」——误差越小说明你对市场的直觉越准（大多数人的直觉都偏乐观）。
      </p>
      <div class="guess-list">
        ${QUESTIONS.map(
          (item, i) => `
          <div class="guess-item" data-index="${i}">
            <p class="guess-q">${i + 1}. ${item.q}</p>
            <div class="guess-row">
              <input type="number" inputmode="decimal" class="guess-input" data-index="${i}"
                     aria-label="第 ${i + 1} 题的答案" placeholder="你的猜测" />
              <span class="guess-unit">${item.unit}</span>
              <button class="guess-btn" data-index="${i}">揭晓</button>
            </div>
            <div class="guess-answer" data-index="${i}" hidden></div>
          </div>`
        ).join("")}
      </div>
      <div class="guess-score" id="guess-score"></div>
    </div>`;

  const revealed = new Map();

  host.querySelectorAll(".guess-btn").forEach((button) => {
    button.addEventListener("click", () => {
      const i = Number(button.dataset.index);
      const item = QUESTIONS[i];
      const input = host.querySelector(`.guess-input[data-index="${i}"]`);
      const box = host.querySelector(`.guess-answer[data-index="${i}"]`);
      const guess = Number(input.value);
      const truth = item.truth;

      revealed.set(i, { guess, truth });
      const tolerance = item.loose ?? Math.max(1.5, Math.abs(truth) * 0.18);
      const diff = Number.isFinite(guess) ? Math.abs(guess - truth) : null;
      const verdict =
        diff === null
          ? "没填也能看答案。"
          : diff <= tolerance
            ? "猜得很准。"
            : diff <= tolerance * 3
              ? "方向对了，量级还差一点。"
              : "差得比较多——这通常说明直觉偏乐观。";

      box.hidden = false;
      box.className = `guess-answer ${diff !== null && diff <= tolerance ? "ok" : "hint"}`;
      box.innerHTML = `
        <p class="guess-truth">真实值 <strong>${truth.toFixed(1)}${item.unit}</strong>
          ${diff === null ? "" : `· 你的猜测 ${guess.toFixed(1)}${item.unit} · 误差 ${diff.toFixed(1)} 个点`}</p>
        <p>${verdict}${item.hint ? ` ${item.hint}` : ""}</p>
        <p class="guess-explain">${item.explain}</p>`;
      button.disabled = true;

      const done = revealed.size;
      const hits = [...revealed.values()].filter(
        (v) => Number.isFinite(v.guess) && Math.abs(v.guess - v.truth) <= (QUESTIONS[[...revealed.keys()].find((k) => revealed.get(k) === v)]?.loose ?? 1.5)
      ).length;
      host.querySelector("#guess-score").innerHTML = `
        <span>已揭晓 <strong>${done}/${QUESTIONS.length}</strong></span>`;
    });
  });
}

/* --------------------------- 2. 拖拽排序 -------------------------------- */

export async function mountRankLab(host) {
  if (!host) return;
  host.innerHTML = `<div class="loading-inline">正在计算五类资产的真实回撤…</div>`;

  const keys = [
    ["hs300", "index:H00300", "沪深300 全收益"],
    ["bond", "index:000012", "上证国债"],
    ["gold", "index:GOLDCNY", "黄金（人民币）"],
    ["cash", "index:H11025", "货币基金"],
    ["ndx", "index:us.NDX", "纳斯达克100"],
  ];
  const data = await loadKeys(keys.map((k) => k[1]));
  const items = keys
    .map(([id, key, name]) => {
      const s = data[key];
      if (!s) return null;
      const st = statOf(s);
      if (!st) return null;
      return { id, name, maxDrawdown: Math.abs(st.maxDrawdown), series: s };
    })
    .filter(Boolean);

  if (items.length < 4) {
    host.innerHTML = `<div class="notice" data-tone="warn"><span>数据不足，无法运行排序题。</span></div>`;
    return;
  }

  const shuffled = items.slice().sort((a, b) => a.name.localeCompare(b.name));

  host.innerHTML = `
    <div class="lab">
      <p class="lab-prompt">
        <strong>把下面五类资产按「历史最大回撤从深到浅」排序。</strong>
        拖着卡片换位置（手机上点一张、再点另一张也可以），排好后提交。
      </p>
      <ol class="rank-list" id="rank-list">
        ${shuffled.map((item) => `
          <li class="rank-item" draggable="true" data-id="${item.id}">
            <span class="rank-handle" aria-hidden="true">⋮⋮</span>
            <span class="rank-name">${item.name}</span>
          </li>`).join("")}
      </ol>
      <div class="row" style="gap:.5rem;align-items:center">
        <button class="guess-btn" id="rank-submit">提交排序</button>
        <span class="small muted" id="rank-status"></span>
      </div>
      <div id="rank-result"></div>
    </div>`;

  const list = host.querySelector("#rank-list");
  let picked = null;

  const moveItem = (dragged, target) => {
    if (!dragged || !target || dragged === target) return;
    const items = [...list.children];
    const from = items.indexOf(dragged);
    const to = items.indexOf(target);
    if (from < to) target.after(dragged);
    else target.before(dragged);
  };

  list.querySelectorAll(".rank-item").forEach((item) => {
    item.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", item.dataset.id);
      item.classList.add("dragging");
    });
    item.addEventListener("dragend", () => item.classList.remove("dragging"));
    item.addEventListener("dragover", (e) => e.preventDefault());
    item.addEventListener("drop", (e) => {
      e.preventDefault();
      const id = e.dataTransfer.getData("text/plain");
      const dragged = list.querySelector(`.rank-item[data-id="${id}"]`);
      moveItem(dragged, item);
    });
    // 触屏降级：点一张、再点另一张交换位置
    item.addEventListener("click", () => {
      if (!picked) {
        picked = item;
        item.classList.add("picked");
        return;
      }
      if (picked === item) {
        item.classList.remove("picked");
        picked = null;
        return;
      }
      moveItem(picked, item);
      picked.classList.remove("picked");
      picked = null;
    });
  });

  host.querySelector("#rank-submit")?.addEventListener("click", () => {
    const answer = [...list.children].map((li) => li.dataset.id);
    const truth = items.slice().sort((a, b) => b.maxDrawdown - a.maxDrawdown).map((i) => i.id);
    const hits = answer.filter((id, index) => truth[index] === id).length;

    host.querySelector("#rank-status").textContent = `五档中排对 ${hits} 档`;
    host.querySelector("#rank-result").innerHTML = `
      <div class="lab-reveal">
        <p>正确顺序（最大回撤从深到浅）：</p>
        <div class="lab-out">
          ${items
            .slice()
            .sort((a, b) => b.maxDrawdown - a.maxDrawdown)
            .map(
              (item) => `<div class="lab-metric ${Math.abs(item.maxDrawdown) > 0.4 ? "neg" : ""}">
                <span class="lab-metric-label">${item.name}</span>
                <span class="lab-metric-value">${pct(-item.maxDrawdown)}</span>
                <span class="lab-metric-sub">${item.series.dates[0]} 起</span>
              </div>`
            )
            .join("")}
        </div>
        <p class="lab-note">
          注意最后一名：货币基金的回撤接近 0，而「黄金」并不是第二安全的那一档——
          它的历史最深回撤比很多人以为的深得多。这就是「避险 ≠ 低回撤」。
        </p>
      </div>`;
  });
}

/* ----------------------- 3. 拖拽组合构建器 ------------------------------ */

export async function mountBuilderLab(host) {
  if (!host) return;
  host.innerHTML = `<div class="loading-inline">正在加载四类资产…</div>`;

  const slots = [
    ["cn", "index:H00300", "股票"],
    ["bond", "index:000012", "国债"],
    ["gold", "index:GOLDCNY", "黄金"],
    ["cash", "index:H11025", "现金"],
  ];
  const data = await loadKeys(slots.map((s) => s[1]));
  if (slots.some(([id, key]) => !data[key])) {
    host.innerHTML = `<div class="notice" data-tone="warn"><span>数据不足。</span></div>`;
    return;
  }

  const aligned = alignByDate(
    slots.map(([id, key]) => ({ key: id, dates: data[key].dates, prices: data[key].prices }))
  );
  const values = {};
  for (const [id] of slots) values[id] = aligned.values[id];

  // 初始：四个槽位各 25%
  const weights = { cn: 0.25, bond: 0.25, gold: 0.25, cash: 0.25 };

  host.innerHTML = `
    <div class="lab">
      <p class="lab-prompt">
        <strong>拖动卡片分配权重。</strong>把资产卡片拖到某个槽位，就给它 +10%；
        右键或长按减 10%。或者直接点 <b>+</b>/<b>−</b>。实时看到年化、回撤与夏普怎么变。
      </p>
      <div class="builder-sources" id="builder-sources">
        ${slots
          .map(
            ([id, , name]) => `
          <div class="builder-chip" draggable="true" data-id="${id}">
            <span>${name}</span>
            <span class="builder-weight" data-weight="${id}">25%</span>
          </div>`
          )
          .join("")}
      </div>
      <div class="builder-slots" id="builder-slots">
        ${slots
          .map(
            ([id, , name]) => `
          <div class="builder-slot" data-slot="${id}">
            <span class="builder-slot-name">${name}</span>
            <span class="builder-slot-weight" data-slot-weight="${id}">25%</span>
            <span class="builder-slot-bar"><i data-slot-bar="${id}" style="width:25%"></i></span>
          </div>`
          )
          .join("")}
      </div>
      <div class="lab-out" id="builder-out"></div>
      <div class="chart" id="builder-chart" style="margin-top:0.9rem"></div>
      <p class="lab-note" id="builder-note"></p>
    </div>`;

  let picked = null;
  const normalize = () => {
    const total = Object.values(weights).reduce((a, b) => a + b, 0) || 1;
    return slots.map(([id]) => weights[id] / total);
  };

  const render = (sourceId, delta) => {
    if (sourceId) {
      weights[sourceId] = Math.max(0, Math.min(1, weights[sourceId] + delta));
    }
    const w = normalize();

    slots.forEach(([id], i) => {
      const text = `${Math.round(w[i] * 100)}%`;
      host.querySelector(`[data-weight="${id}"]`) &&
        (host.querySelector(`[data-weight="${id}"]`).textContent = text);
      host.querySelector(`[data-slot-weight="${id}"]`).textContent = text;
      host.querySelector(`[data-slot-bar="${id}"]`).style.width = `${w[i] * 100}%`;
    });

    const sim = rebalanceSimulation(aligned.dates, values, w, { everyDays: 252, initial: 10000 });
    if (!sim) return;
    const result = analyze(sim.valueSeries, aligned.dates, { riskFreeRate: 0.025 });
    const stockOnly = rebalanceSimulation(aligned.dates, values, [1, 0, 0, 0], {
      everyDays: 252,
      initial: 10000,
    });
    const stockStats = stockOnly ? analyze(stockOnly.valueSeries, aligned.dates, { riskFreeRate: 0.025 }) : null;

    host.querySelector("#builder-out").innerHTML = `
      ${metricTile("历史年化", pct(result.annualizedReturn), tone(result.annualizedReturn))}
      ${metricTile("最大回撤", pct(result.maxDrawdown?.value), "历史最深", "neg")}
      ${metricTile("年化波动", pct(result.volatility, { signed: false }), "")}
      ${metricTile("夏普", num(result.sharpe), "无风险 2.5%")}
      ${metricTile(
        "对比 100% 股票",
        stockStats ? pct(stockStats.annualizedReturn) : "—",
        stockStats ? `回撤 ${pct(stockStats.maxDrawdown?.value)}` : "",
        stockStats ? tone(stockStats.annualizedReturn) : ""
      )}`;

    lineChart(host.querySelector("#builder-chart"), {
      labels: aligned.dates,
      series: [
        { name: "你的组合", values: sim.valueSeries, color: "var(--il-chart-1)" },
        stockOnly
          ? { name: "100% 股票", values: stockOnly.valueSeries, color: "var(--il-chart-3)", fill: false, width: 1.4 }
          : null,
      ].filter(Boolean),
      formatter: (v) => `¥${Math.round(v / 10000)}万`,
      tipFormatter: (v) => money(v),
      tipDateFormatter: (d) => d,
    });

    const cashWeight = w[3];
    host.querySelector("#builder-note").innerHTML =
      cashWeight > 0.4
        ? `现金占了 ${(cashWeight * 100).toFixed(0)}%：回撤确实压下去了，但也把收益一起压了。现金的作用是「让你不用在不该卖的时候卖」，不是收益来源。`
        : `你现在的股票暴露是 ${(w[0] * 100).toFixed(0)}%。把它拖到 80% 以上看看回撤会变成什么样——那就是「拿得住」与「拿不住」的分界线。`;
  };
  host.querySelectorAll(".builder-chip").forEach((chip) => {
    chip.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", chip.dataset.id);
      chip.classList.add("dragging");
    });
    chip.addEventListener("dragend", () => chip.classList.remove("dragging"));
    chip.addEventListener("click", () => {
      if (picked) picked.classList.remove("picked");
      picked = chip;
      chip.classList.add("picked");
    });
    chip.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      render(chip.dataset.id, -0.1);
    });
    // 长按减 10%（触屏）
    let timer = null;
    chip.addEventListener("touchstart", () => {
      timer = setTimeout(() => render(chip.dataset.id, -0.1), 500);
    });
    chip.addEventListener("touchend", () => clearTimeout(timer));
  });

  host.querySelectorAll(".builder-slot").forEach((slot) => {
    slot.addEventListener("dragover", (e) => e.preventDefault());
    slot.addEventListener("drop", (e) => {
      e.preventDefault();
      const id = e.dataTransfer.getData("text/plain");
      if (id) render(id, 0.1);
    });
    slot.addEventListener("click", () => {
      const id = picked?.dataset.id || slot.dataset.slot;
      render(id, 0.1);
    });
  });

  render();
}

/* --------------------------- 4. 多步分支旅程 ---------------------------- */

/**
 * 2000 → 2026 的决策链：四步，每步的选择改变持仓，最后算真实结局。
 * 这是课程里最缺的东西——一个真正的「分支」，而不是一道单选题。
 */
export async function mountJourneyLab(host) {
  if (!host) return;
  host.innerHTML = `<div class="loading-inline">正在加载 2000 年以来的历史…</div>`;

  const keys = {
    cn: "index:H00300",
    bond: "index:000012",
    gold: "index:GOLDCNY",
    cash: "index:H11025",
  };
  const data = await loadKeys(Object.values(keys));
  if (Object.values(keys).some((k) => !data[k])) {
    host.innerHTML = `<div class="notice" data-tone="warn"><span>数据不足（需要 2005 年以来的全收益序列）。</span></div>`;
    return;
  }

  const aligned = alignByDate(
    Object.entries(keys).map(([id, key]) => ({ key: id, dates: data[key].dates, prices: data[key].prices }))
  );
  const values = {};
  for (const id of Object.keys(keys)) values[id] = aligned.values[id];

  const START = "2005-12-30";
  const startIdx = aligned.dates.findIndex((d) => d >= START);
  const startDates = aligned.dates.slice(startIdx);
  const startValues = {};
  for (const id of Object.keys(keys)) startValues[id] = values[id].slice(startIdx);
  const initial = 100000;

  // 四步：每一步给 3 个选择，选完改持仓，最终按真实走势算终值
  const STEPS = [
    {
      title: "2006 年初：你手里有 10 万，怎么放？",
      options: [
        { label: "全部买股票（沪深300）", weights: [1, 0, 0, 0], note: "你相信经济会继续高增长" },
        { label: "股票一半、国债一半", weights: [0.5, 0.5, 0, 0], note: "想参与，但怕回撤" },
        { label: "四等分（股/债/金/现金）", weights: [0.25, 0.25, 0.25, 0.25], note: "你不知道未来，所以不押注" },
      ],
    },
    {
      title: "2008 年 10 月：指数已经跌了 60%，你会？",
      options: [
        { label: "清仓，先保命", weights: [0, 1, 0, 0], note: "把亏损兑现，转投债券" },
        { label: "什么都不做", weights: null, note: "维持原配置" },
        { label: "把现金与债券换成股票", weights: [0.6, 0.1, 0.15, 0.15], note: "在低点加仓" },
      ],
    },
    {
      title: "2015 年 6 月：杠杆牛市顶峰，你会？",
      options: [
        { label: "满仓冲进去", weights: [1, 0, 0, 0], note: "上次没赶上，这次不想错过" },
        { label: "按规则再平衡，不加不减", weights: null, note: "把漂走的权重调回目标" },
        { label: "降低股票比例", weights: [0.2, 0.4, 0.2, 0.2], note: "估值已经很贵" },
      ],
    },
    {
      title: "2020 年 3 月：疫情熔断，你会？",
      options: [
        { label: "全部卖出等见底", weights: [0, 0.5, 0, 0.5], note: "现金为王" },
        { label: "继续持有不动", weights: null, note: "相信规则" },
        { label: "加仓股票", weights: [0.7, 0.15, 0.1, 0.05], note: "恐慌时贪婪" },
      ],
    },
  ];

  const state = { step: 0, weights: [0.25, 0.25, 0.25, 0.25], history: [] };

  const runTo = (weights) => {
    const sim = rebalanceSimulation(startDates, startValues, weights, {
      everyDays: 252,
      initial,
    });
    return sim ? sim.valueSeries[sim.valueSeries.length - 1] : initial;
  };

  const render = () => {
    if (state.step >= STEPS.length) {
      const finalValue = runTo(state.weights);
      const holdValue = runTo([0.25, 0.25, 0.25, 0.25]);
      const stockValue = runTo([1, 0, 0, 0]);
      const wealthRatio = finalValue / initial - 1;

      host.innerHTML = `
        <div class="lab">
          <div class="lab-reveal">
            <p><strong>你的结局：${money(finalValue)}</strong>（本金 ${money(initial)}，${pct(wealthRatio)}）</p>
            <div class="lab-out">
              ${metricTile("你的路径", money(finalValue), `${STEPS.length} 次主动决策`, wealthRatio >= 0.5 ? "pos" : "neg")}
              ${metricTile("一直用四等分", money(holdValue), "从不动手", "")}
              ${metricTile("一直满仓股票", money(stockValue), "从不动手", "")}
            </div>
            <p class="lab-note">
              ${
                finalValue >= Math.max(holdValue, stockValue)
                  ? `你赢了——但请回看你做过的每一个决定：如果其中任何一次判断错了，结局会完全不同。事后看对的决策，事前都是掷硬币。`
                  : `你的主动决策没有跑赢「什么都不做」。这不是你不够聪明，而是这四个时点上，
                     大多数人（包括专业投资者）的判断都不比「按规则不动」更好——这正是配置存在的理由。`
              }
            </p>
            <p class="lab-note">
              你的四步：${state.history.map((h, i) => `${i + 1}. ${h}`).join(" → ")}
            </p>
            <div class="row" style="gap:.5rem;margin-top:.4rem">
              <button class="guess-btn" id="journey-restart">重新走一遍</button>
            </div>
          </div>
        </div>`;
      host.querySelector("#journey-restart").addEventListener("click", () => {
        state.step = 0;
        state.weights = [0.25, 0.25, 0.25, 0.25];
        state.history = [];
        render();
      });
      return;
    }

    const step = STEPS[state.step];
    host.innerHTML = `
      <div class="lab">
        <div class="journey-head">
          <span class="journey-step">第 ${state.step + 1} / ${STEPS.length} 步</span>
          <span class="journey-progress"><i style="width:${(state.step / STEPS.length) * 100}%"></i></span>
        </div>
        <p class="lab-prompt"><strong>${step.title}</strong></p>
        <div class="lab-choices journey-choices">
          ${step.options
            .map(
              (opt, i) => `<button class="lab-choice" data-index="${i}">${opt.label}
                <span class="journey-note">${opt.note}</span></button>`
            )
            .join("")}
        </div>
        ${
          state.history.length
            ? `<p class="lab-note">到目前为止的选择：${state.history.join(" → ")}</p>`
            : ""
        }
      </div>`;

    host.querySelectorAll(".lab-choice").forEach((button) => {
      button.addEventListener("click", () => {
        const opt = step.options[Number(button.dataset.index)];
        if (opt.weights) {
          // 权重是「相对四类的比例」，需要归一
          const total = opt.weights.reduce((a, b) => a + b, 0) || 1;
          state.weights = opt.weights.map((w) => w / total);
        }
        state.history.push(opt.label);
        state.step += 1;
        render();
      });
    });
  };

  render();
}