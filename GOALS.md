# Project Goals, Non-Goals & Anti-Goals (`GOALS.md`)

> **Governance rule:** Every implementation issue and PR must advance an active **Goal (`G-*`)**, must not implement a deferred **Non-Goal (`NG-*`)** without milestone promotion, and must **never** violate an **Anti-Goal (`AG-*`)**. Automated triage closes or blocks work that violates an Anti-Goal. Changes to `GOALS.md` require human `.github/CODEOWNERS` approval.

## Active Milestone: `v0.1-foundation`

- **Target Exit Criteria:** All `G-01`..`G-06` items below are merged into `main`, green in `python scripts/ci.py all`, and verified by deterministic unit tests + headless `--no-pmu` JSON v1 smoke tests.
- **Active Milestone Label:** `goal:v0.1-foundation`
- **Engineering Constitution:** See [`AGENTS.md`](./AGENTS.md) for the full `zen2top` microarchitectural, metric, Advisor, and UI specification.

## Active Goals (`G-*` — Eligible for Autonomous Auto-Merge under `goal:v0.1-foundation`)

- **`G-01` — Config Schema, Zen 2 PMU Packs & Zero-Split 6-Slot Bin-Packer (`core`):** Implement `config.toml` defaults/parsing, the 12 atomic Zen 2 Core PMC packs (24 slots), 6 quick presets, and the First-Fit Decreasing 6-slot bin-packer (`ExactRetiring` auto-pad, empty-set rejection) with exhaustive 4,095-subset unit tests in `crates/zen2top-core`.
- **`G-02` — CSV Parser, Exclusive CPI Stack & Retiring % Metrics (`core`):** Implement `report_core.csv` / `report_l3.csv` parsing (affinity filtering, CCX0/1 split, per-core `inst/aperf` IPC & `mperf` C0%), Exclusive CPI Stack (Flush vs. MLP clamped $\ge 0$), 6-wide Zen 2 Retiring % (exact `0x4300C1` & `~` estimated), and ring buffers in `crates/zen2top-core`.
- **`G-03` — Raw-Cumulative A/B Baselines & `MUX DIFF` Engine (`core`):** Implement raw-cumulative baseline JSON persistence (`#[serde(default)]` backwards compatibility), pack-aware `%` delta computation, and `MUX DIFF` warnings in `crates/zen2top-core`.
- **`G-04` — Pure Evidence-Gated Advisor (`DiagnosticEngine::evaluate`) (`core`):** Implement the evidence gate ($\ge 10$ samples + active load), no-orphan-verdict invariant, `Data-Dependency / ILP-Bound` exclusion verdict, Amdahl `Est. Gain` (`0.25` CPI floor), PMU/Micro-Arch rules, Zero-PMC Win32/ETW rules, Tab 7 enrichment hook, and Verified Healthy strip across atomic issues in `crates/zen2top-core`.
- **`G-05` — Platform Trait Seams, PMC Contention State Machine & `--no-pmu` Pipeline (`platform`):** Implement `PmuBackend`, `PmuCoordinator` (guaranteed resume on burst error), PMC occupant classification + critical Windows OS blocklist + default-No confirmation state machine, `AllocatorInspector` & `SymbolResolver` traits, generic Layer 1 classification contracts, and `--no-pmu`/mock snapshot runner in `crates/zen2top-platform`.
- **`G-06` — Headless CLI Runner & JSON v1 Contract (`product`):** Wire the full `clap` CLI, `--print-presets`, `--headless` JSON report (`schema_version: 1`), `--baseline` diffing, and deterministic exit codes (`0`, `1`, `2`, `3`) through `zen2top-platform` in `crates/zen2top-cli`.

## Planned Roadmap Milestones (Deferred Until Active Milestone Promotion)

- **`goal:v0.2-platform-win32-pmu`:** Live `AMDuProfPcm.exe` worker, Win32 ETW/handle PMC occupant discovery & confirmed eviction, `--calibrate` pointer-chase/branch benchmark, Win32 RAII telemetry (topology, process, threads, modules/IFEO, VA map, D3DKMT GPU 3D, DPC/IRQ, memory/PDH hard faults, Disk I/O, `SeLockMemoryPrivilege`), and Layer 1 / Layer 2 allocators (`tier0.dll` mimalloc v2 + generic + `rminject` integration).
- **`goal:v0.3-tui-live`:** Full 7-tab borderless `ratatui` TUI (Overview, Cache & Memory, TLB & Large Pages / IFEO, Memory & Allocator, Advisor, Threads & Frames + Affinity Sandbox, Profiler), Braille plots, modals (`p`/`m`/`b`/`a`/`?`), and CCX/SMT strip (`c`).
- **`goal:v0.4-etw-profiler-hil`:** `DXGI`/`DxgKrnl` Present ETW + spike correlator, live On-CPU/Off-CPU ETW profiler, 4-tier x64 `SymbolResolver` (PDB > Export > Sidecar > `.pdata`), on-demand `AMDuProfCLI` IBS burst, Hardware-in-the-Loop Advisor Verification (`TESTING.md` $\ge 95\%$ precision -> `TEST_REPORT.md`), and release ship gate.

## Non-Goals (`NG-*` — Permanently Out of Scope or Deferred; Label `off-goal`)

- **`NG-01` — AMD Top-Down Pipeline Mode:** Physically unsupported on Zen 2 (Zen 4+ only). Never fabricate a 4-way 100% pipeline slot breakdown.
- **`NG-02` — Continuous 1 Hz Live IBS Streaming:** IBS is strictly an on-demand 5–10s `AMDuProfCLI` batch capture on Tab 7.
- **`NG-03` — Cross-Platform Linux/macOS Ports:** `zen2top` is Windows 11 native (`windows` crate, Win32, ETW, IFEO, AMDuProf).
- **`NG-04` — Vendor-Specific GPU SDKs (NVAPI, ADL, IGCL):** Use vendor-agnostic `D3DKMTQueryStatistics` only.
- **`NG-05` — Kernel Drivers, DLL Injection, API Hooking, or Anti-Cheat Bypasses:** External read-only telemetry only (plus documented IFEO registry edits, thread affinity, and user-confirmed PMC eviction).
- **`NG-06` — Permanent OS "Optimizer" / Global Registry Tweaker:** Never modify power plans, Defender, boot BCD, or persist thread affinities across reboots.
- **`NG-07` — Web Server, Browser Frontend, or GUI Wrapper:** Native terminal TUI + `--headless` JSON CLI only. Also defer unpromoted milestone (`v0.2+`) work until `GOALS.md` promotes that milestone.

## Anti-Goals (`AG-*` — Permanently Forbidden; Reject Immediately)

- **`AG-01` — Silent Fallbacks That Mask Errors:** Never swallow errors, stub failing checks with fake success responses, or silently skip broken gates to make CI look green.
- **`AG-02` — Host OS & Focus Intrusion:** Never inject global OS mouse/keyboard input (`SendInput`, `SetCursorPos`, `SetForegroundWindow`, `pyautogui`) or write to real user profiles (`%APPDATA%`, `~/.config`) during tests.
- **`AG-03` — Layer Collapse or Core Leakage:** `zen2top-cli` (`product`) must depend strictly on `zen2top-platform` (`platform`), never directly on `zen2top-core` (`core`); no shipped crate may depend on `tool` scripts.
- **`AG-04` — Unverified Hot-Path Regressions:** Never merge a `B A A B` benchmark verdict of `slower` without isolating the cold path and obtaining human `perf-override-approved`.
- **`AG-05` — Unbounded Scope Creep:** Never bundle unrelated refactors, renames, formatting churn, or dependency upgrades into an issue PR.
- **`AG-06` — UI Clutter Violations (`AGENTS.md` §5.1):** Never nest bordered cards, use pill/color soup, prefix main-view metrics with raw PMC hex codes, exceed 2 top / 1 bottom chrome lines, default CCX strip ON, or pad disabled packs with `--` rows.
- **`AG-07` — Math & Hardware Dishonesty (`AGENTS.md` §5.2):** Never hardcode per-app/game/engine lookup tables, normalize CPI stack to 100%, stack IPC bars, store averages-of-averages in baselines, breach the `0.25` CPI floor, feed `l2icExcl` into an L2 I-Cache miss rule, emit orphan verdicts, fire Advisor before `< 10` samples + active load, or suggest OS tweaks for `[Code / Build]` ceilings.
- **`AG-08` — Unsafe Runtime Pollution (`AGENTS.md` §5.3):** Never spawn PowerShell, call `SuspendThread`, walk target NT heap locks, run `AMDuProfPcm.exe` and `AMDuProfCLI.exe` concurrently, silently evict PMC holders without user confirmation (or evict at all in `--headless`), or terminate critical Windows OS processes.
- **`AG-09` — Resource Leaks & Unverified `unsafe`:** Never leak Win32 `HANDLE`s or leave orphaned ETW sessions running; never add `unsafe` to `zen2top-core` or `zen2top-cli` (`#![forbid(unsafe_code)]`), and never add undocumented `unsafe` (missing `// SAFETY:`) in `zen2top-platform`.
- **`AG-10` — Fragile Crashes on Denied/Missing OS Surfaces:** Never panic on `ERROR_ACCESS_DENIED`, missing AMDuProf, missing PDBs, or pre-22H2 Win11 APIs (`ProcessPowerThrottling`). Always degrade gracefully.
