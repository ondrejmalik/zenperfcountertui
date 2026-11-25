// Top/bottom chrome, CCX/SMT strip, CPI stack, and pack-driven Tab 1 Overview renderer
(() => {
  'use strict';
  const Z = window.Zen2Top || (window.Zen2Top = {});
  const {
    CONFIG, MetricPack, state, computeMicroArchMetrics, getActivePlan,
    formatMuxShort, getMuxAccuracyClass, getAttachedProcess,
    fmtDeltaPct, fmtMiB, fmtRate, formatRetiringTag, severityClass, renderBrailleGraph
  } = Z;

  // =========================================================================
  // 7. RENDER FUNCTIONS
  // =========================================================================
  function renderChrome() {
    const proc = getAttachedProcess();
    const plan = getActivePlan();
    const snap = state.lastSnap;

    const targetEl = document.getElementById('hdr-target');
    if (state.waitingTarget) {
      targetEl.innerHTML = `<span class="c-yellow">WAITING: ${state.waitingTarget}</span>`;
    } else if (proc) {
      targetEl.innerHTML = `<span class="c-bright">${proc.name}</span> <span class="c-dim">(${proc.pid})</span>`;
    } else {
      targetEl.innerHTML = `<span class="c-cyan c-bright">SYSTEM-WIDE</span>`;
    }

    const muxCls = getMuxAccuracyClass(plan.muxGroups);
    document.getElementById('hdr-mux').innerHTML = `<span class="${muxCls}">${plan.label}</span>`;
    document.getElementById('hdr-ghz').textContent = (plan.noPmu || !snap) ? 'GHz N/A' : `${snap.effGhz.toFixed(2)} GHz`;

    const baseEl = document.getElementById('hdr-base');
    if (state.activeBaseline) {
      const baseGroups = state.activeBaseline.muxGroups ?? state.activeBaseline.mux_groups ?? 3;
      const muxDiff = !plan.noPmu && plan.muxGroups !== baseGroups;
      const diffTag = muxDiff
        ? ` <span class="c-red c-bright">[MUX DIFF (${formatMuxShort(plan.muxGroups)} vs ${formatMuxShort(baseGroups)})]</span>`
        : '';
      baseEl.innerHTML = `Base: <span class="c-bright">${state.activeBaseline.name}</span>${diffTag}`;
    } else {
      baseEl.innerHTML = `Base: <span class="c-dim">none</span>`;
    }

    const stEl = document.getElementById('hdr-state');
    if (state.pmcLocked) {
      stEl.innerHTML = `<span class="c-red c-bright">PMC LOCKED</span>`;
    } else if (state.profiler && state.profiler.burstCapture) {
      stEl.innerHTML = `<span class="c-cyan c-bright">BURST ${Math.max(0, state.profiler.burstCapture.remainingSec)}s</span>`;
    } else if (state.timedCapture) {
      stEl.innerHTML = `<span class="c-cyan c-bright">CAPTURE ${Math.max(0, state.timedCapture.remainingSec)}s</span>`;
    } else if (state.paused) {
      stEl.innerHTML = `<span class="c-yellow c-bright">PAUSED</span>`;
    } else {
      stEl.innerHTML = `<span class="c-green c-bright">LIVE</span>`;
    }

    // Tabs (1-7 with subtle red (N) badge on Advisor when HI findings exist)
    const labels = { 1: 'Overview', 2: 'Cache', 3: 'TLB', 4: 'Memory', 5: 'Advisor', 6: 'Threads', 7: 'Profiler' };
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
    } else if (state.activeTab === 4 && proc) {
      hintEl.textContent = 'v Toggle VA/JIT Map │ Space Pause │ d Detach';
    } else if (state.activeTab === 5) {
      hintEl.textContent = 'j/k Select │ Enter Jump │ f HW Burst │ m Packs';
    } else if (state.activeTab === 6 && proc) {
      hintEl.textContent = 'j/k Select Thread │ s Sort │ a Affinity │ R Revert Edits';
    } else if (state.activeTab === 7 && proc) {
      hintEl.textContent = 'o On/Off-CPU │ f HW Burst │ v Flat/Tree │ t Scope │ e Pause ETW │ r Clear │ / Filter';
    } else if ((state.activeTab === 4 || state.activeTab === 6 || state.activeTab === 7) && !proc) {
      hintEl.textContent = '/ Filter │ s Sort │ Enter Attach │ w Wait Mode';
    } else {
      hintEl.textContent = 'm Packs │ M Fast Preset │ Space Pause │ c CCX+SMT';
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
    } else if (state.profiler && state.profiler.burstCapture) {
      const cap = state.profiler.burstCapture;
      banner.className = 'status-banner visible burst';
      bText.textContent = `Hardware Burst Capture [${cap.label}]: ${Math.max(0, cap.remainingSec)}s left... (AMDuProfPcm paused, hardware PMCs released for AMDuProfCLI)`;
      bAct.innerHTML = `<button class="banner-action" id="btn-cancel-burst">Cancel &amp; Resume PCM (Esc)</button>`;
      document.getElementById('btn-cancel-burst').onclick = () => Z.cancelHardwareBurst();
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

  // GLOBAL CCX + PHYSICAL-CORE SMT SIBLING STRIP (Always-On Free Base IPC/GHz/L3/C0%)
  function renderCcxStrip() {
    const strip = document.getElementById('ccx-strip');
    strip.classList.toggle('visible', state.ccxOpen);
    if (!state.ccxOpen || !state.lastSnap) return;

    const snap = state.lastSnap;
    const plan = getActivePlan();
    const isNoPmu = plan.noPmu;
    const hasFreeBase = !isNoPmu;
    const hasDram = plan.has(MetricPack.DcDemand);

    document.getElementById('ccx-tbody').innerHTML = snap.ccx.map(c => `
      <tr>
        <td class="c-bright">CCX${c.id}</td>
        <td class="c-dim">${c.cpus}</td>
        <td class="${hasFreeBase ? severityClass(c.ipc, 1.2, 0.8, true) : 'c-muted'}">${hasFreeBase ? c.ipc.toFixed(2) : '--'}</td>
        <td>${hasFreeBase ? c.ghz.toFixed(2) : '--'}</td>
        <td>${hasFreeBase ? c.l3HitPct.toFixed(1) + '%' : '--'}</td>
        <td>${hasFreeBase ? c.latNs.toFixed(0) + ' ns' : '--'}</td>
        <td class="${hasDram ? '' : 'c-muted'}">${hasDram ? c.dramMpki.toFixed(2) : '--'}</td>
        <td class="c-dim">${c.avgC0.toFixed(0)}%</td>
      </tr>
    `).join('');

    const fmtThread = (cpuId) => {
      const duty = snap.coreC0[cpuId];
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
      const ipcCls = ipcVal >= 1.25 ? 'c-green' : 'c-dim';
      return `<span class="${ipcCls}" title="CPU ${cpuId}: IPC ${ipcVal.toFixed(2)}, C0 ${duty.toFixed(1)}%${dpcTip}">${ipcVal.toFixed(2)}</span><span class="c-dim">(${Math.round(duty)}%)</span>`;
    };

    const makeCcxCoreRow = (ccxId) => {
      const physList = CONFIG.physicalCores.filter(p => p.ccx === ccxId);
      const cells = physList.map(pc => {
        const s0 = pc.siblings[0];
        const s1 = pc.siblings[1];
        const d0 = snap.coreC0[s0];
        const d1 = s1 !== undefined ? snap.coreC0[s1] : 0;
        const contended = s1 !== undefined && d0 >= 15.0 && d1 >= 15.0;
        const sep = s1 === undefined
          ? ''
          : (contended
            ? `<span class="c-yellow c-bright" title="SMT contention: both CPUs ${s0} &amp; ${s1} >= 15% active"> ⇄ </span>`
            : `<span class="c-muted"> │ </span>`);
        return `<span class="smt-pair"><span class="c-bright">P${pc.id}</span> ${fmtThread(s0)}${sep}${s1 !== undefined ? fmtThread(s1) : ''}</span>`;
      }).join('');
      const modeTag = hasFreeBase ? 'IPC(C0%)' : 'Win32 C0%';
      return `
        <div class="core-spark-row">
          <span class="c-dim">CCX${ccxId} ${modeTag}</span>
          ${cells}
        </div>
      `;
    };

    document.getElementById('core-spark-line').innerHTML = makeCcxCoreRow(0) + makeCcxCoreRow(1);
  }

  function buildDecodeBarHtml(ua, wrapW) {
    const ocPx = Math.max(12, Math.round((ua.opcacheHitPct / 100.0) * wrapW));
    const decPx = Math.max(4, wrapW - ocPx);
    const decHex = ua.legacyDecodePct >= 30.0 ? '#e06464' : '#d98d59';
    const ocLbl = ocPx >= 95 ? `Op-Cache ${ua.opcacheHitPct.toFixed(1)}%` : (ocPx >= 36 ? `${ua.opcacheHitPct.toFixed(0)}%` : '');
    const decLbl = decPx >= 86 ? `Legacy ${ua.legacyDecodePct.toFixed(1)}%` : (decPx >= 32 ? `${ua.legacyDecodePct.toFixed(0)}%` : '');
    return (
      `<span class="cpi-seg" style="width:${ocPx}px; background:#5dc27f;" title="Op-Cache dispatched ops (0x4302AA): ${ua.opcacheHitPct.toFixed(1)}%">${ocLbl}</span>` +
      `<span class="cpi-seg" style="width:${decPx}px; background:${decHex};" title="Legacy 4-wide x86 decoder ops (0x4301AA): ${ua.legacyDecodePct.toFixed(1)}%">${decLbl}</span>`
    );
  }

  function ensureUarchTrackRow(decodeRowEl) {
    let row = document.getElementById('cpi-row-uarch');
    let track = document.getElementById('cpi-track-uarch');
    if (row && track) return { row, track };
    const region = document.querySelector('.cpi-region');
    if (!region) return { row: null, track: null };
    row = document.createElement('div');
    row.className = 'cpi-track-row is-hidden';
    row.id = 'cpi-row-uarch';
    row.innerHTML = `<span class="cpi-track-label" id="cpi-label-uarch">uArch (est)</span><div class="cpi-bar-wrap" id="cpi-track-uarch"></div>`;
    if (decodeRowEl && decodeRowEl.parentNode === region) {
      region.insertBefore(row, decodeRowEl);
    } else {
      region.appendChild(row);
    }
    track = document.getElementById('cpi-track-uarch');
    return { row, track };
  }

  function buildUarchBoundBarHtml(activeBounds, totalCpi, hasUnboundedFloor, maxScale, wrapW) {
    let html = '';
    for (const t of activeBounds) {
      const w = Math.max(4, Math.round((t.cpi / maxScale) * wrapW));
      const minLblW = t.short.length * 7 + 8;
      const lbl = w >= minLblW ? t.short : (w >= 18 ? t.short.slice(0, 2) : '');
      const boundDetail = t.boundKind === 'floor'
        ? `uncontended floor (${t.prefix}${t.cpi.toFixed(3)} CPI; real contention may stall 200-400+ cyc and overlap L3/CCX/DRAM)`
        : `upper bound (${t.prefix}${t.cpi.toFixed(3)} CPI; partially hidden by Zen 2 224-entry ROB)`;
      html += `<span class="cpi-uarch-seg" style="width:${w}px; --seg-color:${t.hex};" title="${t.name}: ${boundDetail}">${lbl}</span>`;
    }
    const sumTag = `~${totalCpi.toFixed(2)}${hasUnboundedFloor ? '+' : ''}`;
    html += `<span class="cpi-uarch-note" title="Scale-matched overlapping micro-arch bounds (NOT added to Exclusive Modeled CPI or OoO/MLP)">${sumTag} (overlaps above)</span>`;
    return html;
  }

  function renderCpiStack(snap, plan) {
    const sumEl = document.getElementById('cpi-summary');
    const legendEl = document.getElementById('cpi-legend');
    const actualEl = document.getElementById('cpi-track-actual');
    const modeledEl = document.getElementById('cpi-track-modeled');
    const decodeRowEl = document.getElementById('cpi-row-decode');
    const decodeEl = document.getElementById('cpi-track-decode');
    const lbl1 = document.getElementById('cpi-label-1');
    const lbl2 = document.getElementById('cpi-label-2');
    const lbl3 = document.getElementById('cpi-label-3');
    const { row: uarchRowEl, track: uarchEl } = ensureUarchTrackRow(decodeRowEl);

    if (decodeRowEl) decodeRowEl.classList.add('is-hidden');
    if (decodeEl) decodeEl.innerHTML = '';
    if (uarchRowEl) uarchRowEl.classList.add('is-hidden');
    if (uarchEl) uarchEl.innerHTML = '';

    if (plan.noPmu) {
      if (lbl1) lbl1.textContent = 'Actual';
      if (lbl2) lbl2.textContent = 'Modeled';
      sumEl.innerHTML = `<span class="c-bright">Exclusive CPI Stack</span> <span class="c-dim">│ Hardware PMCs disabled (--no-pmu); Group A Zero-PMC Win32 diagnostics remain active on Tabs 1, 4 &amp; 5</span>`;
      legendEl.innerHTML = '';
      actualEl.innerHTML = `<span class="c-muted">N/A in No-PMU (Win32) mode (press 'm' to configure Metric Packs)</span>`;
      modeledEl.innerHTML = '';
      return;
    }

    const active = snap.activeTiers.filter(t => t.cpi > 0.0005);
    const activeUarchBounds = (snap.uarchBoundTiers || []).filter(t => t.cpi > 0.0005);
    const hasDecode = Boolean(plan.has(MetricPack.OpCacheDecode) && snap.uarch && snap.uarch.opcacheHitPct !== null);

    // If no Exclusive CPI stall packs are enabled, show either Op-Cache Decode strip or Free Base Actual CPI + L3 strip
    if (active.length === 0) {
      const wrapW = Math.max(220, actualEl.getBoundingClientRect().width - 8);
      const actScale = Math.max(snap.actualCpi, snap.uarchBoundTotalCpi || 0, 1.5) * 1.15;
      const actualPx = Math.max(36, Math.min(wrapW, Math.round((snap.actualCpi / actScale) * wrapW)));
      const actTxt = actualPx >= 96 ? `Actual ${snap.actualCpi.toFixed(2)} (aperf)` : `CPI ${snap.actualCpi.toFixed(2)}`;

      if (hasDecode) {
        const ua = snap.uarch;
        if (lbl1) lbl1.textContent = 'Actual';
        if (lbl2) lbl2.textContent = 'Decode';
        sumEl.innerHTML =
          `<span class="c-bright">Micro-Arch Front-End &amp; L3 (${plan.muxShort})</span>` +
          `<span class="c-dim"> │ </span>Actual CPI <span class="c-bright">${snap.actualCpi.toFixed(2)}</span>` +
          `<span class="c-dim"> │ </span>Op-Cache <span class="${ua.legacyDecodePct >= 30.0 ? 'c-yellow c-bright' : 'c-green'}">${ua.opcacheHitPct.toFixed(1)}%</span>` +
          `<span class="c-dim"> │ </span>L3 Hit <span class="c-bright">${snap.l3HitPct.toFixed(1)}%</span> @ <span class="${severityClass(snap.l3LatCyc, 220, 270)}">${snap.l3LatNs.toFixed(1)} ns (${snap.l3LatCyc.toFixed(0)} cyc)</span>`;

        const legParts = [
          `<span><span class="c-muted">Decode:</span> <span style="color:var(--green)">█</span> Op-Cache (8-wide) <span style="color:${ua.legacyDecodePct >= 30.0 ? 'var(--red)' : 'var(--orange)'}">█</span> Legacy (4-wide)</span>`
        ];
        if (activeUarchBounds.length > 0) {
          const fmtUaLeg = list => list.map(t => `<span><span style="color:${t.barColor}">▒</span> ${t.short}</span>`).join(' ');
          legParts.push(`<span><span class="c-muted">uArch(est):</span> ${fmtUaLeg(activeUarchBounds)}</span>`);
        }
        legendEl.innerHTML = legParts.join('');

        actualEl.innerHTML =
          `<span class="cpi-actual-fill" style="width:${actualPx}px;" title="Actual CPI derived from Free Base fixed MSR aperf / irperf: ${snap.actualCpi.toFixed(3)}">${actTxt}</span>` +
          `<span class="cpi-marker" title="Actual CPI boundary (${snap.actualCpi.toFixed(3)})"></span>` +
          `<span class="c-dim" style="margin-left: 8px; font-size: 11.5px;">${plan.coreSlots} Core PMCs + 3 Fixed MSRs + 4 L3 PMCs</span>`;

        modeledEl.innerHTML = buildDecodeBarHtml(ua, wrapW);
        if (activeUarchBounds.length > 0 && uarchRowEl && uarchEl) {
          uarchRowEl.classList.remove('is-hidden');
          uarchEl.innerHTML = buildUarchBoundBarHtml(activeUarchBounds, snap.uarchBoundTotalCpi, snap.uarchHasUnboundedFloor, actScale, wrapW);
        }
        return;
      }

      if (lbl1) lbl1.textContent = 'Actual';
      if (lbl2) lbl2.textContent = 'L3 Hit%';
      sumEl.innerHTML =
        `<span class="c-bright">Free Base Execution &amp; L3 (${plan.muxShort})</span>` +
        `<span class="c-dim"> │ </span>Actual CPI <span class="c-bright">${snap.actualCpi.toFixed(2)}</span>` +
        `<span class="c-dim"> │ </span>L3 Hit <span class="c-bright">${snap.l3HitPct.toFixed(1)}%</span> @ <span class="${severityClass(snap.l3LatCyc, 220, 270)}">${snap.l3LatNs.toFixed(1)} ns (${snap.l3LatCyc.toFixed(0)} cyc)</span>`;
      legendEl.innerHTML = activeUarchBounds.length > 0
        ? `<span><span class="c-muted">uArch(est):</span> ${activeUarchBounds.map(t => `<span><span style="color:${t.barColor}">▒</span> ${t.short}</span>`).join(' ')}</span>`
        : `<span class="c-dim">Press 'm' to add CPI stall packs</span>`;
      actualEl.innerHTML =
        `<span class="cpi-actual-fill" style="width:${actualPx}px;">${actTxt}</span>` +
        `<span class="cpi-marker"></span>` +
        `<span class="c-dim" style="margin-left: 8px; font-size: 11.5px;">${plan.coreSlots}/${plan.capacitySlots} Core PMCs (${Math.round(plan.dutyCyclePct)}% duty)</span>`;
      const hitPx = Math.max(12, Math.round((snap.l3HitPct / 100.0) * wrapW));
      const missPx = Math.max(4, wrapW - hitPx);
      modeledEl.innerHTML =
        `<span class="cpi-seg" style="width:${hitPx}px; background:#5dc27f;">L3 Hit ${snap.l3HitPct.toFixed(1)}%</span>` +
        `<span class="cpi-seg" style="width:${missPx}px; background:#dfb052;">${missPx >= 50 ? 'Miss ' + (100 - snap.l3HitPct).toFixed(1) + '%' : ''}</span>`;
      if (activeUarchBounds.length > 0 && uarchRowEl && uarchEl) {
        uarchRowEl.classList.remove('is-hidden');
        uarchEl.innerHTML = buildUarchBoundBarHtml(activeUarchBounds, snap.uarchBoundTotalCpi, snap.uarchHasUnboundedFloor, actScale, wrapW);
      }
      return;
    }

    if (lbl1) lbl1.textContent = 'Actual';
    if (lbl2) lbl2.textContent = 'Modeled';

    const modeledCpi = snap.modeledCpi;
    const actualCpi = snap.actualCpi;
    const oooHidden = snap.oooHiddenCpi;
    const oooPct = modeledCpi > 0.001 ? Math.round((oooHidden / modeledCpi) * 100) : 0;

    const decodeSummaryPart = hasDecode
      ? `<span class="c-dim"> │ </span>Op-Cache <span class="${snap.uarch.legacyDecodePct >= 30.0 ? 'c-yellow c-bright' : 'c-green'}">${snap.uarch.opcacheHitPct.toFixed(1)}%</span>`
      : '';

    sumEl.innerHTML =
      `<span class="c-bright">Exclusive CPI Stack</span>` +
      `<span class="c-dim"> │ </span>Actual <span class="c-bright">${actualCpi.toFixed(2)}</span>` +
      `<span class="c-dim"> │ </span>Modeled <span class="c-bright">${modeledCpi.toFixed(2)}</span>` +
      `<span class="c-dim"> │ </span>OoO/MLP hides <span class="c-cyan">${oooHidden > 0.005 ? oooHidden.toFixed(2) + ' (' + oooPct + '%)' : '0.00'}</span>` +
      decodeSummaryPart;

    const flushTiers = active.filter(t => t.group === 'flush');
    const mlpTiers = active.filter(t => t.group === 'mlp');
    const fmtLeg = list => list.map(t => `<span><span style="color:${t.barColor}">█</span> ${t.short}</span>`).join(' ');
    const legParts = [];
    if (flushTiers.length > 0) legParts.push(`<span><span class="c-muted">Flush:</span> ${fmtLeg(flushTiers)}</span>`);
    if (mlpTiers.length > 0) legParts.push(`<span><span class="c-muted">MLP:</span> ${fmtLeg(mlpTiers)}</span>`);
    if (activeUarchBounds.length > 0) {
      const fmtUaLeg = list => list.map(t => `<span><span style="color:${t.barColor}">▒</span> ${t.short}</span>`).join(' ');
      legParts.push(`<span><span class="c-muted">uArch:</span> ${fmtUaLeg(activeUarchBounds)}</span>`);
    }
    if (hasDecode) {
      legParts.push(
        `<span><span class="c-muted">Decode:</span> <span style="color:var(--green)">█</span> OpC <span style="color:${snap.uarch.legacyDecodePct >= 30.0 ? 'var(--red)' : 'var(--orange)'}">█</span> Leg</span>`
      );
    }
    legendEl.innerHTML = legParts.join('');

    const wrapW = Math.max(220, actualEl.getBoundingClientRect().width - 8);
    const maxScale = Math.max(actualCpi, modeledCpi, snap.uarchBoundTotalCpi || 0, 0.4) * 1.06;
    const actualPx = Math.max(24, Math.round((actualCpi / maxScale) * wrapW));
    const modeledPx = Math.max(24, Math.round((modeledCpi / maxScale) * wrapW));
    const oooPx = Math.max(0, modeledPx - actualPx);

    const actTxt = actualPx >= 64 ? `Actual ${actualCpi.toFixed(2)}` : (actualPx >= 36 ? actualCpi.toFixed(2) : '');
    const oooTxt = oooPx >= 96 ? `OoO/MLP +${oooHidden.toFixed(2)}` : (oooPx >= 46 ? `+${oooHidden.toFixed(2)}` : '');

    actualEl.innerHTML =
      `<span class="cpi-actual-fill" style="width:${actualPx}px;" title="Actual Measured CPI (aperf / irperf): ${actualCpi.toFixed(3)}">${actTxt}</span>` +
      `<span class="cpi-marker" title="Actual CPI boundary (${actualCpi.toFixed(3)})"></span>` +
      (oooPx > 2 ? `<span class="cpi-ooo-fill" style="width:${oooPx}px;" title="OoO/MLP overlapped latency hidden: ${oooHidden.toFixed(3)} CPI">${oooTxt}</span>` : '');

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

    // Separate, scale-matched hatched track anchored at x = 0 for overlapping micro-arch bounds (STLF, Splits, Lock floor)
    if (activeUarchBounds.length > 0 && uarchRowEl && uarchEl) {
      const lblUarch = document.getElementById('cpi-label-uarch');
      if (lblUarch) lblUarch.textContent = 'uArch (est)';
      uarchRowEl.classList.remove('is-hidden');
      uarchEl.innerHTML = buildUarchBoundBarHtml(activeUarchBounds, snap.uarchBoundTotalCpi, snap.uarchHasUnboundedFloor, maxScale, wrapW);
    }

    // Whenever OpCacheDecode is active alongside CPI packs (e.g. All 4-Mux or custom selection),
    // show the Decode (Op-Cache vs Legacy) bar directly beneath the CPI tracks.
    if (hasDecode && decodeRowEl && decodeEl) {
      if (lbl3) lbl3.textContent = 'Decode';
      decodeRowEl.classList.remove('is-hidden');
      decodeEl.innerHTML = buildDecodeBarHtml(snap.uarch, wrapW);
    }
  }

  function buildActiveMicroArchRows(snap, plan, base) {
    if (!snap.uarch) return [];
    const ua = snap.uarch;
    const cumUa = computeMicroArchMetrics({
      inst: state.cum.instRaw,
      dc_cross_ccx: state.cum.dcCrossCcxRaw,
      locks_serial: state.cum.locksSerialRaw,
      dec_uops: state.cum.decUopsRaw,
      oc_uops: state.cum.ocUopsRaw,
      stlf_interlock: state.cum.stlfInterlockRaw,
      misal_access: state.cum.misalAccessRaw
    }, plan) || ua;

    const rows = [];
    // Cross-CCX Fills (0x430443) is promoted into the solid Exclusive CPI Stack & STALL SOURCE table above.
    if (plan.has(MetricPack.CrossCcxLocks) && ua.locksSerialMpki !== null) {
      const lockFloorCpi = (ua.locksSerialMpki / 1000.0) * CONFIG.latencies.lockFloor;
      const isHi = ua.locksSerialMpki >= 0.5 && (ua.dcCrossCcxMpki ?? 0) >= 0.5;
      rows.push({
        key: 'locksSerial',
        name: 'Serialized Locks',
        hex: '0x430325',
        unit: 'MPKI',
        live: ua.locksSerialMpki,
        avg: cumUa.locksSerialMpki ?? ua.locksSerialMpki,
        baseVal: base ? base.locksSerialMpki : null,
        higherIsBetter: false,
        sev: isHi ? 'HI' : (ua.locksSerialMpki >= 1.0 ? 'MD' : 'OK'),
        boundCpi: lockFloorCpi,
        boundText: `≥${lockFloorCpi.toFixed(3)}`,
        boundTitle: `Uncontended serialization floor (~${CONFIG.latencies.lockFloor.toFixed(0)} cyc/lock). Contended cross-CCX locks can stall 200-400+ cyc and overlap L3/CCX/DRAM.`,
        hatchedBar: true,
        scaleMax: 1.8,
        barColor: isHi ? 'var(--red)' : (ua.locksSerialMpki >= 1.0 ? 'var(--yellow)' : 'var(--orange)'),
        graphTitle: 'Serialized Locks MPKI',
        series: state.history.locksSerial
      });
    }
    if (plan.has(MetricPack.StlfSplits) && ua.stlfInterlockMpki !== null) {
      const stlfCpi = (ua.stlfInterlockMpki / 1000.0) * CONFIG.latencies.stlfPenalty;
      const splitCpi = (ua.misalAccessMpki / 1000.0) * CONFIG.latencies.lineSplitPenalty;
      rows.push(
        {
          key: 'stlfInterlock',
          name: 'STLF Interlocks',
          hex: '0x430224',
          unit: 'MPKI',
          live: ua.stlfInterlockMpki,
          avg: cumUa.stlfInterlockMpki ?? ua.stlfInterlockMpki,
          baseVal: base ? base.stlfInterlockMpki : null,
          higherIsBetter: false,
          sev: ua.stlfInterlockMpki >= 3.0 ? 'MD' : 'OK',
          boundCpi: stlfCpi,
          boundText: `≤${stlfCpi.toFixed(3)}`,
          boundTitle: `Upper bound at ~${CONFIG.latencies.stlfPenalty.toFixed(1)} cyc per failed store-to-load forward (partially hidden by Zen 2 224-entry ROB).`,
          hatchedBar: true,
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
          avg: cumUa.misalAccessMpki ?? ua.misalAccessMpki,
          baseVal: base ? base.misalAccessMpki : null,
          higherIsBetter: false,
          sev: ua.misalAccessMpki >= 20.0 ? 'MD' : (ua.misalAccessMpki >= 10.0 ? 'LO' : 'OK'),
          boundCpi: splitCpi,
          boundText: `≤${splitCpi.toFixed(3)}`,
          boundTitle: `Upper bound at ~${CONFIG.latencies.lineSplitPenalty.toFixed(0)} extra L1d cycle per 64B split (extra cache misses already counted in STALL SOURCE).`,
          hatchedBar: true,
          scaleMax: 30.0,
          barColor: ua.misalAccessMpki >= 20.0 ? 'var(--yellow)' : (ua.misalAccessMpki >= 10.0 ? 'var(--cyan)' : 'var(--blue)'),
          graphTitle: 'Cache-Line Splits MPKI',
          series: state.history.misalAccess
        }
      );
    }
    if (plan.has(MetricPack.OpCacheDecode) && ua.legacyDecodePct !== null) {
      rows.push(
        {
          key: 'legacyDecodePct',
          name: 'Legacy Decode %',
          hex: '0x4301AA',
          unit: '%',
          live: ua.legacyDecodePct,
          avg: cumUa.legacyDecodePct ?? ua.legacyDecodePct,
          baseVal: base ? base.legacyDecodePct : null,
          higherIsBetter: false,
          sev: ua.legacyDecodePct >= 30.0 ? 'MD' : 'OK',
          boundCpi: null,
          boundText: '--',
          boundTitle: 'Dispatch ratio only (no direct stall-cycle weight; Zen 2 4-wide legacy decoder is often masked when back-end memory stalls dominate).',
          hatchedBar: false,
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
          avg: cumUa.opcacheHitPct ?? ua.opcacheHitPct,
          baseVal: base ? base.opcacheHitPct : null,
          higherIsBetter: true,
          sev: ua.opcacheHitPct <= 70.0 ? 'MD' : 'OK',
          boundCpi: null,
          boundText: '--',
          boundTitle: 'Complement of Legacy Decode % (also shown on the Decode bar above).',
          hatchedBar: false,
          scaleMax: 100.0,
          barColor: ua.opcacheHitPct <= 70.0 ? 'var(--yellow)' : 'var(--green)',
          graphTitle: 'Op-Cache Hit %',
          series: state.history.opcacheHitPct
        }
      );
    }
    return rows;
  }

  function renderMicroArchTableRows(uarchRows, highlightTopKey) {
    const boundCell = r => {
      if (r.boundCpi === null || r.boundCpi === undefined) {
        const cls = r.sev === 'MD' ? 'sev-md' : 'c-muted';
        return `<span class="${cls}" title="${r.boundTitle}">${r.boundText}</span>`;
      }
      const cls = r.sev === 'HI' ? 'sev-hi' : (r.sev === 'MD' ? 'sev-md' : (r.sev === 'LO' ? 'sev-lo' : 'c-dim'));
      return `<span class="${cls}" title="${r.boundTitle}">${r.boundText}</span>`;
    };
    return uarchRows.map(r => {
      const isTop = r.key === highlightTopKey;
      const prefix = isTop ? `<span class="c-red c-bright">&gt;&gt; </span>` : `<span class="c-muted">   </span>`;
      const ratio = Math.max(0.0, Math.min(1.0, r.live / r.scaleMax));
      const barLen = Math.max(1, Math.round(ratio * 20));
      const fillChar = r.hatchedBar ? '▒' : '█';
      const barStr = fillChar.repeat(barLen) + '·'.repeat(20 - barLen);
      const liveStr = r.unit === '%' ? `${r.live.toFixed(1)}%` : `${r.live < 1.0 ? r.live.toFixed(3) : r.live.toFixed(2)} MPKI`;
      const avgStr = r.unit === '%' ? `${r.avg.toFixed(1)}%` : (r.avg < 1.0 ? r.avg.toFixed(3) : r.avg.toFixed(2));
      return `
        <tr class="${isTop ? 'top-bottleneck' : ''}" title="${r.name} (${r.hex}) - ${r.boundTitle}">
          <td class="left ${isTop ? 'c-bright' : ''}">${prefix}${r.name}</td>
          <td class="${isTop ? 'c-bright' : ''}">${liveStr}</td>
          <td class="c-dim">${avgStr}</td>
          <td>${fmtDeltaPct(r.live, r.baseVal, r.higherIsBetter)}</td>
          <td>${boundCell(r)}</td>
          <td style="font-size: 12px;"><span style="color:${r.sev !== 'OK' || r.key === 'opcacheHitPct' ? r.barColor : 'var(--fg-dim)'}">${barStr.slice(0, barLen)}</span><span class="c-muted">${barStr.slice(barLen)}</span></td>
        </tr>
      `;
    }).join('');
  }

  function renderTab1Overview() {
    const snap = state.lastSnap;
    if (!snap) return;
    const plan = getActivePlan();
    const base = state.activeBaseline;
    const hasFreeBase = !plan.noPmu;
    const avgIpc = state.cum.samples > 0 ? state.cum.ipc / state.cum.samples : snap.ipc;

    // 1. Top-Left IPC Braille Graph (Always-On Free Base aperf/irperf)
    const ipcTitleEl = document.getElementById('g-ipc-title');
    if (ipcTitleEl) ipcTitleEl.textContent = 'IPC';

    const ipcColor = !hasFreeBase ? 'var(--fg-muted)' : (snap.ipc >= 1.2 ? 'var(--green)' : (snap.ipc >= 0.85 ? 'var(--cyan)' : 'var(--yellow)'));
    const ipcHeader = hasFreeBase
      ? `<span class="${severityClass(snap.ipc, 1.2, 0.75, true)} c-bright">${snap.ipc.toFixed(2)}</span>` +
        `${fmtDeltaPct(snap.ipc, base ? base.ipc : null, true)}` +
        `<span class="c-muted">│</span>` +
        `${formatRetiringTag(snap.retiringPct, snap.retiringExact)}` +
        `<span class="c-muted">│</span>` +
        `<span class="c-dim">avg ${avgIpc.toFixed(2)}</span>` +
        `<span class="c-muted">│</span>` +
        `<span class="c-dim">Inst</span> <span>${fmtRate(snap.instPerSec)}</span>` +
        `<span class="c-dim">aperf</span> <span>${fmtRate(snap.aperfPerSec)}</span>`
      : `<span class="c-dim">N/A (No-PMU Win32-Only) │ Zero-PMC Advisor Active</span>`;
    document.getElementById('g-ipc-stats').innerHTML = ipcHeader;

    renderBrailleGraph(
      document.getElementById('g-ipc-canvas'),
      document.getElementById('g-ipc-axis'),
      hasFreeBase ? state.history.ipc : state.history.ipc.map(() => 0),
      { minVal: 0.4, baseline: (hasFreeBase && base) ? base.ipc : null, color: ipcColor }
    );

    const tierBaseKeyMap = {
      dram: 'dramMpki',
      dcCrossCcx: 'dcCrossCcxMpki',
      l3Hit: 'l3HitMpki',
      l2dcExcl: 'l2dcExclMpki',
      l2icExcl: 'l2icExclMpki',
      branch: 'branchMpki',
      l2dtlb: 'l2dtlbMpki',
      l2itlb: 'l2itlbMpki'
    };
    const getTierAvgMpki = (tier) => {
      if (tier.key === 'dcCrossCcx') {
        return state.cum.instRaw > 0
          ? (state.cum.dcCrossCcxRaw / state.cum.instRaw) * 1000.0
          : tier.mpki;
      }
      return state.cum.samples > 0 ? state.cum[tier.key] / state.cum.samples : tier.mpki;
    };

    const activeCpiRows = snap.tableTiers
      .filter(t => plan.has(t.requiredPack))
      .map(t => ({
        ...t,
        baseVal: base ? base[tierBaseKeyMap[t.key]] : null,
        avgVal: getTierAvgMpki(t)
      }));
    const activeUarchRows = buildActiveMicroArchRows(snap, plan, base);

    const sevWeight = { HI: 3, MD: 2, LO: 1, OK: 0 };
    const hotUarchRows = activeUarchRows.filter(r => r.key !== 'opcacheHitPct' && sevWeight[r.sev] > 0);
    const topUarchRow = activeUarchRows.length > 0
      ? ((hotUarchRows.length === 0)
        ? activeUarchRows[0]
        : [...hotUarchRows].sort((a, b) => (sevWeight[b.sev] - sevWeight[a.sev]) || ((b.live / b.scaleMax) - (a.live / a.scaleMax)))[0])
      : null;

    // 2. Top-Right Graph: Active Top CPI Stall -> Active Top Micro-Arch -> Free Base L3 Latency
    if (activeCpiRows.length > 0 && snap.topTier) {
      const topTier = snap.topTier;
      const topBaseKey = tierBaseKeyMap[topTier.key];
      const topAvg = getTierAvgMpki(topTier);

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
    } else if (topUarchRow) {
      const fmtVal = (v, unit) => unit === '%' ? `${v.toFixed(1)}%` : (v < 1.0 ? v.toFixed(3) : v.toFixed(2));
      const topSevCls = topUarchRow.sev === 'HI' ? 'c-red' : (topUarchRow.sev === 'MD' ? 'c-yellow' : (topUarchRow.sev === 'LO' ? 'c-cyan' : 'c-green'));

      document.getElementById('g-top-title').textContent = topUarchRow.graphTitle;
      document.getElementById('g-top-stats').innerHTML =
        `<span class="${topSevCls} c-bright">${fmtVal(topUarchRow.live, topUarchRow.unit)}</span>` +
        `${fmtDeltaPct(topUarchRow.live, topUarchRow.baseVal, topUarchRow.higherIsBetter)}` +
        `<span class="c-muted">│</span>` +
        `<span class="c-dim">avg ${fmtVal(topUarchRow.avg, topUarchRow.unit)}</span>`;

      renderBrailleGraph(
        document.getElementById('g-top-canvas'),
        document.getElementById('g-top-axis'),
        topUarchRow.series,
        { minVal: 0, baseline: topUarchRow.baseVal, color: topUarchRow.barColor }
      );
    } else if (hasFreeBase) {
      const avgLat = state.cum.samples > 0 ? state.cum.latNs / state.cum.samples : snap.l3LatNs;
      document.getElementById('g-top-title').textContent = 'L3 Miss Latency (ns)';
      document.getElementById('g-top-stats').innerHTML =
        `<span class="${severityClass(snap.l3LatNs, 55, 70)} c-bright">${snap.l3LatNs.toFixed(1)} ns</span>` +
        `${fmtDeltaPct(snap.l3LatNs, base ? base.l3LatNs : null, false)}` +
        `<span class="c-muted">│</span>` +
        `<span class="c-dim">avg ${avgLat.toFixed(1)} ns</span>`;
      renderBrailleGraph(
        document.getElementById('g-top-canvas'),
        document.getElementById('g-top-axis'),
        state.history.latNs,
        { minVal: 25, baseline: base ? base.l3LatNs : null, color: 'var(--yellow)', fmtAxis: v => v.toFixed(0) }
      );
    } else {
      document.getElementById('g-top-title').textContent = 'Top Stall MPKI';
      document.getElementById('g-top-stats').innerHTML = `<span class="c-dim">N/A (No-PMU)</span>`;
      renderBrailleGraph(
        document.getElementById('g-top-canvas'),
        document.getElementById('g-top-axis'),
        state.history.topStall.map(() => 0),
        { minVal: 0, color: 'var(--fg-muted)' }
      );
    }

    // 3. Exclusive CPI Stack + Scale-Matched Hatched uArch Bounds + Decode Bar
    renderCpiStack(snap, plan);

    // 4. Unified Stall Table + Compact Micro-Arch Sub-Table (NEVER pad with empty '--' rows)
    const theadEl = document.getElementById('overview-stall-thead');
    const tbodyEl = document.getElementById('overview-stall-tbody');
    const uarchWrap = document.getElementById('overview-uarch-wrap');
    const uarchTbody = document.getElementById('overview-uarch-tbody');

    if (activeCpiRows.length > 0) {
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
      const maxCpi = Math.max(0.05, ...activeCpiRows.map(r => r.cpi));
      const topKey = snap.topTier ? snap.topTier.key : null;

      tbodyEl.innerHTML = activeCpiRows.map(r => {
        const isTop = r.key === topKey;
        const prefix = isTop ? `<span class="c-red c-bright">&gt;&gt; </span>` : `<span class="c-muted">   </span>`;
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

      // Whenever any Micro-Arch pack is enabled alongside CPI packs, show compact Micro-Arch sub-table below
      if (activeUarchRows.length > 0 && uarchWrap && uarchTbody) {
        uarchWrap.classList.remove('is-hidden');
        const uarchBoundTh = uarchWrap.querySelector('thead th:nth-child(5)');
        if (uarchBoundTh) {
          uarchBoundTh.textContent = 'BOUND CPI';
          uarchBoundTh.title = 'Estimated overlapping CPI bound (excluded from Exclusive Modeled CPI)';
        }
        const topUaKey = hotUarchRows.length > 0 ? topUarchRow.key : null;
        uarchTbody.innerHTML = renderMicroArchTableRows(activeUarchRows, topUaKey);
      } else if (uarchWrap) {
        uarchWrap.classList.add('is-hidden');
      }
    } else if (activeUarchRows.length > 0) {
      if (uarchWrap) uarchWrap.classList.add('is-hidden');
      if (theadEl) {
        theadEl.innerHTML = `
          <tr>
            <th class="left">MICRO-ARCH &amp; CONTENTION</th>
            <th>LIVE</th>
            <th>AVG</th>
            <th>vs BASE</th>
            <th title="Estimated overlapping CPI bound (excluded from Exclusive Modeled CPI)">BOUND CPI</th>
            <th>IMPACT BAR</th>
          </tr>
        `;
      }
      const topUaKey = hotUarchRows.length > 0 ? topUarchRow.key : null;
      tbodyEl.innerHTML = renderMicroArchTableRows(activeUarchRows, topUaKey);
    } else {
      if (uarchWrap) uarchWrap.classList.add('is-hidden');
      if (theadEl) {
        theadEl.innerHTML = `
          <tr>
            <th class="left">ACTIVE TELEMETRY</th>
            <th>LIVE</th>
            <th>AVG</th>
            <th>vs BASE</th>
            <th>STATUS</th>
            <th>NOTE</th>
          </tr>
        `;
      }
      if (plan.noPmu) {
        tbodyEl.innerHTML = `
          <tr>
            <td colspan="6" class="left c-dim" style="padding: 10px 2px;">
              Hardware PMCs disabled (--no-pmu). Zero-PMC Win32 telemetry remains active on Tabs 1, 4, 5, 6, and 7. Press 'm' to enable Metric Packs.
            </td>
          </tr>
        `;
      } else {
        tbodyEl.innerHTML = `
          <tr>
            <td colspan="6" class="left c-dim" style="padding: 10px 2px;">
              Active packs (${plan.selectedPacks.join(', ')}) have no Overview stall rows. Free Base IPC, CPI, GHz, C0%, and L3 Latency remain live. Press 'm' to add CPI or Micro-Arch packs.
            </td>
          </tr>
        `;
      }
    }

    // 5. Bottom 1-line OS Summary
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
      const ps = snap.presentStats;
      const fpsHtml = ps
        ? (() => {
            const fpsCls = ps.composedPct >= 80.0 ? 'c-yellow' : 'c-bright';
            const lowCls = ps.low1Fps < 60.0 ? 'c-yellow' : 'c-dim';
            return `<span class="sep">│</span>FPS <span class="${fpsCls}">${ps.fps.toFixed(1)}</span> <span class="${lowCls}">/ 1%L ${ps.low1Fps.toFixed(0)}</span>`;
          })()
        : '';
      footerEl.innerHTML =
        `<span>CPU <span class="c-bright">${(snap.cpuUsr + snap.cpuSys).toFixed(1)}%</span> <span class="c-dim">(usr ${snap.cpuUsr.toFixed(1)}% / sys <span class="${snap.cpuSys >= 15 ? 'c-yellow' : ''}">${snap.cpuSys.toFixed(1)}%</span>)</span>` +
        `${gpuHtml}` +
        `${fpsHtml}` +
        `<span class="sep">│</span>Faults <span class="${pfCls}">${snap.pfRate.toLocaleString()}/s</span>` +
        `<span class="sep">│</span>RAM 2M: <span class="${proc.hugeMiB > 0 ? 'c-green' : 'c-yellow'}">${fmtMiB(proc.hugeMiB)} (${hugePct}%)</span> / 4K: ${fmtMiB(proc.wsMiB)} (${smallPct}%)</span>` +
        `<span class="c-dim">Real: ${fmtMiB(totalReal)}</span>`;
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