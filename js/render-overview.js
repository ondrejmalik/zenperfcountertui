// Top/bottom chrome, CCX/SMT strip, CPI stack, and Tab 1 Overview renderer
(() => {
  'use strict';
  const Z = window.Zen2Top || (window.Zen2Top = {});
  const { CONFIG, MUX_PRESETS, state, computeMicroArchMetrics, getActiveMux, getAttachedProcess, fmtDeltaPct, fmtMiB, fmtRate, formatRetiringTag, severityClass, renderBrailleGraph } = Z;

  // =========================================================================
  // 7. RENDER FUNCTIONS
  // =========================================================================
  function renderChrome() {
    const proc = getAttachedProcess();
    const mux = getActiveMux();
    const snap = state.lastSnap;

    const targetEl = document.getElementById('hdr-target');
    if (state.waitingTarget) {
      targetEl.innerHTML = `<span class="c-yellow">WAITING: ${state.waitingTarget}</span>`;
    } else if (proc) {
      targetEl.innerHTML = `<span class="c-bright">${proc.name}</span> <span class="c-dim">(${proc.pid})</span>`;
    } else {
      targetEl.innerHTML = `<span class="c-cyan c-bright">SYSTEM-WIDE</span>`;
    }

    document.getElementById('hdr-mux').innerHTML = `<span class="c-cyan">${mux.label}</span>`;
    document.getElementById('hdr-ghz').textContent = (mux.id === 'tlb' || mux.id === 'no-pmu' || !snap) ? 'GHz N/A' : `${snap.effGhz.toFixed(2)} GHz`;

    const baseEl = document.getElementById('hdr-base');
    if (state.activeBaseline) {
      const muxDiff = (state.activeBaseline.muxPreset || 'full') !== mux.id;
      const diffTag = muxDiff ? ` <span class="c-red c-bright">[MUX DIFF]</span>` : '';
      baseEl.innerHTML = `Base: <span class="c-bright">${state.activeBaseline.name}</span>${diffTag}`;
    } else {
      baseEl.innerHTML = `Base: <span class="c-dim">none</span>`;
    }

    const stEl = document.getElementById('hdr-state');
    if (state.pmcLocked) {
      stEl.innerHTML = `<span class="c-red c-bright">PMC LOCKED</span>`;
    } else if (state.timedCapture) {
      stEl.innerHTML = `<span class="c-cyan c-bright">CAPTURE ${Math.max(0, state.timedCapture.remainingSec)}s</span>`;
    } else if (state.paused) {
      stEl.innerHTML = `<span class="c-yellow c-bright">PAUSED</span>`;
    } else {
      stEl.innerHTML = `<span class="c-green c-bright">LIVE</span>`;
    }

    // Tabs (1-5 with subtle red (N) badge on Advisor when HI findings exist)
    const labels = { 1: 'Overview', 2: 'Cache', 3: 'TLB & Pages', 4: 'Memory', 5: 'Advisor' };
    document.querySelectorAll('#tab-strip .tab-btn').forEach(btn => {
      const t = Number(btn.dataset.tab);
      const isAct = t === state.activeTab;
      btn.classList.toggle('active', isAct);
      if (t === 5) {
        const hiCnt = (state.lastDiag && state.lastDiag.ready) ? state.lastDiag.highCount : 0;
        const badge = hiCnt > 0 ? `<span class="tab-badge">(${hiCnt})</span>` : '';
        btn.innerHTML = `${isAct ? '[5]' : '5'} ${labels[5]}${badge}`;
      } else {
        btn.textContent = isAct ? `[${t}] ${labels[t]}` : `${t} ${labels[t]}`;
      }
    });

    document.getElementById('hdr-interval').textContent = `${state.intervalSec}s`;
    document.getElementById('hdr-samples').textContent = `#${state.sampleCount}`;
    document.getElementById('hdr-cpu-scope').textContent = proc
      ? `Affinity 12T │ ${CONFIG.cpuModel}`
      : `All 12T │ ${CONFIG.cpuModel}`;

    // Context-sensitive bottom hint
    const hintEl = document.getElementById('bottom-hint');
    if (state.activeTab === 3) {
      hintEl.textContent = 'j/k Select │ Space/Enter Toggle DLL │ U Master IFEO │ s Sort';
    } else if (state.activeTab === 5) {
      hintEl.textContent = 'j/k Select Finding │ Enter Jump to Tab │ Space Pause';
    } else if (state.activeTab === 4 && !proc) {
      hintEl.textContent = '/ Filter │ s Sort │ Enter Attach │ w Wait Mode';
    } else {
      hintEl.textContent = 'Space Pause │ d Detach │ c CCX+SMT';
    }

    // Status Banner
    const banner = document.getElementById('status-banner');
    const bText = document.getElementById('banner-text');
    const bAct = document.getElementById('banner-actions');
    if (state.pmcLocked) {
      banner.className = 'status-banner visible locked';
      bText.textContent = `[LOCKED] Hardware PMCs claimed by Windows ETW trace (${state.blockerName}): logman stop ${state.blockerName} -ets`;
      bAct.innerHTML = `<button class="banner-action" id="btn-unlock-pmc">Unlock PMCs (u)</button>`;
      document.getElementById('btn-unlock-pmc').onclick = () => Z.unlockPmc();
    } else if (state.waitingTarget) {
      banner.className = 'status-banner visible waiting';
      bText.textContent = `Waiting for ${state.waitingTarget} to start... Streaming live system-wide Zen 2 PMU counters.`;
      bAct.innerHTML = `<button class="banner-action" id="btn-sim-spawn">Simulate Process Spawn</button> &nbsp; <button class="banner-action" id="btn-cancel-wait">Cancel (Esc)</button>`;
      document.getElementById('btn-sim-spawn').onclick = () => {
        state.waitingTarget = null;
        Z.attachProcess(14820);
      };
      document.getElementById('btn-cancel-wait').onclick = () => {
        state.waitingTarget = null;
        Z.renderAll();
      };
    } else {
      banner.className = 'status-banner';
    }
  }

  // GLOBAL CCX + PHYSICAL-CORE SMT SIBLING STRIP (opens above everything on every page)
  function renderCcxStrip() {
    const strip = document.getElementById('ccx-strip');
    strip.classList.toggle('visible', state.ccxOpen);
    if (!state.ccxOpen || !state.lastSnap) return;

    const snap = state.lastSnap;
    const muxId = MUX_PRESETS[state.muxIndex].id;
    const hasCore = muxId !== 'tlb' && muxId !== 'no-pmu';
    const hasDram = muxId === 'full' || muxId === 'ipc-mem';
    const isNoPmu = muxId === 'no-pmu';

    document.getElementById('ccx-tbody').innerHTML = snap.ccx.map(c => `
      <tr>
        <td class="c-bright">CCX${c.id}</td>
        <td class="c-dim">${c.cpus}</td>
        <td class="${hasCore ? severityClass(c.ipc, 1.2, 0.8, true) : 'c-muted'}">${hasCore ? c.ipc.toFixed(2) : '--'}</td>
        <td>${hasCore ? c.ghz.toFixed(2) : '--'}</td>
        <td>${hasCore ? c.l3HitPct.toFixed(1) + '%' : '--'}</td>
        <td>${hasCore ? c.latNs.toFixed(0) + ' ns' : '--'}</td>
        <td class="${hasDram ? '' : 'c-muted'}">${hasDram ? c.dramMpki.toFixed(2) : '--'}</td>
        <td class="c-dim">${c.avgC0.toFixed(0)}%</td>
      </tr>
    `).join('');

    const fmtThread = (cpuId) => {
      const duty = (hasCore || isNoPmu) ? snap.coreC0[cpuId] : snap.coreRelInstPct[cpuId];
      const ipcVal = snap.coreIpc[cpuId];
      const dpcIrq = (snap.coreDpcPct ? snap.coreDpcPct[cpuId] : 0) + (snap.coreIrqPct ? snap.coreIrqPct[cpuId] : 0);
      const dpcTip = `, DPC+IRQ ${dpcIrq.toFixed(1)}%`;
      if (duty < 2.0) {
        return `<span class="c-muted" title="CPU ${cpuId}: idle (${duty.toFixed(1)}%${dpcTip})">idle</span>`;
      }
      if (isNoPmu) {
        const cls = (duty >= 60.0 && dpcIrq >= 5.0) ? 'c-yellow' : (duty >= 15.0 ? 'c-green' : 'c-dim');
        return `<span class="${cls}" title="CPU ${cpuId}: Win32 C0 ${duty.toFixed(1)}%${dpcTip}">${Math.round(duty)}%</span>`;
      }
      if (!hasCore) {
        return `<span class="${duty >= 15.0 ? 'c-green' : 'c-dim'}" title="CPU ${cpuId}: ${duty.toFixed(1)}% relative instruction share${dpcTip}">${Math.round(duty)}%</span>`;
      }
      const ipcCls = ipcVal >= 1.25 ? 'c-green' : 'c-dim';
      return `<span class="${ipcCls}" title="CPU ${cpuId}: IPC ${ipcVal.toFixed(2)}, C0 ${duty.toFixed(1)}%${dpcTip}">${ipcVal.toFixed(2)}</span><span class="c-dim">(${Math.round(duty)}%)</span>`;
    };

    const makeCcxCoreRow = (ccxId) => {
      const physList = CONFIG.physicalCores.filter(p => p.ccx === ccxId);
      const cells = physList.map(pc => {
        const s0 = pc.siblings[0];
        const s1 = pc.siblings[1];
        const d0 = (hasCore || isNoPmu) ? snap.coreC0[s0] : snap.coreRelInstPct[s0];
        const d1 = s1 !== undefined ? ((hasCore || isNoPmu) ? snap.coreC0[s1] : snap.coreRelInstPct[s1]) : 0;
        const contended = s1 !== undefined && d0 >= 15.0 && d1 >= 15.0;
        const sep = s1 === undefined
          ? ''
          : (contended
            ? `<span class="c-yellow c-bright" title="SMT contention: both CPUs ${s0} &amp; ${s1} >= 15% active"> ⇄ </span>`
            : `<span class="c-muted"> │ </span>`);
        return `<span class="smt-pair"><span class="c-bright">P${pc.id}</span> ${fmtThread(s0)}${sep}${s1 !== undefined ? fmtThread(s1) : ''}</span>`;
      }).join('');
      const modeTag = hasCore ? 'IPC(C0%)' : (isNoPmu ? 'Win32 C0%' : 'rel-inst%');
      return `
        <div class="core-spark-row">
          <span class="c-dim">CCX${ccxId} ${modeTag}</span>
          ${cells}
        </div>
      `;
    };

    document.getElementById('core-spark-line').innerHTML = makeCcxCoreRow(0) + makeCcxCoreRow(1);
  }

  function renderCpiStack(snap) {
    const muxId = MUX_PRESETS[state.muxIndex].id;
    const sumEl = document.getElementById('cpi-summary');
    const legendEl = document.getElementById('cpi-legend');
    const actualEl = document.getElementById('cpi-track-actual');
    const modeledEl = document.getElementById('cpi-track-modeled');
    const lbl1 = document.getElementById('cpi-label-1');
    const lbl2 = document.getElementById('cpi-label-2');

    if (muxId === 'tlb' || muxId === 'no-pmu') {
      if (lbl1) lbl1.textContent = 'Actual';
      if (lbl2) lbl2.textContent = 'Modeled';
      const reason = muxId === 'no-pmu'
        ? `Hardware PMCs disabled (--no-pmu); Group A Zero-PMC Win32 diagnostics remain active on Tabs 1, 4 &amp; 5`
        : `Actual CPI requires cycles PMC or aperf (press 'm' for Full, IPC+Cache/DRAM, or Micro-Arch)`;
      sumEl.innerHTML = `<span class="c-bright">Exclusive CPI Stack</span> <span class="c-dim">│ ${reason}</span>`;
      legendEl.innerHTML = '';
      actualEl.innerHTML = `<span class="c-muted">N/A in ${getActiveMux().label} preset</span>`;
      modeledEl.innerHTML = '';
      return;
    }

    if (muxId === 'uarch' && snap.uarch) {
      const ua = snap.uarch;
      if (lbl1) lbl1.textContent = 'Actual';
      if (lbl2) lbl2.textContent = 'Decode';
      sumEl.innerHTML =
        `<span class="c-bright">Micro-Arch Front-End &amp; L3 (0-Mux)</span>` +
        `<span class="c-dim"> │ </span>Actual CPI (aperf) <span class="c-bright">${snap.actualCpi.toFixed(2)}</span>` +
        `<span class="c-dim"> │ </span>Op-Cache <span class="${ua.legacyDecodePct >= 30.0 ? 'c-yellow c-bright' : 'c-green'}">${ua.opcacheHitPct.toFixed(1)}%</span>` +
        `<span class="c-dim"> │ </span>L3 Hit <span class="c-bright">${snap.l3HitPct.toFixed(1)}%</span> @ <span class="${severityClass(snap.l3LatCyc, 220, 270)}">${snap.l3LatNs.toFixed(1)} ns (${snap.l3LatCyc.toFixed(0)} cyc)</span>`;

      legendEl.innerHTML =
        `<span><span class="c-muted">Decode:</span> <span style="color:var(--green)">█</span> Op-Cache (8-wide) <span style="color:${ua.legacyDecodePct >= 30.0 ? 'var(--red)' : 'var(--orange)'}">█</span> Legacy (4-wide)</span>`;

      const wrapW = Math.max(220, actualEl.getBoundingClientRect().width - 8);
      const actScale = Math.max(snap.actualCpi, 1.5) * 1.15;
      const actualPx = Math.max(36, Math.min(wrapW, Math.round((snap.actualCpi / actScale) * wrapW)));
      const actTxt = actualPx >= 96 ? `Actual ${snap.actualCpi.toFixed(2)} (aperf)` : `CPI ${snap.actualCpi.toFixed(2)}`;
      actualEl.innerHTML =
        `<span class="cpi-actual-fill" style="width:${actualPx}px;" title="Actual CPI derived from fixed MSR aperf / irperf: ${snap.actualCpi.toFixed(3)}">${actTxt}</span>` +
        `<span class="cpi-marker" title="Actual CPI boundary (${snap.actualCpi.toFixed(3)})"></span>` +
        `<span class="c-dim" style="margin-left: 8px; font-size: 11.5px;">0-Mux: 6 Core PMCs + 3 Fixed MSRs + 4 L3 PMCs</span>`;

      const ocPx = Math.max(12, Math.round((ua.opcacheHitPct / 100.0) * wrapW));
      const decPx = Math.max(4, wrapW - ocPx);
      const decHex = ua.legacyDecodePct >= 30.0 ? '#e06464' : '#d98d59';
      const ocLbl = ocPx >= 95 ? `Op-Cache ${ua.opcacheHitPct.toFixed(1)}%` : (ocPx >= 36 ? `${ua.opcacheHitPct.toFixed(0)}%` : '');
      const decLbl = decPx >= 86 ? `Legacy ${ua.legacyDecodePct.toFixed(1)}%` : (decPx >= 32 ? `${ua.legacyDecodePct.toFixed(0)}%` : '');
      modeledEl.innerHTML =
        `<span class="cpi-seg" style="width:${ocPx}px; background:#5dc27f;" title="Op-Cache dispatched ops (0x4302AA): ${ua.opcacheHitPct.toFixed(1)}%">${ocLbl}</span>` +
        `<span class="cpi-seg" style="width:${decPx}px; background:${decHex};" title="Legacy 4-wide x86 decoder ops (0x4301AA): ${ua.legacyDecodePct.toFixed(1)}%">${decLbl}</span>`;
      return;
    }

    if (lbl1) lbl1.textContent = 'Actual';
    if (lbl2) lbl2.textContent = 'Modeled';

    const active = snap.activeTiers.filter(t => t.cpi > 0.0005);
    const modeledCpi = snap.modeledCpi;
    const actualCpi = snap.actualCpi;
    const oooHidden = snap.oooHiddenCpi;
    const oooPct = modeledCpi > 0.001 ? Math.round((oooHidden / modeledCpi) * 100) : 0;

    sumEl.innerHTML =
      `<span class="c-bright">Exclusive CPI Stack</span>` +
      `<span class="c-dim"> │ </span>Actual <span class="c-bright">${actualCpi.toFixed(2)}</span>` +
      `<span class="c-dim"> │ </span>Modeled <span class="c-bright">${modeledCpi.toFixed(2)}</span>` +
      `<span class="c-dim"> │ </span>OoO/MLP hides <span class="c-cyan">${oooHidden > 0.005 ? oooHidden.toFixed(2) + ' (' + oooPct + '%)' : '0.00'}</span>`;

    const flushTiers = active.filter(t => t.group === 'flush');
    const mlpTiers = active.filter(t => t.group === 'mlp');
    const fmtLeg = list => list.map(t => `<span><span style="color:${t.barColor}">█</span> ${t.short}</span>`).join(' ');
    legendEl.innerHTML =
      `<span><span class="c-muted">Flush:</span> ${fmtLeg(flushTiers)}</span>` +
      `<span><span class="c-muted">MLP:</span> ${fmtLeg(mlpTiers)}</span>`;

    // Measure exact available pixel width so Actual & Modeled share identical horizontal scale (NEVER normalized to 100%)
    const wrapW = Math.max(220, actualEl.getBoundingClientRect().width - 8);
    const maxScale = Math.max(actualCpi, modeledCpi, 0.4) * 1.06;
    const actualPx = Math.max(24, Math.round((actualCpi / maxScale) * wrapW));
    const modeledPx = Math.max(24, Math.round((modeledCpi / maxScale) * wrapW));
    const oooPx = Math.max(0, modeledPx - actualPx);

    const actTxt = actualPx >= 64 ? `Actual ${actualCpi.toFixed(2)}` : (actualPx >= 36 ? actualCpi.toFixed(2) : '');
    const oooTxt = oooPx >= 96 ? `OoO/MLP +${oooHidden.toFixed(2)}` : (oooPx >= 46 ? `+${oooHidden.toFixed(2)}` : '');

    actualEl.innerHTML =
      `<span class="cpi-actual-fill" style="width:${actualPx}px;" title="Actual Measured CPI: ${actualCpi.toFixed(3)}">${actTxt}</span>` +
      `<span class="cpi-marker" title="Actual CPI boundary (${actualCpi.toFixed(3)})"></span>` +
      (oooPx > 2 ? `<span class="cpi-ooo-fill" style="width:${oooPx}px;" title="OoO/MLP overlapped latency hidden: ${oooHidden.toFixed(3)} CPI">${oooTxt}</span>` : '');

    // Modeled track: Flush left, MLP right, exact pixel sum = modeledPx
    const totalMod = Math.max(0.001, active.reduce((a, t) => a + t.cpi, 0));
    const ordered = [...flushTiers, ...mlpTiers];
    const rawPx = ordered.map(t => (t.cpi / totalMod) * modeledPx);
    const intPx = rawPx.map(w => Math.floor(w));
    let rem = modeledPx - intPx.reduce((a, b) => a + b, 0);
    const fracOrder = rawPx.map((w, i) => ({ i, frac: w - intPx[i] })).sort((a, b) => b.frac - a.frac);
    for (let k = 0; k < rem && k < fracOrder.length; k++) intPx[fracOrder[k].i] += 1;

    let modHtml = '';
    for (let i = 0; i < ordered.length; i++) {
      const t = ordered[i];
      const w = intPx[i];
      if (w <= 0) continue;
      if (i > 0 && ordered[i - 1].group !== t.group) {
        modHtml += `<span class="cpi-group-gap"></span>`;
      }
      const pct = Math.round((t.cpi / totalMod) * 100);
      const minLblW = t.short.length * 7 + 22;
      const label = w >= minLblW ? `${t.short} ${pct}%` : (w >= 26 ? `${pct}%` : '');
      modHtml += `<span class="cpi-seg" style="width:${w}px; background:${t.hex};" title="${t.name} (${t.group.toUpperCase()}): ${t.cpi.toFixed(3)} CPI (${pct}% of modeled stalls)">${label}</span>`;
    }
    modeledEl.innerHTML = modHtml;
  }

  function renderTab1Overview() {
    const snap = state.lastSnap;
    if (!snap) return;
    const muxId = MUX_PRESETS[state.muxIndex].id;
    const base = state.activeBaseline;
    const hasIpc = muxId !== 'tlb' && muxId !== 'no-pmu';
    const isUarch = muxId === 'uarch';
    const avgIpc = state.cum.samples > 0 ? state.cum.ipc / state.cum.samples : snap.ipc;

    // 1. Top Colored Braille Graphs
    const ipcTitleEl = document.getElementById('g-ipc-title');
    if (ipcTitleEl) ipcTitleEl.textContent = isUarch ? 'IPC (aperf)' : 'IPC';

    const ipcColor = !hasIpc ? 'var(--fg-muted)' : (snap.ipc >= 1.2 ? 'var(--green)' : (snap.ipc >= 0.85 ? 'var(--cyan)' : 'var(--yellow)'));
    const ipcHeader = hasIpc
      ? `<span class="${severityClass(snap.ipc, 1.2, 0.75, true)} c-bright">${snap.ipc.toFixed(2)}</span>` +
        `${fmtDeltaPct(snap.ipc, base ? base.ipc : null, true)}` +
        `<span class="c-muted">│</span>` +
        `${formatRetiringTag(snap.retiringPct, snap.retiringExact)}` +
        `<span class="c-muted">│</span>` +
        `<span class="c-dim">avg ${avgIpc.toFixed(2)}</span>` +
        `<span class="c-muted">│</span>` +
        `<span class="c-dim">Inst</span> <span>${fmtRate(snap.instPerSec)}</span>` +
        `<span class="c-dim">${isUarch ? 'aperf' : 'Cyc'}</span> <span>${fmtRate(isUarch ? snap.aperfPerSec : snap.cycPerSec)}</span>`
      : (muxId === 'no-pmu'
        ? `<span class="c-dim">N/A (No-PMU Win32-Only) │ Zero-PMC Advisor Active</span>`
        : `<span class="c-dim">N/A (TLB-Only 0-Mux) │ Inst ${fmtRate(snap.instPerSec)}</span>`);
    document.getElementById('g-ipc-stats').innerHTML = ipcHeader;

    renderBrailleGraph(
      document.getElementById('g-ipc-canvas'),
      document.getElementById('g-ipc-axis'),
      hasIpc ? state.history.ipc : state.history.ipc.map(() => 0),
      { minVal: 0.4, baseline: (hasIpc && base) ? base.ipc : null, color: ipcColor }
    );

    const theadEl = document.getElementById('overview-stall-thead');
    const tbodyEl = document.getElementById('overview-stall-tbody');

    if (isUarch && snap.uarch) {
      const ua = snap.uarch;
      const cumUa = computeMicroArchMetrics({
        inst: state.cum.instRaw,
        dc_cross_ccx: state.cum.dcCrossCcxRaw,
        locks_serial: state.cum.locksSerialRaw,
        dec_uops: state.cum.decUopsRaw,
        oc_uops: state.cum.ocUopsRaw,
        stlf_interlock: state.cum.stlfInterlockRaw,
        misal_access: state.cum.misalAccessRaw
      }, 'uarch') || ua;

      const uarchRows = [
        {
          key: 'dcCrossCcx',
          name: 'Cross-CCX Fills',
          hex: '0x430443',
          unit: 'MPKI',
          live: ua.dcCrossCcxMpki,
          avg: cumUa.dcCrossCcxMpki,
          baseVal: base ? base.dcCrossCcxMpki : null,
          higherIsBetter: false,
          sev: ua.dcCrossCcxMpki >= 2.0 ? 'HI' : (ua.dcCrossCcxMpki >= 0.8 ? 'MD' : 'OK'),
          scaleMax: 3.5,
          barColor: ua.dcCrossCcxMpki >= 2.0 ? 'var(--red)' : (ua.dcCrossCcxMpki >= 0.8 ? 'var(--yellow)' : 'var(--cyan)'),
          graphTitle: 'Cross-CCX Fills MPKI',
          series: state.history.dcCrossCcx
        },
        {
          key: 'locksSerial',
          name: 'Serialized Locks',
          hex: '0x430325',
          unit: 'MPKI',
          live: ua.locksSerialMpki,
          avg: cumUa.locksSerialMpki,
          baseVal: base ? base.locksSerialMpki : null,
          higherIsBetter: false,
          sev: (ua.locksSerialMpki >= 0.5 && ua.dcCrossCcxMpki >= 0.5) ? 'HI' : (ua.locksSerialMpki >= 1.0 ? 'MD' : 'OK'),
          scaleMax: 1.8,
          barColor: (ua.locksSerialMpki >= 0.5 && ua.dcCrossCcxMpki >= 0.5) ? 'var(--red)' : (ua.locksSerialMpki >= 1.0 ? 'var(--yellow)' : 'var(--orange)'),
          graphTitle: 'Serialized Locks MPKI',
          series: state.history.locksSerial
        },
        {
          key: 'legacyDecodePct',
          name: 'Legacy Decode %',
          hex: '0x4301AA',
          unit: '%',
          live: ua.legacyDecodePct,
          avg: cumUa.legacyDecodePct,
          baseVal: base ? base.legacyDecodePct : null,
          higherIsBetter: false,
          sev: ua.legacyDecodePct >= 30.0 ? 'MD' : 'OK',
          scaleMax: 50.0,
          barColor: ua.legacyDecodePct >= 30.0 ? 'var(--yellow)' : 'var(--orange)',
          graphTitle: 'Legacy Decode %',
          series: state.history.legacyDecodePct
        },
        {
          key: 'opcacheHitPct',
          name: 'Op-Cache Hit %',
          hex: '0x4302AA',
          unit: '%',
          live: ua.opcacheHitPct,
          avg: cumUa.opcacheHitPct,
          baseVal: base ? base.opcacheHitPct : null,
          higherIsBetter: true,
          sev: ua.opcacheHitPct <= 70.0 ? 'MD' : 'OK',
          scaleMax: 100.0,
          barColor: ua.opcacheHitPct <= 70.0 ? 'var(--yellow)' : 'var(--green)',
          graphTitle: 'Op-Cache Hit %',
          series: state.history.opcacheHitPct
        },
        {
          key: 'stlfInterlock',
          name: 'STLF Interlocks',
          hex: '0x430224',
          unit: 'MPKI',
          live: ua.stlfInterlockMpki,
          avg: cumUa.stlfInterlockMpki,
          baseVal: base ? base.stlfInterlockMpki : null,
          higherIsBetter: false,
          sev: ua.stlfInterlockMpki >= 3.0 ? 'MD' : 'OK',
          scaleMax: 6.0,
          barColor: ua.stlfInterlockMpki >= 3.0 ? 'var(--yellow)' : 'var(--magenta)',
          graphTitle: 'STLF Interlocks MPKI',
          series: state.history.stlfInterlock
        },
        {
          key: 'misalAccess',
          name: 'Cache-Line Splits',
          hex: '0x430047',
          unit: 'MPKI',
          live: ua.misalAccessMpki,
          avg: cumUa.misalAccessMpki,
          baseVal: base ? base.misalAccessMpki : null,
          higherIsBetter: false,
          sev: ua.misalAccessMpki >= 20.0 ? 'MD' : (ua.misalAccessMpki >= 10.0 ? 'LO' : 'OK'),
          scaleMax: 30.0,
          barColor: ua.misalAccessMpki >= 20.0 ? 'var(--yellow)' : (ua.misalAccessMpki >= 10.0 ? 'var(--cyan)' : 'var(--blue)'),
          graphTitle: 'Cache-Line Splits MPKI',
          series: state.history.misalAccess
        }
      ];

      // Pick top-right graph: default to Cross-CCX Fills MPKI when active or when all are OK; else highest-severity active micro-arch stall
      const sevWeight = { HI: 3, MD: 2, LO: 1, OK: 0 };
      const activeStallRows = uarchRows.filter(r => r.key !== 'opcacheHitPct' && sevWeight[r.sev] > 0);
      const topGraphRow = (sevWeight[uarchRows[0].sev] >= 2 || activeStallRows.length === 0)
        ? uarchRows[0]
        : [...activeStallRows].sort((a, b) => (sevWeight[b.sev] - sevWeight[a.sev]) || ((b.live / b.scaleMax) - (a.live / a.scaleMax)))[0];

      const fmtVal = (v, unit) => unit === '%' ? `${v.toFixed(1)}%` : (v < 1.0 ? v.toFixed(3) : v.toFixed(2));
      const topSevCls = topGraphRow.sev === 'HI' ? 'c-red' : (topGraphRow.sev === 'MD' ? 'c-yellow' : (topGraphRow.sev === 'LO' ? 'c-cyan' : 'c-green'));

      document.getElementById('g-top-title').textContent = topGraphRow.graphTitle;
      document.getElementById('g-top-stats').innerHTML =
        `<span class="${topSevCls} c-bright">${fmtVal(topGraphRow.live, topGraphRow.unit)}</span>` +
        `${fmtDeltaPct(topGraphRow.live, topGraphRow.baseVal, topGraphRow.higherIsBetter)}` +
        `<span class="c-muted">│</span>` +
        `<span class="c-dim">avg ${fmtVal(topGraphRow.avg, topGraphRow.unit)}</span>`;

      renderBrailleGraph(
        document.getElementById('g-top-canvas'),
        document.getElementById('g-top-axis'),
        topGraphRow.series,
        { minVal: 0, baseline: topGraphRow.baseVal, color: topGraphRow.barColor }
      );

      // 2. Micro-Arch Front-End & Execution Strip
      renderCpiStack(snap);

      // 3. Dedicated 6-row Micro-Arch & Contention Table (zero empty '--' rows)
      if (theadEl) {
        theadEl.innerHTML = `
          <tr>
            <th class="left">MICRO-ARCH &amp; CONTENTION</th>
            <th>LIVE</th>
            <th>AVG</th>
            <th>vs BASE</th>
            <th>SEVERITY</th>
            <th>IMPACT BAR</th>
          </tr>
        `;
      }

      const topActiveKey = activeStallRows.length > 0 ? topGraphRow.key : null;
      const sevBadge = s => {
        if (s === 'HI') return `<span class="sev-hi">HI</span>`;
        if (s === 'MD') return `<span class="sev-md">MD</span>`;
        if (s === 'LO') return `<span class="sev-lo">LO</span>`;
        return `<span class="c-green">OK</span>`;
      };

      tbodyEl.innerHTML = uarchRows.map(r => {
        const isTop = r.key === topActiveKey;
        const prefix = isTop ? `<span class="c-red c-bright">&gt;&gt; </span>` : `<span class="c-muted">   </span>`;
        const ratio = Math.max(0.0, Math.min(1.0, r.live / r.scaleMax));
        const barLen = Math.max(1, Math.round(ratio * 20));
        const barStr = '█'.repeat(barLen) + '·'.repeat(20 - barLen);
        const liveStr = r.unit === '%' ? `${r.live.toFixed(1)}%` : `${r.live < 1.0 ? r.live.toFixed(3) : r.live.toFixed(2)} MPKI`;
        const avgStr = r.unit === '%' ? `${r.avg.toFixed(1)}%` : (r.avg < 1.0 ? r.avg.toFixed(3) : r.avg.toFixed(2));
        return `
          <tr class="${isTop ? 'top-bottleneck' : ''}" title="${r.name} (${r.hex})">
            <td class="left ${isTop ? 'c-bright' : ''}">${prefix}${r.name}</td>
            <td class="${isTop ? 'c-bright' : ''}">${liveStr}</td>
            <td class="c-dim">${avgStr}</td>
            <td>${fmtDeltaPct(r.live, r.baseVal, r.higherIsBetter)}</td>
            <td>${sevBadge(r.sev)}</td>
            <td style="font-size: 12px;"><span style="color:${r.sev !== 'OK' || r.key === 'opcacheHitPct' ? r.barColor : 'var(--fg-dim)'}">${barStr.slice(0, barLen)}</span><span class="c-muted">${barStr.slice(barLen)}</span></td>
          </tr>
        `;
      }).join('');
    } else {
      const topTier = snap.topTier;
      const topBaseKey = {
        dram: 'dramMpki', l3Hit: 'l3HitMpki', l2dcExcl: 'l2dcExclMpki',
        l2icExcl: 'l2icExclMpki', branch: 'branchMpki', l2dtlb: 'l2dtlbMpki', l2itlb: 'l2itlbMpki'
      }[topTier.key];
      const topAvg = state.cum.samples > 0 ? state.cum[topTier.key] / state.cum.samples : topTier.mpki;

      document.getElementById('g-top-title').textContent = `Top Stall: ${topTier.name} MPKI`;
      document.getElementById('g-top-stats').innerHTML =
        `<span class="${topTier.colorClass} c-bright">${topTier.mpki.toFixed(2)}</span>` +
        `${fmtDeltaPct(topTier.mpki, base ? base[topBaseKey] : null, false)}` +
        `<span class="c-muted">│</span>` +
        `<span class="c-dim">avg ${topAvg.toFixed(2)}</span>`;

      renderBrailleGraph(
        document.getElementById('g-top-canvas'),
        document.getElementById('g-top-axis'),
        state.history.topStall,
        { minVal: 0, baseline: base ? base[topBaseKey] : null, color: topTier.barColor }
      );

      // 2. Two-Line Exclusive CPI Stack
      renderCpiStack(snap);

      // 3. Unified Stall Table
      if (theadEl) {
        theadEl.innerHTML = `
          <tr>
            <th class="left">STALL SOURCE</th>
            <th>LIVE MPKI</th>
            <th>AVG</th>
            <th>vs BASE</th>
            <th>EST CPI</th>
            <th>IMPACT BAR</th>
          </tr>
        `;
      }

      const rowsData = snap.tableTiers.map(t => {
        const enabled = t.avail.includes(muxId);
        const baseKey = {
          dram: 'dramMpki', l3Hit: 'l3HitMpki', l2dcExcl: 'l2dcExclMpki',
          l2icExcl: 'l2icExclMpki', branch: 'branchMpki', l2dtlb: 'l2dtlbMpki', l2itlb: 'l2itlbMpki'
        }[t.key];
        const avgVal = state.cum.samples > 0 ? state.cum[t.key] / state.cum.samples : t.mpki;
        return { ...t, enabled, baseVal: base ? base[baseKey] : null, avgVal };
      });

      const maxCpi = Math.max(0.05, ...rowsData.filter(r => r.enabled).map(r => r.cpi));
      const topKey = snap.topTier.key;

      tbodyEl.innerHTML = rowsData.map(r => {
        const isTop = r.enabled && r.key === topKey;
        const prefix = isTop ? `<span class="c-red c-bright">&gt;&gt; </span>` : `<span class="c-muted">   </span>`;
        if (!r.enabled) {
          return `
            <tr class="c-muted">
              <td class="left">${prefix}${r.name}</td>
              <td>--</td><td>--</td><td>--</td><td>--</td>
              <td class="c-muted">not in ${getActiveMux().label}</td>
            </tr>
          `;
        }
        const barLen = Math.max(1, Math.round((r.cpi / maxCpi) * 20));
        const barStr = '█'.repeat(barLen) + '·'.repeat(20 - barLen);
        const mpkiDisp = r.mpki < 1.0 ? r.mpki.toFixed(3) : r.mpki.toFixed(2);
        const avgDisp = r.avgVal < 1.0 ? r.avgVal.toFixed(3) : r.avgVal.toFixed(2);
        return `
          <tr class="${isTop ? 'top-bottleneck' : ''}">
            <td class="left ${isTop ? 'c-bright' : ''}">${prefix}${r.name}</td>
            <td class="${isTop ? 'c-bright' : ''}">${mpkiDisp}</td>
            <td class="c-dim">${avgDisp}</td>
            <td>${fmtDeltaPct(r.mpki, r.baseVal, false)}</td>
            <td class="${isTop ? r.colorClass + ' c-bright' : ''}">${r.cpi.toFixed(3)}</td>
            <td style="font-size: 12px;"><span style="color:${isTop ? r.barColor : 'var(--fg-dim)'}">${barStr.slice(0, barLen)}</span><span class="c-muted">${barStr.slice(barLen)}</span></td>
          </tr>
        `;
      }).join('');
    }

    // 4. Bottom 1-line OS Summary (strict anti-clutter: append GPU XX% when D3DKMT available; color yellow/red only >=97%)
    const proc = getAttachedProcess();
    const footerEl = document.getElementById('overview-footer');
    const pfCls = snap.pfRate >= 2000 ? 'c-red' : (snap.pfRate >= 500 ? 'c-yellow' : '');
    const gpuHtml = snap.gpu3dPct !== null
      ? (() => {
          const gpuCls = snap.gpu3dPct >= 98.5 ? 'c-red c-bright' : (snap.gpu3dPct >= 97.0 ? 'c-yellow c-bright' : '');
          return `<span class="sep">│</span>GPU <span class="${gpuCls}">${Math.round(snap.gpu3dPct)}%</span>`;
        })()
      : '';
    if (proc) {
      const totalReal = proc.hugeMiB + proc.wsMiB;
      const hugePct = totalReal > 0 ? ((proc.hugeMiB / totalReal) * 100).toFixed(0) : '0';
      const smallPct = (100 - Number(hugePct)).toFixed(0);
      footerEl.innerHTML =
        `<span>CPU <span class="c-bright">${(snap.cpuUsr + snap.cpuSys).toFixed(1)}%</span> <span class="c-dim">(usr ${snap.cpuUsr.toFixed(1)}% / sys <span class="${snap.cpuSys >= 15 ? 'c-yellow' : ''}">${snap.cpuSys.toFixed(1)}%</span>)</span>` +
        `${gpuHtml}` +
        `<span class="sep">│</span>Page Faults <span class="${pfCls}">${snap.pfRate.toLocaleString()}/s</span>` +
        `<span class="sep">│</span>RAM 2 MiB: <span class="${proc.hugeMiB > 0 ? 'c-green' : 'c-yellow'}">${fmtMiB(proc.hugeMiB)} (${hugePct}%)</span> vs 4 KiB: ${fmtMiB(proc.wsMiB)} (${smallPct}%)</span>` +
        `<span class="c-dim">Real Physical: ${fmtMiB(totalReal)}</span>`;
    } else {
      footerEl.innerHTML =
        `<span>Scope <span class="c-bright">System-Wide (12 Logical CPUs)</span>` +
        `<span class="sep">│</span>CPU usr ${snap.cpuUsr.toFixed(1)}% / sys ${snap.cpuSys.toFixed(1)}%` +
        `${gpuHtml}` +
        `<span class="sep">│</span>Page Faults ~${snap.pfRate.toLocaleString()}/s</span>` +
        `<span class="c-dim">Press 'p' or '4' to attach a process</span>`;
    }
  }

  Object.assign(Z, { renderChrome, renderCcxStrip, renderCpiStack, renderTab1Overview });
})();
