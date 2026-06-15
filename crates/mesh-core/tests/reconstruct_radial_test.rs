use mesh_core::coordinate::CoordinateFrame;
use mesh_core::measured_points::MeasuredPoints;
use mesh_core::point::{MeasuredPoint, PointSource};
use mesh_core::reconstruct::radial_basis::RadialBasisReconstructor;
use mesh_core::reconstruct::Reconstructor;
use mesh_core::shape::{CabinetArray, ShapePrior};
use mesh_core::uncertainty::Uncertainty;
use mesh_core::sampling::SamplingMode;
use nalgebra::Vector3;

fn p(name: &str, x: f64, y: f64, z: f64) -> MeasuredPoint {
    MeasuredPoint {
        name: name.into(),
        position: Vector3::new(x, y, z),
        uncertainty: Uncertainty::Isotropic(2.0),
        source: PointSource::TotalStation,
    }
}

fn frame() -> CoordinateFrame {
    CoordinateFrame::from_three_points(
        Vector3::zeros(),
        Vector3::new(1.0, 0.0, 0.0),
        Vector3::new(0.0, 0.0, 1.0),
    )
    .unwrap()
}

#[test]
fn radial_basis_reproduces_anchor_points_exactly() {
    // Sparse: 4 corners + 1 middle, in a 4×4 cabinet grid (5×5 vertices = 25)
    let mp = MeasuredPoints {
        screen_id: "MAIN".into(),
        coordinate_frame: frame(),
        cabinet_array: CabinetArray::rectangle(4, 4, [500.0, 500.0]),
        shape_prior: ShapePrior::Flat,
        points: vec![
            p("MAIN_V001_R001", 0.0, 0.0, 0.0),
            p("MAIN_V005_R001", 2.0, 0.0, 0.0),
            p("MAIN_V001_R005", 0.0, 0.0, 2.0),
            p("MAIN_V005_R005", 2.0, 0.0, 2.0),
            p("MAIN_V003_R003", 1.0, 0.0, 1.0),
        ],
        sampling_mode: SamplingMode::Grid,
    };

    let r = RadialBasisReconstructor;
    assert!(r.applicable(&mp));
    let surface = r.reconstruct(&mp).unwrap();
    assert_eq!(surface.vertices.len(), 25);

    // The anchor at (col=2, row=2) → (1, 0, 1) should be reproduced exactly
    let mid = surface.topology.vertex_index(2, 2);
    assert!((surface.vertices[mid] - Vector3::new(1.0, 0.0, 1.0)).norm() < 1e-3);
}

#[test]
fn radial_basis_with_only_4_corners_is_not_applicable() {
    // 4 corners alone is mathematically equivalent to bilinear; the
    // dispatcher should fall through to NominalReconstructor instead
    // of running RBF (which would shadow nominal forever).
    let mp = MeasuredPoints {
        screen_id: "MAIN".into(),
        coordinate_frame: frame(),
        cabinet_array: CabinetArray::rectangle(4, 4, [500.0, 500.0]),
        shape_prior: ShapePrior::Flat,
        points: vec![
            p("MAIN_V001_R001", 0.0, 0.0, 0.0),
            p("MAIN_V005_R001", 2.0, 0.0, 0.0),
            p("MAIN_V001_R005", 0.0, 0.0, 2.0),
            p("MAIN_V005_R005", 2.0, 0.0, 2.0),
        ],
        sampling_mode: SamplingMode::Grid,
    };
    let r = RadialBasisReconstructor;
    assert!(!r.applicable(&mp));
}

#[test]
fn radial_basis_needs_more_than_4_points() {
    let mp = MeasuredPoints {
        screen_id: "MAIN".into(),
        coordinate_frame: frame(),
        cabinet_array: CabinetArray::rectangle(4, 4, [500.0, 500.0]),
        shape_prior: ShapePrior::Flat,
        points: vec![p("MAIN_V001_R001", 0.0, 0.0, 0.0)],
        sampling_mode: SamplingMode::Grid,
    };
    let r = RadialBasisReconstructor;
    assert!(!r.applicable(&mp));
}

#[test]
fn radial_basis_rejects_clustered_anchors_without_corners() {
    // 5 anchors all clustered in middle, no corners → cannot extrapolate edges.
    let mp = MeasuredPoints {
        screen_id: "MAIN".into(),
        coordinate_frame: frame(),
        cabinet_array: CabinetArray::rectangle(4, 4, [500.0, 500.0]),
        shape_prior: ShapePrior::Flat,
        points: vec![
            p("MAIN_V002_R002", 0.5, 0.0, 0.5),
            p("MAIN_V003_R002", 1.0, 0.0, 0.5),
            p("MAIN_V004_R002", 1.5, 0.0, 0.5),
            p("MAIN_V002_R003", 0.5, 0.0, 1.0),
            p("MAIN_V003_R003", 1.0, 0.0, 1.0),
        ],
        sampling_mode: SamplingMode::Grid,
    };
    let r = RadialBasisReconstructor;
    assert!(
        !r.applicable(&mp),
        "should reject inputs without all 4 corners"
    );
}

#[test]
fn radial_basis_ignores_out_of_grid_anchor_names() {
    // 4 corners + 1 out-of-grid stray → only 4 in-grid unique anchors → not applicable.
    let mp = MeasuredPoints {
        screen_id: "MAIN".into(),
        coordinate_frame: frame(),
        cabinet_array: CabinetArray::rectangle(4, 4, [500.0, 500.0]),
        shape_prior: ShapePrior::Flat,
        points: vec![
            p("MAIN_V001_R001", 0.0, 0.0, 0.0),
            p("MAIN_V005_R001", 2.0, 0.0, 0.0),
            p("MAIN_V001_R005", 0.0, 0.0, 2.0),
            p("MAIN_V005_R005", 2.0, 0.0, 2.0),
            p("MAIN_V999_R999", 100.0, 0.0, 100.0), // out of grid
        ],
        sampling_mode: SamplingMode::Grid,
    };
    let r = RadialBasisReconstructor;
    assert!(
        !r.applicable(&mp),
        "out-of-grid stray must not count as anchor"
    );
}

#[test]
fn radial_basis_dedupes_repeated_anchor_names() {
    // 4 corners + same interior name twice = 5 raw, but only 4 unique → not applicable.
    let mp = MeasuredPoints {
        screen_id: "MAIN".into(),
        coordinate_frame: frame(),
        cabinet_array: CabinetArray::rectangle(4, 4, [500.0, 500.0]),
        shape_prior: ShapePrior::Flat,
        points: vec![
            p("MAIN_V001_R001", 0.0, 0.0, 0.0),
            p("MAIN_V005_R001", 2.0, 0.0, 0.0),
            p("MAIN_V001_R005", 0.0, 0.0, 2.0),
            p("MAIN_V005_R005", 2.0, 0.0, 2.0),
            p("MAIN_V001_R001", 0.0, 0.0, 0.0), // duplicate of corner
        ],
        sampling_mode: SamplingMode::Grid,
    };
    let r = RadialBasisReconstructor;
    assert!(
        !r.applicable(&mp),
        "duplicate names must not inflate anchor count"
    );
}


#[test]
fn radial_basis_non_anchor_vertices_land_on_flat_wall() {
    // FIX-11 acceptance (the re-computed review scenario): a 60x10 flat wall of
    // 500mm cabinets with full top+bottom vertex rows + 3 interior midpoints.
    // EVERY vertex — the NON-ANCHOR interior ones included — must land on the
    // true wall to < 5mm. The bare-IMQ interpolant scored 2.25m mean / 13.6m
    // worst here while reporting max(sigma, 8mm); the affine tail makes flat
    // (affine-in-(c,r)) data exact.
    let cols = 60u32;
    let rows = 10u32;
    let cw = 0.5; // meters per cabinet, both axes
    let pos = |c: u32, r: u32| Vector3::new(c as f64 * cw, 0.0, r as f64 * cw);
    let mut pts = vec![];
    for c in 0..=cols {
        pts.push(p(&format!("MAIN_V{:03}_R001", c + 1), pos(c, 0).x, 0.0, pos(c, 0).z));
        pts.push(p(
            &format!("MAIN_V{:03}_R{:03}", c + 1, rows + 1),
            pos(c, rows).x,
            0.0,
            pos(c, rows).z,
        ));
    }
    for (c, r) in [(15u32, 5u32), (30, 5), (45, 5)] {
        pts.push(p(
            &format!("MAIN_V{:03}_R{:03}", c + 1, r + 1),
            pos(c, r).x,
            0.0,
            pos(c, r).z,
        ));
    }
    let mp = MeasuredPoints {
        screen_id: "MAIN".into(),
        coordinate_frame: frame(),
        cabinet_array: CabinetArray::rectangle(cols, rows, [500.0, 500.0]),
        shape_prior: ShapePrior::Flat,
        points: pts,
        sampling_mode: SamplingMode::Grid,
    };
    let r = RadialBasisReconstructor;
    assert!(r.applicable(&mp), "3 strictly interior midpoints -> applicable");
    let surface = r.reconstruct(&mp).unwrap();
    let mut worst = 0.0f64;
    for rr in 0..=rows {
        for cc in 0..=cols {
            let idx = surface.topology.vertex_index(cc, rr);
            let err = (surface.vertices[idx] - pos(cc, rr)).norm();
            worst = worst.max(err);
        }
    }
    // < 5mm acceptance; in meters here (grid spacing 0.5m) -> 0.005.
    assert!(
        worst < 0.005,
        "worst vertex error {:.4}m exceeds 5mm (bare-IMQ scored up to 13.6m)",
        worst
    );
}

#[test]
fn radial_basis_edge_only_anchors_not_applicable() {
    // FIX-11 dispatch: full top+bottom rows but nothing strictly interior ->
    // radial must decline so boundary_interp can run.
    let mut pts = vec![];
    for c in 1..=5 {
        let x = (c - 1) as f64 * 0.5;
        pts.push(p(&format!("MAIN_V{:03}_R001", c), x, 0.0, 0.0));
        pts.push(p(&format!("MAIN_V{:03}_R005", c), x, 0.0, 2.0));
    }
    let mp = MeasuredPoints {
        screen_id: "MAIN".into(),
        coordinate_frame: frame(),
        cabinet_array: CabinetArray::rectangle(4, 4, [500.0, 500.0]),
        shape_prior: ShapePrior::Flat,
        points: pts,
        sampling_mode: SamplingMode::Grid,
    };
    let r = RadialBasisReconstructor;
    assert!(!r.applicable(&mp));
}
