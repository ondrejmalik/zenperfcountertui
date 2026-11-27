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

ROOT = Path(__file__).resolve().parents[1]
SOFT_LINE_LIMIT = 1200
HARD_LINE_LIMIT = 1600
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


def reviewed(path: str) -> bool:
    return not path.endswith(".md") and not TEST_PATH.search(path)


def changed_files(base: str) -> list[str]:
    merge_base = git("merge-base", base, "HEAD").strip()
    tracked = set(filter(None, git("diff", "--name-only", "-z", merge_base).split("\0")))
    untracked = set(filter(None, git("ls-files", "--others", "--exclude-standard", "-z").split("\0")))
    return sorted(tracked | untracked)


def moved_line_count(diff_text: str, window: int = 3) -> int:
    removed: list[str] = []
    added: list[str] = []
    for line in diff_text.splitlines():
        if line.startswith("---") or line.startswith("+++"):
            continue
        if line.startswith("-"):
            s = "".join(line[1:].split())
            if len(s) >= 3:
                removed.append(s)
        elif line.startswith("+"):
            s = "".join(line[1:].split())
            if len(s) >= 3:
                added.append(s)
    used_add = [False] * len(added)
    moved = 0
    i = 0
    while i <= len(removed) - window:
        best_len = 0
        best_j = -1
        for j in range(len(added) - window + 1):
            if used_add[j]:
                continue
            k = 0
            while (
                i + k < len(removed)
                and j + k < len(added)
                and not used_add[j + k]
                and removed[i + k] == added[j + k]
            ):
                k += 1
            if k >= window and k > best_len:
                best_len, best_j = k, j
        if best_len >= window:
            for k in range(best_len):
                used_add[best_j + k] = True
            moved += best_len * 2
            i += best_len
        else:
            i += 1
    return moved


def net_reviewed_lines(base: str, files: list[str]) -> tuple[int, int]:
    merge_base = git("merge-base", base, "HEAD").strip()
    rev_files = [f for f in files if reviewed(f)]
    if not rev_files:
        return 0, 0
    diff_text = git("diff", "-U0", "--no-renames", "--no-color", merge_base, "--", *rev_files)
    raw = sum(
        1
        for line in diff_text.splitlines()
        if (line.startswith("+") and not line.startswith("+++"))
        or (line.startswith("-") and not line.startswith("---"))
    )
    moved = moved_line_count(diff_text)
    return max(0, raw - moved), moved


def check_lockfiles(files: list[str]) -> str | None:
    for lock, manifests in LOCK_PAIRS.items():
        locked = [f for f in files if f.endswith(lock)]
        if locked and not any(f.endswith(m) for f in files for m in manifests):
            return f"{', '.join(locked)} changed without a matching manifest ({', '.join(manifests)})"
    return None


def size_tier(net_loc: int) -> str:
    if net_loc <= SOFT_LINE_LIMIT:
        return "standard"
    if net_loc <= HARD_LINE_LIMIT:
        return "justification-required"
    return "spec-required"


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
    files = changed_files(base)
    net_loc, moved_loc = net_reviewed_lines(base, files)
    tier = size_tier(net_loc)
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
        size_note = f" (SOFT CAP >{SOFT_LINE_LIMIT}: concrete `## Size justification` required)"
    elif tier == "spec-required":
        size_note = f" (HARD CAP >{HARD_LINE_LIMIT}: approved `Spec: #<issue>` required)"

    print("### Self-check (`scripts/pr_ready.py`)")
    print(
        f"- **Changed files:** {len(files)} (`{net_loc}` net reviewed LOC, `{moved_loc}` moved lines excluded){size_note}"
    )
    print("\n| Gate | Verdict | Duration | Detail |")
    print("| :--- | :--- | :--- | :--- |")
    for r in rows:
        print(r)

    print(f"\n{FENCE}pr-ready")
    print("format: pr-ready v1")
    print(f"commit: {head_sha}{' (dirty)' if dirty else ''}")
    print(f"base: {base_sha}")
    print(f"dirty: {'true' if dirty else 'false'}")
    print(f"env: {env_fingerprint()}")
    print(f"files_changed: {len(files)}")
    print(f"net_loc: {net_loc}")
    print(f"moved_loc: {moved_loc}")
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
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
