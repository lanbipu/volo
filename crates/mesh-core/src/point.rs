use nalgebra::Vector3;
use serde::{Deserialize, Serialize};

use crate::uncertainty::Uncertainty;

/// Source of a 3D point (used for diagnostics + weighting heuristics).
///
/// Externally tagged: `total_station` for unit variant, `visual_ba: { camera_count: N }`
/// for struct variant.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PointSource {
    /// Direct measurement from a total-station instrument (M1).
    TotalStation,
    /// Reconstructed via visual photogrammetry (M2).
    VisualBA { camera_count: u32 },
}

/// One measured 3D point in the model coordinate frame.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeasuredPoint {
    /// Grid identifier, e.g. `MAIN_V001_R005`.
    pub name: String,
    /// Position in model frame (meters). Origin at user-selected reference.
    #[serde(with = "vector3_serde")]
    pub position: Vector3<f64>,
    /// Per-point uncertainty.
    pub uncertainty: Uncertainty,
    /// Where this point came from.
    pub source: PointSource,
}

mod vector3_serde {
    use nalgebra::Vector3;
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<S: Serializer>(v: &Vector3<f64>, s: S) -> Result<S::Ok, S::Error> {
        [v.x, v.y, v.z].serialize(s)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vector3<f64>, D::Error> {
        let arr: [f64; 3] = Deserialize::deserialize(d)?;
        Ok(Vector3::new(arr[0], arr[1], arr[2]))
    }
}
