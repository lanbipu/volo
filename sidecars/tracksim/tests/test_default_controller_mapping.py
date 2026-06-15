from tracksim.config import DEFAULT_CONTROLLER_MAPPING


def test_default_mapping_binds_paddles_to_zoom_and_focus():
    by_source = {e.source: e for e in DEFAULT_CONTROLLER_MAPPING}
    assert {"p1", "p2", "p3", "p4"} <= set(by_source)
    # 上排 P1/P3 -> 变焦
    assert by_source["p1"].channel == "focal_length"
    assert by_source["p3"].channel == "focal_length"
    # 下排 P2/P4 -> 对焦
    assert by_source["p2"].channel == "focus_distance"
    assert by_source["p4"].channel == "focus_distance"
    # 双向：退/近用 invert
    assert by_source["p1"].invert is False and by_source["p3"].invert is True
    assert by_source["p2"].invert is False and by_source["p4"].invert is True
    # 变焦 clamp 12..300mm，对焦 0.1..100m
    assert (by_source["p1"].clamp_min, by_source["p1"].clamp_max) == (12.0, 300.0)
    assert (by_source["p2"].clamp_min, by_source["p2"].clamp_max) == (0.1, 100.0)


def test_default_mapping_covers_sticks_triggers_shoulders():
    channels = {e.channel for e in DEFAULT_CONTROLLER_MAPPING}
    assert {"x", "y", "pan", "tilt", "z", "roll"} <= channels
    # LT/RT 都绑 z（双向高度），与用户实际用法一致
    z_sources = {e.source for e in DEFAULT_CONTROLLER_MAPPING if e.channel == "z"}
    assert z_sources == {"lefttrigger", "righttrigger"}
    assert all(e.mode == "rate" for e in DEFAULT_CONTROLLER_MAPPING)
