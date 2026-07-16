"""Live verification: synthetic camera + tracking closure and CLI contract."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import cv2
import pytest

from vpcal.core.capture_backend import CaptureConfig, CapturedFrame
from vpcal.core.live_verify import LiveOverlay, run_live_verify
from vpcal.core.simulator import simulate_marker_map_dataset
from vpcal.io.tracking_io import load_tracking
from vpcal.models.marker_map import MarkerMapDefinition, SurveyedMarker
from vpcal.models.session import SessionConfig


def _wall_map() -> MarkerMapDefinition:
    markers = []
    tag_id = 0
    for row in range(3):
        for col in range(4):
            markers.append(
                SurveyedMarker(
                    marker_id=f"AT_36h11_{tag_id}",
                    marker_type="apriltag",
                    dictionary="DICT_APRILTAG_36h11",
                    tag_id=tag_id,
                    center_stage_mm=[col * 600.0, 0.0, 800.0 + row * 500.0],
                    size_mm=250.0,
                    normal=[0.0, -1.0, 0.0],
                )
            )
            tag_id += 1
    return MarkerMapDefinition(name="live_wall", frame_name="RH Z-up", markers=markers)


@pytest.fixture(scope="module")
def live_dataset(tmp_path_factory):
    root = tmp_path_factory.mktemp("live_verify")
    simulate_marker_map_dataset(_wall_map(), root, num_poses=3, render_images=True, seed=29)
    raw = json.loads((root / "session.json").read_text())
    session = SessionConfig.model_validate(raw)
    ground_truth = json.loads((root / "ground_truth.json").read_text())
    result = {
        "tracker_to_stage": ground_truth["tracker_to_stage"],
        "tracker_to_camera": ground_truth["camera_from_tracker"],
    }
    (root / "result.json").write_text(json.dumps(result))
    return root, session, result


def _first_frame(root: Path) -> CapturedFrame:
    gray = cv2.imread(str(root / "captures" / "normal" / "0000.png"), cv2.IMREAD_GRAYSCALE)
    assert gray is not None
    return CapturedFrame(gray=gray, recv_ts=123.0, frame_index=0)


def test_live_overlay_zero_error_closure(live_dataset):
    root, session, result = live_dataset
    tracking = load_tracking(root / "tracking" / "poses.jsonl")[0]
    annotated = LiveOverlay(session, root, result).annotate(_first_frame(root), tracking)

    assert annotated.num_observations >= 4
    assert annotated.rms_px is not None and annotated.rms_px < 2.0
    assert annotated.max_px is not None
    assert annotated.image.shape[2] == 3


class _SyntheticFrameStream:
    def __init__(self, frames):
        self._frames = frames
        self.closed = False

    def frames(self):
        yield from self._frames

    def close(self):
        self.closed = True


class _SyntheticTrackingStream:
    def __init__(self, frame):
        self.frame = frame
        self.started = False
        self.stopped = False

    def start(self):
        self.started = True

    def stop(self):
        self.stopped = True

    def nearest(self, timestamp, tolerance):
        assert timestamp == 123.0
        assert tolerance == pytest.approx(0.05)
        return timestamp, self.frame

    @property
    def connected(self):
        return self.started and not self.stopped


def test_simulator_camera_tracking_loop_publishes_preview_contract(live_dataset):
    root, session, result = live_dataset
    backend = _SyntheticFrameStream([_first_frame(root)])
    listener = _SyntheticTrackingStream(load_tracking(root / "tracking" / "poses.jsonl")[0])
    events = []

    summary = run_live_verify(
        session,
        root,
        result,
        CaptureConfig(backend="synthetic"),
        track_port=6301,
        preview_port=0,
        max_frames=1,
        event_callback=lambda kind, payload: events.append((kind, payload)),
        backend=backend,
        listener=listener,
    )

    assert summary["frames"] == 1
    assert summary["paired_frames"] == 1
    assert summary["annotated_frames"] == 1
    assert summary["num_observations"] >= 4
    assert summary["global_rms_px"] < 2.0
    assert summary["preview_port"] > 0
    assert backend.closed and listener.started and listener.stopped
    kind, preview = events[0]
    assert kind == "preview_ready"
    assert preview["mjpeg_url"].endswith("/preview.mjpg")
    assert preview["ws_url"].endswith("/preview.ws")


def test_verify_live_cli_dry_run_ndjson_contract(live_dataset):
    root, _session, _result = live_dataset
    src = str(Path(__file__).resolve().parents[2] / "src")
    env = dict(os.environ, PYTHONPATH=src)
    proc = subprocess.run(
        [
            sys.executable,
            "-m",
            "vpcal.cli.main",
            "verify",
            "live",
            "--config",
            str(root / "session.json"),
            "--result",
            str(root / "result.json"),
            "--backend",
            "synthetic",
            "--track-camera-id",
            "7",
            "--dry-run",
            "--output",
            "ndjson",
        ],
        capture_output=True,
        text=True,
        env=env,
    )
    assert proc.returncode == 0, proc.stderr
    lines = [json.loads(line) for line in proc.stdout.splitlines() if line.strip()]
    assert lines[0]["type"] == "start"
    assert lines[-1]["type"] == "result"
    assert lines[-1]["operation_id"] == "verify.live"
    assert lines[-1]["data"]["dry_run_plan"]["backend"] == "synthetic"
    assert lines[-1]["data"]["dry_run_plan"]["track_camera_id"] == "7"
