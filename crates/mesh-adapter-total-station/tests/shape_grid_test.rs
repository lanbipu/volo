use mesh_adapter_total_station::project::{
    BottomCompletion, FallbackMethod, ScreenConfig, ShapePriorConfig,
};
use mesh_adapter_total_station::shape_grid::{expected_grid_positions, GridExpected};
use nalgebra::Vector3;

fn flat_screen(cols: u32, rows: u32) -> ScreenConfig {
    ScreenConfig {
        cabinet_count: [cols, rows],
        cabinet_size_mm: [500.0, 500.0],
        shape_prior: ShapePriorConfig::Flat,
        bottom_completion: None,
        absent_cells: vec![],
    }
}

#[test]
fn flat_4x2_grid_yields_15_expected_positions() {
    let cfg = flat_screen(4, 2);
    let grid = expected_grid_positions("MAIN", &cfg).unwrap();
    // (cols+1) × (rows+1) = 5 × 3 = 15
    assert_eq!(grid.len(), 15);

    // Bottom-left V001_R001 at (0, 0, 0) (origin assumed at lowest-left)
    let bl = grid.iter().find(|g| g.name == "MAIN_V001_R001").unwrap();
    assert!((bl.model_position - Vector3::new(0.0, 0.0, 0.0)).norm() < 1e-9);

    // Top-right V005_R003 at (2.0, 0, 1.0) for 4 col × 2 row × 0.5m cabinets
    let tr = grid.iter().find(|g| g.name == "MAIN_V005_R003").unwrap();
    assert!((tr.model_position - Vector3::new(2.0, 0.0, 1.0)).norm() < 1e-9);
}

#[test]
fn flat_grid_skips_absent_cells_neighborhood_keeps_corner() {
    let mut cfg = flat_screen(3, 3);
    // Mark center cabinet (1,1) absent. Its 4 corner vertices are still
    // present because each is shared with at least one present cabinet.
    cfg.absent_cells = vec![(1, 1)];
    let grid = expected_grid_positions("MAIN", &cfg).unwrap();
    // 4×4 = 16 vertices; one absent cabinet doesn't remove any vertex
    // (corners are shared). expected_grid_positions returns ALL grid
    // vertex positions; absent cabinets are reflected by absent_cells in
    // CabinetArray downstream — not by removing grid vertices here.
    assert_eq!(grid.len(), 16);
}

#[test]
fn curved_grid_anchors_v001_r001_at_origin() {
    // Function contract: V001_R001 sits at (0, 0, 0) regardless of shape
    // prior. The raw chord formula puts V001 at theta=-half_angle which
    // is negative-X; the implementation must translate so the anchor
    // lands on the origin (matches Flat's behavior).
    let cfg = ScreenConfig {
        cabinet_count: [4, 2],
        cabinet_size_mm: [500.0, 500.0],
        shape_prior: ShapePriorConfig::Curved {
            radius_mm: 10_000.0,
        },
        bottom_completion: None,
        absent_cells: vec![],
    };
    let grid = expected_grid_positions("MAIN", &cfg).unwrap();
    let bl = grid.iter().find(|g| g.name == "MAIN_V001_R001").unwrap();
    assert!(
        bl.model_position.norm() < 1e-9,
        "V001_R001 should be at origin, got {:?}",
        bl.model_position
    );
}

#[test]
fn curved_3x1_grid_arcs_along_x() {
    // Half-cylinder with very large radius behaves nearly flat — sanity check.
    let cfg = ScreenConfig {
        cabinet_count: [3, 1],
        cabinet_size_mm: [500.0, 500.0],
        shape_prior: ShapePriorConfig::Curved {
            radius_mm: 100_000.0, // 100m radius — gentle arc
        },
        bottom_completion: None,
        absent_cells: vec![],
    };
    let grid = expected_grid_positions("MAIN", &cfg).unwrap();
    assert_eq!(grid.len(), 8); // 4 × 2

    let bl = grid.iter().find(|g| g.name == "MAIN_V001_R001").unwrap();
    let br = grid.iter().find(|g| g.name == "MAIN_V004_R001").unwrap();
    // Arc length from V001 to V004 should be 3 × 0.5 = 1.5m;
    // chord length is slightly less than 1.5m for a 100m-radius arc.
    let chord = (br.model_position - bl.model_position).norm();
    assert!(chord < 1.5);
    assert!(chord > 1.499);
}

#[test]
fn bottom_completion_does_not_change_grid_size() {
    // The grid is always (cols+1)×(rows+1); bottom completion only
    // affects which rows are "fabricated" downstream — see fallback.rs.
    let cfg = ScreenConfig {
        cabinet_count: [4, 10],
        cabinet_size_mm: [500.0, 500.0],
        shape_prior: ShapePriorConfig::Flat,
        bottom_completion: Some(BottomCompletion {
            lowest_measurable_row: 5,
            fallback_method: FallbackMethod::Vertical,
        }),
        absent_cells: vec![],
    };
    let grid = expected_grid_positions("MAIN", &cfg).unwrap();
    assert_eq!(grid.len(), (4 + 1) * (10 + 1));
}

// Silence unused-import lint if the type is only referenced through methods.
#[allow(dead_code)]
fn _type_check(g: GridExpected) -> GridExpected {
    g
}
