#!/usr/bin/env python3
"""Autonomous Batch Integrator: tests ready-to-merge goal-aligned PRs together, ejects culprits, and auto-merges.

Also checks whether all open non-tracker issues for the active `goal:*` label have reached 0 and pings
the open Roadmap Tracker issue so the Planner / maintainer can promote the next milestone.

Usage:
    python scripts/batch_integrate.py --goal-label goal:v0.1-foundation --dry-run
    python scripts/batch_integrate.py --goal-label goal:v0.1-foundation --auto-merge
"""
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
    "perf-override-needed",
    "off-goal",
    "blocked",
    "duplicate",
    "do-not-merge",
}
PROTECTED_GLOBS = (
    "GOALS.md",
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
        "--label", "ready-to-merge",
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
        if any(c.get("conclusion") not in ("SUCCESS", "SKIPPED", "NEUTRAL", None) for c in checks):
            continue
        eligible.append(pr)
    return sorted(eligible, key=lambda p: p["number"])


def test_subset(prs: list[dict], base_ref: str = "origin/main") -> tuple[bool, str]:
    run(["git", "checkout", "-B", "agent-batch-integration", base_ref])
    for pr in prs:
        num = pr["number"]
        run(["git", "fetch", "origin", f"pull/{num}/head:refs/batch/pr-{num}"])
        merge = run(["git", "merge", "--no-ff", "--no-edit", f"refs/batch/pr-{num}"], check=False)
        if merge.returncode != 0:
            run(["git", "merge", "--abort"], check=False)
            return False, f"Merge conflict integrating PR #{num}:\n{merge.stderr}"
    ci = run([sys.executable, "scripts/ci.py", "all"], check=False)
    if ci.returncode != 0:
        tail = "\n".join((ci.stdout + "\n" + ci.stderr).splitlines()[-30:])
        return False, f"Combined batch CI failed:\n{tail}"
    return True, "ok"


def eject_pr(pr_number: int, reason: str, dry_run: bool) -> None:
    msg = (
        "🤖 Agent: BatchIntegrator | Automated ejection from integration batch.\n\n"
        f"Reason:\n```\n{reason[:1500]}\n```\n"
        "Removed `ready-to-merge`; merge `origin/main`, resolve the issue, and re-run `scripts/pr_ready.py`."
    )
    if dry_run:
        print(f"[DRY-RUN] Would eject PR #{pr_number}: {reason.splitlines()[0]}")
        return
    run(["gh", "pr", "comment", str(pr_number), "--body", msg], check=False)
    run(["gh", "pr", "edit", str(pr_number), "--remove-label", "ready-to-merge"], check=False)


def isolate_passing_subset(prs: list[dict], dry_run: bool) -> list[dict]:
    if not prs:
        return []
    ok, log = test_subset(prs)
    if ok:
        return prs
    if len(prs) == 1:
        eject_pr(prs[0]["number"], log, dry_run=dry_run)
        return []
    mid = len(prs) // 2
    left = isolate_passing_subset(prs[:mid], dry_run=dry_run)
    right = isolate_passing_subset(prs[mid:], dry_run=dry_run)
    combined = left + right
    if combined and len(combined) < len(prs):
        ok2, log2 = test_subset(combined)
        if ok2:
            return combined
        for pr in right:
            eject_pr(
                pr["number"],
                f"Cross-PR batch conflict with {[p['number'] for p in left]}:\n{log2}",
                dry_run=dry_run,
            )
        return left
    return combined


def check_milestone_complete(goal_label: str, dry_run: bool) -> None:
    """Notify the open Roadmap Tracker issue if 0 open non-tracker issues remain for goal_label."""
    raw = run([
        "gh", "issue", "list", "--state", "open", "--label", goal_label,
        "--json", "number,labels",
    ]).stdout
    issues = json.loads(raw or "[]")
    remaining = [
        i for i in issues
        if "tracker" not in {lbl["name"] for lbl in i.get("labels", [])}
    ]
    if remaining:
        print(f"batch_integrate: {len(remaining)} open issue(s) remain for {goal_label}.")
        return

    trackers_raw = run([
        "gh", "issue", "list", "--state", "open", "--label", "tracker", "--json", "number,comments",
    ]).stdout
    trackers = json.loads(trackers_raw or "[]")
    marker = f"<!-- milestone-complete:{goal_label} -->"
    for trk in trackers:
        if any(marker in (c.get("body") or "") for c in trk.get("comments", [])):
            continue
        num = str(trk["number"])
        body = (
            f"{marker}\n"
            f"🤖 Agent: BatchIntegrator | All open issues for `{goal_label}` are now closed! "
            "Ready for the Planner Agent / maintainer to promote `GOALS.md` to the next milestone and seed its queue."
        )
        if dry_run:
            print(f"[DRY-RUN] Would notify tracker #{num} that {goal_label} is complete.")
            continue
        run(["gh", "issue", "comment", num, "--body", body], check=False)
        run(["gh", "issue", "edit", num, "--add-label", "needs-human-review"], check=False)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--goal-label", required=True, help="Active goal label from GOALS.md (e.g. goal:v0.1-foundation)")
    parser.add_argument("--auto-merge", action="store_true", help="Auto-merge verified goal-aligned PRs via squash")
    parser.add_argument("--dry-run", action="store_true", help="Test batch locally without mutating GitHub")
    args = parser.parse_args()

    run(["git", "fetch", "origin", "main"])
    candidates = fetch_eligible_prs(args.goal_label)
    if not candidates:
        print(f"batch_integrate: no eligible ready-to-merge PRs for {args.goal_label}.")
        check_milestone_complete(args.goal_label, dry_run=args.dry_run)
        return 0

    print(f"batch_integrate: testing batch {[p['number'] for p in candidates]}...")
    passing = isolate_passing_subset(candidates, dry_run=args.dry_run)
    print(f"batch_integrate: verified passing subset = {[p['number'] for p in passing]}")

    if args.auto_merge and not args.dry_run:
        for pr in passing:
            num = pr["number"]
            print(f"batch_integrate: auto-merging PR #{num} (goal={args.goal_label})...")
            run(["gh", "pr", "merge", str(num), "--squash", "--auto"])

    check_milestone_complete(args.goal_label, dry_run=args.dry_run)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
