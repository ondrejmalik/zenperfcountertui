use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Maps logical CPU IDs to CCX IDs on AMD Zen 2 topologies.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CcxTopology {
    cpu_to_ccx: BTreeMap<usize, usize>,
}

impl CcxTopology {
    /// Default Ryzen 5 3600X topology: 12 logical CPUs (0..=5 -> CCX0, 6..=11 -> CCX1).
    pub fn zen2_ryzen_3600x() -> Self {
        let pairs: Vec<(usize, usize)> = (0..12).map(|cpu| (cpu, usize::from(cpu >= 6))).collect();
        Self::from_cpu_ccx_pairs(&pairs)
    }

    pub fn from_cpu_ccx_pairs(pairs: &[(usize, usize)]) -> Self {
        Self {
            cpu_to_ccx: pairs.iter().copied().collect(),
        }
    }

    pub fn ccx_for_cpu(&self, cpu_id: usize) -> Option<usize> {
        self.cpu_to_ccx.get(&cpu_id).copied()
    }
}

impl Default for CcxTopology {
    fn default() -> Self {
        Self::zen2_ryzen_3600x()
    }
}

/// Parsing and metric derivation options for `report_core.csv`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CsvSampleOptions {
    pub affinity_mask: Option<u64>,
    pub base_mhz: f64,
    pub interval_sec: f64,
    pub topology: CcxTopology,
}

impl Default for CsvSampleOptions {
    fn default() -> Self {
        Self {
            affinity_mask: None,
            base_mhz: 3800.0,
            interval_sec: 1.0,
            topology: CcxTopology::zen2_ryzen_3600x(),
        }
    }
}

/// Shared Core PMC and fixed MSR counters for per-CPU rows and aggregates.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CoreCounters {
    pub inst: f64,
    pub aperf: f64,
    pub mperf: f64,
    pub cycles: f64,
    pub ret_uops: f64,
    pub dc_dem_l3: f64,
    pub dc_dem_dram: f64,
    pub dc_hwpf_l3: f64,
    pub dc_hwpf_dram: f64,
    pub l1_dc_miss: f64,
    pub l2_dc_miss: f64,
    pub l1_ic_miss: f64,
    pub l2_ic_miss: f64,
    pub l2_pf_l3: f64,
    pub l2_pf_dram: f64,
    pub branches: f64,
    pub branch_miss: f64,
    pub l1_itlb_hit: f64,
    pub l1_itlb_miss_l2_hit: f64,
    pub l2_itlb_miss: f64,
    pub l1_dtlb_miss_l2_hit: f64,
    pub l2_dtlb_miss: f64,
    pub dc_cross_ccx: f64,
    pub locks_serial: f64,
    pub dec_uops: f64,
    pub oc_uops: f64,
    pub stlf_interlock: f64,
    pub misal_access: f64,
}

impl CoreCounters {
    /// Accumulates all counter fields from `other` into `self`.
    pub fn add_assign(&mut self, o: &Self) {
        self.inst += o.inst;
        self.aperf += o.aperf;
        self.mperf += o.mperf;
        self.cycles += o.cycles;
        self.ret_uops += o.ret_uops;
        self.dc_dem_l3 += o.dc_dem_l3;
        self.dc_dem_dram += o.dc_dem_dram;
        self.dc_hwpf_l3 += o.dc_hwpf_l3;
        self.dc_hwpf_dram += o.dc_hwpf_dram;
        self.l1_dc_miss += o.l1_dc_miss;
        self.l2_dc_miss += o.l2_dc_miss;
        self.l1_ic_miss += o.l1_ic_miss;
        self.l2_ic_miss += o.l2_ic_miss;
        self.l2_pf_l3 += o.l2_pf_l3;
        self.l2_pf_dram += o.l2_pf_dram;
        self.branches += o.branches;
        self.branch_miss += o.branch_miss;
        self.l1_itlb_hit += o.l1_itlb_hit;
        self.l1_itlb_miss_l2_hit += o.l1_itlb_miss_l2_hit;
        self.l2_itlb_miss += o.l2_itlb_miss;
        self.l1_dtlb_miss_l2_hit += o.l1_dtlb_miss_l2_hit;
        self.l2_dtlb_miss += o.l2_dtlb_miss;
        self.dc_cross_ccx += o.dc_cross_ccx;
        self.locks_serial += o.locks_serial;
        self.dec_uops += o.dec_uops;
        self.oc_uops += o.oc_uops;
        self.stlf_interlock += o.stlf_interlock;
        self.misal_access += o.misal_access;
    }

    fn apply_key(&mut self, key: &str, v: f64) -> bool {
        match key {
            "inst" | "irperf" => self.inst = v,
            "aperf" => self.aperf = v,
            "mperf" => self.mperf = v,
            "cycles" => self.cycles = v,
            "ret_uops" | "0x4300c1" => self.ret_uops = v,
            "dc_dem_l3" | "0x430243" => self.dc_dem_l3 = v,
            "dc_dem_dram" | "0x430843" => self.dc_dem_dram = v,
            "dc_hwpf_l3" | "0x43025a" => self.dc_hwpf_l3 = v,
            "dc_hwpf_dram" | "0x43085a" => self.dc_hwpf_dram = v,
            "l1_dc_miss" | "0x43c860" => self.l1_dc_miss = v,
            "l2_dc_miss" | "0x430864" => self.l2_dc_miss = v,
            "l1_ic_miss" | "0x431060" => self.l1_ic_miss = v,
            "l2_ic_miss" | "0x430164" => self.l2_ic_miss = v,
            "l2_pf_l3" | "0x431f71" => self.l2_pf_l3 = v,
            "l2_pf_dram" | "0x431f72" => self.l2_pf_dram = v,
            "branches" | "0x4300c2" => self.branches = v,
            "branch_miss" | "0x4300c3" => self.branch_miss = v,
            "l1_itlb_hit" | "0x430794" => self.l1_itlb_hit = v,
            "l1_itlb_miss_l2_hit" | "0x430084" => self.l1_itlb_miss_l2_hit = v,
            "l2_itlb_miss" | "0x430785" => self.l2_itlb_miss = v,
            "l1_dtlb_miss_l2_hit" | "0x430f45" => self.l1_dtlb_miss_l2_hit = v,
            "l2_dtlb_miss" | "0x43f045" => self.l2_dtlb_miss = v,
            "dc_cross_ccx" | "0x430443" => self.dc_cross_ccx = v,
            "locks_serial" | "0x430325" => self.locks_serial = v,
            "dec_uops" | "0x4301aa" => self.dec_uops = v,
            "oc_uops" | "0x4302aa" => self.oc_uops = v,
            "stlf_interlock" | "0x430224" => self.stlf_interlock = v,
            "misal_access" | "0x430047" => self.misal_access = v,
            _ => return false,
        }
        true
    }
}

/// Parsed per-logical-CPU counters and derived free-base metrics.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CoreCsvRow {
    pub cpu_id: usize,
    pub ccx_id: usize,
    #[serde(flatten)]
    pub counters: CoreCounters,
    pub ipc: f64,
    pub actual_cpi: f64,
    pub eff_ghz: f64,
    pub c0_pct: f64,
}

/// Aggregated core counters for a single CCX or across all included CPUs.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CoreCsvAggregate {
    pub ccx_id: Option<usize>,
    pub cpu_count: usize,
    #[serde(flatten)]
    pub counters: CoreCounters,
    pub ipc: f64,
    pub actual_cpi: f64,
    pub eff_ghz: f64,
    pub c0_pct: f64,
}

/// Complete parsed result for a `report_core.csv` sample.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ParsedCoreCsv {
    pub per_cpu: Vec<CoreCsvRow>,
    pub ccx_totals: Vec<CoreCsvAggregate>,
    pub total: CoreCsvAggregate,
}

/// Parsed per-CCX (or total) L3 uncore counters and derived metrics.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CcxL3Row {
    pub ccx_id: usize,
    pub l3_access: f64,
    pub l3_miss: f64,
    pub l3_lat: f64,
    pub l3_mtype: f64,
    pub l3_hit_pct: f64,
    pub lat_cyc: f64,
    pub lat_ns: f64,
}

/// Complete parsed result for a `report_l3.csv` sample.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ParsedL3Csv {
    pub per_ccx: Vec<CcxL3Row>,
    pub total: CcxL3Row,
}

fn safe_div(num: f64, den: f64) -> f64 {
    if den > 0.0 && num.is_finite() && den.is_finite() {
        let out = num / den;
        if out.is_finite() {
            return out;
        }
    }
    0.0
}

fn parse_f64(cell: &str) -> f64 {
    cell.trim()
        .parse::<f64>()
        .ok()
        .filter(|v| v.is_finite())
        .unwrap_or(0.0)
}

fn parse_id_token(cell: &str) -> Option<usize> {
    let trimmed = cell.trim().trim_matches('"');
    if let Ok(v) = trimmed.parse::<usize>() {
        return Some(v);
    }
    let end = trimmed.rfind(|c: char| c.is_ascii_digit())?;
    let start = trimmed[..=end]
        .rfind(|c: char| !c.is_ascii_digit())
        .map_or(0, |i| i + 1);
    trimmed[start..=end].parse::<usize>().ok()
}

fn header_keys(raw: &str) -> (String, Option<String>) {
    let clean = raw.trim().trim_matches('"').to_ascii_lowercase();
    let stripped = clean
        .strip_prefix("core/")
        .or_else(|| clean.strip_prefix("l3/"))
        .unwrap_or(&clean);
    if let Some((lhs, rhs)) = stripped.split_once('=') {
        (
            lhs.trim().to_string(),
            Some(
                rhs.trim()
                    .trim_matches(|c| c == '(' || c == ')')
                    .to_string(),
            ),
        )
    } else {
        (stripped.trim().to_string(), None)
    }
}

fn included_by_mask(cpu_id: usize, mask: Option<u64>) -> bool {
    mask.is_none_or(|m| cpu_id < 64 && ((m >> cpu_id) & 1) != 0)
}

fn derive_core_metrics(c: &CoreCounters, base_mhz: f64, interval_sec: f64) -> (f64, f64, f64, f64) {
    let eff_cycles = if c.aperf > 0.0 { c.aperf } else { c.cycles };
    let ipc = safe_div(c.inst, eff_cycles);
    let actual_cpi = safe_div(eff_cycles, c.inst);
    let eff_ghz = safe_div(c.aperf, c.mperf) * (base_mhz / 1000.0);
    let c0_pct = (safe_div(c.mperf, base_mhz * 1e6 * interval_sec) * 100.0).clamp(0.0, 100.0);
    (ipc, actual_cpi, eff_ghz, c0_pct)
}

fn aggregate_rows(ccx_id: Option<usize>, rows: &[&CoreCsvRow], base_mhz: f64) -> CoreCsvAggregate {
    let mut agg = CoreCsvAggregate {
        ccx_id,
        cpu_count: rows.len(),
        ..CoreCsvAggregate::default()
    };
    let mut c0_sum = 0.0;
    for r in rows {
        agg.counters.add_assign(&r.counters);
        c0_sum += r.c0_pct;
    }
    let (ipc, actual_cpi, eff_ghz, _) = derive_core_metrics(&agg.counters, base_mhz, 1.0);
    agg.ipc = ipc;
    agg.actual_cpi = actual_cpi;
    agg.eff_ghz = eff_ghz;
    agg.c0_pct = if rows.is_empty() {
        0.0
    } else {
        (c0_sum / rows.len() as f64).clamp(0.0, 100.0)
    };
    agg
}

/// Parse `report_core.csv` with dynamic header normalization, affinity filtering, and CCX splits.
pub fn parse_report_core_csv(csv: &str, opts: &CsvSampleOptions) -> Result<ParsedCoreCsv> {
    let mut lines = csv
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'));
    let Some(header_line) = lines.next().filter(|h| !h.is_empty()) else {
        bail!("report_core.csv is empty or missing header");
    };
    let headers: Vec<(String, Option<String>)> = header_line.split(',').map(header_keys).collect();
    let mut per_cpu = Vec::new();
    for (row_idx, line) in lines.enumerate() {
        let cells: Vec<&str> = line.split(',').collect();
        if cells.len() < headers.len() {
            continue;
        }
        let mut row = CoreCsvRow {
            cpu_id: row_idx,
            ..CoreCsvRow::default()
        };
        for (idx, (lhs, rhs)) in headers.iter().enumerate() {
            let is_cpu = [Some(lhs.as_str()), rhs.as_deref()]
                .into_iter()
                .flatten()
                .any(|k| matches!(k, "cpu" | "core" | "cpu_id" | "core_id" | "logical_cpu"));
            if is_cpu {
                if let Some(id) = parse_id_token(cells[idx]) {
                    row.cpu_id = id;
                }
                continue;
            }
            let val = parse_f64(cells[idx]);
            if !row.counters.apply_key(lhs, val) {
                if let Some(alias) = rhs {
                    row.counters.apply_key(alias, val);
                }
            }
        }
        if !included_by_mask(row.cpu_id, opts.affinity_mask) {
            continue;
        }
        row.ccx_id = opts.topology.ccx_for_cpu(row.cpu_id).unwrap_or(0);
        let (ipc, actual_cpi, eff_ghz, c0_pct) =
            derive_core_metrics(&row.counters, opts.base_mhz, opts.interval_sec);
        row.ipc = ipc;
        row.actual_cpi = actual_cpi;
        row.eff_ghz = eff_ghz;
        row.c0_pct = c0_pct;
        per_cpu.push(row);
    }

    let mut by_ccx: BTreeMap<usize, Vec<&CoreCsvRow>> = BTreeMap::new();
    for r in &per_cpu {
        by_ccx.entry(r.ccx_id).or_default().push(r);
    }
    let ccx_totals = by_ccx
        .into_iter()
        .map(|(id, rows)| aggregate_rows(Some(id), &rows, opts.base_mhz))
        .collect();
    let all_refs: Vec<&CoreCsvRow> = per_cpu.iter().collect();
    let total = aggregate_rows(None, &all_refs, opts.base_mhz);
    Ok(ParsedCoreCsv {
        per_cpu,
        ccx_totals,
        total,
    })
}

fn finalize_l3_row(
    ccx_id: usize,
    access: f64,
    miss: f64,
    lat: f64,
    mtype: f64,
    eff_ghz: f64,
) -> CcxL3Row {
    let l3_hit_pct = safe_div((access - miss).max(0.0), access) * 100.0;
    let lat_cyc = safe_div(lat * 16.0, mtype);
    let lat_ns = safe_div(lat_cyc, eff_ghz);
    CcxL3Row {
        ccx_id,
        l3_access: access,
        l3_miss: miss,
        l3_lat: lat,
        l3_mtype: mtype,
        l3_hit_pct,
        lat_cyc,
        lat_ns,
    }
}

/// Parse `report_l3.csv` into per-CCX rows and unified L3 totals.
pub fn parse_report_l3_csv(csv: &str, eff_ghz: f64) -> Result<ParsedL3Csv> {
    let mut lines = csv
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'));
    let Some(header_line) = lines.next().filter(|h| !h.is_empty()) else {
        bail!("report_l3.csv is empty or missing header");
    };
    let headers: Vec<(String, Option<String>)> = header_line.split(',').map(header_keys).collect();
    let mut per_ccx = Vec::new();
    for (row_idx, line) in lines.enumerate() {
        let cells: Vec<&str> = line.split(',').collect();
        if cells.len() < headers.len() {
            continue;
        }
        let (mut ccx_id, mut access, mut miss, mut lat, mut mtype) = (row_idx, 0.0, 0.0, 0.0, 0.0);
        for (idx, (lhs, rhs)) in headers.iter().enumerate() {
            for k in [Some(lhs.as_str()), rhs.as_deref()].into_iter().flatten() {
                match k {
                    "ccx" | "ccx_id" | "l3" | "socket_ccx" => {
                        if let Some(id) = parse_id_token(cells[idx]) {
                            ccx_id = id;
                        }
                    }
                    "l3_access" | "0xff0f00000040ff04" => access = parse_f64(cells[idx]),
                    "l3_miss" | "0xff0f000000400104" => miss = parse_f64(cells[idx]),
                    "l3_lat" | "0xff0f000000400090" => lat = parse_f64(cells[idx]),
                    "l3_mtype" | "0xff0f000000401f9a" => mtype = parse_f64(cells[idx]),
                    _ => continue,
                }
                break;
            }
        }
        per_ccx.push(finalize_l3_row(ccx_id, access, miss, lat, mtype, eff_ghz));
    }
    let (mut acc_s, mut miss_s, mut lat_s, mut mtype_s) = (0.0, 0.0, 0.0, 0.0);
    for r in &per_ccx {
        acc_s += r.l3_access;
        miss_s += r.l3_miss;
        lat_s += r.l3_lat;
        mtype_s += r.l3_mtype;
    }
    let total = finalize_l3_row(0, acc_s, miss_s, lat_s, mtype_s, eff_ghz);
    Ok(ParsedL3Csv { per_ccx, total })
}
