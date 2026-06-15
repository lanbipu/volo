"""CLI run-function for the 'simulate' subcommand.

Builds a synthetic Scene from a SimulateInput, saves it as a flat .npz
dataset, and emits a SimulateResultEvent.
"""
from __future__ import annotations

import json
import pathlib

import numpy as np

from lmt_vba_sidecar.io_utils import write_event
from lmt_vba_sidecar.ipc import (
    ErrorEvent,
    SimulateInput,
    SimulateResultData,
    SimulateResultEvent,
)
from lmt_vba_sidecar.simulate import build_scene


def run_simulate(cmd: SimulateInput) -> int:
    if cmd.out_dir is None:
        write_event(ErrorEvent(
            event="error",
            code="invalid_input",
            message="simulate subcommand requires out_dir",
            fatal=True,
        ))
        return 1

    scene = build_scene(cmd)

    out_dir = pathlib.Path(cmd.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    # --- Flatten scene into arrays suitable for np.savez (no pickle). ---
    # Camera arrays
    cam_R = np.stack([R for R, _ in scene.true_camera_poses])   # (n_cam, 3, 3)
    cam_t = np.stack([t for _, t in scene.true_camera_poses])   # (n_cam, 3)

    # Cabinet arrays — use sorted keys to keep deterministic order
    cab_ids_sorted = sorted(scene.true_cabinet_poses.keys())
    cab_ids = np.array(cab_ids_sorted, dtype=np.int64)          # (n_cab,)
    cab_R = np.stack([scene.true_cabinet_poses[j][0] for j in cab_ids_sorted])  # (n_cab,3,3)
    cab_t = np.stack([scene.true_cabinet_poses[j][1] for j in cab_ids_sorted])  # (n_cab,3)

    # Corner arrays — all cabinets share M corners (Phase 0: M=64)
    corners_list = [scene.cabinet_corners_local[j] for j in cab_ids_sorted]
    corners = np.stack(corners_list)  # (n_cab, M, 3)

    # Observation arrays
    obs = scene.observations
    obs_cam = np.array([o.camera_idx for o in obs], dtype=np.int64)      # (N,)
    obs_cab = np.array([o.cabinet_idx for o in obs], dtype=np.int64)     # (N,)
    obs_plocal = np.stack([o.p_local for o in obs]) if obs else np.empty((0, 3))  # (N,3)
    obs_pixel = np.stack([o.pixel for o in obs]) if obs else np.empty((0, 2))     # (N,2)

    np.savez(
        out_dir / "scene.npz",
        K=scene.K,
        cam_R=cam_R,
        cam_t=cam_t,
        cab_ids=cab_ids,
        cab_R=cab_R,
        cab_t=cab_t,
        corners=corners,
        obs_cam=obs_cam,
        obs_cab=obs_cab,
        obs_plocal=obs_plocal,
        obs_pixel=obs_pixel,
    )

    # Small human-readable sidecar with key metadata
    meta = {
        "seed": cmd.seed,
        "n_views": scene.n_cameras,
        "n_cabinets": scene.n_cabinets,
        "cabinet_size_mm": list(cmd.scene.cabinet_array.cabinet_size_mm),
        "method": "simulate",
        # FIX-10a: persist the design so `eval --init cold` can rebuild the
        # nominal model (production init needs it); shape_prior serialises to
        # "flat" or {"curved": {...}}.
        "cols": cmd.scene.cabinet_array.cols,
        "rows": cmd.scene.cabinet_array.rows,
        "shape_prior": cmd.scene.shape_prior if isinstance(cmd.scene.shape_prior, str)
                       else cmd.scene.shape_prior.model_dump(),
        "inter_board_angle_deg": cmd.scene.inter_board_angle_deg,
    }
    # meta.json is informational; non-atomic write is acceptable (scene.npz is the source of truth)
    (out_dir / "meta.json").write_text(json.dumps(meta, indent=2))

    write_event(SimulateResultEvent(
        event="result",
        data=SimulateResultData(
            dataset_dir=str(cmd.out_dir),
            n_views=scene.n_cameras,
            n_observations=len(scene.observations),
            seed=cmd.seed,
        ),
    ))
    return 0
