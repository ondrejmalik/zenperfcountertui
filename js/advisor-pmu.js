// Hardware PMU (Rules 1-11) and Micro-Arch/Contention (Rules 12-16) diagnostic rules
(() => {
  'use strict';
  const Z = window.Zen2Top || (window.Zen2Top = {});
  const { CONFIG, MUX_PRESETS, state, computeMicroArchMetrics, fmtMiB, fmtRate } = Z;

  function evaluatePmuRules(ctx, groupA) {
    const {
      proc, base, mux, muxId, hasIpcClock, hasCacheCore, hasFull, hasTlb, hasL3,
      avgC0, avgIpc, avgActualCpi, avgGhz, avgDram, avgDemDram, avgHwpfDram, avgL2pfDram,
      avgL3Miss, avgL3HitPct, avgL3LatNs, avgL3LatCyc, avgL2IcMiss, avgL1Ic,
      avgBranch, avgBranchPct, avgL2Itlb, avgL1ItlbPct, avgL2Dtlb,
      avgPfRate, avgUsr, avgSys, sysSharePct, avgCoreC0, avgCcxLat,
      avgTierCpi, sumModeledCpi, pushFinding, pushHealthy
    } = ctx;
    const { largePageFailureTriggered } = groupA;

    // --- RULE 1: PE Code iTLB (4 KiB Modules when IFEO Disabled; Silent Failure upgraded to Group A Rule 6) ---
    if (proc && hasTlb) {
      const itlbGain = hasIpcClock
        ? Z.estimateAmdahlGain(avgActualCpi, sumModeledCpi, avgTierCpi.l2Itlb, 0.85, 'flush', 'assumes -85% L2 iTLB walks from 2 MiB PE pages')
        : { kind: 'qualitative', label: 'iTLB walks', detail: 'Actual CPI unavailable in TLB-Only preset (switch to Full for Amdahl IPC range)' };

      if (!largePageFailureTriggered) {
        const candMods = proc.modules
          .filter(m => !m.lp && !m.protectedDriver && m.sizeMiB >= 8.0)
          .sort((a, b) => b.sizeMiB - a.sizeMiB);
        if (!proc.ifeoEnabled && candMods.length >= 1 && (avgL2Itlb >= 0.35 || avgL1ItlbPct >= 1.5)) {
          const topList = candMods.slice(0, 4).map(m => `${m.name} (${m.sizeMiB.toFixed(0)}M)`).join(', ');
          pushFinding({
            id: 'pe_itlb_4k_modules',
            category: 'TlbTranslationBound',
            severity: avgL2Itlb >= 0.70 ? 'HI' : 'MD',
            scope: '[OS / TUI]',
            confidence: 'HIGH',
            impact: avgTierCpi.l2Itlb + 0.08,
            title: `PE code iTLB walks on 4 KiB modules (${candMods.length} DLLs >= 8 MiB)`,
            keyMetric: `L2 iTLB ${avgL2Itlb.toFixed(2)} | L1m ${avgL1ItlbPct.toFixed(2)}%`,
            estGain: itlbGain,
            why: `Rolling L2 iTLB walks are ${avgL2Itlb.toFixed(3)} MPKI (L1 iTLB miss ${avgL1ItlbPct.toFixed(2)}%) while IFEO UseLargePages is disabled and ${candMods.length} non-driver modules >= 8 MiB run on 4 KiB pages (${topList}).`,
            action: `Press Enter to open Tab 3 and toggle the top 2-5 largest executable DLLs plus master UseLargePages (U). Use -insecure / offline benchmarks only when anti-cheat is present.`,
            cascade: `Cuts L2 iTLB page walks by ~70-90% and lowers L1d/L2d/L3 cache pollution caused by hardware page-table walks.`,
            quickJumpTab: 3
          });
        } else if (avgL2Itlb < 0.35 && !groupA.jitResidualTriggered) {
          const lpCount = proc.modules.filter(m => m.lp).length;
          pushHealthy('L2 iTLB', `${avgL2Itlb.toFixed(2)} MPKI${lpCount > 0 ? ` (${lpCount} DLLs 2M)` : ''}`);
        }
      }
    } else if (hasTlb && avgL2Itlb < 0.35) {
      pushHealthy('L2 iTLB', `${avgL2Itlb.toFixed(2)} MPKI (L1m ${avgL1ItlbPct.toFixed(2)}%)`);
    }

    // --- RULE 2: Heap dTLB + Mimalloc Spillover (Tab 3 + Tab 4) ---
    if (proc) {
      const dtlbGain = (hasIpcClock && hasTlb)
        ? Z.estimateAmdahlGain(avgActualCpi, sumModeledCpi, avgTierCpi.l2Dtlb, 0.80, 'mlp', 'assumes -80% L2 dTLB walks from 2 MiB heap arenas')
        : { kind: 'qualitative', label: 'dTLB / faults', detail: 'Requires both cycles and dTLB PMCs for Amdahl IPC range' };

      if (proc.arenas) {
        const osArenaCnt = proc.arenas.osArenas.length;
        const totalHugeBlk = proc.arenas.hugeArenas.length * 32;
        const usedHugeBlk = proc.arenas.hugeArenas.reduce((a, g) => a + g.inuse.reduce((x, y) => x + y, 0), 0);
        const freeHugeBlk = Math.max(0, totalHugeBlk - usedHugeBlk);
        const freePct = totalHugeBlk > 0 ? (freeHugeBlk / totalHugeBlk) * 100.0 : 100.0;

        if (osArenaCnt > 0 || freePct < 10.0) {
          pushFinding({
            id: 'mimalloc_spillover',
            category: 'TlbTranslationBound',
            severity: osArenaCnt > 0 ? 'HI' : 'MD',
            scope: '[OS / TUI]',
            confidence: 'HIGH',
            impact: 0.14 + (hasTlb ? avgTierCpi.l2Dtlb : 0.03),
            title: osArenaCnt > 0
              ? `Mimalloc spilled into ${osArenaCnt} x 4 KiB OS arena${osArenaCnt > 1 ? 's' : ''}`
              : `Mimalloc 2 MiB huge-arena headroom low (${freePct.toFixed(1)}% free)`,
            keyMetric: `4K Arenas ${osArenaCnt} | Free ${freePct.toFixed(1)}%`,
            estGain: dtlbGain,
            why: `Mimalloc has ${osArenaCnt} dynamic 4 KiB OS arena(s) and ${freeHugeBlk}/${totalHugeBlk} free 32 MiB huge blocks (${freePct.toFixed(1)}% headroom) under ${proc.name}.`,
            action: `Raise MIMALLOC_RESERVE_HUGE_OS_PAGES by +1 to +2 GiB so peak allocations stay inside locked 2 MiB arenas without spilling to 4 KiB OS memory.`,
            cascade: `Cuts L2 dTLB page walks (${hasTlb ? avgL2Dtlb.toFixed(2) + ' MPKI' : 'TLB preset off'}) and eliminates soft page-fault churn on heap growth.`,
            quickJumpTab: 4
          });
        } else {
          pushHealthy('Mimalloc headroom', `${freePct.toFixed(0)}% free (0 x 4K)`);
        }
        if (hasTlb && avgL2Dtlb < 0.50) pushHealthy('L2 dTLB', `${avgL2Dtlb.toFixed(2)} MPKI`);
      } else if (hasTlb && proc.hugeMiB === 0 && avgL2Dtlb >= 0.50 && proc.wsMiB >= 512) {
        pushFinding({
          id: 'crt_heap_dtlb',
          category: 'TlbTranslationBound',
          severity: avgL2Dtlb >= 1.0 ? 'HI' : 'MD',
          scope: '[OS / TUI]',
          confidence: 'HIGH',
          impact: avgTierCpi.l2Dtlb + 0.04,
          title: `4 KiB heap exceeds Zen 2 L2 dTLB reach (${fmtMiB(proc.wsMiB)} WS)`,
          keyMetric: `L2 dTLB ${avgL2Dtlb.toFixed(2)} | Huge 0 B`,
          estGain: dtlbGain,
          why: `${proc.name} uses ${fmtMiB(proc.wsMiB)} Private WS with 0 B 2 MiB huge pages, driving ${avgL2Dtlb.toFixed(3)} MPKI L2 dTLB walks (Zen 2's 2,048-entry L2 dTLB covers only ~8 MiB of 4 KiB pages).`,
          action: `Switch heap to a 2 MiB large-page allocator (e.g. mimalloc with MIMALLOC_RESERVE_HUGE_OS_PAGES or VirtualAlloc MEM_LARGE_PAGES in custom code).`,
          cascade: `Cuts L2 dTLB walks, lowers Page Faults/s (${Math.round(avgPfRate).toLocaleString()}/s), and removes page-table entry (PTE) pollution from L1d/L2/L3.`,
          quickJumpTab: 4
        });
      } else if (hasTlb && avgL2Dtlb < 0.50) {
        pushHealthy('L2 dTLB', `${avgL2Dtlb.toFixed(2)} MPKI`);
      }
    } else if (hasTlb && avgL2Dtlb < 0.50) {
      pushHealthy('L2 dTLB', `${avgL2Dtlb.toFixed(2)} MPKI`);
    }

    // --- RULE 3: SMT Sibling Contention on Hot Core (Tab 1 / Global CCX Strip) ---
    let smtContendedHot = false;
    let hotCoreProof = '';
    if (hasIpcClock) {
      const physStats = CONFIG.physicalCores.map(pc => {
        const s0 = pc.siblings[0] !== undefined ? avgCoreC0[pc.siblings[0]] : 0;
        const s1 = pc.siblings[1] !== undefined ? avgCoreC0[pc.siblings[1]] : 0;
        return { id: pc.id, siblings: pc.siblings, s0, s1 };
      });
      const hotContended = physStats.filter(p => p.siblings.length >= 2 && (
        (p.s0 >= 70.0 && p.s1 >= 15.0) || (p.s1 >= 70.0 && p.s0 >= 15.0)
      ));
      const spareCores = physStats.filter(p => p.s0 < 20.0 && p.s1 < 20.0);
      const allSaturated = physStats.every(p => Math.max(p.s0, p.s1) > 85.0);

      if (hotContended.length > 0 && spareCores.length >= 1 && !allSaturated) {
        smtContendedHot = true;
        const c0Hot = hotContended[0];
        const spareIds = spareCores.map(c => `P${c.id}`).join(', ');
        hotCoreProof = `P${c0Hot.id} ${c0Hot.s0.toFixed(0)}% ⇄ ${c0Hot.s1.toFixed(0)}% (${spareIds} idle)`;
        pushFinding({
          id: 'smt_hot_contention',
          category: 'SmtContentionBound',
          severity: 'MD',
          scope: '[OS / TUI]',
          confidence: 'HIGH',
          impact: 0.11,
          title: `SMT sibling contention on hot core P${c0Hot.id} while ${spareIds} sit idle`,
          keyMetric: `P${c0Hot.id} ${Math.round(c0Hot.s0)}% ⇄ ${Math.round(c0Hot.s1)}%`,
          estGain: {
            kind: 'qualitative',
            label: '1% lows / MLP',
            detail: 'Qualitative: restores full ROB (224) & Store Queue to hot thread (never fabricates exact % from CPI stack)'
          },
          why: `Physical core P${c0Hot.id} (CPUs ${c0Hot.siblings.join('/')}) runs both SMT siblings (${c0Hot.s0.toFixed(0)}% and ${c0Hot.s1.toFixed(0)}% C0) while ${spareCores.length} spare physical core(s) (${spareIds}) remain <20% active.`,
          action: `Remove CPU ${c0Hot.siblings[1]} from worker-thread affinity and verify main + render threads are not pinned to sibling logical IDs of the same physical core.`,
          cascade: `Restores 100% of Zen 2 ROB (224 entries) and Store Queue to the hot thread -> boosts OoO/MLP overlap on DRAM misses and eliminates L1/L2/TLB sibling eviction.`,
          quickJumpTab: 1,
          openCcx: true
        });
      } else {
        pushHealthy('SMT siblings', allSaturated ? 'all 6 cores >85% saturated' : 'no hot-core contention');
      }
    }

    // --- RULE 4: Cross-CCX Thread Spread ---
    let crossCcxActive = false;
    if (hasCacheCore && hasL3) {
      const ccx0Active = CONFIG.physicalCores.filter(p => p.ccx === 0).flatMap(p => p.siblings).filter(id => avgCoreC0[id] >= 15.0);
      const ccx1Active = CONFIG.physicalCores.filter(p => p.ccx === 1).flatMap(p => p.siblings).filter(id => avgCoreC0[id] >= 15.0);
      const totalActiveThreads = ccx0Active.length + ccx1Active.length;
      const latDiffRatio = Math.abs(avgCcxLat[0] - avgCcxLat[1]) / Math.max(1.0, Math.min(avgCcxLat[0], avgCcxLat[1]));

      if (ccx0Active.length > 0 && ccx1Active.length > 0 && totalActiveThreads <= 6 && (avgL3HitPct < 80.0 || latDiffRatio >= 0.10)) {
        crossCcxActive = true;
        pushFinding({
          id: 'cross_ccx_spread',
          category: 'L3CapacityOrCrossCcx',
          severity: avgL3HitPct < 75.0 ? 'HI' : 'MD',
          scope: '[OS / TUI]',
          confidence: 'MED',
          impact: 0.12,
          title: `Cross-CCX thread spread (${totalActiveThreads} active threads <= 6, L3 Hit ${avgL3HitPct.toFixed(1)}%)`,
          keyMetric: `CCX0 ${ccx0Active.length}T + CCX1 ${ccx1Active.length}T | L3 ${avgL3HitPct.toFixed(1)}%`,
          estGain: {
            kind: 'qualitative',
            label: 'L3 lat + 1% lows',
            detail: 'Qualitative: cuts Infinity Fabric cross-CCX snoops (validate exact IPC delta against a saved baseline)'
          },
          why: `Only ${totalActiveThreads} logical threads are >=15% active (fits inside one 6-thread Zen 2 CCX), yet threads span both CCX0 and CCX1 with L3 Hit ${avgL3HitPct.toFixed(1)}% (CCX0 ${avgCcxLat[0].toFixed(0)}ns vs CCX1 ${avgCcxLat[1].toFixed(0)}ns).`,
          action: `Test pinning ${proc ? proc.name : 'latency-critical threads'} to a single CCX affinity mask (0x003F for CCX0 or 0x0FC0 for CCX1) and validate against a saved baseline (b).`,
          cascade: `Cuts Infinity Fabric cross-CCX snoops/probes -> lowers both unified L3 Miss MPKI (${avgL3Miss.toFixed(2)}) and measured L3 miss latency (${avgL3LatNs.toFixed(1)} ns).`,
          quickJumpTab: 1,
          openCcx: true
        });
      } else {
        pushHealthy('CCX locality', `${totalActiveThreads}T active │ L3 Hit ${avgL3HitPct.toFixed(1)}%`);
      }
    }

    // --- RULE 5: Loaded DRAM Queueing Inflation vs. Calibrated Baseline ---
    let dramQueueing = false;
    if (hasCacheCore && hasL3) {
      const expectedUnloadedNs = CONFIG.calibrated
        ? Math.max(25.0, (CONFIG.latencies.dramFallback - CONFIG.latencies.l3Hit) / Math.max(0.5, avgGhz))
        : null;
      const latTriggerNs = expectedUnloadedNs !== null ? expectedUnloadedNs * 1.25 : 70.0;
      const hwpfTotalDram = hasFull ? (avgHwpfDram + avgL2pfDram) : 0;

      if (avgL3LatNs >= latTriggerNs && (avgDram >= 3.0 || hwpfTotalDram >= 1.5)) {
        dramQueueing = true;
        const refText = expectedUnloadedNs !== null
          ? `expected unloaded ${expectedUnloadedNs.toFixed(1)} ns (x1.25 = ${latTriggerNs.toFixed(1)} ns)`
          : `uncalibrated 70.0 ns threshold`;
        pushFinding({
          id: 'dram_queueing_inflation',
          category: 'MemoryBandwidthQueueing',
          severity: 'HI',
          scope: '[HW / BIOS]',
          confidence: CONFIG.calibrated ? 'HIGH' : 'MED',
          impact: avgTierCpi.dram,
          title: `Loaded DRAM queueing latency inflation (${avgL3LatNs.toFixed(1)} ns)`,
          keyMetric: `${avgL3LatNs.toFixed(1)} ns | DRAM ${avgDram.toFixed(2)} MPKI`,
          estGain: Z.estimateAmdahlGain(avgActualCpi, sumModeledCpi, avgTierCpi.dram, 0.15, 'mlp', 'illustrative -15% DRAM latency/queueing from tighter DDR4 timings/FCLK'),
          why: `Measured L3 miss latency averaged ${avgL3LatNs.toFixed(1)} ns (${avgL3LatCyc.toFixed(0)} cyc) vs ${refText}, alongside heavy DRAM traffic (${avgDram.toFixed(2)} MPKI, HWPF ${hwpfTotalDram.toFixed(2)} MPKI).`,
          action: `[HW / BIOS] Tighten DDR4 secondary timings (tRFC, tFAW, tRRDS/tRRDL, tREFI) or raise FCLK/UCLK; [Code] shrink streaming struct footprints to cut memory controller queueing.`,
          cascade: `Drops loaded L3-miss latency in ns and increases effective IPC during heavy memory bursts.`,
          quickJumpTab: 2
        });
      } else {
        pushHealthy('DRAM queueing', `${avgL3LatNs.toFixed(1)} ns (< ${latTriggerNs.toFixed(0)} ns)`);
      }

      if (!CONFIG.calibrated) {
        pushFinding({
          id: 'calibrate_unloaded_tip',
          category: 'Meta',
          severity: 'LO',
          scope: '[OS / TUI]',
          confidence: 'HIGH',
          impact: 0.01,
          title: `Host cache/DRAM latencies uncalibrated (using Zen 2 defaults)`,
          keyMetric: `DRAM fallback ${CONFIG.latencies.dramFallback.toFixed(0)} cyc`,
          estGain: {
            kind: 'qualitative',
            label: 'CPI accuracy',
            detail: 'Qualitative: calibrates host L1/L2/L3/DRAM unloaded latencies for sharper queueing detection'
          },
          why: `config.toml has not been calibrated on this host yet, so Rule 5 uses a generic 70 ns threshold instead of your exact unloaded (DRAM - L3) latency delta.`,
          action: `Press b -> C (or run "zen2top --calibrate") to execute the ~1s pointer-chasing + branch probe and persist exact host latencies to config.toml.`,
          cascade: `Sharpens Exclusive CPI Stack accuracy and unlocks exact loaded vs. unloaded DRAM queueing diagnostics.`,
          quickJumpTab: 2
        });
      }
    }

    // --- RULE 6: Demand DRAM Pointer-Chasing ---
    let demandDramChase = false;
    const demShare = avgDemDram / Math.max(0.01, avgDemDram + avgHwpfDram);
    if (hasFull && avgDemDram >= 1.5 && demShare >= 0.65) {
      demandDramChase = true;
      pushFinding({
        id: 'demand_dram_pointer_chase',
        category: 'MemoryLatencyBound',
        severity: avgDemDram >= 2.2 ? 'HI' : 'MD',
        scope: '[Code / Build]',
        confidence: 'HIGH',
        impact: (avgDemDram * avgL3LatCyc) / 1000.0,
        title: `Demand DRAM pointer-chasing (${(demShare * 100).toFixed(0)}% unprefetched)`,
        keyMetric: `Dem DRAM ${avgDemDram.toFixed(2)} (${(demShare * 100).toFixed(0)}%)`,
        estGain: Z.estimateAmdahlGain(avgActualCpi, sumModeledCpi, avgTierCpi.dram, 0.50, 'mlp', 'illustrative -50% DRAM misses from AoS->SoA / locality refactor'),
        why: `Demand D-Cache DRAM fills average ${avgDemDram.toFixed(2)} MPKI and make up ${(demShare * 100).toFixed(1)}% of all D-Cache DRAM fills, meaning indirect/random accesses defeat Zen 2's stride prefetcher.`,
        action: `Pack hot fields into 64B cache lines, convert AoS -> SoA, and allocate objects in contiguous arenas/pools. On closed-source binaries, no OS tweak fixes pointer chasing (only lower RAM latency or larger L3 helps).`,
        cascade: `Improves L1/L2 stride prefetcher hit rate and cuts both Demand DRAM stalls and ROB fill stalls.`,
        quickJumpTab: 2
      });
    }

    // --- RULE 7: Kernel / Page-Fault Churn ---
    if (proc) {
      if (avgPfRate >= 2000 && sysSharePct >= 20.0) {
        pushFinding({
          id: 'kernel_page_fault_churn',
          category: 'OsKernelChurn',
          severity: avgPfRate >= 3500 ? 'HI' : 'MD',
          scope: '[OS / TUI]',
          confidence: 'HIGH',
          impact: 0.15,
          title: `High kernel / page-fault commit churn (${Math.round(avgPfRate).toLocaleString()}/s)`,
          keyMetric: `${Math.round(avgPfRate).toLocaleString()}/s | sys ${sysSharePct.toFixed(0)}%`,
          estGain: {
            kind: 'qualitative',
            label: '-sys% / stutter',
            detail: 'Qualitative: cuts ntoskrnl VirtualAlloc traps, kernel sys% time, and frame-time spikes'
          },
          why: `${proc.name} averages ${Math.round(avgPfRate).toLocaleString()} page faults/s with kernel time at ${sysSharePct.toFixed(1)}% of CPU execution (usr ${avgUsr.toFixed(1)}% / sys ${avgSys.toFixed(1)}%).`,
          action: proc.arenas
            ? `Raise MIMALLOC_PURGE_DELAY (or MIMALLOC_PURGE_DECOMMITS=0) and pre-reserve 2 MiB huge arenas so VirtualAlloc commit/decommit cycles stop trapping into ntoskrnl.`
            : `Pool and reuse large heap buffers instead of repeatedly allocating/freeing virtual ranges (or test a pooling allocator like mimalloc).`,
          cascade: `Drops kernel sys% CPU overhead, removes TLB shootdowns, and eliminates frame-time / build-step latency spikes.`,
          quickJumpTab: 4
        });
      } else {
        pushHealthy('Page faults', `${Math.round(avgPfRate).toLocaleString()}/s (sys ${sysSharePct.toFixed(0)}%)`);
      }
    }

    // --- RULE 8: Branch Mispredictions ---
    let branchBound = false;
    if (hasFull) {
      if (avgBranch >= 5.0 && avgBranchPct >= 3.5) {
        branchBound = true;
        pushFinding({
          id: 'branch_mispredict_bound',
          category: 'BranchMispredictBound',
          severity: avgBranch >= 7.0 ? 'HI' : 'MD',
          scope: '[Code / Build]',
          confidence: 'HIGH',
          impact: avgTierCpi.branch,
          title: `Unpredictable branch mispredictions (${avgBranch.toFixed(2)} MPKI)`,
          keyMetric: `${avgBranch.toFixed(2)} MPKI | ${avgBranchPct.toFixed(2)}% miss`,
          estGain: Z.estimateAmdahlGain(avgActualCpi, sumModeledCpi, avgTierCpi.branch, 0.35, 'flush', 'illustrative -35% branch mispredicts via PGO / branchless paths'),
          why: `Rolling branch mispredicts average ${avgBranch.toFixed(2)} MPKI (${avgBranchPct.toFixed(2)}% miss rate), causing ~16-19 cyc pipeline flushes (~${avgTierCpi.branch.toFixed(2)} CPI) that OoO execution cannot hide.`,
          action: `Apply PGO, branchless cmov/SIMD masks, or predicate sorting in source builds. No Windows or BIOS tweak fixes branch mispredictions on closed-source binaries.`,
          cascade: `Eliminates front-end flush bubbles and reduces speculative garbage fetches polluting L1i/L1d caches.`,
          quickJumpTab: 1
        });
      } else {
        pushHealthy('Branch prediction', `${avgBranch.toFixed(2)} MPKI (${avgBranchPct.toFixed(2)}%)`);
      }
    }

    // --- RULE 9: L1/L2 I-Cache Capacity Pressure (true l2_ic_miss 0x430164, NOT l2icExcl) ---
    let icacheBound = false;
    if (hasCacheCore) {
      if (avgL2IcMiss >= 2.5 || (hasFull && avgL1Ic >= 15.0)) {
        icacheBound = true;
        pushFinding({
          id: 'icache_capacity_pressure',
          category: 'FrontendCodeBound',
          severity: avgL2IcMiss >= 3.5 ? 'HI' : 'MD',
          scope: '[Code / Build]',
          confidence: 'HIGH',
          impact: (avgL2IcMiss * CONFIG.latencies.l3Hit) / 1000.0 + avgTierCpi.l2Ic,
          title: `L1/L2 instruction-cache capacity pressure`,
          keyMetric: `L2i miss ${avgL2IcMiss.toFixed(2)}${hasFull ? ' | L1i ' + avgL1Ic.toFixed(1) : ''} MPKI`,
          estGain: Z.estimateAmdahlGain(avgActualCpi, sumModeledCpi, avgTierCpi.l2Ic, 0.35, 'flush', 'illustrative -35% L2i misses via PGO + BOLT hot/cold splitting'),
          why: `True L2->L3 I-Cache misses (0x430164) average ${avgL2IcMiss.toFixed(2)} MPKI${hasFull ? ` (L1i miss ${avgL1Ic.toFixed(1)} MPKI)` : ''}, showing hot code exceeds Zen 2's 32 KiB L1i / 512 KiB L2 / 4K uop cache.`,
          action: `Rebuild with PGO + BOLT hot/cold function splitting and -O2 on cold paths. Note: 2 MiB PE large pages fix iTLB walks, NOT I-Cache capacity (though isolating SMT siblings helps L1i retention).`,
          cascade: `Reduces front-end fetch starvation and frees unified L2/L3 bandwidth for data loads.`,
          quickJumpTab: 2
        });
      } else {
        pushHealthy('L2 I-Cache miss', `${avgL2IcMiss.toFixed(2)} MPKI${hasFull ? ` (L1i ${avgL1Ic.toFixed(1)})` : ''}`);
      }
    }

    // --- RULE 10: Clock / Boost Throttling ---
    if (hasIpcClock) {
      const baseGhz = CONFIG.baseMhz / 1000.0;
      if (avgGhz < baseGhz * 0.98 && avgC0 >= 25.0) {
        const clkGainPct = Math.max(0.0, ((baseGhz / Math.max(0.1, avgGhz)) - 1.0) * 100.0);
        pushFinding({
          id: 'clock_throttling',
          category: 'ClockThrottling',
          severity: 'HI',
          scope: '[HW / OS]',
          confidence: 'HIGH',
          impact: 0.25,
          title: `Effective clock throttling below nominal base (${avgGhz.toFixed(2)} GHz)`,
          keyMetric: `${avgGhz.toFixed(2)} vs ${baseGhz.toFixed(2)} GHz base`,
          estGain: {
            kind: 'clock',
            pct: clkGainPct,
            detail: `+${clkGainPct.toFixed(1)}% throughput (direct linear clock recovery from ${avgGhz.toFixed(2)} to ${baseGhz.toFixed(2)} GHz nominal base; not CPI stack)`
          },
          why: `Effective clock averaged ${avgGhz.toFixed(2)} GHz (<98% of ${baseGhz.toFixed(2)} GHz nominal P0 base) while active C0 occupancy averaged ${avgC0.toFixed(1)}%.`,
          action: `Inspect CPU cooler mounting/thermals, PPT/TDC/EDC PBO limits in BIOS, and ensure Windows Power Plan is set to Balanced or High Performance (not Power Saver).`,
          cascade: `Restores boost frequency linearly -> cuts wall-clock nanoseconds per cycle across compute, L1/L2/L3 hits, and branch recovery.`,
          quickJumpTab: 1
        });
      } else {
        pushHealthy('Boost clock', `${avgGhz.toFixed(2)} GHz (base ${baseGhz.toFixed(2)})`);
      }
    }

    // --- RULE 11: Measurement Hygiene ---
    if (base) {
      const baseMux = base.muxPreset || 'full';
      if (baseMux !== muxId) {
        pushFinding({
          id: 'hygiene_mux_mismatch',
          category: 'Meta',
          severity: 'HI',
          scope: '[OS / TUI]',
          confidence: 'HIGH',
          impact: 0.99,
          title: `MUX DIFF: Baseline (${baseMux}) != active preset (${muxId})`,
          keyMetric: `${baseMux} vs ${muxId}`,
          estGain: {
            kind: 'qualitative',
            label: 'A/B accuracy',
            detail: 'Qualitative: removes cross-mux measurement skew from baseline delta columns'
          },
          why: `Active baseline "${base.name}" was captured in "${baseMux}" mode, whereas live telemetry is running in "${mux.label}". Cross-mux comparisons introduce multiplexing bias.`,
          action: `Press 'm' to match the baseline's Mux preset, or press 'b' -> S to recapture a baseline under "${mux.label}".`,
          cascade: `Eliminates multiplexing skew from % vs Base delta columns across Tabs 1-3.`,
          quickJumpTab: 1
        });
      } else if (muxId === 'full' && base.ipc > 0) {
        const deltaIpcPct = Math.abs(((avgIpc - base.ipc) / base.ipc) * 100.0);
        if (deltaIpcPct < 3.0) {
          pushFinding({
            id: 'hygiene_small_delta_3mux',
            category: 'Meta',
            severity: 'LO',
            scope: '[OS / TUI]',
            confidence: 'HIGH',
            impact: 0.02,
            title: `Small IPC delta (${deltaIpcPct.toFixed(1)}%) measured in ${mux.label}`,
            keyMetric: `|dIPC| ${deltaIpcPct.toFixed(1)}% in ${mux.label}`,
            estGain: {
              kind: 'qualitative',
              label: 'A/B accuracy',
              detail: 'Qualitative: eliminates hardware PMC time-slice multiplexing variance for sub-3% A/B tuning'
            },
            why: `IPC delta vs "${base.name}" is only ${deltaIpcPct.toFixed(1)}% (<3%), close to Zen 2 multi-group hardware PMC multiplexing variance.`,
            action: `Press 'm' to switch to a 0-Mux preset (IPC+Cache/DRAM, TLB-Only, or Micro-Arch) and re-capture a baseline for lab-grade A/B confirmation.`,
            cascade: `Removes PMC time-slice sampling jitter for sub-3% tuning validation.`,
            quickJumpTab: 1
          });
        } else {
          pushHealthy('Baseline hygiene', `${mux.label} match`);
        }
      } else {
        pushHealthy('Baseline hygiene', `${mux.label} match`);
      }
    }


    return {
      smtContendedHot, hotCoreProof, crossCcxActive, dramQueueing,
      demandDramChase, demShare, branchBound, icacheBound
    };
  }

  function evaluateMicroArchRules(ctx) {
    const { hasUarch, muxId, avgActualCpi, avgL3LatNs, pushFinding, pushHealthy } = ctx;

    // --- MICRO-ARCH / CONTENTION RULES (Evaluated ONLY when Micro-Arch 0-Mux is active) ---
    let uarchMetrics = null;
    let crossCcxBouncing = false;
    let lockContention = false;
    let opcacheThrash = false;
    let stlfBound = false;
    let splitsBound = false;

    if (hasUarch) {
      const cumUarchRaw = {
        inst: state.cum.instRaw,
        dc_cross_ccx: state.cum.dcCrossCcxRaw,
        locks_serial: state.cum.locksSerialRaw,
        dec_uops: state.cum.decUopsRaw,
        oc_uops: state.cum.ocUopsRaw,
        stlf_interlock: state.cum.stlfInterlockRaw,
        misal_access: state.cum.misalAccessRaw
      };
      uarchMetrics = computeMicroArchMetrics(cumUarchRaw, muxId);

      if (uarchMetrics) {
        const crossCcxMpki = uarchMetrics.dcCrossCcxMpki;
        const locksMpki = uarchMetrics.locksSerialMpki;
        const ocHitPct = uarchMetrics.opcacheHitPct;
        const legacyPct = uarchMetrics.legacyDecodePct;
        const stlfMpki = uarchMetrics.stlfInterlockMpki;
        const misalMpki = uarchMetrics.misalAccessMpki;
        const totalDisUops = state.cum.ocUopsRaw + state.cum.decUopsRaw;

        const crossCcxCpi = (crossCcxMpki / 1000.0) * 90.0; // ~80-100 cyc IF probe latency
        const stlfCpi = (stlfMpki / 1000.0) * 12.5;         // ~10-15 cyc STLF load replay penalty
        const uarchModeledRef = Math.max(avgActualCpi, crossCcxCpi + stlfCpi);

        // Rule 12: Cross-CCX Cache Bouncing (0x430443)
        if (crossCcxMpki >= 0.8) {
          crossCcxBouncing = true;
          const isHi = crossCcxMpki >= 2.0;
          const crossCcxGain = (avgActualCpi > 0.05 && avgActualCpi < 10.0 && isFinite(avgActualCpi))
            ? Z.estimateAmdahlGain(avgActualCpi, uarchModeledRef, crossCcxCpi, 0.70, 'mlp', 'assumes -70% cross-CCX fills (~90 cyc IF probe) via single-CCX pinning / 64B padding')
            : { kind: 'qualitative', label: 'L3 lat + IPC', detail: 'Qualitative: cuts Infinity Fabric cross-CCX coherence probes and improves IPC on both CCXs' };
          pushFinding({
            id: 'cross_ccx_cache_bouncing',
            category: 'MicroArchContention',
            severity: isHi ? 'HI' : 'MD',
            scope: '[OS / Code]',
            confidence: 'HIGH',
            impact: crossCcxCpi + (isHi ? 0.12 : 0.04),
            title: `Cross-CCX cache-line bouncing across Infinity Fabric (${crossCcxMpki.toFixed(2)} MPKI)`,
            keyMetric: `Cross-CCX ${crossCcxMpki.toFixed(2)} MPKI | L3 ${avgL3LatNs.toFixed(1)} ns`,
            estGain: crossCcxGain,
            why: `Direct hardware proof (ls_dmnd_fills_from_sys.ext_cache_local 0x430443): ${crossCcxMpki.toFixed(2)} MPKI demand D-Cache fills are serviced from the other CCX's cache over Infinity Fabric (~80-100 cyc probe latency), far stronger than inferring from L3 hit rate.`,
            action: `Pin communicating threads to a single CCX (affinity mask 0x003F for CCX0 or 0x0FC0 for CCX1). In owned code, pad hot shared structs/atomics to 64 bytes (#[repr(align(64))] / alignas(64)) to eliminate false sharing.`,
            cascade: `Cuts Infinity Fabric coherence probes, lowers measured L3 miss latency (${avgL3LatNs.toFixed(1)} ns), and raises IPC on both CCXs.`,
            quickJumpTab: 1,
            openCcx: true
          });
        } else {
          pushHealthy('Cross-CCX fills', `${crossCcxMpki.toFixed(2)} MPKI`);
        }

        // Rule 13: Serialized Lock Contention (0x430325)
        if ((locksMpki >= 0.5 && crossCcxMpki >= 0.5) || locksMpki >= 1.0) {
          lockContention = true;
          const isHi = locksMpki >= 0.5 && crossCcxMpki >= 0.5;
          pushFinding({
            id: 'serialized_lock_contention',
            category: 'MicroArchContention',
            severity: isHi ? 'HI' : 'MD',
            scope: '[Code / Build]',
            confidence: 'HIGH',
            impact: (locksMpki * 60.0) / 1000.0 + (isHi ? 0.14 : 0.05),
            title: `Serialized LOCK / spinlock contention (${locksMpki.toFixed(2)} MPKI)`,
            keyMetric: `Locks ${locksMpki.toFixed(2)} | CCX ${crossCcxMpki.toFixed(2)} MPKI`,
            estGain: {
              kind: 'qualitative',
              label: 'IPC / scaling',
              detail: 'Qualitative: removes pipeline-serializing non-speculative LOCK stalls and cross-CCX lock bounces'
            },
            why: `ls_locks.bus_lock|non_spec_lock (0x430325) averages ${locksMpki.toFixed(2)} MPKI${isHi ? ` alongside ${crossCcxMpki.toFixed(2)} MPKI cross-CCX fills` : ''}, proving user-mode atomics or spinlocks are failing fast cacheable speculation and serializing the core (invisible to Windows context-switch counters).`,
            action: `Use thread-local sharding (TLS counters), batch atomic updates, or add exponential backoff on spinloops. On closed binaries, pinning contended threads to one CCX (0x003F / 0x0FC0) still reduces per-lock coherence cost.`,
            cascade: `Drops dc_cross_ccx coherence traffic and frees Load/Store Queue slots for surrounding instructions.`,
            quickJumpTab: 1,
            openCcx: isHi
          });
        } else {
          pushHealthy('Serialized locks', `${locksMpki.toFixed(2)} MPKI`);
        }

        // Rule 14: Op-Cache Thrashing / Legacy 4-Wide Decode Fallback (0x4301AA vs 0x4302AA)
        if (totalDisUops > 0 && legacyPct >= 30.0) {
          opcacheThrash = true;
          pushFinding({
            id: 'opcache_thrashing',
            category: 'FrontendCodeBound',
            severity: 'MD',
            scope: '[Code / Build]',
            confidence: 'HIGH',
            impact: (legacyPct / 100.0) * 0.22,
            title: `Op-Cache thrashing: ${legacyPct.toFixed(1)}% ops on 4-wide legacy decoder`,
            keyMetric: `Legacy ${legacyPct.toFixed(1)}% | Op-Cache ${ocHitPct.toFixed(1)}%`,
            estGain: {
              kind: 'qualitative',
              label: 'FE dispatch width',
              detail: 'Qualitative: restores Zen 2 8-wide 4K-entry Op-Cache dispatch via PGO + llvm-bolt layout'
            },
            why: `de_dis_uops_from_decoder (0x4301AA vs 0x4302AA) shows ${legacyPct.toFixed(1)}% of dispatched ops falling back to the 4-wide legacy x86 decoder (Op-Cache hit ${ocHitPct.toFixed(1)}% <= 70%), proving hot instruction streams overflow Zen 2's 4K-entry 8-wide Op-Cache.`,
            action: `Strongest hardware proof that PGO + llvm-bolt hot/cold code layout or loop alignment will unlock front-end throughput (even if L1i miss MPKI looks moderate). No Windows or OS tweak fixes this on closed-source binaries.`,
            cascade: `Increases front-end dispatch width (4-wide -> 8-wide Op-Cache) and lowers L1i/L2i fetch stalls.`,
            quickJumpTab: 1
          });
        } else if (totalDisUops > 0) {
          pushHealthy('Op-Cache hit', `${ocHitPct.toFixed(1)}% (legacy ${legacyPct.toFixed(1)}%)`);
        }

        // Rule 15: Store-to-Load Forwarding Interlocks (0x430224)
        if (stlfMpki >= 3.0) {
          stlfBound = true;
          const stlfGain = (avgActualCpi > 0.05 && avgActualCpi < 10.0 && isFinite(avgActualCpi))
            ? Z.estimateAmdahlGain(avgActualCpi, uarchModeledRef, stlfCpi, 0.60, 'mlp', 'assumes -60% STLF load replays (~12.5 cyc) via matched store/load widths')
            : { kind: 'qualitative', label: 'LSQ / replays', detail: 'Qualitative: eliminates ~10-15 cyc store-to-load forwarding replay stalls' };
          pushFinding({
            id: 'stlf_interlocks',
            category: 'MicroArchContention',
            severity: 'MD',
            scope: '[Code / Build]',
            confidence: 'HIGH',
            impact: stlfCpi + 0.03,
            title: `Store-to-load forwarding (STLF) interlock stalls (${stlfMpki.toFixed(2)} MPKI)`,
            keyMetric: `STLF ${stlfMpki.toFixed(2)} MPKI`,
            estGain: stlfGain,
            why: `Hardware-exact proof (ls_bad_status2.stli_other 0x430224): ${stlfMpki.toFixed(2)} MPKI loads stalled because an older overlapping store could not forward (e.g., narrow scalar writes followed immediately by a wider struct or AVX2 load).`,
            action: `Match store and load widths and alignment on hot data structures, and assemble SIMD vectors in registers (shuffles/blends) before storing to memory.`,
            cascade: `Eliminates ~10-15 cyc load replays and relieves Load/Store Queue pressure.`,
            quickJumpTab: 1
          });
        } else {
          pushHealthy('STLF interlocks', `${stlfMpki.toFixed(2)} MPKI`);
        }

        // Rule 16: 64-Byte Cache-Line Splits / Misaligned Accesses (0x430047)
        if (misalMpki >= 10.0) {
          splitsBound = true;
          const isMd = misalMpki >= 20.0;
          pushFinding({
            id: 'cache_line_splits',
            category: 'MicroArchContention',
            severity: isMd ? 'MD' : 'LO',
            scope: '[Code / Build]',
            confidence: 'HIGH',
            impact: (misalMpki / 1000.0) * 3.0 + (isMd ? 0.02 : 0.0),
            title: `64-byte cache-line split / misaligned accesses (${misalMpki.toFixed(1)} MPKI)`,
            keyMetric: `Splits ${misalMpki.toFixed(1)} MPKI`,
            estGain: {
              kind: 'qualitative',
              label: 'L1d ports / LSQ',
              detail: 'Qualitative: halves split cache lookups and relieves L1d port + LSQ contention'
            },
            why: `ls_misal_accesses (0x430047) averages ${misalMpki.toFixed(2)} MPKI loads/stores straddling 64-byte cache-line boundaries, doubling L1d tag lookups and consuming extra Load/Store Queue slots.`,
            action: `Enforce 32B/64B alignment on hot structs and SIMD buffers (#[repr(align(64))] / alignas(64) / aligned allocators).`,
            cascade: `Reduces L1d port contention and L1d miss amplification.`,
            quickJumpTab: 1
          });
        } else {
          pushHealthy('Cache-line splits', `${misalMpki.toFixed(1)} MPKI`);
        }
      }
    }


    return {
      uarchMetrics, crossCcxBouncing, lockContention, opcacheThrash, stlfBound, splitsBound
    };
  }

  Object.assign(Z, { evaluatePmuRules, evaluateMicroArchRules });
})();
