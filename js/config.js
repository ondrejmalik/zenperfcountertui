// Zen 2 topology, modular PMU pack helpers, CSV parser, and baseline JSON schema
(() => {
  'use strict';
  const Z = window.Zen2Top || (window.Zen2Top = {});
  const {
    FREE_BASE_FIXED_MSRS, FREE_BASE_L3_EVENTS, MetricPack, QUICK_PRESETS,
    LEGACY_PRESET_TO_PACKS, normalizePackList, buildUprofMetrics,
    buildNoPmuPlan, resolvePlanFromLegacyOrPacks
  } = Z;

  const DEFAULT_PACKS_STORAGE_KEY = 'zen2top.default_packs';

  function loadSavedDefaultPacks() {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        const raw = window.localStorage.getItem(DEFAULT_PACKS_STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          const norm = normalizePackList(parsed);
          if (norm.length > 0) return norm;
        }
      }
    } catch (_err) {
      // Ignore storage errors in headless / restricted contexts
    }
    return [...QUICK_PRESETS[0].packs];
  }

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
      uopsPerInst: 1.15
    },
    defaultPacks: loadSavedDefaultPacks(),
    profiler: {
      autoStartEtw: true,
      sampleRateKhz: 1, // 1-4 kHz
      maxNodes: 20000,
      defaultBurstDurationSec: 5
    },
    calibrated: false,
    moduleMinMiB: 4.0
  };

  function saveDefaultPacksToConfig(packIds) {
    const norm = normalizePackList(packIds);
    if (norm.length === 0) return false;
    CONFIG.defaultPacks = norm;
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(DEFAULT_PACKS_STORAGE_KEY, JSON.stringify(norm));
      }
    } catch (_err) {
      // Non-fatal in headless Node or restricted storage contexts
    }
    return true;
  }

  // Compatibility aliases pointing to Always-On Free Base
  const PMU_FIXED_MSRS = FREE_BASE_FIXED_MSRS;
  const PMU_L3_EVENTS = FREE_BASE_L3_EVENTS;

  function buildUprofMetricSpec(input) {
    return resolvePlanFromLegacyOrPacks(input);
  }

  function computeMicroArchMetrics(raw, packPlanOrLegacy = null) {
    if (!raw) return null;
    let hasCrossCcx = false;
    let hasOpCache = false;
    let hasStlf = false;

    if (packPlanOrLegacy === 'uarch' || packPlanOrLegacy === null) {
      hasCrossCcx = true;
      hasOpCache = true;
      hasStlf = true;
    } else if (typeof packPlanOrLegacy === 'object' && typeof packPlanOrLegacy.has === 'function') {
      hasCrossCcx = packPlanOrLegacy.has(MetricPack.CrossCcxLocks);
      hasOpCache = packPlanOrLegacy.has(MetricPack.OpCacheDecode);
      hasStlf = packPlanOrLegacy.has(MetricPack.StlfSplits);
    } else {
      const plan = resolvePlanFromLegacyOrPacks(packPlanOrLegacy);
      hasCrossCcx = plan.has(MetricPack.CrossCcxLocks);
      hasOpCache = plan.has(MetricPack.OpCacheDecode);
      hasStlf = plan.has(MetricPack.StlfSplits);
    }

    if (!hasCrossCcx && !hasOpCache && !hasStlf) return null;

    const inst = Math.max(1.0, Number(raw.inst) || 0);
    const dcCrossCcx = Math.max(0.0, Number(raw.dc_cross_ccx) || 0);
    const locksSerial = Math.max(0.0, Number(raw.locks_serial) || 0);
    const decUops = Math.max(0.0, Number(raw.dec_uops) || 0);
    const ocUops = Math.max(0.0, Number(raw.oc_uops) || 0);
    const stlfInterlock = Math.max(0.0, Number(raw.stlf_interlock) || 0);
    const misalAccess = Math.max(0.0, Number(raw.misal_access) || 0);

    const dcCrossCcxMpki = hasCrossCcx ? (dcCrossCcx / inst) * 1000.0 : null;
    const locksSerialMpki = hasCrossCcx ? (locksSerial / inst) * 1000.0 : null;
    const opcacheHitPct = hasOpCache ? (ocUops / Math.max(1.0, ocUops + decUops)) * 100.0 : null;
    const legacyDecodePct = hasOpCache ? (100.0 - opcacheHitPct) : null;
    const stlfInterlockMpki = hasStlf ? (stlfInterlock / inst) * 1000.0 : null;
    const misalAccessMpki = hasStlf ? (misalAccess / inst) * 1000.0 : null;

    return {
      dcCrossCcxMpki,
      locksSerialMpki,
      opcacheHitPct,
      legacyDecodePct,
      stlfInterlockMpki,
      misalAccessMpki
    };
  }

  function parseReportCoreCsv(csvText, packPlanOrLegacy = 'uarch', baseMhz = CONFIG.baseMhz) {
    const lines = String(csvText || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) return null;
    const plan = resolvePlanFromLegacyOrPacks(packPlanOrLegacy);
    const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
    const totals = {
      inst: 0, cycles: 0, aperf: 0, mperf: 0, ret_uops: 0,
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
      const coreAperf = row.aperf > 0 ? row.aperf : (row.cycles || 0);
      perCore.push({
        coreId: row.core ?? row.cpu ?? (i - 1),
        inst: coreInst,
        aperf: coreAperf,
        mperf: row.mperf || 0,
        ipc: coreAperf > 0 ? coreInst / coreAperf : 0
      });
    }
    // Always-On Free Base derives IPC, Actual CPI, and Eff GHz universally from fixed MSRs (aperf/mperf/irperf)
    const effCycles = totals.aperf > 0 ? totals.aperf : totals.cycles;
    const ipc = effCycles > 0 ? totals.inst / effCycles : 0;
    const actualCpi = totals.inst > 0 ? effCycles / totals.inst : 0;
    const effGhz = totals.mperf > 0 ? (totals.aperf / totals.mperf) * (baseMhz / 1000.0) : 0;
    return {
      plan,
      presetId: plan.presetSlug,
      usedAperfFreeBase: totals.aperf > 0,
      totals,
      perCore,
      ipc,
      actualCpi,
      effGhz,
      uarch: computeMicroArchMetrics(totals, plan)
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
      ret_uops: Number(ct.ret_uops) || 0,
      dc_cross_ccx: Number(ct.dc_cross_ccx) || 0,
      locks_serial: Number(ct.locks_serial) || 0,
      dec_uops: Number(ct.dec_uops) || 0,
      oc_uops: Number(ct.oc_uops) || 0,
      stlf_interlock: Number(ct.stlf_interlock) || 0,
      misal_access: Number(ct.misal_access) || 0
    };

    // Resolve enabled_packs / core_pmc_slots / mux_groups with #[serde(default)] backwards compatibility
    const legacySlug = String(raw.muxPreset || raw.mux_preset || 'full').toLowerCase();
    const rawPacks = raw.enabled_packs ?? raw.enabledPacks ?? null;
    let enabledPacks;
    if (Array.isArray(rawPacks)) {
      enabledPacks = normalizePackList(rawPacks);
    } else if (legacySlug === 'no-pmu') {
      enabledPacks = [];
    } else {
      enabledPacks = [...(LEGACY_PRESET_TO_PACKS[legacySlug] || QUICK_PRESETS[0].packs)];
    }

    const plan = enabledPacks.length > 0 ? buildUprofMetrics(enabledPacks) : buildNoPmuPlan();
    const corePmcSlots = raw.core_pmc_slots ?? raw.corePmcSlots ?? plan.coreSlots;
    const muxGroups = raw.mux_groups ?? raw.muxGroups ?? plan.muxGroups;

    const hasUarchTotals = (cumulative_totals.dc_cross_ccx + cumulative_totals.locks_serial +
      cumulative_totals.dec_uops + cumulative_totals.oc_uops +
      cumulative_totals.stlf_interlock + cumulative_totals.misal_access) > 0;
    const derivedUarch = hasUarchTotals && cumulative_totals.inst > 0
      ? computeMicroArchMetrics(cumulative_totals, plan)
      : null;

    const packMetricOrNull = (packId, val) => {
      if (val === null || val === undefined) return null;
      return plan.has(packId) ? val : null;
    };

    return {
      ...raw,
      muxPreset: raw.muxPreset || raw.mux_preset || plan.presetSlug,
      enabled_packs: enabledPacks,
      enabledPacks,
      core_pmc_slots: corePmcSlots,
      corePmcSlots,
      mux_groups: muxGroups,
      muxGroups,
      dramMpki: packMetricOrNull(MetricPack.DcDemand, raw.dramMpki),
      l3HitMpki: packMetricOrNull(MetricPack.DcDemand, raw.l3HitMpki),
      l2dcExclMpki: packMetricOrNull(MetricPack.L1L2Dc, raw.l2dcExclMpki),
      l1dcMpki: packMetricOrNull(MetricPack.L1L2Dc, raw.l1dcMpki),
      l2dcMpki: packMetricOrNull(MetricPack.L1L2Dc, raw.l2dcMpki),
      l2icExclMpki: packMetricOrNull(MetricPack.L1L2Ic, raw.l2icExclMpki),
      l1icMpki: packMetricOrNull(MetricPack.L1L2Ic, raw.l1icMpki),
      l2icMpki: packMetricOrNull(MetricPack.L1L2Ic, raw.l2icMpki),
      l2pfL3Mpki: packMetricOrNull(MetricPack.L2Hwpf, raw.l2pfL3Mpki),
      l2pfDramMpki: packMetricOrNull(MetricPack.L2Hwpf, raw.l2pfDramMpki),
      branchMpki: packMetricOrNull(MetricPack.Branches, raw.branchMpki),
      l2dtlbMpki: packMetricOrNull(MetricPack.DtlbFull, raw.l2dtlbMpki),
      l2itlbMpki: packMetricOrNull(MetricPack.ItlbFull, raw.l2itlbMpki),
      dcCrossCcxMpki: raw.dcCrossCcxMpki ?? (derivedUarch ? derivedUarch.dcCrossCcxMpki : null),
      locksSerialMpki: raw.locksSerialMpki ?? (derivedUarch ? derivedUarch.locksSerialMpki : null),
      opcacheHitPct: raw.opcacheHitPct ?? (derivedUarch ? derivedUarch.opcacheHitPct : null),
      legacyDecodePct: raw.legacyDecodePct ?? (derivedUarch ? derivedUarch.legacyDecodePct : null),
      stlfInterlockMpki: raw.stlfInterlockMpki ?? (derivedUarch ? derivedUarch.stlfInterlockMpki : null),
      misalAccessMpki: raw.misalAccessMpki ?? (derivedUarch ? derivedUarch.misalAccessMpki : null),
      cumulative_totals
    };
  }

  function getActivePlan() {
    if (Z.state && Z.state.noPmu) return buildNoPmuPlan();
    const packs = (Z.state && Array.isArray(Z.state.enabledPacks) && Z.state.enabledPacks.length > 0)
      ? Z.state.enabledPacks
      : CONFIG.defaultPacks;
    return buildUprofMetrics(packs);
  }

  function getActiveMux() {
    const plan = getActivePlan();
    return {
      id: plan.presetSlug,
      label: plan.label,
      cliArg: plan.presetSlug,
      corePmcs: plan.coreSlots,
      l3Pmcs: plan.l3Events.length,
      muxGroups: plan.muxGroups,
      muxShort: plan.muxShort,
      dutyCyclePct: plan.dutyCyclePct,
      plan
    };
  }

  Object.assign(Z, {
    CONFIG,
    PMU_FIXED_MSRS,
    PMU_L3_EVENTS,
    saveDefaultPacksToConfig,
    buildUprofMetricSpec,
    computeMicroArchMetrics,
    parseReportCoreCsv,
    deserializeBaselineJson,
    getActivePlan,
    getActiveMux
  });
})();
