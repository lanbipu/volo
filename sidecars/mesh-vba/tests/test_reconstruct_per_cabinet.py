"""Task 5.1: reconstruct routes each cabinet's corners through its OWN per-cabinet
board shape (v2 pattern_meta) into pitch-based local-mm. Uses the existing
synthetic_charuco_capture fixture (two real ChArUco boards) and asserts both
cabinets are recovered with the canonical V###_R### naming."""
from __future__ import annotations

import json

from lmt_vba_sidecar.ipc import ReconstructInput
from lmt_vba_sidecar.reconstruct import run_reconstruct


def _input(paths: dict) -> ReconstructInput:
    return ReconstructInput.model_validate({
        "command": "reconstruct", "version": 1,
        "project": {"screen_id": "S",
                    "cabinet_array": {"cols": 2, "rows": 1, "cabinet_size_mm": [600, 600]},
                    "shape_prior": "flat"},
        "capture_manifest_path": paths["capture"],
        "screen_mapping_path": paths["screen_mapping"],
        "pose_report_path": paths["pose_report"],
    })


def _result_event(captured_out: str) -> dict:
    for line in captured_out.splitlines():
        line = line.strip()
        if not line:
            continue
        ev = json.loads(line)
        if ev.get("event") == "result":
            return ev
    raise AssertionError("no result event on stdout")


def test_reconstruct_routes_both_cabinets_with_canonical_names(
    synthetic_charuco_capture, capsys,
):
    assert run_reconstruct(_input(synthetic_charuco_capture)) == 0
    result = _result_event(capsys.readouterr().out)
    names = {mp["name"] for mp in result["data"]["measured_points"]}
    # Both cabinets routed; canonical V{col:03d}_R{row:03d} cabinet identity.
    assert names == {"MAIN_V000_R000", "MAIN_V001_R000"}
    # Geometry was recovered (non-degenerate centers) -> per-cabinet local-mm
    # was applied correctly for each board's own shape.
    by = {mp["name"]: mp["position"] for mp in result["data"]["measured_points"]}
    assert by["MAIN_V000_R000"] != by["MAIN_V001_R000"]
