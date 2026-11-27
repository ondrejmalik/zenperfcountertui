//! 4-tier x64 symbol resolver (`PDB` > `PE Export` > `Sidecar .zen2sym.json` > `PE .pdata`).

use serde::{Deserialize, Deserializer, Serialize};
use std::collections::HashMap;

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default, Serialize, Deserialize,
)]
pub enum SymbolTier {
    Pdb,
    PeExport,
    SidecarMap,
    Pdata,
    #[default]
    Raw,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct RuntimeFunction {
    pub begin_address: u32,
    pub end_address: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SymbolRange {
    pub rva_start: u32,
    pub rva_end: u32,
    pub name: String,
    pub signature: Option<String>,
    pub file: Option<String>,
    pub line: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ExportSymbol {
    pub rva_start: u32,
    pub rva_end: u32,
    pub name: String,
    pub ordinal: Option<u16>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ModuleSymbols {
    pub name: String,
    pub base_addr: u64,
    pub size_bytes: u64,
    pub pdb_loaded: bool,
    pub pdb_symbols: Vec<SymbolRange>,
    pub exports: Vec<ExportSymbol>,
    pub pdata: Vec<RuntimeFunction>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ResolvedSymbol {
    pub module: String,
    pub base_addr: u64,
    pub va: u64,
    pub rva: u32,
    pub fn_start_rva: u32,
    pub fn_end_rva: u32,
    pub name: String,
    pub display_name: String,
    pub signature: String,
    pub file_line: Option<String>,
    pub tier: SymbolTier,
    pub key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SidecarSymbolEntry {
    pub module: String,
    #[serde(alias = "rvaStart", deserialize_with = "deserialize_rva")]
    pub rva_start: u32,
    #[serde(alias = "rvaEnd", deserialize_with = "deserialize_rva")]
    pub rva_end: u32,
    pub name: String,
    pub signature: Option<String>,
}

trait Span {
    fn span(&self) -> (u32, u32);
}

impl Span for SymbolRange {
    fn span(&self) -> (u32, u32) {
        (self.rva_start, self.rva_end)
    }
}

impl Span for ExportSymbol {
    fn span(&self) -> (u32, u32) {
        (self.rva_start, self.rva_end)
    }
}

impl Span for SidecarSymbolEntry {
    fn span(&self) -> (u32, u32) {
        (self.rva_start, self.rva_end)
    }
}

impl Span for RuntimeFunction {
    fn span(&self) -> (u32, u32) {
        (self.begin_address, self.end_address)
    }
}

fn module_key(s: &str) -> String {
    s.trim().to_ascii_lowercase()
}

fn deserialize_rva<'de, D: Deserializer<'de>>(d: D) -> Result<u32, D::Error> {
    let v = serde_json::Value::deserialize(d)?;
    let e = || serde::de::Error::custom("invalid RVA");
    if let Some(n) = v.as_u64() {
        return u32::try_from(n).map_err(|_| e());
    }
    let s = v.as_str().ok_or_else(e)?.trim();
    match s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        Some(h) => u32::from_str_radix(h, 16).map_err(|_| e()),
        None => s.parse().map_err(|_| e()),
    }
}

pub fn parse_sidecar_json(json: &str) -> anyhow::Result<Vec<SidecarSymbolEntry>> {
    let mut es: Vec<SidecarSymbolEntry> = serde_json::from_str(json)?;
    es.retain(|e| e.rva_end > e.rva_start && !e.module.trim().is_empty());
    Ok(es)
}

pub trait SymbolResolver: Send + Sync {
    fn resolve(&self, module: &str, rva: u32) -> ResolvedSymbol;
    fn resolve_va(&self, va: u64) -> ResolvedSymbol;
}

#[derive(Debug, Default, Clone)]
pub struct TieredSymbolResolver {
    modules: HashMap<String, ModuleSymbols>,
    sidecar: HashMap<String, Vec<SidecarSymbolEntry>>,
}

fn sort_ranges<T: Span>(v: &mut Vec<T>) {
    v.retain(|x| x.span().1 > x.span().0);
    v.sort_by_key(|x| x.span().0);
}

impl TieredSymbolResolver {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn register_module(&mut self, mut m: ModuleSymbols) {
        sort_ranges(&mut m.pdb_symbols);
        sort_ranges(&mut m.exports);
        sort_ranges(&mut m.pdata);
        self.modules.insert(module_key(&m.name), m);
    }
    pub fn unload_module(&mut self, name: &str) {
        self.modules.remove(&module_key(name));
    }
    pub fn load_sidecar_json(&mut self, json: &str) -> anyhow::Result<usize> {
        let es = parse_sidecar_json(json)?;
        let n = es.len();
        for e in es {
            self.sidecar
                .entry(module_key(&e.module))
                .or_default()
                .push(e);
        }
        self.sidecar.values_mut().for_each(sort_ranges);
        Ok(n)
    }
    pub fn clear_sidecar(&mut self) {
        self.sidecar.clear();
    }
}

fn find<T: Span>(s: &[T], rva: u32) -> Option<&T> {
    let i = s.partition_point(|x| x.span().0 <= rva);
    let f = s.get(i.checked_sub(1)?)?.span().0;
    let rev = s[..i].iter().rev();
    rev.take_while(|x| x.span().0 == f || x.span().1 > rva)
        .find(|x| x.span().0 <= rva && rva < x.span().1)
}

struct ResolvedRange {
    tier: SymbolTier,
    start: u32,
    end: u32,
    name: String,
    display_name: String,
    signature: String,
    file_line: Option<String>,
}

fn resolve_range(
    module_name: &str,
    rva: u32,
    module_symbols: Option<&ModuleSymbols>,
    sidecar: &[SidecarSymbolEntry],
) -> ResolvedRange {
    use SymbolTier::*;
    let named_range = |tier, start, end, name: String, signature, file_line| ResolvedRange {
        tier,
        start,
        end,
        display_name: name.clone(),
        name,
        signature,
        file_line,
    };
    let pdb_module = module_symbols.filter(|m| m.pdb_loaded);
    if let Some(h) = pdb_module.and_then(|m| find(&m.pdb_symbols, rva)) {
        let line = h.line.unwrap_or(1) + (rva - h.rva_start) / 32;
        let file_line = h.file.as_deref().map(|f| format!("{f}:{line}"));
        let signature = h.signature.clone().unwrap_or_else(|| h.name.clone());
        return named_range(
            Pdb,
            h.rva_start,
            h.rva_end,
            h.name.clone(),
            signature,
            file_line,
        );
    }
    if let Some(h) = module_symbols.and_then(|m| find(&m.exports, rva)) {
        let ord = h.ordinal.map_or(String::new(), |o| format!(" (ord #{o})"));
        let signature = format!("{module_name}!{}{ord}", h.name);
        return named_range(
            PeExport,
            h.rva_start,
            h.rva_end,
            h.name.clone(),
            signature,
            None,
        );
    }
    if let Some(h) = find(sidecar, rva) {
        let def = format!("{module_name}!{}", h.name);
        let signature = h.signature.clone().unwrap_or(def);
        return named_range(
            SidecarMap,
            h.rva_start,
            h.rva_end,
            h.name.clone(),
            signature,
            None,
        );
    }
    if let Some(h) = module_symbols.and_then(|m| find(&m.pdata, rva)) {
        let (a, b) = (h.begin_address, h.end_address);
        let (tag, full) = (format!("fn_0x{a:X}"), format!("{module_name}!fn_0x{a:X}"));
        let signature = format!("{full} [0x{a:X}..0x{b:X})");
        return ResolvedRange {
            tier: Pdata,
            start: a,
            end: b,
            name: full,
            display_name: tag,
            signature,
            file_line: None,
        };
    }
    let tag = format!("0x{rva:X}");
    let full = format!("{module_name}!{tag}");
    let signature = format!("{module_name}+{tag} (no unwind .pdata)");
    ResolvedRange {
        tier: Raw,
        start: rva,
        end: rva.saturating_add(1),
        name: full,
        display_name: tag,
        signature,
        file_line: None,
    }
}

impl SymbolResolver for TieredSymbolResolver {
    fn resolve(&self, module: &str, rva: u32) -> ResolvedSymbol {
        let (trimmed_module, module_key) = (module.trim(), module_key(module));
        let module_symbols = self.modules.get(&module_key);
        let (module_name, b) =
            module_symbols.map_or((trimmed_module, 0), |m| (m.name.as_str(), m.base_addr));
        let va = if b > 0 { b + u64::from(rva) } else { 0 };
        let sidecar = self.sidecar.get(&module_key).map_or(&[][..], Vec::as_slice);
        let range = resolve_range(module_name, rva, module_symbols, sidecar);
        let key = format!("{module_key}!{}", range.display_name);
        ResolvedSymbol {
            module: module_name.into(),
            base_addr: b,
            va,
            rva,
            fn_start_rva: range.start,
            fn_end_rva: range.end,
            name: range.name,
            display_name: range.display_name,
            signature: range.signature,
            file_line: range.file_line,
            tier: range.tier,
            key,
        }
    }

    fn resolve_va(&self, va: u64) -> ResolvedSymbol {
        for m in self.modules.values() {
            let end = m.base_addr.saturating_add(m.size_bytes);
            if m.size_bytes > 0 && (m.base_addr..end).contains(&va) {
                return self.resolve(&m.name, u32::try_from(va - m.base_addr).unwrap_or(u32::MAX));
            }
        }
        let t = format!("0x{va:X}");
        ResolvedSymbol {
            module: "unknown".into(),
            va,
            name: t.clone(),
            display_name: t.clone(),
            signature: t.clone(),
            key: format!("unknown!{t}"),
            ..Default::default()
        }
    }
}
