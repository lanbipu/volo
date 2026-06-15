from tracksim.domain.pose import VALID_POSE_CHANNELS


def test_valid_pose_channels_excludes_bookkeeping_fields():
    assert VALID_POSE_CHANNELS == {
        "pan", "tilt", "roll", "x", "y", "z",
        "focal_length", "focus_distance", "iris", "entrance_pupil",
    }
    # bookkeeping 字段不可作为映射目标
    assert "frame" not in VALID_POSE_CHANNELS
    assert "timestamp" not in VALID_POSE_CHANNELS
    assert "rate" not in VALID_POSE_CHANNELS
