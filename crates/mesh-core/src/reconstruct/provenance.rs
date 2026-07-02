//! Per-vertex measurement provenance (M1 uncertainty-ledger fix).
//!
//! Classifies output vertices against the anchors that actually informed
//! them, in the reconstructor's own 2D parameter space (grid (col,row)
//! index space for grid reconstructors; registered (u,v) / (arc-length,h)
//! meters for the scatter path — see `surface_fit/mod.rs`). A non-anchor
//! vertex is `Extrapolated` when it falls outside the anchors' convex hull
//! OR farther than [`EXTRAPOLATION_THRESHOLD_MULTIPLIER`] × median
//! nearest-neighbor anchor spacing from the closest anchor; otherwise
//! `Interpolated`. Anchor positions themselves are `Measured` — callers
//! mark those directly, this module only classifies the rest.

use std::collections::HashSet;

use crate::surface::{GridTopology, VertexProvenance};

/// Default multiplier applied to the median nearest-neighbor anchor spacing
/// to get the "too far to trust" distance threshold. Exposed as a plain
/// constant (not a config field/DTO knob) — callers needing a different
/// value pass it directly to [`classify`]/[`classify_grid`]; no UI/CLI
/// surface asks for this yet, so a config plumbing would be speculative.
pub const EXTRAPOLATION_THRESHOLD_MULTIPLIER: f64 = 2.0;

/// Median nearest-neighbor spacing among `points`. `None` when fewer than
/// 2 points (spacing undefined).
pub fn median_nn_spacing(points: &[(f64, f64)]) -> Option<f64> {
    if points.len() < 2 {
        return None;
    }
    let mut nn: Vec<f64> = Vec::with_capacity(points.len());
    for (i, &(xi, yi)) in points.iter().enumerate() {
        let mut best = f64::INFINITY;
        for (j, &(xj, yj)) in points.iter().enumerate() {
            if i == j {
                continue;
            }
            let d = ((xi - xj).powi(2) + (yi - yj).powi(2)).sqrt();
            if d < best {
                best = d;
            }
        }
        nn.push(best);
    }
    nn.sort_by(|a, b| a.total_cmp(b));
    Some(nn[nn.len() / 2])
}

/// 2D convex hull (Andrew's monotone chain), CCW, no duplicate closing
/// point. Degenerates gracefully: <3 distinct points returns them as-is
/// (empty / a point / a segment).
pub fn convex_hull(points: &[(f64, f64)]) -> Vec<(f64, f64)> {
    let mut pts: Vec<(f64, f64)> = points.to_vec();
    pts.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.total_cmp(&b.1)));
    pts.dedup_by(|a, b| (a.0 - b.0).abs() < 1e-12 && (a.1 - b.1).abs() < 1e-12);
    if pts.len() < 3 {
        return pts;
    }
    let cross = |o: (f64, f64), a: (f64, f64), b: (f64, f64)| {
        (a.0 - o.0) * (b.1 - o.1) - (a.1 - o.1) * (b.0 - o.0)
    };
    let build = |pts: &[(f64, f64)]| -> Vec<(f64, f64)> {
        let mut hull: Vec<(f64, f64)> = Vec::new();
        for &p in pts {
            while hull.len() >= 2 && cross(hull[hull.len() - 2], hull[hull.len() - 1], p) <= 0.0 {
                hull.pop();
            }
            hull.push(p);
        }
        hull
    };
    let mut lower = build(&pts);
    pts.reverse();
    let mut upper = build(&pts);
    lower.pop();
    upper.pop();
    lower.extend(upper);
    lower
}

/// Point-in-(convex)-polygon, boundary inclusive. Handles degenerate hulls
/// (0/1/2 vertices) via exact-point / on-segment membership.
pub fn point_in_hull(hull: &[(f64, f64)], p: (f64, f64)) -> bool {
    match hull.len() {
        0 => false,
        1 => (hull[0].0 - p.0).abs() < 1e-9 && (hull[0].1 - p.1).abs() < 1e-9,
        2 => point_on_segment(hull[0], hull[1], p),
        _ => {
            let n = hull.len();
            let mut sign = 0.0_f64;
            for i in 0..n {
                let a = hull[i];
                let b = hull[(i + 1) % n];
                let cross = (b.0 - a.0) * (p.1 - a.1) - (b.1 - a.1) * (p.0 - a.0);
                if cross.abs() < 1e-9 {
                    continue; // on the edge's line — boundary-inclusive, defer to other edges
                }
                if sign == 0.0 {
                    sign = cross.signum();
                } else if cross.signum() != sign {
                    return false;
                }
            }
            true
        }
    }
}

fn point_on_segment(a: (f64, f64), b: (f64, f64), p: (f64, f64)) -> bool {
    let cross = (b.0 - a.0) * (p.1 - a.1) - (b.1 - a.1) * (p.0 - a.0);
    if cross.abs() > 1e-9 {
        return false;
    }
    let dot = (p.0 - a.0) * (b.0 - a.0) + (p.1 - a.1) * (b.1 - a.1);
    let len_sq = (b.0 - a.0).powi(2) + (b.1 - a.1).powi(2);
    dot >= -1e-9 && dot <= len_sq + 1e-9
}

fn nearest_distance(anchors: &[(f64, f64)], p: (f64, f64)) -> f64 {
    anchors
        .iter()
        .map(|&(ax, ay)| ((ax - p.0).powi(2) + (ay - p.1).powi(2)).sqrt())
        .fold(f64::INFINITY, f64::min)
}

/// Classify a single non-anchor query point against `anchors` (2D
/// parameter-space coordinates). `hull` must be `convex_hull(anchors)`
/// (passed in so callers classifying many query points don't recompute it
/// per call). `threshold` is typically
/// `EXTRAPOLATION_THRESHOLD_MULTIPLIER * median_nn_spacing(anchors)`;
/// pass `f64::INFINITY` to disable the distance criterion (hull-only).
pub fn classify(
    anchors: &[(f64, f64)],
    hull: &[(f64, f64)],
    threshold: f64,
    query: (f64, f64),
) -> VertexProvenance {
    if !point_in_hull(hull, query) {
        return VertexProvenance::Extrapolated;
    }
    if nearest_distance(anchors, query) > threshold {
        return VertexProvenance::Extrapolated;
    }
    VertexProvenance::Interpolated
}

/// Grid-topology convenience: classify every (col, row) vertex of `topo`
/// against integer-indexed `anchors` (exactly reproduced by the caller's
/// reconstructor ⇒ `Measured`; everything else via [`classify`] in
/// (col, row) parameter space, threshold = `multiplier` × median anchor
/// spacing). Output is row-major, aligned with `GridTopology::vertex_index`.
pub fn classify_grid(
    topo: GridTopology,
    anchors: &[(u32, u32)],
    multiplier: f64,
) -> Vec<VertexProvenance> {
    let anchor_set: HashSet<(u32, u32)> = anchors.iter().copied().collect();
    let anchors_f: Vec<(f64, f64)> = anchors.iter().map(|&(c, r)| (c as f64, r as f64)).collect();
    let hull = convex_hull(&anchors_f);
    let threshold = median_nn_spacing(&anchors_f)
        .map(|s| s * multiplier)
        .unwrap_or(f64::INFINITY);

    let mut out = Vec::with_capacity(topo.vertex_count());
    for r in 0..=topo.rows {
        for c in 0..=topo.cols {
            if anchor_set.contains(&(c, r)) {
                out.push(VertexProvenance::Measured);
            } else {
                out.push(classify(&anchors_f, &hull, threshold, (c as f64, r as f64)));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn median_nn_spacing_needs_two_points() {
        assert!(median_nn_spacing(&[]).is_none());
        assert!(median_nn_spacing(&[(0.0, 0.0)]).is_none());
        assert_eq!(median_nn_spacing(&[(0.0, 0.0), (3.0, 0.0)]), Some(3.0));
    }

    #[test]
    fn convex_hull_of_square_is_the_four_corners() {
        let pts = vec![(0.0, 0.0), (4.0, 0.0), (4.0, 2.0), (0.0, 2.0), (2.0, 1.0)];
        let hull = convex_hull(&pts);
        assert_eq!(hull.len(), 4, "{hull:?}");
        for corner in [(0.0, 0.0), (4.0, 0.0), (4.0, 2.0), (0.0, 2.0)] {
            assert!(hull.contains(&corner), "missing corner {corner:?} in {hull:?}");
        }
        assert!(!hull.contains(&(2.0, 1.0)), "interior point leaked into hull: {hull:?}");
    }

    #[test]
    fn point_in_hull_boundary_inclusive() {
        let hull = convex_hull(&[(0.0, 0.0), (4.0, 0.0), (4.0, 2.0), (0.0, 2.0)]);
        assert!(point_in_hull(&hull, (2.0, 1.0))); // interior
        assert!(point_in_hull(&hull, (0.0, 0.0))); // corner
        assert!(point_in_hull(&hull, (2.0, 0.0))); // edge midpoint
        assert!(!point_in_hull(&hull, (5.0, 1.0))); // outside
        assert!(!point_in_hull(&hull, (2.0, -1.0))); // outside
    }

    /// 4-corner-only anchors (nominal reconstructor's exact scenario) on a
    /// wide 60×10 grid: hull covers the whole rectangle (corners ARE the
    /// rectangle), so the distance criterion is what must fire — the
    /// center is far from every corner and must come back Extrapolated,
    /// while a vertex near a corner stays Interpolated.
    #[test]
    fn four_corner_anchors_flag_far_interior_as_extrapolated() {
        let topo = GridTopology { cols: 60, rows: 10 };
        let anchors = vec![(0, 0), (60, 0), (0, 10), (60, 10)];
        let prov = classify_grid(topo, &anchors, EXTRAPOLATION_THRESHOLD_MULTIPLIER);

        let center = prov[topo.vertex_index(30, 5)];
        assert_eq!(center, VertexProvenance::Extrapolated, "{center:?}");

        let near_corner = prov[topo.vertex_index(1, 1)];
        assert_eq!(near_corner, VertexProvenance::Interpolated, "{near_corner:?}");

        for &(c, r) in &anchors {
            assert_eq!(prov[topo.vertex_index(c, r)], VertexProvenance::Measured);
        }
    }

    /// Sparse corner-clustered anchors: the convex hull itself shrinks to a
    /// small region near the corners, so vertices anywhere near the middle
    /// of the wall fall OUTSIDE the hull — every one of them must be
    /// Extrapolated, exercising the hull criterion (not just the distance
    /// one).
    #[test]
    fn corner_clustered_anchors_leave_middle_outside_hull() {
        let topo = GridTopology { cols: 60, rows: 10 };
        // A couple of points near each corner, nothing in the middle.
        let anchors = vec![
            (0, 0), (1, 0), (0, 1),
            (60, 0), (59, 0), (60, 1),
            (0, 10), (1, 10), (0, 9),
            (60, 10), (59, 10), (60, 9),
        ];
        let prov = classify_grid(topo, &anchors, EXTRAPOLATION_THRESHOLD_MULTIPLIER);
        for r in 3..=7 {
            for c in 20..=40 {
                let p = prov[topo.vertex_index(c, r)];
                assert_eq!(
                    p,
                    VertexProvenance::Extrapolated,
                    "(c={c},r={r}) should be outside the corner-clustered hull, got {p:?}"
                );
            }
        }
    }
}
