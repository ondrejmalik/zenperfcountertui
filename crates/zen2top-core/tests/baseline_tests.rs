use zen2top_core::baseline::{
    compare_baselines, deserialize_baseline_json, serialize_baseline_json, BaselineSnapshot,
    RawCumulativeCounters, DEFAULT_BASE_MHZ,
};
use zen2top_core::packs::MetricPack;

fn sample_counters() -> RawCumulativeCounters {
    RawCumulativeCounters {
        inst: 10_000_000_000,
        aperf: 5_000_000_000,
        mperf: 4_000_000_000,
        cycles: 5_000_000_000,
        ret_uops: 12_000_000_000,
        l3_access: 100_000_000,
        l3_miss: 20_000_000,
        l3_lat: 40_000_000,
        l3_mtype: 16_000_000,
        dc_dem_l3: 5_000_000,
        dc_dem_dram: 2_000_000,
        dc_hwpf_l3: 3_000_000,
        dc_hwpf_dram: 1_000_000,
        l1_dc_miss: 50_000_000,
        l2_dc_miss: 10_000_000,
        l1_ic_miss: 8_000_000,
        l2_ic_miss: 2_000_000,
        l2_pf_l3: 4_000_000,
        l2_pf_dram: 1_500_000,
        branches: 1_000_000_000,
        branch_miss: 15_000_000,
        l1_itlb_hit: 900_000_000,
        l1_itlb_miss_l2_hit: 5_000_000,
        l2_itlb_miss: 500_000,
        l1_dtlb_miss_l2_hit: 12_000_000,
        l2_dtlb_miss: 1_000_000,
        dc_cross_ccx: 3_000_000,
        locks_serial: 250_000,
        dec_uops: 2_000_000_000,
        oc_uops: 8_000_000_000,
        stlf_interlock: 400_000,
        misal_access: 600_000,
        base_mhz: 3800.0,
    }
}

#[test]
fn json_round_trip_and_partial_legacy_deserialization() {
    let original = BaselineSnapshot {
        name: "run-01".to_string(),
        timestamp_utc: "2026-11-27T07:00:00Z".to_string(),
        elapsed_sec: 10.0,
        sample_count: 10,
        target_name: Some("game.exe".to_string()),
        affinity_mask: Some(0xFF),
        enabled_packs: vec![MetricPack::DcDemand, MetricPack::Branches],
        core_pmc_slots: 4,
        mux_groups: 1,
        ifeo_summary: "High".to_string(),
        note: "clean 0-mux".to_string(),
        counters: sample_counters(),
    };

    let json = serialize_baseline_json(&original).expect("serialize");
    let decoded = deserialize_baseline_json(&json).expect("deserialize");
    assert_eq!(original, decoded);

    // Partial legacy payload omitting core_pmc_slots, mux_groups, base_mhz, and most counters.
    // DcDemand(2) + L1L2Dc(2) + Branches(2) + ItlbFull(3) = 9 requested slots -> 2 mux bins,
    // with non-final 5-slot bin (ItlbFull + DcDemand) auto-padded to 6 slots -> 10 core_pmc_slots.
    let partial_json = r#"{
        "name": "legacy-partial",
        "enabled_packs": ["DcDemand", "L1L2Dc", "Branches", "ItlbFull"],
        "counters": {
            "inst": 2000000000,
            "aperf": 1000000000,
            "dc_dem_dram": 4000000
        }
    }"#;
    let partial = deserialize_baseline_json(partial_json).expect("deserialize partial");
    assert_eq!(partial.name, "legacy-partial");
    assert_eq!(partial.core_pmc_slots, 10);
    assert_eq!(partial.mux_groups, 2);
    assert_eq!(partial.counters.base_mhz, DEFAULT_BASE_MHZ);
    assert_eq!(partial.counters.dc_dem_dram, 4_000_000);
    assert_eq!(partial.counters.l3_access, 0);
}

#[test]
fn weighted_rates_derive_strictly_from_cumulative_totals() {
    // 10-sample window:
    // Sample 1: 1B inst, 1B aperf (IPC = 1.0), 10M DRAM misses (MPKI = 10.0)
    // Samples 2..=10 (9 samples): each 1B inst, 0.25B aperf (IPC = 4.0), 1M DRAM misses (MPKI = 1.0)
    // Total: 10B inst, 3.25B aperf, 19M DRAM misses.
    let cumulative = RawCumulativeCounters {
        inst: 10_000_000_000,
        aperf: 3_250_000_000,
        dc_dem_dram: 19_000_000,
        ..RawCumulativeCounters::default()
    };

    let rates = cumulative.derived_rates(&[MetricPack::DcDemand]);
    let expected_weighted_ipc = 10.0 / 3.25; // ~3.076923
    let naive_unweighted_mean_ipc = (1.0 + 9.0 * 4.0) / 10.0; // 3.7

    assert!((rates.ipc - expected_weighted_ipc).abs() < 1e-9);
    assert!((rates.ipc - naive_unweighted_mean_ipc).abs() > 0.5);

    let expected_weighted_mpki = 1.9; // 19M * 1000 / 10B
    assert!((rates.dem_dram_mpki.unwrap() - expected_weighted_mpki).abs() < 1e-9);
    // dram_mpki works on DcDemand alone (sums available demand + active HWPF DRAM counters).
    assert!((rates.dram_mpki.unwrap() - expected_weighted_mpki).abs() < 1e-9);
    // Inactive packs must return None.
    assert!(rates.hwpf_dram_mpki.is_none());
    assert!(rates.branch_miss_mpki.is_none());
}

#[test]
fn pack_intersection_filtering_skips_mismatched_packs() {
    let baseline = BaselineSnapshot {
        name: "base".to_string(),
        enabled_packs: vec![MetricPack::DcDemand, MetricPack::Branches],
        core_pmc_slots: 4,
        mux_groups: 1,
        counters: sample_counters(),
        ..BaselineSnapshot::default()
    };
    let current = BaselineSnapshot {
        name: "curr".to_string(),
        enabled_packs: vec![MetricPack::DcDemand, MetricPack::OpCacheDecode],
        core_pmc_slots: 4,
        mux_groups: 1,
        counters: sample_counters(),
        ..BaselineSnapshot::default()
    };

    let diff = compare_baselines(&baseline, &current);
    assert!(diff.deltas.iter().any(|d| d.key == "dem_dram_mpki"));
    assert!(diff.deltas.iter().any(|d| d.key == "dram_mpki"));
    assert!(diff.deltas.iter().any(|d| d.key == "l3_hit_mpki"));
    assert!(!diff.deltas.iter().any(|d| d.key == "branch_miss_mpki"));
    assert!(!diff.deltas.iter().any(|d| d.key == "opcache_hit_pct"));
    assert!(diff
        .skipped_metrics
        .contains(&"branch_miss_mpki".to_string()));
    assert!(diff
        .skipped_metrics
        .contains(&"branch_miss_pct".to_string()));
    assert!(diff
        .skipped_metrics
        .contains(&"opcache_hit_pct".to_string()));
}

#[test]
fn mux_warnings_and_clean_zero_mux_status() {
    let b_mux1 = BaselineSnapshot {
        name: "mux1".to_string(),
        enabled_packs: vec![MetricPack::DcDemand],
        core_pmc_slots: 2,
        mux_groups: 1,
        counters: sample_counters(),
        ..BaselineSnapshot::default()
    };
    let c_mux2 = BaselineSnapshot {
        name: "mux2".to_string(),
        enabled_packs: vec![MetricPack::DcDemand],
        core_pmc_slots: 8,
        mux_groups: 2,
        counters: sample_counters(),
        ..BaselineSnapshot::default()
    };
    let diff_mismatch = compare_baselines(&b_mux1, &c_mux2);
    assert!(diff_mismatch.mux_diff_warning);
    assert!(diff_mismatch.mux_diff_reason.is_some());
    assert!(!diff_mismatch.small_delta_mux_warning);

    let mut c_mux2_small = c_mux2.clone();
    c_mux2_small.counters.inst = 10_150_000_000; // +1.5% IPC
    let diff_small_mux = compare_baselines(&c_mux2, &c_mux2_small);
    assert!(!diff_small_mux.mux_diff_warning);
    assert!(diff_small_mux.small_delta_mux_warning);
    assert!(diff_small_mux.small_delta_reason.is_some());

    let mut c_mux1_small = b_mux1.clone();
    c_mux1_small.counters.inst = 10_150_000_000; // +1.5% IPC
    let diff_clean = compare_baselines(&b_mux1, &c_mux1_small);
    assert!(!diff_clean.mux_diff_warning);
    assert!(diff_clean.mux_diff_reason.is_none());
    assert!(!diff_clean.small_delta_mux_warning);
    assert!(diff_clean.small_delta_reason.is_none());
}
