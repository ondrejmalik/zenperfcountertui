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

  // Built-in saved baseline fixtures (with muxPreset + metadata)
  const BASELINE_PRESETS = {
    '4K-Default': {
      name: 'deadlock_4k_default.json',
      muxPreset: 'full',
      target: 'deadlock.exe',
      elapsedSec: 30,
      samples: 30,
      ifeoEnabled: false,
      note: 'VAC-Safe 4K Default',
      ipc: 1.15,
      cpi: 0.870,
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
      target: 'deadlock.exe',
      elapsedSec: 30,
      samples: 30,
      ifeoEnabled: true,
      note: '17 Source 2 DLLs 2 MiB IFEO',
      ipc: 1.28,
      cpi: 0.781,
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

  Object.assign(Z, { PROTECTED_DRIVERS, makeMod, buildArenas, SOURCE2_DLLS, makeWin32Profile, PROCESSES, SYSTEM_WIDE_WIN32, SYSTEM_WIDE_PROFILE, BASELINE_PRESETS });
})();
