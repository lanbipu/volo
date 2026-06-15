import json
import cv2
from lmt_vba_sidecar.ipc import GenerateStructuredLightInput
from lmt_vba_sidecar.structured_light import run_generate_structured_light


def _run(tmp_path, cols=1, rows=1, **over):
    cmd = GenerateStructuredLightInput.model_validate({
        "command": "generate_structured_light", "version": 1,
        "project": {"screen_id": "MAIN",
                    "cabinet_array": {"cols": cols, "rows": rows,
                                      "absent_cells": [], "cabinet_size_mm": [500, 500]}},
        "output_dir": str(tmp_path / "sl"), "screen_resolution": [480 * cols, 480 * rows],
        "dot_spacing_px": 160, "margin_px": 80, **over,
    })
    return run_generate_structured_light(cmd)


def test_frame_count_includes_anchor_and_two_sentinels(tmp_path):
    assert _run(tmp_path) == 0
    out = tmp_path / "sl"
    meta = json.loads((out / "sl_meta.json").read_text())
    total_bits = meta["code"]["total_bits"]
    frames = sorted((out / "frames").glob("frame_*.png"))
    # WHITE + ALLON + total_bits code frames + WHITE
    assert len(frames) == total_bits + 3
    assert meta["screen_id"] == "MAIN"
    assert (out / "sequence.mp4").exists()


def test_sentinels_white_and_anchor_lights_every_dot(tmp_path):
    _run(tmp_path)
    out = tmp_path / "sl"
    meta = json.loads((out / "sl_meta.json").read_text())
    frames = sorted((out / "frames").glob("frame_*.png"))
    first = cv2.imread(str(frames[0]), cv2.IMREAD_GRAYSCALE)
    last = cv2.imread(str(frames[-1]), cv2.IMREAD_GRAYSCALE)
    assert int(first.min()) == 255 and int(last.min()) == 255  # white sentinels
    anchor = cv2.imread(str(frames[1]), cv2.IMREAD_GRAYSCALE)   # all-on anchor
    for d in meta["dots"]:                                      # every dot lit, incl id 0
        assert int(anchor[int(d["v"]), int(d["u"])]) == 255


def test_auto_derive_keeps_decode_safe_spacing(tmp_path):
    # Omit dot_spacing/margin -> per-cabinet auto-derive. Small cabinet so the
    # spacing FLOOR is exercised (not the rmin/8 term). The floor must keep a
    # capture/blur-survivable gap (center spacing >= 2x dot diameter = 4*r+2),
    # else adjacent dots fuse into one blob at decode and silently drop.
    cmd = GenerateStructuredLightInput.model_validate({
        "command": "generate_structured_light", "version": 1,
        "project": {"screen_id": "MAIN",
                    "cabinet_array": {"cols": 1, "rows": 1,
                                      "absent_cells": [], "cabinet_size_mm": [500, 500]}},
        "output_dir": str(tmp_path / "sl"), "screen_resolution": [120, 120],
        "dot_radius_px": 6,  # dot_spacing_px / margin_px omitted -> None -> auto
    })
    assert cmd.dot_spacing_px is None and cmd.margin_px is None
    assert run_generate_structured_light(cmd) == 0
    meta = json.loads((tmp_path / "sl" / "sl_meta.json").read_text())
    dots = meta["dots"]
    assert len(dots) >= 8  # >= reconstruct's per-cabinet min_points
    us = sorted({d["u"] for d in dots})
    gaps = [b - a for a, b in zip(us, us[1:])]
    assert gaps, "expected a multi-column grid"
    assert min(gaps) >= 4 * 6 + 2, f"auto spacing too tight for decode: {min(gaps)}"


def test_auto_derive_fills_normal_cabinet(tmp_path):
    # Larger cabinet: the rmin/8 term wins -> a ~8x8 filled grid, no tuning.
    cmd = GenerateStructuredLightInput.model_validate({
        "command": "generate_structured_light", "version": 1,
        "project": {"screen_id": "MAIN",
                    "cabinet_array": {"cols": 1, "rows": 1,
                                      "absent_cells": [], "cabinet_size_mm": [500, 500]}},
        "output_dir": str(tmp_path / "sl"), "screen_resolution": [480, 480],
        "dot_radius_px": 6,
    })
    assert run_generate_structured_light(cmd) == 0
    meta = json.loads((tmp_path / "sl" / "sl_meta.json").read_text())
    assert len(meta["dots"]) == 64  # 8x8 across the 480px cabinet


def test_absent_cabinet_gets_no_dots(tmp_path):
    cmd = GenerateStructuredLightInput.model_validate({
        "command": "generate_structured_light", "version": 1,
        "project": {"screen_id": "MAIN",
                    "cabinet_array": {"cols": 2, "rows": 1, "absent_cells": [[1, 0]],
                                      "cabinet_size_mm": [500, 500]}},
        "output_dir": str(tmp_path / "sl"), "screen_resolution": [960, 480],
        "dot_spacing_px": 160, "margin_px": 80,
    })
    assert run_generate_structured_light(cmd) == 0
    meta = json.loads((tmp_path / "sl" / "sl_meta.json").read_text())
    # no dot lands in the absent right-half cabinet (u >= 480)
    assert all(d["u"] < 480 for d in meta["dots"])
