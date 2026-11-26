/**
 * tests/quizbank.test.mjs — 题库完整性测试。
 *
 * 题库是最容易「悄悄坏掉」的内容：复制粘贴时漏掉 correct: true、
 * 选项数不一致、解析复制了上一题、id 重复——这些都不会让页面报错，
 * 只会让用户看到一道没法答对的题。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { QUIZ_BANK_A } from "../js/core/quizbank.js";

test("题库不为空，且四个以上级别都有题", () => {
  assert.ok(QUIZ_BANK_A.length >= 60, `题库只有 ${QUIZ_BANK_A.length} 道`);
  const levels = new Set(QUIZ_BANK_A.map((q) => q.level));
  for (const level of ["beginner", "intermediate", "advanced", "strategy", "method"]) {
    assert.ok(levels.has(level), `缺少 ${level} 级别的题`);
  }
});

test("每道题恰好 4 个选项、恰好 1 个正确答案", () => {
  for (const q of QUIZ_BANK_A) {
    assert.equal(q.options.length, 4, `${q.id} 选项数为 ${q.options.length}`);
    const correct = q.options.filter((o) => o.correct).length;
    assert.equal(correct, 1, `${q.id} 正确答案有 ${correct} 个`);
  }
});

test("id 唯一，题干非空，解析足够长", () => {
  const seen = new Set();
  for (const q of QUIZ_BANK_A) {
    assert.ok(!seen.has(q.id), `id 重复：${q.id}`);
    seen.add(q.id);
    assert.ok(q.q && q.q.length >= 8, `${q.id} 题干过短`);
    assert.ok(q.explain && q.explain.length >= 15, `${q.id} 解析过短`);
    assert.ok(q.topic, `${q.id} 缺少 topic`);
    for (const opt of q.options) {
      assert.ok(opt.text && opt.text.trim().length >= 1, `${q.id} 有空选项`);
    }
  }
});

test("选项文本在同一题内不重复（防止复制粘贴出错）", () => {
  for (const q of QUIZ_BANK_A) {
    const texts = q.options.map((o) => o.text.trim());
    assert.equal(new Set(texts).size, texts.length, `${q.id} 有重复选项`);
  }
});

test("level 只能是约定的五种", () => {
  const allowed = new Set(["beginner", "intermediate", "advanced", "strategy", "method"]);
  for (const q of QUIZ_BANK_A) {
    assert.ok(allowed.has(q.level), `${q.id} 的 level 非法：${q.level}`);
  }
});