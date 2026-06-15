use std::collections::HashMap;

use kiddo::float::distance::SquaredEuclidean;
use kiddo::float::kdtree::KdTree;
use nalgebra::Vector3;

use crate::shape_grid::GridExpected;

/// Per-screen tolerance configuration for matching raw points to
/// expected grid vertices.
pub struct NamingTolerances {
    /// Maximum distance (meters) from a raw point to its nearest expected
    /// grid position before the point is classified as an outlier.
    pub max_match_distance_m: f64,
    /// Distance (meters) within which a competing claim on the same grid
    /// vertex is reported as ambiguous instead of silently dropped.
    pub ambiguity_radius_m: f64,
}

impl Default for NamingTolerances {
    fn default() -> Self {
        Self {
            // 50mm — half a typical 100mm absent-cell margin; well above
            // total-station instrument noise (1-3mm) and below cabinet pitch (500mm).
            max_match_distance_m: 0.050,
            ambiguity_radius_m: 0.010, // 10mm
        }
    }
}

#[derive(Debug, Clone)]
pub struct OutlierEntry {
    pub instrument_id: u32,
    pub nearest_grid_name: String,
    pub distance_m: f64,
}

#[derive(Debug, Clone)]
pub struct AmbiguityEntry {
    pub instrument_id: u32,
    pub candidates: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct NameOutcome {
    pub matches: HashMap<u32, String>,
    pub outliers: Vec<OutlierEntry>,
    pub ambiguous: Vec<AmbiguityEntry>,
}

/// Match each transformed raw point (`instrument_id`, model-frame position)
/// to its nearest expected grid vertex via KD-tree nearest neighbor.
///
/// Reports outliers (no expected vertex within `max_match_distance_m`)
/// and ambiguities (two or more raw points claiming the same vertex
/// within `ambiguity_radius_m`).
pub fn name_points_geometrically(
    model_points: &[(u32, Vector3<f64>)],
    expected: &[GridExpected],
    tol: &NamingTolerances,
) -> NameOutcome {
    // Empty expected grid would panic inside `nearest_one` indexing; bail
    // out cleanly so a malformed screen can't crash the report pipeline.
    if expected.is_empty() {
        return NameOutcome::default();
    }

    let mut tree: KdTree<f64, u64, 3, 32, u32> = KdTree::new();
    for (i, ge) in expected.iter().enumerate() {
        tree.add(
            &[
                ge.model_position.x,
                ge.model_position.y,
                ge.model_position.z,
            ],
            i as u64,
        );
    }

    let max_sq = tol.max_match_distance_m * tol.max_match_distance_m;

    // Phase 1 — find each raw point's nearest expected vertex (or outlier).
    let mut tentative: Vec<(u32, usize, f64)> = Vec::new();
    let mut outliers: Vec<OutlierEntry> = Vec::new();

    for (id, pos) in model_points {
        let q = [pos.x, pos.y, pos.z];
        let nearest = tree.nearest_one::<SquaredEuclidean>(&q);
        let dist_m = nearest.distance.sqrt();
        if nearest.distance > max_sq {
            outliers.push(OutlierEntry {
                instrument_id: *id,
                nearest_grid_name: expected[nearest.item as usize].name.clone(),
                distance_m: dist_m,
            });
        } else {
            tentative.push((*id, nearest.item as usize, dist_m));
        }
    }

    // Phase 2 — resolve competing claims.
    let mut by_expected: HashMap<usize, Vec<(u32, f64)>> = HashMap::new();
    for (id, idx, d) in &tentative {
        by_expected.entry(*idx).or_default().push((*id, *d));
    }

    let mut matches: HashMap<u32, String> = HashMap::new();
    let mut ambiguous: Vec<AmbiguityEntry> = Vec::new();

    for (idx, mut claims) in by_expected {
        if claims.len() == 1 {
            matches.insert(claims[0].0, expected[idx].name.clone());
        } else {
            claims.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
            let winner = claims[0];
            matches.insert(winner.0, expected[idx].name.clone());
            // Runner-ups within ambiguity_radius_m of the same vertex are
            // reported as ambiguous; ones farther out are silently dropped
            // (winner is clearly closer — keeping them would mislead the
            // operator into thinking the dropped point was a real candidate).
            for runner_up in claims.iter().skip(1) {
                if runner_up.1 <= tol.ambiguity_radius_m {
                    ambiguous.push(AmbiguityEntry {
                        instrument_id: runner_up.0,
                        candidates: vec![expected[idx].name.clone()],
                    });
                }
            }
        }
    }

    NameOutcome {
        matches,
        outliers,
        ambiguous,
    }
}
