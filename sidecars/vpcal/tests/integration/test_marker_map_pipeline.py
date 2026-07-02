"""Marker-map (AR path) pipeline integration tests (plan Phase A4/B/E3).

Zero-noise closure, corner/centre equivalence, hand-eye availability, unknown
marker rejection, the rendered-image physical-detector path, and the QA
blocks (ground plane, world alignment, tracker offsets).
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import numpy as np
import pytest

from vpcal.core.pipeline import run_quick
from vpcal.core.simulator import simulate_marker_map_dataset
from vpcal.models.marker_map import MarkerMapDefinition, SurveyedMarker
from vpcal.models.session import SessionConfig


def _wall_map(*, with_ground: bool = True) -> MarkerMapDefinition:
    markers = []
    tid = 0
    for r in range(3):
        for c in range(4):
            markers.append(SurveyedMarker(
                marker_id=f"AT_36h11_{tid}", marker_type="apriltag",
                dictionary="DICT_APRILTAG_36h11", tag_id=tid,
                center_stage_mm=[c * 600.0, 0.0, 800.0 + r * 500.0],
                size_mm=250.0, normal=[0.0, -1.0, 0.0],
                uncertainty_mm=0.5, survey_source="total_station"))
            tid += 1
    if with_ground:
        for gx in range(2):
            for gy in range(2):
                markers.append(SurveyedMarker(
                    marker_id=f"AT_36h11_{tid}", marker_type="apriltag",
                    dictionary="DICT_APRILTAG_36h11", tag_id=tid,
                    center_stage_mm=[300.0 + gx * 900.0, -600.0 - gy * 700.0, 0.0],
                    size_mm=250.0, normal=[0.0, 0.0, 1.0], on_ground=True,
                    uncertainty_mm=0.5, survey_source="total_station"))
                tid += 1
    return MarkerMapDefinition(name="itest_wall", frame_name="itest stage RH Z-up", markers=markers)


def _run_session(tmp_path: Path, **sim_kw) -> tuple[dict, dict]:
    """Simulate + quick-run one marker-map session; returns (result, ground_truth)."""
    mm = sim_kw.pop("marker_map", _wall_map())
    simulate_marker_map_dataset(mm, tmp_path, seed=sim_kw.pop("seed", 5), **sim_kw)
    raw = json.loads((tmp_path / "session.json").read_text())
    session = SessionConfig.model_validate(raw)
    res = run_quick(session, tmp_path, tmp_path / "output", raw_session=raw)
    gt = json.loads((tmp_path / "ground_truth.json").read_text())
    return res, gt


def _t_error_mm(res: dict, gt: dict) -> float:
    solved = np.asarray(res["result"]["tracker_to_stage"]["translation"])
    truth = np.asarray(gt["tracker_to_stage"]["translation"])
    return float(np.linalg.norm(solved - truth))


def test_zero_noise_closure(tmp_path):
    """Plan A4: zero-noise end-to-end recovers T_S_from_O at screen-path level."""
    res, gt = _run_session(tmp_path, num_poses=12, render_images=False)
    assert res["exit_code"] == 0
    assert res["result"]["quality"]["reprojection_rms_px"] < 0.01
    assert _t_error_mm(res, gt) < 0.1
    assert res["detection_source"] == "exact"
    assert res["result"]["inputs"]["screen_definition"] == "itest_wall"


def test_corner_and_center_maps_solve_identically(tmp_path):
    """Plan A4: four-corner vs centre+size+normal entry forms are equivalent."""
    derived = _wall_map(with_ground=False)
    explicit = derived.model_copy(update={"markers": [
        m.model_copy(update={
            "corners_stage_mm": [[float(x) for x in c] for c in m.resolved_corners()],
            "center_stage_mm": None, "size_mm": None, "normal": None,
        })
        for m in derived.markers
    ]})
    res_a, gt_a = _run_session(tmp_path / "a", marker_map=derived, num_poses=10, render_images=False)
    res_b, gt_b = _run_session(tmp_path / "b", marker_map=explicit, num_poses=10, render_images=False)
    np.testing.assert_allclose(
        res_a["result"]["tracker_to_stage"]["translation"],
        res_b["result"]["tracker_to_stage"]["translation"],
        atol=1e-6,
    )


def test_handeye_closed_form_available(tmp_path):
    """Plan A4: closed-form hand-eye init works on the marker-map path."""
    from vpcal.core.handeye import closed_form_handeye
    from vpcal.core.marker_map import physical_world_map
    from vpcal.core.projection import CameraIntrinsics
    from vpcal.core.simulator import default_lens

    mm = _wall_map(with_ground=False)
    simulate_marker_map_dataset(mm, tmp_path, num_poses=10, render_images=False, seed=9,
                                handeye_perturbation=(4.0, 30.0))
    # Rebuild observations exactly as the pipeline does.
    raw = json.loads((tmp_path / "session.json").read_text())
    session = SessionConfig.model_validate(raw)
    res = run_quick(session, tmp_path, tmp_path / "output", raw_session=raw)
    he = res["qa"]["handeye"]
    gt = json.loads((tmp_path / "ground_truth.json").read_text())
    assert he["usable_frames"] >= 3
    t_err = np.linalg.norm(
        np.asarray(he["camera_from_tracker_t"]) - np.asarray(gt["camera_from_tracker"]["translation"])
    )
    assert t_err < 5.0, f"closed-form hand-eye off by {t_err:.2f} mm"


def test_unknown_marker_ignored(tmp_path):
    """Plan A4: detected-but-unmapped markers are counted, never solved."""
    mm = _wall_map(with_ground=False)
    full = mm.model_copy()
    # Simulate with the full map, then drop two markers from the session's map:
    # their rendered tags become "unknown" to the detector.
    simulate_marker_map_dataset(full, tmp_path, num_poses=8, render_images=True, seed=13)
    reduced = mm.model_copy(update={"markers": mm.markers[:-2]})
    from vpcal.io.marker_map_io import save_marker_map

    save_marker_map(reduced, tmp_path / "marker_map.json")
    os.remove(tmp_path / "observations.jsonl")
    raw = json.loads((tmp_path / "session.json").read_text())
    raw.pop("_simulator")
    session = SessionConfig.model_validate(raw)
    res = run_quick(session, tmp_path, tmp_path / "output", raw_session=raw)
    det = res["qa"]["detection"]
    assert det["unknown_markers"] > 0
    assert any("not in the marker map" in w for w in det["warnings"])
    cov = res["qa"]["coverage"]["marker_coverage"]
    assert cov["total_markers"] == len(reduced.markers)


def test_rendered_detection_path(tmp_path):
    """Plan A4 (台架合成版): render → cv2.aruco detect → solve recovers the truth."""
    mm = _wall_map(with_ground=False)
    simulate_marker_map_dataset(mm, tmp_path, num_poses=10, render_images=True, seed=11)
    os.remove(tmp_path / "observations.jsonl")
    raw = json.loads((tmp_path / "session.json").read_text())
    raw.pop("_simulator")
    (tmp_path / "session.json").write_text(json.dumps(raw))
    session = SessionConfig.model_validate(raw)
    res = run_quick(session, tmp_path, tmp_path / "output", raw_session=raw)
    gt = json.loads((tmp_path / "ground_truth.json").read_text())
    assert res["detection_source"] == "detector"
    assert res["result"]["quality"]["reprojection_rms_px"] < 2.0
    assert _t_error_mm(res, gt) < 10.0
    assert res["qa"]["coverage"]["marker_coverage"]["percentage"] == 1.0


def test_qa_blocks_present(tmp_path):
    """Phase B/E3 QA: ground plane, world alignment and tracker offsets emitted."""
    res, _gt = _run_session(tmp_path, num_poses=10, render_images=False)
    ground = res["qa"]["ground_plane"]
    assert ground["available"] and ground["tilt_from_z_deg"] < 0.01
    assert res["qa"]["world_alignment"]["grade"] == "millimetre"
    offsets = res["qa"]["tracker_offsets"]
    assert offsets["cameras"][0]["hand_eye"]["x_mm"] is not None
    out = tmp_path / "output" / "qa"
    for name in ("ground_plane.json", "world_alignment.json", "tracker_offsets.json"):
        assert (out / name).exists()


def test_session_requires_exactly_one_truth_source(tmp_path):
    with pytest.raises(Exception, match="exactly one"):
        SessionConfig.model_validate({
            "images": {"path": "./captures/"},
            "tracking": {"path": "./tracking/poses.jsonl"},
            "lens": json.loads(Path(_lens_json(tmp_path)).read_text()),
        })


def _lens_json(tmp_path: Path) -> Path:
    from vpcal.core.simulator import default_lens

    p = tmp_path / "lens.json"
    p.write_text(default_lens().model_dump_json(exclude={"fx", "fy", "cx", "cy"}))
    return p
