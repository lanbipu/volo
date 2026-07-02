"""Tracker offset backfill blocks (plan E3): roundtrip per coordinate system."""

from __future__ import annotations

import numpy as np
import pytest

from vpcal.core.tracker_offsets import (
    offsets_to_internal_matrix,
    render_offsets_text,
    tracker_offsets_block,
)
from vpcal.core.transforms import make_transform


def _random_qt(rng):
    axis = rng.normal(size=3)
    axis /= np.linalg.norm(axis)
    angle = rng.uniform(-1.2, 1.2)
    q = np.array([np.cos(angle / 2), *(np.sin(angle / 2) * axis)])
    t = rng.uniform(-800, 800, size=3)
    return q, t


@pytest.mark.parametrize("coord", ["unreal", "optitrack", "vicon", "freeDEuler", "opentrackio"])
def test_offsets_roundtrip_to_matrix(coord):
    """Offset block ↔ 4x4 matrix roundtrip is exact per declared tracker frame."""
    rng = np.random.default_rng(42)
    t2s = _random_qt(rng)
    c2t = _random_qt(rng)
    block = tracker_offsets_block(t2s, c2t, coord)
    cam = block["cameras"][0]

    T_C_expected = make_transform(*c2t)
    T_S_expected = make_transform(*t2s)
    T_C_back = offsets_to_internal_matrix(cam["hand_eye"], coord)
    T_S_back = offsets_to_internal_matrix(cam["world_alignment"], coord)
    np.testing.assert_allclose(T_C_back, T_C_expected, atol=1e-9)
    np.testing.assert_allclose(T_S_back, T_S_expected, atol=1e-9)


def test_offsets_block_labels_units_and_convention():
    rng = np.random.default_rng(0)
    block = tracker_offsets_block(_random_qt(rng), _random_qt(rng), "vicon")
    assert block["translation_unit"] == "mm"
    assert "euler_ptr" in block["rotation_convention"]
    assert block["coordinate_system"] == "vicon"
    assert isinstance(block["cameras"], list)  # per-camera list (schema D6 rule)
    entry = block["cameras"][0]["hand_eye"]
    assert set(entry) == {"x_mm", "y_mm", "z_mm", "pan_deg", "tilt_deg", "roll_deg"}


def test_offsets_custom_transform_roundtrip():
    rng = np.random.default_rng(7)
    custom = [[0.0, 1.0, 0.0, 0.0], [-1.0, 0.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0], [0.0, 0.0, 0.0, 1.0]]
    t2s = _random_qt(rng)
    block = tracker_offsets_block(t2s, _random_qt(rng), "custom", custom)
    back = offsets_to_internal_matrix(block["cameras"][0]["world_alignment"], "custom", custom)
    np.testing.assert_allclose(back, make_transform(*t2s), atol=1e-9)


def test_render_offsets_text_copyable():
    rng = np.random.default_rng(1)
    block = tracker_offsets_block(_random_qt(rng), _random_qt(rng), "freeDEuler")
    lines = render_offsets_text(block)
    joined = "\n".join(lines)
    assert "camera transform" in joined and "world transform" in joined
    assert "Pan" in joined and "freeDEuler" in joined
