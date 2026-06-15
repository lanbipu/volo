use std::collections::HashSet;
use std::path::Path;

use nalgebra::Vector3;
use serde::Deserialize;

use crate::error::AdapterError;
use crate::raw_point::RawPoint;

#[derive(Debug, Deserialize)]
struct CsvRow {
    name: String,
    x: f64,
    y: f64,
    z: f64,
    #[serde(default)]
    note: String,
}

/// Parse a Trimble/Leica-style CSV export into raw points (mm).
///
/// Required columns: `name,x,y,z,note` (note may be empty).
/// `name` is parsed as a `u32` instrument id; the field SOP requires
/// the instrument to assign sequential numeric ids.
pub fn parse_csv(path: &Path) -> Result<Vec<RawPoint>, AdapterError> {
    let mut rdr = csv::Reader::from_path(path)?;
    let mut out = Vec::new();
    let mut seen_ids: HashSet<u32> = HashSet::new();

    for row in rdr.deserialize() {
        let row: CsvRow = row?;
        let instrument_id: u32 = row.name.trim().parse().map_err(|e| {
            AdapterError::InvalidInput(format!(
                "expected numeric instrument id, got {:?}: {e}",
                row.name
            ))
        })?;
        if instrument_id == 0 {
            return Err(AdapterError::InvalidInput(
                "instrument_id 0 is not allowed (Trimble/Leica start at 1)".into(),
            ));
        }
        if !seen_ids.insert(instrument_id) {
            return Err(AdapterError::InvalidInput(format!(
                "duplicate instrument_id {instrument_id} in CSV"
            )));
        }
        if !row.x.is_finite() || !row.y.is_finite() || !row.z.is_finite() {
            return Err(AdapterError::InvalidInput(format!(
                "non-finite coordinate on point id {instrument_id}: ({}, {}, {})",
                row.x, row.y, row.z
            )));
        }
        let note = if row.note.trim().is_empty() {
            None
        } else {
            Some(row.note.trim().to_string())
        };
        out.push(RawPoint {
            instrument_id,
            position_mm: Vector3::new(row.x, row.y, row.z),
            note,
        });
    }

    Ok(out)
}
