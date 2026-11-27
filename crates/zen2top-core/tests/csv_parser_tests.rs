use zen2top_core::csv_parser::{
    parse_report_core_csv, parse_report_l3_csv, CcxTopology, CsvSampleOptions,
};

fn approx_eq(a: f64, b: f64, eps: f64) {
    assert!(
        (a - b).abs() <= eps,
        "expected {a} to be within {eps} of {b}"
    );
}

#[test]
fn parses_multicore_amduprof_headers_and_ccx_splits() {
    let csv = "\
# AMDuProf core sample
core,core/dc_dem_dram=(0x430843),core/aperf=(aperf),core/mperf=(mperf),core/inst=(irperf),core/ret_uops=(0x4300C1)
Core 0,100,4000000000,3800000000,6000000000,7200000000
Core 1,200,2000000000,1900000000,2000000000,2400000000
Core 6,50,3800000000,3800000000,7600000000,8000000000

# partial row below must be ignored
Core 7,10,20
";
    let opts = CsvSampleOptions {
        affinity_mask: None,
        base_mhz: 3800.0,
        interval_sec: 1.0,
        topology: CcxTopology::zen2_ryzen_3600x(),
    };
    let parsed = parse_report_core_csv(csv, &opts).expect("valid core csv");
    assert_eq!(parsed.per_cpu.len(), 3);
    assert_eq!(parsed.ccx_totals.len(), 2);

    // Core 0: IPC = 6e9 / 4e9 = 1.5, CPI = 4/6 = 0.6667, Eff GHz = (4e9/3.8e9)*3.8 = 4.0, C0% = 100.0
    let c0 = &parsed.per_cpu[0];
    assert_eq!(c0.cpu_id, 0);
    assert_eq!(c0.ccx_id, 0);
    approx_eq(c0.counters.dc_dem_dram, 100.0, 1e-9);
    approx_eq(c0.ipc, 1.5, 1e-6);
    approx_eq(c0.actual_cpi, 4.0 / 6.0, 1e-6);
    approx_eq(c0.eff_ghz, 4.0, 1e-6);
    approx_eq(c0.c0_pct, 100.0, 1e-6);

    // Core 1: C0% = (1.9e9 / 3.8e9) * 100 = 50.0
    approx_eq(parsed.per_cpu[1].c0_pct, 50.0, 1e-6);

    // CCX0 aggregate (Core 0 + Core 1): inst=8e9, aperf=6e9, mperf=5.7e9, avg C0%=75.0
    let ccx0 = &parsed.ccx_totals[0];
    assert_eq!(ccx0.ccx_id, Some(0));
    assert_eq!(ccx0.cpu_count, 2);
    approx_eq(ccx0.counters.dc_dem_dram, 300.0, 1e-9);
    approx_eq(ccx0.ipc, 8.0 / 6.0, 1e-6);
    approx_eq(ccx0.eff_ghz, 4.0, 1e-6);
    approx_eq(ccx0.c0_pct, 75.0, 1e-6);

    // CCX1 aggregate (Core 6): inst=7.6e9, aperf=3.8e9, mperf=3.8e9, IPC=2.0, Eff GHz=3.8
    let ccx1 = &parsed.ccx_totals[1];
    assert_eq!(ccx1.ccx_id, Some(1));
    assert_eq!(ccx1.cpu_count, 1);
    approx_eq(ccx1.ipc, 2.0, 1e-6);
    approx_eq(ccx1.eff_ghz, 3.8, 1e-6);

    // Total aggregate
    assert_eq!(parsed.total.cpu_count, 3);
    approx_eq(parsed.total.counters.inst, 15_600_000_000.0, 1e-3);
    approx_eq(parsed.total.counters.aperf, 9_800_000_000.0, 1e-3);
    approx_eq(parsed.total.c0_pct, (100.0 + 50.0 + 100.0) / 3.0, 1e-6);
}

#[test]
fn affinity_mask_excludes_ccx1_cpus() {
    let csv = "\
cpu,aperf,mperf,inst
0,1000,1000,1500
5,1000,1000,1500
6,1000,1000,2000
11,1000,1000,2000
";
    let opts = CsvSampleOptions {
        affinity_mask: Some(0x003F), // CPUs 0..=5 only (CCX0)
        base_mhz: 3800.0,
        interval_sec: 1.0,
        topology: CcxTopology::zen2_ryzen_3600x(),
    };
    let parsed = parse_report_core_csv(csv, &opts).expect("valid core csv");
    assert_eq!(parsed.per_cpu.len(), 2);
    assert_eq!(parsed.ccx_totals.len(), 1);
    assert_eq!(parsed.ccx_totals[0].ccx_id, Some(0));
    assert_eq!(parsed.per_cpu[0].cpu_id, 0);
    assert_eq!(parsed.per_cpu[1].cpu_id, 5);
}

#[test]
fn zero_denominators_never_produce_nan_or_inf() {
    let csv = "\
cpu,aperf,mperf,cycles,inst
0,0,0,0,0
";
    let opts = CsvSampleOptions {
        affinity_mask: None,
        base_mhz: 0.0,
        interval_sec: 0.0,
        topology: CcxTopology::from_cpu_ccx_pairs(&[(0, 0)]),
    };
    let parsed = parse_report_core_csv(csv, &opts).expect("valid zero csv");
    let r = &parsed.per_cpu[0];
    assert!(r.ipc == 0.0 && r.ipc.is_finite());
    assert!(r.actual_cpi == 0.0 && r.actual_cpi.is_finite());
    assert!(r.eff_ghz == 0.0 && r.eff_ghz.is_finite());
    assert!(r.c0_pct == 0.0 && r.c0_pct.is_finite());

    let l3_csv = "ccx,l3_access,l3_miss,l3_lat,l3_mtype\nCCX 0,0,0,0,0\n";
    let l3 = parse_report_l3_csv(l3_csv, 0.0).expect("valid zero l3 csv");
    assert_eq!(l3.total.l3_hit_pct, 0.0);
    assert_eq!(l3.total.lat_cyc, 0.0);
    assert_eq!(l3.total.lat_ns, 0.0);
}

#[test]
fn parses_dual_ccx_l3_csv_and_computes_hit_and_latency() {
    let csv = "\
ccx,l3/l3_access=(0xFF0F00000040FF04),l3/l3_miss=(0xFF0F000000400104),l3/l3_lat=(0xFF0F000000400090),l3/l3_mtype=(0xFF0F000000401F9A)
CCX 0,1000,100,500,100
CCX 1,3000,300,1500,300
partial_row_only_two_cols,123
";
    let parsed = parse_report_l3_csv(csv, 4.0).expect("valid l3 csv");
    assert_eq!(parsed.per_ccx.len(), 2);
    // CCX0: hit = 90%, lat_cyc = (500 * 16) / 100 = 80.0, lat_ns = 80.0 / 4.0 = 20.0
    approx_eq(parsed.per_ccx[0].l3_hit_pct, 90.0, 1e-6);
    approx_eq(parsed.per_ccx[0].lat_cyc, 80.0, 1e-6);
    approx_eq(parsed.per_ccx[0].lat_ns, 20.0, 1e-6);
    // Unified total: access=4000, miss=400 -> 90%, lat=2000, mtype=400 -> 80 cyc / 20 ns
    approx_eq(parsed.total.l3_hit_pct, 90.0, 1e-6);
    approx_eq(parsed.total.lat_cyc, 80.0, 1e-6);
    approx_eq(parsed.total.lat_ns, 20.0, 1e-6);
}

#[test]
fn empty_csv_returns_error() {
    let opts = CsvSampleOptions::default();
    assert!(parse_report_core_csv("  \n# only comments\n", &opts).is_err());
    assert!(parse_report_l3_csv("", 4.0).is_err());
}
