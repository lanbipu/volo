"""CLI run-function for the 'eval' subcommand.

Loads a saved scene.npz dataset, reconstructs the Scene object, runs a
reconstruction method via eval_runner.run_method, and emits an EvalResultEvent.
"""
from __future__ import annotations

import json
import pathlib

import numpy as np

from lmt_vba_sidecar.io_utils import write_event
from lmt_vba_sidecar.ipc import (
    ErrorEvent,
    EvalInput,
    EvalResultData,
    EvalResultEvent,
)
from lmt_vba_sidecar.simulate import Scene
from lmt_vba_sidecar.model_constrained_ba import Observation
from lmt_vba_sidecar.eval_runner import run_method


def run_eval(cmd: EvalInput) -> int:
    npz_path = pathlib.Path(cmd.dataset_dir) / "scene.npz"
    if not npz_path.exists():
        write_event(ErrorEvent(
            event="error",
            code="invalid_input",
            message=f"dataset not found: {npz_path}",
            fatal=True,
        ))
        return 1

    data = np.load(npz_path, allow_pickle=False)

    # Rebuild camera poses: list of (R, t) tuples
    cam_R = data["cam_R"]   # (n_cam, 3, 3)
    cam_t = data["cam_t"]   # (n_cam, 3)
    true_camera_poses = [(cam_R[i], cam_t[i]) for i in range(len(cam_R))]

    # Rebuild cabinet poses: dict int -> (R, t)
    cab_ids = data["cab_ids"].tolist()   # list[int] (use int() keys for dict)
    cab_R = data["cab_R"]
    cab_t = data["cab_t"]
    true_cabinet_poses = {int(cab_ids[i]): (cab_R[i], cab_t[i]) for i in range(len(cab_ids))}

    # Rebuild cabinet corners: dict int -> (M,3)
    corners = data["corners"]   # (n_cab, M, 3)
    cabinet_corners_local = {int(cab_ids[i]): corners[i] for i in range(len(cab_ids))}

    # Rebuild observations list
    obs_cam = data["obs_cam"]
    obs_cab = data["obs_cab"]
    obs_plocal = data["obs_plocal"]
    obs_pixel = data["obs_pixel"]
    observations = [
        Observation(
            camera_idx=int(obs_cam[i]),
            cabinet_idx=int(obs_cab[i]),
            p_local=obs_plocal[i],
            pixel=obs_pixel[i],
        )
        for i in range(len(obs_cam))
    ]

    scene = Scene(
        K=data["K"],
        true_camera_poses=true_camera_poses,
        true_cabinet_poses=true_cabinet_poses,
        cabinet_corners_local=cabinet_corners_local,
        observations=observations,
        n_cameras=len(true_camera_poses),
        n_cabinets=len(cab_ids),
    )

    # FIX-10a: cold init needs the design (cols/rows/shape_prior) persisted by
    # simulate in meta.json. Missing/legacy meta -> run_method raises the
    # explanatory ValueError below (mapped to invalid_input).
    design = None
    meta_doc: dict = {}
    meta_path = pathlib.Path(cmd.dataset_dir) / "meta.json"
    try:
        meta_doc = json.loads(meta_path.read_text())
    except (OSError, ValueError):
        pass
    if {"cols", "rows", "shape_prior", "cabinet_size_mm"} <= set(meta_doc):
        from lmt_vba_sidecar.ipc import CabinetArray
        design = (
            CabinetArray(cols=int(meta_doc["cols"]), rows=int(meta_doc["rows"]),
                         cabinet_size_mm=list(meta_doc["cabinet_size_mm"])),
            meta_doc["shape_prior"],
        )

    try:
        metrics = run_method(scene, cmd.method, init=cmd.init, design=design)
    except ValueError as exc:
        # Unimplemented-but-enum-valid methods (e.g. structured_light) raise
        # ValueError in run_method; surface as invalid_input, not internal_error.
        write_event(ErrorEvent(
            event="error",
            code="invalid_input",
            message=str(exc),
            fatal=True,
        ))
        return 1

    # FIX-9: report the seed of the dataset ACTUALLY evaluated (one saved
    # scene), read from the dataset's meta.json — not an echo of the requested
    # seed_matrix (which claimed multi-seed coverage that never ran).
    seeds: list[int] = []
    if "seed" in meta_doc:
        seeds = [int(meta_doc["seed"])]  # legacy dataset without meta.json: [] (unknown)

    write_event(EvalResultEvent(
        event="result",
        data=EvalResultData(
            method=cmd.method,
            seeds=seeds,
            max_size_error_mm=metrics["max_size_error_mm"],
            rms_size_error_mm=metrics["rms_size_error_mm"],
            max_distance_error_mm=metrics["max_distance_error_mm"],
            max_angle_error_deg=metrics["max_angle_error_deg"],
            holdout_rms_mm=metrics["holdout_rms_mm"],
            holdout_p95_mm=metrics["holdout_p95_mm"],
            holdout_max_mm=metrics["holdout_max_mm"],
        ),
    ))
    return 0
