use kiddo::float::distance::SquaredEuclidean;
use kiddo::float::kdtree::KdTree;
use nalgebra::Vector3;

/// Merge vertices that lie within `tolerance_m` of an earlier vertex.
///
/// Always operates in **model frame (meters)** — callers must run
/// welding *before* applying any target-software unit conversion.
///
/// **Panics** if `tolerance_m` is not finite or is negative.
///
/// Returns:
/// - `welded` — the deduplicated vertex list (in insertion order)
/// - `mapping` — for each input index, the index in `welded` it maps to
pub fn weld_vertices(vertices: &[Vector3<f64>], tolerance_m: f64) -> (Vec<Vector3<f64>>, Vec<u32>) {
    assert!(
        tolerance_m.is_finite(),
        "weld_vertices: tolerance_m must be finite, got {tolerance_m}"
    );
    assert!(
        tolerance_m >= 0.0,
        "weld_vertices: tolerance_m must be non-negative, got {tolerance_m}"
    );

    let mut welded: Vec<Vector3<f64>> = Vec::with_capacity(vertices.len());
    let mut mapping: Vec<u32> = Vec::with_capacity(vertices.len());
    let mut tree: KdTree<f64, u64, 3, 32, u32> = KdTree::new();
    let tol_sq = tolerance_m * tolerance_m;

    for v in vertices {
        let q: [f64; 3] = [v.x, v.y, v.z];

        // Guard: nearest_one panics on an empty tree.
        let dedup_to: Option<u32> = if welded.is_empty() {
            None
        } else {
            let nearest = tree.nearest_one::<SquaredEuclidean>(&q);
            if nearest.distance < tol_sq {
                Some(nearest.item as u32)
            } else {
                None
            }
        };

        if let Some(existing) = dedup_to {
            mapping.push(existing);
        } else {
            let new_id = welded.len() as u64;
            welded.push(*v);
            tree.add(&q, new_id);
            mapping.push(new_id as u32);
        }
    }

    (welded, mapping)
}
