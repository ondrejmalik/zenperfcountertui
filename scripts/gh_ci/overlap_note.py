#!/usr/bin/env python3
"""Detect function-level and issue-level overlap across open pull requests (Rust, C#, Python)."""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys

ATTRIBUTES = "*.rs diff=rust\n*.py diff=python\n*.cs diff=csharp\n"
HUNK = re.compile(r"^@@ -\d+(?:,(\d+))? \+\d+(?:,\d+)? @@ ?(.*)$")
SKIP_LINE = re.compile(r"^\+\s*(?:$|//|#\[|#(?!\[)|\[)")
NEW_ITEM = re.compile(
    r"^\+\s*(?:(?:pub(?:\([^)]*\))?|public|private|protected|internal|static|async|virtual|override|sealed|const|unsafe)\s+)*"
    r"(?:fn|def|class|impl|struct|enum|trait|interface|mod)\b"
)
FUNC_NAME = re.compile(
    r"(?:\b(?:fn|def)\s+([A-Za-z_][A-Za-z0-9_]*))|"
    r"(?:[A-Za-z_<>[\],.\s]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\()"
)
NOT_WORK = re.compile(r"/examples/|^tests/|/tests/|^scripts/test_|_tests?\.(?:rs|py|cs)$")
FIXES_RE = re.compile(r"\b(?:Fixes|Closes|Resolves)\s+#(\d+)\b", re.IGNORECASE)
MARKER = "<!-- overlap-note -->"


def extract_modified_functions(diff_text: str) -> set[tuple[str, str]]:
    """Return (file_path, function_name) for every diff hunk that modifies existing lines inside a function."""
    out: set[tuple[str, str]] = set()
    path: str | None = None
    header = ""
    removed = 0
    added: list[str] = []

    def flush() -> None:
        first_real = next((line for line in added if not SKIP_LINE.match(line)), "")
        if path and header and (removed > 0 or not NEW_ITEM.match(first_real)):
            m = FUNC_NAME.search(header)
            fn = (m.group(1) or m.group(2)) if m else None
            if fn and not NOT_WORK.search(path):
                out.add((path, fn))

    for line in diff_text.splitlines():
        if line.startswith("diff --git "):
            flush()
            path, header, removed, added = None, "", 0, []
        elif line.startswith("+++ b/"):
            path = line[6:]
        elif m := HUNK.match(line):
            flush()
            removed = 1 if m.group(1) is None else int(m.group(1))
            header, added = m.group(2), []
        elif line.startswith("+") and header:
            added.append(line)
    flush()
    return out


def extract_linked_issues(body: str) -> set[str]:
    return set(FIXES_RE.findall(body or ""))


def gh(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["gh", *args],
        capture_output=True,
        text=True,
        check=check,
        encoding="utf-8",
        errors="replace",
    )


def main() -> int:
    repo = os.environ.get("REPO")
    pr_num = os.environ.get("PR_NUMBER")
    if not repo or not pr_num:
        print("overlap_note: REPO and PR_NUMBER env vars required.", file=sys.stderr)
        return 2

    raw_prs = gh("pr", "list", "-R", repo, "--state", "open", "--json", "number,body").stdout
    open_prs = json.loads(raw_prs or "[]")
    target = next((p for p in open_prs if str(p["number"]) == str(pr_num)), None)
    if not target:
        return 0

    target_issues = extract_linked_issues(target.get("body", ""))
    target_diff = gh("pr", "diff", str(pr_num), "-R", repo, check=False).stdout
    target_fns = extract_modified_functions(target_diff)

    overlaps: list[str] = []
    for other in open_prs:
        other_num = str(other["number"])
        if other_num == str(pr_num):
            continue
        shared_issues = sorted(target_issues & extract_linked_issues(other.get("body", "")))
        other_diff = gh("pr", "diff", other_num, "-R", repo, check=False).stdout
        shared_fns = sorted(target_fns & extract_modified_functions(other_diff))
        if shared_issues or shared_fns:
            parts: list[str] = []
            if shared_issues:
                parts.append("issues: " + ", ".join(f"#{i}" for i in shared_issues))
            if shared_fns:
                parts.append("functions: " + ", ".join(f"`{p}::{fn}`" for p, fn in shared_fns[:5]))
            overlaps.append(f"- PR #{other_num} ({'; '.join(parts)})")

    if not overlaps:
        print(f"overlap_note: no overlap detected for PR #{pr_num}.")
        return 0

    note = (
        f"{MARKER}\n"
        f"🤖 Agent: OverlapNote | Detected potential overlap with other open PR(s):\n"
        + "\n".join(overlaps)
        + "\n\nVerifiers: check duplicate/quorum policy before approving."
    )
    comments_raw = gh("pr", "view", str(pr_num), "-R", repo, "--json", "comments").stdout
    comments = json.loads(comments_raw or "{}").get("comments", [])
    existing = next((c for c in comments if MARKER in (c.get("body") or "")), None)
    if existing:
        gh("api", "-X", "PATCH", f"repos/{repo}/issues/comments/{existing['databaseId']}", "-f", f"body={note}", check=False)
    else:
        gh("pr", "comment", str(pr_num), "-R", repo, "--body", note, check=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
