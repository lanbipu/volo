"""Board / cube print-sheet generation (plan A3): files, map truth, detectability."""

from __future__ import annotations

import cv2
import numpy as np
import pytest

from vpcal.core.marker_boards import generate_boards, generate_cube, marker_id_prefix, parse_id_range
from vpcal.core.marker_map import validate_marker_map
from vpcal.io.marker_map_io import load_marker_map


def test_parse_id_range():
    assert parse_id_range("0-3") == [0, 1, 2, 3]
    assert parse_id_range("0,5,2") == [0, 2, 5]
    assert parse_id_range("7") == [7]


def test_marker_id_prefix():
    assert marker_id_prefix("DICT_APRILTAG_36h11") == "AT_36h11"
    assert marker_id_prefix("DICT_5X5_100") == "AR_5X5"


def test_generate_boards_and_detect(tmp_path):
    summary = generate_boards("DICT_APRILTAG_36h11", [0, 1], tmp_path, size_mm=120.0)
    assert len(summary["boards"]) == 2
    template = (tmp_path / "survey_template.csv").read_text()
    assert template.count("AT_36h11_0") == 4  # c1..c4 rows
    # The printed sheet must be detectable straight-on with the declared id.
    img = cv2.imread(summary["boards"][0], cv2.IMREAD_GRAYSCALE)
    d = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_APRILTAG_36h11)
    corners, ids, _rej = cv2.aruco.ArucoDetector(d, cv2.aruco.DetectorParameters()).detectMarkers(img)
    assert ids is not None and 0 in ids.ravel()


def test_printable_png_carries_physical_dpi(tmp_path):
    """"print at 100% scale" only reproduces the mm truth if the PNG embeds
    its pixel density — without pHYs the print program picks an arbitrary DPI."""
    from PIL import Image

    px_per_mm = 8.0
    summary = generate_boards("DICT_APRILTAG_36h11", [0], tmp_path, size_mm=120.0, px_per_mm=px_per_mm)
    with Image.open(summary["boards"][0]) as im:
        dpi = im.info.get("dpi")
    assert dpi is not None
    assert dpi[0] == pytest.approx(px_per_mm * 25.4, abs=0.51)  # pHYs rounds to px/metre
    assert dpi[1] == pytest.approx(px_per_mm * 25.4, abs=0.51)


def test_generate_cube_map_valid(tmp_path):
    summary = generate_cube("DICT_APRILTAG_36h11", tmp_path, size_mm=300.0, tolerance_mm=1.0)
    assert summary["num_markers"] == 5
    mm = load_marker_map(summary["marker_map"])
    report = validate_marker_map(mm)
    assert report["passed"]
    # CAD truth discipline: survey_source recorded, tolerance as uncertainty.
    assert all(m.survey_source == "cad" and m.uncertainty_mm == 1.0 for m in mm.markers)
    # Cube local frame: origin at the bottom-face centre → top face centre at z=size.
    top = mm.marker_by_id([m.marker_id for m in mm.markers][0])
    centers = np.array([m.resolved_center() for m in mm.markers])
    assert centers[:, 2].max() == pytest.approx(300.0)
    assert centers[:, 2].min() == pytest.approx(150.0)  # side faces at half height
