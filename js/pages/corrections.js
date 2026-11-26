/**
 * js/pages/corrections.js — 更正记录页。
 *
 * 内容在 js/core/corrections.js，这里只做渲染与「按严重程度筛选」。
 */

import { initShell } from "../core/shell.js";
import { CORRECTIONS, correctionStats } from "../core/corrections.js";

function renderStats() {
  const host = document.getElementById("correction-stats");
  if (!host) return;
  const stats = correctionStats();

  host.innerHTML = `
    <div class="metrics">
      <div class="metric">
        <div class="metric-label">已记录更正</div>
        <div class="metric-value">${stats.total} 处</div>
        <div class="metric-sub">只包含我自己发现的</div>
      </div>
      <div class="metric">
        <div class="metric-label">影响计算的</div>
        <div class="metric-value neg">${stats.substantive} 处</div>
        <div class="metric-sub">会让数字算错或误导判断</div>
      </div>
      <div class="metric">
        <div class="metric-label">只影响表述的</div>
        <div class="metric-value">${stats.descriptive} 处</div>
        <div class="metric-sub">计算没错，预期错了</div>
      </div>
    </div>`;
}

/**
 * 渲染列表。
 *
 * 注意：**筛选条不能跟着列表一起重渲染**。之前把整个 host 的 innerHTML 换掉，
 * 结果变化事件还没处理完，派发事件的按钮就被销毁了，MDUI 内部再去读它
 * 就抛出 "Cannot read properties of undefined (reading 'checkValidity')"。
 * 现在筛选条只创建一次，只替换下面的列表容器。
 */
function renderList(filter = "all") {
  const host = document.getElementById("correction-list");
  if (!host) return;

  // 第一次：建筛选条 + 空列表容器
  if (!host.querySelector("#correction-items")) {
    host.innerHTML = `
      <div class="row" style="gap:.4rem;flex-wrap:wrap;align-items:center;margin-bottom:.9rem">
        <span class="small muted">筛选</span>
        <mdui-segmented-button-group id="correction-filter" value="${filter}" selects="single">
          <mdui-segmented-button value="all">全部</mdui-segmented-button>
          <mdui-segmented-button value="实质性">影响计算</mdui-segmented-button>
          <mdui-segmented-button value="描述性">只影响表述</mdui-segmented-button>
        </mdui-segmented-button-group>
        <span class="small muted" id="correction-count"></span>
      </div>
      <div class="correction-list" id="correction-items"></div>`;

    host.querySelector("#correction-filter").addEventListener("change", (event) => {
      renderList(event.target.value);
    });
  }

  const list = CORRECTIONS.filter((c) => filter === "all" || c.severity === filter);
  const count = host.querySelector("#correction-count");
  if (count) count.textContent = `共 ${list.length} 条`;

  host.querySelector("#correction-items").innerHTML = list
    .map(
      (c) => `
      <article class="correction-item" data-severity="${c.severity}">
        <header class="correction-head">
          <span class="correction-badge ${c.severity === "实质性" ? "serious" : ""}">${c.severity}</span>
          <h2 class="correction-topic">${c.topic}</h2>
          <span class="correction-meta">${c.date} · v${c.version}</span>
        </header>

        <div class="correction-block was">
          <p class="correction-label">原来的说法</p>
          <p>${mdEmphasis(c.was)}</p>
        </div>

        <div class="correction-block now">
          <p class="correction-label">现在怎么说</p>
          <p>${mdEmphasis(c.now)}</p>
        </div>

        <div class="correction-block">
          <p class="correction-label">证据</p>
          <ul class="correction-evidence">
            ${c.evidence
              .map(([text, href]) =>
                href ? `<li><a href="${href}">${text}</a></li>` : `<li>${mdEmphasis(text)}</li>`
              )
              .join("")}
          </ul>
        </div>

        <div class="correction-block why">
          <p class="correction-label">当初为什么会错</p>
          <p>${mdEmphasis(c.why)}</p>
        </div>

        <div class="correction-block">
          <p class="correction-label">对用户的影响</p>
          <p>${mdEmphasis(c.impact)}</p>
        </div>
      </article>`
    )
    .join("");
}

/** 叙述里的 **强调** 渲染成 <strong>（内容由本项目生成，不含用户输入） */
function mdEmphasis(text) {
  return String(text).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

function main() {
  initShell({ active: "corrections" });
  renderStats();
  renderList();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}