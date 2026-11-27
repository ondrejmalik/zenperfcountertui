use zen2top_core::config::Zen2Config;
use zen2top_core::csv_parser::{
    parse_report_core_csv, parse_report_l3_csv, CoreCounters, CoreCsvRow, CsvSampleOptions,
    ParsedL3Csv,
};
use zen2top_core::diagnostics::TierCpiSummary;
use zen2top_core::metrics::{
    aggregate_smt_pairs, classify_smt_pair, compute_core_metrics, compute_cpi_stack,
    compute_retiring, compute_throughput, summarize_ccx, MetricHistory, RingBuffer, SmtPairState,
};
use zen2top_core::packs::MetricPack;

fn approx(a: f64, b: f64) {
    assert!((a - b).abs() < 1e-9, "expected {a} ~= {b}");
}

#[test]
fn throughput_reports_rates_ipc_cpi_and_never_nan() {
    let c = CoreCounters {
        inst: 6e9,
        aperf: 4e9,
        ..CoreCounters::default()
    };
    let t = compute_throughput(&c, 2.0);
    approx(t.inst_per_sec, 3e9);
    approx(t.cyc_per_sec, 2e9);
    approx(t.ipc, 1.5);
    approx(t.actual_cpi, 4.0 / 6.0);

    // `cycles` is used only when `aperf` is absent.
    let fallback = CoreCounters {
        inst: 3e9,
        cycles: 6e9,
        ..CoreCounters::default()
    };
    approx(compute_throughput(&fallback, 1.0).ipc, 0.5);

    let zero = compute_throughput(&CoreCounters::default(), 0.0);
    assert_eq!(zero.ipc, 0.0);
    assert_eq!(zero.actual_cpi, 0.0);
    assert_eq!(zero.inst_per_sec, 0.0);
}

#[test]
fn retiring_is_exact_with_pack_and_estimated_without() {
    let c = CoreCounters {
        inst: 6e9,
        aperf: 4e9,
        ret_uops: 9e9,
        ..CoreCounters::default()
    };
    let cfg = Zen2Config::default();

    // Exact: 9e9 / (6 * 4e9) = 37.5%.
    let exact = compute_core_metrics(&c, &cfg, &[MetricPack::ExactRetiring], None, 1.0);
    assert!(exact.retiring.exact);
    approx(exact.retiring.pct, 37.5);

    // Estimated: IPC 1.5 * 1.15 / 6 = 28.75%, and ret_uops must be ignored.
    let est = compute_core_metrics(&c, &cfg, &[MetricPack::Branches], None, 1.0);
    assert!(!est.retiring.exact);
    approx(est.retiring.pct, 28.75);

    // The uops-per-inst factor comes from config.
    approx(compute_retiring(&c, 2.0, false).pct, 50.0);
    // Never exceeds the 6-wide limit.
    let over = CoreCounters {
        aperf: 1e9,
        ret_uops: 9e9,
        ..CoreCounters::default()
    };
    approx(compute_retiring(&over, 1.15, true).pct, 100.0);
}

#[test]
fn exclusive_tiers_clamp_multiplexed_skew_to_zero() {
    let cfg = Zen2Config::default();
    // Multiplexing skew: L2 misses exceed L1 misses.
    let skewed = CoreCounters {
        inst: 1e6,
        aperf: 1e6,
        l1_dc_miss: 1000.0,
        l2_dc_miss: 3000.0,
        l1_ic_miss: 10.0,
        l2_ic_miss: 50.0,
        ..CoreCounters::default()
    };
    let s = compute_cpi_stack(&skewed, &cfg.latencies, None);
    assert_eq!(s.l2_dc.mpki, 0.0);
    assert_eq!(s.l2_dc.cpi, 0.0);
    assert_eq!(s.l2_ic.mpki, 0.0);
    assert_eq!(s.l2_ic.cpi, 0.0);
    assert_eq!(s.modeled_cpi, 0.0);

    // Normal case: (5000 - 2000) per 1M inst = 3.0 MPKI * 12 cyc L2 hit / 1000 = 0.036 CPI.
    let normal = CoreCounters {
        l1_dc_miss: 5000.0,
        l2_dc_miss: 2000.0,
        ..skewed
    };
    let n = compute_cpi_stack(&normal, &cfg.latencies, None);
    approx(n.l2_dc.mpki, 3.0);
    approx(n.l2_dc.cpi, 0.036);
}

#[test]
fn dram_tier_prefers_valid_live_latency_over_config_fallback() {
    let cfg = Zen2Config::default();
    let c = CoreCounters {
        inst: 1e6,
        aperf: 1e6,
        dc_dem_dram: 2000.0,
        ..CoreCounters::default()
    };
    // 2.0 MPKI * 100 cyc live = 0.2; fallback 225 cyc = 0.45.
    let live = compute_cpi_stack(&c, &cfg.latencies, Some(100.0));
    assert!(live.dram_latency_live);
    approx(live.dram.cpi, 0.2);
    let fallback = compute_cpi_stack(&c, &cfg.latencies, None);
    assert!(!fallback.dram_latency_live);
    approx(fallback.dram.cpi, 0.45);
    for invalid in [0.0, -5.0, f64::NAN, f64::INFINITY] {
        let s = compute_cpi_stack(&c, &cfg.latencies, Some(invalid));
        assert!(!s.dram_latency_live, "{invalid} must fall back");
        approx(s.dram.cpi, 0.45);
    }
}

fn stack_counters(aperf: f64) -> CoreCounters {
    CoreCounters {
        inst: 1e9,
        aperf,
        branch_miss: 5e6,
        l1_ic_miss: 4e6,
        l2_ic_miss: 1e6,
        l2_itlb_miss: 1e6,
        l1_dc_miss: 20e6,
        l2_dc_miss: 5e6,
        dc_dem_l3: 10e6,
        dc_dem_dram: 4e6,
        l2_dtlb_miss: 2e6,
        ..CoreCounters::default()
    }
}

#[test]
fn cpi_stack_groups_flush_vs_mlp_and_is_never_normalized() {
    let cfg = Zen2Config::default();
    // Flush: 5*17 + 3*12 + 1*32 = 153 -> 0.153. MLP: 15*12 + 10*39 + 4*225 + 2*32 = 1534 -> 1.534.
    let hidden = compute_cpi_stack(&stack_counters(1e9), &cfg.latencies, None);
    approx(hidden.flush_cpi, 0.153);
    approx(hidden.mlp_cpi, 1.534);
    approx(hidden.modeled_cpi, 1.687);
    // Actual CPI stays 1.0 (not reduced by stalls) and modeled exceeds it: 0.687 hidden by OoO/MLP.
    approx(hidden.actual_cpi, 1.0);
    approx(hidden.hidden_ooo_mlp, 0.687);

    // Actual CPI 2.0 exceeds modeled 1.687: nothing is hidden and the gap is never negative.
    let exposed = compute_cpi_stack(&stack_counters(2e9), &cfg.latencies, None);
    approx(exposed.actual_cpi, 2.0);
    approx(exposed.modeled_cpi, 1.687);
    assert_eq!(exposed.hidden_ooo_mlp, 0.0);

    let summary = TierCpiSummary::from(&hidden);
    approx(summary.dram, 0.9);
    approx(summary.l3_hit, 0.39);
    approx(summary.l2_dc, 0.18);
    approx(summary.l2_ic, 0.036);
    approx(summary.branch, 0.085);
    approx(summary.l2_dtlb, 0.064);
    approx(summary.l2_itlb, 0.032);
}

#[test]
fn ring_buffer_wraps_and_sanitizes_samples() {
    let mut rb = RingBuffer::new(3);
    assert!(rb.is_empty());
    assert_eq!(rb.latest(), None);
    for v in 1..=5 {
        rb.push(f64::from(v));
    }
    assert_eq!(rb.len(), 3);
    assert_eq!(rb.capacity(), 3);
    assert_eq!(rb.to_vec(), vec![3.0, 4.0, 5.0]);
    assert_eq!(rb.latest(), Some(5.0));
    rb.push(f64::NAN);
    assert_eq!(rb.to_vec(), vec![4.0, 5.0, 0.0]);
    rb.clear();
    assert!(rb.is_empty());

    let mut tiny = RingBuffer::new(0);
    tiny.push(1.0);
    tiny.push(2.0);
    assert_eq!(tiny.capacity(), 1);
    assert_eq!(tiny.to_vec(), vec![2.0]);

    let cfg = Zen2Config::default();
    let mut hist = MetricHistory::new(2);
    for aperf in [1e9, 2e9, 4e9] {
        let m = compute_core_metrics(&stack_counters(aperf), &cfg, &[], None, 1.0);
        hist.push(&m);
    }
    assert_eq!(hist.ipc.to_vec(), vec![0.5, 0.25]);
    assert_eq!(hist.actual_cpi.to_vec(), vec![2.0, 4.0]);
    assert_eq!(hist.modeled_cpi.len(), 2);
}

fn row(cpu_id: usize, c0_pct: f64, ipc: f64) -> CoreCsvRow {
    CoreCsvRow {
        cpu_id,
        c0_pct,
        ipc,
        ..CoreCsvRow::default()
    }
}

#[test]
fn smt_pair_classification_uses_15_and_2_percent_thresholds() {
    assert_eq!(classify_smt_pair(15.0, 15.0), SmtPairState::BothActive);
    assert_eq!(classify_smt_pair(14.99, 80.0), SmtPairState::SingleThread);
    assert_eq!(classify_smt_pair(1.99, 1.99), SmtPairState::BothIdle);
    assert_eq!(classify_smt_pair(2.0, 1.0), SmtPairState::SingleThread);
    assert_eq!(classify_smt_pair(1.9, 50.0), SmtPairState::SingleThread);

    // Sibling pairs come from topology discovery, not even/odd assumptions; CPU 9 has no row.
    let rows = [
        row(0, 88.0, 1.42),
        row(6, 40.0, 0.9),
        row(1, 1.0, 0.0),
        row(7, 0.5, 0.0),
        row(2, 5.0, 0.3),
    ];
    let pairs = aggregate_smt_pairs(&rows, &[(0, 6), (1, 7), (2, 9)]);
    assert_eq!(pairs.len(), 3);
    assert_eq!(pairs[0].state, SmtPairState::BothActive);
    approx(pairs[0].ipc_a, 1.42);
    assert_eq!(pairs[1].state, SmtPairState::BothIdle);
    assert!(pairs[1].idle_a() && pairs[1].idle_b());
    assert_eq!(pairs[2].state, SmtPairState::SingleThread);
    assert!(!pairs[2].idle_a() && pairs[2].idle_b());
    assert_eq!(pairs[2].cpu_b, 9);
}

#[test]
fn ccx_summary_joins_core_and_l3_parses_per_ccx() {
    let core_csv = "\
core,core/dc_dem_dram=(0x430843),core/aperf=(aperf),core/mperf=(mperf),core/inst=(irperf)
Core 0,8000000,4000000000,3800000000,8000000000
Core 6,8000000,4000000000,3800000000,2000000000
";
    let l3_csv = "\
ccx,l3/l3_access=(0xFF0F00000040FF04),l3/l3_miss=(0xFF0F000000400104),l3/l3_lat=(0xFF0F000000400090),l3/l3_mtype=(0xFF0F000000401F9A)
CCX 0,1000,100,500,100
CCX 1,1000,500,1000,100
";
    let core = parse_report_core_csv(core_csv, &CsvSampleOptions::default()).expect("core csv");
    let l3 = parse_report_l3_csv(l3_csv, 4.0).expect("l3 csv");
    let out = summarize_ccx(&core, &l3);
    assert_eq!(out.len(), 2);

    // CCX0: IPC 2.0, 4.0 GHz, 8M DRAM per 8B inst = 1.0 MPKI, L3 hit 90%, 80 cyc / 20 ns.
    assert_eq!((out[0].ccx_id, out[0].cpu_count), (0, 1));
    approx(out[0].ipc, 2.0);
    approx(out[0].eff_ghz, 4.0);
    approx(out[0].dram_mpki, 1.0);
    approx(out[0].l3_hit_pct, 90.0);
    approx(out[0].l3_lat_cyc, 80.0);
    approx(out[0].l3_lat_ns, 20.0);

    // CCX1: IPC 0.5, 8M DRAM per 2B inst = 4.0 MPKI, L3 hit 50%, 160 cyc / 40 ns.
    approx(out[1].ipc, 0.5);
    approx(out[1].dram_mpki, 4.0);
    approx(out[1].l3_hit_pct, 50.0);
    approx(out[1].l3_lat_cyc, 160.0);
    approx(out[1].l3_lat_ns, 40.0);

    // Missing L3 data degrades to zeros instead of panicking.
    let no_l3 = summarize_ccx(&core, &ParsedL3Csv::default());
    assert_eq!(no_l3.len(), 2);
    assert_eq!(no_l3[0].l3_hit_pct, 0.0);
    approx(no_l3[0].dram_mpki, 1.0);
}
