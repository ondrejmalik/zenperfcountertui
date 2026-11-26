# AGENTS.md — `zen2top` Engineering Guide & Project Constitution

This document is the authoritative engineering specification for AI coding agents and human contributors working on **`zen2top`**: a native Windows 11 Rust TUI for AMD Zen 2 hardware performance counters, cache/TLB/SMT/CCX bottleneck analysis, 2 MiB large-page management, memory/allocator introspection, A/B baseline diffing, per-thread/function profiling, and evidence-gated performance diagnostics.

Every design choice in this repository exists for a concrete microarchitectural or ergonomic reason. Read the **Goals**, **Non-Goals**, and **Anti-Goals** carefully before modifying architecture, metrics, rules, or UI layouts.

---

## 1. Project Identity & Core Philosophy

`zen2top` evolves the proven telemetry core of `check_memory.py` (AMD Zen 2 `AMDuProfPcm.exe` PMU counters, Windows `SHS-*` ETW PMC unlocking, `QueryWorkingSetEx` 2 MiB large-page checks, and `tier0.dll` mimalloc v2 introspection) into a fast, near-zero-overhead native **Windows 11 Rust TUI**.

### Guiding Principles
1. **`perf stat` / `htop` Scannability Over Dashboard Eye Candy:** A developer or performance engineer should diagnose the #1 bottleneck in under 2 seconds. Dense, borderless, vertically aligned tables paired with clean Braille time-series graphs beat nested card grids every time.
2. **Hardware Honesty Above All:** Never fabricate precision. Distinguish measured hardware latencies from modeled constants, estimated metrics (`~`) from exact counters, 0-Mux exact counts from multiplexed extrapolations, and actionable OS tweaks from `[Code / Build]` ceilings.
3. **Zero Observer Pollution:** The profiler must not alter the workload it observes. Never spawn PowerShell, never suspend target threads, never walk target OS heap locks, and keep CPU/RAM footprint minimal.
4. **Evidence-Gated Conclusions Only:** Never alarm on 1-second glitches, idle windows, or ambiguous correlations. Every recommendation must cite exact observed values, prove its verdict, state its scope, and explain downstream causal cascades.

---

## 2. Tech Stack & Runtime Architecture

- **Language:** Rust (edition 2021+).
- **Core Crates:** `ratatui`, `crossterm`, `windows`, `clap`, `serde`, `serde_json`, `toml`, `anyhow`.
- **Submodules & External Dependencies:**
  - `rminject` ([`third_party/rminject`](third_party/rminject), upstream `https://github.com/ondrejmalik/rminject.git`): Universal mimalloc PE injector & runner for Rust / Win32 `HeapAlloc` binaries with machine-readable allocator inspection. Agents can inspect its source and git history directly in `third_party/rminject` and reference it in `Cargo.toml` via `rminject = { path = "third_party/rminject" }` (or `git = "https://github.com/ondrejmalik/rminject.git"`).
- **Target Platform:** Windows 11 (x64), optimized first for **AMD Zen 2 (Family 17h Model 71h)** (e.g., Ryzen 5 3600X, 6C/12T, dual 16 MiB CCX, 6 programmable Core PMCs + 3 fixed MSRs + 6 CCX L3 PMCs).
- **Concurrency Model (Strictly Non-Blocking):**
  - **UI Loop (~15–30 FPS):** Owns terminal rendering and keyboard/modal state; consumes immutable snapshots from channels; **never** blocks on `AMDuProfPcm`, `AMDuProfCLI`, `ReadProcessMemory`, symbol resolution, or ETW flushing.
  - **PMU Worker & `PmuCoordinator`:** Runs `AMDuProfPcm.exe` (preferring continuous interval streaming if live-flushing is reliable, with clean fallback to `-d <interval>` loops and automatic `SHS-*` ETW lock detection/recovery). Coordinates exclusive hardware PMC access so on-demand `AMDuProfCLI` burst captures cleanly pause and resume `AMDuProfPcm`.
  - **Win32 Telemetry Worker:** Polls native Win32 process/thread/memory/GPU/DPC/IRQ/IO/IFEO/allocator state using RAII `HANDLE` wrappers.
  - **ETW Consumer Worker(s):** Dedicated real-time `OpenTraceW` / `ProcessTrace` threads for `DXGI`/`DxgKrnl` frame pacing and optional kernel `SampledProfile`/`CSwitch`/`ReadyThread`/`StackWalk` profiling, guaranteed to call `ControlTraceW(EVENT_TRACE_CONTROL_STOP)` on drop, exit, or Ctrl+C.

### Canonical Module Layout
```text
src/
├── main.rs              # CLI (clap), terminal RAII guard, ~20 FPS event loop
├── config/mod.rs        # Auto-generated config.toml (latencies, packs, thresholds)
├── calibrate/mod.rs     # ~1s pointer-chasing + random-branch latency microbenchmark
├── pmu/
│   ├── mod.rs           # PmuBackend trait, PmuCoordinator, SHS-* ETW unlock helper
│   ├── packs.rs         # 12 atomic Core PMC packs, 6-slot bin-packer, quick presets
│   ├── uprof.rs         # AMDuProfPcm streaming/interval worker
│   ├── uprof_burst.rs   # On-demand AMDuProfCLI hardware-stall & IBS burst capture
│   └── csv_parser.rs    # report_core.csv + report_l3.csv (affinity + CCX0/1 + per-CPU)
├── win32/
│   ├── handle.rs        # RAII SafeHandle wrapper (CloseHandle on Drop)
│   ├── topology.rs      # GetLogicalProcessorInformationEx (physical cores & SMT pairs)
│   ├── process.rs       # SystemProcessInformation, noisy neighbors, Priority/EcoQoS
│   ├── threads.rs       # Per-thread CPU/CtxSw/WaitReason, names, live affinity editor
│   ├── modules.rs       # EnumProcessModulesEx, QueryWorkingSetEx, IFEO HKLM read/write
│   ├── va_map.rs        # VirtualQueryEx + QueryWorkingSetEx (Private RW / JIT RX-RWX / Mapped / Image)
│   ├── gpu.rs           # Vendor-agnostic D3DKMTQueryStatistics (3D engine utilization)
│   ├── sys_perf.rs      # SystemProcessorPerformanceInformation (per-CPU DPC/IRQ%)
│   ├── memory.rs        # GetPerformanceInfo + PDH \Memory\Page Reads/sec (hard faults)
│   ├── io.rs            # GetProcessIoCounters (Read/Write MB/s & IOPS)
│   └── privileges.rs    # TokenPrivileges check for SeLockMemoryPrivilege
├── etw/
│   ├── present.rs       # DXGI + DxgKrnl frametime, 1%/0.1% lows, flip mode, spike correlator
│   └── profiler.rs      # Live SampledProfile (On-CPU) + CSwitch/ReadyThread (Off-CPU) + StackWalk
├── allocator/
│   ├── mod.rs           # AllocatorInspector trait + graceful Layer 1 fallback
│   ├── tier0.rs         # PE byte-pattern RVA resolver + _mi_stats_main / mi_arenas reader
│   └── generic.rs       # Standalone mimalloc*.dll export/signature detector
├── symbols/mod.rs       # 4-tier x64 resolver: PDB > PE Export > .zen2sym.json > PE .pdata
├── metrics/mod.rs       # Exclusive CPI Stack, Retiring %, MPKI, ring buffers, CCX/SMT aggregation
├── baseline/mod.rs      # Raw-cumulative JSON persistence, pack-aware Δ%, MUX DIFF checks
├── diagnostics/mod.rs   # Pure DiagnosticEngine::evaluate, evidence gate, Amdahl Est. Gain
└── ui/                  # 7-tab borderless ratatui views, Braille plots, modals, ? Help
```

---

## 3. Goals (What `zen2top` MUST Deliver)

### 3.1 Flexible Profiling Modes & CLI
- **System-Wide Default (`zen2top`):** Launch straight into live system-wide PMU telemetry with zero nagging about missing targets or allocators. Switching to process-dependent tabs (Tabs 4, 6, 7) or pressing `p` shows the native Win32 process picker.
- **Target Mode (`--target <name|pid>`):** Attach immediately if running, or display a non-blocking *"Waiting for `<target>`..."* banner while streaming system-wide PMU data. Auto-attach on spawn; gracefully re-enter waiting state on exit.
- **Interactive Process Picker (`p`):** Native Win32 list with fuzzy search (`/`), sortable by CPU%, Working Set, or Name (`s`), `Enter` to attach, `d`/`Esc` to detach.
- **Host Latency Calibration (`--calibrate`):** ~1-second single-threaded pointer-chase at 16 KiB (L1), 256 KiB (L2), 8 MiB (L3), and 128 MiB (unloaded DRAM) plus a 50/50 random-branch loop that writes verified host latencies into `config.toml` (`calibrated = true`).
- **Full CLI Flags:** `--target <name|pid>`, `--calibrate`, `--unlock-pmc`, `--preset <slug>`, `--packs <csv>`, `--interval <1|2|5>`, `--baseline <path.json>`, `--symbols <path>`, `--config <path.toml>`, `--no-pmu`.

### 3.2 Modular Zen 2 PMU Pack Picker & 6-Slot Bin-Packing (`m`)
Zen 2 has **6 programmable Core PMC registers** per core. Fixed MSRs (`aperf`, `mperf`, `irperf`) and CCX L3 PMCs live in separate hardware domains (0 Core PMC slots).

- **Always-On Free Base (0 Core PMC slots, always 0-Mux / 100%):**
  - Fixed MSRs: `aperf`, `mperf`, `irperf`
  - CCX L3 PMCs: `l3_access` (`0xFF0F00000040FF04`), `l3_miss` (`0xFF0F000000400104`), `l3_lat` (`0xFF0F000000400090`), `l3_mtype` (`0xFF0F000000401F9A`)
  - Universally supplies:
    - $\text{IPC} = \frac{\text{inst}}{\text{aperf}}$ and $\text{Actual CPI} = \frac{\text{aperf}}{\text{inst}}$ (reclaiming `0x430076` frees 1 Core PMC slot)
    - $\text{Eff GHz} = \frac{\text{aperf}}{\text{mperf}} \times \frac{\text{base\_mhz}}{1000}$
    - Per-logical-CPU active duty cycle: $\text{C0\%} = \text{clamp}\left(\frac{\Delta \text{mperf}}{\text{base\_mhz} \times 10^6 \times \Delta t} \times 100,\ 0,\ 100\right)$
    - Unified L3 Hit % and live measured L3 miss latency: $\text{Lat}_{\text{cyc}} = \frac{\text{l3\_lat} \times 16}{\text{l3\_mtype}}$ and $\text{Lat}_{\text{ns}} = \frac{\text{Lat}_{\text{cyc}}}{\text{Eff GHz}}$
- **12 Atomic Core PMC Packs (24 slots total = 4 exact mux groups of 6):**
  1. `DcDemand` (2): `0x430243`, `0x430843` (D-Cache L3/DRAM Demand)
  2. `DcHwpf` (2): `0x43025A`, `0x43085A` (D-Cache L1 HWPF L3/DRAM)
  3. `L1L2Dc` (2): `0x43C860`, `0x430864` (L1/L2 D-Cache Hierarchy)
  4. `L1L2Ic` (2): `0x431060`, `0x430164` (L1/L2 I-Cache Hierarchy)
  5. `L2Hwpf` (2): `0x431F71`, `0x431F72` (L2 HWPF L3/DRAM)
  6. `Branches` (2): `0x4300C2`, `0x4300C3` (Branches & Mispredicts)
  7. `ItlbFull` (3): `0x430794`, `0x430084`, `0x430785` (L1/L2 iTLB)
  8. `DtlbFull` (2): `0x430F45`, `0x43F045` (L1/L2 dTLB)
  9. `CrossCcxLocks` (2): `0x430443` (other-CCX fills), `0x430325` (`bus_lock | non_spec_lock`)
  10. `OpCacheDecode` (2): `0x4301AA` (legacy decoder), `0x4302AA` (Op-Cache)
  11. `StlfSplits` (2): `0x430224` (STLF interlocks), `0x430047` (64B cache-line splits)
  12. `ExactRetiring` (1): `0x4300C1` (`ExRetUops`)
- **Zero-Split Bin-Packing Invariant:** Order Core PMCs into 6-slot bins via First-Fit Decreasing so **no coupled pack ever straddles a 6-register boundary**. If `bins > 1` and a non-final bin ends with 5 slots (`ItlbFull (3)` + a 2-slot pack without `ExactRetiring`), automatically pad the 6th slot with `ExactRetiring (0x4300C1)` at zero mux cost and display `[auto-pad]`.
- **Driver Guardrail:** Enforce `enabled_core_pmcs >= 1` (AMD uProf requires at least one programmable Core PMC alongside fixed MSRs).
- **6 Quick Presets:** `Full (3-Mux, 18/18)`, `Kitchen Sink (4-Mux, 24/24)`, `Balanced Daily (2-Mux, 12/12)`, `TLB-Only (0-Mux, 6/6)`, `Mem + CCX Lab (0-Mux, 6/6)`, `Micro-Arch (0-Mux, 6/6)`.

### 3.3 Core Metrics, Pipeline Retiring % & Two-Line Exclusive CPI Stack
- **Throughput + Efficiency Together:** Always show live `Inst/s` and `Cyc/s` alongside `IPC` so thread-count drops cannot disguise themselves as IPC gains.
- **6-Wide Zen 2 `Retiring %`:**
  - When `ExactRetiring` (`0x4300C1`) is active: $\text{Retiring \%} = \frac{\text{ret\_uops}}{6 \times \text{cycles}} \times 100$ (displayed as `Ret XX%`).
  - Otherwise (zero extra PMCs): $\text{Retiring \%} = \frac{\text{IPC} \times \text{uops\_per\_inst}}{6} \times 100$ using `uops_per_inst = 1.15` in `config.toml` (always prefixed with tilde: `Ret ~XX%`).
  - Document in `?` Help that practical C++/game workloads cap around ~45–60% Retiring (2.5–3.5 IPC) due to dependency chains and Zen 2's 2-load/1-store ports.
- **Exclusive Tier MPKIs (clamped $\ge 0$):**
  - $\text{L2D}_{\text{excl}} = \max(0,\ \text{L1D}_{\text{miss}} - \text{L2D}_{\text{miss}})$
  - $\text{L2I}_{\text{excl}} = \max(0,\ \text{L1I}_{\text{miss}} - \text{L2I}_{\text{miss}})$
  - $\text{Tier CPI} = \frac{\text{Exclusive MPKI}}{1000} \times \text{Latency}_{\text{cyc}}$ (DRAM tier uses live measured `l3_lat` whenever valid, falling back to `config.toml`).
- **Two-Line CPI Stack Visualization:**
  - **Line 1 (`Actual`):** Solid bar scaled to Actual CPI + `OoO/MLP hides X.XX` readout.
  - **Line 2 (`Modeled`):** Color-coded stack on the exact same scale, grouped into **Flush** (`Branch`, `L2I`, `iTLB`) and **MLP** (`L2D`, `L3`, `DRAM`, `dTLB`).

### 3.4 Per-Core SMT Pairing & CCX0/CCX1 Split (`c`, Default OFF)
- Discover exact physical-core-to-logical-CPU sibling pairs at startup via `GetLogicalProcessorInformationEx(RelationProcessorCore)` (never hardcode even/odd IDs).
- Show 2-row `CCX0 vs CCX1` summary (IPC, GHz, L3 Hit%, L3 Lat, DRAM MPKI) paired with numeric per-core sibling pairs: `P0 1.42(88%) │ idle` (muted `│` in 1T mode, yellow `⇄` when **both** siblings are $\ge 15\%$ C0 active, dimmed `idle` below $2\%$ C0).

### 3.5 Two-Layer Memory, Allocator & Per-DLL IFEO Manager
- **Layer 1 (Universal — Works on CRT & Any Process):** Native Win32 OS Working Set (`Private`, `Shared`, `Total 4 KiB`, `Hardware 2 MiB Huge`, `Total Real Phys`, `Commit/Peak`), live soft Page Faults/s + PDH hard `Page Reads/sec`, `GetPerformanceInfo` RAM pressure, `GetProcessIoCounters` Disk R/W MB/s & IOPS, and `VirtualQueryEx` + `QueryWorkingSetEx` 4-bucket VA map (`Private RW`, `Private JIT RX/RWX`, `Mapped`, `Image` split by 2 MiB vs. 4 KiB).
- **Layer 2 (`AllocatorInspector` Trait):**
  - `Tier0MimallocV2Inspector`: Port exact PE byte-pattern RVA resolver (`_mi_stats_main`, `mi_arenas`, `mi_arena_count`), 2D 32 MiB block heatmap (`█` active, `▓` peak-touched, `░` free) per 1 GiB chunk, 4 KiB OS arenas, and full `heap stats` table.
  - `GenericMimallocInspector`: Auto-detect standalone `mimalloc*.dll` via exports/signatures; fail cleanly to Layer 1 on mismatch.
  - Graceful CRT/Unknown fallback: Clean 3-row OS backing breakdown with zero errors.
- **Tab 3 Interactive IFEO Manager:** Toggle per-DLL `LargePageDLLs` (`Space`/`Enter`) and master `UseLargePages` (`U`) directly in HKLM Registry with: (a) Admin elevation check, (b) one-time `[y/N]` anti-cheat/`-insecure` confirmation modal, (c) warnings/protection on core OS & GPU driver DLLs, and (d) explicit pending-restart markers (`-> 2MiB*` / `-> 4KiB*`).

### 3.6 Zero-PMC OS/GPU/Scheduler Deep Telemetry & Per-Thread Control (`Tab 6`)
- **Vendor-Agnostic GPU 3D Utilization:** `D3DKMTEnumAdapters2` + `D3DKMTQueryStatistics` from `gdi32.dll`.
- **Per-CPU DPC/IRQ Collision:** `NtQuerySystemInformation(SystemProcessorPerformanceInformation)`.
- **Noisy Neighbors & Lock Contention:** `SystemProcessInformation` top background CPU consumers + target per-thread `ContextSwitches/s` and synchronization `WaitReason`s.
- **Priority & Windows 11 EcoQoS:** `GetPriorityClass` + `GetProcessInformation(ProcessPowerThrottling)` (degrade `ERROR_INVALID_PARAMETER` cleanly on pre-22H2 builds).
- **Exact `SeLockMemoryPrivilege` Verification:** `OpenProcessToken` + `GetTokenInformation(TokenPrivileges)`.
- **Present / Frame-Time & Flip Mode ETW (`DXGI` + `DxgKrnl`):** Live FPS, avg / 1% low / 0.1% low frametime Braille graph, Presentation Mode (`Hardware: Independent Flip` vs. `Composed: Flip`), and 1s-bucket frametime spike correlator (DRAM lat, Page Faults, DPC/IRQ, CtxSw, Disk I/O).
- **Per-Thread Table & Live Affinity Sandbox (`Tab 6`):** Thread names (`GetThreadDescription` -> start-address module+offset), CPU%, CtxSw/s, State/Wait, Core/Affinity (flagging `⇄`), interactive affinity modal (`a`) with CCX0/CCX1/Physical-only/Single-core presets, protected-process `ERROR_ACCESS_DENIED` handling, and one-key revert (`R`).

### 3.7 Dual-Engine Function & Call-Stack Profiler (`Tab 7`)
- **4-Tier x64 `SymbolResolver`:** Priority order `PDB (dbghelp/pdb)` > `PE Export Table` > `Sidecar .zen2sym.json RVA map` > `PE .pdata (RUNTIME_FUNCTION binary search -> module!fn_0xRVA)` so even stripped binaries group cleanly into exact functions and call trees.
- **Live Zero-PMC ETW Profiler (`e` toggle):** Kernel `SampledProfile` (On-CPU, 1–4 kHz) + `CSwitch`/`ReadyThread` (Off-CPU blocked time & waker attribution) + `StackWalk` + `IMAGE_LOAD`, filtered strictly to attached PID, bounded node cap (~20k nodes), clean `ControlTraceW` stop on exit.
- **On-Demand `AMDuProfCLI` Hardware-Stall & IBS Burst (`f`):** 5s/10s burst for IBS Op Load Latency, DRAM/L3 misses, Branch Mispredicts, or L2 iTLB/dTLB walks. Managed by `PmuCoordinator` (stop `AMDuProfPcm` -> `collect` -> `report` -> parse -> delete temp dir -> **guaranteed resume** even on failure).

### 3.8 Evidence-Gated Advisor (`Tab 5`)
- Pure, unit-testable `DiagnosticEngine::evaluate(&DiagnosticInput) -> DiagnosticReport`.
- **Evidence Gate:** Evaluates cumulative/window totals only; requires $\ge 10$ samples and active load (`avg_c0_pct >= 10%` or `inst_per_sec >= 1.5e9`).
- **Human-Readable Verdict + `Proof:` Line:** Never prints raw Rust enum identifiers; always cites exact winning metrics + `Ret ~XX%`.
- **Zero Orphan Verdicts:** If the winning verdict category triggered no `HI`/`MD` anomaly rule, always emit a top diagnostic row explaining the primary ceiling and honest levers.
- **Action Scopes:** `[OS / TUI]`, `[HW / BIOS]`, `[Code / Build]`.
- **Every Finding Includes:** `Why`, `Action`, `Cascade` (downstream metrics improved), `Confidence`, `Quick Jump Tab` (`Enter`), and `Est. Gain`:
  - CPI-backed findings compute conservative-to-optimistic Amdahl speedup ranges using visible overlap $\text{vis} = \text{clamp}\left(\frac{\text{Actual CPI}}{\text{Modeled CPI}},\ 0.25,\ 1.0\right)$, Flush vs. MLP overlap bounds, explicit reduction assumptions, and a strict $\text{new\_cpi} \ge 0.25$ (4.0 IPC) clamp.
  - Non-CPI findings use honest qualitative labels (`1% lows / MLP`, `FPS gated by GPU`, `A/B accuracy`, etc.).
- **Complete Cross-Tab Rule Coverage:**
  - *PMU Core/Cache/TLB:* PE Code iTLB + 4 KiB DLLs, Silent IFEO / Mimalloc Failure (split by `SeLockMemoryPrivilege` missing vs. RAM fragmentation), Heap dTLB / Mimalloc 4 KiB Spillover, SMT Sibling Contention (suppressed if all physical cores $> 85\%$ saturated), Cross-CCX Thread Spread, Loaded DRAM Queueing vs. calibrated unloaded baseline, Demand DRAM Pointer-Chasing, Branch Mispredictions, True L1/L2 I-Cache Capacity (`0x430164`, NOT `l2icExcl`), Clock Throttling, Measurement Hygiene (`MUX DIFF` + `< 3%` delta in $\ge 2$-Mux).
  - *Zero-PMC Win32 / ETW:* GPU-Bound (`>= 97%` GPU 3D + `< 75%` hot CPU), DPC/IRQ Core Collision (`>= 5%` DPC+IRQ on $\ge 60\%$ C0 core), Noisy Neighbor (`>= 5%` system CPU or $\ge 50\%$ of 1 core), Priority / EcoQoS Throttling, Hard Disk Page Faults (`>= 20/s` or `< 5%` free RAM), Context-Switch / Lock Storm (`>= 50k/s` + $\ge 40\%$ sync waits), Composed Flip Mode, JIT 4 KiB Residual iTLB, Disk I/O Streaming Stalls, Frametime Spike Correlator.
  - *Micro-Arch Packs (evaluated only when active):* Cross-CCX Cache-Line Bouncing (`0x430443`), Serialized Lock Contention (`0x430325`), Op-Cache Thrashing (`0x4301AA`/`0x4302AA`), STLF Interlocks (`0x430224`), Cache-Line Splits (`0x430047`).
- **Tab 7 Enrichment + `Verified Healthy` Strip:** Attach top offending function/wait stack when Tab 7 data exists; show passing cross-tab checks at the bottom so users know what was evaluated and cleared.

### 3.9 First-Class A/B Baselines (`b`) & Self-Explanatory Help (`?`)
- Persist `baselines/<timestamp>_<slug>.json` storing **raw cumulative counter totals**, elapsed seconds, sample count, target, affinity mask, `enabled_packs`, `core_pmc_slots`, `mux_groups`, IFEO state, and user note (with `#[serde(default)]` backwards compatibility).
- Support pinning current session, 15s/30s timed captures, loading/clearing baselines, pack-aware per-metric `%` deltas, and explicit `MUX DIFF` warnings.
- `?` Help modal explains IPC/CPI/MPKI, Exclusive CPI Stack, OoO/MLP overlap, `Retiring %`, Amdahl `Est. Gain`, 0-Mux vs. N-Mux, active `config.toml` latencies, Zen 2 thresholds, all PMC hex codes, and keybindings.

---

## 4. Non-Goals (Explicitly Out of Scope)

Agents MUST NOT spend effort designing or building any of the following:
1. **AMD Top-Down `pipeline` Mode:** Physically unsupported on Zen 2 (Zen 4+ only). Do not add or fake a 4-way 100% pipeline slot breakdown.
2. **Continuous 1 Hz Live IBS Streaming:** IBS is strictly an on-demand 5–10s batch capture via `AMDuProfCLI` on Tab 7.
3. **Cross-Platform Linux/macOS Ports:** `zen2top` is unapologetically Windows 11 native (`windows` crate, Win32, ETW, IFEO, `AMDuProf`).
4. **Vendor-Specific GPU SDKs (NVAPI, ADL, IGCL):** Use vendor-agnostic `D3DKMTQueryStatistics` only.
5. **Kernel Drivers, DLL Injection, API Hooking, or Anti-Cheat Bypasses:** All telemetry is external and read-only (plus documented Windows Registry IFEO and `SetThreadAffinityMask` with explicit user confirmation and `ERROR_ACCESS_DENIED` handling).
6. **Permanent Windows "Optimizer" / Registry Tweaker Features:** Never modify global OS power plans, disable Defender, edit boot BCD, or persist thread affinities across reboots. The only registry writes allowed are user-initiated, confirmed per-DLL IFEO edits on Tab 3.
7. **Web Server, Browser Frontend, or GUI Wrapper:** Pure native terminal TUI only.

---

## 5. Anti-Goals (Hard Red Lines — NEVER Violate)

### 5.1 UI & Readability Anti-Goals
- **NEVER nest bordered boxes inside bordered boxes.** Do not wrap individual KPIs, CPI tiers, or individual CPU cores (`C00`–`C11`) in separate bordered cards. Use at most 3–4 regions per tab separated by thin rules (`─` / `│`).
- **NEVER use pill/color soup.** Keep 90% of the screen monochrome white/gray. Reserve color for severity thresholds, the single `#1` bottleneck row (`>>`), and plain right-aligned `%` delta text—never bordered tinted pills around every metric.
- **NEVER duplicate the same metrics in two formats on one screen** (e.g., CPI stack bar + 6 mini cards + 2 bottleneck cards).
- **NEVER prefix main-view metric labels with raw PMC hex codes** (`0x430843`, etc.). Keep hex codes in `?` Help.
- **NEVER exceed 2 lines of top chrome or 1 line of bottom chrome** (keep bottom key bar to $\le 7$ primary items; tuck secondary controls inside `b`, `m`, and `?` modals).
- **NEVER replace numeric per-core IPC/`C0%` with low-resolution 1-char vertical blocks**, and **NEVER default the CCX strip (`c`) to ON**.
- **NEVER display walls of empty `--` rows for disabled metric packs.** Dynamically show only metrics whose packs are active.

### 5.2 Math, Hardware & Diagnostic Anti-Goals
- **NEVER normalize the Exclusive CPI Stack to 100%** and **NEVER slice/fade rightmost tiers past a single vertical `│` marker** (visually misattributes OoO hiding to Branch/TLB instead of MLP memory stalls).
- **NEVER build a stacked bar out of IPC.** IPC is reciprocal speed; CPI is additive time.
- **NEVER store averages-of-averages in baselines.** Always accumulate and serialize raw counter totals.
- **NEVER subtract `sum(all stalls)` from Actual CPI** or allow Amdahl estimates to divide by zero or fall below the `0.25` CPI floor.
- **NEVER invent fake IPC `%` gains for qualitative/non-CPI findings** (SMT, Cross-CCX, GPU-bound, Page-Faults, Mux hygiene).
- **NEVER allow a coupled multi-event PMC pack to split across a 6-register mux boundary**, and **NEVER allow 0 Core PMCs alongside fixed MSRs**.
- **NEVER feed `l2icExcl` (L2 I-Cache *hits* = `L1i - L2i`) into an L2 I-Cache *miss* rule.** Always use true `l2_ic_miss` (`0x430164`).
- **NEVER display an orphan Advisor verdict** without a `Proof:` line and corresponding explanation row.
- **NEVER fire SMT contention when all physical cores are saturated ($> 85\%$ C0)**—in throughput-bound saturation, SMT adds net work.
- **NEVER fire Advisor findings before the evidence gate** ($\ge 10$ samples + active load).
- **NEVER suggest OS/Windows tweaks for `[Code / Build]` bottlenecks** (Branch Mispredicts, L1i/L2i capacity, Op-Cache thrashing, STLF, Cache-Line splits) on closed-source binaries.

### 5.3 Runtime & Safety Anti-Goals
- **NEVER spawn PowerShell subprocesses.**
- **NEVER call `SuspendThread` or walk target NT heap locks** for profiling or memory inspection.
- **NEVER run `AMDuProfPcm.exe` and `AMDuProfCLI.exe` concurrently.** Always serialize through `PmuCoordinator`.
- **NEVER leak Win32 `HANDLE`s or leave orphaned Windows ETW sessions running** on exit, error, or Ctrl+C.
- **NEVER crash or panic on `ERROR_ACCESS_DENIED` (anti-cheat/protected processes), missing `AMDuProf`, missing PDBs, or pre-22H2 Win11 APIs (`ProcessPowerThrottling`).** Always degrade gracefully.

---

## 6. Tab Map & Primary Keybinding Contract

Preserve `1–7` tab positions and muscle-memory hotkeys across all future changes:

| Tab | Key | Primary Question Answered |
| :--- | :---: | :--- |
| **Overview** | `1` | How fast am I running (`IPC`, `Ret %`, `Inst/s`), what is my #1 stall (`CPI Stack`), and how does it compare to my baseline? |
| **Cache & Memory** | `2` | Where are loads landing (`L1` -> `L2` -> `L3` -> `DRAM`), `DEMAND` vs. `HWPF`, and what is live L3 miss latency (`cyc`/`ns`)? |
| **TLB & Large Pages** | `3` | Are iTLB/dTLB walks costing cycles, are PE DLLs + JIT code on 2 MiB or 4 KiB pages, and which DLLs should I toggle in IFEO? |
| **Memory & Allocator** | `4` | What is real physical RAM (`2 MiB` vs. `4 KiB`), soft/hard page fault rate, Disk I/O, VA map, and Mimalloc arena headroom? |
| **Advisor** | `5` | What am I provably bound by, what concrete actions fix it, what cascades downstream, and what is the estimated gain? |
| **Threads & Frames** | `6` | Which threads are hot/blocked/SMT-contended, how is frame pacing (`1%`/`0.1%` lows, Flip mode), and what happens if I tune affinity? |
| **Profiler** | `7` | Which exact functions and call stacks consume On-CPU time, Off-CPU wait time, or hardware DRAM/Branch/TLB/IBS stalls? |

**Global Keys:** `1-7`/`Tab` tabs · `p` process picker · `m` metric pack picker · `b` baseline & sampler modal · `c` toggle CCX/SMT strip · `Space` pause · `d` detach · `?` help & glossary · `q` quit.

---

## 7. Verification & Quality Gates

Before considering any task complete, agents MUST verify:
1. **`cargo test` passes 100%** — including unit tests for:
   - Exhaustive 6-slot bin-packing across all $2^{12} - 1 = 4,095$ non-empty `MetricPack` subsets (zero split coupled pairs, auto-pad behavior, empty-set rejection).
   - `report_core.csv` and `report_l3.csv` parsing (affinity filtering, CCX0/1 split, per-core `inst / aperf` IPC and `mperf` `C0%`).
   - Two-line Exclusive CPI Stack clamping, `Retiring %` (estimated & exact `0x4300C1`), and `tier0.dll` PE byte-pattern RVA resolution.
   - Baseline JSON round-trip (including backwards-compatible `#[serde(default)]` loading) and `MUX DIFF` detection.
   - Advisor rules: `< 10` sample evidence gate, no-orphan-verdict invariant, SMT suppression under full-core saturation, true `l2_ic_miss` vs. `l2icExcl`, Amdahl `0.25` CPI floor clamping, qualitative-only non-CPI rules, GPU-bound verdict modifier, DPC/IRQ hot-core intersection, and `SeLockMemoryPrivilege` branching.
   - 4-tier `SymbolResolver` precedence (`PDB > Export > Sidecar JSON > .pdata` binary search), ETW On-CPU/Off-CPU aggregation, and `PmuCoordinator` guaranteed resume on burst error.
2. **`cargo clippy --all-targets` exits with zero warnings.**
3. **Visual Anti-Clutter Audit:** Inspect any UI change against Section 5.1 (no nested cards, no hex prefixes, no pill soup, no `--` padding walls, clean 2-line top / 1-line bottom chrome).