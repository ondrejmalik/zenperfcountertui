use crate::packs::MetricPack;

use super::{
    ActionScope, Confidence, DiagnosticInput, EstGain, Finding, HealthyCheck, RuleSignals, Severity,
};

struct Meta(
    &'static str,
    &'static str,
    bool,
    ActionScope,
    Confidence,
    u8,
    &'static str,
    &'static str,
    &'static str,
    &'static str,
);

const METAS: [Meta; 10] = [
    Meta("win32.gpu_bound", "GPU Saturation", true, ActionScope::OsTui, Confidence::High, 1, "FPS gated by GPU",
        "CPU tuning will not lift average FPS while GPU 3D is saturated.",
        "CPU/memory optimizations remain hidden behind GPU frame-time ceiling until GPU load drops below 97%.",
        "Lower render resolution, enable upscaling (DLSS/FSR), or reduce shader/shadow quality."),
    Meta("win32.dpc_irq_collision", "Interrupts & DPC", false, ActionScope::OsTui, Confidence::High, 6, "1% lows / jitter",
        "Eliminating driver interrupts on hot workload cores cuts micro-stutter.",
        "Preempts user threads, flushes L1/L2 state, and inflates tail frametimes.",
        "Move NIC/GPU/audio MSI-X affinity off hot workload cores or pin the workload away from CPU0."),
    Meta("win32.noisy_neighbor", "Background Contention", false, ActionScope::OsTui, Confidence::High, 6, "L3 + A/B stability",
        "Stops background cache thrashing and scheduling interference.",
        "Evicts shared Zen 2 L3 cache lines and skews A/B benchmark comparisons.", ""),
    Meta("win32.priority_ecoqos", "Scheduling & QoS", false, ActionScope::OsTui, Confidence::High, 6, "Boost / quantum",
        "Restores normal scheduler priority and CPU boost residency.",
        "Caps clock boost, shrinks scheduler quanta, and starves threads under load.",
        "Disable Efficiency Mode (EcoQoS) and set process priority to Normal or Above Normal."),
    Meta("win32.hard_page_faults", "Memory Pressure", false, ActionScope::OsHw, Confidence::High, 4, "Eliminates I/O hitch",
        "Avoids millisecond-scale disk-backed page-in stalls.",
        "Blocks faulting threads on storage I/O, causing severe frametime hitches.",
        "Close memory-heavy background apps or add physical RAM to stop pagefile paging."),
    Meta("win32.ctx_sw_lock_storm", "Scheduler & Locks", false, ActionScope::CodeOs, Confidence::Med, 6, "-sys% / tail latency",
        "Reducing lock contention cuts kernel overhead and wake-up jitter.",
        "Inflates kernel CPU% and pollutes private L1/L2 caches on every reschedule.",
        "Reduce oversubscribed worker threads, shard contended mutexes, or use lock-free/reader-writer primitives."),
    Meta("win32.composed_flip", "Display Presentation", false, ActionScope::OsTui, Confidence::High, 6, "-DWM latency",
        "Switching to Independent Flip removes an extra DWM compositor frame.",
        "Adds 1+ frame of input latency and increases VSync/compositor pacing jitter.",
        "Use DXGI flip-model borderless or exclusive fullscreen, enable Optimizations for Windowed Games, and disable conflicting overlays."),
    Meta("win32.jit_4k_itlb_residual", "JIT / iTLB", false, ActionScope::CodeOs, Confidence::High, 3, "Avoids futile IFEO",
        "Static PE images are already 2M-backed; remaining iTLB misses come from JIT code.",
        "4K JIT pages fragment the 512-entry Zen 2 L2 iTLB and cause repeated page-table walks.",
        "Enable large-page JIT code-cache support in the runtime/VM rather than adding more static IFEO DLL entries."),
    Meta("win32.disk_io_stall", "Storage I/O", false, ActionScope::OsHw, Confidence::High, 4, "Isolates I/O hitch",
        "Separates storage asset-streaming stutters from CPU micro-arch bottlenecks.",
        "Synchronous asset loads and WrPageIn waits stall main/render threads regardless of CPU IPC.",
        "Move assets/pagefile to a fast NVMe SSD, warm shader/asset caches, and pause background disk scanners."),
    Meta("win32.frametime_spike_correlator", "Frame Pacing", false, ActionScope::OsTui, Confidence::Med, 6, "1% / 0.1% lows",
        "Addressing correlated OS/memory/presentation culprits smooths frame pacing.",
        "Even brief spikes ruin perceived smoothness despite high average FPS.",
        "Resolve the correlated OS/hardware findings above first, then re-verify 1% and 0.1% lows."),
];

struct Cx<'a> {
    inp: &'a DiagnosticInput,
    findings: &'a mut Vec<Finding>,
    healthy: &'a mut Vec<HealthyCheck>,
    signals: &'a mut RuleSignals,
}

impl Cx<'_> {
    fn emit(
        &mut self,
        i: usize,
        sc: (Severity, Option<Confidence>, f64),
        [title, key_metric, why]: [String; 3],
        action: Option<String>,
        obs: Vec<(&str, String)>,
    ) {
        let m = &METAS[i];
        self.findings.push(Finding {
            rule_id: m.0.into(),
            category: m.1.into(),
            is_primary_anchor: m.2,
            severity: sc.0,
            scope: m.3,
            confidence: sc.1.unwrap_or(m.4),
            impact: sc.2,
            title,
            key_metric,
            est_gain: EstGain::Qualitative {
                label: m.6.into(),
                detail: m.7.into(),
            },
            why,
            action: action.unwrap_or_else(|| m.9.into()),
            cascade: m.8.into(),
            jump_tab: m.5,
            observed_metrics: obs.into_iter().map(|(k, v)| (k.into(), v)).collect(),
            profiler_note: None,
        });
    }

    fn ok(&mut self, i: usize, label: &str, observed_summary: String) {
        self.healthy.push(HealthyCheck {
            rule_id: METAS[i].0.into(),
            label: label.into(),
            observed_summary,
        });
    }
}

fn pick<T>(cond: bool, a: T, b: T) -> T {
    if cond {
        a
    } else {
        b
    }
}

fn max_dpc_irq(inp: &DiagnosticInput) -> f64 {
    let n = inp.core_dpc_pct.len().max(inp.core_irq_pct.len());
    (0..n)
        .map(|i| {
            inp.core_dpc_pct.get(i).copied().unwrap_or(0.0)
                + inp.core_irq_pct.get(i).copied().unwrap_or(0.0)
        })
        .fold(0.0_f64, f64::max)
}

/// Evaluate all Zero-PMC Win32/ETW diagnostic rules and populate Verified Healthy checks.
pub fn evaluate_win32_rules(
    input: &DiagnosticInput,
    findings: &mut Vec<Finding>,
    verified_healthy: &mut Vec<HealthyCheck>,
    signals: &mut RuleSignals,
) {
    let mut cx = Cx {
        inp: input,
        findings,
        healthy: verified_healthy,
        signals,
    };
    eval_gpu_dpc_qos(&mut cx);
    eval_mem_io_locks(&mut cx);
    eval_flip_jit_spikes(&mut cx);
}

fn eval_gpu_dpc_qos(cx: &mut Cx<'_>) {
    let inp = cx.inp;
    if let Some(gpu) = inp.gpu_3d_pct {
        let hot = inp.hottest_cpu_c0();
        if gpu >= 97.0 && hot < 75.0 {
            cx.signals.gpu_bound = true;
            let t = ["GPU-Bound Workload (CPU Headroom Available)".into(), format!("GPU 3D {gpu:.1}% | Hottest CPU C0 {hot:.1}%"), format!("GPU 3D engine is saturated at {gpu:.1}% while the hottest CPU core is only at {hot:.1}% C0.")];
            let obs = vec![
                ("GPU 3D", format!("{gpu:.1}%")),
                ("Hottest CPU C0", format!("{hot:.1}%")),
            ];
            cx.emit(0, (Severity::Hi, None, gpu), t, None, obs);
        } else {
            let sum = format!("GPU 3D {gpu:.1}%, hottest CPU C0 {hot:.1}%");
            cx.ok(0, pick(gpu < 97.0, "GPU <97%", "GPU/CPU Balanced"), sum);
        }
    }
    if !inp.core_c0_pct.is_empty() && (!inp.core_dpc_pct.is_empty() || !inp.core_irq_pct.is_empty())
    {
        let mut worst: Option<(usize, f64, f64, f64, f64)> = None;
        let (mut any_hot, mut hot_peak, mut all_peak) = (false, 0.0_f64, 0.0_f64);
        for (i, &c0) in inp.core_c0_pct.iter().enumerate() {
            let (dpc, irq) = (
                inp.core_dpc_pct.get(i).copied().unwrap_or(0.0),
                inp.core_irq_pct.get(i).copied().unwrap_or(0.0),
            );
            let tot = dpc + irq;
            all_peak = all_peak.max(tot);
            if c0 >= 60.0 {
                any_hot = true;
                hot_peak = hot_peak.max(tot);
                if tot >= 5.0 && worst.is_none_or(|w| tot > w.4) {
                    worst = Some((i, c0, dpc, irq, tot));
                }
            }
        }
        if let Some((core, c0, dpc, irq, tot)) = worst {
            let sev = pick(tot >= 8.0, Severity::Hi, Severity::Md);
            let t = [format!("DPC/IRQ Collision on Active Core CPU{core}"), format!("CPU{core}: C0 {c0:.1}%, DPC+IRQ {tot:.1}%"), format!("Core CPU{core} is busy ({c0:.1}% C0) while spending {tot:.1}% time in DPC ({dpc:.1}%) and IRQ ({irq:.1}%).")];
            let obs = vec![
                ("Core", format!("CPU{core}")),
                ("Core C0", format!("{c0:.1}%")),
                ("DPC+IRQ", format!("{tot:.1}%")),
            ];
            cx.emit(1, (sev, None, tot * 5.0), t, None, obs);
        } else if any_hot {
            let s = format!("Peak hot-core DPC+IRQ {hot_peak:.1}%");
            cx.ok(1, "DPC/IRQ <5%", s);
        } else {
            let s = format!("No >=60% C0 cores; peak DPC+IRQ {all_peak:.1}%");
            cx.ok(1, "DPC/IRQ Clear", s);
        }
    }
    let logical = inp.config.logical_cpus.max(1) as f64;
    let top = inp
        .noisy_neighbors
        .iter()
        .filter(|(n, _, _)| {
            !n.trim().is_empty() && !n.trim().eq_ignore_ascii_case("System Idle Process")
        })
        .max_by(|a, b| a.2.total_cmp(&b.2));
    if let Some((name, pid, pct)) = top.filter(|(_, _, p)| *p >= 5.0 || *p * logical >= 50.0) {
        let one = *pct * logical;
        let t = [format!("Noisy Background Process: {name} (PID {pid})"), format!("{pct:.1}% sys CPU (~{one:.0}% of 1 core)"), format!("{name} (PID {pid}) is consuming {pct:.1}% total system CPU (~{one:.0}% of a logical core).")];
        let act = format!("Close, pause, or lower priority/affinity of {name} (PID {pid}) during profiling or latency-sensitive runs.");
        let obs = vec![
            ("Process", format!("{name} (PID {pid})")),
            ("Sys CPU", format!("{pct:.1}%")),
            ("1-Core Equiv", format!("{one:.0}%")),
        ];
        let sev = pick(*pct >= 15.0, Severity::Hi, Severity::Md);
        cx.emit(2, (sev, None, *pct * 3.0), t, Some(act), obs);
    } else {
        let s = format!(
            "Top background process {:.1}% sys CPU",
            top.map_or(0.0, |(_, _, p)| *p)
        );
        cx.ok(2, "No noisy neighbor", s);
    }
    let prio = inp.priority_class.trim().to_ascii_uppercase();
    let low = prio == "BELOW_NORMAL"
        || prio == "BELOW NORMAL"
        || prio == "BELOW_NORMAL_PRIORITY_CLASS"
        || prio == "IDLE"
        || prio == "IDLE_PRIORITY_CLASS";
    let eco = inp.ecoqos_active == Some(true);
    if eco || low {
        let rsn = match (eco, low) {
            (true, true) => format!("EcoQoS active and priority class {prio}"),
            (true, false) => "EcoQoS (Efficiency Mode) is active".into(),
            _ => format!("Priority class is {prio}"),
        };
        let why = format!("Target process is constrained: {rsn}.");
        let obs = vec![
            ("Priority", inp.priority_class.clone()),
            ("EcoQoS", format!("{:?}", inp.ecoqos_active)),
        ];
        let t = [
            "Target Throttled by Low Priority or EcoQoS".into(),
            rsn,
            why,
        ];
        cx.emit(3, (Severity::Hi, None, 60.0), t, None, obs);
    } else if !prio.is_empty() || inp.ecoqos_active == Some(false) {
        let (p, e) = (
            pick(prio.is_empty(), "Normal", inp.priority_class.trim()),
            pick(inp.ecoqos_active == Some(false), "off", "n/a"),
        );
        cx.ok(3, "Normal QoS", format!("Priority {p}, EcoQoS {e}"));
    }
}

fn eval_mem_io_locks(cx: &mut Cx<'_>) {
    let inp = cx.inp;
    let (hf, av, cm) = (
        inp.hard_page_faults_per_sec,
        inp.avail_phys_pct,
        inp.commit_pct,
    );
    let pop = av > 0.0
        || cm > 0.0
        || inp.target_ws_mib > 0.0
        || inp.soft_page_faults_per_sec > 0.0
        || inp.target_present;
    if hf >= 20.0 || (pop && av < 5.0) {
        let mut act = METAS[4].9.to_string();
        if inp.target_huge_mib > 0.0 {
            act.push_str(&format!(" Warning: {:.0} MiB of non-pageable locked huge pages is reducing available RAM for other processes.", inp.target_huge_mib));
        }
        let t = ["Hard Page Faults / Critical Physical RAM Pressure".into(), format!("{hf:.1} hard faults/s | Avail RAM {av:.1}%"), format!("System is hitting {hf:.1} hard page faults/s with {av:.1}% physical RAM available (commit {cm:.1}%).")];
        let obs = vec![
            ("Hard Faults/s", format!("{hf:.1}")),
            ("Avail Phys", format!("{av:.1}%")),
            ("Commit", format!("{cm:.1}%")),
        ];
        cx.emit(4, (Severity::Hi, None, hf.max(50.0)), t, Some(act), obs);
    } else if pop || hf > 0.0 {
        let s = format!("{hf:.1} hard faults/s, {av:.1}% RAM free");
        cx.ok(4, "Hard faults <20/s", s);
    }
    let (sw, sync) = (inp.ctx_sw_per_sec, inp.sync_wait_pct);
    if sw >= 50_000.0 && sync >= 40.0 {
        let wait = pick(
            inp.top_wait_reason.is_empty(),
            "unknown",
            &inp.top_wait_reason,
        );
        let t = ["Context-Switch & Lock Contention Storm".into(), format!("{sw:.0} ctx/s | Sync wait {sync:.1}%"), format!("High context-switch rate ({sw:.0}/s) coincides with {sync:.1}% synchronization wait (top wait: {wait}).")];
        let obs = vec![
            ("Ctx Sw/s", format!("{sw:.0}")),
            ("Sync Wait", format!("{sync:.1}%")),
        ];
        cx.emit(5, (Severity::Md, None, sync), t, None, obs);
    } else if sw > 0.0 {
        let s = format!("{sw:.0} ctx/s, {sync:.1}% sync wait");
        cx.ok(5, "Scheduler & Locks", s);
    }
    let (mb, iops, spk) = (inp.disk_read_mb_s, inp.disk_read_iops, inp.frametime_spikes);
    let sym = spk > 0
        || inp.cpu_sys_pct >= 10.0
        || hf >= 20.0
        || inp.top_wait_reason.eq_ignore_ascii_case("WrPageIn");
    if ((mb >= 50.0 || iops >= 1000.0) && sym) || mb >= 150.0 || iops >= 3000.0 {
        let (sev, imp) = (
            pick(mb >= 80.0 && spk > 0, Severity::Hi, Severity::Md),
            (mb * 0.4).max(iops / 100.0),
        );
        let t = ["Disk Read Streaming / Storage I/O Stall".into(), format!("{mb:.1} MB/s | {iops:.0} IOPS | {spk} spikes"), format!("Sustained disk reads ({mb:.1} MB/s, {iops:.0} IOPS) coincide with workload stalls or heavy I/O demand.")];
        let obs = vec![
            ("Disk Read", format!("{mb:.1} MB/s")),
            ("Disk IOPS", format!("{iops:.0}")),
            ("Spikes", spk.to_string()),
        ];
        cx.emit(8, (sev, None, imp), t, None, obs);
    } else if mb > 0.0 || iops > 0.0 {
        let s = format!("{mb:.1} MB/s, {iops:.0} IOPS");
        cx.ok(8, "Disk Streaming I/O", s);
    }
}

fn eval_flip_jit_spikes(cx: &mut Cx<'_>) {
    let inp = cx.inp;
    if let Some(pct) = inp.composed_flip_pct {
        if pct >= 80.0 {
            let t = ["DWM Composed Flip Active (No Independent Flip)".into(), format!("Composed Flip {pct:.1}%"), format!("{pct:.1}% of frames are routed through DWM composition instead of Direct/Independent Flip.")];
            let obs = vec![("Composed Flip", format!("{pct:.1}%"))];
            cx.emit(6, (Severity::Md, None, pct * 0.4), t, None, obs);
        } else {
            cx.ok(6, "Independent Flip", format!("Composed Flip {pct:.1}%"));
        }
    }
    if inp.has_pack(MetricPack::ItlbFull) {
        let (itlb, img, jit) = (
            inp.l2_itlb_mpki,
            inp.image_large_2m_pct,
            inp.jit_exec_4k_mib,
        );
        if itlb >= 0.35 && img >= 75.0 && jit >= 8.0 {
            let t = ["Residual L2 iTLB Misses from 4K JIT Executable Memory".into(), format!("L2 iTLB {itlb:.2} MPKI | JIT 4K {jit:.1} MiB | Images 2M {img:.0}%"), format!("PE images are {img:.0}% backed by 2 MiB pages, yet L2 iTLB misses remain {itlb:.2} MPKI alongside {jit:.1} MiB of 4K executable JIT regions.")];
            let obs = vec![
                ("L2 iTLB MPKI", format!("{itlb:.2}")),
                ("Images 2M", format!("{img:.0}%")),
                ("JIT 4K Exec", format!("{jit:.1} MiB")),
            ];
            cx.emit(7, (Severity::Md, None, itlb * 20.0), t, None, obs);
        } else if jit > 0.0 {
            let s = format!("L2 iTLB {itlb:.2} MPKI, JIT 4K {jit:.1} MiB");
            cx.ok(7, "JIT 4K iTLB", s);
        }
    }
    let spk = inp.frametime_spikes;
    if spk >= 5 {
        let mut c = Vec::new();
        if inp.hard_page_faults_per_sec >= 20.0 {
            c.push("hard page faults");
        }
        if inp.disk_read_mb_s >= 50.0 || inp.disk_read_iops >= 1000.0 {
            c.push("disk read I/O");
        }
        if max_dpc_irq(inp) >= 5.0 {
            c.push("DPC/IRQ spikes");
        }
        if inp.ctx_sw_per_sec >= 50_000.0 || inp.sync_wait_pct >= 40.0 {
            c.push("scheduler/lock contention");
        }
        if inp.tier_cpi.dram >= 0.35 || inp.dram_mpki >= 5.0 {
            c.push("DRAM stalls");
        }
        if inp.composed_flip_pct.is_some_and(|p| p >= 80.0) {
            c.push("DWM composed flip");
        }
        let any = !c.is_empty();
        let sum = if any {
            c.join(", ")
        } else {
            "no single OS/PMU culprit (check shader compile or internal frame hitch)".into()
        };
        let t = [format!("Frametime Spikes Detected ({spk})"), format!("{spk} spikes | Correlated: {sum}"), format!("Observed {spk} frametime spikes in the rolling window; concurrent telemetry points to: {sum}.")];
        let sev = pick(spk >= 10 && any, Severity::Md, Severity::Info);
        let conf = Some(pick(any, Confidence::Med, Confidence::Low));
        let obs = vec![("Frametime Spikes", spk.to_string()), ("Correlated", sum)];
        cx.emit(9, (sev, conf, spk as f64 * 2.0), t, None, obs);
    } else if inp.composed_flip_pct.is_some() {
        cx.ok(9, "Frame Pacing", format!("{spk} frametime spikes"));
    }
}
