"""Marker map file I/O: JSON load/save + survey CSV import (plan A3/B1).

Two CSV layouts are accepted (auto-detected from the header), both one row
per surveyed POINT, mm units — matching the one-point-per-row habit of the
M1 total-station workflow (``crates/mesh-adapter-total-station`` uses
``name,x,y,z,note``):

* **rich** — header contains ``marker_id`` and ``point``::

      marker_id,marker_type,dictionary,tag_id,point,x,y,z,on_ground,size_mm,uncertainty_mm,survey_source
      AT_36h11_0,apriltag,DICT_APRILTAG_36h11,0,c1,0,0,2000,...

  ``point`` ∈ ``c1..c4`` (corners TL,TR,BR,BL) or ``center``.  Per-marker
  attributes are read from the first row that carries them.

* **total-station** — header ``name,x,y,z[,note]``.  ``name`` is
  ``<marker_id>#<pt>`` with ``<pt>`` ∈ ``c1..c4`` / ``ctr``; ``note`` holds
  space-separated ``key=value`` attrs (``type= dict= tag= size= ground=
  sigma= src=``), e.g.::

      name,x,y,z,note
      AT_36h11_0#c1,0.0,0.0,2000.0,type=apriltag dict=DICT_APRILTAG_36h11 ground=0
"""

from __future__ import annotations

import csv
import json
from pathlib import Path

from vpcal.core.errors import ArgumentError, ResourceNotFoundError
from vpcal.models.marker_map import MarkerMapDefinition, SurveyedMarker


def load_marker_map(path: str | Path) -> MarkerMapDefinition:
    p = Path(path)
    if not p.exists():
        raise ResourceNotFoundError(f"marker map not found: {p}", details={"path": str(p)})
    try:
        raw = json.loads(p.read_text())
    except json.JSONDecodeError as exc:
        raise ArgumentError(f"marker map is not valid JSON: {exc}", details={"path": str(p)}) from exc
    try:
        return MarkerMapDefinition.model_validate(raw)
    except Exception as exc:  # noqa: BLE001 — pydantic ValidationError → argument error
        raise ArgumentError(f"marker map validation failed: {exc}", details={"path": str(p)}) from exc


def save_marker_map(marker_map: MarkerMapDefinition, path: str | Path) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(marker_map.model_dump(mode="json"), indent=2, ensure_ascii=False))


# ── CSV import ───────────────────────────────────────────────────────

_CORNER_KEYS = {"c1": 0, "c2": 1, "c3": 2, "c4": 3}
_NOTE_KEYS = {"type", "dict", "tag", "size", "ground", "sigma", "src"}


def _truthy(v: str) -> bool:
    return v.strip().lower() in ("1", "true", "yes", "y")


def _parse_note(note: str) -> dict:
    attrs: dict = {}
    for token in note.split():
        if "=" not in token:
            continue
        k, v = token.split("=", 1)
        if k in _NOTE_KEYS:
            attrs[k] = v
    return attrs


def _finish_marker(mid: str, acc: dict) -> SurveyedMarker:
    corners = acc.get("corners", {})
    if corners and len(corners) != 4:
        raise ArgumentError(
            f"marker {mid!r}: {len(corners)} corner rows (need all of c1..c4)"
        )
    kwargs: dict = {
        "marker_id": mid,
        "marker_type": acc.get("marker_type", "apriltag"),
        "dictionary": acc.get("dictionary"),
        "tag_id": acc.get("tag_id"),
        "on_ground": acc.get("on_ground", False),
        "uncertainty_mm": acc.get("uncertainty_mm"),
        "survey_source": acc.get("survey_source"),
        "size_mm": acc.get("size_mm"),
        "normal": acc.get("normal"),
    }
    if corners:
        kwargs["corners_stage_mm"] = [corners[i] for i in range(4)]
    if "center" in acc:
        kwargs["center_stage_mm"] = acc["center"]
    try:
        return SurveyedMarker(**kwargs)
    except Exception as exc:  # noqa: BLE001 — pydantic ValidationError → argument error
        raise ArgumentError(f"marker {mid!r}: {exc}") from exc


def marker_map_from_csv(
    csv_path: str | Path, *, frame_name: str, name: str | None = None
) -> MarkerMapDefinition:
    """Parse a survey CSV (rich or total-station layout) into a marker map."""
    p = Path(csv_path)
    if not p.exists():
        raise ResourceNotFoundError(f"survey CSV not found: {p}", details={"path": str(p)})
    with p.open(newline="") as fh:
        reader = csv.DictReader(fh)
        if reader.fieldnames is None:
            raise ArgumentError(f"survey CSV is empty: {p}")
        header = [c.strip().lower() for c in reader.fieldnames]
        rows = [{k.strip().lower(): (v or "").strip() for k, v in row.items() if k} for row in reader]

    if "marker_id" in header and "point" in header:
        parsed = _parse_rich(rows)
    elif "name" in header and {"x", "y", "z"} <= set(header):
        parsed = _parse_total_station(rows)
    else:
        raise ArgumentError(
            "unrecognised survey CSV header; expected 'marker_id,point,x,y,z,…' "
            f"or 'name,x,y,z[,note]' (got: {header})"
        )

    markers = [_finish_marker(mid, acc) for mid, acc in parsed.items()]
    if not markers:
        raise ArgumentError(f"survey CSV contains no marker rows: {p}")
    return MarkerMapDefinition(name=name, frame_name=frame_name, markers=markers)


def _xyz(row: dict, ctx: str) -> list[float]:
    try:
        return [float(row["x"]), float(row["y"]), float(row["z"])]
    except (KeyError, ValueError) as exc:
        raise ArgumentError(f"{ctx}: bad x/y/z values") from exc


def _parse_rich(rows: list[dict]) -> dict[str, dict]:
    markers: dict[str, dict] = {}
    for i, row in enumerate(rows):
        mid = row.get("marker_id", "")
        pt = row.get("point", "").lower()
        if not mid:
            raise ArgumentError(f"CSV row {i + 2}: empty marker_id")
        acc = markers.setdefault(mid, {"corners": {}})
        xyz = _xyz(row, f"CSV row {i + 2} ({mid})")
        if pt in _CORNER_KEYS:
            acc["corners"][_CORNER_KEYS[pt]] = xyz
        elif pt == "center":
            acc["center"] = xyz
        else:
            raise ArgumentError(f"CSV row {i + 2} ({mid}): point must be c1..c4 or center, got {pt!r}")
        _absorb(acc, row.get("marker_type"), "marker_type")
        _absorb(acc, row.get("dictionary"), "dictionary")
        _absorb(acc, row.get("tag_id"), "tag_id", int)
        _absorb(acc, row.get("size_mm"), "size_mm", float)
        _absorb(acc, row.get("uncertainty_mm"), "uncertainty_mm", float)
        _absorb(acc, row.get("survey_source"), "survey_source")
        if row.get("on_ground"):
            acc["on_ground"] = _truthy(row["on_ground"])
        if row.get("normal_x") and row.get("normal_y") and row.get("normal_z"):
            acc["normal"] = [float(row["normal_x"]), float(row["normal_y"]), float(row["normal_z"])]
    return markers


def _parse_total_station(rows: list[dict]) -> dict[str, dict]:
    markers: dict[str, dict] = {}
    for i, row in enumerate(rows):
        raw_name = row.get("name", "")
        if "#" not in raw_name:
            raise ArgumentError(
                f"CSV row {i + 2}: name {raw_name!r} lacks the '#<pt>' suffix (c1..c4 / ctr)"
            )
        mid, pt = raw_name.rsplit("#", 1)
        pt = pt.lower()
        acc = markers.setdefault(mid, {"corners": {}})
        xyz = _xyz(row, f"CSV row {i + 2} ({mid})")
        if pt in _CORNER_KEYS:
            acc["corners"][_CORNER_KEYS[pt]] = xyz
        elif pt == "ctr":
            acc["center"] = xyz
        else:
            raise ArgumentError(f"CSV row {i + 2} ({mid}): point suffix must be c1..c4 or ctr, got {pt!r}")
        note = _parse_note(row.get("note", ""))
        _absorb(acc, note.get("type"), "marker_type")
        _absorb(acc, note.get("dict"), "dictionary")
        _absorb(acc, note.get("tag"), "tag_id", int)
        _absorb(acc, note.get("size"), "size_mm", float)
        _absorb(acc, note.get("sigma"), "uncertainty_mm", float)
        _absorb(acc, note.get("src"), "survey_source")
        if "ground" in note:
            acc["on_ground"] = _truthy(note["ground"])
    return markers


def _absorb(acc: dict, value, key: str, cast=None) -> None:
    """Set a per-marker attribute from the first row that carries it."""
    if value in (None, "") or key in acc:
        return
    try:
        acc[key] = cast(value) if cast else value
    except ValueError as exc:
        raise ArgumentError(f"bad {key} value {value!r}") from exc
