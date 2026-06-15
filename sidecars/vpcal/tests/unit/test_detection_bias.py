"""Remediation A2 acceptance tests: pattern quantisation, signed differencing,
confidence wiring and detector robustness."""

from __future__ import annotations

import numpy as np

from vpcal.core.detector import detect_markers
from vpcal.core.observations import MarkerId
from vpcal.core.pattern import (
    build_marker_template,
    encode_marker,
    generate_pattern_images,
    splat_gaussian_dot,
)
from vpcal.core.screen_geometry import enumerate_markers, uv_to_pattern_pixel
from vpcal.models.screen import PlaneSection, ScreenDefinition


# ── A2.1: pattern dot at the exact fractional LED pixel ────────────────


def _analytic_dot_centroid(img: np.ndarray, fx: float, fy: float, win: int = 8):
    """Background-subtracted intensity centroid in a window around (fx, fy)."""
    x0, x1 = int(round(fx)) - win, int(round(fx)) + win + 1
    y0, y1 = int(round(fy)) - win, int(round(fy)) + win + 1
    region = img[y0:y1, x0:x1].astype(np.float64)
    bg = float(np.median(region))
    w = np.clip(region - bg, 0.0, None)
    ys, xs = np.mgrid[y0:y1, x0:x1]
    return float((xs * w).sum() / w.sum()), float((ys * w).sum() / w.sum())


def test_pattern_dot_matches_world_map_uv(tmp_path):
    """Dot centroid in the generated pattern == uv_to_pattern_pixel(marker UV)
    to < 0.05 LED pixels — no integer quantisation (A2.1)."""
    import cv2

    # 357×355 px section (odd, not divisible by the 8 sub-positions) → marker
    # UVs land on genuinely fractional pixel positions.
    screen = ScreenDefinition(
        name="q", unit="mm", cabinet_size=(500, 500), led_pixel_pitch_mm=2.8,
        markers_per_cabinet=4,
        sections=[PlaneSection(name="w", width_mm=999.6, height_mm=994.0, origin=[0, 0, 0])],
    )
    info = generate_pattern_images(screen, tmp_path, markers_per_cabinet=4)
    assert not info["warnings"]
    img = cv2.imread(str(tmp_path / "normal.png"), cv2.IMREAD_GRAYSCALE)
    h, w = img.shape
    markers = enumerate_markers(screen, markers_per_cabinet=4)
    worst = 0.0
    for m in markers:
        fx, fy = uv_to_pattern_pixel(m.u, m.v, w, h)
        # Confirm the target is genuinely fractional for at least some markers.
        cx, cy = _analytic_dot_centroid(img, fx, fy)
        worst = max(worst, abs(cx - fx), abs(cy - fy))
    assert worst < 0.05, f"dot centroid deviates {worst:.3f} px from world-map UV position"
    # Sanity: the layout actually exercises fractional positions.
    fracs = [abs((uv_to_pattern_pixel(m.u, m.v, w, h)[0] + 0.5) % 1.0 - 0.5) for m in markers]
    assert max(fracs) > 0.1


# ── A2.2: centroid on the signed difference image ──────────────────────


def _place_marker(scene, code, top_left, size=96, sigma_frac=0.045):
    """Paste a fronto-parallel marker + analytic dot; returns the dot centre."""
    tmpl = build_marker_template(code, size, bake_dot=False)
    y, x = top_left
    region = scene[y : y + size, x : x + size]
    np.copyto(region, np.maximum(region, tmpl))
    panel = size - 2 * int(round(size * 0.14))
    cx, cy = x + (size - 1) / 2.0, y + (size - 1) / 2.0
    splat_gaussian_dot(scene, cx, cy, sigma=panel * sigma_frac)
    return cx, cy


def test_differenced_centroid_immune_to_ambient_light():
    """Ambient light (linear gradient + a local reflection blob near the dot)
    hits normal and inverted exposures identically: the signed-difference
    centroid stays < 0.05 px while the normal-frame centroid is visibly
    biased (A2.2)."""
    m = MarkerId(0, 3, 7, 0)
    code = encode_marker(m)
    base = np.zeros((300, 300), np.uint8)
    true_c = _place_marker(base, code, (102, 102))
    inverted_base = 255 - base

    # Ambient field: 0→60 linear gradient + a bright reflection blob whose
    # centre sits 5 px to the right of the locator dot.
    grad = np.tile(np.linspace(0, 60, 300, dtype=np.float64), (300, 1))
    ys, xs = np.mgrid[0:300, 0:300]
    blob = 80.0 * np.exp(-(((xs - (true_c[0] + 5)) ** 2 + (ys - true_c[1]) ** 2) / (2 * 36.0)))
    ambient = grad + blob
    normal = np.clip(base.astype(np.float64) * 0.6 + ambient, 0, 255).astype(np.uint8)
    inverted = np.clip(inverted_base.astype(np.float64) * 0.6 + ambient, 0, 255).astype(np.uint8)

    diff_dets = detect_markers(normal, inverted=inverted)
    assert len(diff_dets) == 1 and diff_dets[0].marker_id == m
    assert diff_dets[0].differenced is True
    diff_err = np.hypot(diff_dets[0].pixel_u - true_c[0], diff_dets[0].pixel_v - true_c[1])

    normal_dets = detect_markers(normal)
    assert len(normal_dets) == 1 and normal_dets[0].marker_id == m
    assert normal_dets[0].differenced is False
    normal_err = np.hypot(normal_dets[0].pixel_u - true_c[0], normal_dets[0].pixel_v - true_c[1])

    assert diff_err < 0.05, f"differenced centroid biased by {diff_err:.3f} px"
    assert normal_err > 0.3, (
        f"expected visible gradient bias on the normal-only path, got {normal_err:.3f} px"
    )
    assert normal_err > 5 * diff_err


# ── A2.4: adaptive-threshold fallback when global Otsu fails ────────────


def test_adaptive_threshold_fallback_on_otsu_failure():
    """A dominant bright region pushes Otsu above the (dim) marker; the
    block-wise adaptive retry still finds and decodes it (A2.4)."""
    m = MarkerId(0, 5, 2, 0)
    scene = np.zeros((400, 400), np.uint8)
    _place_marker(scene, encode_marker(m), (40, 40))
    # Dim the marker, then add a huge saturated patch that dominates Otsu.
    scene = (scene.astype(np.float64) * 0.35).astype(np.uint8)
    scene[200:, :] = 255

    from vpcal.core.detector import _threshold

    binary = _threshold(scene)
    assert binary[40:136, 40:136].max() == 0, "precondition: global Otsu must miss the marker"

    dets = detect_markers(scene)
    assert any(d.marker_id == m for d in dets), "adaptive fallback failed to recover the marker"


# ── A2.3 + A2.4: pipeline wiring (hard reject + QA report) ──────────────


def _mini_session_dir(tmp_path, scene):
    """Write a one-frame session: image (normal only), tracking, screen."""
    import cv2
    import json

    (tmp_path / "captures" / "normal").mkdir(parents=True)
    cv2.imwrite(str(tmp_path / "captures" / "normal" / "0000.png"), scene)
    (tmp_path / "tracking.jsonl").write_text(
        json.dumps({
            "frame_id": 0, "timestamp_s": 0.0, "position": [0.0, 0.0, 0.0],
            "rotation": {"order": "quaternion", "values": [1.0, 0.0, 0.0, 0.0]},
        }) + "\n"
    )
    return {
        "images": {"path": "./captures/normal/", "format": "png"},
        "tracking": {"path": "./tracking.jsonl", "coordinate_system": "vicon"},
        "screen": {"path": "./screen.json"},
    }


def test_topology_rejected_detection_excluded_and_counted(tmp_path):
    """A decode-valid but topology-contradicting detection is hard-rejected
    (never reaches the solver) and counted in the QA report (A2.3); a missing
    inverted sibling is reported, not silently ignored (A2.4)."""
    import pytest

    from vpcal.core.pipeline import _detect_observations
    from vpcal.core.screen_geometry import marker_world_map
    from vpcal.models.session import SessionConfig
    from vpcal.models.tracking import TrackingFrame

    scene = np.zeros((600, 600), np.uint8)
    rogue = MarkerId(0, 11, 2, 0)  # decodes fine, but its cabinet is far away
    for r in range(5):
        for c in range(5):
            mid = rogue if (r, c) == (2, 2) else MarkerId(0, c, r, 0)
            _place_marker(scene, encode_marker(mid), (30 + r * 110, 30 + c * 110), size=80)

    raw = _mini_session_dir(tmp_path, scene)
    screen = ScreenDefinition(
        name="t", unit="mm", cabinet_size=(500, 500), led_pixel_pitch_mm=2.8,
        markers_per_cabinet=1,
        sections=[PlaneSection(name="w", width_mm=6000, height_mm=2500, origin=[0, 0, 0])],
    )
    raw["lens"] = {
        "focal_length_mm": 24.0, "sensor_width_mm": 36.0, "sensor_height_mm": 24.0,
        "principal_point_offset_mm": [0.0, 0.0],
        "image_width_px": 600, "image_height_px": 600,
        "distortion": {"model": "brown_conrady"},
    }
    session = SessionConfig.model_validate(raw)
    world_map = marker_world_map(screen, markers_per_cabinet=1)
    assert rogue in world_map  # rejection must come from confidence, not lookup
    frames = [TrackingFrame(frame_id=0, timestamp_s=0.0, position=[0, 0, 0],
                            rotation={"order": "quaternion", "values": [1, 0, 0, 0]})]

    images = [str(tmp_path / "captures" / "normal" / "0000.png")]
    with pytest.warns(UserWarning, match="inverted frame not found"):
        observations, report = _detect_observations(session, tmp_path, images, world_map, frames)

    assert all(o.marker_id != rogue for o in observations)
    assert len(observations) == 24
    assert report["detection_rejected_topology"] == 1
    # No inverted sibling → differencing reported off, with a warning (A2.4).
    assert report["differencing_enabled"] is False
    assert any("inverted frame not found" in w for w in report["warnings"])
