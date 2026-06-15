from lmt_vba_sidecar.board_layout import (
    choose_board_shape, markers_per_board, MIN_SQUARE_PX, DEFAULT_SQUARES_SHORT,
)


def test_square_cabinet_reproduces_legacy_9x9_40_markers():
    # Back-compat anchor: a 1080px square cabinet must reproduce the legacy board.
    sx, sy, spx = choose_board_shape(resolution_px=(1080, 1080))
    assert (sx, sy, spx) == (9, 9, 120)
    assert markers_per_board(sx, sy) == 40  # legacy markers_per_cabinet
    assert spx >= MIN_SQUARE_PX
    assert sx * spx <= 1080 and sy * spx <= 1080


def test_widescreen_cabinet_gives_more_columns_than_rows():
    # 1920x1080 short side = 1080 -> square_px=120 -> 16x9 (non-square)
    sx, sy, spx = choose_board_shape(resolution_px=(1920, 1080))
    assert (sx, sy) == (16, 9)
    assert sx > sy  # non-square board fills the 16:9 region
    assert sx * spx <= 1920 and sy * spx <= 1080


def test_short_side_anchors_square_count():
    # Anchored to DEFAULT_SQUARES_SHORT on the short side (not packed to MIN_SQUARE_PX).
    sx, sy, spx = choose_board_shape(resolution_px=(960, 540))
    assert min(sx, sy) == DEFAULT_SQUARES_SHORT or spx == MIN_SQUARE_PX
    assert (sx, sy, spx) == (16, 9, 60)


def test_minimum_two_squares_each_axis():
    sx, sy, spx = choose_board_shape(resolution_px=(130, 130))
    assert sx >= 2 and sy >= 2
