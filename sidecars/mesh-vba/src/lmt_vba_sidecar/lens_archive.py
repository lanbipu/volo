"""Archive a reconstruction self-calibrated lens as a vpcal master-lens file.

The reconstruct self-calibration (``--intrinsics auto``) solves a full-distortion
K when the capture is diverse enough (decision A). When that solve also clears the
vpcal master-lens qualification bar, we persist it in the flat vpcal format so a
fixed-camera calibration can reuse it as a Master Lens WITHOUT a separate offline
chart shoot (the product's single-camera auto-loop). Qualification口径 mirrors the
authoritative vpcal gate (``sidecars/vpcal/src/vpcal/cli/tracker_free.py``).

This module carries its own atomic-write (tmp + os.replace) so it never imports
reconstruct (which imports this) — avoids an import cycle.
"""
from __future__ import annotations

import json
import math
import os
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone

import numpy as np

from lmt_vba_sidecar.intrinsics_solve import IntrinsicsResult
from lmt_vba_sidecar.ipc import MasterLensSummary

MASTER_LENS_SOURCE = "reconstruction_self_calibration"

# vpcal master-lens qualification bar (口径对齐 tracker_free.py:116-139).
MIN_NUM_IMAGES = 8   # distinct view/photo count (NOT view×cabinet poses)
MIN_NUM_POINTS = 60
MAX_RMS_PX = 2.0


@dataclass
class SelfCalInfo:
    res: IntrinsicsResult
    num_images: int          # distinct photos/views the surviving poses cover
    num_points: int          # total correspondence points over surviving poses
    image_size: tuple[int, int]
    view_axis_deg: float
    standoff_ratio: float | None
    diversity_ok: bool
    has_anchor: bool


def master_lens_qualification_reasons(info: SelfCalInfo) -> list[str]:
    """Reasons the self-cal does NOT qualify as a vpcal master lens (empty = OK)."""
    reasons: list[str] = []
    if info.num_images < MIN_NUM_IMAGES:
        reasons.append(f"num_images {info.num_images} < {MIN_NUM_IMAGES}")
    if info.num_points < MIN_NUM_POINTS:
        reasons.append(f"num_points {info.num_points} < {MIN_NUM_POINTS}")
    rms = float(info.res.rms)
    if not math.isfinite(rms) or rms >= MAX_RMS_PX:
        reasons.append(f"lens RMS {rms:.3f}px must be < {MAX_RMS_PX}px")
    w, h = int(info.image_size[0]), int(info.image_size[1])
    if not (w > 0 and h > 0):
        reasons.append(f"image_size {info.image_size} must be positive on both axes")
    if not info.diversity_ok:
        span = info.view_axis_deg
        reasons.append(f"weak per-board diversity (view-axis span {span:.1f}° < 15°)")
    return reasons


def archive_master_lens(info: SelfCalInfo, out_path: str) -> MasterLensSummary:
    """Write ``info`` to ``out_path`` as a vpcal master-lens JSON when it qualifies.

    Returns a MasterLensSummary describing the outcome. Never raises: a
    qualification failure returns ``archived=False`` with reasons (no write); an
    OSError on write returns ``archived=False`` with a "write failed" reason — a
    reconstruction must never be dragged down by archival.
    """
    reasons = master_lens_qualification_reasons(info)
    fx = float(info.res.K[0, 0])
    fy = float(info.res.K[1, 1])
    cx = float(info.res.K[0, 2])
    cy = float(info.res.K[1, 2])
    model = info.res.distortion_model
    rms = float(info.res.rms)
    if reasons:
        return MasterLensSummary(
            archived=False, reason="; ".join(reasons),
            distortion_model=model, rms=rms,
            num_images=info.num_images, num_points=info.num_points)

    # OpenCV order k1,k2,p1,p2,k3; pad to 5 (zero_dist / radial2 supply fewer).
    dist = np.asarray(info.res.dist, dtype=float).flatten()[:5]
    dist_coeffs = dist.tolist() + [0.0] * (5 - len(dist))

    payload = {
        "fx": fx, "fy": fy, "cx": cx, "cy": cy,
        "dist_coeffs": dist_coeffs,
        "rms": rms,
        "num_images": info.num_images,
        "num_points": info.num_points,
        "image_size": [int(info.image_size[0]), int(info.image_size[1])],
        "calibration_kind": "multi_view_intrinsics",
        "is_master": True,
        "session_coupled": False,
        "calibrated_at": datetime.now(timezone.utc).isoformat(),
        "source": MASTER_LENS_SOURCE,
        "note": "auto-archived from visual reconstruction self-calibration",
    }
    try:
        directory = os.path.dirname(os.path.abspath(out_path)) or "."
        os.makedirs(directory, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=directory, suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(payload, f, indent=2)
            os.replace(tmp, out_path)
        except BaseException:
            if os.path.exists(tmp):
                os.remove(tmp)
            raise
    except OSError as e:
        return MasterLensSummary(
            archived=False, reason=f"write failed: {e}",
            distortion_model=model, rms=rms,
            num_images=info.num_images, num_points=info.num_points)

    return MasterLensSummary(
        archived=True, path=out_path,
        distortion_model=model, rms=rms,
        num_images=info.num_images, num_points=info.num_points)
