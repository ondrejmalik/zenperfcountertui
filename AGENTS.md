# zen2top Agent Operating Protocol

Repository `ondrejmalik/zenperfcountertui`. **“Work on this” runs the worker loop below.** A user-specified issue, PR, or task takes precedence. Use a fresh session and isolated checkout per item. The [Architect](docs/ARCHITECT_PROMPT.md) reconciles GitHub and owns merges and stage changes.

- [GOALS.md](GOALS.md) defines the active milestone and product constraints.
- [Architecture rules](docs/ARCHITECTURE_RULES.md) hold the engineering spec. Read the sections relevant to your scope.
- [HANDOFF.md](HANDOFF.md) is a versioned snapshot. Put updates in PR handoff notes for the Architect.
- [TESTING.md](TESTING.md) is for hardware-dependent verification and the release gate. Load it after the build, tests, and Clippy pass.

## 1. Default worker loop

1. Fetch the one open GitHub issue labeled `roadmap,stage:active`. Read its full body. Use the repository explicitly with `-R ondrejmalik/zenperfcountertui` when running GitHub commands outside the checkout.
   ```sh
   gh issue list -R ondrejmalik/zenperfcountertui --state open --label roadmap --label stage:active --json number,title,body
   ```
2. Stop if there is no unique Roadmap, its gate is anything other than `active`, or a linked Stage Review is marked `awaiting-approval`. Report what you found. The Architect owns board repair.
3. Pick the first eligible row in this order. Re-fetch the item, labels, checks, history, dependencies, and touched paths live.

   | Priority | Eligible work |
   | --- | --- |
   | 1. Verify a PR | Open, non-draft, `needs-review`, checks green or runnable locally, no review/fix claim. You did not author or fix this head. |
   | 2. Fix a PR | Open, non-draft, `changes-requested`, with actionable findings, a failing check, or a rebase request and no review/fix claim. |
   | 3. Implement an issue | Open and `ready`; each dependency has a merged delivery PR; it has an explicit Touch Scope clear of other implementation claims and all open PRs. |

   Skip blocked items, human gates, claimed work, and issues with an open delivery PR. If a dependency was intentionally retired, the Architect must update the dependency link. If nothing qualifies, report the reason and exit.
4. Claim exactly one item through ClaimBot. Post one of the following as the entire comment, with a fresh random session token (for example, a UUID) that stays constant for your item.
   ```text
   🤖 Agent: /claim <session-token>
   🤖 Agent: /claim-review <session-token>
   🤖 Agent: /claim-fix <session-token>
   ```
   Proceed only once the Actions bot grants your exact token and the live claim label and Roadmap gate still match. A label alone grants no ownership. If simultaneous requests leave yours without a reply, recheck and retry once with the same token. A denial or a second missing reply leaves the item unclaimed by you. Keep your token and branch or head SHA in your handoff. Renew a long-running claim with the same command and token before three hours for PRs or 48 hours for implementation. Recheck ownership before publishing.
5. Use `🤖 Agent: /unclaim <session-token>` when done or unable to continue. Describe blockers on the item. Avoid clearing another session’s label. After an implementation PR opens, its issue remains unavailable while that PR is open. Use one claim and one item per session.

GitHub accounts may be shared by separate sessions. Use a unique session token, inspect author and fix history, and skip any PR where you cannot establish independence. GitHub native approvals require a separate eligible account. Record the peer decision in a structured PR comment even if native review is available.

## 2. Peer verification

- Check out the exact live PR head in isolation. Read the linked issue and inspect the full diff, tests, error paths, and touched layers. Check every acceptance criterion and the exclusions in [GOALS.md](GOALS.md).
- Run `python scripts/ci.py all` and `python scripts/pr_ready.py --base origin/main` on a clean checkout. Check the PR’s evidence and rerun its issue-specific oracle. Record commands, results, and anything the host could not exercise. A required gate or evidence gap prevents a pass.
- Request changes for scope creep, compression macros, obfuscated helpers or statements, warning suppressions, fake data, swallowed errors, or tests that fail to exercise the behavior. Inspect size warnings and require a credible split rationale and waiver where applicable. A heuristic hit alone is a prompt to inspect code.
- Recheck the head SHA and your claim. Put your matching receipt token, exact head SHA, commands and outcomes, findings with file and line, and pending tests in a PR comment. Use the following first three lines so the Architect can reconcile the result.

  ```text
  🤖 Agent: Peer Verifier | <model> via <tool>: <summary>
  Verification: PASS
  Head: <full head SHA>
  ```

  Include a `Session: <token>` line. Use `Verification: CHANGES_REQUESTED` and name required fixes when defective. Switch `needs-review` to `agent-verified` or `changes-requested` to match your decision, then release your claim. An environment blocker belongs in a comment and leaves the PR awaiting review. Only the Architect merges; contributors never verify their own changes.

## 3. Implementation and fixes

- Branch new work from current `origin/main` as `feat/issue-<id>-<slug>`. For fixes, use the existing PR branch only if you have push access, read all review findings, and preserve the linked issue scope. Use no force push. A fork with no edit permission goes back to the Architect.
- Keep idiomatic, rustfmt-formatted Rust. Macros and abstractions need a real purpose beyond line count. Size targets are planning estimates. Most tasks should target 150–450 production Rust LOC across one to three production files. Keep tests needed for the behavior.
- Aim for a complete slice by 500 production LOC. If the expected diff exceeds 600, prefer a compiling, independently testable slice. Use `Part of #N`, label `needs-split`, and document remaining behavior and proposed dependencies. Only the Architect creates the continuation or approves a split exception. At 601–900 production LOC, CI requires justification and flags `size/large`. Above 900 also requires `size/architect-waiver`. See [contributing](CONTRIBUTING.md) for counting rules.
- Run `python scripts/ci.py all`. Commit, then run `python scripts/pr_ready.py --base origin/main` on a clean tree and paste its evidence into the [PR template](.github/pull_request_template.md). Run the B A A B benchmark for hot paths. Describe untested surfaces honestly.
- Use `Closes #N` for full delivery. In the PR body add `Implementation session: <token>`. Open or update the PR with `needs-review` and its `goal:*` label. For a fix, also append a PR comment with `Fix session: <token>` and `Head: <full head SHA>`, post fresh evidence, and clear `changes-requested` and stale `agent-verified`. Keep the item in fixes until changes and evidence are ready.
- Start agent comments with `🤖 Agent:` and include role, model, and tool in reviews and PR bodies. Leave updates for [HANDOFF.md](HANDOFF.md) in PR notes. Changes to protected paths go through human review.

## 4. Offline or read-only fallback

Inspect [HANDOFF.md](HANDOFF.md), `git status`, and recent history. If the user named a concrete task, do the authorized local work and return a copy-pasteable PR or review with its evidence and labels. If the user gave only “Work on this,” report that the live queue or ClaimBot is unreachable. An offline snapshot cannot reserve work for your session.
