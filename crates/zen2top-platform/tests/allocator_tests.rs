use zen2top_platform::allocator::{
    classify_layer1, AllocatorInspector, AllocatorKind, AllocatorObservation,
    Layer1AllocatorInspector, ObservedModule, RminjectMode, RminjectState,
};

fn mod_only(name: &str) -> ObservedModule {
    ObservedModule {
        name: name.to_string(),
        exports: Vec::new(),
    }
}

#[test]
fn layer1_classifies_standard_crt_and_heapalloc_empirically() {
    let inspector = Layer1AllocatorInspector;
    let obs = AllocatorObservation {
        modules: vec![mod_only("ntdll.dll"), mod_only("ucrtbase.dll")],
        has_crt_malloc: true,
        has_heap_alloc: true,
        has_virtual_alloc: false,
        private_rw_reserved_mib: 64.0,
        private_rw_huge_2mib_mib: 0.0,
        private_rw_large_reservations: 0,
        ws_mib: 900.0,
        peak_ws_mib: 1820.0,
        protected_process: false,
        has_lock_memory_privilege: true,
        avail_phys_pct: 50.0,
        total_ram_gib: 32.0,
    };

    let report = inspector.inspect(&obs).expect("inspection should succeed");
    assert_eq!(report.kind, AllocatorKind::StandardCrtHeapAlloc);
    assert_eq!(report.label, "Standard CRT / Win32 HeapAlloc");
    assert_eq!(report.rminject_eligibility.state, RminjectState::Eligible);
    assert!(report.rminject_eligibility.can_relaunch);
    assert_eq!(
        report.rminject_eligibility.recommended_mode,
        RminjectMode::Large
    );
    assert_eq!(report.rminject_eligibility.recommended_huge_gib, 3);
    assert!(report.rminject_eligibility.warnings.is_empty());
}

#[test]
fn layer1_classifies_direct_virtualalloc_and_private_rw_profile() {
    let obs = AllocatorObservation {
        modules: vec![mod_only("kernel32.dll"), mod_only("ntdll.dll")],
        has_crt_malloc: false,
        has_heap_alloc: false,
        has_virtual_alloc: true,
        private_rw_reserved_mib: 2048.0,
        private_rw_huge_2mib_mib: 0.0,
        private_rw_large_reservations: 8,
        has_lock_memory_privilege: true,
        avail_phys_pct: 60.0,
        total_ram_gib: 32.0,
        ..AllocatorObservation::default()
    };

    let report = classify_layer1(&obs);
    assert_eq!(report.kind, AllocatorKind::DirectVirtualAlloc);
    assert_eq!(report.label, "Direct VirtualAlloc / Custom Private RW");
    assert_eq!(
        report.rminject_eligibility.state,
        RminjectState::CustomAllocator
    );
    assert!(!report.rminject_eligibility.can_relaunch);
    assert_eq!(report.rminject_eligibility.recommended_huge_gib, 0);
}

#[test]
fn layer1_classifies_managed_jit_and_unknown_fallback() {
    let dotnet = AllocatorObservation {
        modules: vec![mod_only("coreclr.dll"), mod_only("clrjit.dll")],
        has_crt_malloc: false,
        has_heap_alloc: true,
        has_virtual_alloc: true,
        ..AllocatorObservation::default()
    };
    let dotnet_report = classify_layer1(&dotnet);
    assert_eq!(dotnet_report.kind, AllocatorKind::ManagedJitRuntime);
    assert_eq!(dotnet_report.label, "Managed / JIT Runtime");
    assert_eq!(
        dotnet_report.rminject_eligibility.state,
        RminjectState::GcVirtualAlloc
    );
    assert!(!dotnet_report.rminject_eligibility.can_relaunch);

    let unknown = AllocatorObservation::default();
    let unknown_report = classify_layer1(&unknown);
    assert_eq!(unknown_report.kind, AllocatorKind::UnknownFallback);
    assert_eq!(unknown_report.label, "Unknown (Layer 1 OS Fallback)");
    assert!(!unknown_report.rminject_eligibility.can_relaunch);
}

#[test]
fn layer1_detects_all_five_known_allocator_dlls_and_exports_without_app_tables() {
    let cases = [
        (
            r"C:\app\mimalloc-override.dll",
            AllocatorKind::Mimalloc,
            RminjectState::AlreadyMimalloc,
        ),
        (
            "jemalloc.dll",
            AllocatorKind::Jemalloc,
            RminjectState::CustomAllocator,
        ),
        (
            "tbbmalloc_proxy.dll",
            AllocatorKind::Tbbmalloc,
            RminjectState::CustomAllocator,
        ),
        (
            "rpmalloc.dll",
            AllocatorKind::Rpmalloc,
            RminjectState::CustomAllocator,
        ),
        (
            "tcmalloc_minimal.dll",
            AllocatorKind::Tcmalloc,
            RminjectState::CustomAllocator,
        ),
    ];

    for (dll, expected_kind, expected_state) in cases {
        let obs = AllocatorObservation {
            modules: vec![mod_only(dll), mod_only("ucrtbase.dll")],
            ..AllocatorObservation::default()
        };
        let report = classify_layer1(&obs);
        assert_eq!(report.kind, expected_kind);
        assert!(report.label.contains(expected_kind.generic_label()));
        assert_eq!(report.rminject_eligibility.state, expected_state);
        assert!(!report.rminject_eligibility.can_relaunch);
    }

    // Export-only empirical detection on an arbitrarily named module (zero hardcoded DLL/app names).
    let export_obs = AllocatorObservation {
        modules: vec![ObservedModule {
            name: "engine_runtime.dll".to_string(),
            exports: vec!["_mi_stats_main".to_string(), "mi_arena_count".to_string()],
        }],
        ..AllocatorObservation::default()
    };
    let export_report = classify_layer1(&export_obs);
    assert_eq!(export_report.kind, AllocatorKind::Mimalloc);
    assert_eq!(
        export_report.rminject_eligibility.state,
        RminjectState::AlreadyMimalloc
    );
}

#[test]
fn rminject_guardrails_block_protected_and_lock_large_without_privilege_or_ram() {
    let base_crt = AllocatorObservation {
        modules: vec![mod_only("ucrtbase.dll")],
        has_crt_malloc: true,
        has_heap_alloc: true,
        has_virtual_alloc: false,
        ws_mib: 1500.0,
        peak_ws_mib: 2048.0,
        protected_process: false,
        has_lock_memory_privilege: false,
        avail_phys_pct: 15.0,
        total_ram_gib: 32.0,
        ..AllocatorObservation::default()
    };

    let low_priv = classify_layer1(&base_crt);
    assert_eq!(low_priv.rminject_eligibility.state, RminjectState::Eligible);
    assert!(low_priv.rminject_eligibility.can_relaunch);
    assert_eq!(
        low_priv.rminject_eligibility.recommended_mode,
        RminjectMode::Standard
    );
    assert_eq!(low_priv.rminject_eligibility.recommended_huge_gib, 0);
    assert_eq!(low_priv.rminject_eligibility.warnings.len(), 2);

    let mut protected = base_crt;
    protected.protected_process = true;
    protected.has_lock_memory_privilege = true;
    protected.avail_phys_pct = 60.0;
    let blocked = classify_layer1(&protected);
    assert_eq!(
        blocked.rminject_eligibility.state,
        RminjectState::BlockedGuardrail
    );
    assert!(!blocked.rminject_eligibility.can_relaunch);
    assert_eq!(blocked.rminject_eligibility.recommended_huge_gib, 0);
}
