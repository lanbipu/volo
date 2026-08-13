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
from lmt_vba_sidecar.pattern import _resolve_cabinet_specs, publish_staging_dir
from lmt_vba_sidecar.sl_codec import build_dots_in_rect, data_bits_for, encode_id

ATOMIC_BACKUP_SUFFIX = ".lmt-sl-old"


def plan_dot_layout(
    *,
    screen_resolution: tuple[int, int],
    projected_screen_px: tuple[float, float],
    target_dots: int = 100,
    min_camera_dot_radius_px: float = 2.0,
    decode_yield: float = 0.75,
) -> dict:
    """Camera-aware dot layout (SL spec §4.2, sequential per-screen capture).

    Given how large the screen appears in the CAMERA (``projected_screen_px``,
    its bounding box in camera pixels — a live-preview estimate), choose
    dot_radius / spacing / margin in SCREEN pixels such that:
      - each dot subtends >= ``min_camera_dot_radius_px`` in the camera (the
        sub-pixel weighted centroid needs a resolvable blob);
      - anchor neighbours keep a dark gap >= one dot diameter
        (spacing >= 4*r+2 — the decoder's blob-merge floor, see the per-cabinet
        auto-derive note in run_generate_structured_light);
      - the grid PLANS for ``target_dots / decode_yield`` placed dots so that
        ``target_dots`` survive real-world decode losses (defocus, oblique
        far sides, occlusion — the spec targets >= 100 DECODED per screen;
        the formal floor is 40). When the merge floor binds, count yields,
        never the gap.

    ``expected_dots`` is a single-rect estimate; multi-cabinet layouts tile
    per cabinet, so the realized count can differ slightly.
    """
    W, H = int(screen_resolution[0]), int(screen_resolution[1])
    pw, ph = float(projected_screen_px[0]), float(projected_screen_px[1])
    # Camera px per screen px, isotropic estimate from the tighter axis.
    scale = max(min(pw / max(W, 1), ph / max(H, 1)), 1e-6)
    r = int(np.ceil(min_camera_dot_radius_px / scale))
    r = int(np.clip(r, 3, max(3, min(W, H) // 40)))
    margin = max(r + 1, int(round(min(W, H) / 16)))
    usable_w, usable_h = max(W - 2 * margin, 1), max(H - 2 * margin, 1)
    planned = max(target_dots, 1) / min(max(decode_yield, 0.1), 1.0)
    s_target = int(np.floor(np.sqrt(usable_w * usable_h / planned)))
    spacing = max(4 * r + 2, s_target)
    nu = usable_w // spacing + 1
    nv = usable_h // spacing + 1
    return {
        "dot_radius_px": int(r),
        "dot_spacing_px": int(spacing),
        "margin_px": int(margin),
        "expected_dots": int(nu * nv),
        "camera_px_per_screen_px": float(scale),
        "camera_dot_radius_px": float(r * scale),
    }


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
    # Camera-aware plan (when the caller supplied a projection estimate): its
    # radius replaces the request default and its spacing (a screen-global
    # density) becomes the fallback; margin stays per-cabinet (see below).
    # Explicit per-field overrides still beat both.
    plan = None
    if cmd.projected_screen_px is not None:
        plan = plan_dot_layout(
            screen_resolution=(w, h),
            projected_screen_px=(cmd.projected_screen_px[0], cmd.projected_screen_px[1]),
        )
    eff_radius = plan["dot_radius_px"] if plan else cmd.dot_radius_px

    dots: list[tuple[int, int, int]] = []
    dot_cabinet: dict[int, tuple[int, int]] = {}
    for s in specs:
        rect = tuple(int(v) for v in s["input_rect_px"])
        rmin = min(rect[2], rect[3])
        # Margin is a PER-RECT inset. The camera-aware plan sizes its margin
        # for the WHOLE screen canvas (min(W,H)/16), so applying it to every
        # cabinet rect carves most (or all) of a small cabinet away — a dense
        # cabinet array then yields ~0 dots and generation aborts. Under a
        # plan, derive the margin per cabinet from the PLANNED radius (same
        # formula as the auto path), clamped so the rect keeps a nonempty dot
        # lattice even when the planned radius rivals the cabinet size. For a
        # single-rect screen this equals the plan's own margin.
        eff_margin = (cmd.margin_px if cmd.margin_px is not None
                      else (min(max(eff_radius + 1, round(rmin / 16)),
                                max(0, (rmin - 1) // 2)) if plan
                            else max(eff_radius + 1, round(rmin / 16))))
        # Spacing floor = 2x dot diameter (4*r+2), i.e. a dark gap of at least one
        # dot diameter between neighbours. Pure non-overlap (2*r+2) is NOT enough:
        # adjacent dots that merely touch on the pristine frame fuse into one blob
        # under any real camera defocus/PSF, and the decoder seeds centroids from
        # the all-on anchor with a fixed binarize + connectedComponents (no blob
        # splitting), so merged dots silently drop from the correspondence set.
        eff_spacing = (cmd.dot_spacing_px if cmd.dot_spacing_px is not None
                       else (plan["dot_spacing_px"] if plan
                             else max(4 * eff_radius + 2, round(rmin / 8))))
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
        anchor = _draw_dots(w, h, dots, all_ids, eff_radius)
        logical = [white, anchor] + [_draw_dots(w, h, dots, lit_by_bit[b], eff_radius)
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
            "dot_radius_px": eff_radius,
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

        publish_staging_dir(staging, out_dir, backup_suffix=ATOMIC_BACKUP_SUFFIX)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise

    write_event(ResultEvent(event="result", data=ResultData(
        measured_points=[], ba_stats=BaStats(rms_reprojection_px=0.0, iterations=0, converged=True),
        frame_strategy_used="nominal_anchoring", procrustes_align_rms_m=0.0)))
    return 0
