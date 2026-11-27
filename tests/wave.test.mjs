/**
 * tests/wave.test.mjs — 分段长波拟合。
 *
 * 分段拟合的核心风险是**过拟合伪装成好结果**：
 * 段数越多 R² 越高，看起来越"准"，但每段的「周期」可能一个波都没走完。
 * 所以测试要同时钉住两件事：拟合能力（该高的时候要高）
 * 和它的代价（参数个数、段内周期数）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { fitContinuousWave, fitTrendOnly, KONDRATIEFF_PHASES } from "../js/core/wave.js";

const payload = JSON.parse(
  fs.readFileSync(new URL("../data/longrun.json", import.meta.url), "utf-8")
);
const uk = payload.uk_price_index;

/* ---------------------------- 合成数据验证 ---------------------------- */

/** 造一条已知周期的序列：分段拟合应该能贴合 */
function synthetic() {
  const years = [];
  const values = [];
  for (let y = 1300; y <= 2000; y += 1) {
    const t = y - 1300;
    const period = y < 1650 ? 40 : 90;
    const wave = 0.3 * Math.sin((2 * Math.PI * t) / period);
    years.push(y);
    values.push(Math.exp(0.003 * t + wave));
  }
  return { years, values };
}

test("能从合成数据里贴合出高 R²", () => {
  const { years, values } = synthetic();
  const trend = fitTrendOnly(years, values);
  const fit = fitContinuousWave(years, values, { segments: 12 });
  assert.ok(fit, "拟合不该返回 null");
  assert.ok(trend.r2 < 0.95, `纯趋势不该抓住波浪，实际 ${trend.r2.toFixed(3)}`);
  assert.ok(fit.r2 > 0.95, `分段拟合应接近完美，实际 ${fit.r2.toFixed(3)}`);
});

test("节点越多 R² 越高（过拟合的指纹）", () => {
  const { years, values } = synthetic();
  const r6 = fitContinuousWave(years, values, { segments: 6 }).r2;
  const r24 = fitContinuousWave(years, values, { segments: 24 }).r2;
  assert.ok(r24 >= r6 - 1e-6, `24 节点 R² 不应低于 6 节点：${r6.toFixed(4)} vs ${r24.toFixed(4)}`);
});

/* ---------------------------- 真实数据验证 ---------------------------- */

test("真实数据：纯趋势解释约 60%", () => {
  const trend = fitTrendOnly(uk.years, uk.values);
  assert.ok(trend.r2 > 0.5, `纯趋势 R² 应 > 0.5，实际 ${trend.r2.toFixed(4)}`);
  assert.ok(trend.r2 < 0.7, `纯趋势 R² 不该过高，实际 ${trend.r2.toFixed(4)}`);
});

test("真实数据：分段拟合 R² 显著高于纯趋势", () => {
  const trend = fitTrendOnly(uk.years, uk.values);
  const fit = fitContinuousWave(uk.years, uk.values, { segments: 12 });
  assert.ok(fit.r2 > 0.95, `12 节点 R² 应 > 0.95，实际 ${fit.r2.toFixed(4)}`);
  assert.ok(fit.r2 - trend.r2 > 0.3, `提升应显著，实际 ${(fit.r2 - trend.r2).toFixed(4)}`);
});

test("每段的周期各不相同（这正是「分段」的意义）", () => {
  const fit = fitContinuousWave(uk.years, uk.values, { segments: 12 });
  const periods = fit.segmentInfo.map((s) => s.period).filter(Boolean);
  assert.ok(periods.length > 0);
  assert.ok(new Set(periods.map((p) => Math.round(p))).size > 3, `周期应有多样性，实际 ${periods.map((p) => p.toFixed(0))}`);
  // 周期不能荒谬（比如 2520 年）
  for (const p of periods) {
    assert.ok(p > 8 && p < 500, `周期 ${p.toFixed(0)} 年不合理`);
  }
});

test("段区间首尾相接，覆盖全区间", () => {
  const fit = fitContinuousWave(uk.years, uk.values, { segments: 12 });
  for (let i = 1; i < fit.segmentInfo.length; i += 1) {
    assert.equal(fit.segmentInfo[i].from, fit.segmentInfo[i - 1].to, `第 ${i} 段不接续`);
  }
  assert.equal(fit.segmentInfo[0].from, uk.years[0]);
  assert.equal(fit.segmentInfo[fit.segmentInfo.length - 1].to, uk.years[uk.years.length - 1]);
});

test("输出连续：相邻年份不出现大跳变", () => {
  const fit = fitContinuousWave(uk.years, uk.values, { segments: 12 });
  let maxJump = 0;
  for (let i = 1; i < fit.waveLog.length; i += 1) {
    maxJump = Math.max(maxJump, Math.abs(fit.waveLog[i] - fit.waveLog[i - 1]));
  }
  // 对数尺度下相邻年份跳变应 < 0.5（约 65%），否则就是断开了
  assert.ok(maxJump < 0.5, `相邻年份最大跳变 ${maxJump.toFixed(3)}，可能不连续`);
});

test("段内 R² 不为负（点数过少时的退化处理）", () => {
  const fit = fitContinuousWave(uk.years, uk.values, { segments: 24 });
  for (const seg of fit.segmentInfo) {
    assert.ok(seg.segmentR2 >= 0, `${seg.from}-${seg.to} 的段内 R² 为负：${seg.segmentR2}`);
    assert.ok(seg.segmentR2 <= 1.0001, `段内 R² 超过 1：${seg.segmentR2}`);
  }
});

test("参数个数随节点数增长（诚实说明的依据）", () => {
  const p6 = fitContinuousWave(uk.years, uk.values, { segments: 6 });
  const p24 = fitContinuousWave(uk.years, uk.values, { segments: 24 });
  assert.ok(p24.parameters > p6.parameters, "24 节点参数应更多");
  assert.ok(p24.r2 > p6.r2, "24 节点 R² 更高——这是过拟合，不是更好");
});

test("样本太少返回 null，不抛异常", () => {
  assert.equal(fitContinuousWave([1900, 1901, 1902], [1, 2, 3], { segments: 6 }), null);
  assert.doesNotThrow(() => fitContinuousWave([], [], { segments: 6 }));
});

test("康波四波划分结构完整", () => {
  assert.equal(KONDRATIEFF_PHASES.length, 4);
  for (const [i, phase] of KONDRATIEFF_PHASES.entries()) {
    assert.equal(phase.wave, i + 1);
    assert.ok(phase.up[0] < phase.up[1], `第 ${i + 1} 波上行段颠倒`);
    assert.ok(phase.down[0] < phase.down[1], `第 ${i + 1} 波下行段颠倒`);
    assert.equal(phase.up[1], phase.down[0], `第 ${i + 1} 波上下行不接续`);
  }
});
