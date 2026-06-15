"""Visibility-aware Monte-Carlo scorer.

Same real-path skeleton as sl_feasibility.feasibility_rms_mm (observe with true
K + centroid noise; estimate each camera pose by solvePnP against the nominal
model with the believed K; triangulate; error vs truth) but every step is gated
by per-point visibility: a camera observes only points it can see, its PnP uses
only its covered cabinets' visible points, and a point is triangulated only from
cameras that see it (>=2). Cabinets that are not `reconstructable` (Task 4) are
not scored — their residual is NaN, never an optimistic number.
"""
from __future__ import annotations

import numpy as np

from lmt_vba_sidecar.sl_feasibility import project_point, solve_pnp_pose, triangulate_multiview
from lmt_vba_sidecar.capture_planner import gates
from lmt_vba_sidecar.capture_planner.geometry import ScreenGeometry
from lmt_vba_sidecar.capture_planner.visibility import (
    Camera,
    coverage_report,
    bridging_report,
    point_visible,
)


def _all_points(geom: ScreenGeometry):
    """Flatten to (truth Nx3, owner (col,row) per point, normal per point)."""
    pts, owner, normals = [], [], []
    for cabg in geom.cabinets:
        for p in cabg.sample_points_mm:
            pts.append(p)
            owner.append((cabg.col, cabg.row))
            normals.append(cabg.normal)
    return np.asarray(pts, float), owner, normals


def _small_rotation(rng, sigma_deg: float) -> np.ndarray:
    """Random small rotation: uniform random axis × N(0, sigma_deg) angle
    (Rodrigues, pure numpy)."""
    axis = rng.normal(size=3)
    n = np.linalg.norm(axis)
    if n < 1e-12:
        return np.eye(3)
    axis = axis / n
    th = np.deg2rad(rng.normal(0.0, sigma_deg))
    kx = np.array([[0.0, -axis[2], axis[1]],
                   [axis[2], 0.0, -axis[0]],
                   [-axis[1], axis[0], 0.0]])
    return np.eye(3) + np.sin(th) * kx + (1.0 - np.cos(th)) * (kx @ kx)


def score_screen(geom: ScreenGeometry, cams: list[Camera], *, pixel_sigma=0.3,
                 nominal_deviation_mm=2.0, cabinet_jitter_mm=1.0,
                 cabinet_jitter_deg=0.1, focal_err_frac=0.0, incidence_max_deg=60.0,
                 margin_frac=0.05, trials=20, seed=0, target_p95_residual_mm=3.0,
                 min_views=gates.MIN_VIEWS):
    per_cab, counts = coverage_report(geom, cams, margin_frac=margin_frac,
                                      incidence_max_deg=incidence_max_deg, min_views=min_views)
    cov_by_key = {(c.col, c.row): c for c in per_cab}
    bridge = bridging_report(geom, cams, margin_frac=margin_frac,
                             incidence_max_deg=incidence_max_deg, counts=counts)
    bridged_keys = set()
    big = max(bridge.components, key=len) if bridge.components else []
    bridged_keys.update(big)

    truth, owner, normals = _all_points(geom)
    n_pts = len(truth)
    arc = geom.arc_occluder
    # which cameras see each truth point (true geometry, fixed across trials)
    sees = [
        [ci for ci, cam in enumerate(cams)
         if point_visible(cam, truth[i], normals[i], margin_frac=margin_frac,
                          incidence_max_deg=incidence_max_deg, arc=arc)]
        for i in range(n_pts)
    ]
    # which points each camera uses for its PnP (only points it can see)
    cam_pts = {ci: [i for i in range(n_pts) if ci in sees[i]] for ci in range(len(cams))}

    rng = np.random.default_rng(seed)
    K = cams[0].K  # planning assumes a shared camera model
    per_point_err = {i: [] for i in range(n_pts)}

    # FIX-17 ②: 真实 as-built 误差的主导项是箱体级系统性偏差(整箱装歪/装偏),
    # 不是逐点 i.i.d. 噪声——纯 i.i.d. 会被多点平均掉,系统性低估 p95。噪声模型
    # = i.i.d. 逐点项(nominal_deviation_mm) + 箱体级相关刚体抖动
    # (cabinet_jitter_mm 平移 + cabinet_jitter_deg 绕箱体中心小旋转,
    # 同一箱体所有采样点共享)。
    own_idx = {}
    cab_centers = {}
    for cabg in geom.cabinets:
        key = (cabg.col, cabg.row)
        own_idx[key] = np.asarray([i for i in range(n_pts) if owner[i] == key], int)
        cab_centers[key] = np.asarray(cabg.center_mm, float)

    for _ in range(trials):
        nominal = truth + (rng.normal(0.0, nominal_deviation_mm, truth.shape)
                           if nominal_deviation_mm > 0 else 0.0)
        if cabinet_jitter_mm > 0 or cabinet_jitter_deg > 0:
            for key, idx in own_idx.items():
                pts = nominal[idx]
                if cabinet_jitter_deg > 0:
                    rj = _small_rotation(rng, cabinet_jitter_deg)
                    c = cab_centers[key]
                    pts = (pts - c) @ rj.T + c
                if cabinet_jitter_mm > 0:
                    pts = pts + rng.normal(0.0, cabinet_jitter_mm, 3)
                nominal[idx] = pts
        Kc = K.copy()
        if focal_err_frac > 0:
            f = K[0, 0] * (1.0 + rng.normal(0.0, focal_err_frac))
            Kc[0, 0] = Kc[1, 1] = f

        # observe (true K + noise) per visible point
        obs = {}
        for ci in range(len(cams)):
            for i in cam_pts[ci]:
                p = project_point(K, cams[ci].R, cams[ci].t, truth[i])
                if pixel_sigma > 0:
                    p = p + rng.normal(0.0, pixel_sigma, 2)
                obs[(ci, i)] = p

        # estimate each camera pose via PnP against nominal (believed K)
        est = {}
        for ci in range(len(cams)):
            idx = cam_pts[ci]
            if len(idx) < 4:
                continue
            try:
                est[ci] = solve_pnp_pose(Kc, nominal[idx],
                                         np.asarray([obs[(ci, i)] for i in idx]))
            except ValueError:
                continue

        for i in range(n_pts):
            usable = [ci for ci in sees[i] if ci in est]
            if len(usable) < 2:
                continue
            poses = [est[ci] for ci in usable]
            pts2d = [obs[(ci, i)] for ci in usable]
            xhat = triangulate_multiview(Kc, poses, pts2d)
            per_point_err[i].append(float(np.linalg.norm(xhat - truth[i])))

    # aggregate per cabinet
    report = {}
    for cabg in geom.cabinets:
        key = (cabg.col, cabg.row)
        cov = cov_by_key[key]
        errs = [e for i in range(n_pts) if owner[i] == key for e in per_point_err[i]]
        bridged = key in bridged_keys
        if cov.reconstructable and errs:
            a = np.asarray(errs)
            p95 = float(np.percentile(a, 95))
            median = float(np.median(a))
        else:
            p95 = float("nan")
            median = float("nan")
        passed = bool(cov.reconstructable and bridged
                      and (p95 <= target_p95_residual_mm))
        # Observability diagnostic (no new gate): WHY did it fail?
        #  - low_coverage: not enough views/points (or unbridged) to even attempt.
        #  - low_parallax: count-reconstructable + bridged, but p95 over target —
        #    degenerate (near-duplicate / fronto-parallel) baseline, not coverage.
        if passed:
            fail_reason = None
        elif not (cov.reconstructable and bridged):
            fail_reason = "low_coverage"
        else:
            fail_reason = "low_parallax"
        report[key] = {
            "p95_mm": p95,
            "median_mm": median,
            "n_views": len(cov.covering_cams),
            "total_observations": cov.total_observations,
            "reconstructable": cov.reconstructable,
            "low_observation": cov.low_observation,
            "bridged": bridged,
            "pass": passed,
            "fail_reason": fail_reason,
        }
    return report
