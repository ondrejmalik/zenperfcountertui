#!/usr/bin/env python3
"""Preview integration of peer-verified PRs. The Architect owns merges and stage gates."""
from __future__ import annotations

import argparse
import fnmatch
import json
import os
from pathlib import Path
import subprocess
import sys

if os.name == "nt":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[1]
BLOCKING_LABELS = {
    "needs-human-review",
    "needs-human",
    "needs-review",
    "changes-requested",
    "review-in-progress",
    "fix-in-progress",
    "perf-override-needed",
    "off-goal",
    "blocked",
    "duplicate",
    "do-not-merge",
}
PROTECTED_GLOBS = (
    "GOALS.md",
    "AGENTS.md",
    "docs/ARCHITECT_PROMPT.md",
    "docs/ARCHITECTURE_RULES.md",
    "scripts/pr_ready.py",
    ".github/*",
    ".github/**",
    "Jenkinsfile",
    "rust-toolchain.toml",
    "scripts/ci.py",
    "scripts/gh_ci/*",
    "scripts/check_hygiene.py",
    "scripts/check_layers.py",
    "scripts/layers.json",
    "scripts/ratchet_gate.py",
    "scripts/batch_integrate.py",
    "Cargo.toml",
    "crates/*/Cargo.toml",
    "pyproject.toml",
    "*.csproj",
    "Directory.Packages.props",
)


def run(cmd: list[str], check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=check,
        encoding="utf-8",
        errors="replace",
    )


def touches_protected(files: list[str]) -> list[str]:
    hits: list[str] = []
    for path in files:
        if any(fnmatch.fnmatch(path, pat) for pat in PROTECTED_GLOBS):
            hits.append(path)
    return hits


def fetch_eligible_prs(goal_label: str) -> list[dict]:
    raw = run([
        "gh", "pr", "list", "--state", "open",
        "--label", "agent-verified",
        "--label", goal_label,
        "--json", "number,title,headRefOid,labels,files,statusCheckRollup,body",
    ]).stdout
    prs = json.loads(raw) if raw.strip() else []
    eligible: list[dict] = []
    for pr in prs:
        labels = {lbl["name"] for lbl in pr.get("labels", [])}
        if labels & BLOCKING_LABELS:
            continue
        files = [f["path"] for f in pr.get("files", [])]
        if touches_protected(files):
            print(f"Skipping PR #{pr['number']}: touches protected/Tier-2 path(s); requires human review.")
            continue
        checks = pr.get("statusCheckRollup", [])
        if not checks or any(c.get("conclusion") not in ("SUCCESS", "SKIPPED", "NEUTRAL") for c in checks):
            continue
        eligible.append(pr)
    return sorted(eligible, key=lambda p: p["number"])


def test_subset(prs: list[dict], base_ref: str = "origin/main") -> tuple[bool, str]:
    run(["git", "checkout", "-B", "agent-batch-integration", base_ref])
    for pr in prs:
        num = pr["number"]
        run(["git", "fetch", "origin", f"+pull/{num}/head:refs/batch/pr-{num}"])
        actual_head = run(["git", "rev-parse", f"refs/batch/pr-{num}"]).stdout.strip()
        if actual_head != pr["headRefOid"]:
            return False, f"PR #{num} changed after selection."
        merge = run(["git", "merge", "--no-ff", "--no-edit", f"refs/batch/pr-{num}"], check=False)
        if merge.returncode != 0:
            run(["git", "merge", "--abort"], check=False)
            return False, f"Merge conflict integrating PR #{num}:\n{merge.stderr}"
    ci = run([sys.executable, "scripts/ci.py", "all"], check=False)
    if ci.returncode != 0:
        tail = "\n".join((ci.stdout + "\n" + ci.stderr).splitlines()[-30:])
        return False, f"Combined batch CI failed:\n{tail}"
    return True, "ok"


def isolate_passing_subset(prs: list[dict]) -> list[dict]:
    if not prs:
        return []
    ok, log = test_subset(prs)
    if ok:
        return prs
    if len(prs) == 1:
        print(f"PR #{prs[0]['number']} did not integrate: {log}")
        return []
    mid = len(prs) // 2
    left = isolate_passing_subset(prs[:mid])
    right = isolate_passing_subset(prs[mid:])
    combined = left + right
    if combined and len(combined) < len(prs):
        ok2, log2 = test_subset(combined)
        if ok2:
            return combined
        print(f"Right-side PRs conflict with {[p['number'] for p in left]}: {log2}")
        return left
    return combined


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--goal-label", required=True, help="Active goal label from GOALS.md (e.g. goal:v0.1-foundation)")
    parser.add_argument("--dry-run", action="store_true", required=True, help="Test the batch in a disposable checkout")
    args = parser.parse_args()

    if run(["git", "status", "--porcelain"]).stdout.strip():
        parser.error("Use a clean, disposable checkout for the integration branch.")
    run(["git", "fetch", "origin", "main"])
    candidates = fetch_eligible_prs(args.goal_label)
    if not candidates:
        print(f"batch_integrate: no eligible agent-verified PRs for {args.goal_label}.")
        return 0

    print(f"batch_integrate: testing batch {[p['number'] for p in candidates]}...")
    passing = isolate_passing_subset(candidates)
    print(f"batch_integrate: verified passing subset = {[p['number'] for p in passing]}")

    return 0 if len(passing) == len(candidates) else 1


if __name__ == "__main__":
    raise SystemExit(main())
