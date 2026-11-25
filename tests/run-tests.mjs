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

// Verify HTML prototype contains Tab 7 + Burst modal + Pack Picker modal + script tags
const html = fs.readFileSync(path.join(rootDir, 'zen2top_interactive_tui_prototype.html'), 'utf8');
const requiredIds = [
  'tab-7', 'prof-control-strip', 'prof-tbody', 'prof-context-strip', 'modal-burst',
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
console.log('[PASS] HTML structure & script wiring verified (' + requiredIds.length + ' checks)');

// Verify all static DOM IDs referenced in render-profiler.js and render-pack-picker.js exist in the HTML
const profJs = fs.readFileSync(path.join(rootDir, 'js/render-profiler.js'), 'utf8');
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
