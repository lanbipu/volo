import pytest

from tracksim.domain.errors import InvalidTrajectoryError
from tracksim.track import load_track

_H = ("timestamp,frame,camera:cam_1.offset.x,camera:cam_1.offset.y,camera:cam_1.offset.z,"
      "camera:cam_1.rotation.x,camera:cam_1.rotation.y,camera:cam_1.rotation.z,"
      "camera:cam_1.focalLengthMM,camera:cam_1.focusDistance")


def _csv(tmp_path, rows, header=_H, name="t.csv"):
    p = tmp_path / name
    p.write_text(header + "\n" + "\n".join(rows) + "\n", encoding="utf-8")
    return str(p)


def test_csv_with_rate_override(tmp_path):
    path = _csv(tmp_path, ["00:00:00.00,100,0,1,-6,0,0,0,30.3,12",
                           "00:00:00.00,101,0.5,1,-6,2,3,4,30.3,12"])
    track = load_track(path, rate_override=60.0)
    assert track.rate == 60.0 and track.camera == "cam_1"
    assert track.frames[0][0] == 0.0
    assert track.frames[1][0] == pytest.approx(1.0 / 60.0)
    p0 = track.frames[0][1]
    assert (p0.x, p0.y, p0.z) == (0.0, 1.0, -6.0)
    assert p0.focal_length == 30.3 and p0.focus_distance == 12.0
    p1 = track.frames[1][1]
    assert (p1.pan, p1.tilt, p1.roll) == (2.0, 3.0, 4.0)


def test_csv_rate_from_shot_sidecar(tmp_path):
    (tmp_path / "t.shot").write_text("D3SR\nFPS: 50\nTimecode: 30.0 FPS NDF\n", encoding="utf-8")
    path = _csv(tmp_path, ["00:00:00.00,0,0,0,0,0,0,0,35,3"])
    assert load_track(path).rate == 50.0


def test_csv_missing_rate_rejected(tmp_path):
    path = _csv(tmp_path, ["00:00:00.00,0,0,0,0,0,0,0,35,3"])
    with pytest.raises(InvalidTrajectoryError):
        load_track(path)


def test_csv_multi_camera_rejected(tmp_path):
    header = "timestamp,frame,camera:cam_1.offset.x,camera:cam_2.offset.x"
    path = _csv(tmp_path, ["00:00:00.00,0,1,2"], header=header)
    with pytest.raises(InvalidTrajectoryError):
        load_track(path, rate_override=60.0)
