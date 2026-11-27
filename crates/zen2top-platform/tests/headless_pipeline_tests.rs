use std::collections::VecDeque;

use zen2top_platform::allocator::{AllocatorObservation, ObservedModule};
use zen2top_platform::core::baseline::{
    serialize_baseline_json, BaselineSnapshot, RawCumulativeCounters,
};
use zen2top_platform::core::packs::MetricPack;
use zen2top_platform::core::HeadlessExitCode;
use zen2top_platform::headless::{
    run_headless_capture, run_no_pmu_capture, CaptureRequest, RawProfilerSample,
};
use zen2top_platform::pmu::contention::{classify_occupant, PmcContentionReport, PmcOccupantKind};
use zen2top_platform::pmu::{PmuBackend, PmuCoordinator, PmuSample};
use zen2top_platform::symbols::{ModuleSymbols, RuntimeFunction, TieredSymbolResolver};

struct QueuePmuBackend {
    running: bool,
    samples: VecDeque<PmuSample>,
}

impl PmuBackend for QueuePmuBackend {
    fn start(&mut self) -> anyhow::Result<()> {
        self.running = true;
        Ok(())
    }
    fn stop(&mut self) -> anyhow::Result<()> {
        self.running = false;
        Ok(())
    }
    fn pause(&mut self) -> anyhow::Result<()> {
        self.running = false;
        Ok(())
    }
    fn resume(&mut self) -> anyhow::Result<()> {
        self.running = true;
        Ok(())
    }
    fn is_running(&self) -> bool {
        self.running
    }
    fn poll_sample(&mut self) -> anyhow::Result<Option<PmuSample>> {
        Ok(self.samples.pop_front())
    }
}

#[test]
fn no_pmu_capture_emits_full_schema_v1_report_with_allocator_and_evidence_gate() {
    let mut req = CaptureRequest {
        preset: "balanced".to_string(),
        no_pmu: true,
        duration_sec: 1,
        target_pid: Some(4242),
        target_name: Some("worker.exe".to_string()),
        allocator_obs: Some(AllocatorObservation {
            modules: vec![ObservedModule {
                name: "ucrtbase.dll".to_string(),
                exports: Vec::new(),
            }],
            has_crt_malloc: true,
            has_heap_alloc: true,
            has_virtual_alloc: false,
            ws_mib: 1200.0,
            peak_ws_mib: 1600.0,
            has_lock_memory_privilege: true,
            avail_phys_pct: 45.0,
            total_ram_gib: 32.0,
            ..AllocatorObservation::default()
        }),
        ..CaptureRequest::default()
    };
    req.win32_etw.gpu_3d_pct = Some(35.0);

    let (code, report) = run_no_pmu_capture(&req).expect("no-pmu capture should succeed");
    assert_eq!(code, HeadlessExitCode::Ok);
    assert_eq!(report.meta.schema_version, 1);
    assert!(report.meta.no_pmu);
    assert_eq!(report.meta.preset, "balanced");
    assert_eq!(report.meta.core_pmc_slots, 12);
    assert_eq!(report.meta.mux_groups, 2);
    assert!(!report.meta.evidence_gate_passed);
    assert_eq!(report.advisor.verdict_id, "insufficient_data");
    assert_eq!(
        report.target.allocator_detected.as_deref(),
        Some("Standard CRT / Win32 HeapAlloc")
    );
    assert!(report
        .target
        .rminject_eligibility
        .as_ref()
        .is_some_and(|e| e.can_relaunch));

    let json = serde_json::to_value(&report).expect("report serializes to JSON");
    assert!(json.get("meta").is_some());
    assert!(json.get("target").is_some());
    assert!(json.get("summary").is_some());
    assert!(json.get("win32_etw").is_some());
    assert!(json.get("advisor").is_some());
}

#[test]
fn mock_pmu_capture_aggregates_counters_baseline_diff_and_profiler_symbols() {
    let core_csv = "\
cpu,core/inst=(irperf),core/aperf=(aperf),core/mperf=(mperf),core/dc_dem_dram=(0x430843)\n\
0,4000000000,2000000000,1900000000,12000000\n\
6,4000000000,2000000000,1900000000,12000000\n";
    let l3_csv = "\
ccx,l3/l3_access=(0xFF0F00000040FF04),l3/l3_miss=(0xFF0F000000400104),l3/l3_lat=(0xFF0F000000400090),l3/l3_mtype=(0xFF0F000000401F9A)\n\
0,100000,20000,300000,20000\n\
1,100000,20000,300000,20000\n";

    let samples: VecDeque<_> = (0..10)
        .map(|i| PmuSample {
            timestamp_ms: (i + 1) * 1000,
            raw_csv_core: Some(core_csv.to_string()),
            raw_csv_l3: Some(l3_csv.to_string()),
            interval_sec: 1,
        })
        .collect();
    let mut coord = PmuCoordinator::new(QueuePmuBackend {
        running: false,
        samples,
    });

    let mut symbols = TieredSymbolResolver::new();
    symbols.register_module(ModuleSymbols {
        name: "app.exe".to_string(),
        base_addr: 0x7FF6_0000_0000,
        size_bytes: 16 * 1024 * 1024,
        pdata: vec![RuntimeFunction {
            begin_address: 0x1000,
            end_address: 0x1400,
        }],
        ..ModuleSymbols::default()
    });

    let baseline = BaselineSnapshot {
        name: "before".to_string(),
        enabled_packs: vec![MetricPack::DcDemand],
        core_pmc_slots: 2,
        mux_groups: 1,
        counters: RawCumulativeCounters {
            inst: 40_000_000_000,
            aperf: 25_000_000_000,
            mperf: 24_000_000_000,
            dc_dem_dram: 200_000_000,
            ..RawCumulativeCounters::default()
        },
        ..BaselineSnapshot::default()
    };
    assert!(serialize_baseline_json(&baseline).is_ok());

    let req = CaptureRequest {
        preset: "mem-ccx-lab".to_string(),
        no_pmu: false,
        duration_sec: 10,
        include_profiler: true,
        baseline: Some(baseline),
        profiler_samples: vec![RawProfilerSample {
            module: "app.exe".to_string(),
            rva: 0x1100,
            weight: 80,
            blocked_ms: None,
            waker: None,
        }],
        ..CaptureRequest::default()
    };

    let (code, report) = run_headless_capture(&req, Some(&mut coord), None, Some(&symbols))
        .expect("mock PMU capture should succeed");
    assert_eq!(code, HeadlessExitCode::Ok);
    assert!(!coord.backend().is_running());
    assert_eq!(report.meta.sample_count, 10);
    assert!(report.meta.evidence_gate_passed);
    assert!((report.summary.ipc - 2.0).abs() < 1e-6);
    assert!((report.summary.l3_hit_pct - 80.0).abs() < 1e-6);
    assert!((report.summary.l3_lat_cyc - 240.0).abs() < 1e-6);
    assert_eq!(report.summary.ccx_summary.len(), 2);
    assert_eq!(report.summary.smt_pairs.len(), 6);
    assert!(report.baseline_diff.is_some());
    let profiler = report.profiler.expect("profiler summary populated");
    assert_eq!(profiler.on_cpu_top[0].name, "app.exe!fn_0x1000");
}

#[test]
fn headless_capture_handles_exit_codes_1_2_and_3_deterministically() {
    // Exit code 2: target unavailable / exited before valid samples.
    let missing_req = CaptureRequest {
        target_name: Some("missing.exe".to_string()),
        target_missing_or_exited: true,
        ..CaptureRequest::default()
    };
    let (code2, rep2) =
        run_no_pmu_capture(&missing_req).expect("target unavailable returns code 2");
    assert_eq!(code2, HeadlessExitCode::TargetUnavailable);
    assert!(rep2.target.exited_early);

    // Exit code 3: PMC contention without eviction.
    let contention_req = CaptureRequest {
        no_pmu: false,
        contention: Some(PmcContentionReport {
            detected: true,
            occupants: vec![classify_occupant(
                PmcOccupantKind::CompetingProcess,
                "AMDuProfCLI.exe",
                Some(5150),
                None,
                None,
            )],
            summary: "PMCs busy".to_string(),
            remediation: "Run interactive --unlock-pmc or pass --no-pmu".to_string(),
        }),
        ..CaptureRequest::default()
    };
    let (code3, rep3) = run_no_pmu_capture(&contention_req).expect("contention returns code 3");
    assert_eq!(code3, HeadlessExitCode::PmcContention);
    assert!(rep3
        .meta
        .pmc_contention
        .as_ref()
        .is_some_and(|c| c.detected));

    // Exit code 1 / error path: invalid interval or live PMU without backend.
    let bad_interval = CaptureRequest {
        interval_sec: Some(3),
        ..CaptureRequest::default()
    };
    assert!(run_no_pmu_capture(&bad_interval).is_err());

    let unimplemented_pmu = CaptureRequest {
        no_pmu: false,
        ..CaptureRequest::default()
    };
    assert!(run_no_pmu_capture(&unimplemented_pmu).is_err());
}
