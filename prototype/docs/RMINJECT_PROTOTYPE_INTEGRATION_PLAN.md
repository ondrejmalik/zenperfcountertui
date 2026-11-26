# `zen2top` + `rminject` Prototype Integration Plan

**Status:** Visual & Architectural Integration Specification (Prototype Phase)
**Target Repository:** `C:\Users\Administrator\.t3\projects\zenperfcountertui`
**Related Backend Spec:** `C:\Users\Administrator\.t3\projects\c-users-administrator-appdata-local-sunbird-sunbird-mi\docs\UNIVERSAL_MIHEAP_PLAN.md`

---

## 1. Context & Design Alignment

`zen2top` already detects the exact two CPU/OS bottlenecks that `miheap.dll` + `mimalloc.dll` with 2 MiB huge pages solves:
- `crt_heap_dtlb` in [js/advisor-pmu.js](file:///C:/Users/Administrator/.t3/projects/zenperfcountertui/js/advisor-pmu.js#L91-L106) (Rule 2: `L2 dTLB >= 0.50 MPKI`, `hugeMiB === 0`, `wsMiB >= 512`)
- `kernel_page_fault_churn` in [js/advisor-pmu.js](file:///C:/Users/Administrator/.t3/projects/zenperfcountertui/js/advisor-pmu.js#L320-L360) (Rule 7: `Mi*/Mm* >= 40%` sys + `avgPfRate >= 2000/s`)

And Tab 4 ([js/render-tabs.js](file:///C:/Users/Administrator/.t3/projects/zenperfcountertui/js/render-tabs.js#L469-L589)) already renders live Mimalloc v2 2 MiB Huge Arena bitmaps (`█ active`, `▓ peak`, `░ free`) alongside `4 KiB OS Arenas` spillover tracking and `_mi_stats_main`.

However, blindly adding a generic "Inject Mimalloc" button for every process would violate `zen2top`'s deterministic, evidence-gated design. **Only eligible native Win32/CRT targets benefit; custom engine allocators, browsers, GC runtimes, and anti-cheat protected processes must be deterministically excluded.**

---

## 2. Goals, Non-Goals, and Anti-Goals

### Goals

1. **Deterministic 5-state allocator eligibility classification** using loaded modules + PE imports + OS guardrails (zero guesswork).
2. **IFEO-parity safety guardrails** inside a dedicated `#modal-rminject` relaunch modal (`i` hotkey on Tab 4 and Tab 5): non-destructive in-memory PE import injection (`rminject run --inject`), Authenticode signature untouched on disk, `SeLockMemoryPrivilege` check, physical RAM headroom check, and protected-process hard block.
3. **Peak Working Set auto-sizing** for `MIMALLOC_RESERVE_HUGE_OS_PAGES` so `--large` defaults to a safe GiB reservation without triggering `over_reserved_huge_pages` (Group A Rule 14) or `hard_page_faults` (Group A Rule 5).
4. **Closed-loop A/B verification:** Automatically pin the current cumulative session as the active baseline before relaunching, attach to the `miheap`-injected successor process, surface `[miheap]` hook stats alongside Tab 4's live Mimalloc arena view, and expose real `vs BASE` L2 dTLB / page-fault / IPC deltas.

### Non-Goals

1. **Never invoke disk-modifying `rminject patch` from inside `zen2top`:** All `zen2top`-initiated launches use non-destructive in-memory injection (`rminject run --inject`).
2. **Never hot-inject mid-flight into an already-running PID:** Existing allocations stay on the OS heap and process state cannot be cleanly migrated; `zen2top` always models a clean relaunch (consistent with IFEO `restart target*` semantics in Tab 3).
3. **Never replace Tab 3 IFEO controls or Tab 4's existing Mimalloc / VA Map views:** `rminject` complements them for heap dTLB and VirtualAlloc commit churn.

### Anti-Goals (Hard Prohibitions)

1. **NEVER offer `rminject` on Protected / Anti-Cheat Processes** (`proc.protectedProcess === true`, e.g., `cs2.exe`, or detected anti-cheat modules/drivers): display an explicit hard block matching `#modal-ifeo` and `#modal-affinity`.
2. **NEVER offer `rminject` on Custom `VirtualAlloc` or GC Runtimes:** (`deadlock.exe` with `tier0.dll`, `blender.exe` with `tbbmalloc.dll` / `mimalloc.dll`, `chrome.exe` with `PartitionAlloc` / `chrome.dll`, `cyberpunk2077.exe` with `REDengine4`, `javaw.exe` with `jvm.dll`, `coreclr_sim.exe` with `coreclr.dll`). Instead, explain cleanly why it was skipped and point to the runtime's own mechanism (e.g., `-XX:+UseLargePages` or existing Mimalloc arena tuning).
3. **NEVER suggest `--large` (`MIMALLOC_RESERVE_HUGE_OS_PAGES > 0`) when `SeLockMemoryPrivilege === 'Missing'` or `availPhysPct < 20%`:** Default `--large` reservation to `0` (standard low-RAM mode) and clearly warn why 2 MiB huge arenas are locked out.
4. **NEVER fabricate exact `+XX% IPC` uplift predictions for `rminject`:** Keep pre-relaunch Advisor impact estimates grounded in the existing Amdahl L2 dTLB tier formula (`crt_heap_dtlb`) and qualitative `-sys% / stutter` (`kernel_page_fault_churn`), and measure actual gains post-relaunch via `vs BASE`.
5. **Zero em-dashes (`\u2014`) or en-dashes (`\u2013`)** in any `zen2top` HTML, JS, or CSS strings (enforced by `tests/run-tests.mjs`).

---

## 3. Deterministic 5-State Eligibility Classifier (`classifyAllocatorEligibility`)

Add a pure helper (e.g. in `js/advisor-pmu.js` or a shared module `js/rminject.js`) evaluated from `proc`, `snap`, and `CONFIG`:

```js
// Output shape:
// {
//   state: 'ELIGIBLE' | 'ALREADY_MIMALLOC' | 'CUSTOM_ALLOCATOR' | 'GC_VIRTUALALLOC' | 'BLOCKED_GUARDRAIL',
//   canRelaunch: boolean,
//   linkageLabel: string,       // e.g. '/MD UCRT (ucrtbase.dll)', 'Rust std::alloc::System (HeapAlloc)', '/MT Static UCRT'
//   blockOrSkipReason: string,  // human-readable explanation when !canRelaunch
//   recommendedMode: 'large' | 'standard',
//   recommendedHugeGiB: number, // 0 when standard or priv/RAM blocked
//   privPresent: boolean,
//   availPhysGiB: number,
//   warnings: string[]
// }
```

### Exact Classification Precedence

1. **`BLOCKED_GUARDRAIL`** (`canRelaunch = false`):
   - Triggered if `proc.protectedProcess || state.simProtectedProcess`, OR `proc.modules` contains anti-cheat/protected runtime indicators (e.g. `easyanticheat*`, `battleye*`, `vgk*`).
2. **`ALREADY_MIMALLOC`** (`canRelaunch = false`):
   - Triggered if `proc.allocatorType === 'tier0_mimalloc' || proc.allocatorType === 'generic_mimalloc' || proc.allocatorType === 'miheap_injected'`, OR `proc.modules` includes `mimalloc.dll`, `miheap.dll`, or `tier0.dll`.
3. **`GC_VIRTUALALLOC`** (`canRelaunch = false`):
   - Triggered if `proc.modules` includes `jvm.dll`, `coreclr.dll`, `clrjit.dll`, `UnityPlayer.dll`, `mono-*.dll`, or `proc.allocatorLabel` indicates JVM / CoreCLR / Go runtime.
4. **`CUSTOM_ALLOCATOR`** (`canRelaunch = false`):
   - Triggered if `proc.modules` includes `tbbmalloc.dll`, `jemalloc.dll`, `chrome.dll`, `libcef.dll`, or `proc.allocatorLabel` matches `PartitionAlloc` / `REDengine4` / `FMallocBinned`.
5. **`ELIGIBLE`** (`canRelaunch = true`):
   - Triggered when PE import metadata (in prototype: `proc.crtProfile` / `proc.modules`; in real backend: `rminject inspect --json`) shows Win32 `HeapAlloc` (`Rust` / `/MT`), `ucrtbase.dll` (`/MD`), `msvcrt.dll` (`MinGW`), or `msvcr*.dll` (legacy `/MD`).

### Peak-WS Huge-Page Auto-Sizing Formula

Let `peakWsMiB = proc.peakWsMiB || proc.wsMiB || 512`, `availPhysPct = snap.availPhysPct ?? proc.win32Profile?.availPhysPct ?? 40`, and `totalRamGiB = CONFIG.totalRamGiB || 32` (32 GiB host default; `availPhysGiB = totalRamGiB * (availPhysPct / 100.0)`):

- If `!privPresent` (`SeLockMemoryPrivilege === 'Missing'`) OR `availPhysPct < 20.0`:
  - `recommendedMode = 'standard'`
  - `recommendedHugeGiB = 0`
  - Append explicit guardrail warning (`SeLockMemoryPrivilege missing` or `Available RAM < 20%`).
- Otherwise:
  - `recommendedMode = 'large'`
  - `rawGiB = Math.ceil((peakWsMiB * 1.25) / 1024.0)` (25% headroom over Peak Private WS so allocations avoid 4 KiB OS arena spillover)
  - `maxSafeGiB = Math.max(1, Math.floor(availPhysGiB * 0.45))` (never lock >45% of currently available physical RAM)
  - `recommendedHugeGiB = Math.max(1, Math.min(rawGiB, maxSafeGiB))`

---

## 4. Exact Prototype UI & Interaction Integration Map

### 4.1 Tab 4 (`js/render-tabs.js` -> `renderTab4Memory`)

1. **Layer 2 OS Fallback View** (`proc.arenas === null`, around `js/render-tabs.js:607-652`):
   - Render a compact 1-line **Allocator Eligibility Strip** directly below the section header:
     - When `ELIGIBLE`: `rminject Eligibility: ELIGIBLE (/MD ucrtbase.dll + HeapAlloc) | Rec: --large 3 GiB (non-destructive)  [i: Relaunch w/ rminject]`
     - When `CUSTOM_ALLOCATOR` / `GC_VIRTUALALLOC`: `rminject Eligibility: SKIPPED (PartitionAlloc on VirtualAlloc - custom arena) | Hint: use native engine flags`
     - When `BLOCKED_GUARDRAIL`: `rminject Eligibility: BLOCKED (Protected / Anti-Cheat Process - injection disabled)`
2. **Layer 2 `miheap_injected` Live View** (`proc.arenas && proc.heapStats`, around `js/render-tabs.js:469-592`):
   - When `proc.allocatorType === 'miheap_injected'`, display `Mimalloc v2 Huge Arenas (miheap.dll -> mimalloc.dll)` as the section title and add a compact `[miheap]` summary row under the KV table showing:
     - `Hooked Target: ucrtbase.dll + 4 modules (18 IAT slots)`
     - `mi_allocs / frees: 142.8K / 138.1K | fallback_allocs: 12 (0% leak)`
     - Plus a `[Revert / Relaunch Baseline]` inline control or baseline delta note.

### 4.2 Tab 5 Advisor (`js/advisor-pmu.js` & `js/render-tabs.js` -> `renderTab5Advisor`)

1. Enrich `crt_heap_dtlb` (`js/advisor-pmu.js:91-106`) and `kernel_page_fault_churn` (`js/advisor-pmu.js:320-360`) findings with `rminjectEligibility = classifyAllocatorEligibility(proc, snap)`:
   - When `ELIGIBLE` and `!proc.arenas`:
     - Update the `action` field to mention detected linkage + non-destructive `rminject run --inject` (plus auto-sized `--large N GiB` when safe, or standard mode when privilege/RAM constrained).
     - Set `finding.rminjectEligible = true`.
   - When `CUSTOM_ALLOCATOR`, `GC_VIRTUALALLOC`, or `BLOCKED_GUARDRAIL`:
     - Keep `finding.rminjectEligible = false`, and append why `rminject` is intentionally suppressed (e.g., `"rminject skipped: chrome.dll uses PartitionAlloc directly on VirtualAlloc."`).
2. In `renderTab5Advisor()` (`js/render-tabs.js:738-758`):
   - Render `[i: Relaunch w/ rminject]` inline button next to `f: HW Burst` and `Enter: Jump to Tab N` **only when `selFinding.rminjectEligible === true`**.
   - Bind `i` / `I` hotkey on Tab 4 (when attached) and Tab 5 (when `selFinding.rminjectEligible` or attached) in `js/main.js` to call `openRminjectModal()`.

### 4.3 New Guardrailed Modal (`#modal-rminject`)

Mirror `#modal-ifeo` and `#modal-burst` in `zen2top_interactive_tui_prototype.html`, `js/render-modals.js`, `js/actions.js`, `js/main.js`, and `styles/zen2top.css`:

- **Header:** `Relaunch with rminject + miheap.dll (In-Memory PE Injection)` | `y Confirm | Esc Cancel`
- **Target Banner:** Target binary, PID, detected linkage (e.g., `ucrtbase.dll (/MD) + Kernel32 HeapAlloc`), and current L2 dTLB / Peak Private WS.
- **4-Point Guardrail Checklist** (mirroring `#modal-ifeo` safety discipline):
  1. `Disk Integrity: Non-destructive --inject (in-memory PE IAT; signed binary untouched)` -> `PASS`
  2. `SeLockMemoryPrivilege: Present / Missing` -> `PASS` or `WARN (locked to standard mode)`
  3. `RAM Headroom: 38.0% free (12.2 GiB avail vs 3 GiB reserve = 24.6%)` -> `PASS` or `WARN (blocks --large)`
  4. `Anti-Cheat / Protected Process: Editable` -> `PASS` or `HARD BLOCK`
- **Interactive Options:**
  - `[1] Standard Low-RAM Mode` (`MIMALLOC_ALLOW_LARGE_OS_PAGES=0`, ~2.2x faster alloc/free, 0 locked RAM)
  - `[2] --large 2 MiB Huge Arenas` (`+` / `-` buttons or `[` / `]` keys to tune `MIMALLOC_RESERVE_HUGE_OS_PAGES` GiB, clamped by guardrails)
  - `[b] Auto-pin current session as Baseline before relaunch` (default ON)
  - `[c] Follow child processes (--follow-children)` (default OFF; shows exclusion notice)
- **Live Command Preview (`code-block`):**
  - Exact command line (e.g. `rminject run --inject --large --env MIMALLOC_RESERVE_HUGE_OS_PAGES=3 -- chatterino.exe`)
- **Footer:** `[Cancel (N / Esc)]` and `[Pin Baseline & Relaunch (y / Enter)]` (disabled if `BLOCKED_GUARDRAIL`).

### 4.4 Prototype Process Profiles & Closed-Loop Simulation (`js/profiles.js`, `js/actions.js`)

1. Add a representative `/MD` C++ profile alongside existing `rustc.exe` (`HeapAlloc` eligible), `chrome.exe` (`PartitionAlloc`), `cyberpunk2077.exe` (`REDengine4`), `cs2.exe` (`Protected`), `blender.exe` (`tbbmalloc.dll` + `mimalloc.dll`):
   - Example: `chatterino.exe` (`/MD` Qt6 C++ app importing `ucrtbase.dll` + `Qt6Widgets.dll`, `wsMiB: 1480`, `peakWsMiB: 1820`, `hugeMiB: 0`, `l2Dtlb: 0.74 MPKI`, `pfRate: 2450/s`) -> triggers `crt_heap_dtlb` and classifies as `ELIGIBLE (/MD ucrtbase.dll)` with `recommendedHugeGiB = 3`.
2. Implement `confirmRminjectRelaunch()` in `js/actions.js`:
   - Re-checks `classifyAllocatorEligibility` guardrail (rejects if `BLOCKED_GUARDRAIL`).
   - If auto-pin is enabled, captures current cumulative session into `state.activeBaseline` (`<proc>_pre_rminject_<n>s.json`).
   - Clones/updates a simulated successor process entry (`allocatorType: 'miheap_injected'`, `allocatorLabel: 'miheap.dll -> mimalloc.dll (2 MiB Arenas)'`, `hugeMiB` + `arenas` + `heapStats` + `miheapStats` populated, `l2Dtlb` dropped from `0.74`/`0.86` -> `0.11`, `pfRate` dropped from `4180`/`2450` -> `190`, IPC bumped cleanly).
   - Attaches to the new PID, closes modal, resets rolling history, switches to Tab 4 (or refreshes Tab 5), and shows a confirmation toast so the user sees live Mimalloc 2 MiB arenas + `[miheap]` stats + `vs BASE` delta immediately.

---

## 5. Verification Plan for Prototype Implementation

When implementing this plan in `zenperfcountertui`:

1. **Automated Node Tests (`tests/run-tests.mjs` + `js/advisor-tests.js`):**
   - Test all 5 classifier states (`ELIGIBLE` for Rust `/MT` / `/MD`, `ALREADY_MIMALLOC` for `deadlock.exe` & `blender.exe`, `CUSTOM_ALLOCATOR` for `chrome.exe` & `cyberpunk2077.exe`, `GC_VIRTUALALLOC` for `javaw.exe` & `coreclr_sim.exe`, `BLOCKED_GUARDRAIL` for `cs2.exe`).
   - Test `SeLockMemoryPrivilege === 'Missing'` clamps `recommendedHugeGiB` to `0` and forces `standard` mode.
   - Test `availPhysPct < 20%` clamps `recommendedHugeGiB` to `0`.
   - Test `confirmRminjectRelaunch()` pins baseline, creates `miheap_injected` arenas, and reduces `l2Dtlb` vs baseline.
   - Assert zero em/en dashes (`[\u2013\u2014]`) across all touched files, and verify all new DOM IDs (`modal-rminject`, etc.) exist in `zen2top_interactive_tui_prototype.html`.
2. **Real Browser / Playwright Check:**
   - Open `zen2top_interactive_tui_prototype.html` via headless browser, attach to `rustc.exe` and `/MD` profile, exercise Tab 4 eligibility strip, Tab 5 `[i: Relaunch w/ rminject]`, `#modal-rminject` GiB adjustments + guardrail warnings, post-relaunch Tab 4 Mimalloc view, and verify `chrome.exe`/`cs2.exe` suppression with 0 console errors at `1280x800` and `900x700`.
