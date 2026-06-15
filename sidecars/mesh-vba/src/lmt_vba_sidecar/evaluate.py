"""Gauge-invariant evaluation. All headline metrics (sizes, pairwise
distances, pairwise normal angles) are SE(3)-invariant, so no datum /
total station is needed. Full-field RMS uses SE(3) alignment with
disjoint align/score split to avoid self-scoring."""
from __future__ import annotations
import itertools
import numpy as np


def umeyama_no_scale(src: np.ndarray, dst: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Rigid-body (no scale) alignment: find R, t such that dst ≈ R @ src + t.

    Uses the SVD-based closed-form solution. The det-sign fix handles the
    reflection ambiguity so R is always a proper rotation (det = +1).
    Requires N>=3 for a non-degenerate solution.
    """
    sc, dc = src.mean(0), dst.mean(0)
    H = (src - sc).T @ (dst - dc)
    U, _, Vt = np.linalg.svd(H)
    d = np.sign(np.linalg.det(Vt.T @ U.T))
    R = Vt.T @ np.diag([1, 1, d]) @ U.T
    t = dc - R @ sc
    return R, t


def gauge_invariant_metrics(tc, tn, ts, ec, en, es) -> dict:
    """Compute SE(3)-invariant metrics between true and estimated cabinet poses.

    Args:
        tc: true centers  {idx: np.ndarray shape (3,)}
        tn: true normals  {idx: np.ndarray shape (3,)}  (unit vectors)
        ts: true sizes    {idx: (width_mm, height_mm)}
        ec: estimated centers  (same schema)
        en: estimated normals  (same schema)
        es: estimated sizes    (same schema)

    Returns dict with keys:
        max_size_error_mm, rms_size_error_mm,
        max_distance_error_mm,
        max_angle_error_deg
    """
    size_err = [abs(es[i][0] - ts[i][0]) for i in tc] + \
               [abs(es[i][1] - ts[i][1]) for i in tc]
    ang_err, dist_err = [], []
    for i, j in itertools.combinations(sorted(tc), 2):
        td = np.linalg.norm(tc[i] - tc[j])
        ed = np.linalg.norm(ec[i] - ec[j])
        dist_err.append(abs(ed - td))
        ta = np.degrees(np.arccos(np.clip(tn[i] @ tn[j], -1, 1)))
        ea = np.degrees(np.arccos(np.clip(en[i] @ en[j], -1, 1)))
        ang_err.append(abs(ea - ta))
    return {
        "max_size_error_mm": float(max(size_err)) if size_err else 0.0,
        "rms_size_error_mm": float(np.sqrt(np.mean(np.square(size_err)))) if size_err else 0.0,
        "max_distance_error_mm": float(max(dist_err)) if dist_err else 0.0,
        "max_angle_error_deg": float(max(ang_err)) if ang_err else 0.0,
    }


def se3_aligned_holdout_rms(true_pts: np.ndarray, est_pts: np.ndarray,
                            align_idx, score_idx) -> dict:
    """SE(3)-aligned holdout RMS: align on `align_idx`, score on `score_idx`.

    The disjoint split prevents self-scoring: alignment uses a subset of
    points, and error is measured on a completely separate subset. This
    gives an unbiased estimate of registration accuracy.

    Args:
        true_pts:  (N, 3) ground-truth 3D points
        est_pts:   (N, 3) estimated 3D points (same ordering)
        align_idx: index array / slice used to fit R, t
        score_idx: index array / slice used to measure error
                   align_idx and score_idx MUST be disjoint (caller contract)
                   to avoid self-scoring.

    Returns dict with keys: rms_mm, p95_mm, max_mm
    """
    R, t = umeyama_no_scale(est_pts[align_idx], true_pts[align_idx])
    aligned = (est_pts[score_idx] @ R.T) + t
    err = np.linalg.norm(aligned - true_pts[score_idx], axis=1)
    return {
        "rms_mm": float(np.sqrt(np.mean(err ** 2))),
        "p95_mm": float(np.percentile(err, 95)),
        "max_mm": float(err.max()),
    }
