// Group A Zero-PMC Win32 diagnostic rules (active in every preset incl. No-PMU)
(() => {
  'use strict';
  const Z = window.Zen2Top || (window.Zen2Top = {});
  const { CONFIG, fmtMiB } = Z;

  function evaluateGroupARules(ctx) {
    const {
      proc, hasTlb, avgC0, avgPfRate, avgTierCpi, avgCoreC0, avgSys, avgL2Itlb,
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
          impact: 0.46 + (hasTlb ? avgTierCpi.l2Itlb : 0),
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
    if (proc && hasTlb && avgL2Itlb >= 0.35 && vaMap && vaMap.imageLarge2mPct >= 75.0 && vaMap.privateJitExec4kMiB >= 8.0) {
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
    if (proc && spikeCorrelation && spikeCorrelation.totalSpikes >= 5 && spikeCorrelation.dominantSharePct >= 60.0 && spikeCorrelation.dominantCulprit) {
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

    return { gpuBound, hottestCpuC0, hottestCpuTag, largePageFailureTriggered, jitResidualTriggered };
  }

  Object.assign(Z, { evaluateGroupARules });
})();
