"""Cross-check the structured-light pixel -> world_mm bridge used by
``tracker-free fixed-observation-sl`` against the VP-QSP path (enumerate_markers).

Both paths must land a marker/dot at the SAME screen pixel on the SAME
world point, because they both ultimately call ``section.uv_to_world()``.
This is the exact inverse of ``screen_geometry.uv_to_pattern_pixel``:

    uv_to_pattern_pixel(u, v, w, h) = (u*w - 0.5, (1-v)*h - 0.5)

The bridge code in ``tracker_free.py::fixed_observation_sl_cmd`` computes:

    u_frac = (u_px + 0.5) / w
    v_frac = 1.0 - (v_px + 0.5) / h

which must exactly invert the forward mapping for any continuous pixel
position, and therefore reproduce the same world_mm as ``enumerate_markers``
for a dot placed at the same cabinet-centre pixel.
"""
from __future__ import annotations

import numpy as np
import pytest

from vpcal.core.screen_geometry import enumerate_markers, uv_to_pattern_pixel
from vpcal.models.screen import PlaneSection, ScreenDefinition


def _bridge_uv_frac(u_px: float, v_px: float, width_px: int, height_px: int) -> tuple[float, float]:
    """Same formula as fixed_observation_sl_cmd's per-dot conversion."""
    u_frac = (u_px + 0.5) / width_px
    v_frac = 1.0 - (v_px + 0.5) / height_px
    return u_frac, v_frac


def _screen(cabinet_size=(1000.0, 1000.0), cols=3, rows=2) -> ScreenDefinition:
    w = cabinet_size[0] * cols
    h = cabinet_size[1] * rows
    return ScreenDefinition(
        name="test", unit="mm",
        cabinet_size=list(cabinet_size), led_pixel_pitch_mm=2.8,
        markers_per_cabinet=1,
        sections=[PlaneSection(name="wall", width_mm=w, height_mm=h, origin=[100, -50, 25],
                                rotation=[0.9238795, 0.0, 0.0, 0.3826834])],  # 45deg about X, arbitrary
    )


def test_bridge_uv_frac_exactly_inverts_uv_to_pattern_pixel():
    """Round-trip: uv -> pixel -> uv_frac must return the original uv exactly."""
    canvas_w, canvas_h = 2400, 1500
    for u in (0.0, 0.05, 0.3, 0.5, 0.77, 1.0):
        for v in (0.0, 0.12, 0.5, 0.83, 1.0):
            px, py = uv_to_pattern_pixel(u, v, canvas_w, canvas_h)
            u2, v2 = _bridge_uv_frac(px, py, canvas_w, canvas_h)
            assert u2 == pytest.approx(u, abs=1e-9)
            assert v2 == pytest.approx(v, abs=1e-9)


def test_bridge_world_point_matches_enumerate_markers():
    """A structured-light dot placed at the pixel of a VP-QSP cabinet-centre
    marker must resolve to the identical world_mm through the SL bridge path."""
    screen = _screen(cols=3, rows=2)
    canvas_w, canvas_h = 3000, 2000  # matches screen mm 1:1 for this test, arbitrary otherwise

    markers = enumerate_markers(screen, markers_per_cabinet=1, screen_id=0, cab_col_offset=0)
    assert len(markers) == 6  # 3x2 cabinets, 1 marker each

    for m in markers:
        # Forward: same conversion mesh-vba's pattern generation / vpcal pattern
        # rendering would use to place a dot at this exact screen fraction.
        px, py = uv_to_pattern_pixel(m.u, m.v, canvas_w, canvas_h)
        # Bridge: exact code path of fixed_observation_sl_cmd.
        u_frac, v_frac = _bridge_uv_frac(px, py, canvas_w, canvas_h)
        world = screen.sections[0].uv_to_world(u_frac, v_frac)
        assert np.allclose(world, m.world, atol=1e-6), (
            f"SL bridge world point {world} != enumerate_markers world point {m.world} "
            f"for marker at u={m.u} v={m.v}"
        )
