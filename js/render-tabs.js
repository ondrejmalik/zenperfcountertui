// Tab 2 Cache, Tab 3 TLB, Process Picker, Tab 4 Memory, and Tab 5 Advisor renderers
(() => {
  'use strict';
  const Z = window.Zen2Top || (window.Zen2Top = {});
  const {
    CONFIG, MetricPack, PROCESSES, state, getActivePlan, getAttachedProcess,
    fmtAddr, fmtDeltaPct, fmtMiB, fmtRate, fmtTimeSec, severityClass,
    evaluateDiagnostics, formatEstGainCell, renderBrailleGraph,
    formatThreadEntry, formatAffinityHex, describeAffinityMask,
    getPrimaryPhysicalCoresMask, isComposedPresentMode
  } = Z;

  function renderTab2Cache() {
    const snap = state.lastSnap;
    if (!snap) return;
    const plan = getActivePlan();
    const base = state.activeBaseline;
    const hasL1L2Ic = plan.has(MetricPack.L1L2Ic);
    const hasL1L2Dc = plan.has(MetricPack.L1L2Dc);
    const hasDcDemand = plan.has(MetricPack.DcDemand);
    const hasDcHwpf = plan.has(MetricPack.DcHwpf);
    const hasL2Hwpf = plan.has(MetricPack.L2Hwpf);
    const hasL3 = !plan.noPmu;
    const instM = snap.instPerSec / 1000.0;

    const rows = [
      {
        label: 'L1 -> L2 I-Cache',
        avail: hasL1L2Ic,
        rate: fmtRate(snap.l1ic * instM),
        dem: snap.l1ic.toFixed(2),
        hwpf: '--',
        total: snap.l1ic,
        base: base ? base.l1icMpki : null,
        note: `L2->L3: ${snap.l2ic.toFixed(2)} MPKI`
      },
      {
        label: 'L1 -> L2 D-Cache',
        avail: hasL1L2Dc,
        rate: fmtRate(snap.l1dc * instM),
        dem: snap.l1dc.toFixed(2),
        hwpf: '--',
        total: snap.l1dc,
        base: base ? base.l1dcMpki : null,
        note: `L2->L3: ${snap.l2dc.toFixed(2)} MPKI`
      },
      {
        label: 'D-Cache -> L3 Hit',
        avail: hasDcDemand,
        rate: fmtRate((snap.demL3 + (hasDcHwpf ? snap.hwpfL3 : 0)) * instM),
        dem: snap.demL3.toFixed(2),
        hwpf: hasDcHwpf ? snap.hwpfL3.toFixed(2) : '--',
        total: snap.demL3 + (hasDcHwpf ? snap.hwpfL3 : 0),
        base: base ? base.l3HitMpki : null,
        note: `${((snap.demL3 / Math.max(0.01, snap.demL3 + snap.demDram)) * 100).toFixed(1)}% of DC fills`
      },
      {
        label: 'D-Cache -> DRAM',
        avail: hasDcDemand,
        rate: fmtRate((snap.demDram + (hasDcHwpf ? snap.hwpfDram : 0)) * instM),
        dem: snap.demDram.toFixed(2),
        hwpf: hasDcHwpf ? snap.hwpfDram.toFixed(2) : '--',
        total: snap.demDram + (hasDcHwpf ? snap.hwpfDram : 0),
        base: base ? base.dramMpki : null,
        note: hasDcHwpf
          ? `${((snap.demDram / Math.max(0.01, snap.demDram + snap.hwpfDram)) * 100).toFixed(0)}% Demand`
          : `Demand only (enable DcHwpf for split)`
      },
      {
        label: 'L2 HWPF -> L3',
        avail: hasL2Hwpf,
        rate: fmtRate(snap.l2pfL3 * instM),
        dem: '--',
        hwpf: snap.l2pfL3.toFixed(2),
        total: snap.l2pfL3,
        base: base ? base.l2pfL3Mpki : null,
        note: `${((snap.l2pfL3 / Math.max(0.01, snap.l2pfL3 + snap.l2pfDram)) * 100).toFixed(1)}% L3 hit`
      },
      {
        label: 'L2 HWPF -> DRAM',
        avail: hasL2Hwpf,
        rate: fmtRate(snap.l2pfDram * instM),
        dem: '--',
        hwpf: snap.l2pfDram.toFixed(2),
        total: snap.l2pfDram,
        base: base ? base.l2pfDramMpki : null,
        note: `${((snap.l2pfDram / Math.max(0.01, snap.l2pfL3 + snap.l2pfDram)) * 100).toFixed(1)}% DRAM`
      },
      {
        label: 'Unified CCX L3 Miss',
        avail: hasL3,
        rate: fmtRate(snap.l3Miss * instM),
        dem: '--',
        hwpf: '--',
        total: snap.l3Miss,
        base: base ? base.l3MissMpki : null,
        note: `Hit ${snap.l3HitPct.toFixed(1)}%`
      }
    ];

    document.getElementById('cache-tbody').innerHTML = rows.map(r => {
      if (!r.avail) {
        return `
          <tr class="c-muted">
            <td class="left">${r.label}</td>
            <td>--</td><td>--</td><td>--</td><td>--</td><td>--</td><td>--</td>
          </tr>
        `;
      }
      const isDram = r.label.includes('DRAM') || r.label.includes('L3 Miss');
      const valCls = isDram ? severityClass(r.total, 1.5, 3.2) : '';
      return `
        <tr>
          <td class="left">${r.label}</td>
          <td class="c-dim">${r.rate}</td>
          <td>${r.dem}</td>
          <td>${r.hwpf}</td>
          <td class="${valCls}">${r.total.toFixed(2)}</td>
          <td>${fmtDeltaPct(r.total, r.base, false)}</td>
          <td class="c-dim">${r.note}</td>
        </tr>
      `;
    }).join('');

    const l3El = document.getElementById('cache-l3-summary');
    if (hasL3) {
      const latCls = severityClass(snap.l3LatCyc, 220, 270);
      l3El.innerHTML =
        `<span>Unified L3 Hit Rate: <span class="c-bright">${snap.l3HitPct.toFixed(1)}%</span>` +
        `<span class="sep">│</span>L3 Access: ${fmtRate(snap.l3Acc * instM)}` +
        `<span class="sep">│</span>Measured L3 Miss Latency: <span class="${latCls} c-bright">${snap.l3LatCyc.toFixed(0)} cyc (${snap.l3LatNs.toFixed(1)} ns)</span></span>` +
        `<span class="c-dim">Always-On Free Base (CCX0 + CCX1, 0-Mux)</span>`;
    } else {
      l3El.innerHTML = `<span class="c-dim">Cache &amp; CCX L3 counters inactive in No-PMU mode. Press 'm' to enable Metric Packs.</span>`;
    }

    const avgDram = state.cum.samples > 0 ? state.cum.dram / state.cum.samples : snap.dramExcl;
    const avgLat = state.cum.samples > 0 ? state.cum.latNs / state.cum.samples : snap.l3LatNs;

    document.getElementById('g-dram-stats').innerHTML = hasDcDemand
      ? `<span class="${severityClass(snap.dramExcl, 1.5, 3.0)} c-bright">${snap.dramExcl.toFixed(2)}</span>` +
        `${fmtDeltaPct(snap.dramExcl, base ? base.dramMpki : null, false)}` +
        `<span class="c-dim">avg ${avgDram.toFixed(2)}</span>`
      : `<span class="c-dim">N/A (enable DcDemand via 'm')</span>`;

    document.getElementById('g-lat-stats').innerHTML = hasL3
      ? `<span class="${severityClass(snap.l3LatNs, 55, 70)} c-bright">${snap.l3LatNs.toFixed(1)} ns</span>` +
        `${fmtDeltaPct(snap.l3LatNs, base ? base.l3LatNs : null, false)}` +
        `<span class="c-dim">avg ${avgLat.toFixed(1)} ns</span>`
      : `<span class="c-dim">N/A</span>`;

    renderBrailleGraph(
      document.getElementById('g-dram-canvas'),
      document.getElementById('g-dram-axis'),
      hasDcDemand ? state.history.dram : state.history.dram.map(() => 0),
      { minVal: 0, baseline: (hasDcDemand && base) ? base.dramMpki : null, color: hasDcDemand ? 'var(--red)' : 'var(--fg-muted)' }
    );
    renderBrailleGraph(
      document.getElementById('g-lat-canvas'),
      document.getElementById('g-lat-axis'),
      hasL3 ? state.history.latNs : state.history.latNs.map(() => 0),
      { minVal: 25, baseline: (hasL3 && base) ? base.l3LatNs : null, color: hasL3 ? 'var(--yellow)' : 'var(--fg-muted)', fmtAxis: v => v.toFixed(0) }
    );
  }

  function renderTab3Tlb() {
    const snap = state.lastSnap;
    if (!snap) return;
    const plan = getActivePlan();
    const hasItlb = plan.has(MetricPack.ItlbFull);
    const hasDtlb = plan.has(MetricPack.DtlbFull);
    const base = state.activeBaseline;

    const avgItlb = state.cum.samples > 0 ? state.cum.l2itlb / state.cum.samples : snap.l2Itlb;
    const avgDtlb = state.cum.samples > 0 ? state.cum.l2dtlb / state.cum.samples : snap.l2Dtlb;

    document.getElementById('g-itlb-stats').innerHTML = hasItlb
      ? `<span class="${severityClass(snap.l2Itlb, 0.35, 0.80)} c-bright">${snap.l2Itlb.toFixed(3)}</span>` +
        `${fmtDeltaPct(snap.l2Itlb, base ? base.l2itlbMpki : null, false)}` +
        `<span class="c-dim">L1m ${snap.l1ItlbMissPct.toFixed(2)}% │ avg ${avgItlb.toFixed(3)}</span>`
      : `<span class="c-dim">N/A (enable ItlbFull via 'm')</span>`;

    document.getElementById('g-dtlb-stats').innerHTML = hasDtlb
      ? `<span class="${severityClass(snap.l2Dtlb, 0.50, 1.00)} c-bright">${snap.l2Dtlb.toFixed(3)}</span>` +
        `${fmtDeltaPct(snap.l2Dtlb, base ? base.l2dtlbMpki : null, false)}` +
        `<span class="c-dim">L1m ${snap.l1DtlbMissPct.toFixed(2)}% │ avg ${avgDtlb.toFixed(3)}</span>`
      : `<span class="c-dim">N/A (enable DtlbFull via 'm')</span>`;

    renderBrailleGraph(
      document.getElementById('g-itlb-canvas'),
      document.getElementById('g-itlb-axis'),
      hasItlb ? state.history.l2itlb : state.history.l2itlb.map(() => 0),
      { minVal: 0, minSpan: 0.25, baseline: (hasItlb && base) ? base.l2itlbMpki : null, color: hasItlb ? 'var(--cyan)' : 'var(--fg-muted)', fmtAxis: v => v.toFixed(2) }
    );
    renderBrailleGraph(
      document.getElementById('g-dtlb-canvas'),
      document.getElementById('g-dtlb-axis'),
      hasDtlb ? state.history.l2dtlb : state.history.l2dtlb.map(() => 0),
      { minVal: 0, minSpan: 0.35, baseline: (hasDtlb && base) ? base.l2dtlbMpki : null, color: hasDtlb ? 'var(--blue)' : 'var(--fg-muted)', fmtAxis: v => v.toFixed(2) }
    );

    const proc = getAttachedProcess();
    const sumEl = document.getElementById('tlb-ifeo-summary');
    const tbody = document.getElementById('tlb-mod-tbody');

    if (!proc) {
      sumEl.innerHTML =
        `<div>IFEO UseLargePages: <span class="c-dim">No target process attached (System-Wide Mode)</span></div>` +
        `<div class="c-dim">Press 'p' to attach a process and inspect PE modules &gt;= ${CONFIG.moduleMinMiB.toFixed(0)} MiB via QueryWorkingSetEx.</div>`;
      tbody.innerHTML = `<tr><td colspan="7" class="left c-dim" style="padding: 12px 2px;">Attach a process ('p') to inspect loaded PE module 2 MiB vs 4 KiB page backing and IFEO registry keys.</td></tr>`;
      return;
    }

    const lpMods = proc.modules.filter(m => m.lp);
    const smMods = proc.modules.filter(m => !m.lp);
    const lpMiB = lpMods.reduce((a, m) => a + m.sizeMiB, 0);
    const smMiB = smMods.reduce((a, m) => a + m.sizeMiB, 0);

    const lpEntries = lpMods.reduce((a, m) => a + Math.ceil(m.sizeMiB / 2.0), 0);
    const lpAs4kEntries = lpMods.reduce((a, m) => a + Math.floor((m.sizeMiB * 1024 * 1024 * 0.55) / 4096), 0);
    const smEntries = smMods.reduce((a, m) => a + Math.floor((m.sizeMiB * 1024 * 1024 * 0.55) / 4096), 0);
    const savedEntries = Math.max(0, lpAs4kEntries - lpEntries);
    const savedPct = (lpAs4kEntries + smEntries) > 0
      ? ((savedEntries / (lpAs4kEntries + smEntries)) * 100).toFixed(1)
      : '0.0';

    const ifeoDllCount = proc.modules.filter(m => m.ifeo).length;
    const ifeoBadge = proc.ifeoEnabled
      ? `<span class="c-yellow c-bright">ENABLED</span> <span class="c-dim">(${ifeoDllCount} DLLs in LargePageDLLs${proc.ifeoMasterSessionToggled ? ', restart target*' : ''})</span>`
      : `<span class="c-green">DISABLED</span> <span class="c-dim">(VAC-Safe Default${proc.ifeoMasterSessionToggled ? ', restart target*' : ''})</span>`;
    const adminNotice = state.isAdmin
      ? ''
      : ` <span class="c-red c-bright">[Admin required to edit IFEO]</span>`;

    const jitMiB = (snap.vaMap && snap.vaMap.privateJitExec4kMiB) ? snap.vaMap.privateJitExec4kMiB : 0;
    const jitWarn = jitMiB >= 8.0 && snap.l2Itlb >= 0.35 && snap.vaMap && snap.vaMap.imageLarge2mPct >= 75.0;
    const jitRowHtml = jitMiB >= 4.0
      ? `<div class="ifeo-row"><span>Private JIT/RWX Code: <span class="${jitWarn ? 'c-yellow c-bright' : 'c-cyan'}">${jitMiB.toFixed(1)} MiB (4 KiB)</span> <span class="c-dim">(dynamic executable pages outside PE images; IFEO cannot back with 2 MiB)</span></span><span class="c-dim">VA Map</span></div>`
      : '';

    sumEl.innerHTML = `
      <div class="ifeo-row">
        <span>IFEO\\${proc.name}\\UseLargePages: ${ifeoBadge}${adminNotice}</span>
        <span style="display:flex; gap:6px; align-items:center;">
          <button class="btn-inline" id="btn-pe-sort">Sort: ${state.modSort}</button>
          <button class="btn-inline" id="btn-ifeo-master">Toggle Master (U)</button>
        </span>
      </div>
      <div class="ifeo-row">
        <span>2 MiB: <span class="${lpMods.length ? 'c-green c-bright' : 'c-dim'}">${lpMiB.toFixed(1)} MiB (${lpMods.length} mods, ~${lpEntries.toLocaleString()} ent)</span>` +
        `<span class="sep">│</span>4 KiB: <span>${smMiB.toFixed(1)} MiB (${smMods.length} mods, ~${smEntries.toLocaleString()} ent)</span>` +
        `<span class="sep">│</span>iTLB Saved: <span class="${savedEntries > 0 ? 'c-green' : 'c-dim'}">${savedEntries > 0 ? '-' + savedEntries.toLocaleString() + ' (' + savedPct + '%)' : '0'}</span></span>
        <span class="c-dim">Space/Enter or dbl-click: toggle DLL</span>
      </div>
      ${jitRowHtml}
    `;
    document.getElementById('btn-pe-sort').onclick = () => Z.cycleModSort();
    document.getElementById('btn-ifeo-master').onclick = () => Z.requestIfeoToggle(null);

    const sorted = [...proc.modules].sort((a, b) => {
      if (state.modSort === 'name') return a.name.localeCompare(b.name);
      if (state.modSort === 'size') return b.sizeMiB - a.sizeMiB;
      if (a.lp !== b.lp) return a.lp ? -1 : 1;
      return b.sizeMiB - a.sizeMiB;
    });

    state.modSelectedIdx = Math.max(0, Math.min(sorted.length - 1, state.modSelectedIdx));
    tbody.innerHTML = sorted.map((m, idx) => {
      const sel = idx === state.modSelectedIdx ? 'selected' : '';
      const mark = idx === state.modSelectedIdx ? `<span class="c-bright">&gt; </span>` : (m.lp ? `<span class="c-green">* </span>` : `<span class="c-muted">  </span>`);
      const pgHtml = m.lp ? `<span class="c-green c-bright">2 MiB</span>` : `<span class="c-dim">4 KiB</span>`;
      let regHtml = m.ifeo ? `<span class="c-cyan">1 (2MiB)</span>` : `<span class="c-muted">0</span>`;
      if (m.ifeo && !m.lp && m.sessionToggled) {
        regHtml = `<span class="c-yellow">-&gt; 2MiB*</span>`;
      } else if (!m.ifeo && m.lp && m.sessionToggled) {
        regHtml = `<span class="c-yellow">-&gt; 4KiB*</span>`;
      } else if (m.ifeo && !m.lp && !m.sessionToggled && proc.ifeoEnabled) {
        regHtml = `<span class="c-red c-bright">1 (4K FAIL)</span>`;
      }
      const drvTag = m.protectedDriver ? ` <span class="c-muted">[OS/DRV]</span>` : '';
      return `
        <tr class="selectable ${sel}" data-mod-name="${m.name}" data-mod-idx="${idx}">
          <td class="left ${m.lp ? 'c-bright' : ''}">${mark}${m.name}${drvTag}</td>
          <td>${m.sizeMiB.toFixed(2)} MiB</td>
          <td>${pgHtml}</td>
          <td>${regHtml}</td>
          <td class="c-cyan">${m.prot}</td>
          <td class="c-dim">${m.shared ? 'Yes' : 'No'}</td>
          <td class="c-dim">${fmtAddr(m.base)}</td>
        </tr>
      `;
    }).join('');

    tbody.querySelectorAll('tr[data-mod-name]').forEach(tr => {
      tr.onclick = () => {
        state.modSelectedIdx = Number(tr.dataset.modIdx);
        renderTab3Tlb();
      };
      tr.ondblclick = () => {
        state.modSelectedIdx = Number(tr.dataset.modIdx);
        const mod = proc.modules.find(x => x.name === tr.dataset.modName);
        if (mod) Z.requestIfeoToggle(mod);
      };
    });
  }

  function getFilteredProcesses() {
    const q = state.pickerFilter.trim().toLowerCase();
    let list = PROCESSES.filter(p => {
      if (!q) return true;
      return p.name.toLowerCase().includes(q)
        || String(p.pid).includes(q)
        || p.tag.toLowerCase().includes(q)
        || p.allocatorLabel.toLowerCase().includes(q);
    });
    list.sort((a, b) => {
      if (state.pickerSort === 'mem') return (b.wsMiB + b.hugeMiB) - (a.wsMiB + a.hugeMiB);
      if (state.pickerSort === 'name') return a.name.localeCompare(b.name);
      return (b.pmuProfile.cpuUsr + b.pmuProfile.cpuSys) - (a.pmuProfile.cpuUsr + a.pmuProfile.cpuSys);
    });
    return list;
  }

  function renderPickerTable(tbodyId, sortLabelId) {
    const sortNames = { cpu: 'CPU%', mem: 'Working Set', name: 'Name' };
    const sl = document.getElementById(sortLabelId);
    if (sl) sl.textContent = sortNames[state.pickerSort];

    const list = getFilteredProcesses();
    state.pickerSelectedIdx = Math.max(0, Math.min(Math.max(0, list.length - 1), state.pickerSelectedIdx));

    const tbody = document.getElementById(tbodyId);
    if (!tbody) return;
    if (list.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" class="left c-dim" style="padding: 10px 2px;">No matching Win32 processes found.</td></tr>`;
      return;
    }

    tbody.innerHTML = list.map((p, idx) => {
      const sel = idx === state.pickerSelectedIdx ? 'selected' : '';
      const isCur = p.pid === state.attachedPid && !state.waitingTarget;
      const wsTotal = p.wsMiB + p.hugeMiB;
      const cpu = p.pmuProfile.cpuUsr + p.pmuProfile.cpuSys;
      const allocCls = (p.allocatorType === 'tier0_mimalloc' || p.allocatorType === 'miheap_injected') ? 'c-green'
                     : (p.allocatorType === 'generic_mimalloc' ? 'c-cyan' : 'c-dim');
      return `
        <tr class="selectable ${sel}" data-pid="${p.pid}" data-idx="${idx}">
          <td class="left c-dim">${p.pid}</td>
          <td class="left ${isCur ? 'c-bright' : ''}">${isCur ? '&gt; ' : '  '}${p.name} <span class="c-dim">(${p.tag})</span></td>
          <td>${cpu.toFixed(1)}%</td>
          <td>${fmtMiB(wsTotal)}</td>
          <td class="left ${allocCls}">${p.allocatorLabel}</td>
        </tr>
      `;
    }).join('');

    tbody.querySelectorAll('tr[data-pid]').forEach(tr => {
      tr.onclick = () => {
        state.pickerSelectedIdx = Number(tr.dataset.idx);
        Z.attachProcess(Number(tr.dataset.pid));
        Z.closeModal();
      };
    });
  }

  function renderTab4Memory() {
    const proc = getAttachedProcess();
    const unattEl = document.getElementById('tab4-unattached');
    const attEl = document.getElementById('tab4-attached');

    if (!proc) {
      unattEl.style.display = 'flex';
      attEl.style.display = 'none';
      renderPickerTable('t4-picker-tbody', 't4-sort-label');
      return;
    }

    unattEl.style.display = 'none';
    attEl.style.display = 'flex';
    const snap = state.lastSnap;
    const total4k = proc.wsMiB + proc.sharedMiB;
    const totalReal = proc.wsMiB + proc.hugeMiB;

    document.getElementById('mem-layer1-tag').textContent = `${proc.name} (PID ${proc.pid}) │ NtQueryInformationProcess`;
    const isNonDefaultQos = (snap.priorityClass && snap.priorityClass !== 'NORMAL') || snap.ecoQos === 'Active';
    const qosWarn = snap.priorityClass === 'BELOW_NORMAL' || snap.priorityClass === 'IDLE' || snap.ecoQos === 'Active';
    const qosLabel = [
      snap.priorityClass,
      snap.ecoQos === 'Active' ? 'EcoQoS Active' : (snap.ecoQos === 'Unknown' ? 'EcoQoS Unknown' : null)
    ].filter(Boolean).join(' │ ');
    const qosRowHtml = isNonDefaultQos
      ? `<tr><td class="k">Priority / QoS</td><td class="v ${qosWarn ? 'c-red c-bright' : 'c-cyan'}">${qosLabel}</td></tr>`
      : '';
    const dio = snap.diskIo;
    const dioWarn = dio && (dio.readMbS >= 50.0 || dio.readIops >= 1000);
    const fmtIops = v => v >= 1000 ? `${(v / 1000).toFixed(1)}K` : `${Math.round(v)}`;
    const diskIoRowHtml = dio
      ? `<tr><td class="k">Disk I/O (R / W)</td><td class="v ${dioWarn ? 'c-yellow c-bright' : ''}">R ${dio.readMbS.toFixed(1)} MB/s (${fmtIops(dio.readIops)} IOPS) <span class="c-dim">/ W ${dio.writeMbS.toFixed(1)} MB/s (${fmtIops(dio.writeIops)})</span></td></tr>`
      : '';
    document.getElementById('mem-os-tbody').innerHTML = `
      <tr><td class="k">Private Working Set</td><td class="v c-bright">${fmtMiB(proc.wsMiB)}</td></tr>
      <tr><td class="k">Shared Working Set</td><td class="v c-dim">${fmtMiB(proc.sharedMiB)}</td></tr>
      <tr><td class="k">Total 4 KiB Working Set</td><td class="v">${fmtMiB(total4k)}</td></tr>
      <tr><td class="k">Hardware 2 MiB Huge Pages</td><td class="v ${proc.hugeMiB > 0 ? 'c-green c-bright' : 'c-yellow'}">${fmtMiB(proc.hugeMiB)}</td></tr>
      <tr><td class="k">Total Real Physical RAM</td><td class="v c-cyan c-bright">${fmtMiB(totalReal)}</td></tr>
      <tr><td class="k">Virtual Commit / Peak</td><td class="v">${fmtMiB(proc.commitMiB)} <span class="c-dim">/ ${fmtMiB(proc.peakCommitMiB)}</span></td></tr>
      <tr><td class="k">CPU (usr / sys / elapsed)</td><td class="v">${fmtTimeSec(proc.userSec)} / ${fmtTimeSec(proc.sysSec)} <span class="c-dim">/ ${fmtTimeSec(proc.elapsedSec)} (${(snap.cpuUsr + snap.cpuSys).toFixed(1)}%)</span></td></tr>
      ${diskIoRowHtml}
      ${qosRowHtml}
    `;

    const pfCls = snap.pfRate >= 2000 ? 'c-red' : (snap.pfRate >= 500 ? 'c-yellow' : 'c-green');
    const pfGraphColor = snap.pfRate >= 2000 ? 'var(--red)' : (snap.pfRate >= 500 ? 'var(--yellow)' : 'var(--cyan)');
    const hardCls = (snap.hardPageReadsPerSec >= 20.0 || snap.availPhysPct < 5.0)
      ? 'c-red c-bright'
      : (snap.hardPageReadsPerSec >= 5.0 ? 'c-yellow' : 'c-dim');
    document.getElementById('g-pf-stats').innerHTML =
      `<span class="${pfCls} c-bright">+${snap.pfRate.toLocaleString()}/s</span>` +
      `<span class="c-muted">│</span>` +
      `<span class="c-dim">Hard Faults (Disk)</span> <span class="${hardCls}">${snap.hardPageReadsPerSec.toFixed(1)}/s</span>` +
      `<span class="c-muted">│</span>` +
      `<span class="c-dim">total ${proc.pageFaults.toLocaleString()}</span>`;

    renderBrailleGraph(
      document.getElementById('g-pf-canvas'),
      document.getElementById('g-pf-axis'),
      state.history.pfRate,
      { minVal: 0, minSpan: 100, color: pfGraphColor, fmtAxis: v => v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v.toFixed(0) }
    );

    const root = document.getElementById('mem-layer2-root');
    const elig = typeof Z.classifyAllocatorEligibility === 'function'
      ? Z.classifyAllocatorEligibility(proc, snap)
      : null;
    const buildEligibilityStripHtml = (el) => {
      if (!el) return '';
      const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      if (el.state === 'ELIGIBLE') {
        const recText = el.recommendedMode === 'large' && el.recommendedHugeGiB > 0
          ? `--large ${el.recommendedHugeGiB} GiB (non-destructive)`
          : `standard mode (${el.warnings[0] || '0 locked RAM'})`;
        return `
          <div class="rminject-strip eligible" id="t4-rminject-strip">
            <span class="rminject-strip-text">rminject Eligibility: <span class="c-green c-bright">ELIGIBLE</span> (<span class="c-bright">${esc(el.linkageLabel)}</span>) <span class="c-muted">│</span> Rec: <span class="c-cyan">${esc(recText)}</span></span>
            <button class="btn-inline btn-rminject-launch" id="btn-t4-rminject">i: Relaunch w/ rminject</button>
          </div>
        `;
      }
      if (el.state === 'BLOCKED_GUARDRAIL') {
        return `
          <div class="rminject-strip blocked" id="t4-rminject-strip">
            <span class="rminject-strip-text">rminject Eligibility: <span class="c-red c-bright">BLOCKED</span> (${esc(el.linkageLabel)} - injection disabled)</span>
          </div>
        `;
      }
      const badgeText = el.state === 'ALREADY_MIMALLOC' ? 'ALREADY MIMALLOC' : 'SKIPPED';
      const badgeCls = el.state === 'ALREADY_MIMALLOC' ? 'c-cyan c-bright' : 'c-yellow c-bright';
      const hintText = el.hint || el.blockOrSkipReason;
      return `
        <div class="rminject-strip skipped" id="t4-rminject-strip">
          <span class="rminject-strip-text">rminject Eligibility: <span class="${badgeCls}">${badgeText}</span> (${esc(el.linkageLabel)}) <span class="c-muted">│</span> ${esc(hintText)}</span>
        </div>
      `;
    };
    const buildVaMapTableHtml = (vaMap) => {
      if (!vaMap) return `<div class="c-dim">VA map pending VirtualQueryEx scan...</div>`;
      return `
        <table class="tui-table" style="font-size: 12px;">
          <colgroup>
            <col style="width: 24%;"><col style="width: 15%;"><col style="width: 15%;"><col style="width: 15%;"><col style="width: 15%;"><col style="width: 16%;">
          </colgroup>
          <thead>
            <tr>
              <th class="left">VA REGION (VirtualQueryEx)</th>
              <th>COMMIT 2 MiB</th>
              <th>COMMIT 4 KiB</th>
              <th>WS 2 MiB</th>
              <th>WS 4 KiB</th>
              <th>TOTAL WS</th>
            </tr>
          </thead>
          <tbody>
            ${vaMap.rows.map(r => {
              const isJit = r.key === 'privateJit';
              const jitCls = isJit && r.commit4kMiB >= 8.0 ? 'c-yellow c-bright' : (isJit && r.commit4kMiB >= 4.0 ? 'c-cyan' : '');
              return `
                <tr>
                  <td class="left ${jitCls || 'c-bright'}">${r.label}</td>
                  <td class="${r.commit2mMiB > 0 ? 'c-green' : 'c-muted'}">${r.commit2mMiB > 0 ? fmtMiB(r.commit2mMiB) : '--'}</td>
                  <td class="${jitCls}">${r.commit4kMiB > 0 ? fmtMiB(r.commit4kMiB) : '--'}</td>
                  <td class="${r.ws2mMiB > 0 ? 'c-green' : 'c-muted'}">${r.ws2mMiB > 0 ? fmtMiB(r.ws2mMiB) : '--'}</td>
                  <td class="c-dim">${r.ws4kMiB > 0 ? fmtMiB(r.ws4kMiB) : '--'}</td>
                  <td class="c-bright">${fmtMiB(r.totalWsMiB)}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      `;
    };

    if (proc.arenas && proc.heapStats && !state.memShowVaMap) {
      const ha = proc.arenas.hugeArenas;
      const totalBlocks = ha.length * 32;
      let actBlocks = 0, tchBlocks = 0;

      const arenaRows = ha.map(g => {
        const act = g.inuse.reduce((a, b) => a + b, 0);
        const tch = g.touched.reduce((a, b) => a + b, 0);
        const free = 32 - act;
        actBlocks += act;
        tchBlocks += tch;

        let mapHtml = '';
        for (let b = 0; b < 32; b++) {
          if (g.inuse[b]) mapHtml += `<span class="c-green">█</span>`;
          else if (g.touched[b]) mapHtml += `<span class="c-yellow">▓</span>`;
          else mapHtml += `<span class="c-muted">░</span>`;
        }
        return `
          <div class="arena-row">
            <span><span class="c-bright">GB #${g.gbIndex}</span> <span class="c-dim">[0x${g.addr.toString(16).toUpperCase().padStart(12, '0')}]</span></span>
            <span style="letter-spacing: 0;">${mapHtml}</span>
            <span>${String(act).padStart(2, ' ')}/32 <span class="c-dim">(${act * 32} MiB, free ${free})</span></span>
          </div>
        `;
      }).join('');

      const osArenas = proc.arenas.osArenas;
      const osRowsHtml = osArenas.map(o => {
        let mapHtml = '';
        for (let b = 0; b < o.blockCount; b++) {
          if (b < o.inuseCount) mapHtml += `<span class="c-red">█</span>`;
          else if (b < o.touchedCount) mapHtml += `<span class="c-yellow">▓</span>`;
          else mapHtml += `<span class="c-muted">░</span>`;
        }
        return `
          <div class="arena-row">
            <span><span class="c-yellow">4K #${o.index}</span> <span class="c-dim">[0x${o.addr.toString(16).toUpperCase().padStart(12, '0')}]</span></span>
            <span style="letter-spacing: 0;">${mapHtml}</span>
            <span class="c-yellow">${o.inuseCount}/${o.blockCount} <span class="c-dim">(${o.inuseCount * 32} MiB 4K)</span></span>
          </div>
        `;
      }).join('');

      const freeBlocks = totalBlocks - actBlocks;
      const freePct = totalBlocks > 0 ? ((freeBlocks / totalBlocks) * 100).toFixed(1) : '0.0';
      const freeCls = Number(freePct) >= 20 ? 'c-green' : (Number(freePct) >= 10 ? 'c-yellow' : 'c-red');

      const hs = proc.heapStats;
      const statRow = (label, obj) => {
        const freed = Math.max(0, obj.total - obj.current);
        const fmt = obj.isCount ? (v => v.toLocaleString()) : fmtMiB;
        return `
          <tr>
            <td class="left ${label === 'huge' || label === 'committed' || label === 'touched' ? 'c-cyan' : ''}">${label}</td>
            <td class="c-dim">${fmt(obj.peak)}</td>
            <td class="c-dim">${fmt(obj.total)}</td>
            <td class="c-dim">${fmt(freed)}</td>
            <td class="${label === 'huge' ? 'c-green c-bright' : 'c-bright'}">${fmt(obj.current)}</td>
          </tr>
        `;
      };

      const osArenaSummary = osArenas.length === 0
        ? `<span class="c-green">NONE (0.00 GiB)</span>`
        : `<span class="c-red c-bright">${osArenas.length} active spillover arena${osArenas.length > 1 ? 's' : ''} (${fmtMiB(osArenas.reduce((a, o) => a + o.inuseCount * 32, 0))})</span>`;

      const allocTitle = proc.allocatorType === 'tier0_mimalloc'
        ? 'Mimalloc v2 Huge Arenas (tier0.dll)'
        : (proc.allocatorType === 'miheap_injected'
          ? 'Mimalloc v2 Huge Arenas (miheap.dll -> mimalloc.dll)'
          : 'Mimalloc v2 Huge Arenas (mimalloc.dll)');

      const blockedArenaStrip = (elig && elig.state === 'BLOCKED_GUARDRAIL')
        ? buildEligibilityStripHtml(elig)
        : '';

      const fmtCountK = v => v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : (v >= 1000 ? `${(v / 1000).toFixed(1)}K` : String(Math.round(v)));
      let miheapKvHtml = '';
      let miheapFooterHtml = '';
      if (proc.allocatorType === 'miheap_injected' && proc.miheapStats) {
        const ms = proc.miheapStats;
        const totalAllocs = Math.max(1, (ms.miAllocs || 0) + (ms.fallbackAllocs || 0));
        const fallbackPct = (((ms.fallbackAllocs || 0) / totalAllocs) * 100).toFixed(2);
        const crtsText = Array.isArray(ms.crts) && ms.crts.length > 0 ? ms.crts.join(', ') : 'ucrtbase.dll';
        miheapKvHtml = `
          <tr><td class="k">[miheap] crts</td><td class="v c-cyan">${crtsText}</td></tr>
          <tr><td class="k">[miheap] iatMods</td><td class="v">${ms.iatMods} modules (${ms.iatSlots} IAT slots)</td></tr>
          <tr><td class="k">[miheap] mi_allocs / mi_frees</td><td class="v c-green">${fmtCountK(ms.miAllocs)} / ${fmtCountK(ms.miFrees)}</td></tr>
          <tr><td class="k">[miheap] fallback_allocs</td><td class="v ${ms.fallbackAllocs > 100 ? 'c-yellow' : 'c-dim'}">${ms.fallbackAllocs} (${fallbackPct}% fallback)</td></tr>
        `;
        const base = state.activeBaseline;
        const deltaNote = (base && snap && base.l2dtlbMpki !== null && base.l2dtlbMpki !== undefined)
          ? `<span>vs BASE (<span class="c-bright">${base.name}</span>): L2 dTLB <span class="c-bright">${snap.l2Dtlb.toFixed(2)}</span> ${fmtDeltaPct(snap.l2Dtlb, base.l2dtlbMpki, false)} <span class="c-muted">│</span> IPC <span class="c-bright">${snap.ipc.toFixed(2)}</span> ${fmtDeltaPct(snap.ipc, base.ipc, true)}</span>`
          : `<span class="c-dim">rminject active (${ms.mode === 'large' ? `--large ${ms.hugeGiB} GiB` : 'standard mode'})</span>`;
        miheapFooterHtml = `
          <div class="miheap-footer-bar" id="t4-miheap-footer">
            ${deltaNote}
            <button class="btn-inline" id="btn-miheap-revert">Revert / Relaunch Baseline</button>
          </div>
        `;
      }

      root.innerHTML = `
        <div class="split-2" style="height: 100%;">
          <div style="display: flex; flex-direction: column; min-height: 0; overflow-y: auto;">
            <div class="section-label">
              <span>${allocTitle}</span>
              <span class="c-dim" style="font-weight: 400; font-size: 11.5px; display:flex; gap:8px; align-items:center;">
                <span><span class="c-green">█</span> active  <span class="c-yellow">▓</span> peak  <span class="c-muted">░</span> free</span>
                <button class="btn-inline" id="btn-toggle-va">VA Map (v)</button>
              </span>
            </div>
            ${blockedArenaStrip}
            <div style="margin-bottom: 4px;">${arenaRows}${osRowsHtml}</div>
            <hr class="h-rule-tight">
            <table class="kv-table" style="font-size: 12px;">
              <tr><td class="k">Active Huge Blocks</td><td class="v c-bright">${actBlocks}/${totalBlocks} (${fmtMiB(actBlocks * 32)}, ${totalBlocks > 0 ? ((actBlocks / totalBlocks) * 100).toFixed(1) : '0.0'}%)</td></tr>
              <tr><td class="k">Peak Touched Blocks</td><td class="v c-yellow">${tchBlocks}/${totalBlocks} (${fmtMiB(tchBlocks * 32)}, ${totalBlocks > 0 ? ((tchBlocks / totalBlocks) * 100).toFixed(1) : '0.0'}%)</td></tr>
              <tr><td class="k">Real Free Headroom</td><td class="v ${freeCls}">${freeBlocks}/${totalBlocks} (${fmtMiB(freeBlocks * 32)}, ${freePct}%)</td></tr>
              <tr><td class="k">4 KiB OS Arenas</td><td class="v">${osArenaSummary}</td></tr>
              ${miheapKvHtml}
            </table>
            ${miheapFooterHtml}
          </div>
          <div class="v-rule"></div>
          <div style="display: flex; flex-direction: column; min-height: 0; overflow-y: auto;">
            <div class="section-label">
              <span>Mimalloc Heap Stats (_mi_stats_main)</span>
              <span class="c-dim" style="font-weight: 400; font-size: 11.5px;">32 MiB blocks</span>
            </div>
            <table class="tui-table" style="font-size: 12px;">
              <colgroup>
                <col style="width: 22%;"><col style="width: 19%;"><col style="width: 20%;"><col style="width: 19%;"><col style="width: 20%;">
              </colgroup>
              <thead>
                <tr><th class="left">stat</th><th>peak</th><th>total</th><th>freed</th><th>current</th></tr>
              </thead>
              <tbody>
                ${statRow('normal', hs.normal)}
                ${statRow('huge', hs.huge)}
                ${statRow('reserved', hs.reserved)}
                ${statRow('committed', hs.committed)}
                ${statRow('touched', hs.touched)}
                ${statRow('segments', hs.segments)}
                ${statRow('pages', hs.pages)}
              </tbody>
            </table>
            <div style="margin-top: 6px; padding-top: 4px; border-top: 1px solid var(--border-dim); display: flex; justify-content: space-between; font-size: 12px;">
              <span>touched peak: <span class="c-yellow">${fmtMiB(hs.touched.peak)}</span></span>
              <span>decommitted: <span class="c-dim">${fmtMiB(Math.max(0, hs.committed.total - hs.committed.current))}</span></span>
              <span>soft reset: <span class="c-dim">${fmtMiB(hs.softReset)}</span></span>
            </div>
          </div>
        </div>
      `;
      const btnVa = document.getElementById('btn-toggle-va');
      if (btnVa) btnVa.onclick = () => Z.toggleVaMapView();
      const btnRevert = document.getElementById('btn-miheap-revert');
      if (btnRevert && typeof Z.revertRminjectBaseline === 'function') {
        btnRevert.onclick = () => Z.revertRminjectBaseline();
      }
    } else if (proc.arenas && proc.heapStats && state.memShowVaMap) {
      root.innerHTML = `
        <div style="display: flex; flex-direction: column; height: 100%; overflow-y: auto;">
          <div class="section-label">
            <span>Virtual Address Space &amp; Private JIT Map (VirtualQueryEx + QueryWorkingSetEx)</span>
            <span style="display:flex; gap:8px; align-items:center;">
              <span class="c-dim" style="font-weight: 400; font-size: 11.5px;">PE 2 MiB: ${snap.vaMap ? snap.vaMap.imageLarge2mPct.toFixed(0) : 0}% │ 2-3s cadence</span>
              <button class="btn-inline" id="btn-toggle-va">Mimalloc View (v)</button>
            </span>
          </div>
          ${buildVaMapTableHtml(snap.vaMap)}
        </div>
      `;
      const btnVa = document.getElementById('btn-toggle-va');
      if (btnVa) btnVa.onclick = () => Z.toggleVaMapView();
    } else {
      const total = Math.max(1, proc.hugeMiB + proc.wsMiB + proc.sharedMiB);
      const breakdown = [
        { name: '2 MiB Large Pages', bytes: proc.hugeMiB, col: 'var(--green)', note: 'Locked physical huge pages (VirtualAlloc MEM_LARGE_PAGES)' },
        { name: '4 KiB Private Working Set', bytes: proc.wsMiB, col: 'var(--fg)', note: 'Process-private heap & stack pages (ucrtbase / OS; ~8 MiB L2 dTLB reach)' },
        { name: 'Mapped / Image Shared', bytes: proc.sharedMiB, col: 'var(--cyan)', note: 'PE images, shared sections, and memory-mapped files' }
      ];
      root.innerHTML = `
        <div style="display: flex; flex-direction: column; height: 100%; overflow-y: auto;">
          <div class="section-label">
            <span>${state.memShowVaMap ? 'OS Virtual Memory Backing (Layer 1 Fallback)' : 'OS Virtual Address Space &amp; Backing Breakdown'}</span>
            <span style="display:flex; gap:8px; align-items:center;">
              <span class="c-dim" style="font-weight: 400; font-size: 11.5px;">Allocator: ${proc.allocatorLabel}</span>
              <button class="btn-inline" id="btn-toggle-va">${state.memShowVaMap ? 'Compact VA (v)' : 'Expand Backing (v)'}</button>
            </span>
          </div>
          ${buildEligibilityStripHtml(elig)}
          ${state.memShowVaMap ? `
          <table class="tui-table" style="margin-bottom: 6px;">
            <colgroup>
              <col style="width: 24%;"><col style="width: 13%;"><col style="width: 9%;"><col style="width: 20%;"><col style="width: 34%;">
            </colgroup>
            <thead>
              <tr><th class="left">BACKING TYPE</th><th>SIZE</th><th>SHARE</th><th>DISTRIBUTION</th><th class="left">NOTES</th></tr>
            </thead>
            <tbody>
              ${breakdown.map(b => {
                const pct = (b.bytes / total) * 100;
                const fill = Math.round((pct / 100) * 18);
                return `
                  <tr>
                    <td class="left c-bright">${b.name}</td>
                    <td>${fmtMiB(b.bytes)}</td>
                    <td class="c-dim">${pct.toFixed(1)}%</td>
                    <td><span style="color:${b.col}">${'█'.repeat(fill)}</span><span class="c-muted">${'·'.repeat(18 - fill)}</span></td>
                    <td class="left c-dim">${b.note}</td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>` : ''}
          ${buildVaMapTableHtml(snap.vaMap)}
        </div>
      `;
      const btnVa = document.getElementById('btn-toggle-va');
      if (btnVa) btnVa.onclick = () => Z.toggleVaMapView();
      const btnRm = document.getElementById('btn-t4-rminject');
      if (btnRm && typeof Z.openRminjectModal === 'function') {
        btnRm.onclick = () => Z.openRminjectModal();
      }
    }
  }

  function renderTab5Advisor() {
    const diag = state.lastDiag || evaluateDiagnostics();
    const verdictEl = document.getElementById('advisor-verdict');
    const tbody = document.getElementById('advisor-tbody');
    const detailEl = document.getElementById('advisor-detail');
    const healthyEl = document.getElementById('advisor-healthy');

    const vCls = (diag.primaryVerdict === 'CoreExecutionBound' || diag.primaryVerdict === 'Win32OnlyClear')
      ? 'c-green c-bright'
      : (diag.primaryVerdict === 'InsufficientData'
        ? 'c-dim c-bright'
        : (diag.primaryVerdict === 'GpuBound' ? 'c-red c-bright' : 'c-yellow c-bright'));
    const inactiveNote = diag.inactiveRules.length > 0
      ? ` <span class="c-muted">│ Skipped in ${diag.muxLabel}: ${diag.inactiveRules.join(', ')}</span>`
      : '';

    verdictEl.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:baseline; flex-wrap:wrap; gap:8px;">
        <span>PRIMARY VERDICT: <span class="${vCls}">${diag.verdictLabel}</span> <span class="c-dim">(${diag.winningStallLine})</span></span>
        <span class="c-dim" style="font-size: 12px;">${diag.samples} samples │ ${diag.muxLabel}${inactiveNote}</span>
      </div>
      <div class="c-dim" style="font-size: 12px;"><span class="c-bright">Proof:</span> ${diag.proofLine}</div>
    `;

    if (!diag.ready) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" class="left c-dim" style="padding: 12px 4px;">
            ${diag.gateReason} Diagnostic rules evaluate strictly on cumulative session totals to prevent 1s single-tick flicker.
          </td>
        </tr>
      `;
      detailEl.innerHTML = `
        <div class="advisor-detail-row"><span class="c-dim">Status</span><span>Accumulating deterministic session evidence (${diag.samples}/${CONFIG.advisor.minSamples} samples).</span></div>
        <div class="advisor-detail-row"><span class="c-dim">Policy</span><span class="c-dim">No single-tick spikes trigger recommendations. Wait a few seconds or switch processes ('p').</span></div>
      `;
      healthyEl.innerHTML = `<div class="c-muted">Verified Healthy: pending evidence gate (${diag.samples}/${CONFIG.advisor.minSamples} samples).</div>`;
      return;
    }

    if (diag.findings.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" class="left c-green" style="padding: 10px 4px;">
            No bottlenecks or configuration faults triggered across active rules. Workload is cleanly CORE EXECUTION BOUND.
          </td>
        </tr>
      `;
      detailEl.innerHTML = `
        <div class="advisor-detail-row"><span class="c-dim">Verdict</span><span class="c-green">No proven OS, BIOS, or microarchitectural regressions detected over ${diag.samples} samples.</span></div>
        <div class="advisor-detail-row"><span class="c-dim">Next Step</span><span class="c-dim">Pin a baseline (b -&gt; S) or test a 0-Mux preset ('m') for sub-3% A/B microbenchmark comparisons.</span></div>
      `;
    } else {
      state.advisorSelectedIdx = Math.max(0, Math.min(diag.findings.length - 1, state.advisorSelectedIdx));
      const selFinding = diag.findings[state.advisorSelectedIdx];
      const sevCls = s => (s === 'HI' ? 'sev-hi' : (s === 'MD' ? 'sev-md' : (s === 'INFO' ? 'sev-info' : 'sev-lo')));

      tbody.innerHTML = diag.findings.map((f, idx) => {
        const isSel = idx === state.advisorSelectedIdx;
        const prefix = isSel ? `<span class="c-bright">&gt;&gt; </span>` : `<span class="c-muted">   </span>`;
        return `
          <tr class="selectable ${isSel ? 'selected' : ''}" data-adv-idx="${idx}">
            <td class="left ${sevCls(f.severity)}">${f.severity}</td>
            <td class="left c-dim">${f.scope}</td>
            <td class="left ${isSel ? 'c-bright' : ''}">${prefix}${f.title}</td>
            <td class="${isSel ? 'c-bright' : ''}">${f.keyMetric}</td>
            <td>${formatEstGainCell(f.estGain)}</td>
            <td class="c-dim">${f.confidence}</td>
          </tr>
        `;
      }).join('');

      tbody.querySelectorAll('tr[data-adv-idx]').forEach(tr => {
        tr.onclick = () => {
          state.advisorSelectedIdx = Number(tr.dataset.advIdx);
          renderTab5Advisor();
        };
        tr.ondblclick = () => {
          state.advisorSelectedIdx = Number(tr.dataset.advIdx);
          Z.jumpToFindingTab(diag.findings[state.advisorSelectedIdx]);
        };
      });

      const tabNames = { 1: 'Overview', 2: 'Cache', 3: 'TLB', 4: 'Memory', 5: 'Advisor', 6: 'Threads', 7: 'Profiler' };
      const rminjectBtnHtml = selFinding.rminjectEligible === true
        ? `<button class="btn-inline btn-rminject-launch" id="btn-adv-rminject">i: Relaunch w/ rminject</button>`
        : '';
      const jumpHtml = selFinding.quickJumpTab
        ? `<span style="display:flex; gap:6px; align-items:center;">${rminjectBtnHtml}<button class="btn-inline" id="btn-adv-burst">f: HW Burst</button><button class="btn-inline" id="btn-adv-jump">Enter: Jump to Tab ${selFinding.quickJumpTab} (${tabNames[selFinding.quickJumpTab]})</button></span>`
        : `<span style="display:flex; gap:6px; align-items:center;">${rminjectBtnHtml}<button class="btn-inline" id="btn-adv-burst">f: HW Burst</button></span>`;
      const gainDetailText = selFinding.estGain ? selFinding.estGain.detail : 'N/A';
      const rmElig = selFinding.rminjectEligibility;
      const rminjectNoteRow = rmElig
        ? (selFinding.rminjectEligible === true
          ? `<div class="advisor-detail-row" id="adv-rminject-note"><span class="c-dim">rminject</span><span class="c-green">ELIGIBLE (${rmElig.linkageLabel}) <span class="c-muted">│</span> Rec: ${rmElig.hint}</span></div>`
          : `<div class="advisor-detail-row" id="adv-rminject-note"><span class="c-dim">rminject</span><span class="${rmElig.state === 'BLOCKED_GUARDRAIL' ? 'c-red' : 'c-yellow'}">${rmElig.state}: ${rmElig.blockOrSkipReason}</span></div>`)
        : '';

      detailEl.innerHTML = `
        <div class="advisor-detail-row"><span class="c-dim">Why</span><span>${selFinding.why}</span></div>
        <div class="advisor-detail-row"><span class="c-dim">Gain Est</span><span class="c-cyan">${gainDetailText}</span></div>
        <div class="advisor-detail-row"><span class="c-dim">Action</span><span class="c-bright">${selFinding.action}</span></div>
        ${rminjectNoteRow}
        <div class="advisor-detail-row"><span class="c-dim">Cascade</span><span class="c-dim">${selFinding.cascade}</span></div>
        <div style="display:flex; justify-content:space-between; align-items:center; font-size: 11.5px; margin-top: 2px;">
          <span class="c-dim">Rule: <span class="c-bright">${selFinding.id}</span> │ Scope: ${selFinding.scope} │ Confidence: ${selFinding.confidence}</span>
          ${jumpHtml}
        </div>
      `;
      const rmAdvBtn = document.getElementById('btn-adv-rminject');
      if (rmAdvBtn && typeof Z.openRminjectModal === 'function') rmAdvBtn.onclick = () => Z.openRminjectModal();
      const jumpBtn = document.getElementById('btn-adv-jump');
      if (jumpBtn) jumpBtn.onclick = () => Z.jumpToFindingTab(selFinding);
      const burstBtn = document.getElementById('btn-adv-burst');
      if (burstBtn) burstBtn.onclick = () => Z.openModal('burst');
    }

    if (diag.healthyChecks.length > 0) {
      healthyEl.innerHTML = `
        <div class="c-dim" style="font-size: 11.5px;">Verified Healthy (${diag.healthyChecks.length} cleared):</div>
        <div class="healthy-list">
          ${diag.healthyChecks.map(h => `<span><span class="c-green">✓</span> <span class="c-bright">${h.label}</span> <span class="c-dim">(${h.metric})</span></span>`).join('')}
        </div>
      `;
    } else {
      healthyEl.innerHTML = `<div class="c-muted">Verified Healthy: none cleared in current preset.</div>`;
    }
  }

  function getSortedThreads(snap, proc) {
    const list = (snap && Array.isArray(snap.threadSnapshots) && snap.threadSnapshots.length > 0)
      ? [...snap.threadSnapshots]
      : (proc && Array.isArray(proc.threads) ? [...proc.threads] : []);
    list.sort((a, b) => {
      if (state.threadSort === 'ctxsw') return (b.ctxSwPerSec - a.ctxSwPerSec) || (b.cpuPct - a.cpuPct);
      if (state.threadSort === 'tid') return a.tid - b.tid;
      return (b.cpuPct - a.cpuPct) || (b.ctxSwPerSec - a.ctxSwPerSec);
    });
    return list;
  }

  function renderTab6Threads() {
    const proc = getAttachedProcess();
    const unattEl = document.getElementById('tab6-unattached');
    const attEl = document.getElementById('tab6-attached');
    if (!unattEl || !attEl) return;

    if (!proc) {
      unattEl.style.display = 'flex';
      attEl.style.display = 'none';
      renderPickerTable('t6-picker-tbody', 't6-sort-label');
      return;
    }

    unattEl.style.display = 'none';
    attEl.style.display = 'flex';
    const snap = state.lastSnap;
    const ps = snap ? snap.presentStats : null;
    const presentWrap = document.getElementById('tab6-present-wrap');
    const presentHr = document.getElementById('tab6-present-hr');

    if (ps) {
      presentWrap.style.display = 'flex';
      presentHr.style.display = 'block';
      const flipCls = isComposedPresentMode(ps.presentMode) ? 'c-yellow c-bright' : 'c-green';
      const low1Cls = ps.low1Ms >= 16.7 ? 'c-yellow' : '';
      const low01Cls = ps.low01Ms >= 25.0 ? 'c-red' : (ps.low01Ms >= 16.7 ? 'c-yellow' : '');
      document.getElementById('g-ft-stats').innerHTML =
        `<span class="c-bright">FPS ${ps.fps.toFixed(1)}</span>` +
        `<span class="c-muted">│</span>` +
        `<span>Avg <span class="c-bright">${ps.avgMs.toFixed(1)} ms</span></span>` +
        `<span class="c-muted">│</span>` +
        `<span>1% Low <span class="${low1Cls}">${ps.low1Ms.toFixed(1)} ms</span></span>` +
        `<span class="c-muted">│</span>` +
        `<span>0.1% Low <span class="${low01Cls}">${ps.low01Ms.toFixed(1)} ms</span></span>` +
        `<span class="c-muted">│</span>` +
        `<span>Flip: <span class="${flipCls}">${ps.presentMode}</span></span>`;

      const ftColor = isComposedPresentMode(ps.presentMode)
        ? 'var(--yellow)'
        : (ps.low01Ms >= 25.0 ? 'var(--orange)' : 'var(--cyan)');
      const baseFt = (state.activeBaseline && state.activeBaseline.avgFrameMs) ? state.activeBaseline.avgFrameMs : null;
      renderBrailleGraph(
        document.getElementById('g-ft-canvas'),
        document.getElementById('g-ft-axis'),
        state.history.frametimeMs,
        { minVal: 0, minSpan: 4.0, baseline: baseFt, color: ftColor, fmtAxis: v => v.toFixed(1) }
      );
    } else {
      presentWrap.style.display = 'none';
      presentHr.style.display = 'none';
    }

    const origMap = state.originalAffinityByPid[proc.pid] || {};
    const editedCnt = Object.keys(origMap).length;
    const sortNames = { cpu: 'CPU%', ctxsw: 'CtxSw/s', tid: 'TID' };
    document.getElementById('threads-sort-label').textContent = sortNames[state.threadSort] || 'CPU%';
    const isProt = Boolean(proc.protectedProcess || state.simProtectedProcess);
    const protTag = isProt ? ` <span class="c-yellow">[Protected Process]</span>` : '';
    const presentOffTag = ps ? '' : ` <span class="c-muted">│ Present ETW: inactive (non-presenting)</span>`;
    document.getElementById('threads-summary-left').innerHTML =
      `<span class="c-bright">${proc.name}</span> (${proc.pid}) │ ${(proc.threads || []).length} threads${protTag}${presentOffTag}`;
    const revBtn = document.getElementById('btn-thread-revert');
    if (revBtn) {
      revBtn.textContent = editedCnt > 0 ? `Revert All (${editedCnt}) [R]` : 'Revert All (R)';
    }

    const sorted = getSortedThreads(snap, proc);
    state.threadSelectedIdx = Math.max(0, Math.min(Math.max(0, sorted.length - 1), state.threadSelectedIdx));

    const tbody = document.getElementById('threads-tbody');
    if (sorted.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="left c-dim" style="padding: 10px 2px;">No threads reported for this process.</td></tr>`;
      return;
    }

    tbody.innerHTML = sorted.map((t, idx) => {
      const sel = idx === state.threadSelectedIdx ? 'selected' : '';
      const mark = idx === state.threadSelectedIdx ? `<span class="c-bright">&gt; </span>` : `<span class="c-muted">  </span>`;
      const entry = formatThreadEntry(t, proc.modules);
      const isNamed = Boolean(t.description && t.description.trim());
      const cpuCls = t.cpuPct >= 70.0 ? 'c-yellow c-bright' : (t.cpuPct >= 30.0 ? 'c-bright' : 'c-dim');
      const ctxCls = t.ctxSwPerSec >= 8000 ? 'c-yellow' : 'c-dim';
      const stCls = t.state === 'Running' ? 'c-green' : (t.state === 'Ready' ? 'c-cyan' : 'c-dim');
      const stateWait = t.state === 'Waiting' && t.waitReason && t.waitReason !== '-'
        ? `<span class="${stCls}">${t.state}</span> <span class="c-muted">/</span> <span class="${t.waitReason === 'WrPageIn' || t.waitReason === 'WrPushLock' ? 'c-yellow' : 'c-dim'}">${t.waitReason}</span>`
        : `<span class="${stCls}">${t.state}</span>`;
      const cpuTag = 'C' + String(t.currentCpu).padStart(2, '0');
      const affShort = describeAffinityMask(t.affinityMask, CONFIG.physicalCores, CONFIG.logicalCpus);
      const affHex = formatAffinityHex(t.affinityMask);
      const isEdited = t.tid in origMap;
      const editTag = isEdited ? `<span class="c-cyan c-bright">*</span>` : '';
      const smtTag = t.smtContended
        ? ` <span class="c-yellow c-bright" title="Running on or pinned to an active SMT-contended physical core pair">⇄</span>`
        : '';
      const affLabel = affShort === affHex ? affHex : `${affShort} (${affHex})`;
      return `
        <tr class="selectable ${sel}" data-tid="${t.tid}" data-tidx="${idx}">
          <td class="left c-dim">${mark}${t.tid}</td>
          <td class="left ${isNamed ? 'c-bright' : 'c-cyan'}" title="${isNamed ? 'GetThreadDescription' : 'Win32StartAddress module offset fallback'}">${entry}</td>
          <td class="${cpuCls}">${t.cpuPct.toFixed(1)}%</td>
          <td class="${ctxCls}">${Math.round(t.ctxSwPerSec).toLocaleString()}/s</td>
          <td class="left">${stateWait}</td>
          <td class="left">${cpuTag} <span class="c-muted">│</span> <span class="${isEdited ? 'c-cyan' : 'c-dim'}">${affLabel}${editTag}</span>${smtTag}</td>
          <td class="c-dim">${t.basePriority}</td>
        </tr>
      `;
    }).join('');

    tbody.querySelectorAll('tr[data-tid]').forEach(tr => {
      tr.onclick = () => {
        state.threadSelectedIdx = Number(tr.dataset.tidx);
        renderTab6Threads();
      };
      tr.ondblclick = () => {
        state.threadSelectedIdx = Number(tr.dataset.tidx);
        Z.openAffinityModal(Number(tr.dataset.tid));
      };
    });
  }

  function renderAffinityModal() {
    const proc = getAttachedProcess();
    if (!proc || !state.affinityModalTid) return;
    const thread = (proc.threads || []).find(t => t.tid === state.affinityModalTid);
    if (!thread) return;

    const entry = formatThreadEntry(thread, proc.modules);
    const origMap = state.originalAffinityByPid[proc.pid] || {};
    const origMask = origMap[thread.tid];
    const editedCount = Object.keys(origMap).length;
    const isProt = Boolean(proc.protectedProcess || state.simProtectedProcess);
    const physMask = getPrimaryPhysicalCoresMask(CONFIG.physicalCores);
    const pc = CONFIG.physicalCores.find(p => p.siblings.includes(thread.currentCpu)) || CONFIG.physicalCores[0];
    const s0 = pc.siblings[0];
    const s1 = pc.siblings[1];

    document.getElementById('affinity-modal-title').textContent = `Thread Affinity Editor - TID ${thread.tid} (${entry})`;
    const protWarn = isProt ? ` <span class="c-red c-bright">[Protected Process: ERROR_ACCESS_DENIED]</span>` : '';
    const origHtml = origMask !== undefined
      ? ` <span class="c-dim">│ Original: ${formatAffinityHex(origMask)}</span>`
      : '';
    document.getElementById('affinity-thread-info').innerHTML =
      `Process: <span class="c-bright">${proc.name}</span> (${proc.pid}) │ Current CPU: <span class="c-cyan">C${String(thread.currentCpu).padStart(2, '0')}</span> │ Mask: <span class="c-bright">${formatAffinityHex(thread.affinityMask)}</span>${origHtml}${protWarn}`;

    document.getElementById('affinity-phys-mask').textContent = formatAffinityHex(physMask);
    document.getElementById('affinity-single-hint').textContent = s1 !== undefined
      ? `C${String(s0).padStart(2, '0')} (${formatAffinityHex(1 << s0)}), excl C${String(s1).padStart(2, '0')}`
      : `C${String(s0).padStart(2, '0')} (${formatAffinityHex(1 << s0)})`;
    document.getElementById('affinity-revert-count').textContent = `${editedCount} edited`;

    const cmpEl = document.getElementById('affinity-baseline-cmp');
    const base = state.activeBaseline;
    const snap = state.lastSnap;
    if (base && snap) {
      cmpEl.classList.remove('is-hidden');
      const ipcDelta = fmtDeltaPct(snap.ipc, base.ipc, true);
      const ftHtml = (snap.presentStats && base.avgFrameMs)
        ? ` │ Frametime: <span class="c-bright">${snap.presentStats.avgMs.toFixed(1)} ms</span> ${fmtDeltaPct(snap.presentStats.avgMs, base.avgFrameMs, false)} <span class="c-dim">(base ${base.avgFrameMs.toFixed(1)} ms)</span>`
        : '';
      cmpEl.innerHTML =
        `<span>vs Baseline (<span class="c-bright">${base.name}</span>): IPC <span class="c-bright">${snap.ipc.toFixed(2)}</span> ${ipcDelta}${ftHtml}</span>` +
        `<span class="c-dim">live A/B</span>`;
    } else {
      cmpEl.classList.add('is-hidden');
    }
  }

  Object.assign(Z, { renderTab2Cache, renderTab3Tlb, getFilteredProcesses, renderPickerTable, renderTab4Memory, renderTab5Advisor, getSortedThreads, renderTab6Threads, renderAffinityModal });
})();
