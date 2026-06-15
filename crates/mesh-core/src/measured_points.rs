use serde::{Deserialize, Serialize};

use crate::coordinate::CoordinateFrame;
use crate::point::MeasuredPoint;
use crate::sampling::SamplingMode;
use crate::shape::{CabinetArray, ShapePrior};

/// Top-level IR: all measured points for one screen plus its
/// coordinate frame and structural priors.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeasuredPoints {
    pub screen_id: String,
    pub coordinate_frame: CoordinateFrame,
    pub cabinet_array: CabinetArray,
    pub shape_prior: ShapePrior,
    pub points: Vec<MeasuredPoint>,
    /// 采样方式。旧 measured.yaml 无此字段时默认 Grid（向后兼容）。
    #[serde(default)]
    pub sampling_mode: SamplingMode,
}

impl MeasuredPoints {
    /// Find a point by exact name. Returns `None` if not found.
    pub fn find(&self, name: &str) -> Option<&MeasuredPoint> {
        self.points.iter().find(|p| p.name == name)
    }

    /// Number of measured points present.
    pub fn len(&self) -> usize {
        self.points.len()
    }

    pub fn is_empty(&self) -> bool {
        self.points.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coordinate::CoordinateFrame;
    use crate::sampling::SamplingMode;
    use crate::shape::{CabinetArray, ShapePrior};
    use nalgebra::Vector3;

    fn sample_frame() -> CoordinateFrame {
        CoordinateFrame::from_three_points(
            Vector3::zeros(),
            Vector3::new(1.0, 0.0, 0.0),
            Vector3::new(0.0, 0.0, 1.0),
        )
        .unwrap()
    }

    #[test]
    fn legacy_yaml_without_sampling_mode_defaults_to_grid() {
        // Create a MeasuredPoints struct and serialize it without sampling_mode,
        // then deserialize to verify default is Grid
        let original = MeasuredPoints {
            screen_id: "MAIN".into(),
            coordinate_frame: sample_frame(),
            cabinet_array: CabinetArray::rectangle(4, 2, [500.0, 500.0]),
            shape_prior: ShapePrior::Flat,
            points: vec![],
            sampling_mode: SamplingMode::Grid,
        };

        // Serialize and remove the sampling_mode field to simulate legacy YAML
        let yaml = serde_yaml::to_string(&original).unwrap();
        let yaml_without_sampling_mode = yaml
            .lines()
            .filter(|line| !line.contains("sampling_mode"))
            .collect::<Vec<_>>()
            .join("\n");

        // Deserialize the legacy YAML (without sampling_mode)
        let mp: MeasuredPoints = serde_yaml::from_str(&yaml_without_sampling_mode).unwrap();
        assert_eq!(mp.sampling_mode, SamplingMode::Grid);
    }

    #[test]
    fn scatter_mode_parses() {
        let base = MeasuredPoints {
            screen_id: "MAIN".into(),
            coordinate_frame: sample_frame(),
            cabinet_array: CabinetArray::rectangle(4, 2, [500.0, 500.0]),
            shape_prior: ShapePrior::Flat,
            points: vec![],
            sampling_mode: SamplingMode::Scatter,
        };

        let yaml = serde_yaml::to_string(&base).unwrap();
        let mp: MeasuredPoints = serde_yaml::from_str(&yaml).unwrap();
        assert_eq!(mp.sampling_mode, SamplingMode::Scatter);
    }
}
