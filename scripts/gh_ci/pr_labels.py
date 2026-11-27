#!/usr/bin/env python3
"""Sync the ticked `## Kind` checkbox in a PR description to repository labels."""
from __future__ import annotations

import os
import re
import subprocess
import sys

KIND_LABELS = ("bug", "feature", "perf", "parity", "tooling", "docs")
CHECKED_RE = re.compile(r"^\s*-\s*\[[xX]\]\s*([a-z]+)\s*:", re.MULTILINE)


def parse_checked_kinds(body: str) -> list[str]:
    found = [m.group(1).lower() for m in CHECKED_RE.finditer(body or "")]
    return [k for k in found if k in KIND_LABELS]


def main() -> int:
    repo = os.environ.get("REPO")
    pr_num = os.environ.get("PR_NUMBER")
    body = os.environ.get("PR_BODY", "")
    if not repo or not pr_num:
        print("pr_labels: REPO and PR_NUMBER env vars required.", file=sys.stderr)
        return 2

    selected = set(parse_checked_kinds(body))
    for lbl in KIND_LABELS:
        flag = "--add-label" if lbl in selected else "--remove-label"
        subprocess.run(
            ["gh", "pr", "edit", str(pr_num), "-R", repo, flag, lbl],
            capture_output=True,
            text=True,
            check=False,
        )
    print(f"pr_labels: synced PR #{pr_num} -> {sorted(selected)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
