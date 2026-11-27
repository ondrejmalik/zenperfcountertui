use std::collections::HashSet;

use zen2top_core::config::{parse_config, to_toml_string, Zen2Config};
use zen2top_core::packs::{
    pack_core_pmcs, resolve_packs_csv, resolve_preset, MetricPack, PresetId,
    CORE_PMC_SLOTS_PER_GROUP, FREE_BASE_FIXED_MSRS, FREE_BASE_L3_EVENTS,
};

#[test]
fn empty_pack_selection_returns_error() {
    assert!(pack_core_pmcs(&[]).is_err());
    assert!(resolve_packs_csv("").is_err());
    assert!(resolve_packs_csv("   ").is_err());
    assert!(resolve_packs_csv("DcDemand,UnknownPack").is_err());
}

#[test]
fn exhaustive_all_4095_subsets_satisfy_bin_packing_invariants() {
    for mask in 1u16..=4095u16 {
        let mut selected = Vec::new();
        for (idx, pack) in MetricPack::ALL.iter().copied().enumerate() {
            if (mask & (1u16 << idx)) != 0 {
                selected.push(pack);
            }
        }

        let plan = pack_core_pmcs(&selected).expect("non-empty subset must pack");
        assert_eq!(plan.selected_packs, selected);
        assert_eq!(plan.mux_groups as usize, plan.bins.len());
        assert_eq!(
            plan.capacity_slots,
            plan.mux_groups * CORE_PMC_SLOTS_PER_GROUP
        );

        let expected_requested: u8 = selected.iter().map(|p| p.slots()).sum();
        assert_eq!(plan.requested_slots, expected_requested);

        let mut seen_packs = HashSet::new();
        let mut auto_pad_count: u8 = 0;

        for (bin_idx, bin) in plan.bins.iter().enumerate() {
            assert_eq!(bin.group, (bin_idx + 1) as u8);
            assert_eq!(bin.capacity, CORE_PMC_SLOTS_PER_GROUP);
            assert!(
                bin.used <= CORE_PMC_SLOTS_PER_GROUP,
                "mask {mask:#06x} bin {bin_idx} exceeded 6 slots: {}",
                bin.used
            );

            let sum_pack_slots: u8 = bin.packs.iter().map(|p| p.slots()).sum();
            assert_eq!(bin.used, sum_pack_slots);
            assert_eq!(bin.events.len(), bin.used as usize);

            // Verify zero coupled pack is split across bins and every event belongs to a pack in this bin.
            for &pack in &bin.packs {
                assert!(
                    seen_packs.insert(pack),
                    "pack {pack:?} appeared in multiple bins for mask {mask:#06x}"
                );
                let event_count_in_bin = bin.events.iter().filter(|e| e.pack == pack).count();
                assert_eq!(event_count_in_bin, pack.slots() as usize);
            }

            if bin.auto_padded {
                assert!(
                    bin_idx < plan.bins.len() - 1,
                    "final bin must not be auto-padded for mask {mask:#06x}"
                );
                assert!(
                    !selected.contains(&MetricPack::ExactRetiring),
                    "auto-pad must only trigger when ExactRetiring was unselected"
                );
                assert_eq!(bin.used, CORE_PMC_SLOTS_PER_GROUP);
                assert!(bin.packs.contains(&MetricPack::ExactRetiring));
                auto_pad_count += 1;
            }
        }

        // Verify non-final 5-slot bins auto-pad with ExactRetiring iff ExactRetiring was unselected.
        let retiring_selected = selected.contains(&MetricPack::ExactRetiring);
        if plan.bins.len() > 1 && !retiring_selected {
            for bin in &plan.bins[..plan.bins.len() - 1] {
                assert_ne!(
                    bin.used, 5,
                    "non-final 5-slot bin was not auto-padded for mask {mask:#06x}"
                );
            }
        } else {
            assert!(!plan.auto_padded_retiring);
            assert_eq!(auto_pad_count, 0);
        }

        assert_eq!(plan.auto_padded_retiring, auto_pad_count > 0);
        assert_eq!(plan.core_slots, plan.requested_slots + auto_pad_count);
        assert_eq!(
            plan.has(MetricPack::ExactRetiring),
            retiring_selected || plan.auto_padded_retiring
        );

        for &pack in &plan.effective_packs {
            assert!(plan.has(pack));
        }
    }
}

#[test]
fn canonical_presets_and_legacy_aliases_resolve_accurately() {
    let cases = [
        ("full", PresetId::Full, 18u8, 3u8),
        ("kitchen-sink", PresetId::KitchenSink, 24u8, 4u8),
        ("all", PresetId::KitchenSink, 24u8, 4u8),
        ("balanced", PresetId::Balanced, 12u8, 2u8),
        ("daily", PresetId::Balanced, 12u8, 2u8),
        ("tlb-only", PresetId::TlbOnly, 6u8, 1u8),
        ("tlb", PresetId::TlbOnly, 6u8, 1u8),
        ("mem-ccx-lab", PresetId::MemCcxLab, 6u8, 1u8),
        ("mem-ccx", PresetId::MemCcxLab, 6u8, 1u8),
        ("micro-arch", PresetId::MicroArch, 6u8, 1u8),
        ("uarch", PresetId::MicroArch, 6u8, 1u8),
    ];

    for (alias, expected_id, expected_slots, expected_mux) in cases {
        let resolved = resolve_preset(alias).expect("preset alias should resolve");
        assert_eq!(resolved, expected_id);
        assert_eq!(resolved.core_pmc_slots(), expected_slots);
        assert_eq!(resolved.mux_groups(), expected_mux);

        let plan = pack_core_pmcs(resolved.packs()).expect("preset packs should pack");
        assert_eq!(plan.core_slots, expected_slots);
        assert_eq!(plan.mux_groups, expected_mux);
        assert_eq!(plan.preset_slug.as_deref(), Some(expected_id.slug()));
        assert!(!plan.auto_padded_retiring);
    }

    assert!(resolve_preset("nonexistent").is_none());

    let parsed = resolve_packs_csv("stlf-splits, DcDemand, dcdemand, exact_retiring")
        .expect("CSV should parse and deduplicate");
    assert_eq!(
        parsed,
        vec![
            MetricPack::DcDemand,
            MetricPack::StlfSplits,
            MetricPack::ExactRetiring,
        ]
    );
}

#[test]
fn pack_hex_codes_and_base_events_match_zen2_spec() {
    let total_slots: u8 = MetricPack::ALL.iter().map(|p| p.slots()).sum();
    assert_eq!(total_slots, 24);

    assert_eq!(
        FREE_BASE_FIXED_MSRS,
        [
            "core/aperf=(aperf)",
            "core/mperf=(mperf)",
            "core/inst=(irperf)",
        ]
    );
    assert_eq!(
        FREE_BASE_L3_EVENTS,
        [
            "l3/l3_access=(0xFF0F00000040FF04)",
            "l3/l3_miss=(0xFF0F000000400104)",
            "l3/l3_lat=(0xFF0F000000400090)",
            "l3/l3_mtype=(0xFF0F000000401F9A)",
        ]
    );

    assert_eq!(MetricPack::DcDemand.hex_codes(), &["0x430243", "0x430843"]);
    assert_eq!(MetricPack::DcHwpf.hex_codes(), &["0x43025A", "0x43085A"]);
    assert_eq!(MetricPack::L1L2Dc.hex_codes(), &["0x43C860", "0x430864"]);
    assert_eq!(MetricPack::L1L2Ic.hex_codes(), &["0x431060", "0x430164"]);
    assert_eq!(MetricPack::L2Hwpf.hex_codes(), &["0x431F71", "0x431F72"]);
    assert_eq!(MetricPack::Branches.hex_codes(), &["0x4300C2", "0x4300C3"]);
    assert_eq!(
        MetricPack::ItlbFull.hex_codes(),
        &["0x430794", "0x430084", "0x430785"]
    );
    assert_eq!(MetricPack::DtlbFull.hex_codes(), &["0x430F45", "0x43F045"]);
    assert_eq!(
        MetricPack::CrossCcxLocks.hex_codes(),
        &["0x430443", "0x430325"]
    );
    assert_eq!(
        MetricPack::OpCacheDecode.hex_codes(),
        &["0x4301AA", "0x4302AA"]
    );
    assert_eq!(
        MetricPack::StlfSplits.hex_codes(),
        &["0x430224", "0x430047"]
    );
    assert_eq!(MetricPack::ExactRetiring.hex_codes(), &["0x4300C1"]);

    for pack in MetricPack::ALL {
        assert_eq!(pack.events().len(), pack.slots() as usize);
        assert_eq!(pack.hex_codes().len(), pack.slots() as usize);
        for (event, hex) in pack.events().iter().zip(pack.hex_codes().iter()) {
            assert!(
                event.contains(hex),
                "event '{event}' does not contain hex code '{hex}'"
            );
        }
    }
}

#[test]
fn config_toml_handles_empty_partial_and_round_trip() {
    let empty_cfg = parse_config("").expect("empty TOML should parse with defaults");
    let default_cfg = Zen2Config::default();
    assert_eq!(empty_cfg, default_cfg);
    assert_eq!(default_cfg.cpu_model, "Ryzen 5 3600X");
    assert!((default_cfg.base_mhz - 3800.0).abs() < f64::EPSILON);
    assert_eq!(default_cfg.logical_cpus, 12);
    assert!(!default_cfg.calibrated);
    assert_eq!(default_cfg.default_preset, "balanced");
    assert_eq!(default_cfg.default_packs, PresetId::Balanced.packs());
    assert!((default_cfg.module_min_mib - 4.0).abs() < f64::EPSILON);
    assert!((default_cfg.latencies.l1_hit - 4.0).abs() < f64::EPSILON);
    assert!((default_cfg.latencies.l2_hit - 12.0).abs() < f64::EPSILON);
    assert!((default_cfg.latencies.l3_hit - 39.0).abs() < f64::EPSILON);
    assert!((default_cfg.latencies.cross_ccx - 90.0).abs() < f64::EPSILON);
    assert!((default_cfg.latencies.branch_mispredict - 17.0).abs() < f64::EPSILON);
    assert!((default_cfg.latencies.l2_itlb_walk - 32.0).abs() < f64::EPSILON);
    assert!((default_cfg.latencies.l2_dtlb_walk - 32.0).abs() < f64::EPSILON);
    assert!((default_cfg.latencies.dram_fallback - 225.0).abs() < f64::EPSILON);
    assert!((default_cfg.latencies.lock_floor - 20.0).abs() < f64::EPSILON);
    assert!((default_cfg.latencies.stlf_penalty - 12.5).abs() < f64::EPSILON);
    assert!((default_cfg.latencies.line_split_penalty - 1.0).abs() < f64::EPSILON);
    assert_eq!(default_cfg.advisor.min_samples, 10);
    assert!((default_cfg.advisor.min_avg_c0_pct - 10.0).abs() < f64::EPSILON);
    assert!((default_cfg.advisor.min_inst_per_sec - 1.5e9).abs() < f64::EPSILON);
    assert!((default_cfg.retiring.uops_per_inst - 1.15).abs() < f64::EPSILON);
    assert!(default_cfg.profiler.auto_start_etw);
    assert_eq!(default_cfg.profiler.sample_rate_khz, 1);
    assert_eq!(default_cfg.profiler.max_nodes, 20_000);
    assert_eq!(default_cfg.profiler.default_burst_duration_sec, 5);

    let partial_toml = r#"
calibrated = true
default_preset = "tlb-only"

[latencies]
dram_fallback = 210.5

[profiler]
sample_rate_khz = 4
"#;
    let partial_cfg = parse_config(partial_toml).expect("partial TOML should parse");
    assert!(partial_cfg.calibrated);
    assert_eq!(partial_cfg.default_preset, "tlb-only");
    assert!((partial_cfg.latencies.dram_fallback - 210.5).abs() < f64::EPSILON);
    assert!((partial_cfg.latencies.l3_hit - 39.0).abs() < f64::EPSILON);
    assert_eq!(partial_cfg.profiler.sample_rate_khz, 4);
    assert_eq!(partial_cfg.profiler.max_nodes, 20_000);
    assert_eq!(partial_cfg.default_packs, PresetId::Balanced.packs());

    let serialized = to_toml_string(&partial_cfg).expect("TOML serialization should succeed");
    let round_tripped = parse_config(&serialized).expect("round-trip TOML should parse");
    assert_eq!(partial_cfg, round_tripped);
}
