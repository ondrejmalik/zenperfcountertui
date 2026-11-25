// Baseline modal, Help/Reference modal, and master renderAll coordinator
(() => {
  'use strict';
  const Z = window.Zen2Top || (window.Zen2Top = {});
  const {
    CONFIG, MetricPack, METRIC_PACKS, state, getActivePlan, formatMuxShort, getAttachedProcess,
    renderChrome, renderCcxStrip, renderTab1Overview, renderTab2Cache, renderTab3Tlb,
    renderTab4Memory, renderTab5Advisor, renderTab6Threads, renderTab7Profiler,
    renderPackPickerModal, renderAffinityModal, renderBurstModal, renderPickerTable
  } = Z;

  function renderBaselineModal() {
    const info = document.getElementById('baseline-current-info');
    const plan = getActivePlan();
    if (state.activeBaseline) {
      const b = state.activeBaseline;
      const baseGroups = b.muxGroups ?? b.mux_groups ?? 3;
      const liveGroups = plan.muxGroups;
      const liveMuxStr = formatMuxShort(liveGroups);
      const baseMuxStr = formatMuxShort(baseGroups);
      const muxWarn = (!plan.noPmu && liveGroups !== baseGroups)
        ? ` <span class="c-red c-bright">[MUX DIFF (${liveMuxStr} vs ${baseMuxStr})]</span>`
        : ` <span class="c-green">[${baseMuxStr} Match]</span>`;
      const statParts = [`IPC ${(b.ipc ?? 0).toFixed(2)}`];
      if (b.dramMpki !== null && b.dramMpki !== undefined) statParts.push(`DRAM ${b.dramMpki.toFixed(2)}`);
      if (b.l2itlbMpki !== null && b.l2itlbMpki !== undefined) statParts.push(`iTLB ${b.l2itlbMpki.toFixed(2)}`);
      if (b.dcCrossCcxMpki !== null && b.dcCrossCcxMpki !== undefined) statParts.push(`CCX ${b.dcCrossCcxMpki.toFixed(2)}`);
      if (b.opcacheHitPct !== null && b.opcacheHitPct !== undefined) statParts.push(`Op-Cache ${b.opcacheHitPct.toFixed(1)}%`);
      const slotsStr = `${b.corePmcSlots ?? b.core_pmc_slots ?? '?'} PMCs`;
      info.innerHTML = `Active Baseline: <span class="c-bright">${b.name}</span>${muxWarn} (${statParts.slice(0, 3).join(' │ ')} │ ${slotsStr} │ ${b.samples || 30} samples / ${b.elapsedSec || 30}s)`;
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
    const retValEl = document.getElementById('modal-ret-val');
    if (retValEl) {
      if (plan.noPmu) {
        retValEl.innerHTML = `<span class="c-dim">No-PMU</span>`;
      } else if (plan.autoPaddedRetiring) {
        retValEl.innerHTML = `<span class="c-cyan">Auto-Pad (0x4300C1, +0 mux)</span>`;
      } else if (plan.has(MetricPack.ExactRetiring)) {
        retValEl.innerHTML = `<span class="c-green">Exact Pack ON (${plan.muxShort})</span>`;
      } else {
        retValEl.innerHTML = `Est (~, 0 PMCs)`;
      }
    }
    const noPmuEl = document.getElementById('modal-nopmu-val');
    if (noPmuEl) {
      noPmuEl.innerHTML = state.noPmu
        ? `<span class="c-yellow">No-PMU (Win32 Only)</span>`
        : `<span class="c-green">${plan.label}</span>`;
    }
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
          <tr><td class="k c-bright">m / M</td><td class="v">Open Modular Metric Pack Picker modal ('m': 1-6 Quick Presets, Space toggle, s save default, Enter apply) │ Fast-cycle presets ('M' on Tabs 1-6)</td></tr>
          <tr><td class="k c-bright">c</td><td class="v">Toggle global CCX0 vs CCX1 + physical-core SMT sibling IPC/C0% strip (above all tabs)</td></tr>
          <tr><td class="k c-bright">b</td><td class="v">Baseline &amp; sampler modal (Save 'S', Timed 'T', Exact Ret pack 'e', No-PMU 'n', Calibrate 'C', Admin 'a', Zero-PMC 'g/o/l/x/v', Reset 'r')</td></tr>
          <tr><td class="k c-bright">j / k / Arrows</td><td class="v">Navigate Metric Packs ('m'), PE modules (Tab 3), Advisor findings (Tab 5), Threads (Tab 6), Profiler (Tab 7), or Picker</td></tr>
          <tr><td class="k c-bright">o / f / v / t / e / r / M</td><td class="v">Tab 7 Profiler: On/Off-CPU ('o'), HW Burst ('f', also Tab 5), Flat/Tree ('v'), Thread Scope ('t'), Pause ETW ('e'), Clear ('r'), Sidecar Map ('M')</td></tr>
          <tr><td class="k c-bright">a / R / v</td><td class="v">Edit thread affinity (Tab 6 'a') │ Revert all session affinity edits (Tab 6 'R') │ Toggle VA/JIT Map (Tab 4 'v')</td></tr>
          <tr><td class="k c-bright">Space / Enter / U</td><td class="v">Pause (global) │ Toggle Pack ('m') or DLL IFEO (Tab 3) │ Toggle Master UseLargePages ('U', Tab 3) │ Jump (Tab 5)</td></tr>
          <tr><td class="k c-bright">? / q</td><td class="v">Open this reference modal / Exit cleanly</td></tr>
        </table>
        <div class="section-label"><span>Always-On Free Base, 6-Slot Bin-Packing &amp; Exclusive CPI Stack</span></div>
        <pre class="code-block">Always-On Free Base (0 Core PMC slots, 100% / 0-Mux universally across all pack configs):
  Fixed MSRs           = core/aperf, core/mperf, core/inst (irperf)
  CCX L3 PMCs          = l3_access, l3_miss, l3_lat, l3_mtype (separate L3 hardware domain)
  IPC                  = inst / aperf   |   Actual CPI = aperf / inst
  Effective GHz        = (aperf / mperf) * (base_mhz / 1000.0)
  Active Duty (C0%)    = clamp((mperf_delta / (base_mhz * 1e6 * duration_sec)) * 100, 0..100)
  L3 Miss Latency      = (l3_lat * 16.0) / l3_mtype  [cyc]  |  lat_cyc / eff_ghz [ns]

6-Slot Zen 2 Core PMC Bin-Packing (FFD + Zero-Cost Alignment Pad):
  12 atomic Core PMC packs total exactly 24 slots = 4 exact mux groups of 6 (0x430076 reclaimed).
  First-Fit Decreasing (3, then 2, then 1) guarantees zero coupled pairs ever straddle a 6-slot boundary.
  If bins.len() &gt; 1 and Bin 1 ends with 5 slots (ItlbFull 3 + one 2-slot pack without ExactRetiring),
  ExactRetiring (0x4300C1, 1 slot) auto-pads slot 6 at +0 mux cost, unlocking exact Ret XX% for free.
  Driver Guardrail: enabled_core_pmcs &gt;= 1 is enforced alongside fixed MSRs.

Quick Presets ('m' -> 1-6, or --preset &lt;slug&gt; / --packs &lt;comma_list&gt;):
  [1] Full (3-Mux, 18/18, 33%)       [2] Kitchen Sink / All (4-Mux, 24/24, 25%)
  [3] Balanced Daily (2-Mux, 12/12)  [4] TLB-Only (0-Mux, 6/6, 100%)
  [5] Mem + CCX Lab (0-Mux, 6/6)     [6] Micro-Arch (0-Mux, 6/6, 100%)

Retiring % (Default) = clamp(((IPC * uops_per_inst) / 6.0) * 100, 0..100)  [Ret ~XX%, 0 extra PMCs]
Retiring % (Exact)   = clamp((ExRetUops / (6.0 * aperf)) * 100, 0..100)    [Ret XX%, ExactRetiring pack]
Exclusive CPI Tiers  = (Exclusive_MPKI / 1000.0) * Latency_Cycles          [NEVER normalized to 100%]

Active Zen 2 Latencies (${CONFIG.calibrated ? 'Calibrated via --calibrate' : 'Default config.toml'}):
  L1 = ${CONFIG.latencies.l1Hit.toFixed(1)} cyc | L2 = ${CONFIG.latencies.l2Hit.toFixed(1)} cyc | L3 = ${CONFIG.latencies.l3Hit.toFixed(1)} cyc | Branch = ${CONFIG.latencies.branchMispredict.toFixed(1)} cyc
  L2 iTLB/dTLB Walk = ${CONFIG.latencies.l2ItlbWalk.toFixed(0)} cyc | DRAM = live measured l3_lat (unloaded fallback ${CONFIG.latencies.dramFallback.toFixed(1)} cyc)</pre>
      `;
    } else if (state.helpTab === 'pmu') {
      const packRows = METRIC_PACKS.map((p, idx) => `
        <tr>
          <td class="left c-bright">${idx + 1}. ${p.id}</td>
          <td class="left">${p.slots} slot${p.slots > 1 ? 's' : ''}</td>
          <td class="left c-cyan">${p.hexSummary}</td>
          <td class="left c-dim">${p.name} (${p.feeds})</td>
        </tr>
      `).join('');
      body.innerHTML = `
        <div class="section-label"><span>Always-On Free Base (0 Core PMC Slots, 100% / 0-Mux) + 12 Atomic Core PMC Packs (24 Slots)</span></div>
        <table class="tui-table" style="font-size: 12px; margin-bottom: 10px;">
          <thead>
            <tr>
              <th class="left">Pack / Metric</th>
              <th class="left">Budget</th>
              <th class="left">Raw Hex / MSR</th>
              <th class="left">Description &amp; Consumers</th>
            </tr>
          </thead>
          <tbody>
            <tr><td class="left c-green c-bright">Fixed MSRs (Base)</td><td class="left c-green">0 slots</td><td class="left c-green">aperf / mperf / irperf</td><td class="left c-dim">Universal IPC, Actual CPI, Eff GHz, per-core C0% (0x430076 reclaimed)</td></tr>
            <tr><td class="left c-yellow c-bright">CCX L3 PMCs (Base)</td><td class="left c-green">0 slots</td><td class="left c-yellow">0xFF0F..FF04 / 0104 / 0090 / 1F9A</td><td class="left c-dim">Unified L3 Hit %, L3 Miss MPKI, and Live L3 Miss Latency (cyc + ns)</td></tr>
            ${packRows}
          </tbody>
        </table>
        <div class="c-dim" style="font-size: 12px;">
          All 12 atomic Core PMC packs total exactly 24 Core PMC slots (4 exact mux groups of 6). Windows ETW Blocker Recovery queries <code>logman query -ets</code> for <code>SHS-*</code> sessions and stops via <code>logman stop &lt;SHS-*&gt; -ets</code>. AMD Top-Down (<code>pipeline</code>) is excluded (unsupported on Zen 2).
        </div>
      `;
    } else {
      const defPacksToml = CONFIG.defaultPacks.map(p => `"${p}"`).join(', ');
      body.innerHTML = `
        <div class="section-label"><span>Rust Crate Layout &amp; Modular Pack Architecture</span></div>
        <pre class="code-block">zen2top/src/
  main.rs                 # clap CLI (--preset &lt;slug&gt;, --packs &lt;list&gt;, --no-pmu), RAII terminal guard
  config/mod.rs           # Auto-generated config.toml (default_packs, latencies, retiring, advisor)
  pmu/{mod,packs,uprof,uprof_burst,csv}.rs
                          # MetricPack (12 atomic packs), 6-slot FFD bin-packer + auto-pad, PmuCoordinator
  symbols/mod.rs          # 4-Tier x64 SymbolResolver (PDB &gt; PE Export &gt; Sidecar .zen2sym.json &gt; PE .pdata)
  etw/{present,profiler}.rs
                          # Non-blocking DXGI Present ETW + Live Zero-PMC ETW SampledProfile/CSwitch/StackWalk
  win32/{handle,process,topology,ifeo,gpu,sys_perf,memory,privileges,threads,va_map,io}.rs
                          # RAII HANDLEs, Toolhelp32, RelationProcessorCore, HKLM IFEO, Zero-PMC Win32
  allocator/{mod,tier0_mimalloc,generic_mimalloc}.rs  # PE byte-pattern RVA resolver + bitmap reader
  metrics/{cpi_stack,history}.rs   # Pack-driven Exclusive CPI Stack, Retiring %, rolling buffers
  diagnostics/mod.rs      # Pack-gated DiagnosticEngine (26 rules + mux-aware Measurement Hygiene)
  calibrate/mod.rs        # --calibrate ~1s pointer-chase + 50/50 branch probe
  baseline/mod.rs         # Raw cumulative totals JSON + enabled_packs / core_pmc_slots / mux_groups
  ui/{chrome,overview,cache,tlb,memory,advisor,threads,profiler,pack_picker,modals}.rs</pre>
        <div class="section-label"><span>config.toml &amp; Mux-Aware Baseline JSON Schema</span></div>
        <pre class="code-block">[pmu]
default_packs = [${defPacksToml}]

[latencies]
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

[advisor]
min_samples = ${CONFIG.advisor.minSamples}
min_avg_c0_pct = ${CONFIG.advisor.minAvgC0Pct.toFixed(1)}
min_inst_per_sec = 1500000000

# baselines/&lt;timestamp&gt;_&lt;slug&gt;.json (all new fields use #[serde(default)] for backwards compatibility):
# { "name", "timestamp_utc", "target", "affinity_mask", "mux_preset",
#   "enabled_packs": ["DcDemand", "L1L2Dc", ...], "core_pmc_slots": 12, "mux_groups": 2,
#   "ifeo_enabled", "elapsed_sec", "sample_count", "note",
#   "cumulative_totals": { "inst", "aperf", "mperf", "ret_uops",
#     "dc_cross_ccx", "locks_serial", "dec_uops", "oc_uops", "stlf_interlock", "misal_access" } }</pre>
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
    if (state.openModal === 'packs' && typeof renderPackPickerModal === 'function') renderPackPickerModal();
    if (state.openModal === 'baseline') renderBaselineModal();
    if (state.openModal === 'help') renderHelpModal();
    if (state.openModal === 'affinity') renderAffinityModal();
    if (state.openModal === 'burst') renderBurstModal();
  }

  Object.assign(Z, { renderBaselineModal, renderHelpModal, renderAll });
})();
