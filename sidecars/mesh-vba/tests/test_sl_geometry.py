import numpy as np
from lmt_vba_sidecar.sl_geometry import sl_local_mm, sl_cabinet_corners_mm


def test_center_dot_maps_to_origin():
    # rect [x=100, y=50, w=400, h=300], dot at the rect center
    p = sl_local_mm((100, 50, 400, 300), u=100 + 200, v=50 + 150,
                    pitch_x=0.5, pitch_y=0.5)
    assert np.allclose(p, [0.0, 0.0, 0.0], atol=1e-9)


def test_y_axis_is_up():
    # a dot ABOVE center on screen (smaller v) must have LARGER local y (+y up),
    # matching screen_mapping.charuco_corner_local_mm's frame.
    rect = (0, 0, 400, 300)
    top = sl_local_mm(rect, u=200, v=50, pitch_x=1.0, pitch_y=1.0)   # v<150 = upper
    bot = sl_local_mm(rect, u=200, v=250, pitch_x=1.0, pitch_y=1.0)  # v>150 = lower
    assert top[1] > 0.0 and bot[1] < 0.0
    assert top[2] == 0.0


def test_x_axis_and_pitch_scale():
    # +x right, scaled by pitch_x. dot 100px right of center, pitch 0.4 -> +40mm
    p = sl_local_mm((0, 0, 400, 300), u=200 + 100, v=150, pitch_x=0.4, pitch_y=0.4)
    assert np.isclose(p[0], 40.0) and np.isclose(p[1], 0.0)


def test_corners_match_active_size_and_order():
    # corners derived from rect w*pitch x h*pitch, order BL,BR,TR,TL (+y up)
    c = sl_cabinet_corners_mm((0, 0, 400, 300), pitch_x=0.5, pitch_y=0.5)
    assert c.shape == (4, 3)
    hw, hh = 400 * 0.5 / 2, 300 * 0.5 / 2     # 100, 75
    np.testing.assert_allclose(c, [[-hw, -hh, 0], [hw, -hh, 0],
                                   [hw, hh, 0], [-hw, hh, 0]])
