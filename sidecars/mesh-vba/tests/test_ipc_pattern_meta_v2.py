from lmt_vba_sidecar.ipc import PatternMeta, PatternMetaCabinet


def test_pattern_meta_v2_roundtrip_with_per_cabinet_geometry():
    meta = PatternMeta(
        schema_version=2,
        aruco_dict="DICT_6X6_1000",
        cabinets=[
            PatternMetaCabinet(
                col=0, row=0, aruco_id_start=0, aruco_id_end=39,
                squares_x=9, squares_y=9, square_px=120,
                pixel_pitch_mm=[0.2778, 0.2778],
            )
        ],
    )
    dumped = meta.model_dump_json()
    again = PatternMeta.model_validate_json(dumped)
    cab = again.cabinets[0]
    assert again.schema_version == 2
    assert (cab.squares_x, cab.squares_y, cab.square_px) == (9, 9, 120)
    assert cab.pixel_pitch_mm == [0.2778, 0.2778]
    assert cab.markers == (9 * 9) // 2  # derived helper


def test_pattern_meta_rejects_v1_missing_squares():
    import pytest
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        PatternMeta.model_validate_json(
            '{"schema_version":2,"aruco_dict":"DICT_6X6_1000",'
            '"cabinets":[{"col":0,"row":0,"aruco_id_start":0,"aruco_id_end":39}]}'
        )
