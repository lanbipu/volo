"""Nominal cabinet center position tests per shape_prior."""
from __future__ import annotations

import pytest

from lmt_vba_sidecar.ipc import CabinetArray
from lmt_vba_sidecar.nominal import nominal_cabinet_centers_model_frame


def test_flat_2x1_grid_in_meters() -> None:
    cab = CabinetArray(cols=2, rows=1, cabinet_size_mm=[500.0, 500.0])
    centers = nominal_cabinet_centers_model_frame(cab, "flat")
    assert centers[(0, 0)] == pytest.approx((0.25, 0.25, 0.0), abs=1e-9)
    assert centers[(1, 0)] == pytest.approx((0.75, 0.25, 0.0), abs=1e-9)


def test_flat_skips_absent_cells() -> None:
    cab = CabinetArray(
        cols=2, rows=2, cabinet_size_mm=[500.0, 500.0],
        absent_cells=[(1, 1)],
    )
    centers = nominal_cabinet_centers_model_frame(cab, "flat")
    assert (1, 1) not in centers
    assert len(centers) == 3


def test_curved_lifts_z_off_plane_at_edges() -> None:
    cab = CabinetArray(cols=4, rows=1, cabinet_size_mm=[500.0, 500.0])
    centers = nominal_cabinet_centers_model_frame(
        cab, {"curved": {"radius_mm": 5000.0}},
    )
    zs = [centers[(c, 0)][2] for c in range(4)]
    # Outer columns should be lifted more than inner ones.
    assert max(zs) - min(zs) > 0.001


def test_unknown_shape_prior_rejected() -> None:
    cab = CabinetArray(cols=1, rows=1, cabinet_size_mm=[500.0, 500.0])
    with pytest.raises(ValueError, match="unsupported shape_prior"):
        nominal_cabinet_centers_model_frame(cab, {"bogus": {}})


def test_folded_fails_fast_not_silently_flat() -> None:
    cab = CabinetArray(cols=4, rows=1, cabinet_size_mm=[500.0, 500.0])
    with pytest.raises(ValueError, match="folded.*not supported"):
        nominal_cabinet_centers_model_frame(cab, {"folded": {"fold_seam_columns": [2]}})


def test_negative_curved_radius_rejected() -> None:
    cab = CabinetArray(cols=4, rows=1, cabinet_size_mm=[500.0, 500.0])
    with pytest.raises(ValueError, match="positive"):
        nominal_cabinet_centers_model_frame(cab, {"curved": {"radius_mm": -100.0}})


def test_zero_curved_radius_rejected() -> None:
    cab = CabinetArray(cols=4, rows=1, cabinet_size_mm=[500.0, 500.0])
    with pytest.raises(ValueError, match="positive"):
        nominal_cabinet_centers_model_frame(cab, {"curved": {"radius_mm": 0.0}})


def test_nonfinite_curved_radius_rejected() -> None:
    cab = CabinetArray(cols=4, rows=1, cabinet_size_mm=[500.0, 500.0])
    with pytest.raises(ValueError, match="finite"):
        nominal_cabinet_centers_model_frame(cab, {"curved": {"radius_mm": float("inf")}})


def test_curved_radius_too_small_for_screen_rejected() -> None:
    """If radius < ~half screen width, the arc angle exceeds 90° → unstable."""
    cab = CabinetArray(cols=20, rows=1, cabinet_size_mm=[500.0, 500.0])  # 10m wide
    with pytest.raises(ValueError, match="too small"):
        nominal_cabinet_centers_model_frame(cab, {"curved": {"radius_mm": 1000.0}})


def test_1x1_grid_returns_single_point() -> None:
    """1×1 grids yield a single nominal — caller (reconstruct) handles this
    by enforcing the 3-anchor minimum in Procrustes; nominal returns what
    the geometry says."""
    cab = CabinetArray(cols=1, rows=1, cabinet_size_mm=[500.0, 500.0])
    centers = nominal_cabinet_centers_model_frame(cab, "flat")
    assert len(centers) == 1
    assert (0, 0) in centers


import numpy as np

from lmt_vba_sidecar.ipc import CabinetArray
from lmt_vba_sidecar.nominal import nominal_cabinet_normals_model_frame


def _cab(cols, rows):
    return CabinetArray.model_validate(
        {"cols": cols, "rows": rows, "absent_cells": [], "cabinet_size_mm": [500, 500]}
    )


def test_flat_normals_all_face_plus_z():
    normals = nominal_cabinet_normals_model_frame(_cab(3, 1), "flat")
    assert set(normals.keys()) == {(0, 0), (1, 0), (2, 0)}
    for n in normals.values():
        np.testing.assert_allclose(n, [0.0, 0.0, 1.0], atol=1e-9)


def test_curved_normals_match_arc_tangent_and_are_unit():
    # Wide arc: cols=5, 500mm each => total 2500mm; radius generous so angle<90.
    cab = _cab(5, 1)
    shape = {"curved": {"radius_mm": 3000.0}}
    normals = nominal_cabinet_normals_model_frame(cab, shape)
    # Each normal is a unit vector with zero y-component (arc bends in x-z).
    for (col, _row), n in normals.items():
        n = np.asarray(n)
        assert abs(np.linalg.norm(n) - 1.0) < 1e-9
        assert abs(n[1]) < 1e-12
    # Concave arc (curvature center on the +z/audience side): normals CONVERGE
    # toward it — left-of-center tilts to POSITIVE x, right-of-center to
    # NEGATIVE x. (The pre-FIX-1 mirrored formula had these diverging.)
    assert normals[(0, 0)][0] > 0.0
    assert normals[(4, 0)][0] < 0.0
    # Center-most cabinet (col 2, near arc center) faces nearly +z.
    assert normals[(2, 0)][2] > 0.99


def test_curved_normal_convention_matches_center_geometry():
    # The normal equals R_world_from_cab @ [0,0,1] for the TILE rotation R_y(-a)
    # that lays a rigid tile tangent to the arc placing the center
    # (x = R*sin a + W/2, z = R*(1-cos a)): normal = R_y(-a) @ [0,0,1]
    # = [-sin a, 0, cos a]. (FIX-1: [sin a, 0, cos a] was the mirror.)
    import math
    cab = _cab(5, 1)
    radius = 3000.0
    normals = nominal_cabinet_normals_model_frame(cab, {"curved": {"radius_mm": radius}})
    cw = 500.0
    total_w = 5 * cw
    for col in range(5):
        x_mm = (col + 0.5) * cw
        chord_x = x_mm - total_w / 2.0
        a = chord_x / radius
        np.testing.assert_allclose(
            normals[(col, 0)], [-math.sin(a), 0.0, math.cos(a)], atol=1e-9
        )


from lmt_vba_sidecar.nominal import nominal_cabinet_poses_model_frame


def test_curved_normal_perpendicular_to_arc_tangent():
    """FIX-1 acceptance invariant: for ANY curved prior, every cabinet normal is
    perpendicular to the arc tangent at its center (the mirrored formula gave
    normal . tangent = sin 2a != 0)."""
    import math
    for cols, radius in [(5, 3000.0), (8, 4000.0), (12, 6000.0), (4, 1500.0)]:
        cab = _cab(cols, 1)
        normals = nominal_cabinet_normals_model_frame(cab, {"curved": {"radius_mm": radius}})
        cw = 500.0
        total_w = cols * cw
        for col in range(cols):
            a = ((col + 0.5) * cw - total_w / 2.0) / radius
            tangent = np.array([math.cos(a), 0.0, math.sin(a)])
            dot = float(np.dot(np.asarray(normals[(col, 0)]), tangent))
            assert abs(dot) < 1e-9, (
                f"cols={cols} r={radius} col={col}: normal.tangent={dot:.2e} "
                f"(mirrored convention gives sin 2a = {math.sin(2*a):.2e})")


def test_curved_adjacent_tiles_share_edge_no_gap():
    """FIX-1 acceptance invariant: adjacent rigid tiles posed by the nominal
    SE(3) poses meet at their shared vertical edge (chord-continuous, gap well
    under 1mm). The mirrored R_y(+a) opened >100mm gaps."""
    cw, ch = 500.0, 500.0
    for cols, radius in [(5, 3000.0), (10, 4000.0)]:
        cab = _cab(cols, 2)
        poses = nominal_cabinet_poses_model_frame(cab, {"curved": {"radius_mm": radius}})
        for row in range(2):
            for col in range(cols - 1):
                R_l, t_l = poses[(col, row)]
                R_r, t_r = poses[(col + 1, row)]
                for y in (-ch / 2.0, ch / 2.0):
                    right_edge_of_left = np.asarray(t_l) * 1000.0 + R_l @ np.array([cw / 2.0, y, 0.0])
                    left_edge_of_right = np.asarray(t_r) * 1000.0 + R_r @ np.array([-cw / 2.0, y, 0.0])
                    gap = float(np.linalg.norm(right_edge_of_left - left_edge_of_right))
                    # Tangent-at-center tiles meet to third order: |overlap| =
                    # R*(da^3)/12 where da = cw/R (~1.16mm at cols=5, r=3000).
                    # The mirrored R_y(+a) misses to FIRST order (~hundreds of mm),
                    # so 2mm cleanly separates correct from mirrored.
                    assert gap < 2.0, f"cols={cols} r={radius} ({col},{row}) y={y}: gap {gap:.2f}mm"


def test_multirow_centers_y_up_row0_top():
    """FIX-2: model frame is +y-UP with cabinet row 0 at the wall TOP. For a
    2x3 wall of 500mm tiles: row 0 centers at y=1.25m, row 2 at y=0.25m; the
    non-bridge BA init seed (nominal[cr] - nominal[root]) therefore has
    NEGATIVE y for any lower row — same sign as the truth in the y-up BA world
    (pre-fix the y-down grid seeded lower rows ABOVE the root)."""
    cab = CabinetArray(cols=2, rows=3, cabinet_size_mm=[500.0, 500.0])
    centers = nominal_cabinet_centers_model_frame(cab, "flat")
    assert centers[(0, 0)][1] == pytest.approx(1.25)
    assert centers[(0, 1)][1] == pytest.approx(0.75)
    assert centers[(0, 2)][1] == pytest.approx(0.25)
    # init seed sign: lower row relative to root (0,0) must be NEGATIVE y.
    seed_y = centers[(0, 1)][1] - centers[(0, 0)][1]
    assert seed_y < 0.0
    # x unchanged: col 1 right of col 0.
    assert centers[(1, 0)][0] > centers[(0, 0)][0]
    # poses API agrees with centers API (single truth source).
    poses = nominal_cabinet_poses_model_frame(cab, "flat")
    for cr, (R, t) in poses.items():
        np.testing.assert_allclose(t, centers[cr], atol=1e-12)
        np.testing.assert_allclose(R, np.eye(3), atol=1e-12)
