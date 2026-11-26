// Group A Zero-PMC Win32 diagnostic rules (active in every preset incl. No-PMU)
(() => {
  'use strict';
  const Z = window.Zen2Top || (window.Zen2Top = {});
  const { CONFIG, fmtMiB, formatThreadEntry, getFullTopologyMask, formatAffinityHex } = Z;

  const EXPLICIT_LOCK_WAIT_RE = /(?:RtlEnterCriticalSection|AcquireSRWLock\w*|NtWaitForAlertByThreadId|NtWaitForKeyedEvent|std::mutex|WaitOnAddress)/i;

  function evaluateGroupARules(ctx) {
    const {
      proc, minSamples = CONFIG.advisor.minSamples, profCtx,
      threadRollingWindow = [], presentRollingWindow = [],
      hasItlb, avgC0, avgPfRate, avgTierCpi, avgCoreC0, avgSys, avgL2Itlb,
      avgGpu3dPct, avgCoreDpc, avgCoreIrq, avgCoreIrqRate,
      avgHardPageReads, avgAvailPhysPct, avgCommitPct,
      avgCtxSw, avgSyncWaitPct, topWaitReason,
      priorityClass, ecoQos, seLockMemoryPrivilege, bgList,
      presentStats, spikeCorrelation, vaMap,
      avgReadMbS, avgReadIops,
      pushFinding, pushHealthy
    } = ctx;

    // =====================================================================
    // GROUP A: ZERO-PMC WIN32 DIAGNOSTICS (Active in EVERY preset incl. --no-pmu)
    // =====================================================================

    // --- GROUP A RULE 1: GPU-Bound (D3DKMT 3D Engine >= 97% & hottest CPU C0 < 75%) ---
    let gpuBound = false;
    let hottestCpuC0 = 0;
    let hottestCpuIdx = 0;
    for (let i = 0; i < avgCoreC0.length; i++) {
      if (avgCoreC0[i] > hottestCpuC0) {
        hottestCpuC0 = avgCoreC0[i];
        hottestCpuIdx = i;
      }
    }
    const hottestCpuTag = 'C' + String(hottestCpuIdx).padStart(2, '0');
    if (avgGpu3dPct !== null) {
      if (avgGpu3dPct >= 97.0 && hottestCpuC0 < 75.0) {
        gpuBound = true;
        pushFinding({
          id: 'gpu_bound',
          category: 'GpuBound',
          isPrimaryAnchor: true,
          severity: 'HI',
          scope: '[OS / TUI]',
          confidence: 'HIGH',
          impact: 1.50,
          title: `GPU-bound workload: 3D engine at ${avgGpu3dPct.toFixed(1)}% (hottest CPU ${hottestCpuTag} only ${hottestCpuC0.toFixed(0)}% C0)`,
          keyMetric: `GPU 3D ${avgGpu3dPct.toFixed(1)}% | Max CPU ${hottestCpuC0.toFixed(0)}%`,
          estGain: {
            kind: 'qualitative',
            label: 'FPS gated by GPU',
            detail: 'Qualitative: average FPS is gated by GPU 3D saturation; CPU/RAM tuning will not raise average FPS until GPU load drops (may still aid 1% lows)'
          },
          why: `D3DKMTQueryStatistics reports global GPU 3D engine utilization averaging ${avgGpu3dPct.toFixed(1)}% (>=97%) while the hottest logical CPU (${hottestCpuTag}) averages only ${hottestCpuC0.toFixed(1)}% C0 (<75%). The CPU is waiting on GPU fences and Present queues.`,
          action: `Lower GPU render resolution, enable upscaling (FSR/DLSS), or reduce shader/RT quality before chasing CPU stalls. Lowering CPI or tuning CPU/RAM will not raise average FPS while GPU-bound (though CPU tweaks may still help 1% lows during CPU-heavy spikes).`,
          cascade: `Relieving GPU 3D saturation exposes true CPU frame-time headroom so microarchitectural optimizations translate into higher average FPS.`,
          quickJumpTab: 1
        });
      } else {
        pushHealthy('GPU <97%', `${avgGpu3dPct.toFixed(0)}%`);
      }
    }

    // --- GROUP A RULE 2: Per-Logical-CPU DPC & Hardware IRQ Collision ---
    let worstDpcCol = null;
    let maxHotDpcIrq = 0;
    let anyHotCpu = false;
    for (let i = 0; i < avgCoreC0.length; i++) {
      const c0 = avgCoreC0[i] || 0;
      const dpc = avgCoreDpc[i] || 0;
      const irq = avgCoreIrq[i] || 0;
      const tot = dpc + irq;
      if (c0 >= 60.0) {
        anyHotCpu = true;
        if (tot > maxHotDpcIrq) maxHotDpcIrq = tot;
        if (tot >= 5.0 && (!worstDpcCol || tot > worstDpcCol.total)) {
          worstDpcCol = { cpu: i, c0, dpc, irq, total: tot, irqRate: avgCoreIrqRate[i] || 0 };
        }
      }
    }
    if (!anyHotCpu) {
      for (let i = 0; i < avgCoreDpc.length; i++) {
        const tot = (avgCoreDpc[i] || 0) + (avgCoreIrq[i] || 0);
        if (tot > maxHotDpcIrq) maxHotDpcIrq = tot;
      }
    }
    if (worstDpcCol) {
      const cpuTag = 'C' + String(worstDpcCol.cpu).padStart(2, '0');
      const isHi = worstDpcCol.total >= 8.0;
      pushFinding({
        id: 'dpc_irq_collision',
        category: 'OsKernelChurn',
        severity: isHi ? 'HI' : 'MD',
        scope: '[OS / TUI]',
        confidence: 'HIGH',
        impact: isHi ? 0.42 : 0.16,
        title: `DPC/IRQ collision on hot CPU ${cpuTag} (${worstDpcCol.total.toFixed(1)}% while ${worstDpcCol.c0.toFixed(0)}% C0)`,
        keyMetric: `${cpuTag}: ${worstDpcCol.total.toFixed(1)}% DPC+IRQ @ ${worstDpcCol.c0.toFixed(0)}% C0`,
        estGain: {
          kind: 'qualitative',
          label: '1% lows / jitter',
          detail: 'Qualitative: eliminates ISR/DPC kernel preemption and L1/L2 cache eviction on the active thread core'
        },
        why: `SystemProcessorPerformanceInformation reports ${cpuTag}: ${worstDpcCol.total.toFixed(1)}% DPC+IRQ (DPC ${worstDpcCol.dpc.toFixed(1)}% + IRQ ${worstDpcCol.irq.toFixed(1)}%, ${Math.round(worstDpcCol.irqRate).toLocaleString()} IRQ/s) while running ${worstDpcCol.c0.toFixed(0)}% C0 active load.`,
        action: `Shift GPU, NIC, or USB MSI interrupt affinity off ${cpuTag} (Interrupt Affinity Policy Tool) or pin the target's main thread to a quiet logical CPU.`,
        cascade: `Reduces frame-time spikes and prevents L1/L2 cache eviction caused by kernel ISR/DPC preemption.`,
        quickJumpTab: 1,
        openCcx: true
      });
    } else {
      pushHealthy('DPC/IRQ <5%', `peak ${maxHotDpcIrq.toFixed(1)}%`);
    }

    // --- GROUP A RULE 3: Noisy Neighbor Background Process ---
    const filteredBg = bgList
      .filter(b => b.name && b.name.toLowerCase() !== 'system idle process' && (!proc || b.pid !== proc.pid))
      .sort((a, b) => b.sysCpuPct - a.sysCpuPct);
    const noisyMatch = filteredBg.find(b => b.sysCpuPct >= 5.0 || b.singleCorePct >= 50.0);
    if (noisyMatch) {
      pushFinding({
        id: 'noisy_neighbor',
        category: 'OsKernelChurn',
        severity: 'MD',
        scope: '[OS / TUI]',
        confidence: 'HIGH',
        impact: 0.18,
        title: `Noisy neighbor: ${noisyMatch.name} [${noisyMatch.pid}] using ${noisyMatch.sysCpuPct.toFixed(1)}% CPU`,
        keyMetric: `${noisyMatch.sysCpuPct.toFixed(1)}% sys | ${noisyMatch.singleCorePct.toFixed(0)}% 1-core`,
        estGain: {
          kind: 'qualitative',
          label: 'L3 + A/B stability',
          detail: 'Qualitative: removes background shared L3 cache eviction and A/B baseline contamination'
        },
        why: `SystemProcessInformation shows non-target process ${noisyMatch.name} [${noisyMatch.pid}] averaging ${noisyMatch.sysCpuPct.toFixed(1)}% total system CPU (${noisyMatch.singleCorePct.toFixed(0)}% of one logical core) during the session.`,
        action: `Pause or close ${noisyMatch.name} [${noisyMatch.pid}] before profiling or gaming. Background CPU bursts compete for Zen 2's shared CCX L3 cache and contaminate A/B baselines.`,
        cascade: `Stabilizes unified L3 hit rate, reduces scheduler preemption, and improves A/B baseline repeatability.`,
        quickJumpTab: 1
      });
    } else {
      const topQuiet = filteredBg[0] ? filteredBg[0].sysCpuPct : 0;
      pushHealthy('No noisy neighbor', `top ${topQuiet.toFixed(1)}%`);
    }

    // --- GROUP A RULE 4: Priority Class & Windows 11 EcoQoS Throttling ---
    if (proc) {
      const isLowPrio = priorityClass === 'BELOW_NORMAL' || priorityClass === 'IDLE';
      const isEcoActive = ecoQos === 'Active';
      if (isLowPrio || isEcoActive) {
        const flags = [];
        if (isEcoActive) flags.push('EcoQoS active');
        if (priorityClass === 'BELOW_NORMAL') flags.push('BelowNormal priority');
        if (priorityClass === 'IDLE') flags.push('Idle priority');
        const flagStr = flags.join(' + ');
        pushFinding({
          id: 'priority_or_ecoqos',
          category: 'ClockThrottling',
          severity: 'HI',
          scope: '[OS / TUI]',
          confidence: 'HIGH',
          impact: 0.48,
          title: `Target OS throttling active: ${flagStr}`,
          keyMetric: `${priorityClass} | EcoQoS ${ecoQos}`,
          estGain: {
            kind: 'qualitative',
            label: 'Boost / quantum',
            detail: 'Qualitative: restores full CPU boost clocks and normal Windows scheduler quantum priority'
          },
          why: `GetPriorityClass / GetProcessInformation(ProcessPowerThrottling) reports ${flagStr} on ${proc.name} (PID ${proc.pid}). Windows 11 Efficiency Mode (PROCESS_POWER_THROTTLING_EXECUTION_SPEED) caps boost frequencies and deprioritizes scheduling.`,
          action: `Disable Efficiency Mode (EcoQoS) for ${proc.name} in Task Manager / launcher settings and restore NORMAL or HIGH priority class.`,
          cascade: `Restores full boost clocks and scheduler quantum priority, preventing silent frequency caps and thread starvation.`,
          quickJumpTab: 4
        });
      } else {
        pushHealthy('Normal QoS', `${priorityClass}${ecoQos === 'Unknown' ? '' : ', EcoQoS off'}`);
      }
    }

    // --- GROUP A RULE 5: Hard Page Faults (Disk Paging) & Physical Memory Pressure ---
    if (avgHardPageReads >= 20.0 || avgAvailPhysPct < 5.0) {
      const hasLockedHuge = Boolean(proc && ((proc.hugeMiB || 0) > 0 || (proc.arenas && proc.arenas.hugeArenas.length > 0)));
      const hugeWarn = hasLockedHuge
        ? ` Warning: ${proc.name} holds ${fmtMiB(proc.hugeMiB)} of locked 2 MiB huge pages; over-reserving MIMALLOC_RESERVE_HUGE_OS_PAGES may be starving Windows' pageable working set.`
        : '';
      pushFinding({
        id: 'hard_page_faults',
        category: 'OsKernelChurn',
        severity: 'HI',
        scope: '[OS / HW]',
        confidence: 'HIGH',
        impact: 0.52,
        title: `Hard disk page faults / RAM pressure (${avgHardPageReads.toFixed(1)} reads/s, ${avgAvailPhysPct.toFixed(1)}% RAM free)`,
        keyMetric: `Hard ${avgHardPageReads.toFixed(1)}/s | Avail ${avgAvailPhysPct.toFixed(1)}%`,
        estGain: {
          kind: 'qualitative',
          label: 'Eliminates I/O hitch',
          detail: 'Qualitative: stops millisecond-scale disk paging stalls from physical memory exhaustion'
        },
        why: `PDH \\Memory\\Page Reads/sec averages ${avgHardPageReads.toFixed(1)}/s with ${avgAvailPhysPct.toFixed(1)}% available physical RAM (commit ${avgCommitPct.toFixed(1)}%). These are real disk-backed hard faults, distinct from harmless soft faults in NtQueryInformationProcess (${Math.round(avgPfRate).toLocaleString()}/s total).`,
        action: `Free physical RAM (close memory-heavy background apps or add RAM) to stop pagefile thrashing.${hugeWarn}`,
        cascade: `Eliminates millisecond-scale disk I/O hitches and severe frame-time freezes.`,
        quickJumpTab: 4
      });
    } else {
      pushHealthy(
        avgHardPageReads < 0.5 ? 'Hard faults 0/s' : 'Hard faults <20/s',
        `${avgHardPageReads.toFixed(1)}/s, ${avgAvailPhysPct.toFixed(0)}% RAM free`
      );
    }

    // --- GROUP A RULE 6: Exact Large-Page Failure Root Cause (Upgrades Rule 1 Silent Failure, Zero-PMC) ---
    let largePageFailureTriggered = false;
    if (proc) {
      const silentFailMods = (proc.ifeoEnabled && proc.modules)
        ? proc.modules.filter(m => m.ifeo && !m.lp && !m.sessionToggled)
        : [];
      const mimallocZeroHuge = Boolean((proc.requestedHugeMiB || 0) > 0 && (proc.hugeMiB || 0) === 0);

      if (silentFailMods.length > 0 || mimallocZeroHuge) {
        largePageFailureTriggered = true;
        const privMissing = seLockMemoryPrivilege === 'Missing';
        const reasons = [];
        if (silentFailMods.length > 0) {
          const modNames = silentFailMods.slice(0, 3).map(m => m.name).join(', ');
          reasons.push(`IFEO UseLargePages=1 fell back to 4 KiB on ${silentFailMods.length} DLL(s) (${modNames}${silentFailMods.length > 3 ? ', ...' : ''})`);
        }
        if (mimallocZeroHuge) {
          reasons.push(`Mimalloc huge arenas reported 0 GiB despite ${fmtMiB(proc.requestedHugeMiB)} requested`);
        }
        const shortTag = silentFailMods.length > 0 ? `${silentFailMods.length} DLLs 4K` : '0 GiB Huge';

        pushFinding({
          id: 'large_page_failure_root_cause',
          category: 'TlbTranslationBound',
          severity: 'HI',
          scope: '[OS / TUI]',
          confidence: 'HIGH',
          impact: 0.46 + (hasItlb ? avgTierCpi.l2Itlb : 0),
          title: privMissing
            ? `Missing SeLockMemoryPrivilege (${shortTag} failed 2 MiB backing)`
            : `Contiguous 2 MiB RAM Fragmentation (${shortTag} failed 2 MiB backing)`,
          keyMetric: `${privMissing ? 'Priv: Missing' : 'Priv: Present'} | ${shortTag}`,
          estGain: {
            kind: 'qualitative',
            label: '2 MiB page backing',
            detail: 'Qualitative: restores hardware 2 MiB large-page allocations to cut TLB walks and PTE cache pollution'
          },
          why: `${reasons.join('; ')}. OpenProcessToken / GetTokenInformation(TokenPrivileges) verified SeLockMemoryPrivilege is ${privMissing ? 'MISSING from the token' : 'PRESENT/ENABLED on the token, ruling out permissions and proving contiguous 2 MiB physical RAM fragmentation'}.`,
          action: privMissing
            ? `Grant "Lock Pages in Memory" (SeLockMemoryPrivilege) to your user account in secpol.msc -> Local Policies -> User Rights Assignment, then sign out and sign back in.`
            : `SeLockMemoryPrivilege is already present. Clear Windows standby RAM (e.g. RAMMap / EmptyStandbyList) or relaunch ${proc.name} after freeing fragmented physical memory.`,
          cascade: `Restores hardware 2 MiB page backing -> eliminates 4-level page-table walks and reduces PTE pollution in L1d/L2/L3.`,
          quickJumpTab: silentFailMods.length > 0 ? 3 : 4
        });
      }
    }

    // --- GROUP A RULE 7: Context-Switch Storm & Lock Contention ---
    if (proc && avgCtxSw >= 50000.0 && avgSyncWaitPct >= 40.0 && avgC0 < 85.0) {
      pushFinding({
        id: 'context_switch_storm',
        category: 'OsKernelChurn',
        severity: 'MD',
        scope: '[Code / OS]',
        confidence: 'HIGH',
        impact: 0.19,
        title: `Context-switch storm & lock contention (${(avgCtxSw / 1000).toFixed(1)}K cs/s, ${avgSyncWaitPct.toFixed(0)}% sync waits)`,
        keyMetric: `${(avgCtxSw / 1000).toFixed(1)}K/s | ${avgSyncWaitPct.toFixed(0)}% ${topWaitReason}`,
        estGain: {
          kind: 'qualitative',
          label: '-sys% / tail latency',
          detail: 'Qualitative: cuts kernel scheduler overhead (sys%) and synchronization wait tail latency'
        },
        why: `SystemProcessInformation thread inspection shows ${proc.name} averaging ${Math.round(avgCtxSw).toLocaleString()} context switches/s with ${avgSyncWaitPct.toFixed(1)}% of waiting threads blocked on synchronization primitives (top: ${topWaitReason}; WrMutex/WrExecutive/WrPushLock/WrResource) while average CPU saturation is only ${avgC0.toFixed(1)}% (<85%).`,
        action: `Diagnose lock contention or worker-thread oversubscription: cap worker pool threads to physical cores (${CONFIG.physicalCores.length} on ${CONFIG.cpuModel}) or replace contended OS locks with sharded or lock-free queues.`,
        cascade: `Cuts kernel scheduler overhead (sys%), reduces cache thrashing from thread migrations, and tightens tail latency.`,
        quickJumpTab: 4
      });
    }


    // --- GROUP A RULE 8: DWM Composed Flip Presentation Path (Present ETW) ---
    if (proc && presentStats) {
      if (presentStats.composedPct >= 80.0) {
        pushFinding({
          id: 'composed_flip_mode',
          category: 'OsKernelChurn',
          severity: 'MD',
          scope: '[OS / TUI]',
          confidence: 'HIGH',
          impact: 0.21,
          title: `DWM Composed presentation path (${presentStats.presentMode} on ${presentStats.composedPct.toFixed(0)}% of frames)`,
          keyMetric: `${presentStats.presentMode} | ${presentStats.composedPct.toFixed(0)}%`,
          estGain: {
            kind: 'qualitative',
            label: '-DWM latency',
            detail: 'Qualitative: bypasses DWM compositor copy/queue to cut display latency and DWM GPU/CPU overhead'
          },
          why: `Microsoft-Windows-DXGI / DxgKrnl Present ETW reports ${presentStats.composedPct.toFixed(0)}% of recent frames (>=80%) routing through ${presentStats.presentMode} instead of Hardware: Independent Flip.`,
          action: `Switch ${proc.name} to Exclusive Fullscreen or Borderless Flip Model (Optimizations for Windowed Games), disable hooking overlays, or force Hardware: Independent Flip.`,
          cascade: `Cuts presentation latency by 1-2 frames and removes DWM compositor GPU/CPU overhead.`,
          quickJumpTab: 6
        });
      } else {
        pushHealthy('Independent Flip', `${presentStats.fps.toFixed(0)} FPS (${presentStats.presentMode})`);
      }
    }

    // --- GROUP A RULE 9: Residual 4 KiB JIT iTLB Misses (PE Already >=75% 2 MiB) ---
    let jitResidualTriggered = false;
    if (proc && hasItlb && avgL2Itlb >= 0.35 && vaMap && vaMap.imageLarge2mPct >= 75.0 && vaMap.privateJitExec4kMiB >= 8.0) {
      jitResidualTriggered = true;
      pushFinding({
        id: 'jit_4k_itlb_residual',
        category: 'TlbTranslationBound',
        severity: 'MD',
        scope: '[OS / Code]',
        confidence: 'HIGH',
        impact: 0.20 + avgTierCpi.l2Itlb,
        title: `Residual iTLB misses from 4 KiB JIT/RWX code (${vaMap.privateJitExec4kMiB.toFixed(1)} MiB, PE already ${vaMap.imageLarge2mPct.toFixed(0)}% 2 MiB)`,
        keyMetric: `iTLB ${avgL2Itlb.toFixed(2)} | JIT ${vaMap.privateJitExec4kMiB.toFixed(1)} MiB`,
        estGain: {
          kind: 'qualitative',
          label: 'Avoids futile IFEO',
          detail: 'Qualitative: proves residual iTLB walks originate in 4 KiB dynamic JIT code that Windows IFEO cannot map with 2 MiB pages'
        },
        why: `L2 iTLB walks remain ${avgL2Itlb.toFixed(2)} MPKI (>=0.35) even though ${vaMap.imageLarge2mPct.toFixed(0)}% (>=75%) of loaded PE image bytes are already backed by 2 MiB large pages. VirtualQueryEx identifies ${vaMap.privateJitExec4kMiB.toFixed(1)} MiB (>=8 MiB) of 4 KiB private executable (RX/RWX) dynamic JIT code.`,
        action: `Stop tuning Windows IFEO PE registry entries (they only apply to static PE images). Address dynamic JIT code locality or runtime large-page JIT flags (e.g. V8/CoreCLR/JVM code-cache tuning).`,
        cascade: `Prevents wasted IFEO registry troubleshooting and focuses effort on dynamic code-cache locality.`,
        quickJumpTab: 3
      });
    }

    // --- GROUP A RULE 10: Disk I/O Asset-Streaming / Shader-Cache Stall ---
    const hasFrametimeSpikes = Boolean(spikeCorrelation && spikeCorrelation.totalSpikes > 0);
    if (proc && (avgReadMbS >= 50.0 || avgReadIops >= 1000.0) && (hasFrametimeSpikes || avgSys >= 15.0 || topWaitReason === 'WrPageIn')) {
      const triggerNote = hasFrametimeSpikes
        ? `${spikeCorrelation.totalSpikes} frametime spike(s) >2x median`
        : (topWaitReason === 'WrPageIn' ? 'WrPageIn wait dominance' : `elevated sys ${avgSys.toFixed(1)}%`);
      pushFinding({
        id: 'disk_io_streaming_stall',
        category: 'OsKernelChurn',
        severity: 'MD',
        scope: '[OS / HW]',
        confidence: 'HIGH',
        impact: 0.24,
        title: `Asset-streaming disk I/O stall (${avgReadMbS.toFixed(0)} MB/s, ${Math.round(avgReadIops).toLocaleString()} read IOPS)`,
        keyMetric: `Read ${avgReadMbS.toFixed(0)} MB/s | ${Math.round(avgReadIops).toLocaleString()} IOPS`,
        estGain: {
          kind: 'qualitative',
          label: 'Isolates I/O hitch',
          detail: 'Qualitative: separates storage streaming / shader-cache hitches from CPU/RAM micro-arch stalls'
        },
        why: `GetProcessIoCounters shows ${proc.name} reading ${avgReadMbS.toFixed(1)} MB/s (${Math.round(avgReadIops).toLocaleString()} read IOPS) coinciding with ${triggerNote}.`,
        action: `Treat these hitches as storage asset-streaming or shader-cache compilation stalls rather than CPU IPC or RAM timing bottlenecks. Move game/shader cache to NVMe SSD, pre-compile shaders, or check antivirus I/O exclusions.`,
        cascade: `Prevents misattributing storage I/O hitches to CPU/RAM timings and eliminates streaming stutter.`,
        quickJumpTab: 4
      });
    }

    // --- GROUP A RULE 11: Frametime Spike Correlator (INFO / MD) ---
    let spikeCorrelatorTriggered = false;
    if (proc && spikeCorrelation && spikeCorrelation.totalSpikes >= 5 && spikeCorrelation.dominantSharePct >= 60.0 && spikeCorrelation.dominantCulprit) {
      spikeCorrelatorTriggered = true;
      const sc = spikeCorrelation;
      const sev = (sc.dominantSharePct >= 75.0 || sc.avgSpikeMs >= 25.0) ? 'MD' : 'INFO';
      const conf = (sc.dominantSharePct >= 75.0 || sc.totalSpikes >= 8) ? 'HIGH' : 'MED';
      const floorMs = Math.max(17, Math.round(sc.minSpikeMs));
      const summarySentence = `${sc.dominantCount} of ${sc.totalSpikes} frame spikes (>${floorMs} ms) coincided with ${sc.culpritSummary}`;
      pushFinding({
        id: 'frametime_spike_correlator',
        category: 'OsKernelChurn',
        severity: sev,
        scope: sc.culpritMeta ? sc.culpritMeta.scope : '[OS / TUI]',
        confidence: conf,
        impact: sev === 'MD' ? 0.22 : 0.08,
        title: summarySentence,
        keyMetric: `${sc.dominantCount}/${sc.totalSpikes} (${sc.dominantSharePct.toFixed(0)}%) | avg ${sc.avgSpikeMs.toFixed(1)} ms`,
        estGain: {
          kind: 'qualitative',
          label: '1% / 0.1% lows',
          detail: 'Qualitative: directly attributes session frame-time hitches (>2x median & >16.7 ms) to the dominant concurrent telemetry burst'
        },
        why: `The Present ETW spike correlation ring captured ${sc.totalSpikes} frame spikes (>2.0x rolling median and >16.7 ms; avg ${sc.avgSpikeMs.toFixed(1)} ms). ${sc.dominantCount}/${sc.totalSpikes} (${sc.dominantSharePct.toFixed(0)}%) occurred in the exact 1s bucket as ${sc.culpritSummary}.`,
        action: `Target the correlated culprit directly: ${summarySentence}. Inspect Tab 6 frame pacing alongside the matching subsystem tab.`,
        cascade: `Directly cuts 1% and 0.1% low frame-time spikes without guessing across unrelated subsystems.`,
        quickJumpTab: 6
      });
    }

    // Aggregate per-thread CPU% across the rolling 10-sample window for Rules 12 & 13
    const threadWinSlice = Array.isArray(threadRollingWindow) ? threadRollingWindow.slice(-minSamples) : [];
    const rollingThreadMap = new Map();
    if (threadWinSlice.length > 0) {
      for (const sampleThreads of threadWinSlice) {
        if (!Array.isArray(sampleThreads)) continue;
        for (const t of sampleThreads) {
          if (!t || t.tid === undefined || t.tid === null) continue;
          let acc = rollingThreadMap.get(t.tid);
          if (!acc) {
            acc = {
              tid: t.tid,
              cpuSum: 0,
              description: t.description || '',
              startAddress: t.startAddress ?? null,
              affinityMask: t.affinityMask,
              currentCpu: t.currentCpu
            };
            rollingThreadMap.set(t.tid, acc);
          }
          acc.cpuSum += Math.max(0, Number(t.cpuPct) || 0);
          if (t.description) acc.description = t.description;
          if (t.startAddress !== undefined && t.startAddress !== null) acc.startAddress = t.startAddress;
          if (t.affinityMask !== undefined) acc.affinityMask = t.affinityMask;
          if (t.currentCpu !== undefined) acc.currentCpu = t.currentCpu;
        }
      }
    }
    const rollingThreadsSorted = [...rollingThreadMap.values()]
      .map(a => ({ ...a, avgCpuPct: a.cpuSum / Math.max(1, threadWinSlice.length) }))
      .sort((a, b) => b.avgCpuPct - a.avgCpuPct);

    // --- GROUP A RULE 12: Single-Thread Serial Bottleneck - Exact Thread Pinpoint (Zero-PMC) ---
    if (proc && !gpuBound && avgC0 < 50.0 && threadWinSlice.length >= minSamples && rollingThreadsSorted.length >= 1) {
      const topThread = rollingThreadsSorted[0];
      const secondThread = rollingThreadsSorted.length >= 2 ? rollingThreadsSorted[1] : null;
      const secondCpuPct = secondThread ? secondThread.avgCpuPct : 0.0;
      if (topThread.avgCpuPct >= 92.0 && secondCpuPct < 65.0) {
        const entryPoint = formatThreadEntry(topThread, proc.modules || []);
        pushFinding({
          id: 'single_thread_serial_bottleneck',
          category: 'CoreExecutionBound',
          severity: topThread.avgCpuPct >= 95.0 ? 'HI' : 'MD',
          scope: '[Code / OS]',
          confidence: 'HIGH',
          impact: topThread.avgCpuPct >= 95.0 ? 0.44 : 0.28,
          title: `Single-thread serial bottleneck: TID ${topThread.tid} (${entryPoint}) at ${topThread.avgCpuPct.toFixed(1)}%`,
          keyMetric: `TID ${topThread.tid} ${topThread.avgCpuPct.toFixed(1)}% | #2 ${secondCpuPct.toFixed(0)}% | C0 ${avgC0.toFixed(0)}%`,
          estGain: {
            kind: 'qualitative',
            label: 'Amdahl serial cap',
            detail: 'Qualitative: throughput is gated by one pegged thread while other cores sit idle; adding worker threads will not help'
          },
          why: `Across the ${threadWinSlice.length}-sample rolling window, ${proc.name} thread TID ${topThread.tid} (${entryPoint}) averaged ${topThread.avgCpuPct.toFixed(1)}% (>=92%) of a logical core while the next busiest thread averaged only ${secondCpuPct.toFixed(1)}% (<65%), overall CPU C0 averaged ${avgC0.toFixed(1)}% (<50%), and the GPU is not saturated.`,
          action: `Do not increase worker-pool thread counts (Amdahl serial limit). Press Enter to jump to Tab 6 on TID ${topThread.tid} and press a -> [4] to clear its SMT sibling, then open Tab 7 scoped to TID ${topThread.tid} ('t') to profile its hot call stack.`,
          cascade: `Protects the critical-path thread's ROB/L1/L2 resources and focuses optimization directly on the serial bottleneck.`,
          quickJumpTab: 6,
          targetTid: topThread.tid
        });
      }
    }

    // --- GROUP A RULE 13: Over-Constrained Thread Affinity Mask (Zero-PMC) ---
    if (proc && Array.isArray(proc.threads) && proc.threads.length >= 2) {
      const fullMask = getFullTopologyMask(CONFIG.logicalCpus);
      const rollingCpuByTid = new Map(rollingThreadsSorted.map(t => [t.tid, t.avgCpuPct]));
      const heavyRestricted = proc.threads
        .map(t => {
          const mask = (t.affinityMask !== undefined && t.affinityMask !== null)
            ? ((Number(t.affinityMask) >>> 0) & fullMask)
            : fullMask;
          const cpuPct = rollingCpuByTid.has(t.tid) ? rollingCpuByTid.get(t.tid) : (Number(t.cpuPct) || 0);
          return { ...t, mask, cpuPct };
        })
        .filter(t => t.cpuPct >= 45.0 && t.mask !== 0 && t.mask !== fullMask);

      if (heavyRestricted.length >= 2) {
        const unionMask = heavyRestricted.reduce((acc, t) => (acc | t.mask) >>> 0, 0);
        let coveredPhysCores = 0;
        const idleOutsideCores = [];
        for (const pc of CONFIG.physicalCores) {
          const coreMask = pc.siblings.reduce((m, c) => (m | (1 << c)) >>> 0, 0);
          if ((unionMask & coreMask) !== 0) {
            coveredPhysCores += 1;
          } else {
            const coreIdle = pc.siblings.length > 0 && pc.siblings.every(c => (avgCoreC0[c] || 0) < 20.0);
            if (coreIdle) idleOutsideCores.push(pc);
          }
        }

        if (coveredPhysCores < heavyRestricted.length && idleOutsideCores.length >= 1) {
          const unionHex = formatAffinityHex(unionMask);
          const tidSummary = heavyRestricted.slice(0, 4)
            .map(t => `TID ${t.tid} (${formatAffinityHex(t.mask)}, ${t.cpuPct.toFixed(0)}%)`)
            .join(', ');
          const extraCnt = heavyRestricted.length > 4 ? ` +${heavyRestricted.length - 4} more` : '';
          const idleList = idleOutsideCores.map(c => `P${c.id}`).join(', ');
          const isSevere = coveredPhysCores <= 1 || (heavyRestricted.length - coveredPhysCores) >= 2;

          pushFinding({
            id: 'overconstrained_thread_affinity',
            category: 'OsKernelChurn',
            severity: isSevere ? 'HI' : 'MD',
            scope: '[OS / TUI]',
            confidence: 'HIGH',
            impact: isSevere ? 0.40 : 0.24,
            title: `Over-constrained thread affinity (${heavyRestricted.length} heavy threads on ${coveredPhysCores} core${coveredPhysCores === 1 ? '' : 's'}, mask ${unionHex})`,
            keyMetric: `${heavyRestricted.length}T -> ${coveredPhysCores}P (${unionHex}) | ${idleList} idle`,
            estGain: {
              kind: 'qualitative',
              label: 'Stops core starvation',
              detail: 'Qualitative: releases artificially pinned heavy threads onto idle physical cores outside their affinity mask'
            },
            why: `${heavyRestricted.length} active threads (>=45% CPU) in ${proc.name} carry restricted affinity masks (${tidSummary}${extraCnt}) whose union ${unionHex} spans only ${coveredPhysCores} physical core(s), while ${idleOutsideCores.length} physical core(s) outside that mask (${idleList}) average <20% C0.`,
            action: `Press Enter to inspect Tab 6 and widen thread masks ('a') or press 'R' (Revert All) to undo session edits. If you did not set affinity here, check external affinity managers (e.g. Process Lasso) or launcher affinity flags.`,
            cascade: `Eliminates artificial scheduler queueing and SMT sibling crowding by spreading heavy threads onto idle physical cores.`,
            quickJumpTab: 6,
            targetTid: heavyRestricted[0].tid
          });
        }
      }
    }

    // --- GROUP A RULE 14: Over-Reserved Locked 2 MiB Huge Pages Under RAM Pressure (Zero-PMC) ---
    if (proc && proc.arenas && Array.isArray(proc.arenas.hugeArenas)) {
      const totalHugeBlk = proc.arenas.hugeArenas.length * 32;
      const usedHugeBlk = proc.arenas.hugeArenas.reduce((a, g) => a + g.inuse.reduce((x, y) => x + y, 0), 0);
      const freeHugeBlk = Math.max(0, totalHugeBlk - usedHugeBlk);
      const freePct = totalHugeBlk > 0 ? (freeHugeBlk / totalHugeBlk) * 100.0 : 0.0;
      const freeHugeMiB = freeHugeBlk * 32;

      if (totalHugeBlk > 0 && freePct >= 40.0 && freeHugeMiB >= 1024 && (avgAvailPhysPct < 15.0 || avgCommitPct >= 88.0)) {
        const usedHugeMiB = usedHugeBlk * 32;
        const usedGiB = usedHugeMiB / 1024.0;
        const totalGiB = (totalHugeBlk * 32) / 1024.0;
        const recommendedHugePages = Math.ceil(usedGiB) + 1;
        const isCritical = avgAvailPhysPct < 8.0 || avgCommitPct >= 92.0;

        pushFinding({
          id: 'over_reserved_huge_pages',
          category: 'OsKernelChurn',
          severity: isCritical ? 'HI' : 'MD',
          scope: '[OS / TUI]',
          confidence: 'HIGH',
          impact: isCritical ? 0.45 : 0.25,
          title: `Over-reserved locked 2 MiB huge pages under RAM pressure (${fmtMiB(freeHugeMiB)} unused)`,
          keyMetric: `${freePct.toFixed(0)}% free (${fmtMiB(freeHugeMiB)}) | RAM ${avgAvailPhysPct.toFixed(1)}% avail`,
          estGain: {
            kind: 'qualitative',
            label: 'Reclaims locked RAM',
            detail: 'Qualitative: reclaims unused non-pageable 2 MiB huge pages before physical RAM exhaustion triggers disk paging'
          },
          why: `${proc.name} holds ${totalGiB.toFixed(0)} GiB of non-pageable locked MEM_LARGE_PAGES huge arenas, yet ${freeHugeBlk}/${totalHugeBlk} 32 MiB blocks (${fmtMiB(freeHugeMiB)}, ${freePct.toFixed(1)}% >= 40%) are unused while system available physical RAM is ${avgAvailPhysPct.toFixed(1)}% (commit ${avgCommitPct.toFixed(1)}%). Windows cannot page out locked huge arenas, increasing Rule 5 disk-paging risk.`,
          action: `Trim MIMALLOC_RESERVE_HUGE_OS_PAGES=${recommendedHugePages} (ceil(${usedGiB.toFixed(2)} GiB used) + 1 GiB headroom) to reclaim unused locked physical RAM without spilling active allocations to 4 KiB OS arenas.`,
          cascade: `Returns locked physical RAM to Windows' pageable working set and prevents hard page-fault freezes while preserving 2 MiB dTLB coverage.`,
          quickJumpTab: 4
        });
      }
    }

    // --- GROUP A RULE 15: Explicit Mutex / SRWLock Wait-Chain Bottleneck via Off-CPU ETW (Zero-PMC) ---
    const offCpuTop = profCtx ? profCtx.offCpuTop : null;
    if (proc && !gpuBound && avgC0 < 85.0 && offCpuTop) {
      const blockedPct = Number(offCpuTop.blockedPct) || 0;
      const wakes = Number(offCpuTop.wakes) || 0;
      const waitStackText = [
        offCpuTop.name,
        offCpuTop.displayName,
        offCpuTop.displayStack,
        offCpuTop.stackSummary,
        offCpuTop.signature
      ].filter(Boolean).join(' ');

      if (blockedPct >= 20.0 && wakes >= 100 && EXPLICIT_LOCK_WAIT_RE.test(waitStackText)) {
        const lockSite = offCpuTop.displayStack || offCpuTop.displayName || offCpuTop.name;
        const wakerName = offCpuTop.topWakerName || 'Unknown';
        const wakerPct = Number(offCpuTop.topWakerPct) || 0;
        const isHi = blockedPct >= 40.0;

        pushFinding({
          id: 'explicit_lock_wait_chain',
          category: 'OsKernelChurn',
          severity: isHi ? 'HI' : 'MD',
          scope: '[Code / OS]',
          confidence: 'HIGH',
          impact: isHi ? 0.42 : 0.23,
          title: `Sleeping lock contention on ${lockSite} (${blockedPct.toFixed(1)}% off-CPU, waker ${wakerName})`,
          keyMetric: `${blockedPct.toFixed(1)}% blocked (${wakes} wakes) | waker ${wakerName} (${Math.round(wakerPct)}%)`,
          estGain: {
            kind: 'qualitative',
            label: 'Lock wait-chain',
            detail: 'Qualitative: eliminates sleeping OS mutex/SRWLock serialization invisible to hardware spinlock PMCs'
          },
          why: `Off-CPU ETW CSwitch + ReadyThread pairing shows ${blockedPct.toFixed(1)}% (>=20%, ${wakes} wakes) of ${proc.name} wait time blocked inside explicit lock acquisition (${lockSite}) while CPU C0 averages ${avgC0.toFixed(1)}% (<85%) and GPU is not saturated. ${Math.round(wakerPct)}% of wakes come from ${wakerName} releasing the lock (invisible to hardware Rule 13 spinning LOCK PMCs).`,
          action: `Press Enter to inspect Tab 7 Off-CPU wait chains for ${lockSite} and reduce critical-section hold time in ${wakerName}, shard contended mutexes/SRWLocks, or switch to lock-free / reader-writer patterns.`,
          cascade: `Unblocks waiting worker threads, increases effective core utilization, and cuts synchronization tail latency.`,
          quickJumpTab: 7,
          profilerSource: 'etw_offcpu'
        });
      }
    }

    // --- GROUP A RULE 16: Sustained Uncorrelated Frame-Pacing Collapse (Zero-PMC) ---
    if (proc && !spikeCorrelatorTriggered && presentStats) {
      const curFrames = Number(presentStats.frameCount) || 0;
      const curMedianMs = Number(presentStats.medianMs) || 0;
      const presentWinSlice = Array.isArray(presentRollingWindow) ? presentRollingWindow.slice(-minSamples) : [];
      const isCollapsedPacing = s => Boolean(
        s &&
        (Number(s.frameCount) || 0) >= 120 &&
        (Number(s.medianMs) || 0) > 0 &&
        (Number(s.medianMs) || 0) <= 33.3 &&
        (Number(s.low1Ms) || 0) >= Math.max(16.7, (Number(s.medianMs) || 0) * 2.2)
      );

      if (curFrames >= 120 && curMedianMs > 0 && curMedianMs <= 33.3 && presentWinSlice.length >= minSamples) {
        const collapsedCount = presentWinSlice.filter(isCollapsedPacing).length;
        const persistFrac = collapsedCount / presentWinSlice.length;
        if (persistFrac >= 0.60) {
          const avgFps = Number.isFinite(presentStats.fps)
            ? presentStats.fps
            : (1000.0 / Math.max(0.01, Number(presentStats.avgMs) || curMedianMs));
          const low1Ms = Number(presentStats.low1Ms) || 0;
          const low1Fps = Number.isFinite(presentStats.low1Fps)
            ? presentStats.low1Fps
            : (1000.0 / Math.max(0.01, low1Ms));
          const low01Ms = Number.isFinite(presentStats.low01Ms) ? presentStats.low01Ms : null;
          const ratio = low1Ms / Math.max(0.01, curMedianMs);
          const persistPct = persistFrac * 100.0;
          const isHi = ratio >= 3.0 || low1Ms >= 33.3;

          pushFinding({
            id: 'uncorrelated_frame_pacing_collapse',
            category: 'OsKernelChurn',
            severity: isHi ? 'HI' : 'MD',
            scope: '[Code / OS]',
            confidence: 'HIGH',
            impact: isHi ? 0.38 : 0.21,
            title: `Sustained uncorrelated frame-pacing collapse (${avgFps.toFixed(0)} Avg vs ${low1Fps.toFixed(0)} FPS 1% Low)`,
            keyMetric: `1% Low ${low1Ms.toFixed(1)} ms (${ratio.toFixed(1)}x med) | ${Math.round(persistPct)}% win`,
            estGain: {
              kind: 'qualitative',
              label: '1% / 0.1% lows',
              detail: 'Qualitative: isolates persistent tail frame hitches not explained by Disk/DPC/PF/DRAM bursts'
            },
            why: `Present ETW shows active rendering (median ${curMedianMs.toFixed(1)} ms, ${avgFps.toFixed(1)} Avg FPS, ${curFrames} frames) with a persistent 1% Low collapse to ${low1Ms.toFixed(1)} ms (${low1Fps.toFixed(1)} FPS, ${ratio.toFixed(1)}x median${low01Ms !== null ? `, 0.1% Low ${low01Ms.toFixed(1)} ms` : ''}) across ${collapsedCount}/${presentWinSlice.length} (${Math.round(persistPct)}% >= 60%) of the rolling 10-sample window, with no dominant Disk/DPC/PF/DRAM burst correlation from Rule 11.`,
            action: `Average-IPC or RAM timing tweaks will not fix uncorrelated tail hitches. Inspect Tab 6 frame pacing alongside Tab 7 (Off-CPU waits, shader compilation spikes, or GC pauses) to isolate the hitch source.`,
            cascade: `Targets the true root cause of 1% and 0.1% low frame-time stutters instead of tuning steady-state average IPC.`,
            quickJumpTab: 6
          });
        }
      }
    }

    return { gpuBound, hottestCpuC0, hottestCpuTag, largePageFailureTriggered, jitResidualTriggered, spikeCorrelatorTriggered };
  }

  Object.assign(Z, { evaluateGroupARules });
})();
