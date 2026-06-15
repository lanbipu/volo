from __future__ import annotations

import csv as _csv
import json
import re
from dataclasses import dataclass
from pathlib import Path

from tracksim.domain.errors import InvalidTrajectoryError
from tracksim.domain.pose import CameraPose

TRACK_SCHEMA = "tracksim.track/1"

_POSE_FIELDS = ("pan", "tilt", "roll", "x", "y", "z", "focal_length", "focus_distance")


@dataclass
class Track:
    """规范摄影机轨迹：作者帧率 + 相机名 + (t秒, pose) 关键帧序列。"""

    rate: float
    camera: str
    frames: list[tuple[float, CameraPose]]


def dump_track(track: Track) -> dict:
    return {
        "schema": TRACK_SCHEMA,
        "rate": track.rate,
        "camera": track.camera,
        "frames": [
            {"t": t, "pose": {f: getattr(pose, f) for f in _POSE_FIELDS}}
            for t, pose in track.frames
        ],
    }


def _finite_pos_rate(value, *, where: str) -> float:
    import math
    try:
        r = float(value)
    except (TypeError, ValueError):
        raise InvalidTrajectoryError(f"{where}: rate must be a number, got {value!r}")
    if not math.isfinite(r) or r <= 0:
        raise InvalidTrajectoryError(f"{where}: rate must be a finite number > 0, got {r}")
    return r


def _frames_from_objs(objs, *, where: str) -> list[tuple[float, CameraPose]]:
    if not objs:
        raise InvalidTrajectoryError(f"{where}: frames is empty")
    frames: list[tuple[float, CameraPose]] = []
    for i, fr in enumerate(objs):
        if "t" not in fr or "pose" not in fr:
            raise InvalidTrajectoryError(f"{where}: frame {i} missing 't' or 'pose'")
        try:
            frames.append((float(fr["t"]), CameraPose(**fr["pose"])))
        except Exception as exc:
            raise InvalidTrajectoryError(f"{where}: frame {i} invalid pose: {exc}") from exc
    return frames


def _load_native(obj: dict, path: str, rate_override) -> Track:
    if "rate" not in obj and rate_override is None:
        raise InvalidTrajectoryError(
            f"{path}: native track.json must contain 'rate' (or pass --rate)", details={"path": path})
    rate = _finite_pos_rate(rate_override if rate_override is not None else obj["rate"], where=path)
    frames = _frames_from_objs(obj.get("frames", []), where=path)
    return Track(rate=rate, camera=str(obj.get("camera", "")), frames=frames)


def load_track(path: str, *, rate_override: float | None = None) -> Track:
    """装载结构化轨迹（原生 track.json / Disguise dense CSV）。失败 → InvalidTrajectoryError。"""
    p = Path(path)
    try:
        raw = p.read_text(encoding="utf-8")
    except OSError as exc:
        raise InvalidTrajectoryError(f"cannot read track file: {path}", details={"path": path}) from exc
    suffix = p.suffix.lower()
    if suffix == ".json":
        try:
            obj = json.loads(raw)
        except (json.JSONDecodeError, ValueError) as exc:
            raise InvalidTrajectoryError(f"cannot parse track JSON: {path}", details={"path": path}) from exc
        if isinstance(obj, dict) and obj.get("schema") == TRACK_SCHEMA:
            return _load_native(obj, path, rate_override)
        raise InvalidTrajectoryError(
            f"unrecognized JSON track (expected schema {TRACK_SCHEMA!r}): {path}", details={"path": path})
    if suffix == ".csv":
        rate = _resolve_csv_rate(p, rate_override)
        return _load_disguise_csv(raw, rate, path)
    raise InvalidTrajectoryError(f"unsupported track extension: {suffix}", details={"path": path})


_CHANNEL_MAP = {
    "offset.x": "x", "offset.y": "y", "offset.z": "z",
    "rotation.x": "pan", "rotation.y": "tilt", "rotation.z": "roll",
    "focalLengthMM": "focal_length", "focusDistance": "focus_distance",
}


def _resolve_csv_rate(csv_path: Path, rate_override) -> float:
    if rate_override is not None:                       # --rate 优先于 sidecar（显式覆盖）
        return _finite_pos_rate(rate_override, where=str(csv_path))
    for sidecar, pat in ((csv_path.with_suffix(".shot"), r"FPS:\s*([0-9.]+)"),
                         (csv_path.with_suffix(".json"), r'"fps"\s*:\s*([0-9.]+)')):
        if sidecar.exists():
            m = re.search(pat, sidecar.read_text(encoding="utf-8"))
            if m:
                return _finite_pos_rate(m.group(1), where=str(sidecar))
    raise InvalidTrajectoryError(
        f"CSV has no embedded rate; provide --rate or a .shot/.json sidecar with fps: {csv_path}",
        details={"path": str(csv_path)})


def _camera_of(col: str) -> str | None:
    if not col.startswith("camera:") or "." not in col:
        return None
    return col[len("camera:"):col.index(".", len("camera:"))]


def _load_disguise_csv(raw: str, rate: float, path: str) -> Track:
    rows = [r for r in _csv.reader(raw.splitlines()) if r]
    if len(rows) < 2:
        raise InvalidTrajectoryError(f"{path}: CSV has no data rows")
    header = rows[0]
    try:
        frame_idx = header.index("frame")
    except ValueError:
        raise InvalidTrajectoryError(f"{path}: CSV header missing 'frame' column")
    col_field: dict[int, str] = {}
    cameras: set[str] = set()
    for i, col in enumerate(header):
        for suffix, field in _CHANNEL_MAP.items():
            if col.endswith("." + suffix) or col == suffix:
                col_field[i] = field
                cam = _camera_of(col)
                if cam:
                    cameras.add(cam)
                break
    if not col_field:
        raise InvalidTrajectoryError(f"{path}: CSV header has no known camera channels")
    if len(cameras) > 1:
        raise InvalidTrajectoryError(
            f"{path}: CSV contains multiple cameras {sorted(cameras)}; single-camera CSV only",
            details={"cameras": sorted(cameras)})
    camera = next(iter(cameras), "")
    frames: list[tuple[float, CameraPose]] = []
    frame0: float | None = None
    for n, row in enumerate(rows[1:]):
        try:
            frame_no = float(row[frame_idx])
        except (IndexError, ValueError) as exc:
            raise InvalidTrajectoryError(f"{path}: row {n} bad frame value") from exc
        if frame0 is None:
            frame0 = frame_no
        kw: dict[str, float] = {}
        for i, field in col_field.items():
            if i < len(row) and row[i] != "":
                try:
                    kw[field] = float(row[i])
                except ValueError as exc:
                    raise InvalidTrajectoryError(f"{path}: row {n} bad value for {field}") from exc
        try:
            pose = CameraPose(**kw)
        except Exception as exc:
            raise InvalidTrajectoryError(f"{path}: row {n} invalid pose: {exc}") from exc
        frames.append(((frame_no - frame0) / rate, pose))
    return Track(rate=rate, camera=camera, frames=frames)
