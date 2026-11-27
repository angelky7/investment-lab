/**
 * tests/wave.test.mjs — 长波拟合的正确性。
 *
 * 这条波浪线是**辅助线**，但它如果算错了会误导人：
 *   - 拟合失败返回 null → 页面画不出图
 *   - R² 算错 → 「可信度」那一段就说谎了
 *   - 振幅/相位算错 → 「当前位置」指错方向
 *
 * 所以用合成数据做端到端验证：造一条「已知周期 + 已知振幅」的序列，
 * 看拟合能不能把它找回来。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { fitWave, fitTrendOnly, KONDRATIEFF_PHASES } from "../js/core/wave.js";

/** 造一条：指数趋势 + 指定周期的正弦 */
function synthetic({ from = 1300, to = 2000, period = 55, amplitude = 0.3, slope = 0.004 }) {
  const years = [];
  const values = [];
  for (let y = from; y <= to; y += 1) {
    years.push(y);
    const t = y - from;
    const wave = amplitude * Math.sin((2 * Math.PI * t) / period);
    values.push(Math.exp(slope * t + wave));
  }
  return { years, values };
}

test("能从合成数据里找回已知周期", () => {
  const { years, values } = synthetic({ period: 55, amplitude: 0.3 });
  const fit = fitWave(years, values, 55);
  assert.ok(fit, "拟合不该返回 null");
  assert.ok(fit.r2 > 0.98, `R² 应接近 1，实际 ${fit.r2.toFixed(4)}`);
  // 振幅应接近 0.3（对数尺度）
  assert.ok(Math.abs(fit.amplitude - 0.3) < 0.03, `振幅应约 0.3，实际 ${fit.amplitude.toFixed(3)}`);
});

test("用错误的周期拟合，R² 更低但差距可能不大（趋势项吃掉了大部分解释力）", () => {
  const { years, values } = synthetic({ period: 55, amplitude: 0.3 });
  const right = fitWave(years, values, 55);
  const wrong = fitWave(years, values, 23);
  assert.ok(right.r2 > wrong.r2, "正确周期的 R² 应更高");

  // 关键观察：即使周期错得离谱，R² 也掉得不多——
  // 因为线性趋势项本身就能解释大部分方差。这正是「R² 高不等于波浪真实存在」的原因，
  // 也是页面里「只提升 0.0004」那句话的来由。
  const gap = right.r2 - wrong.r2;
  assert.ok(gap > 0, "差距应为正");
  assert.ok(
    gap < 0.5,
    `趋势项应吃掉大部分解释力，差距不该超过 0.5，实际 ${gap.toFixed(3)}`
  );
});

test("趋势项能单独拟合，且 R² 不超过带波浪的拟合", () => {
  const { years, values } = synthetic({ period: 55, amplitude: 0.3 });
  const trend = fitTrendOnly(years, values);
  const wave = fitWave(years, values, 55);
  assert.ok(trend, "趋势拟合不该返回 null");
  assert.ok(trend.trend.length === years.length);
  assert.ok(wave.r2 >= trend.r2, "带波浪的 R² 不应低于纯趋势");
});

test("真实数据上：55 年周期的解释力极弱（这是页面里那句话的依据）", async () => {
  const fs = await import("node:fs");
  const path = new URL("../data/longrun.json", import.meta.url);
  const payload = JSON.parse(fs.readFileSync(path, "utf-8"));
  const uk = payload.uk_price_index;

  const trend = fitTrendOnly(uk.years, uk.values);
  const wave55 = fitWave(uk.years, uk.values, 55);

  // 纯趋势已经解释 60% 左右
  assert.ok(trend.r2 > 0.5, `纯趋势 R² 应 > 0.5，实际 ${trend.r2.toFixed(4)}`);

  // 加 55 年波浪的提升必须很小 —— 这正是「康波在价格上不成立」的量化表达
  const gain = wave55.r2 - trend.r2;
  assert.ok(gain < 0.02, `55 年波浪的提升应小于 0.02，实际 ${gain.toFixed(4)}`);
});

test("换周期会改变「当前位置」——说明结论不唯一", async () => {
  const fs = await import("node:fs");
  const path = new URL("../data/longrun.json", import.meta.url);
  const payload = JSON.parse(fs.readFileSync(path, "utf-8"));
  const uk = payload.uk_price_index;

  const positions = [45, 55, 70, 100, 175].map((p) => fitWave(uk.years, uk.values, p).position);
  const signs = positions.map((v) => (v >= 0 ? 1 : -1));
  // 至少有两种不同符号，否则「位置」这个说法就是假的
  assert.ok(new Set(signs).size > 1, `不同周期应给出不同位置，实际 ${positions.map((v) => v.toFixed(2))}`);
});

test("拟合对短序列与非法周期返回 null，不抛异常", () => {
  assert.equal(fitWave([1900, 1901], [1, 2], 55), null, "样本太少应返回 null");
  assert.equal(fitWave([1900, 1901, 1902], [1, 2, 3], 0), null, "周期为 0 应返回 null");
  assert.equal(fitWave([1900, 1901, 1902], [1, 2, 3], -5), null, "负周期应返回 null");
  assert.doesNotThrow(() => fitWave([], [], 55));
});

test("康波四波划分结构完整（上行段与下行段相接）", () => {
  assert.equal(KONDRATIEFF_PHASES.length, 4);
  for (const [i, phase] of KONDRATIEFF_PHASES.entries()) {
    assert.equal(phase.wave, i + 1);
    assert.equal(phase.up.length, 2);
    assert.equal(phase.down.length, 2);
    assert.ok(phase.up[0] < phase.up[1], `第 ${i + 1} 波上行段起止颠倒`);
    assert.ok(phase.down[0] < phase.down[1], `第 ${i + 1} 波下行段起止颠倒`);
    // 上行段结束 = 下行段开始
    assert.equal(phase.up[1], phase.down[0], `第 ${i + 1} 波上下行不接续`);
    if (i > 0) {
      // 上一波下行结束 = 本波上行开始
      assert.equal(KONDRATIEFF_PHASES[i - 1].down[1], phase.up[0], `第 ${i} 与 ${i + 1} 波之间断开`);
    }
  }
});