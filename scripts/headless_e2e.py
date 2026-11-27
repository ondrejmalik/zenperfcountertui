#!/usr/bin/env python3
"""Headless E2E verification harness for zen2top in an isolated scratch environment."""
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
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.test_env import isolated_run  # noqa: E402


def build_zen2top() -> Path:
    build_env = os.environ.copy()
    build_env.pop("RUSTFLAGS", None)
    build_env.pop("CARGO_ENCODED_RUSTFLAGS", None)
    res = subprocess.run(
        ["cargo", "build", "--locked", "-p", "zen2top-cli", "--bin", "zen2top"],
        cwd=ROOT,
        env=build_env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if res.returncode != 0:
        sys.stderr.write(res.stdout + "\n" + res.stderr)
        raise SystemExit(res.returncode)
    exe_name = "zen2top.exe" if os.name == "nt" else "zen2top"
    target_dir = Path(os.environ.get("CARGO_TARGET_DIR", ROOT / "target"))
    binary = target_dir / "debug" / exe_name
    if not binary.exists():
        raise SystemExit(f"headless_e2e: expected binary not found at {binary}")
    return binary


def run_and_capture(cmd: list[str], timeout_s: float = 15.0) -> tuple[int, str, str]:
    with isolated_run(cmd, prefix="ZEN2TOP") as (sup, _scratch):
        out, err = sup.proc.communicate(timeout=timeout_s)
        return sup.proc.returncode, out, err


def main() -> int:
    binary = build_zen2top()

    # 1. Verify --print-presets outputs the 6 canonical Zen 2 presets as JSON.
    rc, out, err = run_and_capture([str(binary), "--print-presets"])
    if rc != 0:
        print(f"headless_e2e: --print-presets failed (rc={rc}): {err}", file=sys.stderr)
        return 1
    presets = json.loads(out)
    slugs = [p["slug"] for p in presets]
    expected_slugs = ["full", "kitchen-sink", "balanced", "tlb-only", "mem-ccx-lab", "micro-arch"]
    if slugs != expected_slugs:
        print(f"headless_e2e: unexpected preset slugs: {slugs}", file=sys.stderr)
        return 1

    # 2. Verify --headless --no-pmu --json-report - emits schema_version 1 JSON and exits 0.
    rc2, out2, err2 = run_and_capture(
        [str(binary), "--headless", "--no-pmu", "--preset", "balanced", "--duration", "1", "--json-report", "-"]
    )
    if rc2 != 0:
        print(f"headless_e2e: --headless --no-pmu failed (rc={rc2}): {err2}", file=sys.stderr)
        return 1
    report = json.loads(out2)
    meta = report.get("meta", {})
    if meta.get("schema_version") != 1 or meta.get("no_pmu") is not True:
        print(f"headless_e2e: invalid headless report meta: {meta}", file=sys.stderr)
        return 1

    print("headless_e2e: PASS (--print-presets + --headless --no-pmu schema_version=1 in isolated scratch env).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
