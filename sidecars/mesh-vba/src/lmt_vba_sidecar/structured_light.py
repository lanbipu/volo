"""Mapping-aware structured-light dot-array generation.

Reuses pattern.py::_resolve_cabinet_specs so placement honors screen_mapping /
absent cells / non-uniform cabinets exactly like generate_pattern. Dots are
tiled inside each PRESENT cabinet's input_rect_px.

Frame sequence (display order):
  [WHITE sentinel] [ALL-ON anchor] [code_0 .. code_{B-1}] [WHITE sentinel]
B = total_bits = data_bits + 1. The anchor lights every dot so the decoder can
seed all dot locations (incl. the all-off id=0). Outputs frames/, sequence.mp4,
sl_meta.json via the same atomic staging swap as pattern.py.
"""
from __future__ import annotations

import json
import pathlib
import shutil
import tempfile

import cv2
import numpy as np

from lmt_vba_sidecar.io_utils import write_event
from lmt_vba_sidecar.ipc import (
    BaStats, ErrorEvent, GenerateStructuredLightInput, ProgressEvent, ResultData, ResultEvent,
)
from lmt_vba_sidecar.pattern import _resolve_cabinet_specs
from lmt_vba_sidecar.sl_codec import build_dots_in_rect, data_bits_for, encode_id

ATOMIC_BACKUP_SUFFIX = ".lmt-sl-old"


def _draw_dots(w: int, h: int, dots, lit_ids: set[int], radius: int) -> np.ndarray:
    img = np.zeros((h, w), dtype=np.uint8)
    for (did, u, v) in dots:
        if did in lit_ids:
            cv2.circle(img, (int(u), int(v)), int(radius), 255, -1, cv2.LINE_AA)
    return img


def run_generate_structured_light(cmd: GenerateStructuredLightInput) -> int:
    w, h = cmd.screen_resolution
    cols = cmd.project.cabinet_array.cols
    rows = cmd.project.cabinet_array.rows
    absent = set(tuple(c) for c in cmd.project.cabinet_array.absent_cells)

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

    # Uniform path requires even divisibility (mirror pattern.py). Mapping path
    # defines placement via input_rect_px, so divisibility is irrelevant there.
    if screen_mapping is None and (w % cols != 0 or h % rows != 0):
        write_event(ErrorEvent(event="error", code="invalid_input",
            message=f"screen_resolution {w}x{h} must divide evenly by grid {cols}x{rows}",
            fatal=True))
        return 1

    try:
        specs = _resolve_cabinet_specs(
            cols=cols, rows=rows, absent=absent, screen_resolution=(w, h),
            screen_mapping=screen_mapping,
            cabinet_size_mm=list(cmd.project.cabinet_array.cabinet_size_mm))
    except ValueError as exc:
        write_event(ErrorEvent(event="error", code="invalid_input", message=str(exc), fatal=True))
        return 1

    # Tile dots inside each present cabinet's placement rect; global row-major ids.
    # spacing/margin auto-derive PER CABINET from its own pixel rect when not given
    # explicitly, so heterogeneous / any-resolution cabinets each fill correctly
    # (~8x8 grid) with zero tuning. dot_radius floors keep dots from clipping/merging.
    dots: list[tuple[int, int, int]] = []
    dot_cabinet: dict[int, tuple[int, int]] = {}
    for s in specs:
        rect = tuple(int(v) for v in s["input_rect_px"])
        rmin = min(rect[2], rect[3])
        eff_margin = (cmd.margin_px if cmd.margin_px is not None
                      else max(cmd.dot_radius_px + 1, round(rmin / 16)))
        # Spacing floor = 2x dot diameter (4*r+2), i.e. a dark gap of at least one
        # dot diameter between neighbours. Pure non-overlap (2*r+2) is NOT enough:
        # adjacent dots that merely touch on the pristine frame fuse into one blob
        # under any real camera defocus/PSF, and the decoder seeds centroids from
        # the all-on anchor with a fixed binarize + connectedComponents (no blob
        # splitting), so merged dots silently drop from the correspondence set.
        eff_spacing = (cmd.dot_spacing_px if cmd.dot_spacing_px is not None
                       else max(4 * cmd.dot_radius_px + 2, round(rmin / 8)))
        cab_dots = build_dots_in_rect(rect=rect, spacing_px=eff_spacing,
                                      margin_px=eff_margin, id_start=len(dots))
        for (did, u, v) in cab_dots:
            dot_cabinet[did] = (s["col"], s["row"])
        dots.extend(cab_dots)

    if len(dots) < 4:
        write_event(ErrorEvent(event="error", code="invalid_input",
            message=(f"only {len(dots)} dots fit; increase cabinet pixel resolution "
                     "or lower --dot-radius (auto layout), or set smaller "
                     "--dot-spacing/--margin explicitly"), fatal=True))
        return 1

    db = data_bits_for(len(dots))
    total_bits = db + 1
    lit_by_bit: list[set[int]] = [set() for _ in range(total_bits)]
    all_ids = {did for (did, _u, _v) in dots}
    for (did, _u, _v) in dots:
        for b, bit in enumerate(encode_id(did, db)):
            if bit:
                lit_by_bit[b].add(did)

    out_dir = pathlib.Path(cmd.output_dir)
    out_dir.parent.mkdir(parents=True, exist_ok=True)
    staging = pathlib.Path(tempfile.mkdtemp(prefix=f".{out_dir.name}-staging-", dir=str(out_dir.parent)))
    frames_dir = staging / "frames"
    frames_dir.mkdir(parents=True)

    try:
        white = np.full((h, w), 255, dtype=np.uint8)
        anchor = _draw_dots(w, h, dots, all_ids, cmd.dot_radius_px)
        logical = [white, anchor] + [_draw_dots(w, h, dots, lit_by_bit[b], cmd.dot_radius_px)
                                     for b in range(total_bits)] + [white]
        for i, img in enumerate(logical):
            cv2.imwrite(str(frames_dir / f"frame_{i:04d}.png"), img)
            write_event(ProgressEvent(event="progress", stage="output",
                        percent=(i + 1) / len(logical), message=f"frame {i}"))

        hold_repeat = max(1, round(cmd.hold_ms / 1000.0 * cmd.fps))
        vw = cv2.VideoWriter(str(staging / "sequence.mp4"),
                             cv2.VideoWriter_fourcc(*"mp4v"), float(cmd.fps), (w, h), isColor=False)
        for img in logical:
            for _ in range(hold_repeat):
                vw.write(img)
        vw.release()

        # disguise-ready image sequence: <screen_id>.seq/ of uncompressed 24-bit
        # TIFFs (IBM-PC/little-endian byte order is native here), one per logical
        # frame, named from 0 with no gaps -- the disguise .seq ingest convention.
        if cmd.emit_tiff_seq:
            sid = cmd.project.screen_id
            seq_dir = staging / f"{sid}.seq"
            seq_dir.mkdir(parents=True)
            for i, img in enumerate(logical):
                bgr = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
                cv2.imwrite(str(seq_dir / f"{sid}_{i:05d}.tif"),
                            bgr, [cv2.IMWRITE_TIFF_COMPRESSION, 1])

        meta = {
            "schema_version": 1,
            "screen_id": cmd.project.screen_id,
            "screen_resolution": [w, h],
            "dot_radius_px": cmd.dot_radius_px,
            "code": {"data_bits": db, "total_bits": total_bits, "parity": "even", "encoding": "binary"},
            "sequence": {"sentinel": "white_full", "anchor": "all_on",
                         "n_code_frames": total_bits, "hold_ms": cmd.hold_ms, "fps": cmd.fps},
            "cabinets": [{"col": s["col"], "row": s["row"],
                          "input_rect_px": [int(v) for v in s["input_rect_px"]],
                          "pixel_pitch_mm": [s["pixel_pitch_mm"][0], s["pixel_pitch_mm"][1]]}
                         for s in specs],
            "dots": [{"id": did, "u": float(u), "v": float(v),
                      "cabinet": list(dot_cabinet[did])} for (did, u, v) in dots],
        }
        (staging / "sl_meta.json").write_text(json.dumps(meta, indent=2))

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

    write_event(ResultEvent(event="result", data=ResultData(
        measured_points=[], ba_stats=BaStats(rms_reprojection_px=0.0, iterations=0, converged=True),
        frame_strategy_used="nominal_anchoring", procrustes_align_rms_m=0.0)))
    return 0
