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

SOFT_CAP = 500
HARD_CAP = 600
FENCE = "`" * 3

HTML_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)
HEADING_RE = re.compile(r"^##\s+(.+?)\s*$", re.MULTILINE)
SPEC_LINK_RE = re.compile(r"\bSpec:\s*#\d+\b", re.IGNORECASE)
FIXES_LINK_RE = re.compile(r"\b(?:Fixes|Closes|Resolves)\s+#\d+\b", re.IGNORECASE)
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
    "net_loc",
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
    actual_net_loc: int | None = None


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

    # 3. Commit-bound pr-ready v1 evidence block
    self_check = sections.get("self-check", "")
    block = extract_fenced_kv(self_check, "pr-ready")
    if block is None:
        errors.append("`## Self-check` must include the fenced `pr-ready` block generated by `scripts/pr_ready.py`.")
        return errors

    for key in REQUIRED_PR_READY_KEYS:
        if not block.get(key):
            errors.append(f"`pr-ready` block missing required key `{key}` (fail-closed).")

    if block.get("format") != "pr-ready v1":
        errors.append(f"`pr-ready` format must be `pr-ready v1`, got `{block.get('format')}`.")

    commit_val = block.get("commit", "")
    if "(dirty)" in commit_val or block.get("dirty") != "false":
        errors.append("`pr-ready` evidence was generated on a dirty working tree; commit first and re-run.")
    elif not ctx.head_sha.startswith(commit_val.split()[0]) or len(commit_val.split()[0]) < 7:
        errors.append(
            f"`pr-ready` commit `{commit_val}` does not match PR head SHA `{ctx.head_sha}`."
        )

    for gate in REQUIRED_PASS_GATES:
        val = block.get(gate, "")
        if val != "PASS":
            errors.append(f"`pr-ready` gate `{gate}` must be `PASS`, got `{val}`.")

    # 4. Size cap enforcement: 500 soft cap (justification required), 600 hard cap (Spec required)
    try:
        reported_loc = int(block.get("net_loc", "-1"))
    except ValueError:
        reported_loc = -1
        errors.append("`pr-ready` `net_loc` must be an integer.")

    effective_loc = ctx.actual_net_loc if ctx.actual_net_loc is not None else reported_loc
    if ctx.actual_net_loc is not None and reported_loc >= 0 and abs(ctx.actual_net_loc - reported_loc) > 25:
        errors.append(
            f"`pr-ready` reported net_loc={reported_loc}, but CI measured {ctx.actual_net_loc}; re-run `scripts/pr_ready.py`."
        )

    if effective_loc > HARD_CAP:
        if not SPEC_LINK_RE.search(ctx.body):
            errors.append(
                f"PR has {effective_loc} net reviewed LOC, exceeding the {HARD_CAP} LOC hard cap without `Spec: #<issue>`."
            )
    elif effective_loc > SOFT_CAP:
        just_sec = sections.get("size justification", "")
        if not is_meaningful_prose(just_sec, min_chars=25) or "n/a" in just_sec.lower():
            errors.append(
                f"PR has {effective_loc} net reviewed LOC (exceeds {SOFT_CAP} soft cap, within {HARD_CAP} hard cap). "
                "Provide a concrete technical reason (>=25 chars) in `## Size justification`."
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
    parser.add_argument("--files-json", type=Path, default=None, help="JSON list of changed file paths")
    parser.add_argument("--actual-net-loc", type=int, default=None)
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

    changed_files: list[str] = []
    if args.files_json and args.files_json.exists():
        changed_files = json.loads(args.files_json.read_text(encoding="utf-8"))

    ctx = PrContext(
        body=pr.get("body") or "",
        head_sha=pr["head"]["sha"],
        changed_files=changed_files,
        labels={lbl["name"] for lbl in pr.get("labels", [])},
        actual_net_loc=args.actual_net_loc,
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
