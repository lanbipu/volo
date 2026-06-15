//! LED Mesh Toolkit core library.
//!
//! Defines the Intermediate Representation (IR) and shared
//! reconstruction / UV / export pipeline used by both M1
//! (total-station) and M2 (visual photogrammetry) adapters.

pub mod coordinate;
pub mod error;
pub mod export;
pub mod measured_points;
pub mod point;
pub mod reconstruct;
pub mod sampling;
pub mod shape;
pub mod surface;
pub mod triangulate;
pub mod uncertainty;
pub mod uv;
pub mod weld;

pub use error::CoreError;

#[cfg(test)]
pub mod test_support {
    use crate::coordinate::CoordinateFrame;
    use crate::measured_points::MeasuredPoints;
    use crate::sampling::SamplingMode;
    use crate::shape::{CabinetArray, ShapePrior};

    /// 最小 scatter MeasuredPoints：空点集、identity frame、4x2 平面屏。
    pub fn minimal_scatter_points() -> MeasuredPoints {
        MeasuredPoints {
            screen_id: "MAIN".into(),
            coordinate_frame: CoordinateFrame {
                origin_world: [0.0, 0.0, 0.0],
                basis: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
            },
            cabinet_array: CabinetArray::rectangle(4, 2, [500.0, 500.0]),
            shape_prior: ShapePrior::Flat,
            points: vec![],
            sampling_mode: SamplingMode::Scatter,
        }
    }
}
