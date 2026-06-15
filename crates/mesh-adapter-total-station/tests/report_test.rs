use mesh_adapter_total_station::report::{
    AdapterReport, AmbiguousMatch, MissingPoint, OutlierPoint, ScreenReport,
};

#[test]
fn screen_report_serializes_to_json() {
    let r = ScreenReport {
        screen_id: "MAIN".into(),
        expected_count: 277,
        measured_count: 273,
        fabricated_count: 0,
        missing: vec![MissingPoint {
            name: "MAIN_V015_R020".into(),
        }],
        outliers: vec![OutlierPoint {
            instrument_id: 42,
            distance_to_nearest_mm: 87.3,
            nearest_grid_name: "MAIN_V010_R005".into(),
        }],
        ambiguous: vec![AmbiguousMatch {
            instrument_id: 51,
            candidates: vec!["MAIN_V005_R005".into(), "MAIN_V006_R005".into()],
        }],
        warnings: vec!["Top edge has 4 missing points".into()],
        estimated_rms_mm: 4.5,
    };
    let s = serde_json::to_string_pretty(&r).unwrap();
    assert!(s.contains("\"expected_count\": 277"));
    assert!(s.contains("MAIN_V015_R020"));
    assert!(s.contains("\"distance_to_nearest_mm\": 87.3"));
}

#[test]
fn adapter_report_contains_screens() {
    let r = AdapterReport {
        project_name: "Studio_A".into(),
        screens: vec![ScreenReport {
            screen_id: "MAIN".into(),
            expected_count: 4,
            measured_count: 4,
            fabricated_count: 0,
            missing: vec![],
            outliers: vec![],
            ambiguous: vec![],
            warnings: vec![],
            estimated_rms_mm: 2.0,
        }],
    };
    let s = serde_json::to_string(&r).unwrap();
    assert!(s.contains("\"project_name\":\"Studio_A\""));
    assert!(s.contains("\"screen_id\":\"MAIN\""));
}
