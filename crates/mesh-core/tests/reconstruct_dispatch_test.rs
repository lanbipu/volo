use mesh_core::coordinate::CoordinateFrame;
use mesh_core::measured_points::MeasuredPoints;
use mesh_core::point::{MeasuredPoint, PointSource};
use mesh_core::reconstruct::auto_reconstruct;
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
fn full_grid_picks_direct_link() {
    let mut pts = vec![];
    for r in 1..=3 {
        for c in 1..=4 {
            pts.push(p(&format!("MAIN_V{:03}_R{:03}", c, r), 0.0, 0.0, 0.0));
        }
    }
    let mp = MeasuredPoints {
        screen_id: "MAIN".into(),
        coordinate_frame: frame(),
        cabinet_array: CabinetArray::rectangle(3, 2, [500.0, 500.0]),
        shape_prior: ShapePrior::Flat,
        points: pts,
        sampling_mode: SamplingMode::Grid,
    };
    let surface = auto_reconstruct(&mp).unwrap();
    assert_eq!(surface.quality_metrics.method, "direct_link");
}

#[test]
fn only_corners_falls_back_to_nominal() {
    let mp = MeasuredPoints {
        screen_id: "MAIN".into(),
        coordinate_frame: frame(),
        cabinet_array: CabinetArray::rectangle(2, 2, [500.0, 500.0]),
        shape_prior: ShapePrior::Flat,
        points: vec![
            p("MAIN_V001_R001", 0.0, 0.0, 0.0),
            p("MAIN_V003_R001", 1.0, 0.0, 0.0),
            p("MAIN_V001_R003", 0.0, 0.0, 1.0),
            p("MAIN_V003_R003", 1.0, 0.0, 1.0),
        ],
        sampling_mode: SamplingMode::Grid,
    };
    let surface = auto_reconstruct(&mp).unwrap();
    assert_eq!(surface.quality_metrics.method, "nominal");
}

#[test]
fn top_bottom_plus_interior_picks_radial_basis() {
    // 4×4 cabinet array with full top + bottom rows + 1 interior anchor.
    // direct_link not applicable (interior columns don't have R002/R003/R004).
    // radial_basis applicable (4 corners present, ≥1 interior).
    // boundary_interp also applicable but should NOT be picked because radial uses
    // interior anchor exactly while boundary ignores it.
    let mut pts = vec![];
    for c in 1..=5 {
        let x = (c - 1) as f64 * 0.5;
        pts.push(p(&format!("MAIN_V{:03}_R001", c), x, 0.0, 0.0));
        pts.push(p(&format!("MAIN_V{:03}_R005", c), x, 0.0, 2.0));
    }
    pts.push(p("MAIN_V003_R003", 1.0, 0.5, 1.0)); // interior anchor with non-zero y

    let mp = MeasuredPoints {
        screen_id: "MAIN".into(),
        coordinate_frame: frame(),
        cabinet_array: CabinetArray::rectangle(4, 4, [500.0, 500.0]),
        shape_prior: ShapePrior::Flat,
        points: pts,
        sampling_mode: SamplingMode::Grid,
    };

    let surface = auto_reconstruct(&mp).unwrap();
    assert_eq!(
        surface.quality_metrics.method, "radial_basis",
        "interior anchor should pull dispatcher to radial_basis, not boundary_interp"
    );

    // Verify the interior anchor is reproduced (RBF property)
    let mid = surface.topology.vertex_index(2, 2);
    assert!(
        (surface.vertices[mid] - nalgebra::Vector3::new(1.0, 0.5, 1.0)).norm() < 1e-3,
        "radial_basis must reproduce the interior anchor"
    );
}

#[test]
fn boundary_only_falls_to_boundary_interp() {
    // FIX-11 dispatch: top + bottom rows complete, NO strictly interior
    // anchors → radial_basis is not applicable (edge anchors no longer count
    // as "interior") and the dispatcher reaches BoundaryInterpReconstructor.
    // The pre-fix version of this test DOCUMENTED the shadowing bug by
    // asserting radial won here — which routed pure boundary captures into
    // the meter-level bare-IMQ interpolation and made boundary_interp
    // production-unreachable.
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

    let surface = auto_reconstruct(&mp).unwrap();
    assert_eq!(surface.quality_metrics.method, "boundary_interp");
}
