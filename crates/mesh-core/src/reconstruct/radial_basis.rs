use nalgebra::{DMatrix, DVector, Vector3};
use std::collections::HashSet;

use crate::error::CoreError;
use crate::measured_points::MeasuredPoints;
use crate::reconstruct::Reconstructor;
use crate::surface::{GridTopology, QualityMetrics, ReconstructedSurface};
use crate::uv::compute_grid_uv;

/// Inverse multiquadric RBF + affine tail over the (col, row) parameter plane.
/// For each output vertex (col, row), interpolate world position
/// from named anchor points. Anchors that are not parsable as
/// `..._V<col>_R<row>` are skipped.
///
/// **FIX-11**: the interpolant is the AUGMENTED system
/// `[[A, P], [Pᵀ, 0]] [w; β] = [f; 0]` with `P = [1, c, r]` — RBF weights plus
/// an affine tail per coordinate. The original bare-IMQ form interpolated
/// ABSOLUTE world coordinates with a decaying kernel: vertices a few cells
/// from every anchor collapsed toward 0 instead of toward the wall plane
/// (re-computed: 2.25 m mean / 13.6 m worst on a 60×10 wall with top+bottom
/// rows + 3 midpoints — while reporting `max(σ, 8 mm)`). With the affine tail
/// a flat wall (positions affine in (c, r)) is reproduced EXACTLY (w → 0) and
/// far-from-anchor vertices land on the anchors' best affine fit, so the
/// error is bounded by genuine surface curvature, not by absolute coordinates.
///
/// **Threshold ≥5 anchors**: 4-corner-only inputs are mathematically
/// equivalent to bilinear and should fall through to NominalReconstructor
/// instead of being shadowed by RBF.
pub struct RadialBasisReconstructor;

const RBF_EPSILON: f64 = 1.5;

impl Reconstructor for RadialBasisReconstructor {
    fn name(&self) -> &'static str {
        "radial_basis"
    }

    fn applicable(&self, points: &MeasuredPoints) -> bool {
        if !points.cabinet_array.absent_cells.is_empty() {
            return false;
        }
        let cols = points.cabinet_array.cols;
        let rows = points.cabinet_array.rows;
        let anchors = parse_anchors(points, cols, rows);
        if anchors.len() < 5 {
            return false;
        }
        // Require all 4 corners (prevents pure-extrapolation cases).
        let has_bl = anchors.iter().any(|(c, r, _)| *c == 0 && *r == 0);
        let has_br = anchors.iter().any(|(c, r, _)| *c == cols && *r == 0);
        let has_tl = anchors.iter().any(|(c, r, _)| *c == 0 && *r == rows);
        let has_tr = anchors.iter().any(|(c, r, _)| *c == cols && *r == rows);
        if !(has_bl && has_br && has_tl && has_tr) {
            return false;
        }
        // ≥1 STRICTLY interior anchor (FIX-11 dispatch): edge anchors (top/
        // bottom rows, left/right columns) do NOT count — a pure top+bottom
        // capture is boundary data and must reach BoundaryInterpReconstructor
        // instead of being shadowed here (the old check only excluded the 4
        // corners, making boundary_interp unreachable in production).
        let n_interior = anchors
            .iter()
            .filter(|(c, r, _)| *c != 0 && *c != cols && *r != 0 && *r != rows)
            .count();
        n_interior >= 1
    }

    fn reconstruct(&self, points: &MeasuredPoints) -> Result<ReconstructedSurface, CoreError> {
        let cols = points.cabinet_array.cols;
        let rows = points.cabinet_array.rows;
        let anchors = parse_anchors(points, cols, rows);
        if anchors.len() < 5 {
            return Err(CoreError::Reconstruction(format!(
                "radial_basis needs ≥5 in-grid unique anchors, got {}",
                anchors.len()
            )));
        }

        // Augmented RBF system (FIX-11): n kernel weights + 3 affine
        // coefficients per coordinate, with the standard orthogonality
        // constraint Pᵀw = 0 closing the system.
        let n = anchors.len();
        let m = n + 3;
        let mut a_mat = DMatrix::<f64>::zeros(m, m);
        for (i, ai) in anchors.iter().enumerate() {
            for (j, aj) in anchors.iter().enumerate() {
                let r = ((ai.0 as f64 - aj.0 as f64).powi(2) + (ai.1 as f64 - aj.1 as f64).powi(2))
                    .sqrt();
                a_mat[(i, j)] = imq(r);
            }
            // P block: [1, c, r] (and its transpose).
            a_mat[(i, n)] = 1.0;
            a_mat[(i, n + 1)] = ai.0 as f64;
            a_mat[(i, n + 2)] = ai.1 as f64;
            a_mat[(n, i)] = 1.0;
            a_mat[(n + 1, i)] = ai.0 as f64;
            a_mat[(n + 2, i)] = ai.1 as f64;
        }

        let lu = a_mat.lu();
        let mut weights: [DVector<f64>; 3] =
            [DVector::zeros(m), DVector::zeros(m), DVector::zeros(m)];
        for (axis, w_slot) in weights.iter_mut().enumerate() {
            let mut b = DVector::<f64>::zeros(m);
            for (i, a) in anchors.iter().enumerate() {
                b[i] = a.2[axis];
            }
            *w_slot = lu
                .solve(&b)
                .ok_or_else(|| CoreError::Reconstruction("RBF system singular".into()))?;
        }

        let topo = GridTopology { cols, rows };
        let mut vertices = Vec::with_capacity(topo.vertex_count());

        for r in 0..=rows {
            for c in 0..=cols {
                let mut p = Vector3::zeros();
                for (axis, w) in weights.iter().enumerate() {
                    let mut sum = w[n] + w[n + 1] * c as f64 + w[n + 2] * r as f64;
                    for (i, a) in anchors.iter().enumerate() {
                        let dr = ((a.0 as f64 - c as f64).powi(2)
                            + (a.1 as f64 - r as f64).powi(2))
                        .sqrt();
                        sum += w[i] * imq(dr);
                    }
                    p[axis] = sum;
                }
                vertices.push(p);
            }
        }

        let uvs = compute_grid_uv(topo);
        // FIX-12: RBF reproduces every anchor exactly — there is no holdout
        // residual to report, so estimated_rms/p95 stay None (the old code
        // echoed input σ clamped to ≥8mm, which was neither).
        let metrics = QualityMetrics {
            method: "radial_basis".into(),
            measured_count: anchors.len(),
            expected_count: topo.vertex_count(),
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

fn imq(r: f64) -> f64 {
    1.0 / (1.0 + (RBF_EPSILON * r).powi(2)).sqrt()
}

/// Returns (col_zero_based, row_zero_based, position).
/// Filters out-of-grid names (col > cols, row > rows) and dedupes by (col, row).
fn parse_anchors(points: &MeasuredPoints, cols: u32, rows: u32) -> Vec<(u32, u32, Vector3<f64>)> {
    let prefix = format!("{}_V", points.screen_id);
    let mut seen: HashSet<(u32, u32)> = HashSet::new();
    let mut out = vec![];
    for p in &points.points {
        let Some(rest) = p.name.strip_prefix(&prefix) else {
            continue;
        };
        let parts: Vec<&str> = rest.split("_R").collect();
        if parts.len() != 2 {
            continue;
        }
        let Ok(col1) = parts[0].parse::<u32>() else {
            continue;
        };
        let Ok(row1) = parts[1].parse::<u32>() else {
            continue;
        };
        if col1 == 0 || row1 == 0 {
            continue;
        }
        let col = col1 - 1;
        let row = row1 - 1;
        if col > cols || row > rows {
            continue;
        }
        if !seen.insert((col, row)) {
            continue;
        }
        out.push((col, row, p.position));
    }
    out
}
