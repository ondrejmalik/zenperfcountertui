// Tab 7 (Profiler: Live ETW On-CPU/Off-CPU + AMDuProfCLI Burst + 4-Tier Symbols) & Burst Modal renderers
(() => {
  'use strict';
  const Z = window.Zen2Top || (window.Zen2Top = {});
  const { CONFIG, state, getAttachedProcess, renderPickerTable, fmtHexRva, BURST_PROFILES, locateUprofCli, getSelectedThreadForProcess } = Z;

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function tierBadgeHtml(tier) {
    if (tier === 'PDB') return `<span class="prof-tier tier-pdb">[PDB]</span>`;
    if (tier === 'EXP') return `<span class="prof-tier tier-exp">[EXP]</span>`;
    if (tier === 'MAP') return `<span class="prof-tier tier-map">[MAP]</span>`;
    if (tier === '.pdata') return `<span class="prof-tier tier-pdata">[.pdata]</span>`;
    return `<span class="prof-tier tier-raw">[RAW]</span>`;
  }

  // =========================================================================
  // TAB 7: PROFILER (Live ETW On-CPU / Off-CPU + AMDuProfCLI Burst)
  // =========================================================================
  function getActiveProfilerRows(proc) {
    const prof = state.profiler;
    const etw = prof.etwSession;
    const selThread = prof.scopeMode === 'thread' ? getSelectedThreadForProcess(proc) : null;
    const tidFilter = selThread ? selThread.tid : null;
    const filter = prof.filter || '';

    if (prof.source === 'etw_offcpu') {
      const rows = (etw && etw.targetPid === proc.pid)
        ? etw.offCpu.getWaitRows({ tid: tidFilter, filter })
        : [];
      return {
        mode: 'offcpu',
        rows,
        totalSamples: etw ? etw.offCpu.getTotalWakes(tidFilter) : 0,
        burstReport: null,
        selThread
      };
    }

    if (prof.source === 'burst') {
      const cached = prof.lastBurstByPid[proc.pid];
      const report = cached && cached.latest ? cached.latest : null;
      if (report && report.aggregator) {
        const rows = prof.viewMode === 'tree'
          ? report.aggregator.getTreeRows({ tid: tidFilter, filter, expandedIds: prof.expandedIds })
          : report.aggregator.getFlatHotspots({ tid: tidFilter, filter });
        return {
          mode: 'burst',
          rows,
          totalSamples: report.aggregator.getTotalSamples(tidFilter),
          burstReport: report,
          selThread
        };
      }
    }

    const rows = (etw && etw.targetPid === proc.pid)
      ? (prof.viewMode === 'tree'
        ? etw.onCpu.getTreeRows({ tid: tidFilter, filter, expandedIds: prof.expandedIds })
        : etw.onCpu.getFlatHotspots({ tid: tidFilter, filter }))
      : [];
    return {
      mode: 'oncpu',
      rows,
      totalSamples: etw ? etw.onCpu.getTotalSamples(tidFilter) : 0,
      burstReport: null,
      selThread
    };
  }

  function renderTab7Profiler() {
    const proc = getAttachedProcess();
    const unattEl = document.getElementById('tab7-unattached');
    const attEl = document.getElementById('tab7-attached');
    if (!unattEl || !attEl) return;

    if (!proc) {
      unattEl.style.display = 'flex';
      attEl.style.display = 'none';
      renderPickerTable('t7-picker-tbody', 't7-sort-label');
      return;
    }

    unattEl.style.display = 'none';
    attEl.style.display = 'flex';

    const prof = state.profiler;
    const etw = prof.etwSession;
    const data = getActiveProfilerRows(proc);
    const { mode, rows, totalSamples, burstReport, selThread } = data;

    // 1. Top Control Strip (strictly 1 line)
    let sourcePill = '';
    if (prof.burstCapture) {
      sourcePill = `<span class="prof-pill pill-warn">BURST CAPTURING: ${escapeHtml(prof.burstCapture.label)} (${prof.burstCapture.remainingSec}s)</span>`;
    } else if (mode === 'burst' && burstReport) {
      sourcePill = `<button class="prof-pill pill-burst" id="btn-prof-source" title="Click to return to Live ETW On-CPU">BURST: ${escapeHtml(burstReport.burstLabel)} [${burstReport.capturedAt}]</button>`;
    } else if (mode === 'offcpu') {
      const paused = etw && etw.paused;
      sourcePill = `<button class="prof-pill ${paused ? 'pill-paused' : 'pill-offcpu'}" id="btn-prof-source" title="Click or press 'o' to switch On-CPU / Off-CPU">${paused ? 'ETW PAUSED: Off-CPU' : 'LIVE ETW: Off-CPU Wait'}</button>`;
    } else {
      const paused = etw && etw.paused;
      sourcePill = `<button class="prof-pill ${paused ? 'pill-paused' : 'pill-oncpu'}" id="btn-prof-source" title="Click or press 'o' to switch On-CPU / Off-CPU">${paused ? 'ETW PAUSED: On-CPU' : 'LIVE ETW: On-CPU'}</button>`;
    }

    const scopeLabel = selThread ? `TID ${selThread.tid} (${selThread.name})` : 'All Threads';
    const sampleLabel = mode === 'offcpu'
      ? `${totalSamples.toLocaleString()} waits`
      : (mode === 'burst'
        ? `${totalSamples.toLocaleString()} burst samples`
        : `${totalSamples.toLocaleString()} samples @ ${CONFIG.profiler.sampleRateKhz} kHz`);
    const mapBadge = prof.sidecarLoaded ? ` <span class="c-magenta">[MAP]</span>` : '';

    const ctrlEl = document.getElementById('prof-control-strip');
    ctrlEl.innerHTML = `
      <div class="prof-ctrl-left">
        ${sourcePill}
        <span class="sep">│</span>
        <span class="chrome-item" id="btn-prof-scope" title="Press 't' to toggle All Threads vs Tab 6 selected thread">Scope: <span class="c-bright">${escapeHtml(scopeLabel)}</span></span>
        <span class="sep">│</span>
        <span class="c-dim">${sampleLabel}${mapBadge}</span>
      </div>
      <div class="prof-ctrl-right">
        <button class="key-btn" id="btn-prof-onoff"><span class="k">o</span> ${mode === 'offcpu' ? 'On-CPU' : 'Off-CPU'}</button>
        <button class="key-btn" id="btn-prof-burst"><span class="k">f</span> HW Burst</button>
        <button class="key-btn" id="btn-prof-view"><span class="k">v</span> ${prof.viewMode === 'tree' ? 'Flat' : 'Tree'}</button>
        <button class="key-btn" id="btn-prof-pause"><span class="k">e</span> ${etw && etw.paused ? 'Resume' : 'Pause'}</button>
        <button class="key-btn" id="btn-prof-clear"><span class="k">r</span> Clear</button>
      </div>
    `;

    const srcBtn = document.getElementById('btn-prof-source');
    if (srcBtn) {
      srcBtn.onclick = () => {
        if (mode === 'burst') {
          prof.source = 'etw_oncpu';
          prof.selectedIdx = 0;
          renderTab7Profiler();
        } else {
          Z.toggleProfilerOnOffCpu();
        }
      };
    }
    document.getElementById('btn-prof-scope').onclick = () => Z.toggleProfilerScope();
    document.getElementById('btn-prof-onoff').onclick = () => Z.toggleProfilerOnOffCpu();
    document.getElementById('btn-prof-burst').onclick = () => Z.openModal('burst');
    document.getElementById('btn-prof-view').onclick = () => Z.toggleProfilerViewMode();
    document.getElementById('btn-prof-pause').onclick = () => Z.toggleProfilerEtwPause();
    document.getElementById('btn-prof-clear').onclick = () => Z.clearProfilerData();

    // Optional inline filter row (only visible when '/' pressed or filter non-empty)
    const filterBar = document.getElementById('prof-filter-bar');
    if (filterBar) {
      filterBar.style.display = (prof.filterOpen || prof.filter) ? 'flex' : 'none';
    }

    // 2. Main Table (Flat / Tree or Off-CPU)
    const thead = document.getElementById('prof-thead');
    const tbody = document.getElementById('prof-tbody');
    const colgroup = document.getElementById('prof-colgroup');

    if (mode === 'offcpu') {
      colgroup.innerHTML = `
        <col style="width: 11%;">
        <col style="width: 11%;">
        <col style="width: 9%;">
        <col style="width: 22%;">
        <col style="width: 47%;">
      `;
      thead.innerHTML = `
        <tr>
          <th>BLOCKED %</th>
          <th>AVG WAIT</th>
          <th>WAKES</th>
          <th class="left">TOP WAKER</th>
          <th class="left">SLEEPING FUNCTION / STACK</th>
        </tr>
      `;
    } else {
      const sampleColTitle = (mode === 'burst' && burstReport && burstReport.burstType === 'ibs_op')
        ? 'SAMPLES / LAT'
        : 'SAMPLES';
      colgroup.innerHTML = `
        <col style="width: 9%;">
        <col style="width: 9%;">
        <col style="width: 17%;">
        <col style="width: 21%;">
        <col style="width: 44%;">
      `;
      thead.innerHTML = `
        <tr>
          <th>SELF %</th>
          <th>INCL %</th>
          <th>${sampleColTitle}</th>
          <th class="left">MODULE</th>
          <th class="left">${prof.viewMode === 'tree' ? 'CALL TREE (Enter expand)' : 'FUNCTION'}</th>
        </tr>
      `;
    }

    if (rows.length === 0) {
      const emptyMsg = prof.filter
        ? `No functions matching "${escapeHtml(prof.filter)}". Press Esc to clear filter.`
        : (etw && etw.paused
          ? 'ETW sampling is paused. Press e to resume or f to run an AMDuProfCLI hardware burst.'
          : 'Waiting for ETW StackWalk samples for this scope...');
      tbody.innerHTML = `<tr><td colspan="5" class="left c-dim" style="padding: 12px 4px;">${emptyMsg}</td></tr>`;
      renderProfilerContextStrip(null, mode, proc);
      return;
    }

    prof.selectedIdx = Math.max(0, Math.min(rows.length - 1, prof.selectedIdx));
    const selectedRow = rows[prof.selectedIdx];

    if (mode === 'offcpu') {
      tbody.innerHTML = rows.map((r, idx) => {
        const isSel = idx === prof.selectedIdx;
        const pctCls = r.blockedPct >= 40 ? 'c-red c-bright' : (r.blockedPct >= 20 ? 'c-yellow' : '');
        const mark = isSel ? `<span class="c-bright">&gt; </span>` : `<span class="c-muted">  </span>`;
        return `
          <tr class="selectable ${isSel ? 'selected' : ''}" data-prof-idx="${idx}">
            <td class="${pctCls}">${r.blockedPct.toFixed(1)}%</td>
            <td>${r.avgWaitMs.toFixed(2)} ms</td>
            <td class="c-dim">${r.wakes.toLocaleString()}</td>
            <td class="left"><span class="c-cyan">${escapeHtml(r.topWakerName)}</span> <span class="c-dim">(${Math.round(r.topWakerPct)}%)</span></td>
            <td class="left ${isSel ? 'c-bright' : ''}">${mark}${escapeHtml(r.displayStack)} ${tierBadgeHtml(r.tier)}</td>
          </tr>
        `;
      }).join('');
    } else {
      tbody.innerHTML = rows.map((r, idx) => {
        const isSel = idx === prof.selectedIdx;
        const selfCls = r.selfPct >= 30 ? 'c-red c-bright' : (r.selfPct >= 15 ? 'c-yellow' : '');
        const inclCls = r.inclusivePct >= 50 ? 'c-bright' : 'c-dim';
        let sampleCell = r.selfSamples > 0 ? r.selfSamples.toLocaleString() : `<span class="c-muted">0</span>`;
        if (r.avgLatencyCyc !== null && r.avgLatencyCyc > 0) {
          const latCls = r.avgLatencyCyc >= 200 ? 'c-red' : (r.avgLatencyCyc >= 100 ? 'c-yellow' : 'c-green');
          const srcTxt = r.topDataSource ? ` ${escapeHtml(r.topDataSource)}` : '';
          sampleCell = `${r.selfSamples.toLocaleString()} <span class="${latCls}">(${Math.round(r.avgLatencyCyc)}c${srcTxt})</span>`;
        }
        let fnHtml = '';
        if (prof.viewMode === 'tree') {
          const icon = r.hasChildren
            ? `<span class="prof-tree-toggle c-cyan" data-toggle-id="${escapeHtml(r.id)}">${r.isExpanded ? '▼' : '▶'}</span> `
            : `<span class="c-muted">· </span>`;
          fnHtml = `<span class="c-muted">${escapeHtml(r.treePrefix || '')}</span>${icon}${escapeHtml(r.displayName)} ${tierBadgeHtml(r.tier)}`;
        } else {
          const mark = isSel ? `<span class="c-bright">&gt; </span>` : `<span class="c-muted">  </span>`;
          fnHtml = `${mark}${escapeHtml(r.displayName)} ${tierBadgeHtml(r.tier)}`;
        }
        return `
          <tr class="selectable ${isSel ? 'selected' : ''}" data-prof-idx="${idx}" data-node-id="${escapeHtml(r.id)}">
            <td class="${selfCls}">${r.selfPct.toFixed(1)}%</td>
            <td class="${inclCls}">${r.inclusivePct.toFixed(1)}%</td>
            <td>${sampleCell}</td>
            <td class="left c-dim">${escapeHtml(r.module)}</td>
            <td class="left ${isSel ? 'c-bright' : ''}">${fnHtml}</td>
          </tr>
        `;
      }).join('');
    }

    tbody.querySelectorAll('tr[data-prof-idx]').forEach(tr => {
      tr.onclick = (ev) => {
        const idx = Number(tr.dataset.profIdx);
        prof.selectedIdx = idx;
        if (ev.target && ev.target.dataset && ev.target.dataset.toggleId) {
          const nid = ev.target.dataset.toggleId;
          if (prof.expandedIds.has(nid)) prof.expandedIds.delete(nid);
          else prof.expandedIds.add(nid);
        }
        renderTab7Profiler();
      };
      tr.ondblclick = () => {
        if (prof.viewMode === 'tree' && mode !== 'offcpu') {
          const nid = tr.dataset.nodeId;
          if (prof.expandedIds.has(nid)) prof.expandedIds.delete(nid);
          else prof.expandedIds.add(nid);
          renderTab7Profiler();
        }
      };
    });

    // 3. Bottom 3-Line Context Strip
    renderProfilerContextStrip(selectedRow, mode, proc);
  }

  function renderProfilerContextStrip(row, mode, proc) {
    const el = document.getElementById('prof-context-strip');
    if (!el) return;
    if (!row) {
      el.innerHTML = `
        <div class="prof-ctx-row"><span class="c-dim">Symbol</span><span class="c-muted">Select a row to inspect demangled signature, RVA/PDB location, and call graph.</span></div>
        <div class="prof-ctx-row"><span class="c-dim">Location</span><span class="c-muted">--</span></div>
        <div class="prof-ctx-row"><span class="c-dim">Callers</span><span class="c-muted">--</span></div>
      `;
      return;
    }

    const sidecarBtn = (row.tier === '.pdata' || state.profiler.sidecarLoaded)
      ? `<button class="btn-inline" id="btn-prof-sidecar">${state.profiler.sidecarLoaded ? 'Unload .zen2sym.json (M)' : 'Load .zen2sym.json Map (M)'}</button>`
      : '';

    const line1 = `
      <div class="prof-ctx-row">
        <span class="c-dim">Symbol</span>
        <span class="prof-ctx-main">
          <span class="c-bright">${escapeHtml(row.signature || row.name)}</span> ${tierBadgeHtml(row.tier)}
          ${sidecarBtn}
        </span>
      </div>
    `;

    let locHtml = '';
    if (mode === 'offcpu') {
      locHtml = `<span class="c-yellow">${escapeHtml(row.topWaiterName)} blocked ${row.blockedPct.toFixed(1)}% in ${escapeHtml(row.displayName)} - woken ${Math.round(row.topWakerPct)}% by ${escapeHtml(row.topWakerName)}</span> <span class="c-dim">(RVA ${fmtHexRva(row.rva)})</span>`;
    } else if (row.fileLine) {
      locHtml = `<span class="c-green">${escapeHtml(row.fileLine)}</span> <span class="c-dim">│ RVA ${fmtHexRva(row.rva)} [${fmtHexRva(row.fnStartRva)}..${fmtHexRva(row.fnEndRva)})</span>`;
    } else {
      locHtml = `<span class="c-cyan">RVA ${fmtHexRva(row.rva)}</span> <span class="c-dim">[${fmtHexRva(row.fnStartRva)}..${fmtHexRva(row.fnEndRva)}) │ ${escapeHtml(row.module)} │ Tier ${escapeHtml(row.tier)}</span>`;
    }

    const line2 = `
      <div class="prof-ctx-row">
        <span class="c-dim">${mode === 'offcpu' ? 'Wait Chain' : 'Location'}</span>
        <span>${locHtml}</span>
      </div>
    `;

    const fmtPeers = (list) => {
      if (!list || list.length === 0) return '<span class="c-muted">none</span>';
      return list.map(p => `<span class="c-fg">${escapeHtml(p.name)}</span> <span class="c-dim">(${Math.round(p.pct)}%)</span>`).join(', ');
    };
    const line3 = `
      <div class="prof-ctx-row">
        <span class="c-dim">Call Graph</span>
        <span><span class="c-dim">Callers:</span> ${fmtPeers(row.callers)} <span class="sep">│</span> <span class="c-dim">Callees:</span> ${fmtPeers(row.callees)}</span>
      </div>
    `;

    el.innerHTML = line1 + line2 + line3;
    const scBtn = document.getElementById('btn-prof-sidecar');
    if (scBtn) scBtn.onclick = () => Z.toggleProfilerSidecarMap();
  }

  // =========================================================================
  // HARDWARE-STALL & IBS BURST MODAL ('f' key)
  // =========================================================================
  function renderBurstModal() {
    const proc = getAttachedProcess();
    const infoEl = document.getElementById('burst-modal-info');
    const listEl = document.getElementById('burst-modal-list');
    if (!infoEl || !listEl) return;

    const dur = state.profiler.burstDurationSec || 5;
    const cli = locateUprofCli({ available: state.simUprofCliAvailable });

    if (!proc) {
      infoEl.innerHTML = `<span class="c-yellow">No process attached. Attach a target ('p') to run a per-process AMDuProfCLI hardware burst.</span>`;
    } else if (!cli.found) {
      infoEl.innerHTML = `<span class="c-red c-bright">AMDuProfCLI.exe Missing:</span> <span class="c-dim">${escapeHtml(cli.error)}</span>`;
    } else {
      infoEl.innerHTML =
        `Target: <span class="c-bright">${escapeHtml(proc.name)} (PID ${proc.pid})</span>` +
        `<span class="sep">│</span>Duration: <span class="c-cyan c-bright">${dur}s</span>` +
        `<span class="sep">│</span>Binary: <span class="c-green">${escapeHtml(cli.path)}</span>` +
        `<div class="c-dim" style="margin-top:3px;">PmuCoordinator cleanly pauses AMDuProfPcm to release Zen 2 hardware PMCs, runs AMDuProfCLI collect + report, deletes tmpdir, and auto-resumes live polling.</div>`;
    }

    const pid = proc ? proc.pid : 14820;
    const rowsHtml = BURST_PROFILES.map(bp => {
      const cmd = bp.primaryArgs(pid, dur, `C:\\Temp\\zen2top_burst_${pid}_${bp.id}`);
      return `
        <button class="modal-action-row" data-burst-type="${bp.id}" ${(!proc || !cli.found) ? 'disabled' : ''}>
          <span>
            <span class="c-bright">[${bp.hotkey}]</span> <span class="c-cyan">${escapeHtml(bp.label)}</span>
            <span class="c-dim"> - ${escapeHtml(bp.desc)}</span>
            <div class="c-muted" style="font-size:11px; margin-top:2px;">${escapeHtml(cmd)}</div>
          </span>
          <span class="c-bright">${dur}s</span>
        </button>
      `;
    }).join('');

    listEl.innerHTML = `
      ${rowsHtml}
      <hr class="h-rule-tight">
      <button class="modal-action-row" data-burst-act="duration">
        <span><span class="c-bright">[d]</span> Toggle Burst Capture Duration (5s default / 10s)</span>
        <span class="c-cyan c-bright">${dur}s</span>
      </button>
      <button class="modal-action-row" data-burst-act="sidecar">
        <span><span class="c-bright">[m]</span> Toggle Sidecar RVA Symbol Map (.zen2sym.json Tier 3)</span>
        <span class="${state.profiler.sidecarLoaded ? 'c-magenta' : 'c-dim'}">${state.profiler.sidecarLoaded ? 'Loaded [MAP]' : 'Off (.pdata)'}</span>
      </button>
      <button class="modal-action-row" data-burst-act="toggle-cli">
        <span><span class="c-bright">[u]</span> Simulate AMDuProfCLI.exe Availability (Missing Binary Guard)</span>
        <span class="${state.simUprofCliAvailable ? 'c-green' : 'c-red'}">${state.simUprofCliAvailable ? 'Found' : 'Missing'}</span>
      </button>
    `;

    listEl.querySelectorAll('[data-burst-type]').forEach(btn => {
      btn.onclick = () => Z.startHardwareBurst(btn.dataset.burstType, dur);
    });
    listEl.querySelectorAll('[data-burst-act]').forEach(btn => {
      btn.onclick = () => {
        const a = btn.dataset.burstAct;
        if (a === 'duration') Z.toggleBurstDuration();
        else if (a === 'sidecar') Z.toggleProfilerSidecarMap();
        else if (a === 'toggle-cli') {
          state.simUprofCliAvailable = !state.simUprofCliAvailable;
          renderBurstModal();
        }
      };
    });
  }

  Object.assign(Z, {
    renderTab7Profiler,
    renderBurstModal,
    getActiveProfilerRows
  });
})();
