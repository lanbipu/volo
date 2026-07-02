"""Gray-code frame tags (core/graycode.py) — encode/render/decode roundtrips."""

from __future__ import annotations

import numpy as np
import pytest

from vpcal.core.graycode import (
    TAG_CELLS,
    decode_tag,
    gray_decode,
    gray_encode,
    render_tags,
)


def test_gray_code_roundtrip_all_8bit():
    for n in range(256):
        assert gray_decode(gray_encode(n)) == n
    # Successive Gray codes differ in exactly one bit.
    for n in range(255):
        assert bin(gray_encode(n) ^ gray_encode(n + 1)).count("1") == 1


@pytest.mark.parametrize("index", [0, 1, 7, 42, 255])
def test_render_decode_roundtrip(index):
    img = np.full((480, 640), 128, dtype=np.uint8)
    render_tags(img, index, cell_px=16)
    tag = decode_tag(img, cell_px=16)
    assert tag is not None
    assert tag.frame_index == index
    assert tag.inverted is False


def test_inverted_frame_reports_polarity():
    img = np.zeros((480, 640), dtype=np.uint8)
    render_tags(img, 5, cell_px=16)
    tag = decode_tag(255 - img, cell_px=16)
    assert tag is not None
    assert tag.frame_index == 5
    assert tag.inverted is True


def test_decode_rejects_flat_image_and_corruption():
    flat = np.full((480, 640), 100, dtype=np.uint8)
    assert decode_tag(flat, cell_px=16) is None
    img = np.full((480, 640), 128, dtype=np.uint8)
    render_tags(img, 9, cell_px=16)
    # Corrupt one data cell in every corner → parity fails everywhere.
    for y0, x0 in [(8, 8), (8, 640 - 8 - TAG_CELLS * 16), (480 - 8 - 16, 8),
                   (480 - 8 - 16, 640 - 8 - TAG_CELLS * 16)]:
        cell = img[y0:y0 + 16, x0 + 2 * 16:x0 + 3 * 16]
        cell[:] = 255 - cell
    assert decode_tag(img, cell_px=16) is None


def test_render_out_of_range_raises():
    img = np.zeros((480, 640), dtype=np.uint8)
    with pytest.raises(ValueError):
        render_tags(img, 256, cell_px=16)
    with pytest.raises(ValueError):
        render_tags(np.zeros((20, 20), dtype=np.uint8), 1, cell_px=16)


def test_pattern_generation_embeds_decodable_tags(tmp_path):
    """pattern generate --graycode-tags → tags decodable on normal & inverted."""
    import cv2

    from vpcal.core.pattern import generate_pattern_images
    from vpcal.models.screen import PlaneSection, ScreenDefinition

    screen = ScreenDefinition(
        name="s", unit="mm", cabinet_size=(500, 500), led_pixel_pitch_mm=1.0,
        markers_per_cabinet=4,
        sections=[PlaneSection(name="w", width_mm=1000, height_mm=800, origin=[0, 0, 0])],
    )
    summary = generate_pattern_images(screen, tmp_path, markers_per_cabinet=4,
                                      graycode_tags=True)
    assert summary["graycode_tags"] is True
    normal = cv2.imread(str(tmp_path / "normal.png"), cv2.IMREAD_GRAYSCALE)
    inverted = cv2.imread(str(tmp_path / "inverted.png"), cv2.IMREAD_GRAYSCALE)
    tag_n = decode_tag(normal)
    tag_i = decode_tag(inverted)
    assert tag_n is not None and tag_n.frame_index == 0 and not tag_n.inverted
    assert tag_i is not None and tag_i.frame_index == 0 and tag_i.inverted
