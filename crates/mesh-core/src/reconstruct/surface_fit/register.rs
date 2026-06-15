//! FIX-12 ②: place the KNOWN screen span over the measured scatter samples
//! instead of trusting the raw min/max extent.
//!
//! min/max is biased by measurement noise (inflates) and by missing edge
//! coverage (shrinks by whole cabinets). The screen's true span along each
//! surface parameter is known exactly (`cols × cabinet_w`, `rows × cabinet_h`),
//! so only its 1-D placement (a translation) needs estimating:
//!
//! 1. center the known span on the measured span (always well-defined);
//! 2. if the samples cluster on cabinet-pitch grid lines (operators shooting
//!    cabinet corners), lock the placement to the grid phase via the circular
//!    mean of `sample mod pitch` — the least-squares translation onto the
//!    nearest grid line. Low phase concentration (free-form samples) keeps
//!    the centered placement and reports `phase_locked = false`.

/// Register a known 1-D span onto samples. Returns `(lo, hi, phase_locked)`
/// with `hi - lo == known_span` exactly.
pub fn register_range_1d(
    samples: &[f64],
    pitch: f64,
    known_span: f64,
    raw_lo: f64,
    raw_hi: f64,
) -> (f64, f64, bool) {
    let centered = (raw_lo + raw_hi) / 2.0 - known_span / 2.0;
    if !(pitch > 0.0) || samples.is_empty() {
        return (centered, centered + known_span, false);
    }
    // Circular mean of sample phases modulo the cabinet pitch.
    let tau = std::f64::consts::TAU;
    let (mut s, mut c) = (0.0_f64, 0.0_f64);
    for &x in samples {
        let a = tau * (x / pitch);
        s += a.sin();
        c += a.cos();
    }
    let n = samples.len() as f64;
    let concentration = (s * s + c * c).sqrt() / n;
    if concentration < 0.5 {
        return (centered, centered + known_span, false);
    }
    let phase = s.atan2(c) / tau * pitch;
    // Snap the centered placement to the nearest phase-consistent grid line.
    let lo = phase + pitch * ((centered - phase) / pitch).round();
    (lo, lo + known_span, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn corner_samples_lock_phase_and_recover_exact_extent() {
        // grid corners at 0.5m pitch over a 4-cabinet (2.0m) screen, with the
        // outermost column (x=2.0) UNMEASURED — min/max would report 1.5m.
        let samples = [0.0, 0.5, 1.0, 1.5];
        let (lo, hi, locked) = register_range_1d(&samples, 0.5, 2.0, 0.0, 1.5);
        assert!(locked);
        assert!((hi - lo - 2.0).abs() < 1e-12);
        // placement lands on a grid line; size error vs known span is 0.
        assert!((lo / 0.5 - (lo / 0.5).round()).abs() < 1e-9, "lo={lo}");
    }

    #[test]
    fn noisy_corner_samples_still_lock() {
        let samples: Vec<f64> = (0..=4)
            .map(|i| i as f64 * 0.5 + if i % 2 == 0 { 0.003 } else { -0.002 })
            .collect();
        let (lo, hi, locked) = register_range_1d(&samples, 0.5, 2.0, 0.001, 2.003);
        assert!(locked);
        assert!((hi - lo - 2.0).abs() < 1e-12);
        assert!(lo.abs() < 0.01, "lo={lo}");
    }

    #[test]
    fn freeform_samples_fall_back_to_centering() {
        // incommensurate sample spacing → low phase concentration
        let samples: Vec<f64> = (0..40).map(|i| i as f64 * 0.0473).collect();
        let raw_lo = 0.0;
        let raw_hi = samples.last().copied().unwrap();
        let (lo, hi, locked) = register_range_1d(&samples, 0.5, 2.0, raw_lo, raw_hi);
        assert!(!locked);
        assert!((hi - lo - 2.0).abs() < 1e-12);
        let mid = (raw_lo + raw_hi) / 2.0;
        assert!(((lo + hi) / 2.0 - mid).abs() < 1e-12);
    }
}
