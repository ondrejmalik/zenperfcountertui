use crate::diagnostics::{
    estimate_amdahl_gain, ActionScope, Confidence, DiagnosticInput, EstGain, Finding, HealthyCheck,
    RuleSignals, Severity, StallKind,
};
use crate::packs::MetricPack::{
    Branches, CrossCcxLocks, DcDemand, DcHwpf, DtlbFull, ItlbFull, L1L2Ic, L2Hwpf, OpCacheDecode,
    StlfSplits,
};
use ActionScope::{CodeBuild, CodeOs, HwBios, OsHw, OsTui};
use Confidence::{High, Med};
use Severity::{Hi, Info, Lo, Md};
use StallKind::{Flush, Mlp};
type Sm = (Severity, f64);
type Kg = (String, EstGain);

macro_rules! ids { ($($n:ident = $v:expr),+ $(,)?) => { $(const $n: usize = $v;)+ }; }
ids! {
    LARGE_PRIV = 0, LARGE_FRAG = 1, PE_ITLB = 2, MI_SPILL = 3, CRT_DTLB = 4, SMT = 5,
    CCX_SPREAD = 6, DRAM_Q = 7, DEM_DRAM = 8, BRANCH = 9, ICACHE = 10, CLOCK = 11, MUX_DIFF = 12,
    MUX_NOISE = 13, CCX_BOUNCE = 14, LOCKS = 15, OC_MASKED = 16, OC_THRASH = 17, STLF = 18,
    SPLITS = 19, F_DRAM_Q = 0, F_DEM_DRAM = 1, F_BRANCH = 2, F_UARCH = 3, F_FE = 4, F_CCX = 5,
    F_TLB = 6, F_SMT = 7
}

struct Spec(
    &'static str,
    &'static str,
    ActionScope,
    Confidence,
    u8,
    [&'static str; 4],
);

const OC_WHY: &str =
    "Hot loops spill out of Zen 2's 4K-entry OpCache into the narrower 4-wide x86 decoder.";
const OC_ACT: &str = "Reduce loop unrolling/inlining bloat and align hot loop entries to 32/64-byte boundaries (PGO/BOLT).";
const OC_CAS: &str =
    "Legacy decode limits frontend uop supply and increases branch recovery latency.";
const LP_CAS: &str =
    "Falls back to 4 KiB pages, increasing L2 iTLB/dTLB walks and page-table traffic.";
const NO_PRIV: &str = "No SeLockMemoryPrivilege";

macro_rules! specs {
    ($(($id:expr, $cat:expr, $sc:expr, $cf:expr, $tb:expr, $ti:expr, $wh:expr, $ac:expr, $ca:expr)),+ $(,)?) => {
        &[$(Spec($id, $cat, $sc, $cf, $tb, [$ti, $wh, $ac, $ca])),+]
    };
}

const SPECS: &[Spec] = specs! {
    ("pmu.large_page_failure_root_cause", "TLB Translation", OsTui, High, 3,
     "Large-page allocation failed: Missing SeLockMemoryPrivilege", "Windows rejected 2 MiB backing because the token lacks Lock Pages in Memory.",
     "Open secpol.msc -> Local Policies -> User Rights Assignment -> Lock Pages in Memory, add your account, and sign out/in.", LP_CAS),
    ("pmu.large_page_failure_root_cause", "TLB Translation", OsTui, High, 3,
     "Large-page allocation failed: Contiguous 2 MiB RAM Fragmentation", "SeLockMemoryPrivilege is granted, so 2 MiB allocation failed from fragmented RAM.",
     "Clear standby RAM or close memory-heavy background apps to free contiguous 2 MiB frames before relaunch.", LP_CAS),
    ("pmu.pe_itlb_4k_modules", "TLB Translation", OsTui, High, 3,
     "4 KiB PE modules driving instruction TLB walks", "Candidate 4 KiB modules exceed the 64-entry L1 iTLB and trigger L2 iTLB walks.",
     "Enable IFEO UseLargePages (Tab 3) for hot candidate DLLs and relaunch the target.", "Frontend stalls on instruction fetch translation before decode can issue uops."),
    ("pmu.mimalloc_spillover", "TLB Translation", OsTui, High, 4,
     "Mimalloc huge-page pool exhausted or spilling to 4 KiB OS arenas", "Mimalloc ran out of reserved huge-page headroom and fell back to 4 KiB OS arenas.",
     "Increase MIMALLOC_RESERVE_HUGE_OS_PAGES to cover peak working set and relaunch.", "4 KiB heap pages fragment dTLB entries and increase page-walk latency on random loads."),
    ("pmu.crt_heap_dtlb", "TLB Translation", OsTui, High, 4,
     "4 KiB CRT heap causing elevated L2 dTLB page walks", "Large 4 KiB working set exceeds Zen 2's 2048-entry L2 dTLB reach (~8 MiB at 4 KiB pages).",
     "Back the heap with 2 MiB large pages (e.g., mimalloc huge OS pages on Tab 4).", "Page walks serialize behind L2/L3 cache lookups and inflate effective load latency."),
    ("pmu.smt_hot_contention", "SMT Contention", OsTui, High, 6,
     "Hot SMT sibling contention while spare physical cores sit idle", "Active threads share a physical Zen 2 core via SMT while idle physical cores exist.",
     "Pin hot threads to separate physical cores (even logical CPUs) on Tab 6.", "SMT siblings split L1 caches, ROB entries, and execution ports, hurting tail latency."),
    ("pmu.cross_ccx_spread", "L3 / Cross-CCX", OsTui, High, 6,
     "Active threads spread across both Zen 2 CCXs despite fitting in one", "Zen 2 splits L3 into two 16 MiB CCX slices; cross-CCX sharing traverses Infinity Fabric.",
     "Pin target process affinity to a single CCX so active threads share one L3 cache.", "Cross-CCX probes add ~90-cycle transfers and reduce effective L3 hit rate."),
    ("pmu.dram_queueing_inflation", "Memory Bandwidth", HwBios, High, 2,
     "DRAM latency inflated by memory controller queueing", "Measured L3-miss latency exceeds unloaded DRAM baseline under heavy memory traffic.",
     "Verify dual-channel 1:1 FCLK:MCLK, tighten DDR4 subtimings (tRFC/tFAW/tRRDS), or reduce background bandwidth.", "Queueing delays stretch every demand miss and starve the Zen 2 ROB of ready uops."),
    ("pmu.demand_dram_pointer_chase", "Memory Latency", CodeBuild, High, 2,
     "Demand-dominated DRAM misses (pointer chasing / irregular access)", "Hardware prefetchers cannot predict irregular pointer-chasing or hash-table misses.",
     "Refactor hot structures to contiguous SoA/flat arrays, shrink node size, or add software prefetching.", "Dependent demand loads serialize on full DRAM latency and cap instruction-level parallelism."),
    ("pmu.branch_mispredict_bound", "Branch Prediction", CodeBuild, High, 1,
     "High branch misprediction rate flushing the pipeline", "Unpredictable branches trigger ~17-cycle Zen 2 pipeline flushes and discard speculative work.",
     "Use branchless CMOV/SIMD selection, sort data before branching, or apply Profile-Guided Optimization (PGO).", "Frequent flushes waste frontend decode bandwidth and drain the reorder buffer."),
    ("pmu.icache_capacity_pressure", "Frontend Code", CodeBuild, High, 2,
     "Instruction cache capacity pressure starving frontend fetch", "Hot code footprint exceeds L1i (32 KiB) and spills into L2/L3 instruction fetches.",
     "Apply PGO/LLVM-BOLT hot-cold code splitting, trim excessive inlining, and mark cold error paths #[cold].", "Frontend stalls waiting for instruction lines leave execution units underutilized."),
    ("pmu.clock_throttling", "Clock / Power", OsHw, High, 1,
     "Effective CPU frequency below base clock under active load", "Core clocks are throttled below rated base frequency despite sustained C0 residency.",
     "Check CPU thermals, VRM/PPT limits, and Windows Power Plan maximum processor state.", "Lower clock frequency scales down instruction throughput linearly even at constant IPC."),
    ("pmu.hygiene_mux_mismatch", "Measurement Hygiene", OsTui, High, 1,
     "MUX DIFF: Baseline and live PMU mux group counts differ", "Comparing runs with different PMU multiplexing ratios introduces counter scaling bias.",
     "Match the active metric pack preset to the baseline before interpreting A/B deltas.", "Mismatched mux windows can fabricate or hide small CPI and MPKI shifts."),
    ("pmu.hygiene_small_delta_mux", "Measurement Hygiene", OsTui, High, 1,
     "Small A/B IPC delta within PMU multiplexing noise floor", "Sub-3% IPC differences can be masked by time-sliced counter multiplexing error.",
     "Switch to a 0-mux (1 group) preset to verify small A/B optimizations cleanly.", "Noisy A/B deltas risk chasing measurement jitter instead of real wins."),
    ("uarch.cross_ccx_cache_bouncing", "Micro-Arch", CodeOs, Med, 1,
     "Cross-CCX cache-line bouncing across Infinity Fabric", "Modified cache lines bounce between Zen 2 CCXs (false sharing or shared atomics).",
     "Pad contended atomics to 64-byte cache lines or pin communicating threads to one CCX.", "Coherency probes stall loads/stores and consume Infinity Fabric bandwidth."),
    ("uarch.serialized_lock_contention", "Micro-Arch", CodeBuild, High, 1,
     "Serialized atomic/lock instructions throttling execution", "Frequent LOCK-prefixed atomics drain the store buffer and serialize memory ordering.",
     "Batch atomic updates into thread-local accumulators, shard locks, or use read-mostly fast paths.", "Serialized memory fences stall out-of-order retirement and amplify contention."),
    ("uarch.opcache_thrashing_masked", "Frontend Code", CodeBuild, High, 2, "OpCache thrashing (currently masked by DRAM stalls)", OC_WHY, OC_ACT, OC_CAS),
    ("uarch.opcache_thrashing", "Frontend Code", CodeBuild, High, 1, "OpCache thrashing forcing legacy x86 decode", OC_WHY, OC_ACT, OC_CAS),
    ("uarch.stlf_interlocks", "Micro-Arch", CodeBuild, High, 1,
     "Store-to-Load Forwarding (STLF) interlocks stalling loads", "Loads partially overlap recent stores and must wait for the store to commit to L1d.",
     "Match load/store widths and alignments (avoid partial-register or byte-then-qword aliasing).", "Failed forwarding replays the load through L1d and blocks dependent instructions."),
    ("uarch.cache_line_splits", "Micro-Arch", CodeBuild, High, 1,
     "Misaligned 64-byte cache-line splits consuming L1d ports", "Memory accesses straddle 64-byte cache-line boundaries, issuing two L1d ops per instruction.",
     "Align hot structs and SIMD buffers to 32/64 bytes (#[repr(align(64))]).", "Split accesses double L1d port pressure and increase load-store queue occupancy."),
};

struct Cx<'a>(&'a DiagnosticInput, &'a mut Vec<Finding>, [bool; 8]);

macro_rules! hit {
    ($cx:expr, $r:expr, $s:expr, $m:expr, $k:expr, @q $ql:expr, $qd:expr; $($ok:expr => $ov:expr),+ $(,)?) => {{
        let g = EstGain::Qualitative { label: $ql.into(), detail: $qd.into() };
        $cx.em($r, ($s, $m), ($k, g), &[$(($ok, $ov)),+])
    }};
    ($cx:expr, $r:expr, $s:expr, $m:expr, $k:expr, $g:expr; $($ok:expr => $ov:expr),+ $(,)?) => {
        $cx.em($r, ($s, $m), ($k, $g), &[$(($ok, $ov)),+])
    };
}

type Obs<'a> = &'a [(&'a str, String)];

impl Cx<'_> {
    fn em(&mut self, r: usize, sm: Sm, kg: Kg, o: Obs<'_>) -> &mut Finding {
        let p = &SPECS[r];
        self.1.push(Finding {
            rule_id: p.0.into(),
            category: p.1.into(),
            severity: sm.0,
            scope: p.2,
            confidence: p.3,
            impact: sm.1,
            jump_tab: p.4,
            title: p.5[0].into(),
            key_metric: kg.0,
            est_gain: kg.1,
            why: p.5[1].into(),
            action: p.5[2].into(),
            cascade: p.5[3].into(),
            observed_metrics: o.iter().map(|(x, y)| ((*x).into(), y.clone())).collect(),
            ..Finding::default()
        });
        self.1.last_mut().expect("pushed")
    }
    fn am(&self, t: f64, f: f64, k: StallKind, m: &str) -> EstGain {
        estimate_amdahl_gain(self.0.actual_cpi, self.0.modeled_cpi, t, f, k, m)
    }
    fn opt(&self, c: f64, f: f64, m: &str, l: &str, d: &str) -> EstGain {
        if (0.05..10.0).contains(&self.0.actual_cpi) {
            estimate_amdahl_gain(self.0.actual_cpi, self.0.actual_cpi.max(c), c, f, Mlp, m)
        } else {
            self.q(l, d)
        }
    }
    fn q(&self, l: &str, d: &str) -> EstGain {
        EstGain::Qualitative {
            label: l.into(),
            detail: d.into(),
        }
    }
}

/// Evaluate all PMU Core/Cache/TLB and active Micro-Arch pack rules.
pub fn evaluate(
    input: &DiagnosticInput,
    findings: &mut Vec<Finding>,
    _: &mut Vec<HealthyCheck>,
    signals: &mut RuleSignals,
) {
    if input.no_pmu {
        return;
    }
    let mut cx = Cx(input, findings, [false; 8]);
    eval_tlb(&mut cx);
    eval_topo(&mut cx);
    eval_mem_clk(&mut cx);
    eval_uarch(&mut cx);
    apply_verdict(input, signals, &cx.2);
}

fn eval_tlb(cx: &mut Cx<'_>) {
    let (i, t) = (cx.0, &cx.0.tier_cpi);
    if !i.target_present {
        return;
    }
    let sil = i.ifeo_enabled && !i.silent_ifeo_fail_dlls.is_empty();
    if sil || (i.requested_huge_mib > 0.0 && i.target_huge_mib <= 0.0) {
        cx.2[F_TLB] = true;
        let (ok, req) = (i.has_lock_memory_privilege, i.requested_huge_mib);
        let r = if ok { LARGE_FRAG } else { LARGE_PRIV };
        let s = format!("{req:.0}M req, 0");
        let k = if ok { s } else { NO_PRIV.into() };
        let f = hit! { cx, r, Hi, (t.l2_itlb + t.l2_dtlb).max(0.25), k, @q "2 MiB page backing", "Restores 2 MiB TLB coverage.";
            "Priv" => if ok { "granted" } else { "missing" }.into(),
            "Fail" => i.silent_ifeo_fail_dlls.len().to_string(),
            "Huge" => format!("{:.0}/{req:.0}M", i.target_huge_mib)
        };
        if i.silent_ifeo_fail_dlls.is_empty() {
            f.jump_tab = 4;
        }
    }
    let itlb = i.l2_itlb_mpki >= 0.35 || i.l1_itlb_miss_pct >= 1.5;
    if itlb && i.has_pack(ItlbFull) && !sil && !i.ifeo_enabled && !i.cand_4k_dlls.is_empty() {
        cx.2[F_TLB] = true;
        let (n, l2, l1) = (i.cand_4k_dlls.len(), i.l2_itlb_mpki, i.l1_itlb_miss_pct);
        let f = hit! { cx, PE_ITLB, if l2 >= 0.70 { Hi } else { Md }, t.l2_itlb.max(0.10), format!("L2 {l2:.2} | L1 {l1:.1}%"), cx.am(t.l2_itlb, 0.85, Flush, "85% L2 iTLB cut");
            "L2" => format!("{l2:.2}"), "L1%" => format!("{l1:.1}"), "4K" => n.to_string()
        };
        f.why = format!("{n} candidate 4 KiB DLLs exceed 64-entry L1 iTLB and cause L2 walks.");
    }
    let hp = i.mimalloc_huge_free_pct;
    if i.mimalloc_os_arenas > 0 || hp.is_some_and(|p| p < 10.0) {
        cx.2[F_TLB] = true;
        let q = cx.q("dTLB / faults", "Eliminates 4 KiB OS arena spillover.");
        let am = cx.am(t.l2_dtlb, 0.80, Mlp, "80% L2 dTLB cut");
        let g = if i.has_pack(DtlbFull) { am } else { q };
        let fr = hp.map_or_else(|| "n/a".into(), |p| format!("{p:.1}%"));
        hit! { cx, MI_SPILL, if i.mimalloc_os_arenas > 0 { Hi } else { Md }, t.l2_dtlb.max(0.12), format!("OS={} | free={fr}", i.mimalloc_os_arenas), g;
            "OS" => i.mimalloc_os_arenas.to_string(), "Free%" => fr, "dTLB" => format!("{:.2}", i.l2_dtlb_mpki)
        };
        return;
    }
    let crt = i.has_pack(DtlbFull) && hp.is_none() && i.target_huge_mib <= 0.0;
    if crt && i.l2_dtlb_mpki >= 0.50 && i.target_ws_mib >= 512.0 {
        cx.2[F_TLB] = true;
        let (d, w, h) = (i.l2_dtlb_mpki, i.target_ws_mib, i.target_huge_mib);
        hit! { cx, CRT_DTLB, if d >= 1.0 { Hi } else { Md }, t.l2_dtlb.max(0.10), format!("dTLB {d:.2} | WS {w:.0}M"), cx.am(t.l2_dtlb, 0.80, Mlp, "80% L2 dTLB cut");
            "dTLB" => format!("{d:.2}"), "WS" => format!("{w:.0}"), "Huge" => format!("{h:.0}")
        };
    }
}

fn eval_topo(cx: &mut Cx<'_>) {
    let p = &cx.0.core_c0_pct;
    if p.len() >= 4 {
        let (mut sat, mut hot, mut spr) = (true, 0usize, 0usize);
        for c in p.chunks_exact(2) {
            sat &= c[0].max(c[1]) > 85.0;
            hot += usize::from(c[0].max(c[1]) >= 70.0 && c[0].min(c[1]) >= 15.0);
            spr += usize::from(c[0] < 20.0 && c[1] < 20.0);
        }
        if !sat && hot > 0 && spr > 0 {
            cx.2[F_SMT] = true;
            hit! { cx, SMT, Md, 0.14, format!("{hot} hot | {spr} spare"), @q "1% lows / MLP", "Gives hot threads dedicated core ports.";
                "Hot" => hot.to_string(), "Spare" => spr.to_string(), "C0%" => format!("{:.1}", cx.0.avg_c0_pct)
            };
        }
    }
    if p.len() >= 2 {
        let half = p.len() / 2;
        let c0 = p[..half].iter().filter(|&&v| v >= 15.0).count();
        let c1 = p[half..].iter().filter(|&&v| v >= 15.0).count();
        let df = match cx.0.ccx_lat_ns.as_slice() {
            [a, b, ..] if *a > 0.0 && *b > 0.0 => (a - b).abs() / a.min(*b).max(1.0),
            _ => 0.0,
        };
        let l3 = cx.0.l3_hit_pct;
        if c0 > 0 && c1 > 0 && (c0 + c1) <= half && ((l3 > 0.0 && l3 < 80.0) || df >= 0.10) {
            cx.2[F_CCX] = true;
            hit! { cx, CCX_SPREAD, if l3 < 75.0 { Hi } else { Md }, cx.0.tier_cpi.l3_hit.max(0.15), format!("CCX {c0}/{c1} | L3 {l3:.1}%"), @q "L3 lat + 1% lows", "Consolidates shared L3 onto one CCX.";
                "CCX" => format!("{c0}/{c1}"), "L3%" => format!("{l3:.1}"), "Skew%" => format!("{:.1}", df * 100.0)
            };
        }
    }
}

fn eval_mem_clk(cx: &mut Cx<'_>) {
    let (i, t) = (cx.0, &cx.0.tier_cpi);
    let pk = |p, v| if i.has_pack(p) { v } else { 0.0 };
    let hw = pk(DcHwpf, i.hwpf_dram_mpki) + pk(L2Hwpf, i.l2_pf_dram_mpki);
    if i.has_pack(DcDemand) {
        let l = &i.config.latencies;
        let unl = ((l.dram_fallback - l.l3_hit) / i.eff_ghz.max(0.5)).max(25.0);
        let cal = unl * 1.25;
        let trig = if i.config.calibrated { cal } else { 70.0 };
        if i.l3_lat_ns >= trig && (i.dram_mpki >= 3.0 || hw >= 1.5) {
            cx.2[F_DRAM_Q] = true;
            let f = hit! { cx, DRAM_Q, Hi, t.dram.max(0.20), format!("L3 {:.1}ns (trig {trig:.1}) | DRAM {:.2}", i.l3_lat_ns, i.dram_mpki),
                cx.am(t.dram, 0.15, Mlp, "15% DRAM cut via timings");
                "L3 ns" => format!("{:.1}", i.l3_lat_ns), "DRAM" => format!("{:.2}", i.dram_mpki), "HWPF" => format!("{hw:.2}")
            };
            f.confidence = if i.config.calibrated { High } else { Med };
        }
    }
    if i.has_pack(DcDemand) && i.has_pack(DcHwpf) {
        let sh = i.dem_dram_mpki / (i.dem_dram_mpki + hw).max(0.01);
        if i.dem_dram_mpki >= 1.5 && sh >= 0.65 {
            cx.2[F_DEM_DRAM] = true;
            hit! { cx, DEM_DRAM, if i.dem_dram_mpki >= 2.2 { Hi } else { Md }, t.dram.max(0.18), format!("Dem {:.2} ({:.0}%)", i.dem_dram_mpki, sh * 100.0), cx.am(t.dram, 0.50, Mlp, "50% demand DRAM cut");
                "Dem" => format!("{:.2}", i.dem_dram_mpki), "HWPF" => format!("{hw:.2}"), "Share%" => format!("{:.0}", sh * 100.0)
            };
        }
    }
    if i.has_pack(Branches) && i.branch_miss_mpki >= 5.0 && i.branch_miss_pct >= 3.5 {
        cx.2[F_BRANCH] = true;
        let (x, p) = (i.branch_miss_mpki, i.branch_miss_pct);
        hit! { cx, BRANCH, if x >= 7.0 { Hi } else { Md }, t.branch.max(0.15), format!("{x:.2} MPKI ({p:.2}%)"), cx.am(t.branch, 0.35, Flush, "35% branch mispredict cut");
            "BrMPKI" => format!("{x:.2}"), "Br%" => format!("{p:.2}"), "BrCPI" => format!("{:.2}", t.branch)
        };
    }
    if i.has_pack(L1L2Ic) && (i.l2_ic_miss_mpki >= 2.5 || i.l1_ic_miss_mpki >= 15.0) {
        cx.2[F_FE] = true;
        let (l2, l1) = (i.l2_ic_miss_mpki, i.l1_ic_miss_mpki);
        hit! { cx, ICACHE, if l2 >= 3.5 { Hi } else { Md }, t.l2_ic.max(0.12), format!("L2 {l2:.2} | L1 {l1:.1}"), cx.am(t.l2_ic, 0.35, Flush, "35% L2 IC miss cut");
            "L2IC" => format!("{l2:.2}"), "L1IC" => format!("{l1:.1}"), "ICCPI" => format!("{:.2}", t.l2_ic)
        };
    }
    let base = i.config.base_mhz / 1000.0;
    if i.eff_ghz > 0.1 && base > 0.0 && i.avg_c0_pct >= 25.0 && i.eff_ghz < base * 0.98 {
        let pct = ((base / i.eff_ghz) - 1.0).max(0.0) * 100.0;
        hit! { cx, CLOCK, Hi, (pct / 100.0).max(0.15), format!("{:.2} vs {base:.2} GHz", i.eff_ghz),
            EstGain::Clock { pct, detail: format!("+{pct:.1}% restoring {base:.2} GHz") };
            "Eff" => format!("{:.2}", i.eff_ghz), "Base" => format!("{base:.2}"), "C0%" => format!("{:.1}", i.avg_c0_pct)
        };
    }
    if let Some(bm) = i.baseline_mux_groups {
        if i.mux_groups != bm {
            hit! { cx, MUX_DIFF, Hi, 0.05, format!("{}x vs {bm}x mux", i.mux_groups), @q "A/B accuracy", "Prevents mux skew in A/B comparisons.";
                "Live" => i.mux_groups.to_string(), "Base" => bm.to_string()
            };
        } else if i.mux_groups >= 2 {
            if let Some(bi) = i.baseline_ipc.filter(|&b| b > 0.0) {
                let d = ((i.ipc - bi) / bi * 100.0).abs();
                if d < 3.0 {
                    hit! { cx, MUX_NOISE, Lo, 0.02, format!("|dIPC| {d:.2}% @ {}x", i.mux_groups), @q "A/B accuracy", "Re-measuring at 1x isolates sub-3% shifts.";
                        "IPC" => format!("{:.3}", i.ipc), "Base" => format!("{bi:.3}"), "Mux" => i.mux_groups.to_string()
                    };
                }
            }
        }
    }
}

fn eval_uarch(cx: &mut Cx<'_>) {
    let i = cx.0;
    if i.has_pack(CrossCcxLocks) {
        if i.dc_cross_ccx_mpki >= 0.8 {
            cx.2[F_UARCH] = true;
            let ccx = i.dc_cross_ccx_mpki;
            let c = (ccx / 1000.0) * i.config.latencies.cross_ccx;
            hit! { cx, CCX_BOUNCE, if ccx >= 2.0 { Hi } else { Md }, c.max(0.12), format!("{ccx:.2} MPKI (~{c:.2} CPI)"),
                cx.opt(c, 0.70, "70% cross-CCX cut", "Coherency", "Avoids ~90c fills.");
                "CCX" => format!("{ccx:.2}"), "CPI" => format!("{c:.2}")
            };
        }
        let both = i.locks_serial_mpki >= 0.5 && i.dc_cross_ccx_mpki >= 0.5;
        if both || i.locks_serial_mpki >= 1.0 {
            cx.2[F_UARCH] = true;
            hit! { cx, LOCKS, if both { Hi } else { Md }, 0.14, format!("Locks {:.2} | CCX {:.2}", i.locks_serial_mpki, i.dc_cross_ccx_mpki),
                @q "IPC / scaling", "Reduces store-buffer drains and lock stalls.";
                "Locks" => format!("{:.2}", i.locks_serial_mpki), "Cross-CCX" => format!("{:.2}", i.dc_cross_ccx_mpki)
            };
        }
    }
    if i.has_pack(OpCacheDecode) {
        let oc = i.opcache_hit_pct;
        let fb = if oc > 0.0 { (100.0 - oc).max(0.0) } else { 0.0 };
        let leg = if i.legacy_decode_pct > 0.0 {
            i.legacy_decode_pct
        } else {
            fb
        };
        if leg >= 30.0 {
            const G: [(&str, &str); 2] = [
                ("~0% until DRAM fixed", "DRAM stalls hide decode."),
                ("FE dispatch width", "Restores 8-wide OpCache."),
            ];
            let msk = i.l3_miss_mpki >= 3.0 && i.l3_lat_ns >= 65.0 && i.ipc < 1.25;
            if !msk {
                cx.2[F_FE] = true;
            }
            let (r, s, m) = if msk {
                (OC_MASKED, Info, 0.04)
            } else {
                (OC_THRASH, if leg >= 45.0 { Hi } else { Md }, 0.14)
            };
            let (gl, gd) = G[usize::from(!msk)];
            hit! { cx, r, s, m, format!("Legacy {leg:.1}% | Hit {oc:.1}%"), @q gl, gd;
                "Leg%" => format!("{leg:.1}"), "OC%" => format!("{oc:.1}"), "L3" => format!("{:.2}", i.l3_miss_mpki)
            };
        }
    }
    if i.has_pack(StlfSplits) {
        if i.stlf_interlock_mpki >= 3.0 {
            cx.2[F_UARCH] = true;
            let c = (i.stlf_interlock_mpki / 1000.0) * i.config.latencies.stlf_penalty;
            hit! { cx, STLF, Md, c.max(0.10), format!("{:.2} MPKI (~{c:.2} CPI)", i.stlf_interlock_mpki),
                cx.opt(c, 0.60, "60% STLF cut", "LSU latency", "Avoids ~12.5c replay.");
                "STLF" => format!("{:.2}", i.stlf_interlock_mpki), "CPI" => format!("{c:.2}")
            };
        }
        if i.misal_access_mpki >= 10.0 {
            cx.2[F_UARCH] = true;
            let s = if i.misal_access_mpki >= 20.0 { Md } else { Lo };
            hit! { cx, SPLITS, s, 0.08, format!("{:.1} MPKI misaligned", i.misal_access_mpki), @q "L1d ports / LSQ", "Halves load/store port occupancy.";
                "Misal" => format!("{:.1}", i.misal_access_mpki)
            };
        }
    }
}

fn apply_verdict(i: &DiagnosticInput, sig: &mut RuleSignals, fl: &[bool; 8]) {
    let hot = i.hottest_cpu_c0();
    let gpu = i.gpu_3d_pct.is_some_and(|g| g >= 97.0 && hot < 75.0);
    if gpu || sig.preferred_verdict_id.is_some() {
        return;
    }
    const V: [&str; 8] = [
        "memory_bandwidth_queueing|DRAM queueing latency inflation",
        "memory_latency_bound|Demand DRAM pointer-chasing latency",
        "branch_mispredict_bound|Branch misprediction pipeline flushes",
        "micro_arch_contention|Cross-CCX / lock / LSU micro-arch stalls",
        "frontend_code_bound|Instruction fetch or OpCache frontend stalls",
        "l3_capacity_or_cross_ccx|Cross-CCX thread spread and L3 latency",
        "tlb_translation_bound|L2 iTLB/dTLB walks or 2 MiB page fallback",
        "smt_contention_bound|Hot SMT sibling contention with spare cores",
    ];
    let t = &i.tier_cpi;
    let tlb = t.l2_itlb + t.l2_dtlb;
    let oth = t.l3_hit.max(t.l2_ic).max(tlb);
    let mem_dom = t.dram.max(t.branch) > oth && (t.dram >= 0.35 || t.branch >= 0.20);
    let fe =
        fl[F_FE] && (t.l2_ic >= tlb.max(t.l3_hit) || (!fl[F_CCX] && t.l3_hit < 0.25 && tlb < 0.20));
    let idx = match () {
        _ if fl[F_DRAM_Q] && t.dram >= t.branch => Some(0),
        _ if fl[F_DEM_DRAM] && t.dram >= t.branch && t.dram >= oth => Some(1),
        _ if fl[F_BRANCH] && t.branch >= t.dram && t.branch >= oth => Some(2),
        _ if mem_dom => None,
        _ if fl[F_UARCH] => Some(3),
        _ if fe => Some(4),
        _ if fl[F_CCX] && t.l3_hit >= tlb => Some(5),
        _ if fl[F_TLB] => Some(6),
        _ if fl[F_SMT] => Some(7),
        _ => None,
    };
    if let Some((id, stall)) = idx.and_then(|k| V[k].split_once('|')) {
        let (ipc, cpi, ns, c0) = (i.ipc, i.actual_cpi, i.l3_lat_ns, i.avg_c0_pct);
        sig.preferred_verdict_id = Some(id.into());
        sig.preferred_winning_stall = Some(stall.into());
        let pr = format!("IPC {ipc:.2} | CPI {cpi:.2} | L3 {ns:.1}ns | C0 {c0:.1}%");
        sig.preferred_proof = Some(pr);
    }
}
