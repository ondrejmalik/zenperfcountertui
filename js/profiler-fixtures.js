// Realistic per-process threads, 4-tier symbols, sidecar maps, ETW stacks, and AMDuProfCLI burst CSV fixtures
(() => {
  'use strict';
  const Z = window.Zen2Top || (window.Zen2Top = {});
  const { SymbolResolver } = Z;

  // Per-process realistic thread lists for Tab 6 (6 Threads) and Tab 7 ('t' thread filter)
  const PROCESS_THREADS = {
    14820: [ // deadlock.exe (IFEO 2MiB + SMT Hot)
      { tid: 14824, name: 'MainThread', cpuPct: 24.8, state: 'Running', waitReason: 'WrQueue', ctxSw: 2420, cpu: 0, ccx: 0 },
      { tid: 14892, name: 'RenderThread', cpuPct: 16.4, state: 'Running', waitReason: 'EventPairLow', ctxSw: 3180, cpu: 1, ccx: 0 },
      { tid: 14910, name: 'PhysicsWorker0', cpuPct: 6.2, state: 'Ready', waitReason: 'WrQueue', ctxSw: 1940, cpu: 2, ccx: 0 },
      { tid: 14914, name: 'AnimEvalWorker', cpuPct: 2.4, state: 'Waiting', waitReason: 'UserRequest', ctxSw: 1420, cpu: 4, ccx: 0 },
      { tid: 15008, name: 'AudioMixer', cpuPct: 1.2, state: 'Waiting', waitReason: 'DelayExecution', ctxSw: 880, cpu: 6, ccx: 1 }
    ],
    19204: [ // deadlock.exe (4K Default)
      { tid: 19208, name: 'MainThread', cpuPct: 23.1, state: 'Running', waitReason: 'WrQueue', ctxSw: 2810, cpu: 0, ccx: 0 },
      { tid: 19244, name: 'RenderThread', cpuPct: 17.5, state: 'Running', waitReason: 'EventPairLow', ctxSw: 3440, cpu: 2, ccx: 0 },
      { tid: 19260, name: 'PhysicsWorker0', cpuPct: 7.4, state: 'Ready', waitReason: 'WrQueue', ctxSw: 2110, cpu: 4, ccx: 0 },
      { tid: 19292, name: 'V8JsWorker', cpuPct: 5.7, state: 'Waiting', waitReason: 'UserRequest', ctxSw: 1680, cpu: 6, ccx: 1 }
    ],
    27408: [ // cs2.exe
      { tid: 27412, name: 'MainThread', cpuPct: 28.4, state: 'Running', waitReason: 'WrQueue', ctxSw: 2650, cpu: 0, ccx: 0 },
      { tid: 27440, name: 'RenderThread', cpuPct: 18.2, state: 'Running', waitReason: 'EventPairLow', ctxSw: 3290, cpu: 2, ccx: 0 },
      { tid: 27468, name: 'SceneJob0', cpuPct: 8.6, state: 'Ready', waitReason: 'WrQueue', ctxSw: 1820, cpu: 4, ccx: 0 },
      { tid: 27490, name: 'NetChannel', cpuPct: 5.3, state: 'Waiting', waitReason: 'WrQueue', ctxSw: 1120, cpu: 6, ccx: 1 }
    ],
    31088: [ // rustc.exe (PDB-backed local build, branch + I-Cache heavy)
      { tid: 31092, name: 'rustc_main', cpuPct: 26.5, state: 'Running', waitReason: 'WrExecutive', ctxSw: 11400, cpu: 0, ccx: 0 },
      { tid: 31104, name: 'rayon_cg0', cpuPct: 19.2, state: 'Running', waitReason: 'WrExecutive', ctxSw: 14800, cpu: 2, ccx: 0 },
      { tid: 31108, name: 'rayon_cg1', cpuPct: 18.4, state: 'Running', waitReason: 'WrExecutive', ctxSw: 14200, cpu: 4, ccx: 0 },
      { tid: 31112, name: 'llvm_opt0', cpuPct: 15.4, state: 'Running', waitReason: 'WrExecutive', ctxSw: 12100, cpu: 6, ccx: 1 }
    ],
    22910: [ // blender.exe
      { tid: 22914, name: 'cycles_cpu0', cpuPct: 22.8, state: 'Running', waitReason: 'UserRequest', ctxSw: 1420, cpu: 0, ccx: 0 },
      { tid: 22918, name: 'cycles_cpu1', cpuPct: 22.4, state: 'Running', waitReason: 'UserRequest', ctxSw: 1380, cpu: 2, ccx: 0 },
      { tid: 22922, name: 'cycles_bvh', cpuPct: 14.5, state: 'Running', waitReason: 'UserRequest', ctxSw: 1120, cpu: 6, ccx: 1 },
      { tid: 22930, name: 'ui_main', cpuPct: 7.4, state: 'Waiting', waitReason: 'UserRequest', ctxSw: 840, cpu: 8, ccx: 1 }
    ],
    6104: [ // chrome.exe
      { tid: 6108, name: 'CrRendererMain', cpuPct: 11.4, state: 'Running', waitReason: 'UserRequest', ctxSw: 2940, cpu: 0, ccx: 0 },
      { tid: 6142, name: 'Compositor', cpuPct: 8.6, state: 'Running', waitReason: 'WrQueue', ctxSw: 2410, cpu: 6, ccx: 1 },
      { tid: 6188, name: 'V8TurboFan', cpuPct: 6.2, state: 'Ready', waitReason: 'UserRequest', ctxSw: 1620, cpu: 2, ccx: 0 }
    ],
    34112: [ // cyberpunk2077.exe
      { tid: 34116, name: 'MainThread', cpuPct: 16.8, state: 'Running', waitReason: 'UserRequest', ctxSw: 2480, cpu: 0, ccx: 0 },
      { tid: 34148, name: 'RenderSubmit', cpuPct: 13.4, state: 'Waiting', waitReason: 'WrEventPair', ctxSw: 3120, cpu: 2, ccx: 0 },
      { tid: 34180, name: 'StreamingIO', cpuPct: 11.0, state: 'Ready', waitReason: 'WrQueue', ctxSw: 1840, cpu: 6, ccx: 1 }
    ],
    38904: [ // javaw.exe
      { tid: 38908, name: 'RenderThread', cpuPct: 22.4, state: 'Running', waitReason: 'UserRequest', ctxSw: 4120, cpu: 0, ccx: 0 },
      { tid: 38932, name: 'G1ConcRefine', cpuPct: 16.8, state: 'Running', waitReason: 'WrResource', ctxSw: 3840, cpu: 2, ccx: 0 },
      { tid: 38956, name: 'C2Compiler0', cpuPct: 13.3, state: 'Ready', waitReason: 'UserRequest', ctxSw: 2180, cpu: 6, ccx: 1 }
    ],
    41250: [ // sqlservr.exe (CtxSw Lock Storm)
      { tid: 41254, name: 'QueryWorker0', cpuPct: 14.2, state: 'Waiting', waitReason: 'WrPushLock', ctxSw: 22400, cpu: 0, ccx: 0 },
      { tid: 41258, name: 'QueryWorker1', cpuPct: 13.8, state: 'Waiting', waitReason: 'WrPushLock', ctxSw: 21800, cpu: 2, ccx: 0 },
      { tid: 41264, name: 'LogWriterThread', cpuPct: 11.4, state: 'Running', waitReason: 'WrQueue', ctxSw: 18600, cpu: 6, ccx: 1 },
      { tid: 41270, name: 'LatchMgr', cpuPct: 9.3, state: 'Waiting', waitReason: 'WrPushLock', ctxSw: 15700, cpu: 8, ccx: 1 }
    ]
  };

  // Optional sidecar .zen2sym.json maps (Tier 3) that users can toggle live for stripped game binaries
  const SIDECAR_MAPS = {
    source2: [
      { module: 'client.dll', rva_start: '0x14A200', rva_end: '0x14A480', name: 'client::CEntitySystem::UpdateTransforms', signature: 'void client::CEntitySystem::UpdateTransforms(float dt, uint32_t mask)' },
      { module: 'client.dll', rva_start: '0x2A8100', rva_end: '0x2A8540', name: 'client::CAnimGraph::EvaluateBranchTable', signature: 'void client::CAnimGraph::EvaluateBranchTable(const CAnimContext*)' },
      { module: 'client.dll', rva_start: '0x31F400', rva_end: '0x31F920', name: 'client::CClientFrame::SimulatePrediction', signature: 'void client::CClientFrame::SimulatePrediction(int tick)' },
      { module: 'vphysics2.dll', rva_start: '0x08C100', rva_end: '0x08C4C0', name: 'vphysics2::BroadphaseBVH::RayCastBatch', signature: 'int vphysics2::BroadphaseBVH::RayCastBatch(const RayBatch*)' },
      { module: 'rendersystemvulkan.dll', rva_start: '0x112000', rva_end: '0x1123F0', name: 'rsvk::CRenderQueue::SubmitCommandBuffers', signature: 'VkResult rsvk::CRenderQueue::SubmitCommandBuffers(uint32_t count)' },
      { module: 'engine2.dll', rva_start: '0x064000', rva_end: '0x064380', name: 'engine2::CEngineServiceMgr::LoopTick', signature: 'void engine2::CEngineServiceMgr::LoopTick(double frameDt)' }
    ],
    cyberpunk: [
      { module: 'Cyberpunk2077.exe', rva_start: '0x418200', rva_end: '0x418680', name: 'red4::SceneGraph::GatherVisibleClusters', signature: 'void red4::SceneGraph::GatherVisibleClusters(const Frustum&)' },
      { module: 'Cyberpunk2077.exe', rva_start: '0x52C900', rva_end: '0x52CE00', name: 'red4::RenderProxy::WaitGpuFence', signature: 'void red4::RenderProxy::WaitGpuFence(uint64_t fenceVal)' }
    ],
    sql: [
      { module: 'sqlmin.dll', rva_start: '0x18B400', rva_end: '0x18B820', name: 'sqlmin::SOS_RWLock::GetLongWait', signature: 'void sqlmin::SOS_RWLock::GetLongWait(SOS_Task*)' },
      { module: 'sqlmin.dll', rva_start: '0x219000', rva_end: '0x219540', name: 'sqlmin::BPool::LookupPageHash', signature: 'BUF* sqlmin::BPool::LookupPageHash(PageId id)' }
    ]
  };

  function getSidecarForPid(pid) {
    if (pid === 14820 || pid === 19204 || pid === 27408) return SIDECAR_MAPS.source2;
    if (pid === 34112) return SIDECAR_MAPS.cyberpunk;
    if (pid === 41250) return SIDECAR_MAPS.sql;
    return SIDECAR_MAPS.source2;
  }

  // NtQuerySystemInformation(SystemModuleInformation, class 0x0B) kernel image snapshot (base + sizeBytes)
  const KERNEL_SYSTEM_MODULES = [
    {
      name: 'ntoskrnl.exe',
      base: 0xFFFFF80040000000n,
      sizeBytes: 0x01047000,
      rsdsGuid: 'A41C92F0-8E21-4B3A-9C12-5D8F1102A0E1',
      rsdsAge: 1,
      pdbLoaded: true,
      pdbPath: 'C:\\Symbols\\ntkrnlmp.pdb\\A41C92F08E214B3A9C125D8F1102A0E11\\ntkrnlmp.pdb',
      pdbSymbols: [
        { rvaStart: 0x00412000, rvaEnd: 0x00412400, name: 'KiSystemCall64' },
        { rvaStart: 0x00414000, rvaEnd: 0x00414500, name: 'KiPageFault' },
        { rvaStart: 0x00240000, rvaEnd: 0x00240600, name: 'KiRetireDpcList' },
        { rvaStart: 0x00242000, rvaEnd: 0x00242600, name: 'KiInterruptDispatch' },
        { rvaStart: 0x00260000, rvaEnd: 0x00260400, name: 'memcpy' },
        { rvaStart: 0x00310000, rvaEnd: 0x00310600, name: 'NtReadFile' },
        { rvaStart: 0x00312000, rvaEnd: 0x00312600, name: 'CcCopyRead' },
        { rvaStart: 0x00314000, rvaEnd: 0x00314600, name: 'CcMapData' },
        { rvaStart: 0x00350000, rvaEnd: 0x00350600, name: 'MmAccessFault' },
        { rvaStart: 0x00352000, rvaEnd: 0x00352600, name: 'MiZeroFault' },
        { rvaStart: 0x00354000, rvaEnd: 0x00354600, name: 'MiIssueHardFault' },
        { rvaStart: 0x00356000, rvaEnd: 0x00356500, name: 'KiFlushProcessTbWorker' },
        { rvaStart: 0x00380000, rvaEnd: 0x00380600, name: 'KeWaitForSingleObject' },
        { rvaStart: 0x00382000, rvaEnd: 0x00382600, name: 'KiSwapThread' },
        { rvaStart: 0x00384000, rvaEnd: 0x00384600, name: 'NtWaitForAlertByThreadId' }
      ]
    },
    { name: 'ntfs.sys',      base: 0xFFFFF80044000000n, sizeBytes: 0x00320000, pdbLoaded: false, exports: [{ rva: 0x018000, rvaEnd: 0x018600, name: 'NtfsFsdRead' }] },
    { name: 'fltmgr.sys',    base: 0xFFFFF80045000000n, sizeBytes: 0x00078000, pdbLoaded: false, exports: [{ rva: 0x006000, rvaEnd: 0x006600, name: 'FltpDispatch' }] },
    { name: 'WdFilter.sys',  base: 0xFFFFF80045200000n, sizeBytes: 0x00084000, pdbLoaded: false, exports: [{ rva: 0x012000, rvaEnd: 0x012600, name: 'MpPreCreate' }] },
    { name: 'stornvme.sys',  base: 0xFFFFF80045600000n, sizeBytes: 0x00048000, pdbLoaded: false, exports: [{ rva: 0x008000, rvaEnd: 0x008500, name: 'NVMeStartIo' }] },
    { name: 'storport.sys',  base: 0xFFFFF80045800000n, sizeBytes: 0x000E2000, pdbLoaded: false, exports: [{ rva: 0x014000, rvaEnd: 0x014600, name: 'RaidStartIoPacket' }] },
    { name: 'afd.sys',       base: 0xFFFFF80046000000n, sizeBytes: 0x000A8000, pdbLoaded: false, exports: [{ rva: 0x01A000, rvaEnd: 0x01A600, name: 'AfdFastIoDeviceControl' }] },
    { name: 'tcpip.sys',     base: 0xFFFFF80046200000n, sizeBytes: 0x00340000, pdbLoaded: false, exports: [{ rva: 0x022000, rvaEnd: 0x022600, name: 'TcpReceive' }] },
    { name: 'npfs.sys',      base: 0xFFFFF80046600000n, sizeBytes: 0x00024000, pdbLoaded: false, exports: [{ rva: 0x004000, rvaEnd: 0x004500, name: 'NpFsdRead' }] },
    { name: 'dxgkrnl.sys',   base: 0xFFFFF80047000000n, sizeBytes: 0x00460000, pdbLoaded: false, exports: [{ rva: 0x048000, rvaEnd: 0x048600, name: 'DxgkSubmitCommand' }] },
    { name: 'dxgmms2.sys',   base: 0xFFFFF80047600000n, sizeBytes: 0x00160000, pdbLoaded: false, exports: [{ rva: 0x018000, rvaEnd: 0x018500, name: 'VidSchiSubmitCommand' }] },
    { name: 'amdkmdag.sys',  base: 0xFFFFF80048000000n, sizeBytes: 0x03800000, pdbLoaded: false, exports: [{ rva: 0x110000, rvaEnd: 0x110600, name: 'AmdSubmitPacket' }] },
    { name: 'nvlddmkm.sys',  base: 0xFFFFF8004C000000n, sizeBytes: 0x03400000, pdbLoaded: false, exports: [{ rva: 0x092000, rvaEnd: 0x092600, name: 'nvDpcForIsr' }] },
    { name: 'e1d68x64.sys',  base: 0xFFFFF80050000000n, sizeBytes: 0x00090000, pdbLoaded: false, exports: [{ rva: 0x010000, rvaEnd: 0x010500, name: 'E1dMessageInterruptDpc' }] }
  ];

  function buildResolverForProcess(proc, loadSidecar = false) {
    const pid = proc ? proc.pid : 0;
    const resolver = new SymbolResolver(pid);

    // Load SystemModuleInformation (class 0x0B) kernel module snapshot for kernel-range SampledProfile frames
    resolver.loadKernelModules(KERNEL_SYSTEM_MODULES);

    // Common OS DLLs (Tier 2 PE Exports + Tier 1 OS PDB for ntdll/kernelbase)
    resolver.onModuleLoad({
      name: 'kernelbase.dll',
      base: 0x7FFA84000000n,
      sizeMiB: 3.4,
      pdbLoaded: false,
      exports: [
        { rva: 0x03A100, rvaEnd: 0x03A240, name: 'WaitForSingleObjectEx', ordinal: 1842 },
        { rva: 0x041200, rvaEnd: 0x041360, name: 'SleepConditionVariableSRW', ordinal: 1620 }
      ]
    });
    resolver.onModuleLoad({
      name: 'ntdll.dll',
      base: 0x7FFA88000000n,
      sizeMiB: 2.2,
      pdbLoaded: false,
      exports: [
        { rva: 0x09C400, rvaEnd: 0x09C4E0, name: 'NtWaitForSingleObject', ordinal: 422 },
        { rva: 0x0A1800, rvaEnd: 0x0A1980, name: 'RtlAcquireSRWLockExclusive', ordinal: 912 }
      ]
    });
    resolver.onModuleLoad({
      name: 'tier0.dll',
      base: 0x7FF9DE000000n,
      sizeMiB: 6.12,
      pdbLoaded: false,
      exports: [
        { rva: 0x024400, rvaEnd: 0x024620, name: 'mi_malloc_aligned', ordinal: 318 },
        { rva: 0x028900, rvaEnd: 0x028B40, name: 'CThreadEvent::Wait', ordinal: 411 }
      ]
    });

    // Source 2 stripped modules (Tier 4 .pdata by default -> upgrades to Tier 3 MAP when sidecar loaded)
    resolver.onModuleLoad({
      name: 'client.dll',
      base: 0x7FFA12000000n,
      sizeMiB: 68.42,
      pdbLoaded: false,
      pdata: [
        { beginAddress: 0x14A200, endAddress: 0x14A480 },
        { beginAddress: 0x2A8100, endAddress: 0x2A8540 },
        { beginAddress: 0x31F400, endAddress: 0x31F920 },
        { beginAddress: 0x412800, endAddress: 0x412B00 }
      ]
    });
    resolver.onModuleLoad({
      name: 'vphysics2.dll',
      base: 0x7FF9E8000000n,
      sizeMiB: 12.20,
      pdbLoaded: false,
      pdata: [
        { beginAddress: 0x08C100, endAddress: 0x08C4C0 },
        { beginAddress: 0x094200, endAddress: 0x094500 }
      ]
    });
    resolver.onModuleLoad({
      name: 'rendersystemvulkan.dll',
      base: 0x7FFA03000000n,
      sizeMiB: 26.85,
      pdbLoaded: false,
      pdata: [
        { beginAddress: 0x112000, endAddress: 0x1123F0 },
        { beginAddress: 0x11A800, endAddress: 0x11AC00 }
      ]
    });
    resolver.onModuleLoad({
      name: 'engine2.dll',
      base: 0x7FFA00000000n,
      sizeMiB: 24.12,
      pdbLoaded: false,
      pdata: [
        { beginAddress: 0x064000, endAddress: 0x064380 }
      ]
    });

    // PDB-backed rustc.exe / LLVM-19.dll
    resolver.onModuleLoad({
      name: 'rustc_driver-8a91c.dll',
      base: 0x7FF7E0000000n,
      sizeMiB: 146.20,
      pdbLoaded: true,
      pdbSymbols: [
        { rvaStart: 0x421000, rvaEnd: 0x421680, name: 'rustc_borrowck::polonius::solve_constraints', signature: 'fn rustc_borrowck::polonius::solve_constraints(&mut MirBorrowckCtxt)', file: 'compiler/rustc_borrowck/src/polonius/mod.rs', line: 214 },
        { rvaStart: 0x518400, rvaEnd: 0x518920, name: 'rustc_trait_selection::traits::select::evaluate_stack', signature: 'fn rustc_trait_selection::traits::select::evaluate_stack(&mut SelectionContext)', file: 'compiler/rustc_trait_selection/src/traits/select/mod.rs', line: 482 },
        { rvaStart: 0x602100, rvaEnd: 0x602540, name: 'rustc_mir_transform::inline::process_blocks', signature: 'fn rustc_mir_transform::inline::process_blocks(&mut Inliner)', file: 'compiler/rustc_mir_transform/src/inline.rs', line: 158 },
        { rvaStart: 0x110200, rvaEnd: 0x1104C0, name: 'rustc_interface::passes::run_compiler', signature: 'fn rustc_interface::passes::run_compiler(Config)', file: 'compiler/rustc_interface/src/passes.rs', line: 89 }
      ]
    });
    resolver.onModuleLoad({
      name: 'LLVM-19.dll',
      base: 0x7FF7EA000000n,
      sizeMiB: 98.40,
      pdbLoaded: true,
      pdbSymbols: [
        { rvaStart: 0x892000, rvaEnd: 0x892600, name: 'llvm::InstCombinerImpl::visitInstruction', signature: 'Instruction* llvm::InstCombinerImpl::visitInstruction(Instruction&)', file: 'llvm/lib/Transforms/InstCombine/InstructionCombining.cpp', line: 4120 },
        { rvaStart: 0x914200, rvaEnd: 0x914780, name: 'llvm::SelectionDAGISel::SelectCodeCommon', signature: 'void llvm::SelectionDAGISel::SelectCodeCommon(SDNode*, const unsigned char*)', file: 'llvm/lib/CodeGen/SelectionDAG/SelectionDAGISel.cpp', line: 2890 }
      ]
    });

    // PDB-backed blender.exe / cycles_kernel.dll / embree4.dll
    resolver.onModuleLoad({
      name: 'cycles_kernel.dll',
      base: 0x7FF850000000n,
      sizeMiB: 42.10,
      pdbLoaded: true,
      pdbSymbols: [
        { rvaStart: 0x120000, rvaEnd: 0x120580, name: 'ccl::integrator_shade_surface_avx2', signature: 'void ccl::integrator_shade_surface_avx2(KernelGlobals*, IntegratorStateCPU*)', file: 'intern/cycles/kernel/integrator/shade_surface.h', line: 312 },
        { rvaStart: 0x148200, rvaEnd: 0x148640, name: 'ccl::kernel_path_trace_work', signature: 'void ccl::kernel_path_trace_work(PathTraceWorkCPU*)', file: 'intern/cycles/integrator/path_trace_work_cpu.cpp', line: 104 }
      ]
    });
    resolver.onModuleLoad({
      name: 'embree4.dll',
      base: 0x7FF854000000n,
      sizeMiB: 36.20,
      pdbLoaded: true,
      pdbSymbols: [
        { rvaStart: 0x098400, rvaEnd: 0x098900, name: 'embree::avx2::BVHNIntersector1::intersect', signature: 'void embree::avx2::BVHNIntersector1::intersect(const BVH4*, RayHit&)', file: 'kernels/bvh/bvh_intersector1.cpp', line: 176 }
      ]
    });

    // Stripped Cyberpunk2077 / Chrome / JVM / SQL Server
    resolver.onModuleLoad({
      name: 'Cyberpunk2077.exe',
      base: 0x7FF6A0000000n,
      sizeMiB: 92.40,
      pdbLoaded: false,
      pdata: [
        { beginAddress: 0x418200, endAddress: 0x418680 },
        { beginAddress: 0x52C900, endAddress: 0x52CE00 }
      ]
    });
    resolver.onModuleLoad({
      name: 'chrome.dll',
      base: 0x7FF940000000n,
      sizeMiB: 214.80,
      pdbLoaded: false,
      pdata: [
        { beginAddress: 0x820400, endAddress: 0x820980 },
        { beginAddress: 0x914000, endAddress: 0x914540 },
        { beginAddress: 0xA42100, endAddress: 0xA42580 }
      ]
    });
    resolver.onModuleLoad({
      name: 'jvm.dll',
      base: 0x7FF870000000n,
      sizeMiB: 28.40,
      pdbLoaded: false,
      pdata: [
        { beginAddress: 0x224100, endAddress: 0x224600 },
        { beginAddress: 0x28C400, endAddress: 0x28C920 }
      ]
    });
    resolver.onModuleLoad({
      name: 'sqlmin.dll',
      base: 0x7FF880000000n,
      sizeMiB: 48.20,
      pdbLoaded: false,
      pdata: [
        { beginAddress: 0x18B400, endAddress: 0x18B820 },
        { beginAddress: 0x219000, endAddress: 0x219540 },
        { beginAddress: 0x2A4000, endAddress: 0x2A4400 }
      ]
    });
    resolver.onModuleLoad({
      name: 'sqllang.dll',
      base: 0x7FF886000000n,
      sizeMiB: 39.60,
      pdbLoaded: false,
      pdata: [
        { beginAddress: 0x0C4200, endAddress: 0x0C4680 }
      ]
    });

    if (loadSidecar) {
      resolver.loadSidecarJson(getSidecarForPid(pid));
    }
    return resolver;
  }

  function getThreadsForProcess(proc) {
    if (proc && Array.isArray(proc.threads) && proc.threads.length > 0) {
      return proc.threads.map((t, idx) => ({
        tid: t.tid,
        name: (t.description && t.description.trim())
          ? t.description.trim()
          : (typeof Z.formatThreadEntry === 'function' ? Z.formatThreadEntry(t, proc.modules) : `TID ${t.tid}`),
        cpuPct: t.cpuPct ?? t.baseCpuPct ?? 0,
        state: t.state || 'Running',
        waitReason: t.waitReason || '-',
        ctxSw: t.ctxSwPerSec ?? t.baseCtxSw ?? 0,
        cpu: t.currentCpu ?? (idx * 2) % 12,
        ccx: (t.currentCpu ?? 0) < 6 ? 0 : 1
      }));
    }
    const pid = proc ? proc.pid : 14820;
    return PROCESS_THREADS[pid] || PROCESS_THREADS[14820];
  }

  // Generate realistic ETW On-CPU + Off-CPU batches per process
  function getEtwTemplatesForPid(pid, proc = null) {
    const threads = getThreadsForProcess(proc || { pid });
    const tAt = (i) => threads[Math.min(i, threads.length - 1)] || { tid: pid + 4, name: 'MainThread' };
    const t0 = tAt(0), t1 = tAt(1), t2 = tAt(2), t3 = tAt(3);

    if (pid === 31088) { // rustc.exe
      return {
        onCpu: [
          { tid: t0.tid, weight: 38, stack: [
            { module: 'rustc_driver-8a91c.dll', rva: 0x110240 },
            { module: 'rustc_driver-8a91c.dll', rva: 0x518440 },
            { module: 'rustc_driver-8a91c.dll', rva: 0x421080 }
          ]},
          { tid: t1.tid, weight: 29, stack: [
            { module: 'rustc_driver-8a91c.dll', rva: 0x110240 },
            { module: 'LLVM-19.dll', rva: 0x8920C0 }
          ]},
          { tid: t2.tid, weight: 21, stack: [
            { module: 'rustc_driver-8a91c.dll', rva: 0x110240 },
            { module: 'LLVM-19.dll', rva: 0x914260 }
          ]},
          { tid: t3.tid, weight: 12, stack: [
            { module: 'rustc_driver-8a91c.dll', rva: 0x110240 },
            { module: 'rustc_driver-8a91c.dll', rva: 0x602180 }
          ]},
          // Kernel SampledProfile frames (Memory Manager commit/zero-fault + AV minifilter)
          { tid: t0.tid, weight: 8, stack: [
            { module: 'rustc_driver-8a91c.dll', rva: 0x110240 },
            { module: 'ntoskrnl.exe', rva: 0x00414040 },
            { module: 'ntoskrnl.exe', rva: 0x00350080 },
            { module: 'ntoskrnl.exe', rva: 0x00352080 },
            { module: 'ntoskrnl.exe', rva: 0x00260040 }
          ]},
          { tid: t1.tid, weight: 4, stack: [
            { module: 'rustc_driver-8a91c.dll', rva: 0x110240 },
            { module: 'ntoskrnl.exe', rva: 0x00412040 },
            { module: 'ntoskrnl.exe', rva: 0x00310080 },
            { module: 'fltmgr.sys', rva: 0x006040 },
            { module: 'WdFilter.sys', rva: 0x012040 }
          ]}
        ],
        offCpu: [
          { tid: t0.tid, threadName: t0.name, wakerTid: t1.tid, wakerName: t1.name, durUs: 1850, stack: [
            { module: 'rustc_driver-8a91c.dll', rva: 0x110240 },
            { module: 'kernelbase.dll', rva: 0x041240 }
          ]},
          { tid: t1.tid, threadName: t1.name, wakerTid: t0.tid, wakerName: t0.name, durUs: 920, stack: [
            { module: 'LLVM-19.dll', rva: 0x8920C0 },
            { module: 'ntdll.dll', rva: 0x0A1840 }
          ]}
        ]
      };
    }
    if (pid === 41250) { // sqlservr.exe (Heavy Off-CPU CSwitch lock storm)
      return {
        onCpu: [
          { tid: t0.tid, weight: 36, stack: [
            { module: 'sqllang.dll', rva: 0x0C4240 },
            { module: 'sqlmin.dll', rva: 0x219080 }
          ]},
          { tid: t2.tid, weight: 28, stack: [
            { module: 'sqllang.dll', rva: 0x0C4240 },
            { module: 'sqlmin.dll', rva: 0x2A4080 }
          ]},
          { tid: t1.tid, weight: 24, stack: [
            { module: 'sqllang.dll', rva: 0x0C4240 },
            { module: 'sqlmin.dll', rva: 0x18B440 }
          ]},
          { tid: t3.tid, weight: 12, stack: [
            { module: 'sqlmin.dll', rva: 0x18B440 },
            { module: 'ntdll.dll', rva: 0x0A1840 }
          ]},
          { tid: t0.tid, weight: 8, stack: [
            { module: 'sqlmin.dll', rva: 0x18B440 },
            { module: 'ntoskrnl.exe', rva: 0x00412040 },
            { module: 'ntoskrnl.exe', rva: 0x00384040 },
            { module: 'ntoskrnl.exe', rva: 0x00382040 }
          ]}
        ],
        offCpu: [
          { tid: t0.tid, threadName: t0.name, wakerTid: t2.tid, wakerName: t2.name, durUs: 4620, stack: [
            { module: 'sqllang.dll', rva: 0x0C4240 },
            { module: 'sqlmin.dll', rva: 0x18B440 },
            { module: 'kernelbase.dll', rva: 0x03A120 }
          ]},
          { tid: t1.tid, threadName: t1.name, wakerTid: t2.tid, wakerName: t2.name, durUs: 3840, stack: [
            { module: 'sqllang.dll', rva: 0x0C4240 },
            { module: 'sqlmin.dll', rva: 0x18B440 },
            { module: 'ntdll.dll', rva: 0x0A1840 }
          ]},
          { tid: t3.tid, threadName: t3.name, wakerTid: t0.tid, wakerName: t0.name, durUs: 1410, stack: [
            { module: 'sqlmin.dll', rva: 0x219080 },
            { module: 'kernelbase.dll', rva: 0x041240 }
          ]}
        ]
      };
    }
    if (pid === 22910) { // blender.exe
      return {
        onCpu: [
          { tid: t0.tid, weight: 46, stack: [
            { module: 'cycles_kernel.dll', rva: 0x148240 },
            { module: 'cycles_kernel.dll', rva: 0x120080 }
          ]},
          { tid: t1.tid, weight: 38, stack: [
            { module: 'cycles_kernel.dll', rva: 0x148240 },
            { module: 'embree4.dll', rva: 0x098480 }
          ]},
          { tid: t2.tid, weight: 16, stack: [
            { module: 'cycles_kernel.dll', rva: 0x148240 },
            { module: 'tier0.dll', rva: 0x024440 }
          ]}
        ],
        offCpu: [
          { tid: t3.tid, threadName: t3.name, wakerTid: t0.tid, wakerName: t0.name, durUs: 2400, stack: [
            { module: 'cycles_kernel.dll', rva: 0x148240 },
            { module: 'kernelbase.dll', rva: 0x03A120 }
          ]}
        ]
      };
    }
    if (pid === 34112) { // cyberpunk2077.exe
      return {
        onCpu: [
          { tid: t0.tid, weight: 42, stack: [
            { module: 'Cyberpunk2077.exe', rva: 0x418260 }
          ]},
          { tid: t1.tid, weight: 36, stack: [
            { module: 'Cyberpunk2077.exe', rva: 0x418260 },
            { module: 'Cyberpunk2077.exe', rva: 0x52C940 }
          ]},
          { tid: t2.tid, weight: 22, stack: [
            { module: 'Cyberpunk2077.exe', rva: 0x418260 },
            { module: 'ntdll.dll', rva: 0x09C420 }
          ]},
          { tid: t2.tid, weight: 6, stack: [
            { module: 'Cyberpunk2077.exe', rva: 0x418260 },
            { module: 'ntoskrnl.exe', rva: 0x00412040 },
            { module: 'storport.sys', rva: 0x014040 },
            { module: 'stornvme.sys', rva: 0x008040 }
          ]}
        ],
        offCpu: [
          { tid: t1.tid, threadName: t1.name, wakerTid: t0.tid, wakerName: t0.name, durUs: 6200, stack: [
            { module: 'Cyberpunk2077.exe', rva: 0x52C940 },
            { module: 'kernelbase.dll', rva: 0x03A120 }
          ]}
        ]
      };
    }
    if (pid === 6104) { // chrome.exe
      return {
        onCpu: [
          { tid: t0.tid, weight: 44, stack: [
            { module: 'chrome.dll', rva: 0x820460 },
            { module: 'chrome.dll', rva: 0x914080 }
          ]},
          { tid: t1.tid, weight: 34, stack: [
            { module: 'chrome.dll', rva: 0x820460 },
            { module: 'chrome.dll', rva: 0xA42160 }
          ]},
          { tid: t2.tid, weight: 22, stack: [
            { module: 'chrome.dll', rva: 0x914080 }
          ]}
        ],
        offCpu: [
          { tid: t0.tid, threadName: t0.name, wakerTid: t1.tid, wakerName: t1.name, durUs: 3100, stack: [
            { module: 'chrome.dll', rva: 0x820460 },
            { module: 'kernelbase.dll', rva: 0x03A120 }
          ]}
        ]
      };
    }
    if (pid === 38904) { // javaw.exe
      return {
        onCpu: [
          { tid: t0.tid, weight: 48, stack: [
            { module: 'jvm.dll', rva: 0x224140 },
            { module: 'jvm.dll', rva: 0x28C480 }
          ]},
          { tid: t1.tid, weight: 34, stack: [
            { module: 'jvm.dll', rva: 0x28C480 }
          ]},
          { tid: t2.tid, weight: 18, stack: [
            { module: 'jvm.dll', rva: 0x224140 }
          ]}
        ],
        offCpu: [
          { tid: t0.tid, threadName: t0.name, wakerTid: t1.tid, wakerName: t1.name, durUs: 4100, stack: [
            { module: 'jvm.dll', rva: 0x28C480 },
            { module: 'kernelbase.dll', rva: 0x041240 }
          ]}
        ]
      };
    }

    // Default: Source 2 (deadlock.exe 14820 / 19204, cs2.exe 27408)
    return {
      onCpu: [
        { tid: t0.tid, weight: 36, stack: [
          { module: 'engine2.dll', rva: 0x064040 },
          { module: 'client.dll', rva: 0x31F440 },
          { module: 'client.dll', rva: 0x14A260 }
        ]},
        { tid: t0.tid, weight: 22, stack: [
          { module: 'engine2.dll', rva: 0x064040 },
          { module: 'client.dll', rva: 0x31F440 },
          { module: 'client.dll', rva: 0x2A8180 }
        ]},
        { tid: t1.tid, weight: 19, stack: [
          { module: 'engine2.dll', rva: 0x064040 },
          { module: 'rendersystemvulkan.dll', rva: 0x112080 }
        ]},
        { tid: t2.tid, weight: 14, stack: [
          { module: 'client.dll', rva: 0x14A260 },
          { module: 'vphysics2.dll', rva: 0x08C140 }
        ]},
        { tid: t3.tid, weight: 9, stack: [
          { module: 'client.dll', rva: 0x2A8180 },
          { module: 'tier0.dll', rva: 0x024440 }
        ]},
        { tid: t1.tid, weight: 5, stack: [
          { module: 'rendersystemvulkan.dll', rva: 0x112080 },
          { module: 'ntoskrnl.exe', rva: 0x00412040 },
          { module: 'dxgkrnl.sys', rva: 0x048040 },
          { module: 'amdkmdag.sys', rva: 0x110040 }
        ]},
        ...(pid === 27408 ? [{ tid: t0.tid, weight: 3, stack: [
          { module: 'engine2.dll', rva: 0x064040 },
          { module: 'ntoskrnl.exe', rva: 0x00240040 },
          { module: 'nvlddmkm.sys', rva: 0x092040 }
        ]}] : [])
      ],
      offCpu: [
        { tid: t0.tid, threadName: t0.name, wakerTid: t1.tid, wakerName: t1.name, durUs: 3820, stack: [
          { module: 'engine2.dll', rva: 0x064040 },
          { module: 'tier0.dll', rva: 0x028920 },
          { module: 'kernelbase.dll', rva: 0x03A120 }
        ]},
        { tid: t1.tid, threadName: t1.name, wakerTid: t0.tid, wakerName: t0.name, durUs: 1940, stack: [
          { module: 'rendersystemvulkan.dll', rva: 0x112080 },
          { module: 'ntdll.dll', rva: 0x09C420 }
        ]},
        { tid: t2.tid, threadName: t2.name, wakerTid: t0.tid, wakerName: t0.name, durUs: 1210, stack: [
          { module: 'vphysics2.dll', rva: 0x08C140 },
          { module: 'kernelbase.dll', rva: 0x041240 }
        ]}
      ]
    };
  }

  // Generate realistic AMDuProfCLI report.csv text per process + burst type
  function generateBurstCsvForProcess(proc, burstType) {
    const pid = proc ? proc.pid : 14820;
    const threads = getThreadsForProcess(proc || { pid });
    const t0 = threads[0].tid;
    const t1 = (threads[1] || threads[0]).tid;

    if (pid === 31088) { // rustc.exe
      if (burstType === 'branch_miss') {
        return [
          'Function,Module,RVA,Self Samples,Inclusive Samples,Avg Load Latency (cyc),Data Source,Call Stack,TID',
          `rustc_borrowck::polonius::solve_constraints,rustc_driver-8a91c.dll,0x421080,1480,1520,0,,rustc_driver-8a91c.dll!rustc_interface::passes::run_compiler@0x110240 > rustc_driver-8a91c.dll!rustc_trait_selection::traits::select::evaluate_stack@0x518440,${t0}`,
          `llvm::InstCombinerImpl::visitInstruction,LLVM-19.dll,0x8920C0,940,940,0,,rustc_driver-8a91c.dll!rustc_interface::passes::run_compiler@0x110240,${t1}`,
          `rustc_trait_selection::traits::select::evaluate_stack,rustc_driver-8a91c.dll,0x518440,610,2090,0,,rustc_driver-8a91c.dll!rustc_interface::passes::run_compiler@0x110240,${t0}`,
          `llvm::SelectionDAGISel::SelectCodeCommon,LLVM-19.dll,0x914260,420,420,0,,rustc_driver-8a91c.dll!rustc_interface::passes::run_compiler@0x110240,${t1}`
        ].join('\n');
      }
      if (burstType === 'tlb_walk') {
        return [
          'Function,Module,RVA,Self Samples,Inclusive Samples,Avg Load Latency (cyc),Data Source,Call Stack,TID',
          `llvm::SelectionDAGISel::SelectCodeCommon,LLVM-19.dll,0x914260,1120,1120,0,,rustc_driver-8a91c.dll!rustc_interface::passes::run_compiler@0x110240,${t1}`,
          `rustc_trait_selection::traits::select::evaluate_stack,rustc_driver-8a91c.dll,0x518440,780,780,0,,rustc_driver-8a91c.dll!rustc_interface::passes::run_compiler@0x110240,${t0}`,
          `llvm::InstCombinerImpl::visitInstruction,LLVM-19.dll,0x8920C0,490,490,0,,rustc_driver-8a91c.dll!rustc_interface::passes::run_compiler@0x110240,${t1}`
        ].join('\n');
      }
      return [
        'Function,Module,RVA,Self Samples,Inclusive Samples,Avg Load Latency (cyc),Data Source,Call Stack,TID',
        `rustc_borrowck::polonius::solve_constraints,rustc_driver-8a91c.dll,0x421080,1260,1260,214,DRAM,rustc_driver-8a91c.dll!rustc_interface::passes::run_compiler@0x110240 > rustc_driver-8a91c.dll!rustc_trait_selection::traits::select::evaluate_stack@0x518440,${t0}`,
        `llvm::InstCombinerImpl::visitInstruction,LLVM-19.dll,0x8920C0,880,880,168,L3,rustc_driver-8a91c.dll!rustc_interface::passes::run_compiler@0x110240,${t1}`,
        `rustc_mir_transform::inline::process_blocks,rustc_driver-8a91c.dll,0x602180,520,520,42,L2,rustc_driver-8a91c.dll!rustc_interface::passes::run_compiler@0x110240,${t0}`
      ].join('\n');
    }

    if (pid === 41250) { // sqlservr.exe (raw hex RVAs enriched by SymbolResolver!)
      return [
        'Function,Module,RVA,Self Samples,Inclusive Samples,Avg Load Latency (cyc),Data Source,Call Stack,TID',
        `0x219080,sqlmin.dll,0x219080,1420,1420,238,DRAM,sqllang.dll!0x0C4240@0x0C4240,${t0}`,
        `0x18B440,sqlmin.dll,0x18B440,980,980,192,L3,sqllang.dll!0x0C4240@0x0C4240,${t1}`,
        `0x2A4080,sqlmin.dll,0x2A4080,460,460,46,L2,sqllang.dll!0x0C4240@0x0C4240,${t0}`
      ].join('\n');
    }

    // Source 2 / generic stripped binaries: deliberately emit raw hex function names in CSV
    // so parseUprofBurstReportCsv demonstrates live Tier 3/4 SymbolResolver enrichment!
    if (burstType === 'branch_miss') {
      return [
        'Function,Module,RVA,Self Samples,Inclusive Samples,Avg Load Latency (cyc),Data Source,Call Stack,TID',
        `0x2A8180,client.dll,0x2A8180,1380,1380,0,,engine2.dll!0x064040@0x064040 > client.dll!0x31F440@0x31F440,${t0}`,
        `0x14A260,client.dll,0x14A260,860,860,0,,engine2.dll!0x064040@0x064040 > client.dll!0x31F440@0x31F440,${t0}`,
        `0x08C140,vphysics2.dll,0x08C140,540,540,0,,client.dll!0x14A260@0x14A260,${t1}`,
        `0x112080,rendersystemvulkan.dll,0x112080,320,320,0,,engine2.dll!0x064040@0x064040,${t1}`
      ].join('\n');
    }
    if (burstType === 'tlb_walk') {
      return [
        'Function,Module,RVA,Self Samples,Inclusive Samples,Avg Load Latency (cyc),Data Source,Call Stack,TID',
        `0x31F440,client.dll,0x31F440,1190,1190,0,,engine2.dll!0x064040@0x064040,${t0}`,
        `0x14A260,client.dll,0x14A260,740,740,0,,engine2.dll!0x064040@0x064040 > client.dll!0x31F440@0x31F440,${t0}`,
        `0x112080,rendersystemvulkan.dll,0x112080,580,580,0,,engine2.dll!0x064040@0x064040,${t1}`,
        `0x08C140,vphysics2.dll,0x08C140,390,390,0,,client.dll!0x14A260@0x14A260,${t1}`
      ].join('\n');
    }
    if (burstType === 'dram_l3') {
      return [
        'Function,Module,RVA,Self Samples,Inclusive Samples,Avg Load Latency (cyc),Data Source,Call Stack,TID',
        `0x14A260,client.dll,0x14A260,1640,1640,224,DRAM,engine2.dll!0x064040@0x064040 > client.dll!0x31F440@0x31F440,${t0}`,
        `0x08C140,vphysics2.dll,0x08C140,920,920,186,L3,client.dll!0x14A260@0x14A260,${t1}`,
        `0x2A8180,client.dll,0x2A8180,580,580,212,DRAM,engine2.dll!0x064040@0x064040 > client.dll!0x31F440@0x31F440,${t0}`,
        `0x112080,rendersystemvulkan.dll,0x112080,410,410,44,L2,engine2.dll!0x064040@0x064040,${t1}`
      ].join('\n');
    }

    // Default: IBS Op Load Latency
    return [
      'Function,Module,RVA,Self Samples,Inclusive Samples,Avg Load Latency (cyc),Data Source,Call Stack,TID',
      `0x14A260,client.dll,0x14A260,1520,1520,234,DRAM,engine2.dll!0x064040@0x064040 > client.dll!0x31F440@0x31F440,${t0}`,
      `0x08C140,vphysics2.dll,0x08C140,890,890,148,L3,client.dll!0x14A260@0x14A260,${t1}`,
      `0x2A8180,client.dll,0x2A8180,610,610,208,DRAM,engine2.dll!0x064040@0x064040 > client.dll!0x31F440@0x31F440,${t0}`,
      `0x112080,rendersystemvulkan.dll,0x112080,420,420,42,L2,engine2.dll!0x064040@0x064040,${t1}`,
      `mi_malloc_aligned,tier0.dll,0x024440,260,260,28,L2,client.dll!0x2A8180@0x2A8180,${t0}`
    ].join('\n');
  }

  Object.assign(Z, {
    PROCESS_THREADS,
    SIDECAR_MAPS,
    KERNEL_SYSTEM_MODULES,
    getThreadsForProcess,
    getSidecarForPid,
    buildResolverForProcess,
    getEtwTemplatesForPid,
    generateBurstCsvForProcess
  });
})();
