use nalgebra::Vector3;

use crate::error::AdapterError;
use crate::project::{ScreenConfig, ShapePriorConfig};

/// One expected grid vertex position with its grid name.
#[derive(Debug, Clone)]
pub struct GridExpected {
    pub name: String,
    /// Position in model frame (meters), assuming origin is at the
    /// bottom-left vertex of the screen (`V001_R001`).
    pub model_position: Vector3<f64>,
    pub col_zero_based: u32,
    pub row_zero_based: u32,
}

/// Compute the expected (nominal) position of every grid vertex for a
/// given screen, in model-frame meters, assuming the screen's origin is
/// at the bottom-left vertex (`V001_R001`).
///
/// The returned positions are used as targets for KD-tree nearest-neighbor
/// matching in `geometric_naming.rs`.
pub fn expected_grid_positions(
    screen_id: &str,
    cfg: &ScreenConfig,
) -> Result<Vec<GridExpected>, AdapterError> {
    let cols = cfg.cabinet_count[0];
    let rows = cfg.cabinet_count[1];
    let cw_m = cfg.cabinet_size_mm[0] * 0.001;
    let ch_m = cfg.cabinet_size_mm[1] * 0.001;

    let mut out = Vec::with_capacity(((cols + 1) * (rows + 1)) as usize);

    match &cfg.shape_prior {
        ShapePriorConfig::Flat => {
            for r in 0..=rows {
                for c in 0..=cols {
                    let x = c as f64 * cw_m;
                    let z = r as f64 * ch_m;
                    out.push(GridExpected {
                        name: format!("{screen_id}_V{:03}_R{:03}", c + 1, r + 1),
                        model_position: Vector3::new(x, 0.0, z),
                        col_zero_based: c,
                        row_zero_based: r,
                    });
                }
            }
        }
        ShapePriorConfig::Curved { radius_mm } => {
            // Half-cylinder centered on +Y, radius R. `total_width` is the
            // arc length (cabinets sit flush against the curve), so the
            // chord is slightly shorter than total_width.
            //
            // Anchor: V001_R001 at (0, 0, 0). We compute each vertex's
            // raw position (theta from -half_angle..+half_angle, bow +Y),
            // then translate by V001_R001's raw position so the bottom-
            // left vertex lands on the origin — matches the Flat case
            // and the function contract.
            let r_m = radius_mm * 0.001;
            let total_width = cols as f64 * cw_m;
            let half_angle = total_width / (2.0 * r_m);
            // Raw position of V001_R001 (c=0, r=0) — the anchor we subtract.
            let anchor_x = r_m * (-half_angle).sin();
            let anchor_y = r_m - r_m * (-half_angle).cos();
            for r in 0..=rows {
                for c in 0..=cols {
                    let t = c as f64 / cols as f64;
                    let theta = -half_angle + 2.0 * half_angle * t;
                    let x = r_m * theta.sin() - anchor_x;
                    let y = (r_m - r_m * theta.cos()) - anchor_y;
                    let z = r as f64 * ch_m;
                    out.push(GridExpected {
                        name: format!("{screen_id}_V{:03}_R{:03}", c + 1, r + 1),
                        model_position: Vector3::new(x, y, z),
                        col_zero_based: c,
                        row_zero_based: r,
                    });
                }
            }
        }
        ShapePriorConfig::Folded {
            fold_seam_columns: _,
        } => {
            // M1.1: treat folded as flat for the nominal grid; the actual
            // fold geometry is recovered from measured points in the
            // reconstructor. Future enhancement: piecewise-flat by seam.
            for r in 0..=rows {
                for c in 0..=cols {
                    let x = c as f64 * cw_m;
                    let z = r as f64 * ch_m;
                    out.push(GridExpected {
                        name: format!("{screen_id}_V{:03}_R{:03}", c + 1, r + 1),
                        model_position: Vector3::new(x, 0.0, z),
                        col_zero_based: c,
                        row_zero_based: r,
                    });
                }
            }
        }
    }

    Ok(out)
}
