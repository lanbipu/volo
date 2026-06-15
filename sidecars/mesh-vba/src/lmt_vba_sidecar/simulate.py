"""Geometric simulator (Level 0A). Builds true cabinet/camera poses and
noisy (cam, cabinet, local_mm, pixel) observations. Validates BA math only
-- NOT a substitute for real capture (no LED bloom/moire/rolling shutter).

Camera pitch must satisfy |pitch| < 90 deg; the look-at basis gimbal-locks
(divide-by-zero) at +/-90 deg. Phase 0 range is +/-20 deg, which is safe."""
from __future__ import annotations
from dataclasses import dataclass
import cv2
import numpy as np
from lmt_vba_sidecar.ipc import SimulateInput
from lmt_vba_sidecar.model_constrained_ba import Observation


@dataclass
class Scene:
    K: np.ndarray
    true_camera_poses: list[tuple[np.ndarray, np.ndarray]]
    true_cabinet_poses: dict[int, tuple[np.ndarray, np.ndarray]]
    cabinet_corners_local: dict[int, np.ndarray]  # idx -> (M,3) mm
    observations: list[Observation]
    n_cameras: int
    n_cabinets: int


def _board_corners_local(w_mm: float, h_mm: float, nx: int = 8, ny: int = 8) -> np.ndarray:
    """Active-surface center as origin; nx*ny inner-corner grid (mimics ChArUco)."""
    xs = (np.arange(nx) - (nx - 1) / 2) / (nx - 1) * w_mm
    ys = (np.arange(ny) - (ny - 1) / 2) / (ny - 1) * h_mm
    gx, gy = np.meshgrid(xs, ys)
    return np.stack([gx.ravel(), gy.ravel(), np.zeros(gx.size)], axis=1)


def build_scene(inp: SimulateInput) -> Scene:
    rng = np.random.default_rng(inp.seed)
    K = np.array(inp.intrinsics.K, float)
    img_w, img_h = (float(v) for v in inp.intrinsics.image_size)
    cab = inp.scene.cabinet_array
    cw, ch = cab.cabinet_size_mm
    n_cab = cab.cols * cab.rows
    pitch_err = inp.noise.pixel_pitch_error_frac

    # Build cabinet poses, row-major j -> (col, row) = (j % cols, j // cols).
    #
    # FIX-10a placement:
    # - inter_board_angle_deg != 0 (flat only): the LEGACY monitor-bench fan —
    #   yaw accumulates per column on a flat position lattice. This is a rig of
    #   separate monitors, not a wall.
    # - otherwise: the wall IS the nominal design — poses straight from
    #   nominal_cabinet_poses_model_frame (y-up model frame, curved = a TRUE
    #   constant-radius arc whose tiles both translate AND tilt). The pre-fix
    #   "curved" stand-in (in-place fan on a flat lattice) had zero center
    #   deflection, which is exactly the artifact the in-place-rotation eval
    #   blind spot grew around.
    ang = np.deg2rad(inp.scene.inter_board_angle_deg)
    if inp.scene.shape_prior != "flat" and ang != 0.0:
        raise ValueError(
            "inter_board_angle_deg is the flat monitor-bench fan; it is mutually "
            "exclusive with a curved shape_prior (the arc defines tile tilt)")
    cabinet_poses: dict[int, tuple[np.ndarray, np.ndarray]] = {}
    corners_local: dict[int, np.ndarray] = {}
    if ang != 0.0:
        for j in range(n_cab):
            col = j % cab.cols
            row = j // cab.cols
            R, _ = cv2.Rodrigues(np.array([0.0, ang * col, 0.0]))
            t = np.array([col * cw, row * ch, 0.0])
            cabinet_poses[j] = (R, t)
    else:
        from lmt_vba_sidecar.nominal import nominal_cabinet_poses_model_frame
        cab_full = cab.model_copy(update={"absent_cells": []})
        poses_cr = nominal_cabinet_poses_model_frame(cab_full, inp.scene.shape_prior)
        for j in range(n_cab):
            R_n, t_m = poses_cr[(j % cab.cols, j // cab.cols)]
            cabinet_poses[j] = (np.asarray(R_n, float), np.asarray(t_m, float) * 1000.0)
        # Re-express into root-cabinet frame so cabinet 0 = (I, 0) — eval's
        # near_truth init and the BA gauge both assume this convention.
        R0, t0 = cabinet_poses[0]
        for j in list(cabinet_poses):
            Rj, tj = cabinet_poses[j]
            cabinet_poses[j] = (R0.T @ Rj, R0.T @ (tj - t0))
    for j in range(n_cab):
        # Apply pixel pitch error as uniform scale on the corner grid
        scale = 1.0 + pitch_err
        corners_local[j] = _board_corners_local(cw * scale, ch * scale)

    def _look_at(cam_pos: np.ndarray, target: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        fwd = target - cam_pos
        fwd = fwd / np.linalg.norm(fwd)
        up = np.array([0.0, 1.0, 0.0])
        right = np.cross(up, fwd)
        right /= np.linalg.norm(right)
        up2 = np.cross(fwd, right)
        R = np.stack([right, up2, fwd])  # world-to-camera rotation
        return R, -R @ cam_pos

    center = np.mean([t for _, t in cabinet_poses.values()], axis=0)
    cams: list[tuple[np.ndarray, np.ndarray]] = []
    if inp.cameras.trajectory == "along_wall":
        # FIX-10a: stations spread along the wall, each aimed at its OWN wall
        # segment (interpolated column center at mid-height) from a standoff
        # along the local surface normal, jittered by the yaw/pitch ranges.
        # Combined with FOV clipping this yields the partial per-view coverage
        # of a real segmented capture (most stations never see the corner
        # cabinet — the FIX-3 init-chaining regime).
        col_centers = []
        col_normals = []
        for col in range(cab.cols):
            rows_j = [row * cab.cols + col for row in range(cab.rows)]
            col_centers.append(np.mean([cabinet_poses[j][1] for j in rows_j], axis=0))
            col_normals.append(cabinet_poses[rows_j[0]][0] @ np.array([0.0, 0.0, 1.0]))
        for vi in range(inp.cameras.n_views):
            frac = vi / max(1, inp.cameras.n_views - 1) * (cab.cols - 1)
            c0 = int(np.floor(frac))
            c1 = min(c0 + 1, cab.cols - 1)
            w1 = frac - c0
            target = (1 - w1) * col_centers[c0] + w1 * col_centers[c1]
            normal = (1 - w1) * col_normals[c0] + w1 * col_normals[c1]
            normal = normal / np.linalg.norm(normal)
            dist = rng.uniform(*inp.cameras.distance_mm_range)
            yaw = np.deg2rad(rng.uniform(*inp.cameras.yaw_deg_range))
            pitch = np.deg2rad(rng.uniform(*inp.cameras.pitch_deg_range))
            Ry, _ = cv2.Rodrigues(np.array([0.0, yaw, 0.0]))
            Rx, _ = cv2.Rodrigues(np.array([pitch, 0.0, 0.0]))
            cam_pos = target + dist * (Ry @ Rx @ normal)
            cams.append(_look_at(cam_pos, target))
    else:
        # "orbit": every camera aims at the centroid of all cabinet positions.
        for _ in range(inp.cameras.n_views):
            dist = rng.uniform(*inp.cameras.distance_mm_range)
            yaw = np.deg2rad(rng.uniform(*inp.cameras.yaw_deg_range))
            pitch = np.deg2rad(rng.uniform(*inp.cameras.pitch_deg_range))
            # Spherical offset from center; cameras look inward
            cam_pos = center + dist * np.array([
                np.sin(yaw) * np.cos(pitch),
                np.sin(pitch),
                -np.cos(yaw) * np.cos(pitch),
            ])
            cams.append(_look_at(cam_pos, center))

    # Generate observations: project each corner through each camera
    obs: list[Observation] = []
    for ci, (Rc, tc) in enumerate(cams):
        for j in range(n_cab):
            Rb, tb = cabinet_poses[j]
            for p in corners_local[j]:
                # Visibility dropout
                if rng.random() > inp.noise.visibility_frac:
                    continue
                xw = Rb @ p + tb
                xc = Rc @ xw + tc
                if xc[2] <= 0:
                    continue
                px = (K @ xc)[:2] / (K @ xc)[2]
                # Gaussian pixel noise
                if inp.noise.pixel_sigma > 0:
                    px = px + rng.normal(0, inp.noise.pixel_sigma, 2)
                # Gross outlier injection
                if inp.noise.outlier_frac > 0 and rng.random() < inp.noise.outlier_frac:
                    px = px + rng.normal(0, 50, 2)
                # FIX-10a: FOV clipping — a real detector only reports in-frame
                # corners (clip the FINAL pixel, after noise/outliers).
                if not (0.0 <= px[0] <= img_w and 0.0 <= px[1] <= img_h):
                    continue
                obs.append(Observation(
                    camera_idx=ci,
                    cabinet_idx=j,
                    p_local=p.copy(),
                    pixel=px,
                ))

    return Scene(
        K=K,
        true_camera_poses=cams,
        true_cabinet_poses=cabinet_poses,
        cabinet_corners_local=corners_local,
        observations=obs,
        n_cameras=len(cams),
        n_cabinets=n_cab,
    )
