"""Printable marker board / calibration-cube generation (plan A3).

``generate_boards`` writes one print-ready PNG per tag (tag + quiet zone +
physical-size annotation + cut marks) and a survey CSV template whose rows
the operator fills in after measuring the mounted corners.

``generate_cube`` writes the face sheets of a DIY cardboard calibration cube
(cf. Miraxyz CalibFX Lineup) plus the matching marker map JSON whose corner
coordinates come from the cube's CAD geometry (``survey_source="cad"``,
uncertainty = the declared manufacturing tolerance).  Cube local frame:
origin at the bottom-face centre, Z up — placing the cube puts the stage
origin at its footprint.  Assembly check rulers (exact face-size outlines
with mm labels) are drawn on every sheet.

Annotations are ASCII-only by design: these sheets go through arbitrary
print pipelines and cv2's Hershey fonts carry no CJK glyphs.
"""

from __future__ import annotations

import re
from pathlib import Path

import cv2
import numpy as np

from vpcal.core.detector_physical import resolve_dictionary
from vpcal.models.marker_map import MarkerMapDefinition, SurveyedMarker

_DEFAULT_PX_PER_MM = 8.0
_TAG_BITMAP_PX = 960  # oversampled bit pattern, downscaled into the sheet


def marker_id_prefix(dictionary: str) -> str:
    """``DICT_APRILTAG_36h11`` → ``AT_36h11``; ``DICT_5X5_100`` → ``AR_5X5``."""
    m = re.match(r"DICT_APRILTAG_(.+)", dictionary)
    if m:
        return f"AT_{m.group(1)}"
    m = re.match(r"DICT_(.+?)_\d+$", dictionary)
    if m:
        return f"AR_{m.group(1)}"
    return dictionary


def parse_id_range(spec: str) -> list[int]:
    """``"0-11"`` / ``"0,3,7"`` / ``"5"`` → sorted unique id list."""
    ids: set[int] = set()
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            lo, hi = part.split("-", 1)
            ids.update(range(int(lo), int(hi) + 1))
        else:
            ids.add(int(part))
    return sorted(ids)


def _annotate(img: np.ndarray, lines: list[str], origin: tuple[int, int]) -> None:
    x, y = origin
    for line in lines:
        cv2.putText(img, line, (x, y), cv2.FONT_HERSHEY_SIMPLEX, 0.9, 0, 2, cv2.LINE_AA)
        y += 34


def _tag_sheet(
    dictionary_name: str, tag_id: int, marker_id: str, size_mm: float, px_per_mm: float,
    extra_lines: list[str] | None = None, sheet_mm: float | None = None,
) -> np.ndarray:
    """One white sheet with the tag centred, quiet zone, cut marks and labels."""
    lines = [
        f"{marker_id}  ({dictionary_name} id {tag_id})",
        f"tag edge = {size_mm:.0f} mm  |  print at 100% scale, no fit-to-page",
        "corner order: c1=TL c2=TR c3=BR c4=BL (tag upright)",
    ]
    if extra_lines:
        lines.extend(extra_lines)

    tag_px = int(round(size_mm * px_per_mm))
    quiet_px = max(tag_px // 8, int(round(10 * px_per_mm)))  # >= 10 mm quiet zone
    sheet_px = int(round(sheet_mm * px_per_mm)) if sheet_mm else tag_px + 2 * quiet_px + int(round(20 * px_per_mm))
    sheet_px = max(sheet_px, tag_px + 2 * quiet_px + 80)
    # Label band sized to the actual line count — a fixed height silently
    # clips the extra cube-face lines off the printed sheet.
    band_px = 40 + 34 * (len(lines) + 1) + 20
    sheet = np.full((sheet_px + band_px, sheet_px), 255, dtype=np.uint8)

    tag = cv2.aruco.generateImageMarker(resolve_dictionary(dictionary_name), tag_id, _TAG_BITMAP_PX)
    tag = cv2.resize(tag, (tag_px, tag_px), interpolation=cv2.INTER_NEAREST)
    x0 = (sheet_px - tag_px) // 2
    y0 = (sheet_px - tag_px) // 2
    sheet[y0 : y0 + tag_px, x0 : x0 + tag_px] = tag

    # Cut marks at the quiet-zone boundary (the printable cut line).
    cut = quiet_px
    for cx, cy, dx, dy in (
        (x0 - cut, y0 - cut, 1, 1), (x0 + tag_px + cut, y0 - cut, -1, 1),
        (x0 - cut, y0 + tag_px + cut, 1, -1), (x0 + tag_px + cut, y0 + tag_px + cut, -1, -1),
    ):
        cv2.line(sheet, (cx, cy), (cx + dx * 40, cy), 0, 2)
        cv2.line(sheet, (cx, cy), (cx, cy + dy * 40), 0, 2)

    lines.insert(2, f"quiet zone >= {quiet_px / px_per_mm:.0f} mm (keep white)")
    _annotate(sheet, lines, (20, sheet_px + 40))
    return sheet


def generate_boards(
    dictionary_name: str,
    ids: list[int],
    out_dir: str | Path,
    *,
    size_mm: float = 160.0,
    px_per_mm: float = _DEFAULT_PX_PER_MM,
) -> dict:
    """Write one printable PNG per tag + a survey CSV template; returns a summary."""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    prefix = marker_id_prefix(dictionary_name)
    files: list[str] = []
    csv_lines = ["marker_id,marker_type,dictionary,tag_id,point,x,y,z,on_ground,size_mm,uncertainty_mm,survey_source"]
    marker_type = "apriltag" if "APRILTAG" in dictionary_name else "aruco"
    for tag_id in ids:
        marker_id = f"{prefix}_{tag_id}"
        sheet = _tag_sheet(dictionary_name, tag_id, marker_id, size_mm, px_per_mm)
        path = out / f"{marker_id}.png"
        cv2.imwrite(str(path), sheet)
        files.append(str(path))
        for pt in ("c1", "c2", "c3", "c4"):
            csv_lines.append(
                f"{marker_id},{marker_type},{dictionary_name},{tag_id},{pt},,,,"
                f"0,{size_mm:.0f},,total_station"
            )
    template = out / "survey_template.csv"
    template.write_text("\n".join(csv_lines) + "\n")
    return {
        "boards": files,
        "survey_template": str(template),
        "dictionary": dictionary_name,
        "size_mm": size_mm,
    }


# Cube faces: (name, outward normal, face-centre offset from the bottom-centre
# origin in units of size).  Bottom face omitted (it rests on the floor).
_CUBE_FACES = [
    ("top", (0.0, 0.0, 1.0), (0.0, 0.0, 1.0)),
    ("x_pos", (1.0, 0.0, 0.0), (0.5, 0.0, 0.5)),
    ("x_neg", (-1.0, 0.0, 0.0), (-0.5, 0.0, 0.5)),
    ("y_pos", (0.0, 1.0, 0.0), (0.0, 0.5, 0.5)),
    ("y_neg", (0.0, -1.0, 0.0), (0.0, -0.5, 0.5)),
]


def generate_cube(
    dictionary_name: str,
    out_dir: str | Path,
    *,
    size_mm: float = 300.0,
    start_id: int = 0,
    tag_fill: float = 0.7,
    tolerance_mm: float = 1.0,
    px_per_mm: float = _DEFAULT_PX_PER_MM,
) -> dict:
    """Write cube face sheets + the CAD-truth marker map JSON; returns a summary.

    Faces: top + the four sides (the bottom rests on the floor).  Tag edge =
    ``tag_fill`` × face size.  The generated map's corner coordinates assume
    the sheets are mounted with the annotated "TOP" edge up (sides) /
    toward +X (top face) — the same orientation convention as
    ``SurveyedMarker.resolved_corners``.
    """
    from vpcal.io.marker_map_io import save_marker_map

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    prefix = marker_id_prefix(dictionary_name)
    marker_type = "apriltag" if "APRILTAG" in dictionary_name else "aruco"
    tag_mm = tag_fill * size_mm

    files: list[str] = []
    markers: list[SurveyedMarker] = []
    for i, (face, normal, centre_units) in enumerate(_CUBE_FACES):
        tag_id = start_id + i
        marker_id = f"{prefix}_{tag_id}"
        top_hint = "tag TOP edge -> stage +X" if face == "top" else "tag TOP edge -> up (+Z)"
        sheet = _tag_sheet(
            dictionary_name, tag_id, marker_id, tag_mm, px_per_mm,
            extra_lines=[
                f"cube face: {face}  |  face edge = {size_mm:.0f} mm (assembly check)",
                f"mount: {top_hint}",
            ],
            sheet_mm=size_mm,
        )
        # Assembly check ruler: the exact face outline.
        face_px = int(round(size_mm * px_per_mm))
        off = (sheet.shape[1] - face_px) // 2
        cv2.rectangle(sheet, (off, off), (off + face_px - 1, off + face_px - 1), 0, 1)
        path = out / f"cube_{face}_{marker_id}.png"
        cv2.imwrite(str(path), sheet)
        files.append(str(path))

        centre = [c * size_mm for c in centre_units]
        markers.append(
            SurveyedMarker(
                marker_id=marker_id,
                marker_type=marker_type,
                dictionary=dictionary_name,
                tag_id=tag_id,
                center_stage_mm=centre,
                size_mm=tag_mm,
                normal=list(normal),
                uncertainty_mm=tolerance_mm,
                survey_source="cad",
            )
        )

    marker_map = MarkerMapDefinition(
        name=f"cube_{int(size_mm)}mm_{prefix}",
        frame_name=(
            f"calibration cube local frame ({size_mm:.0f} mm edge): origin at the "
            "bottom-face centre, Z up, +X face toward stage +X; place the cube so "
            "this point is the desired stage origin (survey_source=cad, "
            f"tolerance {tolerance_mm} mm)"
        ),
        markers=markers,
    )
    map_path = out / "cube_map.json"
    save_marker_map(marker_map, map_path)
    return {
        "faces": files,
        "marker_map": str(map_path),
        "dictionary": dictionary_name,
        "size_mm": size_mm,
        "tag_mm": tag_mm,
        "num_markers": len(markers),
    }
