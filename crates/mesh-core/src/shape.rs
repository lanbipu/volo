use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// Rectangular grid of cabinets, with optional irregular mask.
#[derive(Debug, Clone, Serialize)]
pub struct CabinetArray {
    pub cols: u32,
    pub rows: u32,
    /// Single cabinet size in millimeters: [width, height].
    pub cabinet_size_mm: [f64; 2],
    /// Cells that are explicitly absent (irregular shape).
    /// Keyed by (col, row), 0-based.
    #[serde(default)]
    pub absent_cells: HashSet<(u32, u32)>,
}

#[derive(Deserialize)]
struct CabinetArrayRaw {
    cols: u32,
    rows: u32,
    cabinet_size_mm: [f64; 2],
    #[serde(default)]
    absent_cells: HashSet<(u32, u32)>,
}

impl<'de> Deserialize<'de> for CabinetArray {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let raw = CabinetArrayRaw::deserialize(d)?;
        if raw.cols > crate::surface::MAX_GRID_DIM {
            return Err(serde::de::Error::custom(format!(
                "CabinetArray.cols {} exceeds MAX_GRID_DIM ({})",
                raw.cols,
                crate::surface::MAX_GRID_DIM
            )));
        }
        if raw.rows > crate::surface::MAX_GRID_DIM {
            return Err(serde::de::Error::custom(format!(
                "CabinetArray.rows {} exceeds MAX_GRID_DIM ({})",
                raw.rows,
                crate::surface::MAX_GRID_DIM
            )));
        }
        if raw.cols == 0 {
            return Err(serde::de::Error::custom("CabinetArray.cols must be > 0"));
        }
        if raw.rows == 0 {
            return Err(serde::de::Error::custom("CabinetArray.rows must be > 0"));
        }
        for (i, v) in raw.cabinet_size_mm.iter().enumerate() {
            if !v.is_finite() || *v <= 0.0 {
                return Err(serde::de::Error::custom(format!(
                    "CabinetArray.cabinet_size_mm[{i}] must be finite and positive: got {v}"
                )));
            }
        }
        Ok(Self {
            cols: raw.cols,
            rows: raw.rows,
            cabinet_size_mm: raw.cabinet_size_mm,
            absent_cells: raw.absent_cells,
        })
    }
}

impl CabinetArray {
    /// Construct a complete rectangular array (no missing cells).
    pub fn rectangle(cols: u32, rows: u32, cabinet_size_mm: [f64; 2]) -> Self {
        Self {
            cols,
            rows,
            cabinet_size_mm,
            absent_cells: HashSet::new(),
        }
    }

    /// Construct an irregular array with explicitly absent cells.
    pub fn irregular(
        cols: u32,
        rows: u32,
        cabinet_size_mm: [f64; 2],
        absent: Vec<(u32, u32)>,
    ) -> Self {
        Self {
            cols,
            rows,
            cabinet_size_mm,
            absent_cells: absent.into_iter().collect(),
        }
    }

    /// Returns whether a given (col, row) cell exists in the screen.
    pub fn is_present(&self, col: u32, row: u32) -> bool {
        col < self.cols && row < self.rows && !self.absent_cells.contains(&(col, row))
    }

    /// Total physical size of the rectangular bounding box, in mm.
    pub fn total_size_mm(&self) -> [f64; 2] {
        [
            self.cabinet_size_mm[0] * self.cols as f64,
            self.cabinet_size_mm[1] * self.rows as f64,
        ]
    }
}

/// Prior knowledge about screen geometry.
///
/// Externally tagged: `flat` for unit variant, `curved: { radius_mm: N }` etc.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShapePrior {
    Flat,
    /// Half-cylinder with constant radius.
    Curved {
        radius_mm: f64,
    },
    /// Multi-segment flat with folds at given column indices.
    Folded {
        fold_seam_columns: Vec<u32>,
    },
}
