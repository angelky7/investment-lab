/**
 * tests/decisions-corrections.test.mjs — 决策场景与更正记录的数据完整性。
 *
 * 这两份数据都有同一个风险：结构对、但内容会「悄悄坏掉」。
 *   - 决策场景少一个 ending，页面不报错，只是那句话不显示；
 *   - 更正记录漏一个字段，页面不报错，但那一条就失去了「为什么错」的价值。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { SCENARIOS, findScenario, summarizePath, TONE_ORDER } from "../js/core/decisions.js";
import { CORRECTIONS, correctionStats } from "../js/core/corrections.js";

/* ------------------------------ 决策场景 ------------------------------- */

test("三个场景，每个至少 3 步", () => {
  assert.ok(SCENARIOS.length >= 3, `只有 ${SCENARIOS.length} 个场景`);
  for (const s of SCENARIOS) {
    assert.ok(s.steps.length >= 3, `${s.id} 只有 ${s.steps.length} 步`);
    assert.ok(s.id && s.title && s.tagline && s.setup, `${s.id} 缺基础字段`);
    assert.ok(s.lesson && s.lesson.length >= 15, `${s.id} 缺 lesson`);
  }
});

test("每一步都有至少 3 个选项，且每个选项含 label / tone / note / 事后揭晓", () => {
  for (const s of SCENARIOS) {
    assert.ok(s.steps.length >= 3);
    for (const [i, step] of s.steps.entries()) {
      assert.ok(step.options.length >= 3, `${s.id} 第 ${i + 1} 步选项不足`);
      assert.ok(step.question && step.reveal && step.after, `${s.id} 第 ${i + 1} 步缺字段`);
      for (const opt of step.options) {
        assert.ok(opt.label && opt.tone && opt.note, `${s.id} 第 ${i + 1} 步选项字段不全`);
        assert.ok(
          TONE_ORDER.includes(opt.tone),
          `${s.id} 第 ${i + 1} 步的 tone「${opt.tone}」不在约定列表里`
        );
      }
      // 同一题内 label 不重复
      const labels = step.options.map((o) => o.label);
      assert.equal(new Set(labels).size, labels.length, `${s.id} 第 ${i + 1} 步有重复选项`);
    }
  }
});

test("每个场景都有两种结局文案（纪律 / 情绪）", () => {
  for (const s of SCENARIOS) {
    assert.ok(s.endings?.discipline, `${s.id} 缺 discipline 结局`);
    assert.ok(s.endings?.emotion, `${s.id} 缺 emotion 结局`);
  }
});

test("场景 id 唯一，findScenario 能找到", () => {
  const ids = SCENARIOS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) {
    assert.equal(findScenario(id)?.id, id);
  }
  assert.equal(findScenario("不存在的"), null);
});

test("summarizePath：多数是「纪律」时判定为纪律派", () => {
  const result = summarizePath(["纪律", "纪律", "乐观"]);
  assert.equal(result.disciplined, true);
  assert.equal(result.dominant, "纪律");
  assert.equal(result.counts["纪律"], 2);

  const loose = summarizePath(["乐观", "乐观", "追高"]);
  assert.equal(loose.disciplined, false);
});

test("summarizePath：空输入不炸", () => {
  const result = summarizePath([]);
  assert.equal(result.dominant, "");
  assert.equal(result.disciplined, false);
});

/* ------------------------------ 更正记录 ------------------------------- */

test("每条更正都有完整字段，且原话与现说法都在", () => {
  assert.ok(CORRECTIONS.length >= 5, `只有 ${CORRECTIONS.length} 条更正`);
  for (const c of CORRECTIONS) {
    for (const field of ["date", "version", "topic", "was", "now", "why", "impact", "severity"]) {
      assert.ok(c[field], `${c.topic} 缺字段 ${field}`);
    }
    assert.ok(c.was.length >= 15, `${c.topic} 的「原来的说法」过短`);
    assert.ok(c.now.length >= 15, `${c.topic} 的「现在怎么说」过短`);
    assert.ok(c.why.length >= 15, `${c.topic} 的「为什么会错」过短`);
    assert.ok(["实质性", "描述性"].includes(c.severity), `${c.topic} 的 severity 非法`);
    assert.ok(Array.isArray(c.evidence) && c.evidence.length >= 1, `${c.topic} 缺证据`);
  }
});

test("日期格式为 YYYY-MM-DD", () => {
  for (const c of CORRECTIONS) {
    assert.match(c.date, /^\d{4}-\d{2}-\d{2}$/, `${c.topic} 日期格式错：${c.date}`);
  }
});

test("correctionStats 统计与数据一致", () => {
  const stats = correctionStats();
  assert.equal(stats.total, CORRECTIONS.length);
  assert.equal(
    stats.substantive + stats.descriptive,
    CORRECTIONS.length,
    "两类之和应等于总数"
  );
  const manual = CORRECTIONS.filter((c) => c.severity === "实质性").length;
  assert.equal(stats.substantive, manual);
});