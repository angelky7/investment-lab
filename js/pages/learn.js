/**
 * js/pages/learn.js — 学习页入口。
 *
 * 三种模式，**默认是闯关**：
 *   quest    一次一关，读一段 + 答一题，答对解锁下一关（默认）
 *   practice 独立题库随机刷题（67 道）
 *   case     多步决策训练（3 个场景）
 *
 * 为什么默认闯关：46 张卡片一次铺开的结果是「看起来很全，但没人读完」。
 * 一次只给一屏、每屏必须动手一次，才有推进感。
 */

import { initShell } from "../core/shell.js";
import { mountQuest } from "../ui/quest-ui.js";

const MODES = ["quest", "practice", "case"];

function showMode(mode) {
  const sections = {
    quest: document.getElementById("quest-section"),
    practice: document.getElementById("practice-section"),
    case: document.getElementById("case-section"),
  };

  for (const [key, el] of Object.entries(sections)) {
    if (el) el.hidden = key !== mode;
  }

  if (location.hash !== `#${mode}`) {
    history.replaceState(null, "", `#${mode}`);
  }
}

let practiceMounted = false;
let caseMounted = false;

async function ensurePractice() {
  if (practiceMounted) return;
  const { mountPractice } = await import("../ui/quiz-practice.js");
  mountPractice(document.getElementById("lab-practice"));
  practiceMounted = true;
}

async function ensureCase() {
  if (caseMounted) return;
  const { mountDecisionLab } = await import("../ui/decision-lab.js");
  mountDecisionLab(document.getElementById("lab-decision"));
  caseMounted = true;
}

async function main() {
  initShell({ active: "learn" });

  // 闯关是默认视图
  mountQuest(document.getElementById("quest-host"));
  showMode("quest");

  const go = async (mode) => {
    if (mode === "practice") await ensurePractice();
    if (mode === "case") await ensureCase();
    showMode(mode);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  document.getElementById("link-practice")?.addEventListener("click", (event) => {
    event.preventDefault();
    go("practice");
  });
  document.getElementById("link-case")?.addEventListener("click", (event) => {
    event.preventDefault();
    go("case");
  });
  document.getElementById("back-to-quest")?.addEventListener("click", () => go("quest"));
  document.getElementById("back-to-quest-2")?.addEventListener("click", () => go("quest"));

  // 支持深链：#practice / #case
  const hash = location.hash.replace("#", "");
  if (MODES.includes(hash) && hash !== "quest") {
    await go(hash);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}