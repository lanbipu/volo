import pathlib
import cv2
import numpy as np
from lmt_vba_sidecar.pattern import generate_cabinet_png
from lmt_vba_sidecar.board_layout import markers_per_board
from lmt_vba_sidecar.detect import detect_charuco_corners


def test_detect_routes_two_cabinets(tmp_path: pathlib.Path):
    # Build a 1x2 vertical screen image from two square boards.
    b0 = tmp_path / "V000_R000.png"
    b1 = tmp_path / "V000_R001.png"
    n0 = generate_cabinet_png(out_path=b0, aruco_id_start=0,
                              squares_x=9, squares_y=9, square_px=80)
    generate_cabinet_png(out_path=b1, aruco_id_start=n0,
                         squares_x=9, squares_y=9, square_px=80)
    img0 = cv2.imread(str(b0), cv2.IMREAD_GRAYSCALE)
    img1 = cv2.imread(str(b1), cv2.IMREAD_GRAYSCALE)
    screen = np.full((img0.shape[0] + img1.shape[0] + 40, img0.shape[1] + 40), 255, np.uint8)
    screen[20:20 + img0.shape[0], 20:20 + img0.shape[1]] = img0
    y1 = 20 + img0.shape[0]
    screen[y1:y1 + img1.shape[0], 20:20 + img1.shape[1]] = img1
    shot = tmp_path / "v001.png"
    cv2.imwrite(str(shot), screen)

    boards = [
        {"cabinet": (0, 0), "aruco_id_start": 0, "aruco_id_end": n0 - 1,
         "squares_x": 9, "squares_y": 9},
        {"cabinet": (0, 1), "aruco_id_start": n0, "aruco_id_end": n0 + markers_per_board(9, 9) - 1,
         "squares_x": 9, "squares_y": 9},
    ]
    dets = detect_charuco_corners([str(shot)], boards=boards)[str(shot)]
    cabs = {d["cabinet"] for d in dets}
    assert (0, 0) in cabs and (0, 1) in cabs
    # No corner is misrouted: every charuco_id is within its board's inner-corner count
    for d in dets:
        assert 0 <= d["charuco_id"] < (9 - 1) * (9 - 1)
