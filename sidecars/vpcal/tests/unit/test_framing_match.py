"""Framing-guidance match score — hit-rate, bbox tolerance, hysteresis."""

from __future__ import annotations

from vpcal.core.framing_match import (
    apply_match_hysteresis,
    cabinets_norm_bbox,
    compute_framing_score,
    summarize_detections,
)
from vpcal.core.observations import Detection, MarkerId


def test_cabinets_norm_bbox():
    assert cabinets_norm_bbox([], 8, 4) is None
    box = cabinets_norm_bbox([(0, 0), (3, 1)], 8, 4)
    assert box == [0.0, 0.0, 0.5, 0.5]


def test_hit_rate_dominates_score():
    exp = [(0, 0), (1, 0), (2, 0), (3, 0)]
    full = compute_framing_score(exp, exp, expected_bbox=[0, 0, 0.5, 0.25],
                                 observed_bbox=[0, 0, 0.5, 0.25])
    assert full >= 99.0
    half = compute_framing_score(exp, exp[:2], expected_bbox=[0, 0, 0.5, 0.25],
                                 observed_bbox=[0, 0, 0.25, 0.25])
    assert 30.0 <= half <= 55.0
    none = compute_framing_score(exp, [], expected_bbox=[0, 0, 0.5, 0.25],
                                 observed_bbox=None)
    assert none == 0.0


def test_bbox_area_tolerance_band():
    exp = [(0, 0), (1, 0)]
    # Same cabinets, bbox area 2× still inside 1.5? 2.0 is outside → slightly lower
    tight = compute_framing_score(
        exp, exp,
        expected_bbox=[0, 0, 0.4, 0.4],
        observed_bbox=[0, 0, 0.4, 0.4],
    )
    wide = compute_framing_score(
        exp, exp,
        expected_bbox=[0, 0, 0.4, 0.4],
        observed_bbox=[0, 0, 0.9, 0.9],
    )
    assert tight > wide
    assert wide >= 75.0  # hit-rate still 1.0 carries most weight


def test_hysteresis_avoids_flicker():
    assert apply_match_hysteresis(80, False) is True
    assert apply_match_hysteresis(79, False) is False
    assert apply_match_hysteresis(70, True) is True
    assert apply_match_hysteresis(69, True) is False


def test_summarize_detections():
    dets = [
        Detection(0, MarkerId(1, 2, 0, 0), 100.0, 50.0),
        Detection(0, MarkerId(1, 2, 0, 1), 120.0, 60.0),
        Detection(0, MarkerId(1, 3, 1, 0), 300.0, 200.0),
    ]
    s = summarize_detections(dets, (400, 400))
    assert s["count"] == 3
    assert s["cabinets"] == [[1, 2, 0], [1, 3, 1]]
    assert s["bbox_frac"] == [100 / 400, 50 / 400, 300 / 400, 200 / 400]
