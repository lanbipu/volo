use nalgebra::Vector3;

use crate::error::CoreError;
use crate::measured_points::MeasuredPoints;
use crate::reconstruct::provenance::{classify_grid, EXTRAPOLATION_THRESHOLD_MULTIPLIER};
use crate::reconstruct::Reconstructor;
use crate::surface::{GridTopology, QualityMetrics, ReconstructedSurface, VertexProvenance};
use crate::uv::compute_grid_uv;

/// Boundary-interp reconstructor: requires full top + bottom rows
/// of vertex points. Interpolates the interior linearly between
/// the matched (col-aligned) top/bottom samples.
pub struct BoundaryInterpReconstructor;

impl Reconstructor for BoundaryInterpReconstructor {
    fn name(&self) -> &'static str {
        "boundary_interp"
    }

    fn applicable(&self, points: &MeasuredPoints) -> bool {
        // Skip irregular shapes (consistent with DirectLinkReconstructor —
        // masked topology is deferred).
        if !points.cabinet_array.absent_cells.is_empty() {
            return false;
        }

        let cols = points.cabinet_array.cols;
        let rows = points.cabinet_array.rows;

        // need every column's top + bottom vertex
        for c in 1..=(cols + 1) {
            let top_name = format!("{}_V{:03}_R{:03}", points.screen_id, c, rows + 1);
            let bot_name = format!("{}_V{:03}_R{:03}", points.screen_id, c, 1);
            if points.find(&top_name).is_none() || points.find(&bot_name).is_none() {
                return false;
            }
        }
        true
    }

    fn reconstruct(&self, points: &MeasuredPoints) -> Result<ReconstructedSurface, CoreError> {
        let cols = points.cabinet_array.cols;
        let rows = points.cabinet_array.rows;
        let topo = GridTopology { cols, rows };

        let mut vertices = vec![Vector3::zeros(); topo.vertex_count()];

        for c in 0..=cols {
            let top_name = format!("{}_V{:03}_R{:03}", points.screen_id, c + 1, rows + 1);
            let bot_name = format!("{}_V{:03}_R{:03}", points.screen_id, c + 1, 1);
            let top_pos = points
                .find(&top_name)
                .ok_or_else(|| CoreError::Reconstruction(format!("missing top {}", top_name)))?
                .position;
            let bot_pos = points
                .find(&bot_name)
                .ok_or_else(|| CoreError::Reconstruction(format!("missing bot {}", bot_name)))?
                .position;

            for r in 0..=rows {
                let t = r as f64 / rows as f64; // 0 = bottom, 1 = top
                let v = bot_pos * (1.0 - t) + top_pos * t;
                vertices[topo.vertex_index(c, r)] = v;
            }
        }

        // Validate any interior (non-top/bottom) measured grid points against
        // the interpolation result. Fill middle_max_dev_mm / middle_mean_dev_mm
        // and emit warnings when deviation exceeds the threshold.
        // FIX-12: these interior deviations ARE the fit residuals — their
        // rms/p95 become estimated_rms_mm/estimated_p95_mm (None when no
        // interior point was measured; no input-σ stand-in, no 5mm floor).
        let mut warnings: Vec<String> = Vec::new();
        const INTERIOR_DEV_WARN_MM: f64 = 10.0;

        let residuals = crate::reconstruct::grid_check::grid_residuals_mm(
            points,
            &vertices,
            topo,
            // top/bottom anchors are exactly reproduced — exclude them.
            |_, row| row == 0 || row == rows,
        );
        for (name, dev_mm) in &residuals {
            if *dev_mm > INTERIOR_DEV_WARN_MM {
                warnings.push(format!(
                    "{} deviates {:.2}mm from boundary interpolation (>{}mm threshold)",
                    name, dev_mm, INTERIOR_DEV_WARN_MM
                ));
            }
        }
        let devs: Vec<f64> = residuals.iter().map(|(_, d)| *d).collect();
        let max_dev_mm = devs.iter().fold(0.0_f64, |a, &b| a.max(b));
        let mean_dev_mm = if devs.is_empty() {
            0.0
        } else {
            devs.iter().sum::<f64>() / devs.len() as f64
        };
        let stats = crate::reconstruct::grid_check::cv_residual_stats_mm(&devs, points.len());

        // FIX-12 ④: anchor sanity — top/bottom row spacing must match the
        // cabinet width (every edge spans exactly one cabinet face). The
        // interpolated interior is consistent by construction, so run the
        // check on the full grid and let edge warnings name the culprits.
        let (spacing_outliers, mut spacing_warnings) =
            crate::reconstruct::grid_check::spacing_outliers(
                &vertices,
                topo,
                &points.cabinet_array,
                &points.screen_id,
            );
        warnings.append(&mut spacing_warnings);

        // M1 uncertainty-ledger fix: anchors are exactly the column
        // top+bottom pairs `applicable()` already requires — classify the
        // interior against them in (col,row) parameter space. Without dense
        // interior sampling, rows far from both the top and bottom edge
        // legitimately come back Extrapolated.
        let anchors: Vec<(u32, u32)> = (0..=cols)
            .flat_map(|c| [(c, 0), (c, rows)])
            .collect();
        let vertex_provenance =
            classify_grid(topo, &anchors, EXTRAPOLATION_THRESHOLD_MULTIPLIER);
        let extrapolated_count = vertex_provenance
            .iter()
            .filter(|p| **p == VertexProvenance::Extrapolated)
            .count();
        if extrapolated_count > 0 {
            warnings.push(format!(
                "{extrapolated_count} vertex(es) are extrapolated beyond the measured top/bottom \
                 rows — treat like a fabricated point (see vertex_provenance)"
            ));
        }

        let uvs = compute_grid_uv(topo);
        let metrics = QualityMetrics {
            method: "boundary_interp".into(),
            measured_count: points.len(),
            expected_count: topo.vertex_count(),
            estimated_rms_mm: stats.map(|(rms, _)| rms),
            estimated_p95_mm: stats.map(|(_, p95)| p95),
            middle_max_dev_mm: max_dev_mm,
            middle_mean_dev_mm: mean_dev_mm,
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
