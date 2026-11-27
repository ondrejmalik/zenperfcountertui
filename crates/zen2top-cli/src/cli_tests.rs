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
        "--launch",
        "child.exe",
        "--warmup",
        "2",
        "--interval",
        "5",
        "--packs",
        "branches,exact-retiring",
        "--",
        "--child-flag",
        "a b",
    ])
    .expect("CLI flags should parse");
    assert!(cli.headless);
    assert!(cli.no_pmu);
    assert_eq!(cli.preset, "tlb-only");
    assert_eq!(cli.duration, 1);
    assert_eq!(cli.interval, Some(5));
    assert_eq!(cli.warmup, Some(2));
    assert_eq!(
        cli.packs.unwrap().0,
        [MetricPack::Branches, MetricPack::ExactRetiring]
    );
    assert_eq!(cli.launch_args, ["--child-flag", "a b"]);
}

#[test]
fn cli_print_presets_returns_ok() {
    let cli = Cli::try_parse_from(["zen2top", "--print-presets"]).expect("should parse");
    let code = run(cli).expect("--print-presets should succeed");
    assert_eq!(code, HeadlessExitCode::Ok);
}
