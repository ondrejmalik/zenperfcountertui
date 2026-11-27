//! PMC hardware contention reporting, critical OS process protection, and safe eviction flows.

use serde::{Deserialize, Serialize};

use crate::core::HeadlessExitCode;

/// Classification of an entity currently holding PMC hardware counters.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PmcOccupantKind {
    EtwPmcSession,
    CompetingProcess,
    UnknownProtectedHolder,
}

/// Metadata describing a single PMC occupant and whether it may be evicted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PmcOccupant {
    pub kind: PmcOccupantKind,
    pub name: String,
    pub pid: Option<u32>,
    pub path: Option<String>,
    pub session_name: Option<String>,
    pub evictable: bool,
    pub refusal_reason: Option<String>,
}

/// Structured contention report surfaced to interactive UI or headless JSON output.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PmcContentionReport {
    pub detected: bool,
    pub occupants: Vec<PmcOccupant>,
    pub summary: String,
    pub remediation: String,
}

/// Critical Windows OS processes that must never be terminated or evicted.
pub const CRITICAL_OS_PROCESSES: [&str; 7] = [
    "system",
    "smss.exe",
    "csrss.exe",
    "wininit.exe",
    "services.exe",
    "lsass.exe",
    "svchost.exe",
];

/// Returns `true` if `name_or_path` refers to a critical OS process.
///
/// Strips Windows (`\`) and POSIX (`/`) directory prefixes, trims whitespace,
/// and compares ASCII case-insensitively against [`CRITICAL_OS_PROCESSES`].
pub fn is_critical_os_process(name_or_path: &str) -> bool {
    let trimmed = name_or_path.trim();
    if trimmed.is_empty() {
        return false;
    }
    let basename = trimmed.rsplit(['\\', '/']).next().unwrap_or(trimmed).trim();
    CRITICAL_OS_PROCESSES
        .iter()
        .any(|critical| basename.eq_ignore_ascii_case(critical))
}

fn occupant_is_critical_os_process(occupant: &PmcOccupant) -> bool {
    occupant.kind == PmcOccupantKind::CompetingProcess
        && (is_critical_os_process(&occupant.name)
            || occupant.path.as_deref().is_some_and(is_critical_os_process))
}

/// Builds a [`PmcOccupant`] with safety classification applied.
pub fn classify_occupant(
    kind: PmcOccupantKind,
    name: &str,
    pid: Option<u32>,
    path: Option<String>,
    session_name: Option<String>,
) -> PmcOccupant {
    let (evictable, refusal_reason) = match kind {
        PmcOccupantKind::CompetingProcess => {
            let is_critical =
                is_critical_os_process(name) || path.as_deref().is_some_and(is_critical_os_process);
            if is_critical {
                (
                    false,
                    Some(format!(
                        "Refused: '{name}' is a critical OS process and cannot be evicted."
                    )),
                )
            } else {
                (true, None)
            }
        }
        PmcOccupantKind::UnknownProtectedHolder => (
            false,
            Some("Refused: unknown or protected PMC holder cannot be safely evicted.".to_string()),
        ),
        PmcOccupantKind::EtwPmcSession => (true, None),
    };

    PmcOccupant {
        kind,
        name: name.to_string(),
        pid,
        path,
        session_name,
        evictable,
        refusal_reason,
    }
}

/// Outcome of resolving a PMC eviction prompt or headless contention check.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum EvictionDecision {
    PendingConfirmation,
    ConfirmedEvict,
    Declined,
    RefusedCriticalProcess,
    HeadlessExitContention,
}

/// Safe Default-No confirmation state machine for interactive and headless PMC contention.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvictionPromptState {
    report: PmcContentionReport,
    selected_confirm: bool,
}

impl EvictionPromptState {
    /// Creates a new prompt state defaulting to **No** (`selected_confirm = false`).
    pub fn new(report: PmcContentionReport) -> Self {
        Self {
            report,
            selected_confirm: false,
        }
    }

    /// Returns the underlying contention report.
    pub fn report(&self) -> &PmcContentionReport {
        &self.report
    }

    /// Returns `true` while the prompt remains in its safe Default-No state.
    pub fn is_default_no(&self) -> bool {
        !self.selected_confirm
    }

    /// Returns the current confirmation selection.
    pub fn selected_confirm(&self) -> bool {
        self.selected_confirm
    }

    /// Toggles the confirmation choice between No and Yes.
    pub fn toggle_choice(&mut self) {
        self.selected_confirm = !self.selected_confirm;
    }

    /// Explicitly sets the confirmation choice.
    pub fn set_confirm(&mut self, confirm: bool) {
        self.selected_confirm = confirm;
    }

    /// Returns all occupants that are eligible for eviction (never includes critical OS processes).
    pub fn evictable_occupants(&self) -> Vec<&PmcOccupant> {
        self.report
            .occupants
            .iter()
            .filter(|occ| occ.evictable && !occupant_is_critical_os_process(occ))
            .collect()
    }

    /// Returns all occupants that are refused from eviction.
    pub fn refused_occupants(&self) -> Vec<&PmcOccupant> {
        self.report
            .occupants
            .iter()
            .filter(|occ| !occ.evictable || occupant_is_critical_os_process(occ))
            .collect()
    }

    /// Resolves an interactive eviction prompt.
    ///
    /// Returns [`EvictionDecision::Declined`] unless `selected_confirm` is `true`.
    /// Even when confirmed, refuses if any critical OS process is present or if no
    /// evictable target exists.
    pub fn resolve_interactive(&self) -> EvictionDecision {
        if !self.selected_confirm {
            return EvictionDecision::Declined;
        }

        let has_critical = self
            .report
            .occupants
            .iter()
            .any(occupant_is_critical_os_process);

        if has_critical || self.evictable_occupants().is_empty() {
            return EvictionDecision::RefusedCriticalProcess;
        }

        EvictionDecision::ConfirmedEvict
    }

    /// Resolves contention in `--headless` mode without ever evicting any occupant.
    pub fn resolve_headless(&self) -> (HeadlessExitCode, PmcContentionReport) {
        (HeadlessExitCode::PmcContention, self.report.clone())
    }
}

/// Platform executor capable of evicting a single approved PMC occupant.
pub trait EvictionExecutor {
    fn evict_occupant(&mut self, occupant: &PmcOccupant) -> anyhow::Result<()>;
}

/// Applies eviction only when interactive mode is active, confirmed, and free of critical OS targets.
pub fn apply_confirmed_eviction<E: EvictionExecutor>(
    state: &EvictionPromptState,
    headless: bool,
    executor: &mut E,
) -> anyhow::Result<EvictionDecision> {
    if headless {
        return Ok(EvictionDecision::HeadlessExitContention);
    }

    let decision = state.resolve_interactive();
    if decision != EvictionDecision::ConfirmedEvict {
        return Ok(decision);
    }

    for occupant in state.evictable_occupants() {
        executor.evict_occupant(occupant)?;
    }

    Ok(EvictionDecision::ConfirmedEvict)
}
