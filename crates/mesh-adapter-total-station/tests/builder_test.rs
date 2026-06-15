use mesh_adapter_total_station::builder::build_screen_measured_points;
use mesh_adapter_total_station::project::{ScreenConfig, ShapePriorConfig};
use mesh_adapter_total_station::raw_point::RawPoint;
use mesh_core::point::PointSource;
use nalgebra::Vector3;

fn rp(id: u32, x_mm: f64, y_mm: f64, z_mm: f64) -> RawPoint {
    RawPoint {
        instrument_id: id,
        position_mm: Vector3::new(x_mm, y_mm, z_mm),
        note: None,
    }
}

fn flat_4x2() -> ScreenConfig {
    ScreenConfig {
        cabinet_count: [4, 2],
        cabinet_size_mm: [500.0, 500.0],
        shape_prior: ShapePriorConfig::Flat,
        bottom_completion: None,
        absent_cells: vec![],
    }
}

#[test]
fn builder_assigns_grid_names_and_returns_measured_points() {
    // SOP: ids 1, 2, 3 = origin / x-axis / xy-plane.
    // 4×2 flat screen, lowest=R001:
    //   origin = MAIN_V001_R001 (model 0,0,0)
    //   x_axis = MAIN_V005_R001 (model 2,0,0) → instrument at +X 2m from origin
    //   xy_plane = MAIN_V001_R003 (model 0,0,1) → instrument at +Z 1m from origin
    //   (row direction = +Z per M0.1 convention)
    let raw = vec![
        rp(1, 1000.0, 1000.0, 1000.0), // origin
        rp(2, 3000.0, 1000.0, 1000.0), // x-axis ref, +2m X
        rp(3, 1000.0, 1000.0, 2000.0), // xy-plane ref, +1m Z
        rp(4, 1500.0, 1000.0, 1000.0), // → MAIN_V002_R001 (model 0.5,0,0)
        rp(5, 3000.0, 1000.0, 2000.0), // → MAIN_V005_R003 (model 2,0,1)
    ];
    let cfg = flat_4x2();
    let mp = build_screen_measured_points("MAIN", &raw, &cfg).unwrap();

    assert!(mp.points.len() >= 3);

    let bl = mp
        .points
        .iter()
        .find(|p| p.name == "MAIN_V001_R001")
        .unwrap();
    assert!(matches!(bl.source, PointSource::TotalStation));
    assert!(bl.position.norm() < 1e-9);

    let v2 = mp
        .points
        .iter()
        .find(|p| p.name == "MAIN_V002_R001")
        .unwrap();
    assert!((v2.position - Vector3::new(0.5, 0.0, 0.0)).norm() < 1e-3);
}

#[test]
fn builder_with_bottom_completion_inserts_fabricated_rows() {
    use mesh_adapter_total_station::project::{BottomCompletion, FallbackMethod};

    let mut cfg = flat_4x2();
    cfg.cabinet_count = [4, 4];
    cfg.bottom_completion = Some(BottomCompletion {
        lowest_measurable_row: 3,
        fallback_method: FallbackMethod::Vertical,
    });

    let raw = vec![
        rp(1, 1000.0, 1000.0, 2000.0), // origin = MAIN_V001_R003 (model 0,0,0)
        rp(2, 3000.0, 1000.0, 2000.0), // x-axis = MAIN_V005_R003 (model 2,0,0)
        rp(3, 1000.0, 1000.0, 3000.0), // xy-plane = MAIN_V001_R005 (model 0,0,1)
    ];
    let mp = build_screen_measured_points("MAIN", &raw, &cfg).unwrap();

    // Fabricated rows below R003 should appear.
    assert!(mp.points.iter().any(|p| p.name == "MAIN_V001_R001"));
    assert!(mp.points.iter().any(|p| p.name == "MAIN_V003_R002"));
}
