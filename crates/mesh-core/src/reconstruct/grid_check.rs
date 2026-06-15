//! FIX-12 ④: grid-path sanity helpers shared by the grid reconstructors.
//!
//! Every grid edge connects two corners of the SAME cabinet face, so its
//! expected length equals the cabinet dimension exactly — independent of
//! curvature or folds (the edge lies within one flat cabinet). That hard
//! constraint detects gross measurement outliers that the old metrics
//! (input-σ summaries) could never see.

use nalgebra::Vector3;

use crate::measured_points::MeasuredPoints;
use crate::shape::CabinetArray;
use crate::surface::GridTopology;

/// Edge-length deviation (mm) beyond which a grid edge is flagged.
/// Well above survey noise (~1–2 mm) and pitch rounding, well below a
/// mis-shot point (tens of mm).
pub const GRID_SPACING_TOL_MM: f64 = 20.0;

/// Check all grid edges against the cabinet dimensions.
///
/// Returns `(outlier_vertex_names, warnings)`:
/// - a vertex is reported as an outlier when ≥2 of its incident edges (or
///   all of them, for 2-edge corner vertices) deviate by more than
///   [`GRID_SPACING_TOL_MM`] — single bad edges are ambiguous between their
///   two endpoints and are surfaced as warnings only;
/// - every deviating edge produces one warning naming both endpoints.
///
/// Vertices are in meters; cabinet sizes in mm.
pub fn spacing_outliers(
    vertices: &[Vector3<f64>],
    topo: GridTopology,
    cabinet_array: &CabinetArray,
    screen_id: &str,
) -> (Vec<String>, Vec<String>) {
    let cols = topo.cols;
    let rows = topo.rows;
    let exp_w_m = cabinet_array.cabinet_size_mm[0] / 1000.0;
    let exp_h_m = cabinet_array.cabinet_size_mm[1] / 1000.0;

    let name = |c: u32, r: u32| format!("{}_V{:03}_R{:03}", screen_id, c + 1, r + 1);

    let mut warnings = Vec::new();
    // count of deviating incident edges + total incident edges, per vertex
    let mut bad = vec![0u32; topo.vertex_count()];
    let mut deg = vec![0u32; topo.vertex_count()];

    let mut check_edge = |c0: u32, r0: u32, c1: u32, r1: u32, expected_m: f64| {
        let i0 = topo.vertex_index(c0, r0);
        let i1 = topo.vertex_index(c1, r1);
        deg[i0] += 1;
        deg[i1] += 1;
        let len_m = (vertices[i1] - vertices[i0]).norm();
        let dev_mm = (len_m - expected_m).abs() * 1000.0;
        if dev_mm > GRID_SPACING_TOL_MM {
            bad[i0] += 1;
            bad[i1] += 1;
            warnings.push(format!(
                "grid edge {}–{} length {:.1}mm deviates {:.1}mm from cabinet size {:.1}mm (>{}mm)",
                name(c0, r0),
                name(c1, r1),
                len_m * 1000.0,
                dev_mm,
                expected_m * 1000.0,
                GRID_SPACING_TOL_MM
            ));
        }
    };

    for r in 0..=rows {
        for c in 0..cols {
            check_edge(c, r, c + 1, r, exp_w_m);
        }
    }
    for r in 0..rows {
        for c in 0..=cols {
            check_edge(c, r, c, r + 1, exp_h_m);
        }
    }

    let mut outliers = Vec::new();
    for r in 0..=rows {
        for c in 0..=cols {
            let i = topo.vertex_index(c, r);
            if bad[i] >= 2 || (bad[i] > 0 && bad[i] == deg[i]) {
                outliers.push(name(c, r));
            }
        }
    }
    (outliers, warnings)
}

/// Residuals (mm) of named in-grid measured points against the reconstructed
/// grid: for each measured point parseable as `<screen>_V<col>_R<row>`
/// (1-based) inside the grid and NOT excluded by `skip(col0, row0)`, the
/// distance to the corresponding reconstructed vertex.
///
/// `skip` excludes points the reconstructor reproduces exactly by
/// construction (anchors) — including them would dilute the statistics
/// toward a fake 0.
pub fn grid_residuals_mm(
    points: &MeasuredPoints,
    vertices: &[Vector3<f64>],
    topo: GridTopology,
    skip: impl Fn(u32, u32) -> bool,
) -> Vec<(String, f64)> {
    let prefix = format!("{}_V", points.screen_id);
    let mut out = Vec::new();
    for p in &points.points {
        let Some(rest) = p.name.strip_prefix(&prefix) else {
            continue;
        };
        let parts: Vec<&str> = rest.split("_R").collect();
        if parts.len() != 2 {
            continue;
        }
        let (Ok(col1), Ok(row1)) = (parts[0].parse::<u32>(), parts[1].parse::<u32>()) else {
            continue;
        };
        if col1 == 0 || row1 == 0 {
            continue;
        }
        let (col, row) = (col1 - 1, row1 - 1);
        if col > topo.cols || row > topo.rows || skip(col, row) {
            continue;
        }
        let dev_mm = (p.position - vertices[topo.vertex_index(col, row)]).norm() * 1000.0;
        out.push((p.name.clone(), dev_mm));
    }
    out
}

/// `(rms, p95)` of a residual sample; `None` for an empty sample.
/// p95 = nearest-rank percentile (ceil(0.95·n) − 1 after sort).
pub fn residual_stats_mm(residuals_mm: &[f64]) -> Option<(f64, f64)> {
    if residuals_mm.is_empty() {
        return None;
    }
    let n = residuals_mm.len();
    let rms = (residuals_mm.iter().map(|d| d * d).sum::<f64>() / n as f64).sqrt();
    let mut sorted: Vec<f64> = residuals_mm.to_vec();
    sorted.sort_by(|a, b| a.total_cmp(b));
    let idx = ((0.95 * n as f64).ceil() as usize).clamp(1, n) - 1;
    Some((rms, sorted[idx]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shape::CabinetArray;

    fn flat_grid(cols: u32, rows: u32, cab_m: f64) -> Vec<Vector3<f64>> {
        let mut v = Vec::new();
        for r in 0..=rows {
            for c in 0..=cols {
                v.push(Vector3::new(c as f64 * cab_m, r as f64 * cab_m, 0.0));
            }
        }
        v
    }

    #[test]
    fn clean_grid_has_no_outliers() {
        let topo = GridTopology { cols: 4, rows: 2 };
        let v = flat_grid(4, 2, 0.5);
        let cab = CabinetArray::rectangle(4, 2, [500.0, 500.0]);
        let (outliers, warnings) = spacing_outliers(&v, topo, &cab, "MAIN");
        assert!(outliers.is_empty(), "{outliers:?}");
        assert!(warnings.is_empty(), "{warnings:?}");
    }

    #[test]
    fn single_50mm_outlier_is_flagged_with_warnings() {
        let topo = GridTopology { cols: 4, rows: 2 };
        let mut v = flat_grid(4, 2, 0.5);
        // displace interior vertex (col=2,row=1) by 50mm along x
        let i = topo.vertex_index(2, 1);
        v[i].x += 0.050;
        let cab = CabinetArray::rectangle(4, 2, [500.0, 500.0]);
        let (outliers, warnings) = spacing_outliers(&v, topo, &cab, "MAIN");
        assert_eq!(outliers, vec!["MAIN_V003_R002".to_string()]);
        assert!(!warnings.is_empty());
    }

    #[test]
    fn residual_stats_p95_and_rms() {
        let r: Vec<f64> = (1..=20).map(|i| i as f64).collect();
        let (rms, p95) = residual_stats_mm(&r).unwrap();
        assert!((p95 - 19.0).abs() < 1e-9, "p95={p95}");
        assert!(rms > 11.0 && rms < 13.0, "rms={rms}");
        assert!(residual_stats_mm(&[]).is_none());
    }
}
