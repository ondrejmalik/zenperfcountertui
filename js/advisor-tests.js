// Group A Zero-PMC Win32 diagnostics self-test suite
(() => {
  'use strict';
  const Z = window.Zen2Top || (window.Zen2Top = {});
  const {
    CONFIG, makeMod, buildArenas, makeWin32Profile, evaluateDiagnostics,
    formatThreadEntry, computeThreadDeltaMetrics, applyThreadAffinityEdit, revertAllThreadAffinities,
    getCcxMask, getPrimaryPhysicalCoresMask, isThreadSmtContended,
    computeFrametimeStats, recordFrametimeSpikeIfMatched, analyzeSpikeCorrelations,
    aggregateVaRegions, computeIoCounterDeltas
  } = Z;

  function runGroupADiagnosticTests() {
    const baseProc = {
      pid: 9001,
      name: 'test_app.exe',
      wsMiB: 1024,
      hugeMiB: 2048,
      requestedHugeMiB: 2048,
      ifeoEnabled: false,
      modules: [makeMod('game.dll', 48.0, true, true, 'RX', true, 0x7FF800000000n)],
      arenas: buildArenas(2, [16, 12], []),
      win32Profile: makeWin32Profile()
    };
    const quietDpc = new Array(12).fill(0.3);
    const quietIrq = new Array(12).fill(0.2);
    const quietIrqRate = new Array(12).fill(300);
    const baseOverride = (extra = {}) => ({
      samples: 15,
      muxId: 'full',
      proc: baseProc,
      base: null,
      avg: {
        avgC0Pct: 40.0, instPerSec: 8e9, ipc: 1.5, actualCpi: 0.67, modeledCpi: 0.50,
        oooHiddenCpi: 0.0, retiringPct: 28.0, effGhz: 4.2,
        dram: 0.8, demDram: 0.5, hwpfDram: 0.3, l2pfDram: 0.2,
        l3Hit: 2.0, l3Miss: 0.9, l3HitPct: 88.0, latNs: 48.0, latCyc: 200,
        l2icMiss: 0.8, l2icExcl: 4.0, l1ic: 5.0, l2dcExcl: 10.0,
        branch: 1.5, branchMissPct: 1.5, l2itlb: 0.05, l1ItlbMissPct: 0.2,
        l2dtlb: 0.08, pageFaultRate: 120, cpuUsr: 40.0, cpuSys: 4.0,
        ...(extra.avg || {})
      },
      avgCoreC0: [62, 10, 50, 8, 40, 5, 45, 6, 30, 4, 20, 2],
      avgCcxLat: [48, 49],
      avgGpu3dPct: 70.0,
      avgCoreDpc: [...quietDpc],
      avgCoreIrq: [...quietIrq],
      avgCoreIrqRate: [...quietIrqRate],
      avgHardPageReads: 0.0,
      avgAvailPhysPct: 48.0,
      avgCommitPct: 45.0,
      avgCtxSw: 10000,
      avgSyncWaitPct: 15.0,
      topWaitReason: 'WrQueue',
      priorityClass: 'NORMAL',
      ecoQos: 'Inactive',
      seLockMemoryPrivilege: 'Present',
      noisyNeighbors: [{ name: 'dwm.exe', pid: 1188, sysCpuPct: 1.0 }],
      ...extra
    });

    const results = [];
    const check = (name, cond, detail) => results.push({ name, pass: Boolean(cond), detail });

    // 1. Evidence gate (<10 samples)
    const dGate = evaluateDiagnostics(baseOverride({ samples: 9, avgGpu3dPct: 99.0 }));
    check('evidence_gate_under_10', !dGate.ready && dGate.findings.length === 0, `ready=${dGate.ready}, findings=${dGate.findings.length}`);

    // 2. GPU-bound verdict annotation & top HI qualitative finding
    const dGpu = evaluateDiagnostics(baseOverride({ avgGpu3dPct: 98.5 }));
    const fGpu = dGpu.findings.find(f => f.id === 'gpu_bound');
    check(
      'gpu_bound_verdict_override',
      dGpu.gpuBound && dGpu.verdictLabel === 'GPU-BOUND (CPU Headroom Available)' && fGpu && fGpu.severity === 'HI' && fGpu.estGain.kind === 'qualitative' && dGpu.findings[0].id === 'gpu_bound',
      `verdict="${dGpu.verdictLabel}", top=${dGpu.findings[0]?.id}`
    );

    // 3. GPU-bound suppressed when hottest CPU >= 75% C0 or GPU is null (D3DKMT unavailable)
    const dGpuHotCpu = evaluateDiagnostics(baseOverride({ avgGpu3dPct: 99.0, avgCoreC0: [82, 10, 50, 8, 40, 5, 45, 6, 30, 4, 20, 2] }));
    const dGpuNone = evaluateDiagnostics(baseOverride({ avgGpu3dPct: null }));
    check(
      'gpu_bound_guards_and_none',
      !dGpuHotCpu.gpuBound && !dGpuNone.gpuBound && !dGpuNone.findings.some(f => f.id === 'gpu_bound') && !dGpuNone.healthyChecks.some(h => h.label.includes('GPU')),
      `hotCpuBound=${dGpuHotCpu.gpuBound}, nullGpuBound=${dGpuNone.gpuBound}`
    );

    // 4. DPC/IRQ collision HI (>=8%) and MD (>=5%) on hot CPU (>=60% C0)
    const dpcHi = [...quietDpc]; dpcHi[0] = 6.2;
    const irqHi = [...quietIrq]; irqHi[0] = 2.4;
    const dDpcHi = evaluateDiagnostics(baseOverride({ avgCoreDpc: dpcHi, avgCoreIrq: irqHi }));
    const fDpcHi = dDpcHi.findings.find(f => f.id === 'dpc_irq_collision');
    const dpcMd = [...quietDpc]; dpcMd[0] = 4.2;
    const irqMd = [...quietIrq]; irqMd[0] = 1.6;
    const dDpcMd = evaluateDiagnostics(baseOverride({ avgCoreDpc: dpcMd, avgCoreIrq: irqMd }));
    const fDpcMd = dDpcMd.findings.find(f => f.id === 'dpc_irq_collision');
    check(
      'dpc_irq_hot_cpu_hi_and_md',
      fDpcHi && fDpcHi.severity === 'HI' && fDpcHi.title.includes('C00') && fDpcMd && fDpcMd.severity === 'MD',
      `HI=${fDpcHi?.severity}, MD=${fDpcMd?.severity}`
    );

    // 5. DPC/IRQ collision does NOT fire when noisy CPU is cool (<60% C0)
    const dpcCool = [...quietDpc]; dpcCool[1] = 8.5;
    const irqCool = [...quietIrq]; irqCool[1] = 2.5;
    const dDpcCool = evaluateDiagnostics(baseOverride({ avgCoreDpc: dpcCool, avgCoreIrq: irqCool }));
    check(
      'dpc_irq_cool_cpu_suppressed',
      !dDpcCool.findings.some(f => f.id === 'dpc_irq_collision'),
      `fired=${dDpcCool.findings.some(f => f.id === 'dpc_irq_collision')}`
    );

    // 6. Noisy neighbor triggers on >=5% sys CPU or >=50% single-core
    const dNoisy = evaluateDiagnostics(baseOverride({ noisyNeighbors: [{ name: 'MsMpEng.exe', pid: 4120, sysCpuPct: 4.5 }] }));
    const fNoisy = dNoisy.findings.find(f => f.id === 'noisy_neighbor');
    check(
      'noisy_neighbor_single_core_and_sys',
      fNoisy && fNoisy.severity === 'MD' && fNoisy.title.includes('MsMpEng.exe [4120]'),
      `title="${fNoisy?.title}"`
    );

    // 7. Priority / EcoQoS fires on BELOW_NORMAL or Active, handles Unknown gracefully
    const dEco = evaluateDiagnostics(baseOverride({ ecoQos: 'Active' }));
    const dUnk = evaluateDiagnostics(baseOverride({ priorityClass: 'NORMAL', ecoQos: 'Unknown' }));
    check(
      'priority_ecoqos_and_unknown_graceful',
      dEco.findings.some(f => f.id === 'priority_or_ecoqos' && f.severity === 'HI') &&
      !dUnk.findings.some(f => f.id === 'priority_or_ecoqos'),
      `ecoFired=${dEco.findings.some(f => f.id === 'priority_or_ecoqos')}, unkFired=${dUnk.findings.some(f => f.id === 'priority_or_ecoqos')}`
    );

    // 8. Hard page faults fires on >=20/s or <5% avail phys, warns on huge pages, ignores soft faults
    const dHard = evaluateDiagnostics(baseOverride({ avgHardPageReads: 32.0, avgAvailPhysPct: 3.5 }));
    const fHard = dHard.findings.find(f => f.id === 'hard_page_faults');
    const dSoftOnly = evaluateDiagnostics(baseOverride({ avg: { pageFaultRate: 4500 }, avgHardPageReads: 1.5, avgAvailPhysPct: 40.0 }));
    check(
      'hard_page_faults_vs_soft_and_huge_warn',
      fHard && fHard.severity === 'HI' && fHard.action.includes('locked 2 MiB huge pages') &&
      !dSoftOnly.findings.some(f => f.id === 'hard_page_faults'),
      `hardFired=${Boolean(fHard)}, softOnlyFired=${dSoftOnly.findings.some(f => f.id === 'hard_page_faults')}`
    );

    // 9. Exact SeLockMemoryPrivilege Missing vs Present branching (IFEO + Mimalloc 0 GiB)
    const ifeoFailProc = {
      ...baseProc, ifeoEnabled: true,
      modules: [makeMod('client.dll', 58.0, false, true, 'RX', true, 0x7FF811000000n)]
    };
    const dPrivMiss = evaluateDiagnostics(baseOverride({ proc: ifeoFailProc, seLockMemoryPrivilege: 'Missing' }));
    const fPrivMiss = dPrivMiss.findings.find(f => f.id === 'large_page_failure_root_cause');
    const miZeroProc = { ...baseProc, hugeMiB: 0, requestedHugeMiB: 4096 };
    const dPrivFrag = evaluateDiagnostics(baseOverride({ proc: miZeroProc, seLockMemoryPrivilege: 'Present' }));
    const fPrivFrag = dPrivFrag.findings.find(f => f.id === 'large_page_failure_root_cause');
    check(
      'large_page_priv_missing_vs_fragmentation',
      fPrivMiss && fPrivMiss.title.includes('Missing SeLockMemoryPrivilege') && fPrivMiss.action.includes('secpol.msc') &&
      fPrivFrag && fPrivFrag.title.includes('Contiguous 2 MiB RAM Fragmentation') && fPrivFrag.action.includes('standby RAM'),
      `missing="${fPrivMiss?.title}", present="${fPrivFrag?.title}"`
    );

    // 10. Context-switch storm fires at >=50k/s + >=40% sync + <85% C0; suppressed at >=85% C0
    const dCtx = evaluateDiagnostics(baseOverride({ avgCtxSw: 72000, avgSyncWaitPct: 52.0, topWaitReason: 'WrPushLock' }));
    const fCtx = dCtx.findings.find(f => f.id === 'context_switch_storm');
    const dCtxSat = evaluateDiagnostics(baseOverride({ avg: { avgC0Pct: 89.0 }, avgCtxSw: 72000, avgSyncWaitPct: 52.0 }));
    check(
      'context_switch_storm_and_saturation_guard',
      fCtx && fCtx.severity === 'MD' && !dCtxSat.findings.some(f => f.id === 'context_switch_storm'),
      `fired=${Boolean(fCtx)}, saturatedFired=${dCtxSat.findings.some(f => f.id === 'context_switch_storm')}`
    );

    // 11. --no-pmu preset runs Group A rules and Verified Healthy checks with zero PMCs
    const dNoPmu = evaluateDiagnostics(baseOverride({ muxId: 'no-pmu', avg: { avgC0Pct: 35.0, instPerSec: 0 } }));
    const hasHealthySet = ['GPU <97%', 'DPC/IRQ <5%', 'No noisy neighbor', 'Hard faults 0/s', 'Normal QoS']
      .every(lbl => dNoPmu.healthyChecks.some(h => h.label === lbl));
    check(
      'no_pmu_group_a_and_healthy_strip',
      dNoPmu.ready && hasHealthySet,
      `ready=${dNoPmu.ready}, healthy=${dNoPmu.healthyChecks.map(h => h.label).join(', ')}`
    );

    // 12. All 7 Group A findings emit qualitative estGain + required fields (never fake IPC %)
    const allGroupAFindings = [fGpu, fDpcHi, fNoisy, dEco.findings.find(f => f.id === 'priority_or_ecoqos'), fHard, fPrivMiss, fCtx];
    const allValid = allGroupAFindings.every(f =>
      f && f.why && f.action && f.cascade && f.scope && f.confidence && f.estGain && f.estGain.kind === 'qualitative'
    );
    check('all_7_rules_qualitative_schema', allValid, `validated=${allGroupAFindings.filter(Boolean).length}/7`);

    const passed = results.filter(r => r.pass).length;
    return { passed, total: results.length, results };
  }

  function runDeepDiveTests() {
    const results = [];
    const check = (name, cond, detail) => results.push({ name, pass: Boolean(cond), detail });

    // 1. Per-thread CPU%, context-switch rate, and 2-tier GetThreadDescription vs module+offset fallback
    const delta = computeThreadDeltaMetrics(
      { kernelSec: 1.0, userSec: 4.0, ctxSwitches: 1000 },
      { kernelSec: 1.25, userSec: 4.50, ctxSwitches: 3500 },
      1.0,
      1
    );
    const mods = [
      makeMod('client.dll', 64.0, true, true, 'RX', false, 0x7FFA12000000n),
      makeMod('engine2.dll', 24.0, true, true, 'RX', false, 0x7FFA00000000n)
    ];
    const named = formatThreadEntry({ description: 'RenderThread', startAddress: 0x7FFA1201A420n }, mods);
    const offsetFallback = formatThreadEntry({ description: '', startAddress: 0x7FFA1201A420n }, mods);
    const rawAddrFallback = formatThreadEntry({ description: '', startAddress: 0x000012345678n }, mods);
    check(
      'thread_metrics_and_2tier_naming',
      Math.abs(delta.cpuPct - 75.0) < 0.01 &&
      Math.abs(delta.ctxSwPerSec - 2500) < 0.01 &&
      named === 'RenderThread' &&
      offsetFallback === 'client.dll+0x1A420' &&
      rawAddrFallback === '0x12345678',
      `cpu=${delta.cpuPct.toFixed(1)}%, cs=${delta.ctxSwPerSec}/s, named="${named}", fallback="${offsetFallback}"`
    );

    // 2. Thread affinity editor: presets, single-core SMT exclusion, ERROR_ACCESS_DENIED, and R revert
    const testProc = {
      pid: 9010,
      name: 'aff_test.exe',
      protectedProcess: false,
      threads: [
        { tid: 101, description: 'MainThread', currentCpu: 0, idealCpu: 0, affinityMask: 0x0FFF },
        { tid: 102, description: 'Worker#0', currentCpu: 1, idealCpu: 1, affinityMask: 0x0FFF }
      ]
    };
    const origMap = {};
    const rCcx0 = applyThreadAffinityEdit(testProc, 101, getCcxMask(0, CONFIG.physicalCores), origMap);
    const rSingle = applyThreadAffinityEdit(testProc, 101, 1 << 0, origMap, { excludeSiblingFromOthers: true });
    const workerAfterExcl = testProc.threads[1].affinityMask;
    const smtBitRemoved = (workerAfterExcl & (1 << 1)) === 0;
    const origPreserved = origMap[101] === 0x0FFF && origMap[102] === 0x0FFF;
    const deniedProc = { ...testProc, protectedProcess: true };
    const rDenied = applyThreadAffinityEdit(deniedProc, 101, 0x003F, {});
    const reverted = revertAllThreadAffinities(testProc, origMap);
    const smtFlag = isThreadSmtContended({ currentCpu: 0, affinityMask: 0x0FFF }, [80, 25, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0], CONFIG.physicalCores);
    check(
      'thread_affinity_presets_denied_and_revert',
      rCcx0.ok && rSingle.ok && smtBitRemoved && origPreserved &&
      !rDenied.ok && rDenied.error === 'ERROR_ACCESS_DENIED' && rDenied.message.includes('Access Denied') &&
      reverted === 2 && testProc.threads[0].affinityMask === 0x0FFF && testProc.threads[1].affinityMask === 0x0FFF &&
      getPrimaryPhysicalCoresMask(CONFIG.physicalCores) === 0x0555 && smtFlag,
      `excl=${smtBitRemoved}, denied=${rDenied.error}, reverted=${reverted}, physMask=0x${getPrimaryPhysicalCoresMask(CONFIG.physicalCores).toString(16)}`
    );

    // 3. VirtualQueryEx region aggregation (4 categories, 2 MiB vs 4 KiB split, RX/RWX JIT detection, RESERVE ignored)
    const MiB = 1024 * 1024;
    const va = aggregateVaRegions([
      { type: 'PRIVATE', protect: 'RW', state: 'COMMIT', commitBytes: 1024 * MiB, wsBytes: 1024 * MiB, largePage: true },
      { type: 'PRIVATE', protect: 'RW', state: 'COMMIT', commitBytes: 512 * MiB, wsBytes: 400 * MiB, largePage: false },
      { type: 'PRIVATE', protect: 'RWX', state: 'COMMIT', commitBytes: 18 * MiB, wsBytes: 16 * MiB, largePage: false },
      { type: 'PRIVATE', protect: 'RX', state: 'COMMIT', commitBytes: 6 * MiB, wsBytes: 5 * MiB, largePage: false },
      { type: 'MAPPED', protect: 'R', state: 'COMMIT', commitBytes: 200 * MiB, wsBytes: 150 * MiB, largePage: false },
      { type: 'IMAGE', protect: 'RX', state: 'COMMIT', commitBytes: 160 * MiB, wsBytes: 140 * MiB, largePage: true },
      { type: 'IMAGE', protect: 'RX', state: 'COMMIT', commitBytes: 40 * MiB, wsBytes: 35 * MiB, largePage: false },
      { type: 'PRIVATE', protect: 'RWX', state: 'RESERVE', commitBytes: 256 * MiB, wsBytes: 0, largePage: false }
    ]);
    check(
      'va_region_aggregation_and_jit_detection',
      Math.abs(va.privateRw.commit2mMiB - 1024) < 0.01 &&
      Math.abs(va.privateRw.commit4kMiB - 512) < 0.01 &&
      Math.abs(va.privateJitExec4kMiB - 24) < 0.01 &&
      Math.abs(va.mapped.ws4kMiB - 150) < 0.01 &&
      Math.abs(va.imageLarge2mPct - 80.0) < 0.01,
      `privRW=${va.privateRw.commit2mMiB}M/2M+${va.privateRw.commit4kMiB}M/4K, jit4K=${va.privateJitExec4kMiB}M, img2M=${va.imageLarge2mPct.toFixed(1)}%`
    );

    // 4. Disk I/O counter delta math
    const io = computeIoCounterDeltas(
      { readBytes: 100 * MiB, writeBytes: 10 * MiB, readOps: 500, writeOps: 100 },
      { readBytes: 340 * MiB, writeBytes: 22 * MiB, readOps: 3100, writeOps: 220 },
      2.0
    );
    check(
      'disk_io_counter_deltas',
      Math.abs(io.readMbS - 120.0) < 0.01 &&
      Math.abs(io.writeMbS - 6.0) < 0.01 &&
      Math.abs(io.readIops - 1300) < 0.01 &&
      Math.abs(io.writeIops - 60) < 0.01,
      `R=${io.readMbS.toFixed(1)} MB/s (${io.readIops} IOPS), W=${io.writeMbS.toFixed(1)} MB/s (${io.writeIops} IOPS)`
    );

    // 5. Frametime percentile math (avg, 1% low, 0.1% low, composedPct) + spike correlation attribution
    const ring = [];
    for (let i = 0; i < 296; i++) ring.push({ frametimeMs: 8.0, presentMode: 'Hardware: Independent Flip' });
    ring.push({ frametimeMs: 14.0, presentMode: 'Hardware: Independent Flip' });
    ring.push({ frametimeMs: 16.0, presentMode: 'Hardware: Independent Flip' });
    ring.push({ frametimeMs: 22.0, presentMode: 'Hardware: Independent Flip' });
    ring.push({ frametimeMs: 35.0, presentMode: 'Hardware: Independent Flip' });
    const fs = computeFrametimeStats(ring);
    const spikeRing = [];
    // Should ignore <= 16.7ms or <= 2x median
    recordFrametimeSpikeIfMatched(spikeRing, 15.0, 6.0, { readMbS: 150 });
    recordFrametimeSpikeIfMatched(spikeRing, 18.0, 10.0, { readMbS: 150 });
    // Should record 7 disk-correlated spikes + 2 uncorrelated
    for (let i = 0; i < 7; i++) recordFrametimeSpikeIfMatched(spikeRing, 24.0 + i, 8.0, { readMbS: 130 + i * 5, readIops: 1400 });
    for (let i = 0; i < 2; i++) recordFrametimeSpikeIfMatched(spikeRing, 22.0, 8.0, { readMbS: 5, readIops: 40 });
    const corr = analyzeSpikeCorrelations(spikeRing);
    check(
      'frametime_percentiles_and_spike_correlation',
      fs && Math.abs(fs.medianMs - 8.0) < 0.01 &&
      fs.low1Ms === 16.0 && fs.low01Ms === 35.0 &&
      Math.abs(fs.low1Fps - (1000 / 16.0)) < 0.1 &&
      corr.totalSpikes === 9 && corr.dominantCulprit === 'disk_read' && corr.dominantCount === 7 &&
      corr.dominantSharePct > 77.0 && corr.culpritSummary.includes('Disk Read'),
      `med=${fs?.medianMs}ms, 1%L=${fs?.low1Ms}ms, 0.1%L=${fs?.low01Ms}ms, corr=${corr.dominantCount}/${corr.totalSpikes} ${corr.dominantCulprit}`
    );

    // Shared Advisor fixture helper
    const baseProc = {
      pid: 9020,
      name: 'deep_app.exe',
      wsMiB: 1024,
      hugeMiB: 0,
      requestedHugeMiB: 0,
      ifeoEnabled: true,
      modules: [makeMod('game.dll', 64.0, true, true, 'RX', false, 0x7FF800000000n)],
      arenas: null,
      win32Profile: makeWin32Profile()
    };
    const mkOv = (extra = {}) => {
      const { avg: extraAvg, ...rest } = extra;
      return {
        samples: 15,
        muxId: 'full',
        proc: baseProc,
        base: null,
        avgCoreC0: [62, 10, 50, 8, 40, 5, 45, 6, 30, 4, 20, 2],
        avgCcxLat: [48, 49],
        avgGpu3dPct: 70.0,
        avgCoreDpc: new Array(12).fill(0.3),
        avgCoreIrq: new Array(12).fill(0.2),
        avgCoreIrqRate: new Array(12).fill(300),
        avgHardPageReads: 0.0,
        avgAvailPhysPct: 48.0,
        avgCommitPct: 45.0,
        avgCtxSw: 10000,
        avgSyncWaitPct: 15.0,
        topWaitReason: 'WrQueue',
        priorityClass: 'NORMAL',
        ecoQos: 'Inactive',
        seLockMemoryPrivilege: 'Present',
        noisyNeighbors: [],
        presentStats: null,
        spikeCorrelation: null,
        vaMap: null,
        avgReadMbS: 4.0,
        avgWriteMbS: 1.0,
        avgReadIops: 90,
        avgWriteIops: 20,
        ...rest,
        avg: {
          avgC0Pct: 42.0, instPerSec: 8e9, ipc: 1.5, actualCpi: 0.67, modeledCpi: 0.50,
          oooHiddenCpi: 0.0, retiringPct: 28.0, effGhz: 4.2,
          dram: 0.8, demDram: 0.5, hwpfDram: 0.3, l2pfDram: 0.2,
          l3Hit: 2.0, l3Miss: 0.9, l3HitPct: 88.0, latNs: 48.0, latCyc: 200,
          l2icMiss: 0.8, l2icExcl: 4.0, l1ic: 5.0, l2dcExcl: 10.0,
          branch: 1.5, branchMissPct: 1.5, l2itlb: 0.08, l1ItlbMissPct: 0.2,
          l2dtlb: 0.08, pageFaultRate: 120, cpuUsr: 40.0, cpuSys: 4.0,
          ...(extraAvg || {})
        }
      };
    };

    // 6. Advisor Rule: composed_flip_mode (>=80% composed triggers MD; <80% does not)
    const dComp = evaluateDiagnostics(mkOv({
      presentStats: { fps: 110, avgMs: 9.1, medianMs: 8.8, low1Ms: 14.0, low01Ms: 18.0, presentMode: 'Composed: Flip', composedPct: 88.0 }
    }));
    const dIndep = evaluateDiagnostics(mkOv({
      presentStats: { fps: 144, avgMs: 6.9, medianMs: 6.8, low1Ms: 11.2, low01Ms: 16.0, presentMode: 'Hardware: Independent Flip', composedPct: 0.0 }
    }));
    const fComp = dComp.findings.find(f => f.id === 'composed_flip_mode');
    check(
      'advisor_composed_flip_mode',
      fComp && fComp.severity === 'MD' && fComp.scope === '[OS / TUI]' &&
      !dIndep.findings.some(f => f.id === 'composed_flip_mode'),
      `fired=${Boolean(fComp)}, indepFired=${dIndep.findings.some(f => f.id === 'composed_flip_mode')}`
    );

    // 7. Advisor Rule: jit_4k_itlb_residual fires ONLY when PE >=75% 2MiB AND JIT >=8MiB AND iTLB >=0.35
    const dJitFire = evaluateDiagnostics(mkOv({
      avg: { l2itlb: 0.55 },
      vaMap: { imageLarge2mPct: 85.0, privateJitExec4kMiB: 22.0 }
    }));
    const dJitLowPe = evaluateDiagnostics(mkOv({
      avg: { l2itlb: 0.55 },
      vaMap: { imageLarge2mPct: 40.0, privateJitExec4kMiB: 22.0 }
    }));
    const dJitLowJit = evaluateDiagnostics(mkOv({
      avg: { l2itlb: 0.55 },
      vaMap: { imageLarge2mPct: 90.0, privateJitExec4kMiB: 4.0 }
    }));
    const fJit = dJitFire.findings.find(f => f.id === 'jit_4k_itlb_residual');
    check(
      'advisor_jit_4k_itlb_residual_pe_gate',
      fJit && fJit.severity === 'MD' && fJit.scope === '[OS / Code]' &&
      !dJitLowPe.findings.some(f => f.id === 'jit_4k_itlb_residual') &&
      !dJitLowJit.findings.some(f => f.id === 'jit_4k_itlb_residual'),
      `fired=${Boolean(fJit)}, lowPeFired=${dJitLowPe.findings.some(f => f.id === 'jit_4k_itlb_residual')}, lowJitFired=${dJitLowJit.findings.some(f => f.id === 'jit_4k_itlb_residual')}`
    );

    // 8. Advisor Rule: disk_io_streaming_stall (high read + spikes/WrPageIn/sys%; suppressed without coincidence)
    const dDiskFire = evaluateDiagnostics(mkOv({
      avgReadMbS: 135.0,
      avgReadIops: 1800,
      spikeCorrelation: corr
    }));
    const dDiskWrPageIn = evaluateDiagnostics(mkOv({
      avgReadMbS: 62.0,
      avgReadIops: 400,
      topWaitReason: 'WrPageIn'
    }));
    const dDiskQuiet = evaluateDiagnostics(mkOv({
      avgReadMbS: 135.0,
      avgReadIops: 1800,
      avg: { cpuSys: 3.0 },
      topWaitReason: 'WrQueue',
      spikeCorrelation: { totalSpikes: 0 }
    }));
    const fDisk = dDiskFire.findings.find(f => f.id === 'disk_io_streaming_stall');
    check(
      'advisor_disk_io_streaming_stall',
      fDisk && fDisk.severity === 'MD' && fDisk.scope === '[OS / HW]' &&
      dDiskWrPageIn.findings.some(f => f.id === 'disk_io_streaming_stall') &&
      !dDiskQuiet.findings.some(f => f.id === 'disk_io_streaming_stall'),
      `spikeFired=${Boolean(fDisk)}, wrPageInFired=${dDiskWrPageIn.findings.some(f => f.id === 'disk_io_streaming_stall')}, quietFired=${dDiskQuiet.findings.some(f => f.id === 'disk_io_streaming_stall')}`
    );

    // 9. Advisor Rule: frametime_spike_correlator (>=5 spikes & >=60% dominant; INFO vs MD; suppressed <5 or <60%)
    const dCorrMd = evaluateDiagnostics(mkOv({ spikeCorrelation: corr }));
    const fCorrMd = dCorrMd.findings.find(f => f.id === 'frametime_spike_correlator');
    const infoCorr = {
      totalSpikes: 5,
      dominantCulprit: 'dpc_irq',
      dominantCount: 3,
      dominantSharePct: 60.0,
      avgSpikeMs: 19.5,
      minSpikeMs: 18.0,
      culpritMeta: { scope: '[OS / TUI]', tab: 1 },
      culpritSummary: 'DPC/IRQ spikes >6.0%'
    };
    const dCorrInfo = evaluateDiagnostics(mkOv({ spikeCorrelation: infoCorr }));
    const fCorrInfo = dCorrInfo.findings.find(f => f.id === 'frametime_spike_correlator');
    const dCorrTooFew = evaluateDiagnostics(mkOv({ spikeCorrelation: { ...infoCorr, totalSpikes: 4 } }));
    const dCorrLowShare = evaluateDiagnostics(mkOv({ spikeCorrelation: { ...infoCorr, dominantCount: 2, dominantSharePct: 40.0 } }));
    check(
      'advisor_frametime_spike_correlator',
      fCorrMd && fCorrMd.severity === 'MD' && fCorrMd.title.includes('7 of 9 frame spikes') &&
      fCorrInfo && fCorrInfo.severity === 'INFO' &&
      !dCorrTooFew.findings.some(f => f.id === 'frametime_spike_correlator') &&
      !dCorrLowShare.findings.some(f => f.id === 'frametime_spike_correlator'),
      `mdTitle="${fCorrMd?.title}", infoSev=${fCorrInfo?.severity}, tooFew=${dCorrTooFew.findings.some(f => f.id === 'frametime_spike_correlator')}`
    );

    // 10. All 4 new Deep-Dive Advisor rules emit valid qualitative schema
    const allNew = [fComp, fJit, fDisk, fCorrMd];
    const allSchemaValid = allNew.every(f =>
      f && f.why && f.action && f.cascade && f.scope && f.confidence && f.estGain && f.estGain.kind === 'qualitative'
    );
    check('all_4_deep_dive_rules_schema', allSchemaValid, `validated=${allNew.filter(Boolean).length}/4`);

    const passed = results.filter(r => r.pass).length;
    return { passed, total: results.length, results };
  }

  function runAllDiagnosticTests() {
    const a = runGroupADiagnosticTests();
    const b = runDeepDiveTests();
    const results = [...a.results, ...b.results];
    return {
      passed: a.passed + b.passed,
      total: a.total + b.total,
      results
    };
  }

  Object.assign(Z, { runGroupADiagnosticTests, runDeepDiveTests, runAllDiagnosticTests });
})();
