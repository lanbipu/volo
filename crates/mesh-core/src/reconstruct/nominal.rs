use nalgebra::Vector3;

use crate::error::CoreError;
use crate::measured_points::MeasuredPoints;
use crate::reconstruct::Reconstructor;
use crate::shape::ShapePrior;
use crate::surface::{GridTopology, QualityMetrics, ReconstructedSurface};
use crate::uv::compute_grid_uv;

/// Pure nominal model: 4-corner bilinear extrapolation across the
/// whole grid. Last-resort fallback when measurement density is at
/// the minimum (4 corners only).
///
/// **M0.1 limitation:** only applicable when `shape_prior` is
/// `Flat`. Curved/folded screens with only 4 corners need a
/// shape-aware nominal generator (TBD in M0.2 / M1) — applicable
/// returns `false` and the dispatcher will surface a clear error
/// instead of silently producing a wrong (planar) mesh.
pub struct NominalReconstructor;

impl Reconstructor for NominalReconstructor {
    fn name(&self) -> &'static str {
        "nominal"
    }

    fn applicable(&self, points: &MeasuredPoints) -> bool {
        // M0.1: only flat prior. Other priors with sparse samples
        // need shape-aware fitting which is deferred.
        if !matches!(points.shape_prior, ShapePrior::Flat) {
            return false;
        }
        let cols = points.cabinet_array.cols;
        let rows = points.cabinet_array.rows;
        let corners = [
            corner_name(&points.screen_id, 1, 1),
            corner_name(&points.screen_id, cols + 1, 1),
            corner_name(&points.screen_id, 1, rows + 1),
            corner_name(&points.screen_id, cols + 1, rows + 1),
        ];
        corners.iter().all(|n| points.find(n).is_some())
    }

    fn reconstruct(&self, points: &MeasuredPoints) -> Result<ReconstructedSurface, CoreError> {
        let cols = points.cabinet_array.cols;
        let rows = points.cabinet_array.rows;

        let bl = points
            .find(&corner_name(&points.screen_id, 1, 1))
            .ok_or_else(|| CoreError::Reconstruction("missing bottom-left corner".into()))?;
        let br = points
            .find(&corner_name(&points.screen_id, cols + 1, 1))
            .ok_or_else(|| CoreError::Reconstruction("missing bottom-right corner".into()))?;
        let tl = points
            .find(&corner_name(&points.screen_id, 1, rows + 1))
            .ok_or_else(|| CoreError::Reconstruction("missing top-left corner".into()))?;
        let tr = points
            .find(&corner_name(&points.screen_id, cols + 1, rows + 1))
            .ok_or_else(|| CoreError::Reconstruction("missing top-right corner".into()))?;

        let topo = GridTopology { cols, rows };
        let mut vertices = Vec::with_capacity(topo.vertex_count());

        // Bilinear interpolation across the 4 corners.
        for r in 0..=rows {
            let v = r as f64 / rows as f64;
            for c in 0..=cols {
                let u = c as f64 / cols as f64;
                let p = bilinear(&bl.position, &br.position, &tl.position, &tr.position, u, v);
                vertices.push(p);
            }
        }

        let uvs = compute_grid_uv(topo);

        // FIX-12: any extra in-grid measured point (beyond the 4 exactly
        // reproduced corners) is a genuine holdout against the bilinear
        // surface — report its residual stats; None when only corners exist.
        let residuals = crate::reconstruct::grid_check::grid_residuals_mm(
            points,
            &vertices,
            topo,
            |col, row| (col == 0 || col == cols) && (row == 0 || row == rows),
        );
        let devs: Vec<f64> = residuals.iter().map(|(_, d)| *d).collect();
        let stats = crate::reconstruct::grid_check::residual_stats_mm(&devs);

        let metrics = QualityMetrics {
            method: "nominal".into(),
            measured_count: points.len(),
            expected_count: topo.vertex_count(),
            estimated_rms_mm: stats.map(|(rms, _)| rms),
            estimated_p95_mm: stats.map(|(_, p95)| p95),
            ..Default::default()
        };

        Ok(ReconstructedSurface {
            screen_id: points.screen_id.clone(),
            topology: topo,
            vertices,
            uv_coords: uvs,
            quality_metrics: metrics,
            scatter_fit: None,
        })
    }
}

fn corner_name(screen: &str, v_one_based: u32, r_one_based: u32) -> String {
    format!("{}_V{:03}_R{:03}", screen, v_one_based, r_one_based)
}

fn bilinear(
    bl: &Vector3<f64>,
    br: &Vector3<f64>,
    tl: &Vector3<f64>,
    tr: &Vector3<f64>,
    u: f64,
    v: f64,
) -> Vector3<f64> {
    let bottom = bl * (1.0 - u) + br * u;
    let top = tl * (1.0 - u) + tr * u;
    bottom * (1.0 - v) + top * v
}
