#!/usr/bin/env python3
"""Universal commit-bound B A A B interleaved block benchmark runner and Hodges-Lehmann / Wilcoxon evaluator.

Usage:
    # Run built-in statistical and state-reset verification suite:
    python scripts/bench_baab.py --self-test

    # Compare baseline command A vs candidate command B (8 pairs = 16 blocks in B A A B order):
    python scripts/bench_baab.py \
        --name "csv_parse_1000" \
        --profile release \
        --cmd-a "./.local/bench-target-a/release/bench_probe" \
        --cmd-b "./.local/bench-target-b/release/bench_probe" \
        --pairs 8 --samples-per-block 30 --warmup-samples 5 \
        --out benchmarks/latest-baab.json
"""
from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass
import datetime
import json
import math
import os
from pathlib import Path
import platform
import re
import shlex
import statistics
import subprocess
import sys
import time

if os.name == "nt":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[1]
FLOAT_RE = re.compile(r"[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?")
FENCE = "`" * 3


@dataclass
class AbResult:
    metric: str
    unit: str
    pairs: int
    a_median: float
    b_median: float
    diff: float
    diff_pct: float | None
    ci95: list[float] | None
    confidence: float | None
    noise: float
    first_block_outside_range: bool
    verdict: str


def git_meta(base_ref: str = "origin/main") -> tuple[str, str, bool]:
    """Return (head_sha, base_sha, is_dirty); fall back cleanly outside git repos."""
    try:
        head = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True
        ).stdout.strip()
        dirty = bool(
            subprocess.run(["git", "status", "--porcelain"], cwd=ROOT, capture_output=True, text=True, check=True)
            .stdout.strip()
        )
        base = "unknown"
        for ref in (base_ref, "main", "master", "HEAD"):
            mb = subprocess.run(["git", "merge-base", ref, "HEAD"], cwd=ROOT, capture_output=True, text=True)
            if mb.returncode == 0:
                base = mb.stdout.strip()
                break
        return head, base, dirty
    except (subprocess.SubprocessError, FileNotFoundError):
        return "unknown", "unknown", True


def env_string(profile: str) -> str:
    return f"{platform.system().lower()}-{platform.machine().lower()}-cpu{os.cpu_count() or 0}-{profile}"


def wilcoxon_k_and_confidence(n: int, alpha_two_sided: float = 0.05) -> tuple[int, float] | None:
    """Exact Wilcoxon signed-rank critical rank k (1-indexed) and confidence level for N pairs."""
    if n < 6:
        return None
    max_t = n * (n + 1) // 2
    dp = [0] * (max_t + 1)
    dp[0] = 1
    for rank in range(1, n + 1):
        for s in range(max_t, rank - 1, -1):
            dp[s] += dp[s - rank]
    total = 1 << n
    target_tail = alpha_two_sided / 2.0
    cum = 0
    best_k = 0
    best_tail = 0.0
    for t_val in range(max_t + 1):
        cum += dp[t_val]
        tail = cum / total
        if tail <= target_tail:
            best_k = t_val + 1
            best_tail = tail
        else:
            break
    if best_k == 0:
        return 1, 1.0 - 2.0 * (dp[0] / total)
    return best_k, round(1.0 - 2.0 * best_tail, 4)


def evaluate_baab(
    blocks: list[tuple[str, float]],
    metric: str = "latency",
    unit: str = "ms",
    abs_floor: float = 0.05,
    rel_floor: float = 0.02,
) -> AbResult:
    """Evaluate a sequence of [('B', val), ('A', val), ('A', val), ('B', val), ...] blocks."""
    if len(blocks) % 2 != 0:
        raise ValueError("blocks length must be even (2 * pairs)")
    pairs = len(blocks) // 2
    a_vals: list[float] = []
    b_vals: list[float] = []
    pair_diffs: list[float] = []

    for p in range(pairs):
        arm0, v0 = blocks[2 * p]
        arm1, v1 = blocks[2 * p + 1]
        if {arm0, arm1} != {"A", "B"}:
            raise ValueError(f"Pair {p} must contain one 'A' and one 'B' block, got {arm0}, {arm1}")
        a_v = v0 if arm0 == "A" else v1
        b_v = v0 if arm0 == "B" else v1
        a_vals.append(a_v)
        b_vals.append(b_v)
        pair_diffs.append(b_v - a_v)

    a_med = statistics.median(a_vals)
    b_med = statistics.median(b_vals)

    walsh = sorted(
        (pair_diffs[i] + pair_diffs[j]) / 2.0
        for i in range(pairs)
        for j in range(i, pairs)
    )
    hl_diff = statistics.median(walsh)
    diff_pct = (hl_diff / a_med * 100.0) if a_med != 0 else None

    same_arm_dists = [
        abs(blocks[i + 1][1] - blocks[i][1])
        for i in range(1, len(blocks) - 1, 2)
        if blocks[i][0] == blocks[i + 1][0]
    ]
    noise = statistics.median(same_arm_dists) if same_arm_dists else 0.0

    first_b = blocks[0][1] if blocks[0][0] == "B" else b_vals[0]
    later_b = b_vals[1:]
    first_outside = bool(later_b and (first_b < min(later_b) or first_b > max(later_b)))

    wk = wilcoxon_k_and_confidence(pairs)
    if wk is None:
        return AbResult(
            metric=metric,
            unit=unit,
            pairs=pairs,
            a_median=round(a_med, 4),
            b_median=round(b_med, 4),
            diff=round(hl_diff, 4),
            diff_pct=round(diff_pct, 2) if diff_pct is not None else None,
            ci95=None,
            confidence=None,
            noise=round(noise, 4),
            first_block_outside_range=first_outside,
            verdict="too_few_pairs",
        )

    k, conf = wk
    m = len(walsh)
    ci_low, ci_high = walsh[k - 1], walsh[m - k]

    if ci_low <= 0.0 <= ci_high:
        verdict = "within_noise"
    elif abs(hl_diff) < max(abs_floor, rel_floor * abs(a_med)):
        verdict = "negligible"
    elif ci_low > 0.0:
        verdict = "slower"
    else:
        verdict = "faster"

    return AbResult(
        metric=metric,
        unit=unit,
        pairs=pairs,
        a_median=round(a_med, 4),
        b_median=round(b_med, 4),
        diff=round(hl_diff, 4),
        diff_pct=round(diff_pct, 2) if diff_pct is not None else None,
        ci95=[round(ci_low, 4), round(ci_high, 4)],
        confidence=conf,
        noise=round(noise, 4),
        first_block_outside_range=first_outside,
        verdict=verdict,
    )


def measure_one_sample(cmd: str) -> float:
    """Run cmd once; if stdout ends with a number or JSON {'value': X}, use it; else use wall time in ms."""
    args = shlex.split(cmd, posix=(sys.platform != "win32"))
    t0 = time.perf_counter()
    res = subprocess.run(args, capture_output=True, text=True, check=True)
    wall_ms = (time.perf_counter() - t0) * 1000.0
    lines = [line.strip() for line in res.stdout.splitlines() if line.strip()]
    if lines:
        last = lines[-1]
        if last.startswith("{"):
            try:
                data = json.loads(last)
                if isinstance(data, dict) and "value" in data:
                    return float(data["value"])
            except ValueError:
                pass
        if m := FLOAT_RE.fullmatch(last):
            return float(m.group(0))
    return wall_ms


def run_baab_schedule(
    cmd_a: str,
    cmd_b: str,
    pairs: int = 8,
    samples_per_block: int = 15,
    warmup_samples: int = 3,
) -> list[tuple[str, float]]:
    blocks: list[tuple[str, float]] = []
    for p in range(pairs):
        order = ("B", "A") if p % 2 == 0 else ("A", "B")
        for arm in order:
            cmd = cmd_a if arm == "A" else cmd_b
            for _ in range(warmup_samples):
                measure_one_sample(cmd)
            samples = [measure_one_sample(cmd) for _ in range(samples_per_block)]
            blocks.append((arm, statistics.median(samples)))
    return blocks


def format_markdown_report(
    name: str,
    res: AbResult,
    head_sha: str,
    base_sha: str,
    dirty: bool,
    profile: str,
) -> str:
    ci_str = f"[{res.ci95[0]:+.4f}, {res.ci95[1]:+.4f}]" if res.ci95 else "N/A"
    pct_str = f"{res.diff_pct:+.2f}%" if res.diff_pct is not None else "N/A"
    reset_note = " (WARN: `first_block_outside_range=true`)" if res.first_block_outside_range else ""
    lines = [
        f"### `B A A B` Benchmark Report: `{name}`",
        "",
        "| Metric | Pairs | Baseline `A` (median) | Candidate `B` (median) | Hodges-Lehmann `diff` (`B - A`) | 95% Wilcoxon CI | Same-Arm Noise | Verdict |",
        "| :--- | ---: | ---: | ---: | ---: | :---: | ---: | :--- |",
        f"| `{res.metric}` ({res.unit}) | {res.pairs} | `{res.a_median:.4f}` | `{res.b_median:.4f}` | `{res.diff:+.4f}` ({pct_str}) | `{ci_str}` | `{res.noise:.4f}` | **`{res.verdict}`**{reset_note} |",
        "",
        f"{FENCE}baab",
        "format: baab v1",
        f"name: {name}",
        f"base_sha: {base_sha}",
        f"head_sha: {head_sha}",
        f"dirty: {'true' if dirty else 'false'}",
        f"env: {env_string(profile)}",
        f"pairs: {res.pairs}",
        f"diff: {res.diff:+.4f} {res.unit}",
        f"ci95: {ci_str}",
        f"verdict: {res.verdict}",
        FENCE,
    ]
    return "\n".join(lines)


def self_test() -> int:
    drift_blocks: list[tuple[str, float]] = []
    for p in range(8):
        order = ("B", "A") if p % 2 == 0 else ("A", "B")
        for idx, arm in enumerate(order):
            t = 2 * p + idx
            drift_blocks.append((arm, 10.0 + 0.1 * t))
    r_drift = evaluate_baab(drift_blocks)
    assert abs(r_drift.diff) < 1e-9, f"Expected drift cancellation diff=0, got {r_drift.diff}"
    assert r_drift.verdict == "within_noise", f"Expected within_noise, got {r_drift.verdict}"

    reg_blocks: list[tuple[str, float]] = []
    for p in range(8):
        order = ("B", "A") if p % 2 == 0 else ("A", "B")
        for arm in order:
            reg_blocks.append((arm, 10.0 if arm == "A" else 11.5))
    r_reg = evaluate_baab(reg_blocks)
    assert r_reg.verdict == "slower", f"Expected slower, got {r_reg.verdict}"
    assert math.isclose(r_reg.diff, 1.5, abs_tol=1e-6)

    fast_blocks = [(arm, 10.0 if arm == "A" else 8.8) for arm, _ in reg_blocks]
    fast_blocks[0] = ("B", 7.2)
    r_fast = evaluate_baab(fast_blocks)
    assert r_fast.verdict == "faster", f"Expected faster, got {r_fast.verdict}"
    assert r_fast.first_block_outside_range is True

    print("bench_baab: self-test passed (drift cancellation, Wilcoxon CI, slower/faster verdicts, state-reset check).")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true", help="Run built-in statistical verification")
    parser.add_argument("--name", default="hot_path")
    parser.add_argument("--metric", default="latency")
    parser.add_argument("--unit", default="ms")
    parser.add_argument("--profile", default="release", help="Build profile used for both arms (e.g. release)")
    parser.add_argument("--base", default="origin/main", help="Git ref for baseline arm A")
    parser.add_argument("--cmd-a", help="Baseline A command")
    parser.add_argument("--cmd-b", help="Candidate B command")
    parser.add_argument("--pairs", type=int, default=8)
    parser.add_argument("--samples-per-block", type=int, default=15)
    parser.add_argument("--warmup-samples", type=int, default=3)
    parser.add_argument("--abs-floor", type=float, default=0.05)
    parser.add_argument("--rel-floor", type=float, default=0.02)
    parser.add_argument("--allow-slower", action="store_true", help="Set only when perf-override-approved is present")
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args()

    if args.self_test:
        return self_test()

    if not args.cmd_a or not args.cmd_b:
        parser.error("--cmd-a and --cmd-b are required unless --self-test is used")

    head_sha, base_sha, dirty = git_meta(args.base)
    blocks = run_baab_schedule(
        args.cmd_a,
        args.cmd_b,
        pairs=args.pairs,
        samples_per_block=args.samples_per_block,
        warmup_samples=args.warmup_samples,
    )
    res = evaluate_baab(
        blocks,
        metric=args.metric,
        unit=args.unit,
        abs_floor=args.abs_floor,
        rel_floor=args.rel_floor,
    )
    md = format_markdown_report(
        args.name, res, head_sha=head_sha, base_sha=base_sha, dirty=dirty, profile=args.profile
    )
    print(md)

    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "format": "agent-baab-benchmark-report",
            "version": 2,
            "name": args.name,
            "base_sha": base_sha,
            "head_sha": head_sha,
            "dirty": dirty,
            "profile": args.profile,
            "created": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
            "hardware": {
                "os": platform.system().lower(),
                "arch": platform.machine(),
                "cpu_count": os.cpu_count(),
                "env": env_string(args.profile),
            },
            "blocks": [{"arm": arm, "value": round(val, 4)} for arm, val in blocks],
            "ab": asdict(res),
        }
        args.out.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

    if res.verdict == "slower" and not args.allow_slower:
        print(
            "\n::error::B A A B benchmark detected a statistically significant regression (verdict: slower). "
            "Optimize the hot path or follow the Intentional Overhead Protocol and obtain 'perf-override-approved'.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
