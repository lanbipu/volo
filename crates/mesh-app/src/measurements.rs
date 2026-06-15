use mesh_core::measured_points::MeasuredPoints;
use volo_shared::error::{VoloError, VoloResult};
use std::path::Path;

/// Pure helper: read `measured.yaml` from an absolute file path.
/// Returns `NotFound` if the file does not exist.
pub fn load_measurements_from_path(path: &Path) -> VoloResult<MeasuredPoints> {
    if !path.is_file() {
        return Err(VoloError::NotFound(path.display().to_string()));
    }
    let yaml = std::fs::read_to_string(path)?;
    Ok(serde_yaml::from_str(&yaml)?)
}
