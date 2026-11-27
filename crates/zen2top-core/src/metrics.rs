//! Pure Zen 2 metric math: throughput, 6-wide Retiring %, the Exclusive CPI Stack,
//! bounded time-series ring buffers, and CCX / SMT-sibling aggregation (`AGENTS.md` §3.3, §3.4).
//!
//! The CPI stack is additive time, never normalized to 100%, and stalls are never subtracted
//! from Actual CPI; the gap between modeled and actual CPI is reported as `hidden_ooo_mlp`.

use std::collections::VecDeque;

use serde::{Deserialize, Serialize};

use crate::config::{LatencyConfig, Zen2Config};
use crate::csv_parser::{CcxL3Row, CoreCounters, CoreCsvRow, ParsedCoreCsv, ParsedL3Csv};
use crate::diagnostics::TierCpiSummary;
use crate::packs::MetricPack;

/// Zen 2 retires at most 6 macro-ops per cycle.
pub const ZEN2_RETIRE_WIDTH: f64 = 6.0;
/// A logical CPU at or above this C0% counts as actively running a thread.
pub const SMT_ACTIVE_C0_PCT: f64 = 15.0;
/// A logical CPU below this C0% counts as idle.
pub const SMT_IDLE_C0_PCT: f64 = 2.0;

fn safe_div(num: f64, den: f64) -> f64 {
    if den > 0.0 && num.is_finite() && den.is_finite() {
        let out = num / den;
        if out.is_finite() {
            return out;
        }
    }
    0.0
}

/// Cycles used for CPI/IPC: `aperf` (reclaims a Core PMC slot), falling back to `cycles`.
pub fn effective_cycles(c: &CoreCounters) -> f64 {
    if c.aperf > 0.0 {
        c.aperf
    } else {
        c.cycles
    }
}

/// Live throughput paired with efficiency so thread-count drops cannot masquerade as IPC gains.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct Throughput {
    pub inst_per_sec: f64,
    pub cyc_per_sec: f64,
    pub ipc: f64,
    pub actual_cpi: f64,
}

/// Derives `Inst/s`, `Cyc/s`, IPC and Actual CPI from one sample window of `interval_sec`.
pub fn compute_throughput(c: &CoreCounters, interval_sec: f64) -> Throughput {
    let cyc = effective_cycles(c);
    Throughput {
        inst_per_sec: safe_div(c.inst, interval_sec),
        cyc_per_sec: safe_div(cyc, interval_sec),
        ipc: safe_div(c.inst, cyc),
        actual_cpi: safe_div(cyc, c.inst),
    }
}

/// 6-wide Retiring %; `exact == false` means the value is an estimate (`Ret ~XX%`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct Retiring {
    pub pct: f64,
    pub exact: bool,
}

/// Exact `ret_uops / (6 * cycles)` when `ExactRetiring` (`0x4300C1`) is active, otherwise
/// `IPC * uops_per_inst / 6` (zero extra PMCs). Both are clamped to `0..=100`.
pub fn compute_retiring(c: &CoreCounters, uops_per_inst: f64, exact_active: bool) -> Retiring {
    let cyc = effective_cycles(c);
    let ratio = if exact_active {
        safe_div(c.ret_uops, ZEN2_RETIRE_WIDTH * cyc)
    } else {
        safe_div(c.inst, cyc) * uops_per_inst / ZEN2_RETIRE_WIDTH
    };
    Retiring {
        pct: (ratio * 100.0).clamp(0.0, 100.0),
        exact: exact_active,
    }
}

/// One stack tier: events per kilo-instruction, assumed latency, and `mpki / 1000 * latency`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct TierStall {
    pub mpki: f64,
    pub latency_cyc: f64,
    pub cpi: f64,
}

fn tier(events: f64, inst: f64, latency_cyc: f64) -> TierStall {
    let mpki = safe_div(events.max(0.0) * 1000.0, inst);
    TierStall {
        mpki,
        latency_cyc,
        cpi: mpki / 1000.0 * latency_cyc,
    }
}

/// Two-line Exclusive CPI Stack: Actual CPI (line 1) vs. modeled Flush + MLP tiers (line 2).
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct CpiStack {
    pub actual_cpi: f64,
    /// Flush group: pipeline restarts / front-end bubbles.
    pub branch: TierStall,
    pub l2_ic: TierStall,
    pub l2_itlb: TierStall,
    /// MLP group: back-end misses the out-of-order core can overlap.
    pub l2_dc: TierStall,
    pub l3_hit: TierStall,
    pub dram: TierStall,
    pub l2_dtlb: TierStall,
    pub flush_cpi: f64,
    pub mlp_cpi: f64,
    pub modeled_cpi: f64,
    /// `max(0, modeled - actual)`: stall time hidden by OoO / memory-level parallelism.
    pub hidden_ooo_mlp: f64,
    /// `true` when the DRAM tier used the live measured `l3_lat` instead of the config fallback.
    pub dram_latency_live: bool,
}

impl From<&CpiStack> for TierCpiSummary {
    fn from(s: &CpiStack) -> Self {
        Self {
            dram: s.dram.cpi,
            l3_hit: s.l3_hit.cpi,
            l2_dc: s.l2_dc.cpi,
            l2_ic: s.l2_ic.cpi,
            branch: s.branch.cpi,
            l2_dtlb: s.l2_dtlb.cpi,
            l2_itlb: s.l2_itlb.cpi,
        }
    }
}

/// Builds the Exclusive CPI Stack. `L2D_excl = max(0, L1D - L2D)` and `L2I_excl = max(0, L1I - L2I)`
/// are clamped so multiplexed counter skew never yields negative MPKI/CPI. The DRAM tier uses
/// `live_dram_lat_cyc` when it is finite and positive, else `lat.dram_fallback`.
pub fn compute_cpi_stack(
    c: &CoreCounters,
    lat: &LatencyConfig,
    live_dram_lat_cyc: Option<f64>,
) -> CpiStack {
    let live = live_dram_lat_cyc.filter(|l| l.is_finite() && *l > 0.0);
    let inst = c.inst;
    let branch = tier(c.branch_miss, inst, lat.branch_mispredict);
    let l2_ic = tier(c.l1_ic_miss - c.l2_ic_miss, inst, lat.l2_hit);
    let l2_itlb = tier(c.l2_itlb_miss, inst, lat.l2_itlb_walk);
    let l2_dc = tier(c.l1_dc_miss - c.l2_dc_miss, inst, lat.l2_hit);
    let l3_hit = tier(c.dc_dem_l3, inst, lat.l3_hit);
    let dram = tier(c.dc_dem_dram, inst, live.unwrap_or(lat.dram_fallback));
    let l2_dtlb = tier(c.l2_dtlb_miss, inst, lat.l2_dtlb_walk);
    let flush_cpi = branch.cpi + l2_ic.cpi + l2_itlb.cpi;
    let mlp_cpi = l2_dc.cpi + l3_hit.cpi + dram.cpi + l2_dtlb.cpi;
    let modeled_cpi = flush_cpi + mlp_cpi;
    let actual_cpi = compute_throughput(c, 1.0).actual_cpi;
    CpiStack {
        actual_cpi,
        branch,
        l2_ic,
        l2_itlb,
        l2_dc,
        l3_hit,
        dram,
        l2_dtlb,
        flush_cpi,
        mlp_cpi,
        modeled_cpi,
        hidden_ooo_mlp: if actual_cpi > 0.0 {
            (modeled_cpi - actual_cpi).max(0.0)
        } else {
            0.0
        },
        dram_latency_live: live.is_some(),
    }
}

/// All per-sample core metrics for one aggregate window.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct CoreMetrics {
    pub throughput: Throughput,
    pub retiring: Retiring,
    pub cpi_stack: CpiStack,
}

/// Computes throughput, Retiring % and the CPI stack from counters, config and active packs.
pub fn compute_core_metrics(
    c: &CoreCounters,
    cfg: &Zen2Config,
    packs: &[MetricPack],
    l3: Option<&CcxL3Row>,
    interval_sec: f64,
) -> CoreMetrics {
    let exact = packs.contains(&MetricPack::ExactRetiring);
    CoreMetrics {
        throughput: compute_throughput(c, interval_sec),
        retiring: compute_retiring(c, cfg.retiring.uops_per_inst, exact),
        cpi_stack: compute_cpi_stack(c, &cfg.latencies, l3.map(|r| r.lat_cyc)),
    }
}

/// Fixed-capacity time-series buffer; the oldest sample is evicted once full.
#[derive(Debug, Clone, PartialEq)]
pub struct RingBuffer {
    cap: usize,
    data: VecDeque<f64>,
}

impl RingBuffer {
    /// Creates a buffer holding at most `cap` samples (minimum 1).
    pub fn new(cap: usize) -> Self {
        let cap = cap.max(1);
        Self {
            cap,
            data: VecDeque::with_capacity(cap),
        }
    }

    /// Appends a sample (non-finite values are stored as `0.0` so plots never see NaN/Inf).
    pub fn push(&mut self, v: f64) {
        if self.data.len() == self.cap {
            self.data.pop_front();
        }
        self.data.push_back(if v.is_finite() { v } else { 0.0 });
    }

    pub fn len(&self) -> usize {
        self.data.len()
    }

    pub fn is_empty(&self) -> bool {
        self.data.is_empty()
    }

    pub fn capacity(&self) -> usize {
        self.cap
    }

    pub fn latest(&self) -> Option<f64> {
        self.data.back().copied()
    }

    /// Iterates oldest to newest.
    pub fn iter(&self) -> impl Iterator<Item = f64> + '_ {
        self.data.iter().copied()
    }

    pub fn to_vec(&self) -> Vec<f64> {
        self.iter().collect()
    }

    pub fn clear(&mut self) {
        self.data.clear();
    }
}

/// Rolling plot history for the headline metrics.
#[derive(Debug, Clone, PartialEq)]
pub struct MetricHistory {
    pub ipc: RingBuffer,
    pub inst_per_sec: RingBuffer,
    pub retiring_pct: RingBuffer,
    pub actual_cpi: RingBuffer,
    pub modeled_cpi: RingBuffer,
}

impl MetricHistory {
    pub fn new(cap: usize) -> Self {
        Self {
            ipc: RingBuffer::new(cap),
            inst_per_sec: RingBuffer::new(cap),
            retiring_pct: RingBuffer::new(cap),
            actual_cpi: RingBuffer::new(cap),
            modeled_cpi: RingBuffer::new(cap),
        }
    }

    pub fn push(&mut self, m: &CoreMetrics) {
        self.ipc.push(m.throughput.ipc);
        self.inst_per_sec.push(m.throughput.inst_per_sec);
        self.retiring_pct.push(m.retiring.pct);
        self.actual_cpi.push(m.cpi_stack.actual_cpi);
        self.modeled_cpi.push(m.cpi_stack.modeled_cpi);
    }
}

/// Activity classification of one physical core's two SMT siblings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SmtPairState {
    /// Both siblings `>= 15%` C0 (shown as `⇄`).
    BothActive,
    /// At most one sibling is active (1T-style `│`).
    SingleThread,
    /// Both siblings `< 2%` C0.
    BothIdle,
}

/// Classifies a sibling pair from their C0% values.
pub fn classify_smt_pair(c0_a: f64, c0_b: f64) -> SmtPairState {
    if c0_a >= SMT_ACTIVE_C0_PCT && c0_b >= SMT_ACTIVE_C0_PCT {
        SmtPairState::BothActive
    } else if c0_a < SMT_IDLE_C0_PCT && c0_b < SMT_IDLE_C0_PCT {
        SmtPairState::BothIdle
    } else {
        SmtPairState::SingleThread
    }
}

/// Per-physical-core sibling summary (`P0 1.42(88%) │ idle`).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SmtPair {
    pub core_index: usize,
    pub cpu_a: usize,
    pub cpu_b: usize,
    pub c0_a: f64,
    pub c0_b: f64,
    pub ipc_a: f64,
    pub ipc_b: f64,
    pub state: SmtPairState,
}

impl SmtPair {
    pub fn idle_a(&self) -> bool {
        self.c0_a < SMT_IDLE_C0_PCT
    }

    pub fn idle_b(&self) -> bool {
        self.c0_b < SMT_IDLE_C0_PCT
    }
}

/// Joins discovered sibling `pairs` (logical CPU ids) with parsed per-CPU rows; CPUs without a
/// row (e.g. excluded by the affinity mask) are treated as idle with zero IPC.
pub fn aggregate_smt_pairs(rows: &[CoreCsvRow], pairs: &[(usize, usize)]) -> Vec<SmtPair> {
    let find = |cpu: usize| {
        rows.iter()
            .find(|r| r.cpu_id == cpu)
            .map_or((0.0, 0.0), |r| (r.c0_pct, r.ipc))
    };
    pairs
        .iter()
        .enumerate()
        .map(|(core_index, &(cpu_a, cpu_b))| {
            let ((c0_a, ipc_a), (c0_b, ipc_b)) = (find(cpu_a), find(cpu_b));
            SmtPair {
                core_index,
                cpu_a,
                cpu_b,
                c0_a,
                c0_b,
                ipc_a,
                ipc_b,
                state: classify_smt_pair(c0_a, c0_b),
            }
        })
        .collect()
}

/// CCX0 / CCX1 strip row: IPC, GHz, L3 Hit %, L3 latency and DRAM MPKI.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct CcxSummary {
    pub ccx_id: usize,
    pub cpu_count: usize,
    pub ipc: f64,
    pub eff_ghz: f64,
    pub c0_pct: f64,
    pub l3_hit_pct: f64,
    pub l3_lat_cyc: f64,
    pub l3_lat_ns: f64,
    /// Demand + HWPF DRAM fills per kilo-instruction (inactive packs contribute zero).
    pub dram_mpki: f64,
}

/// Joins per-CCX core aggregates with per-CCX L3 rows (matched by `ccx_id`; missing L3 -> zeros).
pub fn summarize_ccx(core: &ParsedCoreCsv, l3: &ParsedL3Csv) -> Vec<CcxSummary> {
    core.ccx_totals
        .iter()
        .map(|a| {
            let ccx_id = a.ccx_id.unwrap_or(0);
            let l3_row = l3.per_ccx.iter().find(|r| r.ccx_id == ccx_id);
            let c = &a.counters;
            CcxSummary {
                ccx_id,
                cpu_count: a.cpu_count,
                ipc: a.ipc,
                eff_ghz: a.eff_ghz,
                c0_pct: a.c0_pct,
                l3_hit_pct: l3_row.map_or(0.0, |r| r.l3_hit_pct),
                l3_lat_cyc: l3_row.map_or(0.0, |r| r.lat_cyc),
                l3_lat_ns: l3_row.map_or(0.0, |r| r.lat_ns),
                dram_mpki: safe_div(
                    (c.dc_dem_dram + c.dc_hwpf_dram + c.l2_pf_dram).max(0.0) * 1000.0,
                    c.inst,
                ),
            }
        })
        .collect()
}
