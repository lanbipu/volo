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

fn arc_screen(cols: u32, rows: u32, center_flat_cols: u32, angle_per_col_deg: f64) -> ScreenConfig {
    ScreenConfig {
        cabinet_count: [cols, rows],
        cabinet_size_mm: [500.0, 500.0],
        shape_prior: ShapePriorConfig::Arc { center_flat_cols, angle_per_col_deg },
        bottom_completion: None,
        absent_cells: vec![],
    }
}

#[test]
fn arc_zero_angle_matches_flat() {
    let arc = expected_grid_positions("MAIN", &arc_screen(4, 2, 0, 0.0)).unwrap();
    let flat = expected_grid_positions("MAIN", &flat_screen(4, 2)).unwrap();
    for g in &arc {
        let f = flat.iter().find(|x| x.name == g.name).unwrap();
        assert!((g.model_position - f.model_position).norm() < 1e-9, "{} diverged", g.name);
    }
}

#[test]
fn arc_anchors_v001_r001_at_origin() {
    let grid = expected_grid_positions("MAIN", &arc_screen(4, 2, 0, 10.0)).unwrap();
    let bl = grid.iter().find(|g| g.name == "MAIN_V001_R001").unwrap();
    assert!(bl.model_position.norm() < 1e-9, "got {:?}", bl.model_position);
}

#[test]
fn arc_bows_the_chord_shorter_than_flat_width() {
    // Symmetric arc, no flat center: the wall bows away from the straight
    // chord, so the V001->V005 distance should be < the flat 4×0.5m width.
    let grid = expected_grid_positions("MAIN", &arc_screen(4, 1, 0, 10.0)).unwrap();
    let v1 = grid.iter().find(|g| g.name == "MAIN_V001_R001").unwrap();
    let v5 = grid.iter().find(|g| g.name == "MAIN_V005_R001").unwrap();
    let chord = (v5.model_position - v1.model_position).norm();
    assert!(chord < 2.0, "expected bowed chord < flat width 2.0, got {chord}");
}

fn l_shape_screen(cols: u32, rows: u32, left_cols: u32, soften_cols: u32, corner_angle_deg: f64) -> ScreenConfig {
    ScreenConfig {
        cabinet_count: [cols, rows],
        cabinet_size_mm: [500.0, 500.0],
        shape_prior: ShapePriorConfig::LShape { left_cols, soften_cols, corner_angle_deg },
        bottom_completion: None,
        absent_cells: vec![],
    }
}

#[test]
fn l_shape_hard_corner_is_perpendicular() {
    // 2 left + 2 right cols, hard 90° corner (no soften): the corner seam
    // (V003, at the leg boundary) splits the wall into two perpendicular runs.
    let grid = expected_grid_positions("MAIN", &l_shape_screen(4, 1, 2, 0, 90.0)).unwrap();
    let v1 = grid.iter().find(|g| g.name == "MAIN_V001_R001").unwrap().model_position;
    let v3 = grid.iter().find(|g| g.name == "MAIN_V003_R001").unwrap().model_position;
    let v5 = grid.iter().find(|g| g.name == "MAIN_V005_R001").unwrap().model_position;
    assert!(v1.norm() < 1e-9, "V001_R001 should anchor the origin, got {v1:?}");
    let left_leg = v3 - v1;
    let right_leg = v5 - v3;
    assert!(left_leg.dot(&right_leg).abs() < 1e-9, "legs should be perpendicular: {left_leg:?} · {right_leg:?}");
    assert!((left_leg.norm() - 1.0).abs() < 1e-9, "left leg should span 2 cabinets = 1.0m, got {}", left_leg.norm());
    assert!((right_leg.norm() - 1.0).abs() < 1e-9, "right leg should span 2 cabinets = 1.0m, got {}", right_leg.norm());
}

fn u_shape_screen(cols: u32, rows: u32, wing_cols: u32, soften_cols: u32, corner_angle_deg: f64) -> ScreenConfig {
    ScreenConfig {
        cabinet_count: [cols, rows],
        cabinet_size_mm: [500.0, 500.0],
        shape_prior: ShapePriorConfig::UShape { wing_cols, soften_cols, corner_angle_deg },
        bottom_completion: None,
        absent_cells: vec![],
    }
}

#[test]
fn u_shape_symmetric_wings_return_to_the_same_depth() {
    // 1-col wings folding 90° each way around a 1-col center: the wall
    // starts and ends at the same "depth" (Y) — a defining U-shape property.
    let grid = expected_grid_positions("MAIN", &u_shape_screen(3, 1, 1, 0, 90.0)).unwrap();
    let v1 = grid.iter().find(|g| g.name == "MAIN_V001_R001").unwrap().model_position;
    let v4 = grid.iter().find(|g| g.name == "MAIN_V004_R001").unwrap().model_position;
    assert!(v1.norm() < 1e-9, "V001_R001 should anchor the origin, got {v1:?}");
    assert!((v1.y - v4.y).abs() < 1e-9, "wings should return to the same depth: {v1:?} vs {v4:?}");
}

fn custom_segments_screen(cols: u32, rows: u32, segments: Vec<(u32, f64)>) -> ScreenConfig {
    ScreenConfig {
        cabinet_count: [cols, rows],
        cabinet_size_mm: [500.0, 500.0],
        shape_prior: ShapePriorConfig::CustomSegments {
            segments: segments
                .into_iter()
                .map(|(cols, cum_angle_deg)| mesh_adapter_total_station::project::ShapeSegment { cols, cum_angle_deg })
                .collect(),
        },
        bottom_completion: None,
        absent_cells: vec![],
    }
}

#[test]
fn custom_segments_hold_a_straight_run_within_each_segment() {
    // Segment 1 (cols 0-1) flat, segment 2 (cols 2-3) at 45° — within a
    // segment, consecutive seam-to-seam vectors must be parallel (straight).
    let grid = expected_grid_positions(
        "MAIN",
        &custom_segments_screen(4, 1, vec![(2, 0.0), (2, 45.0)]),
    )
    .unwrap();
    let v3 = grid.iter().find(|g| g.name == "MAIN_V003_R001").unwrap().model_position;
    let v4 = grid.iter().find(|g| g.name == "MAIN_V004_R001").unwrap().model_position;
    let v5 = grid.iter().find(|g| g.name == "MAIN_V005_R001").unwrap().model_position;
    let a = v4 - v3;
    let b = v5 - v4;
    // Parallel same-direction vectors of equal length have a cross product
    // of ~0 and a dot product of ~|a||b|.
    assert!(a.cross(&b).norm() < 1e-9, "segment 2 should be a straight run: {a:?} vs {b:?}");
}

// Silence unused-import lint if the type is only referenced through methods.
#[allow(dead_code)]
fn _type_check(g: GridExpected) -> GridExpected {
    g
}
