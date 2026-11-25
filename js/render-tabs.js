// Tab 2 Cache, Tab 3 TLB, Process Picker, Tab 4 Memory, and Tab 5 Advisor renderers
(() => {
  'use strict';
  const Z = window.Zen2Top || (window.Zen2Top = {});
  const { CONFIG, MUX_PRESETS, PROCESSES, state, getActiveMux, getAttachedProcess, fmtAddr, fmtDeltaPct, fmtMiB, fmtRate, fmtTimeSec, severityClass, evaluateDiagnostics, formatEstGainCell, renderBrailleGraph } = Z;

  function renderTab2Cache() {
    const snap = state.lastSnap;
    if (!snap) return;
    const muxId = MUX_PRESETS[state.muxIndex].id;
    const base = state.activeBaseline;
    const hasFull = muxId === 'full';
    const hasCache = muxId === 'full' || muxId === 'ipc-mem';
    const hasL3 = muxId !== 'tlb' && muxId !== 'no-pmu';
    const instM = snap.instPerSec / 1000.0;

    const rows = [
      {
        label: 'L1 -> L2 I-Cache',
        avail: hasFull,
        rate: fmtRate(snap.l1ic * instM),
        dem: snap.l1ic.toFixed(2),
        hwpf: '--',
        total: snap.l1ic,
        base: base ? base.l1icMpki : null,
        note: `L2->L3: ${snap.l2ic.toFixed(2)} MPKI`
      },
      {
        label: 'L1 -> L2 D-Cache',
        avail: hasFull,
        rate: fmtRate(snap.l1dc * instM),
        dem: snap.l1dc.toFixed(2),
        hwpf: '--',
        total: snap.l1dc,
        base: base ? base.l1dcMpki : null,
        note: `L2->L3: ${snap.l2dc.toFixed(2)} MPKI`
      },
      {
        label: 'D-Cache -> L3 Hit',
        avail: hasCache,
        rate: fmtRate((snap.demL3 + (hasFull ? snap.hwpfL3 : 0)) * instM),
        dem: snap.demL3.toFixed(2),
        hwpf: hasFull ? snap.hwpfL3.toFixed(2) : '--',
        total: snap.demL3 + (hasFull ? snap.hwpfL3 : 0),
        base: base ? base.l3HitMpki : null,
        note: `${((snap.demL3 / Math.max(0.01, snap.demL3 + snap.demDram)) * 100).toFixed(1)}% of DC fills`
      },
      {
        label: 'D-Cache -> DRAM',
        avail: hasCache,
        rate: fmtRate((snap.demDram + (hasFull ? snap.hwpfDram : 0)) * instM),
        dem: snap.demDram.toFixed(2),
        hwpf: hasFull ? snap.hwpfDram.toFixed(2) : '--',
        total: snap.demDram + (hasFull ? snap.hwpfDram : 0),
        base: base ? base.dramMpki : null,
        note: `${((snap.demDram / Math.max(0.01, snap.demDram + (hasFull ? snap.hwpfDram : 0))) * 100).toFixed(0)}% Demand`
      },
      {
        label: 'L2 HWPF -> L3',
        avail: hasFull,
        rate: fmtRate(snap.l2pfL3 * instM),
        dem: '--',
        hwpf: snap.l2pfL3.toFixed(2),
        total: snap.l2pfL3,
        base: base ? base.l2pfL3Mpki : null,
        note: `${((snap.l2pfL3 / Math.max(0.01, snap.l2pfL3 + snap.l2pfDram)) * 100).toFixed(1)}% L3 hit`
      },
      {
        label: 'L2 HWPF -> DRAM',
        avail: hasFull,
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
        `<span class="c-dim">${muxId === 'uarch' ? 'CCX L3 PMU active in Micro-Arch (0-Mux)' : 'CCX0 + CCX1 Aggregate'}</span>`;
    } else {
      l3El.innerHTML = `<span class="c-dim">Cache &amp; CCX L3 counters inactive in TLB-Only (0-Mux) preset. Press 'm' to switch.</span>`;
    }

    const avgDram = state.cum.samples > 0 ? state.cum.dram / state.cum.samples : snap.dramTotal;
    const avgLat = state.cum.samples > 0 ? state.cum.latNs / state.cum.samples : snap.l3LatNs;

    document.getElementById('g-dram-stats').innerHTML = hasCache
      ? `<span class="${severityClass(snap.dramTotal, 1.5, 3.0)} c-bright">${snap.dramTotal.toFixed(2)}</span>` +
        `${fmtDeltaPct(snap.dramTotal, base ? base.dramMpki : null, false)}` +
        `<span class="c-dim">avg ${avgDram.toFixed(2)}</span>`
      : `<span class="c-dim">N/A (${getActiveMux().label})</span>`;

    document.getElementById('g-lat-stats').innerHTML = hasL3
      ? `<span class="${severityClass(snap.l3LatNs, 55, 70)} c-bright">${snap.l3LatNs.toFixed(1)} ns</span>` +
        `${fmtDeltaPct(snap.l3LatNs, base ? base.l3LatNs : null, false)}` +
        `<span class="c-dim">avg ${avgLat.toFixed(1)} ns</span>`
      : `<span class="c-dim">N/A</span>`;

    renderBrailleGraph(
      document.getElementById('g-dram-canvas'),
      document.getElementById('g-dram-axis'),
      hasCache ? state.history.dram : state.history.dram.map(() => 0),
      { minVal: 0, baseline: (hasCache && base) ? base.dramMpki : null, color: hasCache ? 'var(--red)' : 'var(--fg-muted)' }
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
    const muxId = MUX_PRESETS[state.muxIndex].id;
    const hasTlb = muxId === 'full' || muxId === 'tlb';
    const base = state.activeBaseline;

    const avgItlb = state.cum.samples > 0 ? state.cum.l2itlb / state.cum.samples : snap.l2Itlb;
    const avgDtlb = state.cum.samples > 0 ? state.cum.l2dtlb / state.cum.samples : snap.l2Dtlb;

    document.getElementById('g-itlb-stats').innerHTML = hasTlb
      ? `<span class="${severityClass(snap.l2Itlb, 0.35, 0.80)} c-bright">${snap.l2Itlb.toFixed(3)}</span>` +
        `${fmtDeltaPct(snap.l2Itlb, base ? base.l2itlbMpki : null, false)}` +
        `<span class="c-dim">L1m ${snap.l1ItlbMissPct.toFixed(2)}% │ avg ${avgItlb.toFixed(3)}</span>`
      : `<span class="c-dim">N/A (${getActiveMux().label})</span>`;

    document.getElementById('g-dtlb-stats').innerHTML = hasTlb
      ? `<span class="${severityClass(snap.l2Dtlb, 0.50, 1.00)} c-bright">${snap.l2Dtlb.toFixed(3)}</span>` +
        `${fmtDeltaPct(snap.l2Dtlb, base ? base.l2dtlbMpki : null, false)}` +
        `<span class="c-dim">L1m ${snap.l1DtlbMissPct.toFixed(2)}% │ avg ${avgDtlb.toFixed(3)}</span>`
      : `<span class="c-dim">N/A (${getActiveMux().label})</span>`;

    renderBrailleGraph(
      document.getElementById('g-itlb-canvas'),
      document.getElementById('g-itlb-axis'),
      hasTlb ? state.history.l2itlb : state.history.l2itlb.map(() => 0),
      { minVal: 0, minSpan: 0.25, baseline: (hasTlb && base) ? base.l2itlbMpki : null, color: hasTlb ? 'var(--cyan)' : 'var(--fg-muted)', fmtAxis: v => v.toFixed(2) }
    );
    renderBrailleGraph(
      document.getElementById('g-dtlb-canvas'),
      document.getElementById('g-dtlb-axis'),
      hasTlb ? state.history.l2dtlb : state.history.l2dtlb.map(() => 0),
      { minVal: 0, minSpan: 0.35, baseline: (hasTlb && base) ? base.l2dtlbMpki : null, color: hasTlb ? 'var(--blue)' : 'var(--fg-muted)', fmtAxis: v => v.toFixed(2) }
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
      const allocCls = p.allocatorType === 'tier0_mimalloc' ? 'c-green'
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
    document.getElementById('mem-os-tbody').innerHTML = `
      <tr><td class="k">Private Working Set</td><td class="v c-bright">${fmtMiB(proc.wsMiB)}</td></tr>
      <tr><td class="k">Shared Working Set</td><td class="v c-dim">${fmtMiB(proc.sharedMiB)}</td></tr>
      <tr><td class="k">Total 4 KiB Working Set</td><td class="v">${fmtMiB(total4k)}</td></tr>
      <tr><td class="k">Hardware 2 MiB Huge Pages</td><td class="v ${proc.hugeMiB > 0 ? 'c-green c-bright' : 'c-yellow'}">${fmtMiB(proc.hugeMiB)}</td></tr>
      <tr><td class="k">Total Real Physical RAM</td><td class="v c-cyan c-bright">${fmtMiB(totalReal)}</td></tr>
      <tr><td class="k">Virtual Commit / Peak</td><td class="v">${fmtMiB(proc.commitMiB)} <span class="c-dim">/ ${fmtMiB(proc.peakCommitMiB)}</span></td></tr>
      <tr><td class="k">CPU (usr / sys / elapsed)</td><td class="v">${fmtTimeSec(proc.userSec)} / ${fmtTimeSec(proc.sysSec)} <span class="c-dim">/ ${fmtTimeSec(proc.elapsedSec)} (${(snap.cpuUsr + snap.cpuSys).toFixed(1)}%)</span></td></tr>
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
    if (proc.arenas && proc.heapStats) {
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
        : 'Mimalloc v2 Huge Arenas (mimalloc.dll)';

      root.innerHTML = `
        <div class="split-2" style="height: 100%;">
          <div style="display: flex; flex-direction: column; min-height: 0; overflow-y: auto;">
            <div class="section-label">
              <span>${allocTitle}</span>
              <span class="c-dim" style="font-weight: 400; font-size: 11.5px;"><span class="c-green">█</span> active  <span class="c-yellow">▓</span> peak  <span class="c-muted">░</span> free</span>
            </div>
            <div style="margin-bottom: 4px;">${arenaRows}${osRowsHtml}</div>
            <hr class="h-rule-tight">
            <table class="kv-table" style="font-size: 12px;">
              <tr><td class="k">Active Huge Blocks</td><td class="v c-bright">${actBlocks}/${totalBlocks} (${fmtMiB(actBlocks * 32)}, ${totalBlocks > 0 ? ((actBlocks / totalBlocks) * 100).toFixed(1) : '0.0'}%)</td></tr>
              <tr><td class="k">Peak Touched Blocks</td><td class="v c-yellow">${tchBlocks}/${totalBlocks} (${fmtMiB(tchBlocks * 32)}, ${totalBlocks > 0 ? ((tchBlocks / totalBlocks) * 100).toFixed(1) : '0.0'}%)</td></tr>
              <tr><td class="k">Real Free Headroom</td><td class="v ${freeCls}">${freeBlocks}/${totalBlocks} (${fmtMiB(freeBlocks * 32)}, ${freePct}%)</td></tr>
              <tr><td class="k">4 KiB OS Arenas</td><td class="v">${osArenaSummary}</td></tr>
            </table>
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
    } else {
      const total = Math.max(1, proc.hugeMiB + proc.wsMiB + proc.sharedMiB);
      const breakdown = [
        { name: '2 MiB Large Pages', bytes: proc.hugeMiB, col: 'var(--green)', note: 'Locked physical huge pages (VirtualAlloc MEM_LARGE_PAGES)' },
        { name: '4 KiB Private Working Set', bytes: proc.wsMiB, col: 'var(--fg)', note: 'Process-private heap & stack pages (ucrtbase / OS; ~8 MiB L2 dTLB reach)' },
        { name: 'Mapped / Image Shared', bytes: proc.sharedMiB, col: 'var(--cyan)', note: 'PE images, shared sections, and memory-mapped files' }
      ];
      root.innerHTML = `
        <div style="display: flex; flex-direction: column; height: 100%;">
          <div class="section-label">
            <span>OS Virtual Memory &amp; Working Set Backing Breakdown</span>
            <span class="c-dim" style="font-weight: 400; font-size: 12px;">Allocator: ${proc.allocatorLabel} (no Mimalloc v2 symbols)</span>
          </div>
          <table class="tui-table">
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
          </table>
        </div>
      `;
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
      const sevCls = s => (s === 'HI' ? 'sev-hi' : (s === 'MD' ? 'sev-md' : 'sev-lo'));

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

      const tabNames = { 1: 'Overview', 2: 'Cache', 3: 'TLB & Pages', 4: 'Memory' };
      const jumpHtml = selFinding.quickJumpTab
        ? `<button class="btn-inline" id="btn-adv-jump">Enter: Jump to Tab ${selFinding.quickJumpTab} (${tabNames[selFinding.quickJumpTab]})</button>`
        : `<span class="c-muted">No linked tab</span>`;
      const gainDetailText = selFinding.estGain ? selFinding.estGain.detail : 'N/A';

      detailEl.innerHTML = `
        <div class="advisor-detail-row"><span class="c-dim">Why</span><span>${selFinding.why}</span></div>
        <div class="advisor-detail-row"><span class="c-dim">Gain Est</span><span class="c-cyan">${gainDetailText}</span></div>
        <div class="advisor-detail-row"><span class="c-dim">Action</span><span class="c-bright">${selFinding.action}</span></div>
        <div class="advisor-detail-row"><span class="c-dim">Cascade</span><span class="c-dim">${selFinding.cascade}</span></div>
        <div style="display:flex; justify-content:space-between; align-items:center; font-size: 11.5px; margin-top: 2px;">
          <span class="c-dim">Rule: <span class="c-bright">${selFinding.id}</span> │ Scope: ${selFinding.scope} │ Confidence: ${selFinding.confidence}</span>
          ${jumpHtml}
        </div>
      `;
      const jumpBtn = document.getElementById('btn-adv-jump');
      if (jumpBtn) jumpBtn.onclick = () => Z.jumpToFindingTab(selFinding);
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

  Object.assign(Z, { renderTab2Cache, renderTab3Tlb, getFilteredProcesses, renderPickerTable, renderTab4Memory, renderTab5Advisor });
})();
