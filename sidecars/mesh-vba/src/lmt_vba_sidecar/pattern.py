"""ChArUco pattern generation. Each cabinet gets an independent ChArUco board.

Outputs three artifacts:
  - cabinets/V<col>_R<row>.png    per-cabinet pattern (debug / regenerate)
  - full_screen.png               assembled screen-resolution image (Disguise drop-in)
  - pattern_meta.json             cabinet ↔ ArUco ID range mapping
"""
from __future__ import annotations

import os
import pathlib
import shutil
import tempfile

import cv2
import numpy as np

from lmt_vba_sidecar.io_utils import write_event
from lmt_vba_sidecar.ipc import (
    BaStats,
    ErrorEvent,
    GeneratePatternInput,
    PatternMeta,
    PatternMetaCabinet,
    ProgressEvent,
    ResultData,
    ResultEvent,
)


DEFAULT_ARUCO_DICT = "DICT_6X6_1000"
ABSENT_CELL_FILL = 255  # white block for missing cabinets
ARUCO_DICT_CAPACITY = 1000  # DICT_6X6_1000 has 1000 markers


def _aruco_dict():
    return cv2.aruco.getPredefinedDictionary(getattr(cv2.aruco, DEFAULT_ARUCO_DICT))


def generate_cabinet_png(
    *,
    out_path: pathlib.Path,
    aruco_id_start: int,
    squares_x: int,
    squares_y: int,
    square_px: int,
    aruco_dict_name: str = DEFAULT_ARUCO_DICT,
) -> int:
    """Render one cabinet's ChArUco PNG at exact integer square pixels.

    Canvas = (squares_x*square_px, squares_y*square_px); cells stay square.
    Returns the next free ArUco ID (caller assigns blocks sequentially).
    """
    if aruco_dict_name != DEFAULT_ARUCO_DICT:
        raise ValueError(f"only {DEFAULT_ARUCO_DICT} supported")
    from lmt_vba_sidecar.board_layout import markers_per_board
    aruco_dict = _aruco_dict()
    n_markers = markers_per_board(squares_x, squares_y)
    if aruco_id_start + n_markers > ARUCO_DICT_CAPACITY:
        raise ValueError(
            f"ArUco ID range {aruco_id_start}..{aruco_id_start + n_markers} "
            f"overflows {DEFAULT_ARUCO_DICT} ({ARUCO_DICT_CAPACITY} markers)"
        )

    # Slice the dictionary's bytesList so per-cabinet IDs occupy a contiguous
    # offset and stay unique across cabinets.
    sub_dict = cv2.aruco.Dictionary(
        aruco_dict.bytesList[aruco_id_start:aruco_id_start + n_markers],
        aruco_dict.markerSize,
    )
    board = cv2.aruco.CharucoBoard(
        size=(squares_x, squares_y),
        squareLength=1.0,
        markerLength=0.7,
        dictionary=sub_dict,
    )
    img = board.generateImage(
        (squares_x * square_px, squares_y * square_px),
        marginSize=0, borderBits=1,
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(out_path), img)
    return aruco_id_start + n_markers


def _resolve_cabinet_specs(
    *, cols: int, rows: int, absent: set,
    screen_resolution: tuple[int, int],
    screen_mapping,  # ScreenMapping | None
    cabinet_size_mm: list[float],
) -> list[dict]:
    """Return per-cabinet specs in row-major order.

    Each: {"col","row","resolution_px":(w,h),"pixel_pitch_mm":(px,py),
           "input_rect_px":(x,y,w,h)}.

    --screen-mapping mode (screen_mapping is not None): per-cabinet geometry +
    placement rect come from screen_mapping, with EXACT coverage (DD1a) — every
    present grid cabinet must be in the mapping and every mapping cabinet_id must
    be a present grid cell, else ValueError (caller -> invalid_input).

    Uniform mode (screen_mapping is None): geometry from screen_resolution / grid,
    uniform cabinet_size_mm, placement rect = (col*cw, row*ch, cw, ch).
    """
    from lmt_vba_sidecar.board_layout import cabinet_name
    sw, sh = screen_resolution
    present = [(col, row) for row in range(rows) for col in range(cols)
               if (col, row) not in absent]

    if screen_mapping is not None:
        sm_by_name = {c.cabinet_id: c for c in screen_mapping.cabinets}
        present_names = {cabinet_name(col, row) for (col, row) in present}
        missing = sorted(present_names - set(sm_by_name))
        if missing:
            raise ValueError(
                f"screen_mapping is missing {len(missing)} present cabinet(s): "
                f"{missing}. With --screen-mapping every present cabinet must be "
                f"described (single source of truth).")
        extra = sorted(set(sm_by_name) - present_names)
        if extra:
            raise ValueError(
                f"screen_mapping has {len(extra)} cabinet id(s) that are not "
                f"present grid cells (stale/misspelled or absent): {extra}.")
        specs: list[dict] = []
        for (col, row) in present:
            cab = sm_by_name[cabinet_name(col, row)]
            x, y, w, h = cab.input_rect_px
            specs.append({
                "col": col, "row": row,
                "resolution_px": (cab.resolution_px[0], cab.resolution_px[1]),
                "pixel_pitch_mm": (cab.pixel_pitch_mm[0], cab.pixel_pitch_mm[1]),
                "input_rect_px": (x, y, w, h),
            })
        return specs

    # Uniform mode.
    # Uniform placement puts cabinet (col,row) at canvas rect (col*w, row*h):
    # canvas v=0 is the displayed TOP, so cabinet row 0 = wall TOP (the cabinet
    # grid convention — declared in nominal.py's module docstring).
    uni_w, uni_h = sw // cols, sh // rows
    uni_pitch = (cabinet_size_mm[0] / uni_w, cabinet_size_mm[1] / uni_h)
    return [{
        "col": col, "row": row,
        "resolution_px": (uni_w, uni_h),
        "pixel_pitch_mm": uni_pitch,
        "input_rect_px": (col * uni_w, row * uni_h, uni_w, uni_h),
    } for (col, row) in present]


def _assemble_screen(
    *, out_path, cabinets_dir, specs, screen_resolution,
    tile_suffix: str = "", background: int = ABSENT_CELL_FILL,
) -> None:
    """Composite per-cabinet tiles onto the screen canvas.

    ``tile_suffix`` selects an alternate tile set (e.g. ``"_inverted"`` for the
    VP-QSP A2.2 inverted companion); default "" preserves the original charuco
    and vpqsp normal-frame behaviour byte-for-byte.
    """
    sw, sh = screen_resolution
    full = np.full((sh, sw), background, dtype=np.uint8)
    for s in specs:
        tile_path = cabinets_dir / f"V{s['col']:03d}_R{s['row']:03d}{tile_suffix}.png"
        if not tile_path.exists():
            continue
        tile = cv2.imread(str(tile_path), cv2.IMREAD_GRAYSCALE)
        th, tw = tile.shape
        rx, ry, rw, rh = s["input_rect_px"]        # placement rect (DD6)
        x0 = rx + (rw - tw) // 2                    # center board in its rect
        y0 = ry + (rh - th) // 2
        full[y0:y0 + th, x0:x0 + tw] = tile
    cv2.imwrite(str(out_path), full)


ATOMIC_BACKUP_SUFFIX = ".lmt-vba-old"


def publish_staging_dir(
    staging: pathlib.Path,
    out_dir: pathlib.Path,
    *,
    backup_suffix: str = ATOMIC_BACKUP_SUFFIX,
) -> None:
    """Atomically publish ``staging`` → ``out_dir`` (rename; WinError 5 → file merge)."""
    backup: pathlib.Path | None = None
    if out_dir.exists():
        backup = out_dir.with_suffix(out_dir.suffix + backup_suffix)
        if backup.exists():
            shutil.rmtree(backup)
        try:
            out_dir.rename(backup)
        except OSError:
            _merge_staging_into(staging, out_dir)
            shutil.rmtree(staging, ignore_errors=True)
            return

    try:
        staging.rename(out_dir)
    except OSError:
        if backup is not None and not out_dir.exists():
            backup.rename(out_dir)
        raise
    if backup is not None:
        shutil.rmtree(backup, ignore_errors=True)


def _merge_staging_into(staging: pathlib.Path, out_dir: pathlib.Path) -> None:
    """Best-effort in-place publish when the output directory cannot be renamed."""
    out_dir.mkdir(parents=True, exist_ok=True)
    published: set[pathlib.Path] = set()
    for src in staging.rglob("*"):
        if not src.is_file():
            continue
        rel = src.relative_to(staging)
        dest = out_dir / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_name(dest.name + ".lmt-vba-tmp")
        if tmp.exists():
            tmp.unlink()
        try:
            src.rename(tmp)
        except OSError:
            shutil.copy2(src, tmp)
            src.unlink(missing_ok=True)
        os.replace(tmp, dest)
        published.add(rel)

    for existing in list(out_dir.rglob("*")):
        if not existing.is_file():
            continue
        rel = existing.relative_to(out_dir)
        if rel not in published:
            try:
                existing.unlink()
            except OSError:
                pass


def run_generate_pattern(cmd: GeneratePatternInput) -> int:
    # VP-QSP: self-encoding markers, no ArUco dictionary capacity ceiling.
    if cmd.method == "vpqsp":
        from lmt_vba_sidecar.vpqsp_pattern import run_generate_pattern_vpqsp
        return run_generate_pattern_vpqsp(cmd)

    out_dir = pathlib.Path(cmd.output_dir)
    cols = cmd.project.cabinet_array.cols
    rows = cmd.project.cabinet_array.rows
    absent = set(tuple(c) for c in cmd.project.cabinet_array.absent_cells)
    sw, sh = cmd.screen_resolution

    # Optional per-cabinet geometry from screen_mapping (single source of truth).
    # A malformed mapping or a failed model validator (scale/1:1/rotation guards)
    # surfaces as a clean invalid_input envelope, not an uncaught traceback.
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

    # Even-divisibility only constrains the UNIFORM path; in --screen-mapping
    # mode the per-cabinet input_rect_px defines placement (DD6), so divisibility
    # is irrelevant.
    if screen_mapping is None and (sw % cols != 0 or sh % rows != 0):
        write_event(ErrorEvent(event="error", code="invalid_input",
            message=f"screen_resolution {sw}x{sh} must divide evenly by grid {cols}x{rows}",
            fatal=True))
        return 1

    # Resolve specs; exact-coverage / bad-mapping errors -> invalid_input (DD1a).
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

    # Choose per-cabinet board shape and run the capacity check on the real total.
    from lmt_vba_sidecar.board_layout import choose_board_shape, markers_per_board
    for s in specs:
        s["squares_x"], s["squares_y"], s["square_px"] = choose_board_shape(
            resolution_px=s["resolution_px"])
    total_markers = sum(markers_per_board(s["squares_x"], s["squares_y"]) for s in specs)
    if total_markers > ARUCO_DICT_CAPACITY:
        write_event(ErrorEvent(event="error", code="invalid_input",
            message=(f"grid needs {total_markers} ArUco IDs across {len(specs)} cabinets, "
                     f"exceeds {DEFAULT_ARUCO_DICT} capacity ({ARUCO_DICT_CAPACITY}); "
                     f"use fewer/larger cabinets or structured light"),
            fatal=True))
        return 1

    # DD6: every board must fit inside its placement rect, and every rect inside
    # the screen. Catches a board wider than its input_rect or rects that spill
    # past screen_resolution before any file is written.
    for s in specs:
        bw, bh = s["squares_x"] * s["square_px"], s["squares_y"] * s["square_px"]
        rx, ry, rw, rh = s["input_rect_px"]
        if bw > rw or bh > rh:
            write_event(ErrorEvent(event="error", code="invalid_input",
                message=(f"cabinet V{s['col']:03d}_R{s['row']:03d} board {bw}x{bh}px "
                         f"does not fit its input_rect {rw}x{rh}px"), fatal=True))
            return 1
        if rx < 0 or ry < 0 or rx + rw > sw or ry + rh > sh:
            write_event(ErrorEvent(event="error", code="invalid_input",
                message=(f"cabinet V{s['col']:03d}_R{s['row']:03d} input_rect "
                         f"[{rx},{ry},{rw},{rh}] spills past screen {sw}x{sh}"), fatal=True))
            return 1

    # Reject overlapping placement rects: in mapped mode input_rect_px are
    # operator-supplied, and two overlapping rects would silently overwrite each
    # other's board pixels in full_screen.png (uniform mode can't overlap).
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

    # Generate into a sibling temp dir and atomically swap on success so a
    # mid-run failure leaves the existing output_dir untouched.
    out_dir.parent.mkdir(parents=True, exist_ok=True)
    staging = pathlib.Path(tempfile.mkdtemp(
        prefix=f".{out_dir.name}-staging-",
        dir=str(out_dir.parent),
    ))
    cabinets_dir = staging / "cabinets"
    cabinets_dir.mkdir(parents=True)

    try:
        cabinets_meta: list[PatternMetaCabinet] = []
        next_id = 0
        total = len(specs)
        for i, s in enumerate(specs):
            col, row = s["col"], s["row"]
            tile = cabinets_dir / f"V{col:03d}_R{row:03d}.png"
            id_start = next_id
            next_id = generate_cabinet_png(
                out_path=tile, aruco_id_start=id_start,
                squares_x=s["squares_x"], squares_y=s["squares_y"], square_px=s["square_px"])
            cabinets_meta.append(PatternMetaCabinet(
                col=col, row=row, aruco_id_start=id_start, aruco_id_end=next_id - 1,
                squares_x=s["squares_x"], squares_y=s["squares_y"], square_px=s["square_px"],
                pixel_pitch_mm=[s["pixel_pitch_mm"][0], s["pixel_pitch_mm"][1]]))
            write_event(ProgressEvent(event="progress", stage="output",
                percent=(i + 1) / total, message=f"cabinet V{col:03d}_R{row:03d}"))

        _assemble_screen(
            out_path=staging / "full_screen.png",
            cabinets_dir=cabinets_dir,
            specs=specs,
            screen_resolution=(sw, sh),
        )

        meta = PatternMeta(schema_version=2, aruco_dict=DEFAULT_ARUCO_DICT, cabinets=cabinets_meta)
        (staging / "pattern_meta.json").write_text(meta.model_dump_json(indent=2))

        # Atomic publish: move existing out_dir aside, rename staging into place
        # (Windows falls back to per-file replace — see publish_staging_dir).
        publish_staging_dir(staging, out_dir)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise

    write_event(ResultEvent(
        event="result",
        data=ResultData(
            measured_points=[],
            ba_stats=BaStats(rms_reprojection_px=0.0, iterations=0, converged=True),
            frame_strategy_used="nominal_anchoring",
            procrustes_align_rms_m=0.0,  # pattern gen does no Procrustes
        ),
    ))
    return 0
