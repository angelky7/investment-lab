// tests/e2e/smoke.mjs — 无头浏览器端到端冒烟测试。
//
// 逐页加载站点，切换每个子页签，收集控制台/网络错误，并截图存档。
// 这是「单元测试覆盖不到」的那部分：MDUI 自定义元素升级、ES 模块加载顺序、
// canvas 绘制、真实数据请求。
//
// 用法：
//   npm i -D playwright-core        # 只装驱动，复用系统 Chrome
//   node tests/e2e/smoke.mjs                        # 默认 http://127.0.0.1:8080
//   node tests/e2e/smoke.mjs https://angelky7.github.io/investment-lab
//   SHOTS=out node tests/e2e/smoke.mjs              # 自定义截图目录
//
// 退出码 0 表示所有页面零错误。

import { chromium } from "playwright-core";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const BASE = (process.argv[2] || "http://127.0.0.1:8080").replace(/\/$/, "");
const SHOTS = process.env.SHOTS || "e2e-shots";

/** 依次尝试：playwright 自带浏览器 → 系统 Chrome → 系统 Edge */
async function launch() {
  const candidates = [
    { channel: "chrome" },
    { channel: "msedge" },
    process.platform === "win32"
      ? { executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" }
      : null,
    process.platform === "linux" ? { executablePath: "/usr/bin/google-chrome" } : null,
    process.platform === "darwin"
      ? { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" }
      : null,
    {},
  ].filter(Boolean);

  const errors = [];
  for (const options of candidates) {
    try {
      return await chromium.launch({ headless: true, ...options });
    } catch (err) {
      errors.push(`${JSON.stringify(options)}: ${err.message.split("\n")[0]}`);
    }
  }
  throw new Error(
    `找不到可用的 Chromium。请安装 Chrome，或执行 npx playwright install chromium。\n${errors.join("\n")}`
  );
}

const CASES = [
  { path: "index.html", tabs: null },
  { path: "learn.html", tabs: "#learn-tabs", values: ["beginner", "intermediate", "advanced", "case"] },
  { path: "analysis.html", tabs: "#mode-tabs", values: ["single", "compare"] },
  {
    path: "analysis.html?mode=compare&compare=index:000300,index:000905,etf:518880",
    tabs: null,
    label: "analysis-compare",
  },
  {
    path: "portfolio.html",
    tabs: "#mode-tabs",
    values: ["corr", "dca", "stress", "rebalance", "strategy"],
  },
  { path: "history.html", tabs: null },
  { path: "calculator.html", tabs: "#calc-tabs", values: ["compound", "dca", "drawdown", "rebalance"] },
  { path: "data.html", tabs: null },
];

function slug(value) {
  return value.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
}

async function snapshot(page) {
  return page.evaluate(() => {
    const visible = (el) => el && el.offsetParent !== null;
    const text = document.body.textContent.replace(/\s+/g, " ");
    return {
      title: document.title,
      h1: document.querySelector("h1")?.textContent?.trim() || "",
      metrics: [...document.querySelectorAll(".metric")].filter(visible).length,
      canvases: [...document.querySelectorAll(".chart canvas")].filter(visible).length,
      tableRows: [...document.querySelectorAll("table.tbl tbody tr")].filter(visible).length,
      skeletons: document.querySelectorAll(".skeleton").length,
      drawerItems: document.querySelectorAll("#nav-drawer mdui-list-item").length,
      // 页面文本里出现这些说明渲染逻辑出错了
      broken: /出错了|加载失败|undefined|NaN|\[object Object\]/.test(text),
    };
  });
}

async function main() {
  await fs.mkdir(SHOTS, { recursive: true });
  const browser = await launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const failures = [];
  let checks = 0;

  for (const testCase of CASES) {
    const label = testCase.label || slug(testCase.path);
    const page = await context.newPage();
    const issues = [];
    page.on("pageerror", (err) => issues.push(`pageerror: ${String(err).split("\n")[0]}`));
    page.on("console", (msg) => {
      if (msg.type() === "error") issues.push(`console: ${msg.text().replace(/\s+/g, " ").slice(0, 200)}`);
    });
    page.on("requestfailed", (req) => {
      if (!req.url().includes("favicon")) {
        issues.push(`requestfailed: ${req.url()} ${req.failure()?.errorText ?? ""}`.slice(0, 200));
      }
    });

    try {
      await page.goto(`${BASE}/${testCase.path}`, { waitUntil: "load", timeout: 60000 });
      await page.waitForTimeout(2800);

      const values = testCase.values || [null];
      for (const value of values) {
        if (value) {
          await page.evaluate((val) => {
            const tabs = document.querySelector("#mode-tabs, #calc-tabs, #learn-tabs");
            if (tabs) tabs.value = val;
          }, value);
          await page.waitForTimeout(2200);
        }
        const state = await snapshot(page);
        checks += 1;
        if (state.broken) issues.push(`渲染异常（${value || "默认"}）：页面出现错误文案或 NaN/undefined`);
        if (state.drawerItems < 7) issues.push(`导航抽屉只渲染了 ${state.drawerItems} 项`);

        const file = path.join(
          SHOTS,
          `${label}${value ? `-${value}` : ""}.png`
        );
        await page.screenshot({ path: file });
      }
    } catch (err) {
      issues.push(`导航失败: ${err.message.split("\n")[0]}`);
    }

    if (issues.length) failures.push({ label, issues: [...new Set(issues)] });
    await page.close();
    process.stdout.write(`· ${label}\n`);
  }

  await browser.close();

  if (failures.length) {
    console.error(`\n端到端检查失败 ${failures.length}/${CASES.length}：`);
    for (const failure of failures) {
      console.error(`  ${failure.label}`);
      for (const issue of failure.issues) console.error(`    - ${issue}`);
    }
    process.exitCode = 1;
  } else {
    console.log(`\n端到端检查通过：${CASES.length} 个页面、${checks} 个视图，零控制台错误。`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});