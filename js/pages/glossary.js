/**
 * js/pages/glossary.js — 术语词典。
 *
 * 每个术语三件事：一句话定义 / 本站哪里能看到 / 最常见误解。
 * 「最常被误解」那一行是这个页面的价值所在——
 * 定义网上到处都是，但「你以为你懂了，其实反了」的地方没人写。
 */

import { initShell } from "../core/shell.js";

export const TERMS = [
  {
    group: "资产",
    id: "stock",
    term: "股票",
    def: "公司的所有权凭证，回报来自盈利增长与分红。",
    where: "资产分析里选任意个股，看「年度收益」表最直观。",
    myth: "股票长期一定赚——取决于买入价格与持有年限，2007 年高点买入沪深300 需要 8 年才回本。",
  },
  {
    group: "资产",
    id: "etf",
    term: "ETF",
    def: "交易所上市的指数基金，像股票一样买卖，费率通常低于主动基金。",
    where: "组合分析全部用 ETF 或指数做示范。",
    myth: "ETF 一定便宜——杠杆、跨境、行业主题 ETF 的费率能到 1% 以上。",
  },
  {
    group: "资产",
    id: "index",
    term: "指数",
    def: "用固定规则把一篮子资产加权成一个数字，代表某个市场。",
    where: "宽基指数分组里有沪深300、中证500、中证1000 等。",
    myth: "指数不能买——通过 ETF 就能买，代价是费率与跟踪误差。",
  },
  {
    group: "资产",
    id: "total-return",
    term: "全收益 vs 价格指数",
    def: "全收益把分红再投资算进去；价格指数只看报价。",
    where: "沪深300全收益（H00300）与沪深300（000300）可以并排对比。",
    myth: "两者差不多——20 年下来，分红再投资能让年化相差约 2 个百分点。",
  },
  {
    group: "资产",
    id: "bond",
    term: "债券",
    def: "把钱借出去并约定还本付息的凭证，波动通常远小于股票。",
    where: "上证国债指数（000012）自 2003 年起。",
    myth: "债券不会亏——利率上行时债券价格会跌，长久期债券跌得比想象中多。",
  },
  {
    group: "资产",
    id: "gold",
    term: "黄金",
    def: "不产生现金流的实物资产，长期对冲货币贬值与极端通胀。",
    where: "组合分析→相关性页签有一张「黄金真的是避险资产吗」的实时检验。",
    myth: "股票跌它就涨——实测近一年黄金 −16.6%、标普500 +7.4%，黄金跌得更多。",
  },
  {
    group: "风险",
    id: "volatility",
    term: "波动率",
    def: "日收益标准差年化，衡量价格上下起伏的幅度。",
    where: "资产分析的「年化波动」指标。",
    myth: "波动率低就是安全——低波动可能只是流动性差、报价不连续。",
  },
  {
    group: "风险",
    id: "drawdown",
    term: "回撤 / 最大回撤",
    def: "从历史高点的跌幅；最大回撤是整个过程里最深的那一次。",
    where: "资产分析的「回撤曲线」，组合分析里的回撤对比图。",
    myth: "回撤会很快修复——沪深300 在 2007 年之后的回撤用了 8 年才收复。",
  },
  {
    group: "风险",
    id: "sharpe",
    term: "夏普比率",
    def: "（年化收益 − 无风险利率）÷ 年化波动，每单位波动换来的超额收益。",
    where: "资产分析与策略组合里都直接给出。",
    myth: "夏普越高越好——它把上涨的波动也算作风险，会低估高成长资产。",
  },
  {
    group: "风险",
    id: "sortino",
    term: "索提诺比率",
    def: "和夏普类似，但分母只统计下跌波动。",
    where: "资产分析指标区。",
    myth: "和夏普一样用——两者对「上涨算不算风险」的立场不同。",
  },
  {
    group: "风险",
    id: "calmar",
    term: "卡玛比率",
    def: "年化收益 ÷ 最大回撤，衡量「为了这点收益，你最多要忍受多深的坑」。",
    where: "资产分析指标区。",
    myth: "回撤小就一定好——只做现金的组合卡玛很高，但没有收益。",
  },
  {
    group: "风险",
    id: "beta",
    term: "Beta / Alpha",
    def: "Beta 是对基准的敏感度，Alpha 是扣掉这份敏感度之后的超额收益。",
    where: "资产分析的 Beta/Alpha，说明里会标「哪年起可比」。",
    myth: "Alpha 为正就是能力——样本短、基准选得不对，都能造出假 Alpha。",
  },
  {
    group: "组合",
    id: "correlation",
    term: "相关性",
    def: "两个资产日收益的同向程度，−1 到 +1。",
    where: "组合分析→相关性的矩阵与热力图。",
    myth: "低相关等于反向——低相关只是不同步；黄金与沪深300 相关性 0.07，但它自己也会大跌。",
  },
  {
    group: "组合",
    id: "diversify",
    term: "分散",
    def: "用涨跌原因不同的资产，降低单一资产出事的后果。",
    where: "课程「分散实验室」可以拖动权重看波动如何低于加权平均。",
    myth: "买五只科技 ETF 就叫分散——它们几乎是同一个风险。",
  },
  {
    group: "组合",
    id: "rebalance",
    term: "再平衡",
    def: "把漂走的权重调回目标，本质是机械地卖强买弱。",
    where: "组合分析→再平衡页签有净值对比、回撤对比与权重漂移三张图。",
    myth: "再平衡能提高收益——它主要降回撤；单边牛市里它一定跑输「买入后不动」。",
  },
  {
    group: "组合",
    id: "band",
    term: "阈值带再平衡",
    def: "只有权重偏离到一定范围（如 15%–35%）才动手，而不是按日历调。",
    where: "策略组合里的永久组合用的就是这套规则。",
    myth: "每年调一次最科学——频率不是重点，规则是否被真正执行才是。",
  },
  {
    group: "组合",
    id: "permanent",
    term: "永久组合",
    def: "股票 / 国债 / 黄金 / 现金 各 25%，对应四种经济状态，不预测只应对。",
    where: "课程「策略」级 + 组合分析→策略组合。",
    myth: "四个 25% 是收益最优——它年化低于满仓股票，换来的是回撤浅 45 个百分点。",
  },
  {
    group: "组合",
    id: "risk-parity",
    term: "风险平价",
    def: "按风险贡献而不是资金量分配权重，通常需要杠杆把收益拉回来。",
    where: "课程「策略」级有与其他配置的取舍对比。",
    myth: "风险平价等于全天候——前者是方法，后者是一个具体组合。",
  },
  {
    group: "指标",
    id: "annualized",
    term: "年化收益",
    def: "把累计收益折算成「每年复合多少」，用自然日计算。",
    where: "每个资产的指标区与年度收益表。",
    myth: "年化 10% 等于每年都涨 10%——它只是一个平滑后的等效值，实际每年差别巨大。",
  },
  {
    group: "指标",
    id: "xirr",
    term: "XIRR（资金加权收益）",
    def: "考虑每笔现金流发生时间的收益率，定投的真实成绩。",
    where: "组合分析→定投页签。",
    myth: "定投收益等于标的涨幅——买在高位的那几笔会显著拉低 XIRR。",
  },
  {
    group: "指标",
    id: "rolling",
    term: "滚动一年收益",
    def: "以每个交易日为起点、往后看一年的收益，用来衡量「什么时候买」的影响。",
    where: "资产分析的滚动收益图。",
    myth: "长期年化好看就随时能买——滚动收益的分布告诉你运气占多大比重。",
  },
  {
    group: "指标",
    id: "fee",
    term: "费率与摩擦",
    def: "管理费、托管费、申赎费与调仓成本，直接扣减到手收益。",
    where: "策略组合里给出了「扣掉 0.6%/年之后」的年化与终值对照。",
    myth: "0.5% 可以忽略——20 年下来它会吃掉 10% 以上的终值。",
  },
  {
    group: "指标",
    id: "tracking",
    term: "跟踪误差",
    def: "ETF 收益与所跟踪指数收益之间的偏差。",
    where: "数据状态页可以看到每个资产的起点与口径。",
    myth: "跟踪误差可以忽略——跨境 ETF 还有溢价与额度限制，实际偏差远大于费率。",
  },
  {
    group: "行为",
    id: "loss-aversion",
    term: "损失厌恶",
    def: "同样金额的亏损带来的痛苦，约为收益带来快乐的 2 倍。",
    where: "课程「2008 体验馆」里，多数人第一反应是「先卖掉」。",
    myth: "知道就好办了——知道不等于能忍住，所以要用「不需要做决定」的配置。",
  },
  {
    group: "行为",
    id: "recency",
    term: "近因偏差",
    def: "把最近几年的体验当成长期规律。",
    where: "红利低波在 7 年窗口里波动 16.8%、20 年窗口里 24.6%——同一策略，两种性格。",
    myth: "最近涨得好就是好资产——长历史往往给出相反的排序。",
  },
  {
    group: "行为",
    id: "disposition",
    term: "处置效应",
    def: "赚一点就跑、亏了死扛，导致「卖出赢家、留住输家」。",
    where: "再平衡的阈值带本质上是在对抗它。",
    myth: "这是纪律问题——它更多是情绪问题，靠规则而不是意志解决。",
  },
  {
    group: "数据",
    id: "hfq",
    term: "后复权",
    def: "把分红再投资计入价格，保证历史收益可比。",
    where: "为什么用后复权：README 与数据状态页都有说明。",
    myth: "前复权更好看就用它——前复权会让早期价格为负（高分红股），收益率会算错。",
  },
  {
    group: "数据",
    id: "gap",
    term: "数据缺口 / 空洞",
    def: "该有数据的交易日没有数据，分「真停牌」与「源端空洞」两类。",
    where: "数据状态页逐条列出，并标注成因。",
    myth: "补齐都一样——停牌是市场事实，补上是造假；源端空洞补上必须做连续性校验。",
  },
  {
    group: "数据",
    id: "calendar",
    term: "交易日历",
    def: "判断「哪天该有数据」的基准，各市场不同。",
    where: "数据状态页显示三大市场的日历覆盖。",
    myth: "节假日缺失是数据问题——那是日历本身要剔除的日期。",
  },
];

function render(list) {
  const root = document.getElementById("glossary-root");
  const groups = [];
  for (const item of list) {
    if (!groups.includes(item.group)) groups.push(item.group);
  }

  root.innerHTML = groups
    .map(
      (group) => `
      <div class="glossary-group">
        <h2 class="section-title">${group}</h2>
        <div class="course-grid">
          ${list
            .filter((item) => item.group === group)
            .map(
              (item) => `
            <div class="lesson glossary-item" id="term-${item.id}" data-key="${(
                item.term + item.def + item.myth
              ).toLowerCase()}">
              <h3><a href="#term-${item.id}">${item.term}</a></h3>
              <p>${item.def}</p>
              <p class="glossary-where"><strong>本站实例：</strong>${item.where}</p>
              <p class="glossary-myth"><strong>常见误解：</strong>${item.myth}</p>
            </div>`
            )
            .join("")}
        </div>
      </div>`
    )
    .join("");

  document.getElementById("glossary-count").textContent = `共 ${list.length} 条术语`;
}

function main() {
  initShell({ active: "glossary" });
  render(TERMS);

  const field = document.getElementById("glossary-filter");
  if (field) {
    const apply = () => {
      const query = (field.value || "").trim().toLowerCase();
      const filtered = query
        ? TERMS.filter((item) => (item.term + item.def + item.myth + item.where).toLowerCase().includes(query))
        : TERMS;
      render(filtered);
      const count = document.getElementById("glossary-count");
      if (count && query) count.textContent = `匹配 ${filtered.length} 条`;
    };
    field.addEventListener("input", apply);
  }

  // 深链接：#term-xxx 时滚动过去并高亮
  if (location.hash.startsWith("#term-")) {
    const el = document.querySelector(location.hash);
    if (el) {
      el.scrollIntoView({ block: "center" });
      el.classList.add("on");
    }
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}