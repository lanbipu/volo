"""FIX-8: VP-QSP detection blur-degradation envelope, pinned in CI.

Characterisation (proper render + Gaussian blur, deterministic): decode rate
by marker size x blur sigma. The SAFE envelope below is asserted so a detector
change that silently shrinks it fails loud; the known cliff (small markers at
sigma>=3) is documented data, not a target.

Measured matrix (36-marker tiles, global-Otsu front end):

    marker_px | s=0  s=1  s=2  s=3  s=4
       48     |  36   36   28    0    0
       56     |  36   36   36    1    0
       64     |  36   36   36   10    0
       86     |  36   36   36   36   24
      120     |  36   36   36   36   36

Threshold-stage alternatives were evaluated against this matrix
(adaptiveThreshold blocks 31/51/101, CLAHE+Otsu) and none improved it — the
cliff is contour merging + rectified cell-contrast collapse (a resolution
limit). Operator guidance: a marker must subtend >= ~48 camera px at effective
blur sigma <= 1, >= 64 px at sigma <= 2, >= ~86 px at sigma = 3.
"""
from __future__ import annotations

import cv2
import numpy as np
import pytest

from lmt_vba_sidecar.vpqsp_detect import detect_markers_image
from lmt_vba_sidecar.vpqsp_layout import DEFAULT_MARKER_FILL, render_cabinet_tile


def _tile(marker_px: int, n: int = 6):
    cell = int(round(marker_px / DEFAULT_MARKER_FILL))
    res = (n * cell, n * cell)
    tile = render_cabinet_tile(screen_id_code=1, col=2, row=3, markers_x=n,
                               markers_y=n, marker_px=marker_px, resolution_px=res)
    return tile, n * n


def _rate(marker_px: int, sigma: float) -> tuple[int, int]:
    tile, total = _tile(marker_px)
    img = tile if sigma == 0 else cv2.GaussianBlur(tile, (0, 0), sigma)
    return len(detect_markers_image(img)), total


# Safe envelope: (marker_px, sigma, min_detections_of_36)
_SAFE = [
    (48, 0, 36), (48, 1, 36),
    (56, 0, 36), (56, 1, 36), (56, 2, 36),
    (64, 0, 36), (64, 1, 36), (64, 2, 36),
    (86, 0, 36), (86, 1, 36), (86, 2, 36), (86, 3, 36),
    (120, 0, 36), (120, 1, 36), (120, 2, 36), (120, 3, 36), (120, 4, 36),
]


@pytest.mark.parametrize("marker_px,sigma,min_det", _SAFE)
def test_safe_envelope_holds(marker_px, sigma, min_det):
    got, total = _rate(marker_px, sigma)
    assert got >= min_det, (
        f"marker {marker_px}px @ sigma={sigma}: {got}/{total} detected "
        f"(envelope requires >= {min_det}) — detector regression")


def test_known_cliff_is_documented_not_relied_on():
    """The cliff exists (48px @ sigma=3 decodes ~nothing). If this ever starts
    PASSING wholesale, the envelope doc above is stale — update it (and
    consider widening the safe envelope) rather than deleting this test."""
    got, total = _rate(48, 3)
    assert got <= total // 3, (
        f"48px @ sigma=3 now decodes {got}/{total} — the documented envelope "
        f"is out of date, refresh the matrix in this file's docstring")
