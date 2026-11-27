use serde::{Deserialize, Serialize};

use crate::config::Zen2Config;
use crate::packs::MetricPack;

pub mod win32_rules;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Default)]
pub enum Severity {
    Hi,
    Md,
    Lo,
    #[default]
    Info,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum ActionScope {
    #[default]
    OsTui,
    HwBios,
    CodeBuild,
    CodeOs,
    OsHw,
    HwCode,
}

impl ActionScope {
    pub const fn label(self) -> &'static str {
        match self {
            Self::OsTui => "[OS / TUI]",
            Self::HwBios => "[HW / BIOS]",
            Self::CodeBuild => "[Code / Build]",
            Self::CodeOs => "[Code / OS]",
            Self::OsHw => "[OS / HW]",
            Self::HwCode => "[HW / Code]",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum Confidence {
    High,
    #[default]
    Med,
    Low,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum StallKind {
    Flush,
    #[default]
    Mlp,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum EstGain {
    Numeric {
        low_pct: f64,
        high_pct: f64,
        vis_ratio: f64,
        detail: String,
    },
    Clock {
        pct: f64,
        detail: String,
    },
    Qualitative {
        label: String,
        detail: String,
    },
}

impl Default for EstGain {
    fn default() -> Self {
        Self::Qualitative {
            label: "--".to_string(),
            detail: String::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Finding {
    pub rule_id: String,
    pub category: String,
    pub is_primary_anchor: bool,
    pub severity: Severity,
    pub scope: ActionScope,
    pub confidence: Confidence,
    pub impact: f64,
    pub title: String,
    pub key_metric: String,
    pub est_gain: EstGain,
    pub why: String,
    pub action: String,
    pub cascade: String,
    pub jump_tab: u8,
    pub observed_metrics: Vec<(String, String)>,
    pub profiler_note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct HealthyCheck {
    pub rule_id: String,
    pub label: String,
    pub observed_summary: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct TierCpiSummary {
    pub dram: f64,
    pub l3_hit: f64,
    pub l2_dc: f64,
    pub l2_ic: f64,
    pub branch: f64,
    pub l2_dtlb: f64,
    pub l2_itlb: f64,
}

/// Complete rolling-window snapshot consumed by `DiagnosticEngine`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct DiagnosticInput {
    pub config: Zen2Config,
    pub enabled_packs: Vec<MetricPack>,
    pub no_pmu: bool,
    pub mux_groups: u8,
    pub sample_count: u64,
    pub avg_c0_pct: f64,
    pub inst_per_sec: f64,
    pub ipc: f64,
    pub actual_cpi: f64,
    pub modeled_cpi: f64,
    pub ooo_hidden_cpi: f64,
    pub retiring_pct: f64,
    pub retiring_exact: bool,
    pub eff_ghz: f64,
    pub tier_cpi: TierCpiSummary,
    pub dram_mpki: f64,
    pub dem_dram_mpki: f64,
    pub hwpf_dram_mpki: f64,
    pub l2_pf_dram_mpki: f64,
    pub l3_hit_mpki: f64,
    pub l3_miss_mpki: f64,
    pub l3_hit_pct: f64,
    pub l3_lat_ns: f64,
    pub l3_lat_cyc: f64,
    pub l2_ic_miss_mpki: f64,
    pub l2_ic_excl_mpki: f64,
    pub l1_ic_miss_mpki: f64,
    pub l2_dc_excl_mpki: f64,
    pub branch_miss_mpki: f64,
    pub branch_miss_pct: f64,
    pub l2_itlb_mpki: f64,
    pub l1_itlb_miss_pct: f64,
    pub l2_dtlb_mpki: f64,
    pub dc_cross_ccx_mpki: f64,
    pub locks_serial_mpki: f64,
    pub opcache_hit_pct: f64,
    pub legacy_decode_pct: f64,
    pub stlf_interlock_mpki: f64,
    pub misal_access_mpki: f64,
    pub ret_uops_per_inst: f64,
    pub dis_mops_per_inst: f64,
    pub core_c0_pct: Vec<f64>,
    pub core_dpc_pct: Vec<f64>,
    pub core_irq_pct: Vec<f64>,
    pub ccx_lat_ns: Vec<f64>,
    pub gpu_3d_pct: Option<f64>,
    pub hard_page_faults_per_sec: f64,
    pub soft_page_faults_per_sec: f64,
    pub cpu_usr_pct: f64,
    pub cpu_sys_pct: f64,
    pub avail_phys_pct: f64,
    pub commit_pct: f64,
    pub ctx_sw_per_sec: f64,
    pub sync_wait_pct: f64,
    pub top_wait_reason: String,
    pub priority_class: String,
    pub ecoqos_active: Option<bool>,
    pub has_lock_memory_privilege: bool,
    pub target_present: bool,
    pub target_name: Option<String>,
    pub target_ws_mib: f64,
    pub target_huge_mib: f64,
    pub requested_huge_mib: f64,
    pub ifeo_enabled: bool,
    pub silent_ifeo_fail_dlls: Vec<String>,
    pub cand_4k_dlls: Vec<String>,
    pub mimalloc_os_arenas: usize,
    pub mimalloc_huge_free_pct: Option<f64>,
    pub composed_flip_pct: Option<f64>,
    pub jit_exec_4k_mib: f64,
    pub image_large_2m_pct: f64,
    pub disk_read_mb_s: f64,
    pub disk_read_iops: f64,
    pub frametime_spikes: u64,
    pub noisy_neighbors: Vec<(String, u32, f64)>,
    pub baseline_mux_groups: Option<u8>,
    pub baseline_ipc: Option<f64>,
    pub top_on_cpu_fn: Option<String>,
    pub top_off_cpu_wait: Option<String>,
}

impl DiagnosticInput {
    pub fn has_pack(&self, pack: MetricPack) -> bool {
        !self.no_pmu && self.enabled_packs.contains(&pack)
    }
    pub fn hottest_cpu_c0(&self) -> f64 {
        self.core_c0_pct
            .iter()
            .copied()
            .fold(None::<f64>, |a, v| Some(a.map_or(v, |m| m.max(v))))
            .unwrap_or(self.avg_c0_pct)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct DiagnosticReport {
    pub ready: bool,
    pub evidence_gate_passed: bool,
    pub evidence_gate_reason: String,
    pub verdict_id: String,
    pub verdict_label: String,
    pub proof: String,
    pub winning_stall_line: String,
    pub gpu_bound: bool,
    pub findings: Vec<Finding>,
    pub verified_healthy: Vec<HealthyCheck>,
    pub inactive_rules: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct RuleSignals {
    pub gpu_bound: bool,
    pub preferred_verdict_id: Option<String>,
    pub preferred_verdict_label: Option<String>,
    pub preferred_winning_stall: Option<String>,
    pub preferred_proof: Option<String>,
}

pub type RuleEvaluator =
    fn(&DiagnosticInput, &mut Vec<Finding>, &mut Vec<HealthyCheck>, &mut RuleSignals);

/// Estimate Amdahl IPC gain from reducing a single stall tier, clamped at Zen 2's 0.25 CPI floor.
pub fn estimate_amdahl_gain(
    actual_cpi: f64,
    modeled_cpi: f64,
    tier_cpi: f64,
    reduction_frac: f64,
    kind: StallKind,
    assumption: &str,
) -> EstGain {
    if actual_cpi <= 0.001 || tier_cpi <= 0.0001 || reduction_frac <= 0.0 {
        return EstGain::Numeric {
            low_pct: 0.0,
            high_pct: 0.0,
            vis_ratio: 1.0,
            detail: format!("<0.5% IPC ({assumption}; negligible stall tier)"),
        };
    }
    let vis_ratio = (actual_cpi / modeled_cpi.max(0.001)).clamp(0.25, 1.0);
    let delta_raw = tier_cpi * reduction_frac;
    let delta_low = match kind {
        StallKind::Flush => delta_raw * vis_ratio.min(0.90),
        StallKind::Mlp => delta_raw * (vis_ratio * 0.80).min(0.75),
    };
    let new_cpi_low = (actual_cpi - delta_low).max(0.25);
    let new_cpi_high = (actual_cpi - delta_raw).max(0.25);
    let low_pct = ((actual_cpi / new_cpi_low) - 1.0).max(0.0) * 100.0;
    let high_pct = (((actual_cpi / new_cpi_high) - 1.0).max(0.0) * 100.0).max(low_pct);
    let vis_pct = (vis_ratio * 100.0).round() as u32;
    let detail = if high_pct < 0.5 {
        format!("<0.5% IPC ({assumption} on {actual_cpi:.2} CPI; {vis_pct}% visible overlap)")
    } else {
        format!("+{low_pct:.1}% to +{high_pct:.1}% IPC ({assumption} on {actual_cpi:.2} CPI; {vis_pct}% visible overlap)")
    };
    EstGain::Numeric {
        low_pct,
        high_pct,
        vis_ratio,
        detail,
    }
}

pub struct DiagnosticEngine;

impl DiagnosticEngine {
    pub fn evaluate(input: &DiagnosticInput) -> DiagnosticReport {
        Self::evaluate_with_rules(input, &[win32_rules::evaluate_win32_rules])
    }

    pub fn evaluate_with_rules(
        input: &DiagnosticInput,
        rules: &[RuleEvaluator],
    ) -> DiagnosticReport {
        let inactive_rules = compute_inactive_rules(input);
        let min_samples = input.config.advisor.min_samples;
        if input.sample_count < min_samples {
            let reason = format!(
                "Collecting baseline evidence ({}/{min_samples} samples)...",
                input.sample_count
            );
            return DiagnosticReport {
                evidence_gate_reason: reason.clone(),
                verdict_id: "insufficient_data".into(),
                verdict_label: "Insufficient Data".into(),
                proof: format!(
                    "Waiting for {min_samples} samples ({}/{min_samples}).",
                    input.sample_count
                ),
                winning_stall_line: reason,
                inactive_rules,
                ..DiagnosticReport::default()
            };
        }
        let (min_c0, min_inst) = (
            input.config.advisor.min_avg_c0_pct,
            input.config.advisor.min_inst_per_sec,
        );
        if input.avg_c0_pct < min_c0 && (input.no_pmu || input.inst_per_sec < min_inst) {
            let note = if input.no_pmu {
                String::new()
            } else {
                format!(
                    ", Inst {:.2} B/s < {:.2} B/s",
                    input.inst_per_sec / 1e9,
                    min_inst / 1e9
                )
            };
            let reason = format!(
                "Low workload activity (avg C0 {:.1}% < {min_c0:.1}%{note}).",
                input.avg_c0_pct
            );
            return DiagnosticReport {
                evidence_gate_reason: reason.clone(),
                verdict_id: "insufficient_data".into(),
                verdict_label: "Insufficient Data".into(),
                proof: reason,
                winning_stall_line: "Workload mostly idle".into(),
                inactive_rules,
                ..DiagnosticReport::default()
            };
        }

        let (mut findings, mut verified_healthy, mut signals) =
            (Vec::new(), Vec::new(), RuleSignals::default());
        for rule in rules {
            rule(input, &mut findings, &mut verified_healthy, &mut signals);
        }
        let gpu_bound = signals.gpu_bound
            || input
                .gpu_3d_pct
                .is_some_and(|g| g >= 97.0 && input.hottest_cpu_c0() < 75.0);
        let (verdict_id, verdict_label, winning_stall_line, mut proof) =
            resolve_verdict(input, &findings, &signals, gpu_bound);
        if proof.trim().is_empty() {
            proof = format!(
                "IPC {:.2} | Actual CPI {:.2} | Avg C0 {:.1}%",
                input.ipc, input.actual_cpi, input.avg_c0_pct
            );
        }
        if !matches!(
            verdict_id.as_str(),
            "win32_only_clear" | "insufficient_data"
        ) && !findings
            .iter()
            .any(|f| matches!(f.severity, Severity::Hi | Severity::Md))
        {
            findings.push(build_primary_anchor(
                input,
                &verdict_id,
                &verdict_label,
                &proof,
            ));
        }
        findings.sort_by(|a, b| {
            b.is_primary_anchor
                .cmp(&a.is_primary_anchor)
                .then_with(|| a.severity.cmp(&b.severity))
                .then_with(|| b.impact.total_cmp(&a.impact))
        });
        attach_profiler_notes(input, &mut findings);
        DiagnosticReport {
            ready: true,
            evidence_gate_passed: true,
            evidence_gate_reason: String::new(),
            verdict_id,
            verdict_label,
            proof,
            winning_stall_line,
            gpu_bound,
            findings,
            verified_healthy,
            inactive_rules,
        }
    }
}

fn compute_inactive_rules(input: &DiagnosticInput) -> Vec<String> {
    if input.no_pmu {
        return vec!["Hardware PMCs (No-PMU: Win32 OS rules active)".into()];
    }
    let mut out = Vec::new();
    if !input.has_pack(MetricPack::DcDemand) {
        out.push("DRAM/L3".into());
    } else if !input.has_pack(MetricPack::DcHwpf) {
        out.push("Dem/HWPF".into());
    }
    for (p, name) in [
        (MetricPack::L1L2Dc, "L1/L2 DC"),
        (MetricPack::Branches, "Branches"),
        (MetricPack::L1L2Ic, "I-Cache"),
        (MetricPack::ItlbFull, "iTLB"),
        (MetricPack::DtlbFull, "dTLB"),
        (MetricPack::CrossCcxLocks, "CCX/Locks"),
        (MetricPack::OpCacheDecode, "Op-Cache"),
        (MetricPack::StlfSplits, "STLF/Splits"),
    ] {
        if !input.has_pack(p) {
            out.push(name.into());
        }
    }
    out
}

fn verdict_meta(verdict_id: &str) -> (&'static str, ActionScope, &'static str, u8, &'static str) {
    match verdict_id {
        "gpu_bound" => ("GPU-Bound (CPU Headroom Available)", ActionScope::OsTui, "GPU Saturation", 1, "Lower render resolution/upscaling or shader quality; CPU tuning will not lift average FPS while GPU 3D >= 97%."),
        "memory_latency_bound" => ("Memory Latency Bound", ActionScope::HwCode, "Memory Latency", 2, "Improve spatial locality, pack hot structs to 64B lines, or tighten DDR4 timings/FCLK."),
        "memory_bandwidth_queueing" => ("Memory Bandwidth / Queueing", ActionScope::HwBios, "Memory Bandwidth", 2, "Tighten DDR4 timings/FCLK or shrink streaming footprints to relieve memory controller queueing."),
        "l3_capacity_or_cross_ccx" => ("L3 Capacity / Cross-CCX", ActionScope::CodeOs, "L3 / Cross-CCX", 2, "Pin communicating threads to a single Zen 2 CCX or shrink hot working sets toward 512 KiB L2."),
        "micro_arch_contention" => ("Micro-Arch / Contention Bound", ActionScope::CodeBuild, "Micro-Arch", 1, "Reduce false sharing, serialized locks, STLF mismatches, or 64B cache-line splits."),
        "frontend_code_bound" => ("Frontend Code Bound", ActionScope::CodeBuild, "Frontend Code", 2, "Apply PGO/llvm-bolt hot-cold splitting to fit hot loops inside 32 KiB L1i and 4K Op-Cache."),
        "branch_mispredict_bound" => ("Branch Mispredict Bound", ActionScope::CodeBuild, "Branch Prediction", 1, "Replace unpredictable branches with branchless CMOV/SIMD or apply PGO."),
        "tlb_translation_bound" => ("TLB Translation Bound", ActionScope::CodeOs, "TLB Translation", 3, "Back hot PE DLLs and heap arenas with 2 MiB large pages (Tab 3 / Tab 4)."),
        "smt_contention_bound" => ("SMT Contention Bound", ActionScope::OsTui, "SMT Contention", 6, "Clear hot thread affinity off occupied SMT sibling pairs onto idle physical cores."),
        "data_dependency_ilp_bound" => ("Data-Dependency / ILP-Bound", ActionScope::CodeBuild, "Core Execution / ILP", 7, "Break serial dependency chains: unroll accumulators, use contiguous arrays, enable PGO/LTO/AVX2. OS tweaks will not fix serial dependency latency."),
        "core_execution_bound" => ("Core Execution Bound", ActionScope::CodeBuild, "Core Execution", 7, "Inspect hot loops in Tab 7 for AVX2 vectorization, instruction mix, and PGO opportunities."),
        "win32_only_clear" => ("Win32 OS Diagnostics Clear (No-PMU)", ActionScope::OsTui, "Win32 OS", 5, "No Win32 OS bottleneck detected."),
        _ => ("Insufficient Data", ActionScope::OsTui, "Evidence Gate", 5, "Wait for >= 10 active samples."),
    }
}

fn resolve_verdict(
    input: &DiagnosticInput,
    findings: &[Finding],
    signals: &RuleSignals,
    gpu_bound: bool,
) -> (String, String, String, String) {
    if let Some(id) = &signals.preferred_verdict_id {
        let label = signals
            .preferred_verdict_label
            .clone()
            .unwrap_or_else(|| verdict_meta(id).0.into());
        let stall = signals
            .preferred_winning_stall
            .clone()
            .unwrap_or_else(|| label.clone());
        let proof = signals.preferred_proof.clone().unwrap_or_else(|| {
            format!(
                "IPC {:.2} | Actual CPI {:.2} | Avg C0 {:.1}%",
                input.ipc, input.actual_cpi, input.avg_c0_pct
            )
        });
        return (id.clone(), label, stall, proof);
    }
    if gpu_bound {
        let (gpu, hot) = (input.gpu_3d_pct.unwrap_or(97.0), input.hottest_cpu_c0());
        return (
            "gpu_bound".into(),
            verdict_meta("gpu_bound").0.into(),
            format!("GPU 3D {gpu:.1}% | Hottest CPU {hot:.0}% C0"),
            format!(
                "GPU 3D {gpu:.1}% (>=97%) with hottest CPU {hot:.0}% C0 (<75%) | IPC {:.2}",
                input.ipc
            ),
        );
    }
    if input.no_pmu {
        return (
            "win32_only_clear".into(),
            verdict_meta("win32_only_clear").0.into(),
            "No Win32 OS bottleneck detected".into(),
            format!(
                "Win32 OS diagnostics active (No-PMU) | Avg C0 {:.1}% | Sys {:.1}%",
                input.avg_c0_pct, input.cpu_sys_pct
            ),
        );
    }
    let t = &input.tier_cpi;
    let dominant = [
        ("memory_latency_bound", t.dram, 0.35, "DRAM latency stalls"),
        (
            "l3_capacity_or_cross_ccx",
            t.l3_hit,
            0.25,
            "L3 capacity / cross-CCX stalls",
        ),
        (
            "tlb_translation_bound",
            t.l2_dtlb + t.l2_itlb,
            0.20,
            "L2 TLB page-walk stalls",
        ),
        (
            "branch_mispredict_bound",
            t.branch,
            0.20,
            "Branch misprediction flushes",
        ),
        (
            "frontend_code_bound",
            t.l2_ic,
            0.20,
            "Frontend I-Cache fetch stalls",
        ),
    ]
    .into_iter()
    .filter(|(_, val, thresh, _)| *val >= *thresh)
    .max_by(|a, b| a.1.total_cmp(&b.1));
    if let Some((id, cpi, _, desc)) = dominant {
        return (
            id.into(),
            verdict_meta(id).0.into(),
            format!("{desc} ({cpi:.2} CPI)"),
            format!(
                "{desc}: {cpi:.2} modeled CPI | Actual CPI {:.2} | IPC {:.2}",
                input.actual_cpi, input.ipc
            ),
        );
    }
    if input.ipc < 1.1
        && input.retiring_pct < 22.0
        && findings.is_empty()
        && input.modeled_cpi < 0.85
    {
        let rp = if input.retiring_exact { "" } else { "~" };
        return ("data_dependency_ilp_bound".into(), verdict_meta("data_dependency_ilp_bound").0.into(), format!("Low IPC ({:.2}) & Retiring ({rp}{:.1}%) with no dominant stall", input.ipc, input.retiring_pct), format!("IPC {:.2} (< 1.10) and Retiring {rp}{:.1}% (< 22.0%) with low modeled stall CPI ({:.2}) prove serial ILP/execution-port ceiling.", input.ipc, input.retiring_pct, input.modeled_cpi));
    }
    (
        "core_execution_bound".into(),
        verdict_meta("core_execution_bound").0.into(),
        format!("Core execution throughput (IPC {:.2})", input.ipc),
        format!(
            "IPC {:.2} | Actual CPI {:.2} | Retiring {:.1}% | Avg C0 {:.1}%",
            input.ipc, input.actual_cpi, input.retiring_pct, input.avg_c0_pct
        ),
    )
}

fn build_primary_anchor(
    input: &DiagnosticInput,
    verdict_id: &str,
    verdict_label: &str,
    proof: &str,
) -> Finding {
    let (_, scope, category, jump_tab, action) = verdict_meta(verdict_id);
    let is_ilp = verdict_id == "data_dependency_ilp_bound";
    Finding {
        rule_id: if is_ilp { "exclusion.data_dependency_ilp".into() } else { format!("anchor.{verdict_id}") },
        category: category.into(),
        is_primary_anchor: true,
        severity: Severity::Md,
        scope,
        confidence: Confidence::Med,
        impact: if is_ilp { (1.1 - input.ipc).max(0.1) * 100.0 } else { input.actual_cpi.max(0.1) * 25.0 },
        title: if is_ilp { "Serial Data-Dependency Chains Limiting ILP".into() } else { format!("Primary Bottleneck: {verdict_label}") },
        key_metric: if is_ilp { format!("IPC {:.2} | Ret {:.1}%", input.ipc, input.retiring_pct) } else { format!("IPC {:.2} | CPI {:.2}", input.ipc, input.actual_cpi) },
        est_gain: EstGain::Qualitative { label: if is_ilp { "Code ILP" } else { "Regime" }.into(), detail: proof.into() },
        why: proof.into(),
        action: action.into(),
        cascade: if is_ilp { "OS tweaks do not reduce serial dependency latency; focus on compiler PGO/LTO and dataflow." } else { "Enable additional PMU packs or inspect Tab 7 stack samples for deeper root-cause attribution." }.into(),
        jump_tab,
        observed_metrics: vec![("IPC".into(), format!("{:.2}", input.ipc)), ("Actual CPI".into(), format!("{:.2}", input.actual_cpi))],
        profiler_note: input.top_on_cpu_fn.clone(),
    }
}

fn attach_profiler_notes(input: &DiagnosticInput, findings: &mut [Finding]) {
    let on_cpu = input
        .top_on_cpu_fn
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let off_cpu = input
        .top_off_cpu_wait
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if on_cpu.is_none() && off_cpu.is_none() {
        return;
    }
    for f in findings {
        if f.profiler_note.is_some() {
            continue;
        }
        let note = match f.rule_id.as_str() {
            "win32.ctx_sw_lock_storm" | "win32.hard_page_faults" => off_cpu,
            "win32.disk_io_stall" | "win32.frametime_spike_correlator" => off_cpu.or(on_cpu),
            id if id == "win32.jit_4k_itlb_residual"
                || id.starts_with("pmu.")
                || id.starts_with("anchor.")
                || id.starts_with("exclusion.") =>
            {
                on_cpu
            }
            _ => None,
        };
        if let Some(text) = note {
            f.profiler_note = Some(text.to_string());
        }
    }
}
