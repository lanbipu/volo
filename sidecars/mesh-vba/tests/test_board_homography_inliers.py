"""_board_homography_inliers: ghost-detection RANSAC clean before self-cal."""
import numpy as np

from lmt_vba_sidecar.reconstruct import _board_homography_inliers


def _grid_board(n_cols=6, n_rows=5, pitch=30.0):
    obj = [np.array([c * pitch, r * pitch, 0.0]) for r in range(n_rows) for c in range(n_cols)]
    # Simple projective-ish view: scale + offset (an exact homography).
    img = [[100.0 + 8.0 * p[0], 80.0 + 8.1 * p[1]] for p in obj]
    return obj, img


def test_clean_board_passes_through():
    obj, img = _grid_board()
    o2, i2 = _board_homography_inliers(obj, img)
    assert len(o2) == len(obj) and len(i2) == len(img)


def test_single_ghost_is_dropped():
    obj, img = _grid_board()
    # Duplicate marker id: same local position, wildly wrong pixel (real case:
    # CRC-valid reflection 649px off — poisoned calibrateCamera to 90px RMS).
    obj.append(obj[8].copy())
    img.append([img[8][0] + 500.0, img[8][1] + 400.0])
    o2, i2 = _board_homography_inliers(obj, img)
    assert len(o2) == len(obj) - 1
    assert [img[8][0] + 500.0, img[8][1] + 400.0] not in i2


def test_small_board_untouched():
    obj, img = _grid_board(n_cols=3, n_rows=2)  # 6 pts < 8
    o2, i2 = _board_homography_inliers(obj, img)
    assert len(o2) == 6 and len(i2) == 6
