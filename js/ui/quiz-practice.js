/**
 * js/ui/quiz-practice.js — 刷题模式。
 *
 * 与课文里的「每节自测」不同，这里是**从题库随机抽一组**：
 * 打散顺序、限制题数、算分、错题回看、再来一组。
 *
 * 关键设计：
 * - 用确定性种子打乱，同一组题刷新后仍是同一组（否则你无法回看错题）；
 * - 每题答完立刻给解析，不攒到最后——学习反馈越近越有效；
 * - 结束时列出错题与正确答案，并从 localStorage 里给出历史最好成绩。
 */

import { QUIZ_BANK_A } from "../core/quizbank.js";

const BEST_KEY = "investment-lab:quiz-best";

const SCOPES = [
  { id: "all", label: "全部", levels: null },
  { id: "beginner", label: "小白", levels: ["beginner"] },
  { id: "intermediate", label: "进阶", levels: ["intermediate"] },
  { id: "advanced", label: "高级", levels: ["advanced"] },
  { id: "strategy", label: "策略", levels: ["strategy"] },
  { id: "method", label: "方法论", levels: ["method"] },
];

const ROUND_SIZE = 20;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(list, seed) {
  const rand = mulberry32(seed);
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function readBest() {
  try {
    return JSON.parse(localStorage.getItem(BEST_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

function writeBest(best) {
  try {
    localStorage.setItem(BEST_KEY, JSON.stringify(best));
  } catch {
    /* 隐私模式忽略 */
  }
}

/**
 * @param {HTMLElement} host
 * @param {{scope?: string, seed?: number}} options
 */
export function mountPractice(host, options = {}) {
  if (!host) return;

  const state = {
    scope: options.scope || "all",
    seed: options.seed || 20261126,
    index: 0,
    answers: [],
    questions: [],
    finished: false,
  };

  const build = () => {
    const scope = SCOPES.find((s) => s.id === state.scope) || SCOPES[0];
    const pool = QUIZ_BANK_A.filter((q) => !scope.levels || scope.levels.includes(q.level));
    const picked = shuffle(pool, state.seed).slice(0, Math.min(ROUND_SIZE, pool.length));
    // 选项也打乱，避免「正确答案总在第一个」
    state.questions = picked.map((q, i) => {
      const order = shuffle(q.options.map((o, idx) => ({ ...o, original: idx })), state.seed + i + 1);
      return { ...q, shuffled: order };
    });
    state.index = 0;
    state.answers = [];
    state.finished = false;
  };

  const renderShell = () => {
    host.innerHTML = `
      <div class="lab">
        <div class="practice-head">
          <div class="row" style="gap:.4rem;flex-wrap:wrap;align-items:center">
            <span class="small muted">范围</span>
            <mdui-segmented-button-group id="practice-scope" value="${state.scope}" selects="single">
              ${SCOPES.map((s) => `<mdui-segmented-button value="${s.id}">${s.label}</mdui-segmented-button>`).join("")}
            </mdui-segmented-button-group>
          </div>
          <span class="small muted" id="practice-best"></span>
        </div>
        <div id="practice-body"></div>
      </div>`;

    host.querySelector("#practice-scope").addEventListener("change", (event) => {
      state.scope = event.target.value;
      state.seed = Date.now() % 100000;
      build();
      renderBody();
    });
    updateBest();
  };

  const updateBest = () => {
    const best = readBest();
    const entry = best[state.scope];
    const el = host.querySelector("#practice-best");
    if (!el) return;
    el.textContent = entry ? `最好成绩 ${entry.score}/${entry.total}` : "还没有成绩记录";
  };

  const renderBody = () => {
    const body = host.querySelector("#practice-body");

    if (state.finished) {
      const total = state.questions.length;
      const score = state.answers.filter((a) => a.correct).length;
      const wrong = state.answers.filter((a) => !a.correct);
      const prev = readBest()[state.scope];
      const isBest = !prev || score > prev.score;

      if (isBest) {
        writeBest({ ...readBest(), [state.scope]: { score, total } });
        updateBest();
      }

      body.innerHTML = `
        <div class="practice-summary">
          <p class="practice-score">
            本组得分 <strong>${score} / ${total}</strong>
            ${isBest ? '<span class="practice-new">新纪录</span>' : ""}
          </p>
          <p class="lab-note">
            ${score === total
              ? "全对。题库还会随更新增加，隔一段时间再来一组。"
              : `错了 ${total - score} 题，下面是它们的正确解释——这比刷更多题有用。`}
          </p>
          ${
            wrong.length
              ? `<div class="practice-review">
                  ${wrong
                    .map(
                      (a) => `<div class="practice-wrong">
                        <p class="guess-q">${a.question.q}</p>
                        <p class="practice-right">正确答案：${a.question.options.find((o) => o.correct).text}</p>
                        <p class="guess-explain">${a.question.explain}</p>
                      </div>`
                    )
                    .join("")}
                </div>`
              : ""
          }
          <div class="row" style="gap:.5rem;margin-top:.6rem">
            <button class="guess-btn" id="practice-again">再来一组</button>
            <button class="guess-btn" id="practice-same">重做这一组</button>
          </div>
        </div>`;
      body.querySelector("#practice-again").addEventListener("click", () => {
        state.seed = Date.now() % 100000;
        build();
        renderBody();
      });
      body.querySelector("#practice-same").addEventListener("click", () => {
        state.index = 0;
        state.answers = [];
        state.finished = false;
        renderBody();
      });
      return;
    }

    const question = state.questions[state.index];
    const progress = ((state.index) / state.questions.length) * 100;
    const answered = state.answers[state.index];

    body.innerHTML = `
      <div class="practice-progress">
        <span>第 ${state.index + 1} / ${state.questions.length} 题</span>
        <span class="progress-bar"><i style="width:${progress}%"></i></span>
        <span class="small muted">${question.topic}</span>
      </div>
      <p class="practice-q">${question.q}</p>
      <div class="practice-opts">
        ${question.shuffled
          .map(
            (opt, i) => `
          <button class="practice-opt ${answered ? (opt.correct ? "right" : "dim") : ""}"
                  data-index="${i}" ${answered ? "disabled" : ""}>
            <span class="practice-key">${String.fromCharCode(65 + i)}</span>
            <span>${opt.text}</span>
          </button>`
          )
          .join("")}
      </div>
      ${
        answered
          ? `<div class="practice-feedback ${answered.correct ? "ok" : "hint"}">
               <strong>${answered.correct ? "答对了。" : "答错了。"}</strong>
               ${!answered.correct ? `正确答案：<strong>${question.options.find((o) => o.correct).text}</strong>。` : ""}
               ${question.explain}
             </div>
             <div class="row" style="gap:.5rem;margin-top:.5rem">
               <button class="guess-btn" id="practice-next">${state.index + 1 >= state.questions.length ? "看结果" : "下一题"}</button>
             </div>`
          : ""
      }`;

    body.querySelectorAll(".practice-opt").forEach((button) => {
      button.addEventListener("click", () => {
        const chosen = question.shuffled[Number(button.dataset.index)];
        state.answers[state.index] = {
          correct: Boolean(chosen.correct),
          chosen: chosen.text,
          question,
        };
        renderBody();
      });
    });

    body.querySelector("#practice-next")?.addEventListener("click", () => {
      if (state.index + 1 >= state.questions.length) {
        state.finished = true;
      } else {
        state.index += 1;
      }
      renderBody();
    });
  };

  build();
  renderShell();
  renderBody();
}