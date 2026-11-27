#!/usr/bin/env python3
"""Unit tests and negative controls for PR, layer, overlap, and ratchet governance scripts."""
from __future__ import annotations

from contextlib import redirect_stderr
from io import StringIO
from pathlib import Path
import os
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.check_layers import negative_control as layers_negative_control  # noqa: E402
from scripts.gh_ci import claim_command, diff_size  # noqa: E402
from scripts.gh_ci.diff_size import DiffSize, size_tier  # noqa: E402
from scripts.gh_ci.overlap_note import extract_modified_functions  # noqa: E402
from scripts.gh_ci.pr_check import FENCE, PrContext, validate_pr  # noqa: E402
from scripts.gh_ci.pr_labels import parse_checked_kinds  # noqa: E402
from scripts.ratchet_gate import count_unsafe_in_source, negative_control as ratchet_negative_control  # noqa: E402

HEAD = "1234567890abcdef1234567890abcdef12345678"


def make_valid_body(
    commit: str = HEAD,
    dirty: str = "false",
    net_loc: int = 240,
    size_just: str = "N/A (600 production Rust LOC or below)",
    other_loc: int = 18,
    not_tested: str = "Live AMDuProf hardware counters were not run on this runner.",
    extra: str = "",
) -> str:
    return f"""
## What and why
Implements deterministic Zen 2 pack bin-packing validation. Fixes #42.

## Goal alignment
- Goal ID: G-01 (goal:v0.1-foundation)
- Anti-Goals checked: AG-01..AG-10

## Diff budget and anti-golfing check
- [x] No compression macros were introduced to meet a line target.

## Size justification
{size_just}

## Tested
Ran `python scripts/pr_ready.py` (48 passed, 0 failed, 0 skipped).

## Not tested
{not_tested}

## Self-check
{FENCE}pr-ready
format: pr-ready v2
commit: {commit}
base: abcdef1234567890abcdef1234567890abcdef12
dirty: {dirty}
env: windows-amd64-py3.13-cpu12
files_changed: 3
net_prod_loc: {net_loc}
non_prod_loc: {other_loc}
moved_loc: 0
size_tier: {size_tier(net_loc)}
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
            diff=DiffSize(240, 18, 0, (), ()),
        )
        self.assertEqual(validate_pr(ctx), [])

    def test_rejects_stale_commit_sha(self) -> None:
        ctx = PrContext(
            body=make_valid_body(commit="deadbeef" * 5),
            head_sha=HEAD,
            changed_files=["crates/zen2top-core/src/packs.rs"],
            labels=set(),
            diff=DiffSize(240, 18, 0, (), ()),
        )
        errs = validate_pr(ctx)
        self.assertTrue(any("does not match PR head SHA" in e for e in errs))

    def test_rejects_dirty_working_tree(self) -> None:
        ctx = PrContext(
            body=make_valid_body(dirty="true"),
            head_sha=HEAD,
            changed_files=["crates/zen2top-core/src/packs.rs"],
            labels=set(),
            diff=DiffSize(240, 18, 0, (), ()),
        )
        errs = validate_pr(ctx)
        self.assertTrue(any("dirty working tree" in e for e in errs))

    def test_rejects_placeholder_not_tested(self) -> None:
        ctx = PrContext(
            body=make_valid_body(not_tested="N/A"),
            head_sha=HEAD,
            changed_files=["crates/zen2top-core/src/packs.rs"],
            labels=set(),
            diff=DiffSize(240, 18, 0, (), ()),
        )
        errs = validate_pr(ctx)
        self.assertTrue(any("Not tested" in e for e in errs))

    def test_production_thresholds_and_large_test_diff(self) -> None:
        rationale = "The externally visible entry point and its validation must ship together."
        cases = (
            (600, "N/A", set(), None),
            (601, "N/A", set(), "600 soft cap"),
            (601, rationale, set(), None),
            (900, rationale, set(), None),
            (901, rationale, set(), "900 hard cap"),
            (901, rationale, {"size/architect-waiver"}, None),
        )
        for loc, why, labels, error in cases:
            with self.subTest(loc=loc, labels=labels, why=why):
                ctx = PrContext(
                    make_valid_body(net_loc=loc, size_just=why, other_loc=4000),
                    HEAD, [], labels, DiffSize(loc, 4000, 0, (), ()),
                )
                errors = validate_pr(ctx)
                if error:
                    self.assertTrue(any(error in finding for finding in errors), errors)
                else:
                    self.assertEqual(errors, [])

    def test_partial_delivery_link(self) -> None:
        body = make_valid_body().replace("Fixes #42", "Part of #42")
        self.assertEqual(validate_pr(PrContext(body, HEAD, [], set(), DiffSize(240, 18, 0, (), ()))), [])

    def test_legacy_evidence_uses_live_production_size(self) -> None:
        body = make_valid_body().replace("pr-ready v2", "pr-ready v1").replace("net_prod_loc: 240", "net_loc: 490")
        standard = PrContext(body, HEAD, [], set(), DiffSize(320, 3000, 0, (), ()))
        self.assertTrue(any("pr-ready v2" in e for e in validate_pr(standard)))
        standard.allow_legacy_evidence = True
        self.assertEqual(validate_pr(standard), [])
        standard.diff = DiffSize(950, 0, 0, (), ())
        self.assertTrue(any("900 hard cap" in e for e in validate_pr(standard)))

    def test_production_count_is_checked_against_commit_diff(self) -> None:
        ctx = PrContext(make_valid_body(), HEAD, [], set(), DiffSize(241, 18, 0, (), ()))
        self.assertTrue(any("CI measured 241" in e for e in validate_pr(ctx)))

    def test_forbids_worker_edits_to_handoff_md(self) -> None:
        ctx = PrContext(body=make_valid_body(), head_sha=HEAD, changed_files=["HANDOFF.md"], labels=set(),
                        diff=DiffSize(240, 18, 0, (), ()))
        self.assertTrue(any("HANDOFF.md" in e for e in validate_pr(ctx)))

    def test_rejects_slower_baab_without_override_label(self) -> None:
        baab = f"\n{FENCE}baab\nformat: baab v1\nhead_sha: {HEAD}\ndirty: false\nverdict: slower\n{FENCE}\n"
        ctx = PrContext(
            body=make_valid_body(extra=baab),
            head_sha=HEAD,
            changed_files=["crates/zen2top-core/src/csv_parser.rs"],
            labels=set(),
            diff=DiffSize(240, 18, 0, (), ()),
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



class DiffSizeTests(unittest.TestCase):
    def test_moves_count_only_contiguous_blocks(self) -> None:
        block = ["first();", "second();", "third();"]
        self.assertEqual(diff_size.moved_line_count(block, block), 6)
        self.assertEqual(diff_size.moved_line_count(block, [block[0], None, *block[1:]]), 0)

    def test_git_diff_classifies_paths_and_checks_added_source(self) -> None:
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)

            def git(*args: str) -> str:
                return subprocess.run(
                    ["git", "--literal-pathspecs", *args], cwd=root,
                    capture_output=True, check=True, encoding="utf-8",
                ).stdout

            git("init", "-q")
            git("config", "user.name", "Gate Test")
            git("config", "user.email", "test@example.invalid")
            git("config", "commit.gpgsign", "false")
            git("commit", "-qm", "base", "--allow-empty")
            source = {
                "crates/core/src/lib.rs": (
                    'const EXAMPLE: &str = r#"macro_rules! fake; foo; bar;"#;\n'
                    '/* macro_rules! also_fake; a; b; */\n'
                    'macro_rules! real { () => {} }\n'
                    'fn work() { first(); second(); }\n'
                    'fn array() { let a = [0; 4]; }\n'
                ),
                "crates/core/src/internal/tests/fixtures.rs": "// fixture\n" * 611,
                "crates/core/tests/suite.rs": "// test\n" * 1200,
                "prototype/src/demo.rs": "// prototype\n",
                "docs/design.md": "# Design\n",
                "Cargo.lock": "# Lock\n",
            }
            for name, contents in source.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(contents, encoding="utf-8")
            git("add", ".")
            git("commit", "-qm", "head")
            with patch.object(diff_size, "git", side_effect=git):
                diff = diff_size.measure_diff("HEAD^")
            self.assertEqual((diff.production, diff.other), (5, 1814))
            self.assertEqual(len(diff.warnings), 2)
            self.assertIn("lib.rs:3: inspect new macro_rules!", diff.warnings[0])
            self.assertIn("lib.rs:4: inspect multiple semicolons", diff.warnings[1])


class ClaimQueueTests(unittest.TestCase):
    def test_gh_logs_each_error_line_and_propagates_failure(self) -> None:
        error = subprocess.CalledProcessError(
            1, ["gh", "api"],
            stderr="gh: Resource not accessible (HTTP 403)\n::error::Remote detail\n##[error]Remote detail\n",
        )
        stderr = StringIO()
        with patch.object(claim_command.subprocess, "run", side_effect=error), redirect_stderr(stderr):
            with self.assertRaises(subprocess.CalledProcessError) as raised:
                claim_command.gh("api", "repos/owner/repo/issues/123/labels")
        self.assertIs(raised.exception, error)
        self.assertEqual(stderr.getvalue().splitlines(), [
            "claim_command: gh: Resource not accessible (HTTP 403)",
            "claim_command: ::error::Remote detail",
            r"claim_command: ##\[error]Remote detail",
        ])

    def test_claim_only_matches_the_correct_queue_and_item(self) -> None:
        body = "## 1. Verify\n| #123 | #8 |\n## 2. Fix\n| #12 | #8 |\n## 3. Implement\n| #8 |"
        self.assertTrue(claim_command.queue_contains(body, "review", "123"))
        self.assertFalse(claim_command.queue_contains(body, "review", "12"))
        self.assertTrue(claim_command.queue_contains(body, "fix", "12"))
        self.assertTrue(claim_command.queue_contains(body, "implement", "8"))


    def test_two_sessions_sharing_a_login_cannot_both_claim_a_pr(self) -> None:
        labels = [{"name": "needs-review"}]
        comments = []

        def fake_api(repo: str, endpoint: str) -> dict:
            if endpoint == "issues/123":
                return {"state": "open", "labels": labels, "pull_request": {}}
            self.assertEqual(endpoint, "pulls/123")
            return {"draft": False}

        def fake_pages(repo: str, endpoint: str) -> list[dict]:
            if endpoint.startswith("issues?"):
                return [{"body": "**Stage Gate:** `active`\n## 1. Verify\n| #123 | #8 |"}]
            return comments

        def fake_gh(*args: str) -> str:
            if args[-1] == "labels[]=review-in-progress":
                labels.append({"name": "review-in-progress"})
            elif args[-1].startswith("body="):
                comments.append({"user": {"login": "github-actions[bot]"}, "body": args[-1][5:]})
            return ""

        env = dict(REPO="owner/repo", ISSUE="123", AUTHOR="shared", ASSOCIATION="OWNER", MODE="active")
        with patch.dict(os.environ, env), patch.object(claim_command, "api", side_effect=fake_api), \
             patch.object(claim_command, "pages", side_effect=fake_pages), \
             patch.object(claim_command, "gh", side_effect=fake_gh):
            os.environ["BODY"] = "/claim-review first-token"
            self.assertEqual(claim_command.main(), 0)
            os.environ["BODY"] = "/claim-review second-token"
            self.assertEqual(claim_command.main(), 0)
        self.assertEqual(len(labels), 2)
        self.assertIn("Claim granted for `first-token`", comments[0]["body"])
        self.assertIn("Claim denied for `second-token`", comments[1]["body"])

    def test_touch_scope_detects_path_and_directory_collisions(self) -> None:
        scope = claim_command.touch_scope("### Touch Scope\n- `crates/core/src/`\n\n### Depends On\n- `other.rs`")
        self.assertEqual(scope, {"crates/core/src/"})
        self.assertTrue(claim_command.overlaps(scope, {"crates/core/src/lib.rs"}))
        self.assertFalse(claim_command.overlaps(scope, {"crates/core/src2/lib.rs"}))

if __name__ == "__main__":
    unittest.main()
