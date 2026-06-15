use mesh_adapter_total_station::builder::build_screen_measured_points_with_outcome;
use mesh_adapter_total_station::project::{ScreenConfig, ShapePriorConfig};
use mesh_adapter_total_station::raw_point::RawPoint;
use mesh_adapter_total_station::report_builder::build_screen_report;
use nalgebra::Vector3;

fn rp(id: u32, x_mm: f64, y_mm: f64, z_mm: f64) -> RawPoint {
    RawPoint {
        instrument_id: id,
        position_mm: Vector3::new(x_mm, y_mm, z_mm),
        note: None,
    }
}

#[test]
fn report_counts_measured_and_missing() {
    let raw = vec![
        rp(1, 1000.0, 1000.0, 1000.0), // origin
        rp(2, 3000.0, 1000.0, 1000.0), // x-axis
        rp(3, 1000.0, 1000.0, 2000.0), // xy-plane
        rp(4, 1500.0, 1000.0, 1000.0), // → MAIN_V002_R001
    ];
    let cfg = ScreenConfig {
        cabinet_count: [4, 2],
        cabinet_size_mm: [500.0, 500.0],
        shape_prior: ShapePriorConfig::Flat,
        bottom_completion: None,
        absent_cells: vec![],
    };
    let (mp, outcome) = build_screen_measured_points_with_outcome("MAIN", &raw, &cfg).unwrap();
    let report = build_screen_report("MAIN", &mp, &outcome, &cfg);

    // Expected = 5×3 = 15
    assert_eq!(report.expected_count, 15);
    // Measured = 4 named (V001_R001, V005_R001, V001_R003, V002_R001)
    assert_eq!(report.measured_count, 4);
    assert_eq!(report.fabricated_count, 0);
    // Missing = 15 - 4 = 11
    assert_eq!(report.missing.len(), 11);
    assert!(report.estimated_rms_mm > 0.0);
}

#[test]
fn report_records_outliers_when_point_too_far() {
    let raw = vec![
        rp(1, 1000.0, 1000.0, 1000.0),
        rp(2, 3000.0, 1000.0, 1000.0),
        rp(3, 1000.0, 1000.0, 2000.0),
        rp(4, 99999.0, 99999.0, 99999.0), // outlier
    ];
    let cfg = ScreenConfig {
        cabinet_count: [4, 2],
        cabinet_size_mm: [500.0, 500.0],
        shape_prior: ShapePriorConfig::Flat,
        bottom_completion: None,
        absent_cells: vec![],
    };
    let (mp, outcome) = build_screen_measured_points_with_outcome("MAIN", &raw, &cfg).unwrap();
    let report = build_screen_report("MAIN", &mp, &outcome, &cfg);

    assert_eq!(report.outliers.len(), 1);
    assert_eq!(report.outliers[0].instrument_id, 4);
}
