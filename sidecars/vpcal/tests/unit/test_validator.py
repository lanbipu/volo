"""Stage 0 validator tests (spec §3.1)."""

from __future__ import annotations

import json

import pytest

from vpcal.core.errors import PreconditionError, ResourceNotFoundError
from vpcal.core.simulator import default_lens, simulate_dataset
from vpcal.core.validator import validate_session
from vpcal.models.screen import PlaneSection, ProcessorCanvas, ScreenDefinition
from vpcal.models.session import SessionConfig


def _make_session(tmp_path, num_poses=8, processor=None):
    screen = ScreenDefinition(
        name="s", unit="mm", cabinet_size=(500, 500), led_pixel_pitch_mm=2.8,
        markers_per_cabinet=4,
        sections=[PlaneSection(name="w", width_mm=2000, height_mm=1500, origin=[0, 0, 0])],
        processor=processor,
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


# ── processor mapping verification (architecture §3.3a, W9.1) ────────


def test_no_processor_declared_needs_no_mapping_verification(tmp_path):
    # No screen.processor ⇒ Phase-1 direct-drive 1:1 assumption; unaffected.
    session, raw = _make_session(tmp_path)
    report = validate_session(session, tmp_path, raw_session=raw)
    assert report["passed"] is True
    assert "processor_mapping_verified" not in report


def test_declared_processor_without_attestation_is_mandatory_and_blocks(tmp_path):
    proc = ProcessorCanvas(input_width_px=100, input_height_px=100)  # ~1920x1440px wall @2.8mm pitch mismatch is fine, only presence matters
    session, raw = _make_session(tmp_path, processor=proc)
    with pytest.raises(PreconditionError, match="not verified"):
        validate_session(session, tmp_path, raw_session=raw)


def test_declared_processor_with_processor_verified_skips_check(tmp_path):
    proc = ProcessorCanvas(input_width_px=100, input_height_px=100)
    session, raw = _make_session(tmp_path, processor=proc)
    raw["processor_check"] = {"processor_verified": True}
    session = SessionConfig.model_validate(raw)
    report = validate_session(session, tmp_path, raw_session=raw)
    assert report["passed"] is True
    assert report["processor_mapping_verified"] == "skipped (processor_verified=true)"


def test_declared_processor_with_passing_mapping_image(tmp_path):
    from vpcal.core.mapping_verify import generate_mapping_pattern

    proc = ProcessorCanvas(input_width_px=100, input_height_px=100)
    session, raw = _make_session(tmp_path, processor=proc)
    generate_mapping_pattern(640, 480, tmp_path / "mapping.png")
    raw["processor_check"] = {
        "mapping_image": "mapping.png", "expected_width_px": 640, "expected_height_px": 480,
    }
    session = SessionConfig.model_validate(raw)
    report = validate_session(session, tmp_path, raw_session=raw)
    assert report["passed"] is True
    assert report["processor_mapping_verified"] == "checked"
    assert abs(report["processor_mapping"]["offset_x_px"]) < 0.5


def test_declared_processor_with_failing_mapping_image_blocks(tmp_path):
    import cv2
    import numpy as np

    from vpcal.core.mapping_verify import generate_mapping_pattern

    proc = ProcessorCanvas(input_width_px=100, input_height_px=100)
    session, raw = _make_session(tmp_path, processor=proc)
    generate_mapping_pattern(640, 480, tmp_path / "mapping_ref.png")
    img = cv2.imread(str(tmp_path / "mapping_ref.png"), cv2.IMREAD_GRAYSCALE)
    shift = np.array([[1.0, 0.0, 2.0], [0.0, 1.0, 0.0]], dtype=np.float64)
    shifted = cv2.warpAffine(img, shift, (640, 480), flags=cv2.INTER_LINEAR,
                             borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    cv2.imwrite(str(tmp_path / "mapping.png"), shifted)
    raw["processor_check"] = {
        "mapping_image": "mapping.png", "expected_width_px": 640, "expected_height_px": 480,
    }
    session = SessionConfig.model_validate(raw)
    with pytest.raises(PreconditionError, match="NOT 1:1"):
        validate_session(session, tmp_path, raw_session=raw)
