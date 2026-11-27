#!/usr/bin/env python3
"""Unified cross-platform CI runner invoked identically by GitHub Actions, Jenkins, Batch Integrator, and local devs.

Usage:
    python scripts/ci.py hygiene
    python scripts/ci.py layers [--base origin/main]
    python scripts/ci.py lint
    python scripts/ci.py test
    python scripts/ci.py headless
    python scripts/ci.py ratchet
    python scripts/ci.py bench
    python scripts/ci.py all
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

if os.name == "nt":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[1]


def detect_stacks() -> list[str]:
    stacks: list[str] = []
    if (ROOT / "Cargo.toml").exists():
        stacks.append("rust")
    if (ROOT / "pyproject.toml").exists():
        stacks.append("python")
    return stacks


def scratch_env() -> tuple[dict[str, str], Path]:
    scratch = Path(tempfile.mkdtemp(prefix="zen2top-ci-scratch-"))
    env = os.environ.copy()
    # Clear ambient host RUSTFLAGS (e.g. nightly-only `-Zthreads=...`) so stable CI builds stay deterministic.
    env.pop("RUSTFLAGS", None)
    env.pop("CARGO_ENCODED_RUSTFLAGS", None)
    env.update({
        "PYTHONUTF8": "1",
        "ZEN2TOP_HOME": str(scratch / "zen2top-home"),
        "ZEN2TOP_CONFIG_HOME": str(scratch / "zen2top-config"),
        "APPDATA": str(scratch / "appdata"),
        "LOCALAPPDATA": str(scratch / "localappdata"),
        "XDG_DATA_HOME": str(scratch / "xdg-data"),
        "XDG_CONFIG_HOME": str(scratch / "xdg-config"),
        "ZEN2TOP_NO_AUDIO": "1",
        "ZEN2TOP_NO_SELF_UPDATE": "1",
        "ZEN2TOP_TELEMETRY_URL": "off",
        "ZEN2TOP_TEST_LOOPBACK": "1",
    })
    for key in ("ZEN2TOP_HOME", "ZEN2TOP_CONFIG_HOME", "APPDATA", "LOCALAPPDATA", "XDG_DATA_HOME", "XDG_CONFIG_HOME"):
        Path(env[key]).mkdir(parents=True, exist_ok=True)
    return env, scratch


def run_cmd(cmd: list[str], env: dict[str, str] | None = None, cwd: Path = ROOT) -> None:
    print(f"+ {' '.join(cmd)}", flush=True)
    res = subprocess.run(cmd, cwd=cwd, env=env)
    if res.returncode != 0:
        raise SystemExit(res.returncode)


def stage_hygiene(env: dict[str, str]) -> None:
    run_cmd([sys.executable, "scripts/check_hygiene.py"], env=env)
    scripts_dir = ROOT / "scripts"
    if any(scripts_dir.glob("test_*.py")):
        run_cmd(
            [sys.executable, "-m", "unittest", "discover", "-s", "scripts", "-p", "test_*.py", "-v"],
            env=env,
        )


def stage_layers(env: dict[str, str], base: str | None) -> None:
    if (ROOT / "scripts/check_layers.py").exists():
        cmd = [sys.executable, "scripts/check_layers.py"]
        if base:
            cmd += ["--base", base]
        run_cmd(cmd, env=env)


def stage_lint(env: dict[str, str], stacks: list[str]) -> None:
    if "rust" in stacks:
        run_cmd(["cargo", "fmt", "--all", "--", "--check"], env=env)
        run_cmd(
            [
                sys.executable,
                "scripts/check_warnings.py",
                "cargo",
                "clippy",
                "--keep-going",
                "--workspace",
                "--all-targets",
                "--locked",
            ],
            env=env,
        )


def stage_test(env: dict[str, str], stacks: list[str]) -> None:
    if "rust" in stacks:
        if shutil.which("cargo-nextest"):
            run_cmd(["cargo", "nextest", "run", "--workspace", "--locked"], env=env)
        else:
            run_cmd(["cargo", "test", "--locked", "--workspace", "--lib", "--bins", "--tests"], env=env)
        run_cmd(["cargo", "test", "--locked", "--workspace", "--doc"], env=env)


def stage_headless(env: dict[str, str]) -> None:
    harness = ROOT / "scripts/headless_e2e.py"
    if harness.exists():
        run_cmd([sys.executable, str(harness)], env=env)
    else:
        print("headless: no scripts/headless_e2e.py configured; skipping.")


def stage_ratchet(env: dict[str, str]) -> None:
    ratchet = ROOT / "scripts/ratchet_gate.py"
    if ratchet.exists():
        run_cmd([sys.executable, str(ratchet)], env=env)
    else:
        print("ratchet: no scripts/ratchet_gate.py configured; skipping.")


def stage_bench(env: dict[str, str]) -> None:
    bench_script = ROOT / "scripts/bench_baab.py"
    if bench_script.exists():
        run_cmd([sys.executable, str(bench_script), "--self-test"], env=env)
    else:
        print("bench: no scripts/bench_baab.py configured; skipping.")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "stage",
        choices=("hygiene", "layers", "lint", "test", "headless", "ratchet", "bench", "all"),
    )
    parser.add_argument("--base", default=os.environ.get("BASE_SHA"), help="Base git ref for diff/layer checks")
    args = parser.parse_args()

    stacks = detect_stacks()
    env, scratch = scratch_env()
    try:
        if args.stage in ("hygiene", "all"):
            stage_hygiene(env)
        if args.stage in ("layers", "all"):
            stage_layers(env, args.base)
        if args.stage in ("lint", "all"):
            stage_lint(env, stacks)
        if args.stage in ("test", "all"):
            stage_test(env, stacks)
        if args.stage in ("headless", "all"):
            stage_headless(env)
        if args.stage in ("ratchet", "all"):
            stage_ratchet(env)
        if args.stage in ("bench", "all"):
            stage_bench(env)
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
