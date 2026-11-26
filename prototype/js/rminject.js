// Deterministic 5-state allocator eligibility classifier & rminject launch helpers
(() => {
  'use strict';
  const Z = window.Zen2Top || (window.Zen2Top = {});

  const ANTI_CHEAT_PATTERNS = [
    'easyanticheat',
    'battleye',
    'vgk',
    'vanguard',
    'faceit',
    'ricochet'
  ];

  const GC_MODULES = new Set([
    'jvm.dll',
    'coreclr.dll',
    'clrjit.dll',
    'unityplayer.dll',
    'clr.dll',
    'mscorwks.dll'
  ]);

  const CUSTOM_ALLOC_MODULES = new Set([
    'tbbmalloc.dll',
    'tbbmalloc_proxy.dll',
    'jemalloc.dll',
    'chrome.dll',
    'libcef.dll'
  ]);

  function getLowerModuleNames(proc) {
    return (proc && Array.isArray(proc.modules) ? proc.modules : [])
      .map(m => String(m && m.name ? m.name : '').toLowerCase())
      .filter(Boolean);
  }

  function isAntiCheatModule(modName) {
    return ANTI_CHEAT_PATTERNS.some(pat =>
      pat === 'vgk' ? modName.startsWith('vgk') : modName.includes(pat)
    );
  }

  function isGcModuleOrLabel(modNames, allocLabel, crtProf) {
    if (crtProf && crtProf.kind === 'gc_virtualalloc') return true;
    if (modNames.some(n => GC_MODULES.has(n) || /^mono-.*\.dll$/.test(n))) return true;
    return /\b(jvm|hotspot|coreclr|\.net|clr|mono|golang|go runtime)\b/i.test(allocLabel);
  }

  function isCustomAllocatorModuleOrLabel(modNames, allocLabel, crtProf) {
    if (crtProf && crtProf.kind === 'custom_allocator') return true;
    if (modNames.some(n => CUSTOM_ALLOC_MODULES.has(n))) return true;
    return /(partitionalloc|redengine4|fmallocbinned|tbbmalloc|jemalloc)/i.test(allocLabel);
  }

  function detectCrtLinkage(proc, modNames, crtProf) {
    if (crtProf && crtProf.linkageLabel) return crtProf.linkageLabel;
    const hasUcrt = modNames.includes('ucrtbase.dll') || modNames.includes('ucrtbased.dll');
    const hasMsvcrt = modNames.includes('msvcrt.dll');
    const legacyMsvcr = modNames.find(n => /^msvcr(80|90|100|110|120)d?\.dll$/.test(n));
    const nameLower = String(proc && proc.name ? proc.name : '').toLowerCase();
    const allocLabel = String(proc && proc.allocatorLabel ? proc.allocatorLabel : '');

    if (nameLower.includes('rustc') || /\brust\b/i.test(allocLabel)) {
      return hasUcrt
        ? 'Rust std::alloc::System (HeapAlloc) + /MD ucrtbase.dll'
        : 'Rust std::alloc::System (HeapAlloc)';
    }
    if (hasUcrt) return '/MD UCRT (ucrtbase.dll)';
    if (hasMsvcrt) return 'MinGW / MSVCRT (msvcrt.dll)';
    if (legacyMsvcr) return `Legacy /MD CRT (${legacyMsvcr})`;
    if (crtProf && crtProf.crt === 'static_mt') return '/MT Static UCRT (HeapAlloc)';
    return 'Win32 HeapAlloc / CRT';
  }

  function classifyAllocatorEligibility(proc, snap = null, opts = {}) {
    const CONFIG = Z.CONFIG || {};
    const state = Z.state || {};
    const simProtected = Boolean(
      opts && opts.simProtectedProcess !== undefined
        ? opts.simProtectedProcess
        : state.simProtectedProcess
    );

    const privRaw = (opts && opts.seLockMemoryPrivilege !== undefined)
      ? opts.seLockMemoryPrivilege
      : (snap && snap.seLockMemoryPrivilege !== undefined
        ? snap.seLockMemoryPrivilege
        : (proc && proc.win32Profile && proc.win32Profile.seLockMemoryPrivilege) || 'Present');
    const privPresent = privRaw === 'Present';

    const rawAvailPct = (opts && opts.availPhysPct !== undefined)
      ? opts.availPhysPct
      : (snap && snap.availPhysPct !== undefined
        ? snap.availPhysPct
        : (proc && proc.win32Profile && proc.win32Profile.availPhysPct !== undefined
          ? proc.win32Profile.availPhysPct
          : 40));
    const availPhysPct = Number.isFinite(Number(rawAvailPct)) ? Number(rawAvailPct) : 40;
    const totalRamGiB = Number((opts && opts.totalRamGiB) || CONFIG.totalRamGiB || 32) || 32;
    const availPhysGiB = totalRamGiB * (availPhysPct / 100.0);
    const maxSafeGiB = Math.max(1, Math.floor(availPhysGiB * 0.45));

    if (!proc) {
      return {
        state: 'BLOCKED_GUARDRAIL',
        canRelaunch: false,
        linkageLabel: 'None (System-Wide)',
        blockOrSkipReason: 'Attach a target process first before launching with rminject.',
        recommendedMode: 'standard',
        recommendedHugeGiB: 0,
        privPresent,
        availPhysPct,
        availPhysGiB,
        maxSafeGiB,
        warnings: ['No target process attached'],
        hint: 'Attach a target process (p)'
      };
    }

    const modNames = getLowerModuleNames(proc);
    const allocType = String(proc.allocatorType || '').toLowerCase();
    const allocLabel = String(proc.allocatorLabel || '');
    const crtProf = proc.crtProfile || null;
    const warnings = [];

    if (!privPresent) {
      warnings.push('SeLockMemoryPrivilege missing (--large locked out)');
    }
    if (availPhysPct < 20.0) {
      warnings.push(`Available RAM < 20% (${availPhysPct.toFixed(1)}% free; --large locked out)`);
    }

    // 1. BLOCKED_GUARDRAIL (highest precedence)
    const antiCheatMod = modNames.find(isAntiCheatModule);
    if (proc.protectedProcess || simProtected || antiCheatMod || (crtProf && crtProf.protected)) {
      const linkageLabel = (crtProf && crtProf.linkageLabel)
        ? crtProf.linkageLabel
        : (antiCheatMod ? `Protected Anti-Cheat (${antiCheatMod})` : 'Protected Process (Access Denied)');
      return {
        state: 'BLOCKED_GUARDRAIL',
        canRelaunch: false,
        linkageLabel,
        blockOrSkipReason: `Protected / anti-cheat process (${proc.name}): in-memory PE import injection is hard-blocked to prevent integrity or anti-cheat violations.`,
        recommendedMode: 'standard',
        recommendedHugeGiB: 0,
        privPresent,
        availPhysPct,
        availPhysGiB,
        maxSafeGiB,
        warnings: ['Protected / anti-cheat process: injection disabled', ...warnings],
        hint: 'Injection disabled on protected processes'
      };
    }

    // 2. ALREADY_MIMALLOC
    const isGc = isGcModuleOrLabel(modNames, allocLabel, crtProf);
    const hasMimallocMod = modNames.some(n =>
      n === 'mimalloc.dll' || n === 'miheap.dll' || n === 'tier0.dll' ||
      /^mimalloc[-_]/.test(n) || /^miheap[-_]/.test(n)
    );
    const isAlreadyMimalloc = allocType === 'tier0_mimalloc' ||
      allocType === 'miheap_injected' ||
      hasMimallocMod ||
      (allocType === 'generic_mimalloc' && !isGc);

    if (isAlreadyMimalloc) {
      let linkageLabel;
      if (allocType === 'miheap_injected') {
        linkageLabel = 'miheap.dll -> mimalloc.dll (Injected 2 MiB)';
      } else if (allocType === 'tier0_mimalloc' || modNames.includes('tier0.dll')) {
        linkageLabel = 'tier0.dll (Embedded Mimalloc v2)';
      } else {
        linkageLabel = 'mimalloc.dll (Native Mimalloc v2)';
      }
      const blockOrSkipReason = allocType === 'miheap_injected'
        ? `${proc.name} is already running with miheap.dll -> mimalloc.dll hook injection.`
        : `rminject skipped: ${proc.name} already embeds Mimalloc (${linkageLabel}). Tune MIMALLOC_RESERVE_HUGE_OS_PAGES or IFEO directly instead of double-injecting.`;
      return {
        state: 'ALREADY_MIMALLOC',
        canRelaunch: false,
        linkageLabel,
        blockOrSkipReason,
        recommendedMode: 'standard',
        recommendedHugeGiB: 0,
        privPresent,
        availPhysPct,
        availPhysGiB,
        maxSafeGiB,
        warnings,
        hint: allocType === 'miheap_injected'
          ? 'Live miheap hooks active in Tab 4'
          : 'Tune native Mimalloc env / IFEO instead'
      };
    }

    // 3. GC_VIRTUALALLOC
    if (isGc) {
      const hasJvm = modNames.includes('jvm.dll');
      const hasCoreClr = modNames.includes('coreclr.dll') || modNames.includes('clrjit.dll');
      const linkageLabel = (crtProf && crtProf.linkageLabel)
        ? crtProf.linkageLabel
        : (hasJvm ? 'HotSpot JVM (jvm.dll on VirtualAlloc)' : (hasCoreClr ? 'CoreCLR GC + RyuJIT (coreclr.dll)' : 'Managed GC Runtime (VirtualAlloc)'));
      const blockOrSkipReason = hasJvm
        ? 'rminject skipped: jvm.dll manages its GC heap directly on VirtualAlloc rather than CRT malloc/HeapAlloc. Use -XX:+UseLargePages instead.'
        : (hasCoreClr
          ? 'rminject skipped: coreclr.dll manages its GC heap directly on VirtualAlloc rather than CRT malloc/HeapAlloc. Use DOTNET_GCLargePages / COMPlus_GCHeapHardLimit.'
          : 'rminject skipped: managed GC runtime allocates directly via VirtualAlloc rather than CRT/HeapAlloc.');
      const hint = (crtProf && crtProf.runtimeHint)
        ? crtProf.runtimeHint
        : (hasJvm ? 'Use -XX:+UseLargePages' : 'Use native runtime large-page GC flags');
      return {
        state: 'GC_VIRTUALALLOC',
        canRelaunch: false,
        linkageLabel,
        blockOrSkipReason,
        recommendedMode: 'standard',
        recommendedHugeGiB: 0,
        privPresent,
        availPhysPct,
        availPhysGiB,
        maxSafeGiB,
        warnings,
        hint
      };
    }

    // 4. CUSTOM_ALLOCATOR
    if (isCustomAllocatorModuleOrLabel(modNames, allocLabel, crtProf)) {
      const isChrome = modNames.includes('chrome.dll') || /partitionalloc/i.test(allocLabel);
      const isRed = /redengine4/i.test(allocLabel);
      const linkageLabel = (crtProf && crtProf.linkageLabel)
        ? crtProf.linkageLabel
        : (isChrome
          ? 'PartitionAlloc (chrome.dll on VirtualAlloc)'
          : (isRed ? 'REDengine4 Pool (custom VirtualAlloc)' : 'Custom Native Allocator'));
      const blockOrSkipReason = isChrome
        ? 'rminject skipped: chrome.dll uses PartitionAlloc directly on VirtualAlloc; intercepting ucrtbase/HeapAlloc will not back browser arenas.'
        : (isRed
          ? 'rminject skipped: Cyberpunk2077.exe uses REDengine4 memory pools directly on VirtualAlloc.'
          : `rminject skipped: custom allocator detected (${linkageLabel}) bypassing standard CRT/HeapAlloc.`);
      const hint = (crtProf && crtProf.runtimeHint) ? crtProf.runtimeHint : 'Use native engine / runtime pool flags';
      return {
        state: 'CUSTOM_ALLOCATOR',
        canRelaunch: false,
        linkageLabel,
        blockOrSkipReason,
        recommendedMode: 'standard',
        recommendedHugeGiB: 0,
        privPresent,
        availPhysPct,
        availPhysGiB,
        maxSafeGiB,
        warnings,
        hint
      };
    }

    // 5. ELIGIBLE (Win32 HeapAlloc / ucrtbase.dll / msvcrt.dll / legacy msvcr*.dll)
    const hasCrtOrHeapSignal = Boolean(
      (crtProf && crtProf.kind === 'eligible') ||
      allocType === 'crt_fallback' ||
      modNames.some(n =>
        n === 'ucrtbase.dll' || n === 'ucrtbased.dll' || n === 'msvcrt.dll' ||
        /^msvcr(80|90|100|110|120)d?\.dll$/.test(n)
      ) ||
      /ucrtbase|heapalloc|msvcrt|rust/i.test(allocLabel)
    );

    if (!hasCrtOrHeapSignal) {
      return {
        state: 'CUSTOM_ALLOCATOR',
        canRelaunch: false,
        linkageLabel: allocLabel || 'Unknown Custom Allocator',
        blockOrSkipReason: `rminject skipped: no standard CRT (ucrtbase/msvcrt) or Win32 HeapAlloc import metadata detected on ${proc.name}.`,
        recommendedMode: 'standard',
        recommendedHugeGiB: 0,
        privPresent,
        availPhysPct,
        availPhysGiB,
        maxSafeGiB,
        warnings,
        hint: 'Verify PE CRT imports with rminject inspect --json'
      };
    }

    const peakWsMiB = Number(proc.peakWsMiB || proc.wsMiB || 512);
    let recommendedMode;
    let recommendedHugeGiB;
    if (!privPresent || availPhysPct < 20.0) {
      recommendedMode = 'standard';
      recommendedHugeGiB = 0;
    } else {
      recommendedMode = 'large';
      const rawGiB = Math.ceil((peakWsMiB * 1.25) / 1024.0);
      recommendedHugeGiB = Math.max(1, Math.min(rawGiB, maxSafeGiB));
    }

    return {
      state: 'ELIGIBLE',
      canRelaunch: true,
      linkageLabel: detectCrtLinkage(proc, modNames, crtProf),
      blockOrSkipReason: '',
      recommendedMode,
      recommendedHugeGiB,
      privPresent,
      availPhysPct,
      availPhysGiB,
      maxSafeGiB,
      warnings,
      hint: recommendedMode === 'large'
        ? `--large ${recommendedHugeGiB} GiB (non-destructive)`
        : 'standard low-RAM mode (0 locked RAM)'
    };
  }

  function buildRminjectCommand(proc, draft = {}, elig = null) {
    const targetName = (proc && proc.name) ? proc.name : 'target.exe';
    const allowLarge = elig ? (elig.privPresent && elig.availPhysPct >= 20.0) : true;
    const mode = (draft.mode === 'large' && allowLarge) ? 'large' : 'standard';
    const hugeGiB = mode === 'large'
      ? Math.max(1, Math.round(draft.hugeGiB || (elig && elig.recommendedHugeGiB) || 1))
      : 0;

    const parts = ['rminject', 'run', '--inject'];
    if (mode === 'large' && hugeGiB > 0) {
      parts.push('--large', '--env', `MIMALLOC_RESERVE_HUGE_OS_PAGES=${hugeGiB}`);
    } else {
      parts.push('--env', 'MIMALLOC_ALLOW_LARGE_OS_PAGES=0');
    }
    if (draft.followChildren) {
      parts.push('--follow-children');
    }
    parts.push('--', targetName);
    return parts.join(' ');
  }

  Object.assign(Z, {
    classifyAllocatorEligibility,
    buildRminjectCommand
  });
})();
