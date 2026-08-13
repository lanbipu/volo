"""Structured-light-specific formal gates (SL spec §7.3), layered post-solve.

The shared fixed-observation kernel (``fixed_observation.py``) enforces the
fail-closed gates that apply to ANY single-observation solve — VP-QSP
included — at thresholds pinned for sparse coded-marker detections. Dense
structured-light correspondences warrant stricter bars; those SL-only bars
live here, evaluated AFTER ``solve_fixed_observation()`` succeeds, and are
recorded under ``result.qualification["sl_gates"]``. A miss downgrades the
artifact to informal (``qualification.passed=False`` + ``formal=False``): it
is still persisted for diagnosis but never promoted —
``write_fixed_observation_result`` refuses unqualified *formal* results only.

Threshold provenance: ``docs/calibrate/structured-light-fixed-calibration-spec.md``
§7.3. ``trustworthy`` = matched points passing the decoder's confidence floor
and (when measured) the per-point sigma ceiling; the centroid-sigma double
gate applies whenever the decoder measured temporal sigma (video captures) and
records not-applicable on single-anchor-frame decodes.
"""
from __future__ import annotations

from dataclasses import replace
from typing import Any

import cv2
import numpy as np

from vpcal.core.fixed_observation import (
    Correspondence,
    FixedObservationResult,
    SessionLens,
    _as_arrays,
    _per_screen_homography_rms,
    coverage_xy,
    edge_fraction,
    spatial_block_split,
)

SL_MIN_DECODED_TOTAL = 120
SL_MIN_DECODED_PER_SCREEN = 40
SL_MIN_TRUSTWORTHY_TOTAL = 100
SL_MIN_TRUSTWORTHY_PER_SCREEN = 32
SL_MIN_COVERAGE_XY = 0.40
# Re-pinned 0.30 → 0.20 by the 2026-08-13 margin sweep: under the kernel's
# radius convention (EDGE_RADIUS_FRACTION=0.35 × FULL image diagonal), a
# perfectly uniform full-frame spread on a 16:9 sensor tops out at ≈0.27 —
# the spec's 0.30 assumed a half-diagonal convention and is unattainable
# here. 0.20 still demands meaningfully wide framing (shared bar is 0.15).
SL_MIN_EDGE_FRACTION = 0.20
SL_MAX_RMS_PX = 1.5
SL_MAX_WITHHELD_RMS_PX = 1.5
SL_MAX_HOMOGRAPHY_RMS_PX = 0.75
# Trustworthy = a matched point the solver may lean on: decoder confidence at
# least SL_TRUSTWORTHY_MIN_CONFIDENCE and, when measured, centroid temporal
# jitter within SL_TRUSTWORTHY_MAX_SIGMA_PX. Unmeasured sigma (frames-dir
# decode) is neutral, not disqualifying.
SL_TRUSTWORTHY_MIN_CONFIDENCE = 0.5
SL_TRUSTWORTHY_MAX_SIGMA_PX = 0.5
# §7.3 centroid-sigma double gate; applied when the decoder measured sigma.
SL_MAX_SIGMA_MEDIAN_PX = 0.25
SL_MAX_SIGMA_P95_PX = 0.5


def _lens_K_dist(lens: SessionLens) -> tuple[np.ndarray, np.ndarray]:
    K = np.array(
        [[lens.fx, 0.0, lens.cx], [0.0, lens.fy, lens.cy], [0.0, 0.0, 1.0]],
        dtype=np.float64,
    )
    return K, np.asarray(lens.dist_coeffs, dtype=np.float64)


def _undistorted_homography(
    correspondences: list[Correspondence], lens: SessionLens
) -> dict[str, dict[str, Any]]:
    """Per-screen planar-consistency RMS on UNDISTORTED pixels.

    The kernel preflight runs homography on raw (distorted) pixels and can
    therefore only apply a soft ×4 gate; with the solved/known lens in hand
    the strict SL bar is fair to apply.
    """
    K, dist = _lens_K_dist(lens)
    pts = np.asarray([c.pixel_uv for c in correspondences], dtype=np.float64)
    und = cv2.undistortPoints(pts.reshape(-1, 1, 2), K, dist, P=K).reshape(-1, 2)
    undistorted = [
        replace(c, pixel_uv=(float(und[i, 0]), float(und[i, 1])))
        for i, c in enumerate(correspondences)
    ]
    return _per_screen_homography_rms(undistorted)


def _known_lens_withheld(
    correspondences: list[Correspondence], lens: SessionLens
) -> dict[str, Any] | None:
    """Spatial-block holdout for the extrinsics-only path.

    The joint path validates withheld points inside the kernel (pose+lens
    solved on the train blocks only); the known-lens kernel path does not.
    Re-solve the pose from the train blocks with the known lens, then measure
    holdout reprojection — the same generalization check, PnP flavor.
    """
    solve_idx, hold_idx = spatial_block_split(correspondences)
    if not hold_idx or len(solve_idx) < 6:
        return None
    world, pixels, labels = _as_arrays(correspondences)
    K, dist = _lens_K_dist(lens)
    ok, rvec, tvec = cv2.solvePnP(
        world[solve_idx], pixels[solve_idx], K, dist, flags=cv2.SOLVEPNP_ITERATIVE
    )
    if not ok:
        return None
    proj, _ = cv2.projectPoints(world[hold_idx], rvec, tvec, K, dist)
    sq = np.sum((proj.reshape(-1, 2) - pixels[hold_idx]) ** 2, axis=1)
    hold_labels = [labels[i] for i in hold_idx]
    by_screen: dict[str, dict[str, Any]] = {}
    for label in sorted(set(hold_labels)):
        mask = np.asarray([lb == label for lb in hold_labels])
        by_screen[label] = {
            "rms_px": float(np.sqrt(np.mean(sq[mask]))),
            "count": int(mask.sum()),
        }
    return {
        "rms_px": float(np.sqrt(np.mean(sq))),
        "count": len(hold_idx),
        "by_screen": by_screen,
    }


def evaluate_sl_gates(
    result: FixedObservationResult,
    correspondences: list[Correspondence],
    image_size: tuple[int, int],
    *,
    decoded_total: int,
    decoded_per_screen: dict[str, int],
    sigma_px: list[float | None] | None = None,
) -> dict[str, Any]:
    """Evaluate the SL spec §7.3 bars against a completed solve.

    ``sigma_px`` aligns 1:1 with ``correspondences`` (decoder centroid temporal
    jitter; None per point when unmeasured). Returns the same
    ``{"passed", "failed", "gates"}`` shape as the kernel's
    ``evaluate_observability_gates`` so consumers read one format.
    """
    _world, pixels, labels = _as_arrays(correspondences)
    matched_per_screen: dict[str, int] = {}
    for label in labels:
        matched_per_screen[label] = matched_per_screen.get(label, 0) + 1
    screens = set(matched_per_screen)

    sigmas = sigma_px if sigma_px is not None else [None] * len(correspondences)
    trustworthy_per_screen: dict[str, int] = {label: 0 for label in screens}
    for c, sig in zip(correspondences, sigmas):
        if c.quality < SL_TRUSTWORTHY_MIN_CONFIDENCE:
            continue
        if sig is not None and sig > SL_TRUSTWORTHY_MAX_SIGMA_PX:
            continue
        trustworthy_per_screen[c.screen_label] += 1
    trustworthy_total = sum(trustworthy_per_screen.values())

    measured = [float(s) for s in sigmas if s is not None]
    # The sigma double gate needs a measurement to judge; a frames-dir decode
    # (single anchor frame) carries none — recorded as not-applicable rather
    # than silently failed. corr.quality.sigma_source explains why upstream.
    sigma_median = float(np.median(measured)) if measured else None
    sigma_p95 = float(np.percentile(measured, 95)) if measured else None

    cov_x, cov_y = coverage_xy(pixels, image_size)
    edge = edge_fraction(
        pixels, image_size, cx=0.5 * image_size[0], cy=0.5 * image_size[1]
    )

    if result.solve_kind == "joint_single_observation":
        w_combined = result.validation.get("withheld_rms_px")
        w_by_screen = dict(result.validation.get("withheld_rms_by_screen") or {})
    else:
        wh = (
            None
            if result.session_lens is None
            else _known_lens_withheld(correspondences, result.session_lens)
        )
        w_combined = None if wh is None else wh["rms_px"]
        w_by_screen = {} if wh is None else wh["by_screen"]

    homography = (
        {}
        if result.session_lens is None
        else _undistorted_homography(correspondences, result.session_lens)
    )

    def _per_screen_below(per: dict[str, dict[str, Any]], limit: float) -> bool:
        # Every solved screen must be present AND under the bar — a screen
        # silently missing from the breakdown must not pass.
        return set(per) >= screens and all(
            float(d.get("rms_px", float("inf"))) < limit for d in per.values()
        )

    gates: dict[str, Any] = {
        "decoded_total": {
            "value": decoded_total,
            "threshold": SL_MIN_DECODED_TOTAL,
            "pass": decoded_total >= SL_MIN_DECODED_TOTAL,
        },
        "decoded_per_screen": {
            "value": decoded_per_screen,
            "threshold": SL_MIN_DECODED_PER_SCREEN,
            "pass": bool(decoded_per_screen)
            and all(v >= SL_MIN_DECODED_PER_SCREEN for v in decoded_per_screen.values()),
        },
        "trustworthy_total": {
            "value": trustworthy_total,
            "threshold": SL_MIN_TRUSTWORTHY_TOTAL,
            "pass": trustworthy_total >= SL_MIN_TRUSTWORTHY_TOTAL,
        },
        "trustworthy_per_screen": {
            "value": trustworthy_per_screen,
            "threshold": SL_MIN_TRUSTWORTHY_PER_SCREEN,
            "pass": bool(trustworthy_per_screen)
            and all(
                v >= SL_MIN_TRUSTWORTHY_PER_SCREEN
                for v in trustworthy_per_screen.values()
            ),
        },
        "sigma_median_px": {
            "value": sigma_median,
            "threshold": SL_MAX_SIGMA_MEDIAN_PX,
            "pass": sigma_median is None or sigma_median < SL_MAX_SIGMA_MEDIAN_PX,
        },
        "sigma_p95_px": {
            "value": sigma_p95,
            "threshold": SL_MAX_SIGMA_P95_PX,
            "pass": sigma_p95 is None or sigma_p95 < SL_MAX_SIGMA_P95_PX,
        },
        "coverage_xy": {
            "value": [cov_x, cov_y],
            "threshold": SL_MIN_COVERAGE_XY,
            "pass": cov_x >= SL_MIN_COVERAGE_XY and cov_y >= SL_MIN_COVERAGE_XY,
        },
        "edge_fraction": {
            "value": edge,
            "threshold": SL_MIN_EDGE_FRACTION,
            "pass": edge >= SL_MIN_EDGE_FRACTION,
        },
        "rms_reprojection_px": {
            "value": result.rms_reprojection_px,
            "threshold": SL_MAX_RMS_PX,
            "pass": result.rms_reprojection_px < SL_MAX_RMS_PX,
        },
        "withheld_rms_px": {
            "value": w_combined,
            "threshold": SL_MAX_WITHHELD_RMS_PX,
            "pass": w_combined is not None
            and float(w_combined) < SL_MAX_WITHHELD_RMS_PX,
        },
        "withheld_rms_per_screen": {
            "value": w_by_screen,
            "threshold": SL_MAX_WITHHELD_RMS_PX,
            "pass": _per_screen_below(w_by_screen, SL_MAX_WITHHELD_RMS_PX),
        },
        "homography_rms_undistorted": {
            "value": homography,
            "threshold": SL_MAX_HOMOGRAPHY_RMS_PX,
            "pass": _per_screen_below(homography, SL_MAX_HOMOGRAPHY_RMS_PX),
        },
    }
    failed = [name for name, g in gates.items() if not g["pass"]]
    return {"passed": len(failed) == 0, "failed": failed, "gates": gates}
