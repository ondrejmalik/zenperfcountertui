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

    headless = [str(binary), "--headless", "--no-pmu"]
    for arguments in (["--interval", "3"], ["--preset", "bogus"], ["--packs", "branches,"]):
        rc, _, err = run_and_capture(headless + arguments)
        if rc != 1 or arguments[0] not in err:
            raise SystemExit(f"headless_e2e: invalid arguments {arguments} returned {rc}: {err}")

    if os.name == "nt":
        rc, out, err = run_and_capture(headless + ["--target", "4294967295"])
        if rc != 2 or json.loads(out)["meta"]["evidence_gate_reason"] != "target_unavailable":
            raise SystemExit(f"headless_e2e: missing target returned {rc}: {err}")

        rc, out, err = run_and_capture(headless + ["--target", str(os.getpid())])
        if rc != 0 or json.loads(out)["target"]["pid"] != os.getpid():
            raise SystemExit(f"headless_e2e: attach by PID returned {rc}: {err}")

    rc, _, err = run_and_capture(headless + ["--baseline", "missing.json"])
    if rc != 1 or "missing.json" not in err:
        raise SystemExit(f"headless_e2e: unreadable baseline returned {rc}: {err}")

    child = [sys.executable, "--duration", "2", "--", "-c"]
    command = headless + [
        "--preset", "tlb-only", "--interval", "2", "--json-report", "reports/capture.json",
        "--save-baseline", "reports/saved.json", "--include-profiler", "--launch",
        *child, "import pathlib, sys, time; pathlib.Path('child.txt').write_text(sys.argv[1]); time.sleep(60)",
        "trailing argument with spaces",
    ]
    with isolated_run(command, prefix="ZEN2TOP") as (sup, scratch):
        out, err = sup.proc.communicate(timeout=15)
        if sup.proc.returncode != 0 or out:
            raise SystemExit(f"headless_e2e: file capture returned {sup.proc.returncode}: {err}")
        report = json.loads((scratch / "reports/capture.json").read_text(encoding="utf-8"))
        if not {"meta", "target", "summary", "win32_etw", "advisor", "profiler"} <= report.keys():
            raise SystemExit(f"headless_e2e: incomplete JSON v1 report: {report.keys()}")
        if report["meta"]["interval_sec"] != 2 or report["meta"]["sample_count"] != 0:
            raise SystemExit(f"headless_e2e: unexpected capture metadata: {report['meta']}")
        if not report["target"]["pid"] or report["target"]["exited_early"]:
            raise SystemExit(f"headless_e2e: unexpected launched target: {report['target']}")
        if (scratch / "child.txt").read_text() != "trailing argument with spaces":
            raise SystemExit("headless_e2e: child did not receive its trailing argument")
        baseline_path = scratch / "reports/saved.json"
        baseline = json.loads(baseline_path.read_text(encoding="utf-8"))
        if baseline["counters"] != report["summary"]["raw_cumulative_counters"]:
            raise SystemExit("headless_e2e: saved baseline did not preserve raw counters")

        rc, out, err = run_and_capture(headless + ["--preset", "full", "--baseline", str(baseline_path)])
        if rc != 0 or not json.loads(out).get("baseline_diff", {}).get("mux_diff_warning"):
            raise SystemExit(f"headless_e2e: baseline comparison returned {rc}: {err or out}")

    rc, out, err = run_and_capture(headless + ["--launch", *child, "raise SystemExit(0)"])
    if rc != 2 or not json.loads(out)["target"]["exited_early"]:
        raise SystemExit(f"headless_e2e: early child exit returned {rc}: {err}")

    print("headless_e2e: PASS (presets, JSON v1, invalid args, target lifecycle, baseline save and diff).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
