// Unit tests for Tab 7 Profiler: 4-tier SymbolResolver, Sidecar JSON, CallTree/Off-CPU, AMDuProfCLI CSV & PmuCoordinator, Advisor Attribution
(() => {
  'use strict';
  const Z = window.Zen2Top || (window.Zen2Top = {});
  const {
    SymbolResolver,
    KERNEL_ADDR_MIN,
    isKernelAddress,
    ETW_KERNEL_FLAGS,
    CallTreeAggregator,
    OffCpuAggregator,
    KernelSysBreakdown,
    buildKernelStripViewModel,
    DiskIoEtwAggregator,
    KERNEL_SYSTEM_MODULES,
    getEtwTemplatesForPid,
    getSystemWideEtwTemplates,
    parseUprofBurstReportCsv,
    PmuCoordinator,
    EtwProfilerSession,
    evaluateDiagnostics,
    makeMod,
    makeWin32Profile
  } = Z;

  function runProfilerTests() {
    const results = [];
    const check = (name, cond, detail) => results.push({ name, pass: Boolean(cond), detail });

    // 1. 4-Tier SymbolResolver precedence: PDB > Export > Sidecar JSON > .pdata binary search
    const resolver = new SymbolResolver(14820);
    resolver.onModuleLoad({
      name: 'client.dll',
      base: 0x7FFA12000000n,
      sizeMiB: 64.0,
      pdbLoaded: true,
      pdbSymbols: [
        { rvaStart: 0x1000, rvaEnd: 0x1200, name: 'pdb_hot_fn', file: 'src/hot.cpp', line: 42 }
      ],
      exports: [
        { rva: 0x1000, rvaEnd: 0x1200, name: 'export_shadowed_by_pdb', ordinal: 1 },
        { rva: 0x2000, rvaEnd: 0x2300, name: 'ExportedApiFn', ordinal: 12 }
      ],
      pdata: [
        { beginAddress: 0x1000, endAddress: 0x1200 },
        { beginAddress: 0x2000, endAddress: 0x2300 },
        { beginAddress: 0x3000, endAddress: 0x3400 },
        { beginAddress: 0x4000, endAddress: 0x4500 },
        { beginAddress: 0x14A200, endAddress: 0x14A480 }
      ]
    });
    resolver.loadSidecarJson([
      { module: 'client.dll', rva_start: '0x2000', rva_end: '0x2300', name: 'sidecar_shadowed_by_export' },
      { module: 'client.dll', rva_start: '0x3000', rva_end: '0x3400', name: 'crate::sidecar_fn' }
    ]);

    const r1 = resolver.resolve('client.dll', 0x1040); // Tier 1 PDB wins over Export/pdata
    const r2 = resolver.resolve('client.dll', 0x2080); // Tier 2 Export wins over Sidecar/pdata
    const r3 = resolver.resolve('client.dll', 0x3120); // Tier 3 Sidecar wins over pdata
    const r4a = resolver.resolve('client.dll', 0x14A200); // Tier 4 .pdata start boundary
    const r4b = resolver.resolve('client.dll', 0x14A47F); // Tier 4 .pdata end-1 boundary -> grouped under same fn!
    const r4out = resolver.resolve('client.dll', 0x14A480); // End is exclusive -> RAW

    check(
      'symbol_resolver_4tier_precedence_and_pdata_grouping',
      r1.tier === 'PDB' && r1.name === 'pdb_hot_fn' && r1.fileLine === 'src/hot.cpp:44' &&
      r2.tier === 'EXP' && r2.name === 'ExportedApiFn' &&
      r3.tier === 'MAP' && r3.name === 'crate::sidecar_fn' &&
      r4a.tier === '.pdata' && r4a.name === 'client.dll!fn_0x14A200' &&
      r4b.tier === '.pdata' && r4b.name === 'client.dll!fn_0x14A200' && r4a.key === r4b.key &&
      r4out.tier === 'RAW',
      `T1=${r1.tier}:${r1.name}, T2=${r2.tier}:${r2.name}, T3=${r3.tier}:${r3.name}, T4=${r4a.tier}:${r4a.name}, endExcl=${r4out.tier}`
    );

    // 2. Sidecar JSON string parsing, cache invalidation on load/unload, and base-address resolution
    const res2 = new SymbolResolver(9999);
    res2.onModuleLoad({
      name: 'foo.exe',
      base: 0x7FF600000000n,
      sizeMiB: 16.0,
      pdbLoaded: false,
      pdata: [{ beginAddress: 0x14A200, endAddress: 0x14A480 }]
    });
    const beforeMap = res2.resolve(0x7FF600000000n, 0x14A280);
    const loadedCnt = res2.loadSidecarJson(JSON.stringify([
      { module: 'foo.exe', rva_start: '0x14A200', rva_end: '0x14A480', name: 'crate::hot_fn' }
    ]));
    const afterMap = res2.resolve(0x7FF600000000n, 0x14A280);
    res2.onModuleUnload('foo.exe');
    const afterUnload = res2.resolve(0x7FF600000000n, 0x14A280);

    check(
      'sidecar_json_loading_and_cache_invalidation',
      beforeMap.tier === '.pdata' && beforeMap.name === 'foo.exe!fn_0x14A200' &&
      loadedCnt === 1 &&
      afterMap.tier === 'MAP' && afterMap.name === 'crate::hot_fn' &&
      afterUnload.tier === 'RAW',
      `before=${beforeMap.tier}, loaded=${loadedCnt}, after=${afterMap.tier}:${afterMap.name}, unloaded=${afterUnload.tier}`
    );

    // 3. Call-Tree aggregation: Self % vs Inclusive % without double-counting recursive frames + LRU node cap
    const agg = new CallTreeAggregator({ maxNodes: 20 });
    const fMain = { key: 'app!main', module: 'app.exe', name: 'main', displayName: 'main', tier: 'PDB', rva: 0x1000 };
    const fRec = { key: 'app!recurse', module: 'app.exe', name: 'recurse', displayName: 'recurse', tier: 'PDB', rva: 0x2000 };
    const fLeaf = { key: 'app!leaf', module: 'app.exe', name: 'leaf', displayName: 'leaf', tier: 'PDB', rva: 0x3000 };

    // 60 samples in recursive stack: main -> recurse -> recurse -> leaf
    agg.recordSample([fMain, fRec, fRec, fLeaf], { tid: 100, weight: 60 });
    // 40 samples in main -> recurse (self in recurse)
    agg.recordSample([fMain, fRec], { tid: 200, weight: 40 });

    const flatAll = agg.getFlatHotspots();
    const mRow = flatAll.find(r => r.key === 'app!main');
    const rRow = flatAll.find(r => r.key === 'app!recurse');
    const lRow = flatAll.find(r => r.key === 'app!leaf');
    const flatTid100 = agg.getFlatHotspots({ tid: 100 });

    // Node cap verification
    const cappedAgg = new CallTreeAggregator({ maxNodes: 16 });
    for (let i = 0; i < 40; i++) {
      cappedAgg.recordSample([
        fMain,
        { key: `m!fn_${i}`, module: 'm.dll', name: `fn_${i}`, displayName: `fn_${i}`, tier: '.pdata', rva: 0x1000 + i * 0x100 }
      ], { weight: 1 });
    }

    check(
      'call_tree_recursion_dedup_thread_filter_and_node_cap',
      Math.abs(lRow.selfPct - 60.0) < 0.01 && Math.abs(lRow.inclusivePct - 60.0) < 0.01 &&
      Math.abs(rRow.selfPct - 40.0) < 0.01 && Math.abs(rRow.inclusivePct - 100.0) < 0.01 && rRow.inclusiveSamples === 100 &&
      Math.abs(mRow.selfPct - 0.0) < 0.01 && Math.abs(mRow.inclusivePct - 100.0) < 0.01 &&
      flatTid100.find(r => r.key === 'app!leaf').selfPct === 100.0 &&
      cappedAgg.nodeCount <= 16 && cappedAgg.evictedNodes > 0,
      `leaf=${lRow.selfPct}%/${lRow.inclusivePct}%, rec=${rRow.selfPct}%/${rRow.inclusivePct}% (no double-count), cap=${cappedAgg.nodeCount}/16`
    );

    // 4. Off-CPU CSwitch + ReadyThread pairing & waker attribution
    const offCpu = new OffCpuAggregator({ targetPid: 14820 });
    const fWait = { key: 'kernelbase.dll!WaitForSingleObject', module: 'kernelbase.dll', name: 'WaitForSingleObject', displayName: 'WaitForSingleObject', tier: 'EXP', rva: 0x3A100 };
    const fCaller = { key: 'engine2.dll!LoopTick', module: 'engine2.dll', name: 'LoopTick', displayName: 'LoopTick', tier: 'MAP', rva: 0x64000 };

    // 9 wakes by RenderThread (20ms each = 180ms), 1 wake by AudioThread (20ms), plus 1 ignored wrong-PID event
    for (let i = 0; i < 9; i++) {
      const baseTs = i * 50000;
      offCpu.onCSwitchOut({ pid: 14820, tid: 1001, threadName: 'MainThread', tsUs: baseTs, stack: [fCaller, fWait] });
      offCpu.onReadyThread({ targetPid: 14820, targetTid: 1001, wakerPid: 14820, wakerTid: 1002, wakerName: 'RenderThread', tsUs: baseTs + 19000 });
      offCpu.onCSwitchIn({ pid: 14820, tid: 1001, tsUs: baseTs + 20000 });
    }
    offCpu.onCSwitchOut({ pid: 14820, tid: 1001, threadName: 'MainThread', tsUs: 600000, stack: [fCaller, fWait] });
    offCpu.onReadyThread({ targetPid: 14820, targetTid: 1001, wakerPid: 14820, wakerTid: 1003, wakerName: 'AudioThread', tsUs: 619000 });
    offCpu.onCSwitchIn({ pid: 14820, tid: 1001, tsUs: 620000 });
    // Different PID must be strictly filtered out
    offCpu.onCSwitchOut({ pid: 55555, tid: 9999, threadName: 'OtherProc', tsUs: 700000, stack: [fWait] });
    offCpu.onCSwitchIn({ pid: 55555, tid: 9999, tsUs: 790000 });

    const waitRows = offCpu.getWaitRows();
    const topWait = waitRows[0];
    check(
      'off_cpu_cswitch_readythread_pairing',
      waitRows.length === 1 &&
      topWait.wakes === 10 &&
      Math.abs(topWait.blockedMs - 200.0) < 0.01 &&
      Math.abs(topWait.avgWaitMs - 20.0) < 0.01 &&
      topWait.topWakerName === 'RenderThread' &&
      Math.abs(topWait.topWakerPct - 90.0) < 0.01,
      `wakes=${topWait?.wakes}, blocked=${topWait?.blockedMs}ms, topWaker=${topWait?.topWakerName} (${topWait?.topWakerPct}%)`
    );

    // 5. AMDuProfCLI report.csv parser (flat + call-graph + IBS latency columns + Tier 3/4 enrichment)
    const sampleCsv = [
      'Function,Module,RVA,Self Samples,Inclusive Samples,Avg Load Latency (cyc),Data Source,Call Stack,TID',
      '0x14A260,client.dll,0x14A260,750,750,242,DRAM,client.dll!0x3000@0x3000,1001',
      '0x4020,client.dll,0x4020,250,250,118,L3,client.dll!0x3000@0x3000,1001'
    ].join('\n');
    const parsedBurst = parseUprofBurstReportCsv(sampleCsv, resolver, { burstType: 'ibs_op', durationSec: 5, capturedAt: '14:32:10' });
    const topBurst = parsedBurst.flatRows[0];
    const treeBurst = parsedBurst.aggregator.getTreeRows({ expandedIds: new Set(['client.dll!crate::sidecar_fn']) });

    check(
      'uprof_burst_csv_parser_ibs_and_enrichment',
      parsedBurst.totalSamples === 1000 &&
      topBurst && topBurst.name === 'client.dll!fn_0x14A200' && topBurst.tier === '.pdata' &&
      Math.abs(topBurst.selfPct - 75.0) < 0.01 &&
      Math.abs(topBurst.avgLatencyCyc - 242) < 0.01 &&
      topBurst.topDataSource === 'DRAM' &&
      treeBurst.length === 3 && treeBurst[0].name === 'crate::sidecar_fn' && treeBurst[0].tier === 'MAP',
      `total=${parsedBurst.totalSamples}, top=${topBurst?.name} (${topBurst?.selfPct}%, ${topBurst?.avgLatencyCyc}c ${topBurst?.topDataSource}), root=${treeBurst[0]?.name}`
    );

    // 6. PmuCoordinator guaranteed AMDuProfPcm resume & tmpdir cleanup on burst failure + ETW stop safety
    let pausedCount = 0;
    let resumedCount = 0;
    let cleanedCount = 0;
    const coord = new PmuCoordinator({
      pausePcm: () => { pausedCount += 1; },
      resumePcm: () => { resumedCount += 1; },
      cleanupTmpDir: () => { cleanedCount += 1; },
      collectBurst: () => { throw new Error('Simulated AMDuProfCLI failure'); }
    });
    const syncRes = coord.runBurstSync({ pid: 14820, burstType: 'ibs_op', durationSec: 5 });

    // Also test async PmuCoordinator resume guarantee
    const asyncCoord = new PmuCoordinator({
      pausePcm: async () => {},
      resumePcm: async () => {},
      cleanupTmpDir: async () => {},
      collectBurst: async () => { throw new Error('Simulated async AMDuProfCLI failure'); }
    });
    const coordPromise = asyncCoord.runBurst({ pid: 14820, burstType: 'ibs_op', durationSec: 5 });

    const etwSess = new EtwProfilerSession();
    etwSess.attach(14820, resolver);
    etwSess.stop();

    check(
      'pmu_coordinator_pause_resume_on_failure_and_etw_stop',
      syncRes.ok === false && pausedCount === 1 && resumedCount === 1 && cleanedCount === 1 &&
      coord.state === 'LIVE_PCM' && coord.pcmRunning === true &&
      etwSess.running === false && etwSess.controlStopCount === 1,
      `paused=${pausedCount}, resumed=${resumedCount}, cleaned=${cleanedCount}, state=${coord.state}, etwStops=${etwSess.controlStopCount}`
    );

    // 7. Advisor finding enrichment when burst/ETW hotspot data is present vs. absent
    const advProc = {
      pid: 7777,
      name: 'bench.exe',
      wsMiB: 1024,
      hugeMiB: 2048,
      requestedHugeMiB: 2048,
      ifeoEnabled: false,
      modules: [makeMod('client.dll', 64.0, true, true, 'RX', false, 0x7FFA12000000n)],
      arenas: null,
      win32Profile: makeWin32Profile()
    };
    const mkAdvOv = (profilerObj) => ({
      samples: 15,
      muxId: 'full',
      proc: advProc,
      base: null,
      profiler: profilerObj,
      avg: {
        avgC0Pct: 45.0, instPerSec: 8e9, ipc: 1.05, actualCpi: 0.95, modeledCpi: 0.85,
        oooHiddenCpi: 0.0, retiringPct: 22.0, effGhz: 4.2,
        dram: 2.6, demDram: 2.0, hwpfDram: 0.6, l2pfDram: 0.3,
        l3Hit: 3.0, l3Miss: 2.2, l3HitPct: 82.0, latNs: 54.0, latCyc: 226,
        l2icMiss: 1.0, l2icExcl: 4.0, l1ic: 6.0, l2dcExcl: 12.0,
        branch: 7.5, branchMissPct: 4.8, l2itlb: 0.1, l1ItlbMissPct: 0.3,
        l2dtlb: 0.1, pageFaultRate: 200, cpuUsr: 42.0, cpuSys: 8.0
      },
      avgCoreC0: [62, 10, 50, 8, 40, 5, 45, 6, 30, 4, 20, 2],
      avgCcxLat: [52, 55],
      avgGpu3dPct: 60.0,
      avgCoreDpc: new Array(12).fill(0.3),
      avgCoreIrq: new Array(12).fill(0.2),
      avgCoreIrqRate: new Array(12).fill(300),
      avgHardPageReads: 0.0,
      avgAvailPhysPct: 48.0,
      avgCommitPct: 45.0,
      avgCtxSw: 72000,
      avgSyncWaitPct: 55.0,
      topWaitReason: 'WrPushLock',
      priorityClass: 'NORMAL',
      ecoQos: 'Inactive',
      seLockMemoryPrivilege: 'Present',
      noisyNeighbors: []
    });

    const diagWithout = evaluateDiagnostics(mkAdvOv(null));
    const diagWith = evaluateDiagnostics(mkAdvOv({
      pid: 7777,
      onCpuTop: { module: 'client.dll', name: 'client.dll!fn_0x14A200', displayName: 'fn_0x14A200', selfPct: 31.4 },
      offCpuTop: { module: 'kernelbase.dll', name: 'WaitForSingleObject', displayName: 'WaitForSingleObject', blockedPct: 28.4, topWakerName: 'RenderThread', topWakerPct: 88.0 },
      bursts: {
        branch_miss: { flatRows: [{ module: 'client.dll', name: 'client.dll!fn_0x2A8100', displayName: 'fn_0x2A8100', selfPct: 34.2 }] },
        ibs_op: { flatRows: [{ module: 'client.dll', name: 'client.dll!fn_0x14A200', displayName: 'fn_0x14A200', selfPct: 41.5, avgLatencyCyc: 234, topDataSource: 'DRAM' }] }
      }
    }));

    const brNo = diagWithout.findings.find(f => f.id === 'branch_mispredict_bound');
    const brYes = diagWith.findings.find(f => f.id === 'branch_mispredict_bound');
    const ctxNo = diagWithout.findings.find(f => f.id === 'context_switch_storm');
    const ctxYes = diagWith.findings.find(f => f.id === 'context_switch_storm');
    const dramYes = diagWith.findings.find(f => f.id === 'demand_dram_pointer_chase');

    check(
      'advisor_enrichment_present_vs_absent',
      brNo && !brNo.why.includes('Top branch-mispredict') && !brNo.profilerAttribution &&
      brYes && brYes.why.includes('Top branch-mispredict burst contributor: client.dll!fn_0x2A8100 (34.2%)') &&
      ctxNo && !ctxNo.why.includes('Top Off-CPU sleep stack') &&
      ctxYes && ctxYes.why.includes('Top Off-CPU sleep stack: WaitForSingleObject (28.4% blocked, woken 88% by RenderThread)') &&
      dramYes && dramYes.why.includes('Top IBS Op load-latency contributor: client.dll!fn_0x14A200 (41.5%, avg 234 cyc DRAM)'),
      `brEnriched=${Boolean(brYes?.profilerAttribution)}, ctxEnriched=${Boolean(ctxYes?.profilerAttribution)}, dramEnriched=${Boolean(dramYes?.profilerAttribution)}`
    );

    // 8. Kernel SampledProfile sys% stack-walk attribution, zero-PDB Tier 1 drivers, and DPC/ISR isolation
    const kRes = new SymbolResolver(7777);
    const kLoaded = kRes.loadKernelModules(KERNEL_SYSTEM_MODULES);
    const kSess = new EtwProfilerSession();
    kSess.attach(7777, kRes);
    const hasDiskIoFlag = (kSess.enabledFlags & ETW_KERNEL_FLAGS.EVENT_TRACE_FLAG_DISK_IO) !== 0;
    const hasSysCallFlag = (kSess.enabledFlags & 0x00000080) !== 0; // EVENT_TRACE_FLAG_SYSTEMCALL must stay OFF

    const userFrame = { module: 'app.exe', rva: 0x1000, base: 0x7FF600000000n, va: 0x7FF600001000n, name: 'ReadLoop', displayName: 'ReadLoop', key: 'app!ReadLoop', isKernel: false };
    // User-mode only sample -> must be ignored by KernelSysBreakdown
    kSess.ingestSampledProfile({ pid: 7777, tid: 101, weight: 50, stack: [userFrame] });
    // Cached I/O memcpy: KiSystemCall64 -> NtReadFile -> CcCopyRead -> memcpy -> must bill to cached_io
    kSess.ingestSampledProfile({
      pid: 7777, tid: 101, weight: 30,
      stack: [userFrame, { va: 0xFFFFF80040412040n }, { va: 0xFFFFF80040310040n }, { va: 0xFFFFF80040312040n }, { va: 0xFFFFF80040260040n }]
    });
    // Socket buffer memcpy: KiSystemCall64 -> afd.sys -> memcpy -> must bill to network_ipc (zero PDB on afd.sys)
    kSess.ingestSampledProfile({
      pid: 7777, tid: 101, weight: 20,
      stack: [userFrame, { va: 0xFFFFF80040412040n }, { va: 0xFFFFF8004601A040n }, { va: 0xFFFFF80040260040n }]
    });
    // Demand-zero page fault memcpy: KiPageFault -> MmAccessFault -> MiZeroFault -> memcpy -> must bill to memory_manager
    kSess.ingestSampledProfile({
      pid: 7777, tid: 101, weight: 25,
      stack: [userFrame, { va: 0xFFFFF80040414040n }, { va: 0xFFFFF80040350040n }, { va: 0xFFFFF80040352040n }, { va: 0xFFFFF80040260040n }]
    });
    // Hard fault into NVMe: KiPageFault -> MmAccessFault -> MiIssueHardFault -> stornvme.sys -> must bill to physical_storage
    kSess.ingestSampledProfile({
      pid: 7777, tid: 101, weight: 10,
      stack: [userFrame, { va: 0xFFFFF80040414040n }, { va: 0xFFFFF80040350040n }, { va: 0xFFFFF80040354040n }, { va: 0xFFFFF80045608040n }]
    });
    // Minifilter tax: KiSystemCall64 -> NtReadFile -> fltmgr.sys -> WdFilter.sys -> ntfs.sys -> must bill to av_minifilter (WdFilter.sys)
    kSess.ingestSampledProfile({
      pid: 7777, tid: 101, weight: 15,
      stack: [userFrame, { va: 0xFFFFF80040412040n }, { va: 0xFFFFF80040310040n }, { va: 0xFFFFF80045006040n }, { va: 0xFFFFF80045212040n }, { va: 0xFFFFF80044018040n }]
    });
    // Preempting NIC DPC/ISR: UserCode -> KiInterruptDispatch -> KiRetireDpcList -> e1d68x64.sys -> isolated from targetSysSamples!
    kSess.ingestSampledProfile({
      pid: 7777, tid: 101, weight: 40,
      stack: [userFrame, { va: 0xFFFFF80040242040n }, { va: 0xFFFFF80040240040n }, { va: 0xFFFFF80050010040n }]
    });

    const kSum = kSess.kernelSys.getSummary({ activeSysCpuPct: 14.0, isSystemWide: false });
    const kSumSysPctTotal = kSum.rows.reduce((a, r) => a + r.pctOfSys, 0);
    const kSumCpuPctTotal = kSum.rows.reduce((a, r) => a + r.pctOfCpu, 0);
    check(
      'kernel_sys_stackwalk_attribution_and_dpc_isolation',
      kLoaded >= 10 && hasDiskIoFlag && !hasSysCallFlag &&
      isKernelAddress(0xFFFFF80040000000n) && !isKernelAddress(0x00007FF600001000n) &&
      kSum.targetSysSamples === 100 && kSum.preemptingDpcSamples === 40 && kSum.totalKernelSamples === 140 &&
      Math.abs(kSumSysPctTotal - 100.0) <= 0.2 &&
      Math.abs(kSumCpuPctTotal - 14.0) <= 0.2 &&
      Math.abs(kSum.buckets.cached_io.syscallOnlySharePct - 30.0) < 0.01 &&
      Math.abs(kSum.buckets.network_ipc.syscallOnlySharePct - 20.0) < 0.01 &&
      Math.abs(kSum.buckets.memory_manager.syscallOnlySharePct - 25.0) < 0.01 &&
      Math.abs(kSum.buckets.physical_storage.syscallOnlySharePct - 10.0) < 0.01 &&
      Math.abs(kSum.buckets.av_minifilter.syscallOnlySharePct - 15.0) < 0.01 &&
      kSum.topAvDriver?.name === 'WdFilter.sys' &&
      kSum.topDpcDriver?.name === 'e1d68x64.sys',
      `sys=${kSum.targetSysSamples}, dpc=${kSum.preemptingDpcSamples} (${kSum.topDpcDriver?.name}), sumSys=${kSumSysPctTotal.toFixed(1)}%, sumCpu=${kSumCpuPctTotal.toFixed(1)}%`
    );

    // 8b. Exact reproduction of old 100% + 37% bug -> must now produce 63.0% and 37.0% summing to 100.0% and activeSysCpuPct
    const reproSess = new EtwProfilerSession();
    reproSess.attach(7777, kRes);
    reproSess.ingestSampledProfile({
      pid: 7777, tid: 101, cpu: 2, weight: 63,
      stack: [userFrame, { va: 0xFFFFF80040412040n }, { va: 0xFFFFF80047048040n }, { va: 0xFFFFF80048110040n }]
    });
    reproSess.ingestSampledProfile({
      pid: 7777, tid: 101, cpu: 0, weight: 37,
      stack: [userFrame, { va: 0xFFFFF80040240040n }, { va: 0xFFFFF8004E014040n }]
    });
    const reproVm = buildKernelStripViewModel({
      proc: { pid: 7777, name: 'cs2.exe' },
      etwSession: reproSess,
      activeSysCpuPct: 12.5,
      activeUsrCpuPct: 48.0
    });
    const rGpuRow = reproVm.rows.find(r => r.id === 'gpu_driver');
    const rDpcRow = reproVm.rows.find(r => r.id === 'preempting_dpc_isr');
    const reproSysSum = reproVm.rows.reduce((a, r) => a + r.pctOfSys, 0);
    const reproCpuSum = reproVm.rows.reduce((a, r) => a + r.pctOfCpu, 0);
    const hasMixedVendor = KERNEL_SYSTEM_MODULES.some(m => m.name.toLowerCase() === 'nvlddmkm.sys') ||
      getEtwTemplatesForPid(27408).onCpu.some(t => t.stack.some(f => String(f.module || '').toLowerCase() === 'nvlddmkm.sys'));
    check(
      'kernel_strip_unified_denominator_63_37_and_vendor_consistency',
      !reproVm.empty && reproVm.rows.length === 2 &&
      Math.abs(rGpuRow.pctOfSys - 63.0) < 0.05 && Math.abs(rDpcRow.pctOfSys - 37.0) < 0.05 &&
      Math.abs(reproSysSum - 100.0) <= 0.2 && Math.abs(reproCpuSum - 12.5) <= 0.2 &&
      rGpuRow.hatched === false && rDpcRow.hatched === true &&
      rDpcRow.attribution === 'Preempt / HW (C00)' &&
      rGpuRow.topDriver?.name === 'amdkmdag.sys' && rDpcRow.topDriver?.name === 'USBXHCI.sys' &&
      !hasMixedVendor,
      `gpu=${rGpuRow?.pctOfSys?.toFixed(1)}% (${rGpuRow?.pctOfCpu?.toFixed(2)}%cpu), dpc=${rDpcRow?.pctOfSys?.toFixed(1)}% (${rDpcRow?.pctOfCpu?.toFixed(2)}%cpu), sumSys=${reproSysSum.toFixed(1)}%, sumCpu=${reproCpuSum.toFixed(2)}%, mixedVendor=${hasMixedVendor}`
    );

    // 8c. Zero-sample / paused ETW / detached System-Wide scope with PID 4 worker attribution (zero NaN/Infinity)
    const emptySess = new EtwProfilerSession();
    emptySess.attach(7777, kRes);
    emptySess.togglePause();
    const emptyVm = buildKernelStripViewModel({
      proc: { pid: 7777, name: 'deadlock.exe' },
      etwSession: emptySess,
      activeSysCpuPct: 8.5,
      activeUsrCpuPct: 40.0
    });
    const sysSess = new EtwProfilerSession();
    sysSess.attachSystemWide(kRes);
    for (const item of getSystemWideEtwTemplates()) {
      sysSess.ingestSampledProfile({
        pid: item.pid,
        tid: item.tid,
        cpu: item.cpu,
        isSystemWorker: item.isSystemWorker,
        weight: item.weight * 5,
        stack: item.stack
      });
    }
    const sysVm = buildKernelStripViewModel({
      proc: null,
      etwSession: sysSess,
      activeSysCpuPct: 6.4,
      activeUsrCpuPct: 18.2
    });
    const sysSumPct = sysVm.rows.reduce((a, r) => a + r.pctOfSys, 0);
    const sysSumCpu = sysVm.rows.reduce((a, r) => a + r.pctOfCpu, 0);
    const allFinite = sysVm.rows.every(r => Number.isFinite(r.pctOfSys) && Number.isFinite(r.pctOfCpu));
    const hasPid4Worker = sysVm.rows.some(r => r.attribution === 'System worker (PID 4)');
    check(
      'kernel_strip_empty_paused_and_system_wide_scope',
      emptyVm.empty && emptyVm.totalSamples === 0 && emptyVm.rows.length === 0 && emptyVm.emptyReason.includes('paused') &&
      sysVm.isSystemWide && !sysVm.empty && allFinite && hasPid4Worker &&
      Math.abs(sysSumPct - 100.0) <= 0.2 && Math.abs(sysSumCpu - 6.4) <= 0.2,
      `emptyPaused=${emptyVm.empty}, sysWideRows=${sysVm.rows.length}, sumSys=${sysSumPct.toFixed(1)}%, sumCpu=${sysSumCpu.toFixed(2)}%, pid4Worker=${hasPid4Worker}`
    );

    // 9. DiskIo ETW logical-vs-physical split + Rule 10a vs Rule 10b separation
    const dioAgg = new DiskIoEtwAggregator({ targetPid: 7777 });
    dioAgg.recordEvent({ pid: 7777, op: 'read', bytes: 90 * 1024 * 1024, ops: 900, latencyMs: 0.9 });
    dioAgg.recordEvent({ pid: 9999, op: 'read', bytes: 500 * 1024 * 1024, ops: 5000, latencyMs: 2.0 }); // wrong PID ignored
    const dioRates = dioAgg.getRates(1.0);

    const mkKernelSummary = (pcts, extras = {}) => ({
      targetSysSamples: extras.targetSysSamples ?? 200,
      preemptingDpcSamples: extras.preemptingDpcSamples ?? 0,
      totalKernelSamples: (extras.targetSysSamples ?? 200) + (extras.preemptingDpcSamples ?? 0),
      buckets: {
        cached_io: { pct: pcts.cached_io || 0, topDriver: extras.topCachedDriver || { name: 'ntfs.sys' } },
        av_minifilter: { pct: pcts.av_minifilter || 0, topDriver: extras.topAvDriver || null },
        physical_storage: { pct: pcts.physical_storage || 0, topDriver: extras.topStorageDriver || null },
        network_ipc: { pct: pcts.network_ipc || 0, topDriver: extras.topNetDriver || null },
        gpu_driver: { pct: pcts.gpu_driver || 0, topDriver: extras.topGpuDriver || null },
        memory_manager: { pct: pcts.memory_manager || 0, topDriver: { name: 'ntoskrnl.exe' } },
        scheduler_sync: { pct: pcts.scheduler_sync || 0, topDriver: { name: 'ntoskrnl.exe' } },
        preempting_dpc_isr: { pct: extras.preemptingDpcPct || 0, topDriver: extras.topDpcDriver || null },
        other_kernel: { pct: pcts.other_kernel || 0, topDriver: null }
      },
      topDpcDriver: extras.topDpcDriver || null,
      topAvDriver: extras.topAvDriver || null,
      topGpuDriver: extras.topGpuDriver || null,
      topStorageDriver: extras.topStorageDriver || null,
      topCachedDriver: extras.topCachedDriver || null
    });

    const mkKernelOv = (extra = {}) => {
      const base = mkAdvOv(null);
      return {
        ...base,
        avgCtxSw: 8000,
        avgSyncWaitPct: 12.0,
        ...extra,
        avg: { ...base.avg, cpuUsr: 32.0, cpuSys: 14.0, pageFaultRate: 200, ...(extra.avg || {}) }
      };
    };

    // Pure cached I/O: 120 MB/s logical (4000 ops/s), 0 MB/s physical DiskIo ETW, 48% Cc*/ntfs.sys -> Rule 10b fires, Rule 10a suppressed!
    const dCached = evaluateDiagnostics(mkKernelOv({
      avgReadMbS: 120.0,
      avgReadIops: 4000,
      avgPhysReadMbS: 0.0,
      avgPhysReadIops: 0,
      kernelSys: mkKernelSummary({ cached_io: 42.0, network_ipc: 8.0 })
    }));
    const f10b = dCached.findings.find(f => f.id === 'cached_io_pipe_syscall_overhead');
    const f10aOnCached = dCached.findings.find(f => f.id === 'disk_io_streaming_stall');

    // Physical storage streaming: 90 MB/s physical DiskIo ETW + stornvme.sys 28% + frame spikes -> Rule 10a fires, Rule 10b suppressed!
    const dPhys = evaluateDiagnostics(mkKernelOv({
      avgReadMbS: 110.0,
      avgReadIops: 1400,
      avgPhysReadMbS: dioRates.physReadMbS,
      avgPhysReadIops: dioRates.physReadIops,
      avgDiskLatMs: dioRates.avgDiskLatMs,
      spikeCorrelation: { totalSpikes: 4 },
      kernelSys: mkKernelSummary({ physical_storage: 28.0 }, { topStorageDriver: { name: 'stornvme.sys', pct: 80 } })
    }));
    const f10aPhys = dPhys.findings.find(f => f.id === 'disk_io_streaming_stall');
    const f10bOnPhys = dPhys.findings.find(f => f.id === 'cached_io_pipe_syscall_overhead');

    check(
      'disk_io_etw_logical_vs_physical_rule_10a_vs_10b',
      Math.abs(dioRates.physReadMbS - 90.0) < 0.01 && Math.abs(dioRates.avgDiskLatMs - 0.9) < 0.01 &&
      Boolean(f10b) && f10b.action.includes('64 KiB') && !f10aOnCached &&
      Boolean(f10aPhys) && f10aPhys.why.includes('stornvme.sys') && !f10bOnPhys,
      `physRate=${dioRates.physReadMbS.toFixed(0)}MB/s, 10b=${Boolean(f10b)}, 10aOnCached=${Boolean(f10aOnCached)}, 10aPhys=${Boolean(f10aPhys)}, 10bOnPhys=${Boolean(f10bOnPhys)}`
    );

    // 10. AV/Minifilter tax, GPU KMD submission overhead, Memory Manager commit thrash (Rule 7 upgrade), and Rule 2 DPC driver
    const dAv = evaluateDiagnostics(mkKernelOv({
      kernelSys: mkKernelSummary({ av_minifilter: 34.0 }, { topAvDriver: { name: 'WdFilter.sys', pct: 88 } })
    }));
    const fAv = dAv.findings.find(f => f.id === 'av_minifilter_overhead');
    const dAvLowSamples = evaluateDiagnostics(mkKernelOv({
      kernelSys: mkKernelSummary({ av_minifilter: 40.0 }, { targetSysSamples: 60, topAvDriver: { name: 'WdFilter.sys', pct: 88 } })
    }));

    const dGpuSub = evaluateDiagnostics(mkKernelOv({
      avgGpu3dPct: 58.0,
      kernelSys: mkKernelSummary({ gpu_driver: 46.0 }, { topGpuDriver: { name: 'amdkmdag.sys', pct: 62 } })
    }));
    const fGpuSub = dGpuSub.findings.find(f => f.id === 'gpu_kernel_submission_overhead');
    const dGpuSubBound = evaluateDiagnostics(mkKernelOv({
      avgGpu3dPct: 99.0,
      avgCoreC0: [55, 5, 45, 5, 30, 4, 25, 4, 15, 2, 10, 2],
      kernelSys: mkKernelSummary({ gpu_driver: 52.0 }, { topGpuDriver: { name: 'amdkmdag.sys', pct: 62 } })
    }));

    // Rule 7 Memory Manager commit thrash: Mi*/Mm* >= 40% + high soft faults even with sysSharePct < 20% (avgSys=10, avgUsr=60 -> 14.3%)
    const dMmThrash = evaluateDiagnostics(mkKernelOv({
      avg: { cpuUsr: 60.0, cpuSys: 10.0, pageFaultRate: 3200 },
      kernelSys: mkKernelSummary({ memory_manager: 48.0 })
    }));
    const fMmThrash = dMmThrash.findings.find(f => f.id === 'kernel_page_fault_churn');

    // Rule 2 DPC/IRQ collision names offending .sys driver isolated above KiRetireDpcList
    const hotDpc = new Array(12).fill(0.2); hotDpc[0] = 6.5;
    const hotIrq = new Array(12).fill(0.2); hotIrq[0] = 2.2;
    const dDpcDrv = evaluateDiagnostics(mkKernelOv({
      avgCoreDpc: hotDpc,
      avgCoreIrq: hotIrq,
      kernelSys: mkKernelSummary({ scheduler_sync: 20.0 }, {
        preemptingDpcSamples: 45,
        preemptingDpcPct: 18.0,
        topDpcDriver: { name: 'e1d68x64.sys', pct: 92.0, samples: 41 }
      })
    }));
    const fDpcDrv = dDpcDrv.findings.find(f => f.id === 'dpc_irq_collision');

    // 10b. Advisor syscall isolation guard: noisy DPC/ISR driver (300 samples) must NOT pollute syscall-only rules
    const noisyDpcSess = new EtwProfilerSession();
    noisyDpcSess.attach(7777, kRes);
    // Only 50 non-DPC syscall samples (all in amdkmdag.sys) + 300 preempting USBXHCI.sys DPC samples = 350 total
    // Even though totalKernelSamples = 350 >= 100, non-DPC targetSysSamples = 50 < 100 -> GPU submission rule MUST NOT fire!
    noisyDpcSess.ingestSampledProfile({
      pid: 7777, tid: 101, cpu: 2, weight: 50,
      stack: [userFrame, { va: 0xFFFFF80040412040n }, { va: 0xFFFFF80047048040n }, { va: 0xFFFFF80048110040n }]
    });
    noisyDpcSess.ingestSampledProfile({
      pid: 7777, tid: 101, cpu: 0, weight: 300,
      stack: [userFrame, { va: 0xFFFFF80040240040n }, { va: 0xFFFFF8004E014040n }]
    });
    const dNoisyDpcGuard = evaluateDiagnostics(mkKernelOv({
      avgGpu3dPct: 50.0,
      kernelSys: noisyDpcSess.kernelSys.getSummary({ activeSysCpuPct: 14.0, isSystemWide: false })
    }));
    // And when targetSysSamples = 120 (30 GPU KMD = 25% of syscalls + 90 scheduler = 75%) + 300 DPC samples:
    // GPU syscallOnlySharePct = 25% (<40%) -> still MUST NOT fire GPU submission rule!
    const noisyDpcLowShareSess = new EtwProfilerSession();
    noisyDpcLowShareSess.attach(7777, kRes);
    noisyDpcLowShareSess.ingestSampledProfile({
      pid: 7777, tid: 101, cpu: 2, weight: 30,
      stack: [userFrame, { va: 0xFFFFF80040412040n }, { va: 0xFFFFF80047048040n }, { va: 0xFFFFF80048110040n }]
    });
    noisyDpcLowShareSess.ingestSampledProfile({
      pid: 7777, tid: 101, cpu: 2, weight: 90,
      stack: [userFrame, { va: 0xFFFFF80040412040n }, { va: 0xFFFFF80040380040n }, { va: 0xFFFFF80040382040n }]
    });
    noisyDpcLowShareSess.ingestSampledProfile({
      pid: 7777, tid: 101, cpu: 0, weight: 300,
      stack: [userFrame, { va: 0xFFFFF80040240040n }, { va: 0xFFFFF8004E014040n }]
    });
    const dNoisyDpcLowShare = evaluateDiagnostics(mkKernelOv({
      avgGpu3dPct: 50.0,
      kernelSys: noisyDpcLowShareSess.kernelSys.getSummary({ activeSysCpuPct: 14.0, isSystemWide: false })
    }));

    check(
      'kernel_sys_rules_av_gpu_mm_and_dpc_driver',
      Boolean(fAv) && fAv.title.includes('WdFilter.sys') &&
      !dAvLowSamples.findings.some(f => f.id === 'av_minifilter_overhead') &&
      Boolean(fGpuSub) && fGpuSub.title.includes('amdkmdag.sys') &&
      !dGpuSubBound.findings.some(f => f.id === 'gpu_kernel_submission_overhead') &&
      Boolean(fMmThrash) && fMmThrash.mmConfirmed === true && fMmThrash.title.includes('Mi*/Mm*') &&
      Boolean(fDpcDrv) && fDpcDrv.title.includes('e1d68x64.sys') && fDpcDrv.why.includes('KiRetireDpcList') &&
      !dNoisyDpcGuard.findings.some(f => f.id === 'gpu_kernel_submission_overhead') &&
      !dNoisyDpcLowShare.findings.some(f => f.id === 'gpu_kernel_submission_overhead'),
      `av=${fAv?.title?.includes('WdFilter.sys')}, gpuSub=${Boolean(fGpuSub)}, gpuBoundSup=${!dGpuSubBound.findings.some(f => f.id === 'gpu_kernel_submission_overhead')}, mmConf=${Boolean(fMmThrash?.mmConfirmed)}, dpcDrv=${fDpcDrv?.title?.includes('e1d68x64.sys')}, noisyDpcIsolated=${!dNoisyDpcGuard.findings.some(f => f.id === 'gpu_kernel_submission_overhead')}`
    );

    const passed = results.filter(r => r.pass).length;
    return { passed, total: results.length, results, _coordPromise: coordPromise };
  }

  // Extend runAllDiagnosticTests to also include Tab 7 Profiler unit tests
  const prevRunAll = Z.runAllDiagnosticTests;
  function runAllDiagnosticTests() {
    const base = typeof prevRunAll === 'function' ? prevRunAll() : { passed: 0, total: 0, results: [] };
    const prof = runProfilerTests();
    const results = [...base.results, ...prof.results];
    return {
      passed: base.passed + prof.passed,
      total: base.total + prof.total,
      results
    };
  }

  Object.assign(Z, { runProfilerTests, runAllDiagnosticTests });
})();
