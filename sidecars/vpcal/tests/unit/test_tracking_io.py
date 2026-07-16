"""Tracking JSONL I/O tests (spec §4.2)."""

from __future__ import annotations

import json

import numpy as np

from vpcal.io.tracking_io import (
    detect_format,
    load_tracking,
    to_internal_poses,
    write_tracking,
)
from vpcal.models.tracking import RotationData, RotationOrder, TrackingFrame


def _compact_line(frame_id, pos, quat=(1, 0, 0, 0)):
    return json.dumps(
        {
            "frame_id": frame_id,
            "timestamp_s": frame_id * 0.04,
            "position": list(pos),
            "rotation": {"order": "quaternion", "values": list(quat)},
            "confidence": 1.0,
        }
    )


def test_detect_format():
    assert detect_format(_compact_line(0, [1, 2, 3])) == "compact"
    assert detect_format(json.dumps({"protocol": {"name": "OpenTrackIO"}})) == "opentrackio"
    assert detect_format(json.dumps({"static": {}, "transforms": []})) == "opentrackio"


def test_load_compact(tmp_path):
    p = tmp_path / "poses.jsonl"
    p.write_text("\n".join(_compact_line(i, [i * 10, 0, 1000]) for i in range(5)))
    frames = load_tracking(p)
    assert len(frames) == 5
    assert frames[3].frame_id == 3
    assert frames[3].position == [30.0, 0.0, 1000.0]


def test_write_read_roundtrip(tmp_path):
    frames = [
        TrackingFrame(
            frame_id=i, timestamp_s=i * 0.1, position=[i, i * 2, i * 3],
            rotation=RotationData(order=RotationOrder.QUATERNION, values=[1, 0, 0, 0]),
        )
        for i in range(4)
    ]
    p = tmp_path / "out.jsonl"
    write_tracking(frames, p)
    back = load_tracking(p)
    assert [f.frame_id for f in back] == [0, 1, 2, 3]
    assert back[2].position == [2.0, 4.0, 6.0]


def test_compact_roundtrip_preserves_dual_clock_and_fiz(tmp_path):
    frame = TrackingFrame(
        frame_id=1, timestamp_s=0.25, raw_monotonic_ts=1234.5,
        protocol_ts_s=42.25, zoom_raw=100, focus_raw=200,
        position=[0, 0, 0],
        rotation=RotationData(order=RotationOrder.QUATERNION, values=[1, 0, 0, 0]),
    )
    path = tmp_path / "poses.jsonl"
    write_tracking([frame], path)
    restored = load_tracking(path)[0]
    assert restored.timestamp_s == 0.25
    assert restored.raw_monotonic_ts == 1234.5
    assert restored.protocol_ts_s == 42.25
    assert (restored.zoom_raw, restored.focus_raw) == (100, 200)


def test_load_opentrackio_native(tmp_path):
    sample = {
        "protocol": {"name": "OpenTrackIO", "version": "1.0.0"},
        "timing": {"sequenceNumber": 7, "sampleTimestamp": {"seconds": 1, "nanoseconds": 500000000}},
        "transforms": [
            {"translation": {"x": 1.2, "y": 0.8, "z": 3.5}, "rotation": {"pan": 10, "tilt": 5, "roll": 0}}
        ],
    }
    p = tmp_path / "otio.jsonl"
    p.write_text(json.dumps(sample))
    frames = load_tracking(p)
    assert len(frames) == 1
    assert frames[0].frame_id == 7
    # metres → mm
    assert np.allclose(frames[0].position, [1200, 800, 3500])
    assert abs(frames[0].timestamp_s - 1.5) < 1e-9


def test_to_internal_poses_unreal_flips_y(tmp_path):
    p = tmp_path / "poses.jsonl"
    p.write_text(_compact_line(0, [1000, 500, 2000]))
    frames = load_tracking(p)
    poses = to_internal_poses(frames, "unreal")
    _q, t = poses[0]
    assert np.allclose(t, [1000, -500, 2000])
