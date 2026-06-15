use mesh_core::coordinate::CoordinateFrame;
use mesh_core::measured_points::MeasuredPoints;
use mesh_core::point::{MeasuredPoint, PointSource};
use mesh_core::reconstruct::direct::DirectLinkReconstructor;
use mesh_core::reconstruct::Reconstructor;
use mesh_core::sampling::SamplingMode;
use mesh_core::shape::{CabinetArray, ShapePrior};
use mesh_core::uncertainty::Uncertainty;
use nalgebra::Vector3;

fn full_grid_3x2() -> MeasuredPoints {
    let frame = CoordinateFrame::from_three_points(
        Vector3::zeros(),
        Vector3::new(1.0, 0.0, 0.0),
        Vector3::new(0.0, 0.0, 1.0),
    )
    .unwrap();

    // 3 col × 2 row cabinets → 4 × 3 = 12 vertices needed
    let mut pts = vec![];
    for r in 1..=3 {
        for c in 1..=4 {
            let x = (c - 1) as f64 * 0.5;
            let z = (r - 1) as f64 * 0.5;
            pts.push(MeasuredPoint {
                name: format!("MAIN_V{:03}_R{:03}", c, r),
                position: Vector3::new(x, 0.0, z),
                uncertainty: Uncertainty::Isotropic(2.0),
                source: PointSource::TotalStation,
            });
        }
    }

    MeasuredPoints {
        screen_id: "MAIN".into(),
        coordinate_frame: frame,
        cabinet_array: CabinetArray::rectangle(3, 2, [500.0, 500.0]),
        shape_prior: ShapePrior::Flat,
        points: pts,
        sampling_mode: SamplingMode::Grid,
    }
}

#[test]
fn direct_link_with_full_grid_returns_exact_positions() {
    let mp = full_grid_3x2();
    let r = DirectLinkReconstructor;
    assert!(r.applicable(&mp));

    let surface = r.reconstruct(&mp).unwrap();
    assert_eq!(surface.vertices.len(), 12);

    // (0,0) corner → (0,0,0)
    let i = surface.topology.vertex_index(0, 0);
    assert!((surface.vertices[i] - Vector3::new(0.0, 0.0, 0.0)).norm() < 1e-9);
    // top-right (3,2) → (1.5, 0, 1.0)
    let i = surface.topology.vertex_index(3, 2);
    assert!((surface.vertices[i] - Vector3::new(1.5, 0.0, 1.0)).norm() < 1e-9);
}

#[test]
fn direct_link_with_one_missing_is_not_applicable() {
    let mut mp = full_grid_3x2();
    mp.points.retain(|p| p.name != "MAIN_V002_R002");
    let r = DirectLinkReconstructor;
    assert!(!r.applicable(&mp));
}

#[test]
fn direct_link_rejects_irregular_cabinet_array() {
    let mut mp = full_grid_3x2();
    mp.cabinet_array = CabinetArray::irregular(3, 2, [500.0, 500.0], vec![(1, 0)]);
    let r = DirectLinkReconstructor;
    assert!(
        !r.applicable(&mp),
        "irregular CabinetArray should not be applicable for DirectLink"
    );
}

#[test]
fn direct_link_reports_no_fit_residual_not_sigma_echo() {
    // FIX-12: direct_link reproduces every measurement exactly — there is no
    // fit residual. The old behavior echoed input σ as "estimated_rms_mm";
    // that masquerade is gone: the field is None regardless of σ.
    let mut mp = full_grid_3x2();
    for p in &mut mp.points {
        p.uncertainty = Uncertainty::Isotropic(5.0);
    }
    let r = DirectLinkReconstructor;
    let surface = r.reconstruct(&mp).unwrap();
    assert!(surface.quality_metrics.estimated_rms_mm.is_none());
    assert!(surface.quality_metrics.estimated_p95_mm.is_none());
    // clean grid → no spacing outliers
    assert!(surface.quality_metrics.outliers.is_empty());
    assert!(surface.quality_metrics.warnings.is_empty());
}

#[test]
fn direct_link_flags_50mm_outlier_via_grid_spacing() {
    // FIX-12 acceptance: inject a single 50mm outlier → non-zero outlier
    // report (the old metrics stayed all-zero/σ-echo and could never see it).
    let mut mp = full_grid_3x2();
    let p = mp
        .points
        .iter_mut()
        .find(|p| p.name == "MAIN_V002_R002")
        .unwrap();
    p.position.x += 0.050;
    let r = DirectLinkReconstructor;
    let surface = r.reconstruct(&mp).unwrap();
    assert_eq!(
        surface.quality_metrics.outliers,
        vec!["MAIN_V002_R002".to_string()],
        "displaced vertex must be reported as outlier"
    );
    assert!(
        !surface.quality_metrics.warnings.is_empty(),
        "deviating edges must produce warnings"
    );
}
