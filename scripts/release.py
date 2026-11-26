"""scripts/release.py — 一条命令完成发布：校验 → 提交 → 打标签 → 推送 → 发 Release。

为什么需要它：这台机器到 github.com 的链路经常抖，手动发布每次都要重试十几分钟。
把重试、API 兜底与顺序固化下来，少一次手动失误就少一次「tag 指错提交」。

用法：
    py scripts/release.py --version 4.1.0 --message "v4.1.0：……" --notes-from _release.json
    py scripts/release.py --version 4.1.0 --dry-run

流程：
1. 检查工作区（未提交改动会先跑校验，再一起提交）；
2. 跑 Node 与 Python 测试 + 静态检查，任一失败即中止；
3. 改写 package.json 的版本号；
4. commit（带给定信息）→ 打 tag → 推送（失败自动重试，指数退避）；
5. 用 GitHub API 创建 Release（正文来自 --notes-from 指定的 JSON 或 --notes 文本）。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOKEN_CANDIDATES = [
    r"D:\github\token\newest.txt",
    os.path.join(ROOT, ".token"),
]
REPO = "angelky7/investment-lab"


def redact(text: str) -> str:
    """日志里绝不能出现 token —— 之前 push 的命令行把 ghp_ 开头的密钥整个打印了出来。"""
    return re.sub(r"(x-access-token:)[^@\s]+", r"\1***", text)


def run(cmd: list[str], check: bool = True) -> tuple[int, str]:
    print(redact(f"$ {' '.join(cmd)}"), flush=True)
    proc = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace")
    out = (proc.stdout or "") + (proc.stderr or "")
    if out.strip():
        print(redact(out.strip()[-2000:]), flush=True)
    if check and proc.returncode != 0:
        raise SystemExit(f"命令失败（exit {proc.returncode}）：{' '.join(cmd)}")
    return proc.returncode, out


def read_token() -> str:
    token = os.environ.get("GITHUB_TOKEN", "").strip()
    if token:
        return token
    for path in TOKEN_CANDIDATES:
        if os.path.exists(path):
            value = open(path, encoding="utf-8", errors="replace").read().strip()
            if value:
                return value
    raise SystemExit("找不到 GitHub token：设置 GITHUB_TOKEN 或把它们放到 D:\\github\\token\\newest.txt")


def bump_version(version: str) -> str:
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise SystemExit(f"版本号格式应为 X.Y.Z，收到 {version}")
    path = os.path.join(ROOT, "package.json")
    pkg = json.load(open(path, encoding="utf-8"))
    pkg["version"] = version
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(pkg, f, ensure_ascii=False, indent=2)
        f.write("\n")
    return version


def verify() -> None:
    print("\n=== 1/4 校验 ===", flush=True)
    run(["node", "--test"])
    # 有的机器上 python 命令叫 py
    for cmd in (["py", "-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py"],
                ["python", "-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py"]):
        code, _ = run(cmd, check=False)
        if code == 0:
            break
    else:
        raise SystemExit("Python 测试失败")
    run(["py", "scripts/check_links.py"])


def git_commit_and_tag(tag: str, message: str) -> None:
    print("\n=== 2/4 提交与标签 ===", flush=True)
    run(["git", "add", "-A"])
    run(
        [
            "git",
            "-c", "user.name=kwanch27",
            "-c", "user.email=kwanch27@outlook.com",
            "commit",
            "-m", message,
        ],
        check=False,  # 无改动时 commit 会失败，可接受
    )
    run(["git", "tag", "-f", tag])


def push(tag: str, token: str, attempts: int = 8) -> None:
    print("\n=== 3/4 推送 ===", flush=True)
    url = f"https://x-access-token:{token}@github.com/{REPO}.git"
    for attempt in range(1, attempts + 1):
        code, out = run(
            [
                "git",
                "-c", "http.sslBackend=openssl",
                "-c", "http.sslVerify=false",
                "push", url, "main",
            ],
            check=False,
        )
        if code == 0:
            print(f"推送成功（第 {attempt} 次）", flush=True)
            break
        wait = min(60, 10 * attempt)
        print(f"第 {attempt} 次推送失败，{wait}s 后重试…", flush=True)
        time.sleep(wait)
    else:
        raise SystemExit("推送连续失败，请检查网络后重跑（tag 已在本地）")

    # tag 单独推一次，失败不致命——Release 会通过 API 创建引用
    run(
        [
            "git", "-c", "http.sslBackend=openssl", "-c", "http.sslVerify=false",
            "push", url, tag,
        ],
        check=False,
    )


def api(method: str, path: str, token: str, payload: dict | None = None):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(
        f"https://api.github.com{path}",
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "investment-lab-release",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        body = resp.read().decode("utf-8", errors="replace")
        return json.loads(body) if body else {}


def publish_release(tag: str, name: str, body: str, token: str) -> str:
    print("\n=== 4/4 创建 Release ===", flush=True)
    head = api("GET", f"/repos/{REPO}/commits/main", token)["sha"]

    # 确保远程有 tag（git push 抖的时候 API 兜底）
    try:
        api("POST", f"/repos/{REPO}/git/refs", token, {"ref": f"refs/tags/{tag}", "sha": head})
        print(f"已通过 API 创建 tag {tag} → {head[:7]}", flush=True)
    except urllib.error.HTTPError as exc:
        if exc.code != 422:  # 422 = 已存在
            print(f"创建 tag 时返回 {exc.code}，继续尝试发布", flush=True)

    try:
        rel = api(
            "POST",
            f"/repos/{REPO}/releases",
            token,
            {
                "tag_name": tag,
                "name": name,
                "body": body,
                "draft": False,
                "prerelease": False,
                "make_latest": "true",
            },
        )
        return rel.get("html_url", "")
    except urllib.error.HTTPError as exc:
        if exc.code == 422:
            print("该 tag 已有 Release，改为更新正文", flush=True)
            existing = api("GET", f"/repos/{REPO}/releases/tags/{tag}", token)
            rel = api("PATCH", f"/repos/{REPO}/releases/{existing['id']}", token, {"body": body, "name": name})
            return rel.get("html_url", "")
        raise


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", required=True, help="X.Y.Z")
    parser.add_argument("--message", required=True, help="提交与 tag 的说明")
    parser.add_argument("--name", default="", help="Release 标题，默认与 message 相同")
    parser.add_argument("--notes", default="", help="Release 正文")
    parser.add_argument("--notes-from", default="", help="从 JSON 文件读取 Release 正文（字段 body）")
    parser.add_argument("--dry-run", action="store_true", help="只跑校验，不动仓库")
    args = parser.parse_args()

    if args.dry_run:
        verify()
        print("\n（dry-run）校验通过，未修改任何文件。")
        return 0

    verify()
    version = bump_version(args.version)
    tag = f"v{version}"

    body = args.notes
    if args.notes_from and os.path.exists(args.notes_from):
        body = json.load(open(args.notes_from, encoding="utf-8")).get("body", body)
    if not body:
        body = args.message

    git_commit_and_tag(tag, args.message)
    token = read_token()
    push(tag, token)
    url = publish_release(tag, args.name or args.message, body, token)

    print()
    print("=" * 56)
    print(f"发布完成：{tag}")
    if url:
        print(f"Release：{url}")
    return 0


if __name__ == "__main__":
    sys.exit(main())