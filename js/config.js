// Zen 2 topology, PMU presets, CSV parser, and baseline JSON schema
(() => {
  'use strict';
  const Z = window.Zen2Top || (window.Zen2Top = {});

  // =========================================================================
  // 1. CONFIG & ZEN 2 TOPOLOGY (config.toml + GetLogicalProcessorInformationEx)
  // =========================================================================
  const CONFIG = {
    cpuModel: 'Ryzen 5 3600X',
    baseMhz: 3800.0,
    logicalCpus: 12,
    physicalCores: [
      { id: 0, ccx: 0, siblings: [0, 1] },
      { id: 1, ccx: 0, siblings: [2, 3] },
      { id: 2, ccx: 0, siblings: [4, 5] },
      { id: 3, ccx: 1, siblings: [6, 7] },
      { id: 4, ccx: 1, siblings: [8, 9] },
      { id: 5, ccx: 1, siblings: [10, 11] }
    ],
    latencies: {
      l1Hit: 4.0,
      l2Hit: 12.0,
      l3Hit: 39.0,
      branchMispredict: 17.0,
      l2ItlbWalk: 32.0,
      l2DtlbWalk: 32.0,
      dramFallback: 225.0
    },
    advisor: {
      minSamples: 10,
      minAvgC0Pct: 10.0,
      minInstPerSec: 1.5e9
    },
    retiring: {
      uopsPerInst: 1.15,
      exactRetiring: false // false keeps Full at 18 Core PMCs (3-Mux); true adds 0x4300C1 (19 PMCs -> 4-Mux)
    },
    calibrated: false,
    moduleMinMiB: 4.0
  };

  const MUX_PRESETS = [
    { id: 'full', label: 'Full (3-Mux)', cliArg: 'full', corePmcs: 18, l3Pmcs: 4 },
    { id: 'tlb', label: 'TLB-Only (0-Mux)', cliArg: 'tlb', corePmcs: 5, l3Pmcs: 0 },
    { id: 'ipc-mem', label: 'IPC+Cache/DRAM (0-Mux)', cliArg: 'ipc-mem', corePmcs: 6, l3Pmcs: 4 },
    { id: 'uarch', label: 'Micro-Arch (0-Mux)', cliArg: 'uarch', corePmcs: 6, l3Pmcs: 4 },
    { id: 'no-pmu', label: 'No-PMU (Win32 Only)', cliArg: 'no-pmu', corePmcs: 0, l3Pmcs: 0 }
  ];

  // Exact verified AMD Zen 2 (Family 17h Model 71h) AMDuProfPcm event definitions per preset
  const PMU_FIXED_MSRS = [
    'core/aperf=(aperf)',
    'core/mperf=(mperf)',
    'core/inst=(irperf)'
  ];

  const PMU_L3_EVENTS = [
    'l3/l3_access=(0xFF0F00000040FF04)',
    'l3/l3_miss=(0xFF0F000000400104)',
    'l3/l3_lat=(0xFF0F000000400090)',
    'l3/l3_mtype=(0xFF0F000000401F9A)'
  ];

  const PMU_CORE_EVENTS_BY_PRESET = {
    full: [
      'core/cycles=(0x430076)',
      'core/branches=(0x4300C2)',
      'core/branch_miss=(0x4300C3)',
      'core/l1_itlb_hit=(0x430794)',
      'core/l1_itlb_l2h=(0x430084)',
      'core/l2_itlb_m=(0x430785)',
      'core/l1_dtlb_l2h=(0x430F45)',
      'core/l2_dtlb_m=(0x43F045)',
      'core/l1_ic_miss=(0x431060)',
      'core/l2_ic_miss=(0x430164)',
      'core/l1_dc_miss=(0x43C860)',
      'core/l2_dc_miss=(0x430864)',
      'core/dc_dem_l3=(0x430243)',
      'core/dc_dem_dram=(0x430843)',
      'core/dc_hwpf_l3=(0x43025A)',
      'core/dc_hwpf_dram=(0x43085A)',
      'core/l2_pf_l3=(0x431F71)',
      'core/l2_pf_dram=(0x431F72)'
    ],
    tlb: [
      'core/l1_itlb_hit=(0x430794)',
      'core/l1_itlb_l2h=(0x430084)',
      'core/l2_itlb_m=(0x430785)',
      'core/l1_dtlb_l2h=(0x430F45)',
      'core/l2_dtlb_m=(0x43F045)'
    ],
    'ipc-mem': [
      'core/cycles=(0x430076)',
      'core/branch_miss=(0x4300C3)',
      'core/l2_ic_miss=(0x430164)',
      'core/dc_dem_l3=(0x430243)',
      'core/dc_dem_dram=(0x430843)',
      'core/l2_dc_miss=(0x430864)'
    ],
    uarch: [
      'core/dc_cross_ccx=(0x430443)',
      'core/locks_serial=(0x430325)',
      'core/dec_uops=(0x4301AA)',
      'core/oc_uops=(0x4302AA)',
      'core/stlf_interlock=(0x430224)',
      'core/misal_access=(0x430047)'
    ],
    'no-pmu': []
  };

  function buildUprofMetricSpec(presetId, exactRetiring = false) {
    if (presetId === 'no-pmu') {
      return {
        presetId,
        coreEvents: [],
        fixedMsrs: [],
        l3Events: [],
        muxGroups: 0,
        metricString: ''
      };
    }
    const coreEvents = [...(PMU_CORE_EVENTS_BY_PRESET[presetId] || PMU_CORE_EVENTS_BY_PRESET.full)];
    if (presetId === 'full' && exactRetiring) {
      coreEvents.push('core/ret_uops=(0x4300C1)');
    }
    const fixedMsrs = [...PMU_FIXED_MSRS];
    const l3Events = presetId === 'tlb' ? [] : [...PMU_L3_EVENTS];
    const allEvents = [...coreEvents, ...fixedMsrs, ...l3Events];
    return {
      presetId,
      coreEvents,
      fixedMsrs,
      l3Events,
      muxGroups: Math.ceil(coreEvents.length / 6),
      metricString: allEvents.join(',')
    };
  }

  function computeMicroArchMetrics(raw, presetId = 'uarch') {
    if (presetId !== 'uarch' || !raw) return null;
    const inst = Math.max(1.0, Number(raw.inst) || 0);
    const dcCrossCcx = Math.max(0.0, Number(raw.dc_cross_ccx) || 0);
    const locksSerial = Math.max(0.0, Number(raw.locks_serial) || 0);
    const decUops = Math.max(0.0, Number(raw.dec_uops) || 0);
    const ocUops = Math.max(0.0, Number(raw.oc_uops) || 0);
    const stlfInterlock = Math.max(0.0, Number(raw.stlf_interlock) || 0);
    const misalAccess = Math.max(0.0, Number(raw.misal_access) || 0);

    const dcCrossCcxMpki = (dcCrossCcx / inst) * 1000.0;
    const locksSerialMpki = (locksSerial / inst) * 1000.0;
    const opcacheHitPct = (ocUops / Math.max(1.0, ocUops + decUops)) * 100.0;
    const legacyDecodePct = 100.0 - opcacheHitPct;
    const stlfInterlockMpki = (stlfInterlock / inst) * 1000.0;
    const misalAccessMpki = (misalAccess / inst) * 1000.0;

    return {
      dcCrossCcxMpki,
      locksSerialMpki,
      opcacheHitPct,
      legacyDecodePct,
      stlfInterlockMpki,
      misalAccessMpki
    };
  }

  function parseReportCoreCsv(csvText, presetId = 'uarch', baseMhz = CONFIG.baseMhz) {
    const lines = String(csvText || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) return null;
    const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
    const totals = {
      inst: 0, cycles: 0, aperf: 0, mperf: 0,
      dc_cross_ccx: 0, locks_serial: 0, dec_uops: 0,
      oc_uops: 0, stlf_interlock: 0, misal_access: 0
    };
    const perCore = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').map(c => c.trim());
      if (cols.length < headers.length) continue;
      const row = {};
      headers.forEach((h, idx) => {
        const num = Number(cols[idx]);
        row[h] = isFinite(num) ? num : 0;
      });
      for (const k of Object.keys(totals)) {
        if (k in row) totals[k] += row[k];
      }
      const coreInst = row.inst || row.irperf || 0;
      const coreAperf = row.aperf || 0;
      const coreCyc = (presetId === 'uarch' || !(row.cycles > 0)) ? coreAperf : row.cycles;
      perCore.push({
        coreId: row.core ?? row.cpu ?? (i - 1),
        inst: coreInst,
        aperf: coreAperf,
        mperf: row.mperf || 0,
        ipc: coreCyc > 0 ? coreInst / coreCyc : 0
      });
    }
    const useAperfCycles = presetId === 'uarch' || totals.cycles <= 0;
    const effCycles = useAperfCycles ? totals.aperf : totals.cycles;
    const ipc = effCycles > 0 ? totals.inst / effCycles : 0;
    const actualCpi = totals.inst > 0 ? effCycles / totals.inst : 0;
    const effGhz = totals.mperf > 0 ? (totals.aperf / totals.mperf) * (baseMhz / 1000.0) : 0;
    return {
      presetId,
      usedAperfFallback: useAperfCycles,
      totals,
      perCore,
      ipc,
      actualCpi,
      effGhz,
      uarch: computeMicroArchMetrics(totals, presetId)
    };
  }

  function deserializeBaselineJson(input) {
    const raw = typeof input === 'string' ? JSON.parse(input) : { ...(input || {}) };
    const ct = raw.cumulative_totals || {};
    const cumulative_totals = {
      inst: Number(ct.inst) || 0,
      cycles: Number(ct.cycles) || 0,
      aperf: Number(ct.aperf) || 0,
      mperf: Number(ct.mperf) || 0,
      dc_cross_ccx: Number(ct.dc_cross_ccx) || 0,
      locks_serial: Number(ct.locks_serial) || 0,
      dec_uops: Number(ct.dec_uops) || 0,
      oc_uops: Number(ct.oc_uops) || 0,
      stlf_interlock: Number(ct.stlf_interlock) || 0,
      misal_access: Number(ct.misal_access) || 0
    };
    const hasUarchTotals = (cumulative_totals.dc_cross_ccx + cumulative_totals.locks_serial +
      cumulative_totals.dec_uops + cumulative_totals.oc_uops +
      cumulative_totals.stlf_interlock + cumulative_totals.misal_access) > 0;
    const derivedUarch = hasUarchTotals && cumulative_totals.inst > 0
      ? computeMicroArchMetrics(cumulative_totals, 'uarch')
      : null;
    return {
      ...raw,
      muxPreset: raw.muxPreset || raw.mux_preset || 'full',
      dcCrossCcxMpki: raw.dcCrossCcxMpki ?? (derivedUarch ? derivedUarch.dcCrossCcxMpki : null),
      locksSerialMpki: raw.locksSerialMpki ?? (derivedUarch ? derivedUarch.locksSerialMpki : null),
      opcacheHitPct: raw.opcacheHitPct ?? (derivedUarch ? derivedUarch.opcacheHitPct : null),
      legacyDecodePct: raw.legacyDecodePct ?? (derivedUarch ? derivedUarch.legacyDecodePct : null),
      stlfInterlockMpki: raw.stlfInterlockMpki ?? (derivedUarch ? derivedUarch.stlfInterlockMpki : null),
      misalAccessMpki: raw.misalAccessMpki ?? (derivedUarch ? derivedUarch.misalAccessMpki : null),
      cumulative_totals
    };
  }

  function getActiveMux() {
    const base = MUX_PRESETS[Z.state.muxIndex];
    if (base.id === 'full' && CONFIG.retiring.exactRetiring) {
      return { id: 'full', label: 'Full (4-Mux)', cliArg: 'full', corePmcs: 19, l3Pmcs: 4 };
    }
    return base;
  }

  Object.assign(Z, { CONFIG, MUX_PRESETS, PMU_FIXED_MSRS, PMU_L3_EVENTS, PMU_CORE_EVENTS_BY_PRESET, buildUprofMetricSpec, computeMicroArchMetrics, parseReportCoreCsv, deserializeBaselineJson, getActiveMux });
})();
