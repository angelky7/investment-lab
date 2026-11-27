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

import {
  fitPiecewiseWave,
  fitFixedWave,
  fitTrendOnly,
  KONDRATIEFF_PHASES,
} from "../js/core/wave.js";

const payload = JSON.parse(
  fs.readFileSync(new URL("../data/longrun.json", import.meta.url), "utf-8")
);
const uk = payload.uk_price_index;

/* ---------------------------- 合成数据验证 ---------------------------- */

/** 造一条「前半段周期 40、后半段周期 90」的序列——分段拟合应该能各自找回来 */
function syntheticPiecewise() {
  const years = [];
  const values = [];
  let phase = 0;
  for (let y = 1300; y <= 2000; y += 1) {
    const period = y < 1650 ? 40 : 90;
    phase += (2 * Math.PI) / period;
    const wave = 0.35 * Math.sin(phase);
    years.push(y);
    values.push(Math.exp(0.003 * (y - 1300) + wave));
  }
  return { years, values };
}

test("能从两段不同周期的合成数据里恢复形状", () => {
  const { years, values } = syntheticPiecewise();
  const trend = fitTrendOnly(years, values);
  const piecewise = fitPiecewiseWave(years, values, { segments: 2 });
  assert.ok(piecewise, "拟合不该返回 null");
  // 纯趋势抓不住正弦，分段应几乎完美拟合
  assert.ok(trend.r2 < 0.95, `纯趋势不该抓住波浪，实际 ${trend.r2.toFixed(3)}`);
  assert.ok(
    piecewise.r2 > 0.98,
    `分段应接近完美拟合，实际 ${piecewise.r2.toFixed(3)}`
  );
  assert.ok(
    piecewise.r2 > trend.r2,
    `分段应优于纯趋势：趋势 ${trend.r2.toFixed(3)} vs 分段 ${piecewise.r2.toFixed(3)}`
  );
});

test("段数越多 R² 越高（过拟合的指纹）", () => {
  const { years, values } = syntheticPiecewise();
  const r3 = fitPiecewiseWave(years, values, { segments: 3 }).r2;
  const r8 = fitPiecewiseWave(years, values, { segments: 8 }).r2;
  assert.ok(r8 >= r3 - 1e-6, `8 段 R² 不应低于 3 段：${r3.toFixed(4)} vs ${r8.toFixed(4)}`);
});

/* ---------------------------- 真实数据验证 ---------------------------- */

test("真实数据：纯趋势解释约 60%，固定 55 年周期几乎没帮助", () => {
  const trend = fitTrendOnly(uk.years, uk.values);
  const fixed = fitFixedWave(uk.years, uk.values, 55);

  assert.ok(trend.r2 > 0.5, `纯趋势 R² 应 > 0.5，实际 ${trend.r2.toFixed(4)}`);

  const gainFixed = fixed.r2 - trend.r2;
  assert.ok(
    gainFixed < 0.02,
    `固定 55 年周期的提升应极小（页面写的是 0.0004），实际 ${gainFixed.toFixed(4)}`
  );
});

test("真实数据：分段后 R² 显著提升（页面写的是 0.6059 → 0.9881）", () => {
  const trend = fitTrendOnly(uk.years, uk.values);
  const piecewise = fitPiecewiseWave(uk.years, uk.values, { segments: 6 });

  assert.ok(piecewise.r2 > 0.95, `6 段 R² 应 > 0.95，实际 ${piecewise.r2.toFixed(4)}`);
  assert.ok(
    piecewise.r2 - trend.r2 > 0.3,
    `提升应显著，实际 ${(piecewise.r2 - trend.r2).toFixed(4)}`
  );
});

test("分段结果：每段周期不同（这正是「分段」的意义）", () => {
  const piecewise = fitPiecewiseWave(uk.years, uk.values, { segments: 6 });
  const periods = piecewise.fits.map((f) => f.period);
  assert.ok(
    new Set(periods).size > 1,
    `各段周期应不同，实际全是 ${periods[0]}`
  );
  // 段区间必须首尾相接、覆盖全区间
  for (let i = 1; i < piecewise.fits.length; i += 1) {
    assert.equal(
      piecewise.fits[i].from,
      piecewise.fits[i - 1].to,
      `第 ${i} 段与第 ${i + 1} 段不接续`
    );
  }
  assert.equal(piecewise.fits[0].from, uk.years[0]);
  assert.equal(piecewise.fits[piecewise.fits.length - 1].to, uk.years[uk.years.length - 1]);
});

test("参数个数随段数线性增长（诚实说明里的数字依据）", () => {
  const p3 = fitPiecewiseWave(uk.years, uk.values, { segments: 3 });
  const p12 = fitPiecewiseWave(uk.years, uk.values, { segments: 12 });
  assert.equal(p3.parameters, 12, "3 段 × 4 参数 = 12");
  assert.equal(p12.parameters, 48, "12 段 × 4 参数 = 48");
  assert.ok(p12.r2 > p3.r2, "12 段 R² 应更高——这是过拟合，不是更好");
});

test("拟合输出与输入等长，且全是有限数", () => {
  const piecewise = fitPiecewiseWave(uk.years, uk.values, { segments: 6 });
  assert.equal(piecewise.wave.length, uk.years.length);
  assert.equal(piecewise.waveLog.length, uk.years.length);
  for (const v of piecewise.wave) {
    assert.ok(Number.isFinite(v) && v > 0, `波浪值非法：${v}`);
  }
});

test("样本太少或段数过多时返回 null，不抛异常", () => {
  assert.equal(fitPiecewiseWave([1900, 1901, 1902], [1, 2, 3], { segments: 6 }), null);
  assert.doesNotThrow(() => fitPiecewiseWave([], [], { segments: 6 }));
});

test("当前段状态可判定上下行", () => {
  const piecewise = fitPiecewiseWave(uk.years, uk.values, { segments: 6 });
  assert.ok(typeof piecewise.currentSlope === "number");
  assert.ok(Number.isFinite(piecewise.currentSlope));
  assert.ok(piecewise.currentPeriod >= 25 && piecewise.currentPeriod <= 260);
});

/* ---------------------------- 康波划分结构 ---------------------------- */

test("康波四波划分结构完整（上行段与下行段相接）", () => {
  assert.equal(KONDRATIEFF_PHASES.length, 4);
  for (const [i, phase] of KONDRATIEFF_PHASES.entries()) {
    assert.equal(phase.wave, i + 1);
    assert.ok(phase.up[0] < phase.up[1], `第 ${i + 1} 波上行段起止颠倒`);
    assert.ok(phase.down[0] < phase.down[1], `第 ${i + 1} 波下行段起止颠倒`);
    assert.equal(phase.up[1], phase.down[0], `第 ${i + 1} 波上下行不接续`);
    if (i > 0) {
      assert.equal(
        KONDRATIEFF_PHASES[i - 1].down[1],
        phase.up[0],
        `第 ${i} 与 ${i + 1} 波之间断开`
      );
    }
  }
});