#![forbid(unsafe_code)]

use std::fs;
use std::path::PathBuf;
use std::process::ExitCode;

use clap::Parser;
use zen2top_platform::core::HeadlessExitCode;
use zen2top_platform::{list_presets, run_headless_smoke, HeadlessSessionOptions};

/// Native Windows 11 Rust TUI & headless profiler for AMD Zen 2 hardware performance counters.
#[derive(Debug, Parser)]
#[command(name = "zen2top", version, about)]
struct Cli {
    /// Print all canonical PMU presets, slot counts, and mux groups as JSON and exit.
    #[arg(long)]
    print_presets: bool,

    /// Run non-interactive machine-readable capture without initializing terminal raw mode.
    #[arg(long)]
    headless: bool,

    /// Disable hardware PMU collection and run OS/bootstrap telemetry only.
    #[arg(long)]
    no_pmu: bool,

    /// PMU preset slug (e.g., full, kitchen-sink, balanced, tlb-only, mem-ccx-lab, micro-arch).
    #[arg(long, default_value = "balanced")]
    preset: String,

    /// Capture duration in seconds for `--headless` mode.
    #[arg(long, default_value_t = 15)]
    duration: u64,

    /// Output file path for `--headless` JSON report (`-` or omitted writes to stdout).
    #[arg(long)]
    json_report: Option<PathBuf>,
}

fn run(cli: Cli) -> Result<HeadlessExitCode, anyhow::Error> {
    if cli.print_presets {
        let presets = list_presets();
        println!("{}", serde_json::to_string_pretty(&presets)?);
        return Ok(HeadlessExitCode::Ok);
    }

    if cli.headless {
        let report = run_headless_smoke(&HeadlessSessionOptions {
            preset: cli.preset,
            no_pmu: cli.no_pmu,
            duration_sec: cli.duration,
        })?;
        let rendered = serde_json::to_string_pretty(&report)?;
        match cli.json_report {
            Some(path) if path.as_os_str() != "-" => {
                if let Some(parent) = path.parent() {
                    if !parent.as_os_str().is_empty() {
                        fs::create_dir_all(parent)?;
                    }
                }
                fs::write(path, format!("{rendered}\n"))?;
            }
            _ => println!("{rendered}"),
        }
        return Ok(HeadlessExitCode::Ok);
    }

    anyhow::bail!(
        "Interactive TUI mode is scheduled for v0.3-tui-live. Use --print-presets or --headless --no-pmu."
    );
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match run(cli) {
        Ok(code) => ExitCode::from(code.as_i32() as u8),
        Err(err) => {
            eprintln!("zen2top: {err}");
            ExitCode::from(HeadlessExitCode::RuntimeError.as_i32() as u8)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_parses_headless_flags() {
        let cli = Cli::try_parse_from([
            "zen2top",
            "--headless",
            "--no-pmu",
            "--preset",
            "tlb-only",
            "--duration",
            "1",
            "--json-report",
            "-",
        ])
        .expect("CLI flags should parse");
        assert!(cli.headless);
        assert!(cli.no_pmu);
        assert_eq!(cli.preset, "tlb-only");
        assert_eq!(cli.duration, 1);
    }

    #[test]
    fn cli_print_presets_returns_ok() {
        let cli = Cli::try_parse_from(["zen2top", "--print-presets"]).expect("should parse");
        let code = run(cli).expect("--print-presets should succeed");
        assert_eq!(code, HeadlessExitCode::Ok);
    }
}
