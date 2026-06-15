import json, pathlib
import cv2
import numpy as np
from lmt_vba_sidecar.ipc import GeneratePatternInput
from lmt_vba_sidecar.pattern import run_generate_pattern


def test_uniform_generation_writes_v2_meta(tmp_path: pathlib.Path):
    out = tmp_path / "patterns" / "BENCH"
    cmd = GeneratePatternInput.model_validate({
        "command": "generate_pattern", "version": 1,
        "project": {"screen_id": "BENCH",
                    "cabinet_array": {"cols": 1, "rows": 2, "cabinet_size_mm": [300.0, 300.0]}},
        "output_dir": str(out), "screen_resolution": [1080, 2160],
    })
    assert run_generate_pattern(cmd) == 0
    meta = json.loads((out / "pattern_meta.json").read_text())
    assert meta["schema_version"] == 2
    assert len(meta["cabinets"]) == 2
    c0 = meta["cabinets"][0]
    assert {"col", "row", "aruco_id_start", "aruco_id_end",
            "squares_x", "squares_y", "square_px", "pixel_pitch_mm"} <= set(c0)
    # square cabinet reproduces legacy 9x9/40 markers
    assert (c0["squares_x"], c0["squares_y"]) == (9, 9)
    assert c0["aruco_id_end"] - c0["aruco_id_start"] + 1 == 40
    # contiguous, non-overlapping id blocks
    assert meta["cabinets"][1]["aruco_id_start"] == meta["cabinets"][0]["aruco_id_end"] + 1
    assert (out / "cabinets" / "V000_R000.png").exists()
    assert (out / "full_screen.png").exists()


def _write_screen_mapping(path, cabs):
    # cabs: list of (cid, res, size, pitch, rect)
    path.write_text(json.dumps({
        "screen_id": "BENCH", "expected_pattern_hash": "x",
        "cabinets": [{
            "cabinet_id": cid, "resolution_px": res, "active_size_mm": size,
            "pixel_pitch_mm": pitch, "active_origin": "center",
            "input_rect_px": rect, "rotation": 0, "mirror_x": False, "mirror_y": False,
        } for (cid, res, size, pitch, rect) in cabs]}))


def test_screen_mapping_unequal_cabinets_assemble_at_input_rect(tmp_path: pathlib.Path):
    # Two UNEQUAL cabinets stacked with a 40px gap: wide 1280x720 on top,
    # square 720x720 below. Boards must land at their input_rect_px, NOT a uniform grid.
    out = tmp_path / "patterns" / "BENCH"
    sm = tmp_path / "screen_mapping.json"
    _write_screen_mapping(sm, [
        ("V000_R000", [1280, 720], [400.0, 225.0], [0.3125, 0.3125], [0, 0, 1280, 720]),
        ("V000_R001", [720, 720], [225.0, 225.0], [0.3125, 0.3125], [0, 760, 720, 720]),
    ])
    cmd = GeneratePatternInput.model_validate({
        "command": "generate_pattern", "version": 1,
        "project": {"screen_id": "BENCH",
                    "cabinet_array": {"cols": 1, "rows": 2, "cabinet_size_mm": [300.0, 300.0]}},
        "output_dir": str(out), "screen_resolution": [1280, 1480],
        "screen_mapping_path": str(sm),
    })
    assert run_generate_pattern(cmd) == 0
    meta = json.loads((out / "pattern_meta.json").read_text())
    by = {(c["col"], c["row"]): c for c in meta["cabinets"]}
    assert (by[(0, 0)]["squares_x"], by[(0, 0)]["squares_y"]) == (16, 9)   # 1280x720 wide
    assert (by[(0, 1)]["squares_x"], by[(0, 1)]["squares_y"]) == (9, 9)    # 720x720 square
    full = cv2.imread(str(out / "full_screen.png"), cv2.IMREAD_GRAYSCALE)
    assert full.shape == (1480, 1280)
    # The 40px gap row (y in [720,760)) is untouched background (all white) — proof
    # the lower board was placed at its input_rect y=760, not at a uniform y=740 cell.
    assert (full[730:758, :] == 255).all()


def test_screen_mapping_missing_cabinet_is_invalid_input(tmp_path: pathlib.Path, capsys):
    out = tmp_path / "patterns" / "BENCH"
    sm = tmp_path / "screen_mapping.json"
    _write_screen_mapping(sm, [  # grid is 1x2 but only one cabinet described
        ("V000_R000", [720, 720], [225.0, 225.0], [0.3125, 0.3125], [0, 0, 720, 720]),
    ])
    cmd = GeneratePatternInput.model_validate({
        "command": "generate_pattern", "version": 1,
        "project": {"screen_id": "BENCH",
                    "cabinet_array": {"cols": 1, "rows": 2, "cabinet_size_mm": [225.0, 225.0]}},
        "output_dir": str(out), "screen_resolution": [720, 1440],
        "screen_mapping_path": str(sm),
    })
    assert run_generate_pattern(cmd) == 1
    cap = capsys.readouterr()
    err = cap.out + cap.err
    assert "invalid_input" in err and "V000_R001" in err
    assert not out.exists()  # nothing published on failure


def test_screen_mapping_overlapping_rects_is_invalid_input(tmp_path: pathlib.Path, capsys):
    out = tmp_path / "patterns" / "BENCH"
    sm = tmp_path / "screen_mapping.json"
    # Two cabinets whose input_rect_px overlap in y (0..720 vs 360..1080).
    _write_screen_mapping(sm, [
        ("V000_R000", [720, 720], [225.0, 225.0], [0.3125, 0.3125], [0, 0, 720, 720]),
        ("V000_R001", [720, 720], [225.0, 225.0], [0.3125, 0.3125], [0, 360, 720, 720]),
    ])
    cmd = GeneratePatternInput.model_validate({
        "command": "generate_pattern", "version": 1,
        "project": {"screen_id": "BENCH",
                    "cabinet_array": {"cols": 1, "rows": 2, "cabinet_size_mm": [225.0, 225.0]}},
        "output_dir": str(out), "screen_resolution": [720, 1080],
        "screen_mapping_path": str(sm),
    })
    assert run_generate_pattern(cmd) == 1
    cap = capsys.readouterr()
    err = cap.out + cap.err
    assert "invalid_input" in err and "overlapping" in err
    assert not out.exists()


def test_screen_mapping_scale_inconsistency_is_invalid_input(tmp_path: pathlib.Path, capsys):
    out = tmp_path / "patterns" / "BENCH"
    sm = tmp_path / "screen_mapping.json"
    # 1080 * 0.2778 = 300.02mm, but active_size_mm says 320 (>6% off) -> rejected.
    _write_screen_mapping(sm, [
        ("V000_R000", [1080, 1080], [320.0, 320.0], [0.2778, 0.2778], [0, 0, 1080, 1080]),
    ])
    cmd = GeneratePatternInput.model_validate({
        "command": "generate_pattern", "version": 1,
        "project": {"screen_id": "BENCH",
                    "cabinet_array": {"cols": 1, "rows": 1, "cabinet_size_mm": [320.0, 320.0]}},
        "output_dir": str(out), "screen_resolution": [1080, 1080],
        "screen_mapping_path": str(sm),
    })
    assert run_generate_pattern(cmd) == 1
    cap = capsys.readouterr()
    err = cap.out + cap.err
    assert "invalid_input" in err
    assert not out.exists()
