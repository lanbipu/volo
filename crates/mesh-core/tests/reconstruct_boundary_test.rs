use mesh_core::coordinate::CoordinateFrame;
use mesh_core::measured_points::MeasuredPoints;
use mesh_core::point::{MeasuredPoint, PointSource};
use mesh_core::reconstruct::boundary_interp::BoundaryInterpReconstructor;
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

fn frame_at_origin() -> CoordinateFrame {
    CoordinateFrame::from_three_points(
        Vector3::zeros(),
        Vector3::new(1.0, 0.0, 0.0),
        Vector3::new(0.0, 0.0, 1.0),
    )
    .unwrap()
}

#[test]
fn boundary_interp_with_top_bottom_complete_works() {
    // 4×2 cabinet array, top + bottom edge measured (5 points each), no middle
    let mut pts = vec![];
    for c in 1..=5 {
        let x = (c - 1) as f64 * 0.5;
        pts.push(p(&format!("MAIN_V{:03}_R001", c), x, 0.0, 0.0));
        pts.push(p(&format!("MAIN_V{:03}_R003", c), x, 0.0, 1.0));
    }

    let mp = MeasuredPoints {
        screen_id: "MAIN".into(),
        coordinate_frame: frame_at_origin(),
        cabinet_array: CabinetArray::rectangle(4, 2, [500.0, 500.0]),
        shape_prior: ShapePrior::Flat,
        points: pts,
        sampling_mode: SamplingMode::Grid,
    };

    let r = BoundaryInterpReconstructor;
    assert!(r.applicable(&mp));
    let surface = r.reconstruct(&mp).unwrap();

    // 5 × 3 = 15 vertices
    assert_eq!(surface.vertices.len(), 15);

    // Middle row (R002, row index 1) should be linear average → z=0.5
    let mid = surface.topology.vertex_index(2, 1);
    assert!((surface.vertices[mid].z - 0.5).abs() < 1e-9);
}

#[test]
fn boundary_interp_with_missing_top_corner_not_applicable() {
    let mut pts = vec![];
    for c in 1..=5 {
        // missing R001 corner (V001_R001)
        if c != 1 {
            pts.push(p(
                &format!("MAIN_V{:03}_R001", c),
                (c - 1) as f64 * 0.5,
                0.0,
                0.0,
            ));
        }
        pts.push(p(
            &format!("MAIN_V{:03}_R003", c),
            (c - 1) as f64 * 0.5,
            0.0,
            1.0,
        ));
    }

    let mp = MeasuredPoints {
        screen_id: "MAIN".into(),
        coordinate_frame: frame_at_origin(),
        cabinet_array: CabinetArray::rectangle(4, 2, [500.0, 500.0]),
        shape_prior: ShapePrior::Flat,
        points: pts,
        sampling_mode: SamplingMode::Grid,
    };

    let r = BoundaryInterpReconstructor;
    assert!(!r.applicable(&mp));
}

#[test]
fn boundary_interp_flags_interior_point_disagreement() {
    // 4×2 cabinet array, top + bottom + 1 interior point that disagrees with
    // the interpolation (true position elsewhere).
    let mut pts = vec![];
    for c in 1..=5 {
        let x = (c - 1) as f64 * 0.5;
        pts.push(p(&format!("MAIN_V{:03}_R001", c), x, 0.0, 0.0));
        pts.push(p(&format!("MAIN_V{:03}_R003", c), x, 0.0, 1.0));
    }
    // Add interior point V003_R002 at (1.0, 0.05, 0.5) — interpolation says
    // (1.0, 0.0, 0.5); deviation in y is 0.05 m = 50mm > 10mm threshold.
    pts.push(p("MAIN_V003_R002", 1.0, 0.05, 0.5));

    let mp = MeasuredPoints {
        screen_id: "MAIN".into(),
        coordinate_frame: frame_at_origin(),
        cabinet_array: CabinetArray::rectangle(4, 2, [500.0, 500.0]),
        shape_prior: ShapePrior::Flat,
        points: pts,
        sampling_mode: SamplingMode::Grid,
    };

    let r = BoundaryInterpReconstructor;
    let surface = r.reconstruct(&mp).unwrap();

    assert!(surface.quality_metrics.middle_max_dev_mm >= 49.0);
    assert!(surface.quality_metrics.middle_max_dev_mm <= 51.0);
    assert_eq!(
        surface.quality_metrics.middle_max_dev_mm, surface.quality_metrics.middle_mean_dev_mm,
        "single point — max == mean"
    );
    assert!(
        !surface.quality_metrics.warnings.is_empty(),
        "should emit warning for >10mm deviation"
    );
    let warning = &surface.quality_metrics.warnings[0];
    assert!(warning.contains("MAIN_V003_R002"));
    assert!(warning.contains("50") || warning.contains("49") || warning.contains("51"));
    // FIX-12: interior deviations ARE the fit residuals → rms/p95 ≈ 50mm.
    let rms = surface.quality_metrics.estimated_rms_mm.unwrap();
    let p95 = surface.quality_metrics.estimated_p95_mm.unwrap();
    assert!((rms - 50.0).abs() < 1.0, "rms={rms}");
    assert!((p95 - 50.0).abs() < 1.0, "p95={p95}");
}

#[test]
fn boundary_interp_no_middle_dev_when_no_interior_points() {
    // Top + bottom only — middle_max_dev should remain 0, no warnings.
    let mut pts = vec![];
    for c in 1..=5 {
        let x = (c - 1) as f64 * 0.5;
        pts.push(p(&format!("MAIN_V{:03}_R001", c), x, 0.0, 0.0));
        pts.push(p(&format!("MAIN_V{:03}_R003", c), x, 0.0, 1.0));
    }
    let mp = MeasuredPoints {
        screen_id: "MAIN".into(),
        coordinate_frame: frame_at_origin(),
        cabinet_array: CabinetArray::rectangle(4, 2, [500.0, 500.0]),
        shape_prior: ShapePrior::Flat,
        points: pts,
        sampling_mode: SamplingMode::Grid,
    };

    let r = BoundaryInterpReconstructor;
    let surface = r.reconstruct(&mp).unwrap();
    assert_eq!(surface.quality_metrics.middle_max_dev_mm, 0.0);
    assert_eq!(surface.quality_metrics.middle_mean_dev_mm, 0.0);
    assert!(surface.quality_metrics.warnings.is_empty());
    // FIX-12: no interior holdout → residual stats are None, not a σ echo
    // clamped to 5mm.
    assert!(surface.quality_metrics.estimated_rms_mm.is_none());
    assert!(surface.quality_metrics.estimated_p95_mm.is_none());
}
