use nalgebra::Vector3;

/// One row from the total-station CSV export (instrument coordinates, mm).
///
/// `instrument_id` is the auto-incremented point number assigned by the
/// instrument (e.g. Trimble Access). Per the field SOP, the first 3 points
/// are the user-selected reference markers (origin / X-axis / XY-plane).
#[derive(Debug, Clone)]
pub struct RawPoint {
    pub instrument_id: u32,
    /// Position in instrument frame, **millimeters**.
    pub position_mm: Vector3<f64>,
    pub note: Option<String>,
}

impl RawPoint {
    /// Convert position to meters (matches `mesh-core` IR convention).
    pub fn position_meters(&self) -> Vector3<f64> {
        self.position_mm * 0.001
    }
}
