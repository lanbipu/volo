import json

import pytest

from tracksim.cli.commands.factory import build_track_source
from tracksim.infra.clock import FakeClock
from tracksim.sources.track import TrackPoseSource
from tracksim.domain.errors import InvalidTrajectoryError


def _track(tmp_path, rate):
    p = tmp_path / "t.json"
    p.write_text(json.dumps({"schema": "tracksim.track/1", "rate": rate, "camera": "c",
                             "frames": [{"t": 0.0, "pose": {"pan": 0.0}}, {"t": 1.0, "pose": {"pan": 5.0}}]}),
                 encoding="utf-8")
    return str(p)


def test_rate_defaults_to_track_rate(tmp_path):
    src, rate = build_track_source(_track(tmp_path, 24.0), rate=None, clock=FakeClock())
    assert isinstance(src, TrackPoseSource)
    assert rate == 24.0


def test_rate_override(tmp_path):
    src, rate = build_track_source(_track(tmp_path, 24.0), rate=50.0, clock=FakeClock())
    assert rate == 50.0


def test_requires_path():
    with pytest.raises(InvalidTrajectoryError):
        build_track_source(None, rate=30.0, clock=FakeClock())


def test_csv_without_sidecar_uses_rate_override(tmp_path):
    # 回归(Codex P2)：CSV 无 sidecar 但给了 --rate，必须能加载（--rate 透传给 load_track）
    p = tmp_path / "t.csv"
    p.write_text("timestamp,frame,camera:cam_1.offset.x\n00:00:00.00,0,0\n00:00:00.00,1,1\n", encoding="utf-8")
    src, rate = build_track_source(str(p), rate=60.0, clock=FakeClock())
    assert isinstance(src, TrackPoseSource) and rate == 60.0


def test_loop_flag_makes_source_seamless(tmp_path):
    # loop=True → 回放不耗尽（游标回绕）；factory 须把 loop 透传给 TrackPoseSource
    src, _ = build_track_source(_track(tmp_path, 2.0), rate=None, clock=FakeClock(), loop=True)
    poses = [src.next(0.5) for _ in range(6)]   # 2 帧 period=1.0，6 次取样不应 StopIteration
    assert [p.frame for p in poses] == [1, 2, 3, 4, 5, 6]
