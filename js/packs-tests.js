// Automated unit tests for Modular PMU Packs, 6-Slot Bin-Packing, Auto-Pad, Baselines & Pack-Driven Advisor
(() => {
  'use strict';
  const Z = window.Zen2Top || (window.Zen2Top = {});
  const {
    MetricPack, METRIC_PACKS, METRIC_PACK_BY_ID, ALL_PACK_IDS, QUICK_PRESETS,
    buildUprofMetrics, deserializeBaselineJson, evaluateDiagnostics, makeMod, makeWin32Profile
  } = Z;

  function runPackTests() {
    const results = [];
    const check = (name, cond, detail) => results.push({ name, pass: Boolean(cond), detail });

    // 1. Exhaustive zero-split invariant & optimal mux groups across ALL 2^12 - 1 = 4,095 non-empty combinations
    let testedCombos = 0;
    let firstFailure = null;
    const totalCombos = (1 << ALL_PACK_IDS.length) - 1;
    for (let mask = 1; mask <= totalCombos; mask++) {
      const enabled = [];
      let requestedSlots = 0;
      for (let bit = 0; bit < ALL_PACK_IDS.length; bit++) {
        if ((mask & (1 << bit)) !== 0) {
          const id = ALL_PACK_IDS[bit];
          enabled.push(id);
          requestedSlots += METRIC_PACK_BY_ID[id].slots;
        }
      }
      const plan = buildUprofMetrics(enabled);
      const expectedMinGroups = Math.ceil(requestedSlots / 6);

      if (plan.muxGroups !== expectedMinGroups) {
        firstFailure = `mask=${mask} muxGroups=${plan.muxGroups} != expected=${expectedMinGroups}`;
        break;
      }
      if (plan.coreEvents.length !== plan.coreSlots) {
        firstFailure = `mask=${mask} coreEvents.length=${plan.coreEvents.length} != coreSlots=${plan.coreSlots}`;
        break;
      }
      if (plan.fixedMsrs.length !== 3 || plan.l3Events.length !== 4) {
        firstFailure = `mask=${mask} free base count mismatch`;
        break;
      }

      // Assert every enabled multi-event pack's events have identical Math.floor(eventIndex / 6)
      for (const packId of plan.effectivePacks) {
        const pack = METRIC_PACK_BY_ID[packId];
        const indices = pack.events.map(ev => plan.coreEvents.indexOf(ev));
        if (indices.some(idx => idx < 0)) {
          firstFailure = `mask=${mask} missing event for ${packId}`;
          break;
        }
        const groups = new Set(indices.map(idx => Math.floor(idx / 6)));
        if (groups.size !== 1) {
          firstFailure = `mask=${mask} SPLIT coupled pack ${packId} across groups ${[...groups].join(',')}`;
          break;
        }
      }
      if (firstFailure) break;
      testedCombos++;
    }
    check(
      'zero_split_invariant_all_4095_combos',
      !firstFailure && testedCombos === 4095,
      firstFailure || `verified=${testedCombos}/4095 combos, 0 split coupled pairs, optimal mux groups`
    );

    // 2. Auto-pad behavior:
    //    ItlbFull (3) + DcDemand (2) = 5 slots (no pad, 0-Mux)
    //    ItlbFull (3) + DcDemand (2) + Branches (2) = 8 slots -> Bin 1 auto-padded with ExactRetiring (2-Mux, Branches unsplit in Bin 2)
    const p5 = buildUprofMetrics([MetricPack.ItlbFull, MetricPack.DcDemand]);
    const p8 = buildUprofMetrics([MetricPack.ItlbFull, MetricPack.DcDemand, MetricPack.Branches]);
    const p8Explicit = buildUprofMetrics([MetricPack.ItlbFull, MetricPack.DcDemand, MetricPack.Branches, MetricPack.ExactRetiring]);
    const brEvents = METRIC_PACK_BY_ID[MetricPack.Branches].events;
    const brBins = brEvents.map(ev => Math.floor(p8.coreEvents.indexOf(ev) / 6));
    check(
      'auto_pad_exact_retiring_zero_mux_cost',
      p5.coreSlots === 5 && !p5.autoPaddedRetiring && p5.muxGroups === 1 && !p5.has(MetricPack.ExactRetiring) &&
      p8.requestedSlots === 7 && p8.coreSlots === 8 && p8.autoPaddedRetiring && p8.muxGroups === 2 &&
      p8.has(MetricPack.ExactRetiring) && p8.packGroupMap[MetricPack.ExactRetiring] === 1 &&
      p8.packGroupMap[MetricPack.Branches] === 2 && brBins[0] === 1 && brBins[1] === 1 &&
      p8Explicit.coreSlots === 8 && !p8Explicit.autoPaddedRetiring && p8Explicit.muxGroups === 2,
      `5slot(pad=${p5.autoPaddedRetiring},mux=${p5.muxShort}), 8slot(pad=${p8.autoPaddedRetiring},mux=${p8.muxShort},BrBins=${brBins.join('/')})`
    );

    // 3. Guardrail rejecting empty PackSet (0 Core PMCs)
    let emptyRejected = false;
    let emptyMsg = '';
    try {
      buildUprofMetrics([]);
    } catch (err) {
      emptyRejected = true;
      emptyMsg = err.message;
    }
    check(
      'empty_packset_guardrail',
      emptyRejected && /at least 1 Core PMC/i.test(emptyMsg),
      `rejected=${emptyRejected}`
    );

    // 4. All 6 Quick Presets exact slot & group counts + total 24 slots + cycles 0x430076 reclaimed
    const totalPackSlots = METRIC_PACKS.reduce((acc, p) => acc + p.slots, 0);
    const hasLegacyCyclesHex = METRIC_PACKS.some(p => p.events.some(ev => ev.includes('0x430076')));
    const presetChecks = [
      ['full', 18, 3],
      ['all', 24, 4],
      ['daily', 12, 2],
      ['tlb', 6, 1],
      ['mem-ccx', 6, 1],
      ['uarch', 6, 1]
    ].map(([slug, expSlots, expGroups]) => {
      const preset = QUICK_PRESETS.find(p => p.slug === slug);
      const plan = preset ? buildUprofMetrics(preset.packs) : null;
      return Boolean(plan && plan.coreSlots === expSlots && plan.muxGroups === expGroups && !plan.autoPaddedRetiring);
    });
    check(
      'quick_presets_and_24_slot_budget',
      totalPackSlots === 24 && !hasLegacyCyclesHex && presetChecks.every(Boolean),
      `totalSlots=${totalPackSlots}, cyclesReclaimed=${!hasLegacyCyclesHex}, presets=${presetChecks.filter(Boolean).length}/6`
    );

    // 5. Baseline JSON round-trip with custom pack subset, legacy fallback, and MUX DIFF + small-delta hygiene
    const customPacks = [MetricPack.DcDemand, MetricPack.DtlbFull, MetricPack.Branches, MetricPack.CrossCcxLocks];
    const customPlan = buildUprofMetrics(customPacks); // 8 slots -> 2-Mux
    const rawCustomBase = {
      name: 'custom_2mux.json',
      enabled_packs: customPacks,
      core_pmc_slots: customPlan.coreSlots,
      mux_groups: customPlan.muxGroups,
      ipc: 1.40,
      dramMpki: 1.85,
      l2dtlbMpki: 0.25,
      l2itlbMpki: 0.99, // NOT in enabled_packs -> must deserialize as null!
      branchMpki: 2.80,
      dcCrossCcxMpki: 1.15
    };
    const roundTripped = deserializeBaselineJson(JSON.stringify(rawCustomBase));
    const legacyBase = deserializeBaselineJson(JSON.stringify({
      name: 'legacy_uarch.json',
      mux_preset: 'uarch',
      ipc: 1.32
    }));

    const testProc = {
      pid: 9500,
      name: 'pack_test.exe',
      wsMiB: 1024,
      hugeMiB: 2048,
      requestedHugeMiB: 2048,
      ifeoEnabled: false,
      modules: [makeMod('game.dll', 48.0, true, true, 'RX', true, 0x7FF800000000n)],
      arenas: null,
      win32Profile: makeWin32Profile()
    };
    const mkOv = (extra = {}) => ({
      samples: 15,
      proc: testProc,
      base: null,
      avgCoreC0: [62, 10, 50, 8, 40, 5, 45, 6, 30, 4, 20, 2],
      avgCcxLat: [48, 49],
      avgGpu3dPct: 65.0,
      avgCoreDpc: new Array(12).fill(0.3),
      avgCoreIrq: new Array(12).fill(0.2),
      avgCoreIrqRate: new Array(12).fill(300),
      avgHardPageReads: 0.0,
      avgAvailPhysPct: 50.0,
      avgCommitPct: 42.0,
      avgCtxSw: 9000,
      avgSyncWaitPct: 12.0,
      topWaitReason: 'WrQueue',
      priorityClass: 'NORMAL',
      ecoQos: 'Inactive',
      seLockMemoryPrivilege: 'Present',
      noisyNeighbors: [],
      ...extra,
      avg: {
        avgC0Pct: 42.0, instPerSec: 8e9, ipc: 1.42, actualCpi: 0.70, modeledCpi: 0.55,
        oooHiddenCpi: 0.0, retiringPct: 27.0, effGhz: 4.2,
        dram: 1.2, demDram: 0.9, hwpfDram: 0.3, l2pfDram: 0.2,
        l3Hit: 2.2, l3Miss: 1.1, l3HitPct: 86.0, latNs: 49.0, latCyc: 205,
        l2icMiss: 0.8, l2icExcl: 4.0, l1ic: 5.0, l2dcExcl: 10.0,
        branch: 1.8, branchMissPct: 1.8, l2itlb: 0.08, l1ItlbMissPct: 0.2,
        l2dtlb: 0.08, pageFaultRate: 120, cpuUsr: 40.0, cpuSys: 4.0,
        ...(extra.avg || {})
      }
    });

    // Live 0-Mux vs 2-Mux baseline -> MUX DIFF (0-Mux vs 2-Mux)
    const dMuxDiff = evaluateDiagnostics(mkOv({
      packs: [MetricPack.DcDemand, MetricPack.DtlbFull, MetricPack.CrossCcxLocks],
      base: roundTripped
    }));
    const fMuxDiff = dMuxDiff.findings.find(f => f.id === 'hygiene_mux_mismatch');

    // Live 2-Mux vs 2-Mux baseline with <3% IPC delta (1.42 vs 1.40 = 1.4%) -> recommends trimming to <= 6 slots (0-Mux)
    const dSmallDelta = evaluateDiagnostics(mkOv({
      packs: QUICK_PRESETS.find(p => p.slug === 'daily').packs,
      base: roundTripped
    }));
    const fSmallDelta = dSmallDelta.findings.find(f => f.id === 'hygiene_small_delta_mux');

    check(
      'baseline_roundtrip_and_mux_diff_hygiene',
      roundTripped.enabled_packs.length === 4 && roundTripped.core_pmc_slots === 8 && roundTripped.mux_groups === 2 &&
      roundTripped.dramMpki === 1.85 && roundTripped.l2itlbMpki === null && roundTripped.dcCrossCcxMpki === 1.15 &&
      legacyBase.mux_groups === 1 && legacyBase.core_pmc_slots === 6 && legacyBase.enabled_packs.length === 3 &&
      fMuxDiff && fMuxDiff.title.includes('MUX DIFF (0-Mux vs 2-Mux)') &&
      fSmallDelta && fSmallDelta.action.includes('<= 6') && fSmallDelta.action.includes('0-Mux'),
      `rtSlots=${roundTripped.core_pmc_slots}, legacyGroups=${legacyBase.mux_groups}, muxDiff="${fMuxDiff?.keyMetric}", smallDelta=${Boolean(fSmallDelta)}`
    );

    // 6. Pack-driven Advisor gating: mixed CPI + uArch packs fire ONLY their own rules and silence unchecked packs
    const dMixed = evaluateDiagnostics(mkOv({
      packs: [MetricPack.DcDemand, MetricPack.CrossCcxLocks],
      avg: { dram: 3.6, demDram: 3.2, hwpfDram: 0.4, latNs: 76.0, latCyc: 318, branch: 8.5, branchMissPct: 5.0 },
      uarchRaw: {
        inst: 1e9,
        dc_cross_ccx: 2.5e6,    // 2.5 MPKI -> HI cross_ccx_cache_bouncing
        locks_serial: 0.8e6,    // 0.8 MPKI -> HI serialized_lock_contention
        dec_uops: 6e8,          // 60% legacy (OpCacheDecode UNCHECKED -> must stay silent!)
        oc_uops: 4e8,
        stlf_interlock: 5.0e6,  // 5.0 MPKI (StlfSplits UNCHECKED -> must stay silent!)
        misal_access: 25.0e6
      }
    }));
    const hasDramQ = dMixed.findings.some(f => f.id === 'dram_queueing_inflation');
    const hasCcxBounce = dMixed.findings.some(f => f.id === 'cross_ccx_cache_bouncing');
    const hasLocks = dMixed.findings.some(f => f.id === 'serialized_lock_contention');
    const noDemSplit = !dMixed.findings.some(f => f.id === 'demand_dram_pointer_chase');
    const noBranch = !dMixed.findings.some(f => f.id === 'branch_mispredict_bound');
    const noOpCache = !dMixed.findings.some(f => f.id === 'opcache_thrashing');
    const noStlf = !dMixed.findings.some(f => f.id === 'stlf_interlocks');
    check(
      'pack_driven_advisor_gating',
      hasDramQ && hasCcxBounce && hasLocks && noDemSplit && noBranch && noOpCache && noStlf,
      `active(dramQ=${hasDramQ},ccx=${hasCcxBounce},locks=${hasLocks}), silenced(demSplit=${noDemSplit},br=${noBranch},oc=${noOpCache},stlf=${noStlf})`
    );

    const passed = results.filter(r => r.pass).length;
    return { passed, total: results.length, results };
  }

  const prevRunAll = Z.runAllDiagnosticTests;
  function runAllDiagnosticTests() {
    const base = typeof prevRunAll === 'function' ? prevRunAll() : { passed: 0, total: 0, results: [] };
    const packRep = runPackTests();
    return {
      passed: base.passed + packRep.passed,
      total: base.total + packRep.total,
      results: [...base.results, ...packRep.results]
    };
  }

  Object.assign(Z, { runPackTests, runAllDiagnosticTests });
})();
