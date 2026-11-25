// Group A Zero-PMC Win32 diagnostics self-test suite
(() => {
  'use strict';
  const Z = window.Zen2Top || (window.Zen2Top = {});
  const { makeMod, buildArenas, makeWin32Profile, evaluateDiagnostics } = Z;

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

  Object.assign(Z, { runGroupADiagnosticTests });
})();
