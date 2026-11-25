// Event listeners, keyboard shortcuts, live sampling loop, and bootstrap
(() => {
  'use strict';
  const Z = window.Zen2Top || (window.Zen2Top = {});
  const {
    CONFIG, MUX_PRESETS, PROCESSES, BASELINE_PRESETS, state,
    getActiveMux, buildUprofMetricSpec, computeMicroArchMetrics, parseReportCoreCsv,
    deserializeBaselineJson, makeWin32Profile, getAttachedProcess, showToast,
    generateSample, resetHistoryAndSeed, evaluateDiagnostics, runGroupADiagnosticTests,
    renderTab3Tlb, renderTab4Memory, renderTab5Advisor, renderTab6Threads, renderTab7Profiler, renderHelpModal, renderAll,
    getFilteredProcesses, switchTab, jumpToFindingTab, attachProcess, detachProcess,
    startWaitingMode, cycleMux, cycleInterval, togglePause, unlockPmc, captureBaseline,
    startTimedCapture, startCalibration, requestIfeoToggle, applyIfeoToggle,
    openModal, closeModal, cyclePickerSort, cycleModSort, cycleThreadSort,
    toggleVaMapView, toggleProtectedProcess, openAffinityModal, applyAffinityPreset,
    applyCustomAffinityMask, revertAllSessionAffinities, runAndShowGroupATests, toggleTargetLockPriv,
    toggleProfilerOnOffCpu, toggleProfilerViewMode, toggleProfilerScope, toggleProfilerEtwPause,
    clearProfilerData, toggleProfilerSidecarMap, toggleBurstDuration,
    startHardwareBurst, cancelHardwareBurst, getActiveProfilerRows
  } = Z;

  // =========================================================================
  // 9. EVENT LISTENERS (Keyboard-first + Clickable Chrome)
  // =========================================================================
  document.querySelectorAll('#tab-strip .tab-btn').forEach(btn => {
    btn.onclick = () => switchTab(Number(btn.dataset.tab));
  });

  document.getElementById('hdr-target').onclick = () => openModal('picker');
  document.getElementById('hdr-mux').onclick = cycleMux;
  document.getElementById('hdr-base').onclick = () => openModal('baseline');
  document.getElementById('hdr-state').onclick = () => {
    if (state.pmcLocked) unlockPmc();
    else togglePause();
  };

  document.querySelectorAll('.key-btn').forEach(btn => {
    btn.onclick = () => {
      const act = btn.dataset.action;
      if (act === 'tabs') switchTab((state.activeTab % 7) + 1);
      else if (act === 'picker') openModal('picker');
      else if (act === 'mux') cycleMux();
      else if (act === 'baseline') openModal('baseline');
      else if (act === 'ccx') { state.ccxOpen = !state.ccxOpen; renderAll(); }
      else if (act === 'help') openModal('help');
      else if (act === 'quit') {
        cancelHardwareBurst(true);
        if (state.profiler && state.profiler.etwSession) state.profiler.etwSession.stop();
        openModal('quit');
      }
    };
  });

  document.querySelectorAll('.modal-backdrop').forEach(bg => {
    bg.onclick = e => { if (e.target === bg) closeModal(); };
  });

  ['modal-picker-input', 't4-picker-input', 't6-picker-input', 't7-picker-input'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => {
      state.pickerFilter = el.value;
      state.pickerSelectedIdx = 0;
      ['modal-picker-input', 't4-picker-input', 't6-picker-input', 't7-picker-input'].forEach(otherId => {
        if (otherId === id) return;
        const otherEl = document.getElementById(otherId);
        if (otherEl && otherEl.value !== el.value) otherEl.value = el.value;
      });
      renderAll();
    });
  });

  const profFilterInp = document.getElementById('prof-filter-input');
  if (profFilterInp) {
    profFilterInp.addEventListener('input', () => {
      state.profiler.filter = profFilterInp.value;
      state.profiler.selectedIdx = 0;
      renderTab7Profiler();
    });
  }

  document.getElementById('modal-sort-label').onclick = cyclePickerSort;
  document.getElementById('t4-sort-label').onclick = cyclePickerSort;
  const t6Sort = document.getElementById('t6-sort-label');
  if (t6Sort) t6Sort.onclick = cyclePickerSort;
  const t7Sort = document.getElementById('t7-sort-label');
  if (t7Sort) t7Sort.onclick = cyclePickerSort;
  document.getElementById('btn-modal-detach').onclick = () => { detachProcess(); closeModal(); };
  document.getElementById('btn-modal-wait').onclick = startWaitingMode;
  document.getElementById('btn-t4-wait').onclick = startWaitingMode;
  const t6Wait = document.getElementById('btn-t6-wait');
  if (t6Wait) t6Wait.onclick = startWaitingMode;
  const t7Wait = document.getElementById('btn-t7-wait');
  if (t7Wait) t7Wait.onclick = startWaitingMode;

  document.querySelectorAll('[data-mod-sort]').forEach(th => {
    th.onclick = () => {
      state.modSort = th.dataset.modSort;
      renderTab3Tlb();
    };
  });

  document.querySelectorAll('[data-thread-sort]').forEach(th => {
    th.onclick = () => {
      state.threadSort = th.dataset.threadSort;
      renderTab6Threads();
    };
  });
  const threadSortLbl = document.getElementById('threads-sort-label');
  if (threadSortLbl) threadSortLbl.onclick = cycleThreadSort;
  const btnThreadAff = document.getElementById('btn-thread-affinity');
  if (btnThreadAff) btnThreadAff.onclick = () => openAffinityModal();
  const btnThreadRev = document.getElementById('btn-thread-revert');
  if (btnThreadRev) btnThreadRev.onclick = () => revertAllSessionAffinities();

  document.querySelectorAll('[data-aff-act]').forEach(btn => {
    btn.onclick = () => {
      const a = btn.dataset.affAct;
      if (a === 'revert') revertAllSessionAffinities();
      else applyAffinityPreset(a);
    };
  });
  const btnAffHex = document.getElementById('btn-affinity-apply-hex');
  if (btnAffHex) {
    btnAffHex.onclick = () => {
      const inp = document.getElementById('affinity-hex-input');
      applyCustomAffinityMask(inp ? inp.value : '');
    };
  }


  document.querySelectorAll('[data-b-act]').forEach(btn => {
    btn.onclick = () => {
      const a = btn.dataset.bAct;
      if (a === 'capture') { captureBaseline(); closeModal(); }
      else if (a === 'timed-15') { startTimedCapture(15); }
      else if (a === 'load-4k') { state.activeBaseline = deserializeBaselineJson(BASELINE_PRESETS['4K-Default']); state.lastDiag = evaluateDiagnostics(); showToast('Loaded deadlock_4k_default.json'); closeModal(); }
      else if (a === 'load-2m') { state.activeBaseline = deserializeBaselineJson(BASELINE_PRESETS['2MiB-IFEO']); state.lastDiag = evaluateDiagnostics(); showToast('Loaded deadlock_2m_ifeo.json'); closeModal(); }
      else if (a === 'clear') { state.activeBaseline = null; state.lastDiag = evaluateDiagnostics(); showToast('Cleared active baseline'); closeModal(); }
      else if (a === 'interval') { cycleInterval(); }
      else if (a === 'pause') { togglePause(); }
      else if (a === 'reset-avg') { resetHistoryAndSeed(1); closeModal(); showToast('Rolling window reset (N=1) -> Advisor evidence gate active'); }
      else if (a === 'toggle-lock') { state.pmcLocked = !state.pmcLocked; closeModal(); }
      else if (a === 'toggle-exact-ret') {
        CONFIG.retiring.exactRetiring = !CONFIG.retiring.exactRetiring;
        generateSample(false);
        showToast(CONFIG.retiring.exactRetiring ? 'Exact Retiring ON (0x4300C1, Full 4-Mux)' : 'Estimated Retiring ON (~XX%, Full 3-Mux)');
        renderAll();
      }
      else if (a === 'toggle-admin') {
        state.isAdmin = !state.isAdmin;
        showToast(state.isAdmin ? 'Admin elevation ON (IFEO editable)' : 'Admin elevation OFF (IFEO read-only)');
        renderAll();
      }
      else if (a === 'toggle-gpu-api') {
        state.simGpuAvailable = !state.simGpuAvailable;
        generateSample(false);
        showToast(state.simGpuAvailable ? 'D3DKMT GPU telemetry ON' : 'D3DKMT GPU telemetry OFF (None fallback)');
        renderAll();
      }
      else if (a === 'toggle-ecoqos-api') {
        state.simEcoQosSupported = !state.simEcoQosSupported;
        generateSample(false);
        showToast(state.simEcoQosSupported ? 'Win11 22H2+ EcoQoS API ON' : 'Pre-22H2 EcoQoS fallback (Unknown)');
        renderAll();
      }
      else if (a === 'toggle-lock-priv') { toggleTargetLockPriv(); }
      else if (a === 'toggle-prot-proc') { toggleProtectedProcess(); }
      else if (a === 'run-tests') { runAndShowGroupATests(); }
      else if (a === 'calibrate') { startCalibration(); }
    };
  });

  document.getElementById('btn-ifeo-cancel').onclick = () => closeModal();
  document.getElementById('btn-ifeo-confirm').onclick = () => {
    if (state.pendingIfeoAction) applyIfeoToggle(state.pendingIfeoAction.proc, state.pendingIfeoAction.mod);
  };

  document.querySelectorAll('#help-tabs .tab-btn').forEach(btn => {
    btn.onclick = () => {
      state.helpTab = btn.dataset.htab;
      renderHelpModal();
    };
  });

  document.getElementById('btn-resume-tui').onclick = () => closeModal();

  // Global keyboard handler
  window.addEventListener('keydown', e => {
    const activeTag = document.activeElement ? document.activeElement.tagName : '';
    const inInput = activeTag === 'INPUT' || activeTag === 'TEXTAREA';

    if (e.key === 'Escape') {
      if (inInput) {
        const activeId = document.activeElement.id;
        document.activeElement.blur();
        if (activeId === 'prof-filter-input') {
          state.profiler.filter = '';
          state.profiler.filterOpen = false;
          const pf = document.getElementById('prof-filter-input');
          if (pf) pf.value = '';
          renderTab7Profiler();
          return;
        }
        if (activeId !== 'affinity-hex-input' && state.pickerFilter) {
          state.pickerFilter = '';
          ['modal-picker-input', 't4-picker-input', 't6-picker-input', 't7-picker-input'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = '';
          });
          renderAll();
          return;
        }
      }
      if (state.openModal) { closeModal(); return; }
      if (state.profiler && state.profiler.burstCapture) { cancelHardwareBurst(); return; }
      if (state.activeTab === 7 && (state.profiler.filterOpen || state.profiler.filter)) {
        state.profiler.filter = '';
        state.profiler.filterOpen = false;
        const pf = document.getElementById('prof-filter-input');
        if (pf) pf.value = '';
        renderTab7Profiler();
        return;
      }
      if (state.waitingTarget) { detachProcess(); return; }
      return;
    }

    if (inInput) {
      if (document.activeElement.id === 'affinity-hex-input') {
        if (e.key === 'Enter') {
          e.preventDefault();
          applyCustomAffinityMask(document.activeElement.value);
        }
        return;
      }
      if (document.activeElement.id === 'prof-filter-input') {
        if (e.key === 'Enter') {
          e.preventDefault();
          document.activeElement.blur();
        }
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        state.pickerSelectedIdx += 1;
        renderAll();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        state.pickerSelectedIdx = Math.max(0, state.pickerSelectedIdx - 1);
        renderAll();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const list = getFilteredProcesses();
        if (list[state.pickerSelectedIdx]) {
          attachProcess(list[state.pickerSelectedIdx].pid);
          closeModal();
        }
      }
      return;
    }

    if (state.openModal === 'burst') {
      const dur = state.profiler.burstDurationSec || 5;
      if (e.key === '1') { startHardwareBurst('ibs_op', dur); }
      else if (e.key === '2') { startHardwareBurst('dram_l3', dur); }
      else if (e.key === '3') { startHardwareBurst('branch_miss', dur); }
      else if (e.key === '4') { startHardwareBurst('tlb_walk', dur); }
      else if (e.key === 'd' || e.key === 'D') { toggleBurstDuration(); }
      else if (e.key === 'm' || e.key === 'M') { toggleProfilerSidecarMap(); }
      else if (e.key === 'u' || e.key === 'U') { state.simUprofCliAvailable = !state.simUprofCliAvailable; renderAll(); }
      else if (e.key === 'f') { closeModal(); }
      return;
    }

    if (state.openModal === 'affinity') {
      if (e.key === '1') { applyAffinityPreset('ccx0'); }
      else if (e.key === '2') { applyAffinityPreset('ccx1'); }
      else if (e.key === '3') { applyAffinityPreset('phys'); }
      else if (e.key === '4') { applyAffinityPreset('single-phys'); }
      else if (e.key === '5') {
        e.preventDefault();
        const inp = document.getElementById('affinity-hex-input');
        if (inp) { inp.focus(); inp.select(); }
      }
      else if (e.key === 'R' || e.key === 'r') { revertAllSessionAffinities(); }
      return;
    }

    if (state.openModal === 'quit') {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); closeModal(); }
      return;
    }

    if (state.openModal === 'ifeo') {
      if ((e.key === 'Enter' || e.key === 'y' || e.key === 'Y') && state.pendingIfeoAction) {
        e.preventDefault();
        applyIfeoToggle(state.pendingIfeoAction.proc, state.pendingIfeoAction.mod);
      } else if (e.key === 'n' || e.key === 'N') {
        closeModal();
      }
      return;
    }

    if (state.openModal === 'help') {
      if (e.key === '1') { state.helpTab = 'keys'; renderHelpModal(); }
      else if (e.key === '2') { state.helpTab = 'pmu'; renderHelpModal(); }
      else if (e.key === '3') { state.helpTab = 'arch'; renderHelpModal(); }
      else if (e.key === '?') closeModal();
      return;
    }

    if (state.openModal === 'baseline') {
      if (e.key === 'S' || e.key === 's') { captureBaseline(); closeModal(); }
      else if (e.key === 'T' || e.key === 't') { startTimedCapture(15); }
      else if (e.key === '1') { state.activeBaseline = deserializeBaselineJson(BASELINE_PRESETS['4K-Default']); state.lastDiag = evaluateDiagnostics(); closeModal(); }
      else if (e.key === '2') { state.activeBaseline = deserializeBaselineJson(BASELINE_PRESETS['2MiB-IFEO']); state.lastDiag = evaluateDiagnostics(); closeModal(); }
      else if (e.key === 'B') { state.activeBaseline = null; state.lastDiag = evaluateDiagnostics(); closeModal(); }
      else if (e.key === 'i') { cycleInterval(); }
      else if (e.key === ' ') { e.preventDefault(); togglePause(); }
      else if (e.key === 'r') { resetHistoryAndSeed(1); closeModal(); showToast('Rolling window reset (N=1)'); }
      else if (e.key === 'u') { state.pmcLocked = !state.pmcLocked; closeModal(); }
      else if (e.key === 'e' || e.key === 'E') { CONFIG.retiring.exactRetiring = !CONFIG.retiring.exactRetiring; generateSample(false); renderAll(); }
      else if (e.key === 'a' || e.key === 'A') { state.isAdmin = !state.isAdmin; renderAll(); }
      else if (e.key === 'g' || e.key === 'G') { state.simGpuAvailable = !state.simGpuAvailable; generateSample(false); renderAll(); }
      else if (e.key === 'o' || e.key === 'O') { state.simEcoQosSupported = !state.simEcoQosSupported; generateSample(false); renderAll(); }
      else if (e.key === 'l' || e.key === 'L') { toggleTargetLockPriv(); }
      else if (e.key === 'x' || e.key === 'X') { toggleProtectedProcess(); }
      else if (e.key === 'v' || e.key === 'V') { runAndShowGroupATests(); }
      else if (e.key === 'C' || e.key === 'c') { startCalibration(); }
      else if (e.key === 'b') closeModal();
      return;
    }

    if (state.openModal === 'picker') {
      if (e.key === '/') { e.preventDefault(); document.getElementById('modal-picker-input').focus(); }
      else if (e.key === 's') cyclePickerSort();
      else if (e.key === 'd') { detachProcess(); closeModal(); }
      else if (e.key === 'w') startWaitingMode();
      else if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); state.pickerSelectedIdx += 1; renderAll(); }
      else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); state.pickerSelectedIdx = Math.max(0, state.pickerSelectedIdx - 1); renderAll(); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        const list = getFilteredProcesses();
        if (list[state.pickerSelectedIdx]) {
          attachProcess(list[state.pickerSelectedIdx].pid);
          closeModal();
        }
      }
      return;
    }

    // Main TUI hotkeys (1-7)
    if (['1', '2', '3', '4', '5', '6', '7'].includes(e.key)) { switchTab(Number(e.key)); return; }
    if (e.key === 'p') { openModal('picker'); return; }
    if (e.key === 'm') { cycleMux(); return; }
    if (e.key === 'b') { openModal('baseline'); return; }
    if (e.key === 'c') { state.ccxOpen = !state.ccxOpen; renderAll(); return; }
    if (e.key === '?') { openModal('help'); return; }
    if (e.key === 'q') {
      cancelHardwareBurst(true);
      if (state.profiler && state.profiler.etwSession) state.profiler.etwSession.stop();
      openModal('quit');
      return;
    }
    if (e.key === 'd') { detachProcess(); return; }
    if (e.key === 'u' && state.pmcLocked) { unlockPmc(); return; }

    // Tab 3 shortcuts (Space/Enter toggles DLL in IFEO, U toggles master UseLargePages)
    if (state.activeTab === 3) {
      const proc = getAttachedProcess();
      if (e.key === 's') { cycleModSort(); return; }
      if (proc) {
        if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); state.modSelectedIdx += 1; renderTab3Tlb(); return; }
        if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); state.modSelectedIdx = Math.max(0, state.modSelectedIdx - 1); renderTab3Tlb(); return; }
        if (e.key === 'U') { requestIfeoToggle(null); return; }
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          const selRow = document.querySelector('#tlb-mod-tbody tr.selected');
          if (selRow) {
            const mod = proc.modules.find(m => m.name === selRow.dataset.modName);
            if (mod) requestIfeoToggle(mod);
          }
          return;
        }
      }
    }

    // Tab 4 shortcuts (unattached picker OR attached 'v' VA map toggle)
    if (state.activeTab === 4) {
      if (!getAttachedProcess()) {
        if (e.key === '/') { e.preventDefault(); document.getElementById('t4-picker-input').focus(); return; }
        if (e.key === 's') { cyclePickerSort(); return; }
        if (e.key === 'w') { startWaitingMode(); return; }
        if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); state.pickerSelectedIdx += 1; renderTab4Memory(); return; }
        if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); state.pickerSelectedIdx = Math.max(0, state.pickerSelectedIdx - 1); renderTab4Memory(); return; }
        if (e.key === 'Enter') {
          e.preventDefault();
          const list = getFilteredProcesses();
          if (list[state.pickerSelectedIdx]) attachProcess(list[state.pickerSelectedIdx].pid);
          return;
        }
      } else if (e.key === 'v' || e.key === 'V') {
        toggleVaMapView();
        return;
      }
    }

    // Tab 5 Advisor shortcuts
    if (state.activeTab === 5) {
      if (e.key === 'f' || e.key === 'F') { openModal('burst'); return; }
      const diag = state.lastDiag;
      if (diag && diag.ready && diag.findings.length > 0) {
        if (e.key === 'j' || e.key === 'ArrowDown') {
          e.preventDefault();
          state.advisorSelectedIdx = Math.min(diag.findings.length - 1, state.advisorSelectedIdx + 1);
          renderTab5Advisor();
          return;
        }
        if (e.key === 'k' || e.key === 'ArrowUp') {
          e.preventDefault();
          state.advisorSelectedIdx = Math.max(0, state.advisorSelectedIdx - 1);
          renderTab5Advisor();
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          jumpToFindingTab(diag.findings[state.advisorSelectedIdx]);
          return;
        }
      }
    }

    // Tab 6 Threads & Frame Pacing shortcuts
    if (state.activeTab === 6) {
      if (!getAttachedProcess()) {
        if (e.key === '/') { e.preventDefault(); document.getElementById('t6-picker-input').focus(); return; }
        if (e.key === 's') { cyclePickerSort(); return; }
        if (e.key === 'w') { startWaitingMode(); return; }
        if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); state.pickerSelectedIdx += 1; renderTab6Threads(); return; }
        if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); state.pickerSelectedIdx = Math.max(0, state.pickerSelectedIdx - 1); renderTab6Threads(); return; }
        if (e.key === 'Enter') {
          e.preventDefault();
          const list = getFilteredProcesses();
          if (list[state.pickerSelectedIdx]) attachProcess(list[state.pickerSelectedIdx].pid);
          return;
        }
      } else {
        if (e.key === 's') { cycleThreadSort(); return; }
        if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); state.threadSelectedIdx += 1; renderTab6Threads(); return; }
        if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); state.threadSelectedIdx = Math.max(0, state.threadSelectedIdx - 1); renderTab6Threads(); return; }
        if (e.key === 'a' || e.key === 'Enter') { e.preventDefault(); openAffinityModal(); return; }
        if (e.key === 'R') { revertAllSessionAffinities(); return; }
      }
    }

    // Tab 7 Profiler shortcuts (Live ETW On/Off-CPU + AMDuProfCLI Burst)
    if (state.activeTab === 7) {
      const proc = getAttachedProcess();
      if (!proc) {
        if (e.key === '/') { e.preventDefault(); document.getElementById('t7-picker-input').focus(); return; }
        if (e.key === 's') { cyclePickerSort(); return; }
        if (e.key === 'w') { startWaitingMode(); return; }
        if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); state.pickerSelectedIdx += 1; renderTab7Profiler(); return; }
        if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); state.pickerSelectedIdx = Math.max(0, state.pickerSelectedIdx - 1); renderTab7Profiler(); return; }
        if (e.key === 'Enter') {
          e.preventDefault();
          const list = getFilteredProcesses();
          if (list[state.pickerSelectedIdx]) attachProcess(list[state.pickerSelectedIdx].pid);
          return;
        }
      } else {
        if (e.key === 'o' || e.key === 'O') { toggleProfilerOnOffCpu(); return; }
        if (e.key === 'f' || e.key === 'F') { openModal('burst'); return; }
        if (e.key === 'v' || e.key === 'V') { toggleProfilerViewMode(); return; }
        if (e.key === 't' || e.key === 'T') { toggleProfilerScope(); return; }
        if (e.key === 'e' || e.key === 'E') { toggleProfilerEtwPause(); return; }
        if (e.key === 'r' || e.key === 'R') { clearProfilerData(); return; }
        if (e.key === 'M') { toggleProfilerSidecarMap(); return; }
        if (e.key === '/') {
          e.preventDefault();
          state.profiler.filterOpen = true;
          renderTab7Profiler();
          const inp = document.getElementById('prof-filter-input');
          if (inp) { inp.value = state.profiler.filter; inp.focus(); }
          return;
        }
        if (e.key === 'j' || e.key === 'ArrowDown') {
          e.preventDefault();
          state.profiler.selectedIdx += 1;
          renderTab7Profiler();
          return;
        }
        if (e.key === 'k' || e.key === 'ArrowUp') {
          e.preventDefault();
          state.profiler.selectedIdx = Math.max(0, state.profiler.selectedIdx - 1);
          renderTab7Profiler();
          return;
        }
        if (e.key === 'Enter' && state.profiler.viewMode === 'tree' && state.profiler.source !== 'etw_offcpu') {
          e.preventDefault();
          const data = getActiveProfilerRows(proc);
          const row = data.rows[state.profiler.selectedIdx];
          if (row && row.hasChildren) {
            if (state.profiler.expandedIds.has(row.id)) state.profiler.expandedIds.delete(row.id);
            else state.profiler.expandedIds.add(row.id);
            renderTab7Profiler();
          }
          return;
        }
      }
    }

    if (e.key === ' ') {
      e.preventDefault();
      togglePause();
    }
  });

  // =========================================================================
  // 10. LIVE SAMPLING LOOP & RESIZE HANDLER
  // =========================================================================
  let timerId = null;
  function restartTimer() {
    if (timerId) clearInterval(timerId);
    timerId = setInterval(() => {
      if (state.paused || state.pmcLocked) return;
      if (state.profiler && state.profiler.pcmPausedForBurst) {
        // Hardware PMCs paused for AMDuProfCLI burst; Live Zero-PMC ETW still streams!
        if (typeof Z.feedEtwTick === 'function') Z.feedEtwTick(1);
        renderAll();
        return;
      }
      generateSample(true);
      renderAll();
    }, state.intervalSec * 1000);
  }

  Z.restartTimer = restartTimer;

  window.addEventListener('resize', () => renderAll());

  // Expose read-only & test hooks for automated verification
  window.__zen2top = {
    CONFIG,
    MUX_PRESETS,
    PROCESSES,
    BASELINE_PRESETS,
    state,
    getActiveMux,
    buildUprofMetricSpec,
    computeMicroArchMetrics,
    parseReportCoreCsv,
    deserializeBaselineJson,
    makeWin32Profile,
    evaluateDiagnostics,
    runGroupADiagnosticTests,
    runDeepDiveTests: Z.runDeepDiveTests,
    runProfilerTests: Z.runProfilerTests,
    runAllDiagnosticTests: Z.runAllDiagnosticTests,
    SymbolResolver: Z.SymbolResolver,
    CallTreeAggregator: Z.CallTreeAggregator,
    OffCpuAggregator: Z.OffCpuAggregator,
    PmuCoordinator: Z.PmuCoordinator,
    parseUprofBurstReportCsv: Z.parseUprofBurstReportCsv,
    EtwProfilerSession: Z.EtwProfilerSession,
    generateSample,
    resetHistoryAndSeed,
    cycleMux,
    switchTab,
    attachProcess,
    captureBaseline,
    startHardwareBurst,
    cancelHardwareBurst,
    renderAll,
    openModal,
    closeModal
  };

  // Boot (seed 160 samples so Braille graphs span full width and Advisor >= 10 evidence gate is ready)
  resetHistoryAndSeed(160);
  renderAll();
  restartTimer();

})();
