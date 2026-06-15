"""Feasibility model for structured-light screen reconstruction.

Models the ACTUAL reconstruction path so the gate is honest:
  1. project true 3D screen points into N views (true poses, true K)
  2. add Gaussian centroid noise
  3. ESTIMATE each camera pose with cv2.solvePnP against the nominal model
     (the as-built screen the pipeline assumes), using the CAMERA'S believed K
  4. triangulate with the ESTIMATED poses and believed K
This captures PnP pose error, intrinsic/calibration error, and nominal-deviation
error -- not just centroid noise. The definitive gate is re-confirmed by Phase 3's
full BA, but this is a valid stop/proceed screen before any production code.
"""
from __future__ import annotations

import cv2
import numpy as np

Pose = tuple[np.ndarray, np.ndarray]  # (R world->cam 3x3, t world->cam 3,)


def project_point(K: np.ndarray, R: np.ndarray, t: np.ndarray, X: np.ndarray) -> np.ndarray:
    xc = R @ X + t
    p = K @ xc
    return p[:2] / p[2]


def triangulate_multiview(K: np.ndarray, poses: list[Pose], pts2d: list[np.ndarray]) -> np.ndarray:
    if len(poses) < 2:
        raise ValueError("triangulation needs >= 2 camera poses")
    rows = []
    for (R, t), (x, y) in zip(poses, pts2d):
        P = K @ np.hstack([R, t.reshape(3, 1)])
        rows.append(x * P[2] - P[0])
        rows.append(y * P[2] - P[1])
    _, _, Vt = np.linalg.svd(np.asarray(rows))
    Xh = Vt[-1]
    return Xh[:3] / Xh[3]


def look_at_pose(cam_pos_mm: np.ndarray, target_mm: np.ndarray | None = None,
                 up: np.ndarray | None = None) -> Pose:
    target_mm = np.zeros(3) if target_mm is None else target_mm
    up = np.array([0.0, 1.0, 0.0]) if up is None else up
    z = target_mm - cam_pos_mm
    z = z / np.linalg.norm(z)
    x = np.cross(up, z)
    x = x / np.linalg.norm(x)
    y = np.cross(z, x)
    R = np.stack([x, y, z], axis=0)
    return R, -R @ cam_pos_mm


def solve_pnp_pose(K: np.ndarray, object_pts_mm: np.ndarray, image_pts: np.ndarray) -> Pose:
    """Estimate (R, t) from 3D-2D correspondences. SQPNP handles planar and
    general configurations without an initial guess (cv2 4.11)."""
    obj = np.ascontiguousarray(np.asarray(object_pts_mm, float).reshape(-1, 1, 3))
    img = np.ascontiguousarray(np.asarray(image_pts, float).reshape(-1, 1, 2))
    ok, rvec, tvec = cv2.solvePnP(obj, img, K, None, flags=cv2.SOLVEPNP_SQPNP)
    if not ok:
        raise ValueError("solvePnP failed")
    R, _ = cv2.Rodrigues(rvec)
    return R, tvec.reshape(3)


def build_screen(width_mm: float, height_mm: float, nx: int, ny: int,
                 curve_mm: float = 0.0) -> np.ndarray:
    """(nx*ny, 3) grid centered at origin. curve_mm bows it along z (a mild
    cylinder) so PnP is non-degenerate; curve_mm=0 gives a flat (planar) wall."""
    xs = np.linspace(-width_mm / 2, width_mm / 2, nx)
    ys = np.linspace(-height_mm / 2, height_mm / 2, ny)
    pts = []
    for y in ys:
        for x in xs:
            z = curve_mm * (1.0 - (x / (width_mm / 2)) ** 2) if width_mm > 0 else 0.0
            pts.append([x, y, z])
    return np.asarray(pts, float)


def camera_ring(distance_mm: float, n: int, span_deg: float,
                target_mm: np.ndarray | None = None) -> list[Pose]:
    target_mm = np.zeros(3) if target_mm is None else target_mm
    angs = np.linspace(-span_deg / 2, span_deg / 2, n) if n > 1 else np.array([0.0])
    poses: list[Pose] = []
    for a in np.deg2rad(angs):
        pos = target_mm + np.array([distance_mm * np.sin(a), 0.0, -distance_mm * np.cos(a)])
        poses.append(look_at_pose(pos, target_mm))
    return poses


def feasibility_rms_mm(*, K: np.ndarray, screen_points_mm: np.ndarray,
                       camera_poses: list[Pose], pixel_sigma: float,
                       nominal_deviation_mm: float = 0.0, focal_err_frac: float = 0.0,
                       trials: int = 50, seed: int = 0) -> dict:
    """Monte-Carlo of the real path: observe (true K + noise) -> estimate poses
    via PnP against nominal (true + deviation) with believed K (true * focal err)
    -> triangulate with estimated poses + believed K -> 3D error vs truth."""
    if len(camera_poses) < 2:
        raise ValueError("feasibility needs >= 2 camera poses")
    rng = np.random.default_rng(seed)
    errs: list[float] = []
    for _ in range(trials):
        nominal = screen_points_mm.copy()
        if nominal_deviation_mm > 0:
            nominal = nominal + rng.normal(0.0, nominal_deviation_mm, nominal.shape)
        Kc = K.copy()
        if focal_err_frac > 0:
            f = K[0, 0] * (1.0 + rng.normal(0.0, focal_err_frac))
            Kc[0, 0] = f
            Kc[1, 1] = f
        obs = []
        for (R, t) in camera_poses:
            view = []
            for X in screen_points_mm:
                p = project_point(K, R, t, X)
                if pixel_sigma > 0:
                    p = p + rng.normal(0.0, pixel_sigma, 2)
                view.append(p)
            obs.append(view)
        try:
            est = [solve_pnp_pose(Kc, nominal, np.asarray(view)) for view in obs]
        except ValueError:
            continue  # degenerate trial; skip
        for i, X in enumerate(screen_points_mm):
            Xhat = triangulate_multiview(Kc, est, [obs[v][i] for v in range(len(est))])
            errs.append(float(np.linalg.norm(Xhat - X)))
    a = np.asarray(errs)
    return {
        "rms_mm": float(np.sqrt((a ** 2).mean())),
        "median_mm": float(np.median(a)),
        "p95_mm": float(np.percentile(a, 95)),
        "n_points": int(len(screen_points_mm)),
        "n_views": int(len(camera_poses)),
    }


def _report() -> None:
    """Operator sweep: edit rig numbers, run `python -m lmt_vba_sidecar.sl_feasibility`.
    Numbers INCLUDE PnP pose error + intrinsic error, so they reflect the real path."""
    K = np.array([[3000.0, 0, 1920.0], [0, 3000.0, 1080.0], [0, 0, 1]], float)
    pts = build_screen(3000.0, 1800.0, 7, 5, curve_mm=30.0)
    print(f"{'dist':>6} {'views':>6} {'span':>5} {'sigma':>6} {'devmm':>6} "
          f"{'fperr':>6} {'rms_mm':>8} {'p95_mm':>8}")
    for dist in (3000.0, 6000.0):
        for span in (25.0, 50.0, 70.0):
            for sigma in (0.1, 0.3):
                for fperr in (0.0, 0.01):
                    s = feasibility_rms_mm(K=K, screen_points_mm=pts,
                                           camera_poses=camera_ring(dist, 5, span),
                                           pixel_sigma=sigma, nominal_deviation_mm=2.0,
                                           focal_err_frac=fperr, trials=30, seed=0)
                    print(f"{dist:6.0f} {5:6d} {span:5.0f} {sigma:6.2f} {2.0:6.1f} "
                          f"{fperr:6.2f} {s['rms_mm']:8.3f} {s['p95_mm']:8.3f}")


if __name__ == "__main__":
    _report()
