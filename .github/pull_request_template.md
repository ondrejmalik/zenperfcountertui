## What and why

<!-- Describe what this changes and why. Use Closes #123 for full delivery or
     Part of #123 for a slice. Mark needs-split and describe the remaining work. -->

Closes #

Implementation session:

## Goal alignment

<!-- State the Goal ID from GOALS.md (e.g., `G-01` / `goal:v0.1-foundation`) or explicitly write `off-goal`.
     Confirm zero Non-Goal (NG-*) and Anti-Goal (AG-*) violations. -->

- Goal ID:
- Anti-Goals checked (`AG-01`..`AG-10`):

## Kind

<!-- Tick one: it sets the pull request's label. Start the title with it too:
     `kind(area): what changes`, for example `feature(core): ...` or `perf(csv): ...`. -->

- [ ] bug: a crash, regression, or broken behavior
- [ ] feature: something new for users
- [ ] perf: faster execution or lower memory/allocation cost
- [ ] parity: matches reference/oracle specification
- [ ] tooling: scripts, CI, Jenkinsfile, tests, or harnesses
- [ ] docs: documentation only

## Layer

<!-- core, platform, product, or tool (scripts/layers.json). -->

## Diff budget and anti-golfing check

- Net production Rust LOC:
- Other changed LOC (test, fixture, docs and other paths):
- [ ] No compression macros, obfuscated helpers, or dense statements were introduced to meet a line target.
- [ ] Changes stay within the issue’s Touch Scope.

## Size justification

<!-- Above 600 production LOC, explain why a clean, independently testable split is impractical.
     Above 900 also requires an Architect-issued size/architect-waiver label. -->

N/A (600 production Rust LOC or below)

## Tested

<!-- List exact commands run on THIS commit and exact observed counts (passed / failed / skipped).
     Never claim a test passed unless you executed it in this session on the current HEAD SHA. -->

## Not tested

<!-- MANDATORY. Explicitly list everything NOT exercised (e.g., live AMDuProf hardware counters,
     elevated IFEO registry writes, ETW Present traces, UI visual layout). Never leave blank. -->

## Self-check

<!-- Paste the COMPLETE output of `python scripts/pr_ready.py --base origin/main` run on a clean commit,
     including the commit-bound `pr-ready` fenced evidence block. CI verifies commit SHA == PR HEAD. -->

## Performance (`B A A B` Benchmark)

<!-- Required when touching hot paths or when Kind is `perf`. Paste BOTH the Markdown table AND the
     commit-bound `baab` fenced block emitted by `python scripts/bench_baab.py`.
     If verdict is `slower`, include fast-path isolation analysis and add `perf-override-needed`.
     Delete this section if no hot paths are affected. -->

## Headless Verification

<!-- For CLI/TUI changes: paste `--headless` / `--print-presets` smoke verification summary.
     Delete this section otherwise. -->

## Handoff notes

<!-- Do NOT edit HANDOFF.md directly. If this PR changes architecture status, gotchas, or unblocks
     follow-up work, add 1-2 crisp bullets here for the Architect to fold into HANDOFF.md. -->

- None.

## AI use

<!-- Mandatory attribution. Last line format:
     "🤖 Agent: <Role> | <model> via <tool>: <what it did>." One sentence per model. -->

🤖 Agent: Worker | <model> via <tool>: <what it did>.
