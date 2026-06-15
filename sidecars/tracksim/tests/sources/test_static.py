from tracksim.domain.pose import CameraPose
from tracksim.sources.static import StaticPoseSource


def test_static_next_increments_frame_and_timestamp():
    base = CameraPose(pan=12.0, tilt=-3.0, x=1.5, focal_length=50.0)
    source = StaticPoseSource(base)

    first = source.next(0.1)
    assert first.frame == 1
    assert first.timestamp == 0.1
    assert first.pan == 12.0
    assert first.tilt == -3.0
    assert first.x == 1.5
    assert first.focal_length == 50.0

    second = source.next(0.1)
    assert second.frame == 2
    assert second.timestamp == 0.2
    assert second.pan == 12.0
    assert second.tilt == -3.0
    assert second.x == 1.5
    assert second.focal_length == 50.0

    source.close()
