import pathlib
import cv2
from lmt_vba_sidecar.pattern import generate_cabinet_png
from lmt_vba_sidecar.board_layout import markers_per_board


def test_generate_non_square_cabinet_png(tmp_path: pathlib.Path):
    out = tmp_path / "V000_R000.png"
    next_id = generate_cabinet_png(
        out_path=out, aruco_id_start=0,
        squares_x=16, squares_y=9, square_px=60,
    )
    assert next_id == markers_per_board(16, 9)
    img = cv2.imread(str(out), cv2.IMREAD_GRAYSCALE)
    assert img is not None
    # board canvas is squares*square_px (cells square, no stretch)
    assert img.shape == (9 * 60, 16 * 60)  # (height, width)


def test_id_overflow_raises(tmp_path: pathlib.Path):
    import pytest
    with pytest.raises(ValueError):
        generate_cabinet_png(
            out_path=tmp_path / "x.png", aruco_id_start=990,
            squares_x=9, squares_y=9, square_px=60,  # needs 40 > 10 left
        )
