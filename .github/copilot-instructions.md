Follow `AGENTS.md`, `GOALS.md`, and `HANDOFF.md` strictly as the authoritative rules for this repository.
Respect `scripts/layers.json` (`zen2top-core` <- `zen2top-platform` <- `zen2top-cli`), keep PRs under 500 net reviewed LOC (501-600 requires concrete `## Size justification`; >600 requires approved `Spec: #<issue>`).
Never edit `HANDOFF.md` in worker PRs. Never add `unsafe` in `zen2top-core` or `zen2top-cli`, and always place a `// SAFETY:` comment above every `unsafe` block/`unsafe fn` in `zen2top-platform`.
Always run `python scripts/pr_ready.py --base origin/main` on a clean commit and fill in both `## Tested` and `## Not tested`.
