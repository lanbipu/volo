"""Coverage QA report (spec §9.2): sensor, screen, and pose distribution."""

from __future__ import annotations

import numpy as np
from numpy.typing import NDArray

from vpcal.core.observations import Observation
from vpcal.core.projection import CameraIntrinsics
from vpcal.core.screen_geometry import enumerate_markers
from vpcal.core.transforms import quat_to_matrix
from vpcal.models.screen import ScreenDefinition

Array = NDArray[np.float64]


def _sensor_coverage(observations: list[Observation], intr: CameraIntrinsics) -> dict:
    w, h = intr.image_size
    grid = np.zeros((3, 3), dtype=bool)
    for o in observations:
        c = min(2, max(0, int(o.pixel_u / w * 3)))
        r = min(2, max(0, int(o.pixel_v / h * 3)))
        grid[r, c] = True
    return {
        "percentage": float(grid.sum() / 9.0),
        "regions": {
            "center": bool(grid[1, 1]),
            "top_left": bool(grid[0, 0]),
            "top_right": bool(grid[0, 2]),
            "bottom_left": bool(grid[2, 0]),
            "bottom_right": bool(grid[2, 2]),
        },
    }


def _screen_coverage(
    observations: list[Observation], screen: ScreenDefinition, markers_per_cabinet: int
) -> dict:
    all_markers = enumerate_markers(screen, markers_per_cabinet=markers_per_cabinet)
    section_total: dict[str, set] = {}
    id_to_section: dict = {}
    for m in all_markers:
        section_total.setdefault(m.section_name, set()).add(m.marker_id)
        id_to_section[m.marker_id] = m.section_name
    observed_by_section: dict[str, set] = {name: set() for name in section_total}
    for o in observations:
        if o.marker_id is not None and o.marker_id in id_to_section:
            observed_by_section[id_to_section[o.marker_id]].add(o.marker_id)
    per_section = []
    total = sum(len(v) for v in section_total.values())
    observed = 0
    for name, ids in section_total.items():
        obs_n = len(observed_by_section[name])
        observed += obs_n
        per_section.append({"name": name, "percentage": float(obs_n / max(len(ids), 1))})
    return {
        "percentage": float(observed / max(total, 1)),
        "per_section": per_section,
    }


def _pose_distribution(tracker_poses: list[tuple[Array, Array]]) -> dict:
    pts = np.array([t for (_q, t) in tracker_poses])
    spatial = float(np.linalg.norm(pts.max(axis=0) - pts.min(axis=0))) if len(pts) else 0.0
    forwards = np.array([quat_to_matrix(q)[:, 0] for (q, _t) in tracker_poses])
    angular = 0.0
    if len(forwards) > 1:
        cos = np.clip(forwards @ forwards.T, -1, 1)
        angular = float(np.degrees(np.arccos(cos.min())))
    return {
        "num_poses": len(tracker_poses),
        "spatial_spread_mm": spatial,
        "angular_spread_deg": angular,
    }


def _marker_map_coverage(observations: list[Observation], marker_map) -> dict:
    """Per-marker coverage against a surveyed marker map (AR path).

    Counts detectable map markers that produced at least one observation;
    ``missing`` lists the never-observed ones (plan A2 coverage requirement).
    """
    from vpcal.core.observations import PhysicalMarkerId

    detectable = {m.marker_id for m in marker_map.detectable_markers()}
    observed = {
        o.marker_id.marker
        for o in observations
        if isinstance(o.marker_id, PhysicalMarkerId)
    }
    missing = sorted(detectable - observed)
    return {
        "percentage": float(len(detectable & observed) / max(len(detectable), 1)),
        "total_markers": len(detectable),
        "observed_markers": len(detectable & observed),
        "missing": missing,
    }


def coverage_report(
    observations: list[Observation],
    intr: CameraIntrinsics,
    screen: ScreenDefinition | None,
    tracker_poses: list[tuple[Array, Array]],
    *,
    markers_per_cabinet: int | None = None,
    marker_map=None,
) -> dict:
    """Build the coverage QA report (spec §9.2).

    Exactly one of ``screen`` / ``marker_map`` is expected: the screen path
    reports per-section screen coverage, the marker-map path (AR) reports
    per-marker coverage.
    """
    report = {
        "sensor_coverage": _sensor_coverage(observations, intr),
        "pose_distribution": _pose_distribution(tracker_poses),
    }
    if screen is not None:
        mpc = markers_per_cabinet if markers_per_cabinet is not None else screen.markers_per_cabinet
        report["screen_coverage"] = _screen_coverage(observations, screen, mpc)
    if marker_map is not None:
        report["marker_coverage"] = _marker_map_coverage(observations, marker_map)
    return report
