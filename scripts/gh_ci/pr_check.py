#!/usr/bin/env python3
"""Fail-closed pull request body, commit-bound evidence, size-cap, and file-boundary gate."""
from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
import sys

if os.name == "nt":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

if __package__:
    from .diff_size import HARD_CAP, SOFT_CAP, WAIVER, DiffSize, git, measure_diff, size_tier
else:
    from diff_size import HARD_CAP, SOFT_CAP, WAIVER, DiffSize, git, measure_diff, size_tier
FENCE = "`" * 3

HTML_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)
HEADING_RE = re.compile(r"^##\s+(.+?)\s*$", re.MULTILINE)
SPEC_LINK_RE = re.compile(r"\bSpec:\s*#\d+\b", re.IGNORECASE)
FIXES_LINK_RE = re.compile(r"\b(?:Fixes|Closes|Resolves|Part of)\s+#\d+\b", re.IGNORECASE)
GOAL_ID_RE = re.compile(r"\b(?:G-\d+|off-goal)\b", re.IGNORECASE)
AI_MARK_RE = re.compile(r"🤖\s*Agent:\s*(?!<model>)(?!<Role>).{12,}")
PLACEHOLDER_RE = re.compile(
    r"^(?:n/?a|none|tbd|todo|placeholder|-|\*|\.\.\.|<[^>]+>|fixes\s*#?)$",
    re.IGNORECASE,
)

REQUIRED_PR_READY_KEYS = (
    "format",
    "commit",
    "base",
    "dirty",
    "env",
    "size_tier",
    "lockfile",
    "hygiene",
    "layers",
    "lint",
    "tests",
    "headless",
    "ratchet",
    "flake_3x",
    "overall",
)
REQUIRED_PASS_GATES = (
    "lockfile",
    "hygiene",
    "layers",
    "lint",
    "tests",
    "headless",
    "ratchet",
    "flake_3x",
    "overall",
)


@dataclass
class PrContext:
    body: str
    head_sha: str
    changed_files: list[str]
    labels: set[str]
    diff: DiffSize
    allow_legacy_evidence: bool = False


def strip_comments(text: str) -> str:
    return HTML_COMMENT_RE.sub("", text)


def parse_sections(body: str) -> dict[str, str]:
    cleaned = strip_comments(body)
    matches = list(HEADING_RE.finditer(cleaned))
    sections: dict[str, str] = {}
    for idx, match in enumerate(matches):
        name = match.group(1).strip().lower()
        start = match.end()
        end = matches[idx + 1].start() if idx + 1 < len(matches) else len(cleaned)
        sections[name] = cleaned[start:end].strip()
    return sections


def extract_fenced_kv(text: str, fence_lang: str) -> dict[str, str] | None:
    pattern = re.compile(
        r"^" + re.escape(FENCE) + re.escape(fence_lang) + r"\s*\n(.*?)\n" + re.escape(FENCE) + r"\s*$",
        re.MULTILINE | re.DOTALL,
    )
    m = pattern.search(text)
    if not m:
        return None
    kv: dict[str, str] = {}
    for raw_line in m.group(1).splitlines():
        line = raw_line.strip()
        if not line or ":" not in line:
            continue
        key, val = line.split(":", 1)
        kv[key.strip().lower()] = val.strip()
    return kv


def is_meaningful_prose(text: str, min_chars: int = 12) -> bool:
    lines = [ln.strip().lstrip("-* ").strip() for ln in text.splitlines() if ln.strip()]
    kept = [ln for ln in lines if ln and not PLACEHOLDER_RE.match(ln)]
    joined = " ".join(kept)
    return len(joined) >= min_chars


def validate_pr(ctx: PrContext) -> list[str]:
    errors: list[str] = []
    sections = parse_sections(ctx.body)

    # 1. Read-only doc guard (HANDOFF.md and docs/specs/)
    if "HANDOFF.md" in ctx.changed_files and "handoff-sync" not in ctx.labels:
        errors.append(
            "Worker PRs must not edit HANDOFF.md directly (causes merge conflicts); "
            "put state updates in `## Handoff notes` or use a `handoff-sync` PR."
        )
    if any(f.startswith("docs/specs/") for f in ctx.changed_files) and "spec-pr" not in ctx.labels:
        errors.append(
            "Worker PRs must not edit docs/specs/ directly unless labeled `spec-pr`."
        )

    # 2. Required prose sections (fail-closed against placeholders)
    what_why = sections.get("what and why", "")
    if not is_meaningful_prose(what_why, min_chars=15):
        errors.append("Missing or placeholder `## What and why` section.")
    if "off-goal" not in ctx.labels and not FIXES_LINK_RE.search(what_why):
        errors.append("`## What and why` must link a tracked issue (e.g., `Fixes #123`).")

    goal_sec = sections.get("goal alignment", "")
    if not GOAL_ID_RE.search(goal_sec):
        errors.append("`## Goal alignment` must cite a Goal ID from GOALS.md (e.g., `G-01`) or `off-goal`.")

    if not is_meaningful_prose(sections.get("tested", ""), min_chars=12):
        errors.append("Missing or placeholder `## Tested` section.")

    if not is_meaningful_prose(sections.get("not tested", ""), min_chars=12):
        errors.append(
            "Missing or placeholder `## Not tested` section. Explicitly state what was NOT exercised."
        )

    ai_sec = sections.get("ai use", "")
    if not AI_MARK_RE.search(ai_sec):
        errors.append("`## AI use` must end with a concrete `🤖 Agent: <Role> | <model> via <tool>: <summary>` line.")

    # 3. Commit-bound pr-ready evidence block
    self_check = sections.get("self-check", "")
    block = extract_fenced_kv(self_check, "pr-ready")
    if block is None:
        errors.append("`## Self-check` must include the fenced `pr-ready` block generated by `scripts/pr_ready.py`.")
        return errors

    for key in REQUIRED_PR_READY_KEYS:
        if not block.get(key):
            errors.append(f"`pr-ready` block missing required key `{key}` (fail-closed).")

    evidence_format = block.get("format")
    if evidence_format not in {"pr-ready v1", "pr-ready v2"}:
        errors.append(f"Unknown `pr-ready` evidence format: {evidence_format!r}.")

    commit_val = block.get("commit", "")
    if "(dirty)" in commit_val or block.get("dirty") != "false":
        errors.append("`pr-ready` evidence was generated on a dirty working tree; commit first and re-run.")
    elif not re.fullmatch(r"[0-9a-f]{7,40}", commit_val) or not ctx.head_sha.startswith(commit_val):
        errors.append(
            f"`pr-ready` commit `{commit_val}` does not match PR head SHA `{ctx.head_sha}`."
        )

    for gate in REQUIRED_PASS_GATES:
        val = block.get(gate, "")
        if val != "PASS":
            errors.append(f"`pr-ready` gate `{gate}` must be `PASS`, got `{val}`.")

    # Keep evidence from in-flight v1 PRs valid. Its LOC used a different
    # definition, so only the independently measured production size gates it.
    if evidence_format == "pr-ready v2":
        for key, actual in (("net_prod_loc", ctx.diff.production), ("non_prod_loc", ctx.diff.other)):
            value = block.get(key, "")
            if not value.isascii() or not value.isdecimal():
                errors.append(f"`pr-ready` `{key}` must be a non-negative integer.")
            elif key == "net_prod_loc" and int(value) != actual:
                errors.append(
                    f"`pr-ready` reported {key}={value}, but CI measured {actual}; "
                    "refresh the base and re-run `scripts/pr_ready.py`."
                )
        if block.get("size_tier") != size_tier(ctx.diff.production):
            errors.append("`pr-ready` size tier does not match the measured production size.")
        attestation = sections.get("diff budget and anti-golfing check", "")
        if not re.search(r"(?im)^- \[[xX]\] No compression macros", attestation):
            errors.append("Complete the anti-golfing attestation in the PR template.")
    elif evidence_format == "pr-ready v1":
        if not ctx.allow_legacy_evidence:
            errors.append("Refresh evidence with `scripts/pr_ready.py` on this head (pr-ready v2).")
        elif not block.get("net_loc", "").isdecimal():
            errors.append("Legacy `pr-ready` evidence requires an integer `net_loc`.")

    production = ctx.diff.production
    if production > SOFT_CAP:
        just_sec = sections.get("size justification", "")
        if not is_meaningful_prose(just_sec, min_chars=25) or just_sec.lower().startswith("n/a"):
            errors.append(
                f"PR has {production} net production Rust LOC (exceeds {SOFT_CAP} soft cap). "
                "Explain why a clean split is impractical in `## Size justification` (>=25 chars)."
            )
    if production > HARD_CAP and WAIVER not in ctx.labels:
        errors.append(
            f"PR has {production} net production Rust LOC, exceeding the {HARD_CAP} hard cap "
            f"without `{WAIVER}`."
        )

    # 5. Optional B A A B benchmark block validation (fail-closed when present)
    baab_block = extract_fenced_kv(ctx.body, "baab")
    if baab_block is not None:
        if baab_block.get("format") != "baab v1":
            errors.append(f"`baab` block format must be `baab v1`, got `{baab_block.get('format')}`.")
        if baab_block.get("dirty") != "false":
            errors.append("`baab` benchmark was captured on a dirty working tree.")
        b_head = baab_block.get("head_sha", "")
        if not b_head or not ctx.head_sha.startswith(b_head) or len(b_head) < 7:
            errors.append(f"`baab` head_sha `{b_head}` does not match PR head SHA `{ctx.head_sha}`.")
        if baab_block.get("verdict") == "slower" and "perf-override-approved" not in ctx.labels:
            errors.append(
                "`baab` benchmark verdict is `slower` without human `perf-override-approved` label."
            )

    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--event-json", type=Path, default=None, help="GitHub event payload JSON path")
    args = parser.parse_args()

    event_path = args.event_json or (
        Path(os.environ["GITHUB_EVENT_PATH"]) if "GITHUB_EVENT_PATH" in os.environ else None
    )
    if not event_path or not event_path.exists():
        print("pr_check: no --event-json or GITHUB_EVENT_PATH supplied.", file=sys.stderr)
        return 2

    payload = json.loads(event_path.read_text(encoding="utf-8"))
    pr = payload.get("pull_request")
    if not pr:
        print("pr_check: event is not a pull_request; skipping.")
        return 0

    diff = measure_diff(pr["base"]["sha"], pr["head"]["sha"])
    summary = [
        f"**Net production Rust LOC:** {diff.production} ({size_tier(diff.production)})",
        f"**Other changed LOC (informational):** {diff.other}",
    ]
    if diff.production > SOFT_CAP:
        print(f"::warning::Production diff exceeds {SOFT_CAP} LOC. Review the split rationale.")
    for warning in diff.warnings:
        print(f"::warning::{warning}")
        summary.append(f"- **Anti-golfing review:** {warning}")
    print("\n".join(summary))
    if summary_path := os.environ.get("GITHUB_STEP_SUMMARY"):
        with Path(summary_path).open("a", encoding="utf-8") as out:
            out.write("\n\n".join(summary) + "\n")

    body = pr.get("body") or ""
    allow_legacy = (
        "format: pr-ready v1" in body
        and "scripts/pr_ready.py" not in diff.files
        and "format: pr-ready v1" in git("show", f"{pr['head']['sha']}:scripts/pr_ready.py")
    )
    ctx = PrContext(
        body=body,
        head_sha=pr["head"]["sha"],
        changed_files=list(diff.files),
        labels={lbl["name"] for lbl in pr.get("labels", [])},
        diff=diff,
        allow_legacy_evidence=allow_legacy,
    )
    errors = validate_pr(ctx)
    if errors:
        for err in errors:
            print(f"::error::{err}", file=sys.stderr)
        return 1
    print(f"pr_check: PASS (head={ctx.head_sha[:12]}, files={len(ctx.changed_files)}).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
