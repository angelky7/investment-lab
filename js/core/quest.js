/**
 * js/core/quest.js — 闯关系统。
 *
 * 原来的问题（用户提的）：
 *   1. 46 张卡片一次性铺开，密密麻麻，没有「下一步该做什么」；
 *   2. 刷题是 20 道随机选择题，和课程完全脱节，做完不知道为什么要做；
 *   3. 没有进度感，所以没有动力继续。
 *
 * 这一版的设计：
 *   - **一条路径**：章节 → 关卡，一次只看见当前这一关，做完才解锁下一关；
 *   - **环环相扣**：每关 = 一段阅读 + 一道题，题就是这一段的检验，不是随机抽的；
 *   - **三关一章**：每章结束有「章末挑战」，答对才进下一章；
 *   - **可见进度**：顶部一条路径图，已通关的亮着，当前关在跳动；
 *   - **错题不惩罚**：答错可以立刻重答，但必须看完解析。
 *
 * 关键取舍：**一次只给一屏**。信息密度是这轮返工的核心问题——
 * 密密麻麻的卡片不会让人记住更多，只会让人关掉页面。
 */

import { LESSONS } from "./lessons.js";

const PROGRESS_KEY = "investment-lab:quest";
const CHAPTER_SIZE = 3;

/** 章节定义：每个级别按 3 关一章切分 */
const CHAPTER_TITLES = {
  beginner: ["入门：先搞清楚你在买什么", "入门：成本与分散", "入门：第一次下单前"],
  intermediate: ["进阶：看懂财务数字", "进阶：估值与周期", "进阶：组合思维"],
  advanced: ["高级：风险的数学", "高级：回撤与再平衡", "高级：费用与摩擦"],
  strategy: ["策略：配置框架", "策略：再平衡实践", "策略：常见策略拆解"],
};

/** 把 46 节课按级别分组，再按 3 节一章切分 */
export function buildChapters() {
  const byLevel = {};
  for (const lesson of LESSONS) {
    (byLevel[lesson.level] ||= []).push(lesson);
  }

  const order = ["beginner", "intermediate", "advanced", "strategy"];
  const chapters = [];

  for (const level of order) {
    const lessons = byLevel[level] || [];
    if (!lessons.length) continue;
    const titles = CHAPTER_TITLES[level] || [];

    for (let i = 0; i < lessons.length; i += CHAPTER_SIZE) {
      const slice = lessons.slice(i, i + CHAPTER_SIZE);
      const chapterIndex = Math.floor(i / CHAPTER_SIZE);
      chapters.push({
        id: `${level}-${chapterIndex}`,
        level,
        index: chapterIndex,
        title: titles[chapterIndex] || `${level} 第 ${chapterIndex + 1} 章`,
        lessons: slice,
      });
    }
  }

  // 全局序号，用于「第 N 关 / 共 M 关」
  let n = 0;
  for (const chapter of chapters) {
    for (const lesson of chapter.lessons) {
      n += 1;
      lesson.__questIndex = n;
    }
  }

  return chapters;
}

export function readProgress() {
  try {
    const raw = JSON.parse(localStorage.getItem(PROGRESS_KEY) || "{}");
    return {
      cleared: Array.isArray(raw.cleared) ? raw.cleared : [],
      // 阅读完成但未答题的关：允许中途离开
      read: Array.isArray(raw.read) ? raw.read : [],
    };
  } catch {
    return { cleared: [], read: [] };
  }
}

export function writeProgress(progress) {
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
  } catch {
    /* 隐私模式忽略 */
  }
}

/** 关卡的稳定 id（用级别 + 标题，改顺序不会丢进度） */
export function questId(lesson) {
  return `${lesson.level}:${lesson.title}`;
}

/**
 * 计算解锁状态。
 *
 * 规则：第 1 关永远解锁；第 N 关解锁的条件是第 N-1 关已通关。
 * 这样一次只会有一个「当前关」，其余要么已通关、要么锁着。
 */
export function computeLockState(chapters, progress) {
  const cleared = new Set(progress.cleared);
  const flat = chapters.flatMap((c) => c.lessons);

  const state = new Map();
  let previousCleared = true; // 第 1 关默认解锁
  for (const lesson of flat) {
    const id = questId(lesson);
    const isCleared = cleared.has(id);
    const unlocked = previousCleared || isCleared;
    state.set(id, { unlocked, cleared: isCleared });
    previousCleared = isCleared;
  }
  return state;
}

/** 进度摘要：已通关 / 总数、当前关、百分比 */
export function summarize(chapters, progress) {
  const flat = chapters.flatMap((c) => c.lessons);
  const cleared = new Set(progress.cleared);
  const clearedCount = flat.filter((l) => cleared.has(questId(l))).length;

  const lockState = computeLockState(chapters, progress);
  const current = flat.find((l) => {
    const s = lockState.get(questId(l));
    return s.unlocked && !s.cleared;
  });

  return {
    total: flat.length,
    cleared: clearedCount,
    percent: flat.length ? Math.round((clearedCount / flat.length) * 100) : 0,
    current,
    currentIndex: current ? current.__questIndex : null,
  };
}

/**
 * 章节状态：全部通关才算本章完成；本章有未解锁关则视为「进行中」。
 */
export function chapterState(chapter, lockState) {
  const states = chapter.lessons.map((l) => lockState.get(questId(l)));
  const allCleared = states.every((s) => s.cleared);
  const anyUnlocked = states.some((s) => s.unlocked);
  if (allCleared) return "done";
  if (anyUnlocked) return "active";
  return "locked";
}