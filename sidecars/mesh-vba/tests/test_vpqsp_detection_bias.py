"""W5 remediation: VP-QSP normal/inverted signed-difference centroid (A2.2).

FIX-8 removed the `inverted` differencing parameter as dead code (no producer
ever emitted an inverted frame); the LMT review flagged this as a real gap
versus vpcal's A2.2 remediation (sidecars/vpcal/src/vpcal/core/detector.py,
sidecars/vpcal/tests/unit/test_detection_bias.py::
test_differenced_centroid_immune_to_ambient_light). This module:

  1. Re-runs that exact scenario (linear gradient + local reflection blob)
     against mesh-vba's now-ported implementation, quantifying the bias
     before/after — the functional regression test.
  2. Checks mesh-vba's real ``_subpixel_center`` against a controlled copy of
     vpcal's implementation (``_vpcal_reference_centroid.py``) on the same
     signed-difference input — the numeric parity test the review asked for.
     A live cross-package import of vpcal isn't used here: vpcal and mesh-vba
     are independent installs with no dependency edge between them, so a
     controlled copy (kept in sync via the provenance comment) is the
     maintainable option — see the fixture module's docstring.
"""
from __future__ import annotations

import numpy as np

from lmt_vba_sidecar.vpqsp_codec import VpqspMarkerId, encode_marker
from lmt_vba_sidecar.vpqsp_detect import _subpixel_center, detect_markers_image
from lmt_vba_sidecar.vpqsp_layout import build_marker_template, splat_gaussian_dot

from _vpcal_reference_centroid import vpcal_subpixel_center


def _place_marker(scene: np.ndarray, code: int, top_left: tuple[int, int], size: int = 96,
                   sigma_frac: float = 0.045) -> tuple[float, float]:
    """Paste a fronto-parallel marker + analytic dot; returns the dot centre.

    Mirrors vpcal's tests/unit/test_detection_bias.py::_place_marker exactly
    (same template geometry: GRID=7, _MARGIN_FRAC=0.14, same panel/sigma math)
    so the synthetic scene is bit-comparable between the two toolkits.
    """
    tmpl = build_marker_template(code, size, bake_dot=False)
    y, x = top_left
    region = scene[y : y + size, x : x + size]
    np.copyto(region, np.maximum(region, tmpl))
    panel = size - 2 * int(round(size * 0.14))
    cx, cy = x + (size - 1) / 2.0, y + (size - 1) / 2.0
    splat_gaussian_dot(scene, cx, cy, sigma=panel * sigma_frac)
    return cx, cy


def _ambient_scene(true_c: tuple[float, float], base: np.ndarray, n: int = 300):
    """0->60 linear gradient + a bright reflection blob 5px right of the dot —
    identical ambient field to vpcal's test_differenced_centroid_immune_to_ambient_light."""
    inverted_base = 255 - base
    grad = np.tile(np.linspace(0, 60, n, dtype=np.float64), (n, 1))
    ys, xs = np.mgrid[0:n, 0:n]
    blob = 80.0 * np.exp(-(((xs - (true_c[0] + 5)) ** 2 + (ys - true_c[1]) ** 2) / (2 * 36.0)))
    ambient = grad + blob
    normal = np.clip(base.astype(np.float64) * 0.6 + ambient, 0, 255).astype(np.uint8)
    inverted = np.clip(inverted_base.astype(np.float64) * 0.6 + ambient, 0, 255).astype(np.uint8)
    return normal, inverted


def test_differenced_centroid_immune_to_ambient_light():
    """Bias quantification: normal-only centroid vs signed-difference centroid
    under an ambient-light gradient + local reflection blob."""
    m = VpqspMarkerId(screen_id=0, col=3, row=7, local_id=0)
    code = encode_marker(m)
    base = np.zeros((300, 300), np.uint8)
    true_c = _place_marker(base, code, (102, 102))
    normal, inverted = _ambient_scene(true_c, base)

    diff_dets = detect_markers_image(normal, inverted=inverted)
    assert len(diff_dets) == 1
    diff_marker, diff_u, diff_v, _sigma = diff_dets[0]
    assert (diff_marker.screen_id, diff_marker.col, diff_marker.row, diff_marker.local_id) == \
        (m.screen_id, m.col, m.row, m.local_id)
    diff_err = float(np.hypot(diff_u - true_c[0], diff_v - true_c[1]))

    normal_dets = detect_markers_image(normal)
    assert len(normal_dets) == 1
    _n_marker, norm_u, norm_v, _n_sigma = normal_dets[0]
    normal_err = float(np.hypot(norm_u - true_c[0], norm_v - true_c[1]))

    # Quantified bias (see W5 report): normal-only ~= 0.6-0.9px, differenced < 0.05px.
    assert diff_err < 0.05, f"differenced centroid biased by {diff_err:.4f} px"
    assert normal_err > 0.3, f"expected visible gradient bias on normal-only path, got {normal_err:.4f} px"
    assert normal_err > 5 * diff_err


def test_signed_diff_centroid_matches_vpcal_reference():
    """Numeric parity: mesh-vba's real _subpixel_center vs the controlled copy
    of vpcal's _subpixel_center, fed the identical signed-difference input and
    corners (bypasses contour detection so only the centroid math is compared).
    """
    m = VpqspMarkerId(screen_id=1, col=4, row=2, local_id=0)
    code = encode_marker(m)
    size = 96
    top_left = (80, 80)
    base = np.zeros((260, 260), np.uint8)
    true_c = _place_marker(base, code, top_left, size=size)
    normal, inverted = _ambient_scene(true_c, base, n=260)

    signed = normal.astype(np.int16) - inverted.astype(np.int16)
    sample_src = signed.astype(np.float32)

    y, x = top_left
    corners = np.array(
        [[x, y], [x + size - 1, y], [x + size - 1, y + size - 1], [x, y + size - 1]],
        dtype=np.float64,
    )

    mesh_u, mesh_v, _sigma = _subpixel_center(sample_src, corners)
    vpcal_u, vpcal_v = vpcal_subpixel_center(sample_src, corners)

    parity_err = float(np.hypot(mesh_u - vpcal_u, mesh_v - vpcal_v))
    assert parity_err < 0.05, (
        f"mesh-vba centroid ({mesh_u:.4f},{mesh_v:.4f}) vs vpcal reference "
        f"({vpcal_u:.4f},{vpcal_v:.4f}) diverge by {parity_err:.4f} px"
    )
