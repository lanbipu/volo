"""Pydantic model serialisation / round-trip tests (spec §4)."""

from __future__ import annotations

import json

from vpcal.models.calibration import (
    CalibrationResult,
    CameraFromTracker,
    Inputs,
    Quality,
    RigidTransform,
    SolverDiagnostics,
)
from vpcal.models.lens import LensProfile
from vpcal.models.manifest import build_manifest
from vpcal.models.screen import ArcSection, PlaneSection, ScreenDefinition
from vpcal.models.session import SessionConfig

_SESSION_JSON = {
    "images": {"path": "./captures/", "format": "png"},
    "tracking": {"path": "./tracking/poses.jsonl", "coordinate_system": "unreal", "frame_matching": "frame_id"},
    "screen": {"path": "./screen/wall.json"},
    "lens": {
        "focal_length_mm": 35.0,
        "sensor_width_mm": 36.0,
        "sensor_height_mm": 24.0,
        "principal_point_offset_mm": [0.0, 0.0],
        "image_width_px": 3840,
        "image_height_px": 2160,
        "distortion": {"model": "brown_conrady", "k1": 0.0, "k2": 0.0, "k3": 0.0, "p1": 0.0, "p2": 0.0},
    },
    "solver": {
        "refine_tracker_to_camera": False,
        "tracker_to_camera_prior": {"translation": [0, 0, 0], "rotation": [1, 0, 0, 0]},
        "robust_loss": "huber",
        "robust_loss_scale": 1.0,
        "max_iterations": 200,
        "timeout_seconds": 300,
    },
    "capture_mode": "legacy",
}


def test_session_parses_spec_example():
    s = SessionConfig.model_validate(_SESSION_JSON)
    assert s.tracking.coordinate_system == "unreal"
    assert s.lens.image_width_px == 3840
    assert s.solver.max_iterations == 200


def test_lens_computed_intrinsics():
    lens = SessionConfig.model_validate(_SESSION_JSON).lens
    assert lens.fx == 35.0 * 3840 / 36.0
    assert lens.fy == 35.0 * 2160 / 24.0
    assert lens.cx == 1920.0
    assert lens.cy == 1080.0


def test_lens_principal_point_offset():
    lens = LensProfile(
        focal_length_mm=50, sensor_width_mm=36, sensor_height_mm=24,
        principal_point_offset_mm=(1.8, -1.2), image_width_px=1920, image_height_px=1080,
    )
    # 1.8mm offset over 36mm sensor at 1920px → 96px shift.
    assert abs(lens.cx - (960.0 + 96.0)) < 1e-9
    assert abs(lens.cy - (540.0 - 54.0)) < 1e-9


def test_screen_discriminated_union_roundtrip():
    screen = ScreenDefinition(
        name="studio", unit="mm", cabinet_size=(500, 500), led_pixel_pitch_mm=2.8,
        markers_per_cabinet=4,
        sections=[
            ArcSection(name="back", arc_radius_mm=9550, arc_angle_deg=180, height_mm=12000),
            PlaneSection(name="ceil", width_mm=10000, height_mm=8000, origin=[0, 0, 12000]),
        ],
    )
    dumped = json.loads(json.dumps(screen.model_dump(mode="json")))
    back = ScreenDefinition.model_validate(dumped)
    assert isinstance(back.sections[0], ArcSection)
    assert isinstance(back.sections[1], PlaneSection)
    assert back.sections[0].arc_radius_mm == 9550


def test_calibration_result_roundtrip():
    result = CalibrationResult(
        vpcal_version="0.1.0",
        timestamp="2026-06-06T00:00:00Z",
        tracker_to_stage=RigidTransform(translation=[1, 2, 3], rotation=[1, 0, 0, 0]),
        tracker_to_camera=CameraFromTracker(translation=[0, 0, 0], rotation=[1, 0, 0, 0], refined=False),
        quality=Quality(
            reprojection_rms_px=0.4, total_observations=500, inlier_observations=490,
            outlier_ratio=0.02, num_poses=10, confidence="high",
        ),
        inputs=Inputs(session_config_hash="sha256:x", image_count=10, screen_definition="studio"),
        solver_diagnostics=SolverDiagnostics(
            num_iterations=20, initial_cost=100.0, final_cost=1.0, termination_type="CONVERGENCE",
            num_residual_blocks=500, num_inliers=490, num_outliers=10, outlier_ratio=0.02,
            solver_backend="scipy",
        ),
    )
    back = CalibrationResult.model_validate(json.loads(json.dumps(result.model_dump(mode="json"))))
    assert back.quality.confidence == "high"
    assert back.solver_diagnostics.solver_backend == "scipy"


def test_manifest_operations():
    m = build_manifest()
    ids = {o.operation_id for o in m.operations}
    assert ids == {
        "quick.run", "pattern.generate", "screen.create", "screen.import",
        "simulate", "simulate.sweep", "report.generate", "report.diff",
        "export.opentrackio", "export.ndisplay",
        "marker_map.create", "marker_map.validate", "marker_map.board",
        "marker_map.cube", "marker_map.rebase", "verify.mapping", "verify.overlay",
        "verify.live",
        "capture.delay_cal",
        "capture.track", "capture.list_devices", "capture.finalize",
        "capture.enumerate", "capture.video", "capture.session",
        "capture.playback",
        "doctor",
    }
    assert m.contract_version == "1.0"
