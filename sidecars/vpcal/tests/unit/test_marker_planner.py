"""Tests for stage-level marker planner + denser local_id sub-grid."""

from __future__ import annotations

from vpcal.core.marker_planner import plan_markers_per_cabinet, plan_to_dict
from vpcal.core.screen_geometry import enumerate_markers, sub_offsets_for_count
from vpcal.models.screen import PlaneSection, ScreenDefinition


def _screen(name: str = "A", cab=(1000.0, 1000.0), mpc: int = 1) -> ScreenDefinition:
    return ScreenDefinition(
        name=name,
        cabinet_size=cab,
        led_pixel_pitch_mm=2.8,
        markers_per_cabinet=mpc,
        sections=[
            PlaneSection(name="main", width_mm=3000, height_mm=2000, origin=[0, 0, 0]),
        ],
    )


def test_sub_offsets_legacy_and_dense():
    assert sub_offsets_for_count(1) == [(0.5, 0.5)]
    assert len(sub_offsets_for_count(4)) == 4
    assert len(sub_offsets_for_count(9)) == 9
    assert len(sub_offsets_for_count(64)) == 64


def test_enumerate_markers_accepts_mpc_16():
    screen = _screen(mpc=16)
    markers = enumerate_markers(screen, markers_per_cabinet=16, screen_id=0)
    assert len(markers) == 6 * 16  # 3x2 cabinets * 16
    assert max(m.marker_id.local_id for m in markers) == 15


def test_planner_raises_density_to_formal_min():
    a = _screen("A", mpc=1)
    b = _screen("B", mpc=1)
    plan = plan_markers_per_cabinet(
        [("A", a, 0, 0), ("B", b, 1, 10)],
        target_total=100,
        formal_min_total=60,
    )
    assert plan.total_estimated_markers >= 60
    payload = plan_to_dict(plan)
    assert payload["meets_formal_min"]
