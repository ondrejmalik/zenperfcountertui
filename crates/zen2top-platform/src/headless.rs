//! Full `schema_version: 1` headless capture pipeline (`--no-pmu` and mock PMU backends).

use crate::core::{baseline::*, config::*, csv_parser::*, diagnostics::*, metrics::*, packs::*, *};
use crate::{allocator::*, pmu::contention::*, pmu::*, symbols::*};
use anyhow::Context;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct TargetSummary {
    pub pid: Option<u32>,
    pub name: Option<String>,
    pub exited_early: bool,
    pub affinity_mask: Option<u64>,
    pub allocator_detected: Option<String>,
    pub allocator_detection_method: Option<String>,
    pub rminject_eligibility: Option<RminjectEligibility>,
    pub has_lock_memory_privilege: bool,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct CaptureSummary {
    pub ipc: f64,
    pub actual_cpi: f64,
    pub retiring_pct: f64,
    pub retiring_exact: bool,
    pub inst_per_sec: f64,
    pub cyc_per_sec: f64,
    pub eff_ghz: f64,
    pub avg_c0_pct: f64,
    pub l3_hit_pct: f64,
    pub l3_lat_cyc: f64,
    pub l3_lat_ns: f64,
    pub cpi_stack: CpiStack,
    pub ccx_summary: Vec<CcxSummary>,
    pub smt_pairs: Vec<SmtPair>,
    pub raw_cumulative_counters: RawCumulativeCounters,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct VaMapBreakdown {
    pub private_rw_2m_mib: f64,
    pub private_rw_4k_mib: f64,
    pub jit_2m_mib: f64,
    pub jit_4k_mib: f64,
    pub mapped_2m_mib: f64,
    pub mapped_4k_mib: f64,
    pub image_2m_mib: f64,
    pub image_4k_mib: f64,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct PresentEtwSummary {
    pub fps: f64,
    pub frametime_avg_ms: f64,
    pub frametime_p99_ms: f64,
    pub frametime_p999_ms: f64,
    pub flip_mode: String,
    pub spike_correlations: Vec<(u64, f64, String)>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Win32EtwSummary {
    pub gpu_3d_pct: Option<f64>,
    pub max_hot_core_dpc_irq_pct: f64,
    pub hard_page_faults_per_sec: f64,
    pub soft_page_faults_per_sec: f64,
    pub free_ram_pct: f64,
    pub disk_read_mb_s: f64,
    pub disk_write_mb_s: f64,
    pub ctx_sw_per_sec: f64,
    pub sync_wait_pct: f64,
    pub priority_class: String,
    pub ecoqos_active: Option<bool>,
    pub noisy_neighbors: Vec<(String, u32, f64)>,
    pub va_map: VaMapBreakdown,
    pub present_etw: PresentEtwSummary,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ProfilerFunctionEntry {
    pub module: String,
    pub name: String,
    pub tier: SymbolTier,
    pub self_pct: f64,
    pub samples: u64,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct OffCpuWaitEntry {
    pub module: String,
    pub name: String,
    pub blocked_ms: f64,
    pub wakes: u64,
    pub top_waker: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ProfilerSummary {
    pub on_cpu_top: Vec<ProfilerFunctionEntry>,
    pub off_cpu_top: Vec<OffCpuWaitEntry>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct RawProfilerSample {
    pub module: String,
    pub rva: u32,
    pub weight: u64,
    pub blocked_ms: Option<f64>,
    pub waker: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct CaptureMeta {
    pub schema_version: u32,
    pub zen2top_version: String,
    pub timestamp_utc: String,
    pub calibrated: bool,
    pub preset: String,
    pub enabled_packs: Vec<MetricPack>,
    pub core_pmc_slots: u8,
    pub mux_groups: u8,
    pub interval_sec: u64,
    pub elapsed_sec: f64,
    pub sample_count: u64,
    pub evidence_gate_passed: bool,
    pub evidence_gate_reason: String,
    pub no_pmu: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pmc_contention: Option<PmcContentionReport>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct HeadlessCaptureReport {
    pub meta: CaptureMeta,
    pub target: TargetSummary,
    pub summary: CaptureSummary,
    pub win32_etw: Win32EtwSummary,
    pub advisor: DiagnosticReport,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub baseline_diff: Option<BaselineDiff>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profiler: Option<ProfilerSummary>,
}

#[derive(Debug, Clone, Default)]
pub struct CaptureRequest {
    pub config: Zen2Config,
    pub preset: String,
    pub packs: Option<Vec<MetricPack>>,
    pub interval_sec: Option<u64>,
    pub duration_sec: u64,
    pub no_pmu: bool,
    pub target_pid: Option<u32>,
    pub target_name: Option<String>,
    pub target_missing_or_exited: bool,
    pub target_exited_early: bool,
    pub affinity_mask: Option<u64>,
    pub topology: CcxTopology,
    pub smt_pairs: Vec<(usize, usize)>,
    pub timestamp_utc: String,
    pub include_profiler: bool,
    pub baseline: Option<BaselineSnapshot>,
    pub contention: Option<PmcContentionReport>,
    pub win32_etw: Win32EtwSummary,
    pub win32_sample_count: u64,
    pub avg_c0_override_pct: Option<f64>,
    pub allocator_obs: Option<AllocatorObservation>,
    pub profiler_samples: Vec<RawProfilerSample>,
}

fn default_if_empty(value: &str, fallback: &str) -> String {
    if value.is_empty() {
        fallback.to_owned()
    } else {
        value.to_owned()
    }
}

#[derive(Default)]
struct CaptureWindow {
    summary: CaptureSummary,
    sample_count: u64,
    elapsed_sec: f64,
    core_c0_pct: Vec<f64>,
    ccx_lat_ns: Vec<f64>,
}
type CollectPmu = fn(&PackPlan) -> anyhow::Result<CaptureWindow>;
type CaptureResult = anyhow::Result<(HeadlessExitCode, HeadlessCaptureReport)>;

pub fn run_no_pmu_capture(req: &CaptureRequest) -> CaptureResult {
    run_inner(req, None::<CollectPmu>, None, None)
}

pub fn run_headless_capture<B: PmuBackend>(
    req: &CaptureRequest,
    c: Option<&mut PmuCoordinator<B>>,
    a: Option<&dyn AllocatorInspector>,
    s: Option<&dyn SymbolResolver>,
) -> CaptureResult {
    let f = c.map(|c| move |p: &PackPlan| collect_pmu(req, p, c));
    run_inner(req, f, a, s)
}

fn run_inner<F: FnOnce(&PackPlan) -> anyhow::Result<CaptureWindow>>(
    req: &CaptureRequest,
    col: Option<F>,
    alloc: Option<&dyn AllocatorInspector>,
    syms: Option<&dyn SymbolResolver>,
) -> CaptureResult {
    use HeadlessExitCode::*;
    let interval_sec = req.interval_sec.unwrap_or(1);
    anyhow::ensure!(
        matches!(interval_sec, 1 | 2 | 5),
        "bad --interval {interval_sec}"
    );
    let preset = default_if_empty(&req.preset, "balanced");
    let packs = match &req.packs {
        Some(p) => p.as_slice(),
        None => resolve_preset(&preset).context("unknown preset")?.packs(),
    };
    let plan = pack_core_pmcs(packs)?;
    let observation = req.allocator_obs.as_ref();
    let inspector = alloc.unwrap_or(&Layer1AllocatorInspector);
    let allocator_report = observation.map(|o| inspector.inspect(o)).transpose()?;
    let target = TargetSummary {
        pid: req.target_pid,
        name: req.target_name.clone(),
        exited_early: req.target_exited_early || req.target_missing_or_exited,
        affinity_mask: req.affinity_mask,
        allocator_detected: allocator_report.as_ref().map(|r| r.label.clone()),
        allocator_detection_method: allocator_report
            .as_ref()
            .map(|r| r.detection_method.clone()),
        rminject_eligibility: allocator_report
            .as_ref()
            .map(|r| r.rminject_eligibility.clone()),
        has_lock_memory_privilege: observation.is_some_and(|o| o.has_lock_memory_privilege),
    };
    let (mut code, mut window, mut abort_reason, mut pmc_contention) =
        (Ok, CaptureWindow::default(), None, None);
    let contention = req.contention.as_ref();
    let contention = contention.filter(|x| !req.no_pmu && x.detected);
    if req.target_missing_or_exited {
        (code, abort_reason) = (TargetUnavailable, Some("target_unavailable"));
    } else if let Some(c) = contention {
        let (exit_code, r) = EvictionPromptState::new(c.clone()).resolve_headless();
        (code, abort_reason, pmc_contention) = (exit_code, Some("pmc_contention"), Some(r));
    } else if req.no_pmu {
        let s = CaptureSummary {
            avg_c0_pct: req.avg_c0_override_pct.unwrap_or(0.0),
            ..Default::default()
        };
        let n = req.win32_sample_count;
        let elapsed_sec = n as f64 * interval_sec as f64;
        window = CaptureWindow {
            summary: s,
            sample_count: n,
            elapsed_sec,
            ..Default::default()
        };
    } else {
        window =
            col.context("Live PMU collection requires --no-pmu or a mock PmuCoordinator.")?(&plan)?;
    }
    let default_resolver = TieredSymbolResolver::new();
    let resolver = syms.unwrap_or(&default_resolver);
    let include_profiler = abort_reason.is_none() && req.include_profiler;
    let profiler = include_profiler.then(|| build_profiler(&req.profiler_samples, resolver));
    let CaptureWindow {
        summary,
        sample_count,
        elapsed_sec,
        core_c0_pct,
        ccx_lat_ns,
    } = window;
    let win32 = &req.win32_etw;
    let advisor = if let Some(m) = abort_reason {
        DiagnosticReport {
            evidence_gate_reason: m.into(),
            verdict_id: "insufficient_data".into(),
            verdict_label: "Insufficient Data".into(),
            ..Default::default()
        }
    } else {
        let counters = &summary.raw_cumulative_counters;
        let r = counters.derived_rates(&plan.effective_packs);
        let image_mib = win32.va_map.image_2m_mib + win32.va_map.image_4k_mib;
        let d = DiagnosticInput {
            avg_c0_pct: summary.avg_c0_pct,
            inst_per_sec: summary.inst_per_sec,
            ipc: summary.ipc,
            actual_cpi: summary.actual_cpi,
            retiring_pct: summary.retiring_pct,
            retiring_exact: summary.retiring_exact,
            eff_ghz: summary.eff_ghz,
            l3_hit_pct: summary.l3_hit_pct,
            l3_lat_ns: summary.l3_lat_ns,
            l3_lat_cyc: summary.l3_lat_cyc,
            gpu_3d_pct: win32.gpu_3d_pct,
            hard_page_faults_per_sec: win32.hard_page_faults_per_sec,
            soft_page_faults_per_sec: win32.soft_page_faults_per_sec,
            ctx_sw_per_sec: win32.ctx_sw_per_sec,
            sync_wait_pct: win32.sync_wait_pct,
            ecoqos_active: win32.ecoqos_active,
            disk_read_mb_s: win32.disk_read_mb_s,
            dram_mpki: r.dram_mpki.unwrap_or(0.0),
            dem_dram_mpki: r.dem_dram_mpki.unwrap_or(0.0),
            hwpf_dram_mpki: r.hwpf_dram_mpki.unwrap_or(0.0),
            l2_pf_dram_mpki: r.l2_pf_dram_mpki.unwrap_or(0.0),
            l3_hit_mpki: r.l3_hit_mpki.unwrap_or(0.0),
            l2_dc_excl_mpki: r.l2_dc_excl_mpki.unwrap_or(0.0),
            l2_ic_miss_mpki: r.l2_ic_miss_mpki.unwrap_or(0.0),
            l1_ic_miss_mpki: r.l1_ic_miss_mpki.unwrap_or(0.0),
            branch_miss_mpki: r.branch_miss_mpki.unwrap_or(0.0),
            branch_miss_pct: r.branch_miss_pct.unwrap_or(0.0),
            l2_itlb_mpki: r.l2_itlb_mpki.unwrap_or(0.0),
            l2_dtlb_mpki: r.l2_dtlb_mpki.unwrap_or(0.0),
            dc_cross_ccx_mpki: r.dc_cross_ccx_mpki.unwrap_or(0.0),
            locks_serial_mpki: r.locks_serial_mpki.unwrap_or(0.0),
            opcache_hit_pct: r.opcache_hit_pct.unwrap_or(0.0),
            stlf_interlock_mpki: r.stlf_interlock_mpki.unwrap_or(0.0),
            misal_access_mpki: r.misal_access_mpki.unwrap_or(0.0),
            config: req.config.clone(),
            enabled_packs: plan.effective_packs.clone(),
            no_pmu: req.no_pmu,
            mux_groups: plan.mux_groups,
            sample_count,
            tier_cpi: TierCpiSummary::from(&summary.cpi_stack),
            core_c0_pct,
            ccx_lat_ns,
            modeled_cpi: summary.cpi_stack.modeled_cpi,
            ooo_hidden_cpi: summary.cpi_stack.hidden_ooo_mlp,
            avail_phys_pct: if win32.free_ram_pct == 0.0 && win32.priority_class.is_empty() {
                50.0
            } else {
                win32.free_ram_pct
            },
            priority_class: default_if_empty(&win32.priority_class, "Normal"),
            has_lock_memory_privilege: target.has_lock_memory_privilege,
            target_present: target.pid.is_some() || target.name.is_some(),
            target_name: target.name.clone(),
            target_ws_mib: req.allocator_obs.as_ref().map_or(0.0, |o| o.ws_mib),
            target_huge_mib: req
                .allocator_obs
                .as_ref()
                .map_or(0.0, |o| o.private_rw_huge_2mib_mib),
            jit_exec_4k_mib: win32.va_map.jit_4k_mib,
            image_large_2m_pct: if image_mib > 0.0 {
                (win32.va_map.image_2m_mib / image_mib) * 100.0
            } else {
                0.0
            },
            frametime_spikes: win32.present_etw.spike_correlations.len() as u64,
            noisy_neighbors: win32.noisy_neighbors.clone(),
            baseline_mux_groups: req.baseline.as_ref().map(|b| b.mux_groups),
            baseline_ipc: req
                .baseline
                .as_ref()
                .map(|b| b.counters.derived_rates(&b.enabled_packs).ipc),
            top_on_cpu_fn: profiler
                .as_ref()
                .and_then(|p| p.on_cpu_top.first())
                .map(|f| format!("{} ({:.1}%)", f.name, f.self_pct)),
            top_off_cpu_wait: profiler
                .as_ref()
                .and_then(|p| p.off_cpu_top.first())
                .map(|o| format!("{} ({:.1}ms)", o.name, o.blocked_ms)),
            ..Default::default()
        };
        DiagnosticEngine::evaluate(&d)
    };
    let timestamp_utc = default_if_empty(&req.timestamp_utc, "1970-01-01T00:00:00Z");
    let baseline_diff = abort_reason
        .is_none()
        .then_some(req.baseline.as_ref())
        .flatten()
        .map(|base| {
            let current = BaselineSnapshot {
                name: "current".into(),
                timestamp_utc: timestamp_utc.clone(),
                elapsed_sec,
                sample_count,
                target_name: target.name.clone(),
                affinity_mask: target.affinity_mask,
                enabled_packs: plan.effective_packs.clone(),
                core_pmc_slots: plan.core_slots,
                mux_groups: plan.mux_groups,
                counters: summary.raw_cumulative_counters.clone(),
                ..Default::default()
            };
            compare_baselines(base, &current)
        });
    let (pass, g) = (advisor.evidence_gate_passed, &advisor.evidence_gate_reason);
    let reason: String = abort_reason
        .unwrap_or(if pass { "passed" } else { g })
        .into();
    let meta = CaptureMeta {
        schema_version: HEADLESS_SCHEMA_VERSION,
        zen2top_version: env!("CARGO_PKG_VERSION").into(),
        timestamp_utc,
        calibrated: req.config.calibrated,
        preset: plan.preset_slug.clone().unwrap_or(preset),
        enabled_packs: plan.effective_packs.clone(),
        core_pmc_slots: plan.core_slots,
        mux_groups: plan.mux_groups,
        interval_sec,
        elapsed_sec,
        sample_count,
        evidence_gate_passed: pass,
        evidence_gate_reason: reason,
        no_pmu: req.no_pmu,
        pmc_contention,
    };
    let report = HeadlessCaptureReport {
        meta,
        target,
        summary,
        win32_etw: win32.clone(),
        advisor,
        baseline_diff,
        profiler,
    };
    Result::Ok((code, report))
}

fn counter_total(value: f64) -> u64 {
    if value.is_finite() && value > 0.0 {
        value.round() as u64
    } else {
        0
    }
}

fn collect_pmu<B: PmuBackend>(
    req: &CaptureRequest,
    plan: &PackPlan,
    coordinator: &mut PmuCoordinator<B>,
) -> anyhow::Result<CaptureWindow> {
    coordinator.start()?;
    let (mut totals, mut latest_core, mut latest_l3): (CoreCounters, ParsedCoreCsv, ParsedL3Csv) =
        Default::default();
    let (mut l3_access, mut l3_misses, mut l3_latency, mut l3_misses_with_latency) =
        (0.0, 0.0, 0.0, 0.0);
    let (mut c0_total, mut elapsed_sec, mut sample_count) = (0.0, 0.0, 0u64);
    let mut options = CsvSampleOptions {
        affinity_mask: req.affinity_mask,
        base_mhz: req.config.base_mhz,
        interval_sec: 1.0,
        topology: req.topology.clone(),
    };
    let mut run = || -> anyhow::Result<()> {
        for _ in 0..req.duration_sec.max(1).saturating_mul(16).max(64) {
            let Some(sample) = coordinator.poll_sample()? else {
                break;
            };
            let interval_sec = sample.interval_sec.max(1) as f64;
            (sample_count, elapsed_sec, options.interval_sec) =
                (sample_count + 1, elapsed_sec + interval_sec, interval_sec);
            if let Some(csv) = &sample.raw_csv_core {
                latest_core = parse_report_core_csv(csv, &options)?;
                totals.add_assign(&latest_core.total.counters);
                c0_total += latest_core.total.c0_pct;
            }
            if let Some(csv) = &sample.raw_csv_l3 {
                latest_l3 = parse_report_l3_csv(csv, latest_core.total.eff_ghz)?;
                let r = &latest_l3.total;
                l3_access += r.l3_access;
                l3_misses += r.l3_miss;
                l3_latency += r.l3_lat;
                l3_misses_with_latency += r.l3_mtype;
            }
        }
        Ok(())
    };
    let result = run();
    let stop_result = coordinator.stop();
    result?;
    stop_result.context("stop PMU capture")?;
    let div = |a, b| if b > 0.0 { a / b } else { 0.0 };
    let base_mhz = req.config.base_mhz;
    let eff_ghz = div(totals.aperf, totals.mperf) * (base_mhz / 1000.0);
    let (l3_hit, l3_cyc) = (
        div((l3_access - l3_misses).max(0.0), l3_access) * 100.0,
        div(l3_latency * 16.0, l3_misses_with_latency),
    );
    let l3_ns = div(l3_cyc, eff_ghz);
    let l3 = CcxL3Row {
        l3_access,
        l3_miss: l3_misses,
        l3_lat: l3_latency,
        l3_mtype: l3_misses_with_latency,
        l3_hit_pct: l3_hit,
        lat_cyc: l3_cyc,
        lat_ns: l3_ns,
        ..Default::default()
    };
    let (config, packs, duration) = (&req.config, &plan.effective_packs, elapsed_sec.max(1.0));
    let measured_l3 = (l3_misses_with_latency > 0.0).then_some(&l3);
    let metrics = compute_core_metrics(&totals, config, packs, measured_l3, duration);
    let raw = RawCumulativeCounters {
        base_mhz,
        inst: counter_total(totals.inst),
        aperf: counter_total(totals.aperf),
        mperf: counter_total(totals.mperf),
        cycles: counter_total(totals.cycles),
        ret_uops: counter_total(totals.ret_uops),
        dc_dem_l3: counter_total(totals.dc_dem_l3),
        dc_dem_dram: counter_total(totals.dc_dem_dram),
        dc_hwpf_l3: counter_total(totals.dc_hwpf_l3),
        dc_hwpf_dram: counter_total(totals.dc_hwpf_dram),
        l1_dc_miss: counter_total(totals.l1_dc_miss),
        l2_dc_miss: counter_total(totals.l2_dc_miss),
        l1_ic_miss: counter_total(totals.l1_ic_miss),
        l2_ic_miss: counter_total(totals.l2_ic_miss),
        l2_pf_l3: counter_total(totals.l2_pf_l3),
        l2_pf_dram: counter_total(totals.l2_pf_dram),
        branches: counter_total(totals.branches),
        branch_miss: counter_total(totals.branch_miss),
        l1_itlb_hit: counter_total(totals.l1_itlb_hit),
        l1_itlb_miss_l2_hit: counter_total(totals.l1_itlb_miss_l2_hit),
        l2_itlb_miss: counter_total(totals.l2_itlb_miss),
        l1_dtlb_miss_l2_hit: counter_total(totals.l1_dtlb_miss_l2_hit),
        l2_dtlb_miss: counter_total(totals.l2_dtlb_miss),
        dc_cross_ccx: counter_total(totals.dc_cross_ccx),
        locks_serial: counter_total(totals.locks_serial),
        dec_uops: counter_total(totals.dec_uops),
        oc_uops: counter_total(totals.oc_uops),
        stlf_interlock: counter_total(totals.stlf_interlock),
        misal_access: counter_total(totals.misal_access),
        l3_access: counter_total(l3.l3_access),
        l3_miss: counter_total(l3.l3_miss),
        l3_lat: counter_total(l3.l3_lat),
        l3_mtype: counter_total(l3.l3_mtype),
    };
    let c0_avg = req
        .avg_c0_override_pct
        .unwrap_or_else(|| div(c0_total, sample_count as f64));
    let summary = CaptureSummary {
        ipc: metrics.throughput.ipc,
        actual_cpi: metrics.throughput.actual_cpi,
        retiring_pct: metrics.retiring.pct,
        retiring_exact: metrics.retiring.exact,
        inst_per_sec: metrics.throughput.inst_per_sec,
        cyc_per_sec: metrics.throughput.cyc_per_sec,
        eff_ghz,
        avg_c0_pct: c0_avg,
        l3_hit_pct: l3_hit,
        l3_lat_cyc: l3_cyc,
        l3_lat_ns: l3_ns,
        cpi_stack: metrics.cpi_stack,
        ccx_summary: summarize_ccx(&latest_core, &latest_l3),
        smt_pairs: aggregate_smt_pairs(&latest_core.per_cpu, &req.smt_pairs),
        raw_cumulative_counters: raw,
    };
    let core_c0_pct = latest_core.per_cpu.iter().map(|r| r.c0_pct).collect();
    let ccx_lat_ns = latest_l3.per_ccx.iter().map(|r| r.lat_ns).collect();
    Ok(CaptureWindow {
        summary,
        sample_count,
        elapsed_sec,
        core_c0_pct,
        ccx_lat_ns,
    })
}

fn build_profiler(samples: &[RawProfilerSample], resolver: &dyn SymbolResolver) -> ProfilerSummary {
    let mut on_cpu: BTreeMap<String, ProfilerFunctionEntry> = BTreeMap::new();
    let mut off_cpu: BTreeMap<String, OffCpuWaitEntry> = BTreeMap::new();
    let mut total_weight = 0;

    for sample in samples {
        let symbol = resolver.resolve(&sample.module, sample.rva);
        if let Some(blocked_ms) = sample.blocked_ms {
            let entry = off_cpu
                .entry(symbol.key)
                .or_insert_with(|| OffCpuWaitEntry {
                    module: symbol.module,
                    name: symbol.name,
                    top_waker: sample.waker.clone(),
                    ..Default::default()
                });
            entry.blocked_ms += blocked_ms;
            entry.wakes += 1;
        } else {
            let entry = on_cpu
                .entry(symbol.key)
                .or_insert_with(|| ProfilerFunctionEntry {
                    module: symbol.module,
                    name: symbol.name,
                    tier: symbol.tier,
                    ..Default::default()
                });
            entry.samples += sample.weight;
            total_weight += sample.weight;
        }
    }

    let percent_per_sample = if total_weight > 0 {
        100.0 / total_weight as f64
    } else {
        0.0
    };
    let mut on_cpu_top: Vec<_> = on_cpu.into_values().collect();
    for entry in &mut on_cpu_top {
        entry.self_pct = entry.samples as f64 * percent_per_sample;
    }
    on_cpu_top.sort_by_key(|entry| std::cmp::Reverse(entry.samples));

    let mut off_cpu_top: Vec<_> = off_cpu.into_values().collect();
    off_cpu_top.sort_by(|a, b| b.blocked_ms.total_cmp(&a.blocked_ms));
    ProfilerSummary {
        on_cpu_top,
        off_cpu_top,
    }
}
