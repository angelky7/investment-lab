/**
 * js/ui/decision-lab.js — 决策训练的渲染层。
 *
 * 三个场景、每个 3 步，信息按时间释放。走完给出「你的路径」的风格画像，
 * 而不是一个分数——因为决策训练没有正确答案。
 */

import { SCENARIOS, summarizePath } from "../core/decisions.js";

const PROGRESS_KEY = "investment-lab:decision-progress";

/** 把叙述里的 **强调** 渲染成 <strong>（内容由本项目生成，不含用户输入） */
function md(text) {
  return String(text).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

function readProgress() {
  try {
    return JSON.parse(localStorage.getItem(PROGRESS_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

function writeProgress(value) {
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(value));
  } catch {
    /* 隐私模式忽略 */
  }
}

/**
 * @param {HTMLElement} host
 */
export function mountDecisionLab(host) {
  if (!host) return;

  const state = {
    scenario: null,
    step: 0,
    choices: [],
    done: {},
  };

  const renderMenu = () => {
    state.done = readProgress();
    const finished = SCENARIOS.filter((s) => state.done[s.id]).length;

    host.innerHTML = `
      <div class="lab">
        <div class="decision-intro">
          <p class="lab-prompt">
            三个场景，每个 <strong>3 步</strong>。每一步你只会看到「当时能看到的信息」，做完决定后才揭晓后来发生了什么。
            没有标准答案，也没有分数——结束时给你的是<strong>你的决策风格画像</strong>。
          </p>
          <p class="small muted">已完成 ${finished} / ${SCENARIOS.length} 个场景</p>
        </div>
        <div class="decision-menu">
          ${SCENARIOS.map(
            (s) => `
            <button class="decision-card ${state.done[s.id] ? "done" : ""}" data-id="${s.id}">
              <span class="decision-card-title">${s.title}</span>
              <span class="decision-card-tag">${s.tagline}</span>
              <span class="decision-card-meta">${s.steps.length} 步${state.done[s.id] ? " · 已完成" : ""}</span>
            </button>`
          ).join("")}
        </div>
      </div>`;

    host.querySelectorAll(".decision-card").forEach((card) => {
      card.addEventListener("click", () => {
        const scenario = SCENARIOS.find((s) => s.id === card.dataset.id);
        if (!scenario) return;
        state.scenario = scenario;
        state.step = 0;
        state.choices = [];
        renderStep();
      });
    });
  };

  const renderStep = () => {
    const scenario = state.scenario;
    const step = scenario.steps[state.step];
    const isLast = state.step + 1 >= scenario.steps.length;

    host.innerHTML = `
      <div class="lab">
        <div class="decision-head">
          <button class="decision-back" id="decision-back">← 返回场景列表</button>
          <span class="decision-progress-text">${scenario.title} · 第 ${state.step + 1} / ${scenario.steps.length} 步</span>
        </div>
        <div class="progress-line"><span class="progress-bar"><i style="width:${((state.step) / scenario.steps.length) * 100}%"></i></span></div>

        <div class="decision-setup">
          <p class="decision-setup-label">当时的处境</p>
          <p>${state.step === 0 ? md(scenario.setup) : ""}</p>
          <p class="decision-reveal-text">${step.reveal}</p>
        </div>

        <p class="decision-question">${step.question}</p>
        <div class="decision-opts">
          ${step.options
            .map(
              (opt, i) => `
            <button class="decision-opt" data-index="${i}">
              <span class="decision-opt-label">${opt.label}</span>
              <span class="decision-opt-note"><b>${opt.tone}</b> · ${opt.note}</span>
            </button>`
            )
            .join("")}
        </div>
        <div id="decision-after"></div>
      </div>`;

    host.querySelector("#decision-back").addEventListener("click", renderMenu);

    host.querySelectorAll(".decision-opt").forEach((button) => {
      button.addEventListener("click", () => {
        const option = step.options[Number(button.dataset.index)];
        state.choices.push({ step: state.step, tone: option.tone, label: option.label });
        host.querySelectorAll(".decision-opt").forEach((b) => (b.disabled = true));
        button.classList.add("picked");

        host.querySelector("#decision-after").innerHTML = `
          <div class="decision-after">
            <p class="decision-after-label">后来发生了什么</p>
            <p>${md(step.after)}</p>
            <div class="row" style="gap:.5rem;margin-top:.4rem">
              <button class="guess-btn" id="decision-next">${isLast ? "看总结" : "下一步"}</button>
            </div>
          </div>`;

        host.querySelector("#decision-next").addEventListener("click", () => {
          if (isLast) {
            const progress = readProgress();
            progress[scenario.id] = true;
            writeProgress(progress);
            renderOutcome();
          } else {
            state.step += 1;
            renderStep();
          }
        });
      });
    });
  };

  const renderOutcome = () => {
    const scenario = state.scenario;
    const summary = summarizePath(state.choices.map((c) => c.tone));
    const toneList = summary.ranked.map(([tone, n]) => `${tone} × ${n}`).join(" · ");
    const ending = summary.disciplined ? scenario.endings.discipline : scenario.endings.emotion;

    host.innerHTML = `
      <div class="lab">
        <div class="decision-head">
          <button class="decision-back" id="decision-back">← 返回场景列表</button>
          <span class="decision-progress-text">${scenario.title} · 已完成</span>
        </div>

        <div class="lab-reveal">
          <p class="decision-outcome-title">你的路径</p>
          <div class="decision-path">
            ${state.choices
              .map(
                (c, i) => `<div class="decision-path-item">
                  <span class="decision-path-step">第 ${i + 1} 步</span>
                  <span class="decision-path-label">${c.label}</span>
                  <span class="decision-tone-tag ${c.tone === "纪律" ? "good" : ""}">${c.tone}</span>
                </div>`
              )
              .join("")}
          </div>
          <p class="lab-note"><strong>风格统计：</strong>${toneList || "—"}</p>
          <p class="lab-note">${md(ending)}</p>
          <div class="decision-lesson">
            <p class="decision-lesson-label">这个场景真正训练的东西</p>
            <p>${md(scenario.lesson)}</p>
          </div>
          <div class="row" style="gap:.5rem;margin-top:.6rem">
            <button class="guess-btn" id="decision-retry">换一种选法再走一遍</button>
            <button class="guess-btn" id="decision-menu">返回场景列表</button>
          </div>
        </div>
      </div>`;

    host.querySelector("#decision-back").addEventListener("click", renderMenu);
    host.querySelector("#decision-menu").addEventListener("click", renderMenu);
    host.querySelector("#decision-retry").addEventListener("click", () => {
      state.step = 0;
      state.choices = [];
      renderStep();
    });
  };

  renderMenu();
}