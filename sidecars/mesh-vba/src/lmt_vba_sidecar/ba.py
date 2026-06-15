"""Bundle adjustment via scipy.optimize.least_squares.

Joint optimization over 3D points + camera extrinsics. Intrinsics are held
fixed (we trust the calibration step). Observations MUST be undistorted
upstream (e.g. via cv2.undistortPoints) — `bundle_adjust` rejects non-zero
`dist_coeffs` rather than silently fitting lens distortion into pose error.

Per-point covariance is opt-in via `compute_covariance=True`. Uses sparse LU
on JᵀJ to extract only the needed 3×3 diagonal blocks — no dense
pseudo-inverse, no parameter cap.
"""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np
from scipy.optimize import least_squares
from scipy.sparse import csc_matrix, lil_matrix
from scipy.sparse.linalg import splu


@dataclass
class BAResult:
    points: np.ndarray  # (P, 3)
    cam_poses: list[tuple[np.ndarray, np.ndarray]]
    rms_reprojection_px: float
    iterations: int
    converged: bool
    point_covariances: dict[int, np.ndarray]  # per-point 3×3 covariance


def _params_from_state(
    points: np.ndarray, cams: list[tuple[np.ndarray, np.ndarray]],
) -> np.ndarray:
    parts = []
    for R, t in cams:
        rvec, _ = cv2.Rodrigues(R)
        parts.append(np.concatenate([rvec.flatten(), t]))
    parts.append(points.flatten())
    return np.concatenate(parts)


def _state_from_params(
    params: np.ndarray, n_cams: int, n_points: int,
) -> tuple[list[tuple[np.ndarray, np.ndarray]], np.ndarray]:
    cams: list[tuple[np.ndarray, np.ndarray]] = []
    for i in range(n_cams):
        rvec = params[i * 6:i * 6 + 3]
        t = params[i * 6 + 3:i * 6 + 6]
        R, _ = cv2.Rodrigues(rvec)
        cams.append((R, t))
    points = params[n_cams * 6:].reshape(n_points, 3)
    return cams, points


def _residuals(
    params: np.ndarray, n_cams: int, n_points: int,
    K: np.ndarray, observations: list[tuple[int, int, np.ndarray]],
) -> np.ndarray:
    cams, points = _state_from_params(params, n_cams, n_points)
    res = np.zeros(len(observations) * 2)
    for k, (cam_i, pt_i, pix) in enumerate(observations):
        R, t = cams[cam_i]
        cam_pt = R @ points[pt_i] + t
        proj = K @ cam_pt
        proj = proj[:2] / proj[2]
        res[k * 2: k * 2 + 2] = proj - pix
    return res


def _build_sparsity(
    n_cams: int, n_points: int,
    observations: list[tuple[int, int, np.ndarray]],
) -> lil_matrix:
    m = len(observations) * 2
    n = n_cams * 6 + n_points * 3
    A = lil_matrix((m, n), dtype=int)
    for k, (cam_i, pt_i, _) in enumerate(observations):
        A[k * 2:k * 2 + 2, cam_i * 6:cam_i * 6 + 6] = 1
        A[k * 2:k * 2 + 2, n_cams * 6 + pt_i * 3:n_cams * 6 + pt_i * 3 + 3] = 1
    return A


def bundle_adjust(
    *,
    K: np.ndarray, dist_coeffs: np.ndarray,
    initial_points: np.ndarray,
    initial_cam_poses: list[tuple[np.ndarray, np.ndarray]],
    observations: list[tuple[int, int, np.ndarray]],
    max_iters: int = 100,
    compute_covariance: bool = True,
) -> BAResult:
    if dist_coeffs is not None and np.asarray(dist_coeffs).size > 0:
        if not np.allclose(np.asarray(dist_coeffs), 0.0):
            raise ValueError(
                "bundle_adjust requires undistorted observations: "
                "non-zero dist_coeffs supplied. Run cv2.undistortPoints "
                "on observations upstream and pass dist_coeffs=zeros."
            )

    n_cams = len(initial_cam_poses)
    n_points = initial_points.shape[0]
    x0 = _params_from_state(initial_points, initial_cam_poses)
    sparsity = _build_sparsity(n_cams, n_points, observations)

    sol = least_squares(
        _residuals, x0,
        jac_sparsity=sparsity,
        args=(n_cams, n_points, K, observations),
        method="trf",
        loss="huber", f_scale=2.0, x_scale="jac",
        max_nfev=max_iters,
        verbose=0,
    )

    cams, points = _state_from_params(sol.x, n_cams, n_points)
    rms = float(np.sqrt((sol.fun ** 2).reshape(-1, 2).sum(axis=1).mean()))

    point_covariances: dict[int, np.ndarray] = {}
    if compute_covariance and sol.jac is not None:
        try:
            J_sp = csc_matrix(sol.jac) if not isinstance(sol.jac, csc_matrix) else sol.jac
            dof = max(1, J_sp.shape[0] - J_sp.shape[1])
            abs_f = np.abs(sol.fun)
            rho_prime = np.where(abs_f <= 2.0, 1.0,
                                 2.0 / np.maximum(abs_f, 1e-30))
            sigma2 = float((rho_prime * sol.fun ** 2).sum() / dof)
            JtJ = (J_sp.T @ J_sp).tocsc()
            lu = splu(JtJ)
            n_params = JtJ.shape[0]
            for pt_i in range(n_points):
                a = n_cams * 6 + pt_i * 3
                block = np.empty((3, 3))
                for c in range(3):
                    rhs = np.zeros(n_params)
                    rhs[a + c] = 1.0
                    block[:, c] = lu.solve(rhs)[a:a + 3]
                point_covariances[pt_i] = block * sigma2
        except Exception:
            pass

    return BAResult(
        points=points,
        cam_poses=cams,
        rms_reprojection_px=rms,
        iterations=int(sol.nfev),
        converged=bool(sol.success),
        point_covariances=point_covariances,
    )
