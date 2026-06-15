"""LED-processor canvas mapping verification (remediation C0)."""

from __future__ import annotations

import numpy as np
import pytest

from vpcal.core.processor_check import (
    CanvasMapping,
    check_screen_consistency,
    fit_canvas_mapping,
    screen_physical_pixels,
    verify_one_to_one,
)
from vpcal.models.screen import PlaneSection, ProcessorCanvas, ScreenDefinition


def _grid(n=8, w=1920, h=1080):
    xs = np.linspace(0, w - 1, n)
    ys = np.linspace(0, h - 1, n)
    return np.array([[x, y] for x in xs for y in ys], dtype=np.float64)


def test_fit_recovers_injected_scale_and_offset():
    expected = _grid()
    observed = expected * np.array([1.02, 0.99]) + np.array([3.0, -2.0])
    m = fit_canvas_mapping(expected, observed)
    assert abs(m.scale_x - 1.02) < 1e-6
    assert abs(m.scale_y - 0.99) < 1e-6
    assert abs(m.offset_x_px - 3.0) < 1e-6
    assert abs(m.offset_y_px + 2.0) < 1e-6


def test_exact_one_to_one_passes():
    expected = _grid()
    ok, m = verify_one_to_one(expected, expected.copy())
    assert ok
    assert m.is_one_to_one()


def test_detects_one_pixel_canvas_offset():
    # C0 acceptance (synthetic): a 1-px canvas offset must be caught.
    expected = _grid()
    observed = expected + np.array([1.0, 0.0])  # 1 px shift in x
    ok, m = verify_one_to_one(expected, observed)
    assert ok is False
    assert abs(m.offset_x_px - 1.0) < 1e-6
    assert abs(m.scale_x - 1.0) < 1e-6


def test_detects_aspect_scale():
    expected = _grid()
    observed = expected * np.array([1.0, 1.005])  # 0.5% vertical stretch
    ok, m = verify_one_to_one(expected, observed)
    assert ok is False
    assert abs(m.scale_y - 1.005) < 1e-6


def test_subpixel_offset_within_tolerance_passes():
    expected = _grid()
    observed = expected + np.array([0.2, 0.1])  # < 0.5 px default tolerance
    ok, _ = verify_one_to_one(expected, observed)
    assert ok


def test_too_few_correspondences_raises():
    with pytest.raises(ValueError, match="need >= 2"):
        fit_canvas_mapping(np.array([[0.0, 0.0]]), np.array([[0.0, 0.0]]))


# ── screen consistency ───────────────────────────────────────────────


def _screen(processor=None):
    # 2400 mm / 2.5 mm = 960 px wide; 1500 / 2.5 = 600 px tall.
    return ScreenDefinition(
        name="wall", unit="mm", cabinet_size=(500, 500), led_pixel_pitch_mm=2.5,
        markers_per_cabinet=1,
        sections=[PlaneSection(name="w", width_mm=2400, height_mm=1500, origin=[0, 0, 0])],
        processor=processor,
    )


def test_physical_pixels_from_geometry():
    assert screen_physical_pixels(_screen()) == (960, 600)


def test_no_processor_no_issues():
    assert check_screen_consistency(_screen()) == []


def test_consistent_one_to_one_processor_ok():
    proc = ProcessorCanvas(input_width_px=960, input_height_px=600)  # identity, matches geometry
    assert check_screen_consistency(_screen(proc)) == []


def test_non_one_to_one_processor_flagged():
    proc = ProcessorCanvas(input_width_px=960, input_height_px=600, offset_x_px=2.0)
    issues = check_screen_consistency(_screen(proc))
    assert any("NOT 1:1" in i for i in issues)


def test_resolution_mismatch_flagged():
    # input 1920 wide at 1:1 → 1920 px, but wall is 960 px → disagree.
    proc = ProcessorCanvas(input_width_px=1920, input_height_px=600)
    issues = check_screen_consistency(_screen(proc))
    assert any("disagree" in i for i in issues)
