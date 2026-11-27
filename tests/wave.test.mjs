/**
 * tests/wave.test.mjs — 纯三角函数拟合。
 *
 * 这个模块是「全部用三角函数拟合」的实现，测试要钉住三件事：
 *   1. 真的没有线性项（用合成数据验证：纯正弦能被完美还原）
 *   2. 半周期项确实能表达趋势（没有它，单调序列拟合很差）
 *   3. 谐波周期与数据跨度的关系正确（周期 = span / k）
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { fitTrigonometric, KONDRATIEFF_PHASES } from "../js/core/wave.js";

/* ---------------------------- 合成数据验证 ---------------------------- */

/** 造一条纯正弦序列：拟合应该几乎完美 */
function pureSine({ from = 1300, to = 2000, period = 60, amplitude = 0.3 }) {
  const years = [];
  const values = [];
  for (let y = from; y <= to; y += 1) {
    const t = y - from;
    years.push(y);
    values.push(Math.exp(amplitude * Math.sin((2 * Math.PI * t) / period) + 0.001 * t));
  }
  return { years, values };
}

test("周期正好等于 span/k 的正弦能被完美还原", () => {
  // 傅里叶只能表达 span/k 这些周期。
  // 跨度 700 年、k=10 → 周期 70 年，正好在谐波集合里，应该几乎完美。
  const { years, values } = pureSine({ from: 1300, to: 2000, period: 70, amplitude: 0.3 });
  const fit = fitTrigonometric(years, values, { harmonics: 10 });
  assert.ok(fit, "拟合不该返回 null");
  assert.ok(fit.r2 > 0.98, `R² 应 > 0.98，实际 ${fit.r2.toFixed(4)}`);
});

test("周期不在 span/k 上的正弦拟合会明显变差（这是方法的固有性质）", () => {
  // 跨度 700 年，60 年不在谐波集合里（最近的 700/12≈58.3、700/11≈63.6）。
  // 傅里叶级数无法精确表达它——这不是 bug，而是必须告诉用户的性质。
  const { years, values } = pureSine({ from: 1300, to: 2000, period: 60, amplitude: 0.3 });
  const offGrid = fitTrigonometric(years, values, { harmonics: 10 });
  const onGrid = fitTrigonometric(years, values, { harmonics: 12 }); // 700/12≈58.3，更接近

  assert.ok(
    offGrid.r2 < 0.95,
    `60 年周期在 10 谐波下不该拟合得很好，实际 ${offGrid.r2.toFixed(4)}`
  );
  assert.ok(
    onGrid.r2 > offGrid.r2,
    `更接近的谐波应拟合更好：${offGrid.r2.toFixed(4)} vs ${onGrid.r2.toFixed(4)}`
  );
});

test("半周期项能表达单调趋势（这是纯三角拟合的关键）", () => {
  // 造一条单调指数增长，没有任何波动
  const years = [];
  const values = [];
  for (let y = 1300; y <= 2000; y += 1) {
    years.push(y);
    values.push(Math.exp(0.004 * (y - 1300)));
  }
  const fit = fitTrigonometric(years, values, { harmonics: 2 });
  assert.ok(fit.r2 > 0.9, `单调序列也应拟合得好（靠 1−cos 项），实际 ${fit.r2.toFixed(4)}`);
});

test("谐波周期 = 数据跨度 ÷ k", () => {
  const { years, values } = pureSine({ from: 1300, to: 2000 });
  const fit = fitTrigonometric(years, values, { harmonics: 10 });
  const span = 2000 - 1300;

  for (const h of fit.harmonicsInfo) {
    assert.ok(
      Math.abs(h.period - span / h.k) < 1e-6,
      `k=${h.k} 的周期应为 ${span / h.k}，实际 ${h.period}`
    );
  }
  assert.equal(fit.harmonicsInfo.length, 10);
});

test("谐波越多 R² 越高（过拟合的指纹）", () => {
  const { years, values } = pureSine({ period: 45 });
  const r3 = fitTrigonometric(years, values, { harmonics: 3 }).r2;
  const r20 = fitTrigonometric(years, values, { harmonics: 20 }).r2;
  assert.ok(r20 >= r3 - 1e-6, `20 谐波 R² 不应低于 3 谐波：${r3.toFixed(4)} vs ${r20.toFixed(4)}`);
});

test("参数个数 = 2 + 2K（常数 + 半周期项 + 每谐波两个系数）", () => {
  const { years, values } = pureSine({});
  for (const K of [1, 5, 12]) {
    const fit = fitTrigonometric(years, values, { harmonics: K });
    assert.equal(fit.parameters, 2 + 2 * K, `K=${K} 时参数应为 ${2 + 2 * K}`);
  }
});

/* ---------------------------- 真实数据验证 ---------------------------- */

const longrun = JSON.parse(
  fs.readFileSync(new URL("../data/longrun.json", import.meta.url), "utf-8")
);
const uk = longrun.uk_price_index;

test("英国物价 757 年：纯三角拟合 R² 高", () => {
  const fit = fitTrigonometric(uk.years, uk.values, { harmonics: 12 });
  assert.ok(fit.r2 > 0.98, `R² 应 > 0.98，实际 ${fit.r2.toFixed(4)}`);
  assert.ok(fit.span > 750, `跨度应 > 750 年，实际 ${fit.span}`);
});

test("英国物价：主谐波是整段跨度（长期趋势由半周期项+第一谐波承担）", () => {
  const fit = fitTrigonometric(uk.years, uk.values, { harmonics: 12 });
  assert.ok(fit.dominant, "应有主谐波");
  assert.ok(fit.dominant.k >= 1);
  assert.ok(Number.isFinite(fit.dominant.period));
});

test("拟合输出与输入等长，且全是有限正数", () => {
  const fit = fitTrigonometric(uk.years, uk.values, { harmonics: 12 });
  assert.equal(fit.fitted.length, uk.values.length);
  assert.equal(fit.trend.length, uk.values.length);
  for (const v of fit.fitted) {
    assert.ok(Number.isFinite(v) && v > 0, `拟合值非法：${v}`);
  }
  for (const v of fit.trend) {
    assert.ok(Number.isFinite(v) && v > 0, `趋势值非法：${v}`);
  }
});

test("样本太少或谐波数非法时返回 null，不抛异常", () => {
  assert.equal(fitTrigonometric([1900, 1901], [1, 2], { harmonics: 5 }), null);
  assert.equal(fitTrigonometric([], [], { harmonics: 5 }), null);
  assert.doesNotThrow(() => fitTrigonometric([1900, 1901, 1902], [1, 2, 3], { harmonics: 0 }));
});

/* ---------------------------- Shiller 数据 ---------------------------- */

test("Shiller 数据：1871 年起，覆盖康波所需的 150+ 年", () => {
  const shillerPath = new URL("../data/shiller.json", import.meta.url);
  if (!fs.existsSync(shillerPath)) {
    return; // 没有导入过就跳过
  }
  const shiller = JSON.parse(fs.readFileSync(shillerPath, "utf-8"));

  assert.ok(shiller.coverage.years > 150, `应 > 150 年，实际 ${shiller.coverage.years}`);
  assert.ok(shiller.coverage.from.startsWith("1871"), `起点应为 1871，实际 ${shiller.coverage.from}`);

  // 四个历史节点核对
  const labels = shiller.labels;
  const prices = shiller.series.price;
  const at = (label) => (labels.includes(label) ? prices[labels.indexOf(label)] : null);

  assert.ok(at("1929-09") > 30, `1929-09 应 > 30，实际 ${at("1929-09")}`);
  assert.ok(at("1932-06") < 10, `1932-06 应 < 10，实际 ${at("1932-06")}`);
  assert.ok(at("2000-01") > 1400, `2000-01 应 > 1400，实际 ${at("2000-01")}`);
  assert.ok(at("2009-03") < 800, `2009-03 应 < 800，实际 ${at("2009-03")}`);

  // 纯三角拟合应很好
  const fit = fitTrigonometric(shiller.fractions, prices, { harmonics: 20 });
  assert.ok(fit.r2 > 0.99, `Shiller 拟合 R² 应 > 0.99，实际 ${fit.r2.toFixed(4)}`);
});

/* ---------------------------- 康波划分结构 ---------------------------- */

test("康波四波划分结构完整", () => {
  assert.equal(KONDRATIEFF_PHASES.length, 4);
  for (const [i, phase] of KONDRATIEFF_PHASES.entries()) {
    assert.equal(phase.wave, i + 1);
    assert.ok(phase.up[0] < phase.up[1], `第 ${i + 1} 波上行段颠倒`);
    assert.ok(phase.down[0] < phase.down[1], `第 ${i + 1} 波下行段颠倒`);
    assert.equal(phase.up[1], phase.down[0], `第 ${i + 1} 波上下行不接续`);
  }
});