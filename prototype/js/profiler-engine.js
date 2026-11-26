// Dual-Engine Profiler: Live Zero-PMC ETW (On-CPU + Off-CPU) & AMDuProfCLI Hardware-Stall/IBS Burst Engine
(() => {
  'use strict';
  const Z = window.Zen2Top || (window.Zen2Top = {});
  const { SymbolResolver, KERNEL_ADDR_MIN, isKernelAddress, parseRva, fmtHexRva } = Z;

  const ETW_KERNEL_FLAGS = Object.freeze({
    EVENT_TRACE_FLAG_PROFILE: 0x01000000,
    EVENT_TRACE_FLAG_CSWITCH: 0x00000010,
    EVENT_TRACE_FLAG_DISPATCHER: 0x00000800, // ReadyThread event type 0x32
    EVENT_TRACE_FLAG_IMAGE_LOAD: 0x00000004,
    EVENT_TRACE_FLAG_DISK_IO: 0x00000100     // Physical storage IRPs only (never SYSTEMCALL)
  });

  const KERNEL_SYS_BUCKETS = Object.freeze([
    { id: 'gpu_driver',         label: 'GPU / Display KMD',      shortLabel: 'GPU KMD',    color: '#d98d59', barColor: 'var(--orange)',  hatched: false },
    { id: 'cached_io',          label: 'Cached File I/O',        shortLabel: 'Cached I/O', color: '#5fb4c9', barColor: 'var(--cyan)',    hatched: false },
    { id: 'physical_storage',   label: 'Physical Storage',       shortLabel: 'Phys Disk',  color: '#dfb052', barColor: 'var(--yellow)',  hatched: false },
    { id: 'memory_manager',     label: 'Memory Manager',         shortLabel: 'Mem Mgr',    color: '#b380d6', barColor: 'var(--magenta)', hatched: false },
    { id: 'av_minifilter',      label: 'AV / Minifilter',        shortLabel: 'AV Filter',  color: '#e06464', barColor: 'var(--red)',     hatched: false },
    { id: 'network_ipc',        label: 'Network / IPC Pipes',    shortLabel: 'Net/Pipes',  color: '#6b96d6', barColor: 'var(--blue)',    hatched: false },
    { id: 'scheduler_sync',     label: 'Scheduler & Sync',       shortLabel: 'Sched/Sync', color: '#5dc27f', barColor: 'var(--green)',   hatched: false },
    { id: 'preempting_dpc_isr', label: 'DPC / Hardware ISR',     shortLabel: 'DPC/ISR',    color: '#e06464', barColor: 'var(--red)',     hatched: true },
    { id: 'other_kernel',       label: 'Other Kernel',           shortLabel: 'Other Krnl', color: '#6f7785', barColor: 'var(--fg-dim)',  hatched: false }
  ]);

  const CACHED_IO_DRIVERS = new Set(['ntfs.sys', 'fastfat.sys', 'refs.sys']);
  const AV_FILTER_DRIVERS = new Set([
    'fltmgr.sys', 'wdfilter.sys', 'eamonm.sys', 'klif.sys', 'mbamchameleon.sys',
    'csagent.sys', 'sentinelmonitor.sys', 'bedaisy.sys', 'vgk.sys',
    'easyanticheat_eos.sys', 'easyanticheat.sys', 'faceit.sys'
  ]);
  const PHYSICAL_STORAGE_DRIVERS = new Set([
    'stornvme.sys', 'storport.sys', 'partmgr.sys', 'volmgr.sys', 'classpnp.sys', 'disk.sys', 'storahci.sys'
  ]);
  const NETWORK_IPC_DRIVERS = new Set(['afd.sys', 'tcpip.sys', 'ndis.sys', 'npfs.sys', 'msfs.sys']);
  const GPU_KMD_DRIVERS = new Set([
    'dxgkrnl.sys', 'dxgmms2.sys', 'amdkmdag.sys', 'nvlddmkm.sys', 'igdkmd64.sys', 'igdkmdn64.sys'
  ]);

  const DPC_ISR_FRAME_RE = /^(?:KiRetireDpcList|KiInterruptDispatch)/i;
  const SYSCALL_ENTRY_RE = /^(?:KiSystemCall64|KiSystemService)/i;
  const HARD_FAULT_FRAME_RE = /^MiIssueHardFault/i;
  const CACHED_IO_FRAME_RE = /^(?:Cc[A-Z]|NtReadFile|NtWriteFile|ZwReadFile|ZwWriteFile)/;
  const MEM_MGR_FRAME_RE = /^(?:Mi[A-Z]|Mm[A-Z]|KiFlushProcessTb)/;
  const SCHED_SYNC_FRAME_RE = /^(?:Ke[A-Z]|KiSwapThread|Exp[A-Z]|NtWaitFor)/;
  const AV_DRIVER_NAME_RE = /(?:filter|wdfilter|fltmgr|anticheat|bedaisy|vgk)\.sys$/i;

  function isKernelFrame(frame) {
    if (!frame) return false;
    if (frame.isKernel === true) return true;
    if (frame.va !== undefined && frame.va !== null && isKernelAddress(frame.va)) return true;
    if (frame.base !== undefined && frame.base !== null && isKernelAddress(frame.base)) return true;
    const mod = String(frame.module || '').toLowerCase();
    return mod === 'ntoskrnl.exe' || mod === 'hal.dll' || mod.endsWith('.sys');
  }

  function frameSymbolName(frame) {
    if (!frame) return '';
    const raw = String(frame.displayName || frame.name || '');
    const bang = raw.lastIndexOf('!');
    return bang >= 0 ? raw.slice(bang + 1) : raw;
  }

  /**
   * Classify a single kernel-mode SampledProfile stack (ordered ROOT -> ... -> LEAF).
   * 1. Requires leaf IP in kernel space (>= 0xFFFF800000000000 on x64).
   * 2. Isolates KiRetireDpcList / KiInterruptDispatch frames into preempting_dpc_isr and extracts offending .sys driver.
   * 3. Walks kernel stack from syscall entry (KiSystemCall64) upward so shared helpers like ntoskrnl!memcpy are billed
   *    to the exact invoking driver or syscall/subsystem (Tier 1 driver modules work even with zero PDBs).
   */
  function classifyKernelStack(stackFrames, opts = {}) {
    if (!Array.isArray(stackFrames) || stackFrames.length === 0) return null;
    const frames = opts.leafFirst ? [...stackFrames].reverse() : stackFrames;
    const leaf = frames[frames.length - 1];
    if (!isKernelFrame(leaf)) return null;

    // Locate the kernel portion of the stack
    let firstKernelIdx = -1;
    for (let i = 0; i < frames.length; i++) {
      if (isKernelFrame(frames[i])) {
        firstKernelIdx = i;
        break;
      }
    }
    if (firstKernelIdx < 0) return null;
    const kernelFrames = frames.slice(firstKernelIdx);

    // Anti-misattribution rule 2: Isolate KiRetireDpcList / KiInterruptDispatch frames FIRST
    let dpcIdx = -1;
    for (let i = 0; i < kernelFrames.length; i++) {
      if (DPC_ISR_FRAME_RE.test(frameSymbolName(kernelFrames[i]))) {
        dpcIdx = i;
        break;
      }
    }
    if (dpcIdx >= 0) {
      let offendingDriver = null;
      let offendingFrame = null;
      for (let i = dpcIdx + 1; i < kernelFrames.length; i++) {
        const mod = String(kernelFrames[i].module || '');
        const low = mod.toLowerCase();
        if (low.endsWith('.sys') && low !== 'ntoskrnl.exe' && low !== 'hal.dll') {
          offendingDriver = mod;
          offendingFrame = `${mod}!${frameSymbolName(kernelFrames[i])}`;
          break;
        }
      }
      if (!offendingDriver) {
        const leafMod = String(leaf.module || '');
        offendingDriver = leafMod.toLowerCase().endsWith('.sys') ? leafMod : (leafMod || 'ntoskrnl.exe');
        offendingFrame = `${offendingDriver}!${frameSymbolName(leaf)}`;
      }
      return {
        bucket: 'preempting_dpc_isr',
        driver: offendingDriver,
        topFrame: offendingFrame,
        isFault: false,
        isPreemptingDpc: true
      };
    }

    // Anti-misattribution rule 1: Walk from KiSystemCall64 (or kernel boundary) upward toward leaf
    let startIdx = 0;
    let isFaultStack = false;
    for (let i = 0; i < kernelFrames.length; i++) {
      const sym = frameSymbolName(kernelFrames[i]);
      if (/^(?:KiPageFault|MmAccessFault|Mi[A-Z])/i.test(sym)) isFaultStack = true;
      if (SYSCALL_ENTRY_RE.test(sym)) {
        startIdx = i + 1;
        break;
      }
    }
    const walkFrames = startIdx < kernelFrames.length ? kernelFrames.slice(startIdx) : kernelFrames;

    // Tier 1: Driver Module classification (works offline with zero PDBs) + MiIssueHardFault check
    let avDriver = null;
    let avFrame = null;
    let genericFltmgr = null;
    let genericFltmgrFrame = null;
    let physDriver = null;
    let physFrame = null;
    let gpuDriver = null;
    let gpuFrame = null;
    let gpuDxgkrnl = null;
    let gpuDxgkrnlFrame = null;
    let netDriver = null;
    let netFrame = null;
    let fsDriver = null;
    let fsFrame = null;

    for (const f of walkFrames) {
      const mod = String(f.module || '');
      const low = mod.toLowerCase();
      const sym = frameSymbolName(f);
      const qualified = sym ? `${mod}!${sym}` : mod;

      if (AV_FILTER_DRIVERS.has(low) || (low.endsWith('.sys') && AV_DRIVER_NAME_RE.test(low))) {
        if (low === 'fltmgr.sys') {
          if (!genericFltmgr) { genericFltmgr = mod; genericFltmgrFrame = qualified; }
        } else if (!avDriver) {
          avDriver = mod; avFrame = qualified;
        }
      }
      if (PHYSICAL_STORAGE_DRIVERS.has(low) || HARD_FAULT_FRAME_RE.test(sym)) {
        if (HARD_FAULT_FRAME_RE.test(sym)) isFaultStack = true;
        if (!physDriver) {
          physDriver = low.endsWith('.sys') ? mod : 'ntoskrnl.exe';
          physFrame = qualified;
        }
      }
      if (GPU_KMD_DRIVERS.has(low)) {
        if (low === 'dxgkrnl.sys' || low === 'dxgmms2.sys') {
          if (!gpuDxgkrnl) { gpuDxgkrnl = mod; gpuDxgkrnlFrame = qualified; }
        } else if (!gpuDriver) {
          gpuDriver = mod; gpuFrame = qualified;
        }
      }
      if (NETWORK_IPC_DRIVERS.has(low) && !netDriver) {
        netDriver = mod; netFrame = qualified;
      }
      if (CACHED_IO_DRIVERS.has(low) && !fsDriver) {
        fsDriver = mod; fsFrame = qualified;
      }
    }

    if (avDriver || genericFltmgr) {
      return { bucket: 'av_minifilter', driver: avDriver || genericFltmgr, topFrame: avFrame || genericFltmgrFrame, isFault: false, isPreemptingDpc: false };
    }
    if (physDriver) {
      return { bucket: 'physical_storage', driver: physDriver, topFrame: physFrame, isFault: isFaultStack, isPreemptingDpc: false };
    }
    if (gpuDriver || gpuDxgkrnl) {
      return { bucket: 'gpu_driver', driver: gpuDriver || gpuDxgkrnl, topFrame: gpuFrame || gpuDxgkrnlFrame, isFault: false, isPreemptingDpc: false };
    }
    if (netDriver) {
      return { bucket: 'network_ipc', driver: netDriver, topFrame: netFrame, isFault: false, isPreemptingDpc: false };
    }
    if (fsDriver) {
      return { bucket: 'cached_io', driver: fsDriver, topFrame: fsFrame, isFault: false, isPreemptingDpc: false };
    }

    // Tier 2: ntoskrnl.pdb prefixes / syscall frames (walked entry -> leaf so memcpy is attributed to caller)
    for (const f of walkFrames) {
      const sym = frameSymbolName(f);
      const mod = f.module || 'ntoskrnl.exe';
      const qualified = sym ? `${mod}!${sym}` : mod;
      if (CACHED_IO_FRAME_RE.test(sym)) {
        return { bucket: 'cached_io', driver: mod, topFrame: qualified, isFault: false, isPreemptingDpc: false };
      }
      if (MEM_MGR_FRAME_RE.test(sym)) {
        return { bucket: 'memory_manager', driver: mod, topFrame: qualified, isFault: true, isPreemptingDpc: false };
      }
      if (SCHED_SYNC_FRAME_RE.test(sym)) {
        return { bucket: 'scheduler_sync', driver: mod, topFrame: qualified, isFault: false, isPreemptingDpc: false };
      }
    }

    const leafMod = leaf.module || 'ntoskrnl.exe';
    const leafSym = frameSymbolName(leaf);
    return {
      bucket: 'other_kernel',
      driver: leafMod,
      topFrame: leafSym ? `${leafMod}!${leafSym}` : leafMod,
      isFault: isFaultStack,
      isPreemptingDpc: false
    };
  }

  class KernelSysBreakdown {
    constructor(opts = {}) {
      this.targetPid = opts.targetPid ?? null;
      this.reset(this.targetPid);
    }

    _makeEmptyState() {
      const counts = {};
      const driversByBucket = {};
      const framesByBucket = {};
      const cpusByBucket = {};
      const faultSamplesByBucket = {};
      const sysWorkerSamplesByBucket = {};
      for (const b of KERNEL_SYS_BUCKETS) {
        counts[b.id] = 0;
        driversByBucket[b.id] = new Map();
        framesByBucket[b.id] = new Map();
        cpusByBucket[b.id] = new Map();
        faultSamplesByBucket[b.id] = 0;
        sysWorkerSamplesByBucket[b.id] = 0;
      }
      return {
        targetSysSamples: 0,
        preemptingDpcSamples: 0,
        totalKernelSamples: 0,
        counts,
        driversByBucket,
        framesByBucket,
        cpusByBucket,
        faultSamplesByBucket,
        sysWorkerSamplesByBucket
      };
    }

    reset(targetPid = this.targetPid) {
      this.targetPid = targetPid;
      this.global = this._makeEmptyState();
      this.byTid = new Map();
    }

    _applyTo(st, cls, weight, meta = {}) {
      st.totalKernelSamples += weight;
      if (cls.isPreemptingDpc) {
        st.preemptingDpcSamples += weight;
      } else {
        st.targetSysSamples += weight;
      }
      st.counts[cls.bucket] = (st.counts[cls.bucket] || 0) + weight;
      if (cls.driver) {
        const dm = st.driversByBucket[cls.bucket];
        if (dm) dm.set(cls.driver, (dm.get(cls.driver) || 0) + weight);
      }
      if (cls.topFrame) {
        const fm = st.framesByBucket[cls.bucket];
        if (fm) fm.set(cls.topFrame, (fm.get(cls.topFrame) || 0) + weight);
      }
      if (meta.cpu !== null && meta.cpu !== undefined && Number.isFinite(Number(meta.cpu))) {
        const cm = st.cpusByBucket[cls.bucket];
        const cpuId = Math.max(0, Math.floor(Number(meta.cpu)));
        if (cm) cm.set(cpuId, (cm.get(cpuId) || 0) + weight);
      }
      if (cls.isFault) {
        st.faultSamplesByBucket[cls.bucket] = (st.faultSamplesByBucket[cls.bucket] || 0) + weight;
      }
      if (meta.pid === 4 || meta.isSystemWorker) {
        st.sysWorkerSamplesByBucket[cls.bucket] = (st.sysWorkerSamplesByBucket[cls.bucket] || 0) + weight;
      }
    }

    recordSample(stackFrames, opts = {}) {
      const cls = classifyKernelStack(stackFrames, opts);
      if (!cls) return null;
      const weight = Math.max(1, Number(opts.weight) || 1);
      const meta = {
        pid: opts.pid ?? null,
        cpu: opts.cpu ?? null,
        isSystemWorker: Boolean(opts.isSystemWorker || opts.pid === 4)
      };
      this._applyTo(this.global, cls, weight, meta);

      const tid = opts.tid ?? null;
      if (tid !== null && tid !== undefined) {
        let tb = this.byTid.get(tid);
        if (!tb) {
          tb = this._makeEmptyState();
          this.byTid.set(tid, tb);
        }
        this._applyTo(tb, cls, weight, meta);
      }
      return cls;
    }

    _topMapEntry(map, denom) {
      if (!map || map.size === 0) return null;
      let bestKey = null;
      let bestSamples = 0;
      for (const [k, cnt] of map.entries()) {
        if (cnt > bestSamples) {
          bestSamples = cnt;
          bestKey = k;
        }
      }
      if (bestKey === null) return null;
      return {
        name: bestKey,
        samples: bestSamples,
        pct: denom > 0 ? (bestSamples / denom) * 100.0 : 0.0
      };
    }

    getSummary(opts = {}) {
      const tid = opts.tid ?? null;
      const activeSysCpuPct = Math.max(0, Number(opts.activeSysCpuPct) || 0);
      const isSystemWide = Boolean(opts.isSystemWide ?? (this.targetPid === null));
      const st = (tid !== null && tid !== undefined) ? this.byTid.get(tid) : this.global;

      if (!st || st.totalKernelSamples <= 0) {
        const emptyBuckets = {};
        for (const b of KERNEL_SYS_BUCKETS) {
          emptyBuckets[b.id] = {
            id: b.id,
            label: b.label,
            shortLabel: b.shortLabel,
            color: b.color,
            barColor: b.barColor,
            hatched: b.hatched,
            samples: 0,
            pct: 0,
            pctOfSys: 0,
            pctOfCpu: 0,
            syscallOnlySharePct: 0,
            topDriver: null,
            topFrame: null,
            topCpu: null,
            attribution: b.id === 'preempting_dpc_isr' ? 'Preempt / HW' : (isSystemWide ? 'System worker' : 'Target syscall')
          };
        }
        return {
          targetSysSamples: 0,
          preemptingDpcSamples: 0,
          totalKernelSamples: 0,
          activeSysCpuPct,
          isSystemWide,
          buckets: emptyBuckets,
          rows: [],
          topDpcDriver: null,
          topDpcCpu: null,
          topAvDriver: null,
          topGpuDriver: null,
          topStorageDriver: null,
          topCachedDriver: null
        };
      }

      // Single unified denominator for display (ALL rows including DPC/ISR sum to 100.0% of sys and activeSysCpuPct).
      // Internal Advisor isolation uses syscallOnlySharePct = bucketSamples / targetSysSamples (non-DPC denominator).
      const totalDenom = st.totalKernelSamples;
      const nonDpcDenom = st.targetSysSamples;
      const buckets = {};
      const rows = [];

      for (const b of KERNEL_SYS_BUCKETS) {
        const samples = st.counts[b.id] || 0;
        const isDpc = b.id === 'preempting_dpc_isr';
        const pctOfSys = totalDenom > 0 ? (samples / totalDenom) * 100.0 : 0.0;
        const pctOfCpu = totalDenom > 0 ? (samples / totalDenom) * activeSysCpuPct : 0.0;
        const syscallOnlySharePct = (!isDpc && nonDpcDenom > 0) ? (samples / nonDpcDenom) * 100.0 : 0.0;
        const topDriver = this._topMapEntry(st.driversByBucket[b.id], Math.max(1, samples));
        const topFrame = this._topMapEntry(st.framesByBucket[b.id], Math.max(1, samples));
        const topCpuObj = this._topMapEntry(st.cpusByBucket[b.id], Math.max(1, samples));
        const topCpu = topCpuObj ? topCpuObj.name : null;

        let attribution = 'Target syscall';
        if (isDpc) {
          attribution = topCpu !== null
            ? `Preempt / HW (C${String(topCpu).padStart(2, '0')})`
            : 'Preempt / HW';
        } else if (isSystemWide && (st.sysWorkerSamplesByBucket[b.id] || 0) >= samples * 0.5) {
          attribution = 'System worker (PID 4)';
        } else if ((st.faultSamplesByBucket[b.id] || 0) >= samples * 0.5 || b.id === 'memory_manager') {
          attribution = isSystemWide ? 'System fault' : 'Target fault';
        } else if (isSystemWide) {
          attribution = 'System syscall';
        }

        const entry = {
          id: b.id,
          label: b.label,
          shortLabel: b.shortLabel,
          color: b.color,
          barColor: b.barColor,
          hatched: b.hatched,
          samples,
          pct: pctOfSys,
          pctOfSys,
          pctOfCpu,
          syscallOnlySharePct,
          topDriver,
          topFrame,
          topCpu,
          attribution
        };
        buckets[b.id] = entry;
        if (samples > 0) rows.push(entry);
      }

      rows.sort((a, b) => (b.samples - a.samples) || (b.pctOfSys - a.pctOfSys));
      const dpcCpuEntry = this._topMapEntry(st.cpusByBucket.preempting_dpc_isr, Math.max(1, st.preemptingDpcSamples));
      return {
        targetSysSamples: st.targetSysSamples,
        preemptingDpcSamples: st.preemptingDpcSamples,
        totalKernelSamples: st.totalKernelSamples,
        activeSysCpuPct,
        isSystemWide,
        buckets,
        rows,
        topDpcDriver: this._topMapEntry(st.driversByBucket.preempting_dpc_isr, Math.max(1, st.preemptingDpcSamples)),
        topDpcCpu: dpcCpuEntry ? dpcCpuEntry.name : null,
        topAvDriver: this._topMapEntry(st.driversByBucket.av_minifilter, Math.max(1, st.counts.av_minifilter || 0)),
        topGpuDriver: this._topMapEntry(st.driversByBucket.gpu_driver, Math.max(1, st.counts.gpu_driver || 0)),
        topStorageDriver: this._topMapEntry(st.driversByBucket.physical_storage, Math.max(1, st.counts.physical_storage || 0)),
        topCachedDriver: this._topMapEntry(st.driversByBucket.cached_io, Math.max(1, st.counts.cached_io || 0))
      };
    }
  }

  /**
   * Build the unified display model for the global Kernel sys% breakdown strip (#kernel-strip).
   * Works for both Attached-Process and System-Wide scopes and handles paused / zero-sample states cleanly.
   */
  function buildKernelStripViewModel(opts = {}) {
    const proc = opts.proc || null;
    const etw = opts.etwSession || null;
    const snap = opts.snap || null;
    const activeSysCpuPct = Math.max(0, Number(opts.activeSysCpuPct ?? (snap ? snap.cpuSys : 0)) || 0);
    const activeUsrCpuPct = Math.max(0, Number(opts.activeUsrCpuPct ?? (snap ? snap.cpuUsr : 0)) || 0);
    const etwPaused = Boolean(opts.etwPaused ?? (etw ? etw.paused : false));
    const etwRunning = Boolean(opts.etwRunning ?? (etw ? etw.running : false));
    const isSystemWide = !proc;
    const scopeLabel = proc ? `Target: ${proc.name} (PID ${proc.pid})` : 'SYSTEM-WIDE (All Processes + PID 4)';

    let summary = opts.summary || null;
    if (!summary && etw) {
      if (proc && etw.targetPid === proc.pid && etw.kernelSys) {
        summary = etw.kernelSys.getSummary({ activeSysCpuPct, isSystemWide: false });
      } else if (!proc && etw.systemKernelSys) {
        summary = etw.systemKernelSys.getSummary({ activeSysCpuPct, isSystemWide: true });
      }
    }

    const totalSamples = summary ? (Number(summary.totalKernelSamples) || 0) : 0;
    const targetSysSamples = summary ? (Number(summary.targetSysSamples) || 0) : 0;
    const preemptingDpcSamples = summary ? (Number(summary.preemptingDpcSamples) || 0) : 0;
    const rows = (summary && Array.isArray(summary.rows) && totalSamples > 0) ? summary.rows : [];
    const empty = totalSamples <= 0 || rows.length === 0;
    const emptyReason = etwPaused
      ? 'ETW paused (0 active kernel samples) - press e on Tab 7 or Space to resume.'
      : (!etwRunning && totalSamples === 0
        ? 'ETW kernel sampling inactive (0 samples) - attach a target or resume ETW.'
        : 'Collecting 1 kHz SampledProfile kernel frames (0 kernel samples in window)...');

    return {
      isSystemWide,
      scopeLabel,
      activeSysCpuPct,
      activeUsrCpuPct,
      totalSamples,
      targetSysSamples,
      preemptingDpcSamples,
      etwPaused,
      etwRunning,
      empty,
      emptyReason,
      rows,
      summary
    };
  }

  class DiskIoEtwAggregator {
    constructor(opts = {}) {
      this.targetPid = opts.targetPid ?? null;
      this.reset(this.targetPid);
    }

    reset(targetPid = this.targetPid) {
      this.targetPid = targetPid;
      this.readBytes = 0;
      this.writeBytes = 0;
      this.readOps = 0;
      this.writeOps = 0;
      this.latencyMsSum = 0;
      this.totalOps = 0;
    }

    recordEvent(ev) {
      if (!ev) return;
      if (this.targetPid !== null && ev.pid !== undefined && ev.pid !== this.targetPid) return;
      const bytes = Math.max(0, Number(ev.bytes) || 0);
      const ops = Math.max(1, Number(ev.ops) || 1);
      const latMs = Math.max(0, Number(ev.latencyMs) || 0);
      if (ev.op === 'write') {
        this.writeBytes += bytes;
        this.writeOps += ops;
      } else {
        this.readBytes += bytes;
        this.readOps += ops;
      }
      this.latencyMsSum += latMs * ops;
      this.totalOps += ops;
    }

    getRates(elapsedSec = 1.0) {
      const dt = Math.max(0.001, Number(elapsedSec) || 1.0);
      return {
        physReadMbS: (this.readBytes / (1024 * 1024)) / dt,
        physWriteMbS: (this.writeBytes / (1024 * 1024)) / dt,
        physReadIops: this.readOps / dt,
        physWriteIops: this.writeOps / dt,
        avgDiskLatMs: this.totalOps > 0 ? this.latencyMsSum / this.totalOps : 0.0,
        totalOps: this.totalOps
      };
    }
  }

  const BURST_PROFILES = Object.freeze([
    {
      id: 'ibs_op',
      hotkey: '1',
      label: 'IBS Op Load Latency',
      shortLabel: 'IBS Op',
      desc: 'DRAM / L3 / L2 data source + measured load-latency cycles',
      metricUnit: 'cyc',
      primaryArgs: (pid, sec, tmpDir) =>
        `AMDuProfCLI.exe collect --config ibs -p ${pid} -d ${sec} -g -o "${tmpDir}"`,
      fallbackArgs: (pid, sec, tmpDir) =>
        `AMDuProfCLI.exe collect -e event=ibs-op,interval=100000,loadstore -p ${pid} -d ${sec} -g -o "${tmpDir}"`
    },
    {
      id: 'dram_l3',
      hotkey: '2',
      label: 'DRAM / L3 Miss Hotspots',
      shortLabel: 'DRAM/L3',
      desc: 'D-Cache demand DRAM fills (0x43 umask 0x08, interval 25k)',
      metricUnit: 'samples',
      primaryArgs: (pid, sec, tmpDir) =>
        `AMDuProfCLI.exe collect -e event=0x43,umask=0x08,interval=25000 -p ${pid} -d ${sec} -g -o "${tmpDir}"`,
      fallbackArgs: (pid, sec, tmpDir) =>
        `AMDuProfCLI.exe collect -e event=ibsop-l3miss,interval=25000 -p ${pid} -d ${sec} -g -o "${tmpDir}"`
    },
    {
      id: 'branch_miss',
      hotkey: '3',
      label: 'Branch Mispredict Hotspots',
      shortLabel: 'Branch',
      desc: 'Retired branch mispredictions (0xC3 umask 0x00, interval 50k)',
      metricUnit: 'samples',
      primaryArgs: (pid, sec, tmpDir) =>
        `AMDuProfCLI.exe collect -e event=0xC3,umask=0x00,interval=50000 -p ${pid} -d ${sec} -g -o "${tmpDir}"`,
      fallbackArgs: null
    },
    {
      id: 'tlb_walk',
      hotkey: '4',
      label: 'L2 iTLB / dTLB Walk Hotspots',
      shortLabel: 'L2 TLB',
      desc: 'L2 iTLB (0x85/0x07) & L2 dTLB (0x45/0xF0) page walks (interval 10k)',
      metricUnit: 'samples',
      primaryArgs: (pid, sec, tmpDir) =>
        `AMDuProfCLI.exe collect -e event=0x85,umask=0x07,interval=10000 -e event=0x45,umask=0xF0,interval=10000 -p ${pid} -d ${sec} -g -o "${tmpDir}"`,
      fallbackArgs: null
    }
  ]);

  function getBurstProfile(id) {
    return BURST_PROFILES.find(b => b.id === id) || BURST_PROFILES[0];
  }

  function buildUprofReportCommand(sessionDir, reportCsv) {
    return `AMDuProfCLI.exe report -i "${sessionDir}" --detail -g --report-output "${reportCsv}"`;
  }

  function locateUprofCli(opts = {}) {
    if (opts.available === false) {
      return {
        found: false,
        path: null,
        error: 'AMDuProfCLI.exe not found in PATH or C:\\Program Files\\AMD\\AMDuProf\\bin\\AMDuProfCLI.exe. Install AMD uProf alongside AMDuProfPcm.exe to enable hardware-stall burst capture.'
      };
    }
    return {
      found: true,
      path: opts.customPath || 'C:\\Program Files\\AMD\\AMDuProf\\bin\\AMDuProfCLI.exe',
      error: null
    };
  }

  // =========================================================================
  // CALL-TREE & FLAT HOTSPOT AGGREGATOR (Bounded LRU/Cap, Recursion-Safe)
  // =========================================================================
  class CallTreeAggregator {
    constructor(opts = {}) {
      this.maxNodes = Math.max(16, opts.maxNodes || 20000);
      this.reset();
    }

    reset() {
      this.totalSamples = 0;
      this.nodeCount = 0;
      this.evictedNodes = 0;
      this.tickSeq = 0;
      this.flatMap = new Map(); // fnKey -> stats
      this.rootChildren = new Map(); // fnKey -> TreeNode
      this.threadBuckets = new Map(); // tid -> { totalSamples, flatMap, rootChildren }
      this.allTreeNodes = new Map(); // nodeId -> node (for LRU cap)
    }

    _makeFlatEntry(frame) {
      return {
        key: frame.key,
        module: frame.module,
        name: frame.name,
        displayName: frame.displayName || frame.name,
        signature: frame.signature || frame.name,
        tier: frame.tier || '.pdata',
        fileLine: frame.fileLine || null,
        rva: frame.rva || 0,
        fnStartRva: frame.fnStartRva ?? (frame.rva || 0),
        fnEndRva: frame.fnEndRva ?? ((frame.rva || 0) + 1),
        selfSamples: 0,
        inclusiveSamples: 0,
        latencyWeightedSum: 0,
        latencyCount: 0,
        dataSourceCounts: {},
        callers: new Map(), // callerKey -> { name, module, count }
        callees: new Map()  // calleeKey -> { name, module, count }
      };
    }

    _makeTreeNode(id, frame, parent) {
      return {
        id,
        key: frame.key,
        module: frame.module,
        name: frame.name,
        displayName: frame.displayName || frame.name,
        signature: frame.signature || frame.name,
        tier: frame.tier || '.pdata',
        fileLine: frame.fileLine || null,
        rva: frame.rva || 0,
        fnStartRva: frame.fnStartRva ?? (frame.rva || 0),
        fnEndRva: frame.fnEndRva ?? ((frame.rva || 0) + 1),
        selfSamples: 0,
        inclusiveSamples: 0,
        latencyWeightedSum: 0,
        latencyCount: 0,
        dataSourceCounts: {},
        parent,
        children: new Map(),
        lastTouch: ++this.tickSeq
      };
    }

    _enforceNodeCap() {
      while (this.nodeCount > this.maxNodes && this.allTreeNodes.size > 0) {
        // Evict least-recently-touched leaf node with smallest inclusiveSamples
        let victim = null;
        for (const node of this.allTreeNodes.values()) {
          if (node.children.size > 0) continue;
          if (!victim || node.lastTouch < victim.lastTouch) {
            victim = node;
          }
        }
        if (!victim) break;
        this.allTreeNodes.delete(victim.id);
        if (victim.parent) {
          victim.parent.children.delete(victim.key);
        } else {
          this.rootChildren.delete(victim.key);
        }
        this.nodeCount = Math.max(0, this.nodeCount - 1);
        this.evictedNodes += 1;
      }
    }

    // stackFrames: array ordered ROOT -> ... -> LEAF (entry point first, active RIP last)
    // opts: { tid, weight, latencyCyc, dataSource, leafFirst }
    recordSample(stackFrames, opts = {}) {
      if (!Array.isArray(stackFrames) || stackFrames.length === 0) return;
      const weight = Math.max(1, Number(opts.weight) || 1);
      const frames = opts.leafFirst ? [...stackFrames].reverse() : stackFrames;
      const tid = opts.tid ?? null;
      const latencyCyc = Number.isFinite(opts.latencyCyc) ? opts.latencyCyc : null;
      const dataSource = opts.dataSource || null;

      this.totalSamples += weight;
      this._applyToBucket(this.flatMap, this.rootChildren, frames, weight, latencyCyc, dataSource, true);

      if (tid !== null && tid !== undefined) {
        let tb = this.threadBuckets.get(tid);
        if (!tb) {
          tb = { totalSamples: 0, flatMap: new Map(), rootChildren: new Map() };
          this.threadBuckets.set(tid, tb);
        }
        tb.totalSamples += weight;
        this._applyToBucket(tb.flatMap, tb.rootChildren, frames, weight, latencyCyc, dataSource, false);
      }
    }

    _applyToBucket(flatMap, rootChildren, frames, weight, latencyCyc, dataSource, trackGlobalCap) {
      const seenInclusive = new Set();
      const leafIdx = frames.length - 1;

      for (let i = 0; i < frames.length; i++) {
        const f = frames[i];
        let entry = flatMap.get(f.key);
        if (!entry) {
          entry = this._makeFlatEntry(f);
          flatMap.set(f.key, entry);
        } else {
          // Refresh resolved metadata (e.g. if sidecar map loaded)
          entry.name = f.name;
          entry.displayName = f.displayName || f.name;
          entry.signature = f.signature || f.name;
          entry.tier = f.tier || entry.tier;
          if (f.fileLine) entry.fileLine = f.fileLine;
        }

        // Deduplicate recursive frames so inclusiveSamples is never > totalSamples
        if (!seenInclusive.has(f.key)) {
          seenInclusive.add(f.key);
          entry.inclusiveSamples += weight;
        }

        if (i === leafIdx) {
          entry.selfSamples += weight;
          if (latencyCyc !== null) {
            entry.latencyWeightedSum += latencyCyc * weight;
            entry.latencyCount += weight;
          }
          if (dataSource) {
            entry.dataSourceCounts[dataSource] = (entry.dataSourceCounts[dataSource] || 0) + weight;
          }
        }

        // Caller / callee edges (skip direct self-recursion edge noise or keep cleanly)
        if (i > 0) {
          const caller = frames[i - 1];
          const cObj = entry.callers.get(caller.key) || { key: caller.key, name: caller.displayName || caller.name, module: caller.module, count: 0 };
          cObj.count += weight;
          entry.callers.set(caller.key, cObj);
        }
        if (i < leafIdx) {
          const callee = frames[i + 1];
          const ceObj = entry.callees.get(callee.key) || { key: callee.key, name: callee.displayName || callee.name, module: callee.module, count: 0 };
          ceObj.count += weight;
          entry.callees.set(callee.key, ceObj);
        }
      }

      // Walk/update hierarchical call tree (root -> leaf)
      let currentMap = rootChildren;
      let parentNode = null;
      let pathId = '';
      // Avoid double-counting inclusive on recursive ancestor nodes in the tree path
      const seenTreeKeys = new Set();

      for (let i = 0; i < frames.length; i++) {
        const f = frames[i];
        pathId = pathId ? `${pathId}>${f.key}` : f.key;
        let node = currentMap.get(f.key);
        if (!node) {
          node = this._makeTreeNode(pathId, f, parentNode);
          currentMap.set(f.key, node);
          if (trackGlobalCap) {
            this.nodeCount += 1;
            this.allTreeNodes.set(pathId, node);
          }
        } else {
          node.lastTouch = ++this.tickSeq;
        }
        if (!seenTreeKeys.has(f.key)) {
          seenTreeKeys.add(f.key);
          node.inclusiveSamples += weight;
        }
        if (i === leafIdx) {
          node.selfSamples += weight;
          if (latencyCyc !== null) {
            node.latencyWeightedSum += latencyCyc * weight;
            node.latencyCount += weight;
          }
          if (dataSource) {
            node.dataSourceCounts[dataSource] = (node.dataSourceCounts[dataSource] || 0) + weight;
          }
        }
        parentNode = node;
        currentMap = node.children;
      }

      if (trackGlobalCap && this.nodeCount > this.maxNodes) {
        this._enforceNodeCap();
      }
    }

    _topSource(counts) {
      let best = null;
      let bestN = 0;
      for (const [k, v] of Object.entries(counts || {})) {
        if (v > bestN) {
          bestN = v;
          best = k;
        }
      }
      return best;
    }

    getFlatHotspots(opts = {}) {
      const tid = opts.tid ?? null;
      const filter = String(opts.filter || '').trim().toLowerCase();
      const bucket = (tid !== null && tid !== undefined)
        ? this.threadBuckets.get(tid)
        : { totalSamples: this.totalSamples, flatMap: this.flatMap };
      if (!bucket || bucket.totalSamples <= 0) return [];

      const total = bucket.totalSamples;
      const rows = [];
      for (const e of bucket.flatMap.values()) {
        if (filter) {
          const hay = `${e.module} ${e.name} ${e.displayName} ${e.signature} ${e.fileLine || ''}`.toLowerCase();
          if (!hay.includes(filter)) continue;
        }
        const callers = [...e.callers.values()]
          .sort((a, b) => b.count - a.count)
          .slice(0, 2)
          .map(c => ({ ...c, pct: (c.count / Math.max(1, e.inclusiveSamples)) * 100.0 }));
        const callees = [...e.callees.values()]
          .sort((a, b) => b.count - a.count)
          .slice(0, 2)
          .map(c => ({ ...c, pct: (c.count / Math.max(1, e.inclusiveSamples)) * 100.0 }));
        rows.push({
          id: e.key,
          key: e.key,
          module: e.module,
          name: e.name,
          displayName: e.displayName,
          signature: e.signature,
          tier: e.tier,
          fileLine: e.fileLine,
          rva: e.rva,
          fnStartRva: e.fnStartRva,
          fnEndRva: e.fnEndRva,
          selfSamples: e.selfSamples,
          selfPct: (e.selfSamples / total) * 100.0,
          inclusiveSamples: e.inclusiveSamples,
          inclusivePct: Math.min(100.0, (e.inclusiveSamples / total) * 100.0),
          avgLatencyCyc: e.latencyCount > 0 ? e.latencyWeightedSum / e.latencyCount : null,
          topDataSource: this._topSource(e.dataSourceCounts),
          callers,
          callees
        });
      }
      rows.sort((a, b) => (b.selfSamples - a.selfSamples) || (b.inclusiveSamples - a.inclusiveSamples));
      return rows;
    }

    getTreeRows(opts = {}) {
      const tid = opts.tid ?? null;
      const filter = String(opts.filter || '').trim().toLowerCase();
      const expandedIds = opts.expandedIds || new Set();
      const bucket = (tid !== null && tid !== undefined)
        ? this.threadBuckets.get(tid)
        : { totalSamples: this.totalSamples, flatMap: this.flatMap, rootChildren: this.rootChildren };
      if (!bucket || bucket.totalSamples <= 0) return [];

      const total = bucket.totalSamples;
      const out = [];

      const matchesFilter = (node) => {
        if (!filter) return true;
        const hay = `${node.module} ${node.name} ${node.displayName} ${node.signature}`.toLowerCase();
        if (hay.includes(filter)) return true;
        for (const ch of node.children.values()) {
          if (matchesFilter(ch)) return true;
        }
        return false;
      };

      const walk = (childrenMap, depth, prefixParts) => {
        const list = [...childrenMap.values()]
          .filter(matchesFilter)
          .sort((a, b) => (b.inclusiveSamples - a.inclusiveSamples) || (b.selfSamples - a.selfSamples));

        list.forEach((node, idx) => {
          const isLast = idx === list.length - 1;
          const hasChildren = node.children.size > 0;
          const isExpanded = Boolean(filter) || expandedIds.has(node.id);
          const flatRef = bucket.flatMap.get(node.key);
          const callers = flatRef
            ? [...flatRef.callers.values()].sort((a, b) => b.count - a.count).slice(0, 2)
                .map(c => ({ ...c, pct: (c.count / Math.max(1, flatRef.inclusiveSamples)) * 100.0 }))
            : [];
          const callees = flatRef
            ? [...flatRef.callees.values()].sort((a, b) => b.count - a.count).slice(0, 2)
                .map(c => ({ ...c, pct: (c.count / Math.max(1, flatRef.inclusiveSamples)) * 100.0 }))
            : [];

          let treePrefix = '';
          if (depth > 0) {
            treePrefix = prefixParts.join('') + (isLast ? '└─ ' : '├─ ');
          }

          out.push({
            id: node.id,
            key: node.key,
            depth,
            treePrefix,
            hasChildren,
            isExpanded,
            module: node.module,
            name: node.name,
            displayName: node.displayName,
            signature: node.signature,
            tier: node.tier,
            fileLine: node.fileLine,
            rva: node.rva,
            fnStartRva: node.fnStartRva,
            fnEndRva: node.fnEndRva,
            selfSamples: node.selfSamples,
            selfPct: (node.selfSamples / total) * 100.0,
            inclusiveSamples: node.inclusiveSamples,
            inclusivePct: Math.min(100.0, (node.inclusiveSamples / total) * 100.0),
            avgLatencyCyc: node.latencyCount > 0 ? node.latencyWeightedSum / node.latencyCount : null,
            topDataSource: this._topSource(node.dataSourceCounts),
            callers,
            callees
          });

          if (hasChildren && isExpanded) {
            const nextParts = depth === 0 ? [] : [...prefixParts, isLast ? '   ' : '│  '];
            walk(node.children, depth + 1, nextParts);
          }
        });
      };

      walk(bucket.rootChildren, 0, []);
      return out;
    }

    getTotalSamples(tid = null) {
      if (tid !== null && tid !== undefined) {
        const tb = this.threadBuckets.get(tid);
        return tb ? tb.totalSamples : 0;
      }
      return this.totalSamples;
    }
  }

  // =========================================================================
  // OFF-CPU / WAIT-CHAIN AGGREGATOR (CSwitch + ReadyThread Pairing)
  // =========================================================================
  class OffCpuAggregator {
    constructor(opts = {}) {
      this.targetPid = opts.targetPid ?? null;
      this.reset();
    }

    reset(targetPid = this.targetPid) {
      this.targetPid = targetPid;
      this.pendingOut = new Map(); // tid -> { outTsUs, stack, waker }
      this.totalBlockedUs = 0;
      this.totalWakes = 0;
      this.groups = new Map(); // groupKey -> wait group
      this.threadGroups = new Map(); // tid -> { totalBlockedUs, totalWakes, groups: Map }
    }

    // CSwitch switch-out: target thread leaves CPU
    onCSwitchOut(ev) {
      if (!ev) return;
      if (this.targetPid !== null && ev.pid !== this.targetPid) return;
      this.pendingOut.set(ev.tid, {
        pid: ev.pid,
        tid: ev.tid,
        threadName: ev.threadName || `TID ${ev.tid}`,
        outTsUs: ev.tsUs,
        stack: Array.isArray(ev.stack) ? ev.stack : [],
        waker: null
      });
    }

    // ReadyThread (event type 0x32): waker unblocks sleeping target thread
    onReadyThread(ev) {
      if (!ev) return;
      if (this.targetPid !== null && ev.targetPid !== this.targetPid) return;
      const pending = this.pendingOut.get(ev.targetTid);
      if (!pending) return;
      pending.waker = {
        wakerPid: ev.wakerPid,
        wakerTid: ev.wakerTid,
        wakerName: ev.wakerName || `TID ${ev.wakerTid}`,
        readyTsUs: ev.tsUs
      };
    }

    // CSwitch switch-in: target thread resumes CPU -> commit paired wait interval
    onCSwitchIn(ev) {
      if (!ev) return null;
      if (this.targetPid !== null && ev.pid !== this.targetPid) return null;
      const pending = this.pendingOut.get(ev.tid);
      if (!pending) return null;
      this.pendingOut.delete(ev.tid);

      const durationUs = Math.max(0, (ev.tsUs || 0) - (pending.outTsUs || 0));
      if (durationUs <= 0) return null;

      const stack = pending.stack;
      const leaf = stack[stack.length - 1] || {
        key: 'ntdll.dll!WaitForSingleObject',
        module: 'ntdll.dll',
        name: 'WaitForSingleObject',
        displayName: 'WaitForSingleObject',
        signature: 'ntdll.dll!WaitForSingleObject',
        tier: 'EXP',
        rva: 0x9C410,
        fnStartRva: 0x9C410,
        fnEndRva: 0x9C490,
        fileLine: null
      };
      const caller = stack.length >= 2 ? stack[stack.length - 2] : null;
      const wakerLabel = pending.waker ? pending.waker.wakerName : 'Kernel/Timer';
      const groupKey = `${leaf.key}|${caller ? caller.key : ''}`;

      this.totalBlockedUs += durationUs;
      this.totalWakes += 1;
      this._addToGroupMap(this.groups, groupKey, leaf, caller, stack, pending.threadName, wakerLabel, durationUs);

      let tb = this.threadGroups.get(ev.tid);
      if (!tb) {
        tb = { totalBlockedUs: 0, totalWakes: 0, groups: new Map() };
        this.threadGroups.set(ev.tid, tb);
      }
      tb.totalBlockedUs += durationUs;
      tb.totalWakes += 1;
      this._addToGroupMap(tb.groups, groupKey, leaf, caller, stack, pending.threadName, wakerLabel, durationUs);

      return { tid: ev.tid, durationUs, waker: pending.waker, leaf };
    }

    _addToGroupMap(map, groupKey, leaf, caller, stack, threadName, wakerLabel, durationUs) {
      let g = map.get(groupKey);
      if (!g) {
        g = {
          id: groupKey,
          key: leaf.key,
          module: leaf.module,
          name: leaf.name,
          displayName: leaf.displayName || leaf.name,
          signature: leaf.signature || leaf.name,
          tier: leaf.tier || 'EXP',
          fileLine: leaf.fileLine || null,
          rva: leaf.rva || 0,
          fnStartRva: leaf.fnStartRva ?? (leaf.rva || 0),
          fnEndRva: leaf.fnEndRva ?? ((leaf.rva || 0) + 1),
          callerName: caller ? (caller.displayName || caller.name) : null,
          callerModule: caller ? caller.module : null,
          stackSummary: stack.map(s => s.displayName || s.name).join(' -> '),
          blockedUs: 0,
          wakes: 0,
          wakers: new Map(),
          waiters: new Map()
        };
        map.set(groupKey, g);
      }
      g.blockedUs += durationUs;
      g.wakes += 1;
      g.wakers.set(wakerLabel, (g.wakers.get(wakerLabel) || 0) + 1);
      g.waiters.set(threadName, (g.waiters.get(threadName) || 0) + durationUs);
    }

    getWaitRows(opts = {}) {
      const tid = opts.tid ?? null;
      const filter = String(opts.filter || '').trim().toLowerCase();
      const bucket = (tid !== null && tid !== undefined)
        ? this.threadGroups.get(tid)
        : { totalBlockedUs: this.totalBlockedUs, totalWakes: this.totalWakes, groups: this.groups };
      if (!bucket || bucket.totalBlockedUs <= 0) return [];

      const totalUs = bucket.totalBlockedUs;
      const rows = [];
      for (const g of bucket.groups.values()) {
        const wakersSorted = [...g.wakers.entries()].sort((a, b) => b[1] - a[1]);
        const topWakerEntry = wakersSorted[0] || ['Kernel/Timer', g.wakes];
        const topWakerName = topWakerEntry[0];
        const topWakerPct = (topWakerEntry[1] / Math.max(1, g.wakes)) * 100.0;

        const waitersSorted = [...g.waiters.entries()].sort((a, b) => b[1] - a[1]);
        const topWaiterName = waitersSorted[0] ? waitersSorted[0][0] : 'Thread';

        const displayStack = g.callerName
          ? `${g.displayName} <- ${g.callerName}`
          : g.displayName;

        if (filter) {
          const hay = `${g.module} ${g.name} ${displayStack} ${topWakerName} ${topWaiterName}`.toLowerCase();
          if (!hay.includes(filter)) continue;
        }

        rows.push({
          id: g.id,
          key: g.key,
          module: g.module,
          name: g.name,
          displayName: g.displayName,
          displayStack,
          stackSummary: g.stackSummary,
          signature: g.signature,
          tier: g.tier,
          fileLine: g.fileLine,
          rva: g.rva,
          fnStartRva: g.fnStartRva,
          fnEndRva: g.fnEndRva,
          blockedMs: g.blockedUs / 1000.0,
          blockedPct: (g.blockedUs / totalUs) * 100.0,
          avgWaitMs: (g.blockedUs / Math.max(1, g.wakes)) / 1000.0,
          wakes: g.wakes,
          topWakerName,
          topWakerPct,
          topWaiterName,
          callers: g.callerName ? [{ name: g.callerName, module: g.callerModule, pct: 100.0 }] : [],
          callees: []
        });
      }
      rows.sort((a, b) => b.blockedMs - a.blockedMs);
      return rows;
    }

    getTotalWakes(tid = null) {
      if (tid !== null && tid !== undefined) {
        const tb = this.threadGroups.get(tid);
        return tb ? tb.totalWakes : 0;
      }
      return this.totalWakes;
    }
  }

  // =========================================================================
  // AMDuProfCLI report.csv PARSER (Flat + Call-Graph + IBS Load Latency)
  // =========================================================================
  function parseCsvLine(line) {
    const out = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        out.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur.trim());
    return out;
  }

  function parseUprofBurstReportCsv(csvText, resolver = null, burstMeta = {}) {
    const lines = String(csvText || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const agg = new CallTreeAggregator({ maxNodes: 20000 });
    const parsedRows = [];

    let headerIdx = -1;
    let headers = [];
    for (let i = 0; i < lines.length; i++) {
      const low = lines[i].toLowerCase();
      if (low.includes('function') && low.includes('module') && (low.includes('self') || low.includes('samples'))) {
        headerIdx = i;
        headers = parseCsvLine(lines[i]).map(h => h.toLowerCase());
        break;
      }
    }
    if (headerIdx === -1) {
      return {
        burstType: burstMeta.burstType || 'ibs_op',
        capturedAt: burstMeta.capturedAt || '--:--:--',
        durationSec: burstMeta.durationSec || 5,
        aggregator: agg,
        totalSamples: 0,
        flatRows: [],
        parsedRows
      };
    }

    const colIdx = (patterns) => headers.findIndex(h => patterns.some(p => h.includes(p)));
    const iFunc = colIdx(['function', 'symbol']);
    const iMod = colIdx(['module', 'image']);
    const iRva = colIdx(['rva', 'offset', 'address']);
    const iSelf = colIdx(['self samples', 'self', 'samples']);
    const iIncl = colIdx(['inclusive samples', 'inclusive', 'total samples']);
    const iLat = colIdx(['avg load latency', 'latency', 'lat (cyc)', 'ibs lat']);
    const iSrc = colIdx(['data source', 'source', 'mem src']);
    const iCallers = colIdx(['callers', 'call stack', 'callstack', 'parent']);
    const iTid = colIdx(['tid', 'thread']);

    const resolveFrame = (modName, fnName, rvaVal) => {
      if (resolver) {
        return resolver.enrichCsvSymbol(modName, fnName, rvaVal);
      }
      const rva = parseRva(rvaVal);
      return {
        module: modName || 'unknown',
        name: fnName || `${modName}!${fmtHexRva(rva)}`,
        displayName: fnName || fmtHexRva(rva),
        signature: `${modName}!${fnName || fmtHexRva(rva)}`,
        tier: fnName && !fnName.startsWith('0x') ? 'PDB' : '.pdata',
        fileLine: null,
        rva: Number.isFinite(rva) ? rva : 0,
        fnStartRva: Number.isFinite(rva) ? rva : 0,
        fnEndRva: Number.isFinite(rva) ? rva + 0x100 : 0,
        key: `${String(modName || 'unknown').toLowerCase()}!${fnName || fmtHexRva(rva)}`
      };
    };

    for (let i = headerIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('#') || line.startsWith('---')) continue;
      const cols = parseCsvLine(line);
      if (cols.length < 3) continue;

      const rawFunc = iFunc >= 0 ? cols[iFunc] : '';
      const rawMod = iMod >= 0 ? cols[iMod] : 'unknown';
      if (!rawFunc && !rawMod) continue;

      const rvaVal = iRva >= 0 ? parseRva(cols[iRva]) : NaN;
      const selfSamples = iSelf >= 0 ? Math.max(0, Math.round(Number(cols[iSelf]) || 0)) : 0;
      const inclSamples = iIncl >= 0 ? Math.max(selfSamples, Math.round(Number(cols[iIncl]) || 0)) : selfSamples;
      const latRaw = iLat >= 0 ? Number(cols[iLat]) : NaN;
      const latencyCyc = Number.isFinite(latRaw) && latRaw > 0 ? latRaw : null;
      const dataSource = iSrc >= 0 && cols[iSrc] ? cols[iSrc] : null;
      const tidRaw = iTid >= 0 ? Number(cols[iTid]) : NaN;
      const tid = Number.isFinite(tidRaw) ? tidRaw : null;

      const leafFrame = resolveFrame(rawMod, rawFunc, rvaVal);

      // Parse optional call-graph chain (Root > Mid > Leaf or Parent1;Parent2)
      const chainRaw = iCallers >= 0 ? (cols[iCallers] || '') : '';
      const stackFrames = [];
      if (chainRaw) {
        const parts = chainRaw.split('>').map(s => s.trim()).filter(Boolean);
        for (const p of parts) {
          const bang = p.indexOf('!');
          let pMod = rawMod;
          let pFn = p;
          let pRva = NaN;
          if (bang > 0) {
            pMod = p.slice(0, bang).trim();
            pFn = p.slice(bang + 1).trim();
          }
          const atIdx = pFn.indexOf('@');
          if (atIdx > 0) {
            pRva = parseRva(pFn.slice(atIdx + 1));
            pFn = pFn.slice(0, atIdx).trim();
          }
          stackFrames.push(resolveFrame(pMod, pFn, pRva));
        }
      }
      stackFrames.push(leafFrame);

      if (selfSamples > 0) {
        agg.recordSample(stackFrames, {
          tid,
          weight: selfSamples,
          latencyCyc,
          dataSource
        });
      }

      parsedRows.push({
        module: leafFrame.module,
        name: leafFrame.name,
        displayName: leafFrame.displayName,
        tier: leafFrame.tier,
        rva: leafFrame.rva,
        selfSamples,
        inclusiveSamples: inclSamples,
        avgLatencyCyc: latencyCyc,
        dataSource
      });
    }

    return {
      burstType: burstMeta.burstType || 'ibs_op',
      burstLabel: burstMeta.burstLabel || getBurstProfile(burstMeta.burstType).shortLabel,
      capturedAt: burstMeta.capturedAt || '--:--:--',
      durationSec: burstMeta.durationSec || 5,
      command: burstMeta.command || '',
      aggregator: agg,
      totalSamples: agg.totalSamples,
      flatRows: agg.getFlatHotspots(),
      parsedRows
    };
  }

  // =========================================================================
  // PMU COORDINATOR STATE MACHINE (Pause PCM -> Burst -> Report -> Resume PCM)
  // =========================================================================
  class PmuCoordinator {
    constructor(callbacks = {}) {
      this.state = 'LIVE_PCM'; // LIVE_PCM | PAUSING_PCM | CAPTURING_BURST | GENERATING_REPORT | RESUMING_PCM
      this.pcmRunning = true;
      this.history = [];
      this.activeBurst = null;
      this.callbacks = {
        pausePcm: callbacks.pausePcm || (() => {}),
        resumePcm: callbacks.resumePcm || (() => {}),
        collectBurst: callbacks.collectBurst || (() => ''),
        cleanupTmpDir: callbacks.cleanupTmpDir || (() => {}),
        onStateChange: callbacks.onStateChange || (() => {})
      };
    }

    _transition(nextState, info = {}) {
      this.state = nextState;
      this.history.push({ state: nextState, ...info });
      this.callbacks.onStateChange(nextState, info);
    }

    // Synchronous guaranteed-resume burst runner (useful for deterministic sync checks & tests)
    runBurstSync(opts = {}) {
      if (this.state !== 'LIVE_PCM') {
        throw new Error(`PmuCoordinator busy in state ${this.state}`);
      }
      const profile = getBurstProfile(opts.burstType || 'ibs_op');
      const pid = opts.pid;
      const durationSec = opts.durationSec || 5;
      const tmpDir = opts.tmpDir || `C:\\Temp\\zen2top_burst_${pid}_${Date.now()}`;
      const cliCheck = locateUprofCli({ available: opts.cliAvailable !== false });
      if (!cliCheck.found) {
        return { ok: false, error: cliCheck.error, state: this.state, pcmRunning: this.pcmRunning };
      }

      this.activeBurst = { burstType: profile.id, label: profile.shortLabel, durationSec, remainingSec: durationSec, tmpDir };
      let report = null;
      let err = null;

      try {
        this._transition('PAUSING_PCM', { pid, burstType: profile.id });
        this.pcmRunning = false;
        this.callbacks.pausePcm();

        this._transition('CAPTURING_BURST', { pid, burstType: profile.id, durationSec, tmpDir });
        const csvText = this.callbacks.collectBurst({ pid, durationSec, burstType: profile.id, tmpDir, profile });

        this._transition('GENERATING_REPORT', { pid, burstType: profile.id, tmpDir });
        report = parseUprofBurstReportCsv(csvText, opts.resolver || null, {
          burstType: profile.id,
          burstLabel: profile.shortLabel,
          durationSec,
          capturedAt: opts.capturedAt || new Date().toTimeString().slice(0, 8),
          command: profile.primaryArgs(pid, durationSec, tmpDir)
        });
      } catch (e) {
        err = e;
      } finally {
        try {
          this.callbacks.cleanupTmpDir(tmpDir);
        } catch (_) {
          // Best-effort temp cleanup
        }
        this._transition('RESUMING_PCM', { hadError: Boolean(err) });
        this.callbacks.resumePcm();
        this.pcmRunning = true;
        this.activeBurst = null;
        this._transition('LIVE_PCM', { resumed: true });
      }

      if (err) {
        return { ok: false, error: err.message || String(err), report: null, state: this.state, pcmRunning: this.pcmRunning };
      }
      return { ok: true, error: null, report, state: this.state, pcmRunning: this.pcmRunning };
    }

    // Async guaranteed-resume burst runner
    async runBurst(opts = {}) {
      if (this.state !== 'LIVE_PCM') {
        throw new Error(`PmuCoordinator busy in state ${this.state}`);
      }
      const profile = getBurstProfile(opts.burstType || 'ibs_op');
      const pid = opts.pid;
      const durationSec = opts.durationSec || 5;
      const tmpDir = opts.tmpDir || `C:\\Temp\\zen2top_burst_${pid}_${Date.now()}`;
      const cliCheck = locateUprofCli({ available: opts.cliAvailable !== false });
      if (!cliCheck.found) {
        return { ok: false, error: cliCheck.error, state: this.state, pcmRunning: this.pcmRunning };
      }

      this.activeBurst = { burstType: profile.id, label: profile.shortLabel, durationSec, remainingSec: durationSec, tmpDir };
      let report = null;
      let err = null;

      try {
        this._transition('PAUSING_PCM', { pid, burstType: profile.id });
        this.pcmRunning = false;
        await this.callbacks.pausePcm();

        this._transition('CAPTURING_BURST', { pid, burstType: profile.id, durationSec, tmpDir });
        const csvText = await this.callbacks.collectBurst({ pid, durationSec, burstType: profile.id, tmpDir, profile });

        this._transition('GENERATING_REPORT', { pid, burstType: profile.id, tmpDir });
        report = parseUprofBurstReportCsv(csvText, opts.resolver || null, {
          burstType: profile.id,
          burstLabel: profile.shortLabel,
          durationSec,
          capturedAt: opts.capturedAt || new Date().toTimeString().slice(0, 8),
          command: profile.primaryArgs(pid, durationSec, tmpDir)
        });
      } catch (e) {
        err = e;
      } finally {
        try {
          await this.callbacks.cleanupTmpDir(tmpDir);
        } catch (_) {
          // Best-effort temp cleanup
        }
        this._transition('RESUMING_PCM', { hadError: Boolean(err) });
        await this.callbacks.resumePcm();
        this.pcmRunning = true;
        this.activeBurst = null;
        this._transition('LIVE_PCM', { resumed: true });
      }

      if (err) {
        return { ok: false, error: err.message || String(err), report: null, state: this.state, pcmRunning: this.pcmRunning };
      }
      return { ok: true, error: null, report, state: this.state, pcmRunning: this.pcmRunning };
    }
  }

  // =========================================================================
  // LIVE ETW SESSION WRAPPER (Zero-PMC, Safe Cleanup on Exit/Ctrl+C)
  // =========================================================================
  class EtwProfilerSession {
    constructor(opts = {}) {
      this.sessionName = opts.sessionName || 'zen2top_live_etw';
      this.sampleRateKhz = Math.min(4, Math.max(1, opts.sampleRateKhz || 1));
      this.maxNodes = opts.maxNodes || 20000;
      this.enabledFlags =
        ETW_KERNEL_FLAGS.EVENT_TRACE_FLAG_PROFILE |
        ETW_KERNEL_FLAGS.EVENT_TRACE_FLAG_CSWITCH |
        ETW_KERNEL_FLAGS.EVENT_TRACE_FLAG_DISPATCHER |
        ETW_KERNEL_FLAGS.EVENT_TRACE_FLAG_IMAGE_LOAD |
        ETW_KERNEL_FLAGS.EVENT_TRACE_FLAG_DISK_IO;
      this.stackWalkEnabled = ['SampledProfile', 'CSwitch', 'ReadyThread'];
      this.running = false;
      this.paused = false;
      this.targetPid = null;
      this.resolver = null;
      this.onCpu = new CallTreeAggregator({ maxNodes: this.maxNodes });
      this.offCpu = new OffCpuAggregator();
      this.kernelSys = new KernelSysBreakdown();
      this.systemKernelSys = new KernelSysBreakdown({ targetPid: null });
      this.diskIoEtw = new DiskIoEtwAggregator();
      this.controlStopCount = 0;
    }

    attach(pid, resolver) {
      this.targetPid = pid;
      this.resolver = resolver || new SymbolResolver(pid);
      this.onCpu.reset();
      this.offCpu.reset(pid);
      this.kernelSys.reset(pid);
      this.systemKernelSys.reset(null);
      this.diskIoEtw.reset(pid);
      this.running = pid !== null && pid !== undefined;
    }

    attachSystemWide(resolver) {
      this.targetPid = null;
      this.resolver = resolver || new SymbolResolver(0);
      this.onCpu.reset();
      this.offCpu.reset(null);
      this.kernelSys.reset(null);
      this.systemKernelSys.reset(null);
      this.diskIoEtw.reset(null);
      this.running = true;
    }

    togglePause() {
      this.paused = !this.paused;
      return this.paused;
    }

    clear() {
      this.onCpu.reset();
      this.offCpu.reset(this.targetPid);
      this.kernelSys.reset(this.targetPid);
      this.systemKernelSys.reset(null);
      this.diskIoEtw.reset(this.targetPid);
    }

    // Guaranteed ControlTraceW(EVENT_TRACE_CONTROL_STOP) cleanup
    stop() {
      if (this.running) {
        this.running = false;
        this.controlStopCount += 1;
      }
    }

    _resolveFrame(f) {
      if (!f) return f;
      if (f.key) return f;
      if (this.resolver) {
        if (f.va !== undefined && f.va !== null && !f.module) {
          return this.resolver.resolveAddress(f.va);
        }
        return this.resolver.resolve(f.module, f.rva);
      }
      return f;
    }

    ingestSampledProfile(ev) {
      if (!this.running || this.paused || !ev) return;
      const frames = (ev.stack || []).map(f => this._resolveFrame(f));
      const sampleOpts = {
        tid: ev.tid,
        pid: ev.pid ?? null,
        cpu: ev.cpu ?? null,
        isSystemWorker: Boolean(ev.isSystemWorker || ev.pid === 4),
        weight: ev.weight || 1,
        leafFirst: Boolean(ev.leafFirst)
      };
      // Always track system-wide kernel sys% breakdown
      this.systemKernelSys.recordSample(frames, sampleOpts);

      if (this.targetPid !== null && ev.pid !== this.targetPid) return;
      if (this.targetPid !== null) {
        this.onCpu.recordSample(frames, { tid: ev.tid, weight: ev.weight || 1, leafFirst: Boolean(ev.leafFirst) });
      }
      this.kernelSys.recordSample(frames, sampleOpts);
    }

    ingestDiskIo(ev) {
      if (!this.running || this.paused || !ev) return;
      this.diskIoEtw.recordEvent(ev);
    }

    ingestOffCpuPair(outEv, readyEv, inEv) {
      if (!this.running || this.paused) return;
      const resolveStack = (stk) => (stk || []).map(f => this._resolveFrame(f));
      this.offCpu.onCSwitchOut({ ...outEv, stack: resolveStack(outEv.stack) });
      if (readyEv) this.offCpu.onReadyThread(readyEv);
      this.offCpu.onCSwitchIn(inEv);
    }
  }

  Object.assign(Z, {
    ETW_KERNEL_FLAGS,
    KERNEL_SYS_BUCKETS,
    isKernelFrame,
    classifyKernelStack,
    KernelSysBreakdown,
    buildKernelStripViewModel,
    DiskIoEtwAggregator,
    BURST_PROFILES,
    getBurstProfile,
    buildUprofReportCommand,
    locateUprofCli,
    CallTreeAggregator,
    OffCpuAggregator,
    parseUprofBurstReportCsv,
    PmuCoordinator,
    EtwProfilerSession
  });
})();
