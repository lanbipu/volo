"""Pattern generation: per-cabinet PNG, assembled screen PNG, meta JSON."""
from __future__ import annotations

import json
import pathlib

import cv2
import numpy as np

from lmt_vba_sidecar.ipc import (
    CabinetArray,
    GeneratePatternInput,
    GeneratePatternProject,
)
from lmt_vba_sidecar.pattern import (
    DEFAULT_ARUCO_DICT,
    generate_cabinet_png,
    run_generate_pattern,
)


def test_generate_cabinet_png_dimensions(tmp_out: pathlib.Path) -> None:
    out = tmp_out / "V000_R000.png"
    # 9x9 board at 40px/cell -> 360x360 canvas (cells stay square).
    generate_cabinet_png(
        out_path=out,
        aruco_id_start=0,
        squares_x=9, squares_y=9, square_px=40,
        aruco_dict_name=DEFAULT_ARUCO_DICT,
    )
    img = cv2.imread(str(out), cv2.IMREAD_GRAYSCALE)
    assert img is not None
    assert img.shape == (360, 360)


def test_run_generate_pattern_full_outputs(tmp_out: pathlib.Path) -> None:
    project = GeneratePatternProject(
        screen_id="MAIN",
        cabinet_array=CabinetArray(cols=2, rows=2, cabinet_size_mm=[500.0, 500.0]),
    )
    cmd = GeneratePatternInput(
        command="generate_pattern",
        version=1,
        project=project,
        output_dir=str(tmp_out),
        screen_resolution=[720, 720],
    )
    rc = run_generate_pattern(cmd)
    assert rc == 0

    cabinets_dir = tmp_out / "cabinets"
    assert (cabinets_dir / "V000_R000.png").exists()
    assert (cabinets_dir / "V001_R001.png").exists()

    full = tmp_out / "full_screen.png"
    assert full.exists()
    full_img = cv2.imread(str(full), cv2.IMREAD_GRAYSCALE)
    assert full_img.shape == (720, 720)

    meta = json.loads((tmp_out / "pattern_meta.json").read_text())
    assert meta["aruco_dict"] == DEFAULT_ARUCO_DICT
    assert len(meta["cabinets"]) == 4
    # Each cabinet's ID range is contiguous and non-overlapping.
    sorted_meta = sorted(meta["cabinets"], key=lambda c: c["aruco_id_start"])
    for i in range(len(sorted_meta) - 1):
        assert sorted_meta[i + 1]["aruco_id_start"] == sorted_meta[i]["aruco_id_end"] + 1


def test_absent_cells_omitted(tmp_out: pathlib.Path) -> None:
    project = GeneratePatternProject(
        screen_id="MAIN",
        cabinet_array=CabinetArray(
            cols=2, rows=2, cabinet_size_mm=[500.0, 500.0],
            absent_cells=[(1, 1)],
        ),
    )
    cmd = GeneratePatternInput(
        command="generate_pattern",
        version=1,
        project=project,
        output_dir=str(tmp_out),
        screen_resolution=[720, 720],
    )
    assert run_generate_pattern(cmd) == 0
    assert not (tmp_out / "cabinets" / "V001_R001.png").exists()
    full = cv2.imread(str(tmp_out / "full_screen.png"), cv2.IMREAD_GRAYSCALE)
    block = full[360:720, 360:720]
    # Absent cell is solid fill (uniform).
    assert block.std() < 1.0


def test_screen_resolution_must_divide_grid(tmp_out: pathlib.Path) -> None:
    project = GeneratePatternProject(
        screen_id="MAIN",
        cabinet_array=CabinetArray(cols=3, rows=2, cabinet_size_mm=[500.0, 500.0]),
    )
    cmd = GeneratePatternInput(
        command="generate_pattern",
        version=1,
        project=project,
        output_dir=str(tmp_out),
        screen_resolution=[721, 720],  # 721 not divisible by 3
    )
    rc = run_generate_pattern(cmd)
    assert rc != 0


def test_overflow_grid_fails_preflight_with_no_partial_output(tmp_out: pathlib.Path) -> None:
    """26 cabinets × 40 markers = 1040 > 1000 capacity. Must fail BEFORE
    any cabinet PNG is written, leaving output_dir empty.

    Each cabinet is 540x540 px so the short-side-anchored shape chooser yields a
    9x9 board (40 markers) — the legacy per-cabinet count that overflows at 26."""
    out = tmp_out / "patterns"
    project = GeneratePatternProject(
        screen_id="MAIN",
        cabinet_array=CabinetArray(cols=26, rows=1, cabinet_size_mm=[500.0, 500.0]),
    )
    # 26 * 540 px wide; each 540x540 cabinet -> 9x9 board -> 40 markers.
    cmd = GeneratePatternInput(
        command="generate_pattern",
        version=1,
        project=project,
        output_dir=str(out),
        screen_resolution=[26 * 540, 540],
    )
    rc = run_generate_pattern(cmd)
    assert rc != 0
    # No staging dir or partial output left behind
    assert not out.exists() or list(out.glob("**/*.png")) == []


def test_existing_output_preserved_when_generation_fails(tmp_out: pathlib.Path) -> None:
    """If output_dir has prior content and generation fails, prior content
    must remain (atomic publish guarantee)."""
    out = tmp_out / "patterns"
    out.mkdir()
    sentinel = out / "prior.txt"
    sentinel.write_text("prior content")

    project = GeneratePatternProject(
        screen_id="MAIN",
        cabinet_array=CabinetArray(cols=26, rows=1, cabinet_size_mm=[500.0, 500.0]),
    )
    cmd = GeneratePatternInput(
        command="generate_pattern",
        version=1,
        project=project,
        output_dir=str(out),
        screen_resolution=[26 * 540, 540],  # 540x540 cabinets -> 9x9 -> 40 markers -> overflow
    )
    assert run_generate_pattern(cmd) != 0
    assert sentinel.exists()
    assert sentinel.read_text() == "prior content"
