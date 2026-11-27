# TESTING.md — `zen2top` Hardware-in-the-Loop Advisor Verification Phase

Load this document **only after** `cargo build --release`, `cargo test`, and `cargo clippy --all-targets` pass.

The goal of this phase is to prove empirically on real AMD Zen 2 hardware that `zen2top`'s Advisor (`DiagnosticEngine`) produces **accurate, high-signal recommendations with ≥95% precision (≤5% false-positive rate)** across isolated synthetic workloads and real CLI software.

---

## 1. Non-Negotiable Testing Rules

1. **No Real Games:** Never launch, attach to, or depend on any real video game (with or without anti-cheat). All GPU/Present/Flip-mode testing uses a self-contained synthetic Win32/DXGI render harness.
2. **Primarily CLI & Self-Contained Workloads:** Every test case must be launchable unattended from the command line using `zen2top --headless`.
3. **Observable & In-Scope Effects Only:** Only test hardware/OS phenomena that are physically observable on AMD Zen 2 via `zen2top`'s 12 Core PMC packs, L3 PMCs, fixed MSRs, or Win32/ETW telemetry (inspired by the observable subset of `kobzol/hardware-effects` plus Zen 2 TLB/Micro-Arch/Win32 rules). Never invent rules or tests for unobservable effects.
4. **Honest Calibration, Never Test-Rigging:** If a test fails, inspect the raw JSON telemetry first. Fix genuine bugs in Advisor thresholds, gating conditions, counter math, or broken synthetic loops—**never** weaken `must_not_fire` assertions or delete failing cases to manufacture a pass.
5. **Respect PMC Safety:** If `zen2top --headless` exits with code `3` (PMC occupied), do **not** bypass eviction safeguards. Report the exact occupying session/process from `meta.pmc_contention` and mark PMU-dependent tests as `BLOCKED` until the user clears it via interactive `--unlock-pmc`.

---

## 2. Phase 0: Pre-Flight Calibration

1. Run `zen2top --calibrate` on a quiet host to write verified L1, L2, L3, and unloaded DRAM latencies into `config.toml` (`calibrated = true`).
2. Run a 15-second idle sanity check (`zen2top --headless --duration 15 --preset full --json-report target/test_reports/00_preflight.json`):
   - Verify exit code `0` (PMCs accessible) and `meta.calibrated == true`.
   - Verify no background noise triggers spurious findings during idle (`evidence_gate_passed == false`).

---

## 3. Phase 1: Synthetic Micro-Benchmark Suite (`crates/synth_bench`)

Build a single, small Rust binary (`crates/synth_bench` or `examples/synth_bench.rs`, compiled with `--release`) with subcommands that isolate **one** hardware or OS characteristic at a time. Each test runs for `--duration 15` (with `--warmup 2` so steady-state counters clear the $\ge 10$ sample evidence gate) using `zen2top --headless --launch`.

Every test case enforces a **confusion-matrix contract**:
- **`must_fire`:** Rule IDs or verdicts that MUST be emitted.
- **`must_not_fire`:** Rule IDs that MUST NOT be emitted (guarding the ≥95% precision target).
- **`invariants`:** Quantitative counter sanity bounds proving the workload actually exercised the hardware.

### 3.1 Observable CPU & Memory Effects (`hardware-effects` Inspired)

| Subcommand | Workload Mechanics (Isolated Effect) | Preset / Packs | `must_fire` | `must_not_fire` | Metric Invariants |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `pointer-chase` | 128 MiB Fisher-Yates cyclic pointer chase, 1 pinned core | `full`, then confirm `mem-ccx-lab` (0-Mux) | Demand DRAM Pointer-Chasing | Branch, iTLB, SMT, Cross-CCX, Data-Dependency | `IPC < 0.5`, high Demand DRAM MPKI (`0x430843`) |
| `seq-stream` | 128 MiB linear sequential read scan, 1 pinned core | `full` | *(Discriminative negative control for pointer-chasing)* | Demand DRAM Pointer-Chasing, Branch, iTLB | HWPF fills dominate Demand DRAM fills |
| `bw-saturation` | 6 threads pinned to 6 physical cores streaming 256 MiB+ arrays | `full`, then confirm `mem-ccx-lab` (0-Mux) | Loaded DRAM Queueing | Demand DRAM Pointer-Chasing, SMT Contention, Branch | `l3_lat_ns > 1.30 * calibrated_dram_ns`, high DRAM MPKI |
| `branch-mispredict` | L1-resident xorshift 50/50 unpredictable conditional & indirect branches | `full`, then confirm `micro-arch` (0-Mux) | Branch Mispredictions (`[Code / Build]`) | DRAM, L3, dTLB, iTLB, I-Cache | High branch mispredict MPKI (`0x4300C3`), low DRAM MPKI |
| `cache-tier-l2` | 256 KiB random cyclic chase (fits in 512 KiB L2, misses 32 KiB L1D) | `full` | L2 D-Cache dominant CPI tier | Demand DRAM Pointer-Chasing, dTLB, Branch | `L2D_excl` dominates CPI stack; low DRAM MPKI |
| `cache-tier-l3` | 8 MiB random cyclic chase (fits in 16 MiB CCX L3, misses L2) | `full` | L3 dominant CPI tier | Demand DRAM Pointer-Chasing, Branch, iTLB | High L3 Hit %, `L3` tier dominates CPI stack |
| `misaligned-splits` | L1-resident unaligned loads straddling 64-byte cache-line boundaries | `micro-arch` (0-Mux) | Cache-Line Splits (`[Code / Build]`) | DRAM, Branch, Op-Cache | High `0x430047` MPKI |
| `stlf-4k-alias` | Narrow stores immediately followed by overlapping/4 KiB-aliased wider loads | `micro-arch` (0-Mux) | STLF Interlocks (`[Code / Build]`) | DRAM, Branch, Cache-Line Splits | High `0x430224` MPKI |
| `false-sharing-ccx` | 2 threads pinned to CCX0 + CCX1 writing adjacent atomics in same 64B line | `mem-ccx-lab` (0-Mux) | Cross-CCX Cache-Line Bouncing (`0x430443`) + Cross-CCX Spread | Branch, iTLB, SMT | High other-CCX fills (`0x430443`) |
| `false-sharing-local` | Same 2-thread workload pinned to 2 physical cores inside **same** CCX0 | `mem-ccx-lab` (0-Mux) | *(Control)* | Cross-CCX Cache-Line Bouncing, Cross-CCX Spread | `0x430443` near zero |
| `dep-chain` | L1/register-resident serial dependent ALU chain (e.g., dependent `imul`/add loop) | `full` & `kitchen-sink` | Data-Dependency / ILP-Bound (`[Code / Build]`) | DRAM, L3, L2, TLB, Branch, Op-Cache, Lock | `IPC < 1.1`, `Retiring % < 22%`, all stall MPKIs minimal |

### 3.2 Zen 2 TLB, Front-End & Synchronization Isolators

| Subcommand | Workload Mechanics | Preset / Packs | `must_fire` | `must_not_fire` | Metric Invariants |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `dtlb-thrash` | 512 MiB 4 KiB-strided random reads (defeating L1/L2 dTLB reach) | `tlb-only` (0-Mux) | Heap dTLB (`DtlbFull`) | iTLB, Branch, Op-Cache | High L2 dTLB miss MPKI (`0x43F045`) |
| `itlb-icache-jit` | `VirtualAlloc` RWX code buffer jumping across thousands of 4 KiB pages | `tlb-only` (0-Mux), then `full` | iTLB + JIT 4 KiB Residual iTLB + True L1/L2 I-Cache Capacity (`0x430164`) | dTLB, DRAM Pointer-Chasing | High `0x430785` + `0x430164`, VA map shows JIT RX/RWX 4 KiB |
| `opcache-thrash` | L2-resident dense unrolled branch/NOP code exceeding Zen 2's 4K-uop Op-Cache | `micro-arch` (0-Mux) | Op-Cache Thrashing (`0x4301AA`/`0x4302AA`) | DRAM, dTLB, STLF | Legacy decode share elevated vs. Op-Cache |
| `atomic-lock-storm` | 4 threads hammering contended `AtomicU64::fetch_add` / split-lock bus locks | `mem-ccx-lab` (0-Mux) | Serialized Lock Contention (`0x430325`) | Branch, iTLB | High `0x430325` lock events |

### 3.3 Zero-PMC Win32, Scheduler & Synthetic Render Isolators

| Subcommand | Workload Mechanics | Preset / Packs | `must_fire` | `must_not_fire` | Metric Invariants |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `smt-contention` | 2 compute threads pinned to the **same** physical core's SMT sibling pair (via topology API); other cores idle | `balanced` | SMT Sibling Contention | Cross-CCX, GPU-Bound | 1 active core pair flagged `⇄`, other cores idle |
| `smt-saturated` | All logical CPUs (e.g., 12T) running full compute (`>90%` C0 across all physical cores) | `balanced` | *(Anti-Goal control)* | **SMT Sibling Contention** | All physical cores `>85%` C0 |
| `ctxsw-storm` | 4 threads ping-ponging on a Win32 `Mutex`/Event (`>60k` ctx switches/s) | `--no-pmu` | Context-Switch / Lock Storm | GPU-Bound, EcoQoS, Hard Page Faults | `ctx_sw_per_sec >= 50_000`, `sync_wait_pct >= 40%` |
| `ecoqos-throttled` | Busy compute loop enabling `PROCESS_POWER_THROTTLING_EXECUTION_SPEED` + `IDLE_PRIORITY_CLASS` | `--no-pmu` | Priority / EcoQoS Throttling | Context-Switch Storm, Disk I/O | `ecoqos_active == true` or low priority detected |
| `noisy-neighbor` | Moderate target + separate helper process burning 2 physical cores | `--no-pmu` | Noisy Neighbor | EcoQoS, GPU-Bound | Helper appears in `noisy_neighbors[]` |
| `disk-io-stall` | Unbuffered (`FILE_FLAG_NO_BUFFERING`) sequential temp-file reads/writes in `%TEMP%` | `--no-pmu` | Disk I/O Streaming Stalls | GPU-Bound, EcoQoS | Elevated `disk_read_mb_s` / `disk_write_mb_s` |
| `synth-dxgi-gpu --gpu-heavy` | Minimal synthetic Win32/DXGI D3D11/D3D12 shader loop saturating GPU 3D (`>=97%`) with lightweight CPU submission | `--no-pmu` | GPU-Bound + Present ETW telemetry active | EcoQoS, Context-Switch Storm | `gpu_3d_pct >= 97%`, hot CPU `< 75%`, valid FPS/frametime |
| `synth-dxgi-gpu --windowed-composed` | Minimal synthetic windowed DXGI swapchain forcing DWM composition (`Composed: Flip`) | `--no-pmu` | Composed Flip Mode | Hard Page Faults, EcoQoS | `flip_mode` reports Composed Flip |

### 3.4 Negative Controls (Strict False-Positive Guards)

| Subcommand | Workload Mechanics | Preset / Packs | `must_fire` | `must_not_fire` | Metric Invariants |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `healthy-compute` | Independent register/SIMD ALU throughput loop (`IPC > 2.5`), 1 pinned core | `kitchen-sink` (4-Mux) AND `balanced` | `Verified Healthy` checks populated | **ANY `HI` or `MD` anomaly** (0 false positives) | `IPC >= 2.2`, `Retiring % >= 40%` |
| `short-gate` | `pointer-chase` run for only `--duration 5` (`< 10` samples) | `full` | `evidence_gate_passed == false` | **ANY finding** | `sample_count < 10`, `findings.is_empty()` |
| `mux-hygiene` | Compare `healthy-compute` in `kitchen-sink` (4-Mux) against a `mem-ccx-lab` (0-Mux) baseline | `kitchen-sink` + `--baseline` | Measurement Hygiene (`MUX DIFF`) | Spurious performance regression findings | `baseline_diff.mux_diff_warning == true` |

---

## 4. Phase 2: Real Self-Contained CLI Software Validation

Run `zen2top --headless` against real, deterministic local CLI software (no games) using the **two-stage workflow** (Stage 1: `kitchen-sink` 4-Mux smoke test -> Stage 2: targeted 0-Mux confirmation of any flagged category):

1. **Compiler Workload (`cargo build --release` on `zen2top` or `synth_bench` after `cargo clean -p`):**
   - Verify Advice is coherent with real compiler behavior (e.g., branchy/front-end/iTLB/multi-thread activity) and does **not** emit bogus GPU-Bound, EcoQoS, DPC/IRQ, or hardcoded-engine messages.
2. **Search / Compression CLI Workload (e.g., `rg`, `git grep`, or a Rust `flate2`/`zstd` CLI compressing a multi-hundred-MiB temp corpus):**
   - Verify Layer 1 memory/I/O telemetry and Advisor conclusions match raw IPC, cache, and Disk I/O metrics.
3. **Allocator-Injected Real CLI (`rminject` running a real allocation-heavy Rust/Win32 CLI workload):**
   - Verify Layer 2 `AllocatorInspector` detects `mimalloc`, VA map distinguishes 2 MiB vs. 4 KiB backing accurately, `SeLockMemoryPrivilege` branching works, and non-injected standard CRT / direct `VirtualAlloc` targets display **generic Layer 1 labels** (zero hardcoded app/engine names).
4. **Profiler Attribution Check (`--include-profiler` on `synth_bench pointer-chase` and `branch-mispredict`):**
   - Verify Tab 7 / `profiler` JSON resolves the exact hot Rust function name via PDB / `.pdata` (`> 50%` attribution to the benchmark loop function).

---

## 5. Phase 3: Triage Loop, Mandatory Report & Exit Gate

### 5.1 Triage Loop (Iterate Until Matched)
For every failed or unexpected result:
1. Inspect the raw `--json-report` counters (`summary`, `win32_etw`, `advisor`).
2. Classify the failure:
   - **False Positive:** Add or tighten threshold/gating logic in `src/diagnostics/mod.rs` (e.g., minimum MPKI floor, HWPF vs. Demand ratio guard, active C0% gate).
   - **False Negative:** Confirm whether the synthetic workload failed to trigger the hardware counter (fix `synth_bench`) or the Advisor threshold/math missed a real bottleneck (fix `src/diagnostics/mod.rs`).
   - **Host Blocker:** Record exact error/exit code and mark `BLOCKED` (never mark `PASS`).
3. Re-run `cargo test`, `cargo clippy --all-targets`, and the affected hardware tests after every fix.

### 5.2 Mandatory Output (`TEST_REPORT.md` + Final Agent Summary)
At the end of the testing phase, write `TEST_REPORT.md` in the repository root and summarize it in the final response with:

1. **Scorecard:** `Passed / Failed / Blocked` counts for Phase 1 (Synthetics) and Phase 2 (Real CLI Software), plus exact **False-Positive Rate** (`unexpected findings / total negative checks`).
2. **Synthetic Results Table:** Subcommand, Preset(s), Observed Headline Metrics (`IPC`, `Ret %`, key MPKI/Win32 value), Expected Advice vs. Actual Advice, and `PASS` / `FAIL` / `BLOCKED`.
3. **Real CLI Software Critique:** For every real CLI workload, explain what advice `zen2top` emitted, whether 0-Mux confirmed the 4-Mux smoke test, and why each finding makes engineering sense (or why it is questionable).
4. **Strict Verdict Gate (Required Final Section):**
   - Output **`STATUS: NO FURTHER TESTING NEEDED`** **ONLY IF**:
     - 100% of Phase 1 synthetic test cases match their expected `must_fire`, `must_not_fire`, and `invariants` contracts,
     - `0` tests are `FAILED` or `BLOCKED`,
     - False-Positive Rate is `<= 5%` (`0` false positives on `healthy-compute`, `short-gate`, and `smt-saturated`), and
     - Every piece of advice emitted across all Phase 2 real CLI workloads is verified accurate against raw telemetry.
   - In **all other cases**, output **`STATUS: MORE TESTING NEEDED`**, clearly explain every mismatch, false positive, false negative, or untested area discovered, and list the exact next tests or code changes required.
Artifact 3: SKILL.md (AI Profiling Workflow Skill for zen2top --headless)Markdown---
name: zen2top-profiler
description: Profile Windows 11 applications on AMD Zen 2 using `zen2top --headless` JSON telemetry. Uses a disciplined two-stage funnel—high-MUX smoke test to cast a wide net, followed by targeted 0-Mux hardware confirmation, call-stack attribution, and A/B baseline verification—to eliminate multiplexing artifacts and produce evidence-backed optimization recommendations.
---

# `zen2top` Autonomous Headless Profiling Workflow

Use this skill whenever asked to profile, diagnose, benchmark, or verify an optimization on a Windows 11 application, CLI tool, server, or local binary running on AMD Zen 2 using `zen2top`.

## Core Rules
- **Always use `--headless` + `--json-report <path>`** (never launch the interactive TUI inside an agent shell).
- **Never trust a 3-Mux or 4-Mux finding alone.** High-MUX modes multiplex 18–24 Core PMCs across 6 hardware registers; treat them strictly as a **smoke test**, then confirm every lead in **0-Mux (6/6 exact hardware counts)** before acting or reporting root cause.
- **Always evaluate `IPC` AND `Inst/s` together.** A higher IPC paired with lower `Inst/s` often means fewer active threads, not faster execution.
- **Never compare baselines across different mux groups** (`MUX DIFF` invalidates small `%` deltas).
- **Respect PMC eviction safety:** If `zen2top --headless` exits with code `3` (PMC occupied), inspect `meta.pmc_contention` in the JSON report, inform the user which ETW session or process holds the PMCs, and ask them to clear it interactively (`zen2top --unlock-pmc`)—or fall back to `--no-pmu` if only Win32/ETW telemetry is needed.

---

## Step-by-Step Profiling Funnel

### Stage 0: Pre-Flight & Calibration Check
1. Discover available presets and packs if needed:
   ```powershell
   zen2top --print-presets
Verify host latencies are calibrated (config.toml has calibrated = true). If not yet calibrated on this machine/RAM configuration, run once while the system is quiet:PowerShellzen2top --calibrate
Stage 1: High-MUX Broad Smoke Test (4-Mux kitchen-sink)Cast a wide net across all 12 Core PMC packs (cache, DRAM, TLB, branch, cross-CCX, locks, Op-Cache, STLF, line splits, exact retiring) plus all zero-PMC Win32/ETW diagnostics.Capture at least 15 seconds of steady-state work (--warmup past startup/JIT/loading phases) so meta.evidence_gate_passed == true ($\ge 10$ samples):PowerShellzen2top --headless --preset kitchen-sink --interval 1 --warmup 3 --duration 15 \
  --target <name_or_pid> --json-report reports/01_smoke_4mux.json
(Or use --launch <exe> -- <args...> to spawn and profile a CLI workload directly.)Read reports/01_smoke_4mux.json and check:meta.evidence_gate_passed — if false, increase --duration or verify the target was actively under load (avg_c0_pct >= 10%).summary: ipc, retiring_pct, inst_per_sec, l3_hit_pct, l3_lat_ns, and cpi_stack top stall tiers.advisor.verdict_label, advisor.proof, and top advisor.findings[] (noting each finding's scope: [Code / Build], [OS / TUI], or [HW / BIOS]).win32_etw: check for zero-PMC blockers first (gpu_3d_pct >= 97%, ecoqos_active, hard_page_faults_per_sec, ctx_sw_per_sec, noisy_neighbors, max_hot_core_dpc_irq_pct).Stage 2: Targeted 0-Mux Confirmation (Eliminate Multiplexing Artifacts)Pick the exact 0-Mux (6 Core PMC slots, mux_groups == 1) preset or custom --packs combination that isolates the top candidate(s) from Stage 1:Stage 1 SuspectRecommended 0-Mux CommandDRAM / L3 / Pointer-Chasing / Bandwidth / Cross-CCX / Locks--preset mem-ccx-lab (or --packs DcDemand,DcHwpf,CrossCcxLocks)iTLB / dTLB / 4 KiB Large-Page Overhead--preset tlb-only (ItlbFull,DtlbFull,ExactRetiring)Branch Mispredicts / Op-Cache / STLF / 64B Line Splits--preset micro-arch (OpCacheDecode,StlfSplits,Branches)L1/L2 D-Cache + Branch + DRAM Mix--packs L1L2Dc,DcDemand,Branches (6/6 = 0-Mux)I-Cache Capacity + iTLB + Exact Retiring--packs L1L2Ic,ItlbFull,ExactRetiring (6/6 = 0-Mux)Data-Dependency / ILP-Bound Confirmation--packs DcDemand,Branches,L1L2Dc + check ExactRetiringRe-run the exact same workload at 0-Mux and save a baseline snapshot for later A/B comparison:PowerShellzen2top --headless --preset <chosen_0mux_preset> --interval 1 --warmup 3 --duration 15 \
  --target <name_or_pid> --save-baseline baselines/before_0mux.json \
  --json-report reports/02_confirm_0mux.json
Confirmation Decision:Confirmed Bottleneck: The metric magnitude, CPI stack dominance, and Advisor finding persist with meta.mux_groups == 1 -> proceed to Stage 3/4.High-MUX Artifact: The finding disappears or drops sharply below threshold at 0-Mux -> explicitly document that the Stage 1 signal was a 4-Mux sampling/phase-aliasing artifact, re-check the next Stage 1 lead, and do not optimize a non-existent bottleneck.Stage 3: Function & Call-Stack Attribution (When Code Changes Are Needed)If the confirmed bottleneck has scope [Code / Build] (or high CPU/wait time needing source attribution), run a capture with --include-profiler (ETW On-CPU SampledProfile + Off-CPU CSwitch + 4-tier PDB/Export/Sidecar/.pdata symbol resolution):PowerShellzen2top --headless --preset <chosen_0mux_preset> --include-profiler --duration 15 \
  --target <name_or_pid> --json-report reports/03_profiler.json
Inspect profiler in the JSON output to pinpoint the exact top hot functions and call stacks before modifying code.Stage 4: A/B Verification (Same 0-Mux Preset Only)After applying one code, build, affinity, or large-page change:Re-run the exact same workload using the exact same 0-Mux preset/packs and --baseline baselines/before_0mux.json:PowerShellzen2top --headless --preset <chosen_0mux_preset> --interval 1 --warmup 3 --duration 15 \
  --target <name_or_pid> --baseline baselines/before_0mux.json \
  --json-report reports/04_after_0mux.json
Verify in reports/04_after_0mux.json:baseline_diff.mux_diff_warning == false.Target stall MPKI / CPI dropped as expected.Both efficiency (ipc, retiring_pct) and real throughput (inst_per_sec or application wall-clock speed) improved (or did not regress due to shifting the bottleneck elsewhere).Required Reporting Format for AI AgentsWhen presenting profiling results to the user, always include:Stage 1 (4-Mux Smoke) -> Stage 2 (0-Mux Confirmed) Summary: Explicitly state which leads held up at 0-Mux and whether any 4-Mux signals turned out to be multiplexing noise.Exact Observed Numbers: Cite IPC, Retiring %, Inst/s, Eff GHz, L3 Lat (ns), and the specific MPKI / Win32 telemetry from the 0-Mux JSON report.Scoped Recommendations: Separate [Code / Build], [OS / TUI], and [HW / BIOS] actions cleanly—never recommend OS registry tweaks for code-bound bottlenecks.A/B Proof (if an optimization was applied): Cite exact 0-Mux before/after deltas for both IPC and throughput.
---

If you want, we can also refine the exact default numeric thresholds inside `AGENTS.md` / `TESTING.md` (fo
