# Contributing to `zen2top` (Humans & Autonomous Agents)

Read [`AGENTS.md`](./AGENTS.md) (engineering specification), [`GOALS.md`](./GOALS.md) (active milestone goals, non-goals, anti-goals), and [`HANDOFF.md`](./HANDOFF.md) (current live state) before starting work.

## Fast Local Setup

```powershell
git config core.hooksPath .githooks
python scripts/ci.py all
```

`rust-toolchain.toml` pins `stable` (`rustfmt`, `clippy`) so local checks, local Jenkins (`zen2top-ci`), and GitHub Actions (`windows-latest`) match 1:1.

## Autonomous 4-Role Workflow

1. **Planner Agent:** Audits `needs-triage` issues against `GOALS.md`, rejects `AG-*` violations, decomposes `> 1200` net LOC work into single-layer atomic child issues, and applies `goal:<milestone>` + `ready`.
2. **Worker Agent:**
   - Finds an unclaimed `ready` + `goal:<milestone>` issue:
     ```sh
     gh issue list --search 'is:open no:assignee label:ready -label:"in progress" -label:blocked -label:tracker -label:proposal -label:"not claimable" -linked:pr'
     ```
   - Checks for overlapping PRs (`gh pr list --state open --search "<issue-or-symbol>"`).
   - Comments `🤖 Agent: /claim` on the issue and opens a draft PR (`Fixes #<N>`) promptly.
   - Keeps net reviewed LOC $\le 1200$ (1201–1600 requires concrete `## Size justification`; $> 1600$ requires `Spec: #<M>`).
   - Never edits `HANDOFF.md` or `docs/specs/` directly (put state updates in `## Handoff notes`).
   - Commits cleanly, runs `python scripts/pr_ready.py --base origin/main`, and pastes the entire table + `pr-ready v1` block into `## Self-check`.
3. **Two-Pass Verifier Quorum (Pass A + Pass B):** Two fresh-context reviews (code/spec/goal audit + independent scratch execution of `python scripts/ci.py all`) apply `ready-to-merge` upon dual `VERDICT: PASS`.
4. **Batch Integrator:** Runs `python scripts/batch_integrate.py --goal-label goal:<milestone> --auto-merge` to test eligible `ready-to-merge` PRs together, bisect/eject breaking PRs, auto-merge verified non-`CODEOWNERS` subsets, sync `HANDOFF.md`, and flag the Roadmap Tracker when a milestone reaches `0` open issues.

## Tier-2 Mandatory Human Gates (Never Auto-Merged)

Any PR touching `.github/CODEOWNERS` paths, changing `Cargo.toml` dependencies, breaking public/JSON schemas, exceeding 1600 net LOC without `spec-approved`, marked `off-goal`, regressing `B A A B` benchmarks (`slower` without `perf-override-approved`), or tripping the Circuit Breaker (`blocked`) requires human maintainer approval.
