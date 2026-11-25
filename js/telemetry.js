// Live telemetry generator, exclusive CPI stack, and history seeding
(() => {
  'use strict';
  const Z = window.Zen2Top || (window.Zen2Top = {});
  const { CONFIG, MUX_PRESETS, SYSTEM_WIDE_PROFILE, SYSTEM_WIDE_WIN32, HISTORY_LEN, state, computeMicroArchMetrics, getAttachedProcess, pushRing } = Z;

  let noisePhase = 0;
  function jitter(base, relAmp, phaseOffset = 0) {
    const wave = Math.sin(noisePhase * 0.27 + phaseOffset) * 0.45
               + Math.sin(noisePhase * 0.71 + phaseOffset * 1.9) * 0.30
               + (Math.random() - 0.5) * 0.85;
    return Math.max(0.0, base * (1.0 + wave * relAmp));
  }

  // =========================================================================
  // 5. LIVE TELEMETRY & TWO-LINE EXCLUSIVE CPI STACK GENERATOR
  // =========================================================================
  function generateSample(commitToHistory = true) {
    noisePhase += 1;
    const proc = getAttachedProcess();
    const prof = proc ? proc.pmuProfile : SYSTEM_WIDE_PROFILE;

    const burst = Math.sin(noisePhase * 0.14) > 0.72 ? 1.12 : 1.0;

    const muxId = MUX_PRESETS[state.muxIndex].id;
    const simEffGhz = Math.min(4.40, Math.max(3.40, jitter(prof.effGhz, 0.014, 0.4)));
    const simIpc = Math.max(0.45, jitter(prof.ipc / Math.sqrt(burst), 0.052, 1.1));
    const instPerSec = simEffGhz * 1e9 * simIpc * 4.2;
    // Fixed MSRs: aperf (actual unhalted C0 cycles), mperf (nominal base clock cycles), irperf (retired instructions)
    const aperfPerSec = instPerSec / simIpc;
    const mperfPerSec = aperfPerSec / Math.max(0.1, simEffGhz / (CONFIG.baseMhz / 1000.0));
    const cycPerSec = muxId === 'uarch' ? aperfPerSec : (instPerSec / simIpc);
    const ipc = muxId === 'uarch'
      ? (instPerSec / Math.max(1.0, aperfPerSec))
      : (instPerSec / Math.max(1.0, cycPerSec));
    const actualCpi = muxId === 'uarch'
      ? (aperfPerSec / Math.max(1.0, instPerSec))
      : (cycPerSec / Math.max(1.0, instPerSec));
    const effGhz = (aperfPerSec / Math.max(1.0, mperfPerSec)) * (CONFIG.baseMhz / 1000.0);

    // Zen 2 Pipeline Retiring % (6-wide dispatch)
    const retiringExact = CONFIG.retiring.exactRetiring && muxId === 'full';
    const hwUopsRatio = jitter(1.16, 0.022, 0.8);
    const retUopsPerSec = instPerSec * hwUopsRatio;
    const rawRetPct = retiringExact
      ? (retUopsPerSec / Math.max(1.0, 6.0 * cycPerSec)) * 100.0
      : ((ipc * CONFIG.retiring.uopsPerInst) / 6.0) * 100.0;
    const retiringPct = Math.min(100.0, Math.max(0.0, rawRetPct));

    // Micro-Arch / Contention (0-Mux) raw hardware counts + derived metrics
    const dtSec = Math.max(1, state.intervalSec);
    const instDelta = instPerSec * dtSec;
    const aperfDelta = aperfPerSec * dtSec;
    const mperfDelta = mperfPerSec * dtSec;
    const disUopsDelta = instDelta * hwUopsRatio;
    const simCrossCcx = jitter((prof.dcCrossCcx ?? 0.65) * burst, 0.075, 14.1);
    const simLocks = jitter((prof.locksSerial ?? 0.22) * burst, 0.085, 14.7);
    const simOcHitPct = Math.min(99.5, Math.max(25.0, jitter(prof.opcacheHitPct ?? 81.0, 0.024, 15.2)));
    const simStlf = jitter((prof.stlfInterlock ?? 1.80) * burst, 0.07, 15.8);
    const simMisal = jitter((prof.misalAccess ?? 6.4) * burst, 0.065, 16.4);

    const uarchRawDelta = {
      inst: instDelta,
      dc_cross_ccx: (simCrossCcx / 1000.0) * instDelta,
      locks_serial: (simLocks / 1000.0) * instDelta,
      oc_uops: disUopsDelta * (simOcHitPct / 100.0),
      dec_uops: disUopsDelta * (1.0 - simOcHitPct / 100.0),
      stlf_interlock: (simStlf / 1000.0) * instDelta,
      misal_access: (simMisal / 1000.0) * instDelta
    };
    const uarchDerived = computeMicroArchMetrics(uarchRawDelta, 'uarch');
    const uarchActive = computeMicroArchMetrics(uarchRawDelta, muxId);

    // Cache & DRAM MPKIs
    const l1dc = jitter(prof.l1dc * burst, 0.055, 2.1);
    const l2dc = Math.min(l1dc * 0.85, jitter(prof.l2dc * burst, 0.065, 2.5));
    const l1ic = jitter(prof.l1ic, 0.055, 3.1);
    const l2ic = Math.min(l1ic * 0.85, jitter(prof.l2ic, 0.07, 3.6));

    const demL3 = jitter(prof.demL3 * burst, 0.065, 4.1);
    const hwpfL3 = jitter(prof.hwpfL3 * burst, 0.075, 4.4);
    const demDram = jitter(prof.demDram * burst, 0.08, 5.1);
    const hwpfDram = jitter(prof.hwpfDram * burst, 0.08, 5.5);

    const l2pfL3 = jitter(prof.l2pfL3, 0.065, 6.1);
    const l2pfDram = jitter(prof.l2pfDram * burst, 0.08, 6.5);

    const l3Acc = jitter(prof.l3Acc * burst, 0.055, 7.1);
    const l3Miss = Math.min(l3Acc * 0.72, jitter(prof.l3Miss * burst, 0.075, 7.4));
    const l3HitPct = ((l3Acc - l3Miss) / Math.max(1e-6, l3Acc)) * 100.0;
    const l3LatCyc = jitter(prof.l3LatCyc * (burst > 1 ? 1.04 : 1.0), 0.038, 8.2);
    const l3LatNs = l3LatCyc / Math.max(0.5, effGhz);

    const br = jitter(prof.br, 0.04, 9.0);
    const brMiss = jitter(prof.brMiss, 0.065, 9.4);
    const brMissPct = jitter(prof.brMissPct, 0.04, 9.7);

    // TLB MPKIs
    const l1ItlbMissPct = jitter(prof.l1ItlbMissPct, 0.06, 10.2);
    const l2Itlb = jitter(prof.l2Itlb, 0.09, 10.9);
    const l1Dtlb = jitter(prof.l1Dtlb, 0.07, 11.3);
    const l2Dtlb = jitter(prof.l2Dtlb, 0.09, 11.8);
    const l1DtlbMissPct = ((l1Dtlb + l2Dtlb) / 310.0) * 100.0;

    // OS dynamics
    const pfRate = Math.max(0, Math.round(jitter(prof.pfRate * burst, 0.16, 13.1)));
    const cpuUsr = Math.min(95, jitter(prof.cpuUsr, 0.04, 13.5));
    const cpuSys = Math.min(45, jitter(prof.cpuSys, 0.06, 13.9));

    // Exclusive tier MPKIs (strictly clamped >= 0.0)
    const dramExcl = Math.max(0.0, demDram + (muxId === 'full' ? hwpfDram : 0));
    const dramTotal = Math.max(0.0, demDram + hwpfDram);
    const l3HitExcl = Math.max(0.0, demL3 + (muxId === 'full' ? hwpfL3 : 0));
    const l3HitTotal = Math.max(0.0, demL3 + hwpfL3);
    const l2dcExcl = Math.max(0.0, l1dc - l2dc);
    const l2icExcl = Math.max(0.0, l1ic - l2ic);
    const dramLatForCpi = l3LatCyc > 0 ? l3LatCyc : CONFIG.latencies.dramFallback;

    // Ordered for Two-Line CPI Stack: Flush/FE left -> MLP Memory right
    const cpiTiers = [
      // Flush / Front-End
      { key: 'branch',   name: 'Branch',     short: 'Br',     group: 'flush', mpki: brMiss,    cpi: (brMiss / 1000) * CONFIG.latencies.branchMispredict, colorClass: 'c-magenta', barColor: 'var(--magenta)', hex: '#b380d6', avail: ['full', 'ipc-mem'] },
      { key: 'l2icExcl', name: 'L2 I-Cache', short: 'L2I',    group: 'flush', mpki: l2icExcl,  cpi: (l2icExcl / 1000) * CONFIG.latencies.l2Hit,          colorClass: 'c-blue',    barColor: 'var(--blue)',    hex: '#6b96d6', avail: ['full'] },
      { key: 'l2itlb',   name: 'L2 iTLB',    short: 'iTLB',   group: 'flush', mpki: l2Itlb,    cpi: (l2Itlb / 1000) * CONFIG.latencies.l2ItlbWalk,       colorClass: 'c-orange',  barColor: 'var(--orange)',  hex: '#d98d59', avail: ['full', 'tlb'] },
      // MLP-Overlappable Memory
      { key: 'l2dcExcl', name: 'L2 D-Cache', short: 'L2D',    group: 'mlp',   mpki: l2dcExcl,  cpi: (l2dcExcl / 1000) * CONFIG.latencies.l2Hit,          colorClass: 'c-cyan',    barColor: 'var(--cyan)',    hex: '#5fb4c9', avail: ['full'] },
      { key: 'l3Hit',    name: 'L3 Hit',     short: 'L3',     group: 'mlp',   mpki: l3HitExcl, cpi: (l3HitExcl / 1000) * CONFIG.latencies.l3Hit,         colorClass: 'c-yellow',  barColor: 'var(--yellow)',  hex: '#dfb052', avail: ['full', 'ipc-mem'] },
      { key: 'dram',     name: 'DRAM',       short: 'DRAM',   group: 'mlp',   mpki: dramExcl,  cpi: (dramExcl / 1000) * dramLatForCpi,                   colorClass: 'c-red',     barColor: 'var(--red)',     hex: '#e06464', avail: ['full', 'ipc-mem'] },
      { key: 'l2dtlb',   name: 'L2 dTLB',    short: 'dTLB',   group: 'mlp',   mpki: l2Dtlb,    cpi: (l2Dtlb / 1000) * CONFIG.latencies.l2DtlbWalk,       colorClass: 'c-green',   barColor: 'var(--green)',   hex: '#5dc27f', avail: ['full', 'tlb'] }
    ];

    // Table display order (DRAM -> L3 -> L2D -> L2I -> Branch -> dTLB -> iTLB)
    const tableOrderKeys = ['dram', 'l3Hit', 'l2dcExcl', 'l2icExcl', 'branch', 'l2dtlb', 'l2itlb'];
    const tableTiers = tableOrderKeys.map(k => cpiTiers.find(t => t.key === k));

    const activeTiers = cpiTiers.filter(t => t.avail.includes(muxId));
    const modeledCpi = activeTiers.reduce((acc, t) => acc + t.cpi, 0);
    const oooHiddenCpi = Math.max(0, modeledCpi - actualCpi);
    const topTier = [...activeTiers].sort((a, b) => b.cpi - a.cpi)[0] || cpiTiers[5];

    // Per-core C0% (mperf duty cycle) & per-core IPC
    const coreC0 = prof.coreC0.map((c, idx) => Math.min(100, Math.max(0, jitter(c, 0.055, 11 + idx * 0.35))));
    const totalC0Sum = Math.max(0.01, coreC0.reduce((a, b) => a + b, 0));
    const coreRelInstPct = coreC0.map(c => (c / totalC0Sum) * 100.0);
    const coreIpc = coreC0.map((c0, idx) => {
      if (c0 < 2.0) return 0.0;
      const ccxBias = idx < 6 ? 1.03 : 0.97;
      const smtBias = (idx % 2 === 0) ? 1.05 : 0.93;
      return Math.max(0.30, jitter(ipc * ccxBias * smtBias, 0.07, 13 + idx * 0.45));
    });
    const avgC0Pct = coreC0.reduce((a, b) => a + b, 0) / coreC0.length;

    const ccx = [0, 1].map(id => {
      const sliceC0 = coreC0.slice(id * 6, id * 6 + 6);
      const sliceIpc = coreIpc.slice(id * 6, id * 6 + 6);
      const wSum = sliceC0.reduce((a, b) => a + b, 0);
      const wIpc = wSum > 0.1
        ? sliceC0.reduce((acc, c0, k) => acc + c0 * sliceIpc[k], 0) / wSum
        : ipc;
      const hitPct = Math.min(99.2, Math.max(40, l3HitPct + (id === 0 ? 1.4 : -1.5)));
      const latNs = l3LatNs * (id === 0 ? 0.97 : 1.04);
      const dramM = dramTotal * (id === 0 ? 0.95 : 1.06);
      return {
        id,
        cpus: id === 0 ? '0-5' : '6-11',
        ipc: wIpc,
        ghz: effGhz + (id === 0 ? 0.02 : -0.02),
        l3HitPct: hitPct,
        latNs,
        dramMpki: dramM,
        avgC0: wSum / 6.0
      };
    });

    if (proc && commitToHistory) {
      proc.pageFaults += Math.round(pfRate * state.intervalSec);
      proc.userSec += (cpuUsr / 100.0) * 6.0 * state.intervalSec;
      proc.sysSec += (cpuSys / 100.0) * 6.0 * state.intervalSec;
      proc.elapsedSec += state.intervalSec;
      if (proc.arenas && proc.arenas.hugeArenas.length > 0 && Math.random() < 0.30) {
        const lastGb = proc.arenas.hugeArenas[proc.arenas.hugeArenas.length - 1];
        const act = lastGb.inuse.reduce((a, b) => a + b, 0);
        const next = Math.max(8, Math.min(30, act + (Math.random() < 0.5 ? 1 : -1)));
        for (let b = 0; b < 32; b++) {
          lastGb.inuse[b] = b < next ? 1 : 0;
          if (b < next) lastGb.touched[b] = 1;
        }
      }
    }

    // Group A (Zero-PMC Win32) non-blocking background collector snapshot
    const w32 = (proc && proc.win32Profile) ? proc.win32Profile : SYSTEM_WIDE_WIN32;
    const gpu3dPct = state.simGpuAvailable
      ? Math.min(100.0, Math.max(0.0, jitter(w32.gpu3dPct, 0.015, 17.1)))
      : null;
    const gpuProc3dPct = (state.simGpuAvailable && proc)
      ? Math.min(gpu3dPct, Math.max(0.0, jitter(w32.gpuProc3dPct ?? w32.gpu3dPct, 0.02, 17.5)))
      : null;
    const coreDpcPct = w32.coreDpcPct.map((d, idx) => Math.min(100.0, Math.max(0.0, jitter(d, 0.08, 18 + idx * 0.4))));
    const coreIrqPct = w32.coreIrqPct.map((q, idx) => Math.min(100.0, Math.max(0.0, jitter(q, 0.08, 19 + idx * 0.4))));
    const coreIrqPerSec = w32.coreIrqPerSec.map((r, idx) => Math.max(0, Math.round(jitter(r, 0.09, 20 + idx * 0.3))));
    const noisyNeighbors = (w32.noisyNeighbors || []).map((bg, idx) => {
      const sysCpuPct = Math.min(100.0, Math.max(0.0, jitter(bg.sysCpuPct, 0.07, 21 + idx * 0.7)));
      return {
        name: bg.name,
        pid: bg.pid,
        sysCpuPct,
        singleCorePct: sysCpuPct * CONFIG.logicalCpus
      };
    });
    const ctxSwPerSec = proc ? Math.max(0, Math.round(jitter(w32.ctxSwPerSec, 0.06, 22.1))) : 0;
    const syncWaitPct = proc ? Math.min(100.0, Math.max(0.0, jitter(w32.syncWaitPct, 0.05, 22.6))) : 0;
    const topWaitReason = w32.topWaitReason || 'WrQueue';
    const priorityClass = proc ? (w32.priorityClass || 'NORMAL') : 'NORMAL';
    const ecoQos = !proc
      ? 'Inactive'
      : (state.simEcoQosSupported ? (w32.ecoQos || 'Inactive') : 'Unknown');
    const hardPageReadsPerSec = w32.hardPageReadsPerSec <= 0.01
      ? 0.0
      : Math.max(0.0, jitter(w32.hardPageReadsPerSec, 0.12, 23.2));
    const availPhysPct = Math.min(99.0, Math.max(0.5, jitter(w32.availPhysPct, 0.03, 23.8)));
    const commitPct = Math.min(99.5, Math.max(5.0, jitter(w32.commitPct, 0.02, 24.3)));
    const seLockMemoryPrivilege = w32.seLockMemoryPrivilege || 'Present';

    const snap = {
      effGhz, ipc, actualCpi, instPerSec, cycPerSec, aperfPerSec, mperfPerSec,
      retiringPct, retiringExact, retUopsPerSec,
      uarch: uarchActive, uarchRawDelta,
      l1dc, l2dc, l1ic, l2ic, l2dcExcl, l2icExcl,
      demL3, hwpfL3, demDram, hwpfDram, l2pfL3, l2pfDram,
      dramTotal, l3HitTotal,
      l3Acc, l3Miss, l3HitPct, l3LatCyc, l3LatNs,
      br, brMiss, brMissPct,
      l1ItlbMissPct, l2Itlb, l1Dtlb, l2Dtlb, l1DtlbMissPct,
      cpiTiers, tableTiers, activeTiers, modeledCpi, oooHiddenCpi, topTier,
      coreC0, coreRelInstPct, coreIpc, avgC0Pct, ccx,
      pfRate, cpuUsr, cpuSys,
      gpu3dPct, gpuProc3dPct, coreDpcPct, coreIrqPct, coreIrqPerSec,
      noisyNeighbors, ctxSwPerSec, syncWaitPct, topWaitReason,
      priorityClass, ecoQos, hardPageReadsPerSec, availPhysPct, commitPct,
      seLockMemoryPrivilege
    };

    if (commitToHistory) {
      state.sampleCount += 1;
      state.cum.samples += 1;
      state.cum.elapsedSec += state.intervalSec;
      state.cum.ipc += ipc;
      state.cum.actualCpi += actualCpi;
      state.cum.modeledCpi += modeledCpi;
      state.cum.oooHiddenCpi += oooHiddenCpi;
      state.cum.retiringPct += retiringPct;
      state.cum.effGhz += effGhz;
      state.cum.instPerSec += instPerSec;
      state.cum.cycPerSec += cycPerSec;
      state.cum.instRaw += instDelta;
      state.cum.aperfRaw += aperfDelta;
      state.cum.mperfRaw += mperfDelta;
      state.cum.dcCrossCcxRaw += uarchRawDelta.dc_cross_ccx;
      state.cum.locksSerialRaw += uarchRawDelta.locks_serial;
      state.cum.decUopsRaw += uarchRawDelta.dec_uops;
      state.cum.ocUopsRaw += uarchRawDelta.oc_uops;
      state.cum.stlfInterlockRaw += uarchRawDelta.stlf_interlock;
      state.cum.misalAccessRaw += uarchRawDelta.misal_access;
      state.cum.dram += dramTotal;
      state.cum.demDram += demDram;
      state.cum.hwpfDram += hwpfDram;
      state.cum.l2pfL3 += l2pfL3;
      state.cum.l2pfDram += l2pfDram;
      state.cum.l3Hit += l3HitTotal;
      state.cum.l3Miss += l3Miss;
      state.cum.l3HitPct += l3HitPct;
      state.cum.latNs += l3LatNs;
      state.cum.latCyc += l3LatCyc;
      state.cum.l2dcExcl += l2dcExcl;
      state.cum.l1dc += l1dc;
      state.cum.l2dcMiss += l2dc;
      state.cum.l2icExcl += l2icExcl;
      state.cum.l1ic += l1ic;
      state.cum.l2icMiss += l2ic;
      state.cum.branch += brMiss;
      state.cum.branchMissPct += brMissPct;
      state.cum.l2dtlb += l2Dtlb;
      state.cum.l2itlb += l2Itlb;
      state.cum.l1ItlbMissPct += l1ItlbMissPct;
      state.cum.pageFaultRate += pfRate;
      state.cum.cpuUsr += cpuUsr;
      state.cum.cpuSys += cpuSys;
      state.cum.avgC0Pct += avgC0Pct;
      for (let i = 0; i < 12; i++) {
        state.cum.coreC0Sum[i] += coreC0[i];
        state.cum.coreDpcSum[i] += coreDpcPct[i];
        state.cum.coreIrqSum[i] += coreIrqPct[i];
        state.cum.coreIrqRateSum[i] += coreIrqPerSec[i];
      }
      state.cum.ccxLatSum[0] += ccx[0].latNs;
      state.cum.ccxLatSum[1] += ccx[1].latNs;

      if (gpu3dPct !== null) {
        state.cum.gpu3dSum += gpu3dPct;
        state.cum.gpu3dSamples += 1;
      }
      state.cum.hardPageReadsSum += hardPageReadsPerSec;
      state.cum.availPhysPctSum += availPhysPct;
      state.cum.commitPctSum += commitPct;
      state.cum.ctxSwSum += ctxSwPerSec;
      state.cum.syncWaitPctSum += syncWaitPct;
      for (const bg of noisyNeighbors) {
        const key = `${bg.name}|${bg.pid}`;
        if (!state.cum.bgProcCpuSum[key]) {
          state.cum.bgProcCpuSum[key] = { name: bg.name, pid: bg.pid, sysCpuSum: 0 };
        }
        state.cum.bgProcCpuSum[key].sysCpuSum += bg.sysCpuPct;
      }

      pushRing(state.history.ipc, ipc);
      pushRing(state.history.topStall, topTier.mpki);
      pushRing(state.history.dram, dramTotal);
      pushRing(state.history.latNs, l3LatNs);
      pushRing(state.history.l2itlb, l2Itlb);
      pushRing(state.history.l2dtlb, l2Dtlb);
      pushRing(state.history.pfRate, pfRate);
      pushRing(state.history.dcCrossCcx, uarchDerived.dcCrossCcxMpki);
      pushRing(state.history.locksSerial, uarchDerived.locksSerialMpki);
      pushRing(state.history.legacyDecodePct, uarchDerived.legacyDecodePct);
      pushRing(state.history.opcacheHitPct, uarchDerived.opcacheHitPct);
      pushRing(state.history.stlfInterlock, uarchDerived.stlfInterlockMpki);
      pushRing(state.history.misalAccess, uarchDerived.misalAccessMpki);

      // Timed capture accumulation
      if (state.timedCapture) {
        const tc = state.timedCapture;
        tc.samples += 1;
        tc.elapsedSec += state.intervalSec;
        tc.ipc += ipc;
        tc.instRaw += instDelta;
        tc.aperfRaw += aperfDelta;
        tc.mperfRaw += mperfDelta;
        tc.dcCrossCcxRaw += uarchRawDelta.dc_cross_ccx;
        tc.locksSerialRaw += uarchRawDelta.locks_serial;
        tc.decUopsRaw += uarchRawDelta.dec_uops;
        tc.ocUopsRaw += uarchRawDelta.oc_uops;
        tc.stlfInterlockRaw += uarchRawDelta.stlf_interlock;
        tc.misalAccessRaw += uarchRawDelta.misal_access;
        tc.dram += dramTotal;
        tc.l3Hit += l3HitTotal;
        tc.l2dcExcl += l2dcExcl;
        tc.l2icExcl += l2icExcl;
        tc.branch += brMiss;
        tc.l2dtlb += l2Dtlb;
        tc.l2itlb += l2Itlb;
        tc.l3Miss += l3Miss;
        tc.latNs += l3LatNs;
        tc.l1ic += l1ic;
        tc.l2ic += l2ic;
        tc.l1dc += l1dc;
        tc.l2dc += l2dc;
        tc.l2pfL3 += l2pfL3;
        tc.l2pfDram += l2pfDram;
        tc.remainingSec -= state.intervalSec;
        if (tc.remainingSec <= 0) {
          Z.finishTimedCapture();
        }
      }
    }

    state.lastSnap = snap;
    state.lastDiag = Z.evaluateDiagnostics();
    return snap;
  }


  function resetHistoryAndSeed(count = 160) {
    for (const k of Object.keys(state.history)) state.history[k] = [];
    for (const k of Object.keys(state.cum)) {
      if (Array.isArray(state.cum[k])) state.cum[k] = state.cum[k].map(() => 0);
      else if (state.cum[k] && typeof state.cum[k] === 'object') state.cum[k] = {};
      else state.cum[k] = 0;
    }
    state.sampleCount = 0;
    for (let i = 0; i < count; i++) {
      generateSample(true);
    }
  }

  Object.assign(Z, { generateSample, resetHistoryAndSeed });
})();
