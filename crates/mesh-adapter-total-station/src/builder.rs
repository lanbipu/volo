use std::collections::HashMap;

use nalgebra::Vector3;

use crate::error::AdapterError;
use crate::fallback::fabricate_bottom_rows;
use crate::geometric_naming::{name_points_geometrically, NameOutcome, NamingTolerances};
use crate::project::ScreenConfig;
use crate::raw_point::RawPoint;
use crate::reference_frame::build_frame_from_first_three;
use crate::shape_grid::expected_grid_positions;
use crate::transform::transform_to_model;

use mesh_core::measured_points::MeasuredPoints;
use mesh_core::point::{MeasuredPoint, PointSource};
use mesh_core::shape::{CabinetArray, ShapePrior};
use mesh_core::uncertainty::Uncertainty;

/// Standard total-station instrument uncertainty (mm).
const INSTRUMENT_SIGMA_MM: f64 = 2.0;
/// Larger uncertainty for fabricated (vertical-extension) fallback points (mm).
const FABRICATED_SIGMA_MM: f64 = 10.0;

/// End-to-end: raw CSV points + screen config → `MeasuredPoints` ready
/// for `mesh_core::reconstruct::auto_reconstruct`.
pub fn build_screen_measured_points(
    screen_id: &str,
    raw: &[RawPoint],
    cfg: &ScreenConfig,
) -> Result<MeasuredPoints, AdapterError> {
    let (mp, _outcome) = build_screen_measured_points_with_outcome(screen_id, raw, cfg)?;
    Ok(mp)
}

/// Same as `build_screen_measured_points` but also returns the
/// `NameOutcome` (matches/outliers/ambiguous) for diagnostics.
pub fn build_screen_measured_points_with_outcome(
    screen_id: &str,
    raw: &[RawPoint],
    cfg: &ScreenConfig,
) -> Result<(MeasuredPoints, NameOutcome), AdapterError> {
    // 1. Coordinate frame from the first 3 SOP reference points.
    let frame = build_frame_from_first_three(raw)?;

    // 2. Transform every raw point to model frame.
    let model = transform_to_model(raw, &frame);

    // 3. Expected grid positions, anchored at V001_R001 by default.
    let mut expected = expected_grid_positions(screen_id, cfg)?;

    // 3a. Translate the expected grid so that the configured origin
    // vertex sits at (0,0,0). SOP: when bottom_completion is set with
    // lowest_measurable_row = N, the origin is V001_R<N>; otherwise it
    // is V001_R001 (no translation needed).
    if let Some(bc) = &cfg.bottom_completion {
        let origin_row_idx = bc.lowest_measurable_row.saturating_sub(1);
        // Anchor offset = position of V001_R<N> in the un-translated grid.
        let anchor = expected
            .iter()
            .find(|g| g.col_zero_based == 0 && g.row_zero_based == origin_row_idx)
            .map(|g| g.model_position)
            .unwrap_or_else(Vector3::zeros);
        for ge in &mut expected {
            ge.model_position -= anchor;
        }
    }

    // 4. KD-tree nearest-neighbor naming.
    let outcome = name_points_geometrically(&model, &expected, &NamingTolerances::default());

    // 5. Build name → model position map for matched raw points.
    let model_by_id: HashMap<u32, Vector3<f64>> = model.iter().map(|(id, p)| (*id, *p)).collect();

    let mut measured_by_name: HashMap<String, Vector3<f64>> = HashMap::new();
    for (id, name) in &outcome.matches {
        if let Some(pos) = model_by_id.get(id) {
            measured_by_name.insert(name.clone(), *pos);
        }
    }

    // 6. Fabricate fallback rows (if any).
    //
    // `fabricate_bottom_rows` requires every column to have a measured
    // anchor at R<lowest_measurable_row>. In partial-measurement scenarios
    // (only the 3 SOP reference points were taken on the bottom row),
    // missing column anchors are filled from the nominal expected grid so
    // the fabricated rows still appear at sensible nominal positions —
    // their uncertainty (`FABRICATED_SIGMA_MM`) already advertises lower
    // confidence than measured points.
    let mut fabricate_input = measured_by_name.clone();
    if let Some(bc) = &cfg.bottom_completion {
        let lowest = bc.lowest_measurable_row;
        for ge in &expected {
            if ge.row_zero_based + 1 == lowest {
                fabricate_input
                    .entry(ge.name.clone())
                    .or_insert(ge.model_position);
            }
        }
    }
    let fabricated = fabricate_bottom_rows(screen_id, cfg, &fabricate_input)?;

    // 7. Assemble MeasuredPoints.
    let mut points: Vec<MeasuredPoint> = Vec::new();
    for (name, pos) in &measured_by_name {
        points.push(MeasuredPoint {
            name: name.clone(),
            position: *pos,
            uncertainty: Uncertainty::Isotropic(INSTRUMENT_SIGMA_MM),
            source: PointSource::TotalStation,
        });
    }
    for (name, pos) in &fabricated {
        points.push(MeasuredPoint {
            name: name.clone(),
            position: *pos,
            uncertainty: Uncertainty::Isotropic(FABRICATED_SIGMA_MM),
            source: PointSource::TotalStation,
        });
    }

    let cabinet_array = if cfg.absent_cells.is_empty() {
        CabinetArray::rectangle(
            cfg.cabinet_count[0],
            cfg.cabinet_count[1],
            cfg.cabinet_size_mm,
        )
    } else {
        CabinetArray::irregular(
            cfg.cabinet_count[0],
            cfg.cabinet_count[1],
            cfg.cabinet_size_mm,
            cfg.absent_cells.clone(),
        )
    };

    let shape_prior = match &cfg.shape_prior {
        crate::project::ShapePriorConfig::Flat => ShapePrior::Flat,
        crate::project::ShapePriorConfig::Curved { radius_mm } => ShapePrior::Curved {
            radius_mm: *radius_mm,
        },
        crate::project::ShapePriorConfig::Folded { fold_seam_columns } => ShapePrior::Folded {
            fold_seam_columns: fold_seam_columns.clone(),
        },
    };

    let mp = MeasuredPoints {
        screen_id: screen_id.to_string(),
        coordinate_frame: frame,
        cabinet_array,
        shape_prior,
        points,
        sampling_mode: mesh_core::sampling::SamplingMode::Grid,
    };

    Ok((mp, outcome))
}
