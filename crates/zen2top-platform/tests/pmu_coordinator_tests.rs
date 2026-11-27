use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Arc, Mutex};

use zen2top_platform::core::HeadlessExitCode;
use zen2top_platform::pmu::contention::{
    apply_confirmed_eviction, classify_occupant, is_critical_os_process, EvictionDecision,
    EvictionExecutor, EvictionPromptState, PmcContentionReport, PmcOccupant, PmcOccupantKind,
};
use zen2top_platform::pmu::{
    BurstKind, BurstRequest, BurstResult, BurstRunner, PmuBackend, PmuCoordinator, PmuSample,
};

#[derive(Debug, Clone, PartialEq, Eq)]
enum CallEvent {
    Start,
    Pause,
    Burst,
    Resume,
    Stop,
}

struct MockPmuBackend {
    running: bool,
    log: Arc<Mutex<Vec<CallEvent>>>,
}

impl MockPmuBackend {
    fn new(log: Arc<Mutex<Vec<CallEvent>>>) -> Self {
        Self {
            running: false,
            log,
        }
    }
}

impl PmuBackend for MockPmuBackend {
    fn start(&mut self) -> anyhow::Result<()> {
        self.running = true;
        self.log.lock().expect("log lock").push(CallEvent::Start);
        Ok(())
    }

    fn stop(&mut self) -> anyhow::Result<()> {
        self.running = false;
        self.log.lock().expect("log lock").push(CallEvent::Stop);
        Ok(())
    }

    fn pause(&mut self) -> anyhow::Result<()> {
        self.running = false;
        self.log.lock().expect("log lock").push(CallEvent::Pause);
        Ok(())
    }

    fn resume(&mut self) -> anyhow::Result<()> {
        self.running = true;
        self.log.lock().expect("log lock").push(CallEvent::Resume);
        Ok(())
    }

    fn is_running(&self) -> bool {
        self.running
    }

    fn poll_sample(&mut self) -> anyhow::Result<Option<PmuSample>> {
        if !self.running {
            return Ok(None);
        }
        Ok(Some(PmuSample {
            timestamp_ms: 1_000,
            raw_csv_core: Some("core,0,1.25".to_string()),
            raw_csv_l3: None,
            interval_sec: 1,
        }))
    }
}

enum BurstBehavior {
    Succeed,
    Fail,
    Panic,
}

struct MockBurstRunner {
    behavior: BurstBehavior,
    log: Arc<Mutex<Vec<CallEvent>>>,
}

impl MockBurstRunner {
    fn new(behavior: BurstBehavior, log: Arc<Mutex<Vec<CallEvent>>>) -> Self {
        Self { behavior, log }
    }
}

impl BurstRunner for MockBurstRunner {
    fn run_burst(&mut self, req: &BurstRequest) -> anyhow::Result<BurstResult> {
        self.log.lock().expect("log lock").push(CallEvent::Burst);
        match self.behavior {
            BurstBehavior::Succeed => Ok(BurstResult {
                kind: req.kind,
                sample_count: 42,
                summary: "burst ok".to_string(),
            }),
            BurstBehavior::Fail => anyhow::bail!("simulated burst failure"),
            BurstBehavior::Panic => panic!("simulated burst panic"),
        }
    }
}

struct MockEvictionExecutor {
    evicted: Vec<String>,
}

impl MockEvictionExecutor {
    fn new() -> Self {
        Self {
            evicted: Vec::new(),
        }
    }
}

impl EvictionExecutor for MockEvictionExecutor {
    fn evict_occupant(&mut self, occupant: &PmcOccupant) -> anyhow::Result<()> {
        self.evicted.push(occupant.name.clone());
        Ok(())
    }
}

fn sample_burst_request() -> BurstRequest {
    BurstRequest {
        kind: BurstKind::IbsOp,
        pid: Some(1234),
        duration_sec: 3,
    }
}

#[test]
fn coordinated_burst_pauses_runs_and_resumes_without_overlap() {
    let log = Arc::new(Mutex::new(Vec::new()));
    let mut coordinator = PmuCoordinator::new(MockPmuBackend::new(Arc::clone(&log)));
    let mut runner = MockBurstRunner::new(BurstBehavior::Succeed, Arc::clone(&log));

    coordinator.start().expect("start should succeed");
    let result = coordinator
        .run_coordinated_burst(&mut runner, &sample_burst_request())
        .expect("burst should succeed");
    assert_eq!(result.sample_count, 42);
    assert!(!coordinator.is_burst_active());
    assert!(coordinator.backend().is_running());

    coordinator.stop().expect("stop should succeed");

    let events = log.lock().expect("log lock").clone();
    assert_eq!(
        events,
        vec![
            CallEvent::Start,
            CallEvent::Pause,
            CallEvent::Burst,
            CallEvent::Resume,
            CallEvent::Stop,
        ]
    );
}

#[test]
fn coordinated_burst_resumes_after_error() {
    let log = Arc::new(Mutex::new(Vec::new()));
    let mut coordinator = PmuCoordinator::new(MockPmuBackend::new(Arc::clone(&log)));
    let mut runner = MockBurstRunner::new(BurstBehavior::Fail, Arc::clone(&log));

    coordinator.start().expect("start should succeed");
    let err = coordinator
        .run_coordinated_burst(&mut runner, &sample_burst_request())
        .expect_err("burst error should propagate");
    assert!(err.to_string().contains("simulated burst failure"));
    assert!(!coordinator.is_burst_active());
    assert!(coordinator.backend().is_running());

    let events = log.lock().expect("log lock").clone();
    assert_eq!(
        events,
        vec![
            CallEvent::Start,
            CallEvent::Pause,
            CallEvent::Burst,
            CallEvent::Resume,
        ]
    );
}

#[test]
fn coordinated_burst_resumes_after_panic_unwind() {
    let log = Arc::new(Mutex::new(Vec::new()));
    let mut coordinator = PmuCoordinator::new(MockPmuBackend::new(Arc::clone(&log)));
    let mut runner = MockBurstRunner::new(BurstBehavior::Panic, Arc::clone(&log));

    coordinator.start().expect("start should succeed");

    let panic_result = catch_unwind(AssertUnwindSafe(|| {
        let _ = coordinator.run_coordinated_burst(&mut runner, &sample_burst_request());
    }));
    assert!(panic_result.is_err(), "burst panic should unwind");
    assert!(!coordinator.is_burst_active());
    assert!(coordinator.backend().is_running());

    let events = log.lock().expect("log lock").clone();
    assert_eq!(
        events,
        vec![
            CallEvent::Start,
            CallEvent::Pause,
            CallEvent::Burst,
            CallEvent::Resume,
        ]
    );
}

#[test]
fn critical_os_process_detection_handles_paths_and_casing() {
    assert!(is_critical_os_process(r"C:\Windows\System32\svchost.exe"));
    assert!(is_critical_os_process("CSRSS.EXE"));
    assert!(is_critical_os_process("  System  "));
    assert!(is_critical_os_process("lsass.exe"));
    assert!(is_critical_os_process("/Windows/System32/WinInit.exe"));
    assert!(!is_critical_os_process("AMDuProfCLI.exe"));
    assert!(!is_critical_os_process(
        r"C:\Program Files\AMD\AMDuProf\bin\AMDuProfCLI.exe"
    ));
}

#[test]
fn eviction_prompt_defaults_to_no_and_skips_executor() {
    let occupant = classify_occupant(
        PmcOccupantKind::CompetingProcess,
        "AMDuProfCLI.exe",
        Some(4242),
        Some(r"C:\Program Files\AMD\AMDuProf\bin\AMDuProfCLI.exe".to_string()),
        None,
    );
    assert!(occupant.evictable);

    let report = PmcContentionReport {
        detected: true,
        occupants: vec![occupant],
        summary: "PMC counters are occupied by AMDuProfCLI.exe".to_string(),
        remediation: "Stop AMDuProfCLI.exe or confirm eviction.".to_string(),
    };

    let state = EvictionPromptState::new(report);
    assert!(state.is_default_no());
    assert_eq!(state.resolve_interactive(), EvictionDecision::Declined);

    let mut executor = MockEvictionExecutor::new();
    let decision =
        apply_confirmed_eviction(&state, false, &mut executor).expect("apply should succeed");
    assert_eq!(decision, EvictionDecision::Declined);
    assert!(executor.evicted.is_empty());
}

#[test]
fn eviction_prompt_refuses_critical_os_process_even_when_confirmed() {
    let critical = classify_occupant(
        PmcOccupantKind::CompetingProcess,
        "svchost.exe",
        Some(700),
        Some(r"C:\Windows\System32\svchost.exe".to_string()),
        None,
    );
    assert!(!critical.evictable);
    assert!(critical.refusal_reason.is_some());

    let report = PmcContentionReport {
        detected: true,
        occupants: vec![critical],
        summary: "PMC counters are held by svchost.exe".to_string(),
        remediation: "Cannot evict critical OS process.".to_string(),
    };

    let mut state = EvictionPromptState::new(report);
    state.set_confirm(true);
    assert!(!state.is_default_no());
    assert_eq!(
        state.resolve_interactive(),
        EvictionDecision::RefusedCriticalProcess
    );

    let mut executor = MockEvictionExecutor::new();
    let decision =
        apply_confirmed_eviction(&state, false, &mut executor).expect("apply should succeed");
    assert_eq!(decision, EvictionDecision::RefusedCriticalProcess);
    assert!(executor.evicted.is_empty());
}

#[test]
fn headless_contention_never_evicts_and_returns_exit_code_3() {
    let occupant = classify_occupant(
        PmcOccupantKind::CompetingProcess,
        "AMDuProfCLI.exe",
        Some(9001),
        Some(r"C:\Program Files\AMD\AMDuProf\bin\AMDuProfCLI.exe".to_string()),
        None,
    );
    let report = PmcContentionReport {
        detected: true,
        occupants: vec![occupant],
        summary: "PMC hardware occupied in headless mode".to_string(),
        remediation: "Close competing profiler and retry.".to_string(),
    };

    let mut state = EvictionPromptState::new(report);
    state.set_confirm(true);

    let (exit_code, returned_report) = state.resolve_headless();
    assert_eq!(exit_code, HeadlessExitCode::PmcContention);
    assert_eq!(exit_code.as_i32(), 3);
    assert!(returned_report.detected);
    assert_eq!(returned_report.occupants.len(), 1);
    assert_eq!(returned_report.occupants[0].name, "AMDuProfCLI.exe");

    let mut executor = MockEvictionExecutor::new();
    let decision =
        apply_confirmed_eviction(&state, true, &mut executor).expect("apply should succeed");
    assert_eq!(decision, EvictionDecision::HeadlessExitContention);
    assert!(executor.evicted.is_empty());
}
