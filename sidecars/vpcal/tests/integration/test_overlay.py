"""Verification overlay (plan Phase D): zero-error regression + injected offset."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from vpcal.core.errors import PreconditionError
from vpcal.core.overlay import overlay_session
from vpcal.core.simulator import simulate_marker_map_dataset
from vpcal.models.marker_map import MarkerMapDefinition, SurveyedMarker
from vpcal.models.session import SessionConfig


def _wall_map() -> MarkerMapDefinition:
    markers = []
    tid = 0
    for r in range(3):
        for c in range(4):
            markers.append(SurveyedMarker(
                marker_id=f"AT_36h11_{tid}", marker_type="apriltag",
                dictionary="DICT_APRILTAG_36h11", tag_id=tid,
                center_stage_mm=[c * 600.0, 0.0, 800.0 + r * 500.0],
                size_mm=250.0, normal=[0.0, -1.0, 0.0]))
            tid += 1
    return MarkerMapDefinition(name="ovl_wall", frame_name="RH Z-up", markers=markers)


@pytest.fixture(scope="module")
def rendered_session(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("overlay")
    simulate_marker_map_dataset(_wall_map(), tmp, num_poses=6, render_images=True, seed=21)
    gt = json.loads((tmp / "ground_truth.json").read_text())
    raw = json.loads((tmp / "session.json").read_text())
    session = SessionConfig.model_validate(raw)
    result = {
        "tracker_to_stage": gt["tracker_to_stage"],
        "tracker_to_camera": gt["camera_from_tracker"],
    }
    return tmp, session, result


def test_zero_error_overlay(rendered_session, tmp_path):
    """Zero-error data → red circle ≈ green cross (RMS bounded by detector noise)."""
    tmp, session, result = rendered_session
    summary = overlay_session(session, tmp, result, tmp_path / "annotated")
    assert summary["global_rms_px"] < 2.0
    assert summary["num_frames"] == 6
    assert len(summary["annotated_images"]) == 6
    assert all(Path(p).exists() for p in summary["annotated_images"])
    assert summary["per_marker"], "per-marker error table must be populated"


def test_injected_offset_visible(rendered_session, tmp_path):
    """A systematic stage-translation error must surface in the error table."""
    tmp, session, result = rendered_session
    baseline = overlay_session(session, tmp, result, None)
    shifted = json.loads(json.dumps(result))
    shifted["tracker_to_stage"]["translation"] = [
        v + 30.0 for v in shifted["tracker_to_stage"]["translation"]
    ]
    corrupted = overlay_session(session, tmp, shifted, None)
    assert corrupted["global_rms_px"] > baseline["global_rms_px"] + 3.0


def test_overlay_requires_result(rendered_session):
    tmp, session, _result = rendered_session
    with pytest.raises(PreconditionError, match="tracker_to_stage"):
        overlay_session(session, tmp, {}, None)
