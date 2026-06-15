use mesh_adapter_total_station::fallback::fabricate_bottom_rows;
use mesh_adapter_total_station::project::{
    BottomCompletion, FallbackMethod, ScreenConfig, ShapePriorConfig,
};
use nalgebra::Vector3;
use std::collections::HashMap;

fn flat_screen_with_fallback(cols: u32, rows: u32, lowest: u32) -> ScreenConfig {
    ScreenConfig {
        cabinet_count: [cols, rows],
        cabinet_size_mm: [500.0, 500.0],
        shape_prior: ShapePriorConfig::Flat,
        bottom_completion: Some(BottomCompletion {
            lowest_measurable_row: lowest,
            fallback_method: FallbackMethod::Vertical,
        }),
        absent_cells: vec![],
    }
}

#[test]
fn fabricate_bottom_uses_lowest_row_minus_height() {
    // 4×5 cabinet array, lowest_measurable_row=3 → fabricate R001 + R002
    // (vertex rows 0 + 1) from R003 (vertex row 2).
    let cfg = flat_screen_with_fallback(4, 5, 3);

    // measured: every column at vertex row 2 (R003) at z=1.0m
    let mut measured: HashMap<String, Vector3<f64>> = HashMap::new();
    for c in 1..=5u32 {
        measured.insert(
            format!("MAIN_V{:03}_R003", c),
            Vector3::new((c - 1) as f64 * 0.5, 0.0, 1.0),
        );
    }

    let fabricated = fabricate_bottom_rows("MAIN", &cfg, &measured).unwrap();

    // R001 + R002 × 5 columns = 10 fabricated points
    assert_eq!(fabricated.len(), 10);

    // R002 vertex 2 (col=1) should be 0.5m below R003 vertex
    let v2 = fabricated.get("MAIN_V002_R002").unwrap();
    assert!((v2 - Vector3::new(0.5, 0.0, 0.5)).norm() < 1e-9);
    let v1 = fabricated.get("MAIN_V001_R001").unwrap();
    assert!((v1 - Vector3::new(0.0, 0.0, 0.0)).norm() < 1e-9);
}

#[test]
fn fabricate_bottom_with_no_completion_returns_empty() {
    let cfg = ScreenConfig {
        cabinet_count: [4, 2],
        cabinet_size_mm: [500.0, 500.0],
        shape_prior: ShapePriorConfig::Flat,
        bottom_completion: None,
        absent_cells: vec![],
    };
    let measured: HashMap<String, Vector3<f64>> = HashMap::new();
    let fabricated = fabricate_bottom_rows("MAIN", &cfg, &measured).unwrap();
    assert!(fabricated.is_empty());
}

#[test]
fn fabricate_bottom_errors_when_anchor_row_missing() {
    let cfg = flat_screen_with_fallback(4, 5, 3);
    // Empty measured map → can't anchor on R003.
    let measured: HashMap<String, Vector3<f64>> = HashMap::new();
    let result = fabricate_bottom_rows("MAIN", &cfg, &measured);
    assert!(result.is_err());
}
