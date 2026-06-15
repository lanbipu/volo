"""Model-constrained bundle adjustment.

State = per-camera SE3 (rvec,t) + per-NON-root cabinet SE3 (rvec,t).
Root cabinet (gauge) is fixed at R=I,t=0 so the world frame equals the
root cabinet's active-surface frame. Observations carry the known local
mm coordinate of each detected corner. Scale is fixed by these metric
local coords — no anchors, no total station.
"""
from __future__ import annotations
from dataclasses import dataclass
import cv2
import numpy as np
from scipy.optimize import least_squares
from scipy.sparse import csc_matrix, lil_matrix
from scipy.sparse.linalg import splu


@dataclass
class Observation:
    camera_idx: int
    cabinet_idx: int
    p_local: np.ndarray  # (3,) mm
    pixel: np.ndarray     # (2,)
    sigma_px: float = 1.0  # observation uncertainty (px); BA residuals are divided by this


@dataclass
class BAResult:
    camera_poses: list[tuple[np.ndarray, np.ndarray]]
    cabinet_poses: dict[int, tuple[np.ndarray, np.ndarray]]  # idx -> (R,t); 含 root=I,0
    rms_reprojection_px: float
    iterations: int
    converged: bool
    cabinet_covariances: dict[int, np.ndarray]


def _nonroot_cabinets(n_cabinets: int, root: int) -> list[int]:
    return [j for j in range(n_cabinets) if j != root]


def _pack(cams, cabs, nonroot):
    parts = []
    for R, t in cams:
        rvec, _ = cv2.Rodrigues(R)
        parts.append(np.concatenate([rvec.ravel(), t]))
    for j in nonroot:
        R, t = cabs[j]
        rvec, _ = cv2.Rodrigues(R)
        parts.append(np.concatenate([rvec.ravel(), t]))
    return np.concatenate(parts)


def _unpack(x, n_cams, nonroot):
    cams = []
    for i in range(n_cams):
        seg = x[i*6:i*6+6]
        R, _ = cv2.Rodrigues(seg[:3])
        cams.append((R, seg[3:6].copy()))
    cabs = {}
    base = n_cams*6
    for k, j in enumerate(nonroot):
        seg = x[base+k*6: base+k*6+6]
        R, _ = cv2.Rodrigues(seg[:3])
        cabs[j] = (R, seg[3:6].copy())
    return cams, cabs


def _precompute_obs_arrays(obs):
    """Extract observation fields into contiguous arrays for vectorized residuals."""
    n = len(obs)
    cam_idx = np.array([o.camera_idx for o in obs], dtype=np.int32)
    cab_idx = np.array([o.cabinet_idx for o in obs], dtype=np.int32)
    p_local = np.array([o.p_local for o in obs], dtype=np.float64)  # (N, 3)
    pixel = np.array([o.pixel for o in obs], dtype=np.float64)      # (N, 2)
    sigma = np.array([o.sigma_px for o in obs], dtype=np.float64)   # (N,)
    return cam_idx, cab_idx, p_local, pixel, sigma


def _residuals(x, n_cams, nonroot, root, K, obs_arrays):
    cam_idx, cab_idx, p_local, pixel, sigma = obs_arrays
    n = len(cam_idx)
    # Unpack all poses into arrays: cameras (n_cams, 3, 3) + (n_cams, 3),
    # cabinets indexed by cabinet_idx.
    all_R_cam = np.zeros((n_cams, 3, 3))
    all_t_cam = np.zeros((n_cams, 3))
    for i in range(n_cams):
        seg = x[i*6:i*6+6]
        all_R_cam[i], _ = cv2.Rodrigues(seg[:3])
        all_t_cam[i] = seg[3:6]
    nonroot_map = {j: k for k, j in enumerate(nonroot)}
    base = n_cams * 6
    all_R_cab = {}
    all_t_cab = {}
    all_R_cab[root] = np.eye(3)
    all_t_cab[root] = np.zeros(3)
    for k, j in enumerate(nonroot):
        seg = x[base + k*6: base + k*6 + 6]
        all_R_cab[j], _ = cv2.Rodrigues(seg[:3])
        all_t_cab[j] = seg[3:6]
    # Vectorized: gather per-observation rotation/translation
    Rc = all_R_cam[cam_idx]  # (N, 3, 3)
    tc = all_t_cam[cam_idx]  # (N, 3)
    # Cabinet poses: build arrays indexed by observation
    unique_cabs = np.unique(cab_idx)
    Rb = np.zeros((n, 3, 3))
    tb = np.zeros((n, 3))
    for j in unique_cabs:
        mask = cab_idx == j
        Rb[mask] = all_R_cab[j]
        tb[mask] = all_t_cab[j]
    # xw = Rb @ p_local + tb  (batch matmul)
    xw = np.einsum('nij,nj->ni', Rb, p_local) + tb
    # xc = Rc @ xw + tc
    xc = np.einsum('nij,nj->ni', Rc, xw) + tc
    # project: p = K @ xc, then p[:2]/p[2]
    proj = (K @ xc.T).T  # (N, 3)
    projected = proj[:, :2] / proj[:, 2:3]
    # residuals / sigma
    res_2d = (projected - pixel) / sigma[:, None]
    return res_2d.ravel()


def _sparsity(n_cams, nonroot, root, obs):
    n = n_cams*6 + len(nonroot)*6
    A = lil_matrix((len(obs)*2, n), dtype=int)
    nonroot_pos = {j: k for k, j in enumerate(nonroot)}
    base = n_cams*6
    for k, o in enumerate(obs):
        A[k*2:k*2+2, o.camera_idx*6:o.camera_idx*6+6] = 1
        if o.cabinet_idx != root:
            c = base + nonroot_pos[o.cabinet_idx]*6
            A[k*2:k*2+2, c:c+6] = 1
    return A


def model_constrained_ba(*, K, observations, n_cameras, n_cabinets,
                         root_cabinet_idx, init_cameras, init_cabinets,
                         loss="huber", f_scale=2.0, max_nfev=200,
                         x_scale="jac", compute_covariance=True) -> BAResult:
    nonroot = _nonroot_cabinets(n_cabinets, root_cabinet_idx)
    cabs0 = dict(init_cabinets)
    for j in nonroot:
        cabs0.setdefault(j, (np.eye(3), np.zeros(3)))
    x0 = _pack(init_cameras, cabs0, nonroot)
    sp = _sparsity(n_cameras, nonroot, root_cabinet_idx, observations)
    obs_arrays = _precompute_obs_arrays(observations)
    sol = least_squares(
        _residuals, x0, jac_sparsity=sp, method="trf",
        loss=loss, f_scale=f_scale, max_nfev=max_nfev, x_scale=x_scale, verbose=0,
        args=(n_cameras, nonroot, root_cabinet_idx, K, obs_arrays),
    )
    cams, cabs = _unpack(sol.x, n_cameras, nonroot)
    cabs[root_cabinet_idx] = (np.eye(3), np.zeros(3))
    # sol.fun is the weighted residual (r/σ); recover unweighted pixel RMS.
    unweighted = sol.fun.reshape(-1, 2) * obs_arrays[4][:, None]  # obs_arrays[4] = sigma
    rms = float(np.sqrt((unweighted**2).sum(axis=1).mean()))
    covs: dict[int, np.ndarray] = {}
    if compute_covariance and sol.jac is not None:
        try:
            J_sp = csc_matrix(sol.jac) if not isinstance(sol.jac, csc_matrix) else sol.jac
            dof = max(1, J_sp.shape[0] - J_sp.shape[1])
            if loss == "huber":
                abs_f = np.abs(sol.fun)
                rho_prime = np.where(abs_f <= f_scale, 1.0,
                                     f_scale / np.maximum(abs_f, 1e-30))
                sigma2 = float((rho_prime * sol.fun**2).sum() / dof)
            else:
                sigma2 = float((sol.fun**2).sum() / dof)
            # FIX-19③: sparse LU on JᵀJ, solve only the 3 columns needed per
            # cabinet translation block — no dense pinv, no parameter cap.
            JtJ = (J_sp.T @ J_sp).tocsc()
            lu = splu(JtJ)
            base = n_cameras*6
            n_params = JtJ.shape[0]
            for k, j in enumerate(nonroot):
                a = base + k*6 + 3  # translation block start
                block = np.empty((3, 3))
                for c in range(3):
                    rhs = np.zeros(n_params)
                    rhs[a + c] = 1.0
                    block[:, c] = lu.solve(rhs)[a:a+3]
                covs[j] = block * sigma2
        except Exception:
            pass
    return BAResult(camera_poses=cams, cabinet_poses=cabs,
                    rms_reprojection_px=rms, iterations=int(sol.nfev),
                    converged=bool(sol.success), cabinet_covariances=covs)
