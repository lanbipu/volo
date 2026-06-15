"""Screen JSON/OBJ I/O tests (spec §4.1.3)."""

from __future__ import annotations

import numpy as np

from vpcal.io.screen_io import import_obj, load_screen, save_screen
from vpcal.models.screen import ArcSection, PlaneSection, ScreenDefinition


def _screen():
    return ScreenDefinition(
        name="studio", unit="mm", cabinet_size=(500, 500), led_pixel_pitch_mm=2.8,
        markers_per_cabinet=4,
        sections=[
            PlaneSection(name="wall", width_mm=4000, height_mm=2000, origin=[0, 1000, 0]),
            ArcSection(name="back", arc_radius_mm=6000, arc_angle_deg=90, arc_center_angle_deg=180, height_mm=3000),
        ],
    )


def test_json_roundtrip(tmp_path):
    screen = _screen()
    p = tmp_path / "wall.json"
    save_screen(screen, p)
    back = load_screen(p)
    assert back.name == "studio"
    assert isinstance(back.sections[0], PlaneSection)
    assert isinstance(back.sections[1], ArcSection)
    assert back.sections[1].arc_radius_mm == 6000


def _write_obj_from_plane(path, plane: PlaneSection, n=8):
    """Sample a plane section into an OBJ group with a face grid."""
    us = np.linspace(0, 1, n)
    vs = np.linspace(0, 1, n)
    lines = [f"g {plane.name}"]
    verts = []
    for v in vs:
        for u in us:
            w = plane.uv_to_world(u, v)
            verts.append(w)
            lines.append(f"v {w[0]} {w[1]} {w[2]}")
    # one face to anchor the group
    lines.append("f 1 2 3")
    path.write_text("\n".join(lines))


def test_obj_import_plane_geometry(tmp_path):
    plane = PlaneSection(name="wall", width_mm=3000, height_mm=1500, origin=[100, 200, 50])
    obj = tmp_path / "wall.obj"
    _write_obj_from_plane(obj, plane)
    screen = import_obj(obj, name="imported", cabinet_size=(500, 500), led_pixel_pitch_mm=2.8)
    assert len(screen.sections) == 1
    sec = screen.sections[0]
    assert isinstance(sec, PlaneSection)
    # Geometric equivalence: corner world points should match within tolerance.
    for u, v in [(0.0, 0.0), (1.0, 0.0), (0.5, 1.0), (1.0, 1.0)]:
        assert np.allclose(sec.uv_to_world(u, v), plane.uv_to_world(u, v), atol=1.0)


def test_obj_import_arc_detected(tmp_path):
    arc = ArcSection(name="curve", arc_radius_mm=5000, arc_angle_deg=120, arc_center_angle_deg=180, height_mm=3000)
    us = np.linspace(0, 1, 12)
    vs = np.linspace(0, 1, 4)
    lines = ["g curve"]
    for v in vs:
        for u in us:
            w = arc.uv_to_world(u, v)
            lines.append(f"v {w[0]} {w[1]} {w[2]}")
    lines.append("f 1 2 3")
    obj = tmp_path / "arc.obj"
    obj.write_text("\n".join(lines))
    screen = import_obj(obj, name="imported", cabinet_size=(500, 500), led_pixel_pitch_mm=2.8)
    sec = screen.sections[0]
    assert isinstance(sec, ArcSection)
    assert abs(sec.arc_radius_mm - 5000) < 50
    # world points reproduce within tolerance
    for u in [0.0, 0.5, 1.0]:
        assert np.allclose(sec.uv_to_world(u, 0.5), arc.uv_to_world(u, 0.5), atol=5.0)
