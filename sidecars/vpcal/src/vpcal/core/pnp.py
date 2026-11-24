"""Planar-safe robust PnP shared by every RANSAC pose estimate in vpcal.

Why not plain ``cv2.solvePnPRansac(..., flags=SOLVEPNP_ITERATIVE)``: whatever
``flags`` says, OpenCV's RANSAC minimal-sample kernel is **5-point EPnP**
(only P3P / AP3P change it).  OpenCV's EPnP has no planar branch — for
coplanar object points (a flat LED wall, one screen of a multi-screen stage)
its PCA control points degenerate and, for some viewing geometries, EPnP is
off by tens to hundreds of pixels even with *all* points (LAN-8: 61–489 px
RMS on every frame of one simulated capture), so RANSAC finds no consensus
and returns ``ok=False``.  Whether a capture hits such geometry is
data-dependent, not platform-dependent: in CI the simulator happened to emit a
mirrored pose set on hosts without AVX-512 (LAPACK SVD sign choice), and that
pose set failed 8/10 frames on every CPU — while the macOS-generated pose set
passed everywhere.  Real captures can hit it on any host.

:func:`ransac_pnp` keeps OpenCV's RANSAC loop (fixed internal seed) but uses
the 4-point **AP3P** kernel, which is well-conditioned for planar and
non-planar points alike, discards OpenCV's EPnP final refit, and refits the
consensus set itself: IPPE (planar) / SQPnP candidates + the minimal-sample
pose, each LM-refined, lowest RMS wins.  Inliers are then re-scored against
the refined pose.
"""

from __future__ import annotations

import numpy as np
from numpy.typing import NDArray

Array = NDArray[np.float64]

# Singular-value ratio (smallest / largest of the centred object points) under
# which the object is treated as planar and IPPE joins the refit candidates.
_PLANAR_SV_RATIO = 1e-3


def is_planar(obj: Array, ratio: float = _PLANAR_SV_RATIO) -> bool:
    """True when the 3-D points are (numerically) coplanar."""
    pts = np.asarray(obj, dtype=np.float64).reshape(-1, 3)
    if len(pts) < 4:
        return True
    s = np.linalg.svd(pts - pts.mean(axis=0), compute_uv=False)
    return bool(s[0] <= 0.0 or s[2] <= ratio * s[0])


def _reproj_err(obj: Array, img: Array, K: Array, dist: Array, rvec, tvec) -> Array:
    import cv2

    proj, _ = cv2.projectPoints(obj, rvec, tvec, K, dist)
    return np.linalg.norm(proj.reshape(-1, 2) - img, axis=1)


def fit_pose(
    obj: Array,
    img: Array,
    K: Array,
    dist: Array,
    seeds: list[tuple[Array, Array]] | None = None,
) -> tuple[Array, Array] | None:
    """Best LM-refined pose over all points (no outlier rejection).

    Candidates: IPPE solutions (planar objects only), SQPnP, and any ``seeds``.
    Each is refined with ``solvePnPRefineLM``; the lowest-RMS one is returned.
    Returns ``None`` when no candidate could be computed.
    """
    import cv2

    obj = np.asarray(obj, dtype=np.float64).reshape(-1, 3)
    img = np.asarray(img, dtype=np.float64).reshape(-1, 2)
    if len(obj) < 4:
        return None
    cands: list[tuple[Array, Array]] = list(seeds or [])
    methods = ([cv2.SOLVEPNP_IPPE] if is_planar(obj) else []) + [cv2.SOLVEPNP_SQPNP]
    for flag in methods:
        try:
            n, rvecs, tvecs = cv2.solvePnPGeneric(obj, img, K, dist, flags=flag)[:3]
        except cv2.error:
            continue
        for rv, tv in zip(rvecs[:n] if n else [], tvecs[:n] if n else []):
            cands.append((rv, tv))
    best: tuple[float, Array, Array] | None = None
    for rv, tv in cands:
        rv = np.asarray(rv, dtype=np.float64).reshape(3, 1)
        tv = np.asarray(tv, dtype=np.float64).reshape(3, 1)
        if not (np.all(np.isfinite(rv)) and np.all(np.isfinite(tv))):
            continue
        rv, tv = cv2.solvePnPRefineLM(obj, img, K, dist, rv.copy(), tv.copy())
        rms = float(np.sqrt(np.mean(_reproj_err(obj, img, K, dist, rv, tv) ** 2)))
        if np.isfinite(rms) and (best is None or rms < best[0]):
            best = (rms, rv, tv)
    if best is None:
        return None
    return best[1], best[2]


def ransac_pnp(
    obj: Array,
    img: Array,
    K: Array,
    dist: Array,
    *,
    reprojection_error: float = 8.0,
    iterations: int = 100,
    confidence: float = 0.99,
) -> tuple[bool, Array | None, Array | None, NDArray[np.int32] | None]:
    """Drop-in for ``cv2.solvePnPRansac`` → ``(ok, rvec, tvec, inliers)``.

    ``inliers`` has OpenCV's shape ``(k, 1)`` int32 and is re-scored against
    the refined pose (``error <= reprojection_error`` px).  Defaults match
    OpenCV's (8 px, 100 iterations, 0.99 confidence).
    """
    import cv2

    obj = np.ascontiguousarray(np.asarray(obj, dtype=np.float64).reshape(-1, 3))
    img = np.ascontiguousarray(np.asarray(img, dtype=np.float64).reshape(-1, 2))
    if len(obj) < 4 or len(obj) != len(img):
        return False, None, None, None

    ok, rv0, tv0, inl = cv2.solvePnPRansac(
        obj, img, K, dist,
        iterationsCount=iterations,
        reprojectionError=reprojection_error,
        confidence=confidence,
        flags=cv2.SOLVEPNP_AP3P,
    )
    if not ok or inl is None or len(inl) < 4:
        return False, None, None, None
    keep = inl.reshape(-1)
    # rv0/tv0 is OpenCV's EPnP refit of the consensus set — still a valid
    # candidate when well-conditioned, so offer it as a seed.
    pose = fit_pose(obj[keep], img[keep], K, dist, seeds=[(rv0, tv0)])
    if pose is None:
        return False, None, None, None
    rvec, tvec = pose
    err = _reproj_err(obj, img, K, dist, rvec, tvec)
    new_keep = np.flatnonzero(err <= reprojection_error)
    if len(new_keep) < 4:
        return False, None, None, None
    if len(new_keep) > len(keep):
        # The refined pose explains more points than the minimal sample did.
        refit = fit_pose(obj[new_keep], img[new_keep], K, dist, seeds=[(rvec, tvec)])
        if refit is not None:
            rvec, tvec = refit
            err = _reproj_err(obj, img, K, dist, rvec, tvec)
            new_keep = np.flatnonzero(err <= reprojection_error)
            if len(new_keep) < 4:
                return False, None, None, None
    return True, rvec, tvec, new_keep.astype(np.int32).reshape(-1, 1)
