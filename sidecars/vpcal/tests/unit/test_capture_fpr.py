"""First-principles capture/timing regression tests (WP1)."""

from __future__ import annotations

from collections import deque
import json
import itertools
import queue
from types import SimpleNamespace

import numpy as np
import pytest

from vpcal.core import delay as delay_mod
from vpcal.core.delay import PoseSampler, _Track, estimate_delay
from vpcal.core.tracking_listener import TrackingListener
from vpcal.models.tracking import RotationData, RotationOrder, TrackingFrame


def _frame(fid: int, ts: float, x: float = 0.0, pan: float = 0.0) -> TrackingFrame:
    return TrackingFrame(
        frame_id=fid, timestamp_s=ts, raw_monotonic_ts=100.0 + ts,
        position=[x, 0.0, 0.0],
        rotation=RotationData(order=RotationOrder.EULER_PTR, values=[pan, 0.0, 0.0]),
    )


def test_listener_uses_peak_adjacent_translation_and_angular_speed(monkeypatch):
    listener = TrackingListener(9999)
    listener._samples = deque([
        (10.0, _frame(0, 0.0, 0.0, 0.0)),
        (10.1, _frame(1, 0.1, 10.0, 0.5)),
        (10.2, _frame(2, 0.2, 10.0, 1.0)),
    ])
    monkeypatch.setattr("vpcal.core.tracking_listener.time.monotonic", lambda: 10.2)
    assert listener.speed_mm_s() == pytest.approx(100.0)
    assert listener.angular_speed_deg_s() == pytest.approx(5.0, abs=1e-6)


def test_mean_pose_markley_average_preserves_raw_fields():
    listener = TrackingListener(9999)
    listener._samples = deque([
        (1.0, _frame(0, 0.0, pan=-1.0)),
        (1.1, _frame(1, 0.1, pan=0.0)),
        (1.2, _frame(2, 0.2, pan=1.0)),
    ])
    mean = listener.mean_pose(1.0, 1.2)
    assert mean is not None
    assert mean.rotation.order is RotationOrder.QUATERNION
    assert abs(mean.rotation.values[3]) < 1e-6
    assert mean.raw_monotonic_ts == pytest.approx(100.1)


def test_listener_camera_filter_excludes_other_camera_ids():
    listener = TrackingListener(9999, camera_id="2")
    cam1 = _frame(1, 0.1).model_copy(update={"camera_id": 1})
    cam2 = _frame(2, 0.2).model_copy(update={"camera_id": 2})
    assert listener.accepts_frame(cam1) is False
    assert listener.accepts_frame(cam2) is True


def test_delay_boundary_auto_expands_and_single_marker_has_no_fake_sigma(monkeypatch):
    track = _Track(times=np.arange(8.0), pixels=np.c_[np.arange(8.0) * 20, np.zeros(8)],
                   world=np.zeros(3))
    sampler = PoseSampler([(0.0, np.array([1., 0, 0, 0]), np.zeros(3)),
                           (10.0, np.array([1., 0, 0, 0]), np.zeros(3))])
    monkeypatch.setattr(delay_mod, "_track_cost",
                        lambda _t, _s, tau, *_a: abs(tau - 0.150) + 1.0)
    result = estimate_delay([track], sampler,
                            (np.array([1., 0, 0, 0]), np.zeros(3)),
                            (np.array([1., 0, 0, 0]), np.zeros(3)), None)
    assert result["delay_ms"] == pytest.approx(-150.0, abs=2.0)
    assert result["search_ms"] == 200.0
    assert result["boundary_hit"] is True
    assert result["boundary_unresolved"] is False
    assert result["sigma_ms"] is None
    assert result["low_marker_count"] is True


def test_delay_unresolved_boundary_fails_confidence_closed(monkeypatch):
    tracks = [_Track(times=np.arange(8.0), pixels=np.c_[np.arange(8.0) * 20, np.zeros(8)],
                     world=np.zeros(3)) for _ in range(3)]
    sampler = PoseSampler([(0.0, np.array([1., 0, 0, 0]), np.zeros(3)),
                           (10.0, np.array([1., 0, 0, 0]), np.zeros(3))])
    monkeypatch.setattr(delay_mod, "_track_cost",
                        lambda _t, _s, tau, *_a: abs(tau - 0.600) + 1.0)
    result = estimate_delay(tracks, sampler,
                            (np.array([1., 0, 0, 0]), np.zeros(3)),
                            (np.array([1., 0, 0, 0]), np.zeros(3)), None)
    assert result["search_ms"] == 400.0
    assert result["boundary_unresolved"] is True
    assert result["confidence"] == 0.0


def test_finalize_partial_session_recovers_completed_pairs(tmp_path):
    from vpcal.core.capture_session import finalize_partial_session

    (tmp_path / "captures" / "normal").mkdir(parents=True)
    (tmp_path / "tracking").mkdir()
    (tmp_path / "captures" / "normal" / "0001.png").write_bytes(b"png")
    (tmp_path / "tracking" / "poses.jsonl").write_text(json.dumps({"frame_id": 1}) + "\n")
    partial = {
        "images": {"path": "captures/normal", "format": "png"},
        "tracking": {"path": "tracking/poses.jsonl", "coordinate_system": "freeDEuler",
                     "frame_matching": "frame_id"},
        "screen": {"path": "screen.json"},
        "capture_partial": {"poses_captured": 1},
    }
    (tmp_path / "session.partial.json").write_text(json.dumps(partial))
    result = finalize_partial_session(tmp_path)
    assert result["poses_recovered"] == 1
    assert (tmp_path / "session.json").exists()
    assert not (tmp_path / "session.partial.json").exists()
    assert "capture_partial" not in json.loads((tmp_path / "session.json").read_text())


def test_pattern_wait_preserves_outer_finish_command():
    from vpcal.core.capture_backend import CapturedFrame
    from vpcal.core.capture_session import CaptureSessionRunner

    runner = CaptureSessionRunner.__new__(CaptureSessionRunner)
    runner.cfg = SimpleNamespace(pattern_wait_s=1.0, graycode_sync=False,
                                 allow_ack_without_graycode=False, graycode_cell_px=24,
                                 preview_sink=None)
    runner.emit = lambda *_args: None
    runner._control = queue.Queue()
    runner.post({"cmd": "finish"})
    frame = CapturedFrame(np.zeros((8, 8), np.uint8), recv_ts=0.0)
    _frame, ok = runner._wait_pattern(itertools.repeat(frame), "normal")
    assert ok is False
    assert runner._drain_control() == [{"cmd": "finish"}]
