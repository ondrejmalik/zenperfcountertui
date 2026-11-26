// Simulated Win32 processes, workload profiles, and baseline presets
(() => {
  'use strict';
  const Z = window.Zen2Top || (window.Zen2Top = {});

  // =========================================================================
  // 2. SIMULATED WIN32 PROCESSES & WORKLOAD PROFILES
  // =========================================================================
  const PROTECTED_DRIVERS = new Set([
    'ntdll.dll', 'kernel32.dll', 'kernelbase.dll', 'ucrtbase.dll',
    'nvoglv64.dll', 'amdxc64.dll', 'dxil.dll', 'd3d11.dll', 'vulkan-1.dll'
  ]);

  function makeMod(name, sizeMiB, lp, ifeo, prot, shared, baseBig) {
    return {
      name, sizeMiB, lp, ifeo, prot, shared,
      base: baseBig,
      protectedDriver: PROTECTED_DRIVERS.has(name.toLowerCase()),
      sessionToggled: false
    };
  }

  function buildArenas(gbCount, fillProfile, osArenaProfiles = []) {
    const hugeArenas = [];
    for (let g = 0; g < gbCount; g++) {
      const inuse = [];
      const touched = [];
      const activeTarget = fillProfile[g] ?? 20;
      const peakTarget = Math.min(32, activeTarget + (activeTarget >= 31 ? 1 : 3 + (g % 2)));
      for (let b = 0; b < 32; b++) {
        inuse.push(b < activeTarget ? 1 : 0);
        touched.push(b < peakTarget ? 1 : 0);
      }
      hugeArenas.push({
        gbIndex: g + 1,
        addr: 0x0001A4000000n + BigInt(g) * 0x40000000n,
        inuse,
        touched
      });
    }
    const osArenas = osArenaProfiles.map((spec, idx) => ({
      index: idx + 1,
      addr: 0x0002E8000000n + BigInt(idx) * 0x40000000n,
      blockCount: spec.blocks,
      inuseCount: spec.inuse,
      touchedCount: Math.min(spec.blocks, spec.touched)
    }));
    return { hugeArenas, osArenas };
  }

  const SOURCE2_DLLS = [
    ['client.dll', 68.42, 0x7FFA12000000n, true],
    ['server.dll', 54.18, 0x7FFA0A000000n, true],
    ['v8.dll', 41.60, 0x7FFA06000000n, true],
    ['rendersystemvulkan.dll', 26.85, 0x7FFA03000000n, true],
    ['engine2.dll', 24.12, 0x7FFA00000000n, true],
    ['nvoglv64.dll', 58.90, 0x7FF9F4000000n, false],
    ['panorama.dll', 19.74, 0x7FF9F1000000n, true],
    ['particles.dll', 16.40, 0x7FF9EE000000n, true],
    ['scenesystem.dll', 15.10, 0x7FF9EC000000n, true],
    ['animationsystem.dll', 13.85, 0x7FF9EA000000n, true],
    ['vphysics2.dll', 12.20, 0x7FF9E8000000n, true],
    ['phonon.dll', 11.45, 0x7FF9E6000000n, true],
    ['soundsystem.dll', 9.80, 0x7FF9E4000000n, true],
    ['steamnetworkingsockets.dll', 8.65, 0x7FF9E2000000n, true],
    ['networksystem.dll', 7.40, 0x7FF9E0000000n, true],
    ['tier0.dll', 6.12, 0x7FF9DE000000n, true],
    ['deadlock.exe', 4.35, 0x7FF7B2000000n, true],
    ['dxil.dll', 14.55, 0x7FF9DA000000n, false],
    ['ucrtbase.dll', 4.30, 0x7FFA81200000n, false]
  ];

  function makeThread(tid, description, startAddress, baseCpuPct, baseCtxSw, stateStr, waitReason, basePriority, currentCpu, idealCpu, affinityMask = 0x0FFF) {
    return {
      tid,
      description,
      startAddress,
      baseCpuPct,
      cpuPct: baseCpuPct,
      baseCtxSw,
      ctxSwPerSec: baseCtxSw,
      state: stateStr,
      waitReason,
      basePriority,
      currentCpu,
      idealCpu: idealCpu ?? currentCpu,
      affinityMask
    };
  }

  function buildSource2Threads(pidBase, smtHot = true) {
    return [
      makeThread(pidBase + 4,  'MainThread',       0x7FF7B2012400n, 78.4, 2420, 'Running', '-',          10, 0, 0, 0x0FFF),
      makeThread(pidBase + 12, 'RenderThread',     0x7FFA03048810n, smtHot ? 58.6 : 54.2, 3180, 'Running', '-',          10, smtHot ? 1 : 2, smtHot ? 1 : 2, 0x0FFF),
      makeThread(pidBase + 20, '',                 0x7FFA1201A420n, 42.1, 1890, 'Running', '-',           8, 2, 2, 0x0FFF),
      makeThread(pidBase + 28, 'V8JsWorker',       0x7FFA06092C00n, 29.8, 1460, 'Ready',   'WrQueue',     8, 4, 4, 0x0FFF),
      makeThread(pidBase + 36, '',                 0x7FFA0004F810n, 24.5, 2140, 'Waiting', 'WrQueue',     8, 6, 6, 0x0FFF),
      makeThread(pidBase + 44, 'JobWorker#0',      0x7FFA0A081200n, 18.2, 1620, 'Waiting', 'UserRequest', 8, 4, 4, 0x0FFF),
      makeThread(pidBase + 52, 'JobWorker#1',      0x7FFA0A081200n, 15.6, 1380, 'Waiting', 'UserRequest', 8, 6, 6, 0x0FFF),
      makeThread(pidBase + 60, 'AudioMixThread',   0x7FF9E402B100n,  7.4,  680, 'Waiting', 'DelayExec',  11, 8, 8, 0x0FFF),
      makeThread(pidBase + 68, 'NetworkSocket',    0x7FF9E2019440n,  5.2,  940, 'Waiting', 'WrQueue',     9, 10, 10, 0x0FFF),
      makeThread(pidBase + 76, '',                 0x7FF9F4120880n,  9.8, 1120, 'Waiting', 'EventPair',  10, 3, 3, 0x0FFF)
    ];
  }

  function makeWin32Profile(overrides = {}) {
    const baseDpc = [0.6, 0.2, 0.4, 0.2, 0.3, 0.1, 0.4, 0.2, 0.3, 0.1, 0.2, 0.1];
    const baseIrq = [0.4, 0.1, 0.2, 0.1, 0.2, 0.1, 0.2, 0.1, 0.2, 0.1, 0.1, 0.1];
    const baseIrqRate = [920, 310, 540, 280, 460, 220, 510, 260, 410, 210, 320, 190];
    return {
      gpu3dPct: 72.0,
      gpuProc3dPct: 68.0,
      coreDpcPct: overrides.coreDpcPct ? [...overrides.coreDpcPct] : baseDpc,
      coreIrqPct: overrides.coreIrqPct ? [...overrides.coreIrqPct] : baseIrq,
      coreIrqPerSec: overrides.coreIrqPerSec ? [...overrides.coreIrqPerSec] : baseIrqRate,
      noisyNeighbors: overrides.noisyNeighbors
        ? overrides.noisyNeighbors.map(x => ({ ...x }))
        : [
            { name: 'dwm.exe', pid: 1188, sysCpuPct: 1.2 },
            { name: 'Discord.exe', pid: 8824, sysCpuPct: 0.9 }
          ],
      ctxSwPerSec: 12400,
      syncWaitPct: 16.0,
      topWaitReason: 'WrQueue',
      priorityClass: 'NORMAL',
      ecoQos: 'Inactive',
      hardPageReadsPerSec: 0.0,
      availPhysPct: 48.0,
      commitPct: 46.0,
      seLockMemoryPrivilege: 'Present',
      ...overrides
    };
  }

  const PROCESSES = [
    {
      pid: 14820,
      name: 'deadlock.exe',
      tag: 'IFEO 2MiB + SMT Hot',
      allocatorType: 'tier0_mimalloc',
      allocatorLabel: 'tier0.dll (mimalloc v2) + IFEO 2MiB',
      crtProfile: {
        kind: 'already_mimalloc',
        crt: 'tier0_mimalloc',
        linkageLabel: 'tier0.dll (Embedded Mimalloc v2) + /MD ucrtbase.dll',
        hookedModules: ['tier0.dll', 'ucrtbase.dll']
      },
      wsMiB: 1640,
      sharedMiB: 412,
      hugeMiB: 4096,
      requestedHugeMiB: 4096,
      commitMiB: 6180,
      peakWsMiB: 2140,
      peakCommitMiB: 6320,
      pageFaults: 1482910,
      userSec: 1842.6,
      sysSec: 214.3,
      elapsedSec: 712.4,
      ifeoEnabled: true,
      ifeoMasterSessionToggled: false,
      affinityMask: 0x0FFF,
      modules: SOURCE2_DLLS.map(([n, s, b, isS2]) => makeMod(n, s, isS2, isS2, 'RX', !isS2, b)),
      arenas: buildArenas(4, [31, 29, 24, 14], []),
      heapStats: {
        normal:    { peak: 2980, total: 18420, current: 2610 },
        huge:      { peak: 4096, total: 4096,  current: 4096 },
        reserved:  { peak: 4096, total: 4096,  current: 4096 },
        committed: { peak: 3420, total: 4210,  current: 3230 },
        touched:   { peak: 3552, total: 3552,  current: 3136 },
        segments:  { peak: 112,  total: 184,   current: 98, isCount: true },
        pages:     { peak: 24180, total: 91200, current: 20790, isCount: true },
        softReset: 412
      },
      win32Profile: makeWin32Profile({
        gpu3dPct: 72.0,
        gpuProc3dPct: 68.0,
        hardPageReadsPerSec: 0.0,
        availPhysPct: 46.0,
        commitPct: 49.0,
        seLockMemoryPrivilege: 'Present'
      }),
      protectedProcess: false,
      threads: buildSource2Threads(14820, true),
      presentProfile: {
        baseFrameMs: 6.94,
        jitterRel: 0.11,
        presentMode: 'Hardware: Independent Flip',
        composedShare: 0.0,
        spikeChance: 0.012,
        spikeMultiplier: 2.2
      },
      vaProfile: {
        privateJit4kMiB: 14.2,
        jitProtect: 'RWX',
        mapped4kMiB: 268
      },
      ioProfile: {
        readMbS: 4.2,
        writeMbS: 0.8,
        readIops: 95,
        writeIops: 18
      },
      pmuProfile: {
        effGhz: 4.22, ipc: 1.28,
        l1dc: 31.4, l2dc: 8.6, l1ic: 11.2, l2ic: 1.75,
        demL3: 3.45, hwpfL3: 1.40, demDram: 1.28, hwpfDram: 0.44,
        l2pfL3: 1.10, l2pfDram: 0.38,
        l3Acc: 10.6, l3Miss: 1.88, l3LatCyc: 212,
        br: 158.0, brMiss: 3.40, brMissPct: 2.85,
        l1ItlbMissPct: 0.28, l2Itlb: 0.09, l1Dtlb: 0.95, l2Dtlb: 0.14,
        dcCrossCcx: 2.45, locksSerial: 0.78, opcacheHitPct: 76.5, stlfInterlock: 3.85, misalAccess: 12.4,
        pfRate: 185, cpuUsr: 46.2, cpuSys: 4.8,
        // P0 hot SMT contention (82% + 26%), P4/P5 spare (<20%) -> fires Rule 3
        coreC0: [82, 26, 61, 4, 48, 3, 52, 6, 12, 2, 8, 1]
      }
    },
    {
      pid: 19204,
      name: 'deadlock.exe',
      tag: '4K Default (No IFEO)',
      allocatorType: 'tier0_mimalloc',
      allocatorLabel: 'tier0.dll (mimalloc v2) - 4K Spillover',
      crtProfile: {
        kind: 'already_mimalloc',
        crt: 'tier0_mimalloc',
        linkageLabel: 'tier0.dll (Embedded Mimalloc v2)',
        hookedModules: ['tier0.dll']
      },
      wsMiB: 2890,
      sharedMiB: 440,
      hugeMiB: 2048,
      requestedHugeMiB: 2048,
      commitMiB: 5410,
      peakWsMiB: 3490,
      peakCommitMiB: 5620,
      pageFaults: 4210880,
      userSec: 1204.2,
      sysSec: 198.7,
      elapsedSec: 504.1,
      ifeoEnabled: false,
      ifeoMasterSessionToggled: false,
      affinityMask: 0x0FFF,
      modules: SOURCE2_DLLS.slice(0, 12).map(([n, s, b]) => makeMod(n, s, false, false, 'RX', true, b)),
      arenas: buildArenas(2, [32, 30], [{ blocks: 32, inuse: 23, touched: 28 }, { blocks: 16, inuse: 9, touched: 12 }]),
      heapStats: {
        normal:    { peak: 3120, total: 22100, current: 2860 },
        huge:      { peak: 2048, total: 2048,  current: 1984 },
        reserved:  { peak: 3584, total: 3584,  current: 3584 },
        committed: { peak: 3340, total: 6810,  current: 3030 },
        touched:   { peak: 3328, total: 3328,  current: 3008 },
        segments:  { peak: 128,  total: 240,   current: 108, isCount: true },
        pages:     { peak: 26800, total: 118400, current: 23300, isCount: true },
        softReset: 620
      },
      win32Profile: makeWin32Profile({
        gpu3dPct: 76.0,
        gpuProc3dPct: 73.0,
        hardPageReadsPerSec: 0.4,
        availPhysPct: 44.0,
        commitPct: 52.0,
        seLockMemoryPrivilege: 'Present'
      }),
      protectedProcess: false,
      threads: buildSource2Threads(19204, false),
      presentProfile: {
        baseFrameMs: 8.65,
        jitterRel: 0.14,
        presentMode: 'Composed: Flip',
        composedShare: 0.92,
        spikeChance: 0.02,
        spikeMultiplier: 2.1
      },
      vaProfile: {
        privateJit4kMiB: 11.6,
        jitProtect: 'RWX',
        mapped4kMiB: 290
      },
      ioProfile: {
        readMbS: 8.4,
        writeMbS: 1.2,
        readIops: 180,
        writeIops: 24
      },
      pmuProfile: {
        effGhz: 4.19, ipc: 1.15,
        l1dc: 33.8, l2dc: 9.8, l1ic: 12.1, l2ic: 1.95,
        demL3: 3.60, hwpfL3: 1.25, demDram: 1.82, hwpfDram: 0.56,
        l2pfL3: 1.05, l2pfDram: 0.42,
        l3Acc: 11.4, l3Miss: 2.48, l3LatCyc: 224,
        br: 160.0, brMiss: 3.65, brMissPct: 3.05,
        l1ItlbMissPct: 2.15, l2Itlb: 0.84, l1Dtlb: 2.40, l2Dtlb: 0.68,
        dcCrossCcx: 1.35, locksSerial: 0.32, opcacheHitPct: 74.0, stlfInterlock: 2.15, misalAccess: 8.2,
        pfRate: 1450, cpuUsr: 44.5, cpuSys: 9.2,
        coreC0: [76, 8, 58, 6, 42, 4, 49, 5, 34, 4, 21, 2]
      }
    },
    {
      pid: 27408,
      name: 'cs2.exe',
      tag: 'IFEO Priv Missing + DPC/IRQ HI',
      allocatorType: 'tier0_mimalloc',
      allocatorLabel: 'tier0.dll (mimalloc v2) - IFEO Fault',
      crtProfile: {
        kind: 'blocked_guardrail',
        crt: 'tier0_mimalloc',
        protected: true,
        linkageLabel: 'Protected Source 2 (tier0.dll + VAC Guardrail)',
        hookedModules: ['tier0.dll']
      },
      wsMiB: 2610,
      sharedMiB: 380,
      hugeMiB: 1024,
      requestedHugeMiB: 1024,
      commitMiB: 4520,
      peakWsMiB: 3110,
      peakCommitMiB: 4700,
      pageFaults: 3190440,
      userSec: 890.1,
      sysSec: 142.4,
      elapsedSec: 390.2,
      ifeoEnabled: true,
      ifeoMasterSessionToggled: false,
      affinityMask: 0x0FFF,
      modules: [
        makeMod('client.dll', 58.20, false, true, 'RX', true, 0x7FF811040000n),
        makeMod('engine2.dll', 19.40, false, true, 'RX', true, 0x7FF819080000n),
        makeMod('scenesystem.dll', 17.80, false, true, 'RX', true, 0x7FF81E040000n),
        makeMod('tier0.dll', 6.10, false, true, 'RX', false, 0x7FF821000000n),
        makeMod('dxil.dll', 16.50, false, false, 'RX', true, 0x7FF844000000n),
        makeMod('nvoglv64.dll', 58.90, false, false, 'RX', true, 0x7FF849000000n)
      ],
      arenas: buildArenas(1, [31], [{ blocks: 32, inuse: 27, touched: 30 }]),
      heapStats: {
        normal:    { peak: 2150, total: 14100, current: 1890 },
        huge:      { peak: 1024, total: 1024,  current: 992 },
        reserved:  { peak: 2048, total: 2048,  current: 2048 },
        committed: { peak: 1980, total: 4210,  current: 1820 },
        touched:   { peak: 1984, total: 1984,  current: 1856 },
        segments:  { peak: 72,   total: 140,   current: 62, isCount: true },
        pages:     { peak: 16200, total: 72400, current: 14100, isCount: true },
        softReset: 310
      },
      win32Profile: makeWin32Profile({
        gpu3dPct: 81.0,
        gpuProc3dPct: 78.0,
        // C00 is hot (64% C0) with 8.6% DPC+IRQ -> fires dpc_irq_collision (HI)
        coreDpcPct: [6.2, 0.3, 0.5, 0.2, 0.4, 0.1, 0.5, 0.2, 0.3, 0.1, 0.2, 0.1],
        coreIrqPct: [2.4, 0.2, 0.3, 0.1, 0.2, 0.1, 0.3, 0.1, 0.2, 0.1, 0.1, 0.1],
        coreIrqPerSec: [4820, 410, 560, 290, 480, 240, 520, 260, 400, 210, 310, 190],
        hardPageReadsPerSec: 0.6,
        availPhysPct: 41.0,
        commitPct: 54.0,
        seLockMemoryPrivilege: 'Missing'
      }),
      protectedProcess: true,
      threads: [
        makeThread(27412, 'MainThread',     0x7FF811022180n, 64.0, 2850, 'Running', '-',          10, 0, 0, 0x0FFF),
        makeThread(27420, 'RenderThread',   0x7FF819044B20n, 56.2, 2640, 'Running', '-',          10, 2, 2, 0x0FFF),
        makeThread(27428, '',               0x7FF81101A420n, 38.4, 1940, 'Running', '-',           8, 4, 4, 0x0FFF),
        makeThread(27436, 'SceneWorker#0',  0x7FF81E03C900n, 31.2, 1620, 'Waiting', 'WrQueue',     8, 6, 6, 0x0FFF),
        makeThread(27444, '',               0x7FF849108400n, 14.5, 1180, 'Waiting', 'EventPair',  10, 8, 8, 0x0FFF),
        makeThread(27452, 'AudioEngine',    0x7FF821011200n,  6.1,  540, 'Waiting', 'DelayExec',  11, 10, 10, 0x0FFF)
      ],
      presentProfile: {
        baseFrameMs: 5.40,
        jitterRel: 0.10,
        presentMode: 'Hardware: Independent Flip',
        composedShare: 0.0,
        spikeChance: 0.09,
        spikeMultiplier: 3.6,
        spikeCulprit: 'dpc_irq'
      },
      vaProfile: {
        privateJit4kMiB: 2.4,
        jitProtect: 'RX',
        mapped4kMiB: 240
      },
      ioProfile: {
        readMbS: 6.5,
        writeMbS: 0.9,
        readIops: 140,
        writeIops: 22
      },
      pmuProfile: {
        effGhz: 3.64, ipc: 0.94,
        l1dc: 38.0, l2dc: 12.8, l1ic: 10.6, l2ic: 1.85,
        demL3: 4.10, hwpfL3: 2.05, demDram: 2.35, hwpfDram: 1.65,
        l2pfL3: 1.45, l2pfDram: 0.95,
        l3Acc: 15.2, l3Miss: 4.35, l3LatCyc: 308,
        br: 152.0, brMiss: 3.90, brMissPct: 3.10,
        l1ItlbMissPct: 1.92, l2Itlb: 0.72, l1Dtlb: 2.20, l2Dtlb: 0.58,
        dcCrossCcx: 2.10, locksSerial: 1.25, opcacheHitPct: 67.5, stlfInterlock: 4.60, misalAccess: 24.8,
        pfRate: 1120, cpuUsr: 52.0, cpuSys: 8.5,
        coreC0: [64, 12, 58, 8, 41, 6, 48, 9, 32, 4, 24, 3]
      }
    },
    {
      pid: 31088,
      name: 'rustc.exe',
      tag: 'CRT + Branch / I-Cache / Soft PF',
      allocatorType: 'crt_fallback',
      allocatorLabel: 'ucrtbase.dll (Layer 1 OS Fallback)',
      crtProfile: {
        kind: 'eligible',
        crt: 'dynamic_md',
        linkageLabel: 'Rust std::alloc::System (HeapAlloc) + /MD ucrtbase.dll',
        hookedModules: ['ucrtbase.dll', 'rustc_driver-8a91c.dll', 'LLVM-19.dll', 'std-rust.dll']
      },
      wsMiB: 1940,
      sharedMiB: 190,
      hugeMiB: 0,
      requestedHugeMiB: 0,
      commitMiB: 2680,
      peakWsMiB: 2310,
      peakCommitMiB: 2940,
      pageFaults: 8940120,
      userSec: 94.6,
      sysSec: 34.8,
      elapsedSec: 28.4,
      ifeoEnabled: false,
      ifeoMasterSessionToggled: false,
      affinityMask: 0x0FFF,
      modules: [
        makeMod('rustc_driver-8a91c.dll', 146.20, false, false, 'RX', true, 0x7FF7E0000000n),
        makeMod('LLVM-19.dll', 98.40, false, false, 'RX', true, 0x7FF7EA000000n),
        makeMod('std-rust.dll', 9.80, false, false, 'RX', true, 0x7FF7F4000000n),
        makeMod('rustc.exe', 4.10, false, false, 'RX', true, 0x7FF714000000n),
        makeMod('ucrtbase.dll', 4.30, false, false, 'RX', true, 0x7FF981200000n)
      ],
      arenas: null,
      heapStats: null,
      win32Profile: makeWin32Profile({
        gpu3dPct: 4.0,
        gpuProc3dPct: 0.0,
        // High soft faults (4180/s) but low disk hard faults (1.2/s); ctx sw suppressed by avgC0 >= 85%
        hardPageReadsPerSec: 1.2,
        availPhysPct: 38.0,
        commitPct: 58.0,
        ctxSwPerSec: 58000,
        syncWaitPct: 44.0,
        topWaitReason: 'WrExecutive',
        seLockMemoryPrivilege: 'Present'
      }),
      protectedProcess: false,
      threads: [
        makeThread(31092, 'rustc',          0x7FF7E0041100n, 92.0, 8200, 'Running', '-',           8, 0, 0, 0x0FFF),
        makeThread(31096, 'LLVM-Codegen#0', 0x7FF7EA128400n, 89.5, 7600, 'Running', '-',           8, 2, 2, 0x0FFF),
        makeThread(31100, 'LLVM-Codegen#1', 0x7FF7EA128400n, 88.2, 7400, 'Running', '-',           8, 4, 4, 0x0FFF),
        makeThread(31104, 'LLVM-Codegen#2', 0x7FF7EA128400n, 87.6, 7100, 'Running', '-',           8, 6, 6, 0x0FFF),
        makeThread(31108, '',               0x7FF7E029A800n, 86.4, 6800, 'Running', '-',           8, 8, 8, 0x0FFF),
        makeThread(31112, '',               0x7FF7E029A800n, 85.1, 6400, 'Ready',   'WrExecutive', 8, 10, 10, 0x0FFF)
      ],
      presentProfile: null, // CLI compiler: no Present ETW stream (graceful None)
      vaProfile: {
        privateJit4kMiB: 1.2,
        jitProtect: 'RX',
        mapped4kMiB: 140
      },
      ioProfile: {
        readMbS: 38.0,
        writeMbS: 24.5,
        readIops: 620,
        writeIops: 410
      },
      pmuProfile: {
        effGhz: 4.14, ipc: 1.06,
        l1dc: 26.5, l2dc: 6.4, l1ic: 18.6, l2ic: 3.85,
        demL3: 2.85, hwpfL3: 0.90, demDram: 1.05, hwpfDram: 0.35,
        l2pfL3: 0.80, l2pfDram: 0.25,
        l3Acc: 8.8, l3Miss: 1.55, l3LatCyc: 210,
        br: 192.0, brMiss: 7.45, brMissPct: 4.65,
        l1ItlbMissPct: 1.35, l2Itlb: 0.42, l1Dtlb: 2.95, l2Dtlb: 0.86,
        dcCrossCcx: 0.42, locksSerial: 1.18, opcacheHitPct: 61.8, stlfInterlock: 4.20, misalAccess: 22.5,
        pfRate: 4180, cpuUsr: 58.0, cpuSys: 21.5,
        // All 6 physical cores >85% saturated -> tests Rule 3 SMT & Rule 7 CtxSw suppression
        coreC0: [92, 88, 91, 86, 89, 87, 93, 89, 90, 86, 88, 86]
      }
    },
    {
      pid: 22910,
      name: 'blender.exe',
      tag: 'Generic Mimalloc (Healthy)',
      allocatorType: 'generic_mimalloc',
      allocatorLabel: 'mimalloc.dll (Generic v2)',
      crtProfile: {
        kind: 'already_mimalloc',
        crt: 'generic_mimalloc',
        linkageLabel: 'mimalloc.dll (Generic v2)',
        hookedModules: ['mimalloc.dll']
      },
      wsMiB: 2420,
      sharedMiB: 310,
      hugeMiB: 2048,
      requestedHugeMiB: 2048,
      commitMiB: 4610,
      peakWsMiB: 2880,
      peakCommitMiB: 4820,
      pageFaults: 912300,
      userSec: 3412.8,
      sysSec: 118.4,
      elapsedSec: 640.0,
      ifeoEnabled: false,
      ifeoMasterSessionToggled: false,
      affinityMask: 0x0FFF,
      modules: [
        makeMod('blender.exe', 112.40, false, false, 'RX', false, 0x7FF610000000n),
        makeMod('cycles_kernel.dll', 42.10, false, false, 'RX', true, 0x7FF850000000n),
        makeMod('embree4.dll', 36.20, false, false, 'RX', true, 0x7FF854000000n),
        makeMod('mimalloc.dll', 4.60, false, false, 'RX', true, 0x7FF858000000n),
        makeMod('nvoglv64.dll', 58.90, false, false, 'RX', true, 0x7FF860000000n)
      ],
      arenas: buildArenas(2, [24, 16], []),
      heapStats: {
        normal:    { peak: 1680, total: 8420, current: 1320 },
        huge:      { peak: 2048, total: 2048, current: 2048 },
        reserved:  { peak: 2048, total: 2048, current: 2048 },
        committed: { peak: 1820, total: 2400, current: 1620 },
        touched:   { peak: 1472, total: 1472, current: 1280 },
        segments:  { peak: 54,   total: 96,   current: 44, isCount: true },
        pages:     { peak: 12400, total: 42100, current: 10900, isCount: true },
        softReset: 210
      },
      win32Profile: makeWin32Profile({
        gpu3dPct: 14.0,
        gpuProc3dPct: 11.0,
        hardPageReadsPerSec: 0.0,
        availPhysPct: 52.0,
        commitPct: 44.0,
        seLockMemoryPrivilege: 'Present'
      }),
      protectedProcess: false,
      threads: [
        makeThread(22914, 'CyclesRender#0', 0x7FF850018200n, 88.0,  920, 'Running', '-', 8, 0, 0, 0x0FFF),
        makeThread(22918, 'CyclesRender#1', 0x7FF850018200n, 87.2,  890, 'Running', '-', 8, 2, 2, 0x0FFF),
        makeThread(22922, 'CyclesRender#2', 0x7FF850018200n, 86.8,  860, 'Running', '-', 8, 4, 4, 0x0FFF),
        makeThread(22926, 'EmbreeBVH',      0x7FF85402C100n, 84.5,  780, 'Running', '-', 8, 6, 6, 0x0FFF),
        makeThread(22930, 'BlenderUI',      0x7FF610052A00n, 14.2, 1120, 'Waiting', 'UserRequest', 8, 8, 8, 0x0FFF)
      ],
      presentProfile: {
        baseFrameMs: 16.67,
        jitterRel: 0.04,
        presentMode: 'Hardware: Legacy Flip',
        composedShare: 0.0,
        spikeChance: 0.0,
        spikeMultiplier: 1.2
      },
      vaProfile: {
        privateJit4kMiB: 2.8,
        jitProtect: 'RX',
        mapped4kMiB: 210
      },
      ioProfile: {
        readMbS: 12.0,
        writeMbS: 6.4,
        readIops: 210,
        writeIops: 95
      },
      pmuProfile: {
        effGhz: 4.24, ipc: 2.18,
        l1dc: 18.2, l2dc: 3.6, l1ic: 6.4, l2ic: 0.72,
        demL3: 1.50, hwpfL3: 0.90, demDram: 0.55, hwpfDram: 0.35,
        l2pfL3: 0.65, l2pfDram: 0.22,
        l3Acc: 5.2, l3Miss: 0.95, l3LatCyc: 196,
        br: 112.0, brMiss: 1.45, brMissPct: 1.40,
        l1ItlbMissPct: 0.22, l2Itlb: 0.06, l1Dtlb: 0.62, l2Dtlb: 0.09,
        dcCrossCcx: 0.18, locksSerial: 0.06, opcacheHitPct: 89.4, stlfInterlock: 0.95, misalAccess: 3.8,
        pfRate: 210, cpuUsr: 64.0, cpuSys: 3.1,
        coreC0: [88, 86, 89, 87, 90, 88, 89, 86, 87, 86, 88, 86]
      }
    },
    {
      pid: 6104,
      name: 'chrome.exe',
      tag: 'Cross-CCX + EcoQoS Throttled',
      allocatorType: 'crt_fallback',
      allocatorLabel: 'PartitionAlloc (Layer 1 OS Fallback)',
      crtProfile: {
        kind: 'custom_allocator',
        crt: 'custom',
        linkageLabel: 'PartitionAlloc (chrome.dll on VirtualAlloc)',
        runtimeHint: 'Use Chromium PartitionAlloc flags; rminject skipped'
      },
      wsMiB: 1180,
      sharedMiB: 310,
      hugeMiB: 0,
      requestedHugeMiB: 0,
      commitMiB: 1520,
      peakWsMiB: 1410,
      peakCommitMiB: 1740,
      pageFaults: 984120,
      userSec: 412.1,
      sysSec: 68.5,
      elapsedSec: 3840.0,
      ifeoEnabled: false,
      ifeoMasterSessionToggled: false,
      affinityMask: 0x0FFF,
      modules: [
        makeMod('chrome.dll', 214.80, false, false, 'RX', true, 0x7FF940000000n),
        makeMod('libglesv2.dll', 11.40, false, false, 'RX', true, 0x7FF93A000000n),
        makeMod('vk_swiftshader.dll', 9.10, false, false, 'RX', true, 0x7FF936000000n),
        makeMod('chrome_elf.dll', 5.20, false, false, 'RX', true, 0x7FF93E000000n)
      ],
      arenas: null,
      heapStats: null,
      win32Profile: makeWin32Profile({
        gpu3dPct: 22.0,
        gpuProc3dPct: 14.0,
        priorityClass: 'BELOW_NORMAL',
        ecoQos: 'Active',
        hardPageReadsPerSec: 0.8,
        availPhysPct: 45.0,
        commitPct: 48.0,
        seLockMemoryPrivilege: 'Present'
      }),
      protectedProcess: false,
      threads: [
        makeThread(6108, 'CrRendererMain',  0x7FF94014A200n, 42.0, 2180, 'Running', '-',          6, 0, 0, 0x0FFF),
        makeThread(6112, 'Compositor',      0x7FF94022C410n, 34.0, 1840, 'Running', '-',          6, 2, 2, 0x0FFF),
        makeThread(6116, 'V8TurboFan',      0x7FF94088F100n, 38.0, 1420, 'Running', '-',          6, 6, 6, 0x0FFF),
        makeThread(6120, '',                0x7FF93A018800n, 29.0, 1290, 'Waiting', 'WrQueue',    6, 8, 8, 0x0FFF),
        makeThread(6124, 'ThreadPoolFg#0',  0x7FF940310400n,  8.4,  620, 'Waiting', 'UserRequest', 6, 4, 4, 0x0FFF)
      ],
      presentProfile: {
        baseFrameMs: 16.67,
        jitterRel: 0.09,
        presentMode: 'Composed: Copy with GPU GDI',
        composedShare: 0.96,
        spikeChance: 0.02,
        spikeMultiplier: 1.8
      },
      vaProfile: {
        privateJit4kMiB: 36.8,
        jitProtect: 'RWX',
        mapped4kMiB: 220
      },
      ioProfile: {
        readMbS: 6.2,
        writeMbS: 3.1,
        readIops: 185,
        writeIops: 92
      },
      pmuProfile: {
        effGhz: 4.08, ipc: 1.02,
        l1dc: 22.8, l2dc: 7.4, l1ic: 14.2, l2ic: 2.10,
        demL3: 3.10, hwpfL3: 0.62, demDram: 1.32, hwpfDram: 0.28,
        l2pfL3: 1.20, l2pfDram: 0.32,
        l3Acc: 9.8, l3Miss: 2.60, l3LatCyc: 214,
        br: 165.0, brMiss: 4.40, brMissPct: 3.10,
        l1ItlbMissPct: 1.25, l2Itlb: 0.48, l1Dtlb: 1.80, l2Dtlb: 0.54,
        dcCrossCcx: 3.15, locksSerial: 0.92, opcacheHitPct: 64.2, stlfInterlock: 2.40, misalAccess: 14.2,
        pfRate: 340, cpuUsr: 22.0, cpuSys: 4.2,
        // 4 threads active across both CCX0 & CCX1 + low L3 hit (73.5%) -> fires Rule 4 Cross-CCX
        coreC0: [42, 4, 34, 2, 6, 1, 38, 3, 29, 2, 4, 1]
      }
    },
    {
      pid: 34112,
      name: 'cyberpunk2077.exe',
      tag: 'GPU-Bound 99% + Noisy Neighbor',
      allocatorType: 'crt_fallback',
      allocatorLabel: 'REDengine4 Pool (Layer 1 OS Fallback)',
      crtProfile: {
        kind: 'custom_allocator',
        crt: 'custom',
        linkageLabel: 'REDengine4 Pool (custom VirtualAlloc)',
        runtimeHint: 'Custom engine pool allocator bypasses CRT/HeapAlloc'
      },
      wsMiB: 4820,
      sharedMiB: 690,
      hugeMiB: 0,
      requestedHugeMiB: 0,
      commitMiB: 7940,
      peakWsMiB: 5340,
      peakCommitMiB: 8420,
      pageFaults: 2140300,
      userSec: 910.4,
      sysSec: 128.6,
      elapsedSec: 485.0,
      ifeoEnabled: false,
      ifeoMasterSessionToggled: false,
      affinityMask: 0x0FFF,
      modules: [
        makeMod('Cyberpunk2077.exe', 92.40, false, false, 'RX', false, 0x7FF6A0000000n),
        makeMod('PhysX3_x64.dll', 21.80, false, false, 'RX', true, 0x7FF8B2000000n),
        makeMod('nvngx_dlss.dll', 34.50, false, false, 'RX', true, 0x7FF8B8000000n),
        makeMod('d3d12core.dll', 18.20, false, false, 'RX', true, 0x7FF8BC000000n)
      ],
      arenas: null,
      heapStats: null,
      win32Profile: makeWin32Profile({
        gpu3dPct: 98.8,
        gpuProc3dPct: 97.6,
        // C00 is hot (62% C0) with 6.4% DPC+IRQ -> fires dpc_irq_collision (MD)
        coreDpcPct: [4.6, 0.3, 0.5, 0.2, 0.4, 0.2, 0.5, 0.2, 0.3, 0.1, 0.2, 0.1],
        coreIrqPct: [1.8, 0.1, 0.2, 0.1, 0.2, 0.1, 0.2, 0.1, 0.1, 0.1, 0.1, 0.1],
        coreIrqPerSec: [3450, 380, 520, 270, 440, 210, 490, 240, 360, 190, 290, 170],
        noisyNeighbors: [
          { name: 'MsMpEng.exe', pid: 4120, sysCpuPct: 8.8 },
          { name: 'dwm.exe', pid: 1188, sysCpuPct: 1.4 }
        ],
        hardPageReadsPerSec: 0.2,
        availPhysPct: 29.0,
        commitPct: 68.0,
        seLockMemoryPrivilege: 'Present'
      }),
      protectedProcess: false,
      threads: [
        makeThread(34116, 'REDMainThread',   0x7FF6A0114000n, 62.0, 2140, 'Running', '-',          10, 0, 0, 0x0FFF),
        makeThread(34120, 'REDRenderThread', 0x7FF8BC028400n, 54.0, 2480, 'Running', '-',          10, 2, 2, 0x0FFF),
        makeThread(34124, 'AssetStreamer',   0x7FF6A0821900n, 46.0, 3890, 'Waiting', 'WrPageIn',    9, 4, 4, 0x0FFF),
        makeThread(34128, 'PhysXWorker#0',   0x7FF8B204A100n, 48.0, 1620, 'Running', '-',           8, 6, 6, 0x0FFF),
        makeThread(34132, '',                0x7FF8B806C200n, 34.0, 1340, 'Waiting', 'EventPair',   8, 8, 8, 0x0FFF),
        makeThread(34136, 'JobPool#2',       0x7FF6A0448000n, 26.0, 1180, 'Waiting', 'WrQueue',     8, 10, 10, 0x0FFF)
      ],
      presentProfile: {
        baseFrameMs: 11.80,
        jitterRel: 0.12,
        presentMode: 'Hardware: Independent Flip',
        composedShare: 0.0,
        spikeChance: 0.095,
        spikeMultiplier: 2.35,
        spikeCulprit: 'disk_read'
      },
      vaProfile: {
        privateJit4kMiB: 3.1,
        jitProtect: 'RX',
        mapped4kMiB: 540
      },
      ioProfile: {
        readMbS: 138.0,
        writeMbS: 4.2,
        readIops: 1840,
        writeIops: 68
      },
      pmuProfile: {
        effGhz: 4.21, ipc: 1.24,
        l1dc: 29.5, l2dc: 8.1, l1ic: 9.8, l2ic: 1.45,
        demL3: 3.10, hwpfL3: 1.35, demDram: 1.55, hwpfDram: 0.52,
        l2pfL3: 0.95, l2pfDram: 0.40,
        l3Acc: 9.6, l3Miss: 2.10, l3LatCyc: 218,
        br: 146.0, brMiss: 2.85, brMissPct: 2.20,
        l1ItlbMissPct: 0.35, l2Itlb: 0.16, l1Dtlb: 1.20, l2Dtlb: 0.24,
        dcCrossCcx: 0.72, locksSerial: 0.24, opcacheHitPct: 80.5, stlfInterlock: 1.70, misalAccess: 7.4,
        pfRate: 240, cpuUsr: 36.0, cpuSys: 5.2,
        // Hottest logical CPU C00 is 62% (<75%) while GPU 3D is 98.8% (>=97%) -> GPU-BOUND
        coreC0: [62, 14, 54, 12, 46, 10, 48, 8, 34, 6, 26, 4]
      }
    },
    {
      pid: 38904,
      name: 'javaw.exe',
      tag: 'Hard Paging + 2MiB RAM Frag',
      allocatorType: 'generic_mimalloc',
      allocatorLabel: 'mimalloc.dll (4 GiB Locked + Disk Paging)',
      crtProfile: {
        kind: 'gc_virtualalloc',
        crt: 'gc_jvm',
        linkageLabel: 'HotSpot JVM G1GC (jvm.dll on VirtualAlloc)',
        runtimeHint: 'Use JVM -XX:+UseLargePages instead of rminject'
      },
      wsMiB: 3180,
      sharedMiB: 280,
      hugeMiB: 4096,
      requestedHugeMiB: 4096,
      commitMiB: 11240,
      peakWsMiB: 4620,
      peakCommitMiB: 12180,
      pageFaults: 6180400,
      userSec: 540.2,
      sysSec: 162.8,
      elapsedSec: 310.0,
      ifeoEnabled: true,
      ifeoMasterSessionToggled: false,
      affinityMask: 0x0FFF,
      modules: [
        makeMod('jvm.dll', 28.40, false, true, 'RX', true, 0x7FF870000000n),
        makeMod('javaw.exe', 4.60, false, true, 'RX', false, 0x7FF650000000n),
        makeMod('lwjgl_opengl.dll', 12.10, false, false, 'RX', true, 0x7FF876000000n),
        makeMod('ucrtbase.dll', 4.30, false, false, 'RX', true, 0x7FFA81200000n)
      ],
      arenas: buildArenas(4, [30, 28, 25, 19], []),
      heapStats: {
        normal:    { peak: 3420, total: 19400, current: 3110 },
        huge:      { peak: 4096, total: 4096,  current: 4096 },
        reserved:  { peak: 4096, total: 4096,  current: 4096 },
        committed: { peak: 3810, total: 4920,  current: 3640 },
        touched:   { peak: 3680, total: 3680,  current: 3264 },
        segments:  { peak: 118,  total: 204,   current: 102, isCount: true },
        pages:     { peak: 25100, total: 96400, current: 21800, isCount: true },
        softReset: 510
      },
      win32Profile: makeWin32Profile({
        gpu3dPct: 48.0,
        gpuProc3dPct: 44.0,
        hardPageReadsPerSec: 44.5,
        availPhysPct: 3.8,
        commitPct: 93.5,
        seLockMemoryPrivilege: 'Present'
      }),
      protectedProcess: false,
      threads: [
        makeThread(38908, 'Render thread',   0x7FF876012400n, 68.0, 2650, 'Running', '-',          10, 0, 0, 0x0FFF),
        makeThread(38912, 'C2 Compiler#0',   0x7FF87018A200n, 52.0, 1980, 'Running', '-',           8, 2, 2, 0x0FFF),
        makeThread(38916, 'G1 Conc#0',       0x7FF870244800n, 44.0, 1740, 'Waiting', 'WrPageIn',    8, 4, 4, 0x0FFF),
        makeThread(38920, 'Server thread',   0x7FF870091A00n, 46.0, 2120, 'Running', '-',           9, 6, 6, 0x0FFF),
        makeThread(38924, '',                0x7FF87032C100n, 28.0, 1420, 'Waiting', 'UserRequest', 8, 8, 8, 0x0FFF)
      ],
      presentProfile: {
        baseFrameMs: 8.20,
        jitterRel: 0.13,
        presentMode: 'Hardware: Independent Flip',
        composedShare: 0.0,
        spikeChance: 0.085,
        spikeMultiplier: 3.1,
        spikeCulprit: 'page_faults'
      },
      vaProfile: {
        privateJit4kMiB: 42.5,
        jitProtect: 'RWX',
        mapped4kMiB: 210
      },
      ioProfile: {
        readMbS: 18.4,
        writeMbS: 6.2,
        readIops: 420,
        writeIops: 110
      },
      pmuProfile: {
        effGhz: 4.16, ipc: 1.12,
        l1dc: 28.0, l2dc: 7.9, l1ic: 11.8, l2ic: 1.90,
        demL3: 3.20, hwpfL3: 1.10, demDram: 1.42, hwpfDram: 0.45,
        l2pfL3: 0.90, l2pfDram: 0.34,
        l3Acc: 9.8, l3Miss: 1.95, l3LatCyc: 219,
        br: 150.0, brMiss: 3.10, brMissPct: 2.50,
        l1ItlbMissPct: 1.45, l2Itlb: 0.56, l1Dtlb: 1.15, l2Dtlb: 0.22,
        dcCrossCcx: 0.68, locksSerial: 0.28, opcacheHitPct: 78.0, stlfInterlock: 1.95, misalAccess: 8.6,
        pfRate: 1620, cpuUsr: 38.0, cpuSys: 14.5,
        coreC0: [68, 10, 52, 8, 44, 6, 46, 7, 28, 4, 18, 2]
      }
    },
    {
      pid: 41250,
      name: 'sqlservr.exe',
      tag: 'CtxSw Lock Storm + 0 GiB Huge Frag',
      allocatorType: 'generic_mimalloc',
      allocatorLabel: 'mimalloc.dll (0 GiB Huge - Frag Fallback)',
      crtProfile: {
        kind: 'already_mimalloc',
        crt: 'generic_mimalloc',
        linkageLabel: 'mimalloc.dll (Generic v2)',
        hookedModules: ['mimalloc.dll']
      },
      wsMiB: 2740,
      sharedMiB: 320,
      hugeMiB: 0,
      requestedHugeMiB: 2048,
      commitMiB: 3890,
      peakWsMiB: 3120,
      peakCommitMiB: 4100,
      pageFaults: 1520100,
      userSec: 1120.5,
      sysSec: 495.2,
      elapsedSec: 615.0,
      ifeoEnabled: false,
      ifeoMasterSessionToggled: false,
      affinityMask: 0x0FFF,
      modules: [
        makeMod('sqlmin.dll', 48.20, false, false, 'RX', true, 0x7FF880000000n),
        makeMod('sqllang.dll', 39.60, false, false, 'RX', true, 0x7FF886000000n),
        makeMod('mimalloc.dll', 4.60, false, false, 'RX', true, 0x7FF88A000000n),
        makeMod('sqlservr.exe', 5.10, false, false, 'RX', false, 0x7FF660000000n)
      ],
      arenas: buildArenas(0, [], [{ blocks: 32, inuse: 26, touched: 30 }, { blocks: 32, inuse: 18, touched: 24 }]),
      heapStats: {
        normal:    { peak: 2680, total: 16200, current: 2410 },
        huge:      { peak: 0,    total: 0,     current: 0 },
        reserved:  { peak: 2048, total: 2048,  current: 2048 },
        committed: { peak: 2540, total: 5820,  current: 2320 },
        touched:   { peak: 2496, total: 2496,  current: 2240 },
        segments:  { peak: 88,   total: 174,   current: 76, isCount: true },
        pages:     { peak: 19400, total: 88100, current: 16900, isCount: true },
        softReset: 430
      },
      win32Profile: makeWin32Profile({
        gpu3dPct: 2.0,
        gpuProc3dPct: 0.0,
        ctxSwPerSec: 78500,
        syncWaitPct: 58.0,
        topWaitReason: 'WrPushLock',
        hardPageReadsPerSec: 1.8,
        availPhysPct: 36.0,
        commitPct: 61.0,
        seLockMemoryPrivilege: 'Present'
      }),
      protectedProcess: false,
      threads: [
        makeThread(41254, 'SOS_Worker#0',    0x7FF880112200n, 56.0, 14800, 'Running', '-',          8, 0, 0, 0x0FFF),
        makeThread(41258, 'SOS_Worker#1',    0x7FF880112200n, 52.0, 13900, 'Waiting', 'WrPushLock', 8, 2, 2, 0x0FFF),
        makeThread(41262, 'SOS_Worker#2',    0x7FF886084100n, 48.0, 12600, 'Waiting', 'WrPushLock', 8, 4, 4, 0x0FFF),
        makeThread(41266, 'SOS_Worker#3',    0x7FF886084100n, 54.0, 14100, 'Running', '-',          8, 6, 6, 0x0FFF),
        makeThread(41270, '',                0x7FF88041C900n, 44.0, 11800, 'Waiting', 'WrPushLock', 8, 1, 1, 0x0FFF),
        makeThread(41274, 'LogWriter',       0x7FF880028800n, 18.0,  6400, 'Waiting', 'WrQueue',    9, 8, 8, 0x0FFF)
      ],
      presentProfile: null, // Headless DB server: no Present ETW stream (graceful None)
      vaProfile: {
        privateJit4kMiB: 2.0,
        jitProtect: 'RX',
        mapped4kMiB: 280
      },
      ioProfile: {
        readMbS: 34.0,
        writeMbS: 48.0,
        readIops: 860,
        writeIops: 1120
      },
      pmuProfile: {
        effGhz: 4.18, ipc: 1.04,
        l1dc: 27.2, l2dc: 7.1, l1ic: 10.4, l2ic: 1.55,
        demL3: 2.95, hwpfL3: 0.85, demDram: 1.18, hwpfDram: 0.32,
        l2pfL3: 0.78, l2pfDram: 0.28,
        l3Acc: 8.9, l3Miss: 1.62, l3LatCyc: 214,
        br: 142.0, brMiss: 2.95, brMissPct: 2.40,
        l1ItlbMissPct: 0.40, l2Itlb: 0.18, l1Dtlb: 1.85, l2Dtlb: 0.56,
        dcCrossCcx: 1.45, locksSerial: 1.35, opcacheHitPct: 75.5, stlfInterlock: 2.30, misalAccess: 9.2,
        pfRate: 480, cpuUsr: 29.5, cpuSys: 19.2,
        coreC0: [56, 44, 52, 42, 48, 38, 54, 41, 49, 37, 45, 34]
      }
    },
    {
      pid: 45120,
      name: 'coreclr_sim.exe',
      tag: '2MiB PE + 4K JIT iTLB Residual',
      allocatorType: 'crt_fallback',
      allocatorLabel: 'CoreCLR GC + RyuJIT (2MiB PE, 4K JIT)',
      crtProfile: {
        kind: 'gc_virtualalloc',
        crt: 'gc_coreclr',
        linkageLabel: 'CoreCLR GC + RyuJIT (coreclr.dll on VirtualAlloc)',
        runtimeHint: 'Use COMPlus_GCHeapHardLimit / DOTNET_GCLargePages'
      },
      wsMiB: 1420,
      sharedMiB: 240,
      hugeMiB: 0,
      requestedHugeMiB: 0,
      commitMiB: 1980,
      peakWsMiB: 1640,
      peakCommitMiB: 2120,
      pageFaults: 740200,
      userSec: 412.0,
      sysSec: 38.4,
      elapsedSec: 260.0,
      ifeoEnabled: true,
      ifeoMasterSessionToggled: false,
      affinityMask: 0x0FFF,
      modules: [
        makeMod('coreclr.dll', 64.00, true, true, 'RX', false, 0x7FF890000000n),
        makeMod('clrjit.dll', 32.00, true, true, 'RX', false, 0x7FF896000000n),
        makeMod('sim_engine.dll', 48.00, true, true, 'RX', false, 0x7FF89A000000n),
        makeMod('coreclr_sim.exe', 8.00, true, true, 'RX', false, 0x7FF670000000n),
        makeMod('ucrtbase.dll', 4.30, false, false, 'RX', true, 0x7FFA81200000n)
      ],
      arenas: null,
      heapStats: null,
      win32Profile: makeWin32Profile({
        gpu3dPct: 58.0,
        gpuProc3dPct: 54.0,
        hardPageReadsPerSec: 0.0,
        availPhysPct: 51.0,
        commitPct: 44.0,
        seLockMemoryPrivilege: 'Present'
      }),
      protectedProcess: false,
      threads: [
        makeThread(45124, '.NET MainLoop',   0x7FF890024A00n, 74.0, 1980, 'Running', '-',           9, 0, 0, 0x0FFF),
        makeThread(45128, 'RyuJIT Worker',   0x7FF896018800n, 46.0, 1520, 'Running', '-',           8, 2, 2, 0x0FFF),
        makeThread(45132, '.NET TP Worker',  0x7FF89A04C100n, 38.0, 2140, 'Ready',   'WrQueue',     8, 4, 4, 0x0FFF),
        makeThread(45136, 'GC Server#0',     0x7FF890198000n, 16.0,  860, 'Waiting', 'UserRequest', 8, 6, 6, 0x0FFF),
        makeThread(45140, '',                0x7FF89A082200n, 12.0,  640, 'Waiting', 'WrQueue',     8, 8, 8, 0x0FFF)
      ],
      presentProfile: {
        baseFrameMs: 8.33,
        jitterRel: 0.08,
        presentMode: 'Hardware: Independent Flip',
        composedShare: 0.0,
        spikeChance: 0.01,
        spikeMultiplier: 1.9
      },
      vaProfile: {
        privateJit4kMiB: 28.4,
        jitProtect: 'RWX',
        mapped4kMiB: 165
      },
      ioProfile: {
        readMbS: 3.8,
        writeMbS: 1.1,
        readIops: 84,
        writeIops: 22
      },
      pmuProfile: {
        effGhz: 4.21, ipc: 1.24,
        l1dc: 24.5, l2dc: 6.8, l1ic: 12.4, l2ic: 1.95,
        demL3: 2.60, hwpfL3: 0.95, demDram: 0.92, hwpfDram: 0.30,
        l2pfL3: 0.85, l2pfDram: 0.25,
        l3Acc: 8.6, l3Miss: 1.48, l3LatCyc: 206,
        br: 152.0, brMiss: 2.90, brMissPct: 2.35,
        l1ItlbMissPct: 1.48, l2Itlb: 0.58, l1Dtlb: 1.12, l2Dtlb: 0.21,
        dcCrossCcx: 0.54, locksSerial: 0.22, opcacheHitPct: 77.2, stlfInterlock: 1.85, misalAccess: 7.6,
        pfRate: 240, cpuUsr: 41.0, cpuSys: 4.2,
        coreC0: [74, 6, 46, 5, 38, 4, 24, 3, 14, 2, 10, 1]
      }
    },
    {
      pid: 48320,
      name: 'chatterino.exe',
      tag: '/MD Qt6 C++ (Heap dTLB + Soft PF)',
      allocatorType: 'crt_fallback',
      allocatorLabel: 'ucrtbase.dll (/MD C++ OS Heap Fallback)',
      crtProfile: {
        kind: 'eligible',
        crt: 'dynamic_md',
        linkageLabel: '/MD UCRT (ucrtbase.dll + Qt6)',
        hookedModules: ['ucrtbase.dll', 'Qt6Core.dll', 'Qt6Widgets.dll', 'Qt6Gui.dll', 'chatterino.exe']
      },
      wsMiB: 1480,
      sharedMiB: 260,
      hugeMiB: 0,
      requestedHugeMiB: 0,
      commitMiB: 2040,
      peakWsMiB: 1820,
      peakCommitMiB: 2260,
      pageFaults: 3640210,
      userSec: 328.4,
      sysSec: 84.6,
      elapsedSec: 540.0,
      ifeoEnabled: false,
      ifeoMasterSessionToggled: false,
      affinityMask: 0x0FFF,
      modules: [
        makeMod('Qt6Widgets.dll', 6.40, false, false, 'RX', true, 0x7FF8C0000000n),
        makeMod('Qt6Gui.dll', 7.80, false, false, 'RX', true, 0x7FF8C2000000n),
        makeMod('Qt6Core.dll', 6.90, false, false, 'RX', true, 0x7FF8C4000000n),
        makeMod('chatterino.exe', 12.60, false, false, 'RX', false, 0x7FF680000000n),
        makeMod('ucrtbase.dll', 4.30, false, false, 'RX', true, 0x7FFA81200000n)
      ],
      arenas: null,
      heapStats: null,
      win32Profile: makeWin32Profile({
        gpu3dPct: 12.0,
        gpuProc3dPct: 8.0,
        hardPageReadsPerSec: 0.0,
        availPhysPct: 46.0,
        commitPct: 48.0,
        ctxSwPerSec: 18400,
        syncWaitPct: 22.0,
        seLockMemoryPrivilege: 'Present'
      }),
      protectedProcess: false,
      threads: [
        makeThread(48324, 'QtMainThread',    0x7FF680018200n, 52.0, 2240, 'Running', '-',          9, 0, 0, 0x0FFF),
        makeThread(48328, 'ChatIrcWorker',   0x7FF8C4042100n, 38.0, 1860, 'Running', '-',          8, 2, 2, 0x0FFF),
        makeThread(48332, 'MsgCacheCleaner', 0x7FF8C4091400n, 24.0, 1420, 'Waiting', 'WrQueue',    8, 4, 4, 0x0FFF),
        makeThread(48336, 'EmoteDecodePool', 0x7FF8C2054800n, 18.0, 1180, 'Waiting', 'UserRequest', 8, 6, 6, 0x0FFF)
      ],
      presentProfile: {
        baseFrameMs: 16.67,
        jitterRel: 0.06,
        presentMode: 'Hardware: Independent Flip',
        composedShare: 0.0,
        spikeChance: 0.0,
        spikeMultiplier: 1.4
      },
      vaProfile: {
        privateJit4kMiB: 0.8,
        jitProtect: 'RX',
        mapped4kMiB: 180
      },
      ioProfile: {
        readMbS: 2.4,
        writeMbS: 1.1,
        readIops: 65,
        writeIops: 32
      },
      pmuProfile: {
        effGhz: 4.18, ipc: 1.18,
        l1dc: 24.5, l2dc: 6.2, l1ic: 9.4, l2ic: 1.45,
        demL3: 2.30, hwpfL3: 0.85, demDram: 0.92, hwpfDram: 0.45,
        l2pfL3: 0.72, l2pfDram: 0.25,
        l3Acc: 8.2, l3Miss: 1.38, l3LatCyc: 204,
        br: 146.0, brMiss: 2.65, brMissPct: 2.10,
        l1ItlbMissPct: 0.36, l2Itlb: 0.14, l1Dtlb: 2.65, l2Dtlb: 0.74,
        dcCrossCcx: 0.45, locksSerial: 0.28, opcacheHitPct: 79.0, stlfInterlock: 1.80, misalAccess: 7.2,
        pfRate: 2450, cpuUsr: 22.0, cpuSys: 8.5,
        coreC0: [52, 6, 38, 4, 24, 3, 18, 2, 12, 1, 8, 1]
      }
    }
  ];

  const SYSTEM_WIDE_WIN32 = makeWin32Profile({
    gpu3dPct: 18.0,
    gpuProc3dPct: 0.0,
    hardPageReadsPerSec: 0.2,
    availPhysPct: 54.0,
    commitPct: 39.0,
    seLockMemoryPrivilege: 'Present'
  });

  const SYSTEM_WIDE_PROFILE = {
    effGhz: 4.18, ipc: 1.44,
    l1dc: 22.0, l2dc: 5.4, l1ic: 9.2, l2ic: 1.40,
    demL3: 2.30, hwpfL3: 1.10, demDram: 0.95, hwpfDram: 0.42,
    l2pfL3: 0.85, l2pfDram: 0.30,
    l3Acc: 7.4, l3Miss: 1.45, l3LatCyc: 205,
    br: 148.0, brMiss: 2.10, brMissPct: 2.15,
    l1ItlbMissPct: 0.45, l2Itlb: 0.14, l1Dtlb: 1.10, l2Dtlb: 0.22,
    dcCrossCcx: 0.65, locksSerial: 0.22, opcacheHitPct: 81.0, stlfInterlock: 1.80, misalAccess: 6.4,
    pfRate: 420, cpuUsr: 18.0, cpuSys: 3.5,
    coreC0: [44, 6, 36, 4, 22, 1, 31, 5, 16, 1, 10, 0]
  };

  // Built-in saved baseline fixtures (with enabled_packs, core_pmc_slots, mux_groups)
  const FULL_FIXTURE_PACKS = [
    'DcDemand', 'DcHwpf', 'L1L2Dc', 'L1L2Ic', 'L2Hwpf',
    'Branches', 'ItlbFull', 'DtlbFull', 'ExactRetiring'
  ];
  const BASELINE_PRESETS = {
    '4K-Default': {
      name: 'deadlock_4k_default.json',
      muxPreset: 'full',
      enabled_packs: [...FULL_FIXTURE_PACKS],
      core_pmc_slots: 18,
      mux_groups: 3,
      target: 'deadlock.exe',
      elapsedSec: 30,
      samples: 30,
      ifeoEnabled: false,
      note: 'VAC-Safe 4K Default',
      ipc: 1.15,
      cpi: 0.870,
      fps: 115.6,
      avgFrameMs: 8.65,
      dramMpki: 2.38,
      l3HitMpki: 4.85,
      l2dcExclMpki: 24.00,
      l2icExclMpki: 10.15,
      branchMpki: 3.65,
      l2dtlbMpki: 0.68,
      l2itlbMpki: 0.84,
      l3MissMpki: 2.48,
      l3LatNs: 53.5,
      l1icMpki: 12.1,
      l2icMpki: 1.95,
      l1dcMpki: 33.8,
      l2dcMpki: 9.8,
      l2pfL3Mpki: 1.05,
      l2pfDramMpki: 0.42
    },
    '2MiB-IFEO': {
      name: 'deadlock_2m_ifeo.json',
      muxPreset: 'full',
      enabled_packs: [...FULL_FIXTURE_PACKS],
      core_pmc_slots: 18,
      mux_groups: 3,
      target: 'deadlock.exe',
      elapsedSec: 30,
      samples: 30,
      ifeoEnabled: true,
      note: '17 Source 2 DLLs 2 MiB IFEO',
      ipc: 1.28,
      cpi: 0.781,
      fps: 144.1,
      avgFrameMs: 6.94,
      dramMpki: 1.72,
      l3HitMpki: 4.85,
      l2dcExclMpki: 22.80,
      l2icExclMpki: 9.45,
      branchMpki: 3.40,
      l2dtlbMpki: 0.14,
      l2itlbMpki: 0.09,
      l3MissMpki: 1.88,
      l3LatNs: 50.2,
      l1icMpki: 11.2,
      l2icMpki: 1.75,
      l1dcMpki: 31.4,
      l2dcMpki: 8.6,
      l2pfL3Mpki: 1.10,
      l2pfDramMpki: 0.38
    }
  };

  function createMiheapSuccessorProcess(srcProc, opts = {}) {
    const mode = opts.mode === 'large' && (opts.hugeGiB || 0) > 0 ? 'large' : 'standard';
    const hugeGiB = mode === 'large' ? Math.max(1, Math.round(opts.hugeGiB)) : 0;
    const hugeMiB = hugeGiB * 1024;
    const pid = Number(opts.pid) || (srcProc.pid + 100000);

    const mods = (srcProc.modules || []).map(m => ({ ...m }));
    const hasMod = (name) => mods.some(m => m.name.toLowerCase() === name);
    if (!hasMod('miheap.dll')) {
      mods.push(makeMod('miheap.dll', 0.45, false, false, 'RX', true, 0x7FF9A1000000n));
    }
    if (!hasMod('mimalloc.dll')) {
      mods.push(makeMod('mimalloc.dll', 4.60, false, false, 'RX', true, 0x7FF9A2000000n));
    }

    const srcWsMiB = Number(srcProc.wsMiB) || 1024;
    const srcPeakWsMiB = Number(srcProc.peakWsMiB) || srcWsMiB;
    const totalNeededBlocks = Math.max(6, Math.round((srcWsMiB * 0.78) / 32));
    const fillProfile = [];
    if (hugeGiB > 0) {
      const avgPerArena = Math.max(6, Math.min(28, Math.round(totalNeededBlocks / hugeGiB)));
      for (let g = 0; g < hugeGiB; g++) {
        const bias = g === 0 ? 6 : (g === hugeGiB - 1 ? -6 : 0);
        fillProfile.push(Math.max(4, Math.min(29, avgPerArena + bias)));
      }
    }
    const osArenaSpec = hugeGiB === 0
      ? [{ blocks: 32, inuse: Math.min(28, Math.max(6, Math.round(srcWsMiB / 64))), touched: 30 }]
      : [];

    const arenas = buildArenas(hugeGiB, fillProfile, osArenaSpec);
    const activeBlocks = arenas.hugeArenas.reduce((a, g) => a + g.inuse.reduce((x, y) => x + y, 0), 0);
    const touchedBlocks = arenas.hugeArenas.reduce((a, g) => a + g.touched.reduce((x, y) => x + y, 0), 0);
    const activeMiB = activeBlocks * 32;
    const touchedMiB = touchedBlocks * 32;

    const newWsMiB = hugeGiB > 0
      ? Math.max(120, Math.round(srcWsMiB * 0.14))
      : Math.max(256, Math.round(srcWsMiB * 0.88));
    const newPeakWsMiB = hugeGiB > 0
      ? Math.max(newWsMiB + 64, Math.round(srcPeakWsMiB * 0.16))
      : Math.max(newWsMiB + 128, Math.round(srcPeakWsMiB * 0.90));

    const heapStats = {
      normal:    { peak: Math.round(srcPeakWsMiB * 0.85), total: Math.round(srcWsMiB * 6.4), current: Math.max(128, activeMiB || Math.round(newWsMiB * 0.72)) },
      huge:      { peak: hugeMiB, total: hugeMiB, current: hugeMiB },
      reserved:  { peak: Math.max(hugeMiB, 1024), total: Math.max(hugeMiB, 1024), current: Math.max(hugeMiB, 1024) },
      committed: { peak: Math.max(touchedMiB, newWsMiB), total: Math.round(srcWsMiB * 1.6), current: Math.max(activeMiB, newWsMiB) },
      touched:   { peak: touchedMiB || newWsMiB, total: touchedMiB || newWsMiB, current: activeMiB || Math.round(newWsMiB * 0.8) },
      segments:  { peak: Math.max(16, Math.round(srcWsMiB / 32)), total: Math.max(32, Math.round(srcWsMiB / 16)), current: Math.max(12, Math.round(srcWsMiB / 40)), isCount: true },
      pages:     { peak: Math.max(1200, Math.round(srcWsMiB * 8)), total: Math.max(4800, Math.round(srcWsMiB * 32)), current: Math.max(960, Math.round(srcWsMiB * 6)), isCount: true },
      softReset: hugeGiB > 0 ? 48 : 260
    };

    const srcPmu = srcProc.pmuProfile || {};
    const newL2Dtlb = hugeGiB > 0
      ? 0.11
      : Math.min(Number(srcPmu.l2Dtlb) || 0.5, Number(((srcPmu.l2Dtlb || 0.6) * 0.75).toFixed(2)));
    const newPfRate = hugeGiB > 0
      ? 190
      : Math.max(220, Math.round((srcPmu.pfRate || 2000) * 0.24));
    const newCpuSys = Number(Math.max(2.1, (srcPmu.cpuSys || 8.0) * (hugeGiB > 0 ? 0.30 : 0.48)).toFixed(1));
    const newIpc = Number(Math.min(2.8, (srcPmu.ipc || 1.1) + (hugeGiB > 0 ? 0.14 : 0.06)).toFixed(2));

    const hookedCrts = [];
    const lowerMods = mods.map(m => m.name.toLowerCase());
    if (lowerMods.includes('ucrtbase.dll') || lowerMods.includes('ucrtbased.dll')) hookedCrts.push('ucrtbase.dll');
    if (lowerMods.includes('msvcrt.dll')) hookedCrts.push('msvcrt.dll');
    if ((srcProc.crtProfile && srcProc.crtProfile.linkageLabel && srcProc.crtProfile.linkageLabel.includes('HeapAlloc')) || hookedCrts.length === 0) {
      hookedCrts.push('kernel32!HeapAlloc');
    }
    const iatMods = Math.max(2, (srcProc.modules || []).filter(m => !m.protectedDriver).length);
    const iatSlots = iatMods * 4 + 2;

    const srcW32 = srcProc.win32Profile || makeWin32Profile();
    const availPhysAfter = hugeGiB > 0
      ? Math.max(5.0, Number((srcW32.availPhysPct - (hugeGiB / 32.0) * 100.0).toFixed(1)))
      : srcW32.availPhysPct;
    const newCommitMiB = Math.max(newWsMiB + hugeMiB, srcProc.commitMiB || (newWsMiB + hugeMiB));
    const newPeakCommitMiB = Math.max(srcProc.peakCommitMiB || 0, newCommitMiB);

    return {
      ...srcProc,
      pid,
      tag: hugeGiB > 0 ? `miheap 2MiB (${hugeGiB} GiB)` : 'miheap Standard (0 GiB Huge)',
      allocatorType: 'miheap_injected',
      allocatorLabel: hugeGiB > 0
        ? 'miheap.dll -> mimalloc.dll (2 MiB Arenas)'
        : 'miheap.dll -> mimalloc.dll (Standard Heap)',
      crtProfile: {
        kind: 'already_mimalloc',
        crt: 'miheap_injected',
        linkageLabel: 'miheap.dll -> mimalloc.dll (Injected 2 MiB)',
        hookedModules: [...hookedCrts]
      },
      wsMiB: newWsMiB,
      hugeMiB,
      requestedHugeMiB: hugeGiB > 0 ? hugeMiB : 0,
      commitMiB: newCommitMiB,
      peakCommitMiB: newPeakCommitMiB,
      peakWsMiB: newPeakWsMiB,
      pageFaults: Math.round((srcProc.pageFaults || 100000) * 0.08),
      elapsedSec: 12.0,
      userSec: 18.0,
      sysSec: 1.4,
      modules: mods,
      arenas,
      heapStats,
      miheapStats: {
        mode,
        hugeGiB,
        crts: hookedCrts,
        iatMods,
        iatSlots,
        miAllocs: 142800,
        miFrees: 138100,
        fallbackAllocs: 12,
        sourcePid: srcProc.pid,
        sourceName: srcProc.name,
        followChildren: Boolean(opts.followChildren),
        commandLine: opts.commandLine || ''
      },
      win32Profile: makeWin32Profile({
        ...srcW32,
        availPhysPct: availPhysAfter,
        hardPageReadsPerSec: 0.0
      }),
      threads: (srcProc.threads || []).map(t => ({ ...t })),
      pmuProfile: {
        ...srcPmu,
        ipc: newIpc,
        l1Dtlb: hugeGiB > 0 ? 0.78 : Math.max(0.85, Number(((srcPmu.l1Dtlb || 2.0) * 0.72).toFixed(2))),
        l2Dtlb: newL2Dtlb,
        l3LatCyc: Math.max(190, Math.round((srcPmu.l3LatCyc || 210) - (hugeGiB > 0 ? 8 : 3))),
        pfRate: newPfRate,
        cpuSys: newCpuSys
      }
    };
  }

  Object.assign(Z, { PROTECTED_DRIVERS, makeMod, makeThread, buildArenas, SOURCE2_DLLS, makeWin32Profile, createMiheapSuccessorProcess, PROCESSES, SYSTEM_WIDE_WIN32, SYSTEM_WIDE_PROFILE, BASELINE_PRESETS });
})();
