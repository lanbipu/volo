"""VP-QSP detector: render -> perspective-warp -> detect round-trip.

Validates decoding (screen_id/col/row/local_id) and sub-pixel centroid accuracy
under perspective, plus the multi-screen screen_id filter. (The detector decodes
and centroids correctly regardless of the warp's handedness; the BA-side
correspondence chirality is exercised in test_vpqsp_reconstruct.)
"""
from __future__ import annotations

import cv2
import numpy as np

from lmt_vba_sidecar.vpqsp_detect import _order_corners, detect_markers_image, detect_vpqsp_markers
from lmt_vba_sidecar.vpqsp_layout import (
    choose_marker_grid,
    marker_center_px,
    render_cabinet_tile,
)

_RES = (630, 630)
_IMG = (1600, 1200)
_K = np.array([[2200.0, 0, _IMG[0] / 2], [0, 2200.0, _IMG[1] / 2], [0, 0, 1]], float)


def _warp_tile(tile, yaw_deg):
    """Warp a cabinet tile into a synthetic camera image at a given yaw."""
    h, w = tile.shape
    hw = _RES[0] / 2.0
    yaw = np.deg2rad(yaw_deg)
    d = 1800.0
    cp = d * np.array([np.sin(yaw), 0.0, -np.cos(yaw)])
    fwd = -cp / np.linalg.norm(cp)
    up = np.array([0.0, -1.0, 0.0])
    right = np.cross(up, fwd); right /= np.linalg.norm(right)
    up2 = np.cross(fwd, right)
    Rc = np.stack([right, up2, fwd]); tc = -Rc @ cp
    lc = np.array([[-hw, -hw, 0], [hw, -hw, 0], [hw, hw, 0], [-hw, hw, 0]], float)
    cam = (lc @ Rc.T) + tc
    pix = (_K @ cam.T).T
    dst = (pix[:, :2] / pix[:, 2:3]).astype(np.float32)
    src = np.array([[0, 0], [w, 0], [w, h], [0, h]], np.float32)
    H = cv2.getPerspectiveTransform(src, dst)
    canvas = np.full((_IMG[1], _IMG[0]), 64, np.uint8)
    warped = cv2.warpPerspective(tile, H, _IMG, flags=cv2.INTER_LINEAR)
    mask = cv2.warpPerspective(np.full(tile.shape, 255, np.uint8), H, _IMG, flags=cv2.INTER_NEAREST)
    canvas[mask > 0] = warped[mask > 0]
    return canvas, H


def test_detect_decodes_all_markers_fronto_parallel():
    mx, my, mpx = choose_marker_grid(_RES)
    tile = render_cabinet_tile(screen_id_code=3, col=5, row=7, markers_x=mx, markers_y=my,
                               marker_px=mpx, resolution_px=_RES)
    dets = detect_markers_image(tile)
    assert len(dets) == mx * my
    local_ids = set()
    max_err = 0.0
    for m, u, v, _sigma in dets:
        assert (m.screen_id, m.col, m.row) == (3, 5, 7)
        local_ids.add(m.local_id)
        cx, cy = marker_center_px(m.local_id, markers_x=mx, markers_y=my, resolution_px=_RES)
        max_err = max(max_err, np.hypot(u - cx, v - cy))
    assert local_ids == set(range(mx * my))  # unique, complete
    assert max_err < 1.0  # sub-pixel centroid on the rendered dot


def test_detect_subpixel_under_perspective():
    mx, my, mpx = choose_marker_grid(_RES)
    tile = render_cabinet_tile(screen_id_code=0, col=0, row=0, markers_x=mx, markers_y=my,
                               marker_px=mpx, resolution_px=_RES)
    canvas, H = _warp_tile(tile, yaw_deg=20.0)
    dets = detect_markers_image(canvas)
    assert len(dets) == mx * my  # all decoded under a 20-degree view
    errs = []
    for m, u, v, _sigma in dets:
        cx, cy = marker_center_px(m.local_id, markers_x=mx, markers_y=my, resolution_px=_RES)
        proj = H @ np.array([cx, cy, 1.0])
        proj = proj[:2] / proj[2]
        errs.append(np.hypot(u - proj[0], v - proj[1]))
    # Gaussian centroid stays sub-pixel vs the projected rendered centre. The
    # denser default grid (TARGET_MARKERS_SHORT=6) trades a slightly larger
    # centroid sigma (smaller markers) for more observations/cabinet; ~0.8px here
    # is well within the fast-mode 0.5-1.5px reprojection budget and the BA
    # tolerates it (see test_vpqsp_reconstruct, <1px rms).
    assert np.median(errs) < 1.0


def test_screen_id_filter_drops_other_screens(tmp_path):
    mx, my, mpx = choose_marker_grid(_RES)
    tile = render_cabinet_tile(screen_id_code=2, col=1, row=0, markers_x=mx, markers_y=my,
                               marker_px=mpx, resolution_px=_RES)
    p = tmp_path / "view.png"
    cv2.imwrite(str(p), tile)
    # Target screen 2 -> all markers kept; target screen 9 -> none (different screen).
    kept = detect_vpqsp_markers([str(p)], screen_id_code=2)[str(p)]
    dropped = detect_vpqsp_markers([str(p)], screen_id_code=9)[str(p)]
    assert len(kept) == mx * my
    assert dropped == []
    # Observation shape matches the ChArUco detection seam (+ screen_id/local_id).
    o = kept[0]
    assert set(o) == {"cabinet", "screen_id", "local_id", "corner_px", "sigma_px"}
    assert tuple(o["cabinet"]) == (1, 0) and o["screen_id"] == 2


def test_unreadable_image_yields_empty_list():
    out = detect_vpqsp_markers(["/does/not/exist.png"])
    assert out == {"/does/not/exist.png": []}


# ---------- FIX-24: _order_corners stability at all roll angles ----------
def _rotate_pts(pts, angle_deg, center):
    a = np.deg2rad(angle_deg)
    R = np.array([[np.cos(a), -np.sin(a)], [np.sin(a), np.cos(a)]])
    return (pts - center) @ R.T + center


def test_order_corners_stable_across_all_rolls():
    """FIX-24: at ~45° roll the old argmin(sum)/argmin(diff) trick picks the same
    vertex for TL and TR — the polar-angle sort must be stable at every roll."""
    hw = 50.0
    base = np.array([[-hw, -hw], [hw, -hw], [hw, hw], [-hw, hw]], float)  # TL TR BR BL
    center = np.array([300.0, 300.0])
    base_centered = base + center
    for roll in range(0, 360, 5):
        pts = _rotate_pts(base_centered, roll, center)
        ordered = _order_corners(pts.copy())
        # All 4 indices must be distinct
        dists = np.linalg.norm(ordered[:, None] - ordered[None, :], axis=-1)
        np.fill_diagonal(dists, 999)
        assert dists.min() > 1.0, f"roll={roll}°: duplicate vertex in ordering"
        # Verify winding: cross product of consecutive edges must all have the same sign
        edges = np.diff(np.vstack([ordered, ordered[:1]]), axis=0)
        crosses = edges[:-1, 0] * edges[1:, 1] - edges[:-1, 1] * edges[1:, 0]
        assert np.all(crosses > 0) or np.all(crosses < 0), (
            f"roll={roll}°: corners not consistently wound")
