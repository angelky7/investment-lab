/**
 * js/pages/learn.js — 投资课程页的交互部分。
 *
 * 课程正文是静态 HTML（可被搜索引擎读取），这里只负责三处测验：
 * 计算题（要真的输入数字）、选择题（要判断）、决策训练（没有标准答案）。
 */

import { initShell, toast } from "../core/shell.js";

/* ------------------------------- 小工具 --------------------------------- */

function html(strings, ...values) {
  return strings.reduce((acc, str, i) => acc + str + (values[i] ?? ""), "");
}

function quizHost(name) {
  return document.querySelector(`.quiz[data-quiz="${name}"]`);
}

function feedback(el, type, content) {
  el.className = `quiz-feedback ${type}`;
  el.hidden = false;
  el.innerHTML = content;
}

/* ------------------------------ 小白测验 -------------------------------- */

function renderBeginnerQuiz() {
  const host = quizHost("beginner");
  if (!host) return;

  host.innerHTML = html`
    <p class="quiz-q">第 1 题：一项资产从 100 元跌到 70 元，回撤是多少？</p>
    <div class="row">
      <div style="flex:1 1 10rem">
        <mdui-text-field id="b-q1" label="你的答案" type="number" suffix="%" placeholder="填数字即可" variant="outlined"></mdui-text-field>
      </div>
      <mdui-button variant="filled" id="b-check1">确认</mdui-button>
    </div>
    <div class="quiz-feedback" id="b-fb1" hidden></div>
    <div id="b-step2" class="hidden" style="margin-top:1.1rem">
      <p class="quiz-q">第 2 题：从 70 元涨回 100 元，需要上涨多少？</p>
      <div class="row">
        <div style="flex:1 1 10rem">
          <mdui-text-field id="b-q2" label="你的答案" type="number" suffix="%" placeholder="填数字即可" variant="outlined"></mdui-text-field>
        </div>
        <mdui-button variant="filled" id="b-check2">确认</mdui-button>
      </div>
      <div class="quiz-feedback" id="b-fb2" hidden></div>
    </div>
    <div id="b-step3" class="hidden" style="margin-top:1.1rem"></div>`;

  const fb1 = host.querySelector("#b-fb1");
  const fb2 = host.querySelector("#b-fb2");
  const step2 = host.querySelector("#b-step2");
  const step3 = host.querySelector("#b-step3");

  const check1 = () => {
    const value = Number(host.querySelector("#b-q1").value);
    if (!Number.isFinite(value) || host.querySelector("#b-q1").value === "") {
      feedback(fb1, "hint", "先填一个数字。回撤 =（高点 − 低点）÷ 高点。");
      return;
    }
    if (Math.abs(value - 30) < 1) {
      feedback(fb1, "ok", "<strong>正确。</strong>(100 − 70) ÷ 100 = 30%。下面第二题才是关键。");
      step2.classList.remove("hidden");
    } else {
      feedback(
        fb1,
        "hint",
        `不是 ${value}%。回撤的分母是<strong>高点</strong>：(100 − 70) ÷ 100 = 30%。再算一次。`
      );
    }
  };

  const check2 = () => {
    const value = Number(host.querySelector("#b-q2").value);
    const field = host.querySelector("#b-q2");
    if (!Number.isFinite(value) || field.value === "") {
      feedback(fb2, "hint", "先填一个数字。回本涨幅 =（高点 − 低点）÷ 低点。");
      return;
    }
    if (Math.abs(value - 42.86) < 1.5) {
      feedback(fb2, "ok", "<strong>正确。</strong>(100 − 70) ÷ 70 ≈ 42.86%。");
      step3.classList.remove("hidden");
      step3.innerHTML = `
        <div class="quiz-feedback ok" style="display:block">
          <strong>这两题的差别，就是整个风险管理的起点。</strong><br /><br />
          跌 30% 需要涨 42.86% 才能回本，两者 <em>不相等</em>。而且随着跌幅变大，这个缺口会指数级拉大：
          跌 50% 要涨 100%，跌 80% 要涨 400%。<br /><br />
          所以，「控制下行风险」不是保守，而是算术要求。
          去 <a href="calculator.html">投资计算器</a> 的「回撤与回本」里把这个对照表看一遍。
        </div>`;
    } else {
      feedback(
        fb2,
        "hint",
        `注意分母变了：涨回去是相对于<strong>低点</strong>而言的。(100 − 70) ÷ 70 ≈ 42.86%。`
      );
    }
  };

  host.querySelector("#b-check1").addEventListener("click", check1);
  host.querySelector("#b-check2").addEventListener("click", check2);
  host.querySelector("#b-q1").addEventListener("keydown", (e) => {
    if (e.key === "Enter") check1();
  });
  host.querySelector("#b-q2").addEventListener("keydown", (e) => {
    if (e.key === "Enter") check2();
  });
}

/* ------------------------------ 进阶测验 -------------------------------- */

const INTERMEDIATE_EXPLAIN = {
  a: `选择 PE=50 那家：你可能更看重高增长潜力。高 PE 反映市场对未来利润的高预期——
      如果利润真能兑现，贵一点也值得；但如果增长不及预期，估值会同时被「盈利下调」和「估值下杀」两头打击，
      这叫戴维斯双杀。`,
  b: `选择 PE=15 那家：你更看重当下的盈利能力。低 PE + 高 ROE 通常意味着「用便宜的价格买到好生意」，
      但也可能意味着市场认为它的成长空间有限，甚至利润不可持续。便宜常有便宜的原因。`,
  c: `选择「看情况」——这是最接近投资现实的一步。PE 是结果，不是原因：
      要判断的是「这家公司未来能不能维持甚至提高 ROE」，以及「市场给的溢价是否过度」。
      只看两个数字无法回答，还需要增长率、行业格局、资本开支与负债。`,
};

function renderIntermediateQuiz() {
  const host = quizHost("intermediate");
  if (!host) return;

  host.innerHTML = html`
    <p class="quiz-q">
      A 公司：PE = 50，ROE = 10%。<br />
      B 公司：PE = 15，ROE = 15%。<br />
      哪一家的估值更合理？
    </p>
    <div class="quiz-opts">
      <mdui-button variant="tonal" data-answer="a">A. PE = 50 的 A 公司</mdui-button>
      <mdui-button variant="tonal" data-answer="b">B. PE = 15 的 B 公司</mdui-button>
      <mdui-button variant="tonal" data-answer="c">C. 仅凭这两个数字判断不了</mdui-button>
    </div>
    <div class="quiz-feedback" id="i-fb" hidden></div>`;

  const fb = host.querySelector("#i-fb");
  host.querySelectorAll("[data-answer]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const answer = btn.dataset.answer;
      const type = answer === "c" ? "ok" : "hint";
      feedback(fb, type, INTERMEDIATE_EXPLAIN[answer]);
    });
  });
}

/* ------------------------------ 高级测验 -------------------------------- */

const ADVANCED_EXPLAIN = {
  yes: `如果你选了「是」，那你可能把夏普比率当成了一个绝对标准。它确实很有用，但至少有三个问题：
        收益分布不是正态的、它把上涨波动也算成风险、以及它对样本区间极度敏感。`,
  no: `「不一定」——这个方向是对的。夏普高只说明「这段历史里，每单位波动换来的超额收益多」。
       它没有告诉你：尾部风险有多大、回撤能不能承受、这个收益是不是靠某一段行情堆出来的。`,
  depends: `「看情况」是更完整的答案：夏普比率是过滤器，不是决策器。
       真正要问的是三件事——这个收益来自什么逻辑、这个逻辑还在不在、以及最坏的情况下我能不能拿住。`,
};

function renderAdvancedQuiz() {
  const host = quizHost("advanced");
  if (!host) return;

  host.innerHTML = html`
    <p class="quiz-q">一项资产的夏普比率是 2.5（远高于同类），说明它一定是好投资吗？</p>
    <div class="quiz-opts">
      <mdui-button variant="tonal" data-answer="yes">是，数字不会骗人</mdui-button>
      <mdui-button variant="tonal" data-answer="no">不一定</mdui-button>
      <mdui-button variant="tonal" data-answer="depends">看情况，要看更多东西</mdui-button>
    </div>
    <div class="quiz-feedback" id="a-fb" hidden></div>`;

  const fb = host.querySelector("#a-fb");
  host.querySelectorAll("[data-answer]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const answer = btn.dataset.answer;
      feedback(fb, answer === "yes" ? "hint" : "ok", ADVANCED_EXPLAIN[answer]);
    });
  });
}

/* ---------------------------- 决策训练（案例） --------------------------- */

const CASE_EXPLAIN = {
  a: `<strong>A. 作为核心配置</strong><br /><br />
      你看重的是 12.5% 的年化收益和 0.45 的中等相关性，愿意用 38% 的回撤换取这份收益。
      注意一个前提：核心配置意味着它要占组合的大头，那么「38% 的回撤」会直接变成「整个组合的回撤」。
      如果你的投资期限足够长、且能承受账户缩水近四成，这个选择是理性的；如果不是，它就是风险错配。`,
  b: `<strong>B. 少量加入，控制比例</strong><br /><br />
      这是最常见的专业做法：认可收益潜力，用仓位而不是「用信心」来控制风险。
      10% 的仓位遇到 38% 回撤，对组合的冲击约 3.8%，完全在可承受范围；
      如果它表现好，你也不会完全错过。仓位是你唯一能精确控制的变量。`,
  c: `<strong>C. 不加入</strong><br /><br />
      38% 的回撤意味着你有可能在账户上看到接近四成的浮亏。
      如果你无法承受这种心理压力、或者资金在三年内要用，那么不加入是完全合理的选择。
      「不亏钱」本身就是一种收益，尤其当你的风险承受力不允许时。`,
  d: `<strong>D. 再观察一段时间</strong><br /><br />
      等待更多数据、观察估值变化、等一个更清楚的环境。
      但要注意「再观察」的两个陷阱：一是它可能变成永远的拖延；二是市场不会等你观察完。
      更好的做法是把「观察什么」写下来（例如：PE 回到多少、季度利润增速如何），设定触发条件。`,
};

function renderCase() {
  const options = document.getElementById("case-options");
  const fb = document.getElementById("case-feedback");
  if (!options || !fb) return;

  options.querySelectorAll("[data-choice]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const choice = btn.dataset.choice;
      options.querySelectorAll("[data-choice]").forEach((b) => {
        b.setAttribute("variant", b === btn ? "filled" : "tonal");
      });
      feedback(fb, "hint", CASE_EXPLAIN[choice]);
      toast("每个选择都对应一种风险偏好，没有唯一正确答案。");
    });
  });
}

/* --------------------------------- 启动 --------------------------------- */

/** 级别切换：只切换自定义面板，不依赖 mdui-tab-panel 的布局 */
function bindLevelTabs() {
  const tabs = document.getElementById("learn-tabs");
  const panels = [...document.querySelectorAll(".level-panel")];
  if (!tabs || !panels.length) return;

  const show = (value) => {
    panels.forEach((panel) => {
      panel.classList.toggle("hidden", panel.dataset.level !== value);
    });
    // 支持 learn.html#case 这样的深链直接落到决策训练
    if (value === "case") {
      history.replaceState(null, "", "#case");
    } else if (location.hash === "#case") {
      history.replaceState(null, "", location.pathname);
    }
  };

  tabs.addEventListener("change", () => show(tabs.value));
  if (location.hash === "#case") tabs.value = "case";
  show(tabs.value || "beginner");
}

function main() {
  initShell({ active: "learn" });
  renderBeginnerQuiz();
  renderIntermediateQuiz();
  renderAdvancedQuiz();
  renderCase();
  bindLevelTabs();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}