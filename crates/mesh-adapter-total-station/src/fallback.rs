use std::collections::HashMap;

use nalgebra::Vector3;

use crate::error::AdapterError;
use crate::project::{FallbackMethod, ScreenConfig};

/// Fabricate vertices for grid rows below `lowest_measurable_row` by
/// vertical extension from the lowest measured row.
///
/// Returns a map of fabricated `grid_name → model_position`. Empty if
/// `bottom_completion` is `None`.
///
/// **Convention**: `lowest_measurable_row` is a 1-based **vertex row**
/// (e.g. R005 in `MAIN_V001_R005`). The vertex grid has `rows + 1` rows
/// numbered R001..R<rows+1>; R001 is the bottom edge.
pub fn fabricate_bottom_rows(
    screen_id: &str,
    cfg: &ScreenConfig,
    measured: &HashMap<String, Vector3<f64>>,
) -> Result<HashMap<String, Vector3<f64>>, AdapterError> {
    let Some(bc) = &cfg.bottom_completion else {
        return Ok(HashMap::new());
    };
    let lowest = bc.lowest_measurable_row;
    if lowest <= 1 {
        return Ok(HashMap::new());
    }

    let cols = cfg.cabinet_count[0];
    let cabinet_height_m = cfg.cabinet_size_mm[1] * 0.001;

    let mut out = HashMap::new();

    match bc.fallback_method {
        FallbackMethod::Vertical => {
            // For each column, anchor on the measured R<lowest> vertex,
            // then push down by cabinet height for each missing row below.
            for c in 1..=(cols + 1) {
                let anchor_name = format!("{screen_id}_V{:03}_R{:03}", c, lowest);
                let anchor = measured.get(&anchor_name).ok_or_else(|| {
                    AdapterError::InvalidInput(format!(
                        "fallback anchor {} not in measured points; \
                         cannot fabricate rows R001..R{:03}",
                        anchor_name,
                        lowest - 1
                    ))
                })?;

                for r in 1..lowest {
                    // Distance below anchor = (lowest - r) cabinets in z.
                    let dz = (lowest as f64 - r as f64) * cabinet_height_m;
                    let pos = Vector3::new(anchor.x, anchor.y, anchor.z - dz);
                    out.insert(format!("{screen_id}_V{:03}_R{:03}", c, r), pos);
                }
            }
        }
    }

    Ok(out)
}
