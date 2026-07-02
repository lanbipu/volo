"""W7 benchmark: model_constrained_ba wall clock, finite-difference Jacobian
(pre-W7 baseline, reproduced inline below) vs. the analytic Jacobian now
shipped in lmt_vba_sidecar.model_constrained_ba.

Not packaged (outside src/, excluded by [tool.setuptools.packages.find]).

Usage:
    .venv/bin/python benchmarks/bench_ba_jacobian.py [--cabinets N] [--cams N]
        [--corners N] [--noise PX] [--max-nfev N] [--seed N] [--skip-fd]

Machine: results in the README were captured on the dev machine (Apple
Silicon, macOS, single-threaded scipy/numpy build in .venv) — wall-clock
numbers are illustrative of the *relative* speedup, not absolute hardware-
independent figures.
"""
from __future__ import annotations
import argparse
import time
import numpy as np
import cv2
from scipy.optimize import least_squares
from scipy.sparse import lil_matrix

from lmt_vba_sidecar.model_constrained_ba import (
    Observation,
    model_constrained_ba,
    _nonroot_cabinets,
    _pack,
    _precompute_obs_arrays,
    _residuals,
)


def _sparsity_pre_w7(n_cams, nonroot, root, obs):
    """Verbatim copy of the pre-W7 `_sparsity` helper (removed from
    model_constrained_ba.py when the analytic Jacobian replaced
    jac_sparsity-guided finite differences) — kept here only so the
    benchmark can reproduce the old code path for an honest before/after."""
    n = n_cams * 6 + len(nonroot) * 6
    A = lil_matrix((len(obs) * 2, n), dtype=int)
    nonroot_pos = {j: k for k, j in enumerate(nonroot)}
    base = n_cams * 6
    for k, o in enumerate(obs):
        A[k * 2:k * 2 + 2, o.camera_idx * 6:o.camera_idx * 6 + 6] = 1
        if o.cabinet_idx != root:
            c = base + nonroot_pos[o.cabinet_idx] * 6
            A[k * 2:k * 2 + 2, c:c + 6] = 1
    return A


def model_constrained_ba_fd(*, K, observations, n_cameras, n_cabinets,
                             root_cabinet_idx, init_cameras, init_cabinets,
                             loss="huber", f_scale=2.0, max_nfev=200,
                             x_scale="jac"):
    """Pre-W7 code path: scipy 2-point finite-difference Jacobian guided by
    jac_sparsity, instead of the analytic jac= callable."""
    nonroot = _nonroot_cabinets(n_cabinets, root_cabinet_idx)
    cabs0 = dict(init_cabinets)
    for j in nonroot:
        cabs0.setdefault(j, (np.eye(3), np.zeros(3)))
    x0 = _pack(init_cameras, cabs0, nonroot)
    sp = _sparsity_pre_w7(n_cameras, nonroot, root_cabinet_idx, observations)
    obs_arrays = _precompute_obs_arrays(observations)
    sol = least_squares(
        _residuals, x0, jac_sparsity=sp, method="trf",
        loss=loss, f_scale=f_scale, max_nfev=max_nfev, x_scale=x_scale, verbose=0,
        args=(n_cameras, nonroot, root_cabinet_idx, K, obs_arrays),
    )
    return sol


def _project(K, R_cam, t_cam, R_cab, t_cab, p_local):
    xw = R_cab @ p_local + t_cab
    xc = R_cam @ xw + t_cam
    p = K @ xc
    return p[:2] / p[2]


def make_scene(n_cabinets, n_cams, n_corners, noise_px, seed):
    """Full-visibility synthetic scene: every camera observes every cabinet's
    `n_corners` planar markers — the worst-case density for stress-testing.

    Cabinets tile a grid (like an LED wall); cameras sit on a line in front of
    the wall's centroid at a distance scaled to the wall's size, so pixel
    projections stay well-conditioned regardless of how many cabinets are
    requested (a naive 1-D cabinet layout pushes far cabinets to extreme,
    poorly-conditioned viewing angles and huber-loss BA stalls)."""
    rng = np.random.default_rng(seed)
    K = np.array([[2000., 0, 960], [0, 2000, 540], [0, 0, 1]])
    half_w, half_h = 300.0, 170.0
    if n_corners == 4:
        local_pts = np.array([[-half_w, -half_h, 0], [half_w, -half_h, 0],
                               [half_w, half_h, 0], [-half_w, half_h, 0]], float)
    else:
        side = max(2, int(np.ceil(np.sqrt(n_corners))))
        pts = []
        for iy in range(side):
            for ix in range(side):
                if len(pts) >= n_corners:
                    break
                x = -half_w + 2 * half_w * ix / (side - 1)
                y = -half_h + 2 * half_h * iy / (side - 1)
                pts.append([x, y, 0.0])
        local_pts = np.array(pts[:n_corners], float)

    spacing = 650.0  # mm, typical LED cabinet pitch
    n_cols = max(1, int(np.ceil(np.sqrt(n_cabinets))))
    wall_span = spacing * n_cols
    centroid_x = spacing * (n_cols - 1) / 2.0
    centroid_y = spacing * ((n_cabinets - 1) // n_cols) / 2.0
    depth = 3.0 * wall_span  # camera distance scales with wall size -> bounded pixel offsets

    boards_true = {0: (np.eye(3), np.zeros(3))}
    for j in range(1, n_cabinets):
        col, row = j % n_cols, j // n_cols
        tb = np.array([spacing * col, spacing * row, 0.0])
        angle = np.deg2rad(1.5 * ((j % 7) - 3))  # +-4.5deg misalignment, bounded
        Rb, _ = cv2.Rodrigues(np.array([0.0, angle, 0.0]))
        boards_true[j] = (Rb, tb)

    cams_true = []
    for i in range(n_cams):
        frac = i / max(1, n_cams - 1)
        lateral = wall_span * 0.5 * (frac - 0.5)
        rvec = np.array([0.0, 0.03 * (frac - 0.5), 0.0])
        Rc, _ = cv2.Rodrigues(rvec)
        tc = np.array([-centroid_x + lateral, -centroid_y, depth])
        cams_true.append((Rc, tc))

    obs = []
    for ci, (Rc, tc) in enumerate(cams_true):
        for bj, (Rb, tb) in boards_true.items():
            for p in local_pts:
                px = _project(K, Rc, tc, Rb, tb, p)
                if noise_px > 0:
                    px = px + rng.normal(0, noise_px, 2)
                obs.append(Observation(camera_idx=ci, cabinet_idx=bj,
                                        p_local=p.copy(), pixel=px.copy()))

    # Perturbed initial guess (BA must do real work, not start converged).
    init_cams = []
    for Rc, tc in cams_true:
        drvec = rng.normal(0, 0.02, 3)
        dR, _ = cv2.Rodrigues(drvec)
        init_cams.append((dR @ Rc, tc + rng.normal(0, 5.0, 3)))
    init_cabs = {}
    for j in range(1, n_cabinets):
        Rb, tb = boards_true[j]
        drvec = rng.normal(0, 0.02, 3)
        dR, _ = cv2.Rodrigues(drvec)
        init_cabs[j] = (dR @ Rb, tb + rng.normal(0, 5.0, 3))

    return K, obs, cams_true, boards_true, init_cams, init_cabs


def run(n_cabinets, n_cams, n_corners, noise_px, max_nfev, seed, skip_fd):
    K, obs, cams_true, boards_true, init_cams, init_cabs = make_scene(
        n_cabinets, n_cams, n_corners, noise_px, seed)
    n_params = n_cams * 6 + (n_cabinets - 1) * 6
    print(f"scene: cabinets={n_cabinets} cams={n_cams} corners/board={n_corners} "
          f"-> observations={len(obs)} residual_dim={2*len(obs)} params={n_params}")

    fd_wall = None
    if not skip_fd:
        t0 = time.perf_counter()
        sol_fd = model_constrained_ba_fd(
            K=K, observations=obs, n_cameras=n_cams, n_cabinets=n_cabinets,
            root_cabinet_idx=0, init_cameras=init_cams, init_cabinets=init_cabs,
            loss="huber", max_nfev=max_nfev)
        fd_wall = time.perf_counter() - t0
        print(f"[finite-diff, pre-W7] wall={fd_wall:.2f}s nfev={sol_fd.nfev} "
              f"cost={sol_fd.cost:.6g} success={sol_fd.success}")

    t0 = time.perf_counter()
    result = model_constrained_ba(
        K=K, observations=obs, n_cameras=n_cams, n_cabinets=n_cabinets,
        root_cabinet_idx=0, init_cameras=init_cams, init_cabinets=init_cabs,
        loss="huber", max_nfev=max_nfev, compute_covariance=False)
    analytic_wall = time.perf_counter() - t0
    print(f"[analytic jac, W7]     wall={analytic_wall:.2f}s "
          f"iterations(nfev)={result.iterations} rms_px={result.rms_reprojection_px:.4g} "
          f"converged={result.converged}")

    if fd_wall is not None:
        print(f"speedup: {fd_wall/analytic_wall:.1f}x")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--cabinets", type=int, default=300)
    ap.add_argument("--cams", type=int, default=20)
    ap.add_argument("--corners", type=int, default=4)
    ap.add_argument("--noise", type=float, default=0.3)
    ap.add_argument("--max-nfev", type=int, default=200)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--skip-fd", action="store_true",
                    help="skip the pre-W7 finite-difference baseline (it can be very slow at scale)")
    args = ap.parse_args()
    run(args.cabinets, args.cams, args.corners, args.noise, args.max_nfev, args.seed, args.skip_fd)
