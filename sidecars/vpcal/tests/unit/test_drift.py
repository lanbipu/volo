"""Calibration drift comparison (remediation C5)."""

from __future__ import annotations

import numpy as np

from vpcal.core.drift import compare_results, render_drift, _rot_drift_deg


def _result(t_stage, q_stage, t_cam=(0, 0, 0), q_cam=(1, 0, 0, 0), val_rms=0.5, reproj=0.3):
    return {
        "tracker_to_stage": {"translation": list(t_stage), "rotation": list(q_stage)},
        "tracker_to_camera": {"translation": list(t_cam), "rotation": list(q_cam)},
        "quality": {"validation_rms_px": val_rms, "reprojection_rms_px": reproj},
    }


def test_no_drift_identical_results():
    r = _result((100, 200, 300), (1, 0, 0, 0))
    d = compare_results(r, r)
    assert d["any_alert"] is False
    ts = d["transforms"]["tracker_to_stage"]
    assert ts["translation_drift_mm"] == 0.0
    assert ts["rotation_drift_deg"] == 0.0


def test_translation_drift_over_threshold_alerts():
    a = _result((100, 0, 0), (1, 0, 0, 0))
    b = _result((103, 0, 0), (1, 0, 0, 0))  # 3 mm > 2 mm default
    d = compare_results(a, b)
    ts = d["transforms"]["tracker_to_stage"]
    assert abs(ts["translation_drift_mm"] - 3.0) < 1e-6
    assert ts["translation_alert"] is True
    assert d["any_alert"] is True


def test_rotation_drift_geodesic_and_alert():
    # 0.1° rotation about z → quaternion (cos(0.05°), 0, 0, sin(0.05°))
    ang = np.radians(0.1)
    q = [np.cos(ang / 2), 0, 0, np.sin(ang / 2)]
    a = _result((0, 0, 0), (1, 0, 0, 0))
    b = _result((0, 0, 0), q)
    d = compare_results(a, b)
    ts = d["transforms"]["tracker_to_stage"]
    assert abs(ts["rotation_drift_deg"] - 0.1) < 1e-3
    assert ts["rotation_alert"] is True            # 0.1° > 0.05° default
    assert ts["translation_alert"] is False


def test_within_threshold_no_alert():
    a = _result((0, 0, 0), (1, 0, 0, 0))
    b = _result((1.0, 0, 0), (1, 0, 0, 0))  # 1 mm < 2 mm
    d = compare_results(a, b)
    assert d["any_alert"] is False


def test_validation_rms_delta_reported():
    a = _result((0, 0, 0), (1, 0, 0, 0), val_rms=0.40)
    b = _result((0, 0, 0), (1, 0, 0, 0), val_rms=0.55)
    d = compare_results(a, b)
    assert abs(d["quality"]["validation_rms_px"]["delta"] - 0.15) < 1e-6


def test_validation_rms_regression_alerts_even_when_transforms_stable():
    # Transforms barely move but validation RMS degrades badly → must alert.
    a = _result((0, 0, 0), (1, 0, 0, 0), val_rms=0.40)
    b = _result((0.5, 0, 0), (1, 0, 0, 0), val_rms=3.0)  # 0.5mm (< 2mm), but +2.6px RMS
    d = compare_results(a, b)
    assert d["transforms"]["tracker_to_stage"]["translation_alert"] is False
    assert d["quality"]["validation_rms_px"]["alert"] is True
    assert d["any_alert"] is True


def test_validation_rms_improvement_no_alert():
    a = _result((0, 0, 0), (1, 0, 0, 0), val_rms=2.0)
    b = _result((0, 0, 0), (1, 0, 0, 0), val_rms=0.5)  # improved
    assert compare_results(a, b)["any_alert"] is False


def test_missing_validation_rms_handled():
    a = _result((0, 0, 0), (1, 0, 0, 0), val_rms=None)
    b = _result((0, 0, 0), (1, 0, 0, 0), val_rms=None)
    d = compare_results(a, b)
    assert "delta" not in d["quality"]["validation_rms_px"]


def test_custom_thresholds():
    a = _result((0, 0, 0), (1, 0, 0, 0))
    b = _result((1.5, 0, 0), (1, 0, 0, 0))
    assert compare_results(a, b)["any_alert"] is False            # default 2 mm
    assert compare_results(a, b, trans_threshold_mm=1.0)["any_alert"] is True


def test_render_drift_marks_alert():
    a = _result((0, 0, 0), (1, 0, 0, 0))
    b = _result((5, 0, 0), (1, 0, 0, 0))
    text = render_drift(compare_results(a, b), label_a="base.json", label_b="today.json")
    assert "⚠ ALERT" in text
    assert "base.json" in text and "today.json" in text


def test_rot_drift_antipodal_quaternion_is_zero():
    # q and -q are the same rotation → zero drift.
    q = [np.cos(0.3), np.sin(0.3), 0, 0]
    assert _rot_drift_deg(q, [-x for x in q]) < 1e-9
