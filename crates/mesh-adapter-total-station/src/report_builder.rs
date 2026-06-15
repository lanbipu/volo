use std::collections::HashSet;

use crate::geometric_naming::NameOutcome;
use crate::project::ScreenConfig;
use crate::report::{AmbiguousMatch, MissingPoint, OutlierPoint, ScreenReport};
use crate::shape_grid::expected_grid_positions;

use mesh_core::measured_points::MeasuredPoints;

/// Sigma threshold (mm) used to separate measured vs fabricated points.
/// Direct total-station measurements carry ~2mm sigma; bottom-occlusion
/// fallback rows carry ~10mm. Anything above this threshold is treated
/// as fabricated regardless of the `PointSource` variant or `Uncertainty`
/// shape — the heuristic uses `sigma_approx()` so it covers `Isotropic`
/// and `Covariance3x3` uniformly.
const FABRICATED_SIGMA_THRESHOLD_MM: f64 = 5.0;

pub fn build_screen_report(
    screen_id: &str,
    mp: &MeasuredPoints,
    outcome: &NameOutcome,
    cfg: &ScreenConfig,
) -> ScreenReport {
    // Compute expected names.
    let expected = expected_grid_positions(screen_id, cfg).unwrap_or_default();
    let expected_count = expected.len();
    let expected_names: HashSet<String> = expected.iter().map(|g| g.name.clone()).collect();

    // Count measured vs fabricated using a uniform sigma heuristic. Track
    // any non-finite sigmas so the RMS guard can warn instead of pretending
    // the screen has perfect uncertainty.
    let mut measured_count = 0usize;
    let mut fabricated_count = 0usize;
    let mut non_finite_sigma_count = 0usize;
    let mut present_names: HashSet<String> = HashSet::new();
    for p in &mp.points {
        present_names.insert(p.name.clone());
        let sigma = p.uncertainty.sigma_approx();
        if !sigma.is_finite() {
            non_finite_sigma_count += 1;
            measured_count += 1; // count somewhere, flagged via warning
        } else if sigma > FABRICATED_SIGMA_THRESHOLD_MM {
            fabricated_count += 1;
        } else {
            measured_count += 1;
        }
    }

    let missing: Vec<MissingPoint> = expected_names
        .difference(&present_names)
        .map(|n| MissingPoint { name: n.clone() })
        .collect();

    let outliers: Vec<OutlierPoint> = outcome
        .outliers
        .iter()
        .map(|o| OutlierPoint {
            instrument_id: o.instrument_id,
            distance_to_nearest_mm: o.distance_m * 1000.0,
            nearest_grid_name: o.nearest_grid_name.clone(),
        })
        .collect();

    let ambiguous: Vec<AmbiguousMatch> = outcome
        .ambiguous
        .iter()
        .map(|a| AmbiguousMatch {
            instrument_id: a.instrument_id,
            candidates: a.candidates.clone(),
        })
        .collect();

    let mut warnings: Vec<String> = Vec::new();
    if !outcome.outliers.is_empty() {
        warnings.push(format!(
            "{} outlier point(s) — possibly stray markers or wrong screen",
            outcome.outliers.len()
        ));
    }
    if fabricated_count > 0 {
        warnings.push(format!(
            "{fabricated_count} bottom-row vertices fabricated via vertical fallback; \
             accuracy ±5-15mm in fallback region"
        ));
    }
    if missing.len() > expected_count / 2 {
        warnings.push(format!(
            "Less than half the grid is populated ({}/{}); reconstruction may be unreliable",
            present_names.len(),
            expected_count
        ));
    }
    if non_finite_sigma_count > 0 {
        warnings.push(format!(
            "{non_finite_sigma_count} point(s) have non-finite uncertainty — \
             estimated_rms_mm reflects only finite sigmas; investigate input data"
        ));
    }

    // Estimated RMS aggregates finite sigma_approx values only. Non-finite
    // sigmas are surfaced as a warning above so a zero/conservative RMS
    // doesn't masquerade as perfect quality.
    let estimated_rms_mm = {
        let finite_sigmas: Vec<f64> = mp
            .points
            .iter()
            .map(|p| p.uncertainty.sigma_approx())
            .filter(|s| s.is_finite())
            .collect();
        if finite_sigmas.is_empty() {
            0.0
        } else {
            let n = finite_sigmas.len() as f64;
            let sum_sq: f64 = finite_sigmas.iter().map(|s| s * s).sum();
            (sum_sq / n).sqrt()
        }
    };

    ScreenReport {
        screen_id: screen_id.to_string(),
        expected_count,
        measured_count,
        fabricated_count,
        missing,
        outliers,
        ambiguous,
        warnings,
        estimated_rms_mm,
    }
}
