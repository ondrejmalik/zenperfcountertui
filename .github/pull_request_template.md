## What and why

<!-- Describe what this changes and why. Link the claimed ready issue ("Fixes #123").
     Over 1600 net reviewed LOC (hard cap): MUST link a `spec-approved` issue ("Spec: #456"). -->

Fixes #

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

## Size justification

<!-- Required ONLY when net reviewed LOC is 1201-1600 (soft cap exceeded, under 1600 hard cap).
     Give a concrete, technical reason why splitting this PR would leave half-wired or un-testable code.
     Leave "N/A (<= 1200 net LOC)" if <= 1200 net LOC. -->

N/A (<= 1200 net LOC)

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
     follow-up work, add 1-2 crisp bullets here for the Batch Integrator to fold into HANDOFF.md. -->

- None.

## AI use

<!-- Mandatory attribution. Last line format:
     "🤖 Agent: <Role> | <model> via <tool>: <what it did>." One sentence per model. -->

🤖 Agent: Worker | <model> via <tool>: <what it did>.
