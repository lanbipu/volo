"""Verification overlay — AR-mode "所见即所校" (plan Phase D).

Reprojects the marker map (or screen marker field) through a solved
calibration and draws it over the capture frames: detected position = green
cross, reprojected position = red circle, connecting line labelled with the
pixel error.  Output: annotated PNGs + a per-marker error table.  This is the
eyes-on acceptance tool for non-algorithm crew and the daily-check payload
(pair with ``vpcal report diff`` for drift).

CJK annotation: labels are drawn with Pillow using a system CJK sans font
(PingFang / Noto Sans CJK / Source Han Sans / Microsoft YaHei — no negative
letter-spacing, sans only, per the house CJK typography rules).  When no CJK
font is found the labels fall back to English via cv2 so the tool still runs
headless.
"""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
from numpy.typing import NDArray

from vpcal.core.errors import PreconditionError
from vpcal.core.projection import CameraIntrinsics, project_point
from vpcal.core.transforms import make_transform, stage_to_camera_transform
from vpcal.io.frame_matching import match_frames
from vpcal.io.tracking_io import load_tracking, to_internal_pose
from vpcal.models.lens import effective_lens
from vpcal.models.session import SessionConfig

Array = NDArray[np.float64]

_GREEN = (60, 200, 60)
_RED = (60, 60, 230)
_CJK_FONT_CANDIDATES = [
    "/System/Library/Fonts/PingFang.ttc",                       # macOS
    "/System/Library/Fonts/STHeiti Light.ttc",                  # macOS fallback
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",   # Linux
    "/usr/share/fonts/opentype/source-han-sans/SourceHanSansSC-Regular.otf",
    "C:/Windows/Fonts/msyh.ttc",                                # Windows
]


def _load_cjk_font(size: int):
    """Best-effort CJK sans font via Pillow; None → cv2/English fallback."""
    try:
        from PIL import ImageFont
    except ImportError:
        return None
    for path in _CJK_FONT_CANDIDATES:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size=size)
            except OSError:
                continue
    return None


def _draw_labels(
    image_bgr: NDArray[np.uint8], labels: list[tuple[str, tuple[int, int], tuple[int, int, int]]]
) -> NDArray[np.uint8]:
    """Draw text labels; CJK via Pillow when a font is available, else cv2.

    ``labels`` items are ``(text, (x, y), bgr_color)``.
    """
    font = _load_cjk_font(20)
    if font is not None:
        from PIL import Image, ImageDraw

        pil = Image.fromarray(cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB))
        draw = ImageDraw.Draw(pil)
        for text, (x, y), bgr in labels:
            draw.text((x, y), text, font=font, fill=(bgr[2], bgr[1], bgr[0]))
        return cv2.cvtColor(np.asarray(pil), cv2.COLOR_RGB2BGR)
    for text, (x, y), bgr in labels:
        # Hershey fonts carry no CJK glyphs: swap the CJK legend for its
        # English counterpart instead of ascii-stripping it into fragments.
        if text == _LEGEND_CJK:
            text = _LEGEND_ASCII
        cv2.putText(image_bgr, text, (x, y + 16), cv2.FONT_HERSHEY_SIMPLEX, 0.55, bgr, 1, cv2.LINE_AA)
    return image_bgr


_LEGEND_CJK = "绿十字 = 检测位置 · 红圈 = 重投影位置 · 连线标注像素误差"
_LEGEND_ASCII = "green cross = detected, red circle = reprojected, line = px error"


def _detections_for_image(session: SessionConfig, marker_map, img: NDArray[np.uint8], frame_id: int):
    """Detect markers in one grayscale frame (marker-map or VP-QSP path)."""
    if marker_map is not None:
        from vpcal.core.detector_physical import detect_physical_markers

        dets, _counters = detect_physical_markers(img, marker_map, frame_id=frame_id)
        return dets
    from vpcal.core.detector import detect_markers

    return [d for d in detect_markers(img, frame_id=frame_id) if d.confidence >= 1.0]


def overlay_session(
    session: SessionConfig,
    session_dir: Path,
    result: dict,
    out_dir: Path | None,
    *,
    limit: int | None = None,
) -> dict:
    """Run the verification overlay; returns the error table summary.

    Precondition: a completed spatial calibration ``result`` (T_S_from_O +
    T_C_from_B) — without it the reprojection is meaningless.
    """
    for key in ("tracker_to_stage", "tracker_to_camera"):
        if key not in result:
            raise PreconditionError(
                f"result.json lacks {key!r} — run `vpcal quick run` first",
                details={"missing": key},
            )
    t2s = result["tracker_to_stage"]
    c2t = result["tracker_to_camera"]
    T_S = make_transform(np.asarray(t2s["rotation"]), np.asarray(t2s["translation"]))
    T_C = make_transform(np.asarray(c2t["rotation"]), np.asarray(c2t["translation"]))
    # A QLE result was solved with result.quality.lens_estimate, not the
    # nominal session lens — overlaying through the nominal lens would show
    # phantom reprojection error on a correct calibration.
    lens_estimate = (result.get("quality") or {}).get("lens_estimate")
    lens = effective_lens(session.lens, lens_estimate) if lens_estimate else session.lens
    intr = CameraIntrinsics.from_lens(lens)

    marker_map = None
    if session.marker_map is not None:
        from vpcal.core.marker_map import physical_world_map
        from vpcal.io.marker_map_io import load_marker_map

        marker_map = load_marker_map(_resolve(session_dir, session.marker_map.path))
        world_map = physical_world_map(marker_map)
    else:
        from vpcal.core.pipeline import _M_UE
        from vpcal.core.session_targets import combined_world_map, load_screen_targets

        targets = load_screen_targets(session, session_dir)
        world_map, _ = combined_world_map(targets, transform=lambda point: _M_UE @ point)

    from vpcal.core.validator import list_images

    images = list_images(_resolve(session_dir, session.images.path))
    frames = load_tracking(_resolve(session_dir, session.tracking.path))
    if not images:
        raise PreconditionError(
            "no capture images found — the overlay needs frames to draw on",
            details={"images_dir": str(_resolve(session_dir, session.images.path))},
        )
    match = match_frames(
        images, [f.frame_id for f in frames],
        strategy=session.tracking.frame_matching,
        timestamp_tolerance_s=session.tracking.timestamp_tolerance_s,
    )
    if out_dir is not None:
        out_dir.mkdir(parents=True, exist_ok=True)

    per_marker: dict[str, list[float]] = {}
    frame_rows: list[dict] = []
    annotated: list[str] = []
    all_errors: list[float] = []
    for fm in match.matched[: limit if limit is not None else None]:
        frame = frames[fm.tracking_index]
        gray = cv2.imread(fm.image, cv2.IMREAD_GRAYSCALE)
        if gray is None:
            continue
        q, t = to_internal_pose(
            frame, session.tracking.coordinate_system, session.tracking.custom_transform
        )
        T_sdk = make_transform(q, t)
        T_C_from_S = stage_to_camera_transform(T_S, T_sdk, T_C)

        canvas = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
        labels: list[tuple[str, tuple[int, int], tuple[int, int, int]]] = [
            (_LEGEND_CJK, (12, 8), (235, 235, 235))
        ]
        frame_errors: list[float] = []
        for det in _detections_for_image(session, marker_map, gray, frame.frame_id):
            world = world_map.get(det.marker_id)
            if world is None:
                continue
            cam = T_C_from_S[:3, :3] @ np.asarray(world) + T_C_from_S[:3, 3]
            if cam[2] <= 1.0:
                continue
            pred = project_point(cam, intr)
            du, dv = int(round(det.pixel_u)), int(round(det.pixel_v))
            pu, pv = int(round(pred[0])), int(round(pred[1]))
            err = float(np.hypot(pred[0] - det.pixel_u, pred[1] - det.pixel_v))
            cv2.drawMarker(canvas, (du, dv), _GREEN, cv2.MARKER_CROSS, 14, 2)
            cv2.circle(canvas, (pu, pv), 7, _RED, 2)
            cv2.line(canvas, (du, dv), (pu, pv), (0, 200, 255), 1)
            labels.append((f"{err:.1f}px", (pu + 8, pv + 4), (0, 200, 255)))
            key = getattr(det.marker_id, "marker", None) or str(det.marker_id.to_dict())
            per_marker.setdefault(key, []).append(err)
            frame_errors.append(err)
            all_errors.append(err)
        canvas = _draw_labels(canvas, labels)
        if out_dir is not None:
            out_path = out_dir / (Path(fm.image).stem + "_overlay.png")
            cv2.imwrite(str(out_path), canvas)
            annotated.append(str(out_path))
        frame_rows.append(
            {
                "frame_id": frame.frame_id,
                "image": fm.image,
                "num_markers": len(frame_errors),
                "rms_px": float(np.sqrt(np.mean(np.square(frame_errors)))) if frame_errors else None,
                "max_px": float(np.max(frame_errors)) if frame_errors else None,
            }
        )

    if not all_errors:
        raise PreconditionError(
            "no marker was both detected and found in the truth source — "
            "nothing to overlay",
            details={"frames_processed": len(frame_rows)},
        )
    table = [
        {
            "marker_id": key,
            "count": len(errs),
            "mean_px": float(np.mean(errs)),
            "max_px": float(np.max(errs)),
        }
        for key, errs in sorted(per_marker.items())
    ]
    return {
        "global_rms_px": float(np.sqrt(np.mean(np.square(all_errors)))),
        "global_max_px": float(np.max(all_errors)),
        "num_frames": len(frame_rows),
        "num_observations": len(all_errors),
        "per_marker": table,
        "per_frame": frame_rows,
        "annotated_images": annotated,
        "legend": _LEGEND_CJK if _load_cjk_font(20) else _LEGEND_ASCII,
    }


def _resolve(session_dir: Path, p: str) -> Path:
    path = Path(p)
    return path if path.is_absolute() else session_dir / path
