"""1:1 LED-processor canvas mapping verification pattern (architecture §3.3a, W9.1)."""

from __future__ import annotations

import cv2
import numpy as np
import pytest

from vpcal.core.errors import PreconditionError
from vpcal.core.mapping_verify import (
    MAPPING_SCREEN_ID,
    NUM_FIDUCIALS,
    generate_mapping_pattern,
    verify_mapping_image,
)

WIDTH, HEIGHT = 1600, 900


def _generate(tmp_path):
    out = tmp_path / "pattern.png"
    summary = generate_mapping_pattern(WIDTH, HEIGHT, out)
    return out, summary


def test_generate_writes_all_fiducials(tmp_path):
    out, summary = _generate(tmp_path)
    assert out.exists()
    assert len(summary["fiducials"]) == NUM_FIDUCIALS
    img = cv2.imread(str(out), cv2.IMREAD_GRAYSCALE)
    assert img.shape == (HEIGHT, WIDTH)


def test_identity_capture_passes(tmp_path):
    out, _ = _generate(tmp_path)
    mapping = verify_mapping_image(out, WIDTH, HEIGHT)
    assert mapping.is_one_to_one()
    assert abs(mapping.offset_x_px) < 0.1
    assert abs(mapping.offset_y_px) < 0.1


def test_detects_one_pixel_canvas_offset(tmp_path):
    """Architecture §3.3a acceptance (synthetic): a 1-px canvas offset must be caught."""
    out, _ = _generate(tmp_path)
    img = cv2.imread(str(out), cv2.IMREAD_GRAYSCALE)
    shift = np.array([[1.0, 0.0, 1.0], [0.0, 1.0, 0.0]], dtype=np.float64)
    shifted = cv2.warpAffine(img, shift, (WIDTH, HEIGHT), flags=cv2.INTER_LINEAR,
                             borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    shifted_path = out.parent / "shifted.png"
    cv2.imwrite(str(shifted_path), shifted)

    with pytest.raises(PreconditionError) as exc_info:
        verify_mapping_image(shifted_path, WIDTH, HEIGHT)
    details = exc_info.value.details
    assert abs(details["offset_x_px"] - 1.0) < 0.3
    assert exc_info.value.exit_code == 6


def test_detects_scale_mismatch(tmp_path):
    out, _ = _generate(tmp_path)
    img = cv2.imread(str(out), cv2.IMREAD_GRAYSCALE)
    # 1% aspect stretch (processor upscaling the input canvas).
    scaled = cv2.resize(img, None, fx=1.01, fy=1.0, interpolation=cv2.INTER_LINEAR)
    canvas = np.zeros((HEIGHT, max(WIDTH, scaled.shape[1])), dtype=np.uint8)
    canvas[:, : scaled.shape[1]] = scaled[:HEIGHT, :]
    scaled_path = out.parent / "scaled.png"
    cv2.imwrite(str(scaled_path), canvas[:, :WIDTH] if canvas.shape[1] >= WIDTH else canvas)

    with pytest.raises(PreconditionError) as exc_info:
        verify_mapping_image(scaled_path, WIDTH, HEIGHT)
    assert abs(exc_info.value.details["scale_x"] - 1.01) < 0.01


def test_unreadable_image_raises_precondition_error(tmp_path):
    missing = tmp_path / "does_not_exist.png"
    with pytest.raises(PreconditionError):
        verify_mapping_image(missing, WIDTH, HEIGHT)


def test_too_few_fiducials_raises_precondition_error(tmp_path):
    out, _ = _generate(tmp_path)
    img = cv2.imread(str(out), cv2.IMREAD_GRAYSCALE)
    # Blank out everything except a small corner, leaving < 3 decodable fiducials.
    cropped = img.copy()
    cropped[:, WIDTH // 2 :] = 0
    cropped[HEIGHT // 2 :, :] = 0
    partial_path = out.parent / "partial.png"
    cv2.imwrite(str(partial_path), cropped)

    with pytest.raises(PreconditionError, match="fiducials decoded"):
        verify_mapping_image(partial_path, WIDTH, HEIGHT)


def test_generate_rejects_non_positive_dimensions(tmp_path):
    with pytest.raises(ValueError):
        generate_mapping_pattern(0, 100, tmp_path / "x.png")


def test_reserved_screen_id_is_out_of_normal_range():
    # 4-bit VP-QSP screen_id space is 0-15; MAPPING_SCREEN_ID must stay in range.
    assert 0 <= MAPPING_SCREEN_ID <= 15
