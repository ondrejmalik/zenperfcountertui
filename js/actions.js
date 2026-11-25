// User actions, IFEO guardrails, hardware calibration, timed capture, and self-test runner
(() => {
  'use strict';
  const Z = window.Zen2Top || (window.Zen2Top = {});
  const {
    CONFIG, MetricPack, QUICK_PRESETS, state, computeMicroArchMetrics, deserializeBaselineJson,
    getActivePlan, getPresetBySlug, normalizePackList, packsEqual, buildUprofMetrics, saveDefaultPacksToConfig,
    getAttachedProcess, showToast, generateSample, resetHistoryAndSeed,
    evaluateDiagnostics, runGroupADiagnosticTests, renderAll,
    getCcxMask, getPrimaryPhysicalCoresMask, formatAffinityHex,
    applyThreadAffinityEdit, revertAllThreadAffinities,
    EtwProfilerSession, getBurstProfile, locateUprofCli, parseUprofBurstReportCsv,
    PROCESS_THREADS, buildResolverForProcess, getEtwTemplatesForPid,
    generateBurstCsvForProcess, getSidecarForPid
  } = Z;

  // =========================================================================
  // 8. ACTIONS, IFEO GUARDRAILS, CALIBRATION & TIMED CAPTURE
  // =========================================================================
  function switchTab(t) {
    state.activeTab = t;
    renderAll();
  }

  function jumpToFindingTab(finding) {
    if (!finding || !finding.quickJumpTab) return;
    if (finding.openCcx) state.ccxOpen = true;
    switchTab(finding.quickJumpTab);
    showToast(`Jumped to Tab ${finding.quickJumpTab} (${finding.id})`);
  }

  function attachProcess(pid) {
    cancelHardwareBurst(true);
    state.waitingTarget = null;
    state.attachedPid = pid;
    state.advisorSelectedIdx = 0;
    state.modSelectedIdx = 0;
    state.threadSelectedIdx = 0;
    state.affinityModalTid = null;
    state.profiler.selectedIdx = 0;
    state.profiler.expandedIds = new Set();
    state.profiler.scopeMode = 'all';
    if (state.profiler.source === 'burst') state.profiler.source = 'etw_oncpu';
    resetHistoryAndSeed(160);
    const p = getAttachedProcess();
    if (p) showToast(`Attached to ${p.name} (PID ${p.pid})`);
    renderAll();
  }

  function detachProcess() {
    cancelHardwareBurst(true);
    if (state.profiler.etwSession) {
      state.profiler.etwSession.stop();
      state.profiler.etwSession.attach(null, null);
    }
    state.profiler.resolver = null;
    state.waitingTarget = null;
    state.attachedPid = null;
    resetHistoryAndSeed(160);
    showToast('Detached to System-Wide PMU mode (ETW stopped)');
    renderAll();
  }

  function startWaitingMode() {
    state.attachedPid = null;
    state.waitingTarget = 'deadlock.exe';
    closeModal(false);
    resetHistoryAndSeed(160);
    showToast('Waiting for deadlock.exe (streaming system-wide PMU)');
    renderAll();
  }

  function openPackPickerModal() {
    state.packPicker.draftPacks = [...state.enabledPacks];
    state.packPicker.guardrailNote = '';
    openModal('packs');
  }

  function toggleDraftPack(packId) {
    if (!state.packPicker.draftPacks) {
      state.packPicker.draftPacks = [...state.enabledPacks];
    }
    const cur = state.packPicker.draftPacks;
    const has = cur.includes(packId);
    if (has && cur.length <= 1) {
      state.packPicker.guardrailNote = 'Guardrail: AMDuProfPcm requires >= 1 Core PMC pack alongside fixed MSRs.';
      renderAll();
      return false;
    }
    state.packPicker.guardrailNote = '';
    if (has) {
      state.packPicker.draftPacks = cur.filter(id => id !== packId);
    } else {
      state.packPicker.draftPacks = normalizePackList([...cur, packId]);
    }
    renderAll();
    return true;
  }

  function selectDraftPreset(slugOrKey) {
    const preset = QUICK_PRESETS.find(p => p.slug === slugOrKey || p.key === String(slugOrKey));
    if (!preset) return false;
    state.packPicker.draftPacks = [...preset.packs];
    state.packPicker.guardrailNote = '';
    renderAll();
    return true;
  }

  function applyDraftPacks() {
    const draft = normalizePackList(state.packPicker.draftPacks || state.enabledPacks);
    if (draft.length === 0) {
      state.packPicker.guardrailNote = 'Guardrail: AMDuProfPcm requires >= 1 Core PMC pack alongside fixed MSRs.';
      renderAll();
      return false;
    }
    state.enabledPacks = draft;
    state.noPmu = false;
    state.packPicker.guardrailNote = '';
    const plan = buildUprofMetrics(draft);
    generateSample(false);
    closeModal(false);
    const padNote = plan.autoPaddedRetiring ? ' (+auto-pad ExactRetiring)' : '';
    showToast(`PMU restarted: ${plan.label} (${plan.coreSlots} Core PMCs${padNote})`);
    renderAll();
    return true;
  }

  function saveDraftPacksAsDefault() {
    const draft = normalizePackList(state.packPicker.draftPacks || state.enabledPacks);
    if (draft.length === 0) {
      state.packPicker.guardrailNote = 'Guardrail: select >= 1 Core PMC pack before saving defaults.';
      renderAll();
      return false;
    }
    saveDefaultPacksToConfig(draft);
    const plan = buildUprofMetrics(draft);
    showToast(`Saved default_packs to config.toml (${plan.label}, ${draft.length} packs)`);
    renderAll();
    return true;
  }

  function fastCyclePreset() {
    state.noPmu = false;
    const curIdx = QUICK_PRESETS.findIndex(p => packsEqual(state.enabledPacks, p.packs));
    const next = QUICK_PRESETS[(curIdx + 1) % QUICK_PRESETS.length];
    state.enabledPacks = [...next.packs];
    const plan = buildUprofMetrics(state.enabledPacks);
    generateSample(false);
    showToast(`Quick preset: ${plan.label} (${plan.coreSlots}/${plan.capacitySlots} Core PMCs)`);
    renderAll();
  }

  function toggleExactRetiringPack() {
    if (state.noPmu) {
      showToast('No-PMU mode active; enable PMU packs first (m)');
      return;
    }
    const has = state.enabledPacks.includes(MetricPack.ExactRetiring);
    if (has && state.enabledPacks.length <= 1) {
      showToast('Guardrail: cannot uncheck the final Core PMC pack');
      return;
    }
    state.enabledPacks = has
      ? state.enabledPacks.filter(id => id !== MetricPack.ExactRetiring)
      : normalizePackList([...state.enabledPacks, MetricPack.ExactRetiring]);
    const plan = getActivePlan();
    generateSample(false);
    const status = plan.autoPaddedRetiring
      ? 'ExactRetiring auto-padded (+0 mux cost)'
      : (plan.has(MetricPack.ExactRetiring) ? `ExactRetiring ON (${plan.label})` : `ExactRetiring OFF (${plan.label})`);
    showToast(status);
    renderAll();
  }

  function toggleNoPmuMode() {
    state.noPmu = !state.noPmu;
    generateSample(false);
    showToast(state.noPmu ? 'No-PMU mode ON (Win32-only diagnostics)' : `PMU active: ${getActivePlan().label}`);
    renderAll();
  }

  function cycleMux() {
    fastCyclePreset();
  }

  function cycleInterval() {
    const seq = [1, 2, 5];
    state.intervalSec = seq[(seq.indexOf(state.intervalSec) + 1) % seq.length];
    Z.restartTimer();
    renderAll();
  }

  function togglePause() {
    state.paused = !state.paused;
    renderAll();
  }

  function unlockPmc() {
    state.pmcLocked = false;
    showToast(`Stopped ${state.blockerName} via logman -ets -> PMCs unlocked`);
    renderAll();
  }

  function buildBaselinePayload(name, target, elapsedSec, samples, ifeoEnabled, acc, plan) {
    const n = Math.max(1, samples);
    const uarchRaw = {
      inst: acc.instRaw,
      dc_cross_ccx: acc.dcCrossCcxRaw,
      locks_serial: acc.locksSerialRaw,
      dec_uops: acc.decUopsRaw,
      oc_uops: acc.ocUopsRaw,
      stlf_interlock: acc.stlfInterlockRaw,
      misal_access: acc.misalAccessRaw
    };
    const uarchMetrics = computeMicroArchMetrics(uarchRaw, plan);
    const hasFree = !plan.noPmu;
    const avgIpc = hasFree ? (acc.ipc / n) : null;
    const avgCpi = hasFree ? ((acc.actualCpi !== undefined ? acc.actualCpi / n : 1.0 / Math.max(0.01, avgIpc))) : null;

    return deserializeBaselineJson({
      name,
      muxPreset: plan.presetSlug,
      enabled_packs: [...plan.selectedPacks],
      core_pmc_slots: plan.coreSlots,
      mux_groups: plan.muxGroups,
      target,
      elapsedSec,
      samples: n,
      ifeoEnabled,
      ipc: avgIpc,
      cpi: avgCpi,
      fps: acc.presentSamples > 0 ? acc.fpsSum / acc.presentSamples : null,
      avgFrameMs: acc.presentSamples > 0 ? acc.avgFrameMsSum / acc.presentSamples : null,
      dramMpki: plan.has(MetricPack.DcDemand) ? (acc.dram / n) : null,
      l3HitMpki: plan.has(MetricPack.DcDemand) ? (acc.l3Hit / n) : null,
      l2dcExclMpki: plan.has(MetricPack.L1L2Dc) ? (acc.l2dcExcl / n) : null,
      l1dcMpki: plan.has(MetricPack.L1L2Dc) ? (acc.l1dc / n) : null,
      l2dcMpki: plan.has(MetricPack.L1L2Dc) ? (acc.l2dc / n) : null,
      l2icExclMpki: plan.has(MetricPack.L1L2Ic) ? (acc.l2icExcl / n) : null,
      l1icMpki: plan.has(MetricPack.L1L2Ic) ? (acc.l1ic / n) : null,
      l2icMpki: plan.has(MetricPack.L1L2Ic) ? (acc.l2ic / n) : null,
      l2pfL3Mpki: plan.has(MetricPack.L2Hwpf) ? (acc.l2pfL3 / n) : null,
      l2pfDramMpki: plan.has(MetricPack.L2Hwpf) ? (acc.l2pfDram / n) : null,
      branchMpki: plan.has(MetricPack.Branches) ? (acc.branch / n) : null,
      l2dtlbMpki: plan.has(MetricPack.DtlbFull) ? (acc.l2dtlb / n) : null,
      l2itlbMpki: plan.has(MetricPack.ItlbFull) ? (acc.l2itlb / n) : null,
      l3MissMpki: hasFree ? (acc.l3Miss / n) : null,
      l3LatNs: hasFree ? (acc.latNs / n) : null,
      dcCrossCcxMpki: uarchMetrics ? uarchMetrics.dcCrossCcxMpki : null,
      locksSerialMpki: uarchMetrics ? uarchMetrics.locksSerialMpki : null,
      opcacheHitPct: uarchMetrics ? uarchMetrics.opcacheHitPct : null,
      legacyDecodePct: uarchMetrics ? uarchMetrics.legacyDecodePct : null,
      stlfInterlockMpki: uarchMetrics ? uarchMetrics.stlfInterlockMpki : null,
      misalAccessMpki: uarchMetrics ? uarchMetrics.misalAccessMpki : null,
      cumulative_totals: {
        inst: hasFree ? acc.instRaw : 0,
        cycles: 0,
        aperf: hasFree ? acc.aperfRaw : 0,
        mperf: hasFree ? acc.mperfRaw : 0,
        dc_cross_ccx: plan.has(MetricPack.CrossCcxLocks) ? acc.dcCrossCcxRaw : 0,
        locks_serial: plan.has(MetricPack.CrossCcxLocks) ? acc.locksSerialRaw : 0,
        dec_uops: plan.has(MetricPack.OpCacheDecode) ? acc.decUopsRaw : 0,
        oc_uops: plan.has(MetricPack.OpCacheDecode) ? acc.ocUopsRaw : 0,
        stlf_interlock: plan.has(MetricPack.StlfSplits) ? acc.stlfInterlockRaw : 0,
        misal_access: plan.has(MetricPack.StlfSplits) ? acc.misalAccessRaw : 0
      }
    });
  }

  function captureBaseline() {
    const n = Math.max(1, state.cum.samples);
    const proc = getAttachedProcess();
    const plan = getActivePlan();
    const slug = proc ? `${proc.name.replace('.exe', '')}_${plan.presetSlug}` : `sys_${plan.presetSlug}`;
    state.activeBaseline = buildBaselinePayload(
      `${slug}_${n}s.json`,
      proc ? proc.name : 'SYSTEM-WIDE',
      state.cum.elapsedSec,
      n,
      proc ? proc.ifeoEnabled : false,
      { ...state.cum, l2ic: state.cum.l2icMiss, l2dc: state.cum.l2dcMiss },
      plan
    );
    state.lastDiag = evaluateDiagnostics();
    showToast(`Pinned baseline: ${state.activeBaseline.name} (${plan.muxShort}, ${n} samples)`);
    renderAll();
  }

  function startTimedCapture(seconds = 15) {
    if (state.timedCapture) {
      state.timedCapture = null;
      showToast('Cancelled timed baseline capture');
      renderAll();
      return;
    }
    state.timedCapture = {
      remainingSec: seconds,
      totalSec: seconds,
      samples: 0, elapsedSec: 0,
      ipc: 0, instRaw: 0, aperfRaw: 0, mperfRaw: 0,
      dcCrossCcxRaw: 0, locksSerialRaw: 0, decUopsRaw: 0,
      ocUopsRaw: 0, stlfInterlockRaw: 0, misalAccessRaw: 0,
      dram: 0, l3Hit: 0, l2dcExcl: 0, l2icExcl: 0,
      branch: 0, l2dtlb: 0, l2itlb: 0, l3Miss: 0, latNs: 0,
      l1ic: 0, l2ic: 0, l1dc: 0, l2dc: 0, l2pfL3: 0, l2pfDram: 0
    };
    if (state.paused) state.paused = false;
    closeModal(false);
    showToast(`Started ${seconds}s timed baseline capture...`);
    renderAll();
  }

  function finishTimedCapture() {
    const tc = state.timedCapture;
    if (!tc) return;
    const proc = getAttachedProcess();
    const plan = getActivePlan();
    state.activeBaseline = buildBaselinePayload(
      `${proc ? proc.name.replace('.exe', '') : 'sys'}_cap${tc.totalSec}s.json`,
      proc ? proc.name : 'SYSTEM-WIDE',
      tc.elapsedSec,
      tc.samples,
      proc ? proc.ifeoEnabled : false,
      tc,
      plan
    );
    state.timedCapture = null;
    showToast(`Timed capture complete -> pinned ${state.activeBaseline.name} (${plan.muxShort})`);
  }

  function startCalibration() {
    const out = document.getElementById('calibrate-output');
    out.style.display = 'block';
    out.innerHTML = `<pre class="code-block c-cyan">Running ~1s pointer-chase (16K L1, 256K L2, 8M L3, 128M DRAM) + 50/50 branch probe...</pre>`;
    setTimeout(() => {
      CONFIG.latencies.l1Hit = 4.0;
      CONFIG.latencies.l2Hit = 12.1;
      CONFIG.latencies.l3Hit = 38.8;
      CONFIG.latencies.branchMispredict = 16.9;
      CONFIG.latencies.dramFallback = 236.0;
      CONFIG.calibrated = true;
      generateSample(false);
      out.innerHTML = `<pre class="code-block c-green">Calibration complete -> wrote config.toml (calibrated = true):
  L1 = 4.0 cyc | L2 = 12.1 cyc | L3 = 38.8 cyc | Branch = 16.9 cyc
  Unloaded DRAM = 236.0 cyc (~56.2 ns @ 4.20 GHz)</pre>`;
      showToast('Host latencies calibrated & saved to config.toml');
      renderAll();
    }, 650);
  }

  function requestIfeoToggle(mod) {
    const proc = getAttachedProcess();
    if (!proc) return;
    if (!state.isAdmin) {
      showToast('[Admin required to edit IFEO] Run elevated (or press b -> a in prototype)');
      return;
    }
    const isMaster = mod === null;
    const needsConfirm = !state.ifeoWarnedSession || (mod && mod.protectedDriver);
    if (!needsConfirm) {
      applyIfeoToggle(proc, mod);
      return;
    }
    state.pendingIfeoAction = { proc, mod };
    const titleEl = document.getElementById('ifeo-modal-title');
    const bodyEl = document.getElementById('ifeo-modal-body');
    if (mod && mod.protectedDriver) {
      titleEl.textContent = `Protected OS / GPU Driver DLL Warning (${mod.name})`;
      bodyEl.innerHTML = `
        <p><span class="c-red c-bright">${mod.name}</span> is a core OS or GPU driver module. Forcing 2 MiB IFEO large pages on system/driver DLLs can destabilize rendering or fail anti-cheat integrity checks.</p>
        <p class="c-dim">Proceed only in offline / -insecure testing environments with Administrator privileges.</p>
      `;
    } else {
      titleEl.textContent = isMaster
        ? `Toggle IFEO Master UseLargePages for ${proc.name}`
        : `Toggle IFEO LargePageDLLs Entry: ${mod.name}`;
      bodyEl.innerHTML = `
        <p>Modifying <span class="c-bright">HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\${proc.name}</span> requires Administrator privileges and takes effect after restarting the target process.</p>
        <p class="c-yellow">Anti-Cheat Notice: Use -insecure / offline benchmarks only for games protected by VAC or kernel anti-cheat.</p>
      `;
    }
    openModal('ifeo');
  }

  function applyIfeoToggle(proc, mod) {
    state.ifeoWarnedSession = true;
    if (mod === null) {
      proc.ifeoEnabled = !proc.ifeoEnabled;
      proc.ifeoMasterSessionToggled = true;
      showToast(`IFEO UseLargePages=${proc.ifeoEnabled ? 1 : 0} for ${proc.name} (restart target to apply)`);
    } else {
      mod.ifeo = !mod.ifeo;
      mod.sessionToggled = true;
      showToast(`IFEO ${mod.name}=${mod.ifeo ? 1 : 0} (pending restart)`);
    }
    state.lastDiag = evaluateDiagnostics();
    closeModal(false);
    renderAll();
  }

  function openModal(name) {
    closeModal(false);
    state.openModal = name;
    const el = document.getElementById(`modal-${name}`);
    if (el) el.classList.add('open');
    renderAll();
    if (name === 'picker') {
      const inp = document.getElementById('modal-picker-input');
      if (inp) {
        inp.value = state.pickerFilter;
        setTimeout(() => inp.focus(), 10);
      }
    }
  }

  function closeModal(rerender = true) {
    state.openModal = null;
    state.pendingIfeoAction = null;
    state.affinityModalTid = null;
    document.querySelectorAll('.modal-backdrop').forEach(m => m.classList.remove('open'));
    if (rerender) renderAll();
  }

  function cyclePickerSort() {
    const order = ['cpu', 'mem', 'name'];
    state.pickerSort = order[(order.indexOf(state.pickerSort) + 1) % order.length];
    renderAll();
  }

  function cycleModSort() {
    const order = ['page', 'size', 'name'];
    state.modSort = order[(order.indexOf(state.modSort) + 1) % order.length];
    renderAll();
  }

  function cycleThreadSort() {
    const order = ['cpu', 'ctxsw', 'tid'];
    state.threadSort = order[(order.indexOf(state.threadSort) + 1) % order.length];
    renderAll();
  }

  function toggleVaMapView() {
    state.memShowVaMap = !state.memShowVaMap;
    renderAll();
  }

  function toggleProtectedProcess() {
    const p = getAttachedProcess();
    if (p) {
      p.protectedProcess = !p.protectedProcess;
      showToast(`${p.name} Protected Process: ${p.protectedProcess ? 'ON (ERROR_ACCESS_DENIED)' : 'OFF (Editable)'}`);
    } else {
      state.simProtectedProcess = !state.simProtectedProcess;
      showToast(`Global Protected Process Simulation: ${state.simProtectedProcess ? 'ON' : 'OFF'}`);
    }
    renderAll();
  }

  function openAffinityModal(tid = null) {
    const proc = getAttachedProcess();
    if (!proc || !Array.isArray(proc.threads) || proc.threads.length === 0) {
      showToast('Attach a process with active threads first');
      return;
    }
    let targetTid = tid;
    if (!targetTid) {
      const sorted = Z.getSortedThreads(state.lastSnap, proc);
      const sel = sorted[state.threadSelectedIdx];
      if (!sel) return;
      targetTid = sel.tid;
    }
    state.affinityModalTid = targetTid;
    openModal('affinity');
    const hexEl = document.getElementById('affinity-hex-input');
    const thread = proc.threads.find(t => t.tid === targetTid);
    if (hexEl && thread) {
      hexEl.value = formatAffinityHex(thread.affinityMask);
    }
  }

  function applyAffinityPreset(preset) {
    const proc = getAttachedProcess();
    if (!proc || !state.affinityModalTid) return;
    const thread = (proc.threads || []).find(t => t.tid === state.affinityModalTid);
    if (!thread) return;

    if (!state.originalAffinityByPid[proc.pid]) {
      state.originalAffinityByPid[proc.pid] = {};
    }
    const origMap = state.originalAffinityByPid[proc.pid];
    const accessDenied = Boolean(proc.protectedProcess || state.simProtectedProcess);

    let newMask = 0;
    let excludeSiblingFromOthers = false;
    let label = '';

    if (preset === 'ccx0') {
      newMask = getCcxMask(0, CONFIG.physicalCores);
      label = 'CCX0 (0x003F)';
    } else if (preset === 'ccx1') {
      newMask = getCcxMask(1, CONFIG.physicalCores);
      label = 'CCX1 (0x0FC0)';
    } else if (preset === 'phys') {
      newMask = getPrimaryPhysicalCoresMask(CONFIG.physicalCores);
      label = `Physical Cores (${formatAffinityHex(newMask)})`;
    } else if (preset === 'single-phys') {
      const pc = CONFIG.physicalCores.find(p => p.siblings.includes(thread.currentCpu)) || CONFIG.physicalCores[0];
      const s0 = pc.siblings[0];
      newMask = (1 << s0) >>> 0;
      excludeSiblingFromOthers = true;
      label = `Single Core C${String(s0).padStart(2, '0')} (${formatAffinityHex(newMask)})`;
    } else {
      return;
    }

    const res = applyThreadAffinityEdit(proc, thread.tid, newMask, origMap, {
      accessDenied,
      excludeSiblingFromOthers,
      logicalCpus: CONFIG.logicalCpus,
      physicalCores: CONFIG.physicalCores
    });

    if (!res.ok) {
      showToast(res.message);
      renderAll();
      return;
    }
    const exclNote = res.excludedSiblingsCount > 0 ? ` (excluded SMT sibling on ${res.excludedSiblingsCount} threads)` : '';
    generateSample(false);
    showToast(`TID ${thread.tid} -> ${label}${exclNote}`);
    closeModal(false);
    renderAll();
  }

  function applyCustomAffinityMask(rawHex) {
    const proc = getAttachedProcess();
    if (!proc || !state.affinityModalTid) return;
    const cleaned = String(rawHex || '').trim();
    const parsed = parseInt(cleaned.replace(/^0x/i, ''), 16);
    if (!cleaned || !isFinite(parsed) || parsed <= 0) {
      showToast('Invalid hex affinity mask (example: 0x003F)');
      return;
    }
    if (!state.originalAffinityByPid[proc.pid]) {
      state.originalAffinityByPid[proc.pid] = {};
    }
    const res = applyThreadAffinityEdit(proc, state.affinityModalTid, parsed, state.originalAffinityByPid[proc.pid], {
      accessDenied: Boolean(proc.protectedProcess || state.simProtectedProcess),
      logicalCpus: CONFIG.logicalCpus,
      physicalCores: CONFIG.physicalCores
    });
    if (!res.ok) {
      showToast(res.message);
      renderAll();
      return;
    }
    generateSample(false);
    showToast(`TID ${state.affinityModalTid} -> Custom Mask ${formatAffinityHex(res.newMask)}`);
    closeModal(false);
    renderAll();
  }

  function revertAllSessionAffinities() {
    const proc = getAttachedProcess();
    if (!proc) return;
    const origMap = state.originalAffinityByPid[proc.pid];
    const count = revertAllThreadAffinities(proc, origMap);
    if (count === 0) {
      showToast('No session affinity edits to revert');
      return;
    }
    generateSample(false);
    showToast(`Reverted ${count} session thread affinity edit${count === 1 ? '' : 's'}`);
    if (state.openModal === 'affinity') closeModal(false);
    renderAll();
  }


  function runAndShowGroupATests() {
    const report = Z.runAllDiagnosticTests ? Z.runAllDiagnosticTests() : runGroupADiagnosticTests();
    const out = document.getElementById('calibrate-output');
    if (out) {
      out.style.display = 'block';
      const lines = report.results.map(r => `${r.pass ? '[PASS]' : '[FAIL]'} ${r.name}: ${r.detail}`).join('\n');
      const cls = report.passed === report.total ? 'c-green' : 'c-red';
      out.innerHTML = `<pre class="code-block ${cls}">Zero-PMC Diagnostics &amp; Deep-Dive Self-Test: ${report.passed}/${report.total} PASSED\n${lines}</pre>`;
    }
    const badge = document.getElementById('modal-tests-val');
    if (badge) {
      badge.innerHTML = report.passed === report.total
        ? `<span class="c-green">${report.passed}/${report.total} PASS</span>`
        : `<span class="c-red">${report.passed}/${report.total} FAIL</span>`;
    }
    showToast(`Self-tests: ${report.passed}/${report.total} passed`);
  }

  function getSelectedThreadForProcess(proc) {
    if (!proc) return null;
    if (typeof Z.getSortedThreads === 'function') {
      const sorted = Z.getSortedThreads(state.lastSnap, proc);
      if (sorted.length > 0) {
        const idx = Math.max(0, Math.min(sorted.length - 1, state.threadSelectedIdx || 0));
        const th = sorted[idx] || sorted[0];
        return {
          tid: th.tid,
          name: (th.description && th.description.trim())
            ? th.description.trim()
            : (typeof Z.formatThreadEntry === 'function' ? Z.formatThreadEntry(th, proc.modules) : `TID ${th.tid}`)
        };
      }
    }
    const threads = Z.getThreadsForProcess ? Z.getThreadsForProcess(proc) : [];
    if (threads.length === 0) return null;
    const idx = Math.max(0, Math.min(threads.length - 1, state.threadSelectedIdx || 0));
    return threads[idx] || threads[0];
  }

  function initProfilerForAttachedProcess(seedTicks = 0) {
    const proc = getAttachedProcess();
    if (!state.profiler.etwSession) {
      state.profiler.etwSession = new EtwProfilerSession({
        sampleRateKhz: CONFIG.profiler.sampleRateKhz,
        maxNodes: CONFIG.profiler.maxNodes
      });
    }
    if (!proc) {
      state.profiler.etwSession.stop();
      state.profiler.etwSession.attach(null, null);
      state.profiler.resolver = null;
      return;
    }
    const resolver = buildResolverForProcess(proc, state.profiler.sidecarLoaded);
    state.profiler.resolver = resolver;
    state.profiler.etwSession.attach(proc.pid, resolver);
    if (!CONFIG.profiler.autoStartEtw) {
      state.profiler.etwSession.paused = true;
    }
    if (seedTicks > 0) {
      feedEtwTick(seedTicks);
    }
  }

  let etwSimClockUs = 1000000;
  function feedEtwTick(ticks = 1) {
    const proc = getAttachedProcess();
    const etw = state.profiler.etwSession;
    if (!proc || !etw || !etw.running || etw.paused) return;
    const tpl = getEtwTemplatesForPid(proc.pid, proc);
    const rateMult = Math.max(1, CONFIG.profiler.sampleRateKhz || 1);

    for (let t = 0; t < ticks; t++) {
      for (const item of tpl.onCpu) {
        const jitterW = Math.max(1, Math.round(item.weight * rateMult * (0.85 + Math.random() * 0.30)));
        etw.ingestSampledProfile({
          pid: proc.pid,
          tid: item.tid,
          weight: jitterW,
          stack: item.stack
        });
      }
      for (const waitItem of tpl.offCpu) {
        const durUs = Math.max(100, Math.round(waitItem.durUs * (0.80 + Math.random() * 0.40)));
        const outTs = etwSimClockUs;
        const readyTs = outTs + Math.round(durUs * 0.92);
        const inTs = outTs + durUs;
        etwSimClockUs += durUs + 50;
        etw.ingestOffCpuPair(
          { pid: proc.pid, tid: waitItem.tid, threadName: waitItem.threadName, tsUs: outTs, stack: waitItem.stack },
          { targetPid: proc.pid, targetTid: waitItem.tid, wakerPid: proc.pid, wakerTid: waitItem.wakerTid, wakerName: waitItem.wakerName, tsUs: readyTs },
          { pid: proc.pid, tid: waitItem.tid, tsUs: inTs }
        );
      }
    }
  }

  function toggleProfilerOnOffCpu() {
    if (state.profiler.source === 'etw_offcpu') {
      state.profiler.source = 'etw_oncpu';
      showToast('Profiler source: LIVE ETW On-CPU');
    } else {
      state.profiler.source = 'etw_offcpu';
      showToast('Profiler source: LIVE ETW Off-CPU Wait Chains');
    }
    state.profiler.selectedIdx = 0;
    renderAll();
  }

  function toggleProfilerViewMode() {
    state.profiler.viewMode = state.profiler.viewMode === 'flat' ? 'tree' : 'flat';
    state.profiler.selectedIdx = 0;
    showToast(`Profiler view: ${state.profiler.viewMode === 'tree' ? 'Call Tree' : 'Flat Hotspots'}`);
    renderAll();
  }

  function toggleProfilerScope() {
    const proc = getAttachedProcess();
    if (!proc) return;
    if (state.profiler.scopeMode === 'all') {
      const th = getSelectedThreadForProcess(proc);
      if (!th) {
        showToast('No thread available to filter');
        return;
      }
      state.profiler.scopeMode = 'thread';
      showToast(`Profiler scope: TID ${th.tid} (${th.name})`);
    } else {
      state.profiler.scopeMode = 'all';
      showToast('Profiler scope: All Threads');
    }
    state.profiler.selectedIdx = 0;
    renderAll();
  }

  function toggleProfilerEtwPause() {
    const etw = state.profiler.etwSession;
    if (!etw) return;
    const paused = etw.togglePause();
    showToast(paused ? 'Live ETW sampling paused (zero overhead)' : `Live ETW sampling resumed (${etw.sampleRateKhz} kHz)`);
    renderAll();
  }

  function clearProfilerData() {
    const proc = getAttachedProcess();
    if (state.profiler.etwSession) {
      state.profiler.etwSession.clear();
    }
    if (proc && state.profiler.lastBurstByPid[proc.pid]) {
      delete state.profiler.lastBurstByPid[proc.pid];
    }
    if (state.profiler.source === 'burst') {
      state.profiler.source = 'etw_oncpu';
    }
    state.profiler.selectedIdx = 0;
    state.profiler.expandedIds = new Set();
    state.lastDiag = evaluateDiagnostics();
    showToast('Cleared ETW & burst profiler samples');
    renderAll();
  }

  function toggleProfilerSidecarMap() {
    const proc = getAttachedProcess();
    state.profiler.sidecarLoaded = !state.profiler.sidecarLoaded;
    if (proc && state.profiler.resolver) {
      if (state.profiler.sidecarLoaded) {
        const count = state.profiler.resolver.loadSidecarJson(getSidecarForPid(proc.pid));
        showToast(`Loaded sidecar .zen2sym.json (${count} RVA ranges -> Tier 3 [MAP])`);
      } else {
        state.profiler.resolver.clearSidecarMaps();
        showToast('Unloaded sidecar map (fallback to Tier 4 [.pdata])');
      }
      // Re-resolve live ETW samples and any cached bursts cleanly
      if (state.profiler.etwSession) {
        state.profiler.etwSession.clear();
        feedEtwTick(18);
      }
      const cached = state.profiler.lastBurstByPid[proc.pid];
      if (cached && cached.latest) {
        const bType = cached.latest.burstType;
        const csv = generateBurstCsvForProcess(proc, bType);
        const rep = parseUprofBurstReportCsv(csv, state.profiler.resolver, {
          burstType: bType,
          burstLabel: cached.latest.burstLabel,
          durationSec: cached.latest.durationSec,
          capturedAt: cached.latest.capturedAt,
          command: cached.latest.command
        });
        cached[bType] = rep;
        cached.latest = rep;
      }
      state.lastDiag = evaluateDiagnostics();
    }
    renderAll();
  }

  function toggleBurstDuration() {
    state.profiler.burstDurationSec = state.profiler.burstDurationSec === 5 ? 10 : 5;
    renderAll();
  }

  function startHardwareBurst(burstType = 'ibs_op', durationSec = state.profiler.burstDurationSec || 5) {
    const proc = getAttachedProcess();
    if (!proc) {
      showToast('Attach a process first (press p) before starting a hardware burst');
      return;
    }
    if (state.profiler.burstCapture) {
      showToast('Hardware burst capture already running');
      return;
    }
    const cli = locateUprofCli({ available: state.simUprofCliAvailable });
    if (!cli.found) {
      showToast(cli.error);
      renderAll();
      return;
    }
    const profile = getBurstProfile(burstType);
    const tmpDir = `C:\\Temp\\zen2top_burst_${proc.pid}_${profile.id}`;
    const cmd = profile.primaryArgs(proc.pid, durationSec, tmpDir);

    // PmuCoordinator: Pause AMDuProfPcm cleanly to release Zen 2 hardware PMCs
    state.profiler.pcmPausedForBurst = true;
    const capture = {
      burstType: profile.id,
      label: profile.shortLabel,
      remainingSec: durationSec,
      totalSec: durationSec,
      pid: proc.pid,
      procName: proc.name,
      tmpDir,
      command: cmd,
      timerId: null
    };
    state.profiler.burstCapture = capture;
    closeModal(false);
    showToast(`Paused AMDuProfPcm -> running ${profile.shortLabel} burst (${durationSec}s)`);
    renderAll();

    capture.timerId = setInterval(() => {
      if (!state.profiler.burstCapture || state.profiler.burstCapture !== capture) {
        clearInterval(capture.timerId);
        return;
      }
      capture.remainingSec -= 1;
      if (capture.remainingSec <= 0) {
        clearInterval(capture.timerId);
        finishHardwareBurst(capture);
      } else {
        renderAll();
      }
    }, 1000);
  }

  function finishHardwareBurst(capture) {
    try {
      const proc = getAttachedProcess();
      if (proc && proc.pid === capture.pid) {
        const csvText = generateBurstCsvForProcess(proc, capture.burstType);
        const capturedAt = new Date().toTimeString().slice(0, 8);
        const report = parseUprofBurstReportCsv(csvText, state.profiler.resolver, {
          burstType: capture.burstType,
          burstLabel: capture.label,
          durationSec: capture.totalSec,
          capturedAt,
          command: capture.command
        });
        if (!state.profiler.lastBurstByPid[proc.pid]) {
          state.profiler.lastBurstByPid[proc.pid] = {};
        }
        state.profiler.lastBurstByPid[proc.pid][capture.burstType] = report;
        state.profiler.lastBurstByPid[proc.pid].latest = report;
        state.profiler.source = 'burst';
        state.profiler.selectedIdx = 0;
        state.activeTab = 7;
        state.lastDiag = evaluateDiagnostics();
        showToast(`${capture.label} burst complete (${report.totalSamples.toLocaleString()} samples) -> AMDuProfPcm resumed`);
      }
    } finally {
      // Guaranteed resume of AMDuProfPcm & cleanup of tmpDir
      state.profiler.burstCapture = null;
      state.profiler.pcmPausedForBurst = false;
      renderAll();
    }
  }

  function cancelHardwareBurst(silent = false) {
    const cap = state.profiler.burstCapture;
    if (!cap) return;
    if (cap.timerId) clearInterval(cap.timerId);
    state.profiler.burstCapture = null;
    state.profiler.pcmPausedForBurst = false;
    if (!silent) {
      showToast(`Cancelled ${cap.label} burst -> AMDuProfPcm resumed`);
      renderAll();
    }
  }

  function selectThreadAndProfile(tid) {
    const proc = getAttachedProcess();
    if (!proc) return;
    const threads = Z.getThreadsForProcess ? Z.getThreadsForProcess(proc) : [];
    const idx = threads.findIndex(t => t.tid === tid);
    if (idx >= 0) state.threadSelectedIdx = idx;
    state.profiler.scopeMode = 'thread';
    state.profiler.selectedIdx = 0;
    state.activeTab = 7;
    showToast(`Tab 7 Profiler scoped to TID ${tid}`);
    renderAll();
  }

  function toggleTargetLockPriv() {
    const p = getAttachedProcess();
    if (!p || !p.win32Profile) {
      showToast('Attach a process first to toggle SeLockMemoryPrivilege');
      return;
    }
    p.win32Profile.seLockMemoryPrivilege = p.win32Profile.seLockMemoryPrivilege === 'Present' ? 'Missing' : 'Present';
    generateSample(false);
    showToast(`${p.name} SeLockMemoryPrivilege: ${p.win32Profile.seLockMemoryPrivilege}`);
    renderAll();
  }

  Object.assign(Z, {
    switchTab, jumpToFindingTab, attachProcess, detachProcess, startWaitingMode,
    openPackPickerModal, toggleDraftPack, selectDraftPreset, applyDraftPacks,
    saveDraftPacksAsDefault, fastCyclePreset, toggleExactRetiringPack, toggleNoPmuMode,
    cycleMux, cycleInterval, togglePause, unlockPmc, captureBaseline, startTimedCapture,
    finishTimedCapture, startCalibration, requestIfeoToggle, applyIfeoToggle, openModal,
    closeModal, cyclePickerSort, cycleModSort, cycleThreadSort, toggleVaMapView,
    toggleProtectedProcess, openAffinityModal, applyAffinityPreset,
    applyCustomAffinityMask, revertAllSessionAffinities, runAndShowGroupATests, toggleTargetLockPriv,
    getSelectedThreadForProcess, initProfilerForAttachedProcess, feedEtwTick,
    toggleProfilerOnOffCpu, toggleProfilerViewMode, toggleProfilerScope, toggleProfilerEtwPause,
    clearProfilerData, toggleProfilerSidecarMap, toggleBurstDuration,
    startHardwareBurst, finishHardwareBurst, cancelHardwareBurst, selectThreadAndProfile
  });
})();
