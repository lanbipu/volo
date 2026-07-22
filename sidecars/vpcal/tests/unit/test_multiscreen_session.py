import pytest

from vpcal.models.session import SessionConfig


def _base():
    return {
        "images": {"path": "captures/normal"},
        "tracking": {"path": "tracking/poses.jsonl"},
        "lens": {
            "focal_length_mm": 35.0,
            "sensor_width_mm": 36.0,
            "sensor_height_mm": 24.0,
            "image_width_px": 1920,
            "image_height_px": 1080,
        },
    }


def test_multiscreen_session_normalizes_targets():
    raw = _base()
    raw["screens"] = [
        {"id": "A", "path": "a.json", "screen_id": 0, "cab_col_offset": 0},
        {"id": "B", "path": "b.json", "screen_id": 1, "cab_col_offset": 16},
    ]
    session = SessionConfig.model_validate(raw)
    assert [target.id for target in session.screen_targets] == ["A", "B"]
    assert session.screen is None


def test_multiscreen_session_rejects_duplicate_assignment():
    raw = _base()
    raw["screens"] = [
        {"id": "A", "path": "a.json", "screen_id": 0, "cab_col_offset": 0},
        {"id": "B", "path": "b.json", "screen_id": 0, "cab_col_offset": 0},
    ]
    with pytest.raises(ValueError, match="duplicate"):
        SessionConfig.model_validate(raw)


def test_legacy_single_screen_remains_valid():
    raw = _base()
    raw["screen"] = {"path": "screen.json"}
    session = SessionConfig.model_validate(raw)
    assert len(session.screen_targets) == 1
