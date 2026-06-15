use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdapterReport {
    pub project_name: String,
    pub screens: Vec<ScreenReport>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScreenReport {
    pub screen_id: String,
    /// (cols+1) × (rows+1) total grid vertices expected for this screen.
    pub expected_count: usize,
    /// Number of grid vertices populated from CSV measurements (excludes fabricated).
    pub measured_count: usize,
    /// Number of grid vertices fabricated via bottom-occlusion fallback.
    pub fabricated_count: usize,
    /// Grid names that were neither measured nor fabricated.
    pub missing: Vec<MissingPoint>,
    /// Raw points whose nearest expected position is too far (likely a stray / wrong screen).
    pub outliers: Vec<OutlierPoint>,
    /// Raw points that match two or more expected positions within the tolerance.
    pub ambiguous: Vec<AmbiguousMatch>,
    pub warnings: Vec<String>,
    /// Aggregate uncertainty estimate (mm). Computed as RMS of input point sigmas.
    pub estimated_rms_mm: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MissingPoint {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutlierPoint {
    pub instrument_id: u32,
    pub distance_to_nearest_mm: f64,
    pub nearest_grid_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AmbiguousMatch {
    pub instrument_id: u32,
    /// Two or more grid names within the matching tolerance.
    pub candidates: Vec<String>,
}
