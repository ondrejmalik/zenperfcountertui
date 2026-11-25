// User actions, IFEO guardrails, hardware calibration, timed capture, and self-test runner
(() => {
  'use strict';
  const Z = window.Zen2Top || (window.Zen2Top = {});
  const { CONFIG, MUX_PRESETS, state, computeMicroArchMetrics, deserializeBaselineJson, getActiveMux, getAttachedProcess, showToast, generateSample, resetHistoryAndSeed, evaluateDiagnostics, runGroupADiagnosticTests, renderAll } = Z;

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
    state.waitingTarget = null;
    state.attachedPid = pid;
    state.advisorSelectedIdx = 0;
    state.modSelectedIdx = 0;
    resetHistoryAndSeed(160);
    const p = getAttachedProcess();
    if (p) showToast(`Attached to ${p.name} (PID ${p.pid})`);
    renderAll();
  }

  function detachProcess() {
    state.waitingTarget = null;
    state.attachedPid = null;
    resetHistoryAndSeed(160);
    showToast('Detached to System-Wide PMU mode');
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

  function cycleMux() {
    state.muxIndex = (state.muxIndex + 1) % MUX_PRESETS.length;
    generateSample(false);
    showToast(`Mux preset: ${getActiveMux().label}`);
    renderAll();
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

  function captureBaseline() {
    const n = Math.max(1, state.cum.samples);
    const proc = getAttachedProcess();
    const mux = getActiveMux();
    const slug = proc ? `${proc.name.replace('.exe', '')}_${mux.id}` : `sys_${mux.id}`;
    const uarchRaw = {
      inst: state.cum.instRaw,
      dc_cross_ccx: state.cum.dcCrossCcxRaw,
      locks_serial: state.cum.locksSerialRaw,
      dec_uops: state.cum.decUopsRaw,
      oc_uops: state.cum.ocUopsRaw,
      stlf_interlock: state.cum.stlfInterlockRaw,
      misal_access: state.cum.misalAccessRaw
    };
    const uarchMetrics = computeMicroArchMetrics(uarchRaw, mux.id);
    state.activeBaseline = deserializeBaselineJson({
      name: `${slug}_${n}s.json`,
      muxPreset: mux.id,
      target: proc ? proc.name : 'SYSTEM-WIDE',
      elapsedSec: state.cum.elapsedSec,
      samples: n,
      ifeoEnabled: proc ? proc.ifeoEnabled : false,
      ipc: state.cum.ipc / n,
      cpi: state.cum.actualCpi / n,
      dramMpki: state.cum.dram / n,
      l3HitMpki: state.cum.l3Hit / n,
      l2dcExclMpki: state.cum.l2dcExcl / n,
      l2icExclMpki: state.cum.l2icExcl / n,
      branchMpki: state.cum.branch / n,
      l2dtlbMpki: state.cum.l2dtlb / n,
      l2itlbMpki: state.cum.l2itlb / n,
      l3MissMpki: state.cum.l3Miss / n,
      l3LatNs: state.cum.latNs / n,
      l1icMpki: state.cum.l1ic / n,
      l2icMpki: state.cum.l2icMiss / n,
      l1dcMpki: state.cum.l1dc / n,
      l2dcMpki: state.cum.l2dcMiss / n,
      l2pfL3Mpki: state.cum.l2pfL3 / n,
      l2pfDramMpki: state.cum.l2pfDram / n,
      dcCrossCcxMpki: uarchMetrics ? uarchMetrics.dcCrossCcxMpki : null,
      locksSerialMpki: uarchMetrics ? uarchMetrics.locksSerialMpki : null,
      opcacheHitPct: uarchMetrics ? uarchMetrics.opcacheHitPct : null,
      legacyDecodePct: uarchMetrics ? uarchMetrics.legacyDecodePct : null,
      stlfInterlockMpki: uarchMetrics ? uarchMetrics.stlfInterlockMpki : null,
      misalAccessMpki: uarchMetrics ? uarchMetrics.misalAccessMpki : null,
      cumulative_totals: {
        inst: state.cum.instRaw,
        cycles: mux.id === 'uarch' ? 0 : state.cum.aperfRaw,
        aperf: state.cum.aperfRaw,
        mperf: state.cum.mperfRaw,
        dc_cross_ccx: mux.id === 'uarch' ? state.cum.dcCrossCcxRaw : 0,
        locks_serial: mux.id === 'uarch' ? state.cum.locksSerialRaw : 0,
        dec_uops: mux.id === 'uarch' ? state.cum.decUopsRaw : 0,
        oc_uops: mux.id === 'uarch' ? state.cum.ocUopsRaw : 0,
        stlf_interlock: mux.id === 'uarch' ? state.cum.stlfInterlockRaw : 0,
        misal_access: mux.id === 'uarch' ? state.cum.misalAccessRaw : 0
      }
    });
    state.lastDiag = evaluateDiagnostics();
    showToast(`Pinned baseline: ${state.activeBaseline.name} (${n} samples)`);
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
    const n = Math.max(1, tc.samples);
    const proc = getAttachedProcess();
    const mux = getActiveMux();
    const avgIpc = tc.ipc / n;
    const uarchRaw = {
      inst: tc.instRaw,
      dc_cross_ccx: tc.dcCrossCcxRaw,
      locks_serial: tc.locksSerialRaw,
      dec_uops: tc.decUopsRaw,
      oc_uops: tc.ocUopsRaw,
      stlf_interlock: tc.stlfInterlockRaw,
      misal_access: tc.misalAccessRaw
    };
    const uarchMetrics = computeMicroArchMetrics(uarchRaw, mux.id);
    state.activeBaseline = deserializeBaselineJson({
      name: `${proc ? proc.name.replace('.exe', '') : 'sys'}_cap${tc.totalSec}s.json`,
      muxPreset: mux.id,
      target: proc ? proc.name : 'SYSTEM-WIDE',
      elapsedSec: tc.elapsedSec,
      samples: n,
      ifeoEnabled: proc ? proc.ifeoEnabled : false,
      ipc: avgIpc,
      cpi: 1.0 / Math.max(0.01, avgIpc),
      dramMpki: tc.dram / n,
      l3HitMpki: tc.l3Hit / n,
      l2dcExclMpki: tc.l2dcExcl / n,
      l2icExclMpki: tc.l2icExcl / n,
      branchMpki: tc.branch / n,
      l2dtlbMpki: tc.l2dtlb / n,
      l2itlbMpki: tc.l2itlb / n,
      l3MissMpki: tc.l3Miss / n,
      l3LatNs: tc.latNs / n,
      l1icMpki: tc.l1ic / n,
      l2icMpki: tc.l2ic / n,
      l1dcMpki: tc.l1dc / n,
      l2dcMpki: tc.l2dc / n,
      l2pfL3Mpki: tc.l2pfL3 / n,
      l2pfDramMpki: tc.l2pfDram / n,
      dcCrossCcxMpki: uarchMetrics ? uarchMetrics.dcCrossCcxMpki : null,
      locksSerialMpki: uarchMetrics ? uarchMetrics.locksSerialMpki : null,
      opcacheHitPct: uarchMetrics ? uarchMetrics.opcacheHitPct : null,
      legacyDecodePct: uarchMetrics ? uarchMetrics.legacyDecodePct : null,
      stlfInterlockMpki: uarchMetrics ? uarchMetrics.stlfInterlockMpki : null,
      misalAccessMpki: uarchMetrics ? uarchMetrics.misalAccessMpki : null,
      cumulative_totals: {
        inst: tc.instRaw,
        cycles: mux.id === 'uarch' ? 0 : tc.aperfRaw,
        aperf: tc.aperfRaw,
        mperf: tc.mperfRaw,
        dc_cross_ccx: mux.id === 'uarch' ? tc.dcCrossCcxRaw : 0,
        locks_serial: mux.id === 'uarch' ? tc.locksSerialRaw : 0,
        dec_uops: mux.id === 'uarch' ? tc.decUopsRaw : 0,
        oc_uops: mux.id === 'uarch' ? tc.ocUopsRaw : 0,
        stlf_interlock: mux.id === 'uarch' ? tc.stlfInterlockRaw : 0,
        misal_access: mux.id === 'uarch' ? tc.misalAccessRaw : 0
      }
    });
    state.timedCapture = null;
    showToast(`Timed capture complete -> pinned ${state.activeBaseline.name}`);
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


  function runAndShowGroupATests() {
    const report = runGroupADiagnosticTests();
    const out = document.getElementById('calibrate-output');
    if (out) {
      out.style.display = 'block';
      const lines = report.results.map(r => `${r.pass ? '[PASS]' : '[FAIL]'} ${r.name}: ${r.detail}`).join('\n');
      const cls = report.passed === report.total ? 'c-green' : 'c-red';
      out.innerHTML = `<pre class="code-block ${cls}">Group A Zero-PMC Win32 Diagnostics Self-Test: ${report.passed}/${report.total} PASSED\n${lines}</pre>`;
    }
    const badge = document.getElementById('modal-tests-val');
    if (badge) {
      badge.innerHTML = report.passed === report.total
        ? `<span class="c-green">${report.passed}/${report.total} PASS</span>`
        : `<span class="c-red">${report.passed}/${report.total} FAIL</span>`;
    }
    showToast(`Group A tests: ${report.passed}/${report.total} passed`);
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

  Object.assign(Z, { switchTab, jumpToFindingTab, attachProcess, detachProcess, startWaitingMode, cycleMux, cycleInterval, togglePause, unlockPmc, captureBaseline, startTimedCapture, finishTimedCapture, startCalibration, requestIfeoToggle, applyIfeoToggle, openModal, closeModal, cyclePickerSort, cycleModSort, runAndShowGroupATests, toggleTargetLockPriv });
})();
