"""VP-QSP pattern generation. Each cabinet gets a regular grid of self-encoding
VP-QSP markers — no shared ArUco dictionary, so no ~13-cabinet capacity ceiling.

Outputs the same three artifacts as the ChArUco path so the rest of the pipeline
(full_screen.png drop-in, pattern_meta-driven reconstruct) is unchanged:
  - cabinets/V<col>_R<row>.png    per-cabinet VP-QSP tile (debug / regenerate)
  - full_screen.png               assembled screen-resolution image (Disguise drop-in)
  - pattern_meta.json             VpqspPatternMeta (schema_version "vpqsp.v1")

Additionally emits an inverted companion of each image (cabinets/*_inverted.png,
full_screen_inverted.png) — a bitwise `255 - tile` of the normal frame, matching
vpcal's normal/inverted pair (sidecars/vpcal/src/vpcal/core/pattern.py
generate_pattern_images, as of 2026-07-02). Displaying normal then inverted and
differencing the two captures cancels ambient-light gradients in the detector's
sub-pixel centroid (see vpqsp_detect.detect_markers_image's `inverted` param).
These are purely additive outputs — pattern_meta.json and the existing normal
filenames are unchanged, so no downstream consumer (manifest, reconstruct,
IPC schema) is affected by their presence.
"""
from __future__ import annotations

import pathlib
import shutil
import tempfile

import cv2

from lmt_vba_sidecar.io_utils import write_event
from lmt_vba_sidecar.ipc import (
    BaStats,
    ErrorEvent,
    GeneratePatternInput,
    ProgressEvent,
    ResultData,
    ResultEvent,
    VpqspMarkerGrid,
    VpqspPatternMeta,
    WarningEvent,
)
from lmt_vba_sidecar.pattern import (
    ABSENT_CELL_FILL,
    ATOMIC_BACKUP_SUFFIX,
    _assemble_screen,
    _resolve_cabinet_specs,
)
from lmt_vba_sidecar.vpqsp_codec import MAX_COL, MAX_ROW
from lmt_vba_sidecar.vpqsp_layout import choose_marker_grid, render_cabinet_tile

# FIX-7: the generation gate is aligned with the RUNTIME gate. Reconstruct's
# check_observability requires >= 8 observations per cabinet counted ACROSS
# views (plus >= 2 views), so 4 markers x 2 views = 8 obs already satisfies it —
# the old per-pattern floor of 8 markers rejected the mainstream P2.3–P3.1
# 500mm cabinets (2x2 grids) that the runtime accepts. Cabinets in the 4..7
# band generate WITH a low_marker_count warning (every cabinet then needs >= 2
# covering views, zero slack at exactly 2); below 4 markers a single view can't
# even seed PnP (MIN_PNP_CORNERS=4), so generation refuses and points at the
# structured-light path.
MIN_MARKERS_PER_CABINET = 4
RECOMMENDED_MARKERS_PER_CABINET = 8


def run_generate_pattern_vpqsp(cmd: GeneratePatternInput) -> int:
    out_dir = pathlib.Path(cmd.output_dir)
    cols = cmd.project.cabinet_array.cols
    rows = cmd.project.cabinet_array.rows
    absent = set(tuple(c) for c in cmd.project.cabinet_array.absent_cells)
    sw, sh = cmd.screen_resolution

    screen_mapping = None
    if cmd.screen_mapping_path is not None:
        from lmt_vba_sidecar.screen_mapping import ScreenMapping
        try:
            screen_mapping = ScreenMapping.model_validate_json(
                pathlib.Path(cmd.screen_mapping_path).read_text())
        except (OSError, ValueError) as exc:
            write_event(ErrorEvent(event="error", code="invalid_input",
                message=f"screen_mapping load/validate failed: {exc}", fatal=True))
            return 1

    if screen_mapping is None and (sw % cols != 0 or sh % rows != 0):
        write_event(ErrorEvent(event="error", code="invalid_input",
            message=f"screen_resolution {sw}x{sh} must divide evenly by grid {cols}x{rows}",
            fatal=True))
        return 1

    try:
        specs = _resolve_cabinet_specs(
            cols=cols, rows=rows, absent=absent,
            screen_resolution=(sw, sh), screen_mapping=screen_mapping,
            cabinet_size_mm=list(cmd.project.cabinet_array.cabinet_size_mm),
        )
    except ValueError as exc:
        write_event(ErrorEvent(event="error", code="invalid_input",
            message=str(exc), fatal=True))
        return 1

    # Cabinet (col,row) must fit the marker's 7-bit cab_col/cab_row fields. This is
    # VP-QSP's only addressing ceiling (128x128 cabinets — vastly above ChArUco's
    # ~13); a wall beyond it needs a wider codec, so refuse cleanly rather than
    # crash at encode time.
    for s in specs:
        if s["col"] > MAX_COL or s["row"] > MAX_ROW:
            write_event(ErrorEvent(event="error", code="invalid_input",
                message=(f"cabinet V{s['col']:03d}_R{s['row']:03d} exceeds VP-QSP address "
                         f"space (max col/row = {MAX_COL}); grid up to {MAX_COL + 1}x"
                         f"{MAX_ROW + 1} cabinets is supported"), fatal=True))
            return 1

    # Choose per-cabinet marker grid; refuse a cabinet too small to clear
    # observability. The grid is capped at MAX_MARKERS_PER_CABINET (64, the 6-bit
    # local_id capacity) inside choose_marker_grid. NO dictionary-capacity check —
    # that ceiling is exactly what VP-QSP removes.
    low_marker_cabs: list[tuple[str, int]] = []
    for s in specs:
        s["markers_x"], s["markers_y"], s["marker_px"] = choose_marker_grid(s["resolution_px"])
        n_markers = s["markers_x"] * s["markers_y"]
        if n_markers < MIN_MARKERS_PER_CABINET:
            write_event(ErrorEvent(event="error", code="invalid_input",
                message=(f"cabinet V{s['col']:03d}_R{s['row']:03d} resolution "
                         f"{s['resolution_px']} yields only {n_markers} VP-QSP marker(s) "
                         f"(need >= {MIN_MARKERS_PER_CABINET}: one view must seed a 4-point "
                         f"PnP). At this pixel pitch / cabinet resolution VP-QSP cannot "
                         f"carry enough markers — use the structured-light path "
                         f"(generate-structured-light + reconstruct-structured-light) "
                         f"or a higher cabinet resolution"), fatal=True))
            return 1
        if n_markers < RECOMMENDED_MARKERS_PER_CABINET:
            low_marker_cabs.append((f"V{s['col']:03d}_R{s['row']:03d}", n_markers))
    if low_marker_cabs:
        ids = ", ".join(f"{cid}({n})" for cid, n in low_marker_cabs)
        write_event(WarningEvent(
            event="warning", code="low_marker_count",
            message=(f"{len(low_marker_cabs)} cabinet(s) carry fewer than "
                     f"{RECOMMENDED_MARKERS_PER_CABINET} markers: {ids}. The runtime "
                     f"observability gate (>= 8 observations/cabinet) is only reachable "
                     f"with >= 2 covering views per cabinet — plan the capture "
                     f"accordingly; a single lost marker at exactly 2 views fails the "
                     f"gate (zero slack)")))

    # Placement-rect sanity (mirrors the charuco path): rects inside the screen,
    # no overlaps (mapped mode rects are operator-supplied).
    for s in specs:
        rx, ry, rw, rh = s["input_rect_px"]
        if rx < 0 or ry < 0 or rx + rw > sw or ry + rh > sh:
            write_event(ErrorEvent(event="error", code="invalid_input",
                message=(f"cabinet V{s['col']:03d}_R{s['row']:03d} input_rect "
                         f"[{rx},{ry},{rw},{rh}] spills past screen {sw}x{sh}"), fatal=True))
            return 1
    for i in range(len(specs)):
        ax, ay, aw, ah = specs[i]["input_rect_px"]
        for j in range(i + 1, len(specs)):
            bx, by, bw_, bh_ = specs[j]["input_rect_px"]
            if not (ax + aw <= bx or bx + bw_ <= ax or ay + ah <= by or by + bh_ <= ay):
                write_event(ErrorEvent(event="error", code="invalid_input",
                    message=(f"cabinets V{specs[i]['col']:03d}_R{specs[i]['row']:03d} and "
                             f"V{specs[j]['col']:03d}_R{specs[j]['row']:03d} have overlapping "
                             f"input_rect_px ([{ax},{ay},{aw},{ah}] vs [{bx},{by},{bw_},{bh_}]). "
                             f"input_rect_px is [x, y, w, h] — each cabinet's placement rect on "
                             f"the shared screen canvas (cabinets do NOT each start at 0,0); the "
                             f"rects must not overlap. Tile them, e.g. place the 2nd cabinet to "
                             f"the right by setting its x to the 1st's x+w ({ax}+{aw}={ax + aw})."),
                    fatal=True))
                return 1

    out_dir.parent.mkdir(parents=True, exist_ok=True)
    staging = pathlib.Path(tempfile.mkdtemp(
        prefix=f".{out_dir.name}-staging-", dir=str(out_dir.parent)))
    cabinets_dir = staging / "cabinets"
    cabinets_dir.mkdir(parents=True)

    try:
        cabinets_meta: list[VpqspMarkerGrid] = []
        total = len(specs)
        for i, s in enumerate(specs):
            col, row = s["col"], s["row"]
            tile = render_cabinet_tile(
                screen_id_code=cmd.screen_id_code, col=col, row=row,
                markers_x=s["markers_x"], markers_y=s["markers_y"],
                marker_px=s["marker_px"], resolution_px=s["resolution_px"])
            cv2.imwrite(str(cabinets_dir / f"V{col:03d}_R{row:03d}.png"), tile)
            cv2.imwrite(str(cabinets_dir / f"V{col:03d}_R{row:03d}_inverted.png"), 255 - tile)
            cabinets_meta.append(VpqspMarkerGrid(
                col=col, row=row,
                resolution_px=[s["resolution_px"][0], s["resolution_px"][1]],
                markers_x=s["markers_x"], markers_y=s["markers_y"], marker_px=s["marker_px"],
                pixel_pitch_mm=[s["pixel_pitch_mm"][0], s["pixel_pitch_mm"][1]]))
            write_event(ProgressEvent(event="progress", stage="output",
                percent=(i + 1) / total, message=f"cabinet V{col:03d}_R{row:03d}"))

        _assemble_screen(
            out_path=staging / "full_screen.png",
            cabinets_dir=cabinets_dir, specs=specs, screen_resolution=(sw, sh))
        _assemble_screen(
            out_path=staging / "full_screen_inverted.png",
            cabinets_dir=cabinets_dir, specs=specs, screen_resolution=(sw, sh),
            tile_suffix="_inverted", background=255 - ABSENT_CELL_FILL)

        meta = VpqspPatternMeta(
            schema_version="vpqsp.v1", screen_id_code=cmd.screen_id_code,
            cabinets=cabinets_meta)
        (staging / "pattern_meta.json").write_text(meta.model_dump_json(indent=2))

        backup: pathlib.Path | None = None
        if out_dir.exists():
            backup = out_dir.with_suffix(out_dir.suffix + ATOMIC_BACKUP_SUFFIX)
            if backup.exists():
                shutil.rmtree(backup)
            out_dir.rename(backup)
        try:
            staging.rename(out_dir)
        except OSError:
            if backup is not None and not out_dir.exists():
                backup.rename(out_dir)
            raise
        if backup is not None:
            shutil.rmtree(backup, ignore_errors=True)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise

    write_event(ResultEvent(
        event="result",
        data=ResultData(
            measured_points=[],
            ba_stats=BaStats(rms_reprojection_px=0.0, iterations=0, converged=True),
            frame_strategy_used="nominal_anchoring",
            procrustes_align_rms_m=0.0,
        ),
    ))
    return 0
