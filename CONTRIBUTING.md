# Contributing to zen2top

Read [AGENTS.md](AGENTS.md) for contributor operations, [GOALS.md](GOALS.md) for milestone scope, and the [architecture reference](docs/ARCHITECTURE_RULES.md) for engineering requirements.

## Local setup

```sh
git config core.hooksPath .githooks
python scripts/ci.py all
python scripts/pr_ready.py --base origin/main
```

Use Rust from `rust-toolchain.toml`, Python 3.10 or newer, and Windows for native lint, tests, and headless checks. Claim queue items through GitHub CLI or a connected GitHub tool with write access. One fresh contributor session can work on an item without a shared runtime. Use a separate checkout when reviewing or fixing another branch.

## Scope and size

Architect issues describe one observable outcome, exact Touch Scope, merged dependencies, an independent test oracle, and out-of-scope work. Most implementation issues should target 150–450 production Rust LOC across one to three files. A smaller fix fits as written. Split clean, testable slices when work grows.

The size gate measures added plus removed production Rust lines from merge base to PR head, with matching moved blocks excluded. It counts `crates/*/src/**/*.rs`, excluding test, fixture, and snapshot directories and conventional test filenames. Inline `#[cfg(test)]` code is included under the path-based rule. Other changed text lines, including integration tests, docs, and the lockfile, are informational for sizing. Review all changed files, regardless of how they count.

| Net production Rust LOC | Size gate |
| --- | --- |
| 0–600 | Standard |
| 601–900 | Concrete split rationale in `## Size justification` and informational `size/large` label |
| Over 900 | Split rationale and an Architect-issued `size/architect-waiver` |

Review warnings identify new Rust macros and compressed statements for inspection. Legitimate macros still need to be readable and justified by the code. Keep boundary, failure, and regression tests whenever the change calls for them.

## Review and integration

The [Architect prompt](docs/ARCHITECT_PROMPT.md) owns live reconciliation, merges, and stage review. The Architect checks peer evidence against the exact head; labels alone never authorize a merge. Human review applies to CODEOWNERS and governance paths, dependency or breaking schema changes, performance overrides, and stage promotion. The repository’s process treats owner comments or completed closures designated for stage approval as human actions. Agents must leave those actions to the owner, even when using the same GitHub account.

`scripts/batch_integrate.py --goal-label <goal:label> --dry-run` optionally tests combined PRs in a disposable checkout. The script has no GitHub write path.
