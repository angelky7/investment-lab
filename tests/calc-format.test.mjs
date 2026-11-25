/**
 * tests/calc-format.test.mjs — 计算器数学与格式化单元测试。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  annuity,
  compoundGrowth,
  drawdownRecovery,
  monthsToTarget,
  rebalancePlan,
} from "../js/core/calc.js";
import {
  count,
  dateLabel,
  duration,
  money,
  num,
  pct,
  price,
  rangeLabel,
  tone,
  typeLabel,
} from "../js/core/format.js";

test("compoundGrowth 零收益率时终值等于投入", () => {
  const result = compoundGrowth({ principal: 10000, monthly: 500, annualRate: 0, years: 2 });
  assert.equal(result.totalInvested, 10000 + 500 * 24);
  assert.ok(Math.abs(result.finalValue - result.totalInvested) < 1e-6);
  assert.equal(result.rows.length, 25);
});

test("compoundGrowth 月复利结果可手算", () => {
  const result = compoundGrowth({ principal: 10000, monthly: 0, annualRate: 0.12, years: 1 });
  const expected = 10000 * Math.pow(1.01, 12);
  assert.ok(Math.abs(result.finalValue - expected) < 1e-6, `实际 ${result.finalValue}`);
});

test("annuity 与 compoundGrowth 的定投部分口径一致", () => {
  const a = annuity({ amount: 1000, annualRate: 0.06, years: 10, timesPerYear: 12 });
  const b = compoundGrowth({ principal: 0, monthly: 1000, annualRate: 0.06, years: 10 });
  assert.ok(Math.abs(a.finalValue - b.finalValue) < 0.01);
});

test("drawdownRecovery 体现跌幅与回本的不对称", () => {
  const result = drawdownRecovery(100, 70);
  assert.ok(Math.abs(result.drawdown - 0.3) < 1e-12);
  assert.ok(Math.abs(result.recovery - 0.42857142857142855) < 1e-9);
  assert.ok(result.recovery > result.drawdown);
  assert.equal(drawdownRecovery(70, 100), null);
  assert.equal(drawdownRecovery(0, 100), null);
});

test("rebalancePlan 算出买卖金额并校验权重", () => {
  const result = rebalancePlan({
    items: [
      { name: "股票", current: 70000, target: 60 },
      { name: "债券", current: 30000, target: 40 },
    ],
  });
  assert.equal(result.total, 100000);
  assert.equal(result.valid, true);
  assert.equal(result.rows[0].action, "sell");
  assert.ok(Math.abs(result.rows[0].delta + 10000) < 1e-9);
  assert.equal(result.rows[1].action, "buy");
  assert.ok(Math.abs(result.rows[1].delta - 10000) < 1e-9);

  const invalid = rebalancePlan({ items: [{ name: "x", current: 1, target: 60 }] });
  assert.equal(invalid.valid, false);
});

test("monthsToTarget 在给定假设下给出有限值", () => {
  const months = monthsToTarget({ monthly: 5000, annualRate: 0.06, target: 1000000 });
  assert.ok(Number.isInteger(months) && months > 100);
  assert.equal(monthsToTarget({ monthly: 0 }), null);
});

test("pct / num / money / price 处理缺失值", () => {
  assert.equal(pct(0.1234), "+12.34%");
  assert.equal(pct(-0.05), "-5.00%");
  assert.equal(pct(0.5, { signed: false }), "50.00%");
  assert.equal(pct(null), "—");
  assert.equal(pct(NaN), "—");
  assert.equal(num(3.14159), "3.14");
  assert.equal(num(undefined), "—");
  assert.equal(money(1234567), "¥1,234,567");
  assert.equal(price(3916.42), "3,916.4");
});

test("dateLabel / rangeLabel / duration / count", () => {
  assert.equal(dateLabel("2024-09-30"), "2024/09/30");
  assert.equal(dateLabel(""), "");
  assert.equal(rangeLabel("2024-01-01", "2024-02-01"), "2024/01/01 – 2024/02/01");
  assert.equal(rangeLabel("", ""), "—");
  assert.equal(duration(120), "120 天");
  assert.equal(duration(730), "2.0 年");
  assert.equal(count(1234), "1,234");
  assert.equal(typeLabel("etf"), "ETF");
});

test("tone 与中文涨跌配色约定一致", () => {
  assert.equal(tone(0.01), "pos");
  assert.equal(tone(-0.01), "neg");
  assert.equal(tone(0), "");
  assert.equal(tone(null), "");
});