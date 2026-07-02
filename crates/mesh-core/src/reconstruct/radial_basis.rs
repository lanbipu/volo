use nalgebra::{DMatrix, DVector, Vector3};
use std::collections::HashSet;

use crate::error::CoreError;
use crate::measured_points::MeasuredPoints;
use crate::reconstruct::grid_check::{self, MIN_MEASURED_FOR_CV_STATS};
use crate::reconstruct::provenance::{classify_grid, EXTRAPOLATION_THRESHOLD_MULTIPLIER};
use crate::reconstruct::Reconstructor;
use crate::surface::{GridTopology, QualityMetrics, ReconstructedSurface, VertexProvenance};
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
///
/// **M1 uncertainty ledger fix**: `estimated_rms_mm`/`estimated_p95_mm` now
/// come from real cross-validation (`cross_validate_rms_p95` — the affine
/// tail reproduces every anchor exactly, so there is no free holdout;
/// CV manufactures one by refitting with anchors excluded in turn), and
/// every vertex is tagged with a [`crate::surface::VertexProvenance`]
/// (anchors are `Measured`; the rest `Interpolated`/`Extrapolated` via
/// `crate::reconstruct::provenance`) — this is the honest replacement for
/// the E1 finding that a sparse capture silently produced a wildly wrong
/// mesh with a decorative RMS.
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

        let weights = fit_rbf(&anchors)?;

        let topo = GridTopology { cols, rows };
        let mut vertices = Vec::with_capacity(topo.vertex_count());
        for r in 0..=rows {
            for c in 0..=cols {
                vertices.push(eval_rbf(&weights, &anchors, c as f64, r as f64));
            }
        }

        let uvs = compute_grid_uv(topo);

        // M1 uncertainty-ledger fix (item 2): RBF reproduces every anchor
        // exactly by construction, so — unlike the other grid
        // reconstructors — there is no "extra measured point beyond the
        // anchors" to hold out for free. Cross-validate instead: refit
        // excluding each anchor (or fold of anchors) in turn and measure
        // the residual at the held-out position. `None` below the CV
        // sample floor (see `MIN_MEASURED_FOR_CV_STATS`).
        let stats = cross_validate_rms_p95(&anchors);

        // Item 4: classify every vertex against the anchors in (col,row)
        // parameter space — anchors are exact (Measured); the rest are
        // Interpolated/Extrapolated depending on hull membership + distance
        // to the nearest anchor. This is exactly E1's failure mode (sparse
        // anchors ⇒ far interior collapses) made visible instead of silent.
        let anchor_cr: Vec<(u32, u32)> = anchors.iter().map(|a| (a.0, a.1)).collect();
        let vertex_provenance =
            classify_grid(topo, &anchor_cr, EXTRAPOLATION_THRESHOLD_MULTIPLIER);
        let extrapolated_count = vertex_provenance
            .iter()
            .filter(|p| **p == VertexProvenance::Extrapolated)
            .count();

        // Item 4 (grid outlier gate): a single mis-shot anchor pulls every
        // nearby edge off the expected cabinet size — the same geometric
        // check direct_link/boundary_interp already run.
        let (spacing_outliers, mut warnings) = grid_check::spacing_outliers(
            &vertices,
            topo,
            &points.cabinet_array,
            &points.screen_id,
        );
        if extrapolated_count > 0 {
            warnings.push(format!(
                "{extrapolated_count} vertex(es) are extrapolated beyond anchor coverage \
                 — treat like a fabricated point (see vertex_provenance)"
            ));
        }

        let metrics = QualityMetrics {
            method: "radial_basis".into(),
            measured_count: anchors.len(),
            expected_count: topo.vertex_count(),
            estimated_rms_mm: stats.map(|(rms, _)| rms),
            estimated_p95_mm: stats.map(|(_, p95)| p95),
            outliers: spacing_outliers,
            extrapolated_count,
            warnings,
            ..Default::default()
        };

        Ok(ReconstructedSurface {
            screen_id: points.screen_id.clone(),
            topology: topo,
            vertices,
            uv_coords: uvs,
            quality_metrics: metrics,
            scatter_fit: None,
            vertex_provenance,
        })
    }
}

/// Solve the augmented RBF system (FIX-11) for `anchors`: n kernel weights
/// + 3 affine coefficients per coordinate, with the standard orthogonality
/// constraint Pᵀw = 0 closing the system. Returns `[weights_x, weights_y,
/// weights_z]`, each of length `anchors.len() + 3`.
fn fit_rbf(anchors: &[(u32, u32, Vector3<f64>)]) -> Result<[DVector<f64>; 3], CoreError> {
    let n = anchors.len();
    let m = n + 3;
    let mut a_mat = DMatrix::<f64>::zeros(m, m);
    for (i, ai) in anchors.iter().enumerate() {
        for (j, aj) in anchors.iter().enumerate() {
            let r =
                ((ai.0 as f64 - aj.0 as f64).powi(2) + (ai.1 as f64 - aj.1 as f64).powi(2)).sqrt();
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
    let mut weights: [DVector<f64>; 3] = [DVector::zeros(m), DVector::zeros(m), DVector::zeros(m)];
    for (axis, w_slot) in weights.iter_mut().enumerate() {
        let mut b = DVector::<f64>::zeros(m);
        for (i, a) in anchors.iter().enumerate() {
            b[i] = a.2[axis];
        }
        *w_slot = lu
            .solve(&b)
            .ok_or_else(|| CoreError::Reconstruction("RBF system singular".into()))?;
    }
    Ok(weights)
}

/// Evaluate a fitted RBF+affine system at parameter position `(c, r)`.
fn eval_rbf(weights: &[DVector<f64>; 3], anchors: &[(u32, u32, Vector3<f64>)], c: f64, r: f64) -> Vector3<f64> {
    let n = anchors.len();
    let mut p = Vector3::zeros();
    for (axis, w) in weights.iter().enumerate() {
        let mut sum = w[n] + w[n + 1] * c + w[n + 2] * r;
        for (i, a) in anchors.iter().enumerate() {
            let dr = ((a.0 as f64 - c).powi(2) + (a.1 as f64 - r).powi(2)).sqrt();
            sum += w[i] * imq(dr);
        }
        p[axis] = sum;
    }
    p
}

/// Leave-one-out (≤30 anchors) or 10-fold (larger captures, to bound
/// worst-case refit cost) cross-validation: refit excluding each
/// fold's anchors, evaluate the fit at their (col,row) position, and
/// compare against their real measured position. `None` below
/// [`MIN_MEASURED_FOR_CV_STATS`] or if every fold degenerates (too few
/// training anchors / singular system).
fn cross_validate_rms_p95(anchors: &[(u32, u32, Vector3<f64>)]) -> Option<(f64, f64)> {
    let n = anchors.len();
    if n < MIN_MEASURED_FOR_CV_STATS {
        return None;
    }
    let k = if n <= 30 { n } else { 10 };
    let mut residuals_mm = Vec::new();
    for fold in 0..k {
        let held_out: Vec<usize> = (fold..n).step_by(k).collect();
        let train: Vec<(u32, u32, Vector3<f64>)> = anchors
            .iter()
            .enumerate()
            .filter(|(i, _)| !held_out.contains(i))
            .map(|(_, a)| *a)
            .collect();
        if train.len() < 4 {
            continue; // too few anchors left to fit the augmented system
        }
        let Ok(weights) = fit_rbf(&train) else {
            continue;
        };
        for &i in &held_out {
            let (c, r, truth) = anchors[i];
            let pred = eval_rbf(&weights, &train, c as f64, r as f64);
            residuals_mm.push((pred - truth).norm() * 1000.0);
        }
    }
    grid_check::residual_stats_mm(&residuals_mm)
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
