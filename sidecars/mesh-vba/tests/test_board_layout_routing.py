from lmt_vba_sidecar.board_layout import (
    build_marker_routing, cabinet_name, corner_name,
)


def test_routing_maps_marker_id_to_cabinet_block():
    # two cabinets: block0 = ids 0..39 (cab (0,0)), block1 = 40..71 (cab (0,1))
    blocks = [
        {"col": 0, "row": 0, "aruco_id_start": 0, "aruco_id_end": 39},
        {"col": 0, "row": 1, "aruco_id_start": 40, "aruco_id_end": 71},
    ]
    route = build_marker_routing(blocks)
    assert route[0] == (0, 0)
    assert route[39] == (0, 0)
    assert route[40] == (0, 1)
    assert route[71] == (0, 1)
    assert 72 not in route  # outside any block


def test_canonical_names():
    assert cabinet_name(0, 0) == "V000_R000"
    assert cabinet_name(12, 5) == "V012_R005"
    assert corner_name("BENCH", 0, 0, 12) == "BENCH_V000_R000_C012"
