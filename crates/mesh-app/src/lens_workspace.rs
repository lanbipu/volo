//! Lens capture workspace — deterministic multi-screen VP-QSP assignment and the
//! `patterns/<id>/meta.json` schema used by the auto-generation freshness check.
//!
//! Business logic lives here (transport-agnostic, CLI-reusable); the
//! `#[tauri::command]` wrappers stay in `src-tauri/src/commands/vpcal_runs.rs`.
//! See `docs/calibrate/lens-capture-auto-paths-spec.md` §3.2/§3.3.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use volo_shared::dto::{ScreenConfig, ShapePriorConfig};
use volo_shared::error::{VoloError, VoloResult};

pub const ASSIGNMENT_SCHEMA: &str = "volo_vpqsp_assignment.v1";
pub const PATTERNS_META_SCHEMA: &str = "volo_lens_patterns.v1";

const TARGET_MARKERS_SHORT_SIDE: u32 = 6;
const MIN_MARKER_CELL_PX: f64 = 80.0;

/// Cabinet-column gap between adjacent screens' marker id ranges. Mirrors
/// `_COL_OFFSET_GAP` in `sidecars/vpcal/.../cli/tracker_free.py` so spatial's
/// default `--offset-b` (= A 总列数 + 5) lands on the same value the pattern
/// generator baked in.
const COL_OFFSET_GAP: u32 = 5;

/// VP-QSP `screen_id` is a 4-bit codeword → at most 16 distinct screens.
const MAX_SCREENS: usize = 16;

/// One screen's assignment: 4-bit `code`, cabinet-column `offset`, and the
/// screen's own column count (persisted so downstream consumers — spatial CLI or
/// future UI — can recompute neighbour offsets without reloading project.yaml).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LensScreenAssign {
    pub code: u32,
    pub offset: u32,
    pub columns: u32,
}

/// `<project>/vpcal/assignment.json` payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LensAssignment {
    pub schema_version: String,
    pub screens: BTreeMap<String, LensScreenAssign>,
}

/// `<project>/vpcal/patterns/<screenId>/meta.json` payload (schema v1).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LensPatternsMeta {
    pub schema_version: String,
    pub screen_fingerprint: String,
    pub screen_id_code: u32,
    pub cab_col_offset: u32,
    pub graycode_tags: bool,
    pub generated_at: String,
    pub files: Vec<String>,
}

/// VP-QSP uses a virtual marker grid rather than the physical cabinet count.
/// This keeps a one-cabinet monitor/TV dense enough for a conditioned PnP
/// solve while preserving the physical section size.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LensPatternGrid {
    pub columns: u32,
    pub rows: u32,
    pub cell_size_mm: [f64; 2],
    pub markers_per_cell: u8,
}

pub fn pattern_grid_for_screen(screen: &ScreenConfig) -> LensPatternGrid {
    let physical_width_mm = screen.cabinet_count[0] as f64 * screen.cabinet_size_mm[0];
    let physical_height_mm = screen.cabinet_count[1] as f64 * screen.cabinet_size_mm[1];
    let supports_virtual_grid = matches!(
        screen.shape_prior,
        ShapePriorConfig::Flat | ShapePriorConfig::Folded { .. }
    );
    if supports_virtual_grid {
        if let Some(pixels_per_cabinet) = screen.pixels_per_cabinet {
            let width_px = screen.cabinet_count[0] as f64 * pixels_per_cabinet[0] as f64;
            let height_px = screen.cabinet_count[1] as f64 * pixels_per_cabinet[1] as f64;
            if width_px > 0.0 && height_px > 0.0 {
                let landscape = width_px >= height_px;
                let short_px = width_px.min(height_px);
                let long_px = width_px.max(height_px);
                for short_count in (2..=TARGET_MARKERS_SHORT_SIDE).rev() {
                    let cell_px = short_px / short_count as f64;
                    if cell_px < MIN_MARKER_CELL_PX {
                        continue;
                    }
                    let long_count = (long_px / cell_px).round().max(2.0) as u32;
                    if long_px / (long_count as f64) < MIN_MARKER_CELL_PX {
                        continue;
                    }
                    let (columns, rows) = if landscape {
                        (long_count, short_count)
                    } else {
                        (short_count, long_count)
                    };
                    return LensPatternGrid {
                        columns,
                        rows,
                        cell_size_mm: [
                            physical_width_mm / columns as f64,
                            physical_height_mm / rows as f64,
                        ],
                        markers_per_cell: 1,
                    };
                }
            }
        }
    }
    LensPatternGrid {
        columns: screen.cabinet_count[0],
        rows: screen.cabinet_count[1],
        cell_size_mm: screen.cabinet_size_mm,
        markers_per_cell: 4,
    }
}

/// Deterministic screen-id / cab-col-offset assignment (§3.3).
///
/// - Screens are sorted by id (lexicographic — `BTreeMap` iterates in key order).
/// - `code[i]` = sorted index (matches `vpqspScreenIdCode` in the frontend).
/// - `offset[0] = 0`; `offset[i] = offset[i-1] + columns[i-1] + COL_OFFSET_GAP`
///   where `columns` is the exported VP-QSP virtual marker-grid width.
///
/// Errors when there are more than 16 screens (4-bit code exhausted).
pub fn assignment_from_screens(
    screens: &BTreeMap<String, ScreenConfig>,
) -> VoloResult<LensAssignment> {
    if screens.len() > MAX_SCREENS {
        return Err(VoloError::InvalidInput(format!(
            "VP-QSP 屏幕标识码仅 4 bit(0-15)，项目内已有 {} 块屏幕，无法为每屏分配唯一码",
            screens.len()
        )));
    }
    let mut out: BTreeMap<String, LensScreenAssign> = BTreeMap::new();
    let mut offset: u32 = 0;
    let mut prev_columns: Option<u32> = None;
    for (idx, (id, sc)) in screens.iter().enumerate() {
        if let Some(pc) = prev_columns {
            offset = offset + pc + COL_OFFSET_GAP;
        }
        let columns = pattern_grid_for_screen(sc).columns;
        out.insert(
            id.clone(),
            LensScreenAssign {
                code: idx as u32,
                offset,
                columns,
            },
        );
        prev_columns = Some(columns);
    }
    Ok(LensAssignment {
        schema_version: ASSIGNMENT_SCHEMA.to_string(),
        screens: out,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use volo_shared::dto::{ShapeMode, ShapePriorConfig};

    fn screen(cols: u32, rows: u32) -> ScreenConfig {
        ScreenConfig {
            cabinet_count: [cols, rows],
            cabinet_size_mm: [500.0, 500.0],
            pixels_per_cabinet: Some([250, 250]),
            output_topology: None,
            shape_prior: ShapePriorConfig::Flat,
            shape_mode: ShapeMode::Rectangle,
            irregular_mask: Vec::new(),
            bottom_completion: None,
            position_m: [0.0, 0.0, 0.0],
            yaw_deg: 0.0,
            height_offset_mm: 0.0,
            normal_flip: false,
            origin_aligned: false,
        }
    }

    fn screens(pairs: &[(&str, u32)]) -> BTreeMap<String, ScreenConfig> {
        pairs
            .iter()
            .map(|(id, cols)| (id.to_string(), screen(*cols, 2)))
            .collect()
    }

    #[test]
    fn two_screens_codes_and_offset_gap() {
        // A has 4 cabinet columns; B's offset must be A.cols + 5 = 9.
        let a = assignment_from_screens(&screens(&[("A", 4), ("B", 3)])).unwrap();
        assert_eq!(a.schema_version, ASSIGNMENT_SCHEMA);
        let sa = &a.screens["A"];
        let sb = &a.screens["B"];
        assert_eq!(sa.code, 0);
        assert_eq!(sa.offset, 0);
        assert_eq!(sa.columns, 4);
        assert_eq!(sb.code, 1);
        assert_eq!(sb.offset, 4 + 5); // A.cabinet_count[0] + gap
        assert_eq!(sb.columns, 3);
    }

    #[test]
    fn sorts_by_id_not_insertion_order() {
        // Insertion order Z,A must still yield code A=0, Z=1 (sorted).
        let mut m = BTreeMap::new();
        m.insert("Z".to_string(), screen(6, 2));
        m.insert("A".to_string(), screen(4, 2));
        let a = assignment_from_screens(&m).unwrap();
        assert_eq!(a.screens["A"].code, 0);
        assert_eq!(a.screens["A"].offset, 0);
        assert_eq!(a.screens["Z"].code, 1);
        assert_eq!(a.screens["Z"].offset, 4 + 5);
    }

    #[test]
    fn three_screens_offset_accumulates() {
        // A(4), B(3), C(5): offsets 0, 9, 9+3+5=17.
        let a = assignment_from_screens(&screens(&[("A", 4), ("B", 3), ("C", 5)])).unwrap();
        assert_eq!(a.screens["A"].offset, 0);
        assert_eq!(a.screens["B"].offset, 4 + 5);
        assert_eq!(a.screens["C"].offset, (4 + 5) + 3 + 5);
        assert_eq!(a.screens["C"].code, 2);
    }

    #[test]
    fn rejects_more_than_sixteen_screens() {
        let pairs: Vec<(String, u32)> = (0..17).map(|i| (format!("S{i:02}"), 4)).collect();
        let m: BTreeMap<String, ScreenConfig> =
            pairs.iter().map(|(id, c)| (id.clone(), screen(*c, 2))).collect();
        let err = assignment_from_screens(&m).unwrap_err();
        assert!(matches!(err, VoloError::InvalidInput(_)));
    }

    #[test]
    fn one_cabinet_uhd_display_gets_dense_virtual_grid() {
        let mut sc = screen(1, 1);
        sc.cabinet_size_mm = [1209.0, 678.0];
        sc.pixels_per_cabinet = Some([3840, 2160]);
        let grid = pattern_grid_for_screen(&sc);
        assert_eq!((grid.columns, grid.rows), (11, 6));
        assert_eq!(grid.markers_per_cell, 1);
        assert_eq!(grid.columns * grid.rows, 66);
        assert!((grid.cell_size_mm[0] * 11.0 - 1209.0).abs() < 1.0e-9);
        assert!((grid.cell_size_mm[1] * 6.0 - 678.0).abs() < 1.0e-9);
    }
}
