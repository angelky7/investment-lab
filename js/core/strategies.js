/**
 * js/core/strategies.js — 预设组合策略。
 *
 * 这里只描述「配比 + 再平衡规则」，不含任何计算；计算在 portfolio.js 里。
 * 所有档位都用**可投资的 ETF**，而不是指数点位——ETF 的序列含分红/票息再投资，
 * 和指数点位混用会把股票档的收益算低约每年 2 个百分点。
 *
 * 关于哈利·布朗永久组合（Harry Browne, 1987 *The Permanent Portfolio*）：
 * 他的出发点不是「预测哪类资产会涨」，而是承认「不知道未来是繁荣、通胀、紧缩还是衰退」，
 * 所以四等分覆盖四种经济状态：
 *   繁荣 → 股票；通胀 → 黄金；紧缩/衰退 → 长期国债；其余 → 现金。
 * 再平衡规则也不是定投式的「每年调一次」，而是**阈值带**：
 * 任一档跌破 15% 或涨过 35% 就调回 25%。
 */

export const STRATEGIES = [
  {
    id: "permanent",
    name: "永久组合（哈利·布朗）",
    tagline: "四等分：股票 / 国债 / 黄金 / 现金，各 25%",
    description:
      "用四类资产分别对应繁荣、紧缩、通胀、衰退四种经济状态，放弃预测、靠结构活着。" +
      "任一档跌到 15% 以下或涨到 35% 以上时调回 25%，其余时间不动。",
    sleeves: [
      { key: "etf:510300", label: "沪深300ETF", weight: 25, role: "股票：繁荣期" },
      { key: "etf:511010", label: "国债ETF", weight: 25, role: "债券：紧缩/衰退期" },
      { key: "etf:518880", label: "黄金ETF", weight: 25, role: "黄金：通胀期（短期同样会大跌）" },
      { key: "etf:511880", label: "货币ETF", weight: 25, role: "现金：其余时间与弹药" },
    ],
    rule: { type: "band", lower: 0.15, upper: 0.35 },
    notes: [
      "四档都用后复权 ETF 序列，分红与票息已经再投资，口径一致。",
      "永久组合的目标是「任何一年都不要伤筋动骨」，不是收益最大化；它的长期收益通常低于纯股票。",
      "黄金档用人民币计价的 518880；若换成美元计价的 GLD，还要叠加汇率变化。",
      "别把黄金当「股票跌它就涨」的工具：低相关只是不同步。实测近一年黄金跌得比标普500 更多，" +
        "组合分析页的「数据检验」卡片会把当前数字算给你看。",
    ],
  },
  {
    id: "classic6040",
    name: "60/40 经典股债",
    tagline: "股票 60% / 国债 40%，每年再平衡",
    description:
      "最传统的机构配置：靠股票的长期收益，靠债券压住波动。" +
      "每年调回 60/40，是它唯一的纪律。",
    sleeves: [
      { key: "etf:510300", label: "沪深300ETF", weight: 60, role: "收益来源" },
      { key: "etf:511010", label: "国债ETF", weight: 40, role: "波动缓冲" },
    ],
    rule: { type: "annual" },
    notes: [
      "股债同跌的年份（如 2022 全球加息）它也会亏，这不是「保本组合」。",
    ],
  },
  {
    id: "allstock",
    name: "对照组：100% 股票",
    tagline: "沪深300ETF 满仓，不调仓",
    description: "用来回答「折腾这些配置，到底换来了什么」。",
    sleeves: [{ key: "etf:510300", label: "沪深300ETF", weight: 100, role: "全部仓位" }],
    rule: { type: "none" },
    notes: ["它是标尺，不是推荐。"],
  },
];

export function findStrategy(id) {
  return STRATEGIES.find((s) => s.id === id) || STRATEGIES[0];
}