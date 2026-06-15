"""Reprojection-error QA report (spec §9.1).

Behind-camera (Z<=0) observations have no valid projection; their error is
non-finite.  They are *excluded* from the reported statistics (which would
otherwise be wrecked by a single such point) and counted separately as
``non_projectable_observations`` so the headline RMS/confidence stay
representative of the inliers (spec §8.4).
"""

from __future__ import annotations

import numpy as np
from numpy.typing import NDArray

from vpcal.core.observations import Observation
from vpcal.core.projection import CameraIntrinsics, project_points
from vpcal.core.transforms import make_transform, stage_to_camera_transform

Array = NDArray[np.float64]

_HIST_EDGES = [0.0, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 999.0]


def per_observation_errors(
    observations: list[Observation],
    intr: CameraIntrinsics,
    tracker_to_stage: tuple[Array, Array],
    camera_from_tracker: tuple[Array, Array],
) -> Array:
    """Return the reprojection error (px) per observation.

    Non-projectable (Z<=0) observations yield a non-finite (inf/NaN) error; the
    caller is responsible for excluding them from statistics.
    """
    T_S = make_transform(np.asarray(tracker_to_stage[0]), np.asarray(tracker_to_stage[1]))
    T_C = make_transform(np.asarray(camera_from_tracker[0]), np.asarray(camera_from_tracker[1]))
    errors = np.zeros(len(observations))
    by_frame: dict[int, list[int]] = {}
    for i, o in enumerate(observations):
        by_frame.setdefault(o.frame_id, []).append(i)
    for idxs in by_frame.values():
        o0 = observations[idxs[0]]
        T_sdk = make_transform(np.asarray(o0.track_q), np.asarray(o0.track_t))
        T_C_from_S = stage_to_camera_transform(T_S, T_sdk, T_C)
        world = np.array([observations[i].world_rh for i in idxs])
        cam = world @ T_C_from_S[:3, :3].T + T_C_from_S[:3, 3]
        pred = project_points(cam, intr)
        detected = np.array([[observations[i].pixel_u, observations[i].pixel_v] for i in idxs])
        for k, i in enumerate(idxs):
            errors[i] = float(np.linalg.norm(pred[k] - detected[k]))
    return errors


def _lens_residual_check(observations: list[Observation], errors: Array, intr: CameraIntrinsics) -> dict:
    """Detect a systematic radial residual pattern (edge >> centre → bad lens).

    Operates only on finite-error observations; returns the default verdict when
    too few are available.
    """
    default = {"radial_pattern_detected": False, "description": "no systematic radial residual pattern detected"}
    radii = np.array([np.hypot(o.pixel_u - intr.cx, o.pixel_v - intr.cy) for o in observations])
    finite = np.isfinite(errors)
    r_all, e_all = radii[finite], errors[finite]
    if e_all.size < 20:
        return default
    inliers = e_all < (np.median(e_all) + 5 * (np.std(e_all) or 1.0))
    r, e = r_all[inliers], e_all[inliers]
    if r.std() <= 0 or e.std() <= 0:
        return default
    corr = float(np.corrcoef(r, e)[0, 1])
    mid = np.median(r)
    edge_mean = e[r > mid].mean() if (r > mid).any() else 0.0
    center_mean = e[r <= mid].mean() if (r <= mid).any() else 0.0
    if corr > 0.5 and edge_mean > 2.0 * max(center_mean, 1e-6):
        return {
            "radial_pattern_detected": True,
            "description": (
                f"radial residual grows toward the edge (corr={corr:.2f}, "
                f"edge {edge_mean:.2f}px vs centre {center_mean:.2f}px); "
                "lens distortion parameters may be inaccurate"
            ),
        }
    return default


def _quality_label(rms: float) -> str:
    if rms < 0.5:
        return "good"
    if rms < 1.5:
        return "fair"
    return "poor"


def _rms(values: Array) -> float:
    return float(np.sqrt(np.mean(values**2))) if values.size else 0.0


def reprojection_report(
    observations: list[Observation],
    intr: CameraIntrinsics,
    tracker_to_stage: tuple[Array, Array],
    camera_from_tracker: tuple[Array, Array],
    *,
    per_marker: bool = False,
) -> dict:
    """Build the reprojection QA report (spec §9.1)."""
    errors = per_observation_errors(observations, intr, tracker_to_stage, camera_from_tracker)
    finite = np.isfinite(errors)
    valid = errors[finite]

    report: dict = {
        "global_rms_px": _rms(valid),
        "global_mean_px": float(np.mean(valid)) if valid.size else 0.0,
        "global_max_px": float(np.max(valid)) if valid.size else 0.0,
        "non_projectable_observations": int((~finite).sum()),
    }

    per_pose = []
    by_frame: dict[int, list[int]] = {}
    for i, o in enumerate(observations):
        by_frame.setdefault(o.frame_id, []).append(i)
    for fid in sorted(by_frame):
        e = errors[by_frame[fid]]
        ef = e[np.isfinite(e)]
        rms = _rms(ef)
        per_pose.append(
            {"frame_id": fid, "rms_px": rms, "num_observations": int(ef.size), "quality": _quality_label(rms)}
        )
    report["per_pose"] = per_pose

    report["per_marker_summary"] = {
        "total_markers": len({o.marker_id for o in observations if o.marker_id is not None}),
        "mean_error_px": float(np.mean(valid)) if valid.size else 0.0,
        "enabled": per_marker,
    }
    if per_marker:
        per_m: dict = {}
        for o, e in zip(observations, errors):
            if o.marker_id is None or not np.isfinite(e):
                continue
            per_m.setdefault(str(o.marker_id.to_dict()), []).append(float(e))
        report["per_marker"] = {k: {"mean_px": float(np.mean(v)), "count": len(v)} for k, v in per_m.items()}

    # Worst finite-error observations (behind-camera ones are counted above).
    finite_idx = np.where(finite)[0]
    order = finite_idx[np.argsort(errors[finite_idx])[::-1][:10]]
    report["outliers_top10"] = [
        {
            "frame_id": observations[i].frame_id,
            "marker_id": observations[i].marker_id.to_dict() if observations[i].marker_id else None,
            "error_px": float(errors[i]),
            "pixel_detected": [observations[i].pixel_u, observations[i].pixel_v],
        }
        for i in order
    ]

    counts, _ = np.histogram(valid, bins=_HIST_EDGES)
    report["error_histogram"] = {"bin_edges_px": _HIST_EDGES, "counts": [int(c) for c in counts]}
    report["lens_residual_check"] = _lens_residual_check(observations, errors, intr)
    return report
