"""Recipe seed layout: a deterministic, human-followable starting set of camera
stations. FOV-fill sets the standoff; a horizontal front fan covers the body;
one top and one bottom station target the edge rows (where residual is worst).
The optimizer (optimize.py) warm-starts from this and patches the rest.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from lmt_vba_sidecar.capture_planner.geometry import ScreenGeometry, aim_targets
from lmt_vba_sidecar.capture_planner.visibility import Camera, look_at_camera


@dataclass(frozen=True)
class Shell:
    standoff_min_mm: float
    standoff_max_mm: float
    height_min_mm: float
    height_max_mm: float


@dataclass(frozen=True)
class SeedStation:
    camera: Camera
    position_mm: np.ndarray
    standoff_used_mm: float
    role: str            # "fan" | "top" | "bottom"


def fov_fill_standoff(K, image_size, screen_w_mm, screen_h_mm, fill=0.8) -> float:
    """Distance at which the wall fills `fill` of the frame (tighter of w/h)."""
    w, h = image_size
    standoff_w = K[0, 0] * screen_w_mm / (fill * w)
    standoff_h = K[1, 1] * screen_h_mm / (fill * h)
    return max(standoff_w, standoff_h)


def _clamp(x, lo, hi):
    return max(lo, min(hi, x))


def seed_cameras(geom: ScreenGeometry, K, image_size, shell: Shell, *, n_fan=5,
                 fan_span_deg=40.0, fill=0.8) -> list[SeedStation]:
    cx = geom.total_width_mm / 2.0
    cy = geom.total_height_mm / 2.0
    standoff = _clamp(
        fov_fill_standoff(K, image_size, geom.total_width_mm, geom.total_height_mm, fill),
        shell.standoff_min_mm, shell.standoff_max_mm,
    )
    center = np.array([cx, cy, 0.0])
    # Fan cameras stand at the wall mid-height when reachable, else at the nearest
    # reachable height in the shell — never outside it (the shell IS the physical
    # constraint). They still aim at the wall's vertical center.
    fan_y = _clamp(cy, shell.height_min_mm, shell.height_max_mm)

    stations: list[SeedStation] = []
    # horizontal front fan on an arc of radius `standoff`, at the reachable height.
    # FIX-15(与候选池同步): 墙宽超过一个 FOV 足迹时,fan 各站不再全部瞄中心,
    # 而是按位置单调分配到墙面分区 zone 中心(左侧站瞄左 zone),宽墙边缘箱体
    # 在 seed 阶段就有指向它们的机位;窄墙 aim 池只剩中心,行为不变。
    zone_aims = sorted(
        (t for t in aim_targets(geom, K, image_size, standoff)[1:]),
        key=lambda t: float(t[0]),
    )
    angles = np.deg2rad(np.linspace(-fan_span_deg / 2, fan_span_deg / 2, n_fan))
    for i, a in enumerate(angles):
        pos = np.array([cx + standoff * np.sin(a), fan_y, standoff * np.cos(a)])
        if zone_aims:
            zi = round(i * (len(zone_aims) - 1) / max(n_fan - 1, 1))
            aim = zone_aims[int(zi)]
        else:
            aim = center
        stations.append(SeedStation(look_at_camera(K, pos, aim, image_size),
                                    pos, standoff, "fan"))

    # top / bottom stations aimed at the edge-row centers
    top_target = np.array([cx, geom.total_height_mm, 0.0])
    bot_target = np.array([cx, 0.0, 0.0])
    top_pos = np.array([cx, shell.height_max_mm, standoff])
    bot_pos = np.array([cx, shell.height_min_mm, standoff])
    stations.append(SeedStation(look_at_camera(K, top_pos, top_target, image_size),
                                top_pos, standoff, "top"))
    stations.append(SeedStation(look_at_camera(K, bot_pos, bot_target, image_size),
                                bot_pos, standoff, "bottom"))
    return stations
