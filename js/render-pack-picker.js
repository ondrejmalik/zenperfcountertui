// Interactive 'm' Metric Pack Picker Modal (6-slot budget meter, quick presets, live bin preview)
(() => {
  'use strict';
  const Z = window.Zen2Top || (window.Zen2Top = {});
  const {
    METRIC_PACKS, QUICK_PRESETS, MetricPack, state,
    buildUprofMetrics, getMuxAccuracyClass, packsEqual
  } = Z;

  function renderPackBudgetBlocks(plan) {
    return plan.bins.map(bin => {
      const cells = [];
      let filledNonPad = 0;
      let filledPad = 0;
      for (const p of bin.packs) {
        if (p.isAutoPad) filledPad += p.slots;
        else filledNonPad += p.slots;
      }
      const empty = Math.max(0, 6 - filledNonPad - filledPad);
      const grpCls = getMuxAccuracyClass(plan.muxGroups);
      if (filledNonPad > 0) cells.push(`<span class="${grpCls}">${'█'.repeat(filledNonPad)}</span>`);
      if (filledPad > 0) cells.push(`<span class="c-cyan" title="Auto-pad: Exact Retiring (0x4300C1) +0 mux cost">${'▓'.repeat(filledPad)}</span>`);
      if (empty > 0) cells.push(`<span class="c-muted">${'░'.repeat(empty)}</span>`);
      const tip = `Group G${bin.group}: ${bin.used}/6 slots (${bin.packs.map(p => p.id + (p.isAutoPad ? '*' : '')).join(', ')})`;
      return `<span class="pack-bin-block" title="${tip}">[${cells.join('')}]</span>`;
    }).join('');
  }

  function renderPackPickerModal() {
    const draft = (state.packPicker && Array.isArray(state.packPicker.draftPacks) && state.packPicker.draftPacks.length > 0)
      ? state.packPicker.draftPacks
      : state.enabledPacks;
    const plan = buildUprofMetrics(draft);
    const muxCls = getMuxAccuracyClass(plan.muxGroups);
    const dutyStr = `${Math.round(plan.dutyCyclePct)}% duty`;

    // 1. Top Budget Meter (2 lines)
    const budgetEl = document.getElementById('pack-budget-meter');
    if (budgetEl) {
      const autoPadTag = plan.autoPaddedRetiring
        ? ` <span class="c-cyan">[auto-pad: Exact Retiring +0 mux cost]</span>`
        : '';
      budgetEl.innerHTML =
        `<div class="pack-budget-line">` +
          `<span>Budget: <span class="c-bright">${plan.coreSlots} / ${plan.capacitySlots}</span> Core PMCs -&gt; ` +
          `<span class="${muxCls} c-bright">${plan.muxShort} (${dutyStr})</span>${autoPadTag}</span>` +
          `<span class="pack-bins-wrap">${renderPackBudgetBlocks(plan)}</span>` +
        `</div>` +
        `<div class="pack-free-line c-dim">Free (0-Mux): IPC, CPI, GHz, C0%, L3 Hit%, Live L3 Latency</div>`;
    }

    // 2. Quick Presets Strip (1 line)
    const presetsEl = document.getElementById('pack-presets-strip');
    if (presetsEl) {
      presetsEl.innerHTML = QUICK_PRESETS.map(p => {
        const isActive = packsEqual(draft, p.packs);
        const cls = isActive ? 'pack-preset-btn active' : 'pack-preset-btn';
        return `<button class="${cls}" data-preset-slug="${p.slug}" title="${p.name}"><span class="c-bright">[${p.key}]</span> ${p.stripLabel}</button>`;
      }).join('');
      presetsEl.querySelectorAll('[data-preset-slug]').forEach(btn => {
        btn.onclick = () => Z.selectDraftPreset(btn.dataset.presetSlug);
      });
    }

    // 3. Guardrail inline note
    const noteEl = document.getElementById('pack-guardrail-note');
    if (noteEl) {
      const msg = (state.packPicker && state.packPicker.guardrailNote) ? state.packPicker.guardrailNote : '';
      noteEl.textContent = msg;
      noteEl.classList.toggle('visible', Boolean(msg));
    }

    // 4. Pack Checklist Table ([x] | PACK NAME | SLOTS | GROUP | FEEDS)
    const tbody = document.getElementById('pack-picker-tbody');
    if (!tbody) return;

    const selIdx = Math.max(0, Math.min(METRIC_PACKS.length - 1, (state.packPicker && state.packPicker.selectedIdx) || 0));
    if (state.packPicker) state.packPicker.selectedIdx = selIdx;

    const draftSet = new Set(draft);
    tbody.innerHTML = METRIC_PACKS.map((p, idx) => {
      const isSelected = idx === selIdx;
      const isChecked = draftSet.has(p.id);
      const isAutoPad = !isChecked && p.id === MetricPack.ExactRetiring && plan.autoPaddedRetiring;
      const grp = plan.packGroupMap[p.id];

      let checkHtml;
      if (isChecked) checkHtml = `<span class="c-green c-bright">[x]</span>`;
      else if (isAutoPad) checkHtml = `<span class="c-cyan">[+]</span>`;
      else checkHtml = `<span class="c-muted">[ ]</span>`;

      const groupHtml = grp
        ? `<span class="${isAutoPad ? 'c-cyan' : muxCls}">G${grp}</span>`
        : `<span class="c-muted">--</span>`;

      const autoPadMarker = isAutoPad
        ? ` <span class="c-cyan">[auto-pad +0 mux]</span>`
        : '';

      const nameCls = isChecked ? 'c-bright' : (isAutoPad ? 'c-cyan' : 'c-dim');
      return `
        <tr class="selectable ${isSelected ? 'selected' : ''}" data-pack-id="${p.id}" data-pack-idx="${idx}" title="${p.name} (${p.hexSummary})">
          <td class="left">${checkHtml}</td>
          <td class="left ${nameCls}">${p.name}${autoPadMarker}</td>
          <td class="${isChecked || isAutoPad ? '' : 'c-muted'}">${p.slots}</td>
          <td>${groupHtml}</td>
          <td class="left c-dim">${p.feeds}</td>
        </tr>
      `;
    }).join('');

    tbody.querySelectorAll('tr[data-pack-id]').forEach(tr => {
      tr.onclick = () => {
        if (state.packPicker) state.packPicker.selectedIdx = Number(tr.dataset.packIdx);
        Z.toggleDraftPack(tr.dataset.packId);
      };
    });
  }

  Object.assign(Z, { renderPackBudgetBlocks, renderPackPickerModal });
})();
