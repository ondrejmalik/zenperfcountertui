use anyhow::{anyhow, bail};
use serde::{Deserialize, Serialize};

/// Number of programmable Core PMC counters per hardware mux group on AMD Zen 2.
pub const CORE_PMC_SLOTS_PER_GROUP: u8 = 6;

/// Always-on fixed MSRs that do not consume programmable Core PMC slots.
pub const FREE_BASE_FIXED_MSRS: [&str; 3] = [
    "core/aperf=(aperf)",
    "core/mperf=(mperf)",
    "core/inst=(irperf)",
];

/// Always-on L3 uncore PMU events that do not consume Core PMC slots.
pub const FREE_BASE_L3_EVENTS: [&str; 4] = [
    "l3/l3_access=(0xFF0F00000040FF04)",
    "l3/l3_miss=(0xFF0F000000400104)",
    "l3/l3_lat=(0xFF0F000000400090)",
    "l3/l3_mtype=(0xFF0F000000401F9A)",
];

/// The 12 atomic AMD Zen 2 Core PMC metric packs (24 total slots = 4 exact mux groups of 6).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub enum MetricPack {
    DcDemand,
    DcHwpf,
    L1L2Dc,
    L1L2Ic,
    L2Hwpf,
    Branches,
    ItlbFull,
    DtlbFull,
    CrossCcxLocks,
    OpCacheDecode,
    StlfSplits,
    ExactRetiring,
}

type PackDef = (
    &'static str,
    &'static str,
    &'static str,
    &'static [&'static str],
    &'static [&'static str],
);

macro_rules! pack_table {
    ($([$id:expr, $disp:expr, $short:expr, $ev:expr, $hx:expr]),* $(,)?) => {
        [$(($id, $disp, $short, $ev, $hx)),*]
    };
}

const PACK_DEFS: [PackDef; 12] = pack_table! {
    ["DcDemand", "D-Cache L3/DRAM Demand", "DC Demand", &["core/dc_dem_l3=(0x430243)", "core/dc_dem_dram=(0x430843)"], &["0x430243", "0x430843"]],
    ["DcHwpf", "D-Cache L1 HWPF L3/DRAM", "DC HWPF", &["core/dc_hwpf_l3=(0x43025A)", "core/dc_hwpf_dram=(0x43085A)"], &["0x43025A", "0x43085A"]],
    ["L1L2Dc", "L1/L2 D-Cache Hierarchy", "L1/L2 DC", &["core/l1_dc_miss=(0x43C860)", "core/l2_dc_miss=(0x430864)"], &["0x43C860", "0x430864"]],
    ["L1L2Ic", "L1/L2 I-Cache Hierarchy", "L1/L2 IC", &["core/l1_ic_miss=(0x431060)", "core/l2_ic_miss=(0x430164)"], &["0x431060", "0x430164"]],
    ["L2Hwpf", "L2 HWPF L3/DRAM", "L2 HWPF", &["core/l2_pf_l3=(0x431F71)", "core/l2_pf_dram=(0x431F72)"], &["0x431F71", "0x431F72"]],
    ["Branches", "Branches & Mispredicts", "Branches", &["core/branches=(0x4300C2)", "core/branch_miss=(0x4300C3)"], &["0x4300C2", "0x4300C3"]],
    ["ItlbFull", "iTLB Full", "iTLB", &["core/l1_itlb_hit=(0x430794)", "core/l1_itlb_miss_l2_hit=(0x430084)", "core/l2_itlb_miss=(0x430785)"], &["0x430794", "0x430084", "0x430785"]],
    ["DtlbFull", "dTLB Full", "dTLB", &["core/l1_dtlb_miss_l2_hit=(0x430F45)", "core/l2_dtlb_miss=(0x43F045)"], &["0x430F45", "0x43F045"]],
    ["CrossCcxLocks", "Cross-CCX Fills & Serialized Locks", "CCX+Locks", &["core/dc_cross_ccx=(0x430443)", "core/locks_serial=(0x430325)"], &["0x430443", "0x430325"]],
    ["OpCacheDecode", "Op-Cache vs. Legacy Decode", "Op-Cache", &["core/dec_uops=(0x4301AA)", "core/oc_uops=(0x4302AA)"], &["0x4301AA", "0x4302AA"]],
    ["StlfSplits", "STLF Interlocks & Line Splits", "STLF+Splits", &["core/stlf_interlock=(0x430224)", "core/misal_access=(0x430047)"], &["0x430224", "0x430047"]],
    ["ExactRetiring", "Exact Macro-Op Retiring", "Retiring", &["core/ret_uops=(0x4300C1)"], &["0x4300C1"]],
};

impl MetricPack {
    /// All 12 metric packs in canonical order.
    pub const ALL: [MetricPack; 12] = [
        Self::DcDemand,
        Self::DcHwpf,
        Self::L1L2Dc,
        Self::L1L2Ic,
        Self::L2Hwpf,
        Self::Branches,
        Self::ItlbFull,
        Self::DtlbFull,
        Self::CrossCcxLocks,
        Self::OpCacheDecode,
        Self::StlfSplits,
        Self::ExactRetiring,
    ];

    pub const fn canonical_index(self) -> usize {
        self as usize
    }
    pub const fn id_str(self) -> &'static str {
        PACK_DEFS[self as usize].0
    }
    pub const fn display_name(self) -> &'static str {
        PACK_DEFS[self as usize].1
    }
    pub const fn short_name(self) -> &'static str {
        PACK_DEFS[self as usize].2
    }
    pub const fn slots(self) -> u8 {
        PACK_DEFS[self as usize].3.len() as u8
    }
    pub const fn events(self) -> &'static [&'static str] {
        PACK_DEFS[self as usize].3
    }
    pub const fn hex_codes(self) -> &'static [&'static str] {
        PACK_DEFS[self as usize].4
    }

    /// Case-insensitive parser accepting canonical IDs, slugs, and common shorthand names.
    pub fn parse_name(input: &str) -> Option<Self> {
        match normalize_token(input).as_str() {
            "dcdemand" => Some(Self::DcDemand),
            "dchwpf" => Some(Self::DcHwpf),
            "l1l2dc" => Some(Self::L1L2Dc),
            "l1l2ic" => Some(Self::L1L2Ic),
            "l2hwpf" => Some(Self::L2Hwpf),
            "branches" | "branch" => Some(Self::Branches),
            "itlbfull" | "itlb" => Some(Self::ItlbFull),
            "dtlbfull" | "dtlb" => Some(Self::DtlbFull),
            "crossccxlocks" | "ccxlocks" | "ccx" => Some(Self::CrossCcxLocks),
            "opcachedecode" | "opcache" => Some(Self::OpCacheDecode),
            "stlfsplits" | "stlf" => Some(Self::StlfSplits),
            "exactretiring" | "retiring" => Some(Self::ExactRetiring),
            _ => None,
        }
    }
}

/// The 6 canonical quick presets for `zen2top`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum PresetId {
    Full,
    KitchenSink,
    Balanced,
    TlbOnly,
    MemCcxLab,
    MicroArch,
}

const PRESET_DEFS: [(&str, &str, &[MetricPack], u8); 6] = [
    (
        "full",
        "Full",
        &[
            MetricPack::DcDemand,
            MetricPack::DcHwpf,
            MetricPack::L1L2Dc,
            MetricPack::L1L2Ic,
            MetricPack::L2Hwpf,
            MetricPack::Branches,
            MetricPack::ItlbFull,
            MetricPack::DtlbFull,
            MetricPack::ExactRetiring,
        ],
        18,
    ),
    ("kitchen-sink", "Kitchen Sink", &MetricPack::ALL, 24),
    (
        "balanced",
        "Balanced Daily",
        &[
            MetricPack::DcDemand,
            MetricPack::L1L2Dc,
            MetricPack::L1L2Ic,
            MetricPack::Branches,
            MetricPack::DtlbFull,
            MetricPack::CrossCcxLocks,
        ],
        12,
    ),
    (
        "tlb-only",
        "TLB-Only",
        &[
            MetricPack::ItlbFull,
            MetricPack::DtlbFull,
            MetricPack::ExactRetiring,
        ],
        6,
    ),
    (
        "mem-ccx-lab",
        "Mem + CCX Lab",
        &[
            MetricPack::DcDemand,
            MetricPack::DtlbFull,
            MetricPack::CrossCcxLocks,
        ],
        6,
    ),
    (
        "micro-arch",
        "Micro-Arch",
        &[
            MetricPack::CrossCcxLocks,
            MetricPack::OpCacheDecode,
            MetricPack::StlfSplits,
        ],
        6,
    ),
];

impl PresetId {
    pub const ALL: [PresetId; 6] = [
        Self::Full,
        Self::KitchenSink,
        Self::Balanced,
        Self::TlbOnly,
        Self::MemCcxLab,
        Self::MicroArch,
    ];
    pub const fn slug(self) -> &'static str {
        PRESET_DEFS[self as usize].0
    }
    pub const fn display_name(self) -> &'static str {
        PRESET_DEFS[self as usize].1
    }
    pub const fn packs(self) -> &'static [MetricPack] {
        PRESET_DEFS[self as usize].2
    }
    pub const fn core_pmc_slots(self) -> u8 {
        PRESET_DEFS[self as usize].3
    }
    pub const fn mux_groups(self) -> u8 {
        self.core_pmc_slots() / CORE_PMC_SLOTS_PER_GROUP
    }
}

/// Resolve a canonical preset slug or legacy alias into a `PresetId`.
pub fn resolve_preset(name: &str) -> Option<PresetId> {
    match name.trim().to_ascii_lowercase().as_str() {
        "full" => Some(PresetId::Full),
        "kitchen-sink" | "all" => Some(PresetId::KitchenSink),
        "balanced" | "daily" => Some(PresetId::Balanced),
        "tlb-only" | "tlb" => Some(PresetId::TlbOnly),
        "mem-ccx-lab" | "mem-ccx" => Some(PresetId::MemCcxLab),
        "micro-arch" | "uarch" => Some(PresetId::MicroArch),
        _ => None,
    }
}

/// Parse a comma-separated list of pack names into a deduplicated, canonically ordered `Vec<MetricPack>`.
pub fn resolve_packs_csv(csv: &str) -> anyhow::Result<Vec<MetricPack>> {
    let trimmed = csv.trim();
    if trimmed.is_empty() {
        bail!("pack list cannot be empty");
    }
    let mut present = [false; 12];
    for raw in trimmed.split(',') {
        let token = raw.trim();
        if token.is_empty() {
            bail!("empty pack name in CSV list: '{csv}'");
        }
        let pack = MetricPack::parse_name(token)
            .ok_or_else(|| anyhow!("unknown metric pack: '{token}'"))?;
        present[pack.canonical_index()] = true;
    }
    Ok(MetricPack::ALL
        .into_iter()
        .filter(|p| present[p.canonical_index()])
        .collect())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackedEvent {
    pub pack: MetricPack,
    pub metric: String,
    pub hex_code: String,
    pub auto_padded: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackBin {
    pub group: u8,
    pub used: u8,
    pub capacity: u8,
    pub auto_padded: bool,
    pub packs: Vec<MetricPack>,
    pub events: Vec<PackedEvent>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PackPlan {
    pub selected_packs: Vec<MetricPack>,
    pub effective_packs: Vec<MetricPack>,
    pub auto_padded_retiring: bool,
    pub requested_slots: u8,
    pub core_slots: u8,
    pub capacity_slots: u8,
    pub mux_groups: u8,
    pub duty_cycle_pct: f64,
    pub bins: Vec<PackBin>,
    pub core_events: Vec<String>,
    pub fixed_msrs: Vec<String>,
    pub l3_events: Vec<String>,
    pub metric_string: String,
    pub preset_slug: Option<String>,
}

impl PackPlan {
    /// Returns `true` if `pack` is active in this plan (either explicitly selected or auto-padded).
    pub fn has(&self, pack: MetricPack) -> bool {
        self.effective_packs.contains(&pack)
    }
}

fn normalize_token(input: &str) -> String {
    input
        .trim()
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

fn push_pack_to_bin(bin: &mut PackBin, pack: MetricPack, auto_padded: bool) {
    bin.used += pack.slots();
    bin.auto_padded |= auto_padded;
    bin.packs.push(pack);
    for (&metric, &hex_code) in pack.events().iter().zip(pack.hex_codes()) {
        bin.events.push(PackedEvent {
            pack,
            metric: metric.to_string(),
            hex_code: hex_code.to_string(),
            auto_padded,
        });
    }
}

/// Pack a non-empty set of `MetricPack`s into 6-slot Zen 2 Core PMC mux groups using First-Fit Decreasing.
pub fn pack_core_pmcs(selected: &[MetricPack]) -> anyhow::Result<PackPlan> {
    let mut present = [false; 12];
    for &pack in selected {
        present[pack.canonical_index()] = true;
    }
    let selected_packs: Vec<MetricPack> = MetricPack::ALL
        .into_iter()
        .filter(|p| present[p.canonical_index()])
        .collect();
    if selected_packs.is_empty() {
        bail!("cannot build Core PMC pack plan from an empty pack selection");
    }

    let requested_slots: u8 = selected_packs.iter().map(|p| p.slots()).sum();
    let mut ffd_order = selected_packs.clone();
    ffd_order.sort_by(|a, b| {
        b.slots()
            .cmp(&a.slots())
            .then_with(|| a.canonical_index().cmp(&b.canonical_index()))
    });

    let mut bins: Vec<PackBin> = Vec::new();
    for pack in ffd_order {
        if let Some(bin) = bins
            .iter_mut()
            .find(|b| b.used + pack.slots() <= CORE_PMC_SLOTS_PER_GROUP)
        {
            push_pack_to_bin(bin, pack, false);
        } else {
            let mut bin = PackBin {
                group: (bins.len() + 1) as u8,
                used: 0,
                capacity: CORE_PMC_SLOTS_PER_GROUP,
                auto_padded: false,
                packs: Vec::new(),
                events: Vec::new(),
            };
            push_pack_to_bin(&mut bin, pack, false);
            bins.push(bin);
        }
    }

    let mut auto_padded_retiring = false;
    if bins.len() > 1 && !present[MetricPack::ExactRetiring.canonical_index()] {
        let last_idx = bins.len() - 1;
        for bin in &mut bins[..last_idx] {
            if bin.used == CORE_PMC_SLOTS_PER_GROUP - 1 {
                push_pack_to_bin(bin, MetricPack::ExactRetiring, true);
                auto_padded_retiring = true;
            }
        }
    }

    let mut effective_present = present;
    if auto_padded_retiring {
        effective_present[MetricPack::ExactRetiring.canonical_index()] = true;
    }
    let effective_packs: Vec<MetricPack> = MetricPack::ALL
        .into_iter()
        .filter(|p| effective_present[p.canonical_index()])
        .collect();
    let core_slots: u8 = bins.iter().map(|b| b.used).sum();
    let mux_groups = bins.len() as u8;
    let capacity_slots = mux_groups * CORE_PMC_SLOTS_PER_GROUP;
    let duty_cycle_pct = 100.0 / f64::from(mux_groups);
    let core_events: Vec<String> = bins
        .iter()
        .flat_map(|b| b.events.iter().map(|e| e.metric.clone()))
        .collect();
    let fixed_msrs: Vec<String> = FREE_BASE_FIXED_MSRS
        .iter()
        .map(|&s| s.to_string())
        .collect();
    let l3_events: Vec<String> = FREE_BASE_L3_EVENTS.iter().map(|&s| s.to_string()).collect();
    let metric_string = fixed_msrs
        .iter()
        .chain(&core_events)
        .chain(&l3_events)
        .cloned()
        .collect::<Vec<_>>()
        .join(",");
    let preset_slug = PresetId::ALL
        .into_iter()
        .find(|p| p.packs() == selected_packs.as_slice())
        .map(|p| p.slug().to_string());

    Ok(PackPlan {
        selected_packs,
        effective_packs,
        auto_padded_retiring,
        requested_slots,
        core_slots,
        capacity_slots,
        mux_groups,
        duty_cycle_pct,
        bins,
        core_events,
        fixed_msrs,
        l3_events,
        metric_string,
        preset_slug,
    })
}
