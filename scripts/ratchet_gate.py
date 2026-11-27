#!/usr/bin/env python3
"""Monotonic quality and capability ratchet gate with scoped unsafe/SAFETY enforcement and live negative control.

Policy:
- `test_functions` (floor): Must never drop below tests/data/ratchet-baseline.json.
- `core_cli_unsafe_blocks` (ceiling = 0): `crates/zen2top-core` and `crates/zen2top-cli` must remain 100% safe Rust.
- `platform_undocumented_unsafe` (ceiling = 0): Every `unsafe` block/fn/impl/trait in `crates/zen2top-platform`
  must have a `// SAFETY:` comment in its immediately preceding comment block.
- `lint_suppressions` (ceiling): Non-test `#[allow(...)]` count across workspace crates must not increase.
- `third_party/` and `prototype/` are excluded from workspace ratchet metrics.

Usage:
    python scripts/ratchet_gate.py
    python scripts/ratchet_gate.py --update-baseline
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys

if os.name == "nt":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[1]
BASELINE_PATH = ROOT / "tests/data/ratchet-baseline.json"

TEST_FN_RE = re.compile(r"(?m)^\s*#\[test\]")
UNSAFE_LINE_RE = re.compile(r"\bunsafe\s*(?:\{|fn\b|impl\b|trait\b)")
SUPPRESS_RE = re.compile(r"#\[allow\(")
SAFETY_COMMENT_RE = re.compile(r"//\s*SAFETY:")
CFG_TEST_RE = re.compile(r"^\s*#\[cfg\(test\)\]")

ZERO_UNSAFE_PREFIXES = ("crates/zen2top-core/", "crates/zen2top-cli/")
PLATFORM_PREFIX = "crates/zen2top-platform/"


def strip_line_comment(line: str) -> str:
    idx = line.find("//")
    return line[:idx] if idx >= 0 else line


def count_unsafe_in_source(text: str) -> tuple[int, int]:
    """Return (total_unsafe, undocumented_unsafe) for a Rust source file.

    A `// SAFETY:` comment satisfies an `unsafe` line when it appears in the contiguous
    comment/attribute/blank header immediately preceding the `unsafe` line (or on the same line).
    """
    lines = text.splitlines()
    total = 0
    undocumented = 0
    for i, raw in enumerate(lines):
        code = strip_line_comment(raw)
        if not UNSAFE_LINE_RE.search(code):
            continue
        total += 1
        if SAFETY_COMMENT_RE.search(raw):
            continue
        found_safety = False
        j = i - 1
        while j >= 0:
            prev = lines[j].strip()
            if not prev:
                j -= 1
                continue
            if prev.startswith("//") or prev.startswith("#["):
                if SAFETY_COMMENT_RE.search(prev):
                    found_safety = True
                    break
                j -= 1
                continue
            break
        if not found_safety:
            undocumented += 1
    return total, undocumented


def count_non_test_suppressions(text: str) -> int:
    """Count `#[allow(...)]` occurrences outside `#[cfg(test)]` tail sections."""
    lines = text.splitlines()
    in_cfg_test = False
    count = 0
    for line in lines:
        if CFG_TEST_RE.match(line):
            in_cfg_test = True
        if not in_cfg_test:
            count += len(SUPPRESS_RE.findall(strip_line_comment(line)))
    return count


def tracked_workspace_rust_files(root: Path = ROOT) -> list[tuple[str, Path]]:
    res = subprocess.run(["git", "ls-files", "-z"], cwd=root, capture_output=True, check=True)
    out: list[tuple[str, Path]] = []
    for rel in filter(None, res.stdout.decode("utf-8").split("\0")):
        if not rel.startswith("crates/") or not rel.endswith(".rs"):
            continue
        p = root / rel
        if p.exists():
            out.append((rel, p))
    return out


def measure_metrics(root: Path = ROOT) -> dict[str, int]:
    test_fns = 0
    core_cli_unsafe = 0
    platform_undoc_unsafe = 0
    lint_suppressions = 0

    for rel, path in tracked_workspace_rust_files(root):
        text = path.read_text(encoding="utf-8", errors="replace")
        test_fns += len(TEST_FN_RE.findall(text))
        if "/tests/" not in rel:
            lint_suppressions += count_non_test_suppressions(text)
        total_u, undoc_u = count_unsafe_in_source(text)
        if rel.startswith(ZERO_UNSAFE_PREFIXES):
            core_cli_unsafe += total_u
        elif rel.startswith(PLATFORM_PREFIX):
            platform_undoc_unsafe += undoc_u

    return {
        "test_functions": test_fns,
        "core_cli_unsafe_blocks": core_cli_unsafe,
        "platform_undocumented_unsafe": platform_undoc_unsafe,
        "lint_suppressions": lint_suppressions,
    }


def evaluate_ratchet(baseline: dict, current: dict[str, int]) -> list[str]:
    errors: list[str] = []
    for key, floor in baseline.get("min_metrics", {}).items():
        if key not in current:
            errors.append(f"ratchet: missing measured min_metric `{key}` (fail-closed)")
        elif current[key] < floor:
            errors.append(f"ratchet regression: `{key}` dropped from {floor} to {current[key]}")
    for key, ceiling in baseline.get("max_metrics", {}).items():
        if key not in current:
            errors.append(f"ratchet: missing measured max_metric `{key}` (fail-closed)")
        elif current[key] > ceiling:
            errors.append(f"ratchet regression: `{key}` increased from {ceiling} to {current[key]}")
    return errors


def negative_control() -> bool:
    sample_base = {
        "min_metrics": {"test_functions": 10},
        "max_metrics": {
            "core_cli_unsafe_blocks": 0,
            "platform_undocumented_unsafe": 0,
            "lint_suppressions": 0,
        },
    }
    sample_bad = {
        "test_functions": 8,
        "core_cli_unsafe_blocks": 1,
        "platform_undocumented_unsafe": 2,
        "lint_suppressions": 1,
    }
    if len(evaluate_ratchet(sample_base, sample_bad)) != 4:
        return False

    documented_sample = (
        "// SAFETY: handle is valid for the duration of this call.\n"
        "#[inline]\n"
        "unsafe { close_handle(h); }\n"
    )
    undocumented_sample = "fn bad() {\n    unsafe { close_handle(h); }\n}\n"
    if count_unsafe_in_source(documented_sample) != (1, 0):
        return False
    if count_unsafe_in_source(undocumented_sample) != (1, 1):
        return False
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, default=BASELINE_PATH)
    parser.add_argument("--update-baseline", action="store_true")
    args = parser.parse_args()

    if not negative_control():
        print("ratchet_gate: negative_control() failed!", file=sys.stderr)
        return 1

    current = measure_metrics(ROOT)
    if args.update_baseline:
        args.baseline.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "version": 1,
            "min_metrics": {"test_functions": current["test_functions"]},
            "max_metrics": {
                "core_cli_unsafe_blocks": current["core_cli_unsafe_blocks"],
                "platform_undocumented_unsafe": current["platform_undocumented_unsafe"],
                "lint_suppressions": current["lint_suppressions"],
            },
        }
        args.baseline.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        print(f"ratchet_gate: updated {args.baseline} -> {current}")
        return 0

    if not args.baseline.exists():
        print(f"ratchet_gate: negative_control passed (no baseline file at {args.baseline} yet; measured={current}).")
        return 0

    baseline = json.loads(args.baseline.read_text(encoding="utf-8"))
    errors = evaluate_ratchet(baseline, current)
    for err in errors:
        print(f"::error::{err}", file=sys.stderr)
    if errors:
        return 1
    print(f"ratchet_gate: PASS ({current}; negative control passed).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
