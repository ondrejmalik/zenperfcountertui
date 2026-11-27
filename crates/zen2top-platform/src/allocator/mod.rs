//! Empirical Layer 1 allocator classification and `rminject` eligibility (`AGENTS.md` §3.5, §5.2).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum AllocatorKind {
    Mimalloc,
    Jemalloc,
    Tbbmalloc,
    Rpmalloc,
    Tcmalloc,
    StandardCrtHeapAlloc,
    DirectVirtualAlloc,
    ManagedJitRuntime,
    #[default]
    UnknownFallback,
}

impl AllocatorKind {
    pub const fn generic_label(self) -> &'static str {
        match self {
            Self::Mimalloc => "mimalloc",
            Self::Jemalloc => "jemalloc",
            Self::Tbbmalloc => "tbbmalloc",
            Self::Rpmalloc => "rpmalloc",
            Self::Tcmalloc => "tcmalloc",
            Self::StandardCrtHeapAlloc => "Standard CRT / Win32 HeapAlloc",
            Self::DirectVirtualAlloc => "Direct VirtualAlloc / Custom Private RW",
            Self::ManagedJitRuntime => "Managed / JIT Runtime",
            Self::UnknownFallback => "Unknown (Layer 1 OS Fallback)",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum RminjectState {
    Eligible,
    AlreadyMimalloc,
    #[default]
    CustomAllocator,
    GcVirtualAlloc,
    BlockedGuardrail,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum RminjectMode {
    Large,
    #[default]
    Standard,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ObservedModule {
    pub name: String,
    pub exports: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct AllocatorObservation {
    pub modules: Vec<ObservedModule>,
    pub has_crt_malloc: bool,
    pub has_heap_alloc: bool,
    pub has_virtual_alloc: bool,
    pub private_rw_reserved_mib: f64,
    pub private_rw_huge_2mib_mib: f64,
    pub private_rw_large_reservations: usize,
    pub ws_mib: f64,
    pub peak_ws_mib: f64,
    pub protected_process: bool,
    pub has_lock_memory_privilege: bool,
    pub avail_phys_pct: f64,
    pub total_ram_gib: f64,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct RminjectEligibility {
    pub state: RminjectState,
    pub can_relaunch: bool,
    pub linkage_label: String,
    pub reason: String,
    pub recommended_mode: RminjectMode,
    pub recommended_huge_gib: u32,
    pub priv_present: bool,
    pub avail_phys_pct: f64,
    pub max_safe_gib: u32,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct AllocatorReport {
    pub kind: AllocatorKind,
    pub label: String,
    pub detection_method: String,
    pub matched_module: Option<String>,
    pub rminject_eligibility: RminjectEligibility,
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

fn normalized_basename(s: &str) -> String {
    let f = s.trim().rsplit(['\\', '/']).next().unwrap_or("");
    f.trim().to_ascii_lowercase()
}

fn find_module(mods: &[ObservedModule], exact: &str, pfx: &str) -> Option<String> {
    let hit = |m: &&ObservedModule| {
        let b = normalized_basename(&m.name);
        exact.split(',').any(|x| x == b) || (b.starts_with(pfx) && b.ends_with(".dll"))
    };
    mods.iter().find(hit).map(|m| m.name.clone())
}

fn match_known(m: &ObservedModule) -> Option<(AllocatorKind, &'static str)> {
    use AllocatorKind::*;
    let b = normalized_basename(&m.name);
    let signatures: &[(AllocatorKind, &[&str], &[&str])] = &[
        (
            Mimalloc,
            &["mimalloc", "miheap"],
            &[
                "mi_malloc",
                "mi_version",
                "_mi_stats_main",
                "mi_arena_count",
            ],
        ),
        (Jemalloc, &["jemalloc"], &["je_malloc", "je_mallctl"]),
        (Tbbmalloc, &["tbbmalloc"], &["scalable_malloc"]),
        (
            Rpmalloc,
            &["rpmalloc"],
            &["rpmalloc_initialize", "rpmalloc"],
        ),
        (Tcmalloc, &["tcmalloc"], &["tc_malloc"]),
    ];
    if b.ends_with(".dll") {
        if let Some(&(k, _, _)) = signatures
            .iter()
            .find(|(_, p, _)| p.iter().any(|prefix| b.starts_with(prefix)))
        {
            return Some((k, "Known allocator DLL"));
        }
    }
    let has = |s: &str| m.exports.iter().any(|x| x.eq_ignore_ascii_case(s));
    signatures
        .iter()
        .find(|(_, _, e)| e.iter().any(|export| has(export)))
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
    if let Some(m) = find_module(&o.modules, rt, "mono-") {
        return (ManagedJitRuntime, None, "Managed runtime module", Some(m));
    }
    let crt = find_module(&o.modules, "ucrtbase.dll,ucrtbased.dll,msvcrt.dll", "msvcr");
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
    let (kind, detected_label, detection_method, matched_module) = detect_kind(obs);
    let label = detected_label.unwrap_or_else(|| kind.generic_label().into());
    let available_ram_pct = obs.avail_phys_pct.clamp(0.0, 100.0);
    let has_lock_memory_privilege = obs.has_lock_memory_privilege;
    let max_safe_gib = (obs.total_ram_gib.max(0.0) * available_ram_pct * 0.0045)
        .floor()
        .max(1.0) as u32;
    let w1 = "SeLockMemoryPrivilege missing (--large locked out)";
    let w2 = format!("Available RAM < 20% ({available_ram_pct:.1}% free; --large locked out)");
    let warnings: Vec<_> = [
        (!has_lock_memory_privilege).then(|| w1.into()),
        (available_ram_pct < 20.0).then_some(w2),
    ]
    .into_iter()
    .flatten()
    .collect();
    let m_mim = format!("Target already loads {label}; tune native Mimalloc/IFEO.");
    let m_cus = format!("Skipped: target uses {label} rather than CRT/HeapAlloc.");
    let m_blk = "Protected process: PE import injection blocked.".into();
    let m_gc = "Managed / JIT runtime manages heaps directly via VirtualAlloc.".into();
    let (state, can_relaunch, reason) = match (obs.protected_process, kind) {
        (true, _) => (BlockedGuardrail, false, m_blk),
        (false, Mimalloc) => (AlreadyMimalloc, false, m_mim),
        (false, ManagedJitRuntime) => (GcVirtualAlloc, false, m_gc),
        (false, StandardCrtHeapAlloc) => (Eligible, true, String::new()),
        (false, _) => (CustomAllocator, false, m_cus),
    };
    let estimated_gib =
        ((obs.peak_ws_mib.max(obs.ws_mib).max(512.0) * 1.25) / 1024.0).ceil() as u32;
    let can_huge = can_relaunch && has_lock_memory_privilege && available_ram_pct >= 20.0;
    let recommended_huge_gib = if can_huge {
        estimated_gib.clamp(1, max_safe_gib)
    } else {
        0
    };
    let recommended_mode = if recommended_huge_gib > 0 {
        Large
    } else {
        Standard
    };
    let eligibility = RminjectEligibility {
        state,
        can_relaunch,
        linkage_label: label.clone(),
        reason,
        recommended_mode,
        recommended_huge_gib,
        priv_present: has_lock_memory_privilege,
        avail_phys_pct: available_ram_pct,
        max_safe_gib,
        warnings,
    };
    AllocatorReport {
        kind,
        label,
        detection_method: detection_method.into(),
        matched_module,
        rminject_eligibility: eligibility,
    }
}
