//! Platform layer seam for `zen2top`.
//!
//! Exposes hardware/OS telemetry backends (PMU, Win32, ETW, Allocators, Symbols,
//! Latency Calibration) and re-exports `zen2top_core` so `zen2top-cli` (`product`)
//! never bypasses the `platform` layer into `core` internals.

pub use zen2top_core as core;

pub mod pmu;

use crate::core::{HeadlessMeta, HeadlessReport, PresetSummary, HEADLESS_SCHEMA_VERSION};

/// Options for a non-interactive headless capture session.
#[derive(Debug, Clone)]
pub struct HeadlessSessionOptions {
    pub preset: String,
    pub no_pmu: bool,
    pub duration_sec: u64,
}

/// Returns all canonical Zen 2 PMU presets via the platform seam.
pub fn list_presets() -> Vec<PresetSummary> {
    core::canonical_presets()
}

/// Runs a deterministic `--no-pmu` bootstrap headless capture without touching OS hardware.
pub fn run_headless_smoke(opts: &HeadlessSessionOptions) -> anyhow::Result<HeadlessReport> {
    if !opts.no_pmu {
        anyhow::bail!("Live PMU collection is scheduled for v0.2-platform-win32-pmu; pass --no-pmu for v0.1 foundation smoke runs.");
    }
    Ok(HeadlessReport {
        meta: HeadlessMeta {
            schema_version: HEADLESS_SCHEMA_VERSION,
            zen2top_version: env!("CARGO_PKG_VERSION").to_string(),
            preset: opts.preset.clone(),
            no_pmu: opts.no_pmu,
            duration_sec: opts.duration_sec,
            sample_count: 0,
            evidence_gate_passed: false,
            evidence_gate_reason: "no_pmu_bootstrap_smoke".to_string(),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headless_smoke_succeeds_with_no_pmu() {
        let report = run_headless_smoke(&HeadlessSessionOptions {
            preset: "balanced".to_string(),
            no_pmu: true,
            duration_sec: 1,
        })
        .expect("no-pmu smoke capture should succeed");
        assert_eq!(report.meta.schema_version, 1);
        assert!(report.meta.no_pmu);
        assert!(!report.meta.evidence_gate_passed);
    }

    #[test]
    fn headless_smoke_rejects_unimplemented_live_pmu() {
        let err = run_headless_smoke(&HeadlessSessionOptions {
            preset: "balanced".to_string(),
            no_pmu: false,
            duration_sec: 1,
        })
        .expect_err("live PMU should fail closed until v0.2");
        assert!(err.to_string().contains("--no-pmu"));
    }
}
