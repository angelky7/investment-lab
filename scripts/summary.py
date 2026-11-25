"""scripts/summary.py — 把数据状态输出成 GitHub Actions 的步骤摘要（Markdown）。

单独成脚本而不是写在 workflow 的 shell heredoc 里，是因为 YAML 块标量
不允许出现「列 0 缩进」的行，heredoc 很容易把整个 workflow 文件写坏。
"""

from __future__ import annotations

import json
import os
import sys

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load(rel: str) -> dict:
    path = os.path.join(PROJECT_ROOT, rel)
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        # 摘要面向 Markdown，读不到文件时写到 stderr，避免污染步骤摘要
        print(f"[summary] 读取 {rel} 失败：{exc}", file=sys.stderr)
        return {}


def main() -> int:
    meta = load("data/meta.json")
    quality = load("data/quality.json")
    fetch_report = load("data/fetch_report.json")

    print("### 数据状态")
    print()
    if meta:
        print(f"- 数据截止：**{meta.get('data_date', '未知')}**")
        print(
            f"- 资产：{meta.get('total_assets', '?')} 项"
            f"（可用 {meta.get('available_assets', '?')}，"
            f"缺失 {meta.get('unavailable_assets', '?')}）"
        )
    if quality:
        summary = quality.get("summary", {})
        print(f"- 记录总数：{summary.get('total_points', '?')}")
        print(
            f"- 校验：错误 {summary.get('error_count', '?')} 项，"
            f"提醒 {summary.get('warning_count', '?')} 项"
        )
        if quality.get("stale_days") is not None:
            print(f"- 数据新鲜度：距今 {quality['stale_days']} 天")
        errors = quality.get("errors") or []
        if errors:
            print()
            print("**校验错误**")
            for err in errors[:10]:
                print(f"- {err}")
    if fetch_report:
        print(
            f"- 抓取：成功 {fetch_report.get('ok', '?')}，"
            f"失败 {fetch_report.get('failed', '?')}，"
            f"耗时 {fetch_report.get('elapsed_seconds', '?')} 秒"
        )
        for failure in (fetch_report.get("failures") or [])[:10]:
            print(f"  - 失败：{failure.get('symbol')} {failure.get('name', '')} {failure.get('reason', '')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())