//! M1 uncertainty-ledger fix acceptance tests (W1): per-vertex provenance +
//! honest cross-validated `estimated_rms_mm` for `RadialBasisReconstructor`.

use mesh_core::coordinate::CoordinateFrame;
use mesh_core::measured_points::MeasuredPoints;
use mesh_core::point::{MeasuredPoint, PointSource};
use mesh_core::reconstruct::radial_basis::RadialBasisReconstructor;
use mesh_core::reconstruct::Reconstructor;
use mesh_core::sampling::SamplingMode;
use mesh_core::shape::{CabinetArray, ShapePrior};
use mesh_core::surface::VertexProvenance;
use mesh_core::uncertainty::Uncertainty;
use nalgebra::Vector3;

fn p(name: &str, pos: Vector3<f64>) -> MeasuredPoint {
    MeasuredPoint {
        name: name.into(),
        position: pos,
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

fn grid_name(c: u32, r: u32) -> String {
    format!("MAIN_V{:03}_R{:03}", c + 1, r + 1)
}

/// Curved wall (arc x = R sin a, z = R(1 - cos a)) matching the review's
/// synthetic scenario; row is the vertical axis (extruded, no curvature).
fn curved_pos(cols: u32, radius_m: f64, total_angle_rad: f64, row_h_m: f64) -> impl Fn(u32, u32) -> Vector3<f64> {
    move |c: u32, r: u32| {
        let a = -total_angle_rad / 2.0 + total_angle_rad * (c as f64 / cols as f64);
        Vector3::new(radius_m * a.sin(), r as f64 * row_h_m, radius_m * (1.0 - a.cos()))
    }
}

/// Acceptance test 1: 60×10 curved wall with anchors clustered ONLY near
/// each of the 4 corners (sparse, per review's failure scenario) — the
/// convex hull of the anchors in (col,row) parameter space shrinks to the
/// corner regions, so every vertex anywhere near the middle of the wall
/// must come back `Extrapolated`.
#[test]
fn curved_wall_sparse_corner_anchors_flag_middle_as_extrapolated() {
    let cols = 60u32;
    let rows = 10u32;
    let pos = curved_pos(cols, 9.523, 2.8, 0.5);

    // A couple of points near each corner, plus one strictly-interior point
    // per corner cluster so `applicable()`'s "≥1 interior anchor" gate is
    // satisfied without adding any real coverage of the middle of the wall.
    let anchor_cr: Vec<(u32, u32)> = vec![
        (0, 0), (1, 0), (0, 1), (2, 2),
        (60, 0), (59, 0), (60, 1), (58, 2),
        (0, 10), (1, 10), (0, 9), (2, 8),
        (60, 10), (59, 10), (60, 9), (58, 8),
    ];
    let points = anchor_cr
        .iter()
        .map(|&(c, r)| p(&grid_name(c, r), pos(c, r)))
        .collect();

    let mp = MeasuredPoints {
        screen_id: "MAIN".into(),
        coordinate_frame: frame(),
        cabinet_array: CabinetArray::rectangle(cols, rows, [500.0, 500.0]),
        shape_prior: ShapePrior::Curved { radius_mm: 9523.0 },
        points,
        sampling_mode: SamplingMode::Grid,
    };

    let r = RadialBasisReconstructor;
    assert!(r.applicable(&mp));
    let surface = r.reconstruct(&mp).unwrap();
    assert_eq!(surface.vertex_provenance.len(), surface.vertices.len());

    for row in 3..=7 {
        for col in 20..=40 {
            let idx = surface.topology.vertex_index(col, row);
            assert_eq!(
                surface.vertex_provenance[idx],
                VertexProvenance::Extrapolated,
                "(col={col},row={row}) should be outside the corner-clustered convex hull"
            );
        }
    }
    // Anchors themselves must be Measured.
    for &(c, r) in &anchor_cr {
        let idx = surface.topology.vertex_index(c, r);
        assert_eq!(surface.vertex_provenance[idx], VertexProvenance::Measured);
    }
    assert!(surface.quality_metrics.extrapolated_count > 0);
    assert!(surface
        .quality_metrics
        .warnings
        .iter()
        .any(|w| w.contains("extrapolated")));
}

/// Acceptance test 2: on a moderately (but genuinely, non-affine-ly)
/// curved wall with reasonably uniform anchor coverage, the honest
/// cross-validated `estimated_rms_mm` must be the same order of magnitude
/// as the REAL error against dense ground truth the test computes
/// independently (held out from the reconstructor entirely) — i.e. the CV
/// number is not decorative, it tracks actual accuracy within ~2x.
#[test]
fn cv_rms_tracks_real_holdout_error_within_2x() {
    let cols = 10u32;
    let rows = 6u32;
    let pos = curved_pos(cols, 5.0, 1.2, 0.5);

    // Dense, uniform coverage: every column measured at rows 0, 3 (mid), 6
    // (top/bottom + one interior row) — 33 anchors total, well above the
    // CV sample floor.
    let anchor_cr: Vec<(u32, u32)> = (0..=cols)
        .flat_map(|c| [(c, 0), (c, 3), (c, rows)])
        .collect();
    let points = anchor_cr
        .iter()
        .map(|&(c, r)| p(&grid_name(c, r), pos(c, r)))
        .collect();

    let mp = MeasuredPoints {
        screen_id: "MAIN".into(),
        coordinate_frame: frame(),
        cabinet_array: CabinetArray::rectangle(cols, rows, [500.0, 500.0]),
        shape_prior: ShapePrior::Curved { radius_mm: 5000.0 },
        points,
        sampling_mode: SamplingMode::Grid,
    };

    let r = RadialBasisReconstructor;
    assert!(r.applicable(&mp));
    let surface = r.reconstruct(&mp).unwrap();

    let cv_rms = surface
        .quality_metrics
        .estimated_rms_mm
        .expect("33 anchors is well above the CV floor — should be Some");

    // Real error at every non-anchor vertex, computed against the known
    // (but never given to the reconstructor) ground truth.
    let anchor_set: std::collections::HashSet<(u32, u32)> = anchor_cr.iter().copied().collect();
    let mut real_residuals_mm = Vec::new();
    for row in 0..=rows {
        for col in 0..=cols {
            if anchor_set.contains(&(col, row)) {
                continue;
            }
            let idx = surface.topology.vertex_index(col, row);
            let err_mm = (surface.vertices[idx] - pos(col, row)).norm() * 1000.0;
            real_residuals_mm.push(err_mm);
        }
    }
    assert!(!real_residuals_mm.is_empty());
    let real_rms = (real_residuals_mm.iter().map(|d| d * d).sum::<f64>()
        / real_residuals_mm.len() as f64)
        .sqrt();

    assert!(
        cv_rms <= 2.0 * real_rms && real_rms <= 2.0 * cv_rms,
        "CV rms {cv_rms:.3}mm should track real holdout rms {real_rms:.3}mm within 2x"
    );
}

/// Acceptance test 3: fewer than `MIN_MEASURED_FOR_CV_STATS` (8) anchors —
/// CV is not statistically meaningful, `estimated_rms_mm`/`p95` must be
/// `None` rather than a number computed from a handful of points.
#[test]
fn fewer_than_8_anchors_yields_none_rms() {
    // Reuses the minimal 5-anchor flat-wall setup: 4 corners + 1 interior.
    let mp = MeasuredPoints {
        screen_id: "MAIN".into(),
        coordinate_frame: frame(),
        cabinet_array: CabinetArray::rectangle(4, 4, [500.0, 500.0]),
        shape_prior: ShapePrior::Flat,
        points: vec![
            p("MAIN_V001_R001", Vector3::new(0.0, 0.0, 0.0)),
            p("MAIN_V005_R001", Vector3::new(2.0, 0.0, 0.0)),
            p("MAIN_V001_R005", Vector3::new(0.0, 0.0, 2.0)),
            p("MAIN_V005_R005", Vector3::new(2.0, 0.0, 2.0)),
            p("MAIN_V003_R003", Vector3::new(1.0, 0.0, 1.0)),
        ],
        sampling_mode: SamplingMode::Grid,
    };
    let r = RadialBasisReconstructor;
    assert!(r.applicable(&mp));
    let surface = r.reconstruct(&mp).unwrap();
    assert_eq!(surface.quality_metrics.measured_count, 5);
    assert!(surface.quality_metrics.estimated_rms_mm.is_none());
    assert!(surface.quality_metrics.estimated_p95_mm.is_none());
}
