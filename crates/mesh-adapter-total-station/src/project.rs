use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::error::AdapterError;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectConfig {
    pub project: ProjectMeta,
    pub screens: HashMap<String, ScreenConfig>,
    pub coordinate_system: CoordinateSystemConfig,
}

impl ProjectConfig {
    /// Reject configs whose geometry would later poison reconstruction:
    /// zero/NaN dimensions, impossible curved radius, out-of-range
    /// `bottom_completion` rows, or coordinate-system grid names that
    /// don't match the project's screen-naming scheme.
    pub fn validate(&self) -> Result<(), AdapterError> {
        if self.screens.is_empty() {
            return Err(AdapterError::InvalidInput("no screens defined".into()));
        }
        for (id, s) in &self.screens {
            s.validate(id)?;
        }
        self.coordinate_system.validate()?;
        Ok(())
    }
}

impl ScreenConfig {
    fn validate(&self, screen_id: &str) -> Result<(), AdapterError> {
        let [cols, rows] = self.cabinet_count;
        if cols == 0 || rows == 0 {
            return Err(AdapterError::InvalidInput(format!(
                "screen {screen_id}: cabinet_count must be > 0; got [{cols}, {rows}]"
            )));
        }
        let [w, h] = self.cabinet_size_mm;
        if !w.is_finite() || !h.is_finite() || w <= 0.0 || h <= 0.0 {
            return Err(AdapterError::InvalidInput(format!(
                "screen {screen_id}: cabinet_size_mm must be finite > 0; got [{w}, {h}]"
            )));
        }
        match &self.shape_prior {
            ShapePriorConfig::Curved { radius_mm } => {
                let total_width_mm = w * cols as f64;
                if !radius_mm.is_finite() || *radius_mm <= 0.0 {
                    return Err(AdapterError::InvalidInput(format!(
                        "screen {screen_id}: curved radius_mm must be finite > 0; got {radius_mm}"
                    )));
                }
                if *radius_mm * 2.0 < total_width_mm {
                    return Err(AdapterError::InvalidInput(format!(
                        "screen {screen_id}: curved radius_mm={radius_mm} too small for screen width {total_width_mm}mm \
                         (radius must be at least half the chord)"
                    )));
                }
            }
            ShapePriorConfig::Folded { fold_seam_columns } => {
                for c in fold_seam_columns {
                    if *c == 0 || *c > cols {
                        return Err(AdapterError::InvalidInput(format!(
                            "screen {screen_id}: fold_seam_columns entry {c} out of range [1, {cols}]"
                        )));
                    }
                }
            }
            ShapePriorConfig::Flat => {}
            ShapePriorConfig::Arc { center_flat_cols, angle_per_col_deg } => {
                if !angle_per_col_deg.is_finite() {
                    return Err(AdapterError::InvalidInput(format!(
                        "screen {screen_id}: arc angle_per_col_deg must be finite; got {angle_per_col_deg}"
                    )));
                }
                if *center_flat_cols > cols {
                    return Err(AdapterError::InvalidInput(format!(
                        "screen {screen_id}: arc center_flat_cols={center_flat_cols} exceeds total columns {cols}"
                    )));
                }
            }
            ShapePriorConfig::LShape { left_cols, soften_cols, corner_angle_deg } => {
                if !corner_angle_deg.is_finite() {
                    return Err(AdapterError::InvalidInput(format!(
                        "screen {screen_id}: l_shape corner_angle_deg must be finite; got {corner_angle_deg}"
                    )));
                }
                if *left_cols == 0 {
                    return Err(AdapterError::InvalidInput(format!(
                        "screen {screen_id}: l_shape left_cols must be > 0"
                    )));
                }
                if left_cols.checked_add(*soften_cols).is_none_or(|sum| sum >= cols) {
                    return Err(AdapterError::InvalidInput(format!(
                        "screen {screen_id}: l_shape left_cols({left_cols}) + soften_cols({soften_cols}) \
                         must leave at least 1 column for the right leg (total {cols})"
                    )));
                }
            }
            ShapePriorConfig::UShape { wing_cols, soften_cols, corner_angle_deg } => {
                if !corner_angle_deg.is_finite() {
                    return Err(AdapterError::InvalidInput(format!(
                        "screen {screen_id}: u_shape corner_angle_deg must be finite; got {corner_angle_deg}"
                    )));
                }
                if *wing_cols == 0 {
                    return Err(AdapterError::InvalidInput(format!(
                        "screen {screen_id}: u_shape wing_cols must be > 0"
                    )));
                }
                let both_wings = wing_cols
                    .checked_add(*soften_cols)
                    .and_then(|half| half.checked_mul(2));
                if both_wings.is_none_or(|sum| sum >= cols) {
                    return Err(AdapterError::InvalidInput(format!(
                        "screen {screen_id}: u_shape wing_cols({wing_cols}) + soften_cols({soften_cols}) on \
                         both sides must leave at least 1 center column (total {cols})"
                    )));
                }
            }
            ShapePriorConfig::CustomSegments { segments } => {
                if segments.is_empty() {
                    return Err(AdapterError::InvalidInput(format!(
                        "screen {screen_id}: custom_segments must have at least 1 segment"
                    )));
                }
                let mut sum = 0u32;
                for seg in segments {
                    if seg.cols == 0 {
                        return Err(AdapterError::InvalidInput(format!(
                            "screen {screen_id}: custom_segments entry has cols=0"
                        )));
                    }
                    if !seg.cum_angle_deg.is_finite() {
                        return Err(AdapterError::InvalidInput(format!(
                            "screen {screen_id}: custom_segments cum_angle_deg must be finite; got {}",
                            seg.cum_angle_deg
                        )));
                    }
                    sum = sum.checked_add(seg.cols).ok_or_else(|| {
                        AdapterError::InvalidInput(format!(
                            "screen {screen_id}: custom_segments cols overflow u32 while summing"
                        ))
                    })?;
                }
                if sum != cols {
                    return Err(AdapterError::InvalidInput(format!(
                        "screen {screen_id}: custom_segments cols sum to {sum}, must equal total columns {cols}"
                    )));
                }
            }
        }
        if let Some(bc) = &self.bottom_completion {
            if bc.lowest_measurable_row == 0 || bc.lowest_measurable_row > rows + 1 {
                return Err(AdapterError::InvalidInput(format!(
                    "screen {screen_id}: lowest_measurable_row={} outside vertex range [1, {}]",
                    bc.lowest_measurable_row,
                    rows + 1
                )));
            }
        }
        for (c, r) in &self.absent_cells {
            if *c >= cols || *r >= rows {
                return Err(AdapterError::InvalidInput(format!(
                    "screen {screen_id}: absent_cells entry ({c}, {r}) out of range ({cols}, {rows})"
                )));
            }
        }
        Ok(())
    }
}

impl CoordinateSystemConfig {
    fn validate(&self) -> Result<(), AdapterError> {
        if self.origin_grid_name.is_empty()
            || self.x_axis_grid_name.is_empty()
            || self.xy_plane_grid_name.is_empty()
        {
            return Err(AdapterError::InvalidInput(
                "coordinate_system grid names must be non-empty".into(),
            ));
        }
        let three = [
            &self.origin_grid_name,
            &self.x_axis_grid_name,
            &self.xy_plane_grid_name,
        ];
        for i in 0..3 {
            for j in (i + 1)..3 {
                if three[i] == three[j] {
                    return Err(AdapterError::InvalidInput(format!(
                        "coordinate_system grid names must be distinct; duplicate {:?}",
                        three[i]
                    )));
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectMeta {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScreenConfig {
    /// `[cols, rows]` in cabinets.
    pub cabinet_count: [u32; 2],
    /// Single cabinet `[width_mm, height_mm]`.
    pub cabinet_size_mm: [f64; 2],
    pub shape_prior: ShapePriorConfig,
    /// `None` → no bottom occlusion (lowest row is R001).
    #[serde(default)]
    pub bottom_completion: Option<BottomCompletion>,
    /// Cells absent in irregular shapes; `(col, row)` 0-based.
    #[serde(default)]
    pub absent_cells: Vec<(u32, u32)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum ShapePriorConfig {
    Flat,
    Curved { radius_mm: f64 },
    Folded { fold_seam_columns: Vec<u32> },
    /// Symmetric arc: a flat center span, then a constant per-column turn
    /// angle accumulating outward on both sides.
    Arc { center_flat_cols: u32, angle_per_col_deg: f64 },
    /// Two straight legs meeting at one corner. The second leg's length is
    /// derived (`total_cols - left_cols - soften_cols`), not stored here.
    LShape { left_cols: u32, soften_cols: u32, corner_angle_deg: f64 },
    /// Two symmetric corners (a center span flanked by two equal wings).
    UShape { wing_cols: u32, soften_cols: u32, corner_angle_deg: f64 },
    /// Explicit column-run segments; segment `cols` must sum to the
    /// screen's total column count.
    CustomSegments { segments: Vec<ShapeSegment> },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShapeSegment {
    pub cols: u32,
    pub cum_angle_deg: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BottomCompletion {
    pub lowest_measurable_row: u32,
    pub fallback_method: FallbackMethod,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FallbackMethod {
    /// R<lowest-1>..R001 = R<lowest>.position − k×cabinet_height (vertical extension).
    Vertical,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoordinateSystemConfig {
    pub origin_grid_name: String,
    pub x_axis_grid_name: String,
    pub xy_plane_grid_name: String,
}
