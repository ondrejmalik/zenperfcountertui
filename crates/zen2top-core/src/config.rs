use serde::{Deserialize, Serialize};

use crate::packs::{MetricPack, PresetId};

/// Per-event cycle latency assumptions for AMD Zen 2 CPI attribution.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct LatencyConfig {
    pub l1_hit: f64,
    pub l2_hit: f64,
    pub l3_hit: f64,
    pub cross_ccx: f64,
    pub branch_mispredict: f64,
    pub l2_itlb_walk: f64,
    pub l2_dtlb_walk: f64,
    pub dram_fallback: f64,
    pub lock_floor: f64,
    pub stlf_penalty: f64,
    pub line_split_penalty: f64,
}

impl Default for LatencyConfig {
    fn default() -> Self {
        Self {
            l1_hit: 4.0,
            l2_hit: 12.0,
            l3_hit: 39.0,
            cross_ccx: 90.0,
            branch_mispredict: 17.0,
            l2_itlb_walk: 32.0,
            l2_dtlb_walk: 32.0,
            dram_fallback: 225.0,
            lock_floor: 20.0,
            stlf_penalty: 12.5,
            line_split_penalty: 1.0,
        }
    }
}

/// Evidence-gate thresholds for the diagnostic advisor engine.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AdvisorConfig {
    pub min_samples: u64,
    pub min_avg_c0_pct: f64,
    pub min_inst_per_sec: f64,
}

impl Default for AdvisorConfig {
    fn default() -> Self {
        Self {
            min_samples: 10,
            min_avg_c0_pct: 10.0,
            min_inst_per_sec: 1.5e9,
        }
    }
}

/// Retiring estimation parameters when `ExactRetiring` is not active.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RetiringConfig {
    pub uops_per_inst: f64,
}

impl Default for RetiringConfig {
    fn default() -> Self {
        Self {
            uops_per_inst: 1.15,
        }
    }
}

/// ETW / stack-sampling profiler defaults.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ProfilerConfig {
    pub auto_start_etw: bool,
    pub sample_rate_khz: u32,
    pub max_nodes: usize,
    pub default_burst_duration_sec: u64,
}

impl Default for ProfilerConfig {
    fn default() -> Self {
        Self {
            auto_start_etw: true,
            sample_rate_khz: 1,
            max_nodes: 20_000,
            default_burst_duration_sec: 5,
        }
    }
}

/// Full `config.toml` configuration schema for `zen2top`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Zen2Config {
    pub cpu_model: String,
    pub base_mhz: f64,
    pub logical_cpus: usize,
    pub latencies: LatencyConfig,
    pub advisor: AdvisorConfig,
    pub retiring: RetiringConfig,
    pub profiler: ProfilerConfig,
    pub calibrated: bool,
    pub default_preset: String,
    pub default_packs: Vec<MetricPack>,
    pub module_min_mib: f64,
}

impl Default for Zen2Config {
    fn default() -> Self {
        Self {
            cpu_model: "Ryzen 5 3600X".to_string(),
            base_mhz: 3800.0,
            logical_cpus: 12,
            latencies: LatencyConfig::default(),
            advisor: AdvisorConfig::default(),
            retiring: RetiringConfig::default(),
            profiler: ProfilerConfig::default(),
            calibrated: false,
            default_preset: PresetId::Balanced.slug().to_string(),
            default_packs: PresetId::Balanced.packs().to_vec(),
            module_min_mib: 4.0,
        }
    }
}

/// Parse a `Zen2Config` from TOML text, filling any omitted fields with defaults.
pub fn parse_config(input: &str) -> anyhow::Result<Zen2Config> {
    Ok(toml::from_str(input)?)
}

/// Serialize a `Zen2Config` to a pretty TOML string.
pub fn to_toml_string(config: &Zen2Config) -> anyhow::Result<String> {
    Ok(toml::to_string_pretty(config)?)
}
