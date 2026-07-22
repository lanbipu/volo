"""Cabinet-grid wireframe projection for AR overlay (fixed + live).

Generates Stage-frame cabinet outlines (outer frame + seams + optional corner
markers) from :class:`~vpcal.models.screen.ScreenDefinition`, projects them
through an OpenCV ``T_C_from_S`` + :class:`~vpcal.core.projection.CameraIntrinsics`,
and returns normalised (0–1) 2D segments for the frontend canvas.
"""

from __future__ import annotations

from typing import Any, Iterable, Sequence

import numpy as np
from numpy.typing import NDArray

from vpcal.core.projection import CameraIntrinsics, project_points
from vpcal.core.screen_geometry import enumerate_markers, section_grid
from vpcal.core.transforms import apply_transform
from vpcal.models.screen import ArcSection, ScreenDefinition

Array = NDArray[np.float64]

# Samples along U for arc horizontal seams (plane seams use 2 endpoints).
_ARC_U_SAMPLES = 24
# Margin outside the image (normalised) before a segment is discarded entirely.
_CLIP_MARGIN = 0.05


def cabinet_grid_polylines(
    screen: ScreenDefinition,
    *,
    include_markers: bool = True,
    markers_per_cabinet: int | None = None,
) -> tuple[list[Array], list[Array]]:
    """Return Stage-frame polylines and optional marker points for one screen.

    Each polyline is ``(K, 3)`` in the same Stage/UE frame as
    ``section.uv_to_world`` (matching tracker-free solvePnP object points).
    Markers are cabinet-corner UV samples plus cell-centred pattern markers.
    """
    polylines: list[Array] = []
    markers: list[Array] = []
    mpc = markers_per_cabinet if markers_per_cabinet is not None else screen.markers_per_cabinet

    for section in screen.sections:
        n_rows, n_cols = section_grid(screen, section)
        is_arc = isinstance(section, ArcSection)
        u_samples = _ARC_U_SAMPLES if is_arc else 2

        # Vertical seams (constant u): straight generators even on arcs.
        for i in range(n_cols + 1):
            u = i / n_cols
            pts = np.array(
                [section.uv_to_world(u, v) for v in (0.0, 1.0)],
                dtype=np.float64,
            )
            polylines.append(pts)

        # Horizontal seams (constant v): sample along u for arcs.
        us = np.linspace(0.0, 1.0, u_samples)
        for j in range(n_rows + 1):
            v = j / n_rows
            pts = np.array(
                [section.uv_to_world(float(u), v) for u in us],
                dtype=np.float64,
            )
            polylines.append(pts)

        if include_markers:
            for i in range(n_cols + 1):
                for j in range(n_rows + 1):
                    markers.append(
                        np.asarray(
                            section.uv_to_world(i / n_cols, j / n_rows),
                            dtype=np.float64,
                        )
                    )

    if include_markers:
        for m in enumerate_markers(screen, markers_per_cabinet=mpc):
            markers.append(np.asarray(m.world, dtype=np.float64))

    return polylines, markers


def screen_perimeter_polylines(screen: ScreenDefinition) -> list[Array]:
    """Return each section's true perspective perimeter as one closed polyline."""
    out: list[Array] = []
    for section in screen.sections:
        samples = _ARC_U_SAMPLES if isinstance(section, ArcSection) else 2
        top_u = np.linspace(0.0, 1.0, samples)
        bottom_u = np.linspace(1.0, 0.0, samples)
        points = [section.uv_to_world(0.0, 0.0), section.uv_to_world(0.0, 1.0)]
        points.extend(section.uv_to_world(float(u), 1.0) for u in top_u[1:])
        points.append(section.uv_to_world(1.0, 0.0))
        points.extend(section.uv_to_world(float(u), 0.0) for u in bottom_u[1:])
        out.append(np.asarray(points, dtype=np.float64))
    return out


def opencv_T_from_stage_pose(pose: dict[str, Any]) -> Array:
    """Convert tracker-free ``stage_pose.json`` Volo matrix → OpenCV ``T_C_from_S``.

    The pose CLI stores ``camera_from_stage.matrix_4x4`` as Stage←VoloCamera
    (Three.js Y-up / −Z forward).  Projection uses OpenCV camera (+Y down, +Z
    forward), so undo the Volo basis flip before inverting to camera←Stage.
    """
    cam = pose.get("camera_from_stage") or {}
    M = np.asarray(cam["matrix_4x4"], dtype=np.float64)
    if M.shape != (4, 4):
        raise ValueError(f"camera_from_stage.matrix_4x4 must be 4x4, got {M.shape}")
    cv_from_volo = np.diag([1.0, -1.0, -1.0])
    R_stage_from_cv = M[:3, :3] @ cv_from_volo
    t_cam_in_stage = M[:3, 3]
    R_cv_from_stage = R_stage_from_cv.T
    t_cv_from_stage = -R_cv_from_stage @ t_cam_in_stage
    T = np.eye(4, dtype=np.float64)
    T[:3, :3] = R_cv_from_stage
    T[:3, 3] = t_cv_from_stage
    return T


def _clip_segment_norm(
    a: Array, b: Array, *, margin: float = _CLIP_MARGIN
) -> Array | None:
    """Liang-Barsky clip of a normalised segment to ``[-margin, 1+margin]²``."""
    x0, y0 = float(a[0]), float(a[1])
    x1, y1 = float(b[0]), float(b[1])
    dx, dy = x1 - x0, y1 - y0
    lo, hi = -margin, 1.0 + margin
    u0, u1 = 0.0, 1.0
    for p, q in (
        (-dx, x0 - lo),
        (dx, hi - x0),
        (-dy, y0 - lo),
        (dy, hi - y0),
    ):
        if abs(p) < 1e-12:
            if q < 0:
                return None
            continue
        r = q / p
        if p < 0:
            if r > u1:
                return None
            if r > u0:
                u0 = r
        else:
            if r < u0:
                return None
            if r < u1:
                u1 = r
    return np.array(
        [[x0 + u0 * dx, y0 + u0 * dy], [x0 + u1 * dx, y0 + u1 * dy]],
        dtype=np.float64,
    )


def _project_polyline_norm(
    points_stage: Array,
    T_C_from_S: Array,
    intr: CameraIntrinsics,
    width: float,
    height: float,
) -> list[list[float]]:
    """Project a Stage polyline → clipped normalised 2-point segments."""
    if len(points_stage) < 2:
        return []
    cam = apply_transform(T_C_from_S, points_stage)
    z = cam[:, 2]
    px = project_points(cam, intr)
    finite = np.isfinite(px).all(axis=1) & (z > 1.0)
    segments: list[list[float]] = []
    for i in range(len(px) - 1):
        if not (finite[i] and finite[i + 1]):
            continue
        a = px[i] / np.array([width, height], dtype=np.float64)
        b = px[i + 1] / np.array([width, height], dtype=np.float64)
        clipped = _clip_segment_norm(a, b)
        if clipped is None:
            continue
        segments.append(
            [
                float(clipped[0, 0]),
                float(clipped[0, 1]),
                float(clipped[1, 0]),
                float(clipped[1, 1]),
            ]
        )
    return segments


def _project_markers_norm(
    markers_stage: Sequence[Array],
    T_C_from_S: Array,
    intr: CameraIntrinsics,
    width: float,
    height: float,
) -> list[list[float]]:
    if not markers_stage:
        return []
    pts = np.asarray(markers_stage, dtype=np.float64)
    cam = apply_transform(T_C_from_S, pts)
    px = project_points(cam, intr)
    out: list[list[float]] = []
    for i, p in enumerate(px):
        if cam[i, 2] <= 1.0 or not np.all(np.isfinite(p)):
            continue
        x, y = float(p[0] / width), float(p[1] / height)
        if -_CLIP_MARGIN <= x <= 1.0 + _CLIP_MARGIN and -_CLIP_MARGIN <= y <= 1.0 + _CLIP_MARGIN:
            out.append([x, y])
    return out


def project_screen_grid(
    screen: ScreenDefinition,
    T_C_from_S: Array,
    intr: CameraIntrinsics,
    *,
    label: str | None = None,
    include_markers: bool = True,
    world_transform: Array | None = None,
) -> dict[str, Any]:
    """Project one screen's cabinet grid to normalised 2D segments/markers."""
    polylines, markers = cabinet_grid_polylines(screen, include_markers=include_markers)
    perimeter_polylines = screen_perimeter_polylines(screen)
    if world_transform is not None:
        R = world_transform[:3, :3] if world_transform.shape == (4, 4) else world_transform
        polylines = [p @ R.T for p in polylines]
        perimeter_polylines = [p @ R.T for p in perimeter_polylines]
        markers = [R @ m for m in markers]
    width, height = intr.image_size
    if width <= 0 or height <= 0:
        raise ValueError("CameraIntrinsics must have positive image size for grid overlay")
    segments: list[list[float]] = []
    for pl in polylines:
        segments.extend(_project_polyline_norm(pl, T_C_from_S, intr, width, height))
    perimeter: list[list[float]] = []
    for polyline in perimeter_polylines:
        perimeter.extend(_project_polyline_norm(polyline, T_C_from_S, intr, width, height))
    marker_pts = _project_markers_norm(markers, T_C_from_S, intr, width, height)
    return {
        "label": label or screen.name,
        "segments": segments,
        "perimeter": perimeter,
        "markers": marker_pts,
    }


def project_grid_overlay(
    screens: Iterable[tuple[str, ScreenDefinition]],
    T_C_from_S: Array,
    intr: CameraIntrinsics,
    *,
    include_markers: bool = True,
    world_transform: Array | None = None,
) -> dict[str, Any]:
    """Project multiple labelled screens → overlay JSON envelope body."""
    width, height = intr.image_size
    screen_payloads = [
        project_screen_grid(
            screen,
            T_C_from_S,
            intr,
            label=label,
            include_markers=include_markers,
            world_transform=world_transform,
        )
        for label, screen in screens
    ]
    return {
        "screens": screen_payloads,
        "image_size": [int(round(width)), int(round(height))],
    }


__all__ = [
    "cabinet_grid_polylines",
    "opencv_T_from_stage_pose",
    "project_grid_overlay",
    "project_screen_grid",
    "screen_perimeter_polylines",
]
