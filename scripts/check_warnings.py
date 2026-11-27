#!/usr/bin/env python3
"""Run a Cargo clippy/check command collecting all workspace warnings and failing closed if any occur."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys

if os.name == "nt":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[1]


def workspace_package_ids() -> set[str]:
    res = subprocess.run(
        ["cargo", "metadata", "--no-deps", "--format-version", "1"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if res.returncode != 0:
        return set()
    data = json.loads(res.stdout)
    return set(data.get("workspace_members", []))


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: check_warnings.py cargo clippy ...", file=sys.stderr)
        return 2

    cmd = list(sys.argv[1:])
    if "--message-format" not in " ".join(cmd):
        cmd.append("--message-format=json-diagnostic-rendered-ansi")

    ws_ids = workspace_package_ids()
    res = subprocess.run(
        cmd,
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )

    warnings = 0
    errors = 0
    for line in res.stdout.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        if msg.get("reason") != "compiler-message":
            continue
        pkg_id = msg.get("package_id", "")
        if ws_ids and pkg_id not in ws_ids:
            continue
        diag = msg.get("message") or {}
        level = diag.get("level")
        rendered = diag.get("rendered", "")
        if level == "warning":
            warnings += 1
            if rendered:
                sys.stderr.write(rendered)
        elif level == "error":
            errors += 1
            if rendered:
                sys.stderr.write(rendered)

    if res.returncode != 0 and errors == 0 and res.stderr.strip():
        sys.stderr.write(res.stderr)

    if res.returncode != 0 or errors > 0 or warnings > 0:
        print(
            f"check_warnings: FAIL ({errors} error(s), {warnings} workspace warning(s), exit={res.returncode}).",
            file=sys.stderr,
        )
        return 1

    print("check_warnings: PASS (0 workspace warnings, 0 errors).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
