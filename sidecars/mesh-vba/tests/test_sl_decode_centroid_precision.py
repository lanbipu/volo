"""Synthetic sub-pixel precision tests for the dot-center estimator (_seed_dots).

These tests render dots at KNOWN sub-pixel centers, then measure how well the
center-finding code path (sl_decode._seed_dots) recovers those centers. They call
the seeding code DIRECTLY (NOT full decode), because run_decode rounds each seed
to integer pixels in _read_bits_relative -- which would erase exactly the
sub-pixel gain this change is about.

Coordinate convention (must stay self-consistent):
  cv2.connectedComponentsWithStats returns a centroid in pixel-INDEX coordinates
  (a single pixel at column c, row r has centroid (c, r)). A dot rendered as
  I[r, c] = A * exp(-((c-cx)^2 + (r-cy)^2) / (2 sigma^2)) therefore has its
  intensity-weighted centroid at exactly (cx, cy) in the SAME coordinate frame,
  so "recovered centroid" and "truth" are directly comparable with no half-pixel
  fudge.

`_binary_ref_seeds` reproduces the PRE-CHANGE _seed_dots (Otsu + connected
components + the same shape filters, geometric centroid of the binary mask). It
is the yardstick the weighted estimator must beat -- a permanent regression guard
against silently reverting to the binary centroid.
"""
from __future__ import annotations

import cv2
import numpy as np
import pytest

from lmt_vba_sidecar.sl_decode import _seed_dots


# --------------------------------------------------------------------------- #
# Rendering helpers
# --------------------------------------------------------------------------- #
def _gaussian_field(h: int, w: int, centers, sigma: float, amplitude: float,
                    cov: np.ndarray | None = None) -> np.ndarray:
    """Sum of analytic Gaussian dots on a float canvas. With `cov` (a 2x2
    covariance) the dots are anisotropic/sheared (oblique view) -- the centroid
    of a Gaussian is its mean for ANY positive-definite covariance, so the truth
    center stays (cx, cy)."""
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float64)
    field = np.zeros((h, w), np.float64)
    inv = None if cov is None else np.linalg.inv(cov)
    for (cx, cy) in centers:
        dx, dy = xs - cx, ys - cy
        if inv is None:
            q = (dx * dx + dy * dy) / (sigma * sigma)
        else:
            q = inv[0, 0] * dx * dx + 2 * inv[0, 1] * dx * dy + inv[1, 1] * dy * dy
        field += amplitude * np.exp(-0.5 * q)
    return field


def _to_u8(field: np.ndarray) -> np.ndarray:
    return np.clip(field, 0, 255).astype(np.uint8)


def _grid_centers(rows: int, cols: int, x0: float, y0: float, spacing: float,
                  seed: int):
    """Grid of dot centers whose sub-pixel fractional offsets are varied (a fixed
    RNG), so the binary-centroid quantization bias is exercised at many phases,
    not just the symmetric (.0/.5) ones where it nearly vanishes."""
    rng = np.random.default_rng(seed)
    centers = []
    for gy in range(rows):
        for gx in range(cols):
            fx, fy = rng.uniform(0.0, 1.0), rng.uniform(0.0, 1.0)
            centers.append((x0 + gx * spacing + fx, y0 + gy * spacing + fy))
    return centers


# --------------------------------------------------------------------------- #
# Baseline (pre-change binary centroid) -- the yardstick to beat
# --------------------------------------------------------------------------- #
def _binary_ref_seeds(anchor: np.ndarray, *, roi, dot_radius_px: int):
    """Exact reproduction of the PRE-CHANGE _seed_dots: Otsu + connected
    components + shape filters, returning the GEOMETRIC centroid of each binary
    blob. The reference the weighted estimator must strictly beat."""
    x, y, w, h = roi
    crop = anchor[y:y + h, x:x + w]
    _t, bw = cv2.threshold(crop, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    n, _lbl, stats, cent = cv2.connectedComponentsWithStats(bw, connectivity=8)
    r = float(dot_radius_px)
    area_lo, area_hi = 0.25 * np.pi * r * r, 9.0 * np.pi * r * r
    side_hi = 6.0 * r
    out = []
    for i in range(1, n):
        cw, ch, area = int(stats[i][2]), int(stats[i][3]), int(stats[i][4])
        if not (area_lo <= area <= area_hi):
            continue
        if cw > side_hi or ch > side_hi:
            continue
        out.append((float(cent[i][0]) + x, float(cent[i][1]) + y))
    return out


# --------------------------------------------------------------------------- #
# Measurement
# --------------------------------------------------------------------------- #
def _match_errors(truth, seeds):
    """For each truth center, the distance to the nearest returned seed. Dots are
    well-separated, so nearest-neighbour matching is unambiguous."""
    if not seeds:
        return np.array([np.inf] * len(truth))
    s = np.array(seeds, dtype=np.float64)
    errs = []
    for (cx, cy) in truth:
        d = np.hypot(s[:, 0] - cx, s[:, 1] - cy)
        errs.append(float(d.min()))
    return np.array(errs)


def _measure(anchor, truth, *, roi, dot_radius_px):
    """Return (binary_errs, weighted_errs, n_binary, n_weighted)."""
    binary = _binary_ref_seeds(anchor, roi=roi, dot_radius_px=dot_radius_px)
    weighted = _seed_dots(anchor, roi=roi, dot_radius_px=dot_radius_px)
    return (_match_errors(truth, binary), _match_errors(truth, weighted),
            len(binary), len(weighted))


# --------------------------------------------------------------------------- #
# Tests
# --------------------------------------------------------------------------- #
def test_weighted_centroid_beats_binary_single_dot_clean():
    # One dot at a deliberately off-grid sub-pixel center; mild camera blur.
    cx, cy, sigma = 70.3, 60.7, 3.0
    field = _gaussian_field(120, 140, [(cx, cy)], sigma, 255.0)
    anchor = _to_u8(field)
    roi = (0, 0, 140, 120)
    b_err, w_err, nb, nw = _measure(anchor, [(cx, cy)], roi=roi, dot_radius_px=6)
    print(f"\n[single clean] binary={b_err[0]:.4f}px  weighted={w_err[0]:.4f}px")
    assert nb == 1 and nw == 1
    assert w_err[0] < b_err[0]                 # strictly more accurate
    assert w_err[0] < 0.10                     # sub-0.1px absolute on clean


def test_weighted_centroid_beats_binary_grid_clean():
    rows, cols, spacing = 5, 6, 34
    centers = _grid_centers(rows, cols, 25.0, 25.0, spacing, seed=3)
    w = int(25 + cols * spacing + 25)
    h = int(25 + rows * spacing + 25)
    anchor = _to_u8(_gaussian_field(h, w, centers, 3.0, 255.0))
    roi = (0, 0, w, h)
    b, wt, nb, nw = _measure(anchor, centers, roi=roi, dot_radius_px=6)
    print(f"\n[grid clean] binary mean={b.mean():.4f} max={b.max():.4f} | "
          f"weighted mean={wt.mean():.4f} max={wt.max():.4f}  (n={nw}/{len(centers)})")
    assert nb == len(centers) and nw == len(centers)      # detection unchanged
    assert wt.mean() < 0.5 * b.mean()                     # >=2x better on average
    assert wt.max() < b.max()                             # and worst-case better
    assert wt.mean() < 0.05


def _grid_anchor(extra_bg=0.0, halo_amp=0.0, halo_sigma=18.0, cov=None,
                 noise=0.0, gradient=0.0, sigma=3.0, seed=3):
    rows, cols, spacing = 5, 6, 34
    centers = _grid_centers(rows, cols, 25.0, 25.0, spacing, seed=seed)
    w = int(25 + cols * spacing + 25)
    h = int(25 + rows * spacing + 25)
    field = _gaussian_field(h, w, centers, sigma, 255.0, cov=cov)
    if halo_amp > 0.0:
        field += _gaussian_field(h, w, centers, halo_sigma, halo_amp)
    field += extra_bg
    if gradient > 0.0:
        ramp = np.linspace(0.0, gradient, w)[None, :] * np.ones((h, 1))
        field += ramp
    if noise > 0.0:
        rng = np.random.default_rng(seed + 100)
        field += rng.normal(0.0, noise, size=field.shape)
    return _to_u8(field), centers, (0, 0, w, h)


def test_weighted_centroid_robust_under_bloom():
    # Flooding: each dot carries a localized glare skirt (~3x the dot sigma) plus
    # ambient DC. The binary Otsu cut wanders on the soft skirt; local-background-
    # subtracted weighting should not be worse, and stay well sub-pixel. The skirt
    # is kept local (sigma 9 << 34px spacing) so dots stay separable -- a wide
    # halo would bridge the gaps into one blob, which is a detection problem, not
    # a centroid one.
    anchor, centers, roi = _grid_anchor(extra_bg=30.0, halo_amp=70.0, halo_sigma=9.0)
    b, wt, nb, nw = _measure(anchor, centers, roi=roi, dot_radius_px=6)
    print(f"\n[bloom] binary mean={b.mean():.4f} max={b.max():.4f} | "
          f"weighted mean={wt.mean():.4f} max={wt.max():.4f}  (n={nw}/{len(centers)})")
    assert nw == len(centers)
    assert wt.mean() <= b.mean()
    assert wt.mean() < 0.30                  # no blow-up; still sub-pixel


def test_weighted_centroid_robust_under_oblique():
    # Oblique view: anisotropic, sheared dots (elongated ellipse). Truth center
    # is unchanged (Gaussian mean), but the binary disk centroid skews.
    cov = np.array([[16.0, 7.0], [7.0, 9.0]])     # positive-definite, sheared
    anchor, centers, roi = _grid_anchor(cov=cov)
    b, wt, nb, nw = _measure(anchor, centers, roi=roi, dot_radius_px=7)
    print(f"\n[oblique] binary mean={b.mean():.4f} max={b.max():.4f} | "
          f"weighted mean={wt.mean():.4f} max={wt.max():.4f}  (n={nw}/{len(centers)})")
    assert nw == len(centers)
    assert wt.mean() < b.mean()              # weighting wins on skewed shapes
    assert wt.mean() < 0.25


def test_weighted_centroid_robust_under_exposure_offset():
    # Exposure / ambient offset: strong DC pedestal, reduced contrast. Weighting
    # must be offset-invariant after local background subtraction.
    anchor, centers, roi = _grid_anchor(extra_bg=80.0)
    b, wt, nb, nw = _measure(anchor, centers, roi=roi, dot_radius_px=6)
    print(f"\n[exposure] binary mean={b.mean():.4f} max={b.max():.4f} | "
          f"weighted mean={wt.mean():.4f} max={wt.max():.4f}  (n={nw}/{len(centers)})")
    assert nw == len(centers)
    assert wt.mean() < 0.5 * b.mean()
    assert wt.mean() < 0.05


def test_weighted_centroid_robust_under_sensor_noise():
    # Read noise. Averaged over the grid the weighted estimator must stay both
    # better than binary and well sub-pixel.
    anchor, centers, roi = _grid_anchor(extra_bg=20.0, noise=6.0)
    b, wt, nb, nw = _measure(anchor, centers, roi=roi, dot_radius_px=6)
    print(f"\n[noise] binary mean={b.mean():.4f} max={b.max():.4f} | "
          f"weighted mean={wt.mean():.4f} max={wt.max():.4f}  (n={nw}/{len(centers)})")
    assert nw == len(centers)
    assert wt.mean() < b.mean()
    assert wt.mean() < 0.30


def test_weighted_centroid_robust_under_defocus():
    # Heavy virtual-focus blur (large PSF). The binary cut snaps to the grid more
    # as the edge softens; weighting tracks the true center.
    anchor, centers, roi = _grid_anchor(sigma=5.0)
    b, wt, nb, nw = _measure(anchor, centers, roi=roi, dot_radius_px=8)
    print(f"\n[defocus] binary mean={b.mean():.4f} max={b.max():.4f} | "
          f"weighted mean={wt.mean():.4f} max={wt.max():.4f}  (n={nw}/{len(centers)})")
    assert nw == len(centers)
    assert wt.mean() < 0.5 * b.mean()
    assert wt.mean() < 0.05


def test_weighted_centroid_robust_under_illumination_gradient():
    # A linear illumination ramp across the screen (vignetting / off-axis LED
    # falloff): every dot sits on a different background level. The local
    # background subtraction (median of each dot's window border ring) must absorb
    # the pedestal so the weighted centroid still beats the binary one -- the part
    # of the algorithm most sensitive to non-uniform illumination.
    anchor, centers, roi = _grid_anchor(extra_bg=20.0, gradient=40.0)
    b, wt, nb, nw = _measure(anchor, centers, roi=roi, dot_radius_px=6)
    print(f"\n[gradient] binary mean={b.mean():.4f} max={b.max():.4f} | "
          f"weighted mean={wt.mean():.4f} max={wt.max():.4f}  (n={nw}/{len(centers)})")
    assert nw == len(centers)
    assert wt.mean() < b.mean()           # gradient handled, still beats binary
    assert wt.mean() < 0.10


@pytest.mark.parametrize("r", [6, 8, 12])
def test_no_regression_vs_binary_at_floor_spacing_under_defocus(r):
    # The neighbour-skirt trap (found by adversarial review + Codex + a max-effort
    # review). At the GENERATION floor dot spacing (4*r+2, the tightest the
    # auto-layout emits) under strong camera defocus (PSF sigma ~ dot radius), Otsu
    # still separates all dots but a generous weighting window reaches into a
    # NEIGHBOUR's soft sub-threshold skirt and drags the centroid toward it --
    # regressing BELOW the binary baseline exactly in the defocus/dense regime this
    # change is meant to help. The estimator keeps its support tight (core dilated
    # by min(r/2, 3)) so the neighbour's skirt can't dominate. This is swept over
    # the dot radius because a support that scaled with r (uncapped r/2) passed at
    # r=6 but regressed for larger dots (r>=8) -- the cap must hold across sizes.
    # (PSF sigma = r is one notch inside the detection-merge limit; below the
    # 4*r+2 floor an explicit sub-floor --dot-spacing override is needed, which
    # already breaks detection independently.)
    rows, cols = 5, 6
    spacing = 4 * r + 2                 # generation floor spacing
    margin = 4 * r                      # keep every dot clear of the ROI edge
    centers = _grid_centers(rows, cols, float(margin), float(margin), spacing, seed=3)
    w = int(margin + cols * spacing + margin)
    h = int(margin + rows * spacing + margin)
    anchor = _to_u8(_gaussian_field(h, w, centers, float(r), 255.0))   # PSF sigma = r
    roi = (0, 0, w, h)
    b, wt, nb, nw = _measure(anchor, centers, roi=roi, dot_radius_px=r)
    print(f"\n[floor+defocus r={r}] binary mean={b.mean():.4f} max={b.max():.4f} | "
          f"weighted mean={wt.mean():.4f} max={wt.max():.4f}  (n={nw}/{len(centers)})")
    assert nb == len(centers) and nw == len(centers)
    assert wt.mean() <= b.mean()          # must NOT regress below the binary baseline
    assert wt.mean() < 0.20               # and stay sub-pixel


def test_no_regression_vs_binary_at_roi_edge():
    # Perimeter dots (found by max review). When the derived screen ROI hugs the
    # dot pattern, the outermost dots sit within the support radius of the ROI
    # edge, so the weighting window clamps and truncates their skirt on one side --
    # biasing the weighted centroid INWARD, below the binary baseline. The edge
    # guard hands those boundary dots to the unbiased binary centroid, so the
    # result never regresses there. Here the whole grid is pushed against the ROI
    # with margin (3) < pad (= r = 6), forcing the entire perimeter ring to clip.
    r, spacing, margin = 6, 30, 3
    centers = _grid_centers(5, 6, float(margin), float(margin), spacing, seed=3)
    w = int(margin + 6 * spacing + margin)
    h = int(margin + 5 * spacing + margin)
    anchor = _to_u8(_gaussian_field(h, w, centers, 3.0, 255.0))
    roi = (0, 0, w, h)
    b, wt, nb, nw = _measure(anchor, centers, roi=roi, dot_radius_px=r)
    print(f"\n[roi-edge] binary mean={b.mean():.4f} max={b.max():.4f} | "
          f"weighted mean={wt.mean():.4f} max={wt.max():.4f}  (n={nw}/{len(centers)})")
    assert nb == len(centers) and nw == len(centers)
    assert wt.mean() <= b.mean()           # perimeter ring must not regress
    assert wt.max() <= b.max() + 1e-6      # worst boundary dot falls back to binary


def test_seed_count_and_sub_pixel_displacement_only():
    # The change touches ONLY the centroid math, not detection: binary and
    # weighted return the SAME number of dots, and weighting merely NUDGES each
    # center sub-pixel (< 1px) rather than relocating it onto a different dot --
    # so it can never change which dot is which. (Whether the decoded id SET is
    # preserved on real material is guarded by the roundtrip tests in
    # test_sl_decode.py; weighting can legitimately round a seed to a different --
    # and more correct -- integer pixel than the binary centroid would.)
    anchor, centers, roi = _grid_anchor(extra_bg=20.0, halo_amp=50.0, halo_sigma=8.0)
    binary = _binary_ref_seeds(anchor, roi=roi, dot_radius_px=6)
    weighted = _seed_dots(anchor, roi=roi, dot_radius_px=6)
    assert len(weighted) == len(binary) == len(centers)   # detection unchanged
    b = np.array(binary)
    for (wx, wy) in weighted:
        d = np.hypot(b[:, 0] - wx, b[:, 1] - wy)
        assert float(d.min()) < 1.0                       # sub-pixel nudge only
