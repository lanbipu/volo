"""Screen UV→3D mapping + marker enumeration tests (spec §4.1)."""

from __future__ import annotations

import math

import numpy as np

from vpcal.core.observations import MarkerId
from vpcal.core.screen_geometry import enumerate_markers, marker_world_map
from vpcal.models.screen import ArcSection, PlaneSection, ScreenDefinition


def test_plane_parametric_equation():
    plane = PlaneSection(name="p", width_mm=1000, height_mm=600, origin=[0, 0, 0])
    # u=0.5,v=0 → local (0,0,0) → origin
    assert np.allclose(plane.uv_to_world(0.5, 0.0), [0, 0, 0])
    # u=1,v=1 → local (500, 0, 600)
    assert np.allclose(plane.uv_to_world(1.0, 1.0), [500, 0, 600])
    # u=0 → local_x = -500
    assert np.allclose(plane.uv_to_world(0.0, 0.5), [-500, 0, 300])


def test_plane_with_origin_and_rotation():
    # 90° about Z (w,z) = (cos45, sin45): maps local x→y.
    q = [math.cos(math.pi / 4), 0, 0, math.sin(math.pi / 4)]
    plane = PlaneSection(name="p", width_mm=200, height_mm=100, origin=[10, 20, 30], rotation=q)
    w = plane.uv_to_world(1.0, 0.0)  # local (100,0,0) rotated 90°Z → (0,100,0) + origin
    assert np.allclose(w, [10, 120, 30], atol=1e-6)


def test_arc_parametric_and_arclength():
    arc = ArcSection(name="a", arc_radius_mm=9550, arc_angle_deg=360, arc_center_angle_deg=180, height_mm=12000)
    # arc length = 2πR ≈ 60005 mm
    assert abs(arc.u_extent_mm() - 2 * math.pi * 9550) < 1e-6
    # center u=0.5 → angle = 180° → (-R, 0, v*H)
    assert np.allclose(arc.uv_to_world(0.5, 0.0), [-9550, 0, 0], atol=1e-6)
    # v=1 → z = height
    assert np.allclose(arc.uv_to_world(0.5, 1.0), [-9550, 0, 12000], atol=1e-6)


def test_arc_radius_constant():
    arc = ArcSection(name="a", arc_radius_mm=5000, arc_angle_deg=120, arc_center_angle_deg=180, height_mm=3000)
    for u in np.linspace(0, 1, 11):
        w = arc.uv_to_world(u, 0.3)
        assert abs(math.hypot(w[0], w[1]) - 5000) < 1e-6


def _screen():
    return ScreenDefinition(
        name="studio", unit="mm", cabinet_size=(500, 500), led_pixel_pitch_mm=2.8,
        markers_per_cabinet=4,
        sections=[
            PlaneSection(name="wall", width_mm=2000, height_mm=1000, origin=[0, 0, 0]),
            PlaneSection(name="ceil", width_mm=1500, height_mm=1000, origin=[0, 0, 2000]),
        ],
    )


def test_enumerate_markers_unique_ids():
    markers = enumerate_markers(_screen(), markers_per_cabinet=1)
    ids = [m.marker_id for m in markers]
    assert len(ids) == len(set(ids))  # unique
    # wall: 2000/500=4 cols × 1000/500=2 rows = 8; ceil: 3 cols × 2 rows = 6 → 14
    assert len(markers) == 14


def test_enumerate_markers_world_matches_uv():
    screen = _screen()
    for m in enumerate_markers(screen, markers_per_cabinet=4):
        section = screen.section_by_name(m.section_name)
        assert np.allclose(section.uv_to_world(m.u, m.v), m.world)


def test_marker_world_map_lookup():
    screen = _screen()
    wm = marker_world_map(screen, markers_per_cabinet=1)
    assert all(isinstance(k, MarkerId) for k in wm)
    assert len(wm) == 14
