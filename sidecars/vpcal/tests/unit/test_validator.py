"""Stage 0 validator tests (spec §3.1)."""

from __future__ import annotations

import json

import pytest

from vpcal.core.errors import PreconditionError, ResourceNotFoundError
from vpcal.core.simulator import default_lens, simulate_dataset
from vpcal.core.validator import validate_session
from vpcal.models.screen import PlaneSection, ScreenDefinition
from vpcal.models.session import SessionConfig


def _make_session(tmp_path, num_poses=8):
    screen = ScreenDefinition(
        name="s", unit="mm", cabinet_size=(500, 500), led_pixel_pitch_mm=2.8,
        markers_per_cabinet=4,
        sections=[PlaneSection(name="w", width_mm=2000, height_mm=1500, origin=[0, 0, 0])],
    )
    simulate_dataset(
        screen, tmp_path, num_poses=num_poses, noise_px=0.0,
        lens=default_lens(1280, 720), seed=0, render_images=False,
    )
    raw = json.loads((tmp_path / "session.json").read_text())
    return SessionConfig.model_validate(raw), raw


def test_valid_session_passes(tmp_path):
    session, raw = _make_session(tmp_path)
    report = validate_session(session, tmp_path, raw_session=raw)
    assert report["passed"] is True
    assert report["matched"] >= 3


def test_unsupported_lens_model_rejected(tmp_path):
    session, raw = _make_session(tmp_path)
    raw["lens"]["distortion"]["k4"] = 0.01
    with pytest.raises(PreconditionError) as exc:
        validate_session(session, tmp_path, raw_session=raw)
    assert "k4" in str(exc.value)


def test_missing_tracking_file(tmp_path):
    session, raw = _make_session(tmp_path)
    (tmp_path / "tracking" / "poses.jsonl").unlink()
    with pytest.raises(ResourceNotFoundError):
        validate_session(session, tmp_path, raw_session=raw)


def test_too_few_poses_rejected(tmp_path):
    session, raw = _make_session(tmp_path, num_poses=2)
    with pytest.raises(PreconditionError):
        validate_session(session, tmp_path, raw_session=raw)


def test_low_pose_count_warns(tmp_path):
    session, raw = _make_session(tmp_path, num_poses=4)
    report = validate_session(session, tmp_path, raw_session=raw)
    assert any("very_low" in w for w in report["warnings"])
