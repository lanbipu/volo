"""Screen definition I/O: JSON read/write + OBJ mesh import (spec §4.1.3).

JSON is the canonical on-disk format.  OBJ import fits each mesh group to a
``plane`` or ``arc`` section; ``cabinet_size`` and ``led_pixel_pitch_mm`` cannot
be expressed in OBJ and must be supplied by the caller.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from numpy.typing import NDArray

from vpcal.core.errors import ArgumentError, ResourceNotFoundError
from vpcal.core.transforms import matrix_to_quat
from vpcal.models.screen import ArcSection, PlaneSection, ScreenDefinition

# Max distance (as a fraction of the larger extent) for a group to count as planar.
_PLANARITY_TOL = 0.02


def load_screen(path: str | Path) -> ScreenDefinition:
    """Load a screen definition from a JSON file."""
    p = Path(path)
    if not p.exists():
        raise ResourceNotFoundError(f"screen definition not found: {p}", details={"path": str(p)})
    try:
        data = json.loads(p.read_text())
    except json.JSONDecodeError as exc:
        raise ArgumentError(f"invalid screen JSON: {exc}", details={"path": str(p)}) from exc
    return ScreenDefinition.model_validate(data)


def save_screen(screen: ScreenDefinition, path: str | Path) -> None:
    """Write a screen definition to a JSON file (pretty-printed)."""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(screen.model_dump(mode="json"), indent=2, ensure_ascii=False))


# ── OBJ parsing ──────────────────────────────────────────────────────


def _parse_obj_groups(text: str) -> dict[str, NDArray[np.float64]]:
    """Parse an OBJ into ``{group_name: (M, 3) vertices}``.

    Vertices are assigned to the group active at their declaration; vertices
    referenced by a group's faces are also included.
    """
    all_verts: list[list[float]] = []
    group_vert_idx: dict[str, set[int]] = {}
    current = "default"
    group_vert_idx.setdefault(current, set())
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        tag = parts[0]
        if tag in ("g", "o"):
            current = parts[1] if len(parts) > 1 else "default"
            group_vert_idx.setdefault(current, set())
        elif tag == "v":
            idx = len(all_verts)
            all_verts.append([float(parts[1]), float(parts[2]), float(parts[3])])
            group_vert_idx[current].add(idx)
        elif tag == "f":
            for tok in parts[1:]:
                vi = int(tok.split("/")[0])
                vi = vi - 1 if vi > 0 else len(all_verts) + vi
                group_vert_idx[current].add(vi)
    verts = np.asarray(all_verts, dtype=np.float64)
    out: dict[str, NDArray[np.float64]] = {}
    for name, idxs in group_vert_idx.items():
        if idxs:
            out[name] = verts[sorted(idxs)]
    return out


def _fit_plane_section(name: str, verts: NDArray[np.float64]) -> tuple[PlaneSection, float]:
    """Fit a plane section to vertices; return (section, max planarity residual)."""
    centroid = verts.mean(axis=0)
    centred = verts - centroid
    _, _, vt = np.linalg.svd(centred, full_matrices=False)
    normal = vt[2]
    residual = float(np.max(np.abs(centred @ normal)))
    # In-plane axes: pick the one most vertical as height (z/v), the other as width (u).
    a1, a2 = vt[0], vt[1]
    up = np.array([0.0, 0.0, 1.0])
    z_axis = a1 if abs(a1 @ up) >= abs(a2 @ up) else a2
    x_axis = a2 if z_axis is a1 else a1
    if z_axis @ up < 0:
        z_axis = -z_axis
    x_axis = x_axis - (x_axis @ z_axis) * z_axis
    x_axis = x_axis / np.linalg.norm(x_axis)
    n_axis = np.cross(z_axis, x_axis)
    proj_x = centred @ x_axis
    proj_z = centred @ z_axis
    width = float(proj_x.max() - proj_x.min())
    height = float(proj_z.max() - proj_z.min())
    R = np.column_stack([x_axis, n_axis, z_axis])
    if np.linalg.det(R) < 0:
        n_axis = -n_axis
        R = np.column_stack([x_axis, n_axis, z_axis])
    quat = matrix_to_quat(R)
    origin = centroid - z_axis * (height / 2.0)
    section = PlaneSection(
        name=name,
        origin=[float(v) for v in origin],
        rotation=[float(v) for v in quat],
        width_mm=max(width, 1e-6),
        height_mm=max(height, 1e-6),
    )
    return section, residual


def _fit_arc_section(name: str, verts: NDArray[np.float64]) -> ArcSection:
    """Fit a vertical cylindrical arc (Z-up, no tilt) to vertices."""
    x, y, z = verts[:, 0], verts[:, 1], verts[:, 2]
    # Algebraic circle fit in XY: minimise |A·[cx,cy,c] - b|.
    A = np.column_stack([2 * x, 2 * y, np.ones_like(x)])
    b = x * x + y * y
    sol, *_ = np.linalg.lstsq(A, b, rcond=None)
    cx, cy, c = sol
    radius = float(np.sqrt(c + cx * cx + cy * cy))
    angles = np.degrees(np.arctan2(y - cy, x - cx))
    angles_sorted = np.sort(angles)
    # Largest gap → the arc spans the complement of that gap.
    gaps = np.diff(np.concatenate([angles_sorted, [angles_sorted[0] + 360.0]]))
    gap_idx = int(np.argmax(gaps))
    span = 360.0 - gaps[gap_idx]
    start = angles_sorted[(gap_idx + 1) % len(angles_sorted)]
    center_angle = (start + span / 2.0) % 360.0
    height = float(z.max() - z.min())
    return ArcSection(
        name=name,
        origin=[float(cx), float(cy), float(z.min())],
        rotation=[1.0, 0.0, 0.0, 0.0],
        arc_radius_mm=radius,
        arc_angle_deg=min(max(span, 1e-3), 360.0),
        arc_center_angle_deg=center_angle,
        height_mm=max(height, 1e-6),
    )


def import_obj(
    path: str | Path,
    *,
    name: str,
    cabinet_size: tuple[float, float],
    led_pixel_pitch_mm: float,
) -> ScreenDefinition:
    """Import a screen definition from an OBJ mesh (spec §4.1.3).

    Each mesh group becomes a section, auto-fitted to ``plane`` or ``arc``.
    """
    p = Path(path)
    if not p.exists():
        raise ResourceNotFoundError(f"OBJ file not found: {p}", details={"path": str(p)})
    groups = _parse_obj_groups(p.read_text())
    if not groups:
        raise ArgumentError("OBJ contains no usable geometry", details={"path": str(p)})
    sections = []
    for gname, verts in groups.items():
        if len(verts) < 3:
            continue
        plane, residual = _fit_plane_section(gname, verts)
        extent = max(plane.width_mm, plane.height_mm)
        if residual <= _PLANARITY_TOL * max(extent, 1e-6):
            sections.append(plane)
        else:
            sections.append(_fit_arc_section(gname, verts))
    if not sections:
        raise ArgumentError("no section could be fitted from OBJ", details={"path": str(p)})
    return ScreenDefinition(
        name=name,
        unit="mm",
        cabinet_size=cabinet_size,
        led_pixel_pitch_mm=led_pixel_pitch_mm,
        sections=sections,
    )
