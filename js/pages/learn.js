/**
 * js/pages/learn.js — 投资课程页的交互部分。
 *
 * 课程正文是静态 HTML（可被搜索引擎读取），这里只负责三处测验：
 * 计算题（要真的输入数字）、选择题（要判断）、决策训练（没有标准答案）。
 */

import { initShell } from "../core/shell.js";
import { showError } from "../core/shell.js";
import { LESSONS } from "../core/lessons.js";

/* ------------------------------- 小工具 --------------------------------- */

function html(strings, ...values) {
  return strings.reduce((acc, str, i) => acc + str + (values[i] ?? ""), "");
}

function quizHost(name) {
  return document.querySelector(`.quiz[data-quiz="${name}"]`);
}

function feedback(el, type, content) {
  el.className = `quiz-feedback ${type}`;
  el.hidden = false;
  el.innerHTML = content;
}

/* ------------------------------ 小白测验 -------------------------------- */

function renderBeginnerQuiz() {
  const host = quizHost("beginner");
  if (!host) return;

  host.innerHTML = html`
    <p class="quiz-q">第 1 题：一项资产从 100 元跌到 70 元，回撤是多少？</p>
    <div class="row">
      <div style="flex:1 1 10rem">
        <mdui-text-field id="b-q1" label="你的答案" type="number" suffix="%" placeholder="填数字即可" variant="outlined"></mdui-text-field>
      </div>
      <mdui-button variant="filled" id="b-check1">确认</mdui-button>
    </div>
    <div class="quiz-feedback" id="b-fb1" hidden></div>
    <div id="b-step2" class="hidden" style="margin-top:1.1rem">
      <p class="quiz-q">第 2 题：从 70 元涨回 100 元，需要上涨多少？</p>
      <div class="row">
        <div style="flex:1 1 10rem">
          <mdui-text-field id="b-q2" label="你的答案" type="number" suffix="%" placeholder="填数字即可" variant="outlined"></mdui-text-field>
        </div>
        <mdui-button variant="filled" id="b-check2">确认</mdui-button>
      </div>
      <div class="quiz-feedback" id="b-fb2" hidden></div>
    </div>
    <div id="b-step3" class="hidden" style="margin-top:1.1rem"></div>`;

  const fb1 = host.querySelector("#b-fb1");
  const fb2 = host.querySelector("#b-fb2");
  const step2 = host.querySelector("#b-step2");
  const step3 = host.querySelector("#b-step3");

  const check1 = () => {
    const value = Number(host.querySelector("#b-q1").value);
    if (!Number.isFinite(value) || host.querySelector("#b-q1").value === "") {
      feedback(fb1, "hint", "先填一个数字。回撤 =（高点 − 低点）÷ 高点。");
      return;
    }
    if (Math.abs(value - 30) < 1) {
      feedback(fb1, "ok", "<strong>正确。</strong>(100 − 70) ÷ 100 = 30%。下面第二题才是关键。");
      step2.classList.remove("hidden");
    } else {
      feedback(
        fb1,
        "hint",
        `不是 ${value}%。回撤的分母是<strong>高点</strong>：(100 − 70) ÷ 100 = 30%。再算一次。`
      );
    }
  };

  const check2 = () => {
    const value = Number(host.querySelector("#b-q2").value);
    const field = host.querySelector("#b-q2");
    if (!Number.isFinite(value) || field.value === "") {
      feedback(fb2, "hint", "先填一个数字。回本涨幅 =（高点 − 低点）÷ 低点。");
      return;
    }
    if (Math.abs(value - 42.86) < 1.5) {
      feedback(fb2, "ok", "<strong>正确。</strong>(100 − 70) ÷ 70 ≈ 42.86%。");
      step3.classList.remove("hidden");
      step3.innerHTML = `
        <div class="quiz-feedback ok" style="display:block">
          <strong>这两题的差别，就是整个风险管理的起点。</strong><br /><br />
          跌 30% 需要涨 42.86% 才能回本，两者 <em>不相等</em>。而且随着跌幅变大，这个缺口会指数级拉大：
          跌 50% 要涨 100%，跌 80% 要涨 400%。<br /><br />
          所以，「控制下行风险」不是保守，而是算术要求。
          去 <a href="calculator.html">投资计算器</a> 的「回撤与回本」里把这个对照表看一遍。
        </div>`;
    } else {
      feedback(
        fb2,
        "hint",
        `注意分母变了：涨回去是相对于<strong>低点</strong>而言的。(100 − 70) ÷ 70 ≈ 42.86%。`
      );
    }
  };

  host.querySelector("#b-check1").addEventListener("click", check1);
  host.querySelector("#b-check2").addEventListener("click", check2);
  host.querySelector("#b-q1").addEventListener("keydown", (e) => {
    if (e.key === "Enter") check1();
  });
  host.querySelector("#b-q2").addEventListener("keydown", (e) => {
    if (e.key === "Enter") check2();
  });
}

/* ------------------------------ 进阶测验 -------------------------------- */

const INTERMEDIATE_EXPLAIN = {
  a: `选择 PE=50 那家：你可能更看重高增长潜力。高 PE 反映市场对未来利润的高预期——
      如果利润真能兑现，贵一点也值得；但如果增长不及预期，估值会同时被「盈利下调」和「估值下杀」两头打击，
      这叫戴维斯双杀。`,
  b: `选择 PE=15 那家：你更看重当下的盈利能力。低 PE + 高 ROE 通常意味着「用便宜的价格买到好生意」，
      但也可能意味着市场认为它的成长空间有限，甚至利润不可持续。便宜常有便宜的原因。`,
  c: `选择「看情况」——这是最接近投资现实的一步。PE 是结果，不是原因：
      要判断的是「这家公司未来能不能维持甚至提高 ROE」，以及「市场给的溢价是否过度」。
      只看两个数字无法回答，还需要增长率、行业格局、资本开支与负债。`,
};

function renderIntermediateQuiz() {
  const host = quizHost("intermediate");
  if (!host) return;

  host.innerHTML = html`
    <p class="quiz-q">
      A 公司：PE = 50，ROE = 10%。<br />
      B 公司：PE = 15，ROE = 15%。<br />
      哪一家的估值更合理？
    </p>
    <div class="quiz-opts">
      <mdui-button variant="tonal" data-answer="a">A. PE = 50 的 A 公司</mdui-button>
      <mdui-button variant="tonal" data-answer="b">B. PE = 15 的 B 公司</mdui-button>
      <mdui-button variant="tonal" data-answer="c">C. 仅凭这两个数字判断不了</mdui-button>
    </div>
    <div class="quiz-feedback" id="i-fb" hidden></div>`;

  const fb = host.querySelector("#i-fb");
  host.querySelectorAll("[data-answer]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const answer = btn.dataset.answer;
      const type = answer === "c" ? "ok" : "hint";
      feedback(fb, type, INTERMEDIATE_EXPLAIN[answer]);
    });
  });
}

/* ------------------------------ 高级测验 -------------------------------- */

const ADVANCED_EXPLAIN = {
  yes: `如果你选了「是」，那你可能把夏普比率当成了一个绝对标准。它确实很有用，但至少有三个问题：
        收益分布不是正态的、它把上涨波动也算成风险、以及它对样本区间极度敏感。`,
  no: `「不一定」——这个方向是对的。夏普高只说明「这段历史里，每单位波动换来的超额收益多」。
       它没有告诉你：尾部风险有多大、回撤能不能承受、这个收益是不是靠某一段行情堆出来的。`,
  depends: `「看情况」是更完整的答案：夏普比率是过滤器，不是决策器。
       真正要问的是三件事——这个收益来自什么逻辑、这个逻辑还在不在、以及最坏的情况下我能不能拿住。`,
};

function renderAdvancedQuiz() {
  const host = quizHost("advanced");
  if (!host) return;

  host.innerHTML = html`
    <p class="quiz-q">一项资产的夏普比率是 2.5（远高于同类），说明它一定是好投资吗？</p>
    <div class="quiz-opts">
      <mdui-button variant="tonal" data-answer="yes">是，数字不会骗人</mdui-button>
      <mdui-button variant="tonal" data-answer="no">不一定</mdui-button>
      <mdui-button variant="tonal" data-answer="depends">看情况，要看更多东西</mdui-button>
    </div>
    <div class="quiz-feedback" id="a-fb" hidden></div>`;

  const fb = host.querySelector("#a-fb");
  host.querySelectorAll("[data-answer]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const answer = btn.dataset.answer;
      feedback(fb, answer === "yes" ? "hint" : "ok", ADVANCED_EXPLAIN[answer]);
    });
  });
}

/* --------------------------------- 启动 --------------------------------- */


/* --------------------------- 课程渲染（数据驱动） -------------------------- */

const PROGRESS_KEY = "investment-lab:learn-progress";

function loadProgress() {
  try {
    return JSON.parse(localStorage.getItem(PROGRESS_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

function saveProgress(progress) {
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
  } catch {
    /* 隐私模式下写不了 localStorage，忽略即可，不影响使用 */
  }
}

function lessonsOf(level) {
  return LESSONS.filter((lesson) => lesson.level === level);
}

/** 每级的进度：展开了几节、自测答对几节 */
function updateProgressLine(level) {
  const host = document.querySelector(`[data-progress="${level}"]`);
  if (!host) return;
  const list = lessonsOf(level);
  const progress = loadProgress();
  const opened = list.filter((lesson) => progress[`${level}:${lesson.title}`]?.opened).length;
  const correct = list.filter((lesson) => progress[`${level}:${lesson.title}`]?.correct).length;
  const pctText = list.length ? `${Math.round((correct / list.length) * 100)}%` : "0%";

  host.innerHTML = `
    <span>本级 <strong>${list.length}</strong> 节 · 已展开 <strong>${opened}</strong> · 自测答对 <strong>${correct}</strong>（${pctText}）</span>
    <span class="progress-bar"><i style="width:${pctText}"></i></span>`;
}

function lessonCard(level, lesson) {
  const key = `${level}:${lesson.title}`;

  const body = lesson.body.map((para) => `<p>${para}</p>`).join("");
  const example = lesson.example
    ? `<p class="lesson-example"><strong>本站实例：</strong><a href="${lesson.example[1]}">${lesson.example[0]}</a></p>`
    : "";
  const myth = lesson.myth
    ? `<p class="lesson-myth"><strong>最常见误解：</strong>${lesson.myth}</p>`
    : "";

  const options = lesson.check
    ? lesson.check.options
        .map(
          (opt, index) => `
        <button class="check-opt" data-index="${index}" data-correct="${opt.correct ? "1" : "0"}"
                data-explain="${(opt.explain || "").replace(/"/g, "&quot;")}">${opt.text}</button>`
        )
        .join("")
    : "";

  const check = lesson.check
    ? `<div class="lesson-check">
         <p class="check-q">自测 · ${lesson.check.q}</p>
         <div class="check-opts">${options}</div>
         <div class="check-feedback" hidden></div>
       </div>`
    : "";

  return `
    <details class="lesson lesson-card" data-key="${key}">
      <summary>
        <span class="lesson-title">${lesson.title}</span>
        <span class="lesson-lead">${lesson.lead}</span>
      </summary>
      <div class="lesson-body">
        ${body}
        ${example}
        ${myth}
        ${check}
      </div>
    </details>`;
}

function renderLessons(level) {
  const host = document.querySelector(`[data-lessons="${level}"]`);
  if (!host || host.dataset.rendered === "1") {
    if (host) updateProgressLine(level);
    return;
  }

  host.innerHTML = lessonsOf(level).map((lesson) => lessonCard(level, lesson)).join("");
  host.dataset.rendered = "1";

  // 展开即算「已读」
  host.querySelectorAll("details.lesson-card").forEach((card) => {
    card.addEventListener("toggle", () => {
      if (!card.open) return;
      const progress = loadProgress();
      const key = card.dataset.key;
      progress[key] = { ...(progress[key] || {}), opened: true };
      saveProgress(progress);
      updateProgressLine(level);
    });
  });

  // 自测：点一下立刻给对错与解释
  host.querySelectorAll(".lesson-check").forEach((box) => {
    const card = box.closest("details.lesson-card");
    const key = card.dataset.key;
    const feedback = box.querySelector(".check-feedback");

    box.querySelectorAll(".check-opt").forEach((button) => {
      button.addEventListener("click", () => {
        const isCorrect = button.dataset.correct === "1";
        box.querySelectorAll(".check-opt").forEach((b) => {
          b.classList.remove("on", "right", "wrong");
        });
        button.classList.add("on", isCorrect ? "right" : "wrong");

        feedback.hidden = false;
        feedback.className = `check-feedback ${isCorrect ? "ok" : "hint"}`;
        feedback.innerHTML = `
          <strong>${isCorrect ? "答对了。" : "再想想。"}</strong>
          ${button.dataset.explain || ""}
          ${isCorrect ? "" : "<br />正确答案是标绿的那一项——点它也能看解释。"}`;

        const progress = loadProgress();
        const prev = progress[key] || {};
        progress[key] = {
          ...prev,
          opened: true,
          answered: true,
          // 一旦答对就保持正确；答错不覆盖已有记录
          correct: prev.correct || isCorrect,
        };
        saveProgress(progress);
        updateProgressLine(level);
      });
    });
  });

  updateProgressLine(level);
}

/* ------------------------------ 互动实验室 ------------------------------ */

/**
 * 实验室按需加载：进入某一级时才去取那一级需要的历史数据，
 * 避免首屏为了一个还没点开的滑块下载五条序列。
 */
const LAB_MOUNTERS = {
  beginner: async () => {
    const { mountCompoundLab } = await import("../ui/labs.js");
    const { mountGuessLab, mountRankLab } = await import("../ui/interactives.js");
    mountCompoundLab(document.getElementById("lab-compound"));
    await mountGuessLab(document.getElementById("lab-guess"));
    await mountRankLab(document.getElementById("lab-rank"));
  },
  intermediate: async () => {
    const { mountDiversifyLab } = await import("../ui/labs.js");
    const { mountBuilderLab } = await import("../ui/interactives.js");
    await mountDiversifyLab(document.getElementById("lab-diversify"));
    await mountBuilderLab(document.getElementById("lab-builder"));
  },
  advanced: async () => {
    const { mountAllocationLab, mountMonteCarloLab } = await import("../ui/labs.js");
    await mountAllocationLab(document.getElementById("lab-alloc"));
    await mountMonteCarloLab(document.getElementById("lab-montecarlo"));
  },
  case: async () => {
    const { mountDecisionLab } = await import("../ui/decision-lab.js");
    mountDecisionLab(document.getElementById("lab-decision"));
  },
  practice: async () => {
    const { mountPractice } = await import("../ui/quiz-practice.js");
    mountPractice(document.getElementById("lab-practice"));
  },
  strategy: async () => {
    const { mountExperienceLab } = await import("../ui/labs.js");
    const { mountJourneyLab } = await import("../ui/interactives.js");
    await mountExperienceLab(document.getElementById("lab-experience"));
    await mountJourneyLab(document.getElementById("lab-journey"));
  },
};

const labState = {};

function mountLab(level) {
  if (!LAB_MOUNTERS[level] || labState[level]) return;
  labState[level] = "loading";
  LAB_MOUNTERS[level]()
    .then(() => {
      labState[level] = "done";
    })
    .catch((err) => {
      labState[level] = "failed";
      const host = {
        beginner: "lab-guess",
        intermediate: "lab-builder",
        advanced: "lab-alloc",
        strategy: "lab-journey",
        practice: "lab-practice",
        case: "lab-decision",
      }[level];
      const el = document.getElementById(host);
      if (el) showError(el, err.message);
    });
}

/** 级别切换：只切换自定义面板，不依赖 mdui-tab-panel 的布局 */
function bindLevelTabs() {
  const tabs = document.getElementById("learn-tabs");
  const panels = [...document.querySelectorAll(".level-panel")];
  if (!tabs || !panels.length) return;

  const show = (value) => {
    panels.forEach((panel) => {
      panel.classList.toggle("hidden", panel.dataset.level !== value);
    });
    renderLessons(value);
    mountLab(value);
    // 支持 learn.html#case 这样的深链直接落到决策训练
    if (value === "case") {
      history.replaceState(null, "", "#case");
    } else if (location.hash === "#case") {
      history.replaceState(null, "", location.pathname);
    }
  };

  tabs.addEventListener("change", () => show(tabs.value));
  if (location.hash === "#case") tabs.value = "case";
  else if (location.hash === "#strategy") tabs.value = "strategy";
  else if (location.hash === "#practice") tabs.value = "practice";
  show(tabs.value || "beginner");
}

function main() {
  initShell({ active: "learn" });
  renderBeginnerQuiz();
  renderIntermediateQuiz();
  renderAdvancedQuiz();
  bindLevelTabs();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}