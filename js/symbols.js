// 4-Tier x64 Symbol & Function Resolver (PDB > PE Export > Sidecar JSON > PE .pdata)
(() => {
  'use strict';
  const Z = window.Zen2Top || (window.Zen2Top = {});

  function parseRva(val) {
    if (typeof val === 'number' && Number.isFinite(val)) return Math.max(0, Math.floor(val));
    if (typeof val === 'bigint') return Number(val);
    if (typeof val === 'string') {
      const s = val.trim();
      if (!s) return NaN;
      const n = s.startsWith('0x') || s.startsWith('0X') ? parseInt(s.slice(2), 16) : Number(s);
      return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : NaN;
    }
    return NaN;
  }

  function fmtHexRva(rva) {
    return '0x' + Math.max(0, Math.floor(rva || 0)).toString(16).toUpperCase();
  }

  // Binary search sorted non-overlapping [start, end) ranges
  function binarySearchRange(ranges, rva, startKey, endKey) {
    let lo = 0;
    let hi = ranges.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const item = ranges[mid];
      if (rva < item[startKey]) {
        hi = mid - 1;
      } else if (rva >= item[endKey]) {
        lo = mid + 1;
      } else {
        return item;
      }
    }
    return null;
  }

  class SymbolResolver {
    constructor(pid, opts = {}) {
      this.pid = pid;
      this.ntSymbolPath = opts.ntSymbolPath || 'srv*C:\\Symbols*https://msdl.microsoft.com/download/symbols';
      // Per-module descriptors keyed by lower-case module name
      this.modules = new Map();
      // Tier 3 sidecar maps keyed by lower-case module name -> sorted [{ rvaStart, rvaEnd, name, signature }]
      this.sidecarMaps = new Map();
      // Resolution cache keyed by `${modLower}|${rva}`
      this.cache = new Map();
      this.generation = 0;
    }

    invalidateAll() {
      this.cache.clear();
      this.generation += 1;
    }

    invalidateModule(moduleName) {
      if (!moduleName) return;
      const key = String(moduleName).toLowerCase();
      for (const cacheKey of this.cache.keys()) {
        if (cacheKey.startsWith(key + '|')) this.cache.delete(cacheKey);
      }
      this.generation += 1;
    }

    onModuleLoad(modDesc) {
      if (!modDesc || !modDesc.name) return;
      const key = String(modDesc.name).toLowerCase();
      const pdbSymbols = (modDesc.pdbSymbols || [])
        .map(s => ({
          rvaStart: parseRva(s.rvaStart ?? s.rva_start),
          rvaEnd: parseRva(s.rvaEnd ?? s.rva_end),
          name: s.name,
          signature: s.signature || s.name,
          file: s.file || null,
          line: s.line ?? null
        }))
        .filter(s => Number.isFinite(s.rvaStart) && Number.isFinite(s.rvaEnd) && s.rvaEnd > s.rvaStart)
        .sort((a, b) => a.rvaStart - b.rvaStart);

      const exportsList = (modDesc.exports || [])
        .map(e => ({
          rva: parseRva(e.rva),
          rvaEnd: parseRva(e.rvaEnd ?? e.rva_end ?? (parseRva(e.rva) + (e.size || 0x200))),
          name: e.name,
          ordinal: e.ordinal ?? null
        }))
        .filter(e => Number.isFinite(e.rva) && Number.isFinite(e.rvaEnd) && e.rvaEnd > e.rva)
        .sort((a, b) => a.rva - b.rva);

      const pdata = (modDesc.pdata || [])
        .map(p => ({
          beginAddress: parseRva(p.beginAddress ?? p.BeginAddress ?? p.begin),
          endAddress: parseRva(p.endAddress ?? p.EndAddress ?? p.end)
        }))
        .filter(p => Number.isFinite(p.beginAddress) && Number.isFinite(p.endAddress) && p.endAddress > p.beginAddress)
        .sort((a, b) => a.beginAddress - b.beginAddress);

      this.modules.set(key, {
        name: modDesc.name,
        base: modDesc.base ?? 0n,
        sizeBytes: modDesc.sizeBytes || Math.round((modDesc.sizeMiB || 4) * 1024 * 1024),
        pdbLoaded: Boolean(modDesc.pdbLoaded ?? pdbSymbols.length > 0),
        pdbPath: modDesc.pdbPath || null,
        pdbSymbols,
        exports: exportsList,
        pdata
      });
      this.invalidateModule(modDesc.name);
    }

    onModuleUnload(moduleName) {
      if (!moduleName) return;
      this.modules.delete(String(moduleName).toLowerCase());
      this.invalidateModule(moduleName);
    }

    // Tier 3: Load sidecar JSON array [{"module":"foo.exe","rva_start":"0x14A200","rva_end":"0x14A480","name":"crate::hot_fn"}]
    loadSidecarJson(jsonInput) {
      const parsed = typeof jsonInput === 'string' ? JSON.parse(jsonInput) : jsonInput;
      if (!Array.isArray(parsed)) {
        throw new Error('Sidecar symbol map must be a JSON array');
      }
      let count = 0;
      const touched = new Set();
      for (const entry of parsed) {
        if (!entry || !entry.module || !entry.name) continue;
        const rvaStart = parseRva(entry.rva_start ?? entry.rvaStart);
        const rvaEnd = parseRva(entry.rva_end ?? entry.rvaEnd);
        if (!Number.isFinite(rvaStart) || !Number.isFinite(rvaEnd) || rvaEnd <= rvaStart) continue;
        const modKey = String(entry.module).toLowerCase();
        if (!this.sidecarMaps.has(modKey)) this.sidecarMaps.set(modKey, []);
        this.sidecarMaps.get(modKey).push({
          rvaStart,
          rvaEnd,
          name: String(entry.name),
          signature: entry.signature ? String(entry.signature) : String(entry.name)
        });
        touched.add(modKey);
        count += 1;
      }
      for (const modKey of touched) {
        this.sidecarMaps.get(modKey).sort((a, b) => a.rvaStart - b.rvaStart);
        this.invalidateModule(modKey);
      }
      return count;
    }

    clearSidecarMaps() {
      this.sidecarMaps.clear();
      this.invalidateAll();
    }

    hasSidecarForModule(moduleName) {
      if (!moduleName) return this.sidecarMaps.size > 0;
      const list = this.sidecarMaps.get(String(moduleName).toLowerCase());
      return Boolean(list && list.length > 0);
    }

    // Resolve by (moduleBaseOrName, rva) with strict precedence:
    // Tier 1 (PDB) > Tier 2 (PE Export) > Tier 3 (Sidecar JSON) > Tier 4 (PE .pdata) > RAW
    resolve(moduleOrBase, rvaInput) {
      const rva = parseRva(rvaInput);
      let mod = null;
      let moduleName = 'unknown';

      if (typeof moduleOrBase === 'string') {
        moduleName = moduleOrBase;
        mod = this.modules.get(moduleOrBase.toLowerCase()) || null;
      } else if (typeof moduleOrBase === 'bigint' || typeof moduleOrBase === 'number') {
        const baseBig = BigInt(moduleOrBase);
        for (const m of this.modules.values()) {
          if (BigInt(m.base || 0n) === baseBig) {
            mod = m;
            moduleName = m.name;
            break;
          }
        }
      }

      const modKey = (mod ? mod.name : moduleName).toLowerCase();
      const cacheKey = `${modKey}|${rva}`;
      if (this.cache.has(cacheKey)) {
        return this.cache.get(cacheKey);
      }

      const canonicalMod = mod ? mod.name : moduleName;
      const baseAddr = mod ? mod.base : 0n;
      let resolved = null;

      // Tier 1: PDB Symbols (SymFromAddrW + SymGetLineFromAddrW64)
      if (mod && mod.pdbLoaded && mod.pdbSymbols.length > 0) {
        const hit = binarySearchRange(mod.pdbSymbols, rva, 'rvaStart', 'rvaEnd');
        if (hit) {
          const lineOffset = Math.max(0, Math.floor((rva - hit.rvaStart) / 32));
          const fileLine = hit.file
            ? `${hit.file}:${hit.line !== null ? hit.line + lineOffset : 1}`
            : null;
          resolved = {
            module: canonicalMod,
            base: baseAddr,
            rva,
            fnStartRva: hit.rvaStart,
            fnEndRva: hit.rvaEnd,
            name: hit.name,
            displayName: hit.name,
            signature: hit.signature || hit.name,
            fileLine,
            tier: 'PDB',
            key: `${modKey}!${hit.name}`
          };
        }
      }

      // Tier 2: PE Export Table (IMAGE_DIRECTORY_ENTRY_EXPORT)
      if (!resolved && mod && mod.exports.length > 0) {
        const hit = binarySearchRange(mod.exports, rva, 'rva', 'rvaEnd');
        if (hit) {
          resolved = {
            module: canonicalMod,
            base: baseAddr,
            rva,
            fnStartRva: hit.rva,
            fnEndRva: hit.rvaEnd,
            name: hit.name,
            displayName: hit.name,
            signature: hit.ordinal !== null ? `${canonicalMod}!${hit.name} (ord #${hit.ordinal})` : `${canonicalMod}!${hit.name}`,
            fileLine: null,
            tier: 'EXP',
            key: `${modKey}!${hit.name}`
          };
        }
      }

      // Tier 3: Sidecar RVA Symbol Map (<module>.zen2sym.json / --symbols)
      if (!resolved) {
        const mapEntries = this.sidecarMaps.get(modKey);
        if (mapEntries && mapEntries.length > 0) {
          const hit = binarySearchRange(mapEntries, rva, 'rvaStart', 'rvaEnd');
          if (hit) {
            resolved = {
              module: canonicalMod,
              base: baseAddr,
              rva,
              fnStartRva: hit.rvaStart,
              fnEndRva: hit.rvaEnd,
              name: hit.name,
              displayName: hit.name,
              signature: hit.signature || `${canonicalMod}!${hit.name}`,
              fileLine: null,
              tier: 'MAP',
              key: `${modKey}!${hit.name}`
            };
          }
        }
      }

      // Tier 4: PE .pdata Exact Function Grouping (IMAGE_DIRECTORY_ENTRY_EXCEPTION RUNTIME_FUNCTION)
      if (!resolved && mod && mod.pdata.length > 0) {
        const hit = binarySearchRange(mod.pdata, rva, 'beginAddress', 'endAddress');
        if (hit) {
          const fnTag = `fn_${fmtHexRva(hit.beginAddress)}`;
          const synthName = `${canonicalMod}!${fnTag}`;
          resolved = {
            module: canonicalMod,
            base: baseAddr,
            rva,
            fnStartRva: hit.beginAddress,
            fnEndRva: hit.endAddress,
            name: synthName,
            displayName: fnTag,
            signature: `${synthName} [${fmtHexRva(hit.beginAddress)}..${fmtHexRva(hit.endAddress)})`,
            fileLine: null,
            tier: '.pdata',
            key: `${modKey}!${fnTag}`
          };
        }
      }

      // Fallback RAW
      if (!resolved) {
        const rawTag = fmtHexRva(rva);
        resolved = {
          module: canonicalMod,
          base: baseAddr,
          rva,
          fnStartRva: rva,
          fnEndRva: rva + 1,
          name: `${canonicalMod}!${rawTag}`,
          displayName: rawTag,
          signature: `${canonicalMod}+${rawTag} (no unwind .pdata)`,
          fileLine: null,
          tier: 'RAW',
          key: `${modKey}!${rawTag}`
        };
      }

      this.cache.set(cacheKey, resolved);
      return resolved;
    }

    // Resolve a raw address (VA) by matching module base..base+size
    resolveAddress(vaBig) {
      const va = BigInt(vaBig);
      for (const m of this.modules.values()) {
        const base = BigInt(m.base || 0n);
        const end = base + BigInt(m.sizeBytes || 0);
        if (va >= base && va < end) {
          return this.resolve(m.name, Number(va - base));
        }
      }
      return {
        module: 'unknown',
        base: 0n,
        rva: 0,
        fnStartRva: 0,
        fnEndRva: 0,
        name: `0x${va.toString(16).toUpperCase()}`,
        displayName: `0x${va.toString(16).toUpperCase()}`,
        signature: `0x${va.toString(16).toUpperCase()}`,
        fileLine: null,
        tier: 'RAW',
        key: `unknown!0x${va.toString(16).toUpperCase()}`
      };
    }

    // Helper for enriching raw/stripped names from AMDuProfCLI report.csv
    enrichCsvSymbol(moduleName, rawFuncName, rvaInput) {
      const rva = parseRva(rvaInput);
      const isStripped = !rawFuncName
        || /^0x[0-9a-f]+$/i.test(rawFuncName.trim())
        || /^unknown/i.test(rawFuncName.trim())
        || /^fn_0x[0-9a-f]+$/i.test(rawFuncName.trim())
        || rawFuncName.includes('!0x');

      if (Number.isFinite(rva) && rva > 0) {
        const res = this.resolve(moduleName, rva);
        if (isStripped || res.tier === 'PDB' || res.tier === 'EXP' || res.tier === 'MAP') {
          return res;
        }
      }
      return {
        module: moduleName || 'unknown',
        base: 0n,
        rva: Number.isFinite(rva) ? rva : 0,
        fnStartRva: Number.isFinite(rva) ? rva : 0,
        fnEndRva: Number.isFinite(rva) ? rva + 0x100 : 0,
        name: rawFuncName || `${moduleName}!unknown`,
        displayName: rawFuncName || 'unknown',
        signature: `${moduleName}!${rawFuncName || 'unknown'}`,
        fileLine: null,
        tier: isStripped ? '.pdata' : 'PDB',
        key: `${String(moduleName || 'unknown').toLowerCase()}!${rawFuncName || 'unknown'}`
      };
    }
  }

  Object.assign(Z, {
    parseRva,
    fmtHexRva,
    binarySearchRange,
    SymbolResolver
  });
})();
