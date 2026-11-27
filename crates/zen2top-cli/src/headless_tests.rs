use super::*;
use zen2top_platform::pmu::contention::{classify_occupant, PmcOccupantKind};

#[test]
fn contention_writes_json_before_returning_exit_three() {
    let occupant = classify_occupant(
        PmcOccupantKind::EtwPmcSession,
        "SHS-test",
        None,
        None,
        Some("SHS-test".into()),
    );
    let request = CaptureRequest {
        contention: Some(PmcContentionReport {
            detected: true,
            occupants: vec![occupant],
            summary: "Fixture PMCs occupied".into(),
            remediation: "Use --no-pmu".into(),
        }),
        ..Default::default()
    };
    let mut output = Vec::new();

    let code = write_capture(&request, None, None, &mut output).unwrap();
    let report: serde_json::Value = serde_json::from_slice(&output).unwrap();

    assert_eq!(code.as_i32(), 3);
    assert_eq!(
        report["meta"]["pmc_contention"]["occupants"][0]["session_name"],
        "SHS-test"
    );
    assert_eq!(report["meta"]["evidence_gate_passed"], false);
    assert_eq!(report["advisor"]["findings"], serde_json::json!([]));
}

#[test]
fn utc_timestamp_handles_leap_day_and_midnight() {
    assert_eq!(utc_timestamp(0), "1970-01-01T00:00:00Z");
    assert_eq!(utc_timestamp(1_709_251_199), "2024-02-29T23:59:59Z");
    assert_eq!(utc_timestamp(1_709_251_200), "2024-03-01T00:00:00Z");
}
