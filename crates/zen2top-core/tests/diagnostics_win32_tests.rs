use zen2top_core::diagnostics::{DiagnosticEngine, DiagnosticInput, EstGain, Severity};
use zen2top_core::packs::{MetricPack, PresetId};

fn base_win32_input() -> DiagnosticInput {
    DiagnosticInput {
        enabled_packs: PresetId::Balanced.packs().to_vec(),
        no_pmu: true,
        sample_count: 12,
        avg_c0_pct: 55.0,
        inst_per_sec: 3.0e9,
        ipc: 1.4,
        actual_cpi: 0.71,
        modeled_cpi: 0.50,
        retiring_pct: 28.0,
        ..DiagnosticInput::default()
    }
}

fn assert_all_win32_gains_qualitative(input: &DiagnosticInput) {
    let report = DiagnosticEngine::evaluate(input);
    for f in report
        .findings
        .iter()
        .filter(|f| f.rule_id.starts_with("win32."))
    {
        match &f.est_gain {
            EstGain::Qualitative { label, detail } => {
                assert!(
                    !label.is_empty(),
                    "empty qualitative label on {}",
                    f.rule_id
                );
                assert!(
                    !detail.is_empty(),
                    "empty qualitative detail on {}",
                    f.rule_id
                );
                assert!(
                    !label.contains("IPC"),
                    "unexpected IPC gain on {}",
                    f.rule_id
                );
            }
            other => panic!(
                "expected Qualitative est_gain on {}, got {other:?}",
                f.rule_id
            ),
        }
    }
}

#[test]
fn gpu_bound_fires_only_when_gpu_saturated_and_cpu_below_75() {
    let mut gpu_bound = base_win32_input();
    gpu_bound.gpu_3d_pct = Some(97.0);
    gpu_bound.core_c0_pct = vec![74.9, 30.0, 20.0];
    let r = DiagnosticEngine::evaluate(&gpu_bound);
    assert!(r.gpu_bound);
    assert_eq!(r.verdict_id, "gpu_bound");
    assert!(r.findings.iter().any(|f| f.rule_id == "win32.gpu_bound"));
    assert_all_win32_gains_qualitative(&gpu_bound);

    let mut cpu_hot = base_win32_input();
    cpu_hot.gpu_3d_pct = Some(99.0);
    cpu_hot.core_c0_pct = vec![75.0, 40.0];
    let r_hot = DiagnosticEngine::evaluate(&cpu_hot);
    assert!(!r_hot.gpu_bound);
    assert_ne!(r_hot.verdict_id, "gpu_bound");
    assert!(!r_hot
        .findings
        .iter()
        .any(|f| f.rule_id == "win32.gpu_bound"));
    assert!(r_hot
        .verified_healthy
        .iter()
        .any(|h| h.rule_id == "win32.gpu_bound" && h.label == "GPU/CPU Balanced"));
}

#[test]
fn dpc_irq_collision_requires_same_hot_core_intersection() {
    // Disjoint cores: CPU0 is hot (80% C0, 1% DPC), CPU1 has high DPC (20% C0, 12% DPC).
    let mut disjoint = base_win32_input();
    disjoint.core_c0_pct = vec![80.0, 20.0];
    disjoint.core_dpc_pct = vec![1.0, 10.0];
    disjoint.core_irq_pct = vec![0.0, 2.0];
    let r_disjoint = DiagnosticEngine::evaluate(&disjoint);
    assert!(!r_disjoint
        .findings
        .iter()
        .any(|f| f.rule_id == "win32.dpc_irq_collision"));
    assert!(r_disjoint
        .verified_healthy
        .iter()
        .any(|h| h.rule_id == "win32.dpc_irq_collision" && h.observed_summary.contains("1.0%")));

    // Intersection on CPU1: C0 >= 60% AND DPC+IRQ >= 5%.
    let mut same_core = base_win32_input();
    same_core.core_c0_pct = vec![40.0, 60.0];
    same_core.core_dpc_pct = vec![10.0, 3.5];
    same_core.core_irq_pct = vec![2.0, 1.5];
    let r_hit = DiagnosticEngine::evaluate(&same_core);
    let f = r_hit
        .findings
        .iter()
        .find(|f| f.rule_id == "win32.dpc_irq_collision")
        .expect("same-core DPC/IRQ collision should fire");
    assert_eq!(f.severity, Severity::Md);
    assert!(f.title.contains("CPU1"));
    assert_all_win32_gains_qualitative(&same_core);
}

#[test]
fn all_remaining_win32_etw_rules_trigger_and_use_qualitative_gains() {
    let mut input = base_win32_input();
    input.no_pmu = false;
    input.enabled_packs = vec![MetricPack::ItlbFull];
    input.noisy_neighbors = vec![
        ("System Idle Process".into(), 0, 80.0),
        ("indexer.exe".into(), 4242, 4.5), // 4.5% * 12 = 54% of 1 core
    ];
    input.priority_class = "BELOW_NORMAL".into();
    input.ecoqos_active = Some(true);
    input.avail_phys_pct = 4.2;
    input.commit_pct = 91.0;
    input.hard_page_faults_per_sec = 25.0;
    input.target_huge_mib = 512.0;
    input.ctx_sw_per_sec = 62_000.0;
    input.sync_wait_pct = 48.0;
    input.top_wait_reason = "WrPushLock".into();
    input.composed_flip_pct = Some(88.0);
    input.l2_itlb_mpki = 0.55;
    input.image_large_2m_pct = 82.0;
    input.jit_exec_4k_mib = 14.0;
    input.disk_read_mb_s = 95.0;
    input.disk_read_iops = 1400.0;
    input.frametime_spikes = 12;

    let report = DiagnosticEngine::evaluate(&input);
    for expected_id in [
        "win32.noisy_neighbor",
        "win32.priority_ecoqos",
        "win32.hard_page_faults",
        "win32.ctx_sw_lock_storm",
        "win32.composed_flip",
        "win32.jit_4k_itlb_residual",
        "win32.disk_io_stall",
        "win32.frametime_spike_correlator",
    ] {
        assert!(
            report.findings.iter().any(|f| f.rule_id == expected_id),
            "missing expected finding {expected_id}"
        );
    }
    let spike = report
        .findings
        .iter()
        .find(|f| f.rule_id == "win32.frametime_spike_correlator")
        .unwrap();
    assert!(spike.why.contains("hard page faults"));
    assert!(spike.why.contains("disk read I/O"));
    assert!(spike.why.contains("scheduler/lock contention"));
    assert!(spike.why.contains("DWM composed flip"));

    let pf = report
        .findings
        .iter()
        .find(|f| f.rule_id == "win32.hard_page_faults")
        .unwrap();
    assert!(pf.action.contains("locked huge pages"));
    assert_all_win32_gains_qualitative(&input);
}

#[test]
fn tab7_profiler_note_enriches_matching_findings_and_verified_healthy_populates() {
    let mut triggered = base_win32_input();
    triggered.no_pmu = false;
    triggered.enabled_packs = vec![MetricPack::ItlbFull];
    triggered.gpu_3d_pct = Some(98.0);
    triggered.core_c0_pct = vec![50.0, 40.0];
    triggered.ctx_sw_per_sec = 75_000.0;
    triggered.sync_wait_pct = 55.0;
    triggered.l2_itlb_mpki = 0.60;
    triggered.image_large_2m_pct = 85.0;
    triggered.jit_exec_4k_mib = 16.0;
    triggered.frametime_spikes = 7;
    triggered.top_on_cpu_fn = Some("jit_runtime.dll!compile_hot_trace (31.4% self)".into());
    triggered.top_off_cpu_wait =
        Some("RtlEnterCriticalSection (52% blocked, woken by Worker)".into());

    let r = DiagnosticEngine::evaluate(&triggered);
    let lock = r
        .findings
        .iter()
        .find(|f| f.rule_id == "win32.ctx_sw_lock_storm")
        .unwrap();
    assert_eq!(
        lock.profiler_note.as_deref(),
        Some("RtlEnterCriticalSection (52% blocked, woken by Worker)")
    );
    let jit = r
        .findings
        .iter()
        .find(|f| f.rule_id == "win32.jit_4k_itlb_residual")
        .unwrap();
    assert_eq!(
        jit.profiler_note.as_deref(),
        Some("jit_runtime.dll!compile_hot_trace (31.4% self)")
    );
    let spike = r
        .findings
        .iter()
        .find(|f| f.rule_id == "win32.frametime_spike_correlator")
        .unwrap();
    assert_eq!(
        spike.profiler_note.as_deref(),
        Some("RtlEnterCriticalSection (52% blocked, woken by Worker)")
    );
    let gpu = r
        .findings
        .iter()
        .find(|f| f.rule_id == "win32.gpu_bound")
        .unwrap();
    assert!(gpu.profiler_note.is_none());

    // Healthy Win32 snapshot populates Verified Healthy strip with observed summaries.
    let mut healthy_input = base_win32_input();
    healthy_input.gpu_3d_pct = Some(52.0);
    healthy_input.core_c0_pct = vec![65.0, 45.0];
    healthy_input.core_dpc_pct = vec![1.2, 0.4];
    healthy_input.core_irq_pct = vec![0.3, 0.1];
    healthy_input.priority_class = "NORMAL".into();
    healthy_input.ecoqos_active = Some(false);
    healthy_input.avail_phys_pct = 42.0;
    healthy_input.hard_page_faults_per_sec = 0.0;
    healthy_input.ctx_sw_per_sec = 12_000.0;
    healthy_input.sync_wait_pct = 8.0;
    healthy_input.composed_flip_pct = Some(0.0);
    healthy_input.disk_read_mb_s = 1.5;
    healthy_input.disk_read_iops = 20.0;
    healthy_input.frametime_spikes = 0;

    let clean = DiagnosticEngine::evaluate(&healthy_input);
    assert_eq!(clean.verdict_id, "win32_only_clear");
    assert!(clean.findings.is_empty());
    for expected_healthy in [
        "win32.gpu_bound",
        "win32.dpc_irq_collision",
        "win32.noisy_neighbor",
        "win32.priority_ecoqos",
        "win32.hard_page_faults",
        "win32.ctx_sw_lock_storm",
        "win32.composed_flip",
        "win32.disk_io_stall",
        "win32.frametime_spike_correlator",
    ] {
        let chk = clean
            .verified_healthy
            .iter()
            .find(|h| h.rule_id == expected_healthy)
            .unwrap_or_else(|| panic!("missing healthy check {expected_healthy}"));
        assert!(!chk.observed_summary.is_empty());
    }
}

#[test]
fn edge_cases_pack_gating_zero_ram_defaults_and_uncorrelated_spikes() {
    // Default unpopulated RAM fields must not false-trigger hard_page_faults, and missing ItlbFull gates JIT rule.
    let mut base = base_win32_input();
    base.enabled_packs = vec![MetricPack::DcDemand];
    base.l2_itlb_mpki = 1.2;
    base.image_large_2m_pct = 90.0;
    base.jit_exec_4k_mib = 32.0;
    base.frametime_spikes = 6;
    base.top_on_cpu_fn = Some("app.exe!render_pass (24% self)".into());
    let r = DiagnosticEngine::evaluate(&base);
    assert!(!r
        .findings
        .iter()
        .any(|f| f.rule_id == "win32.hard_page_faults"));
    assert!(!r
        .findings
        .iter()
        .any(|f| f.rule_id == "win32.jit_4k_itlb_residual"));
    let spike = r
        .findings
        .iter()
        .find(|f| f.rule_id == "win32.frametime_spike_correlator")
        .unwrap();
    assert_eq!(spike.severity, Severity::Info);
    assert_eq!(
        spike.profiler_note.as_deref(),
        Some("app.exe!render_pass (24% self)")
    );

    // Heavy disk I/O triggers even without secondary symptoms; DPC+IRQ >= 8% escalates to Hi.
    let mut hi_case = base_win32_input();
    hi_case.disk_read_mb_s = 160.0;
    hi_case.core_c0_pct = vec![70.0];
    hi_case.core_dpc_pct = vec![6.0];
    hi_case.core_irq_pct = vec![2.5];
    let r_hi = DiagnosticEngine::evaluate(&hi_case);
    assert_eq!(
        r_hi.findings
            .iter()
            .find(|f| f.rule_id == "win32.dpc_irq_collision")
            .unwrap()
            .severity,
        Severity::Hi
    );
    assert!(r_hi
        .findings
        .iter()
        .any(|f| f.rule_id == "win32.disk_io_stall"));
}
