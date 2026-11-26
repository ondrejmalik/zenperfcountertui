// Application state, ring buffers, and formatting/math utilities
(() => {
  'use strict';
  const Z = window.Zen2Top || (window.Zen2Top = {});
  const { CONFIG, PROCESSES, BASELINE_PRESETS, deserializeBaselineJson } = Z;

  // =========================================================================
  // 3. APPLICATION STATE
  // =========================================================================
  const HISTORY_LEN = 220;

  const state = {
    activeTab: 1,
    enabledPacks: [...CONFIG.defaultPacks],
    noPmu: false,
    packPicker: {
      draftPacks: null,
      selectedIdx: 0,
      guardrailNote: ''
    },
    ccxOpen: false,
    paused: false,
    intervalSec: 1,
    sampleCount: 0,
    pmcLocked: false,
    blockerName: 'SHS-11252026-0458',
    waitingTarget: null,
    attachedPid: 14820,
    activeBaseline: deserializeBaselineJson(BASELINE_PRESETS['4K-Default']),
    isAdmin: true,
    simGpuAvailable: true,
    simEcoQosSupported: true,
    simProtectedProcess: false,
    simUprofCliAvailable: true,
    ifeoWarnedSession: false,
    pendingIfeoAction: null,
    timedCapture: null, // { remainingSec, totalSec, accum }
    pickerFilter: '',
    pickerSort: 'cpu',   // 'cpu' | 'mem' | 'name'
    pickerSelectedIdx: 0,
    modSort: 'page',     // 'page' | 'size' | 'name'
    modSelectedIdx: 0,
    advisorSelectedIdx: 0,
    threadSort: 'cpu',   // 'cpu' | 'ctxsw' | 'tid'
    threadSelectedIdx: 0,
    affinityModalTid: null,
    memShowVaMap: false,
    originalAffinityByPid: {}, // { [pid]: { [tid]: originalMask } }
    openModal: null,     // null | 'picker' | 'packs' | 'baseline' | 'help' | 'quit' | 'ifeo' | 'affinity' | 'burst'
    helpTab: 'keys',

    // Tab 7 Profiler state (Live ETW On-CPU/Off-CPU + AMDuProfCLI Burst Engine)
    profiler: {
      source: 'etw_oncpu', // 'etw_oncpu' | 'etw_offcpu' | 'burst'
      viewMode: 'flat',    // 'flat' | 'tree'
      scopeMode: 'all',    // 'all' | 'thread'
      filter: '',
      filterOpen: false,
      selectedIdx: 0,
      expandedIds: new Set(),
      sidecarLoaded: false,
      burstDurationSec: 5,
      burstCapture: null,  // { burstType, label, remainingSec, totalSec, pid, tmpDir, timerId }
      pcmPausedForBurst: false,
      lastBurstByPid: {},  // pid -> { ibs_op, dram_l3, branch_miss, tlb_walk, latest }
      etwSession: null,
      resolver: null
    },

    // Rolling 300-frame Present ETW ring + spike correlation ring + 10-sample Advisor rolling windows + cached VA map
    presentFrames: [],
    spikeRing: [],
    threadRollingWindow: [],
    presentRollingWindow: [],
    vaMapCache: null,
    vaMapTickCounter: 0,

    history: {
      ipc: [],
      topStall: [],
      dram: [],
      latNs: [],
      l2itlb: [],
      l2dtlb: [],
      pfRate: [],
      frametimeMs: [],
      dcCrossCcx: [],
      locksSerial: [],
      legacyDecodePct: [],
      opcacheHitPct: [],
      stlfInterlock: [],
      misalAccess: []
    },

    // Cumulative totals (also used for AVG columns, raw-total baseline save, and Advisor evidence gate)
    cum: {
      samples: 0,
      elapsedSec: 0,
      ipc: 0,
      actualCpi: 0,
      modeledCpi: 0,
      oooHiddenCpi: 0,
      retiringPct: 0,
      effGhz: 0,
      instPerSec: 0,
      cycPerSec: 0,
      instRaw: 0,
      aperfRaw: 0,
      mperfRaw: 0,
      retUopsRaw: 0,
      dcCrossCcxRaw: 0,
      locksSerialRaw: 0,
      decUopsRaw: 0,
      ocUopsRaw: 0,
      stlfInterlockRaw: 0,
      misalAccessRaw: 0,
      dram: 0,
      demDram: 0,
      hwpfDram: 0,
      l2pfL3: 0,
      l2pfDram: 0,
      l3Hit: 0,
      l3Miss: 0,
      l3HitPct: 0,
      latNs: 0,
      latCyc: 0,
      l2dcExcl: 0,
      l1dc: 0,
      l2dcMiss: 0,
      l2icExcl: 0,
      l1ic: 0,
      l2icMiss: 0,
      branch: 0,
      branchMissPct: 0,
      l2dtlb: 0,
      l2itlb: 0,
      l1ItlbMissPct: 0,
      pageFaultRate: 0,
      cpuUsr: 0,
      cpuSys: 0,
      avgC0Pct: 0,
      coreC0Sum: new Array(12).fill(0),
      ccxLatSum: [0, 0],
      // Group A (Zero-PMC Win32) cumulative accumulators
      gpu3dSum: 0,
      gpu3dSamples: 0,
      coreDpcSum: new Array(12).fill(0),
      coreIrqSum: new Array(12).fill(0),
      coreIrqRateSum: new Array(12).fill(0),
      hardPageReadsSum: 0,
      availPhysPctSum: 0,
      commitPctSum: 0,
      ctxSwSum: 0,
      syncWaitPctSum: 0,
      bgProcCpuSum: {},
      // Deep-Dive Zero-PMC accumulators
      readMbSSum: 0,
      writeMbSSum: 0,
      readIopsSum: 0,
      writeIopsSum: 0,
      physReadMbSSum: 0,
      physWriteMbSSum: 0,
      physReadIopsSum: 0,
      physWriteIopsSum: 0,
      diskLatMsSum: 0,
      diskEtwSamples: 0,
      fpsSum: 0,
      avgFrameMsSum: 0,
      presentSamples: 0
    },

    lastSnap: null,
    lastDiag: null
  };

  // =========================================================================
  // 4. FORMATTING & MATH UTILITIES
  // =========================================================================
  function getAttachedProcess() {
    if (state.waitingTarget || state.attachedPid === null) return null;
    return PROCESSES.find(p => p.pid === state.attachedPid) || null;
  }


  function fmtDeltaPct(live, base, higherIsBetter = false) {
    if (base === null || base === undefined || base <= 1e-6 || !isFinite(live)) {
      return '<span class="c-muted">--</span>';
    }
    const pct = ((live - base) / base) * 100.0;
    const sign = pct > 0 ? '+' : '';
    const abs = Math.abs(pct);
    if (abs < 1.5) {
      return `<span class="c-dim">${sign}${pct.toFixed(1)}%</span>`;
    }
    const good = higherIsBetter ? (pct > 0) : (pct < 0);
    const cls = good ? 'c-green' : (abs >= 12 ? 'c-red' : 'c-yellow');
    return `<span class="${cls}">${sign}${pct.toFixed(1)}%</span>`;
  }

  function fmtMiB(mib) {
    if (mib >= 1024) return `${(mib / 1024).toFixed(2)} GiB`;
    return `${mib.toFixed(1)} MiB`;
  }

  function fmtRate(val) {
    if (val >= 1e9) return `${(val / 1e9).toFixed(2)} B/s`;
    if (val >= 1e6) return `${(val / 1e6).toFixed(2)} M/s`;
    if (val >= 1e3) return `${(val / 1e3).toFixed(1)} K/s`;
    return `${val.toFixed(0)} /s`;
  }

  function fmtAddr(big) {
    return '0x' + big.toString(16).toUpperCase().padStart(14, '0');
  }

  function fmtTimeSec(s) {
    if (s >= 3600) {
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      return `${h}h ${m}m`;
    }
    return `${s.toFixed(1)} s`;
  }

  function severityClass(val, warn, bad, invert = false) {
    if (invert) {
      if (val >= warn) return 'c-green';
      if (val >= bad) return 'c-yellow';
      return 'c-red';
    }
    if (val >= bad) return 'c-red';
    if (val >= warn) return 'c-yellow';
    return 'c-green';
  }

  function retiringClass(pct) {
    if (pct >= 40.0) return 'c-green';
    if (pct < 20.0) return 'c-yellow';
    return '';
  }

  function formatRetiringTag(pct, isExact) {
    const tilde = isExact ? '' : '~';
    const cls = retiringClass(pct);
    const tip = isExact
      ? `Exact hardware retiring (ExRetUops 0x4300C1 / (6 * cycles)): ${pct.toFixed(1)}% of 6-wide Zen 2 dispatch (typical C++ ceiling ~45-60%)`
      : `Estimated retiring ((IPC * ${CONFIG.retiring.uopsPerInst.toFixed(2)}) / 6): ~${pct.toFixed(1)}% of 6-wide Zen 2 dispatch (typical C++ ceiling ~45-60%; 0 extra PMCs)`;
    return `<span class="c-dim" title="${tip}">Ret</span> <span class="${cls}" title="${tip}">${tilde}${Math.round(pct)}%</span>`;
  }

  function showToast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => el.classList.remove('show'), 2600);
  }


  function pushRing(arr, val) {
    arr.push(val);
    if (arr.length > HISTORY_LEN) arr.shift();
  }

  Object.assign(Z, { HISTORY_LEN, state, getAttachedProcess, fmtDeltaPct, fmtMiB, fmtRate, fmtAddr, fmtTimeSec, severityClass, retiringClass, formatRetiringTag, showToast, pushRing });
})();
