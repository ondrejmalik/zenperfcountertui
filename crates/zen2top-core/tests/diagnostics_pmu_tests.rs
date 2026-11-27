use zen2top_core::diagnostics::{ActionScope, DiagnosticEngine, DiagnosticInput, EstGain, Finding};
use zen2top_core::packs::MetricPack;

fn base_pmu_input(packs: &[MetricPack]) -> DiagnosticInput {
    DiagnosticInput {
        sample_count: 20,
        avg_c0_pct: 55.0,
        inst_per_sec: 4.5e9,
        ipc: 1.5,
        actual_cpi: 0.67,
        modeled_cpi: 0.55,
        retiring_pct: 30.0,
        eff_ghz: 3.8,
        l3_hit_pct: 88.0,
        l3_lat_ns: 45.0,
        mux_groups: 2,
        enabled_packs: packs.to_vec(),
        ..DiagnosticInput::default()
    }
}

fn assert_finding_well_formed(f: &Finding) {
    assert!(!f.why.trim().is_empty(), "{}: empty why", f.rule_id);
    assert!(!f.action.trim().is_empty(), "{}: empty action", f.rule_id);
    assert!(!f.cascade.trim().is_empty(), "{}: empty cascade", f.rule_id);
    assert!(
        !f.observed_metrics.is_empty(),
        "{}: empty observed_metrics",
        f.rule_id
    );
    assert!(
        (1..=7).contains(&f.jump_tab),
        "{}: bad jump_tab {}",
        f.rule_id,
        f.jump_tab
    );
}

#[test]
fn pe_itlb_4k_modules_fires_and_is_pack_gated() {
    let mut input = base_pmu_input(&[MetricPack::ItlbFull]);
    input.target_present = true;
    input.l2_itlb_mpki = 1.5;
    input.l1_itlb_miss_pct = 4.0;
    input.image_large_2m_pct = 0.0;
    input.cand_4k_dlls = vec!["engine.dll".into(), "renderer.dll".into()];

    let report = DiagnosticEngine::evaluate(&input);
    let f = report
        .findings
        .iter()
        .find(|f| f.rule_id == "pmu.pe_itlb_4k_modules")
        .expect("expected pmu.pe_itlb_4k_modules under ItlbFull");
    assert_finding_well_formed(f);
    assert!(matches!(f.scope, ActionScope::OsTui | ActionScope::CodeOs));

    input.enabled_packs.clear();
    let gated = DiagnosticEngine::evaluate(&input);
    assert!(
        !gated
            .findings
            .iter()
            .any(|f| f.rule_id == "pmu.pe_itlb_4k_modules"),
        "pmu.pe_itlb_4k_modules must not fire without MetricPack::ItlbFull"
    );
}

#[test]
fn silent_ifeo_and_mimalloc_failure_branches_on_lock_memory_privilege() {
    let mut no_priv = base_pmu_input(&[MetricPack::ItlbFull, MetricPack::DtlbFull]);
    no_priv.target_present = true;
    no_priv.ifeo_enabled = true;
    no_priv.silent_ifeo_fail_dlls = vec!["engine.dll".into()];
    no_priv.requested_huge_mib = 512.0;
    no_priv.target_huge_mib = 0.0;
    no_priv.mimalloc_os_arenas = 12;
    no_priv.has_lock_memory_privilege = false;

    let r_no_priv = DiagnosticEngine::evaluate(&no_priv);
    let f_no_priv = r_no_priv
        .findings
        .iter()
        .find(|f| f.rule_id == "pmu.large_page_failure_root_cause")
        .expect("expected pmu.large_page_failure_root_cause without privilege");
    assert_finding_well_formed(f_no_priv);
    assert!(matches!(f_no_priv.est_gain, EstGain::Qualitative { .. }));
    let text_no_priv = format!("{} {}", f_no_priv.why, f_no_priv.action).to_lowercase();
    assert!(text_no_priv.contains("secpol.msc") || text_no_priv.contains("privilege"));

    let mut with_priv = no_priv;
    with_priv.has_lock_memory_privilege = true;
    let r_with_priv = DiagnosticEngine::evaluate(&with_priv);
    let f_with_priv = r_with_priv
        .findings
        .iter()
        .find(|f| f.rule_id == "pmu.large_page_failure_root_cause")
        .expect("expected pmu.large_page_failure_root_cause with privilege");
    assert_finding_well_formed(f_with_priv);
    assert!(matches!(f_with_priv.est_gain, EstGain::Qualitative { .. }));
    let text_with_priv = format!("{} {}", f_with_priv.why, f_with_priv.action).to_lowercase();
    assert!(text_with_priv.contains("fragment") || text_with_priv.contains("ram"));
}

#[test]
fn heap_dtlb_and_mimalloc_spillover_rules() {
    let mut spill_input: DiagnosticInput = base_pmu_input(&[]);
    spill_input.target_present = true;
    spill_input.mimalloc_os_arenas = 3;
    spill_input.mimalloc_huge_free_pct = Some(3.0);

    let spill_report = DiagnosticEngine::evaluate(&spill_input);
    let spill_finding = spill_report
        .findings
        .iter()
        .find(|f| f.rule_id == "pmu.mimalloc_spillover")
        .expect("pmu.mimalloc_spillover should fire");
    assert_finding_well_formed(spill_finding);

    let mut dtlb_input: DiagnosticInput = base_pmu_input(&[MetricPack::DtlbFull]);
    dtlb_input.target_present = true;
    dtlb_input.target_ws_mib = 1024.0;
    dtlb_input.target_huge_mib = 0.0;
    dtlb_input.l2_dtlb_mpki = 3.2;

    let dtlb_report = DiagnosticEngine::evaluate(&dtlb_input);
    let dtlb_finding = dtlb_report
        .findings
        .iter()
        .find(|f| f.rule_id == "pmu.crt_heap_dtlb")
        .expect("pmu.crt_heap_dtlb should fire");
    assert_finding_well_formed(dtlb_finding);

    let mut no_pack = dtlb_input.clone();
    no_pack.enabled_packs.clear();
    assert!(
        !DiagnosticEngine::evaluate(&no_pack)
            .findings
            .iter()
            .any(|f| f.rule_id == "pmu.crt_heap_dtlb"),
        "pmu.crt_heap_dtlb must not fire without DtlbFull"
    );

    let mut small_ws = dtlb_input.clone();
    small_ws.target_ws_mib = 256.0;
    assert!(
        !DiagnosticEngine::evaluate(&small_ws)
            .findings
            .iter()
            .any(|f| f.rule_id == "pmu.crt_heap_dtlb"),
        "pmu.crt_heap_dtlb must not fire when target_ws_mib is 256.0"
    );

    let mut with_huge = dtlb_input;
    with_huge.target_huge_mib = 64.0;
    assert!(
        !DiagnosticEngine::evaluate(&with_huge)
            .findings
            .iter()
            .any(|f| f.rule_id == "pmu.crt_heap_dtlb"),
        "pmu.crt_heap_dtlb must not fire when target_huge_mib is 64.0"
    );
}

#[test]
fn smt_hot_contention_fires_with_spare_cores_and_suppresses_at_saturation() {
    let mut spare_input: DiagnosticInput = base_pmu_input(&[]);
    spare_input.core_c0_pct = vec![92.0, 28.0, 5.0, 3.0, 4.0, 2.0, 6.0, 4.0, 3.0, 2.0, 5.0, 3.0];

    let spare_report = DiagnosticEngine::evaluate(&spare_input);
    let smt_finding = spare_report
        .findings
        .iter()
        .find(|f| f.rule_id == "pmu.smt_hot_contention")
        .expect("pmu.smt_hot_contention should fire with hot sibling pair and spare cores");
    assert_finding_well_formed(smt_finding);
    assert!(matches!(smt_finding.est_gain, EstGain::Qualitative { .. }));

    let mut saturated_input: DiagnosticInput = base_pmu_input(&[]);
    saturated_input.core_c0_pct = vec![
        92.0, 28.0, 90.0, 22.0, 88.0, 25.0, 87.0, 19.0, 91.0, 21.0, 89.0, 17.0,
    ];

    let saturated_report = DiagnosticEngine::evaluate(&saturated_input);
    assert!(
        !saturated_report
            .findings
            .iter()
            .any(|f| f.rule_id == "pmu.smt_hot_contention"),
        "pmu.smt_hot_contention must be suppressed when all 6 physical cores are saturated"
    );
}

#[test]
fn cross_ccx_spread_fires_when_threads_fit_in_single_ccx() {
    let mut input = base_pmu_input(&[MetricPack::DcDemand]);
    input.core_c0_pct = vec![
        50.0, 50.0, 0.0, 0.0, 0.0, 0.0, 50.0, 50.0, 0.0, 0.0, 0.0, 0.0,
    ];
    input.l3_hit_pct = 65.0;
    input.ccx_lat_ns = vec![20.0, 25.0];

    let report = DiagnosticEngine::evaluate(&input);
    let finding = report
        .findings
        .iter()
        .find(|f| f.rule_id == "pmu.cross_ccx_spread")
        .expect("expected pmu.cross_ccx_spread to fire when active threads span CCX0 and CCX1");
    assert_finding_well_formed(finding);

    let mut single_ccx = input;
    single_ccx.core_c0_pct = vec![
        50.0, 50.0, 50.0, 50.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
    ];
    let report_single = DiagnosticEngine::evaluate(&single_ccx);
    assert!(
        !report_single
            .findings
            .iter()
            .any(|f| f.rule_id == "pmu.cross_ccx_spread"),
        "pmu.cross_ccx_spread must not fire when all active threads stay in CCX0"
    );
}

#[test]
fn dram_queueing_uses_calibrated_vs_uncalibrated_threshold() {
    let mut input = base_pmu_input(&[MetricPack::DcDemand]);
    input.eff_ghz = 3.8;
    input.dram_mpki = 4.0;
    input.l3_lat_ns = 62.0;
    input.config.calibrated = false;

    let report_uncal = DiagnosticEngine::evaluate(&input);
    assert!(
        !report_uncal
            .findings
            .iter()
            .any(|f| f.rule_id == "pmu.dram_queueing_inflation"),
        "uncalibrated threshold (70 ns) must not fire at 62.0 ns"
    );

    input.config.calibrated = true;
    let report_cal = DiagnosticEngine::evaluate(&input);
    let finding = report_cal
        .findings
        .iter()
        .find(|f| f.rule_id == "pmu.dram_queueing_inflation")
        .expect("calibrated threshold (~61.18 ns) must fire at 62.0 ns");
    assert_finding_well_formed(finding);
}

#[test]
fn demand_dram_pointer_chase_suppressed_under_hwpf_streaming() {
    let mut input = base_pmu_input(&[MetricPack::DcDemand, MetricPack::DcHwpf]);
    input.dem_dram_mpki = 2.4;
    input.hwpf_dram_mpki = 0.4;
    input.l2_pf_dram_mpki = 0.0;
    input.dram_mpki = 2.8;

    let report = DiagnosticEngine::evaluate(&input);
    let finding = report
        .findings
        .iter()
        .find(|f| f.rule_id == "pmu.demand_dram_pointer_chase")
        .expect("expected pmu.demand_dram_pointer_chase to fire when dem_share >= 0.65");
    assert_finding_well_formed(finding);
    assert_eq!(finding.scope, ActionScope::CodeBuild);

    let mut streaming = input;
    streaming.dem_dram_mpki = 2.0;
    streaming.hwpf_dram_mpki = 5.0;
    streaming.dram_mpki = 7.0;

    let report_stream = DiagnosticEngine::evaluate(&streaming);
    assert!(
        !report_stream
            .findings
            .iter()
            .any(|f| f.rule_id == "pmu.demand_dram_pointer_chase"),
        "pmu.demand_dram_pointer_chase must be suppressed under HWPF streaming"
    );
}

#[test]
fn branch_mispredict_bound_is_code_build_only_without_os_tweaks() {
    let mut gated = base_pmu_input(&[MetricPack::DcDemand]);
    gated.branch_miss_mpki = 8.0;
    gated.branch_miss_pct = 6.5;
    gated.tier_cpi.branch = 0.25;

    let report_gated = DiagnosticEngine::evaluate(&gated);
    assert!(
        !report_gated
            .findings
            .iter()
            .any(|f| f.rule_id == "pmu.branch_mispredict_bound"),
        "pmu.branch_mispredict_bound must be pack-gated on MetricPack::Branches"
    );

    let mut input = base_pmu_input(&[MetricPack::Branches]);
    input.branch_miss_mpki = 8.0;
    input.branch_miss_pct = 6.5;
    input.tier_cpi.branch = 0.25;

    let report = DiagnosticEngine::evaluate(&input);
    let finding = report
        .findings
        .iter()
        .find(|f| f.rule_id == "pmu.branch_mispredict_bound")
        .expect("expected pmu.branch_mispredict_bound to fire");
    assert_finding_well_formed(finding);
    assert_eq!(finding.scope, ActionScope::CodeBuild);
    assert!(matches!(finding.est_gain, EstGain::Numeric { .. }));

    let action_lc = finding.action.to_ascii_lowercase();
    for forbidden in ["registry", "windows", "bios", "power plan", "secpol"] {
        assert!(
            !action_lc.contains(forbidden),
            "branch_mispredict_bound action must not suggest OS tweak '{forbidden}': {}",
            finding.action
        );
    }
}

#[test]
fn icache_capacity_keys_on_true_l2_ic_miss_not_l2ic_excl_alone() {
    let mut input = base_pmu_input(&[MetricPack::L1L2Ic]);
    input.l2_ic_miss_mpki = 3.5;
    input.l2_ic_excl_mpki = 4.0;
    input.l1_ic_miss_mpki = 12.0;
    input.tier_cpi.l2_ic = 0.25;

    let report = DiagnosticEngine::evaluate(&input);
    let finding = report
        .findings
        .iter()
        .find(|f| f.rule_id == "pmu.icache_capacity_pressure")
        .expect("expected pmu.icache_capacity_pressure to fire on high true l2_ic_miss_mpki");
    assert_finding_well_formed(finding);
    assert_eq!(finding.scope, ActionScope::CodeBuild);

    let action_lc = finding.action.to_ascii_lowercase();
    for forbidden in ["registry", "windows", "bios", "power plan", "secpol"] {
        assert!(
            !action_lc.contains(forbidden),
            "icache_capacity_pressure action must not suggest OS tweak '{forbidden}': {}",
            finding.action
        );
    }

    let mut excl_only = base_pmu_input(&[MetricPack::L1L2Ic]);
    excl_only.l2_ic_excl_mpki = 18.0;
    excl_only.l2_ic_miss_mpki = 0.8;
    excl_only.l1_ic_miss_mpki = 8.8;

    let report_excl = DiagnosticEngine::evaluate(&excl_only);
    assert!(
        !report_excl
            .findings
            .iter()
            .any(|f| f.rule_id == "pmu.icache_capacity_pressure"),
        "pmu.icache_capacity_pressure must not fire on l2_ic_excl_mpki alone"
    );
}

#[test]
fn clock_throttling_requires_positive_eff_ghz_and_active_c0() {
    let mut input = base_pmu_input(&MetricPack::ALL);
    input.eff_ghz = 3.2;
    input.avg_c0_pct = 40.0;
    let report = DiagnosticEngine::evaluate(&input);
    let f = report
        .findings
        .iter()
        .find(|f| f.rule_id == "pmu.clock_throttling")
        .expect("expected pmu.clock_throttling finding");
    assert_finding_well_formed(f);
    assert!(matches!(f.est_gain, EstGain::Clock { .. }));

    input.eff_ghz = 0.0;
    let report_zero = DiagnosticEngine::evaluate(&input);
    assert!(!report_zero
        .findings
        .iter()
        .any(|f| f.rule_id == "pmu.clock_throttling"));
}

#[test]
fn measurement_hygiene_detects_mux_diff_and_sub_3pct_mux_noise() {
    let mut input = base_pmu_input(&MetricPack::ALL);
    input.baseline_mux_groups = Some(1);
    input.mux_groups = 2;
    let rep_diff = DiagnosticEngine::evaluate(&input);
    let f_diff = rep_diff
        .findings
        .iter()
        .find(|f| f.rule_id == "pmu.hygiene_mux_mismatch")
        .expect("expected pmu.hygiene_mux_mismatch");
    assert_finding_well_formed(f_diff);
    assert!(f_diff.title.contains("MUX DIFF"));

    input.baseline_mux_groups = Some(2);
    input.mux_groups = 2;
    input.baseline_ipc = Some(1.50);
    input.ipc = 1.52;
    let rep_noise = DiagnosticEngine::evaluate(&input);
    let f_noise = rep_noise
        .findings
        .iter()
        .find(|f| f.rule_id == "pmu.hygiene_small_delta_mux")
        .expect("expected pmu.hygiene_small_delta_mux");
    assert_finding_well_formed(f_noise);

    input.ipc = 1.65;
    let rep_clean = DiagnosticEngine::evaluate(&input);
    assert!(!rep_clean.findings.iter().any(|f| matches!(
        f.rule_id.as_str(),
        "pmu.hygiene_mux_mismatch" | "pmu.hygiene_small_delta_mux"
    )));
}

#[test]
fn micro_arch_cross_ccx_and_serialized_locks_are_pack_gated() {
    let mut input = base_pmu_input(&[MetricPack::CrossCcxLocks]);
    input.dc_cross_ccx_mpki = 6.0;
    input.locks_serial_mpki = 4.0;
    let report = DiagnosticEngine::evaluate(&input);
    let f_ccx = report
        .findings
        .iter()
        .find(|f| f.rule_id == "uarch.cross_ccx_cache_bouncing")
        .expect("expected uarch.cross_ccx_cache_bouncing");
    let f_lock = report
        .findings
        .iter()
        .find(|f| f.rule_id == "uarch.serialized_lock_contention")
        .expect("expected uarch.serialized_lock_contention");
    assert_finding_well_formed(f_ccx);
    assert_finding_well_formed(f_lock);

    input.enabled_packs.clear();
    let rep_off = DiagnosticEngine::evaluate(&input);
    assert!(!rep_off.findings.iter().any(|f| matches!(
        f.rule_id.as_str(),
        "uarch.cross_ccx_cache_bouncing" | "uarch.serialized_lock_contention"
    )));
}

#[test]
fn micro_arch_opcache_thrashing_and_dram_masked_variant() {
    let mut input = base_pmu_input(&[MetricPack::OpCacheDecode]);
    input.legacy_decode_pct = 45.0;
    input.opcache_hit_pct = 55.0;
    let report = DiagnosticEngine::evaluate(&input);
    let f_thrash = report
        .findings
        .iter()
        .find(|f| f.rule_id == "uarch.opcache_thrashing")
        .expect("expected uarch.opcache_thrashing");
    assert_finding_well_formed(f_thrash);

    input.l3_miss_mpki = 12.0;
    input.l3_lat_ns = 75.0;
    input.ipc = 1.05;
    let rep_masked = DiagnosticEngine::evaluate(&input);
    let f_masked = rep_masked
        .findings
        .iter()
        .find(|f| f.rule_id == "uarch.opcache_thrashing_masked")
        .expect("expected uarch.opcache_thrashing_masked");
    assert_finding_well_formed(f_masked);

    input.enabled_packs.clear();
    let rep_off = DiagnosticEngine::evaluate(&input);
    assert!(!rep_off.findings.iter().any(|f| matches!(
        f.rule_id.as_str(),
        "uarch.opcache_thrashing" | "uarch.opcache_thrashing_masked"
    )));
}

#[test]
fn micro_arch_stlf_and_cache_line_splits_are_pack_gated() {
    let mut input = base_pmu_input(&[MetricPack::StlfSplits]);
    input.stlf_interlock_mpki = 8.0;
    input.misal_access_mpki = 22.0;
    let report = DiagnosticEngine::evaluate(&input);
    let f_stlf = report
        .findings
        .iter()
        .find(|f| f.rule_id == "uarch.stlf_interlocks")
        .expect("expected uarch.stlf_interlocks");
    let f_split = report
        .findings
        .iter()
        .find(|f| f.rule_id == "uarch.cache_line_splits")
        .expect("expected uarch.cache_line_splits");
    assert_finding_well_formed(f_stlf);
    assert_finding_well_formed(f_split);
    assert!(matches!(f_stlf.est_gain, EstGain::Numeric { .. }));
    assert!(matches!(f_split.est_gain, EstGain::Qualitative { .. }));

    input.enabled_packs.clear();
    let rep_off = DiagnosticEngine::evaluate(&input);
    assert!(!rep_off.findings.iter().any(|f| matches!(
        f.rule_id.as_str(),
        "uarch.stlf_interlocks" | "uarch.cache_line_splits"
    )));
}

#[test]
fn no_pmu_suppresses_all_pmu_and_uarch_findings() {
    let mut input = base_pmu_input(&MetricPack::ALL);
    input.no_pmu = true;
    input.target_present = true;
    input.cand_4k_dlls = vec!["a.dll".into()];
    input.l2_itlb_mpki = 3.0;
    input.l2_dtlb_mpki = 3.0;
    input.target_ws_mib = 1024.0;
    input.dem_dram_mpki = 4.0;
    input.branch_miss_mpki = 9.0;
    input.branch_miss_pct = 8.0;
    input.l2_ic_miss_mpki = 5.0;
    input.dc_cross_ccx_mpki = 5.0;
    input.locks_serial_mpki = 4.0;
    input.legacy_decode_pct = 50.0;
    input.stlf_interlock_mpki = 6.0;
    input.misal_access_mpki = 25.0;
    input.eff_ghz = 3.0;

    let report = DiagnosticEngine::evaluate(&input);
    assert!(
        report
            .findings
            .iter()
            .all(|f| !f.rule_id.starts_with("pmu.") && !f.rule_id.starts_with("uarch.")),
        "no_pmu = true must suppress all pmu.* and uarch.* findings"
    );
}

#[test]
fn pmu_verdicts_boundaries_and_code_build_os_tweak_audit() {
    // Boundary checks: L1 iTLB trigger, huge-page tab 4 jump without IFEO DLLs, L2Hwpf streaming suppression,
    // cross-CCX saturation suppression (> half active), low-C0 clock suppression, and 1x mux noise suppression.
    let mut b = base_pmu_input(&[
        MetricPack::ItlbFull,
        MetricPack::DcDemand,
        MetricPack::DcHwpf,
        MetricPack::L2Hwpf,
    ]);
    b.target_present = true;
    b.cand_4k_dlls = vec!["hot.dll".into()];
    b.l2_itlb_mpki = 0.10;
    b.l1_itlb_miss_pct = 1.8;
    b.requested_huge_mib = 256.0;
    b.target_huge_mib = 0.0;
    b.has_lock_memory_privilege = true;
    b.dem_dram_mpki = 2.0;
    b.hwpf_dram_mpki = 0.2;
    b.l2_pf_dram_mpki = 4.0;
    b.core_c0_pct = vec![
        50.0, 50.0, 50.0, 50.0, 0.0, 0.0, 50.0, 50.0, 50.0, 50.0, 0.0, 0.0,
    ];
    b.l3_hit_pct = 65.0;
    b.eff_ghz = 3.1;
    b.avg_c0_pct = 20.0;
    b.mux_groups = 1;
    b.baseline_mux_groups = Some(1);
    b.baseline_ipc = Some(1.51);
    let rb = DiagnosticEngine::evaluate(&b);
    assert!(rb
        .findings
        .iter()
        .any(|f| f.rule_id == "pmu.pe_itlb_4k_modules"));
    let lp = rb
        .findings
        .iter()
        .find(|f| f.rule_id == "pmu.large_page_failure_root_cause")
        .unwrap();
    assert_eq!(lp.jump_tab, 4);
    assert!(!rb
        .findings
        .iter()
        .any(|f| f.rule_id == "pmu.demand_dram_pointer_chase"));
    assert!(!rb
        .findings
        .iter()
        .any(|f| f.rule_id == "pmu.cross_ccx_spread"));
    assert!(!rb
        .findings
        .iter()
        .any(|f| f.rule_id == "pmu.clock_throttling"));
    assert!(!rb
        .findings
        .iter()
        .any(|f| f.rule_id == "pmu.hygiene_small_delta_mux"));

    // All Code/Build micro-arch rules must stay CodeBuild with zero OS tweaks.
    let mut ua = base_pmu_input(&[
        MetricPack::CrossCcxLocks,
        MetricPack::OpCacheDecode,
        MetricPack::StlfSplits,
    ]);
    ua.locks_serial_mpki = 3.0;
    ua.legacy_decode_pct = 50.0;
    ua.stlf_interlock_mpki = 6.0;
    ua.misal_access_mpki = 22.0;
    ua.top_on_cpu_fn = Some("app.exe!hot_loop (42.0% self)".into());
    let r_ua = DiagnosticEngine::evaluate(&ua);
    assert_eq!(r_ua.verdict_id, "micro_arch_contention");
    for id in [
        "uarch.serialized_lock_contention",
        "uarch.opcache_thrashing",
        "uarch.stlf_interlocks",
        "uarch.cache_line_splits",
    ] {
        let f = r_ua.findings.iter().find(|f| f.rule_id == id).unwrap();
        assert_eq!(f.scope, ActionScope::CodeBuild);
        assert_eq!(
            f.profiler_note.as_deref(),
            Some("app.exe!hot_loop (42.0% self)")
        );
        let act = f.action.to_ascii_lowercase();
        for forbidden in ["registry", "windows", "bios", "power plan", "secpol"] {
            assert!(
                !act.contains(forbidden),
                "{id} action must not mention '{forbidden}'"
            );
        }
    }

    // PMU verdict selection covers DRAM queueing, Demand DRAM, Branch, ICache, Cross-CCX, TLB, SMT.
    let mut dq = base_pmu_input(&[MetricPack::DcDemand]);
    dq.l3_lat_ns = 75.0;
    dq.dram_mpki = 4.0;
    dq.tier_cpi.dram = 0.50;
    dq.top_on_cpu_fn = Some("app.exe!mem_walk (30.0% self)".into());
    let r_dq = DiagnosticEngine::evaluate(&dq);
    assert_eq!(r_dq.verdict_id, "memory_bandwidth_queueing");
    assert_eq!(
        r_dq.findings
            .iter()
            .find(|f| f.rule_id == "pmu.dram_queueing_inflation")
            .unwrap()
            .profiler_note
            .as_deref(),
        Some("app.exe!mem_walk (30.0% self)")
    );

    let mut dd = base_pmu_input(&[MetricPack::DcDemand, MetricPack::DcHwpf]);
    dd.dem_dram_mpki = 3.0;
    dd.hwpf_dram_mpki = 0.3;
    dd.tier_cpi.dram = 0.45;
    assert_eq!(
        DiagnosticEngine::evaluate(&dd).verdict_id,
        "memory_latency_bound"
    );

    let mut br = base_pmu_input(&[MetricPack::Branches]);
    br.branch_miss_mpki = 8.0;
    br.branch_miss_pct = 6.0;
    br.tier_cpi.branch = 0.30;
    assert_eq!(
        DiagnosticEngine::evaluate(&br).verdict_id,
        "branch_mispredict_bound"
    );

    let mut ic = base_pmu_input(&[MetricPack::L1L2Ic]);
    ic.l2_ic_miss_mpki = 4.0;
    ic.tier_cpi.l2_ic = 0.25;
    assert_eq!(
        DiagnosticEngine::evaluate(&ic).verdict_id,
        "frontend_code_bound"
    );

    let mut ccx = base_pmu_input(&[MetricPack::DcDemand]);
    ccx.core_c0_pct = vec![50.0, 50.0, 0.0, 0.0, 50.0, 50.0, 0.0, 0.0];
    ccx.l3_hit_pct = 65.0;
    ccx.tier_cpi.l3_hit = 0.25;
    assert_eq!(
        DiagnosticEngine::evaluate(&ccx).verdict_id,
        "l3_capacity_or_cross_ccx"
    );

    let mut tlb = base_pmu_input(&[MetricPack::DtlbFull]);
    tlb.target_present = true;
    tlb.target_ws_mib = 1024.0;
    tlb.l2_dtlb_mpki = 3.0;
    tlb.tier_cpi.l2_dtlb = 0.20;
    assert_eq!(
        DiagnosticEngine::evaluate(&tlb).verdict_id,
        "tlb_translation_bound"
    );

    let mut smt = base_pmu_input(&[]);
    smt.core_c0_pct = vec![90.0, 25.0, 5.0, 3.0, 2.0, 2.0, 2.0, 2.0];
    assert_eq!(
        DiagnosticEngine::evaluate(&smt).verdict_id,
        "smt_contention_bound"
    );

    // GPU saturation overrides PMU verdict selection.
    let mut gpu = base_pmu_input(&[MetricPack::Branches]);
    gpu.branch_miss_mpki = 9.0;
    gpu.branch_miss_pct = 8.0;
    gpu.tier_cpi.branch = 0.40;
    gpu.gpu_3d_pct = Some(98.0);
    gpu.core_c0_pct = vec![60.0, 20.0];
    let r_gpu = DiagnosticEngine::evaluate(&gpu);
    assert_eq!(r_gpu.verdict_id, "gpu_bound");
}
