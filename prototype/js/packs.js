// Modular Zen 2 Core PMC Metric Packs, 6-Slot FFD Bin-Packer, and Quick Presets
(() => {
  'use strict';
  const Z = window.Zen2Top || (window.Zen2Top = {});

  const FREE_BASE_FIXED_MSRS = [
    'core/aperf=(aperf)',
    'core/mperf=(mperf)',
    'core/inst=(irperf)'
  ];

  const FREE_BASE_L3_EVENTS = [
    'l3/l3_access=(0xFF0F00000040FF04)',
    'l3/l3_miss=(0xFF0F000000400104)',
    'l3/l3_lat=(0xFF0F000000400090)',
    'l3/l3_mtype=(0xFF0F000000401F9A)'
  ];

  const MetricPack = Object.freeze({
    DcDemand: 'DcDemand',
    DcHwpf: 'DcHwpf',
    L1L2Dc: 'L1L2Dc',
    L1L2Ic: 'L1L2Ic',
    L2Hwpf: 'L2Hwpf',
    Branches: 'Branches',
    ItlbFull: 'ItlbFull',
    DtlbFull: 'DtlbFull',
    CrossCcxLocks: 'CrossCcxLocks',
    OpCacheDecode: 'OpCacheDecode',
    StlfSplits: 'StlfSplits',
    ExactRetiring: 'ExactRetiring'
  });

  // 12 Atomic Core PMC Packs (Total = 24 Core PMC slots = 4 exact mux groups of 6)
  const METRIC_PACKS = [
    {
      id: MetricPack.DcDemand,
      name: 'D-Cache L3/DRAM Demand',
      shortName: 'DC Demand',
      slots: 2,
      category: 'cpi',
      feeds: 'Tab 1 CPI / Tab 2 Cache / Tab 5 Advisor',
      events: ['core/dc_dem_l3=(0x430243)', 'core/dc_dem_dram=(0x430843)'],
      hexSummary: '0x430243, 0x430843'
    },
    {
      id: MetricPack.DcHwpf,
      name: 'D-Cache L1 HWPF L3/DRAM',
      shortName: 'DC HWPF',
      slots: 2,
      category: 'cpi',
      feeds: 'Tab 1 CPI / Tab 2 Cache / Tab 5 Advisor',
      events: ['core/dc_hwpf_l3=(0x43025A)', 'core/dc_hwpf_dram=(0x43085A)'],
      hexSummary: '0x43025A, 0x43085A'
    },
    {
      id: MetricPack.L1L2Dc,
      name: 'L1/L2 D-Cache Hierarchy',
      shortName: 'L1/L2 DC',
      slots: 2,
      category: 'cpi',
      feeds: 'Tab 1 CPI / Tab 2 Cache',
      events: ['core/l1_dc_miss=(0x43C860)', 'core/l2_dc_miss=(0x430864)'],
      hexSummary: '0x43C860, 0x430864'
    },
    {
      id: MetricPack.L1L2Ic,
      name: 'L1/L2 I-Cache Hierarchy',
      shortName: 'L1/L2 IC',
      slots: 2,
      category: 'cpi',
      feeds: 'Tab 1 CPI / Tab 2 Cache / Tab 5 Advisor',
      events: ['core/l1_ic_miss=(0x431060)', 'core/l2_ic_miss=(0x430164)'],
      hexSummary: '0x431060, 0x430164'
    },
    {
      id: MetricPack.L2Hwpf,
      name: 'L2 HWPF L3/DRAM',
      shortName: 'L2 HWPF',
      slots: 2,
      category: 'cache',
      feeds: 'Tab 2 Cache / Tab 5 Advisor',
      events: ['core/l2_pf_l3=(0x431F71)', 'core/l2_pf_dram=(0x431F72)'],
      hexSummary: '0x431F71, 0x431F72'
    },
    {
      id: MetricPack.Branches,
      name: 'Branches & Mispredicts',
      shortName: 'Branches',
      slots: 2,
      category: 'cpi',
      feeds: 'Tab 1 CPI / Tab 5 Advisor',
      events: ['core/branches=(0x4300C2)', 'core/branch_miss=(0x4300C3)'],
      hexSummary: '0x4300C2, 0x4300C3'
    },
    {
      id: MetricPack.ItlbFull,
      name: 'iTLB Full',
      shortName: 'iTLB',
      slots: 3,
      category: 'tlb',
      feeds: 'Tab 1 CPI / Tab 3 TLB / Tab 5 Advisor',
      events: ['core/l1_itlb_hit=(0x430794)', 'core/l1_itlb_miss_l2_hit=(0x430084)', 'core/l2_itlb_miss=(0x430785)'],
      hexSummary: '0x430794, 0x430084, 0x430785'
    },
    {
      id: MetricPack.DtlbFull,
      name: 'dTLB Full',
      shortName: 'dTLB',
      slots: 2,
      category: 'tlb',
      feeds: 'Tab 1 CPI / Tab 3 TLB / Tab 5 Advisor',
      events: ['core/l1_dtlb_miss_l2_hit=(0x430F45)', 'core/l2_dtlb_miss=(0x43F045)'],
      hexSummary: '0x430F45, 0x43F045'
    },
    {
      id: MetricPack.CrossCcxLocks,
      name: 'Cross-CCX Fills & Serialized Locks',
      shortName: 'CCX+Locks',
      slots: 2,
      category: 'uarch',
      feeds: 'Tab 1 uArch / Tab 5 Advisor',
      events: ['core/dc_cross_ccx=(0x430443)', 'core/locks_serial=(0x430325)'],
      hexSummary: '0x430443, 0x430325'
    },
    {
      id: MetricPack.OpCacheDecode,
      name: 'Op-Cache vs. Legacy Decode',
      shortName: 'Op-Cache',
      slots: 2,
      category: 'uarch',
      feeds: 'Tab 1 uArch / Tab 5 Advisor',
      events: ['core/dec_uops=(0x4301AA)', 'core/oc_uops=(0x4302AA)'],
      hexSummary: '0x4301AA, 0x4302AA'
    },
    {
      id: MetricPack.StlfSplits,
      name: 'STLF Interlocks & Line Splits',
      shortName: 'STLF+Splits',
      slots: 2,
      category: 'uarch',
      feeds: 'Tab 1 uArch / Tab 5 Advisor',
      events: ['core/stlf_interlock=(0x430224)', 'core/misal_access=(0x430047)'],
      hexSummary: '0x430224, 0x430047'
    },
    {
      id: MetricPack.ExactRetiring,
      name: 'Exact Macro-Op Retiring',
      shortName: 'Retiring',
      slots: 1,
      category: 'retiring',
      feeds: 'Tab 1 Ret% / Tab 5 Advisor',
      events: ['core/ret_uops=(0x4300C1)'],
      hexSummary: '0x4300C1'
    }
  ];

  const METRIC_PACK_BY_ID = Object.fromEntries(METRIC_PACKS.map((p, idx) => [p.id, { ...p, order: idx }]));
  const ALL_PACK_IDS = METRIC_PACKS.map(p => p.id);

  // 6 Built-In Quick Presets (selectable via 1-6 inside 'm' modal, 'M' fast-cycle, or --preset <slug>)
  const QUICK_PRESETS = [
    {
      key: '1',
      slug: 'full',
      shortName: 'Full',
      stripLabel: 'Full 3-Mux',
      name: 'Full (3-Mux, 18/18, 33%)',
      packs: [
        MetricPack.DcDemand, MetricPack.DcHwpf, MetricPack.L1L2Dc,
        MetricPack.L1L2Ic, MetricPack.L2Hwpf, MetricPack.Branches,
        MetricPack.ItlbFull, MetricPack.DtlbFull, MetricPack.ExactRetiring
      ]
    },
    {
      key: '2',
      slug: 'all',
      shortName: 'All',
      stripLabel: 'All 4-Mux',
      name: 'Kitchen Sink (4-Mux, 24/24, 25%)',
      packs: [...ALL_PACK_IDS]
    },
    {
      key: '3',
      slug: 'daily',
      shortName: 'Daily',
      stripLabel: 'Daily 2-Mux',
      name: 'Balanced Daily (2-Mux, 12/12, 50%)',
      packs: [
        MetricPack.DcDemand, MetricPack.L1L2Dc, MetricPack.L1L2Ic,
        MetricPack.Branches, MetricPack.DtlbFull, MetricPack.CrossCcxLocks
      ]
    },
    {
      key: '4',
      slug: 'tlb',
      shortName: 'TLB',
      stripLabel: 'TLB 0-Mux',
      name: 'TLB-Only (0-Mux, 6/6, 100%)',
      packs: [MetricPack.ItlbFull, MetricPack.DtlbFull, MetricPack.ExactRetiring]
    },
    {
      key: '5',
      slug: 'mem-ccx',
      shortName: 'Mem+CCX',
      stripLabel: 'Mem+CCX 0-Mux',
      name: 'Mem + CCX Lab (0-Mux, 6/6, 100%)',
      packs: [MetricPack.DcDemand, MetricPack.DtlbFull, MetricPack.CrossCcxLocks]
    },
    {
      key: '6',
      slug: 'uarch',
      shortName: 'uArch',
      stripLabel: 'uArch 0-Mux',
      name: 'Micro-Arch (0-Mux, 6/6, 100%)',
      packs: [MetricPack.CrossCcxLocks, MetricPack.OpCacheDecode, MetricPack.StlfSplits]
    }
  ];

  // Legacy preset alias lookup (for backwards compatibility with older baselines and tests)
  const LEGACY_PRESET_TO_PACKS = {
    full: QUICK_PRESETS[0].packs,
    all: QUICK_PRESETS[1].packs,
    'kitchen-sink': QUICK_PRESETS[1].packs,
    daily: QUICK_PRESETS[2].packs,
    balanced: QUICK_PRESETS[2].packs,
    tlb: QUICK_PRESETS[3].packs,
    'mem-ccx': QUICK_PRESETS[4].packs,
    'ipc-mem': [MetricPack.DcDemand, MetricPack.L1L2Dc, MetricPack.Branches],
    uarch: QUICK_PRESETS[5].packs,
    'no-pmu': []
  };

  function normalizePackList(input) {
    const seen = new Set();
    const arr = Array.isArray(input) ? input : (input instanceof Set ? [...input] : []);
    for (const raw of arr) {
      if (typeof raw !== 'string') continue;
      if (METRIC_PACK_BY_ID[raw]) {
        seen.add(raw);
      } else {
        const lower = raw.trim().toLowerCase();
        const match = METRIC_PACKS.find(p => p.id.toLowerCase() === lower);
        if (match) seen.add(match.id);
      }
    }
    return ALL_PACK_IDS.filter(id => seen.has(id));
  }

  function packsEqual(a, b) {
    const na = normalizePackList(a);
    const nb = normalizePackList(b);
    if (na.length !== nb.length) return false;
    for (let i = 0; i < na.length; i++) {
      if (na[i] !== nb[i]) return false;
    }
    return true;
  }

  function findMatchingPreset(packIds) {
    const norm = normalizePackList(packIds);
    return QUICK_PRESETS.find(p => packsEqual(p.packs, norm)) || null;
  }

  function getPresetBySlug(slug) {
    if (!slug) return null;
    const s = String(slug).trim().toLowerCase();
    return QUICK_PRESETS.find(p => p.slug === s) || null;
  }

  function formatMuxShort(muxGroups) {
    if (!muxGroups || muxGroups <= 0) return 'No-PMU';
    if (muxGroups === 1) return '0-Mux';
    return `${muxGroups}-Mux`;
  }

  function getMuxAccuracyClass(muxGroups) {
    if (!muxGroups || muxGroups <= 0) return 'c-dim';
    if (muxGroups === 1) return 'c-green';
    if (muxGroups === 2) return 'c-cyan';
    if (muxGroups === 3) return 'c-yellow';
    return 'c-orange';
  }

  function formatPlanTopBarLabel(plan) {
    if (!plan || plan.noPmu || plan.muxGroups === 0) {
      return 'No-PMU (Win32)';
    }
    const name = plan.preset ? plan.preset.shortName : 'Custom';
    if (plan.muxGroups === 1) {
      return `${name} 0-Mux`;
    }
    return `${name} ${plan.muxGroups}-Mux (${Math.round(plan.dutyCyclePct)}%)`;
  }

  /**
   * Deterministic 6-slot Zen 2 Core PMC bin-packer (First-Fit Decreasing + Zero-Cost Alignment Pad).
   * Guarantees zero coupled multi-event packs ever straddle a 6-register AMDuProfPcm mux boundary.
   * Rejects empty PackSet (enforces enabled_core_pmcs >= 1 driver guardrail).
   */
  function buildUprofMetrics(enabledPacks) {
    const selectedPacks = normalizePackList(enabledPacks);
    if (selectedPacks.length === 0) {
      throw new Error('AMDuProfPcm driver guardrail: at least 1 Core PMC pack must be enabled alongside fixed MSRs.');
    }

    const packObjs = selectedPacks.map(id => METRIC_PACK_BY_ID[id]);
    const requestedSlots = packObjs.reduce((acc, p) => acc + p.slots, 0);

    // 1. Sort enabled packs descending by slot size (3, then 2, then 1), preserving canonical order on ties
    const sorted = [...packObjs].sort((a, b) => (b.slots - a.slots) || (a.order - b.order));

    // 2. First-Fit Decreasing into 6-slot hardware bins
    const bins = [];
    for (const pack of sorted) {
      let placed = false;
      for (const bin of bins) {
        if (bin.used + pack.slots <= 6) {
          bin.packs.push(pack);
          bin.used += pack.slots;
          placed = true;
          break;
        }
      }
      if (!placed) {
        bins.push({ packs: [pack], used: pack.slots, autoPadded: false });
      }
    }

    // 3. Zero-Cost Alignment Pad Rule:
    // If bins.length > 1 and any non-final bin ends with 5 slots (ItlbFull 3 + one 2-slot pack without ExactRetiring),
    // automatically pad that 1 leftover slot with ExactRetiring (0x4300C1) at 0 extra mux group cost.
    let autoPaddedRetiring = false;
    const retPack = METRIC_PACK_BY_ID[MetricPack.ExactRetiring];
    if (bins.length > 1) {
      for (let i = 0; i < bins.length - 1; i++) {
        if (bins[i].used === 5 && !selectedPacks.includes(MetricPack.ExactRetiring)) {
          bins[i].packs.push({ ...retPack, isAutoPad: true });
          bins[i].used += retPack.slots;
          bins[i].autoPadded = true;
          autoPaddedRetiring = true;
        }
      }
    }

    // 4. Emit Core events in packed bin order, recording each pack's assigned 1-based group index
    const coreEvents = [];
    const packGroupMap = {};
    const eventPackMap = [];
    const compiledBins = bins.map((bin, binIdx) => {
      const groupNum = binIdx + 1;
      const startIndex = coreEvents.length;
      for (const pack of bin.packs) {
        packGroupMap[pack.id] = groupNum;
        for (const ev of pack.events) {
          coreEvents.push(ev);
          eventPackMap.push({ event: ev, packId: pack.id, group: groupNum, isAutoPad: Boolean(pack.isAutoPad) });
        }
      }
      return {
        group: groupNum,
        used: bin.used,
        capacity: 6,
        autoPadded: bin.autoPadded,
        startIndex,
        packs: bin.packs.map(p => ({ id: p.id, slots: p.slots, isAutoPad: Boolean(p.isAutoPad) }))
      };
    });

    const effectivePacks = autoPaddedRetiring
      ? normalizePackList([...selectedPacks, MetricPack.ExactRetiring])
      : [...selectedPacks];
    const effectiveSet = new Set(effectivePacks);

    const coreSlots = coreEvents.length;
    const muxGroups = Math.ceil(coreSlots / 6);
    const dutyCyclePct = 100.0 / muxGroups;
    const fixedMsrs = [...FREE_BASE_FIXED_MSRS];
    const l3Events = [...FREE_BASE_L3_EVENTS];
    const allEvents = [...coreEvents, ...fixedMsrs, ...l3Events];
    const preset = findMatchingPreset(selectedPacks);

    const plan = {
      noPmu: false,
      selectedPacks,
      effectivePacks,
      effectiveSet,
      autoPaddedRetiring,
      requestedSlots,
      coreSlots,
      capacitySlots: muxGroups * 6,
      muxGroups,
      muxShort: formatMuxShort(muxGroups),
      dutyCyclePct,
      bins: compiledBins,
      packGroupMap,
      eventPackMap,
      coreEvents,
      fixedMsrs,
      l3Events,
      metricString: allEvents.join(','),
      preset,
      presetSlug: preset ? preset.slug : 'custom',
      presetName: preset ? preset.shortName : 'Custom',
      label: '',
      has(packId) {
        return effectiveSet.has(packId);
      }
    };
    plan.label = formatPlanTopBarLabel(plan);
    return plan;
  }

  function buildNoPmuPlan() {
    const emptySet = new Set();
    return {
      noPmu: true,
      selectedPacks: [],
      effectivePacks: [],
      effectiveSet: emptySet,
      autoPaddedRetiring: false,
      requestedSlots: 0,
      coreSlots: 0,
      capacitySlots: 0,
      muxGroups: 0,
      muxShort: 'No-PMU',
      dutyCyclePct: 0,
      bins: [],
      packGroupMap: {},
      eventPackMap: [],
      coreEvents: [],
      fixedMsrs: [],
      l3Events: [],
      metricString: '',
      preset: null,
      presetSlug: 'no-pmu',
      presetName: 'No-PMU',
      label: 'No-PMU (Win32)',
      has() {
        return false;
      }
    };
  }

  function resolvePlanFromLegacyOrPacks(input) {
    if (!input) return buildUprofMetrics(QUICK_PRESETS[0].packs);
    if (typeof input === 'object' && !Array.isArray(input) && typeof input.has === 'function') {
      return input;
    }
    if (typeof input === 'string') {
      const slug = input.trim().toLowerCase();
      if (slug === 'no-pmu') return buildNoPmuPlan();
      const mapped = LEGACY_PRESET_TO_PACKS[slug];
      if (mapped && mapped.length > 0) return buildUprofMetrics(mapped);
      const preset = getPresetBySlug(slug);
      if (preset) return buildUprofMetrics(preset.packs);
      return buildUprofMetrics(QUICK_PRESETS[0].packs);
    }
    if (Array.isArray(input) || input instanceof Set) {
      const norm = normalizePackList(input);
      if (norm.length === 0) return buildNoPmuPlan();
      return buildUprofMetrics(norm);
    }
    return buildUprofMetrics(QUICK_PRESETS[0].packs);
  }

  function hasAnyMicroArchPack(plan) {
    if (!plan || plan.noPmu) return false;
    return plan.has(MetricPack.CrossCcxLocks) || plan.has(MetricPack.OpCacheDecode) || plan.has(MetricPack.StlfSplits);
  }

  function hasAnyCpiPack(plan) {
    if (!plan || plan.noPmu) return false;
    return plan.has(MetricPack.DcDemand) || plan.has(MetricPack.L1L2Dc) || plan.has(MetricPack.L1L2Ic) ||
      plan.has(MetricPack.Branches) || plan.has(MetricPack.DtlbFull) || plan.has(MetricPack.ItlbFull);
  }

  Object.assign(Z, {
    FREE_BASE_FIXED_MSRS,
    FREE_BASE_L3_EVENTS,
    MetricPack,
    METRIC_PACKS,
    METRIC_PACK_BY_ID,
    ALL_PACK_IDS,
    QUICK_PRESETS,
    LEGACY_PRESET_TO_PACKS,
    normalizePackList,
    packsEqual,
    findMatchingPreset,
    getPresetBySlug,
    formatMuxShort,
    getMuxAccuracyClass,
    formatPlanTopBarLabel,
    buildUprofMetrics,
    buildNoPmuPlan,
    resolvePlanFromLegacyOrPacks,
    hasAnyMicroArchPack,
    hasAnyCpiPack
  });
})();
