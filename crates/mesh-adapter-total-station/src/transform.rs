use nalgebra::Vector3;

use mesh_core::coordinate::CoordinateFrame;

use crate::raw_point::RawPoint;

/// Apply `frame.world_to_model` (with mm→m conversion) to every raw point.
/// Returns `(instrument_id, model_position)` pairs in input order.
pub fn transform_to_model(raw: &[RawPoint], frame: &CoordinateFrame) -> Vec<(u32, Vector3<f64>)> {
    raw.iter()
        .map(|p| (p.instrument_id, frame.world_to_model(&p.position_meters())))
        .collect()
}
