// Deterministic pack-driven evidence-gated diagnostic engine (Tab 5 Advisor)
(() => {
  'use strict';
  const Z = window.Zen2Top || (window.Zen2Top = {});
  const {
    CONFIG, MetricPack, state, getActivePlan, resolvePlanFromLegacyOrPacks, buildNoPmuPlan,
    getAttachedProcess, fmtRate, evaluateGroupARules, evaluatePmuRules, evaluateMicroArchRules
  } = Z;

  // =========================================================================
  // 5B. DETERMINISTIC EVIDENCE-GATED DIAGNOSTIC ENGINE (Tab 5 Advisor)
  // =========================================================================
  const VERDICT_LABELS = {
    GpuBound: 'GPU-BOUND (CPU Headroom Available)',
    MemoryLatencyBound: 'MEMORY LATENCY BOUND',
    MemoryBandwidthQueueing: 'MEMORY BANDWIDTH / QUEUEING',
    L3CapacityOrCrossCcx: 'L3 CAPACITY / CROSS-CCX',
    MicroArchContention: 'MICRO-ARCH / CONTENTION BOUND',
    FrontendCodeBound: 'FRONTEND CODE BOUND',
    BranchMispredictBound: 'BRANCH MISPREDICT BOUND',
    TlbTranslationBound: 'TLB TRANSLATION BOUND',
    SmtContentionBound: 'SMT CONTENTION BOUND',
    CoreExecutionBound: 'CORE EXECUTION BOUND',
    Win32OnlyClear: 'WIN32 OS DIAGNOSTICS CLEAR (NO-PMU)',
    InsufficientData: 'INSUFFICIENT DATA'
  };

  function estimateAmdahlGain(actualCpi, modeledCpi, tierCpi, reductionFrac, stallKind, assumptionText) {
    if (actualCpi <= 0.001 || tierCpi <= 0.0001 || reductionFrac <= 0) {
      return {
        kind: 'numeric', lowPct: 0.0, highPct: 0.0, visRatio: 1.0,
        detail: `<0.5% IPC (${assumptionText}; negligible stall tier)`
      };
    }
    const visRatio = Math.min(1.0, Math.max(0.25, actualCpi / Math.max(0.001, modeledCpi)));
    const deltaRaw = tierCpi * reductionFrac;
    const deltaLow = stallKind === 'flush'
      ? deltaRaw * Math.min(0.90, visRatio)
      : deltaRaw * Math.min(0.75, visRatio * 0.80);
    const deltaHigh = deltaRaw;

    // Clamp at Zen 2 practical 0.25 CPI floor (4.0 IPC)
    const newCpiLowGain = Math.max(0.25, actualCpi - deltaLow);
    const newCpiHighGain = Math.max(0.25, actualCpi - deltaHigh);

    const lowPct = Math.max(0.0, ((actualCpi / newCpiLowGain) - 1.0) * 100.0);
    const highPct = Math.max(lowPct, ((actualCpi / newCpiHighGain) - 1.0) * 100.0);
    const visPct = Math.round(visRatio * 100);

    const detail = highPct < 0.5
      ? `<0.5% IPC (${assumptionText} on ${actualCpi.toFixed(2)} CPI; ${visPct}% visible overlap)`
      : `+${lowPct.toFixed(1)}% to +${highPct.toFixed(1)}% IPC (${assumptionText} on ${actualCpi.toFixed(2)} CPI; ${visPct}% visible overlap)`;

    return { kind: 'numeric', lowPct, highPct, visRatio, detail };
  }

  function formatEstGainCell(est) {
    if (!est) return `<span class="c-muted">--</span>`;
    if (est.kind === 'qualitative') return `<span class="c-dim">${est.label}</span>`;
    if (est.kind === 'clock') {
      if (est.pct < 0.5) return `<span class="c-muted">&lt;0.5%</span>`;
      const cls = est.pct >= 8.0 ? 'c-green c-bright' : (est.pct >= 2.0 ? 'c-green' : '');
      return `<span class="${cls}">+${est.pct.toFixed(1)}% clk</span>`;
    }
    if (est.highPct < 0.5) return `<span class="c-muted">&lt;0.5%</span>`;
    const fmtB = v => (v >= 10.0 ? Math.round(v).toString() : v.toFixed(1));
    const lo = fmtB(est.lowPct);
    const hi = fmtB(est.highPct);
    const txt = lo === hi ? `+${hi}%` : `+${lo}-${hi}%`;
    const cls = est.highPct >= 10.0 ? 'c-green c-bright' : (est.highPct >= 2.0 ? 'c-green' : '');
    return `<span class="${cls}">${txt}</span>`;
  }

  function evaluateDiagnostics(testOverride = null) {
    const ov = testOverride || null;
    const n = (ov && ov.samples !== undefined) ? ov.samples : state.cum.samples;
    const minSamples = CONFIG.advisor.minSamples;

    let plan;
    if (ov && (ov.noPmu || ov.muxId === 'no-pmu')) {
      plan = buildNoPmuPlan();
    } else if (ov && ov.packs) {
      plan = resolvePlanFromLegacyOrPacks(ov.packs);
    } else if (ov && ov.muxId) {
      plan = resolvePlanFromLegacyOrPacks(ov.muxId);
    } else {
      plan = getActivePlan();
    }

    const proc = (ov && ('proc' in ov)) ? ov.proc : getAttachedProcess();
    const base = (ov && ('base' in ov)) ? ov.base : state.activeBaseline;

    const avg = k => {
      if (ov && ov.avg && (k in ov.avg)) return ov.avg[k];
      return n > 0 ? (state.cum[k] || 0) / n : 0;
    };
    const avgC0 = avg('avgC0Pct');
    const avgInst = avg('instPerSec');
    const avgIpc = avg('ipc');
    const avgActualCpi = avg('actualCpi');
    const avgModeledCpi = avg('modeledCpi');
    const avgOooCpi = avg('oooHiddenCpi');
    const avgRetPct = avg('retiringPct');
    const avgGhz = avg('effGhz');
    const oooPct = avgModeledCpi > 0.001 ? Math.min(100, (avgOooCpi / avgModeledCpi) * 100) : 0;

    // Pack-driven capability flags (zero hardcoded preset branches)
    const hasPmu = !plan.noPmu;
    const hasFreeBase = hasPmu;
    const hasDcDemand = plan.has(MetricPack.DcDemand);
    const hasDcHwpf = plan.has(MetricPack.DcHwpf);
    const hasL1L2Dc = plan.has(MetricPack.L1L2Dc);
    const hasL1L2Ic = plan.has(MetricPack.L1L2Ic);
    const hasL2Hwpf = plan.has(MetricPack.L2Hwpf);
    const hasBranches = plan.has(MetricPack.Branches);
    const hasItlb = plan.has(MetricPack.ItlbFull);
    const hasDtlb = plan.has(MetricPack.DtlbFull);
    const hasCrossCcxLocks = plan.has(MetricPack.CrossCcxLocks);
    const hasOpCacheDecode = plan.has(MetricPack.OpCacheDecode);
    const hasStlfSplits = plan.has(MetricPack.StlfSplits);
    const hasExactRetiring = plan.has(MetricPack.ExactRetiring);
    const hasAnyUarch = hasCrossCcxLocks || hasOpCacheDecode || hasStlfSplits;

    const retCtxStr = `Ret ${hasExactRetiring ? '' : '~'}${Math.round(avgRetPct)}% of 6-wide Zen 2 (typical C++ ceiling ~45-60%)`;

    const inactiveRules = [];
    if (!hasPmu) {
      inactiveRules.push('Hardware PMCs (No-PMU: Group A Win32 active)');
    } else {
      if (!hasDcDemand) inactiveRules.push('DRAM/L3');
      else if (!hasDcHwpf) inactiveRules.push('Dem/HWPF');
      if (!hasBranches) inactiveRules.push('Branches');
      if (!hasL1L2Ic) inactiveRules.push('I-Cache');
      if (!hasItlb) inactiveRules.push('iTLB');
      if (!hasDtlb) inactiveRules.push('dTLB');
      if (!hasCrossCcxLocks) inactiveRules.push('CCX/Locks');
      if (!hasOpCacheDecode) inactiveRules.push('Op-Cache');
      if (!hasStlfSplits) inactiveRules.push('STLF/Splits');
    }

    if (n < minSamples) {
      return {
        ready: false,
        gpuBound: false,
        gateReason: `Collecting baseline evidence (${n}/${minSamples} samples)...`,
        primaryVerdict: 'InsufficientData',
        verdictLabel: VERDICT_LABELS.InsufficientData,
        winningStallLine: `waiting for ${minSamples} rolling samples (${n}/${minSamples})`,
        proofLine: `PMU: ${plan.label} | Rolling cumulative window suppresses 1s single-tick flicker.`,
        samples: n, muxLabel: plan.label, plan, avgIpc, avgActualCpi, oooPct,
        inactiveRules, findings: [], healthyChecks: [], highCount: 0
      };
    }

    if (avgC0 < CONFIG.advisor.minAvgC0Pct && (!hasPmu || avgInst < CONFIG.advisor.minInstPerSec)) {
      return {
        ready: false,
        gpuBound: false,
        gateReason: `Low workload activity (avg C0 ${avgC0.toFixed(1)}% < ${CONFIG.advisor.minAvgC0Pct}%${hasPmu ? `, Inst ${fmtRate(avgInst)} < 1.50 B/s` : ''}).`,
        primaryVerdict: 'InsufficientData',
        verdictLabel: VERDICT_LABELS.InsufficientData,
        winningStallLine: 'workload mostly idle',
        proofLine: `Avg C0 ${avgC0.toFixed(1)}%${hasPmu ? ` | Inst ${fmtRate(avgInst)}` : ''} | Waiting for active load.`,
        samples: n, muxLabel: plan.label, plan, avgIpc, avgActualCpi, oooPct,
        inactiveRules, findings: [], healthyChecks: [], highCount: 0
      };
    }

    const avgDram = avg('dram');
    const avgDemDram = avg('demDram');
    const avgHwpfDram = avg('hwpfDram');
    const avgL2pfDram = avg('l2pfDram');
    const avgL3Hit = avg('l3Hit');
    const avgL3Miss = avg('l3Miss');
    const avgL3HitPct = avg('l3HitPct');
    const avgL3LatNs = avg('latNs');
    const avgL3LatCyc = avg('latCyc');
    const avgL2IcMiss = avg('l2icMiss');
    const avgL2IcExcl = avg('l2icExcl');
    const avgL1Ic = avg('l1ic');
    const avgL2DcExcl = avg('l2dcExcl');
    const avgBranch = avg('branch');
    const avgBranchPct = avg('branchMissPct');
    const avgL2Itlb = avg('l2itlb');
    const avgL1ItlbPct = avg('l1ItlbMissPct');
    const avgL2Dtlb = avg('l2dtlb');
    const avgPfRate = avg('pageFaultRate');
    const avgUsr = avg('cpuUsr');
    const avgSys = avg('cpuSys');
    const sysSharePct = (avgSys / Math.max(0.01, avgUsr + avgSys)) * 100.0;

    const avgCoreC0 = (ov && ov.avgCoreC0) ? ov.avgCoreC0 : state.cum.coreC0Sum.map(v => v / n);
    const avgCcxLat = (ov && ov.avgCcxLat) ? ov.avgCcxLat : state.cum.ccxLatSum.map(v => v / n);

    // Group A (Zero-PMC Win32) rolling cumulative averages
    const avgGpu3dPct = (ov && ('avgGpu3dPct' in ov))
      ? ov.avgGpu3dPct
      : (state.simGpuAvailable && state.cum.gpu3dSamples > 0 ? state.cum.gpu3dSum / state.cum.gpu3dSamples : null);
    const avgCoreDpc = (ov && ov.avgCoreDpc) ? ov.avgCoreDpc : state.cum.coreDpcSum.map(v => v / n);
    const avgCoreIrq = (ov && ov.avgCoreIrq) ? ov.avgCoreIrq : state.cum.coreIrqSum.map(v => v / n);
    const avgCoreIrqRate = (ov && ov.avgCoreIrqRate) ? ov.avgCoreIrqRate : state.cum.coreIrqRateSum.map(v => v / n);
    const avgHardPageReads = (ov && ov.avgHardPageReads !== undefined)
      ? ov.avgHardPageReads
      : (state.cum.hardPageReadsSum / n);
    const avgAvailPhysPct = (ov && ov.avgAvailPhysPct !== undefined)
      ? ov.avgAvailPhysPct
      : (state.cum.availPhysPctSum / n);
    const avgCommitPct = (ov && ov.avgCommitPct !== undefined)
      ? ov.avgCommitPct
      : (state.cum.commitPctSum / n);
    const avgCtxSw = (ov && ov.avgCtxSw !== undefined)
      ? ov.avgCtxSw
      : (state.cum.ctxSwSum / n);
    const avgSyncWaitPct = (ov && ov.avgSyncWaitPct !== undefined)
      ? ov.avgSyncWaitPct
      : (state.cum.syncWaitPctSum / n);
    const topWaitReason = (ov && ov.topWaitReason)
      ? ov.topWaitReason
      : (state.lastSnap ? state.lastSnap.topWaitReason : 'WrQueue');
    const priorityClass = (ov && ov.priorityClass)
      ? ov.priorityClass
      : (proc && proc.win32Profile ? proc.win32Profile.priorityClass : 'NORMAL');
    const ecoQos = (ov && ov.ecoQos)
      ? ov.ecoQos
      : (!proc ? 'Inactive' : (state.simEcoQosSupported ? ((proc.win32Profile && proc.win32Profile.ecoQos) || 'Inactive') : 'Unknown'));
    const seLockMemoryPrivilege = (ov && ov.seLockMemoryPrivilege)
      ? ov.seLockMemoryPrivilege
      : ((proc && proc.win32Profile && proc.win32Profile.seLockMemoryPrivilege) || 'Present');
    const bgList = (ov && ov.noisyNeighbors)
      ? ov.noisyNeighbors.map(b => ({
          name: b.name,
          pid: b.pid,
          sysCpuPct: b.sysCpuPct,
          singleCorePct: b.singleCorePct ?? (b.sysCpuPct * CONFIG.logicalCpus)
        }))
      : Object.values(state.cum.bgProcCpuSum || {}).map(b => {
          const sysCpuPct = b.sysCpuSum / n;
          return { name: b.name, pid: b.pid, sysCpuPct, singleCorePct: sysCpuPct * CONFIG.logicalCpus };
        });

    // Deep-Dive Zero-PMC telemetry context
    const presentStats = (ov && ('presentStats' in ov))
      ? ov.presentStats
      : (state.lastSnap ? state.lastSnap.presentStats : null);
    const spikeCorrelation = (ov && ('spikeCorrelation' in ov))
      ? ov.spikeCorrelation
      : (state.lastSnap ? state.lastSnap.spikeCorrelation : null);
    const vaMap = (ov && ('vaMap' in ov))
      ? ov.vaMap
      : (state.lastSnap ? state.lastSnap.vaMap : null);
    const avgReadMbS = (ov && ov.avgReadMbS !== undefined)
      ? ov.avgReadMbS
      : (state.cum.readMbSSum / n);
    const avgWriteMbS = (ov && ov.avgWriteMbS !== undefined)
      ? ov.avgWriteMbS
      : (state.cum.writeMbSSum / n);
    const avgReadIops = (ov && ov.avgReadIops !== undefined)
      ? ov.avgReadIops
      : (state.cum.readIopsSum / n);
    const avgWriteIops = (ov && ov.avgWriteIops !== undefined)
      ? ov.avgWriteIops
      : (state.cum.writeIopsSum / n);

    const dramLatForCpi = avgL3LatCyc > 0 ? avgL3LatCyc : CONFIG.latencies.dramFallback;
    const avgTierCpi = {
      dram:   hasDcDemand ? (avgDram * dramLatForCpi) / 1000.0 : 0,
      l3Hit:  hasDcDemand ? (avgL3Hit * CONFIG.latencies.l3Hit) / 1000.0 : 0,
      l2Dc:   hasL1L2Dc   ? (avgL2DcExcl * CONFIG.latencies.l2Hit) / 1000.0 : 0,
      l2Ic:   hasL1L2Ic   ? (avgL2IcExcl * CONFIG.latencies.l2Hit) / 1000.0 : 0,
      branch: hasBranches ? (avgBranch * CONFIG.latencies.branchMispredict) / 1000.0 : 0,
      l2Dtlb: hasDtlb     ? (avgL2Dtlb * CONFIG.latencies.l2DtlbWalk) / 1000.0 : 0,
      l2Itlb: hasItlb     ? (avgL2Itlb * CONFIG.latencies.l2ItlbWalk) / 1000.0 : 0
    };
    const sumModeledCpi = Math.max(0.001, Object.values(avgTierCpi).reduce((a, b) => a + b, 0));

    const findings = [];
    const healthyChecks = [];
    const pushFinding = f => findings.push(f);
    const pushHealthy = (label, metric) => healthyChecks.push({ label, metric });

    const ctx = {
      proc, base, plan,
      hasPmu, hasFreeBase, hasDcDemand, hasDcHwpf, hasL1L2Dc, hasL1L2Ic, hasL2Hwpf,
      hasBranches, hasItlb, hasDtlb, hasCrossCcxLocks, hasOpCacheDecode, hasStlfSplits, hasExactRetiring,
      uarchRawOverride: ov ? (ov.uarchRaw || null) : null,
      avgC0, avgInst, avgIpc, avgActualCpi, avgModeledCpi, avgOooCpi, avgRetPct, avgGhz,
      avgDram, avgDemDram, avgHwpfDram, avgL2pfDram, avgL3Hit, avgL3Miss, avgL3HitPct,
      avgL3LatNs, avgL3LatCyc, avgL2IcMiss, avgL2IcExcl, avgL1Ic, avgL2DcExcl,
      avgBranch, avgBranchPct, avgL2Itlb, avgL1ItlbPct, avgL2Dtlb,
      avgPfRate, avgUsr, avgSys, sysSharePct, avgCoreC0, avgCcxLat,
      avgGpu3dPct, avgCoreDpc, avgCoreIrq, avgCoreIrqRate,
      avgHardPageReads, avgAvailPhysPct, avgCommitPct,
      avgCtxSw, avgSyncWaitPct, topWaitReason,
      priorityClass, ecoQos, seLockMemoryPrivilege, bgList,
      presentStats, spikeCorrelation, vaMap,
      avgReadMbS, avgWriteMbS, avgReadIops, avgWriteIops,
      avgTierCpi, sumModeledCpi, pushFinding, pushHealthy
    };

    const groupA = evaluateGroupARules(ctx);
    const { gpuBound, hottestCpuC0, hottestCpuTag } = groupA;

    const pmuRes = evaluatePmuRules(ctx, groupA);
    const {
      smtContendedHot, hotCoreProof, crossCcxActive, dramQueueing,
      demandDramChase, demShare, branchBound, icacheBound
    } = pmuRes;

    const uarchRes = evaluateMicroArchRules(ctx);
    const {
      uarchMetrics, crossCcxBouncing, lockContention, opcacheThrash, stlfBound, splitsBound,
      crossCcxCpi, stlfCpi
    } = uarchRes;

    const stallRankList = [
      { key: 'dram',   name: 'DRAM',       cpi: avgTierCpi.dram,   active: hasDcDemand },
      { key: 'l3Hit',  name: 'L3 Hit',     cpi: avgTierCpi.l3Hit,  active: hasDcDemand },
      { key: 'l2Dc',   name: 'L2 D-Cache', cpi: avgTierCpi.l2Dc,   active: hasL1L2Dc },
      { key: 'l2Ic',   name: 'L2 I-Cache', cpi: avgTierCpi.l2Ic,   active: hasL1L2Ic },
      { key: 'branch', name: 'Branch',     cpi: avgTierCpi.branch, active: hasBranches },
      { key: 'l2Dtlb', name: 'L2 dTLB',    cpi: avgTierCpi.l2Dtlb, active: hasDtlb },
      { key: 'l2Itlb', name: 'L2 iTLB',    cpi: avgTierCpi.l2Itlb, active: hasItlb }
    ].filter(x => x.active).sort((a, b) => b.cpi - a.cpi);
    const winStall = stallRankList[0] || null;
    const winSharePct = winStall ? Math.round((winStall.cpi / sumModeledCpi) * 100) : 0;

    const feMissCpi = hasL1L2Ic ? (avgL2IcMiss * CONFIG.latencies.l3Hit) / 1000.0 : 0;
    const tlbCpi = avgTierCpi.l2Itlb + avgTierCpi.l2Dtlb;
    const uarchBound = crossCcxBouncing || lockContention || stlfBound || splitsBound;
    const uarchPeakCpi = Math.max(crossCcxCpi, stlfCpi);

    let primaryVerdict = hasPmu ? 'CoreExecutionBound' : 'Win32OnlyClear';
    if (!hasPmu) {
      primaryVerdict = 'Win32OnlyClear';
    } else if (dramQueueing) {
      primaryVerdict = 'MemoryBandwidthQueueing';
    } else if (hasDcDemand && avgTierCpi.dram >= Math.max(avgTierCpi.l3Hit, avgTierCpi.branch, feMissCpi, tlbCpi) && (avgDram >= 1.5 || demandDramChase)) {
      primaryVerdict = 'MemoryLatencyBound';
    } else if (uarchBound && (!hasDcDemand || uarchPeakCpi >= avgTierCpi.dram * 0.6 || avgDram < 1.5)) {
      primaryVerdict = 'MicroArchContention';
    } else if (branchBound && avgTierCpi.branch >= Math.max(avgTierCpi.dram, avgTierCpi.l3Hit, feMissCpi)) {
      primaryVerdict = 'BranchMispredictBound';
    } else if ((icacheBound && feMissCpi >= Math.max(avgTierCpi.dram, avgTierCpi.branch) * 0.55) || (opcacheThrash && !winStall)) {
      primaryVerdict = 'FrontendCodeBound';
    } else if (crossCcxActive || (hasDcDemand && avgTierCpi.l3Hit >= avgTierCpi.dram && avgL3Hit >= 5.0)) {
      primaryVerdict = 'L3CapacityOrCrossCcx';
    } else if ((hasItlb || hasDtlb) && ((hasItlb && avgL2Itlb >= 0.35) || (hasDtlb && avgL2Dtlb >= 0.50)) && (tlbCpi >= 0.04 || (!hasDcDemand && !hasBranches && !hasL1L2Ic))) {
      primaryVerdict = 'TlbTranslationBound';
    } else if (opcacheThrash) {
      primaryVerdict = 'FrontendCodeBound';
    } else if (uarchBound) {
      primaryVerdict = 'MicroArchContention';
    } else if (smtContendedHot) {
      primaryVerdict = 'SmtContentionBound';
    }

    // No orphan verdicts: emit a top diagnostic anchor if no HI/MD rule fired for the winning regime
    const hasRegimeExplanation = findings.some(f =>
      (f.severity === 'HI' || f.severity === 'MD') && f.category === primaryVerdict
    );

    if (!hasRegimeExplanation && !gpuBound && primaryVerdict !== 'CoreExecutionBound' && primaryVerdict !== 'Win32OnlyClear') {
      if (primaryVerdict === 'MemoryLatencyBound' && hasDcDemand) {
        const splitDesc = hasDcHwpf
          ? `Dem ${avgDemDram.toFixed(2)} (${(demShare * 100).toFixed(0)}%) + HWPF ${avgHwpfDram.toFixed(2)}`
          : `Demand ${avgDemDram.toFixed(2)} MPKI`;
        pushFinding({
          id: 'primary_dram_latency',
          category: 'MemoryLatencyBound',
          isPrimaryAnchor: true,
          severity: 'MD',
          scope: '[HW / Code]',
          confidence: 'HIGH',
          impact: avgTierCpi.dram + 0.05,
          title: `Dominant stall: DRAM latency (${winSharePct}% of modeled stalls, below queueing threshold)`,
          keyMetric: `${avgDram.toFixed(2)} MPKI @ ${avgL3LatNs.toFixed(1)} ns`,
          estGain: estimateAmdahlGain(avgActualCpi, sumModeledCpi, avgTierCpi.dram, 0.15, 'mlp', 'illustrative -15% DRAM latency from tighter DDR4 timings/FCLK'),
          why: `DRAM is the #1 CPI stack contributor (${avgTierCpi.dram.toFixed(2)} CPI / ${winSharePct}% of modeled stalls) at ${avgDram.toFixed(2)} MPKI (${splitDesc}) and ${avgL3LatNs.toFixed(1)} ns (${avgL3LatCyc.toFixed(0)} cyc), though still below the 3.0 MPKI queueing / 1.5 Dem pointer-chase anomaly triggers.`,
          action: `[HW / BIOS] Tighten DDR4 primary/secondary timings, raise FCLK, or move to larger L3 (X3D); [Code / Build] improve data locality, pack hot fields into 64B lines, and reduce pointer chasing. No Windows toggle lowers unloaded DRAM latency.`,
          cascade: `Every 10% drop in L3-miss latency directly reduces the largest stall tier (~${avgTierCpi.dram.toFixed(2)} CPI) and increases effective IPC.`,
          quickJumpTab: 2
        });
      } else if (primaryVerdict === 'L3CapacityOrCrossCcx' && hasDcDemand) {
        pushFinding({
          id: 'primary_l3_capacity',
          category: 'L3CapacityOrCrossCcx',
          isPrimaryAnchor: true,
          severity: 'MD',
          scope: '[HW / Code]',
          confidence: 'HIGH',
          impact: avgTierCpi.l3Hit + 0.05,
          title: `Dominant stall: L3 cache hit traffic (${winSharePct}% of modeled stalls)`,
          keyMetric: `L3 Hit ${avgL3Hit.toFixed(2)} MPKI | ${avgL3HitPct.toFixed(1)}% hit`,
          estGain: estimateAmdahlGain(avgActualCpi, sumModeledCpi, avgTierCpi.l3Hit, 0.25, 'mlp', 'illustrative -25% L3 hit stalls via L2 working-set locality'),
          why: `D-Cache fills serviced by L3 (${avgL3Hit.toFixed(2)} MPKI @ ${CONFIG.latencies.l3Hit.toFixed(0)} cyc = ${avgTierCpi.l3Hit.toFixed(2)} CPI) are the #1 modeled stall while unified L3 hit rate stays at ${avgL3HitPct.toFixed(1)}%.`,
          action: `[OS / TUI] Test single-CCX affinity if active threads <= 6; [Code / Build] shrink hot working sets to fit inside Zen 2's 512 KiB per-core L2 cache.`,
          cascade: `Improves L2 hit rate -> cuts 39-cycle L3 traffic and frees L3 bandwidth for neighboring threads.`,
          quickJumpTab: 2
        });
      } else if (primaryVerdict === 'TlbTranslationBound' && (hasItlb || hasDtlb)) {
        const parts = [];
        if (hasItlb) parts.push(`iTLB ${avgL2Itlb.toFixed(2)}`);
        if (hasDtlb) parts.push(`dTLB ${avgL2Dtlb.toFixed(2)}`);
        pushFinding({
          id: 'primary_tlb_bound',
          category: 'TlbTranslationBound',
          isPrimaryAnchor: true,
          severity: 'MD',
          scope: '[OS / TUI]',
          confidence: 'HIGH',
          impact: tlbCpi + 0.05,
          title: `Dominant stall: Hardware L2 TLB page walks`,
          keyMetric: `${parts.join(' | ')} MPKI`,
          estGain: estimateAmdahlGain(avgActualCpi, sumModeledCpi, tlbCpi, 0.80, 'mlp', 'assumes -80% L2 TLB walks via 2 MiB large pages'),
          why: `${parts.join(' and ')} MPKI hardware page-table walks dominate translation overhead in the current window.`,
          action: `Inspect Tab 3 PE modules and Tab 4 heap arenas to back hot code and data working sets with 2 MiB large pages.`,
          cascade: `Cuts 4-level x86-64 page walks and reduces PTE cache eviction in L1d/L2/L3.`,
          quickJumpTab: 3
        });
      }
    }

    const sevRank = { HI: 3, MD: 2, LO: 1, INFO: 0 };
    findings.sort((a, b) => {
      if (sevRank[b.severity] !== sevRank[a.severity]) return sevRank[b.severity] - sevRank[a.severity];
      if (Boolean(b.isPrimaryAnchor) !== Boolean(a.isPrimaryAnchor)) return b.isPrimaryAnchor ? 1 : -1;
      return b.impact - a.impact;
    });

    // Tab 5 Advisor Attribution Upgrade: enrich matching findings with fresh Tab 7 ETW / Burst hotspots
    const profCtx = (ov && ('profiler' in ov))
      ? ov.profiler
      : buildLiveProfilerContext(proc);
    if (profCtx) {
      enrichFindingsWithProfiler(findings, profCtx);
    }

    let winningStallLine = '';
    let proofLine = '';
    if (!hasPmu) {
      const gpuStr = avgGpu3dPct !== null ? `GPU 3D ${avgGpu3dPct.toFixed(1)}%` : 'GPU N/A';
      winningStallLine = `No-PMU Win32-Only: ${gpuStr} | Max CPU ${hottestCpuTag} ${hottestCpuC0.toFixed(0)}% C0 | Hard Faults ${avgHardPageReads.toFixed(1)}/s`;
      proofLine = `${gpuStr} | Avg C0 ${avgC0.toFixed(1)}% | Hard Faults ${avgHardPageReads.toFixed(1)}/s (Avail RAM ${avgAvailPhysPct.toFixed(1)}%) | Priority ${priorityClass} / EcoQoS ${ecoQos}`;
    } else if (!winStall && hasAnyUarch && uarchMetrics) {
      const uaParts = [];
      if (hasCrossCcxLocks && uarchMetrics.dcCrossCcxMpki !== null) {
        uaParts.push(`Cross-CCX ${uarchMetrics.dcCrossCcxMpki.toFixed(2)}`);
        uaParts.push(`Locks ${uarchMetrics.locksSerialMpki.toFixed(2)}`);
      }
      if (hasOpCacheDecode && uarchMetrics.opcacheHitPct !== null) {
        uaParts.push(`Op-Cache ${uarchMetrics.opcacheHitPct.toFixed(1)}%`);
      }
      if (hasStlfSplits && uarchMetrics.stlfInterlockMpki !== null) {
        uaParts.push(`STLF ${uarchMetrics.stlfInterlockMpki.toFixed(2)}`);
        uaParts.push(`Splits ${uarchMetrics.misalAccessMpki.toFixed(1)}`);
      }
      winningStallLine = `${plan.label}: ${uaParts.slice(0, 3).join(' | ')}`;
      proofLine = `IPC ${avgIpc.toFixed(2)} (CPI ${avgActualCpi.toFixed(2)}) | ${uaParts.join(' | ')} | L3 ${avgL3HitPct.toFixed(1)}% @ ${avgL3LatNs.toFixed(1)} ns`;
    } else if (!winStall) {
      winningStallLine = `${plan.label}: Free Base IPC ${avgIpc.toFixed(2)} | L3 ${avgL3HitPct.toFixed(1)}% @ ${avgL3LatNs.toFixed(1)} ns`;
      proofLine = `Actual CPI ${avgActualCpi.toFixed(2)} (${avgIpc.toFixed(2)} IPC) | ${retCtxStr} | L3 Hit ${avgL3HitPct.toFixed(1)}% @ ${avgL3LatNs.toFixed(1)} ns`;
    } else {
      winningStallLine = `${winStall.name} is #1 stall: ${winStall.cpi.toFixed(2)} CPI / ${winSharePct}% of modeled stalls`;
      if ((primaryVerdict === 'MemoryLatencyBound' || primaryVerdict === 'MemoryBandwidthQueueing') && hasDcDemand) {
        const splitStr = hasDcHwpf
          ? ` (Dem ${avgDemDram.toFixed(2)} / ${(demShare * 100).toFixed(0)}% + HWPF ${avgHwpfDram.toFixed(2)})`
          : '';
        proofLine = `DRAM ${avgDram.toFixed(2)} MPKI${splitStr} @ ${avgL3LatNs.toFixed(1)} ns (${avgL3LatCyc.toFixed(0)} cyc) | Actual CPI ${avgActualCpi.toFixed(2)} (${avgIpc.toFixed(2)} IPC) | ${retCtxStr} | OoO hides ${oooPct.toFixed(0)}%`;
      } else if (primaryVerdict === 'BranchMispredictBound' && hasBranches) {
        proofLine = `Branch ${avgBranch.toFixed(2)} MPKI (${avgBranchPct.toFixed(2)}% miss @ ${CONFIG.latencies.branchMispredict.toFixed(0)} cyc) | Actual CPI ${avgActualCpi.toFixed(2)} (${avgIpc.toFixed(2)} IPC) | ${retCtxStr}`;
      } else if (primaryVerdict === 'FrontendCodeBound' && hasL1L2Ic) {
        proofLine = `L2 I-Cache miss ${avgL2IcMiss.toFixed(2)} MPKI | L1i miss ${avgL1Ic.toFixed(1)} MPKI | Actual CPI ${avgActualCpi.toFixed(2)} (${avgIpc.toFixed(2)} IPC) | ${retCtxStr}`;
      } else if (primaryVerdict === 'L3CapacityOrCrossCcx') {
        proofLine = `${hasDcDemand ? `L3 Hit ${avgL3Hit.toFixed(2)} MPKI | ` : ''}Unified L3 Hit ${avgL3HitPct.toFixed(1)}% @ ${avgL3LatNs.toFixed(1)} ns | Actual CPI ${avgActualCpi.toFixed(2)} (${avgIpc.toFixed(2)} IPC) | ${retCtxStr}`;
      } else if (primaryVerdict === 'SmtContentionBound') {
        proofLine = `${hotCoreProof} | Actual CPI ${avgActualCpi.toFixed(2)} (${avgIpc.toFixed(2)} IPC) | ${retCtxStr}`;
      } else if (primaryVerdict === 'TlbTranslationBound') {
        const tlbParts = [];
        if (hasItlb) tlbParts.push(`L2 iTLB ${avgL2Itlb.toFixed(2)} MPKI (L1m ${avgL1ItlbPct.toFixed(2)}%)`);
        if (hasDtlb) tlbParts.push(`L2 dTLB ${avgL2Dtlb.toFixed(2)} MPKI`);
        proofLine = `${tlbParts.join(' | ')} | Actual CPI ${avgActualCpi.toFixed(2)} (${avgIpc.toFixed(2)} IPC) | ${retCtxStr}`;
      } else {
        const dramPart = hasDcDemand ? `DRAM ${avgDram.toFixed(2)} MPKI @ ` : `L3 ${avgL3HitPct.toFixed(1)}% @ `;
        proofLine = `Actual CPI ${avgActualCpi.toFixed(2)} (${avgIpc.toFixed(2)} IPC) | ${retCtxStr} | ${dramPart}${avgL3LatNs.toFixed(1)} ns | OoO hides ${oooPct.toFixed(0)}%`;
      }
    }

    let verdictLabel = VERDICT_LABELS[primaryVerdict] || primaryVerdict;
    if (gpuBound) {
      verdictLabel = VERDICT_LABELS.GpuBound;
      winningStallLine = `GPU 3D ${avgGpu3dPct.toFixed(1)}% | Hottest ${hottestCpuTag} ${hottestCpuC0.toFixed(0)}% C0 | CPU: ${VERDICT_LABELS[primaryVerdict] || primaryVerdict}`;
      proofLine = `GPU 3D ${avgGpu3dPct.toFixed(1)}% (>=97%) with ${hottestCpuTag} at ${hottestCpuC0.toFixed(0)}% C0 (<75%) | ${proofLine}`;
    }

    const highCount = findings.filter(f => f.severity === 'HI').length;
    return {
      ready: true,
      gpuBound,
      gateReason: '',
      primaryVerdict: gpuBound ? 'GpuBound' : primaryVerdict,
      verdictLabel,
      winningStallLine,
      proofLine,
      samples: n,
      muxLabel: plan.label,
      plan,
      avgIpc, avgActualCpi, oooPct,
      inactiveRules,
      findings,
      healthyChecks,
      highCount
    };
  }

  function buildLiveProfilerContext(proc) {
    if (!proc || !state.profiler) return null;
    const etw = state.profiler.etwSession;
    const bursts = (state.profiler.lastBurstByPid && state.profiler.lastBurstByPid[proc.pid]) || null;
    const onCpuRows = (etw && etw.targetPid === proc.pid && etw.onCpu.totalSamples > 0)
      ? etw.onCpu.getFlatHotspots()
      : [];
    const offCpuRows = (etw && etw.targetPid === proc.pid && etw.offCpu.totalWakes > 0)
      ? etw.offCpu.getWaitRows()
      : [];
    if (onCpuRows.length === 0 && offCpuRows.length === 0 && !bursts) return null;
    return {
      pid: proc.pid,
      onCpuTop: onCpuRows[0] || null,
      offCpuTop: offCpuRows[0] || null,
      bursts: bursts || {}
    };
  }

  function formatFnName(row) {
    if (!row) return '';
    if (row.name && row.name.includes('!')) return row.name;
    return row.module ? `${row.module}!${row.displayName || row.name}` : (row.displayName || row.name);
  }

  function enrichFindingsWithProfiler(findings, profCtx) {
    if (!Array.isArray(findings) || !profCtx) return;
    const bursts = profCtx.bursts || {};
    const topFromBurst = (type) => {
      const b = bursts[type];
      if (!b) return null;
      if (Array.isArray(b.flatRows) && b.flatRows.length > 0) return b.flatRows[0];
      if (b.aggregator && typeof b.aggregator.getFlatHotspots === 'function') {
        return b.aggregator.getFlatHotspots()[0] || null;
      }
      return null;
    };

    const ibsTop = topFromBurst('ibs_op');
    const dramTop = topFromBurst('dram_l3');
    const branchTop = topFromBurst('branch_miss');
    const tlbTop = topFromBurst('tlb_walk');
    const onCpuTop = profCtx.onCpuTop || null;
    const offCpuTop = profCtx.offCpuTop || null;

    for (const f of findings) {
      let note = null;

      if (f.id === 'branch_mispredict_bound' || f.id === 'branch_mispredicts') {
        if (branchTop) {
          note = `Top branch-mispredict burst contributor: ${formatFnName(branchTop)} (${branchTop.selfPct.toFixed(1)}%).`;
        } else if (onCpuTop) {
          note = `Top On-CPU hotspot: ${formatFnName(onCpuTop)} (${onCpuTop.selfPct.toFixed(1)}% self).`;
        }
      } else if (
        f.id === 'dram_queueing_inflation' ||
        f.id === 'demand_dram_pointer_chase' ||
        f.id === 'primary_dram_latency' ||
        f.id === 'primary_l3_capacity'
      ) {
        if (ibsTop) {
          const latStr = ibsTop.avgLatencyCyc ? `, avg ${Math.round(ibsTop.avgLatencyCyc)} cyc` : '';
          const srcStr = ibsTop.topDataSource ? ` ${ibsTop.topDataSource}` : '';
          note = `Top IBS Op load-latency contributor: ${formatFnName(ibsTop)} (${ibsTop.selfPct.toFixed(1)}%${latStr}${srcStr}).`;
        } else if (dramTop) {
          note = `Top DRAM/L3 miss burst contributor: ${formatFnName(dramTop)} (${dramTop.selfPct.toFixed(1)}%).`;
        } else if (onCpuTop) {
          note = `Top On-CPU hotspot: ${formatFnName(onCpuTop)} (${onCpuTop.selfPct.toFixed(1)}% self).`;
        }
      } else if (
        f.id === 'pe_itlb_4k_modules' ||
        f.id === 'crt_heap_dtlb' ||
        f.id === 'mimalloc_spillover' ||
        f.id === 'primary_tlb_bound' ||
        f.id === 'large_page_failure_root_cause'
      ) {
        if (tlbTop) {
          note = `Top TLB-walk burst contributor: ${formatFnName(tlbTop)} (${tlbTop.selfPct.toFixed(1)}%).`;
        } else if (onCpuTop) {
          note = `Top On-CPU hotspot: ${formatFnName(onCpuTop)} (${onCpuTop.selfPct.toFixed(1)}% self).`;
        }
      } else if (f.id === 'context_switch_storm') {
        if (offCpuTop) {
          note = `Top Off-CPU sleep stack: ${offCpuTop.displayName || offCpuTop.name} (${offCpuTop.blockedPct.toFixed(1)}% blocked, woken ${Math.round(offCpuTop.topWakerPct)}% by ${offCpuTop.topWakerName}).`;
        }
      } else if (
        f.id === 'icache_capacity_pressure' ||
        f.id === 'opcache_thrashing' ||
        f.id === 'serialized_lock_contention' ||
        f.id === 'cross_ccx_cache_bouncing' ||
        f.id === 'stlf_interlocks' ||
        f.id === 'cache_line_splits'
      ) {
        if (onCpuTop) {
          note = `Top On-CPU hotspot: ${formatFnName(onCpuTop)} (${onCpuTop.selfPct.toFixed(1)}% self).`;
        }
      }

      if (note) {
        f.why = `${f.why} ${note}`;
        f.profilerAttribution = note;
      }
    }
  }

  Object.assign(Z, { VERDICT_LABELS, estimateAmdahlGain, formatEstGainCell, evaluateDiagnostics, buildLiveProfilerContext, enrichFindingsWithProfiler });
})();
