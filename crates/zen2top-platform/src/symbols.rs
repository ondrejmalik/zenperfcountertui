//! 4-tier x64 symbol resolver (`PDB` > `PE Export` > `Sidecar .zen2sym.json` > `PE .pdata`).

use serde::{Deserialize, Deserializer, Serialize};
use std::collections::HashMap;

macro_rules! sym_dto {
    (tier $n:ident { $($(#[$m:meta])* $v:ident),+ }) => { #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default, Serialize, Deserialize)] pub enum $n { $($(#[$m])* $v),+ } };
    (new $t:ident { $($x:tt)+ }) => { $t { $($x)+ } };
    (span $($t:ty => $a:ident, $b:ident);+ $(;)?) => { $(impl Span for $t { fn span(&self) -> (u32, u32) { (self.$a, self.$b) } })+ };
    ($($n:ident { $($(#[$m:meta])* $f:ident : $t:ty),+ $(,)? })+) => { $(#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)] #[serde(default)] pub struct $n { $($(#[$m])* pub $f: $t),+ })+ };
}

sym_dto! { tier SymbolTier { Pdb, PeExport, SidecarMap, Pdata, #[default] Raw } }
sym_dto! {
    RuntimeFunction { begin_address: u32, end_address: u32 }
    SymbolRange { rva_start: u32, rva_end: u32, name: String, signature: Option<String>, file: Option<String>, line: Option<u32> }
    ExportSymbol { rva_start: u32, rva_end: u32, name: String, ordinal: Option<u16> }
    ModuleSymbols { name: String, base_addr: u64, size_bytes: u64, pdb_loaded: bool, pdb_symbols: Vec<SymbolRange>, exports: Vec<ExportSymbol>, pdata: Vec<RuntimeFunction> }
    ResolvedSymbol { module: String, base_addr: u64, va: u64, rva: u32, fn_start_rva: u32, fn_end_rva: u32, name: String, display_name: String, signature: String, file_line: Option<String>, tier: SymbolTier, key: String }
    SidecarSymbolEntry { module: String, #[serde(alias = "rvaStart", deserialize_with = "deserialize_rva")] rva_start: u32, #[serde(alias = "rvaEnd", deserialize_with = "deserialize_rva")] rva_end: u32, name: String, signature: Option<String> }
}

trait Span {
    fn span(&self) -> (u32, u32);
}
sym_dto! { span SymbolRange => rva_start, rva_end; ExportSymbol => rva_start, rva_end; SidecarSymbolEntry => rva_start, rva_end; RuntimeFunction => begin_address, end_address; }

fn lo(s: &str) -> String {
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

fn prep<T: Span>(v: &mut Vec<T>) {
    v.retain(|x| x.span().1 > x.span().0);
    v.sort_by_key(|x| x.span().0);
}

impl TieredSymbolResolver {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn register_module(&mut self, mut m: ModuleSymbols) {
        prep(&mut m.pdb_symbols);
        prep(&mut m.exports);
        prep(&mut m.pdata);
        self.modules.insert(lo(&m.name), m);
    }
    pub fn unload_module(&mut self, name: &str) {
        self.modules.remove(&lo(name));
    }
    pub fn load_sidecar_json(&mut self, json: &str) -> anyhow::Result<usize> {
        let es = parse_sidecar_json(json)?;
        let n = es.len();
        for e in es {
            self.sidecar.entry(lo(&e.module)).or_default().push(e);
        }
        self.sidecar.values_mut().for_each(prep);
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

type Hit = (SymbolTier, u32, u32, String, String, String, Option<String>);

fn pick(cm: &str, rva: u32, md: Option<&ModuleSymbols>, sd: &[SidecarSymbolEntry]) -> Hit {
    use SymbolTier::*;
    let ok = |t, s, e, n: String, sg, fl| (t, s, e, n.clone(), n, sg, fl);
    let mp = md.filter(|m| m.pdb_loaded);
    if let Some(h) = mp.and_then(|m| find(&m.pdb_symbols, rva)) {
        let ln = h.line.unwrap_or(1) + (rva - h.rva_start) / 32;
        let fl = h.file.as_deref().map(|f| format!("{f}:{ln}"));
        let sg = h.signature.clone().unwrap_or_else(|| h.name.clone());
        return ok(Pdb, h.rva_start, h.rva_end, h.name.clone(), sg, fl);
    }
    if let Some(h) = md.and_then(|m| find(&m.exports, rva)) {
        let ord = h.ordinal.map_or(String::new(), |o| format!(" (ord #{o})"));
        let sg = format!("{cm}!{}{ord}", h.name);
        return ok(PeExport, h.rva_start, h.rva_end, h.name.clone(), sg, None);
    }
    if let Some(h) = find(sd, rva) {
        let def = format!("{cm}!{}", h.name);
        let sg = h.signature.clone().unwrap_or(def);
        return ok(SidecarMap, h.rva_start, h.rva_end, h.name.clone(), sg, None);
    }
    if let Some(h) = md.and_then(|m| find(&m.pdata, rva)) {
        let (a, b) = (h.begin_address, h.end_address);
        let (tag, full) = (format!("fn_0x{a:X}"), format!("{cm}!fn_0x{a:X}"));
        let sg = format!("{full} [0x{a:X}..0x{b:X})");
        return (Pdata, a, b, full, tag, sg, None);
    }
    let tag = format!("0x{rva:X}");
    let full = format!("{cm}!{tag}");
    let sg = format!("{cm}+{tag} (no unwind .pdata)");
    (Raw, rva, rva.saturating_add(1), full, tag, sg, None)
}

impl SymbolResolver for TieredSymbolResolver {
    fn resolve(&self, module: &str, rva: u32) -> ResolvedSymbol {
        let (tr, mk) = (module.trim(), lo(module));
        let md = self.modules.get(&mk);
        let (cm, b) = md.map_or((tr, 0), |m| (m.name.as_str(), m.base_addr));
        let va = if b > 0 { b + u64::from(rva) } else { 0 };
        let sd = self.sidecar.get(&mk).map_or(&[][..], Vec::as_slice);
        let (tier, s, e, n, d, sg, fl) = pick(cm, rva, md, sd);
        let k = format!("{mk}!{d}");
        sym_dto!(new ResolvedSymbol { module: cm.into(), base_addr: b, va, rva, fn_start_rva: s, fn_end_rva: e, name: n, display_name: d, signature: sg, file_line: fl, tier, key: k })
    }

    fn resolve_va(&self, va: u64) -> ResolvedSymbol {
        for m in self.modules.values() {
            let end = m.base_addr.saturating_add(m.size_bytes);
            if m.size_bytes > 0 && (m.base_addr..end).contains(&va) {
                return self.resolve(&m.name, u32::try_from(va - m.base_addr).unwrap_or(u32::MAX));
            }
        }
        let t = format!("0x{va:X}");
        sym_dto!(new ResolvedSymbol { module: "unknown".into(), va, name: t.clone(), display_name: t.clone(), signature: t.clone(), key: format!("unknown!{t}"), ..Default::default() })
    }
}
