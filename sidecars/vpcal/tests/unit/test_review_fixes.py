"""Regression tests for code-review findings (locks the fixes in place)."""

from __future__ import annotations

import json

import numpy as np
import pytest

from vpcal.core.coordinates import convert_pose
from vpcal.core.errors import ConfigError, PreconditionError
from vpcal.core.projection import CameraIntrinsics
from vpcal.core.transforms import make_transform, matrix_to_quat
from vpcal.io.tracking_io import load_tracking
from vpcal.models.lens import LensProfile
from vpcal.qa.coverage import _sensor_coverage


def test_opentrackio_transform_chain_is_composed(tmp_path):
    """A multi-element transforms chain must be composed, not read [-1]."""
    # Two transforms: a parent translation then a child rotation+translation.
    A = make_transform([1, 0, 0, 0], [1.0, 2.0, 3.0])  # mm
    qB = matrix_to_quat(np.array([[0, -1, 0], [1, 0, 0], [0, 0, 1]], dtype=float))  # 90° about Z
    B = make_transform(qB, [0.5, 0.0, 0.0])
    compound = A @ B
    sample = {
        "protocol": {"name": "OpenTrackIO"},
        "timing": {"sequenceNumber": 0},
        "transforms": [
            {"translation": {"x": 0.001, "y": 0.002, "z": 0.003},
             "rotation": {"w": 1.0, "x": 0.0, "y": 0.0, "z": 0.0}, "id": "parent"},
            {"translation": {"x": 0.0005, "y": 0.0, "z": 0.0},
             "rotation": {"w": float(qB[0]), "x": float(qB[1]), "y": float(qB[2]), "z": float(qB[3])}, "id": "camera"},
        ],
    }
    p = tmp_path / "otio.jsonl"
    p.write_text(json.dumps(sample))
    frame = load_tracking(p)[0]
    # position must equal the compound translation (mm), not just the last link.
    assert np.allclose(frame.position, compound[:3, 3], atol=1e-6)
    # and NOT equal to the last transform's translation alone (0.5mm)
    assert not np.allclose(frame.position, [0.5, 0.0, 0.0])


def test_custom_transform_rejects_non_orthonormal():
    """A scaled/sheared custom_transform must be rejected, not yield garbage."""
    scaled = [[2, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]
    with pytest.raises(ConfigError):
        convert_pose("custom", "quaternion", [1, 0, 0, 0], [0, 0, 0], custom_transform=scaled)


def test_custom_transform_accepts_proper_rotation():
    M = [[1, 0, 0, 0], [0, 0, -1, 0], [0, 1, 0, 0], [0, 0, 0, 1]]
    q, t = convert_pose("custom", "quaternion", [1, 0, 0, 0], [1, 2, 3], custom_transform=M)
    assert np.isclose(np.linalg.norm(q), 1.0)


def test_sensor_coverage_uses_real_image_size_with_offset():
    """With a principal-point offset, coverage must bucket against real W/H, not 2·cx."""
    lens = LensProfile(
        focal_length_mm=35, sensor_width_mm=36, sensor_height_mm=24,
        principal_point_offset_mm=(3.0, 0.0), image_width_px=1920, image_height_px=1080,
    )
    intr = CameraIntrinsics.from_lens(lens)
    assert intr.image_size == (1920.0, 1080.0)  # not 2·cx
    assert np.isclose(2.0 * intr.cx, 2240.0)  # phantom width the bug would use

    from vpcal.core.observations import Observation

    # u=1280 is in the right third of 1920 (1280/1920·3 = 2.0 → col 2) but the
    # phantom width 2240 would bucket it to col 1 (1280/2240·3 = 1.71). With the
    # real-size fix it must register the bottom-right region.
    obs = [Observation(1280.0, 1070.0, (0, 0, 0), (1, 0, 0, 0), (0, 0, 0))]
    cov = _sensor_coverage(obs, intr)
    assert cov["regions"]["bottom_right"] is True


def test_timestamp_matching_rejected_with_clear_error(tmp_path):
    """timestamp frame-matching with images present must raise a clear error."""
    from vpcal.core.simulator import default_lens, simulate_dataset
    from vpcal.core.validator import validate_session
    from vpcal.models.screen import PlaneSection, ScreenDefinition
    from vpcal.models.session import SessionConfig

    screen = ScreenDefinition(
        name="s", unit="mm", cabinet_size=(500, 500), led_pixel_pitch_mm=2.8,
        markers_per_cabinet=4,
        sections=[PlaneSection(name="w", width_mm=1200, height_mm=900, origin=[0, 0, 0])],
    )
    simulate_dataset(screen, tmp_path, num_poses=6, lens=default_lens(640, 480), render_images=True)
    (tmp_path / "observations.jsonl").unlink()  # force image path
    raw = json.loads((tmp_path / "session.json").read_text())
    raw["tracking"]["frame_matching"] = "timestamp"
    session = SessionConfig.model_validate(raw)
    with pytest.raises(PreconditionError) as exc:
        validate_session(session, tmp_path, raw_session=raw)
    assert "timestamp" in str(exc.value)


def test_markers_per_cabinet_flows_from_screen(tmp_path):
    """A screen with markers_per_cabinet=1 round-trips through simulate→quick run."""
    from vpcal.core.pipeline import run_quick
    from vpcal.core.simulator import default_lens, simulate_dataset
    from vpcal.models.screen import PlaneSection, ScreenDefinition
    from vpcal.models.session import SessionConfig

    screen = ScreenDefinition(
        name="s", unit="mm", cabinet_size=(500, 500), led_pixel_pitch_mm=2.8,
        markers_per_cabinet=4,
        sections=[PlaneSection(name="w", width_mm=3000, height_mm=2000, origin=[0, 0, 0])],
    )
    simulate_dataset(screen, tmp_path, num_poses=8, lens=default_lens(1920, 1080), render_images=False)
    raw = json.loads((tmp_path / "session.json").read_text())
    session = SessionConfig.model_validate(raw)
    result = run_quick(session, tmp_path, tmp_path / "output", raw_session=raw, prefer_cpp=True)
    # Layout consistent (mpc=1 everywhere) → exact reprojection.
    assert result["result"]["quality"]["reprojection_rms_px"] < 0.01
