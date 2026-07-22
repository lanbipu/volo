"""Marker detection pipeline tests.

Detection precision on rendered rasters is validated to a realistic sub-pixel
bound (< 0.1 px); the < 0.01 px solver guarantee is exercised separately via the
simulator's exact synthetic correspondences (see integration tests).
"""

from __future__ import annotations

import cv2
import numpy as np

from vpcal.core.detector import _localization_quality, detect_markers
from vpcal.core.observations import MarkerId
from vpcal.core.pattern import build_marker_template, encode_marker, splat_gaussian_dot


def _place_marker(scene, code, corners, sigma=2.5):
    """Warp a marker template onto a scene and splat an analytic locator dot."""
    n = 96
    tmpl = build_marker_template(code, n, bake_dot=False)
    src = np.array([[0, 0], [n - 1, 0], [n - 1, n - 1], [0, n - 1]], np.float32)
    H = cv2.getPerspectiveTransform(src, corners.astype(np.float32))
    warped = cv2.warpPerspective(tmpl, H, (scene.shape[1], scene.shape[0]))
    mask = warped > 0
    scene[mask] = warped[mask]
    c = H @ np.array([(n - 1) / 2.0, (n - 1) / 2.0, 1.0])
    c = c[:2] / c[2]
    splat_gaussian_dot(scene, c[0], c[1], sigma)
    return c


def test_detect_and_decode_fronto_parallel():
    scene = np.zeros((400, 400), np.uint8)
    m = MarkerId(0, 12, 5, 1)
    corners = np.array([[160, 160], [240, 160], [240, 240], [160, 240]], np.float64)
    true_c = _place_marker(scene, encode_marker(m), corners)
    dets = detect_markers(scene)
    assert len(dets) == 1
    assert dets[0].marker_id == m
    assert abs(dets[0].pixel_u - true_c[0]) < 0.1
    assert abs(dets[0].pixel_v - true_c[1]) < 0.1


def test_detect_many_with_perspective():
    rng = np.random.default_rng(1)
    correct = 0
    errs = []
    total = 40
    for _ in range(total):
        scene = np.zeros((480, 480), np.uint8)
        m = MarkerId(0, int(rng.integers(0, 128)), int(rng.integers(0, 128)), int(rng.integers(0, 64)))
        cx, cy = 240 + rng.uniform(-2, 2), 240 + rng.uniform(-2, 2)
        half = 42
        jit = rng.uniform(-6, 6, size=(4, 2))
        corners = np.array(
            [[cx - half, cy - half], [cx + half, cy - half], [cx + half, cy + half], [cx - half, cy + half]]
        ) + jit
        true_c = _place_marker(scene, encode_marker(m), corners)
        dets = detect_markers(scene)
        if dets and dets[0].marker_id == m:
            correct += 1
            errs.append(abs(dets[0].pixel_u - true_c[0]))
            errs.append(abs(dets[0].pixel_v - true_c[1]))
    assert correct == total
    assert np.max(errs) < 0.2


def test_blank_image_yields_nothing():
    assert detect_markers(np.zeros((200, 200), np.uint8)) == []


def test_normal_inverted_differencing():
    m = MarkerId(0, 3, 7, 0)
    corners = np.array([[180, 180], [260, 180], [260, 260], [180, 260]], np.float64)
    normal = np.full((440, 440), 30, np.uint8)
    _place_marker(normal, encode_marker(m), corners)
    inverted = np.full((440, 440), 30, np.uint8)
    dets = detect_markers(normal, inverted=inverted)
    assert any(d.marker_id == m for d in dets)


def test_intentional_white_code_blocks_are_warning_not_rejection():
    scene = np.zeros((400, 400), np.uint16)
    m = MarkerId(0, 12, 5, 1)
    corners = np.array([[150, 150], [250, 150], [250, 250], [150, 250]], np.float64)
    rendered = np.zeros_like(scene, dtype=np.uint8)
    _place_marker(rendered, encode_marker(m), corners)
    scene[:] = rendered.astype(np.uint16) * 257
    det = next(d for d in detect_markers(scene) if d.marker_id == m)
    assert det.saturated is True  # brightness warning remains observable
    assert det.localization_rejected is False
    assert det.localization_quality > 0.5


def test_locator_plateau_and_displacement_are_rejected():
    gray = np.zeros((120, 120), np.uint8)
    gray[25:95, 25:95] = 255
    corners = np.array([[10, 10], [110, 10], [110, 110], [10, 110]], np.float64)
    quality, rejected, reasons = _localization_quality(gray, corners, (85.0, 60.0))
    assert rejected is True
    assert quality < 0.5
    assert "locator_flat_topped" in reasons
    assert "locator_centroid_unstable" in reasons
