use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::packs::{pack_core_pmcs, MetricPack};

/// Default AMD Zen 2 nominal base clock used when a baseline payload omits `base_mhz`.
pub const DEFAULT_BASE_MHZ: f64 = 3800.0;

/// Raw cumulative hardware counter totals for a baseline window.
///
/// All derived rates are computed strictly from these cumulative totals
/// (never unweighted averages of per-sample ratios).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RawCumulativeCounters {
    pub inst: u64,
    pub aperf: u64,
    pub mperf: u64,
    pub cycles: u64,
    pub ret_uops: u64,
    pub l3_access: u64,
    pub l3_miss: u64,
    pub l3_lat: u64,
    pub l3_mtype: u64,
    pub dc_dem_l3: u64,
    pub dc_dem_dram: u64,
    pub dc_hwpf_l3: u64,
    pub dc_hwpf_dram: u64,
    pub l1_dc_miss: u64,
    pub l2_dc_miss: u64,
    pub l1_ic_miss: u64,
    pub l2_ic_miss: u64,
    pub l2_pf_l3: u64,
    pub l2_pf_dram: u64,
    pub branches: u64,
    pub branch_miss: u64,
    pub l1_itlb_hit: u64,
    pub l1_itlb_miss_l2_hit: u64,
    pub l2_itlb_miss: u64,
    pub l1_dtlb_miss_l2_hit: u64,
    pub l2_dtlb_miss: u64,
    pub dc_cross_ccx: u64,
    pub locks_serial: u64,
    pub dec_uops: u64,
    pub oc_uops: u64,
    pub stlf_interlock: u64,
    pub misal_access: u64,
    pub base_mhz: f64,
}

impl Default for RawCumulativeCounters {
    fn default() -> Self {
        Self {
            inst: 0,
            aperf: 0,
            mperf: 0,
            cycles: 0,
            ret_uops: 0,
            l3_access: 0,
            l3_miss: 0,
            l3_lat: 0,
            l3_mtype: 0,
            dc_dem_l3: 0,
            dc_dem_dram: 0,
            dc_hwpf_l3: 0,
            dc_hwpf_dram: 0,
            l1_dc_miss: 0,
            l2_dc_miss: 0,
            l1_ic_miss: 0,
            l2_ic_miss: 0,
            l2_pf_l3: 0,
            l2_pf_dram: 0,
            branches: 0,
            branch_miss: 0,
            l1_itlb_hit: 0,
            l1_itlb_miss_l2_hit: 0,
            l2_itlb_miss: 0,
            l1_dtlb_miss_l2_hit: 0,
            l2_dtlb_miss: 0,
            dc_cross_ccx: 0,
            locks_serial: 0,
            dec_uops: 0,
            oc_uops: 0,
            stlf_interlock: 0,
            misal_access: 0,
            base_mhz: DEFAULT_BASE_MHZ,
        }
    }
}

/// Rates derived strictly from cumulative raw counter totals.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct DerivedBaselineRates {
    pub ipc: f64,
    pub actual_cpi: f64,
    pub eff_ghz: f64,
    pub l3_hit_pct: f64,
    pub l3_lat_cyc: f64,
    pub l3_lat_ns: f64,
    pub dram_mpki: Option<f64>,
    pub dem_dram_mpki: Option<f64>,
    pub hwpf_dram_mpki: Option<f64>,
    pub l3_hit_mpki: Option<f64>,
    pub l2_dc_excl_mpki: Option<f64>,
    pub l2_ic_miss_mpki: Option<f64>,
    pub l1_ic_miss_mpki: Option<f64>,
    pub l2_pf_dram_mpki: Option<f64>,
    pub branch_miss_mpki: Option<f64>,
    pub branch_miss_pct: Option<f64>,
    pub l2_itlb_mpki: Option<f64>,
    pub l2_dtlb_mpki: Option<f64>,
    pub dc_cross_ccx_mpki: Option<f64>,
    pub locks_serial_mpki: Option<f64>,
    pub opcache_hit_pct: Option<f64>,
    pub stlf_interlock_mpki: Option<f64>,
    pub misal_access_mpki: Option<f64>,
    pub retiring_pct: Option<f64>,
}

fn mpki(events: u64, inst: u64) -> f64 {
    if inst == 0 {
        0.0
    } else {
        (events as f64 * 1000.0) / inst as f64
    }
}

impl RawCumulativeCounters {
    /// Computes all Free Base and pack-gated rates strictly from cumulative raw totals.
    pub fn derived_rates(&self, enabled_packs: &[MetricPack]) -> DerivedBaselineRates {
        let has = |pack: MetricPack| enabled_packs.contains(&pack);
        let eff_cycles = if self.aperf > 0 {
            self.aperf
        } else {
            self.cycles
        };

        let ipc = if eff_cycles > 0 {
            self.inst as f64 / eff_cycles as f64
        } else {
            0.0
        };
        let actual_cpi = if self.inst > 0 {
            eff_cycles as f64 / self.inst as f64
        } else {
            0.0
        };
        let eff_ghz = if self.mperf > 0 {
            (self.base_mhz / 1000.0) * (self.aperf as f64 / self.mperf as f64)
        } else {
            0.0
        };
        let l3_hit_pct = if self.l3_access > 0 {
            let hits = self.l3_access.saturating_sub(self.l3_miss);
            ((hits as f64 / self.l3_access as f64) * 100.0).clamp(0.0, 100.0)
        } else {
            0.0
        };
        let l3_lat_cyc = if self.l3_mtype > 0 {
            (self.l3_lat as f64 * 16.0) / self.l3_mtype as f64
        } else {
            0.0
        };
        let l3_lat_ns = if eff_ghz > 0.0 {
            l3_lat_cyc / eff_ghz
        } else {
            0.0
        };

        let dem_dram_mpki = has(MetricPack::DcDemand).then(|| mpki(self.dc_dem_dram, self.inst));
        let hwpf_dram_mpki = has(MetricPack::DcHwpf).then(|| mpki(self.dc_hwpf_dram, self.inst));
        let dram_mpki = has(MetricPack::DcDemand).then(|| {
            let total_dram = self
                .dc_dem_dram
                .saturating_add(if has(MetricPack::DcHwpf) {
                    self.dc_hwpf_dram
                } else {
                    0
                })
                .saturating_add(if has(MetricPack::L2Hwpf) {
                    self.l2_pf_dram
                } else {
                    0
                });
            mpki(total_dram, self.inst)
        });
        let l3_hit_mpki = has(MetricPack::DcDemand).then(|| mpki(self.dc_dem_l3, self.inst));
        let l2_dc_excl_mpki = has(MetricPack::L1L2Dc)
            .then(|| mpki(self.l1_dc_miss.saturating_sub(self.l2_dc_miss), self.inst));
        let l2_ic_miss_mpki = has(MetricPack::L1L2Ic).then(|| mpki(self.l2_ic_miss, self.inst));
        let l1_ic_miss_mpki = has(MetricPack::L1L2Ic).then(|| mpki(self.l1_ic_miss, self.inst));
        let l2_pf_dram_mpki = has(MetricPack::L2Hwpf).then(|| mpki(self.l2_pf_dram, self.inst));
        let branch_miss_mpki = has(MetricPack::Branches).then(|| mpki(self.branch_miss, self.inst));
        let branch_miss_pct = has(MetricPack::Branches).then(|| {
            if self.branches > 0 {
                (self.branch_miss as f64 / self.branches as f64) * 100.0
            } else {
                0.0
            }
        });
        let l2_itlb_mpki = has(MetricPack::ItlbFull).then(|| mpki(self.l2_itlb_miss, self.inst));
        let l2_dtlb_mpki = has(MetricPack::DtlbFull).then(|| mpki(self.l2_dtlb_miss, self.inst));
        let dc_cross_ccx_mpki =
            has(MetricPack::CrossCcxLocks).then(|| mpki(self.dc_cross_ccx, self.inst));
        let locks_serial_mpki =
            has(MetricPack::CrossCcxLocks).then(|| mpki(self.locks_serial, self.inst));
        let opcache_hit_pct = has(MetricPack::OpCacheDecode).then(|| {
            let total_uops = self.oc_uops.saturating_add(self.dec_uops);
            if total_uops > 0 {
                (self.oc_uops as f64 / total_uops as f64) * 100.0
            } else {
                0.0
            }
        });
        let stlf_interlock_mpki =
            has(MetricPack::StlfSplits).then(|| mpki(self.stlf_interlock, self.inst));
        let misal_access_mpki =
            has(MetricPack::StlfSplits).then(|| mpki(self.misal_access, self.inst));
        let retiring_pct = has(MetricPack::ExactRetiring).then(|| {
            if eff_cycles > 0 {
                ((self.ret_uops as f64 / (6.0 * eff_cycles as f64)) * 100.0).clamp(0.0, 100.0)
            } else {
                0.0
            }
        });

        DerivedBaselineRates {
            ipc,
            actual_cpi,
            eff_ghz,
            l3_hit_pct,
            l3_lat_cyc,
            l3_lat_ns,
            dram_mpki,
            dem_dram_mpki,
            hwpf_dram_mpki,
            l3_hit_mpki,
            l2_dc_excl_mpki,
            l2_ic_miss_mpki,
            l1_ic_miss_mpki,
            l2_pf_dram_mpki,
            branch_miss_mpki,
            branch_miss_pct,
            l2_itlb_mpki,
            l2_dtlb_mpki,
            dc_cross_ccx_mpki,
            locks_serial_mpki,
            opcache_hit_pct,
            stlf_interlock_mpki,
            misal_access_mpki,
            retiring_pct,
        }
    }
}

/// Serializable baseline snapshot capturing metadata, active packs, and raw cumulative counters.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct BaselineSnapshot {
    pub name: String,
    pub timestamp_utc: String,
    pub elapsed_sec: f64,
    pub sample_count: u64,
    pub target_name: Option<String>,
    pub affinity_mask: Option<u64>,
    pub enabled_packs: Vec<MetricPack>,
    pub core_pmc_slots: u8,
    pub mux_groups: u8,
    pub ifeo_summary: String,
    pub note: String,
    pub counters: RawCumulativeCounters,
}

/// Serializes a `BaselineSnapshot` to pretty-printed JSON.
pub fn serialize_baseline_json(snapshot: &BaselineSnapshot) -> Result<String> {
    Ok(serde_json::to_string_pretty(snapshot)?)
}

/// Deserializes a `BaselineSnapshot` from JSON, preserving backwards compatibility for
/// partial payloads via `#[serde(default)]` and backfilling `core_pmc_slots` / `mux_groups`.
pub fn deserialize_baseline_json(input: &str) -> Result<BaselineSnapshot> {
    let mut snapshot: BaselineSnapshot = serde_json::from_str(input)?;
    if !snapshot.enabled_packs.is_empty()
        && (snapshot.core_pmc_slots == 0 || snapshot.mux_groups == 0)
    {
        if let Ok(plan) = pack_core_pmcs(&snapshot.enabled_packs) {
            if snapshot.core_pmc_slots == 0 {
                snapshot.core_pmc_slots = plan.core_slots;
            }
            if snapshot.mux_groups == 0 {
                snapshot.mux_groups = plan.mux_groups;
            }
        }
    }
    Ok(snapshot)
}

/// Percentage delta for a single compared metric.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BaselineMetricDelta {
    pub key: String,
    pub label: String,
    pub baseline: f64,
    pub current: f64,
    pub delta_pct: f64,
}

/// Comparison result between a saved baseline and a current snapshot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BaselineDiff {
    pub baseline_name: String,
    pub mux_diff_warning: bool,
    pub mux_diff_reason: Option<String>,
    pub small_delta_mux_warning: bool,
    pub small_delta_reason: Option<String>,
    pub deltas: Vec<BaselineMetricDelta>,
    pub skipped_metrics: Vec<String>,
}

fn delta_pct(baseline: f64, current: f64) -> f64 {
    if baseline.abs() > f64::EPSILON {
        ((current - baseline) / baseline) * 100.0
    } else {
        0.0
    }
}

/// Compares two baseline snapshots across Free Base metrics and the intersection of active packs.
pub fn compare_baselines(baseline: &BaselineSnapshot, current: &BaselineSnapshot) -> BaselineDiff {
    let b = baseline.counters.derived_rates(&baseline.enabled_packs);
    let c = current.counters.derived_rates(&current.enabled_packs);

    let mut deltas = Vec::with_capacity(24);
    let mut skipped_metrics = Vec::new();

    for (key, label, bv, cv) in [
        ("ipc", "IPC", b.ipc, c.ipc),
        ("actual_cpi", "Actual CPI", b.actual_cpi, c.actual_cpi),
        ("eff_ghz", "Effective GHz", b.eff_ghz, c.eff_ghz),
        ("l3_hit_pct", "L3 Hit %", b.l3_hit_pct, c.l3_hit_pct),
        ("l3_lat_cyc", "L3 Latency (cyc)", b.l3_lat_cyc, c.l3_lat_cyc),
        ("l3_lat_ns", "L3 Latency (ns)", b.l3_lat_ns, c.l3_lat_ns),
    ] {
        deltas.push(BaselineMetricDelta {
            key: key.to_string(),
            label: label.to_string(),
            baseline: bv,
            current: cv,
            delta_pct: delta_pct(bv, cv),
        });
    }

    for (key, label, bv, cv) in [
        ("dram_mpki", "DRAM MPKI", b.dram_mpki, c.dram_mpki),
        (
            "dem_dram_mpki",
            "Demand DRAM MPKI",
            b.dem_dram_mpki,
            c.dem_dram_mpki,
        ),
        (
            "hwpf_dram_mpki",
            "HWPF DRAM MPKI",
            b.hwpf_dram_mpki,
            c.hwpf_dram_mpki,
        ),
        ("l3_hit_mpki", "L3 Hit MPKI", b.l3_hit_mpki, c.l3_hit_mpki),
        (
            "l2_dc_excl_mpki",
            "L2 D-Cache Excl MPKI",
            b.l2_dc_excl_mpki,
            c.l2_dc_excl_mpki,
        ),
        (
            "l2_ic_miss_mpki",
            "L2 I-Cache Miss MPKI",
            b.l2_ic_miss_mpki,
            c.l2_ic_miss_mpki,
        ),
        (
            "l1_ic_miss_mpki",
            "L1 I-Cache Miss MPKI",
            b.l1_ic_miss_mpki,
            c.l1_ic_miss_mpki,
        ),
        (
            "l2_pf_dram_mpki",
            "L2 HWPF DRAM MPKI",
            b.l2_pf_dram_mpki,
            c.l2_pf_dram_mpki,
        ),
        (
            "branch_miss_mpki",
            "Branch Miss MPKI",
            b.branch_miss_mpki,
            c.branch_miss_mpki,
        ),
        (
            "branch_miss_pct",
            "Branch Miss %",
            b.branch_miss_pct,
            c.branch_miss_pct,
        ),
        (
            "l2_itlb_mpki",
            "L2 iTLB Miss MPKI",
            b.l2_itlb_mpki,
            c.l2_itlb_mpki,
        ),
        (
            "l2_dtlb_mpki",
            "L2 dTLB Miss MPKI",
            b.l2_dtlb_mpki,
            c.l2_dtlb_mpki,
        ),
        (
            "dc_cross_ccx_mpki",
            "Cross-CCX Fill MPKI",
            b.dc_cross_ccx_mpki,
            c.dc_cross_ccx_mpki,
        ),
        (
            "locks_serial_mpki",
            "Serialized Locks MPKI",
            b.locks_serial_mpki,
            c.locks_serial_mpki,
        ),
        (
            "opcache_hit_pct",
            "Op-Cache Hit %",
            b.opcache_hit_pct,
            c.opcache_hit_pct,
        ),
        (
            "stlf_interlock_mpki",
            "STLF Interlock MPKI",
            b.stlf_interlock_mpki,
            c.stlf_interlock_mpki,
        ),
        (
            "misal_access_mpki",
            "Misaligned Access MPKI",
            b.misal_access_mpki,
            c.misal_access_mpki,
        ),
        ("retiring_pct", "Retiring %", b.retiring_pct, c.retiring_pct),
    ] {
        match (bv, cv) {
            (Some(bv), Some(cv)) => deltas.push(BaselineMetricDelta {
                key: key.to_string(),
                label: label.to_string(),
                baseline: bv,
                current: cv,
                delta_pct: delta_pct(bv, cv),
            }),
            (None, None) => {}
            _ => skipped_metrics.push(key.to_string()),
        }
    }

    let mux_diff_warning = baseline.mux_groups != current.mux_groups;
    let mux_diff_reason = mux_diff_warning.then(|| {
        format!(
            "MUX DIFF: baseline used {} mux group(s) vs current {} mux group(s)",
            baseline.mux_groups, current.mux_groups
        )
    });

    let ipc_delta_pct = delta_pct(b.ipc, c.ipc);
    let small_delta_mux_warning =
        !mux_diff_warning && current.mux_groups >= 2 && ipc_delta_pct.abs() < 3.0;
    let small_delta_reason = small_delta_mux_warning.then(|| {
        format!(
            "IPC delta ({ipc_delta_pct:+.2}%) is under 3.0% noise floor under {}-mux scheduling",
            current.mux_groups
        )
    });

    BaselineDiff {
        baseline_name: baseline.name.clone(),
        mux_diff_warning,
        mux_diff_reason,
        small_delta_mux_warning,
        small_delta_reason,
        deltas,
        skipped_metrics,
    }
}
