#!/usr/bin/env python3
"""Unit tests and negative controls for PR, layer, overlap, and ratchet governance scripts."""
from __future__ import annotations

from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.check_layers import negative_control as layers_negative_control  # noqa: E402
from scripts.gh_ci.overlap_note import extract_modified_functions  # noqa: E402
from scripts.gh_ci.pr_check import FENCE, PrContext, validate_pr  # noqa: E402
from scripts.gh_ci.pr_labels import parse_checked_kinds  # noqa: E402
from scripts.ratchet_gate import count_unsafe_in_source, negative_control as ratchet_negative_control  # noqa: E402

HEAD = "1234567890abcdef1234567890abcdef12345678"


def make_valid_body(
    commit: str = HEAD,
    dirty: str = "false",
    net_loc: int = 240,
    size_tier: str = "standard",
    size_just: str = "N/A (<= 500 net LOC)",
    not_tested: str = "Live AMDuProf hardware counters were not run on this runner.",
    extra: str = "",
) -> str:
    return f"""
## What and why
Implements deterministic Zen 2 pack bin-packing validation. Fixes #42.

## Goal alignment
- Goal ID: G-01 (goal:v0.1-foundation)
- Anti-Goals checked: AG-01..AG-10

## Size justification
{size_just}

## Tested
Ran `python scripts/pr_ready.py` (48 passed, 0 failed, 0 skipped).

## Not tested
{not_tested}

## Self-check
{FENCE}pr-ready
format: pr-ready v1
commit: {commit}
base: abcdef1234567890abcdef1234567890abcdef12
dirty: {dirty}
env: windows-amd64-py3.13-cpu12
files_changed: 3
net_loc: {net_loc}
moved_loc: 0
size_tier: {size_tier}
lockfile: PASS
hygiene: PASS
layers: PASS
lint: PASS
tests: PASS
headless: PASS
ratchet: PASS
flake_3x: PASS
overall: PASS
{FENCE}
{extra}

## AI use
🤖 Agent: Worker | Gemini 4 Neon via CLI: implemented pack bin-packer and unit tests.
"""


class PrCheckTests(unittest.TestCase):
    def test_valid_standard_pr_passes(self) -> None:
        ctx = PrContext(
            body=make_valid_body(),
            head_sha=HEAD,
            changed_files=["crates/zen2top-core/src/packs.rs"],
            labels={"goal:v0.1-foundation"},
            actual_net_loc=240,
        )
        self.assertEqual(validate_pr(ctx), [])

    def test_rejects_stale_commit_sha(self) -> None:
        ctx = PrContext(
            body=make_valid_body(commit="deadbeef" * 5),
            head_sha=HEAD,
            changed_files=["crates/zen2top-core/src/packs.rs"],
            labels=set(),
        )
        errs = validate_pr(ctx)
        self.assertTrue(any("does not match PR head SHA" in e for e in errs))

    def test_rejects_dirty_working_tree(self) -> None:
        ctx = PrContext(
            body=make_valid_body(dirty="true"),
            head_sha=HEAD,
            changed_files=["crates/zen2top-core/src/packs.rs"],
            labels=set(),
        )
        errs = validate_pr(ctx)
        self.assertTrue(any("dirty working tree" in e for e in errs))

    def test_rejects_placeholder_not_tested(self) -> None:
        ctx = PrContext(
            body=make_valid_body(not_tested="N/A"),
            head_sha=HEAD,
            changed_files=["crates/zen2top-core/src/packs.rs"],
            labels=set(),
        )
        errs = validate_pr(ctx)
        self.assertTrue(any("Not tested" in e for e in errs))

    def test_soft_cap_501_to_600_requires_concrete_justification(self) -> None:
        bad = PrContext(
            body=make_valid_body(net_loc=540, size_tier="justification-required", size_just="N/A"),
            head_sha=HEAD,
            changed_files=["crates/zen2top-core/src/packs.rs"],
            labels=set(),
            actual_net_loc=540,
        )
        self.assertTrue(any("500 soft cap" in e for e in validate_pr(bad)))

        good = PrContext(
            body=make_valid_body(
                net_loc=540,
                size_tier="justification-required",
                size_just="Splitting the FFD bin-packer from its invariant validator would leave half-wired pack state.",
            ),
            head_sha=HEAD,
            changed_files=["crates/zen2top-core/src/packs.rs"],
            labels=set(),
            actual_net_loc=540,
        )
        self.assertEqual(validate_pr(good), [])

    def test_hard_cap_over_600_requires_spec_link(self) -> None:
        bad = PrContext(
            body=make_valid_body(net_loc=650, size_tier="spec-required"),
            head_sha=HEAD,
            changed_files=["crates/zen2top-core/src/packs.rs"],
            labels=set(),
            actual_net_loc=650,
        )
        self.assertTrue(any("600 LOC hard cap" in e for e in validate_pr(bad)))

        good = PrContext(
            body=make_valid_body(net_loc=650, size_tier="spec-required", extra="\nSpec: #10\n"),
            head_sha=HEAD,
            changed_files=["crates/zen2top-core/src/packs.rs"],
            labels=set(),
            actual_net_loc=650,
        )
        self.assertEqual(validate_pr(good), [])

    def test_forbids_worker_edits_to_handoff_md(self) -> None:
        ctx = PrContext(body=make_valid_body(), head_sha=HEAD, changed_files=["HANDOFF.md"], labels=set())
        self.assertTrue(any("HANDOFF.md" in e for e in validate_pr(ctx)))

    def test_rejects_slower_baab_without_override_label(self) -> None:
        baab = f"\n{FENCE}baab\nformat: baab v1\nhead_sha: {HEAD}\ndirty: false\nverdict: slower\n{FENCE}\n"
        ctx = PrContext(
            body=make_valid_body(extra=baab),
            head_sha=HEAD,
            changed_files=["crates/zen2top-core/src/csv_parser.rs"],
            labels=set(),
        )
        self.assertTrue(any("perf-override-approved" in e for e in validate_pr(ctx)))


class GovernanceHelpersTests(unittest.TestCase):
    def test_layers_and_ratchet_negative_controls_pass(self) -> None:
        self.assertTrue(layers_negative_control())
        self.assertTrue(ratchet_negative_control())

    def test_safety_comment_detection_on_platform_unsafe(self) -> None:
        src = (
            "// SAFETY: valid handle obtained from OpenProcess.\n"
            "unsafe { CloseHandle(h) };\n"
            "unsafe { raw_call() };\n"
        )
        self.assertEqual(count_unsafe_in_source(src), (2, 1))

    def test_overlap_note_extracts_rust_function_hunk(self) -> None:
        diff = (
            "diff --git a/crates/zen2top-core/src/packs.rs b/crates/zen2top-core/src/packs.rs\n"
            "+++ b/crates/zen2top-core/src/packs.rs\n"
            "@@ -10,3 +10,3 @@ pub fn pack_events(selected: &[Pack]) -> Vec<Bin> {\n"
            "-    let cap = 6;\n"
            "+    let cap = 6usize;\n"
        )
        self.assertEqual(
            extract_modified_functions(diff),
            {("crates/zen2top-core/src/packs.rs", "pack_events")},
        )

    def test_pr_labels_parses_checked_kind(self) -> None:
        body = "- [ ] bug: crash\n- [x] feature: new pack\n- [X] perf: fast parser\n"
        self.assertEqual(parse_checked_kinds(body), ["feature", "perf"])


if __name__ == "__main__":
    unittest.main()
