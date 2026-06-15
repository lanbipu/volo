"""Tests for screen_mapping: ScreenMapping model, charuco_corner_local_mm, preflight."""
import pytest
import numpy as np
from lmt_vba_sidecar.screen_mapping import ScreenMapping, ScreenMappingError


def _mapping():
    return ScreenMapping.model_validate({
        "screen_id": "S",
        "cabinets": [{
            "cabinet_id": "V000_R000",
            "resolution_px": [900, 510],
            "active_size_mm": [600, 340],
            "pixel_pitch_mm": [0.667, 0.667],
            "active_origin": "center",
            "input_rect_px": [0, 0, 900, 510],
            "rotation": 0,
            "mirror_x": False,
            "mirror_y": False,
        }],
        "expected_pattern_hash": "abc123",
    })


# ---------------------------------------------------------------------------
# charuco_corner_local_mm
# ---------------------------------------------------------------------------

def test_charuco_corner_local_mm_centered():
    """p0 and p63 must be symmetric about center (physical ChArUco convention)."""
    m = _mapping()
    p0 = m.charuco_corner_local_mm("V000_R000", 0, squares_x=9, squares_y=9, square_px=60)
    p_last = m.charuco_corner_local_mm("V000_R000", 63, squares_x=9, squares_y=9, square_px=60)
    assert np.allclose(p0[:2], -p_last[:2], atol=1e-6), (
        f"Not symmetric: p0={p0[:2]}, p_last={p_last[:2]}"
    )
    assert p0[2] == 0.0
    assert p_last[2] == 0.0


def test_charuco_corner_local_mm_z_is_zero():
    """z component is always 0 (flat screen plane)."""
    m = _mapping()
    for cid in [0, 15, 31, 63]:
        p = m.charuco_corner_local_mm("V000_R000", cid, squares_x=9, squares_y=9, square_px=60)
        assert p[2] == 0.0, f"z != 0 for charuco_id={cid}"


def test_charuco_corner_local_mm_pitch_based_spacing():
    """
    Pitch-based convention (v2): corner (r, c) sits at board-pixel
    ((c+1)*square_px, (r+1)*square_px); x_mm = (x_px - board_px/2) * pitch,
    y_mm = (board_px/2 - y_px) * pitch  (+y UP, matching OpenCV's ChArUco frame).
    For a 9x9 board at square_px=60 (board 540px) with pitch 0.667:
      corner (0,0) -> x = (60 - 270)*0.667 = -140.07, y = (270 - 60)*0.667 = +140.07
    """
    m = _mapping()
    p0 = m.charuco_corner_local_mm("V000_R000", 0, squares_x=9, squares_y=9, square_px=60)
    expected_x = (1 * 60 - 9 * 60 / 2) * 0.667  # -140.07
    expected_y = (9 * 60 / 2 - 1 * 60) * 0.667  # +140.07 (+y up)
    assert np.allclose(p0[:2], [expected_x, expected_y], atol=1e-6), (
        f"Pitch-based spacing mismatch: got {p0[:2]}, expected [{expected_x:.4f}, {expected_y:.4f}]"
    )


def test_charuco_corner_local_mm_unknown_cabinet():
    """Raises ScreenMappingError for unknown cabinet_id."""
    m = _mapping()
    with pytest.raises(ScreenMappingError):
        m.charuco_corner_local_mm("NONEXISTENT", 0, squares_x=9, squares_y=9, square_px=60)


def test_charuco_corner_local_mm_rotation_guard():
    """rotation != 0 must raise ScreenMappingError (not silently return wrong coords)."""
    data = {
        "screen_id": "S",
        "cabinets": [{
            "cabinet_id": "C90",
            "resolution_px": [510, 900],
            "active_size_mm": [340, 600],
            "pixel_pitch_mm": [0.667, 0.667],
            "active_origin": "center",
            "input_rect_px": [0, 0, 510, 900],
            "rotation": 90,
            "mirror_x": False,
            "mirror_y": False,
        }],
        "expected_pattern_hash": "abc",
    }
    m = ScreenMapping.model_validate(data)
    with pytest.raises(ScreenMappingError, match="rotation/mirror"):
        m.charuco_corner_local_mm("C90", 0, squares_x=9, squares_y=9, square_px=60)


def test_charuco_corner_local_mm_mirror_x_guard():
    """mirror_x=True must raise ScreenMappingError."""
    data = {
        "screen_id": "S",
        "cabinets": [{
            "cabinet_id": "CM",
            "resolution_px": [900, 510],
            "active_size_mm": [600, 340],
            "pixel_pitch_mm": [0.667, 0.667],
            "active_origin": "center",
            "input_rect_px": [0, 0, 900, 510],
            "rotation": 0,
            "mirror_x": True,
            "mirror_y": False,
        }],
        "expected_pattern_hash": "abc",
    }
    m = ScreenMapping.model_validate(data)
    with pytest.raises(ScreenMappingError, match="rotation/mirror"):
        m.charuco_corner_local_mm("CM", 0, squares_x=9, squares_y=9, square_px=60)


# ---------------------------------------------------------------------------
# preflight
# ---------------------------------------------------------------------------

def test_preflight_passes_on_correct_hash():
    """preflight returns None when hash matches."""
    m = _mapping()
    result = m.preflight(actual_pattern_hash="abc123")
    assert result is None


def test_preflight_rejects_pattern_hash_mismatch():
    """preflight raises ScreenMappingError on hash mismatch."""
    m = _mapping()
    with pytest.raises(ScreenMappingError):
        m.preflight(actual_pattern_hash="WRONG")


def test_expected_pattern_hash_is_optional_at_construction():
    """A screen_mapping.json may omit expected_pattern_hash (it does not exist
    until generate-pattern writes pattern_meta.json). The model must still
    validate, defaulting the field to None — this is what lets the same mapping
    drive generate-pattern before any pattern (or hash) exists."""
    data = {
        "screen_id": "S",
        "cabinets": [{
            "cabinet_id": "V000_R000",
            "resolution_px": [900, 510],
            "active_size_mm": [600, 340],
            "pixel_pitch_mm": [0.667, 0.667],
            "active_origin": "center",
            "input_rect_px": [0, 0, 900, 510],
            "rotation": 0,
            "mirror_x": False,
            "mirror_y": False,
        }],
        # no expected_pattern_hash
    }
    m = ScreenMapping.model_validate(data)
    assert m.expected_pattern_hash is None


def test_preflight_skips_check_when_hash_unset():
    """With no expected_pattern_hash, preflight has nothing to bind against and
    must skip the check (the reconstruct call site emits the pattern_hash_unset
    warning) rather than raise or false-mismatch against None."""
    data = {
        "screen_id": "S",
        "cabinets": [{
            "cabinet_id": "V000_R000",
            "resolution_px": [900, 510],
            "active_size_mm": [600, 340],
            "pixel_pitch_mm": [0.667, 0.667],
            "active_origin": "center",
            "input_rect_px": [0, 0, 900, 510],
            "rotation": 0,
            "mirror_x": False,
            "mirror_y": False,
        }],
    }
    m = ScreenMapping.model_validate(data)
    assert m.expected_pattern_hash is None
    # any actual hash is accepted (skipped), including a non-matching one
    assert m.preflight(actual_pattern_hash="anything") is None


def test_construction_rejects_invalid_rotation():
    """rotation=45 is rejected at model construction, not at preflight."""
    # model_post_init rejects values not in {0,90,180,270}; pydantic v2 wraps the
    # raised ValueError in a ValidationError (which subclasses ValueError).
    with pytest.raises(ValueError):
        ScreenMapping.model_validate({
            "screen_id": "S",
            "cabinets": [{
                "cabinet_id": "C",
                "resolution_px": [900, 510],
                "active_size_mm": [600, 340],
                "pixel_pitch_mm": [0.667, 0.667],
                "active_origin": "center",
                "input_rect_px": [0, 0, 900, 510],
                "rotation": 45,
                "mirror_x": False,
                "mirror_y": False,
            }],
            "expected_pattern_hash": "abc",
        })



# ---------------------------------------------------------------------------
# ScreenMappingCabinet validation
# ---------------------------------------------------------------------------

def test_cabinet_resolution_must_be_positive():
    """resolution_px must have positive values."""
    with pytest.raises(Exception):
        ScreenMapping.model_validate({
            "screen_id": "S",
            "cabinets": [{
                "cabinet_id": "C",
                "resolution_px": [0, 510],
                "active_size_mm": [600, 340],
                "pixel_pitch_mm": [0.667, 0.667],
                "active_origin": "center",
                "input_rect_px": [0, 0, 900, 510],
                "rotation": 0,
                "mirror_x": False,
                "mirror_y": False,
            }],
            "expected_pattern_hash": "abc",
        })


def _cabinet(**overrides):
    base = {
        "cabinet_id": "V000_R000",
        "resolution_px": [1000, 1000],
        "active_size_mm": [312.5, 312.5],  # = 1000 * 0.3125, consistent
        "pixel_pitch_mm": [0.3125, 0.3125],
        "active_origin": "center",
        "input_rect_px": [0, 0, 1000, 1000],
        "rotation": 0, "mirror_x": False, "mirror_y": False,
    }
    base.update(overrides)
    return {"screen_id": "S", "expected_pattern_hash": "x", "cabinets": [base]}


def test_scale_inconsistency_rejected():
    """pixel_pitch_mm × resolution_px must match active_size_mm (>1% apart fails)."""
    with pytest.raises(ValueError, match="inconsistent"):
        # 1000 * 0.3125 = 312.5mm, but active_size_mm says 300 (4% off)
        ScreenMapping.model_validate(_cabinet(active_size_mm=[300.0, 300.0]))


def test_consistent_scale_accepted():
    """Rounded pitch within 1% is accepted (no false positive)."""
    # 900 * 0.667 = 600.3 vs active 600 -> 0.05%, must pass
    ScreenMapping.model_validate(_cabinet(
        resolution_px=[900, 510], pixel_pitch_mm=[0.667, 0.667],
        active_size_mm=[600.0, 340.0], input_rect_px=[0, 0, 900, 510]))


def test_non_1to1_input_rect_rejected():
    """input_rect_px width/height must equal resolution_px (1:1 feed)."""
    with pytest.raises(ValueError, match="1:1 feed"):
        ScreenMapping.model_validate(_cabinet(input_rect_px=[0, 0, 800, 1000]))


def test_offset_input_rect_accepted():
    """Only the x/y offset may differ from a (0,0) rect (e.g. a gap)."""
    ScreenMapping.model_validate(_cabinet(input_rect_px=[0, 1080, 1000, 1000]))


def _mapping_rect(rw, rh):
    return ScreenMapping.model_validate({
        "screen_id": "S",
        "cabinets": [{
            "cabinet_id": "V000_R000",
            "resolution_px": [rw, rh],
            "active_size_mm": [float(rw), float(rh)],
            "pixel_pitch_mm": [1.0, 1.0],
            "active_origin": "center",
            "input_rect_px": [0, 0, rw, rh],
            "rotation": 0,
            "mirror_x": False,
            "mirror_y": False,
        }],
        "expected_pattern_hash": None,
    })


def test_corner_local_mm_folds_floor_centring_parity():
    """FIX-6 companion: _assemble_screen centres the board with an integer
    FLOOR ((rect-board)//2). With ODD slack the painted board sits 0.5px
    left/up of the rect centre; charuco_corner_local_mm must fold that parity
    offset in so p_local matches the PAINTED corner."""
    # board 8x8 squares x 60px = 480px in a 481px rect -> slack 1 (odd)
    p_odd = _mapping_rect(481, 481).charuco_corner_local_mm(
        "V000_R000", charuco_id=0, squares_x=8, squares_y=8, square_px=60)
    # board pixel (60,60); centre formula 60-240=-180mm at 1mm pitch; floor -0.5px
    assert np.isclose(p_odd[0], -180.0 - 0.5)
    assert np.isclose(p_odd[1], 180.0 + 0.5)
    # EVEN slack: no offset
    p_even = _mapping_rect(482, 482).charuco_corner_local_mm(
        "V000_R000", charuco_id=0, squares_x=8, squares_y=8, square_px=60)
    assert np.isclose(p_even[0], -180.0)
    assert np.isclose(p_even[1], 180.0)
