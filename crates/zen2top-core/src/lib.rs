#![forbid(unsafe_code)]

//! Pure platform-independent core domain layer for `zen2top`.
//!
//! Owns configuration schemas, AMD Zen 2 PMU packs and 6-slot bin-packing,
//! CSV parsing, Exclusive CPI Stack & Retiring % math, raw-cumulative baselines,
//! the pure evidence-gated `DiagnosticEngine`, and headless JSON v1 schemas.

pub mod baseline;
pub mod config;
pub mod csv_parser;
pub mod diagnostics;
pub mod packs;

use serde::{Deserialize, Serialize};

/// Current schema version for `--headless --json-report` output.
pub const HEADLESS_SCHEMA_VERSION: u32 = 1;

/// Deterministic process exit codes for `zen2top --headless` (see `AGENTS.md` §3.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(i32)]
pub enum HeadlessExitCode {
    /// Capture completed and JSON report written.
    Ok = 0,
    /// CLI argument error or unrecoverable runtime failure.
    RuntimeError = 1,
    /// Target process not found or exited before producing valid samples.
    TargetUnavailable = 2,
    /// PMC hardware is occupied; `--headless` never silently evicts.
    PmcContention = 3,
}

impl HeadlessExitCode {
    pub const fn as_i32(self) -> i32 {
        self as i32
    }
}

/// Summary metadata for one canonical Zen 2 PMU quick preset.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PresetSummary {
    pub slug: String,
    pub display_name: String,
    pub core_pmc_slots: u8,
    pub mux_groups: u8,
}

/// Returns the 6 canonical quick presets defined in `AGENTS.md` §3.2.
pub fn canonical_presets() -> Vec<PresetSummary> {
    vec![
        PresetSummary {
            slug: "full".to_string(),
            display_name: "Full".to_string(),
            core_pmc_slots: 18,
            mux_groups: 3,
        },
        PresetSummary {
            slug: "kitchen-sink".to_string(),
            display_name: "Kitchen Sink".to_string(),
            core_pmc_slots: 24,
            mux_groups: 4,
        },
        PresetSummary {
            slug: "balanced".to_string(),
            display_name: "Balanced Daily".to_string(),
            core_pmc_slots: 12,
            mux_groups: 2,
        },
        PresetSummary {
            slug: "tlb-only".to_string(),
            display_name: "TLB-Only".to_string(),
            core_pmc_slots: 6,
            mux_groups: 1,
        },
        PresetSummary {
            slug: "mem-ccx-lab".to_string(),
            display_name: "Mem + CCX Lab".to_string(),
            core_pmc_slots: 6,
            mux_groups: 1,
        },
        PresetSummary {
            slug: "micro-arch".to_string(),
            display_name: "Micro-Arch".to_string(),
            core_pmc_slots: 6,
            mux_groups: 1,
        },
    ]
}

/// Minimal `config.toml` bootstrap settings (expanded by `G-01`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct BootstrapConfig {
    pub calibrated: bool,
    pub default_preset: String,
    pub uops_per_inst: f64,
}

impl Default for BootstrapConfig {
    fn default() -> Self {
        Self {
            calibrated: false,
            default_preset: "balanced".to_string(),
            uops_per_inst: 1.15,
        }
    }
}

/// Parse a `BootstrapConfig` from TOML text with safe defaults.
pub fn parse_bootstrap_config(input: &str) -> anyhow::Result<BootstrapConfig> {
    Ok(toml::from_str(input)?)
}

/// Top-level metadata block for `zen2top --headless` JSON (`schema_version: 1`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HeadlessMeta {
    pub schema_version: u32,
    pub zen2top_version: String,
    pub preset: String,
    pub no_pmu: bool,
    pub duration_sec: u64,
    pub sample_count: u64,
    pub evidence_gate_passed: bool,
    pub evidence_gate_reason: String,
}

/// Machine-readable report envelope emitted by `zen2top --headless`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HeadlessReport {
    pub meta: HeadlessMeta,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_presets_match_spec_slugs_and_slot_counts() {
        let presets = canonical_presets();
        assert_eq!(presets.len(), 6);
        let slugs: Vec<&str> = presets.iter().map(|p| p.slug.as_str()).collect();
        assert_eq!(
            slugs,
            vec![
                "full",
                "kitchen-sink",
                "balanced",
                "tlb-only",
                "mem-ccx-lab",
                "micro-arch",
            ]
        );
        for preset in &presets {
            assert_eq!(preset.core_pmc_slots % 6, 0);
            assert_eq!(preset.core_pmc_slots / 6, preset.mux_groups);
        }
    }

    #[test]
    fn exit_codes_match_documented_contract() {
        assert_eq!(HeadlessExitCode::Ok.as_i32(), 0);
        assert_eq!(HeadlessExitCode::RuntimeError.as_i32(), 1);
        assert_eq!(HeadlessExitCode::TargetUnavailable.as_i32(), 2);
        assert_eq!(HeadlessExitCode::PmcContention.as_i32(), 3);
    }

    #[test]
    fn bootstrap_config_round_trips_with_defaults() {
        let cfg = parse_bootstrap_config("").expect("empty TOML should use defaults");
        assert!(!cfg.calibrated);
        assert_eq!(cfg.default_preset, "balanced");
        assert!((cfg.uops_per_inst - 1.15).abs() < f64::EPSILON);

        let serialized = toml::to_string(&cfg).expect("TOML serialization succeeds");
        let parsed = parse_bootstrap_config(&serialized).expect("round-trip TOML parses");
        assert_eq!(cfg, parsed);
    }

    #[test]
    fn headless_report_serializes_schema_version_one() {
        let report = HeadlessReport {
            meta: HeadlessMeta {
                schema_version: HEADLESS_SCHEMA_VERSION,
                zen2top_version: env!("CARGO_PKG_VERSION").to_string(),
                preset: "balanced".to_string(),
                no_pmu: true,
                duration_sec: 1,
                sample_count: 0,
                evidence_gate_passed: false,
                evidence_gate_reason: "insufficient_samples".to_string(),
            },
        };
        let json = serde_json::to_string(&report).expect("JSON serialization succeeds");
        let back: HeadlessReport = serde_json::from_str(&json).expect("JSON deserializes");
        assert_eq!(back.meta.schema_version, 1);
        assert_eq!(back, report);
    }
}
