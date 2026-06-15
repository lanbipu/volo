"""Structured-light screen-pixel -> cabinet-local-mm geometry (numpy-only, no cv2).

The SL analogs of screen_mapping.charuco_corner_local_mm / reconstruct._active_
surface_corners_mm. A dot's screen pixel (u,v) is absolute; its cabinet occupies
input_rect_px = [x,y,w,h]. Local mm uses CENTER origin and **+y UP** so SL
observations feed model_constrained_ba with the identical frame convention as
the ChArUco path (feeding y-down points yields a mirrored cabinet pose -- see
screen_mapping.charuco_corner_local_mm). Scale comes from the cabinet's own
pixel pitch (mm/px), so mm is exact for any per-cabinet size/pitch.
"""
from __future__ import annotations

import numpy as np


def sl_local_mm(rect: tuple[int, int, int, int], u: float, v: float,
                pitch_x: float, pitch_y: float) -> np.ndarray:
    """Screen pixel (u,v) -> cabinet-local [x,y,0] mm; center origin, +x right, +y up."""
    x, y, w, h = rect
    local_x_px = (u - x) - w / 2.0          # +x right
    local_y_px = h / 2.0 - (v - y)          # +y UP (smaller v = higher = +y)
    return np.array([local_x_px * pitch_x, local_y_px * pitch_y, 0.0], dtype=float)


def sl_cabinet_corners_mm(rect: tuple[int, int, int, int],
                          pitch_x: float, pitch_y: float) -> np.ndarray:
    """The 4 active-surface corners in local mm, order BL,BR,TR,TL (+y up).

    Matches reconstruct._active_surface_corners_mm's order -- load-bearing:
    compare_known derives size from this order (width=‖c1-c0‖, height=‖c2-c1‖).
    Active size derives from the cabinet's pixel extent x pitch (the 1:1-feed
    guarantee means rect w/h == cabinet resolution_px)."""
    _x, _y, w, h = rect
    hw, hh = (w * pitch_x) / 2.0, (h * pitch_y) / 2.0
    return np.array([[-hw, -hh, 0.0], [hw, -hh, 0.0],
                     [hw, hh, 0.0], [-hw, hh, 0.0]], dtype=float)
