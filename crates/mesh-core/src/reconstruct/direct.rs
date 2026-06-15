use crate::error::CoreError;
use crate::measured_points::MeasuredPoints;
use crate::reconstruct::Reconstructor;
use crate::surface::{GridTopology, QualityMetrics, ReconstructedSurface};
use crate::uv::compute_grid_uv;

/// Direct-link reconstructor: every grid vertex is a measured point.
/// No interpolation. Highest fidelity, requires complete sampling.
pub struct DirectLinkReconstructor;

impl Reconstructor for DirectLinkReconstructor {
    fn name(&self) -> &'static str {
        "direct_link"
    }

    fn applicable(&self, points: &MeasuredPoints) -> bool {
        // DirectLink requires every (cols+1)×(rows+1) vertex name to be measured.
        // Irregular screens (absent_cells non-empty) are not supported here —
        // the masked-topology path is not yet implemented. Caller falls back
        // to a more flexible reconstructor (boundary_interp / radial_basis / nominal).
        if !points.cabinet_array.absent_cells.is_empty() {
            return false;
        }
        let cols = points.cabinet_array.cols;
        let rows = points.cabinet_array.rows;
        for r in 1..=(rows + 1) {
            for c in 1..=(cols + 1) {
                let name = format!("{}_V{:03}_R{:03}", points.screen_id, c, r);
                if points.find(&name).is_none() {
                    return false;
                }
            }
        }
        true
    }

    fn reconstruct(&self, points: &MeasuredPoints) -> Result<ReconstructedSurface, CoreError> {
        let cols = points.cabinet_array.cols;
        let rows = points.cabinet_array.rows;
        let topo = GridTopology { cols, rows };

        let mut vertices = Vec::with_capacity(topo.vertex_count());
        for r in 1..=(rows + 1) {
            for c in 1..=(cols + 1) {
                let name = format!("{}_V{:03}_R{:03}", points.screen_id, c, r);
                let p = points.find(&name).ok_or_else(|| {
                    CoreError::Reconstruction(format!("direct_link missing point {}", name))
                })?;
                vertices.push(p.position);
            }
        }

        let uvs = compute_grid_uv(topo);

        // FIX-12: every vertex IS a measurement (exact reproduction), so there
        // is no fit residual to report — estimated_rms/p95 stay None instead
        // of echoing input σ. The grid spacing check (each edge spans exactly
        // one cabinet face) is the honest outlier detector here.
        let (outliers, warnings) = crate::reconstruct::grid_check::spacing_outliers(
            &vertices,
            topo,
            &points.cabinet_array,
            &points.screen_id,
        );

        let metrics = QualityMetrics {
            method: "direct_link".into(),
            measured_count: points.len(),
            expected_count: topo.vertex_count(),
            outliers,
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
        })
    }
}
