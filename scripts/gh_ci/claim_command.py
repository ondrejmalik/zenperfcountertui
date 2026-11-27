#!/usr/bin/env python3
"""Serialize workflow claims from GitHub issue/PR comments."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from datetime import datetime, timedelta, timezone
import json
import os
import re
import subprocess

CLAIM_LABEL = {"implement": "in-progress", "review": "review-in-progress", "fix": "fix-in-progress"}
QUEUE = {"implement": 3, "review": 1, "fix": 2}
BLOCKED = {"blocked", "needs-human", "needs-human-review", "needs-triage", "off-goal", "anti-goal"}
TOKEN = r"[a-zA-Z0-9][a-zA-Z0-9-]{7,63}"
COMMAND = re.compile(rf"(?:🤖\s*Agent:\s*)?/(claim(?:-review|-fix)?|unclaim|expire-claim) ({TOKEN})")
RECEIPT = re.compile(rf"<!-- agent-claim:(\w+) ({TOKEN}) ([a-zA-Z0-9-]+) -->")
SCOPE_SECTION = re.compile(r"(?im)^#{2,3} Touch Scope\s*\n(.*?)(?=^#|\Z)", re.DOTALL)


def gh(*args: str) -> str:
    return subprocess.run(
        ["gh", *args], capture_output=True, check=True, encoding="utf-8", errors="replace",
    ).stdout


def api(repo: str, suffix: str) -> list | dict:
    return json.loads(gh("api", f"repos/{repo}/{suffix}"))


def pages(repo: str, suffix: str) -> list[dict]:
    result = json.loads(gh("api", "--paginate", "--slurp", f"repos/{repo}/{suffix}"))
    return [entry for page in result for entry in page]


def label_names(item: dict) -> set[str]:
    return {label["name"] for label in item["labels"]}


def touch_scope(body: str) -> set[str]:
    section = SCOPE_SECTION.search(body)
    if not section:
        return set()
    return set(re.findall(r"(?m)^- `([a-zA-Z0-9_./-]+)`\s*$", section.group(1)))


def overlaps(left: set[str], right: set[str]) -> bool:
    return any(
        a == b or a.startswith(b.rstrip("/") + "/") or b.startswith(a.rstrip("/") + "/")
        for a in left for b in right
    )


def queue_contains(body: str, role: str, number: str) -> bool:
    section = re.search(rf"(?ms)^## {QUEUE[role]}\. [^\n]+\n(.*?)(?=^## |\Z)", body)
    return bool(section and re.search(rf"(?m)^\|\s*#{number}\s*\|", section.group(1)))


def live_scope_conflict(repo: str, number: str, scope: set[str]) -> str | None:
    for label in ("in-progress", "in progress"):
        for item in pages(repo, f"issues?state=open&labels={label.replace(' ', '%20')}&per_page=100"):
            if "pull_request" in item or str(item["number"]) == number:
                continue
            reserved = touch_scope(item["body"] or "")
            if not reserved or overlaps(scope, reserved):
                return f"reserved or unknown scope on #{item['number']}"
    for pr in pages(repo, "pulls?state=open&per_page=100"):
        files = pages(repo, f"pulls/{pr['number']}/files?per_page=100")
        paths = {file[key] for file in files for key in ("filename", "previous_filename") if key in file}
        if len(files) >= 3000 or overlaps(scope, paths):
            return f"overlaps the open PR #{pr['number']}"
    return None


def latest_claim(repo: str, number: str, role: str) -> tuple[dict, re.Match] | None:
    for comment in reversed(pages(repo, f"issues/{number}/comments?per_page=100")):
        if comment["user"]["login"] != "github-actions[bot]":
            continue
        match = RECEIPT.search(comment["body"])
        if match and match[1] == role:
            return comment, match
    return None


def main() -> int:
    match = COMMAND.fullmatch(os.environ["BODY"].strip())
    if not match or os.environ["ASSOCIATION"] not in {"OWNER", "MEMBER", "COLLABORATOR"}:
        return 0
    command, token = match.groups()
    repo, number, author = (os.environ[key] for key in ("REPO", "ISSUE", "AUTHOR"))
    if os.environ["MODE"] == "paused":
        return 0

    def reply(message: str) -> None:
        gh("api", "--method", "POST", f"repos/{repo}/issues/{number}/comments",
           "-f", f"body=🤖 Agent: ClaimBot | {message}")

    item = api(repo, f"issues/{number}")
    labels = label_names(item)
    if item["state"] != "open":
        return 0

    if command in {"unclaim", "expire-claim"}:
        if command == "expire-claim" and os.environ["ASSOCIATION"] != "OWNER":
            return 0
        for role, label in CLAIM_LABEL.items():
            if label not in labels:
                continue
            receipt = latest_claim(repo, number, role)
            if not receipt or token != receipt[1][2]:
                continue
            if command == "unclaim" and author.lower() != receipt[1][3].lower():
                continue
            if command == "expire-claim":
                claimed = datetime.fromisoformat(receipt[0]["created_at"].replace("Z", "+00:00"))
                lifetime = timedelta(hours=48 if role == "implement" else 3)
                if datetime.now(timezone.utc) - claimed < lifetime:
                    continue
            gh("api", "--method", "DELETE", f"repos/{repo}/issues/{number}/labels/{label}")
        return 0

    role = {"claim": "implement", "claim-review": "review", "claim-fix": "fix"}[command]
    is_pr = "pull_request" in item
    if is_pr != (role != "implement") or labels & BLOCKED:
        reply(f"Claim denied for `{token}`: item type or blocking labels.")
        return 0

    boards = [board for board in pages(repo, "issues?state=open&labels=roadmap,stage%3Aactive&per_page=100")
              if "pull_request" not in board]
    if len(boards) != 1:
        reply(f"Claim denied for `{token}`: expected one active Roadmap.")
        return 0
    body = boards[0]["body"] or ""
    if not re.search(r"(?m)^\*\*Stage Gate:\*\* `active`\s*$", body) or not queue_contains(body, role, number):
        reply(f"Claim denied for `{token}`: Roadmap gate or queue changed.")
        return 0

    label = CLAIM_LABEL[role]
    if labels & (set(CLAIM_LABEL.values()) - {label} | {"in progress"}):
        reply(f"Claim denied for `{token}`: another role or legacy session owns this item.")
        return 0
    if label in labels:
        receipt = latest_claim(repo, number, role)
        if not receipt or (token, author.lower()) != (receipt[1][2], receipt[1][3].lower()):
            reply(f"Claim denied for `{token}`: another session owns this item.")
            return 0
    elif role == "implement":
        scope = touch_scope(item["body"] or "")
        if "ready" not in labels or not scope:
            reply(f"Claim denied for `{token}`: missing readiness or exact Touch Scope.")
            return 0
        if conflict := live_scope_conflict(repo, number, scope):
            reply(f"Claim denied for `{token}`: {conflict}.")
            return 0
    else:
        pr = api(repo, f"pulls/{number}")
        required = "needs-review" if role == "review" else "changes-requested"
        if pr["draft"] or required not in labels or (role == "review" and "changes-requested" in labels):
            reply(f"Claim denied for `{token}`: PR is draft or its queue state changed.")
            return 0

    # The workflow serializes all claim changes across issues and PRs. A
    # receipt is mandatory even if the label write succeeds but posting fails.
    gh("api", "--method", "POST", f"repos/{repo}/issues/{number}/labels", "-F", f"labels[]={label}")
    reply(f"Claim granted for `{token}` ({role}) to @{author}.\n\n<!-- agent-claim:{role} {token} {author} -->")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
