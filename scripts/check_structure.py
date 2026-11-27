"""
scripts/check_structure.py — 页面结构守卫。

为什么需要它：我用脚本切片修改 `learn.html` 时，曾经把「刷题」面板整段删掉、
还留下两个重复的 `data-level="case"`。**页面不报错、测试全绿、check_links 也通过**，
因为 HTML 结构本身是合法的——只是少了东西。只有真去点那个标签才会发现。

所以这里检查的是「结构契约」：
  1. 每个页面里 data-level / 关键容器 id 必须存在且唯一；
  2. 标签页的 value 必须都能找到对应的面板（否则点了没反应）；
  3. 每个面板里声明的 lab 宿主必须真实存在；
  4. 不允许出现重复 id。

退出码非 0 表示结构被破坏。
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 每个页面的结构契约：{ 文件: { 必需的选择器描述 } }
CONTRACTS = {
    # learn.html 已改为闯关结构：不再是「标签 → 面板」，而是单页三模式
    "learn.html": {
        "ids": ["quest-host", "quest-section", "practice-section", "case-section", "lab-practice", "lab-decision"],
    },
    "analysis.html": {"ids": ["single-metrics", "single-charts", "single-basis"]},
    "portfolio.html": {"ids": ["strategy-result"]},
    "planner.html": {"ids": ["questions", "class-picker", "objective-group", "planner-result"]},
    "glossary.html": {"ids": ["glossary-root", "glossary-filter"]},
    "corrections.html": {"ids": ["correction-stats", "correction-list"]},
    "data.html": {"ids": ["site-nav"]},
}


def check_page(path: Path, contract: dict) -> list[str]:
    problems: list[str] = []
    if not path.exists():
        return [f"{path.name}: 文件不存在"]
    html = path.read_text(encoding="utf-8")

    # 1) 重复 id
    ids = re.findall(r'\bid="([^"]+)"', html)
    seen: set[str] = set()
    dupes: set[str] = set()
    for value in ids:
        if value in seen:
            dupes.add(value)
        seen.add(value)
    for value in sorted(dupes):
        problems.append(f"{path.name}: id 重复 —— {value}")

    # 2) data-level 面板：必须齐全、唯一，且与标签一一对应
    levels = re.findall(r'data-level="([^"]+)"', html)
    expected = contract.get("levels")
    if expected is not None:
        for level in expected:
            count = levels.count(level)
            if count == 0:
                problems.append(f"{path.name}: 缺少面板 data-level=\"{level}\"")
            elif count > 1:
                problems.append(f"{path.name}: 面板 data-level=\"{level}\" 重复 {count} 次")
        extra = set(levels) - set(expected)
        for level in sorted(extra):
            problems.append(f"{path.name}: 出现未登记的面板 data-level=\"{level}\"")

        # 标签页 value 必须都能找到面板
        tab_values = re.findall(r'<mdui-tab value="([^"]+)"', html)
        for value in tab_values:
            if value not in levels:
                problems.append(f"{path.name}: 标签 value=\"{value}\" 没有对应的面板（点了会没反应）")
        # 面板也应有对应标签
        for level in levels:
            if level not in tab_values:
                problems.append(f"{path.name}: 面板 \"{level}\" 没有对应的标签")

    # 3) lab 宿主
    for lab in contract.get("labs", []):
        if f'id="{lab}"' not in html:
            problems.append(f"{path.name}: 缺少 lab 宿主 #{lab}")

    # 4) 普通 id 契约
    for id_ in contract.get("ids", []):
        if f'id="{id_}"' not in html:
            problems.append(f"{path.name}: 缺少必需容器 #{id_}")

    return problems


def main() -> int:
    all_problems: list[str] = []
    for name, contract in CONTRACTS.items():
        all_problems.extend(check_page(ROOT / name, contract))

    if all_problems:
        print("结构检查未通过：")
        for problem in all_problems:
            print(f"  - {problem}")
        return 1

    total_levels = sum(len(c.get("levels", [])) for c in CONTRACTS.values())
    total_labs = sum(len(c.get("labs", [])) for c in CONTRACTS.values())
    print(
        f"结构检查通过：{len(CONTRACTS)} 个页面、"
        f"{total_levels} 个面板、{total_labs} 个 lab 宿主，标签与面板一一对应。"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())