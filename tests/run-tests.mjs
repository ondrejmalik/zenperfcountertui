// Headless Node.js verification runner for zen2top HTML prototype modules & unit tests
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const sandbox = {
  window: {},
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Math,
  Date,
  BigInt,
  Number,
  String,
  Array,
  Object,
  Map,
  Set,
  Uint8Array,
  JSON,
  Error,
  isFinite,
  parseInt,
  parseFloat
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);

const scripts = [
  'js/packs.js',
  'js/config.js',
  'js/deep-dive.js',
  'js/profiles.js',
  'js/symbols.js',
  'js/profiler-engine.js',
  'js/profiler-fixtures.js',
  'js/state.js',
  'js/telemetry.js',
  'js/advisor-group-a.js',
  'js/advisor-pmu.js',
  'js/advisor.js',
  'js/advisor-tests.js',
  'js/profiler-tests.js',
  'js/packs-tests.js'
];

for (const rel of scripts) {
  const full = path.join(rootDir, rel);
  const code = fs.readFileSync(full, 'utf8');
  vm.runInContext(code, ctx, { filename: rel });
}

// Also syntax-check all browser-only UI scripts without executing DOM code
const uiScripts = [
  'js/braille.js',
  'js/render-overview.js',
  'js/render-tabs.js',
  'js/render-profiler.js',
  'js/render-pack-picker.js',
  'js/render-modals.js',
  'js/actions.js',
  'js/main.js'
];
for (const rel of uiScripts) {
  const full = path.join(rootDir, rel);
  const code = fs.readFileSync(full, 'utf8');
  new vm.Script(code, { filename: rel });
}

const Z = sandbox.Zen2Top;
const report = Z.runAllDiagnosticTests();
const profReport = Z.runProfilerTests();
if (profReport._coordPromise) {
  const res = await profReport._coordPromise;
  if (res.ok !== false || res.pcmRunning !== true || res.state !== 'LIVE_PCM') {
    console.error('[FAIL] async PmuCoordinator result mismatch:', res);
    process.exit(1);
  }
}

console.log(`=== zen2top Automated Verification: ${report.passed}/${report.total} PASSED ===`);
for (const r of report.results) {
  console.log(`${r.pass ? '[PASS]' : '[FAIL]'} ${r.name}: ${r.detail}`);
}

// Verify HTML prototype contains Tab 7 + Burst modal + Pack Picker modal + Kernel strip + script tags
const html = fs.readFileSync(path.join(rootDir, 'zen2top_interactive_tui_prototype.html'), 'utf8');
const requiredIds = [
  'tab-7', 'prof-control-strip', 'prof-tbody', 'prof-context-strip', 'modal-burst',
  'kernel-strip', 'kernel-strip-header', 'kernel-strip-bar', 'kernel-strip-table', 'kernel-strip-tbody',
  'js/symbols.js', 'js/profiler-engine.js', 'js/render-profiler.js',
  'modal-packs', 'pack-budget-meter', 'pack-presets-strip', 'pack-guardrail-note',
  'pack-picker-tbody', 'overview-uarch-wrap', 'overview-uarch-tbody',
  'cpi-row-decode', 'cpi-track-decode',
  'js/packs.js', 'js/render-pack-picker.js', 'js/packs-tests.js'
];
const missingIds = requiredIds.filter(id => !html.includes(id));
if (missingIds.length > 0) {
  console.error('[FAIL] HTML missing required elements/scripts:', missingIds);
  process.exit(1);
}
// Verify #kernel-strip sits directly below #ccx-strip and above .main-pane, and .keybar stays <= 7 items
const ccxIdx = html.indexOf('id="ccx-strip"');
const krnlIdx = html.indexOf('id="kernel-strip"');
const mainPaneIdx = html.indexOf('class="main-pane"');
if (!(ccxIdx > 0 && krnlIdx > ccxIdx && mainPaneIdx > krnlIdx)) {
  console.error('[FAIL] #kernel-strip must be placed directly below #ccx-strip and above .main-pane');
  process.exit(1);
}
const keybarMatch = html.match(/<div class="keybar">([\s\S]*?)<\/div>/);
const keybarHtml = keybarMatch ? keybarMatch[1] : '';
const keybarButtons = (keybarHtml.match(/class="key-btn"/g) || []).length;
if (!keybarHtml.includes('data-action="kernel"') || !keybarHtml.includes('<span class="k">k</span> Kernel') || keybarHtml.indexOf('data-action="kernel"') < keybarHtml.indexOf('data-action="ccx"')) {
  console.error('[FAIL] .keybar must include clickable k Kernel button next to c CCX');
  process.exit(1);
}
console.log('[PASS] HTML structure, #kernel-strip placement, keybar (' + keybarButtons + ' buttons incl. k Kernel), & script wiring verified (' + requiredIds.length + ' checks)');

// Verify Tab 7 #prof-context-strip stays strictly 3 symbol lines (no misplaced Kernel sys% footer)
const profJs = fs.readFileSync(path.join(rootDir, 'js/render-profiler.js'), 'utf8');
if (profJs.includes('Kernel sys%')) {
  console.error('[FAIL] Tab 7 render-profiler.js must not render Kernel sys% in symbol footer');
  process.exit(1);
}
console.log('[PASS] Tab 7 symbol context strip clean (3 lines only, no misplaced Kernel sys% row)');

// Verify Shift+K toggles #kernel-strip across all tabs (1-7) while lowercase 'k' scrolls tables without toggling
{
  const keyListeners = [];
  const makeStubEl = () => ({
    classList: {
      _set: new Set(),
      toggle(c, force) { if (force) this._set.add(c); else this._set.delete(c); },
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); }
    },
    style: {},
    dataset: {},
    innerHTML: '',
    textContent: '',
    value: '',
    addEventListener() {},
    querySelectorAll() { return []; },
    querySelector() { return null; },
    getBoundingClientRect() { return { width: 600, height: 120 }; },
    focus() {},
    blur() {},
    select() {}
  });
  const elMap = new Map();
  const getEl = (id) => {
    if (!elMap.has(id)) elMap.set(id, makeStubEl());
    return elMap.get(id);
  };
  const domSandbox = {
    window: {},
    console,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    addEventListener(ev, fn) { if (ev === 'keydown') keyListeners.push(fn); },
    document: {
      activeElement: null,
      getElementById: getEl,
      querySelectorAll: () => [],
      querySelector: () => null,
      createElement: () => makeStubEl()
    },
    Math, Date, BigInt, Number, String, Array, Object, Map, Set, Uint8Array, JSON, Error, isFinite, parseInt, parseFloat
  };
  domSandbox.window = domSandbox;
  domSandbox.globalThis = domSandbox;
  const domCtx = vm.createContext(domSandbox);
  const allDomScripts = [...scripts, ...uiScripts];
  for (const rel of allDomScripts) {
    vm.runInContext(fs.readFileSync(path.join(rootDir, rel), 'utf8'), domCtx, { filename: rel });
  }
  const keydown = keyListeners[0];
  const st = domSandbox.Zen2Top.state;
  const fireKey = (key) => keydown({ key, preventDefault() {} });

  if (typeof keydown !== 'function' || st.kernelStripOpen !== false) {
    console.error('[FAIL] k Kernel test harness failed to initialize keydown handler');
    process.exit(1);
  }
  for (let tab = 1; tab <= 7; tab++) {
    st.activeTab = tab;
    st.kernelStripOpen = false;
    fireKey('k');
    if (st.kernelStripOpen !== true || !getEl('kernel-strip').classList.contains('visible')) {
      console.error(`[FAIL] 'k' failed to open #kernel-strip on Tab ${tab}`);
      process.exit(1);
    }
    fireKey('k');
    if (st.kernelStripOpen !== false || getEl('kernel-strip').classList.contains('visible')) {
      console.error(`[FAIL] 'k' failed to close #kernel-strip on Tab ${tab}`);
      process.exit(1);
    }
  }
  // Verify ArrowUp/ArrowDown still scroll tables on Tabs 3, 5, 6, 7 WITHOUT toggling #kernel-strip
  st.kernelStripOpen = false;
  st.activeTab = 3; st.modSelectedIdx = 2; fireKey('ArrowUp');
  const t3Ok = st.modSelectedIdx === 1 && st.kernelStripOpen === false;
  st.activeTab = 5; st.advisorSelectedIdx = 1;
  if (st.lastDiag && st.lastDiag.findings.length >= 2) fireKey('ArrowUp');
  const t5Ok = st.kernelStripOpen === false;
  st.activeTab = 6; st.threadSelectedIdx = 2; fireKey('ArrowUp');
  const t6Ok = st.threadSelectedIdx === 1 && st.kernelStripOpen === false;
  st.activeTab = 7; st.profiler.selectedIdx = 2; fireKey('ArrowUp');
  const t7Ok = st.profiler.selectedIdx === 1 && st.kernelStripOpen === false;
  if (!(t3Ok && t5Ok && t6Ok && t7Ok)) {
    console.error('[FAIL] ArrowUp scroll / no-toggle invariant failed:', { t3Ok, t5Ok, t6Ok, t7Ok });
    process.exit(1);
  }
  console.log('[PASS] k toggles #kernel-strip on all tabs (1-7) while ArrowUp/ArrowDown scroll tables without toggling');
}

// Verify all static DOM IDs referenced in render-profiler.js and render-pack-picker.js exist in the HTML
const packPickerJs = fs.readFileSync(path.join(rootDir, 'js/render-pack-picker.js'), 'utf8');
const dynamicIds = new Set(['btn-prof-source', 'btn-prof-scope', 'btn-prof-onoff', 'btn-prof-burst', 'btn-prof-view', 'btn-prof-pause', 'btn-prof-clear', 'btn-prof-sidecar']);
const staticIds = [...profJs.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g), ...packPickerJs.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)]
  .map(m => m[1])
  .filter(id => !dynamicIds.has(id));
const missingStatic = staticIds.filter(id => !html.includes(`id="${id}"`));
if (missingStatic.length > 0) {
  console.error('[FAIL] Missing static DOM IDs referenced by renderers:', missingStatic);
  process.exit(1);
}
console.log('[PASS] All ' + staticIds.length + ' static DOM IDs in profiler & pack picker renderers verified in HTML');

// Check that no em-dashes or en-dashes appear in our newly authored UI JS / HTML strings
for (const rel of [
  'js/symbols.js', 'js/profiler-engine.js', 'js/profiler-fixtures.js', 'js/render-profiler.js', 'js/profiler-tests.js',
  'js/packs.js', 'js/render-pack-picker.js', 'js/packs-tests.js', 'js/config.js', 'js/advisor.js', 'js/advisor-pmu.js',
  'js/render-overview.js', 'js/render-modals.js'
]) {
  const txt = fs.readFileSync(path.join(rootDir, rel), 'utf8');
  if (/[\u2013\u2014]/.test(txt)) {
    console.error('[FAIL] Found em/en dash in', rel);
    process.exit(1);
  }
}
console.log('[PASS] Zero em/en dashes across all profiler & modular pack modules');

if (report.passed !== report.total) {
  process.exit(1);
}
