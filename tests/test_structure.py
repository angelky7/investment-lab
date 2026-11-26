"""tests/test_structure.py — 结构守卫自身的单元测试。

`scripts/check_structure.py` 是给「HTML 被脚本切坏」兜底的，
如果它自己写错了，那就等于没有守卫——所以它也需要被测。
"""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scripts.check_structure import check_page  # noqa: E402


class TestStructureGuard(unittest.TestCase):
    def _write(self, html: str) -> Path:
        tmp = Path(tempfile.mkdtemp()) / "page.html"
        tmp.write_text(html, encoding="utf-8")
        return tmp

    def test_good_page_passes(self):
        html = """
        <mdui-tab value="a">A</mdui-tab>
        <mdui-tab value="b">B</mdui-tab>
        <div class="level-panel" data-level="a"><div id="lab-one"></div></div>
        <div class="level-panel" data-level="b"><div id="lab-two"></div></div>
        """
        problems = check_page(self._write(html), {"levels": ["a", "b"], "labs": ["lab-one", "lab-two"]})
        self.assertEqual(problems, [])

    def test_missing_panel_detected(self):
        """这次的 bug：标签还在，面板被删了。"""
        html = """
        <mdui-tab value="a">A</mdui-tab>
        <mdui-tab value="b">B</mdui-tab>
        <div class="level-panel" data-level="a"></div>
        """
        problems = check_page(self._write(html), {"levels": ["a", "b"]})
        self.assertTrue(any('缺少面板 data-level="b"' in p for p in problems), problems)
        self.assertTrue(any("没有对应的面板" in p for p in problems), problems)

    def test_duplicate_panel_detected(self):
        html = """
        <mdui-tab value="a">A</mdui-tab>
        <div class="level-panel" data-level="a"></div>
        <div class="level-panel" data-level="a"></div>
        """
        problems = check_page(self._write(html), {"levels": ["a"]})
        self.assertTrue(any("重复 2 次" in p for p in problems), problems)

    def test_missing_lab_host_detected(self):
        html = """
        <mdui-tab value="a">A</mdui-tab>
        <div class="level-panel" data-level="a"></div>
        """
        problems = check_page(self._write(html), {"levels": ["a"], "labs": ["lab-missing"]})
        self.assertTrue(any("lab-missing" in p for p in problems), problems)

    def test_duplicate_id_detected(self):
        html = """
        <mdui-tab value="a">A</mdui-tab>
        <div class="level-panel" data-level="a"><div id="dup"></div><div id="dup"></div></div>
        """
        problems = check_page(self._write(html), {"levels": ["a"]})
        self.assertTrue(any("id 重复" in p and "dup" in p for p in problems), problems)

    def test_unregistered_level_detected(self):
        html = """
        <mdui-tab value="a">A</mdui-tab>
        <mdui-tab value="z">Z</mdui-tab>
        <div class="level-panel" data-level="a"></div>
        <div class="level-panel" data-level="z"></div>
        """
        problems = check_page(self._write(html), {"levels": ["a"]})
        self.assertTrue(any('未登记的面板 data-level="z"' in p for p in problems), problems)

    def test_missing_required_id(self):
        html = '<mdui-tab value="a">A</mdui-tab><div data-level="a"></div>'
        problems = check_page(self._write(html), {"levels": ["a"], "ids": ["needed"]})
        self.assertTrue(any("#needed" in p for p in problems), problems)

    def test_missing_file_reported(self):
        problems = check_page(Path("/nonexistent/page.html"), {"levels": ["a"]})
        self.assertTrue(any("文件不存在" in p for p in problems), problems)


class TestRealPages(unittest.TestCase):
    """真实页面必须满足契约——这是 CI 里跑的那一步。"""

    def test_real_pages_pass(self):
        from scripts.check_structure import CONTRACTS, ROOT

        for name, contract in CONTRACTS.items():
            problems = check_page(ROOT / name, contract)
            self.assertEqual(problems, [], f"{name} 结构检查未通过：{problems}")


if __name__ == "__main__":
    unittest.main()