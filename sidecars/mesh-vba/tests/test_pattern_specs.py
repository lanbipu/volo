import pytest
from lmt_vba_sidecar.pattern import _resolve_cabinet_specs
from lmt_vba_sidecar.screen_mapping import ScreenMapping, ScreenMappingCabinet


def _cab(cid, res, size, pitch, rect):
    return ScreenMappingCabinet(
        cabinet_id=cid, resolution_px=res, active_size_mm=size, pixel_pitch_mm=pitch,
        active_origin="center", input_rect_px=rect,
        rotation=0, mirror_x=False, mirror_y=False)


def test_uniform_fallback_when_no_screen_mapping():
    specs = _resolve_cabinet_specs(
        cols=2, rows=1, absent=set(),
        screen_resolution=(2160, 1080), screen_mapping=None,
        cabinet_size_mm=[300.0, 300.0],
    )
    assert {(s["col"], s["row"]) for s in specs} == {(0, 0), (1, 0)}
    s = specs[0]
    assert s["resolution_px"] == (1080, 1080)  # 2160/2 x 1080/1
    assert s["pixel_pitch_mm"] == (300.0 / 1080, 300.0 / 1080)
    # uniform placement rect = (col*cw, row*ch, cw, ch)
    assert s["input_rect_px"] == (0, 0, 1080, 1080)
    assert specs[1]["input_rect_px"] == (1080, 0, 1080, 1080)


def test_screen_mapping_drives_per_cabinet_geometry_and_rects():
    sm = ScreenMapping(
        screen_id="BENCH", expected_pattern_hash="x",
        cabinets=[
            _cab("V000_R000", [1920, 1080], [600.0, 337.5], [0.3125, 0.3125], [0, 0, 1920, 1080]),
            _cab("V000_R001", [1080, 1080], [300.0, 300.0], [0.2778, 0.2778], [0, 1080, 1080, 1080]),
        ],
    )
    specs = _resolve_cabinet_specs(
        cols=1, rows=2, absent=set(),
        screen_resolution=(1920, 2160), screen_mapping=sm, cabinet_size_mm=[300.0, 300.0],
    )
    by_cr = {(s["col"], s["row"]): s for s in specs}
    assert by_cr[(0, 0)]["resolution_px"] == (1920, 1080)
    assert by_cr[(0, 1)]["resolution_px"] == (1080, 1080)
    # different pitch per cabinet flows through
    assert by_cr[(0, 0)]["pixel_pitch_mm"] != by_cr[(0, 1)]["pixel_pitch_mm"]
    # placement rects come straight from input_rect_px (NOT a uniform grid)
    assert by_cr[(0, 0)]["input_rect_px"] == (0, 0, 1920, 1080)
    assert by_cr[(0, 1)]["input_rect_px"] == (0, 1080, 1080, 1080)


def test_missing_cabinet_in_mapping_is_rejected():
    sm = ScreenMapping(screen_id="BENCH", expected_pattern_hash="x",
        cabinets=[_cab("V000_R000", [1080, 1080], [300.0, 300.0], [0.2778, 0.2778], [0, 0, 1080, 1080])])
    with pytest.raises(ValueError, match="V000_R001"):
        _resolve_cabinet_specs(cols=1, rows=2, absent=set(),
            screen_resolution=(1080, 2160), screen_mapping=sm, cabinet_size_mm=[300.0, 300.0])


def test_extra_or_misspelled_cabinet_in_mapping_is_rejected():
    sm = ScreenMapping(screen_id="BENCH", expected_pattern_hash="x",
        cabinets=[
            _cab("V000_R000", [1080, 1080], [300.0, 300.0], [0.2778, 0.2778], [0, 0, 1080, 1080]),
            _cab("V000_R009", [1080, 1080], [300.0, 300.0], [0.2778, 0.2778], [0, 1080, 1080, 1080]),
        ])
    with pytest.raises(ValueError, match="V000_R009"):
        _resolve_cabinet_specs(cols=1, rows=1, absent=set(),
            screen_resolution=(1080, 1080), screen_mapping=sm, cabinet_size_mm=[300.0, 300.0])
