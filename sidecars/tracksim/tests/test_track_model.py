from tracksim.domain.pose import CameraPose
from tracksim.track import Track, dump_track, TRACK_SCHEMA


def test_dump_track_shape():
    t = Track(rate=60.0, camera="cam_1", frames=[
        (0.0, CameraPose(x=0.0, y=1.0, z=-6.0, focal_length=30.3, focus_distance=12.0)),
        (0.5, CameraPose(pan=10.0)),
    ])
    d = dump_track(t)
    assert d["schema"] == TRACK_SCHEMA
    assert d["rate"] == 60.0
    assert d["camera"] == "cam_1"
    assert len(d["frames"]) == 2
    assert d["frames"][0]["t"] == 0.0
    assert d["frames"][0]["pose"]["z"] == -6.0
    assert d["frames"][1]["pose"]["pan"] == 10.0
