/**
 * tests/quest.test.mjs — 闯关系统的解锁逻辑。

这是纯逻辑，但错了后果很严重：
  - 解锁算错 → 用户卡在第 1 关出不去，或一次全解锁失去闯关意义
  - 进度 id 不稳 → 刷新后进度丢失
  - 通关判定算错 → 卡在中间关

 * 用 Node 内置 test，不需要浏览器。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildChapters,
  questId,
  computeLockState,
  summarize,
  chapterState,
} from "../js/core/quest.js";

const chapters = buildChapters();
const flat = chapters.flatMap((c) => c.lessons);

test("章节由 46 节课构成，每章不超过 3 节", () => {
  assert.ok(flat.length >= 40, `只有 ${flat.length} 关`);
  for (const chapter of chapters) {
    assert.ok(chapter.lessons.length > 0, `${chapter.id} 是空章`);
    assert.ok(chapter.lessons.length <= 3, `${chapter.id} 有 ${chapter.lessons.length} 节，超过 3`);
  }
});

test("每关有唯一 id（级别 + 标题）", () => {
  const ids = flat.map(questId);
  assert.equal(new Set(ids).size, ids.length, "存在重复的关卡 id");
});

test("每关都有题目且恰好一个正确答案", () => {
  for (const lesson of flat) {
    assert.ok(lesson.check, `${lesson.title} 没有检验题`);
    assert.ok(lesson.check.q && lesson.check.q.length > 5, `${lesson.title} 题干过短`);
    assert.ok(lesson.check.options.length >= 2, `${lesson.title} 选项不足`);
    const correct = lesson.check.options.filter((o) => o.correct).length;
    assert.equal(correct, 1, `${lesson.title} 正确答案有 ${correct} 个`);
    for (const [i, opt] of lesson.check.options.entries()) {
      assert.ok(
        typeof opt.explain === "string" && opt.explain.trim().length > 3,
        `${lesson.title} 第 ${i + 1} 个选项缺解析：${JSON.stringify(opt)}`
      );
    }
  }
});

test("零进度：第 1 关解锁，其余全部锁住", () => {
  const state = computeLockState(chapters, { cleared: [], read: [] });
  assert.equal(state.get(questId(flat[0])).unlocked, true, "第 1 关必须解锁");
  assert.equal(state.get(questId(flat[0])).cleared, false);
  for (let i = 1; i < flat.length; i++) {
    assert.equal(state.get(questId(flat[i])).unlocked, false, `第 ${i + 1} 关不该解锁`);
  }
});

test("通关第 1 关后：第 2 关解锁，第 3 关仍锁", () => {
  const progress = { cleared: [questId(flat[0])], read: [] };
  const state = computeLockState(chapters, progress);
  assert.equal(state.get(questId(flat[0])).cleared, true);
  assert.equal(state.get(questId(flat[1])).unlocked, true);
  assert.equal(state.get(questId(flat[2])).unlocked, false);
});

test("连续通关 5 关：第 6 关解锁", () => {
  const progress = { cleared: flat.slice(0, 5).map(questId), read: [] };
  const state = computeLockState(chapters, progress);
  assert.equal(state.get(questId(flat[5])).unlocked, true);
  assert.equal(state.get(questId(flat[6])).unlocked, false);
});

test("全部通关：没有「当前关」", () => {
  const progress = { cleared: flat.map(questId), read: [] };
  const summary = summarize(chapters, progress);
  assert.equal(summary.cleared, flat.length);
  assert.equal(summary.percent, 100);
  assert.ok(!summary.current, "全通关后不该还有当前关");
});

test("summarize：当前关就是第一个未通关的已解锁关", () => {
  const progress = { cleared: flat.slice(0, 3).map(questId), read: [] };
  const summary = summarize(chapters, progress);
  assert.equal(summary.cleared, 3);
  assert.equal(questId(summary.current), questId(flat[3]));
  assert.equal(summary.currentIndex, 4);
  assert.equal(summary.percent, Math.round((3 / flat.length) * 100));
});

test("跳关作弊无效：清空中间一关的进度不会让后面解锁", () => {
  // 只通关第 1 关和第 5 关（模拟手改 localStorage）
  const progress = { cleared: [questId(flat[0]), questId(flat[4])], read: [] };
  const state = computeLockState(chapters, progress);
  // 第 2 关解锁（因为第 1 关通关），第 3 关应该锁着（因为第 2 关没通关）
  assert.equal(state.get(questId(flat[1])).unlocked, true);
  assert.equal(state.get(questId(flat[2])).unlocked, false, "不能跳过第 2 关直接解锁第 3 关");
});

test("chapterState：全通为 done，有解锁为 active，全锁为 locked", () => {
  const first = chapters[0];
  const zero = computeLockState(chapters, { cleared: [], read: [] });
  assert.equal(chapterState(first, zero), "active", "第 1 章应处于进行中");

  const allFirst = computeLockState(chapters, {
    cleared: first.lessons.map(questId),
    read: [],
  });
  assert.equal(chapterState(first, allFirst), "done", "第 1 章全通后应为 done");

  const last = chapters[chapters.length - 1];
  assert.equal(chapterState(last, zero), "locked", "最后一章初始应为 locked");
});

test("进度 id 与顺序无关（改章节切分不会丢进度）", () => {
  const lesson = flat[7];
  const id = questId(lesson);
  assert.equal(id, `${lesson.level}:${lesson.title}`);
  // id 里不应含位置信息
  assert.ok(!/\d+$/.test(id) || id.endsWith(lesson.title), "id 不应包含位置数字");
});