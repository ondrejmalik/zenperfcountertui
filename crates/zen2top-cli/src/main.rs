#![forbid(unsafe_code)]

mod headless;

use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::Context;
use clap::{error::ErrorKind, Parser};
use zen2top_platform::core::{
    packs::{resolve_packs_csv, resolve_preset, MetricPack},
    HeadlessExitCode,
};

/// Native Windows 11 profiler for AMD Zen 2 hardware performance counters.
#[derive(Debug, Parser)]
#[command(name = "zen2top", version, about)]
struct Cli {
    /// List the canonical PMU presets as JSON.
    #[arg(long)]
    print_presets: bool,
    /// Write a machine-readable capture report.
    #[arg(long)]
    headless: bool,
    /// Disable hardware PMU collection.
    #[arg(long)]
    no_pmu: bool,
    /// Attach to a running process by executable name or PID.
    #[arg(long, conflicts_with = "launch")]
    target: Option<String>,
    /// Launch a child process to capture.
    #[arg(long, requires = "headless")]
    launch: Option<PathBuf>,
    /// Arguments to pass to the launched process after --.
    #[arg(last = true, requires = "launch")]
    launch_args: Vec<std::ffi::OsString>,
    /// Measure host latencies and save the calibration.
    #[arg(long, conflicts_with = "headless")]
    calibrate: bool,
    /// Prompt interactively before evicting a PMC occupant.
    #[arg(long, conflicts_with = "headless")]
    unlock_pmc: bool,
    /// Zen 2 PMU preset slug.
    #[arg(long, default_value = "balanced", value_parser = parse_preset)]
    preset: String,
    /// Comma-separated metric packs overriding the preset.
    #[arg(long, value_parser = parse_packs)]
    packs: Option<PackSelection>,
    /// Sampling interval in seconds (1, 2, or 5).
    #[arg(long, value_parser = parse_interval)]
    interval: Option<u64>,
    /// Compare the capture with a saved baseline.
    #[arg(long)]
    baseline: Option<PathBuf>,
    /// Save raw cumulative counters and capture metadata as a baseline.
    #[arg(long)]
    save_baseline: Option<PathBuf>,
    /// Load a .zen2sym.json symbol sidecar.
    #[arg(long)]
    symbols: Option<PathBuf>,
    /// Read configuration from a TOML file.
    #[arg(long)]
    config: Option<PathBuf>,
    /// Capture duration in seconds.
    #[arg(long, default_value_t = 15)]
    duration: u64,
    /// Seconds to wait for a launched child before capture.
    #[arg(long, requires = "launch")]
    warmup: Option<u64>,
    /// Write JSON to this path. Omit or use - for stdout.
    #[arg(long)]
    json_report: Option<PathBuf>,
    /// Include the available function profiling data.
    #[arg(long)]
    include_profiler: bool,
}

fn parse_preset(input: &str) -> anyhow::Result<String> {
    Ok(resolve_preset(input)
        .with_context(|| format!("unknown preset {input:?}"))?
        .slug()
        .to_owned())
}

fn parse_interval(input: &str) -> anyhow::Result<u64> {
    let seconds = input.parse()?;
    anyhow::ensure!(matches!(seconds, 1 | 2 | 5), "expected 1, 2, or 5");
    Ok(seconds)
}

fn run(cli: Cli) -> anyhow::Result<HeadlessExitCode> {
    if cli.print_presets {
        println!(
            "{}",
            serde_json::to_string_pretty(&zen2top_platform::list_presets())?
        );
        return Ok(HeadlessExitCode::Ok);
    }
    if cli.calibrate {
        anyhow::bail!("Host latency calibration is scheduled for v0.2-platform-win32-pmu.");
    }
    if cli.unlock_pmc {
        anyhow::bail!("Interactive PMC eviction is scheduled for v0.2-platform-win32-pmu.");
    }
    if cli.headless {
        return headless::run(cli);
    }
    anyhow::bail!("Interactive TUI mode is scheduled for v0.3-tui-live. Use --print-presets or --headless --no-pmu.");
}

fn main() -> ExitCode {
    let code = match Cli::try_parse() {
        Ok(cli) => run(cli).unwrap_or_else(|err| {
            eprintln!("zen2top: {err:#}");
            HeadlessExitCode::RuntimeError
        }),
        Err(error) => {
            let code = match error.kind() {
                ErrorKind::DisplayHelp | ErrorKind::DisplayVersion => HeadlessExitCode::Ok,
                _ => HeadlessExitCode::RuntimeError,
            };
            if let Err(write_error) = error.print() {
                eprintln!("zen2top: {write_error}");
                return ExitCode::FAILURE;
            }
            code
        }
    };
    ExitCode::from(code.as_i32() as u8)
}

#[cfg(test)]
#[path = "cli_tests.rs"]
mod tests;

#[derive(Clone, Debug)]
struct PackSelection(Vec<MetricPack>);

fn parse_packs(input: &str) -> anyhow::Result<PackSelection> {
    resolve_packs_csv(input).map(PackSelection)
}
