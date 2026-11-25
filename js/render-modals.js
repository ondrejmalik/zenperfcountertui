// Baseline modal, Help/Reference modal, and master renderAll coordinator
(() => {
  'use strict';
  const Z = window.Zen2Top || (window.Zen2Top = {});
  const { CONFIG, state, getActiveMux, getAttachedProcess, renderChrome, renderCcxStrip, renderTab1Overview, renderTab2Cache, renderTab3Tlb, renderTab4Memory, renderTab5Advisor, renderTab6Threads, renderTab7Profiler, renderAffinityModal, renderBurstModal, renderPickerTable } = Z;

  function renderBaselineModal() {
    const info = document.getElementById('baseline-current-info');
    const mux = getActiveMux();
    if (state.activeBaseline) {
      const b = state.activeBaseline;
      const muxWarn = (b.muxPreset || 'full') !== mux.id
        ? ` <span class="c-red c-bright">[MUX DIFF: ${b.muxPreset} vs ${mux.id}]</span>`
        : ` <span class="c-green">[Mux Match]</span>`;
      const summaryStats = b.muxPreset === 'uarch' && b.dcCrossCcxMpki !== null
        ? `IPC ${b.ipc.toFixed(2)} │ Cross-CCX ${b.dcCrossCcxMpki.toFixed(2)} │ Op-Cache ${(b.opcacheHitPct ?? 0).toFixed(1)}%`
        : `IPC ${b.ipc.toFixed(2)} │ DRAM ${(b.dramMpki ?? 0).toFixed(2)} │ iTLB ${(b.l2itlbMpki ?? 0).toFixed(2)}`;
      info.innerHTML = `Active Baseline: <span class="c-bright">${b.name}</span>${muxWarn} (${summaryStats} │ ${b.samples || 30} samples / ${b.elapsedSec || 30}s)`;
    } else {
      info.innerHTML = `Active Baseline: <span class="c-dim">none</span> (pin cumulative session or load a fixture to show vs BASE deltas)`;
    }
    document.getElementById('modal-save-hint').textContent = `${state.cum.samples} samples / ${state.cum.elapsedSec}s`;
    document.getElementById('modal-timed-val').innerHTML = state.timedCapture
      ? `<span class="c-cyan c-bright">${state.timedCapture.remainingSec}s remaining...</span>`
      : `15s countdown`;
    document.getElementById('modal-base-val').textContent = state.activeBaseline ? state.activeBaseline.name : 'none';
    document.getElementById('modal-interval-val').textContent = `${state.intervalSec}s`;
    document.getElementById('modal-pause-val').textContent = state.paused ? 'PAUSED' : 'LIVE';
    document.getElementById('modal-lock-val').textContent = state.pmcLocked ? `LOCKED (${state.blockerName})` : 'Unlocked';
    document.getElementById('modal-ret-val').innerHTML = CONFIG.retiring.exactRetiring
      ? `<span class="c-cyan">Exact (0x4300C1, 4-Mux)</span>`
      : `Est (~, 3-Mux)`;
    document.getElementById('modal-admin-val').innerHTML = state.isAdmin
      ? `<span class="c-green">Elevated (Admin)</span>`
      : `<span class="c-yellow">Unelevated (Read-Only IFEO)</span>`;
    const gpuValEl = document.getElementById('modal-gpu-val');
    if (gpuValEl) {
      gpuValEl.innerHTML = state.simGpuAvailable
        ? `<span class="c-green">D3DKMT Active</span>`
        : `<span class="c-yellow">Unsupported (None)</span>`;
    }
    const ecoValEl = document.getElementById('modal-ecoqos-val');
    if (ecoValEl) {
      ecoValEl.innerHTML = state.simEcoQosSupported
        ? `<span class="c-green">Win11 22H2+</span>`
        : `<span class="c-yellow">Pre-22H2 (Unknown)</span>`;
    }
    const privValEl = document.getElementById('modal-priv-val');
    if (privValEl) {
      const p = getAttachedProcess();
      const priv = (p && p.win32Profile && p.win32Profile.seLockMemoryPrivilege) || 'Present';
      privValEl.innerHTML = priv === 'Present'
        ? `<span class="c-green">Present</span>`
        : `<span class="c-red">Missing</span>`;
    }
    const protValEl = document.getElementById('modal-prot-val');
    if (protValEl) {
      const p = getAttachedProcess();
      const isProt = Boolean(state.simProtectedProcess || (p && p.protectedProcess));
      protValEl.innerHTML = isProt
        ? `<span class="c-red">Protected (Access Denied)</span>`
        : `<span class="c-green">Editable</span>`;
    }
    document.getElementById('modal-cal-val').innerHTML = CONFIG.calibrated
      ? `<span class="c-green">Calibrated (${CONFIG.latencies.dramFallback.toFixed(0)} cyc DRAM)</span>`
      : `~1s pointer-chase + branch`;
  }

  function renderHelpModal() {
    document.querySelectorAll('#help-tabs .tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.htab === state.helpTab);
    });
    const body = document.getElementById('help-body');

    if (state.helpTab === 'keys') {
      body.innerHTML = `
        <div class="section-label"><span>Global Keybinds</span></div>
        <table class="kv-table" style="margin-bottom: 10px; font-size: 12px;">
          <tr><td class="k c-bright">1 / 2 / 3 / 4 / 5 / 6 / 7</td><td class="v">Switch tabs (Overview, Cache, TLB, Memory, Advisor, Threads, Profiler)</td></tr>
          <tr><td class="k c-bright">p / d</td><td class="v">Open native Win32 Process Picker ('/' filter, 's' sort, 'Enter' attach) / Detach to System-Wide</td></tr>
          <tr><td class="k c-bright">m</td><td class="v">Cycle PMU Mux preset: Full (3-Mux) -&gt; TLB-Only (0-Mux) -&gt; IPC+Cache/DRAM (0-Mux) -&gt; Micro-Arch (0-Mux) -&gt; No-PMU (Win32)</td></tr>
          <tr><td class="k c-bright">c</td><td class="v">Toggle global CCX0 vs CCX1 + physical-core SMT sibling IPC/C0% strip (above all tabs)</td></tr>
          <tr><td class="k c-bright">b</td><td class="v">Baseline &amp; sampler modal (Save 'S', Timed 'T', Exact Ret 'e', Calibrate 'C', Admin 'a', Zero-PMC 'g/o/l/x/v', Reset 'r')</td></tr>
          <tr><td class="k c-bright">j / k / Arrows</td><td class="v">Navigate PE modules (Tab 3), Advisor findings (Tab 5), Threads (Tab 6), Profiler (Tab 7), or Picker</td></tr>
          <tr><td class="k c-bright">o / f / v / t / e / r / M</td><td class="v">Tab 7 Profiler: On/Off-CPU ('o'), HW Burst ('f', also Tab 5), Flat/Tree ('v'), Thread Scope ('t'), Pause ETW ('e'), Clear ('r'), Sidecar Map ('M')</td></tr>
          <tr><td class="k c-bright">a / R / v</td><td class="v">Edit thread affinity (Tab 6 'a') │ Revert all session affinity edits (Tab 6 'R') │ Toggle VA/JIT Map (Tab 4 'v')</td></tr>
          <tr><td class="k c-bright">Space / Enter / U</td><td class="v">Pause (global) │ Toggle DLL IFEO (Tab 3) │ Toggle Master UseLargePages ('U', Tab 3) │ Jump (Tab 5)</td></tr>
          <tr><td class="k c-bright">? / q</td><td class="v">Open this reference modal / Exit cleanly</td></tr>
        </table>
        <div class="section-label"><span>Two-Line Exclusive CPI Stack, Micro-Arch (0-Mux) &amp; Amdahl Est. Gain</span></div>
        <pre class="code-block">IPC                  = inst / cycles   (throughput shown as Inst/s &amp; Cyc/s)
IPC (Micro-Arch)     = irperf / aperf  (0 Core PMC slots used; Actual CPI = aperf / irperf)
Actual CPI           = cycles / inst
Effective GHz        = (aperf / mperf) * (base_mhz / 1000.0)
Retiring % (Default) = clamp(((IPC * uops_per_inst) / 6.0) * 100, 0..100)  [Ret ~XX%, 0 extra PMCs]
Retiring % (Exact)   = clamp((ExRetUops / (6.0 * cycles)) * 100, 0..100)   [Ret XX%, 0x4300C1]
  Zen 2 dispatches up to 6 macro-ops/cycle. Real-world C++/game code typically caps at ~45-60%
  (~2.5-3.5 IPC) due to data dependencies and 2-load/1-store port limits. Enabling exact_retiring
  adds a 19th Core PMC (moving Full from 3-Mux to 4-Mux). Toggle live via 'b' -&gt; 'e'.

Micro-Arch / Contention (0-Mux, --preset uarch):
  Uses all 6 programmable Core PMCs continuously (0% mux error) + 3 Fixed MSRs (aperf/mperf/irperf)
  + 4 CCX L3 PMCs (separate L3 domain). Switch here when diagnosing cross-CCX false sharing /
  coherence bouncing, serialized LOCK/spinlock stalls invisible to OS context switches, Op-Cache
  vs 4-wide legacy x86 decode thrashing (PGO/BOLT proof), STLF load replays, or 64B line splits.
  dc_cross_ccx_mpki    = (dc_cross_ccx / inst) * 1000.0        [HI &gt;= 2.0, MD &gt;= 0.8]
  locks_serial_mpki    = (locks_serial / inst) * 1000.0        [HI &gt;= 0.5 &amp; CCX &gt;= 0.5; MD &gt;= 1.0]
  opcache_hit_pct      = (oc_uops / max(1, oc_uops + dec_uops)) * 100.0  [MD legacy &gt;= 30%]
  stlf_interlock_mpki  = (stlf_interlock / inst) * 1000.0      [MD &gt;= 3.0]
  misal_access_mpki    = (misal_access / inst) * 1000.0        [MD &gt;= 20.0, LO &gt;= 10.0]

Active Duty (C0%)    = clamp((mperf_delta / (base_mhz * 1e6 * duration_sec)) * 100, 0..100)
SMT Contention (⇄)   = highlighted yellow when both physical-core siblings &gt;= 15% active
L3 Miss Latency      = (l3_lat * 16.0) / l3_mtype          [cycles]  |  lat_cyc / eff_ghz [ns]

Exclusive CPI Tiers  = (Exclusive_MPKI / 1000.0) * Latency_Cycles   [NEVER normalized to 100%]
  Line 1 (Actual)    = solid bar scaled to Actual CPI + hatched OoO/MLP overlap gap
  Line 2 (Modeled)   = Flush (Branch, L2I, iTLB) left + MLP (L2D, L3, DRAM, dTLB) right on same scale

Advisor Est. Gain (Amdahl's Law with OoO/MLP Overlap Bounds):
  vis_ratio   = clamp(actual_cpi / max(0.001, modeled_cpi), 0.25, 1.0)
  delta_raw   = tier_cpi * reduction_frac  (-85% iTLB, -80% dTLB, -15% DRAM lat, -50% Dem DRAM, -35% Br/L2I, -70% Cross-CCX)
  delta_low   = Flush: delta_raw * min(0.90, vis_ratio) | MLP: delta_raw * min(0.75, vis_ratio * 0.80)
  new_cpi     = max(0.25, actual_cpi - delta)    [clamped at Zen 2 practical 4.0 IPC floor]
  Non-CPI rules (SMT, Cross-CCX spread, Locks, Op-Cache, Splits, Page Faults, Hygiene) report Qualitative labels, never fake %.

Active Zen 2 Latencies (${CONFIG.calibrated ? 'Calibrated via --calibrate' : 'Default config.toml'}):
  L1 = ${CONFIG.latencies.l1Hit.toFixed(1)} cyc | L2 = ${CONFIG.latencies.l2Hit.toFixed(1)} cyc | L3 = ${CONFIG.latencies.l3Hit.toFixed(1)} cyc | Branch = ${CONFIG.latencies.branchMispredict.toFixed(1)} cyc
  L2 iTLB/dTLB Walk = ${CONFIG.latencies.l2ItlbWalk.toFixed(0)} cyc | DRAM = live measured l3_lat (unloaded fallback ${CONFIG.latencies.dramFallback.toFixed(1)} cyc)</pre>
      `;
    } else if (state.helpTab === 'pmu') {
      body.innerHTML = `
        <div class="section-label"><span>AMD Zen 2 Verified PMU Event Codes (AMDuProfPcm.exe)</span></div>
        <table class="tui-table" style="font-size: 12px; margin-bottom: 10px;">
          <thead>
            <tr>
              <th class="left">Metric Key</th>
              <th class="left">Domain</th>
              <th class="left">Raw Hex / MSR</th>
              <th class="left">Description</th>
            </tr>
          </thead>
          <tbody>
            <tr><td class="left c-bright">cycles</td><td class="left">Core PMC</td><td class="left c-cyan">0x430076</td><td class="left c-dim">Unhalted core clock cycles (LsNotHaltedCyc)</td></tr>
            <tr><td class="left c-bright">ret_uops (opt)</td><td class="left">Core PMC</td><td class="left c-cyan">0x4300C1</td><td class="left c-dim">ExRetUops (exact Retiring %; adds 19th PMC -&gt; Full 4-Mux)</td></tr>
            <tr><td class="left c-bright">branches / branch_miss</td><td class="left">Core PMC</td><td class="left c-cyan">0x4300C2 / 0x4300C3</td><td class="left c-dim">Retired branches &amp; branch mispredictions</td></tr>
            <tr><td class="left c-bright">l1_itlb_hit / l1m_l2h / l2m</td><td class="left">Core PMC</td><td class="left c-cyan">0x430794 / 0x430084 / 0x430785</td><td class="left c-dim">L1 iTLB hit, L1 miss-&gt;L2 hit, L2 iTLB page walk</td></tr>
            <tr><td class="left c-bright">l1_dtlb_l2h / l2_dtlb_m</td><td class="left">Core PMC</td><td class="left c-cyan">0x430F45 / 0x43F045</td><td class="left c-dim">L1 dTLB miss-&gt;L2 hit, L2 dTLB page walk</td></tr>
            <tr><td class="left c-bright">l1_ic_miss / l2_ic_miss</td><td class="left">Core PMC</td><td class="left c-cyan">0x431060 / 0x430164</td><td class="left c-dim">L1 I-Cache miss &amp; true L2-&gt;L3 I-Cache miss</td></tr>
            <tr><td class="left c-bright">l1_dc_miss / l2_dc_miss</td><td class="left">Core PMC</td><td class="left c-cyan">0x43C860 / 0x430864</td><td class="left c-dim">L1 D-Cache miss &amp; L2-&gt;L3 D-Cache miss</td></tr>
            <tr><td class="left c-bright">dc_dem_l3 / dc_dem_dram</td><td class="left">Core PMC</td><td class="left c-cyan">0x430243 / 0x430843</td><td class="left c-dim">D-Cache demand fill from L3 vs DRAM</td></tr>
            <tr><td class="left c-bright">dc_hwpf_l3 / dc_hwpf_dram</td><td class="left">Core PMC</td><td class="left c-cyan">0x43025A / 0x43085A</td><td class="left c-dim">L1 D-Cache HW prefetcher fill from L3 vs DRAM</td></tr>
            <tr><td class="left c-bright">l2_pf_l3 / l2_pf_dram</td><td class="left">Core PMC</td><td class="left c-cyan">0x431F71 / 0x431F72</td><td class="left c-dim">L2 HW prefetcher fill from L3 vs DRAM</td></tr>
            <tr><td class="left c-bright">dc_cross_ccx</td><td class="left">Core PMC (uarch)</td><td class="left c-cyan">0x430443</td><td class="left c-dim">ls_dmnd_fills_from_sys.ext_cache_local (umask 0x04: fills from other CCX cache over IF)</td></tr>
            <tr><td class="left c-bright">locks_serial</td><td class="left">Core PMC (uarch)</td><td class="left c-cyan">0x430325</td><td class="left c-dim">ls_locks.bus_lock | non_spec_lock (umask 0x03: serialized LOCK ops, excludes cheap spec locks)</td></tr>
            <tr><td class="left c-bright">dec_uops</td><td class="left">Core PMC (uarch)</td><td class="left c-cyan">0x4301AA</td><td class="left c-dim">de_dis_uops_from_decoder.decoder_dispatched (umask 0x01: 4-wide legacy x86 decoder ops)</td></tr>
            <tr><td class="left c-bright">oc_uops</td><td class="left">Core PMC (uarch)</td><td class="left c-cyan">0x4302AA</td><td class="left c-dim">de_dis_uops_from_decoder.opcache_dispatched (umask 0x02: 8-wide 4K-entry Op-Cache ops)</td></tr>
            <tr><td class="left c-bright">stlf_interlock</td><td class="left">Core PMC (uarch)</td><td class="left c-cyan">0x430224</td><td class="left c-dim">ls_bad_status2.stli_other (umask 0x02: store-to-load forwarding interlock stalls)</td></tr>
            <tr><td class="left c-bright">misal_access</td><td class="left">Core PMC (uarch)</td><td class="left c-cyan">0x430047</td><td class="left c-dim">ls_misal_accesses (umask 0x00: 64-byte cache-line split / misaligned loads &amp; stores)</td></tr>
            <tr><td class="left c-bright">aperf / mperf / inst</td><td class="left">Fixed MSR</td><td class="left c-green">aperf / mperf / irperf</td><td class="left c-dim">Effective GHz, C0 duty %, retired inst; powers live IPC (irperf/aperf) in Micro-Arch 0-Mux</td></tr>
            <tr><td class="left c-bright">l3_access / l3_miss</td><td class="left">CCX L3 PMC</td><td class="left c-yellow">0xFF0F00000040FF04 / 0104</td><td class="left c-dim">Unified CCX L3 requests &amp; misses (stays active in Micro-Arch 0-Mux; zero Core PMC cost)</td></tr>
            <tr><td class="left c-bright">l3_lat / l3_mtype</td><td class="left">CCX L3 PMC</td><td class="left c-yellow">0xFF0F000000400090 / 1F9A</td><td class="left c-dim">XiSampledLatency (x16 cyc) &amp; latency sample count (stays active in Micro-Arch 0-Mux)</td></tr>
          </tbody>
        </table>
        <div class="c-dim" style="font-size: 12px;">
          Micro-Arch (0-Mux) fits strictly in 6 Core PMCs + 3 Fixed MSRs + 4 CCX L3 PMCs (100% continuous counting, zero mux error; Full remains cleanly at 18 Core PMCs / 3-Mux). Windows ETW Blocker Recovery: queries <code>logman query -ets</code> for <code>SHS-*</code> sessions and stops via <code>logman stop &lt;SHS-*&gt; -ets</code> when <code>--unlock-pmc</code> is set or 'u' is pressed. AMD Top-Down (<code>pipeline</code>) is intentionally excluded (unsupported on Zen 2).
        </div>
      `;
    } else {
      body.innerHTML = `
        <div class="section-label"><span>Rust Crate Layout &amp; Threading Architecture</span></div>
        <pre class="code-block">zen2top/src/
  main.rs                 # clap CLI (incl. --no-pmu), RAII terminal guard, ~20 FPS ratatui loop
  config/mod.rs           # Auto-generated config.toml (latencies, retiring, advisor, module threshold)
  pmu/{mod,uprof,uprof_burst,csv}.rs
                          # PmuBackend, PmuCoordinator (Pause->Burst->Report->Resume), AMDuProfCLI IBS/stall parser
  symbols/mod.rs          # 4-Tier x64 SymbolResolver (PDB &gt; PE Export &gt; Sidecar .zen2sym.json &gt; PE .pdata)
  etw/{present,profiler}.rs
                          # Non-blocking DXGI Present ETW + Live Zero-PMC ETW SampledProfile/CSwitch/ReadyThread/StackWalk
  win32/{handle,process,topology,ifeo,gpu,sys_perf,memory,privileges,threads,va_map,io}.rs
                          # RAII HANDLEs, Toolhelp32, RelationProcessorCore, HKLM IFEO,
                          # Zero-PMC Win32: D3DKMT GPU 3D, NtQuerySystemInformation DPC/IRQ &amp; Per-Thread Inspector,
                          # SetThreadAffinityMask editor, VirtualQueryEx+QueryWorkingSetEx VA/JIT map, GetProcessIoCounters
  allocator/{mod,tier0_mimalloc,generic_mimalloc}.rs  # PE byte-pattern RVA resolver + bitmap reader
  metrics/{cpi_stack,history}.rs   # Two-line Exclusive CPI Stack, Retiring %, rolling buffers
  diagnostics/mod.rs      # Deterministic DiagnosticEngine (26 rules + Tab 7 ETW/Burst function attribution)
  calibrate/mod.rs        # --calibrate ~1s pointer-chase + 50/50 branch probe
  baseline/mod.rs         # Raw cumulative totals JSON persistence + #[serde(default)] uarch fields
  ui/{chrome,overview,cache,tlb,memory,advisor,threads,profiler,modals}.rs</pre>
        <div class="section-label"><span>config.toml &amp; Baseline JSON Schema (Raw Cumulative Totals)</span></div>
        <pre class="code-block">[latencies]
l1_hit = ${CONFIG.latencies.l1Hit.toFixed(1)}
l2_hit = ${CONFIG.latencies.l2Hit.toFixed(1)}
l3_hit = ${CONFIG.latencies.l3Hit.toFixed(1)}
branch_mispredict = ${CONFIG.latencies.branchMispredict.toFixed(1)}
l2_itlb_walk = ${CONFIG.latencies.l2ItlbWalk.toFixed(1)}
l2_dtlb_walk = ${CONFIG.latencies.l2DtlbWalk.toFixed(1)}
dram_fallback = ${CONFIG.latencies.dramFallback.toFixed(1)}
calibrated = ${CONFIG.calibrated}

[retiring]
uops_per_inst = ${CONFIG.retiring.uopsPerInst.toFixed(2)}
exact_retiring = ${CONFIG.retiring.exactRetiring}

[advisor]
min_samples = ${CONFIG.advisor.minSamples}
min_avg_c0_pct = ${CONFIG.advisor.minAvgC0Pct.toFixed(1)}
min_inst_per_sec = 1500000000

# baselines/&lt;timestamp&gt;_&lt;slug&gt;.json:
# { "name", "timestamp_utc", "target", "affinity_mask", "mux_preset", "ifeo_enabled",
#   "elapsed_sec", "sample_count", "note",
#   "cumulative_totals": { "inst", "cycles", "aperf", "mperf",
#     "dc_cross_ccx", "locks_serial", "dec_uops", "oc_uops", "stlf_interlock", "misal_access" } }
#   (all 6 micro-arch fields use #[serde(default)] for backwards compatibility with older JSONs)</pre>
      `;
    }
  }

  function renderAll() {
    renderChrome();
    renderCcxStrip();

    document.querySelectorAll('.tab-view').forEach(v => v.classList.remove('active'));
    document.getElementById(`tab-${state.activeTab}`).classList.add('active');

    if (state.activeTab === 1) renderTab1Overview();
    else if (state.activeTab === 2) renderTab2Cache();
    else if (state.activeTab === 3) renderTab3Tlb();
    else if (state.activeTab === 4) renderTab4Memory();
    else if (state.activeTab === 5) renderTab5Advisor();
    else if (state.activeTab === 6) renderTab6Threads();
    else if (state.activeTab === 7) renderTab7Profiler();

    if (state.openModal === 'picker') renderPickerTable('modal-picker-tbody', 'modal-sort-label');
    if (state.openModal === 'baseline') renderBaselineModal();
    if (state.openModal === 'help') renderHelpModal();
    if (state.openModal === 'affinity') renderAffinityModal();
    if (state.openModal === 'burst') renderBurstModal();
  }

  Object.assign(Z, { renderBaselineModal, renderHelpModal, renderAll });
})();
