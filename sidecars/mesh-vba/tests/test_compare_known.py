"""Unit tests for compare_known: known-geometry reconciliation."""
from __future__ import annotations

from lmt_vba_sidecar.compare_known import compare_known


def _report():
    return {
        "schema_version": "visual_pose_report.v1",
        "frame": {},
        "cabinet_poses": [
            {
                "cabinet_id": "V000_R000",
                "position_mm": [0, 0, 0],
                "normal": [0, 0, 1],
                "rotation_matrix": [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                "corners_mm": [[-300, -170, 0], [300, -170, 0], [300, 170, 0], [-300, 170, 0]],
                "reprojection_rms_px": 0.4,
                "observed_views": 7,
                "observed_points": 120,
                "quality": "ok",
            },
            {
                "cabinet_id": "V001_R000",
                "position_mm": [702, 0, 0],
                "normal": [0.0, 0.0, 1.0],
                "rotation_matrix": [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                "corners_mm": [[-300, -170, 0], [300, -170, 0], [300, 170, 0], [-300, 170, 0]],
                "reprojection_rms_px": 0.4,
                "observed_views": 7,
                "observed_points": 120,
                "quality": "ok",
            },
        ],
    }


def test_compare_known_computes_errors():
    report = _report()
    known = {
        "cabinets": {"V000_R000": {"size_mm": [600, 340]}, "V001_R000": {"size_mm": [600, 340]}},
        "pairs": [{"a": "V000_R000", "b": "V001_R000", "distance_mm": 700.0, "angle_deg": 0.0}],
    }
    out = compare_known(report, known)
    assert abs(out["pairs"][0]["distance_error_mm"] - 2.0) < 1e-6  # |702-700|
    assert out["pairs"][0]["angle_error_deg"] < 1e-6


def test_size_error_from_corners():
    report = _report()
    # corners give width=600, height=340; known says 600x340 -> size error 0
    known = {
        "cabinets": {"V000_R000": {"size_mm": [600, 340]}, "V001_R000": {"size_mm": [598, 340]}},
        "pairs": [],
    }
    out = compare_known(report, known)
    by_id = {c["cabinet_id"]: c for c in out["cabinets"]}
    assert abs(by_id["V000_R000"]["size_error_mm"]) < 1e-6
    # V001 known width 598 vs reconstructed 600 -> 2.0 mm error
    assert abs(by_id["V001_R000"]["size_error_mm"] - 2.0) < 1e-6


def test_pass_fail_thresholds():
    report = _report()
    # distance off by 2mm (default threshold 3mm -> pass), size exact, angle exact
    known = {
        "cabinets": {"V000_R000": {"size_mm": [600, 340]}, "V001_R000": {"size_mm": [600, 340]}},
        "pairs": [{"a": "V000_R000", "b": "V001_R000", "distance_mm": 700.0, "angle_deg": 0.0}],
    }
    out = compare_known(report, known)
    assert out["passed"] is True
    # Tighten distance threshold to 1mm -> the 2mm error now fails
    out2 = compare_known(report, known, thresholds={"distance_mm": 1.0})
    assert out2["passed"] is False
    assert out2["pairs"][0]["distance_pass"] is False


def test_angle_error_from_normals():
    report = _report()
    # tilt second cabinet normal by 10 deg about x: (0, sin10, cos10)
    import math

    report["cabinet_poses"][1]["normal"] = [0.0, math.sin(math.radians(10)), math.cos(math.radians(10))]
    known = {
        "cabinets": {"V000_R000": {"size_mm": [600, 340]}, "V001_R000": {"size_mm": [600, 340]}},
        "pairs": [{"a": "V000_R000", "b": "V001_R000", "distance_mm": 702.0, "angle_deg": 10.0}],
    }
    out = compare_known(report, known)
    assert abs(out["pairs"][0]["angle_error_deg"]) < 1e-4
