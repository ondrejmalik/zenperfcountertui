//! PMU backend abstractions, coordinated burst execution, and PMC contention handling.

pub mod contention;

use serde::{Deserialize, Serialize};

/// One raw PMU telemetry sample emitted by a `PmuBackend`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PmuSample {
    pub timestamp_ms: u64,
    pub raw_csv_core: Option<String>,
    pub raw_csv_l3: Option<String>,
    pub interval_sec: u64,
}

/// Supported short-duration diagnostic burst profiles.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BurstKind {
    IbsOp,
    DramL3,
    BranchMiss,
    TlbWalk,
}

/// Parameters for a single coordinated diagnostic burst.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BurstRequest {
    pub kind: BurstKind,
    pub pid: Option<u32>,
    pub duration_sec: u64,
}

/// Output summary returned after a coordinated diagnostic burst completes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BurstResult {
    pub kind: BurstKind,
    pub sample_count: u64,
    pub summary: String,
}

/// Hardware/OS PMU streaming backend abstraction (e.g., `AMDuProfPcm`).
pub trait PmuBackend: Send {
    fn start(&mut self) -> anyhow::Result<()>;
    fn stop(&mut self) -> anyhow::Result<()>;
    fn pause(&mut self) -> anyhow::Result<()>;
    fn resume(&mut self) -> anyhow::Result<()>;
    fn is_running(&self) -> bool;
    fn poll_sample(&mut self) -> anyhow::Result<Option<PmuSample>>;
}

/// On-demand burst profiling backend abstraction (e.g., `AMDuProfCLI`).
pub trait BurstRunner {
    fn run_burst(&mut self, req: &BurstRequest) -> anyhow::Result<BurstResult>;
}

/// Coordinates exclusive PMC access between a primary `PmuBackend` and a `BurstRunner`.
///
/// Guarantees that continuous PMU sampling and diagnostic bursts never run concurrently.
#[derive(Debug)]
pub struct PmuCoordinator<B: PmuBackend> {
    backend: B,
    burst_active: bool,
}

impl<B: PmuBackend> PmuCoordinator<B> {
    /// Wraps a primary PMU backend with burst coordination.
    pub fn new(backend: B) -> Self {
        Self {
            backend,
            burst_active: false,
        }
    }

    /// Starts the underlying PMU backend unless a burst is currently active.
    pub fn start(&mut self) -> anyhow::Result<()> {
        if self.burst_active {
            anyhow::bail!("Cannot start primary PMU backend while a diagnostic burst is active.");
        }
        self.backend.start()
    }

    /// Stops the underlying PMU backend.
    pub fn stop(&mut self) -> anyhow::Result<()> {
        self.backend.stop()
    }

    /// Polls the next sample from the underlying PMU backend.
    pub fn poll_sample(&mut self) -> anyhow::Result<Option<PmuSample>> {
        if self.burst_active {
            return Ok(None);
        }
        self.backend.poll_sample()
    }

    /// Returns a shared reference to the underlying PMU backend.
    pub fn backend(&self) -> &B {
        &self.backend
    }

    /// Returns a mutable reference to the underlying PMU backend.
    pub fn backend_mut(&mut self) -> &mut B {
        &mut self.backend
    }

    /// Returns `true` while a coordinated diagnostic burst is in flight.
    pub fn is_burst_active(&self) -> bool {
        self.burst_active
    }

    /// Executes a diagnostic burst while ensuring the primary PMU backend is paused.
    ///
    /// An internal RAII `Drop` guard clears `burst_active` and resumes the primary
    /// backend if it was running before the burst, even on error or panic unwind.
    pub fn run_coordinated_burst<R: BurstRunner>(
        &mut self,
        runner: &mut R,
        req: &BurstRequest,
    ) -> anyhow::Result<BurstResult> {
        if self.burst_active {
            anyhow::bail!("Re-entrant diagnostic burst rejected: another burst is already active.");
        }

        let was_running = self.backend.is_running();
        if was_running {
            self.backend.pause()?;
        }

        self.burst_active = true;
        let _guard = ResumeGuard {
            coordinator: self,
            should_resume: was_running,
        };

        runner.run_burst(req)
    }
}

struct ResumeGuard<'a, B: PmuBackend> {
    coordinator: &'a mut PmuCoordinator<B>,
    should_resume: bool,
}

impl<B: PmuBackend> Drop for ResumeGuard<'_, B> {
    fn drop(&mut self) {
        self.coordinator.burst_active = false;
        if self.should_resume {
            let _ = self.coordinator.backend.resume();
        }
    }
}
