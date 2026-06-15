"""Step 1: calibrate camera intrinsics from structured-light white dots vs the
nominal design wall (a known 3D target). Solves fx,fy,cx,cy,k1,k2 with
cv2.calibrateCameraExtended and REFUSES on degenerate observability instead of
emitting a confidently-wrong K (spec 2026-05-30-sl-camera-calibration-design)."""
from __future__ import annotations

import hashlib
import json
import pathlib

import numpy as np

from lmt_vba_sidecar.io_utils import write_event
from lmt_vba_sidecar.ipc import (
    BaStats,
    CalibrateStructuredLightInput,
    CorrespondenceFile,
    ErrorEvent,
    ProgressEvent,
    ResultData,
    ResultEvent,
    StructuredLightMeta,
    WarningEvent,
)
from lmt_vba_sidecar.nominal import (
    nominal_cabinet_centers_model_frame,
    nominal_dot_positions_world,
)
from lmt_vba_sidecar.sl_reconstruct import validate_sl_provenance
from lmt_vba_sidecar.calibrate import _atomic_write
from lmt_vba_sidecar.intrinsics_solve import (
    COPLANAR_RATIO_MIN,
    IntrinsicsRefused,
    MIN_DOTS_PER_POSE,
    crosscheck_intrinsics,
    solve_sl_intrinsics,
)

# Gate constants + the observability/quality/covariance solve live in
# intrinsics_solve.solve_sl_intrinsics (shared with reconstruct --intrinsics auto).
# MIN_DOTS_PER_POSE is imported above for the per-pose assembly gate below.


def _err(code: str, msg: str) -> int:
    write_event(ErrorEvent(event="error", code=code, message=msg, fatal=True))
    return 1


def run_calibrate_structured_light(cmd: CalibrateStructuredLightInput) -> int:
    # 1. sl_meta + provenance sha
    meta_path = pathlib.Path(cmd.sl_meta_path)
    try:
        meta = StructuredLightMeta.model_validate_json(meta_path.read_text())
    except (OSError, ValueError) as e:
        return _err("invalid_input", f"sl_meta unreadable: {e}")
    expected_sha = hashlib.sha256(meta_path.read_bytes()).hexdigest()

    # 2. correspondence files + provenance gate (reused from sl_reconstruct)
    corr_files: list[CorrespondenceFile] = []
    for p in cmd.correspondence_paths:
        try:
            corr_files.append(CorrespondenceFile.model_validate_json(pathlib.Path(p).read_text()))
        except (OSError, ValueError) as e:
            return _err("invalid_input", f"correspondence '{p}' unreadable: {e}")
    try:
        validate_sl_provenance(corr_files, expected_sha=expected_sha, expected_screen_id=cmd.project.screen_id)
    except ValueError as e:
        return _err("invalid_input", str(e))

    # 3. same-camera precondition: one camera_image_size across all poses
    sizes = {tuple(int(v) for v in c.camera_image_size) for c in corr_files}
    if len(sizes) != 1:
        return _err("invalid_input", f"correspondences disagree on camera_image_size: {sorted(sizes)}")
    (image_size,) = sizes

    # 4. nominal model (project) + cabinet-set match (mirrors sl_reconstruct,
    #    minus the ROOT_CABINET requirement — calibration has no world-gauge/root
    #    concept; it solves K + per-pose extrinsics). nominal_m.keys() IS the
    #    project present-cell set (nominal.py skips absent_cells), so this ties the
    #    sl_meta universe to the project: a stale sl_meta covering only a SUBSET of
    #    present cells (same screen_id+sha) is rejected instead of silently
    #    calibrating against the wrong cabinet universe.
    try:
        nominal_m = nominal_cabinet_centers_model_frame(cmd.project.cabinet_array, cmd.project.shape_prior)
    except ValueError as e:
        return _err("invalid_input", str(e))
    present = sorted({(c.col, c.row) for c in meta.cabinets}, key=lambda cr: (cr[1], cr[0]))
    if set(present) != set(nominal_m.keys()):
        return _err("invalid_input",
                    f"sl_meta cabinet set {present} != project present cells "
                    f"{sorted(nominal_m.keys())} (stale sl_meta or edited project layout)")

    # 4b. per-dot nominal 3D world (known target). keys() == project present cells.
    try:
        dot_world = nominal_dot_positions_world(meta, cmd.project.cabinet_array, cmd.project.shape_prior)
    except ValueError as e:
        return _err("invalid_input", str(e))

    # 5. assemble per-pose object/image points (canonical (u,v) implicit via dot id)
    write_event(ProgressEvent(event="progress", stage="subpixel_refine", percent=0.3, message="assembling observations"))
    object_points, image_points = [], []
    for cf in corr_files:
        objp, imgp = [], []
        for pt in cf.points:
            X = dot_world.get(int(pt.id))
            if X is None:
                continue
            objp.append(X)
            imgp.append([pt.x, pt.y])
        if len(objp) >= MIN_DOTS_PER_POSE:
            object_points.append(np.asarray(objp, dtype=np.float32))
            image_points.append(np.asarray(imgp, dtype=np.float32))
    if len(object_points) < 1:
        return _err("observability_failed", f"no pose has >= {MIN_DOTS_PER_POSE} dots mapping to nominal")

    # 6-10. coplanarity/coverage/diversity gates + K-solve + covariance gates, all
    #       in the shared pure helper (also used by reconstruct --intrinsics auto).
    write_event(ProgressEvent(event="progress", stage="bundle_adjustment", percent=0.7, message="solving intrinsics"))
    anchor_K = anchor_dist = None
    if cmd.crosscheck_intrinsics_path:
        try:
            anchor = json.loads(pathlib.Path(cmd.crosscheck_intrinsics_path).read_text())
            anchor_K = np.array(anchor["K"], float)
            anchor_dist = np.array(anchor.get("dist_coeffs", [0, 0, 0, 0, 0]), float)
        except (OSError, json.JSONDecodeError, KeyError, ValueError) as e:
            return _err("invalid_input", f"crosscheck intrinsics load failed: {e}")
    try:
        res = solve_sl_intrinsics(object_points, image_points, image_size,
                                  max_rms_px=cmd.max_rms_px,
                                  allow_full_distortion=anchor_K is not None)
    except IntrinsicsRefused as e:
        return _err(e.code, e.message)
    refusal = crosscheck_intrinsics(res, anchor_K=anchor_K, anchor_dist=anchor_dist)
    if refusal is not None:
        return _err(refusal.code, refusal.message)
    if anchor_K is None and res.coplanar_ratio >= COPLANAR_RATIO_MIN:
        write_event(WarningEvent(event="warning", code="no_intrinsics_anchor",
            message="no independent intrinsics anchor; anisotropic pitch/1:1 absorption is "
                    "unguarded — pass --intrinsics-crosscheck <anchor.json> to validate"))
    K, dist, rms = res.K, res.dist, res.rms
    pp_std, foc_std = res.pp_stddev_px, res.focal_stddev_px

    # 11. write intrinsics (5-key contract + provenance)
    payload = json.dumps({
        "K": K.tolist(),
        "dist_coeffs": dist.flatten().tolist(),
        "image_size": list(image_size),
        "reproj_error_px": float(rms),
        "frames_used": len(object_points),
        "calibration_method": "structured_light_nominal",
        "distortion_model": res.distortion_model,
        "pp_stddev_px": list(pp_std),
        "focal_stddev_px": list(foc_std),
        "n_poses": len(object_points),
    }, indent=2)
    _atomic_write(pathlib.Path(cmd.output_path), payload)

    # --- emit result + return 0 --- (mirrors calibrate.py success tail)
    write_event(ResultEvent(
        event="result",
        data=ResultData(
            measured_points=[],
            ba_stats=BaStats(rms_reprojection_px=float(rms), iterations=0, converged=True),
            frame_strategy_used="nominal_anchoring",
            procrustes_align_rms_m=0.0,  # calibrate does no Procrustes
        ),
    ))
    return 0
