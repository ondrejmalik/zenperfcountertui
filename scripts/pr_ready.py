#!/usr/bin/env python3
"""Run before opening or updating a pull request; paste the entire output into `## Self-check`.

    python scripts/pr_ready.py --base origin/main
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import time

if os.name == "nt":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

if __package__:
    from .gh_ci.diff_size import HARD_CAP, SOFT_CAP, measure_diff, size_tier
else:
    from gh_ci.diff_size import HARD_CAP, SOFT_CAP, measure_diff, size_tier

ROOT = Path(__file__).resolve().parents[1]
FENCE = "`" * 3
LOCK_PAIRS = {
    "Cargo.lock": ("Cargo.toml",),
    "packages.lock.json": (".csproj", "Directory.Packages.props", "Directory.Build.props"),
    "uv.lock": ("pyproject.toml",),
    "poetry.lock": ("pyproject.toml",),
}
TEST_PATH = re.compile(r"(^|/)tests?/|/test_\w+\.(?:py|rs|cs)$|\w+_tests?\.(?:py|rs|cs)$")


def git(*args: str) -> str:
    return subprocess.run(
        ["git", "-c", "core.quotePath=false", *args],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
        encoding="utf-8",
        errors="replace",
    ).stdout


def resolve_base(preferred: str) -> str:
    for candidate in (preferred, "origin/main", "main", "master", "HEAD"):
        if not candidate:
            continue
        res = subprocess.run(
            ["git", "rev-parse", "--verify", "--quiet", f"{candidate}^{{commit}}"],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        if res.returncode == 0:
            return candidate
    return "HEAD"


def env_fingerprint() -> str:
    return (
        f"{platform.system().lower()}-{platform.machine().lower()}"
        f"-py{sys.version_info.major}.{sys.version_info.minor}-cpu{os.cpu_count() or 0}"
    )


def is_working_tree_dirty() -> bool:
    return bool(git("status", "--porcelain").strip())


def check_lockfiles(files: tuple[str, ...]) -> str | None:
    for lock, manifests in LOCK_PAIRS.items():
        locked = [f for f in files if f.endswith(lock)]
        if locked and not any(f.endswith(m) for f in files for m in manifests):
            return f"{', '.join(locked)} changed without a matching manifest ({', '.join(manifests)})"
    return None


def run_step(cmd: list[str]) -> tuple[str, float, str]:
    t0 = time.monotonic()
    res = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace")
    elapsed = round(time.monotonic() - t0, 1)
    status = "PASS" if res.returncode == 0 else "FAIL"
    tail = "\n".join((res.stdout + "\n" + res.stderr).strip().splitlines()[-15:])
    return status, elapsed, tail


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="origin/main")
    args = parser.parse_args()

    base = resolve_base(args.base)
    head_sha = git("rev-parse", "HEAD").strip()
    base_sha = git("merge-base", base, "HEAD").strip()
    dirty = is_working_tree_dirty()
    diff = measure_diff(base_sha, head_sha)
    files = diff.files
    tier = size_tier(diff.production)
    lock_err = check_lockfiles(files)

    steps: list[tuple[str, str, list[str] | None]] = [
        ("lockfile", "Lockfile discipline", None if not lock_err else ["false"]),
        ("hygiene", "Hygiene & gate tests", [sys.executable, "scripts/ci.py", "hygiene"]),
        ("layers", "Architectural layers", [sys.executable, "scripts/ci.py", "layers", "--base", base]),
        ("lint", "Format & lint", [sys.executable, "scripts/ci.py", "lint"]),
        ("tests", "Tests", [sys.executable, "scripts/ci.py", "test"]),
        ("headless", "Headless verification", [sys.executable, "scripts/ci.py", "headless"]),
        ("ratchet", "Quality ratchet", [sys.executable, "scripts/ci.py", "ratchet"]),
    ]

    changed_tests = [f for f in files if TEST_PATH.search(f)]
    if changed_tests:
        for run_idx in range(1, 4):
            steps.append((f"flake_{run_idx}", f"Flake check ({run_idx}/3)", [sys.executable, "scripts/ci.py", "test"]))

    rows: list[str] = []
    verdicts: dict[str, str] = {}
    failed = False

    for key, name, cmd in steps:
        if key == "lockfile":
            if lock_err:
                rows.append(f"| {name} | FAIL | 0.0s | `{lock_err}` |")
                verdicts[key] = "FAIL"
                failed = True
                break
            rows.append(f"| {name} | PASS | 0.0s | `ok` |")
            verdicts[key] = "PASS"
            continue
        assert cmd is not None
        status, sec, tail = run_step(cmd)
        verdicts[key] = status
        last_line = tail.splitlines()[-1][:80] if tail.splitlines() else "ok"
        detail = "ok" if status == "PASS" else last_line
        rows.append(f"| {name} | {status} | {sec}s | `{detail}` |")
        if status != "PASS":
            failed = True
            print(f"\n--- FAILED: {name} ---\n{tail}", file=sys.stderr)
            break

    flake_status = (
        "PASS"
        if not changed_tests
        else ("PASS" if all(verdicts.get(f"flake_{i}") == "PASS" for i in (1, 2, 3)) else "FAIL")
    )

    size_note = ""
    if tier == "justification-required":
        size_note = f" (SOFT CAP >{SOFT_CAP}: concrete `## Size justification` required)"
    elif tier == "architect-waiver-required":
        size_note = f" (HARD CAP >{HARD_CAP}: `size/architect-waiver` and size justification required)"

    print("### Self-check (`scripts/pr_ready.py`)")
    print(f"- **Changed files:** {len(files)}")
    print(f"- **Net production Rust LOC:** {diff.production} ({diff.moved} moved lines excluded){size_note}")
    print(f"- **Other changed LOC (informational):** {diff.other}")
    for warning in diff.warnings:
        print(f"- **Anti-golfing review:** {warning}")
    print("\n| Gate | Verdict | Duration | Detail |")
    print("| :--- | :--- | :--- | :--- |")
    for r in rows:
        print(r)

    print(f"\n{FENCE}pr-ready")
    print("format: pr-ready v2")
    print(f"commit: {head_sha}{' (dirty)' if dirty else ''}")
    print(f"base: {base_sha}")
    print(f"dirty: {'true' if dirty else 'false'}")
    print(f"env: {env_fingerprint()}")
    print(f"files_changed: {len(files)}")
    print(f"net_prod_loc: {diff.production}")
    print(f"non_prod_loc: {diff.other}")
    print(f"moved_loc: {diff.moved}")
    print(f"size_tier: {tier}")
    print(f"lockfile: {verdicts.get('lockfile', 'SKIP')}")
    print(f"hygiene: {verdicts.get('hygiene', 'SKIP')}")
    print(f"layers: {verdicts.get('layers', 'SKIP')}")
    print(f"lint: {verdicts.get('lint', 'SKIP')}")
    print(f"tests: {verdicts.get('tests', 'SKIP')}")
    print(f"headless: {verdicts.get('headless', 'SKIP')}")
    print(f"ratchet: {verdicts.get('ratchet', 'SKIP')}")
    print(f"flake_3x: {flake_status}")
    print(f"overall: {'PASS' if not failed else 'FAIL'}")
    print(FENCE)

    if dirty:
        print("\nWARNING: Working tree is dirty. Commit all changes and re-run before opening PR.", file=sys.stderr)
    return 1 if failed or dirty else 0


if __name__ == "__main__":
    raise SystemExit(main())
