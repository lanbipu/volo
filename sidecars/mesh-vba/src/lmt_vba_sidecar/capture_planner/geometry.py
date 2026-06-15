"""Expand a screen's nominal geometry into 3D cabinet centers, surface normals,
and per-cabinet sample points (model frame, millimetres).

The sample grid is the unit of visibility/coverage downstream: each cabinet is
sampled by a `sample_grid` (default 4x4) covering its active face, so coverage
can be judged per point against the observability gate (>=8 obs / >=4 per view)
rather than by a single cabinet-center test.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from lmt_vba_sidecar.ipc import CabinetArray
from lmt_vba_sidecar.nominal import (
    _curved_radius,
    _is_curved,
    nominal_cabinet_centers_model_frame,
    nominal_cabinet_normals_model_frame,
)


@dataclass(frozen=True)
class CabinetGeom:
    col: int
    row: int
    center_mm: np.ndarray        # (3,) model frame, mm
    normal: np.ndarray           # (3,) unit surface normal
    sample_points_mm: np.ndarray  # (K, 3) model frame, mm


@dataclass(frozen=True)
class ArcOccluder:
    """Vertical cylinder cross-section (XZ plane) used for curved self-occlusion.
    Axis at (cx, cz); the screen surface spans arc angles [a_min, a_max].
    FIX-16: the occluder carries the wall's physical y-range — sightlines
    passing over the top / under the bottom of the wall are NOT occluded
    (the old infinite cylinder misreported them)."""
    cx: float
    cz: float
    radius: float
    a_min: float
    a_max: float
    y_min: float
    y_max: float


@dataclass(frozen=True)
class ScreenGeometry:
    cabinets: list[CabinetGeom]
    radius_mm: float | None
    total_width_mm: float
    total_height_mm: float
    arc_occluder: "ArcOccluder | None" = None


def aim_targets(geom: "ScreenGeometry", K, image_size, standoff_mm: float, *,
                n_aim: int | None = None) -> list[np.ndarray]:
    """FIX-15: aim-target 在墙面分区采样。

    旧候选池全部瞄墙中心:任何超出"中心视锥足迹"的箱体对**所有**候选都出画,
    宽墙边缘结构性不可覆盖,planner 把自己的候选空间退化误报成物理不可达。
    这里返回 [全墙中心] + 按列分区的 zone 中心(取区内箱体 nominal 中心均值,
    平墙/弧墙统一适用)。`n_aim` 省略时按 standoff 处的水平 FOV 足迹自适应:
    墙宽 ≤ 一个足迹 → 只保留中心(窄墙行为不变),否则 ceil(墙宽/足迹),上限 7。
    """
    cx = geom.total_width_mm / 2.0
    cy = geom.total_height_mm / 2.0
    center = np.array([cx, cy, 0.0])
    if n_aim is None:
        w_px = float(image_size[0])
        fx = float(np.asarray(K, float)[0, 0])
        footprint = 2.0 * float(standoff_mm) * (w_px / 2.0) / fx
        n_aim = int(np.clip(np.ceil(geom.total_width_mm / max(footprint, 1.0)), 1, 7))
    if n_aim <= 1:
        return [center]
    cols = sorted({c.col for c in geom.cabinets})
    targets = [center]
    for zone in np.array_split(np.asarray(cols), n_aim):
        zone_cols = {int(c) for c in zone}
        if not zone_cols:
            continue
        pts = np.asarray([c.center_mm for c in geom.cabinets if c.col in zone_cols])
        targets.append(pts.mean(axis=0))
    return targets


def _tangent_basis(normal: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Orthonormal (right, up) spanning the cabinet face. World +Y is 'up';
    'right' = up x normal. For a flat (+z) face this is (+x, +y)."""
    up = np.array([0.0, 1.0, 0.0])
    right = np.cross(up, normal)
    right = right / np.linalg.norm(right)
    up_local = np.cross(normal, right)
    return right, up_local


def expand_screen(cab: CabinetArray, shape_prior, sample_grid=(4, 4)) -> ScreenGeometry:
    centers_m = nominal_cabinet_centers_model_frame(cab, shape_prior)
    normals = nominal_cabinet_normals_model_frame(cab, shape_prior)
    cw_mm, ch_mm = cab.cabinet_size_mm
    nx, ny = sample_grid
    us = np.linspace(-1.0, 1.0, nx) * (cw_mm / 2.0)
    vs = np.linspace(-1.0, 1.0, ny) * (ch_mm / 2.0)

    cabinets: list[CabinetGeom] = []
    for (col, row), c_m in centers_m.items():
        center_mm = np.asarray(c_m, float) * 1000.0
        normal = np.asarray(normals[(col, row)], float)
        right, up_local = _tangent_basis(normal)
        pts = [center_mm + u * right + v * up_local for v in vs for u in us]
        cabinets.append(
            CabinetGeom(col, row, center_mm, normal, np.asarray(pts, float))
        )

    cabinets.sort(key=lambda c: (c.row, c.col))
    radius = _curved_radius(shape_prior) if _is_curved(shape_prior) else None
    total_w = cab.cols * cw_mm
    arc_occluder = None
    if radius is not None:
        half = total_w / 2.0
        arc_occluder = ArcOccluder(
            cx=half, cz=radius, radius=radius,
            a_min=-half / radius, a_max=half / radius,
            y_min=0.0, y_max=cab.rows * ch_mm,
        )
    return ScreenGeometry(
        cabinets=cabinets,
        radius_mm=radius,
        total_width_mm=total_w,
        total_height_mm=cab.rows * ch_mm,
        arc_occluder=arc_occluder,
    )
