use zen2top_core::diagnostics::{
    estimate_amdahl_gain, ActionScope, Confidence, DiagnosticEngine, DiagnosticInput, EstGain,
    Finding, HealthyCheck, RuleSignals, Severity, StallKind, TierCpiSummary,
};
use zen2top_core::packs::PresetId;

fn active_base_input() -> DiagnosticInput {
    DiagnosticInput {
        enabled_packs: PresetId::Balanced.packs().to_vec(),
        no_pmu: false,
        mux_groups: 2,
        sample_count: 15,
        avg_c0_pct: 65.0,
        inst_per_sec: 4.0e9,
        ipc: 1.5,
        actual_cpi: 0.67,
        modeled_cpi: 0.60,
        retiring_pct: 32.0,
        ..DiagnosticInput::default()
    }
}

#[test]
fn evidence_gate_blocks_insufficient_samples_and_idle_load() {
    let mut low_samples = active_base_input();
    low_samples.sample_count = 9;
    let r1 = DiagnosticEngine::evaluate(&low_samples);
    assert!(!r1.ready);
    assert!(!r1.evidence_gate_passed);
    assert_eq!(r1.verdict_id, "insufficient_data");
    assert_eq!(r1.verdict_label, "Insufficient Data");
    assert!(r1.findings.is_empty());
    assert!(!r1.proof.is_empty());

    let mut idle = active_base_input();
    idle.avg_c0_pct = 4.0;
    idle.inst_per_sec = 0.5e9;
    let r2 = DiagnosticEngine::evaluate(&idle);
    assert!(!r2.ready);
    assert!(!r2.evidence_gate_passed);
    assert_eq!(r2.verdict_id, "insufficient_data");
    assert!(r2.findings.is_empty());
}

#[test]
fn estimate_amdahl_gain_clamps_at_zen2_cpi_floor_and_handles_zero_denominators() {
    let zero = estimate_amdahl_gain(0.0, 0.0, 0.5, 0.5, StallKind::Flush, "zero actual");
    match zero {
        EstGain::Numeric {
            low_pct,
            high_pct,
            vis_ratio,
            ..
        } => {
            assert_eq!(low_pct, 0.0);
            assert_eq!(high_pct, 0.0);
            assert_eq!(vis_ratio, 1.0);
        }
        other => panic!("expected Numeric, got {other:?}"),
    }

    // Extreme stall reduction must clamp new_cpi at >= 0.25 (max gain on 0.50 CPI is +100%).
    let clamped = estimate_amdahl_gain(0.50, 0.50, 2.0, 1.0, StallKind::Flush, "clamped");
    match clamped {
        EstGain::Numeric {
            low_pct, high_pct, ..
        } => {
            assert!((high_pct - 100.0).abs() < 1e-6);
            assert!(low_pct <= high_pct);
            assert!(low_pct.is_finite() && high_pct.is_finite());
        }
        other => panic!("expected Numeric, got {other:?}"),
    }

    let flush = estimate_amdahl_gain(1.20, 1.50, 0.40, 0.50, StallKind::Flush, "flush");
    let mlp = estimate_amdahl_gain(1.20, 1.50, 0.40, 0.50, StallKind::Mlp, "mlp");
    match (flush, mlp) {
        (
            EstGain::Numeric {
                low_pct: f_lo,
                high_pct: f_hi,
                ..
            },
            EstGain::Numeric {
                low_pct: m_lo,
                high_pct: m_hi,
                ..
            },
        ) => {
            assert!(f_lo > m_lo);
            assert!((f_hi - m_hi).abs() < 1e-6);
        }
        other => panic!("expected Numeric pair, got {other:?}"),
    }
}

#[test]
fn data_dependency_ilp_exclusion_verdict_emits_code_build_only_finding() {
    let mut input = active_base_input();
    input.ipc = 0.78;
    input.actual_cpi = 1.28;
    input.modeled_cpi = 0.45;
    input.retiring_pct = 15.5;
    input.tier_cpi = TierCpiSummary::default();

    let report = DiagnosticEngine::evaluate(&input);
    assert!(report.ready);
    assert!(report.evidence_gate_passed);
    assert_eq!(report.verdict_id, "data_dependency_ilp_bound");
    assert_eq!(report.verdict_label, "Data-Dependency / ILP-Bound");
    assert!(report.proof.contains("0.78"));
    assert!(report.proof.contains("15.5%"));
    assert_eq!(report.findings.len(), 1);

    let f = &report.findings[0];
    assert!(f.is_primary_anchor);
    assert_eq!(f.scope, ActionScope::CodeBuild);
    assert_eq!(f.scope.label(), "[Code / Build]");
    assert!(f.jump_tab >= 1 && f.jump_tab <= 7);
    assert!(
        !f.action.to_ascii_lowercase().contains("registry")
            && !f.action.to_ascii_lowercase().contains("power plan")
    );
}

#[test]
fn no_orphan_verdict_invariant_gpu_thresholds_and_rule_hook() {
    let mut mem = active_base_input();
    mem.tier_cpi.dram = 0.65;
    let mem_report = DiagnosticEngine::evaluate(&mem);
    assert_eq!(mem_report.verdict_id, "memory_latency_bound");
    assert_eq!(mem_report.verdict_label, "Memory Latency Bound");
    assert!(!mem_report.proof.is_empty());
    assert!(!mem_report.findings.is_empty());
    assert!(mem_report.findings[0].is_primary_anchor);
    assert!(mem_report.findings[0].jump_tab >= 1 && mem_report.findings[0].jump_tab <= 7);

    // GPU-Bound requires >=97% GPU 3D AND <75% hottest CPU C0, and also never emits an orphan verdict.
    let mut gpu = active_base_input();
    gpu.gpu_3d_pct = Some(98.0);
    gpu.core_c0_pct = vec![70.0, 20.0];
    let gpu_report = DiagnosticEngine::evaluate(&gpu);
    assert!(gpu_report.gpu_bound);
    assert_eq!(gpu_report.verdict_id, "gpu_bound");
    assert!(!gpu_report.findings.is_empty());

    gpu.core_c0_pct = vec![75.0, 20.0];
    let non_gpu = DiagnosticEngine::evaluate(&gpu);
    assert!(!non_gpu.gpu_bound);

    fn custom_rule(
        _input: &DiagnosticInput,
        findings: &mut Vec<Finding>,
        healthy: &mut Vec<HealthyCheck>,
        signals: &mut RuleSignals,
    ) {
        signals.preferred_verdict_id = Some("tlb_translation_bound".to_string());
        signals.preferred_proof = Some("Custom hook proof: L2 dTLB 4.2 MPKI".to_string());
        findings.push(Finding {
            rule_id: "pmu.dtlb_pressure".to_string(),
            category: "TLB".to_string(),
            is_primary_anchor: true,
            severity: Severity::Hi,
            scope: ActionScope::CodeOs,
            confidence: Confidence::High,
            impact: 88.0,
            title: "High L2 dTLB Walk Rate".to_string(),
            key_metric: "4.2 MPKI".to_string(),
            jump_tab: 3,
            ..Finding::default()
        });
        healthy.push(HealthyCheck {
            rule_id: "pmu.branch_ok".to_string(),
            label: "Branch Prediction".to_string(),
            observed_summary: "0.8 MPKI".to_string(),
        });
    }

    let hooked = DiagnosticEngine::evaluate_with_rules(&active_base_input(), &[custom_rule]);
    assert_eq!(hooked.verdict_id, "tlb_translation_bound");
    assert_eq!(hooked.verdict_label, "TLB Translation Bound");
    assert_eq!(hooked.proof, "Custom hook proof: L2 dTLB 4.2 MPKI");
    assert_eq!(hooked.findings.len(), 1);
    assert_eq!(hooked.findings[0].rule_id, "pmu.dtlb_pressure");
    assert_eq!(hooked.verified_healthy.len(), 1);
}
