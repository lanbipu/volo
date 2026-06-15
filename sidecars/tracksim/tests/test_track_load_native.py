import json

import pytest

from tracksim.domain.errors import InvalidTrajectoryError
from tracksim.track import load_track


def _write(tmp_path, obj, name="t.json"):
    p = tmp_path / name
    p.write_text(json.dumps(obj), encoding="utf-8")
    return str(p)


def test_load_native_basic(tmp_path):
    path = _write(tmp_path, {
        "schema": "tracksim.track/1", "rate": 30.0, "camera": "cam_1",
        "frames": [{"t": 0.0, "pose": {"x": 0.0, "y": 1.0, "z": -6.0}}, {"t": 1.0, "pose": {"pan": 10.0}}],
    })
    track = load_track(path)
    assert track.rate == 30.0 and track.camera == "cam_1" and len(track.frames) == 2
    assert track.frames[0][1].z == -6.0 and track.frames[1][1].pan == 10.0


def test_load_native_missing_rate_rejected(tmp_path):
    path = _write(tmp_path, {"schema": "tracksim.track/1", "camera": "c", "frames": [{"t": 0.0, "pose": {}}]})
    with pytest.raises(InvalidTrajectoryError):
        load_track(path)


def test_load_native_rate_override(tmp_path):
    path = _write(tmp_path, {"schema": "tracksim.track/1", "rate": 60.0, "camera": "c",
                             "frames": [{"t": 0.0, "pose": {}}, {"t": 1.0, "pose": {}}]})
    assert load_track(path, rate_override=24.0).rate == 24.0


def test_load_native_empty_frames_rejected(tmp_path):
    path = _write(tmp_path, {"schema": "tracksim.track/1", "rate": 60.0, "camera": "c", "frames": []})
    with pytest.raises(InvalidTrajectoryError):
        load_track(path)


def test_load_unreadable_rejected(tmp_path):
    with pytest.raises(InvalidTrajectoryError):
        load_track(str(tmp_path / "nope.json"))
