#!/usr/bin/env python3
"""Handle `/claim` and `/unclaim` issue comments and scheduled stale-claim releases."""
from __future__ import annotations

import datetime
import json
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
UNCLAIMABLE_LABELS = {"blocked", "needs-triage", "proposal", "tracker", "not claimable"}
STALE_NO_PR_HOURS = 48
HARD_MAX_DAYS = 5


def gh(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["gh", *args],
        capture_output=True,
        text=True,
        check=check,
        encoding="utf-8",
        errors="replace",
    )


def is_paused() -> bool:
    for rel in (".github/council.txt", ".github/trusted-reviewers.txt"):
        p = ROOT / rel
        if p.exists():
            for line in p.read_text(encoding="utf-8").splitlines():
                if line.strip().lower() == "paused":
                    return True
    return False


def parse_command(body: str) -> str | None:
    first = body.strip().splitlines()[0].strip() if body.strip() else ""
    cleaned = re.sub(r"^🤖\s*Agent:\s*", "", first).strip()
    if cleaned.startswith("/claim"):
        return "claim"
    if cleaned.startswith("/unclaim"):
        return "unclaim"
    return None


def handle_command() -> int:
    if is_paused():
        print("claim_command: automation paused via council.txt/trusted-reviewers.txt.")
        return 0
    repo = os.environ["REPO"]
    issue = os.environ["ISSUE"]
    author = os.environ["AUTHOR"]
    body = os.environ.get("BODY", "")
    cmd = parse_command(body)
    if not cmd:
        return 0

    raw = gh("issue", "view", issue, "-R", repo, "--json", "labels,state,assignees").stdout
    data = json.loads(raw)
    if data.get("state") != "OPEN":
        return 0
    labels = {lbl["name"] for lbl in data.get("labels", [])}

    if cmd == "claim":
        blocked_by = sorted(labels & UNCLAIMABLE_LABELS)
        if blocked_by or "ready" not in labels:
            reason = f"blocked by labels {blocked_by}" if blocked_by else "missing `ready` label"
            gh(
                "issue", "comment", issue, "-R", repo, "--body",
                f"🤖 Agent: ClaimBot | Cannot claim #{issue} ({reason}).",
                check=False,
            )
            return 0
        if "in progress" in labels:
            gh(
                "issue", "comment", issue, "-R", repo, "--body",
                f"🤖 Agent: ClaimBot | Issue #{issue} is already `in progress`.",
                check=False,
            )
            return 0
        gh("issue", "edit", issue, "-R", repo, "--add-label", "in progress", check=False)
        gh(
            "issue", "comment", issue, "-R", repo, "--body",
            f"🤖 Agent: ClaimBot | Claimed by @{author}. Open a draft PR linking `Fixes #{issue}` within {STALE_NO_PR_HOURS}h.",
            check=False,
        )
    elif cmd == "unclaim":
        gh("issue", "edit", issue, "-R", repo, "--remove-label", "in progress", check=False)
        gh(
            "issue", "comment", issue, "-R", repo, "--body",
            f"🤖 Agent: ClaimBot | Released claim on #{issue} by @{author}.",
            check=False,
        )
    return 0


def release_stale_claims() -> int:
    if is_paused():
        print("claim_command: automation paused.")
        return 0
    repo = os.environ["REPO"]
    raw = gh(
        "issue", "list", "-R", repo, "--state", "open", "--label", "in progress",
        "--json", "number,updatedAt",
    ).stdout
    issues = json.loads(raw or "[]")
    now = datetime.datetime.now(datetime.timezone.utc)

    for item in issues:
        num = str(item["number"])
        updated = datetime.datetime.fromisoformat(item["updatedAt"].replace("Z", "+00:00"))
        age_hours = (now - updated).total_seconds() / 3600.0
        pr_raw = gh(
            "pr", "list", "-R", repo, "--state", "open", "--search", f"#{num}", "--json", "number",
        ).stdout
        linked_prs = json.loads(pr_raw or "[]")
        if (not linked_prs and age_hours >= STALE_NO_PR_HOURS) or age_hours >= HARD_MAX_DAYS * 24:
            gh("issue", "edit", num, "-R", repo, "--remove-label", "in progress", check=False)
            gh(
                "issue", "comment", num, "-R", repo, "--body",
                f"🤖 Agent: ClaimBot | Released stale claim on #{num} after {int(age_hours)}h (linked open PRs: {len(linked_prs)}).",
                check=False,
            )
    return 0


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) > 1 else "release"
    if mode == "command":
        return handle_command()
    return release_stale_claims()


if __name__ == "__main__":
    raise SystemExit(main())
