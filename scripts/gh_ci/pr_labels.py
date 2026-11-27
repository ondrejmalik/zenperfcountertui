#!/usr/bin/env python3
"""Sync kind and size labels using the trusted base-branch policy."""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys

if __package__:
    from .diff_size import LARGE, SOFT_CAP, measure_diff
else:
    from diff_size import LARGE, SOFT_CAP, measure_diff

KIND_LABELS = ("bug", "feature", "perf", "parity", "tooling", "docs")
CHECKED_RE = re.compile(r"^\s*-\s*\[[xX]\]\s*([a-z]+)\s*:", re.MULTILINE)


def parse_checked_kinds(body: str) -> list[str]:
    found = [m.group(1).lower() for m in CHECKED_RE.finditer(body or "")]
    return [k for k in found if k in KIND_LABELS]


def main() -> int:
    repo = os.environ.get("REPO")
    pr_num = os.environ.get("PR_NUMBER")
    if not repo or not pr_num:
        print("pr_labels: REPO and PR_NUMBER env vars required.", file=sys.stderr)
        return 2

    def gh(*args: str) -> str:
        return subprocess.run(["gh", *args], capture_output=True, check=True, encoding="utf-8").stdout

    pr = json.loads(gh("api", f"repos/{repo}/pulls/{pr_num}"))
    head = os.environ["HEAD_SHA"]
    base = os.environ["BASE_SHA"]
    if (pr["head"]["sha"], pr["base"]["sha"]) != (head, base):
        print(f"pr_labels: PR #{pr_num} advanced. A newer run will handle it.")
        return 0
    selected = set(parse_checked_kinds(pr["body"] or ""))
    if measure_diff(base, head).production > SOFT_CAP:
        selected.add(LARGE)
    managed = set(KIND_LABELS) | {LARGE}
    existing = {label["name"] for label in pr["labels"]} & managed
    edits = []
    for labels, flag in ((selected - existing, "--add-label"), (existing - selected, "--remove-label")):
        if labels:
            edits.extend((flag, ",".join(sorted(labels))))
    if edits:
        gh("pr", "edit", pr_num, "-R", repo, *edits)
    print(f"pr_labels: synced PR #{pr_num} -> {sorted(selected)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
