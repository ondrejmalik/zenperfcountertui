//! Empirical Layer 1 allocator classification and `rminject` eligibility (`AGENTS.md` §3.5, §5.2).

use serde::{Deserialize, Serialize};

macro_rules! alloc_t {
    (labeled $n:ident { $($(#[$m:meta])? $v:ident => $l:literal),+ }) => { #[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)] pub enum $n { $($(#[$m])? $v),+ } impl $n { pub const fn generic_label(self) -> &'static str { match self { $(Self::$v => $l),+ } } } };
    (enums $($n:ident { $($(#[$m:meta])? $v:ident),+ })+) => { $(#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)] pub enum $n { $($(#[$m])? $v),+ })+ };
    (dto $($n:ident { $($f:ident : $t:ty),+ })+) => { $(#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)] #[serde(default)] pub struct $n { $(pub $f: $t),+ })+ };
    (new $t:ident { $($x:tt)+ }) => { $t { $($x)+ } };
    (known) => {{ use AllocatorKind::*; [(Mimalloc, "mimalloc,miheap", "mi_malloc,mi_version,_mi_stats_main,mi_arena_count"), (Jemalloc, "jemalloc", "je_malloc,je_mallctl"), (Tbbmalloc, "tbbmalloc", "scalable_malloc"), (Rpmalloc, "rpmalloc", "rpmalloc_initialize,rpmalloc"), (Tcmalloc, "tcmalloc", "tc_malloc")] }};
}

alloc_t! { labeled AllocatorKind { Mimalloc => "mimalloc", Jemalloc => "jemalloc", Tbbmalloc => "tbbmalloc", Rpmalloc => "rpmalloc", Tcmalloc => "tcmalloc", StandardCrtHeapAlloc => "Standard CRT / Win32 HeapAlloc", DirectVirtualAlloc => "Direct VirtualAlloc / Custom Private RW", ManagedJitRuntime => "Managed / JIT Runtime", #[default] UnknownFallback => "Unknown (Layer 1 OS Fallback)" } }
alloc_t! { enums RminjectState { Eligible, AlreadyMimalloc, #[default] CustomAllocator, GcVirtualAlloc, BlockedGuardrail } RminjectMode { Large, #[default] Standard } }
alloc_t! { dto
    ObservedModule { name: String, exports: Vec<String> }
    AllocatorObservation { modules: Vec<ObservedModule>, has_crt_malloc: bool, has_heap_alloc: bool, has_virtual_alloc: bool, private_rw_reserved_mib: f64, private_rw_huge_2mib_mib: f64, private_rw_large_reservations: usize, ws_mib: f64, peak_ws_mib: f64, protected_process: bool, has_lock_memory_privilege: bool, avail_phys_pct: f64, total_ram_gib: f64 }
    RminjectEligibility { state: RminjectState, can_relaunch: bool, linkage_label: String, reason: String, recommended_mode: RminjectMode, recommended_huge_gib: u32, priv_present: bool, avail_phys_pct: f64, max_safe_gib: u32, warnings: Vec<String> }
    AllocatorReport { kind: AllocatorKind, label: String, detection_method: String, matched_module: Option<String>, rminject_eligibility: RminjectEligibility }
}

pub trait AllocatorInspector: Send + Sync {
    fn inspect(&self, obs: &AllocatorObservation) -> anyhow::Result<AllocatorReport>;
}

#[derive(Debug, Default, Clone, Copy)]
pub struct Layer1AllocatorInspector;
impl AllocatorInspector for Layer1AllocatorInspector {
    fn inspect(&self, o: &AllocatorObservation) -> anyhow::Result<AllocatorReport> {
        Ok(classify_layer1(o))
    }
}

fn base_lo(s: &str) -> String {
    let f = s.trim().rsplit(['\\', '/']).next().unwrap_or("");
    f.trim().to_ascii_lowercase()
}

fn find_mod(mods: &[ObservedModule], exact: &str, pfx: &str) -> Option<String> {
    let hit = |m: &&ObservedModule| {
        let b = base_lo(&m.name);
        exact.split(',').any(|x| x == b) || (b.starts_with(pfx) && b.ends_with(".dll"))
    };
    mods.iter().find(hit).map(|m| m.name.clone())
}

fn match_known(m: &ObservedModule) -> Option<(AllocatorKind, &'static str)> {
    let (b, tbl) = (base_lo(&m.name), alloc_t!(known));
    if b.ends_with(".dll") {
        if let Some(&(k, _, _)) = tbl
            .iter()
            .find(|(_, p, _)| p.split(',').any(|x| b.starts_with(x)))
        {
            return Some((k, "Known allocator DLL"));
        }
    }
    let has = |s: &str| m.exports.iter().any(|x| x.eq_ignore_ascii_case(s));
    tbl.iter()
        .find(|(_, _, e)| e.split(',').any(has))
        .map(|&(k, _, _)| (k, "Allocator PE export signature"))
}

type Hit = (AllocatorKind, Option<String>, &'static str, Option<String>);

fn detect_kind(o: &AllocatorObservation) -> Hit {
    use AllocatorKind::*;
    for m in &o.modules {
        if let Some((k, me)) = match_known(m) {
            let lbl = format!("{} ({})", k.generic_label(), m.name);
            return (k, Some(lbl), me, Some(m.name.clone()));
        }
    }
    let rt = "coreclr.dll,clrjit.dll,clr.dll,mscorwks.dll,jvm.dll,mono.dll";
    if let Some(m) = find_mod(&o.modules, rt, "mono-") {
        return (ManagedJitRuntime, None, "Managed runtime module", Some(m));
    }
    let crt = find_mod(&o.modules, "ucrtbase.dll,ucrtbased.dll,msvcrt.dll", "msvcr");
    let hc = o.has_crt_malloc || o.has_heap_alloc;
    let rw = o.private_rw_large_reservations >= 2;
    let big = rw && o.private_rw_reserved_mib >= 128.0;
    let va = o.has_virtual_alloc && (!hc || (!o.has_crt_malloc && big));
    let (da, sc, uf) = (DirectVirtualAlloc, StandardCrtHeapAlloc, UnknownFallback);
    match (va, hc, rw && o.private_rw_reserved_mib >= 64.0, crt) {
        (true, _, _, _) => (da, None, "PE IAT VirtualAlloc + Private RW profile", None),
        (_, true, _, c) => (sc, None, "PE IAT CRT / HeapAlloc", c),
        (_, _, true, _) => (da, None, "Private RW reservation profile", None),
        (_, _, _, Some(m)) => (sc, None, "Loaded CRT module", Some(m)),
        _ => (uf, None, "Layer 1 fallback (no CRT/allocator signal)", None),
    }
}

/// Classifies target allocator and `rminject` eligibility strictly from observed OS/PE telemetry.
pub fn classify_layer1(obs: &AllocatorObservation) -> AllocatorReport {
    use {AllocatorKind::*, RminjectMode::*, RminjectState::*};
    let (kind, lbl, meth, matched_module) = detect_kind(obs);
    let label = lbl.unwrap_or_else(|| kind.generic_label().into());
    let av = obs.avail_phys_pct.clamp(0.0, 100.0);
    let pv = obs.has_lock_memory_privilege;
    let mg = (obs.total_ram_gib.max(0.0) * av * 0.0045).floor().max(1.0) as u32;
    let w1 = "SeLockMemoryPrivilege missing (--large locked out)";
    let w2 = format!("Available RAM < 20% ({av:.1}% free; --large locked out)");
    let warn: Vec<_> = [(!pv).then(|| w1.into()), (av < 20.0).then_some(w2)]
        .into_iter()
        .flatten()
        .collect();
    let m_mim = format!("Target already loads {label}; tune native Mimalloc/IFEO.");
    let m_cus = format!("Skipped: target uses {label} rather than CRT/HeapAlloc.");
    let m_blk = "Protected process: PE import injection blocked.".into();
    let m_gc = "Managed / JIT runtime manages heaps directly via VirtualAlloc.".into();
    let (st, ok, rsn) = match (obs.protected_process, kind) {
        (true, _) => (BlockedGuardrail, false, m_blk),
        (false, Mimalloc) => (AlreadyMimalloc, false, m_mim),
        (false, ManagedJitRuntime) => (GcVirtualAlloc, false, m_gc),
        (false, StandardCrtHeapAlloc) => (Eligible, true, String::new()),
        (false, _) => (CustomAllocator, false, m_cus),
    };
    let est = ((obs.peak_ws_mib.max(obs.ws_mib).max(512.0) * 1.25) / 1024.0).ceil() as u32;
    let can_huge = ok && pv && av >= 20.0;
    let huge = if can_huge { est.clamp(1, mg) } else { 0 };
    let mode = if huge > 0 { Large } else { Standard };
    let e = alloc_t!(new RminjectEligibility { state: st, can_relaunch: ok, linkage_label: label.clone(), reason: rsn, recommended_mode: mode, recommended_huge_gib: huge, priv_present: pv, avail_phys_pct: av, max_safe_gib: mg, warnings: warn });
    alloc_t!(new AllocatorReport { kind, label, detection_method: meth.into(), matched_module, rminject_eligibility: e })
}
