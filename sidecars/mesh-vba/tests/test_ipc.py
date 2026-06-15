"""Round-trip tests for IPC pydantic models."""
from __future__ import annotations

import json

import pytest
from pydantic import ValidationError

from lmt_vba_sidecar.ipc import (
    CabinetArray,
    CabinetPose,
    CabinetPoseReport,
    CameraSamplingSpec,
    EvalInput,
    NoiseSpec,
    ProgressEvent,
    ResultEvent,
    SimulateInput,
    SimulateScene,
    WarningEvent,
    ErrorEvent,
    MeasuredPoint,
    PointSource,
    Uncertainty,
    ReconstructInput,
)


def _valid_reconstruct_input() -> dict:
    return {
        "command": "reconstruct",
        "version": 1,
        "project": {
            "screen_id": "MAIN",
            "cabinet_array": {"cols": 4, "rows": 4, "cabinet_size_mm": [500, 500]},
            "shape_prior": "flat",
        },
        "capture_manifest_path": "/tmp/capture.json",
        "screen_mapping_path": "/tmp/screen_mapping.json",
        "pose_report_path": "/tmp/cabinet_pose_report.json",
    }


def test_progress_event_serializes() -> None:
    ev = ProgressEvent(event="progress", stage="detect_charuco", percent=0.3, message="3/10")
    assert json.loads(ev.model_dump_json()) == {
        "event": "progress",
        "stage": "detect_charuco",
        "percent": 0.3,
        "message": "3/10",
    }


def test_measured_point_visual_ba_source() -> None:
    p = MeasuredPoint(
        name="MAIN_V001_R001",
        position=[1.0, 2.0, 3.0],
        uncertainty=Uncertainty(covariance=[[1e-4, 0, 0], [0, 1e-4, 0], [0, 0, 1e-4]]),
        source=PointSource(visual_ba={"camera_count": 5}),
    )
    payload = json.loads(p.model_dump_json())
    assert payload["source"] == {"visual_ba": {"camera_count": 5}}
    assert payload["uncertainty"] == {"covariance": [[1e-4, 0, 0], [0, 1e-4, 0], [0, 0, 1e-4]]}


def test_reconstruct_input_round_trips() -> None:
    """The reworked reconstruct input references files via the capture manifest;
    intrinsics / pattern_meta / frame strategy are no longer inline."""
    parsed = ReconstructInput.model_validate(_valid_reconstruct_input())
    assert parsed.project.screen_id == "MAIN"
    assert parsed.project.shape_prior == "flat"
    assert parsed.capture_manifest_path == "/tmp/capture.json"
    assert parsed.screen_mapping_path == "/tmp/screen_mapping.json"
    assert parsed.pose_report_path == "/tmp/cabinet_pose_report.json"


def test_reconstruct_input_pose_report_optional() -> None:
    raw = _valid_reconstruct_input()
    del raw["pose_report_path"]
    parsed = ReconstructInput.model_validate(raw)
    assert parsed.pose_report_path is None


def test_result_event_round_trips() -> None:
    raw = {
        "event": "result",
        "data": {
            "measured_points": [],
            "ba_stats": {"rms_reprojection_px": 0.5, "iterations": 10, "converged": True},
            "frame_strategy_used": "nominal_anchoring",
            "procrustes_align_rms_m": 0.003,
        },
    }
    parsed = ResultEvent.model_validate(raw)
    assert parsed.data.ba_stats.converged is True
    assert parsed.data.procrustes_align_rms_m == 0.003


def test_missing_capture_manifest_path_rejected() -> None:
    raw = _valid_reconstruct_input()
    del raw["capture_manifest_path"]
    with pytest.raises(ValidationError):
        ReconstructInput.model_validate(raw)


def test_negative_cabinet_size_rejected() -> None:
    raw = _valid_reconstruct_input()
    raw["project"]["cabinet_array"]["cabinet_size_mm"] = [-500, 0]
    with pytest.raises(ValidationError):
        ReconstructInput.model_validate(raw)


def test_unknown_shape_prior_rejected() -> None:
    raw = _valid_reconstruct_input()
    raw["project"]["shape_prior"] = {"bogus": {}}
    with pytest.raises(ValidationError):
        ReconstructInput.model_validate(raw)


def test_curved_shape_prior_accepted() -> None:
    raw = _valid_reconstruct_input()
    raw["project"]["shape_prior"] = {"curved": {"radius_mm": 5000.0}}
    parsed = ReconstructInput.model_validate(raw)
    assert parsed.project.shape_prior.curved.radius_mm == 5000.0


def test_simulate_input_roundtrip():
    inp = SimulateInput.model_validate({
        "command": "simulate", "version": 1,
        "scene": {"cabinet_array": {"cols": 2, "rows": 1, "cabinet_size_mm": [600, 340]},
                  "shape_prior": "flat", "inter_board_angle_deg": 0.0},
        "cameras": {"n_views": 20, "distance_mm_range": [1500, 3000],
                    "yaw_deg_range": [-40, 40], "pitch_deg_range": [-20, 20]},
        "intrinsics": {"K": [[2000,0,960],[0,2000,540],[0,0,1]],
                       "dist_coeffs": [0,0,0,0,0], "image_size": [1920,1080]},
        "noise": {"pixel_sigma": 0.3, "outlier_frac": 0.0,
                  "visibility_frac": 0.8, "pixel_pitch_error_frac": 0.0},
        "seed": 42,
    })
    assert inp.cameras.n_views == 20
    assert inp.noise.pixel_sigma == 0.3

def test_cabinet_pose_report_serializes():
    rep = CabinetPoseReport(
        schema_version="visual_pose_report.v1",
        frame={"type": "screen_local", "gauge_strategy": "fix_root_cabinet",
               "root_cabinet": [0, 0], "units": "mm", "handedness": "right", "z_axis": "outward"},
        cabinet_poses=[CabinetPose(
            cabinet_id="V000_R000", position_mm=[0,0,0],
            rotation_matrix=[[1,0,0],[0,1,0],[0,0,1]], normal=[0,0,1],
            corners_mm=[[-300,-170,0],[300,-170,0],[300,170,0],[-300,170,0]],
            reprojection_rms_px=0.4, observed_views=7, observed_points=128, quality="ok")],
    )
    d = rep.model_dump()
    assert d["cabinet_poses"][0]["cabinet_id"] == "V000_R000"


from lmt_vba_sidecar.ipc import GenerateStructuredLightInput, StructuredLightMeta, CorrespondenceFile


def test_generate_structured_light_input_mirrors_generate_pattern():
    m = GenerateStructuredLightInput.model_validate({
        "command": "generate_structured_light", "version": 1,
        "project": {"screen_id": "MAIN",
                    "cabinet_array": {"cols": 1, "rows": 1,
                                      "absent_cells": [], "cabinet_size_mm": [500, 500]}},
        "output_dir": "/tmp/out", "screen_resolution": [1920, 1080],
    })
    # spacing/margin default to None = auto (derived per-cabinet from resolution).
    assert m.dot_spacing_px is None and m.margin_px is None and m.screen_mapping_path is None


def test_meta_and_correspondence_carry_provenance():
    meta = StructuredLightMeta.model_validate({
        "schema_version": 1, "screen_id": "MAIN", "screen_resolution": [1920, 1080],
        "dot_radius_px": 6,
        "code": {"data_bits": 9, "total_bits": 10, "parity": "even", "encoding": "binary"},
        "sequence": {"sentinel": "white_full", "anchor": "all_on",
                     "n_code_frames": 10, "hold_ms": 500, "fps": 30},
        "cabinets": [{"col": 0, "row": 0, "input_rect_px": [0, 0, 540, 540],
                      "pixel_pitch_mm": [0.93, 0.93]}],
        "dots": [{"id": 0, "u": 240.0, "v": 240.0, "cabinet": [0, 0]}],
    })
    assert meta.screen_id == "MAIN" and meta.dots[0].cabinet == [0, 0]
    corr = CorrespondenceFile.model_validate({
        "schema_version": 1, "screen_id": "MAIN", "sl_meta_sha256": "abc",
        "screen_resolution": [1920, 1080], "camera_image_size": [4000, 3000],
        "source_input": "/cap/pose1.mp4",
        "points": [{"id": 0, "u": 240.0, "v": 240.0, "x": 12.0, "y": 34.0}],
    })
    assert corr.sl_meta_sha256 == "abc" and corr.points[0].id == 0


def test_reconstruct_structured_light_input_defaults():
    from lmt_vba_sidecar.ipc import ReconstructStructuredLightInput
    m = ReconstructStructuredLightInput.model_validate({
        "command": "reconstruct_structured_light", "version": 1,
        "project": {"screen_id": "MAIN",
                    "cabinet_array": {"cols": 2, "rows": 1,
                                      "absent_cells": [], "cabinet_size_mm": [500, 500]}},
        "correspondence_paths": ["/c/p0.json", "/c/p1.json"],
        "sl_meta_path": "/sl/sl_meta.json", "intrinsics_path": "/cal/intr.json",
    })
    assert m.project.shape_prior == "flat"          # ReconstructProject default
    assert m.pose_report_path is None
    assert len(m.correspondence_paths) == 2


from lmt_vba_sidecar.ipc import DecodeStructuredLightInput, CorrespondenceFile


def test_decode_input_accepts_screen_roi_and_emit_debug():
    cmd = DecodeStructuredLightInput.model_validate({
        "command": "decode_structured_light", "version": 1,
        "input_path": "frames", "sl_meta_path": "sl_meta.json",
        "output_path": "corr.json",
        "screen_roi": [10, 20, 300, 200], "emit_debug_image": True,
    })
    assert cmd.screen_roi == (10, 20, 300, 200)
    assert cmd.emit_debug_image is True


def test_decode_input_defaults_screen_roi_none_emit_false():
    cmd = DecodeStructuredLightInput.model_validate({
        "command": "decode_structured_light", "version": 1,
        "input_path": "frames", "sl_meta_path": "sl_meta.json",
        "output_path": "corr.json",
    })
    assert cmd.screen_roi is None
    assert cmd.emit_debug_image is False


def test_correspondence_file_screen_roi_optional():
    base = {
        "schema_version": 1, "screen_id": "MAIN",
        "sl_meta_sha256": "deadbeef",
        "screen_resolution": [960, 540],
        "camera_image_size": [960, 540],
        "source_input": "frames", "points": [],
    }
    assert CorrespondenceFile.model_validate(base).screen_roi is None
    with_roi = CorrespondenceFile.model_validate({**base, "screen_roi": [5, 6, 100, 80]})
    assert with_roi.screen_roi == (5, 6, 100, 80)
