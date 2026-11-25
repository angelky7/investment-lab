"""scripts/check_links.py — 静态资源与 ES 模块导入检查。

CI 里跑它，能在部署前发现三类最常见的「页面白屏」原因：

1. HTML 里引用了不存在的 css / js / 图片；
2. JS 里 import 的模块路径写错（大小写、扩展名、目录）；
3. import 了目标模块并不导出的名字（例如漏写 export 或改名后忘了同步）。

这是个启发式检查器，不做完整的 AST 解析，但足以覆盖本站这种纯静态项目。
"""

from __future__ import annotations

import os
import re
import sys

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HTML_FILES = [
    "index.html",
    "learn.html",
    "analysis.html",
    "portfolio.html",
    "history.html",
    "calculator.html",
    "planner.html",
    "data.html",
]

# HTML 中的本地引用
ATTR_RE = re.compile(r'(?:href|src)\s*=\s*"([^"]+)"')
# import { a, b as c } from "./x.js" / import "./x.js" / import * as ns from "..."
IMPORT_RE = re.compile(
    r"""import\s+(?:[^'"]*?\s+from\s+)?["']([^"']+)["']""", re.S
)
NAMED_IMPORT_RE = re.compile(r"import\s*\{([^}]*)\}\s*from\s*[\"']([^\"']+)[\"']", re.S)

EXPORT_PATTERNS = [
    re.compile(r"export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)"),
    re.compile(r"export\s+class\s+([A-Za-z0-9_$]+)"),
    re.compile(r"export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)"),
    re.compile(r"export\s*\{([^}]*)\}"),
]


def exported_names(path: str) -> set[str] | None:
    """返回模块导出的名字集合；如果存在 export * 则返回 None 表示「无法静态判断」。"""
    try:
        source = open(path, encoding="utf-8").read()
    except OSError:
        return None
    if re.search(r"export\s+\*", source):
        return None

    names: set[str] = set()
    for pattern in EXPORT_PATTERNS[:-1]:
        for match in pattern.finditer(source):
            names.add(match.group(1))
    # export { a, b as c }
    block = EXPORT_PATTERNS[-1].search(source)
    if block:
        for item in block.group(1).split(","):
            item = item.strip()
            if not item:
                continue
            if " as " in item:
                names.add(item.split(" as ")[-1].strip())
            else:
                names.add(item)
    if "export default" in source:
        names.add("default")
    return names


def check_html(errors: list[str]) -> None:
    for page in HTML_FILES:
        path = os.path.join(PROJECT_ROOT, page)
        if not os.path.exists(path):
            errors.append(f"缺少页面文件: {page}")
            continue
        source = open(path, encoding="utf-8").read()
        for ref in ATTR_RE.findall(source):
            if ref.startswith(("http://", "https://", "data:", "#", "mailto:")):
                continue
            target = ref.split("#")[0].split("?")[0]
            if not target:
                continue
            resolved = os.path.normpath(os.path.join(PROJECT_ROOT, target))
            if not os.path.exists(resolved):
                errors.append(f"{page}: 引用不存在的资源 {ref}")


def check_modules(errors: list[str]) -> None:
    js_root = os.path.join(PROJECT_ROOT, "js")
    for dirpath, _dirnames, filenames in os.walk(js_root):
        for filename in filenames:
            if not filename.endswith(".js"):
                continue
            path = os.path.join(dirpath, filename)
            rel = os.path.relpath(path, PROJECT_ROOT)
            source = open(path, encoding="utf-8").read()

            for spec in IMPORT_RE.findall(source):
                if not spec.startswith("."):
                    continue  # 裸模块说明符（本站不使用）
                target = os.path.normpath(os.path.join(dirpath, spec))
                if not os.path.exists(target):
                    errors.append(f"{rel}: import 路径不存在 {spec}")
                    continue

                names = exported_names(target)
                if names is None:
                    continue

                for match in NAMED_IMPORT_RE.finditer(source):
                    if os.path.normpath(os.path.join(dirpath, match.group(2))) != target:
                        continue
                    for raw in match.group(1).split(","):
                        raw = raw.strip()
                        if not raw or raw.startswith("type "):
                            continue
                        imported = raw.split(" as ")[0].strip()
                        if imported and imported not in names:
                            errors.append(
                                f"{rel}: 从 {spec} 导入了不存在的名字 `{imported}`"
                            )


def check_nav(errors: list[str]) -> None:
    """导航里的每个入口都必须是真实存在的页面。"""
    shell = os.path.join(PROJECT_ROOT, "js", "core", "shell.js")
    if not os.path.exists(shell):
        return
    source = open(shell, encoding="utf-8").read()
    for href in re.findall(r'href:\s*"([^"]+)"', source):
        if href.startswith(("http", "#")):
            continue
        if not os.path.exists(os.path.join(PROJECT_ROOT, href)):
            errors.append(f"导航入口指向不存在的页面: {href}")


def main() -> int:
    errors: list[str] = []
    check_html(errors)
    check_modules(errors)
    check_nav(errors)

    if errors:
        print(f"发现 {len(errors)} 个问题：")
        for err in errors:
            print(f"  - {err}")
        return 1

    print(
        f"静态检查通过：{len(HTML_FILES)} 个页面、js/ 下全部模块的引用与导入均可解析。"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())