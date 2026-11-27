/**
 * js/ui/quest-ui.js — 闯关界面。
 *
 * 核心交互：**一次只显示一关**。
 *
 * 屏幕从上到下只有四块：
 *   1. 进度条（第 N / 46 关）
 *   2. 这一段要讲的事（一段话，不是卡片墙）
 *   3. 一道题（检验这一段）
 *   4. 答对后的「继续」按钮
 *
 * 刻意的限制：
 *   - 正文只给 `lead` 一句话，详细内容折叠在「展开细节」里——
 *     想读的人可以读，不想读的人不会被压垮；
 *   - 答错不能跳过，必须点「我懂了」看解析再重答；
 *   - 没有「返回上一关」的显眼按钮，避免走回头路（进度已存，刷新也能接上）。
 */

import {
  buildChapters,
  readProgress,
  writeProgress,
  questId,
  computeLockState,
  summarize,
  chapterState,
} from "../core/quest.js";

/**
 * @param {HTMLElement} host
 */
export function mountQuest(host) {
  if (!host) return;

  const chapters = buildChapters();
  let progress = readProgress();
  let state = { lesson: null, chosen: null, revealed: false, wrongTries: 0 };

  const render = () => {
    const summary = summarize(chapters, progress);
    const lockState = computeLockState(chapters, progress);

    // 没有当前关 = 全部通关
    if (!summary.current) {
      host.innerHTML = `
        <div class="quest">
          <div class="quest-finish">
            <p class="quest-finish-badge">全部通关</p>
            <h3>46 关走完了</h3>
            <p class="quest-finish-text">
              你读完了 46 个概念、答对了 46 道题。接下来真正决定结果的不是知识量，
              而是能不能在真实处境里按规则行动——去「决策训练」用三步场景试一次。
            </p>
            <div class="quest-finish-actions">
              <a class="quest-btn primary" href="#case" data-jump="case">去决策训练</a>
              <button class="quest-btn" id="quest-reset">重新开始（清空进度）</button>
            </div>
          </div>
        </div>`;
      host.querySelector("#quest-reset")?.addEventListener("click", () => {
        progress = { cleared: [], read: [] };
        writeProgress(progress);
        state = { lesson: null, chosen: null, revealed: false, wrongTries: 0 };
        render();
      });
      host.querySelector("[data-jump]")?.addEventListener("click", (event) => {
        event.preventDefault();
        const tab = host.closest(".level-panel")?.dataset.level;
        const tabs = document.getElementById("learn-tabs");
        if (tabs) {
          tabs.value = "case";
          tabs.dispatchEvent(new CustomEvent("change", { bubbles: true }));
        }
        void tab;
      });
      return;
    }

    const lesson = summary.current;
    state.lesson = lesson;
    const chapter = chapters.find((c) => c.lessons.includes(lesson));
    const check = lesson.check;

    host.innerHTML = `
      <div class="quest">
        <div class="quest-top">
          <div class="quest-progress-line">
            <span class="quest-counter">第 <strong>${summary.currentIndex}</strong> / ${summary.total} 关</span>
            <span class="quest-percent">${summary.percent}%</span>
          </div>
          <div class="quest-bar"><i style="width:${summary.percent}%"></i></div>
          <div class="quest-chapters">
            ${["beginner", "intermediate", "advanced", "strategy"]
              .map((level) => {
                const group = chapters.filter((c) => c.level === level);
                if (!group.length) return "";
                const states = group.map((c) => chapterState(c, lockState));
                const done = states.filter((s) => s === "done").length;
                const isCurrent = group.includes(chapter);
                const cls = done === group.length ? "done" : isCurrent ? "active current" : "locked";
                const label = { beginner: "小白", intermediate: "进阶", advanced: "高级", strategy: "策略" }[level];
                return `<span class="quest-chapter-pill ${cls}" title="${label}：${done}/${group.length} 章完成">
                  ${label} ${done}/${group.length}
                </span>`;
              })
              .join("")}
          </div>
        </div>

        <div class="quest-card">
          <p class="quest-chapter-label">${chapter?.title || ""}</p>
          <h3 class="quest-title">${lesson.title}</h3>
          <p class="quest-lead">${lesson.lead}</p>

          <details class="quest-detail">
            <summary>展开细节（${lesson.body.length} 段）</summary>
            ${lesson.body.map((p) => `<p>${p}</p>`).join("")}
            ${lesson.myth ? `<p class="quest-myth"><strong>常见误解：</strong>${lesson.myth}</p>` : ""}
            ${
              lesson.example?.[0]
                ? `<p class="quest-example">在站内验证：<a href="${lesson.example[1]}">${lesson.example[0]}</a></p>`
                : ""
            }
          </details>

          <div class="quest-check">
            <p class="quest-check-label">检验一下</p>
            <p class="quest-q">${check.q}</p>
            <div class="quest-opts">
              ${check.options
                .map(
                  (opt, i) => `
                <button class="quest-opt" data-index="${i}">
                  <span class="quest-key">${String.fromCharCode(65 + i)}</span>
                  <span>${opt.text}</span>
                </button>`
                )
                .join("")}
            </div>
            <div id="quest-feedback"></div>
          </div>
        </div>
      </div>`;

    bindOptions(lesson, check);
  };

  const bindOptions = (lesson, check) => {
    host.querySelectorAll(".quest-opt").forEach((button) => {
      button.addEventListener("click", () => {
        if (state.revealed) return;
        const index = Number(button.dataset.index);
        const opt = check.options[index];
        state.chosen = index;
        state.revealed = true;

        host.querySelectorAll(".quest-opt").forEach((b, i) => {
          b.disabled = true;
          if (check.options[i].correct) b.classList.add("right");
          else if (i === index) b.classList.add("wrong");
        });

        const feedback = host.querySelector("#quest-feedback");

        if (opt.correct) {
          // 答对：写入进度，解锁下一关
          const id = questId(lesson);
          if (!progress.cleared.includes(id)) {
            progress.cleared.push(id);
            writeProgress(progress);
          }
          feedback.innerHTML = `
            <div class="quest-feedback ok">
              <p class="quest-feedback-title">✓ 通关</p>
              <p>${opt.explain}</p>
              <button class="quest-btn primary" id="quest-next">
                ${summarize(chapters, progress).current ? "下一关 →" : "看总结果"}
              </button>
            </div>`;
          feedback.querySelector("#quest-next")?.addEventListener("click", () => {
            state = { lesson: null, chosen: null, revealed: false, wrongTries: 0 };
            render();
            host.scrollIntoView({ behavior: "smooth", block: "start" });
          });
        } else {
          // 答错：不给跳过，必须看完解析重答
          state.wrongTries += 1;
          const correct = check.options.find((o) => o.correct);
          feedback.innerHTML = `
            <div class="quest-feedback bad">
              <p class="quest-feedback-title">✗ 再想想</p>
              <p>${opt.explain}</p>
              <p class="quest-hint">正确答案是「${correct.text}」——${correct.explain}</p>
              <button class="quest-btn" id="quest-retry">我懂了，重答</button>
            </div>`;
          feedback.querySelector("#quest-retry")?.addEventListener("click", () => {
            state.revealed = false;
            render();
          });
        }
      });
    });
  };

  render();
}

/**
 * 路径总览（可选展示）：只在用户主动点「看全图」时渲染，
 * 默认不展示——因为一屏铺开 46 关，正是这轮要避免的问题。
 */
export function renderQuestMap(host) {
  if (!host) return;
  const chapters = buildChapters();
  const progress = readProgress();
  const lockState = computeLockState(chapters, progress);

  host.innerHTML = `
    <div class="quest-map">
      ${chapters
        .map((chapter) => {
          const st = chapterState(chapter, lockState);
          return `
          <div class="quest-map-chapter ${st}">
            <p class="quest-map-title">${chapter.title}</p>
            <div class="quest-map-lessons">
              ${chapter.lessons
                .map((lesson) => {
                  const s = lockState.get(questId(lesson));
                  const cls = s.cleared ? "done" : s.unlocked ? "current" : "locked";
                  return `<span class="quest-map-item ${cls}">${s.cleared ? "✓" : ""} ${lesson.title}</span>`;
                })
                .join("")}
            </div>
          </div>`;
        })
        .join("")}
    </div>`;
}