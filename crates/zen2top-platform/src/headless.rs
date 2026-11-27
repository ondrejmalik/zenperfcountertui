//! Full `schema_version: 1` headless capture pipeline (`--no-pmu` and mock PMU backends).

use crate::core::{baseline::*, config::*, csv_parser::*, diagnostics::*, metrics::*, packs::*, *};
use crate::{allocator::*, pmu::contention::*, pmu::*, symbols::*};
use anyhow::Context;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

macro_rules! dto {
    (plain $($n:ident { $($f:ident : $t:ty),+ $(,)? })+) => { $(#[derive(Debug, Clone, Default)] pub struct $n { $(pub $f: $t),+ })+ };
    ($($n:ident { $($(#[$m:meta])* $f:ident : $t:ty),+ $(,)? })+) => {
        $(#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)] #[serde(default)] pub struct $n { $($(#[$m])* pub $f: $t),+ })+
    };
}

macro_rules! fill {
    ($d:expr; $($f:ident : $e:expr),+ $(,)?) => { $({ $d.$f = $e; })+ };
    (cp $d:expr, $s:expr; $($f:ident),+ $(,)?) => { $({ $d.$f = $s.$f; })+ };
    (opt $d:expr, $s:expr; $($f:ident),+ $(,)?) => { $({ $d.$f = $s.$f.unwrap_or(0.0); })+ };
    (new $t:ident { $($x:tt)+ }) => { $t { $($x)+ } };
    (nz $s:expr, $d:expr) => { if $s.is_empty() { String::from($d) } else { String::from($s) } };
}

dto! {
    TargetSummary { pid: Option<u32>, name: Option<String>, exited_early: bool, affinity_mask: Option<u64>, allocator_detected: Option<String>, allocator_detection_method: Option<String>, rminject_eligibility: Option<RminjectEligibility>, has_lock_memory_privilege: bool }
    CaptureSummary { ipc: f64, actual_cpi: f64, retiring_pct: f64, retiring_exact: bool, inst_per_sec: f64, cyc_per_sec: f64, eff_ghz: f64, avg_c0_pct: f64, l3_hit_pct: f64, l3_lat_cyc: f64, l3_lat_ns: f64, cpi_stack: CpiStack, ccx_summary: Vec<CcxSummary>, smt_pairs: Vec<SmtPair>, raw_cumulative_counters: RawCumulativeCounters }
    VaMapBreakdown { private_rw_2m_mib: f64, private_rw_4k_mib: f64, jit_2m_mib: f64, jit_4k_mib: f64, mapped_2m_mib: f64, mapped_4k_mib: f64, image_2m_mib: f64, image_4k_mib: f64 }
    PresentEtwSummary { fps: f64, frametime_avg_ms: f64, frametime_p99_ms: f64, frametime_p999_ms: f64, flip_mode: String, spike_correlations: Vec<(u64, f64, String)> }
    Win32EtwSummary { gpu_3d_pct: Option<f64>, max_hot_core_dpc_irq_pct: f64, hard_page_faults_per_sec: f64, soft_page_faults_per_sec: f64, free_ram_pct: f64, disk_read_mb_s: f64, disk_write_mb_s: f64, ctx_sw_per_sec: f64, sync_wait_pct: f64, priority_class: String, ecoqos_active: Option<bool>, noisy_neighbors: Vec<(String, u32, f64)>, va_map: VaMapBreakdown, present_etw: PresentEtwSummary }
    ProfilerFunctionEntry { module: String, name: String, tier: SymbolTier, self_pct: f64, samples: u64 }
    OffCpuWaitEntry { module: String, name: String, blocked_ms: f64, wakes: u64, top_waker: Option<String> }
    ProfilerSummary { on_cpu_top: Vec<ProfilerFunctionEntry>, off_cpu_top: Vec<OffCpuWaitEntry> }
    RawProfilerSample { module: String, rva: u32, weight: u64, blocked_ms: Option<f64>, waker: Option<String> }
    CaptureMeta { schema_version: u32, zen2top_version: String, timestamp_utc: String, calibrated: bool, preset: String, enabled_packs: Vec<MetricPack>, core_pmc_slots: u8, mux_groups: u8, interval_sec: u64, elapsed_sec: f64, sample_count: u64, evidence_gate_passed: bool, evidence_gate_reason: String, no_pmu: bool, #[serde(skip_serializing_if = "Option::is_none")] pmc_contention: Option<PmcContentionReport> }
    HeadlessCaptureReport { meta: CaptureMeta, target: TargetSummary, summary: CaptureSummary, win32_etw: Win32EtwSummary, advisor: DiagnosticReport, #[serde(skip_serializing_if = "Option::is_none")] baseline_diff: Option<BaselineDiff>, #[serde(skip_serializing_if = "Option::is_none")] profiler: Option<ProfilerSummary> }
}

dto! { plain CaptureRequest { config: Zen2Config, preset: String, packs: Option<Vec<MetricPack>>, interval_sec: Option<u64>, duration_sec: u64, no_pmu: bool, target_pid: Option<u32>, target_name: Option<String>, target_missing_or_exited: bool, target_exited_early: bool, affinity_mask: Option<u64>, topology: CcxTopology, smt_pairs: Vec<(usize, usize)>, timestamp_utc: String, include_profiler: bool, baseline: Option<BaselineSnapshot>, contention: Option<PmcContentionReport>, win32_etw: Win32EtwSummary, win32_sample_count: u64, avg_c0_override_pct: Option<f64>, allocator_obs: Option<AllocatorObservation>, profiler_samples: Vec<RawProfilerSample> } }

type Win = (CaptureSummary, u64, f64, Vec<f64>, Vec<f64>);
type Col = fn(&PackPlan) -> anyhow::Result<Win>;
type CapRes = anyhow::Result<(HeadlessExitCode, HeadlessCaptureReport)>;

pub fn run_no_pmu_capture(req: &CaptureRequest) -> CapRes {
    run_inner(req, None::<Col>, None, None)
}

pub fn run_headless_capture<B: PmuBackend>(
    req: &CaptureRequest,
    c: Option<&mut PmuCoordinator<B>>,
    a: Option<&dyn AllocatorInspector>,
    s: Option<&dyn SymbolResolver>,
) -> CapRes {
    let f = c.map(|c| move |p: &PackPlan| collect_pmu(req, p, c));
    run_inner(req, f, a, s)
}

fn run_inner<F: FnOnce(&PackPlan) -> anyhow::Result<Win>>(
    req: &CaptureRequest,
    col: Option<F>,
    alloc: Option<&dyn AllocatorInspector>,
    syms: Option<&dyn SymbolResolver>,
) -> CapRes {
    use HeadlessExitCode::*;
    let iv = req.interval_sec.unwrap_or(1);
    anyhow::ensure!(matches!(iv, 1 | 2 | 5), "bad --interval {iv}");
    let ps = fill!(nz & req.preset, "balanced");
    let pk = match &req.packs {
        Some(p) => p.as_slice(),
        None => resolve_preset(&ps).context("unknown preset")?.packs(),
    };
    let plan = pack_core_pmcs(pk)?;
    let ao = req.allocator_obs.as_ref();
    let ai = alloc.unwrap_or(&Layer1AllocatorInspector);
    let ins = ao.map(|o| ai.inspect(o)).transpose()?;
    let mut tgt = TargetSummary::default();
    fill! { tgt; pid: req.target_pid, name: req.target_name.clone(), exited_early: req.target_exited_early || req.target_missing_or_exited, affinity_mask: req.affinity_mask, allocator_detected: ins.as_ref().map(|r| r.label.clone()), allocator_detection_method: ins.as_ref().map(|r| r.detection_method.clone()), rminject_eligibility: ins.as_ref().map(|r| r.rminject_eligibility.clone()), has_lock_memory_privilege: ao.is_some_and(|o| o.has_lock_memory_privilege) }
    let (mut code, mut win, mut abort, mut pmc) = (Ok, Win::default(), None, None);
    let cont = req.contention.as_ref();
    let cont = cont.filter(|x| !req.no_pmu && x.detected);
    if req.target_missing_or_exited {
        (code, abort) = (TargetUnavailable, Some("target_unavailable"));
    } else if let Some(c) = cont {
        let (c2, r) = EvictionPromptState::new(c.clone()).resolve_headless();
        (code, abort, pmc) = (c2, Some("pmc_contention"), Some(r));
    } else if req.no_pmu {
        let s = fill!(new CaptureSummary { avg_c0_pct: req.avg_c0_override_pct.unwrap_or(0.0), ..Default::default() });
        let n = req.win32_sample_count;
        let el = n as f64 * iv as f64;
        win = (s, n, el, vec![], vec![]);
    } else {
        win =
            col.context("Live PMU collection requires --no-pmu or a mock PmuCoordinator.")?(&plan)?;
    }
    let ds = TieredSymbolResolver::new();
    let sy = syms.unwrap_or(&ds);
    let pf = abort.is_none() && req.include_profiler;
    let profiler = pf.then(|| build_profiler(&req.profiler_samples, sy));
    let ((summary, sc, el, c0, lat), w) = (win, &req.win32_etw);
    let advisor = if let Some(m) = abort {
        fill!(new DiagnosticReport { evidence_gate_reason: m.into(), verdict_id: "insufficient_data".into(), verdict_label: "Insufficient Data".into(), ..Default::default() })
    } else {
        let rc = &summary.raw_cumulative_counters;
        let r = rc.derived_rates(&plan.effective_packs);
        let img = w.va_map.image_2m_mib + w.va_map.image_4k_mib;
        let mut d = DiagnosticInput::default();
        fill!(cp d, summary; avg_c0_pct, inst_per_sec, ipc, actual_cpi, retiring_pct, retiring_exact, eff_ghz, l3_hit_pct, l3_lat_ns, l3_lat_cyc);
        fill!(cp d, w; gpu_3d_pct, hard_page_faults_per_sec, soft_page_faults_per_sec, ctx_sw_per_sec, sync_wait_pct, ecoqos_active, disk_read_mb_s);
        fill!(opt d, r; dram_mpki, dem_dram_mpki, hwpf_dram_mpki, l2_pf_dram_mpki, l3_hit_mpki, l2_dc_excl_mpki, l2_ic_miss_mpki, l1_ic_miss_mpki, branch_miss_mpki, branch_miss_pct, l2_itlb_mpki, l2_dtlb_mpki, dc_cross_ccx_mpki, locks_serial_mpki, opcache_hit_pct, stlf_interlock_mpki, misal_access_mpki);
        fill! { d; config: req.config.clone(), enabled_packs: plan.effective_packs.clone(), no_pmu: req.no_pmu, mux_groups: plan.mux_groups, sample_count: sc, tier_cpi: TierCpiSummary::from(&summary.cpi_stack), core_c0_pct: c0, ccx_lat_ns: lat, modeled_cpi: summary.cpi_stack.modeled_cpi, ooo_hidden_cpi: summary.cpi_stack.hidden_ooo_mlp, avail_phys_pct: if w.free_ram_pct == 0.0 && w.priority_class.is_empty() { 50.0 } else { w.free_ram_pct }, priority_class: fill!(nz &w.priority_class, "Normal"), has_lock_memory_privilege: tgt.has_lock_memory_privilege, target_present: tgt.pid.is_some() || tgt.name.is_some(), target_name: tgt.name.clone(), target_ws_mib: req.allocator_obs.as_ref().map_or(0.0, |o| o.ws_mib), target_huge_mib: req.allocator_obs.as_ref().map_or(0.0, |o| o.private_rw_huge_2mib_mib), jit_exec_4k_mib: w.va_map.jit_4k_mib, image_large_2m_pct: if img > 0.0 { (w.va_map.image_2m_mib / img) * 100.0 } else { 0.0 }, frametime_spikes: w.present_etw.spike_correlations.len() as u64, noisy_neighbors: w.noisy_neighbors.clone(), baseline_mux_groups: req.baseline.as_ref().map(|b| b.mux_groups), baseline_ipc: req.baseline.as_ref().map(|b| b.counters.derived_rates(&b.enabled_packs).ipc), top_on_cpu_fn: profiler.as_ref().and_then(|p| p.on_cpu_top.first()).map(|f| format!("{} ({:.1}%)", f.name, f.self_pct)), top_off_cpu_wait: profiler.as_ref().and_then(|p| p.off_cpu_top.first()).map(|o| format!("{} ({:.1}ms)", o.name, o.blocked_ms)) }
        DiagnosticEngine::evaluate(&d)
    };
    let ts = fill!(nz & req.timestamp_utc, "1970-01-01T00:00:00Z");
    let baseline_diff = abort.is_none().then_some(req.baseline.as_ref()).flatten().map(|base| {
        let mut cur = BaselineSnapshot::default();
        fill! { cur; name: "current".into(), timestamp_utc: ts.clone(), elapsed_sec: el, sample_count: sc, target_name: tgt.name.clone(), affinity_mask: tgt.affinity_mask, enabled_packs: plan.effective_packs.clone(), core_pmc_slots: plan.core_slots, mux_groups: plan.mux_groups, counters: summary.raw_cumulative_counters.clone() }
        compare_baselines(base, &cur)
    });
    let (pass, g) = (advisor.evidence_gate_passed, &advisor.evidence_gate_reason);
    let reason: String = abort.unwrap_or(if pass { "passed" } else { g }).into();
    let mut meta = CaptureMeta::default();
    fill! { meta; schema_version: HEADLESS_SCHEMA_VERSION, zen2top_version: env!("CARGO_PKG_VERSION").into(), timestamp_utc: ts, calibrated: req.config.calibrated, preset: plan.preset_slug.clone().unwrap_or(ps), enabled_packs: plan.effective_packs.clone(), core_pmc_slots: plan.core_slots, mux_groups: plan.mux_groups, interval_sec: iv, elapsed_sec: el, sample_count: sc, evidence_gate_passed: pass, evidence_gate_reason: reason, no_pmu: req.no_pmu, pmc_contention: pmc }
    let rep = fill!(new HeadlessCaptureReport { meta, target: tgt, summary, win32_etw: w.clone(), advisor, baseline_diff, profiler });
    Result::Ok((code, rep))
}

fn collect_pmu<B: PmuBackend>(
    req: &CaptureRequest,
    plan: &PackPlan,
    c: &mut PmuCoordinator<B>,
) -> anyhow::Result<Win> {
    c.start()?;
    let (mut tot, mut lc, mut ll): (CoreCounters, ParsedCoreCsv, ParsedL3Csv) = Default::default();
    let (mut ac, mut ms, mut lt, mut mt) = (0.0, 0.0, 0.0, 0.0);
    let (mut c0, mut el, mut n) = (0.0, 0.0, 0u64);
    let mut opts = fill!(new CsvSampleOptions { affinity_mask: req.affinity_mask, base_mhz: req.config.base_mhz, interval_sec: 1.0, topology: req.topology.clone() });
    let mut run = || -> anyhow::Result<()> {
        for _ in 0..req.duration_sec.max(1).saturating_mul(16).max(64) {
            let Some(s) = c.poll_sample()? else { break };
            let dt = s.interval_sec.max(1) as f64;
            (n, el, opts.interval_sec) = (n + 1, el + dt, dt);
            if let Some(csv) = &s.raw_csv_core {
                lc = parse_report_core_csv(csv, &opts)?;
                tot.add_assign(&lc.total.counters);
                c0 += lc.total.c0_pct;
            }
            if let Some(csv) = &s.raw_csv_l3 {
                ll = parse_report_l3_csv(csv, lc.total.eff_ghz)?;
                let r = &ll.total;
                ac += r.l3_access;
                ms += r.l3_miss;
                lt += r.l3_lat;
                mt += r.l3_mtype;
            }
        }
        Ok(())
    };
    let res = run();
    let _ = c.stop();
    res?;
    let div = |a, b| if b > 0.0 { a / b } else { 0.0 };
    let bm = req.config.base_mhz;
    let eff_ghz = div(tot.aperf, tot.mperf) * (bm / 1000.0);
    let (l3_hit, l3_cyc) = (div((ac - ms).max(0.0), ac) * 100.0, div(lt * 16.0, mt));
    let l3_ns = div(l3_cyc, eff_ghz);
    let l3 = fill!(new CcxL3Row { l3_access: ac, l3_miss: ms, l3_lat: lt, l3_mtype: mt, l3_hit_pct: l3_hit, lat_cyc: l3_cyc, lat_ns: l3_ns, ..Default::default() });
    let (c, pk, dt) = (&req.config, &plan.effective_packs, el.max(1.0));
    let l3o = (mt > 0.0).then_some(&l3);
    let cm = compute_core_metrics(&tot, c, pk, l3o, dt);
    let mut raw = fill!(new RawCumulativeCounters { base_mhz: bm, ..Default::default() });
    macro_rules! cp { ($dst:expr, $src:expr; $($f:ident),+) => { $($dst.$f = { let v = $src.$f; if v.is_finite() && v > 0.0 { v.round() as u64 } else { 0 } };)+ }; }
    cp!(raw, tot; inst, aperf, mperf, cycles, ret_uops, dc_dem_l3, dc_dem_dram, dc_hwpf_l3, dc_hwpf_dram, l1_dc_miss, l2_dc_miss, l1_ic_miss, l2_ic_miss, l2_pf_l3, l2_pf_dram, branches, branch_miss, l1_itlb_hit, l1_itlb_miss_l2_hit, l2_itlb_miss, l1_dtlb_miss_l2_hit, l2_dtlb_miss, dc_cross_ccx, locks_serial, dec_uops, oc_uops, stlf_interlock, misal_access);
    cp!(raw, l3; l3_access, l3_miss, l3_lat, l3_mtype);
    const DEF_P: [(usize, usize); 6] = [(0, 1), (2, 3), (4, 5), (6, 7), (8, 9), (10, 11)];
    let sp = &req.smt_pairs;
    let ps = if sp.is_empty() { &DEF_P[..] } else { sp };
    let c0_avg = req.avg_c0_override_pct.unwrap_or_else(|| div(c0, n as f64));
    let mut s = CaptureSummary::default();
    fill! { s; ipc: cm.throughput.ipc, actual_cpi: cm.throughput.actual_cpi, retiring_pct: cm.retiring.pct, retiring_exact: cm.retiring.exact, inst_per_sec: cm.throughput.inst_per_sec, cyc_per_sec: cm.throughput.cyc_per_sec, eff_ghz: eff_ghz, avg_c0_pct: c0_avg, l3_hit_pct: l3_hit, l3_lat_cyc: l3_cyc, l3_lat_ns: l3_ns, cpi_stack: cm.cpi_stack, ccx_summary: summarize_ccx(&lc, &ll), smt_pairs: aggregate_smt_pairs(&lc.per_cpu, ps), raw_cumulative_counters: raw }
    let c0v = lc.per_cpu.iter().map(|r| r.c0_pct).collect();
    let latv = ll.per_ccx.iter().map(|r| r.lat_ns).collect();
    Ok((s, n, el, c0v, latv))
}

fn build_profiler(samples: &[RawProfilerSample], syms: &dyn SymbolResolver) -> ProfilerSummary {
    let (mut on, mut off, mut tot) = (BTreeMap::new(), BTreeMap::new(), 0u64);
    for s in samples {
        let r = syms.resolve(&s.module, s.rva);
        if let Some(ms) = s.blocked_ms {
            let k = off.entry(r.key);
            let e = k.or_insert((r.module, r.name, 0.0, 0, s.waker.clone()));
            (e.2, e.3) = (e.2 + ms, e.3 + 1);
        } else {
            tot += s.weight;
            let k = on.entry(r.key);
            k.or_insert((r.module, r.name, r.tier, 0)).3 += s.weight;
        }
    }
    let pct = if tot > 0 { 100.0 / tot as f64 } else { 0.0 };
    let mut on_cpu_top: Vec<_> = on.into_values().map(|(m, n, t, c)| fill!(new ProfilerFunctionEntry { module: m, name: n, tier: t, self_pct: c as f64 * pct, samples: c })).collect();
    on_cpu_top.sort_by_key(|a| std::cmp::Reverse(a.samples));
    let mut off_cpu_top: Vec<_> = off.into_values().map(|(m, n, b, w, tw)| fill!(new OffCpuWaitEntry { module: m, name: n, blocked_ms: b, wakes: w, top_waker: tw })).collect();
    off_cpu_top.sort_by(|a, b| b.blocked_ms.total_cmp(&a.blocked_ms));
    fill!(new ProfilerSummary { on_cpu_top, off_cpu_top })
}
