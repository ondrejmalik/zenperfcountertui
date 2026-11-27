@AGENTS.md
@GOALS.md
@HANDOFF.md

## Session Discipline

- Before editing code on any non-trivial task, enter plan mode and estimate net reviewed LOC.
- If the plan exceeds 500 net LOC (or spans more than one architectural layer in `scripts/layers.json`), split it into atomic child issues before writing code.
- Never edit `HANDOFF.md` or `docs/specs/` in a feature/bug PR; report state changes in `## Handoff notes` instead.
- Before opening or updating a PR, run `python scripts/pr_ready.py --base origin/main` on a clean committed tree and paste the entire output (including the `pr-ready` fenced block) into `## Self-check`.
