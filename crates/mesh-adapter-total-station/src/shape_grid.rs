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
            //
            // (Not extended when arc/l_shape/u_shape/custom_segments were
            // added below: `fold_seam_columns` carries seam *locations*
            // only, no angle — there is nothing here to lay out a true
            // fold from without inventing a magnitude. Those four new
            // variants all carry an explicit angle, which is what makes
            // a closed-form nominal position possible for them.)
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
        ShapePriorConfig::Arc { .. }
        | ShapePriorConfig::LShape { .. }
        | ShapePriorConfig::UShape { .. }
        | ShapePriorConfig::CustomSegments { .. } => {
            let headings = column_headings_deg(&cfg.shape_prior, cols);
            out.extend(nominal_positions_from_headings(
                screen_id, &headings, cols, rows, cw_m, ch_m,
            ));
        }
    }

    Ok(out)
}

/// Absolute per-column heading (degrees), one entry per column `c` in
/// `0..cols`. Column `c` is a straight run pointing at this heading —
/// consecutive columns can have different headings, producing a polyline
/// wall in the X-Y (bow) plane. Row stacking (Z) is independent, added by
/// [`nominal_positions_from_headings`].
///
/// Only meaningful for the four variants handled by that function; other
/// variants (Flat/Curved/Folded) have their own dedicated code paths above
/// and never reach this helper.
fn column_headings_deg(prior: &ShapePriorConfig, cols: u32) -> Vec<f64> {
    match prior {
        ShapePriorConfig::Arc {
            center_flat_cols,
            angle_per_col_deg,
        } => {
            // Mirrors the frontend viewport's arc formula so both sides
            // agree on where columns land: a flat center span, then a
            // constant per-column turn accumulating outward.
            let mid = (cols as f64 - 1.0) / 2.0;
            let cf = *center_flat_cols as f64;
            (0..cols)
                .map(|i| {
                    let d = i as f64 - mid;
                    let out = (d.abs() - cf / 2.0).max(0.0);
                    d.signum() * out * angle_per_col_deg
                })
                .collect()
        }
        ShapePriorConfig::LShape {
            left_cols,
            soften_cols,
            corner_angle_deg,
        } => {
            let (lc, soft, ang) = (*left_cols, *soften_cols, *corner_angle_deg);
            (0..cols)
                .map(|i| {
                    if i < lc {
                        0.0
                    } else if i < lc + soft {
                        ang * ((i - lc + 1) as f64 / (soft + 1) as f64)
                    } else {
                        ang
                    }
                })
                .collect()
        }
        ShapePriorConfig::UShape {
            wing_cols,
            soften_cols,
            corner_angle_deg,
        } => {
            let (wc, soft, ang) = (*wing_cols, *soften_cols, *corner_angle_deg);
            (0..cols)
                .map(|i| {
                    if i < wc {
                        ang
                    } else if i < wc + soft {
                        ang * (1.0 - (i - wc + 1) as f64 / (soft + 1) as f64)
                    } else if i >= cols - wc {
                        -ang
                    } else if i >= cols - wc - soft {
                        -ang * ((i - (cols - wc - soft) + 1) as f64 / (soft + 1) as f64)
                    } else {
                        0.0
                    }
                })
                .collect()
        }
        ShapePriorConfig::CustomSegments { segments } => {
            let mut out = Vec::with_capacity(cols as usize);
            for seg in segments {
                out.extend(std::iter::repeat(seg.cum_angle_deg).take(seg.cols as usize));
            }
            out
        }
        ShapePriorConfig::Flat | ShapePriorConfig::Curved { .. } | ShapePriorConfig::Folded { .. } => {
            vec![0.0; cols as usize]
        }
    }
}

/// Walk `headings_deg` column by column, accumulating seam positions in the
/// X-Y (bow) plane (`seam[0]` = the V001 column of vertices, anchored at the
/// origin, matching the Flat/Curved branches' contract), then combine with
/// row stacking along Z.
fn nominal_positions_from_headings(
    screen_id: &str,
    headings_deg: &[f64],
    cols: u32,
    rows: u32,
    cw_m: f64,
    ch_m: f64,
) -> Vec<GridExpected> {
    let mut seam_x = Vec::with_capacity(cols as usize + 1);
    let mut seam_y = Vec::with_capacity(cols as usize + 1);
    seam_x.push(0.0);
    seam_y.push(0.0);
    for &heading in headings_deg {
        let theta = heading.to_radians();
        let (px, py) = (*seam_x.last().unwrap(), *seam_y.last().unwrap());
        seam_x.push(px + cw_m * theta.cos());
        seam_y.push(py + cw_m * theta.sin());
    }

    let mut out = Vec::with_capacity((cols as usize + 1) * (rows as usize + 1));
    for r in 0..=rows {
        for c in 0..=cols {
            out.push(GridExpected {
                name: format!("{screen_id}_V{:03}_R{:03}", c + 1, r + 1),
                model_position: Vector3::new(seam_x[c as usize], seam_y[c as usize], r as f64 * ch_m),
                col_zero_based: c,
                row_zero_based: r,
            });
        }
    }
    out
}
