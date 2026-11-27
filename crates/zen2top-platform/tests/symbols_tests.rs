use zen2top_platform::symbols::{
    parse_sidecar_json, ExportSymbol, ModuleSymbols, RuntimeFunction, SymbolRange, SymbolResolver,
    SymbolTier, TieredSymbolResolver,
};

fn setup_test_resolver() -> TieredSymbolResolver {
    let mut resolver = TieredSymbolResolver::new();
    resolver.register_module(ModuleSymbols {
        name: "client.dll".to_string(),
        base_addr: 0x7FFA_1200_0000,
        size_bytes: 64 * 1024 * 1024,
        pdb_loaded: true,
        pdb_symbols: vec![SymbolRange {
            rva_start: 0x1000,
            rva_end: 0x1200,
            name: "pdb_hot_fn".to_string(),
            signature: None,
            file: Some("src/hot.cpp".to_string()),
            line: Some(42),
        }],
        exports: vec![
            ExportSymbol {
                rva_start: 0x1000,
                rva_end: 0x1200,
                name: "export_shadowed_by_pdb".to_string(),
                ordinal: Some(1),
            },
            ExportSymbol {
                rva_start: 0x2000,
                rva_end: 0x2300,
                name: "ExportedApiFn".to_string(),
                ordinal: Some(12),
            },
        ],
        pdata: vec![
            // Deliberately unsorted to verify register_module sorts `.pdata` before binary search.
            RuntimeFunction {
                begin_address: 0x14_A200,
                end_address: 0x14_A480,
            },
            RuntimeFunction {
                begin_address: 0x3000,
                end_address: 0x3400,
            },
            RuntimeFunction {
                begin_address: 0x1000,
                end_address: 0x1200,
            },
            RuntimeFunction {
                begin_address: 0x2000,
                end_address: 0x2300,
            },
        ],
    });
    resolver
        .load_sidecar_json(
            r#"[
              {"module": "client.dll", "rva_start": "0x2000", "rva_end": "0x2300", "name": "sidecar_shadowed_by_export"},
              {"module": "client.dll", "rva_start": "0x3000", "rva_end": "0x3400", "name": "crate::sidecar_fn"}
            ]"#,
        )
        .expect("sidecar JSON should parse");
    resolver
}

#[test]
fn symbol_resolver_enforces_four_tier_precedence() {
    let resolver = setup_test_resolver();

    let t1 = resolver.resolve("client.dll", 0x1040);
    assert_eq!(t1.tier, SymbolTier::Pdb);
    assert_eq!(t1.name, "pdb_hot_fn");
    assert_eq!(t1.file_line.as_deref(), Some("src/hot.cpp:44"));

    let t2 = resolver.resolve("CLIENT.DLL", 0x2080);
    assert_eq!(t2.tier, SymbolTier::PeExport);
    assert_eq!(t2.name, "ExportedApiFn");
    assert_eq!(t2.module, "client.dll");

    let t3 = resolver.resolve("client.dll", 0x3120);
    assert_eq!(t3.tier, SymbolTier::SidecarMap);
    assert_eq!(t3.name, "crate::sidecar_fn");

    let t4 = resolver.resolve("client.dll", 0x14_A280);
    assert_eq!(t4.tier, SymbolTier::Pdata);
    assert_eq!(t4.name, "client.dll!fn_0x14A200");
}

#[test]
fn symbol_resolver_enforces_half_open_boundaries_and_va_lookup() {
    let resolver = setup_test_resolver();

    let before_start = resolver.resolve("client.dll", 0x14_A1FF);
    assert_eq!(before_start.tier, SymbolTier::Raw);
    assert_eq!(before_start.name, "client.dll!0x14A1FF");

    let at_start = resolver.resolve("client.dll", 0x14_A200);
    let at_last_byte = resolver.resolve("client.dll", 0x14_A47F);
    assert_eq!(at_start.tier, SymbolTier::Pdata);
    assert_eq!(at_last_byte.tier, SymbolTier::Pdata);
    assert_eq!(at_start.name, "client.dll!fn_0x14A200");
    assert_eq!(at_start.key, at_last_byte.key);
    assert_eq!(at_start.fn_start_rva, 0x14_A200);
    assert_eq!(at_start.fn_end_rva, 0x14_A480);

    let at_exclusive_end = resolver.resolve("client.dll", 0x14_A480);
    assert_eq!(at_exclusive_end.tier, SymbolTier::Raw);
    assert_eq!(at_exclusive_end.name, "client.dll!0x14A480");

    // Virtual address lookup resolves into the matching loaded module range.
    let va_hit = resolver.resolve_va(0x7FFA_1200_0000 + 0x14_A240);
    assert_eq!(va_hit.tier, SymbolTier::Pdata);
    assert_eq!(va_hit.name, "client.dll!fn_0x14A200");
    assert_eq!(va_hit.va, 0x7FFA_1200_0000 + 0x14_A240);

    let va_outside = resolver.resolve_va(0x7FFA_1200_0000 + 64 * 1024 * 1024);
    assert_eq!(va_outside.tier, SymbolTier::Raw);
    assert_eq!(va_outside.module, "unknown");
}

#[test]
fn sidecar_zen2sym_json_parser_supports_hex_decimal_and_unload() {
    let parsed = parse_sidecar_json(
        r#"[
          {"module": "app.exe", "rva_start": "0x1000", "rva_end": "0x1200", "name": "hex_fn"},
          {"module": "app.exe", "rvaStart": 8192, "rvaEnd": 8704, "name": "dec_fn"},
          {"module": "app.exe", "rva_start": "0x3000", "rva_end": "0x3000", "name": "empty_ignored"}
        ]"#,
    )
    .expect("valid sidecar JSON should parse");
    assert_eq!(parsed.len(), 2);
    assert_eq!(parsed[0].rva_start, 0x1000);
    assert_eq!(parsed[1].rva_start, 8192);

    assert!(parse_sidecar_json(r#"{"not":"an array"}"#).is_err());
    assert!(parse_sidecar_json(
        r#"[{"module":"app.exe","rva_start":"0xZZ","rva_end":"0x10","name":"bad"}]"#
    )
    .is_err());

    let mut resolver = TieredSymbolResolver::new();
    resolver.register_module(ModuleSymbols {
        name: "app.exe".to_string(),
        base_addr: 0x7FF6_0000_0000,
        size_bytes: 1024 * 1024,
        pdata: vec![RuntimeFunction {
            begin_address: 0x1000,
            end_address: 0x1200,
        }],
        ..ModuleSymbols::default()
    });
    assert_eq!(resolver.resolve("app.exe", 0x1050).tier, SymbolTier::Pdata);
    let count = resolver
        .load_sidecar_json(
            r#"[{"module":"app.exe","rva_start":"0x1000","rva_end":"0x1200","name":"crate::hot"}]"#,
        )
        .expect("sidecar loads");
    assert_eq!(count, 1);
    assert_eq!(
        resolver.resolve("app.exe", 0x1050).tier,
        SymbolTier::SidecarMap
    );

    resolver.unload_module("app.exe");
    // Unloaded module loses its base/pdata, though sidecar name remains indexed if queried directly.
    assert_eq!(resolver.resolve_va(0x7FF6_0000_1050).tier, SymbolTier::Raw);
}
