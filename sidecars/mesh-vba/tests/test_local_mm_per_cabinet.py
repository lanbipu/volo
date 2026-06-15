import numpy as np
from lmt_vba_sidecar.screen_mapping import ScreenMapping, ScreenMappingCabinet


def _sm():
    return ScreenMapping(
        screen_id="BENCH", expected_pattern_hash="x",
        cabinets=[ScreenMappingCabinet(
            cabinet_id="V000_R000", resolution_px=[960, 540],
            active_size_mm=[300.0, 168.75], pixel_pitch_mm=[0.3125, 0.3125],
            active_origin="center", input_rect_px=[0, 0, 960, 540],
            rotation=0, mirror_x=False, mirror_y=False)],
    )


def test_local_mm_uses_pitch_and_nonsquare_board():
    sm = _sm()
    # board 16x9, square_px=60 -> board 960x540 px, inner 15x8
    # charuco_id 0 = inner (r=0,c=0): px=((0+1)*60,(0+1)*60)=(60,60)
    # center origin, +y up: x=(60-960/2)*0.3125, y=(540/2-60)*0.3125
    p = sm.charuco_corner_local_mm("V000_R000", charuco_id=0,
                                   squares_x=16, squares_y=9, square_px=60)
    assert np.allclose(p, [(60 - 480) * 0.3125, (270 - 60) * 0.3125, 0.0])


def test_center_corner_is_near_origin_for_centered_board():
    sm = _sm()
    inner_x = 15
    mid_id = (inner_x) * (8 // 2) + (inner_x // 2)  # roughly central corner
    p = sm.charuco_corner_local_mm("V000_R000", charuco_id=mid_id,
                                   squares_x=16, squares_y=9, square_px=60)
    assert abs(p[0]) < 300 and abs(p[1]) < 170
