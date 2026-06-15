import numpy as np

from lmt_vba_sidecar.ipc import CabinetArray
from lmt_vba_sidecar.capture_planner.geometry import expand_screen


def _cab(cols, rows, size=(500.0, 500.0)):
    return CabinetArray(cols=cols, rows=rows, cabinet_size_mm=list(size), absent_cells=[])


def test_flat_single_cabinet_sample_grid_spans_face_and_is_planar():
    geom = expand_screen(_cab(1, 1), "flat", sample_grid=(4, 4))
    assert len(geom.cabinets) == 1
    c = geom.cabinets[0]
    # nominal center of a 500mm cabinet at (col0,row0): (250,250,0) mm
    assert np.allclose(c.center_mm, [250.0, 250.0, 0.0])
    assert np.allclose(c.normal, [0.0, 0.0, 1.0])
    assert c.sample_points_mm.shape == (16, 3)
    # 4x4 grid spans the full cabinet face: x,y in [0,500], z==0 (flat)
    assert np.isclose(c.sample_points_mm[:, 0].min(), 0.0)
    assert np.isclose(c.sample_points_mm[:, 0].max(), 500.0)
    assert np.isclose(c.sample_points_mm[:, 1].min(), 0.0)
    assert np.isclose(c.sample_points_mm[:, 1].max(), 500.0)
    assert np.allclose(c.sample_points_mm[:, 2], 0.0)
    assert geom.radius_mm is None
    assert geom.total_width_mm == 500.0


def test_curved_off_center_cabinet_tilts_and_bows():
    radius = 6000.0
    geom = expand_screen(_cab(4, 1), {"curved": {"radius_mm": radius}}, sample_grid=(4, 4))
    cols = sorted(geom.cabinets, key=lambda c: c.col)
    # center column pair straddles the apex; outermost cabinets tilt in x and bow
    # in +z. Concave arc => normals CONVERGE toward the curvature center on the
    # +z side: left-of-center tilts to +x, right-of-center to -x (FIX-1; the old
    # mirrored normals diverged).
    left, right = cols[0], cols[-1]
    assert left.normal[0] > 0.0          # left-of-center tilts to +x (converging)
    assert right.normal[0] < 0.0         # right-of-center tilts to -x
    assert not np.isclose(left.center_mm[2], 0.0)   # bowed off the z=0 plane
    assert np.isclose(np.linalg.norm(left.normal), 1.0)
    assert geom.radius_mm == radius
