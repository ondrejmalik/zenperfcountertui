// Zero-PMC Deep-Dive Collectors: Per-Thread Inspector & Affinity, Present ETW, VA/JIT Map, and Disk I/O
(() => {
  'use strict';
  const Z = window.Zen2Top || (window.Zen2Top = {});
  const { CONFIG } = Z;

  const PRESENT_RING_LEN = 300;
  const SPIKE_RING_LEN = 48;

  // =========================================================================
  // A. PER-THREAD INSPECTOR & LIVE AFFINITY CONTROL (win32/threads.rs parity)
  // =========================================================================

  /**
   * 2-tier thread naming fallback:
   * 1. GetThreadDescription(hThread) when non-empty
   * 2. NtQueryInformationThread(ThreadQuerySetWin32StartAddress) relative to loaded module (e.g. client.dll+0x1A420)
   */
  function formatThreadEntry(thread, modules = []) {
    if (thread && typeof thread.description === 'string' && thread.description.trim().length > 0) {
      return thread.description.trim();
    }
    const addr = thread && thread.startAddress !== undefined && thread.startAddress !== null
      ? BigInt(thread.startAddress)
      : 0n;
    if (addr === 0n) return 'unknown';

    for (const mod of modules || []) {
      if (!mod || mod.base === undefined || mod.base === null) continue;
      const base = BigInt(mod.base);
      const sizeBytes = BigInt(Math.max(4096, Math.round((mod.sizeMiB || 0) * 1024 * 1024)));
      if (addr >= base && addr < base + sizeBytes) {
        const offset = addr - base;
        return `${mod.name}+0x${offset.toString(16).toUpperCase()}`;
      }
    }
    return `0x${addr.toString(16).toUpperCase()}`;
  }

  /**
   * Compute per-thread CPU% and context switches/sec from two consecutive SystemProcessInformation snapshots.
   * When logicalCpus = 1 (default), cpuPct is % of one logical CPU (0..100%).
   * When logicalCpus = N, cpuPct is normalized across N logical CPUs.
   */
  function computeThreadDeltaMetrics(prev, curr, dtSec, logicalCpus = 1) {
    const dt = Math.max(0.001, Number(dtSec) || 1.0);
    const cpus = Math.max(1, Number(logicalCpus) || 1);
    const prevTime = (Number(prev?.kernelSec) || 0) + (Number(prev?.userSec) || 0);
    const currTime = (Number(curr?.kernelSec) || 0) + (Number(curr?.userSec) || 0);
    const deltaCpuSec = Math.max(0.0, currTime - prevTime);
    const cpuPct = Math.min(100.0, (deltaCpuSec / (dt * cpus)) * 100.0);

    const prevCs = Number(prev?.ctxSwitches) || 0;
    const currCs = Number(curr?.ctxSwitches) || 0;
    const ctxSwPerSec = Math.max(0.0, (currCs - prevCs) / dt);

    return { cpuPct, ctxSwPerSec };
  }

  function getFullTopologyMask(logicalCpus = CONFIG.logicalCpus) {
    return ((1 << Math.min(30, logicalCpus)) - 1) >>> 0;
  }

  function getCcxMask(ccxId, physicalCores = CONFIG.physicalCores) {
    let mask = 0;
    for (const pc of physicalCores) {
      if (pc.ccx === ccxId) {
        for (const cpu of pc.siblings) mask |= (1 << cpu);
      }
    }
    return mask >>> 0;
  }

  function getPrimaryPhysicalCoresMask(physicalCores = CONFIG.physicalCores) {
    let mask = 0;
    for (const pc of physicalCores) {
      if (pc.siblings && pc.siblings.length > 0) {
        mask |= (1 << pc.siblings[0]);
      }
    }
    return mask >>> 0;
  }

  function formatAffinityHex(mask) {
    return '0x' + ((mask >>> 0).toString(16).toUpperCase().padStart(4, '0'));
  }

  function firstSetBit(mask, maxBits = CONFIG.logicalCpus) {
    const m = mask >>> 0;
    for (let i = 0; i < maxBits; i++) {
      if ((m & (1 << i)) !== 0) return i;
    }
    return 0;
  }

  function countSetBits(mask) {
    let x = mask >>> 0;
    let c = 0;
    while (x) {
      x &= (x - 1);
      c += 1;
    }
    return c;
  }

  function describeAffinityMask(mask, physicalCores = CONFIG.physicalCores, logicalCpus = CONFIG.logicalCpus) {
    const m = mask >>> 0;
    const full = getFullTopologyMask(logicalCpus);
    const ccx0 = getCcxMask(0, physicalCores);
    const ccx1 = getCcxMask(1, physicalCores);
    const phys = getPrimaryPhysicalCoresMask(physicalCores);
    if (m === full) return 'All';
    if (m === ccx0) return 'CCX0';
    if (m === ccx1) return 'CCX1';
    if (m === phys) return 'Phys';
    if (countSetBits(m) === 1) return 'C' + String(firstSetBit(m, logicalCpus)).padStart(2, '0');
    return formatAffinityHex(m);
  }

  function isCpuSmtContended(cpuId, coreC0 = [], physicalCores = CONFIG.physicalCores) {
    const pc = physicalCores.find(p => p.siblings && p.siblings.includes(cpuId));
    if (!pc || pc.siblings.length < 2) return false;
    const s0 = Number(coreC0[pc.siblings[0]]) || 0;
    const s1 = Number(coreC0[pc.siblings[1]]) || 0;
    return s0 >= 15.0 && s1 >= 15.0;
  }

  function isThreadSmtContended(thread, coreC0 = [], physicalCores = CONFIG.physicalCores) {
    if (!thread) return false;
    if (isCpuSmtContended(thread.currentCpu, coreC0, physicalCores)) return true;
    // Also flag if thread affinity pins it strictly to a physical core whose pair is contended
    const m = (thread.affinityMask >>> 0);
    for (const pc of physicalCores) {
      if (pc.siblings.length < 2) continue;
      const pairMask = ((1 << pc.siblings[0]) | (1 << pc.siblings[1])) >>> 0;
      if (m !== 0 && (m & ~pairMask) === 0 && isCpuSmtContended(pc.siblings[0], coreC0, physicalCores)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Apply per-thread affinity edit cleanly with ERROR_ACCESS_DENIED handling and session originalAffinity tracking.
   * Never mutates masks passively; only records originalAffinity when an edit is applied.
   */
  function applyThreadAffinityEdit(proc, tid, newMask, originalMap, opts = {}) {
    if (!proc || !Array.isArray(proc.threads)) {
      return { ok: false, error: 'NO_PROCESS', message: 'No attached process' };
    }
    if (opts.accessDenied || proc.protectedProcess) {
      return {
        ok: false,
        error: 'ERROR_ACCESS_DENIED',
        message: '[Access Denied - Protected Process]'
      };
    }
    const fullMask = getFullTopologyMask(opts.logicalCpus || CONFIG.logicalCpus);
    const sanitized = (Number(newMask) >>> 0) & fullMask;
    if (sanitized === 0) {
      return { ok: false, error: 'INVALID_MASK', message: 'Affinity mask must include at least one logical CPU' };
    }
    const thread = proc.threads.find(t => t.tid === tid);
    if (!thread) {
      return { ok: false, error: 'THREAD_NOT_FOUND', message: `Thread ${tid} not found` };
    }

    if (!(tid in originalMap)) {
      originalMap[tid] = thread.affinityMask >>> 0;
    }
    thread.affinityMask = sanitized;
    if (((1 << thread.currentCpu) & sanitized) === 0) {
      thread.currentCpu = firstSetBit(sanitized, opts.logicalCpus || CONFIG.logicalCpus);
    }
    if (((1 << thread.idealCpu) & sanitized) === 0) {
      thread.idealCpu = thread.currentCpu;
    }

    let excludedSiblingsCount = 0;
    if (opts.excludeSiblingFromOthers && countSetBits(sanitized) === 1) {
      const pinnedCpu = firstSetBit(sanitized, opts.logicalCpus || CONFIG.logicalCpus);
      const physicalCores = opts.physicalCores || CONFIG.physicalCores;
      const pc = physicalCores.find(p => p.siblings.includes(pinnedCpu));
      if (pc && pc.siblings.length >= 2) {
        const siblingCpu = pc.siblings[0] === pinnedCpu ? pc.siblings[1] : pc.siblings[0];
        const sibBit = (1 << siblingCpu) >>> 0;
        for (const other of proc.threads) {
          if (other.tid === tid) continue;
          const curMask = other.affinityMask >>> 0;
          if ((curMask & sibBit) !== 0 && (curMask & ~sibBit) !== 0) {
            if (!(other.tid in originalMap)) {
              originalMap[other.tid] = curMask;
            }
            other.affinityMask = (curMask & ~sibBit) >>> 0;
            if (other.currentCpu === siblingCpu) {
              other.currentCpu = firstSetBit(other.affinityMask, opts.logicalCpus || CONFIG.logicalCpus);
            }
            if (other.idealCpu === siblingCpu) {
              other.idealCpu = other.currentCpu;
            }
            excludedSiblingsCount += 1;
          }
        }
      }
    }

    return {
      ok: true,
      tid,
      newMask: sanitized,
      excludedSiblingsCount,
      editedCount: Object.keys(originalMap).length
    };
  }

  function revertAllThreadAffinities(proc, originalMap) {
    if (!proc || !Array.isArray(proc.threads) || !originalMap) return 0;
    let restored = 0;
    for (const [tidKey, origMask] of Object.entries(originalMap)) {
      const tid = Number(tidKey);
      const thread = proc.threads.find(t => t.tid === tid);
      if (thread) {
        thread.affinityMask = (Number(origMask) >>> 0);
        restored += 1;
      }
      delete originalMap[tidKey];
    }
    return restored;
  }

  // =========================================================================
  // B. PRESENT / FRAME-TIME & PRESENTATION PATH CONSUMER (etw/present.rs parity)
  // =========================================================================

  function isComposedPresentMode(mode) {
    if (typeof mode !== 'string') return false;
    return mode === 'Composed: Flip' || mode.startsWith('Composed: Copy');
  }

  /**
   * Compute rolling frame metrics over a 300-frame ring buffer:
   * FPS, Avg Frametime (ms), Median (ms), 1% Low (ms & FPS), 0.1% Low (ms & FPS),
   * active Presentation Mode, and Composed% share.
   */
  function computeFrametimeStats(frameRing) {
    if (!Array.isArray(frameRing) || frameRing.length === 0) return null;
    const valid = frameRing.filter(f => f && isFinite(f.frametimeMs) && f.frametimeMs > 0);
    if (valid.length === 0) return null;

    const times = valid.map(f => f.frametimeMs);
    const n = times.length;
    const sum = times.reduce((a, b) => a + b, 0);
    const avgMs = sum / n;
    const fps = 1000.0 / Math.max(0.01, avgMs);

    const sorted = [...times].sort((a, b) => a - b);
    const mid = Math.floor(n / 2);
    const medianMs = (n % 2 === 1) ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) * 0.5;

    // 1% Low = slowest 1% frame time (99th percentile), 0.1% Low = slowest 0.1% (99.9th percentile)
    const idx1 = Math.min(n - 1, Math.max(0, Math.floor(n * 0.99)));
    const idx01 = Math.min(n - 1, Math.max(0, Math.floor(n * 0.999)));
    const low1Ms = sorted[idx1];
    const low01Ms = sorted[idx01];
    const low1Fps = 1000.0 / Math.max(0.01, low1Ms);
    const low01Fps = 1000.0 / Math.max(0.01, low01Ms);

    const composedCount = valid.reduce((acc, f) => acc + (isComposedPresentMode(f.presentMode) ? 1 : 0), 0);
    const composedPct = (composedCount / n) * 100.0;
    const presentMode = valid[n - 1].presentMode || 'Unknown';

    return {
      frameCount: n,
      fps,
      avgMs,
      medianMs,
      low1Ms,
      low1Fps,
      low01Ms,
      low01Fps,
      presentMode,
      composedPct,
      isComposed: isComposedPresentMode(presentMode)
    };
  }

  const CULPRIT_META = {
    disk_read: {
      label: 'Disk Read bursts',
      tab: 4,
      scope: '[OS / HW]',
      fmtPeak: v => `>${Math.round(v)} MB/s`
    },
    dpc_irq: {
      label: 'DPC/IRQ spikes',
      tab: 1,
      scope: '[OS / TUI]',
      fmtPeak: v => `>${v.toFixed(1)}%`
    },
    page_faults: {
      label: 'Page Fault bursts',
      tab: 4,
      scope: '[OS / TUI]',
      fmtPeak: v => `>${Math.round(v).toLocaleString()}/s`
    },
    dram_latency: {
      label: 'DRAM Latency spikes',
      tab: 2,
      scope: '[HW / Code]',
      fmtPeak: v => `>${v.toFixed(0)} ns`
    },
    ctx_switches: {
      label: 'Context-Switch bursts',
      tab: 6,
      scope: '[Code / OS]',
      fmtPeak: v => `>${(v / 1000).toFixed(0)}K/s`
    }
  };

  /**
   * Detect a frametime spike (> 2.0x rolling median AND > 16.7 ms) and correlate it against
   * simultaneous 1s-bucket telemetry spikes (DRAM latency, Page Faults/s, DPC/IRQ%, Context Switches/s, Disk Read MB/s).
   */
  function recordFrametimeSpikeIfMatched(spikeRing, peakFrameMs, rollingMedianMs, bucketMetrics = {}, maxLen = SPIKE_RING_LEN) {
    if (!Array.isArray(spikeRing)) return null;
    const med = Math.max(0.1, Number(rollingMedianMs) || 0);
    const frameMs = Number(peakFrameMs) || 0;
    if (!(frameMs > 2.0 * med && frameMs > 16.7)) return null;

    const culprits = [];
    const metricValues = {};

    const readMbS = Number(bucketMetrics.readMbS) || 0;
    const readIops = Number(bucketMetrics.readIops) || 0;
    if (readMbS >= 50.0 || readIops >= 1000.0) {
      culprits.push('disk_read');
      metricValues.disk_read = readMbS;
    }

    const maxDpcIrq = Number(bucketMetrics.maxHotDpcIrq) || 0;
    if (maxDpcIrq >= 5.0) {
      culprits.push('dpc_irq');
      metricValues.dpc_irq = maxDpcIrq;
    }

    const pfRate = Number(bucketMetrics.pfRate) || 0;
    const hardReads = Number(bucketMetrics.hardPageReadsPerSec) || 0;
    if (pfRate >= 1500 || hardReads >= 15.0) {
      culprits.push('page_faults');
      metricValues.page_faults = pfRate;
    }

    const dramLatNs = Number(bucketMetrics.l3LatNs) || 0;
    if (dramLatNs >= 65.0) {
      culprits.push('dram_latency');
      metricValues.dram_latency = dramLatNs;
    }

    const ctxSw = Number(bucketMetrics.ctxSwPerSec) || 0;
    if (ctxSw >= 45000) {
      culprits.push('ctx_switches');
      metricValues.ctx_switches = ctxSw;
    }

    const rec = {
      frameMs,
      medianMs: med,
      culprits,
      metricValues
    };
    spikeRing.push(rec);
    if (spikeRing.length > maxLen) spikeRing.shift();
    return rec;
  }

  /**
   * Analyze the spike correlation ring for a dominant culprit (>= 60% of >= 5 spikes).
   */
  function analyzeSpikeCorrelations(spikeRing) {
    const list = Array.isArray(spikeRing) ? spikeRing : [];
    const totalSpikes = list.length;
    const counts = {
      disk_read: 0,
      dpc_irq: 0,
      page_faults: 0,
      dram_latency: 0,
      ctx_switches: 0
    };
    const valsByCulprit = {
      disk_read: [],
      dpc_irq: [],
      page_faults: [],
      dram_latency: [],
      ctx_switches: []
    };

    let sumFrameMs = 0;
    let minSpikeMs = Infinity;
    for (const s of list) {
      const f = Number(s.frameMs) || 0;
      sumFrameMs += f;
      if (f < minSpikeMs) minSpikeMs = f;
      for (const c of (s.culprits || [])) {
        if (c in counts) {
          counts[c] += 1;
          if (s.metricValues && s.metricValues[c] !== undefined) {
            valsByCulprit[c].push(Number(s.metricValues[c]) || 0);
          }
        }
      }
    }

    let dominantCulprit = null;
    let dominantCount = 0;
    for (const [k, cnt] of Object.entries(counts)) {
      if (cnt > dominantCount) {
        dominantCount = cnt;
        dominantCulprit = k;
      }
    }

    const dominantSharePct = totalSpikes > 0 ? (dominantCount / totalSpikes) * 100.0 : 0.0;
    const avgSpikeMs = totalSpikes > 0 ? sumFrameMs / totalSpikes : 0.0;
    const minMs = totalSpikes > 0 && isFinite(minSpikeMs) ? minSpikeMs : 0.0;

    let culpritSummary = '';
    let culpritMeta = null;
    if (dominantCulprit && CULPRIT_META[dominantCulprit]) {
      culpritMeta = CULPRIT_META[dominantCulprit];
      const vList = valsByCulprit[dominantCulprit];
      const floorVal = vList.length > 0 ? Math.min(...vList) : 0;
      const metricTag = floorVal > 0 ? ` ${culpritMeta.fmtPeak(floorVal)}` : '';
      culpritSummary = `${culpritMeta.label}${metricTag}`;
    }

    return {
      totalSpikes,
      counts,
      dominantCulprit,
      dominantCount,
      dominantSharePct,
      avgSpikeMs,
      minSpikeMs: minMs,
      culpritMeta,
      culpritSummary
    };
  }

  // =========================================================================
  // C. VIRTUAL ADDRESS SPACE & PRIVATE EXECUTABLE / JIT MAP (win32/va_map.rs)
  // =========================================================================

  /**
   * Aggregate VirtualQueryEx + QueryWorkingSetEx committed regions into 4 categories,
   * each split by 2 MiB Large vs 4 KiB pages.
   * Non-committed (RESERVE / FREE) regions are ignored.
   */
  function aggregateVaRegions(regions) {
    const blank = () => ({
      commit2mBytes: 0,
      commit4kBytes: 0,
      ws2mBytes: 0,
      ws4kBytes: 0,
      regionCount: 0
    });

    const buckets = {
      privateRw: blank(),
      privateJit: blank(),
      mapped: blank(),
      image: blank()
    };

    for (const r of regions || []) {
      if (!r || r.state !== 'COMMIT') continue;
      const commitB = Math.max(0, Number(r.commitBytes) || 0);
      const wsB = Math.max(0, Number(r.wsBytes ?? commitB) || 0);
      const type = String(r.type || 'PRIVATE').toUpperCase();
      const prot = String(r.protect || 'RW').toUpperCase();
      const isExec = prot.includes('X') || prot.includes('EXECUTE');

      let target = buckets.privateRw;
      if (type === 'IMAGE') {
        target = buckets.image;
      } else if (type === 'MAPPED') {
        target = buckets.mapped;
      } else {
        target = isExec ? buckets.privateJit : buckets.privateRw;
      }

      if (r.largePage) {
        target.commit2mBytes += commitB;
        target.ws2mBytes += wsB;
      } else {
        target.commit4kBytes += commitB;
        target.ws4kBytes += wsB;
      }
      target.regionCount += 1;
    }

    const toMiB = b => b / (1024 * 1024);
    const finalize = (label, key, b) => ({
      key,
      label,
      commit2mMiB: toMiB(b.commit2mBytes),
      commit4kMiB: toMiB(b.commit4kBytes),
      ws2mMiB: toMiB(b.ws2mBytes),
      ws4kMiB: toMiB(b.ws4kBytes),
      totalCommitMiB: toMiB(b.commit2mBytes + b.commit4kBytes),
      totalWsMiB: toMiB(b.ws2mBytes + b.ws4kBytes),
      regionCount: b.regionCount
    });

    const privateRw = finalize('Private RW', 'privateRw', buckets.privateRw);
    const privateJit = finalize('Private JIT RX/RWX', 'privateJit', buckets.privateJit);
    const mapped = finalize('Mapped', 'mapped', buckets.mapped);
    const image = finalize('Image', 'image', buckets.image);

    const imgTotalBytes = buckets.image.commit2mBytes + buckets.image.commit4kBytes;
    const imageLarge2mPct = imgTotalBytes > 0
      ? (buckets.image.commit2mBytes / imgTotalBytes) * 100.0
      : 0.0;

    return {
      rows: [privateRw, privateJit, mapped, image],
      privateRw,
      privateJit,
      mapped,
      image,
      privateJitExec4kMiB: privateJit.commit4kMiB,
      privateJitWs4kMiB: privateJit.ws4kMiB,
      imageLarge2mPct
    };
  }

  /**
   * Build deterministic VirtualQueryEx region descriptors for a simulated process
   * consistent with its modules, hugeMiB, wsMiB, sharedMiB, and vaProfile.
   */
  function buildSimulatedVaRegionsForProcess(proc) {
    if (!proc) return [];
    const MiB = 1024 * 1024;
    const vp = proc.vaProfile || {};
    const regions = [];

    // 1. PE Image regions (reflect live 2 MiB vs 4 KiB backing from proc.modules)
    for (const m of proc.modules || []) {
      const b = Math.round(m.sizeMiB * MiB);
      regions.push({
        type: 'IMAGE',
        protect: m.prot || 'RX',
        state: 'COMMIT',
        commitBytes: b,
        wsBytes: Math.round(b * 0.88),
        largePage: Boolean(m.lp)
      });
    }

    // 2. Private Executable / JIT (RX / RWX) regions
    const jit4kMiB = Math.max(0, Number(vp.privateJit4kMiB) || 0);
    const jit2mMiB = Math.max(0, Number(vp.privateJit2mMiB) || 0);
    if (jit4kMiB > 0) {
      regions.push({
        type: 'PRIVATE',
        protect: vp.jitProtect || 'RWX',
        state: 'COMMIT',
        commitBytes: Math.round(jit4kMiB * MiB),
        wsBytes: Math.round(jit4kMiB * 0.92 * MiB),
        largePage: false
      });
    }
    if (jit2mMiB > 0) {
      regions.push({
        type: 'PRIVATE',
        protect: 'RX',
        state: 'COMMIT',
        commitBytes: Math.round(jit2mMiB * MiB),
        wsBytes: Math.round(jit2mMiB * MiB),
        largePage: true
      });
    }

    // 3. Private RW (heap/stack: 2 MiB huge pages + 4 KiB private commit/WS)
    const priv2mMiB = Math.max(0, Number(proc.hugeMiB) || 0);
    const priv4kWsMiB = Math.max(8, (Number(proc.wsMiB) || 64) - jit4kMiB);
    const priv4kCommitMiB = Math.max(priv4kWsMiB, (Number(proc.commitMiB) || priv4kWsMiB) - priv2mMiB - jit4kMiB);
    if (priv2mMiB > 0) {
      regions.push({
        type: 'PRIVATE',
        protect: 'RW',
        state: 'COMMIT',
        commitBytes: Math.round(priv2mMiB * MiB),
        wsBytes: Math.round(priv2mMiB * MiB),
        largePage: true
      });
    }
    regions.push({
      type: 'PRIVATE',
      protect: 'RW',
      state: 'COMMIT',
      commitBytes: Math.round(priv4kCommitMiB * MiB),
      wsBytes: Math.round(priv4kWsMiB * MiB),
      largePage: false
    });

    // 4. Mapped (shared sections / memory-mapped asset files)
    const mapped4kMiB = Math.max(4, Number(vp.mapped4kMiB ?? Math.max(24, (proc.sharedMiB || 128) * 0.65)));
    const mapped2mMiB = Math.max(0, Number(vp.mapped2mMiB) || 0);
    regions.push({
      type: 'MAPPED',
      protect: 'R',
      state: 'COMMIT',
      commitBytes: Math.round(mapped4kMiB * 1.25 * MiB),
      wsBytes: Math.round(mapped4kMiB * MiB),
      largePage: false
    });
    if (mapped2mMiB > 0) {
      regions.push({
        type: 'MAPPED',
        protect: 'RW',
        state: 'COMMIT',
        commitBytes: Math.round(mapped2mMiB * MiB),
        wsBytes: Math.round(mapped2mMiB * MiB),
        largePage: true
      });
    }

    // Include a non-committed RESERVE guard region to mirror real VirtualQueryEx scans
    regions.push({
      type: 'PRIVATE',
      protect: 'RW',
      state: 'RESERVE',
      commitBytes: 512 * MiB,
      wsBytes: 0,
      largePage: false
    });

    return regions;
  }

  // =========================================================================
  // D. PROCESS DISK & ASSET-STREAMING I/O (win32/io.rs parity)
  // =========================================================================

  /**
   * Compute live Disk I/O rates from two GetProcessIoCounters snapshots.
   */
  function computeIoCounterDeltas(prev, curr, dtSec) {
    const dt = Math.max(0.001, Number(dtSec) || 1.0);
    const dReadBytes = Math.max(0, (Number(curr?.readBytes) || 0) - (Number(prev?.readBytes) || 0));
    const dWriteBytes = Math.max(0, (Number(curr?.writeBytes) || 0) - (Number(prev?.writeBytes) || 0));
    const dReadOps = Math.max(0, (Number(curr?.readOps) || 0) - (Number(prev?.readOps) || 0));
    const dWriteOps = Math.max(0, (Number(curr?.writeOps) || 0) - (Number(prev?.writeOps) || 0));

    return {
      readMbS: dReadBytes / (1024 * 1024) / dt,
      writeMbS: dWriteBytes / (1024 * 1024) / dt,
      readIops: dReadOps / dt,
      writeIops: dWriteOps / dt
    };
  }

  Object.assign(Z, {
    PRESENT_RING_LEN,
    SPIKE_RING_LEN,
    CULPRIT_META,
    formatThreadEntry,
    computeThreadDeltaMetrics,
    getFullTopologyMask,
    getCcxMask,
    getPrimaryPhysicalCoresMask,
    formatAffinityHex,
    firstSetBit,
    countSetBits,
    describeAffinityMask,
    isCpuSmtContended,
    isThreadSmtContended,
    applyThreadAffinityEdit,
    revertAllThreadAffinities,
    isComposedPresentMode,
    computeFrametimeStats,
    recordFrametimeSpikeIfMatched,
    analyzeSpikeCorrelations,
    aggregateVaRegions,
    buildSimulatedVaRegionsForProcess,
    computeIoCounterDeltas
  });
})();
