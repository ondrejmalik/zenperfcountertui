use std::{
    fs,
    io::{self, Write},
    path::Path,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::Context;
use zen2top_platform::{
    core::{
        baseline::{deserialize_baseline_json, serialize_baseline_json, BaselineSnapshot},
        config::parse_config,
        HeadlessExitCode,
    },
    pmu::contention::PmcContentionReport,
    run_no_pmu_capture,
    symbols::parse_sidecar_json,
    CaptureRequest,
};

use super::Cli;

pub(super) fn run(cli: Cli) -> anyhow::Result<HeadlessExitCode> {
    let mut req = CaptureRequest {
        config: cli
            .config
            .as_deref()
            .map(|path| {
                parse_config(&read(path)?).with_context(|| format!("parse {}", path.display()))
            })
            .transpose()?
            .unwrap_or_default(),
        preset: cli.preset,
        packs: cli.packs.map(|selection| selection.0),
        interval_sec: cli.interval,
        duration_sec: cli.duration,
        no_pmu: cli.no_pmu,
        include_profiler: cli.include_profiler,
        baseline: cli
            .baseline
            .as_deref()
            .map(|path| {
                deserialize_baseline_json(&read(path)?)
                    .with_context(|| format!("parse {}", path.display()))
            })
            .transpose()?,
        timestamp_utc: utc_timestamp(SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs()),
        ..Default::default()
    };

    if let Some(path) = &cli.symbols {
        parse_sidecar_json(&read(path)?).with_context(|| format!("parse {}", path.display()))?;
    }
    if let Some(target) = &cli.target {
        if let Some((name, pid)) = find_target(target)? {
            req.target_name = Some(name);
            req.target_pid = Some(pid);
        } else {
            req.target_name = Some(target.clone());
            req.target_missing_or_exited = true;
        }
    }
    let mut child = cli
        .launch
        .as_ref()
        .map(|exe| {
            anyhow::ensure!(
                req.no_pmu,
                "Live PMU collection requires --no-pmu in this milestone."
            );
            let child = Command::new(exe)
                .args(&cli.launch_args)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .with_context(|| format!("launch {}", exe.display()))?;
            req.target_pid = Some(child.id());
            req.target_name = exe
                .file_name()
                .map(|name| name.to_string_lossy().into_owned());
            Ok::<_, anyhow::Error>(CaptureChild(child))
        })
        .transpose()?;
    if let Some(child) = &mut child {
        let exited = child.wait_until(Duration::from_secs(cli.warmup.unwrap_or(0)))?
            || child.wait_until(Duration::from_secs(cli.duration))?;
        // The foundation runner has no live samples to retain after an early exit.
        req.target_missing_or_exited = exited;
        if !exited {
            child.stop()?;
        }
    }
    write_capture(
        &req,
        cli.json_report.as_deref(),
        cli.save_baseline.as_deref(),
        &mut io::stdout().lock(),
    )
}

fn write_capture(
    req: &CaptureRequest,
    report_path: Option<&Path>,
    baseline_path: Option<&Path>,
    stdout: &mut impl Write,
) -> anyhow::Result<HeadlessExitCode> {
    let (code, report) = run_no_pmu_capture(req)?;
    if code == HeadlessExitCode::Ok {
        if let Some(path) = baseline_path {
            let baseline = BaselineSnapshot {
                name: "capture".into(),
                timestamp_utc: report.meta.timestamp_utc.clone(),
                elapsed_sec: report.meta.elapsed_sec,
                sample_count: report.meta.sample_count,
                target_name: report.target.name.clone(),
                affinity_mask: report.target.affinity_mask,
                enabled_packs: report.meta.enabled_packs.clone(),
                core_pmc_slots: report.meta.core_pmc_slots,
                mux_groups: report.meta.mux_groups,
                counters: report.summary.raw_cumulative_counters.clone(),
                ..Default::default()
            };
            write_file(path, &serialize_baseline_json(&baseline)?)?;
        }
    }
    let json = serde_json::to_string_pretty(&report)?;
    match report_path {
        Some(path) if path.as_os_str() != "-" => write_file(path, &json)?,
        _ => writeln!(stdout, "{json}")?,
    }
    if let Some(PmcContentionReport { remediation, .. }) = &report.meta.pmc_contention {
        eprintln!("zen2top: {remediation}");
    }
    Ok(code)
}

fn read(path: &Path) -> anyhow::Result<String> {
    fs::read_to_string(path).with_context(|| format!("read {}", path.display()))
}

fn write_file(path: &Path, json: &str) -> anyhow::Result<()> {
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    fs::write(path, format!("{json}\n")).with_context(|| format!("write {}", path.display()))
}

#[cfg(windows)]
fn find_target(target: &str) -> anyhow::Result<Option<(String, u32)>> {
    let pid = target.parse::<u32>().ok();
    let output = Command::new("tasklist.exe")
        .args(["/FO", "CSV", "/NH"])
        .output()
        .context("list running processes with tasklist.exe")?;
    anyhow::ensure!(
        output.status.success(),
        "tasklist.exe failed ({})",
        output.status
    );
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(|line| {
            let (name, fields) = line.strip_prefix('"')?.split_once("\",\"")?;
            let process_id = fields.split('"').next()?.parse().ok()?;
            let matches = pid.map_or_else(
                || name.eq_ignore_ascii_case(target),
                |pid| pid == process_id,
            );
            matches.then(|| (name.to_owned(), process_id))
        }))
}

#[cfg(not(windows))]
fn find_target(_target: &str) -> anyhow::Result<Option<(String, u32)>> {
    anyhow::bail!("Process lookup requires Windows.")
}

struct CaptureChild(Child);

impl CaptureChild {
    fn wait_until(&mut self, duration: Duration) -> io::Result<bool> {
        let started = Instant::now();
        loop {
            if self.0.try_wait()?.is_some() {
                return Ok(true);
            }
            let remaining = duration.saturating_sub(started.elapsed());
            if remaining.is_zero() {
                return Ok(false);
            }
            thread::sleep(remaining.min(Duration::from_millis(25)));
        }
    }

    fn stop(&mut self) -> io::Result<()> {
        if self.0.try_wait()?.is_none() {
            if let Err(error) = self.0.kill() {
                if self.0.try_wait()?.is_none() {
                    return Err(error);
                }
            }
            self.0.wait()?;
        }
        Ok(())
    }
}

impl Drop for CaptureChild {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

fn utc_timestamp(seconds: u64) -> String {
    let mut days = seconds / 86_400;
    let mut year = 1970;
    let leap = |year| year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    while days >= 365 + u64::from(leap(year)) {
        days -= 365 + u64::from(leap(year));
        year += 1;
    }
    let mut month = 1;
    for days_in_month in [
        31,
        28 + u64::from(leap(year)),
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ] {
        if days < days_in_month {
            break;
        }
        days -= days_in_month;
        month += 1;
    }
    let day = days + 1;
    let hour = seconds / 3_600 % 24;
    let minute = seconds / 60 % 60;
    let second = seconds % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

#[cfg(test)]
#[path = "headless_tests.rs"]
mod tests;
