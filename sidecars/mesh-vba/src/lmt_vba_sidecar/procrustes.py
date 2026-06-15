"""Rigid Procrustes alignment via SVD (no scaling).

Both A and C frame strategies use this. The only difference is how the
source/target point pairs are chosen — A uses every detected ChArUco
center against its nominal position; C uses the 3 user-supplied anchors.
"""
from __future__ import annotations

import numpy as np


def _is_degenerate(pts: np.ndarray, tol: float = 1e-6) -> bool:
    """True if the points are collinear (rank < 2 after centering)."""
    if pts.shape[0] < 3:
        return True
    centered = pts - pts.mean(axis=0)
    s = np.linalg.svd(centered, compute_uv=False)
    if s[0] <= tol:
        return True
    return s[1] / s[0] < tol


def procrustes_rigid(
    src: np.ndarray, dst: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, float]:
    """Solve dst ≈ R @ src + t with R orthonormal, det(R) = +1.

    Returns (R, t, rms). Raises ValueError on degenerate input.
    """
    src = np.asarray(src, dtype=float)
    dst = np.asarray(dst, dtype=float)
    if src.ndim != 2 or src.shape[1] != 3:
        raise ValueError(f"src must be (N,3); got {src.shape}")
    if dst.ndim != 2 or dst.shape[1] != 3:
        raise ValueError(f"dst must be (N,3); got {dst.shape}")
    if src.shape != dst.shape:
        raise ValueError(f"src/dst shape mismatch: {src.shape} vs {dst.shape}")
    if not np.isfinite(src).all() or not np.isfinite(dst).all():
        raise ValueError("anchors contain non-finite values (NaN or Inf)")
    if src.shape[0] < 3:
        raise ValueError(f"need ≥ 3 point pairs, got {src.shape[0]}")
    if _is_degenerate(src):
        raise ValueError("source anchors are collinear or degenerate; cannot align")
    if _is_degenerate(dst):
        raise ValueError("destination anchors are collinear or degenerate; cannot align")

    src_c = src.mean(axis=0)
    dst_c = dst.mean(axis=0)
    src0 = src - src_c
    dst0 = dst - dst_c

    H = src0.T @ dst0
    U, _S, Vt = np.linalg.svd(H)
    d = np.sign(np.linalg.det(Vt.T @ U.T))
    D = np.diag([1.0, 1.0, d])
    R = Vt.T @ D @ U.T
    t = dst_c - R @ src_c

    aligned = (src @ R.T) + t
    rms = float(np.sqrt(((aligned - dst) ** 2).sum(axis=1).mean()))
    return R, t, rms
