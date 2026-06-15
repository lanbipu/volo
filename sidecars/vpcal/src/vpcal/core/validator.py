"""Stage 0 input validation (spec §3.1 / §3.6).

Runs before detection/solve: checks files exist, the lens model is supported,
images align to tracking records, tracking is sane, and pose diversity is
adequate.  Hard failures raise (exit 5 / 6); soft issues become warnings in the
returned report.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

from vpcal.core.errors import ConfigError, PreconditionError, ResourceNotFoundError
from vpcal.core.transforms import quat_to_matrix
from vpcal.io.frame_matching import match_frames, parse_frame_number
from vpcal.io.tracking_io import load_tracking, to_internal_poses
from vpcal.models.session import SessionConfig

_SUPPORTED_DISTORTION_KEYS = {"model", "k1", "k2", "k3", "p1", "p2"}
_UNSUPPORTED_DISTORTION_KEYS = {"k4", "k5", "k6"}
_POSITION_LIMIT_MM = 1_000_000.0  # 1 km sanity bound
_JUMP_LIMIT_MM = 5_000.0  # per-frame translation jump warning threshold

_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp"}


def _resolve(session_dir: Path, path: str) -> Path:
    p = Path(path)
    return p if p.is_absolute() else (session_dir / p)


def list_images(images_dir: Path) -> list[str]:
    """Return sorted image file paths under a directory (recursively, normal/ first)."""
    if not images_dir.exists():
        return []
    files = [
        str(p)
        for p in sorted(images_dir.rglob("*"))
        if p.suffix.lower() in _IMAGE_EXTS and "inverted" not in p.parts
    ]
    return files


def validate_session(
    session: SessionConfig,
    session_dir: str | Path,
    *,
    raw_session: dict | None = None,
) -> dict:
    """Validate a session and its referenced files; return a validation report."""
    session_dir = Path(session_dir)
    warnings: list[str] = []
    report: dict = {"passed": False, "warnings": warnings}

    # 0. capture_mode: only 'legacy' is implemented; 'dual_frame' is a reserved
    #    schema value — reject explicitly rather than silently ignoring it (D2).
    if session.capture_mode != "legacy":
        raise ConfigError(
            f"capture_mode={session.capture_mode!r} is reserved and not implemented; "
            "use 'legacy'",
            details={"capture_mode": session.capture_mode},
        )

    # 1. Lens model support (k4/k5/k6 → hard error).
    if raw_session is not None:
        dist = (raw_session.get("lens", {}) or {}).get("distortion", {}) or {}
        bad = _UNSUPPORTED_DISTORTION_KEYS & dist.keys()
        if bad:
            raise PreconditionError(
                f"unsupported lens distortion parameters: {sorted(bad)}; "
                "Phase 1 supports Brown-Conrady k1,k2,k3,p1,p2 only",
                details={"unsupported": sorted(bad)},
            )

    # 2. Referenced files exist.
    import json as _json

    images_dir = _resolve(session_dir, session.images.path)
    tracking_path = _resolve(session_dir, session.tracking.path)
    screen_path = _resolve(session_dir, session.screen.path)
    for label, p in [("tracking", tracking_path), ("screen", screen_path)]:
        if not p.exists():
            raise ResourceNotFoundError(f"{label} file not found: {p}", details={"path": str(p)})

    exact_obs = session_dir / "observations.jsonl"
    frames = load_tracking(tracking_path)
    report["tracking_count"] = len(frames)
    frame_ids = [f.frame_id for f in frames]
    images = list_images(images_dir) if images_dir.exists() else []
    report["image_count"] = len(images)

    # 3. Frame alignment — via images, or via the exact-observations sidecar
    #    (synthetic datasets generated with --no-images).
    if not images and exact_obs.exists():
        obs_frames = {
            _json.loads(ln)["frame_id"]
            for ln in exact_obs.read_text().splitlines()
            if ln.strip()
        }
        matched = len(obs_frames & set(frame_ids))
        report["matched"] = matched
        report["detection_source"] = "exact"
        if matched < 3:
            raise PreconditionError(
                f"only {matched} observation-tracking matches; need >= 3",
                details={"matched": matched},
            )
    else:
        if not images_dir.exists():
            raise ResourceNotFoundError(
                f"images directory not found: {images_dir}", details={"path": str(images_dir)}
            )
        if session.tracking.frame_matching == "timestamp":
            raise PreconditionError(
                "frame_matching='timestamp' needs per-image timestamps (EXIF), which "
                "Phase 1 cannot extract offline; use 'frame_id' or 'line_number'",
                details={"frame_matching": "timestamp"},
            )
        match = match_frames(
            images, frame_ids,
            strategy=session.tracking.frame_matching,
            timestamp_tolerance_s=session.tracking.timestamp_tolerance_s,
        )
        report["matched"] = len(match.matched)
        report["unmatched_images"] = match.unmatched_images
        report["unused_tracking"] = match.unused_tracking
        if match.unmatched_images:
            warnings.append(f"{len(match.unmatched_images)} image(s) had no matching tracking record")
        if match.unused_tracking:
            warnings.append(f"{len(match.unused_tracking)} tracking record(s) had no matching image")
        if len(match.matched) < 3:
            raise PreconditionError(
                f"only {len(match.matched)} image-tracking matches; need >= 3",
                details={"matched": len(match.matched)},
            )

    # 4. Tracking sanity: finite, bounded, no wild jumps.
    positions = np.array([f.position for f in frames], dtype=np.float64)
    if not np.all(np.isfinite(positions)):
        raise PreconditionError("tracking positions contain non-finite values")
    if np.any(np.abs(positions) > _POSITION_LIMIT_MM):
        warnings.append("some tracking positions exceed 1 km from origin (check units)")
    if len(positions) > 1:
        jumps = np.linalg.norm(np.diff(positions, axis=0), axis=1)
        if np.any(jumps > _JUMP_LIMIT_MM):
            warnings.append(
                f"large frame-to-frame position jumps detected (max {jumps.max():.0f} mm)"
            )

    # 5. Pose diversity (spatial + angular spread).
    poses = to_internal_poses(frames, session.tracking.coordinate_system, session.tracking.custom_transform)
    pts = np.array([t for (_q, t) in poses.values()])
    spatial_spread = float(np.linalg.norm(pts.max(axis=0) - pts.min(axis=0))) if len(pts) else 0.0
    forwards = []
    for q, _t in poses.values():
        forwards.append(quat_to_matrix(q)[:, 0])  # body X axis as a pointing proxy
    forwards = np.array(forwards)
    angular_spread_deg = 0.0
    if len(forwards) > 1:
        cos = np.clip(forwards @ forwards.mean(axis=0) / (np.linalg.norm(forwards.mean(axis=0)) or 1.0), -1, 1)
        angular_spread_deg = float(np.degrees(np.arccos(cos.min())))
    report["spatial_spread_mm"] = spatial_spread
    report["angular_spread_deg"] = angular_spread_deg
    if report["matched"] < 6:
        warnings.append(f"only {report['matched']} poses; result confidence will be very_low (< 6)")
    if spatial_spread < 500.0:
        warnings.append("low spatial spread of poses (< 0.5 m); add more varied positions")

    # 6. Screen sanity.
    bad_frame_ids = [img for img in images if parse_frame_number(img) is None]
    if bad_frame_ids and session.tracking.frame_matching == "frame_id":
        warnings.append(f"{len(bad_frame_ids)} image filename(s) have no parseable frame number")

    # 6b. LED processor canvas consistency (C0): a declared non-1:1 mapping (or one
    #     that disagrees with the wall geometry) is surfaced before the solve.
    #     Best-effort — a screen that does not parse as a ScreenDefinition (e.g. an
    #     OBJ mesh) is left to surface at its own stage, not turned into a validate
    #     failure here.
    try:
        from vpcal.core.processor_check import check_screen_consistency
        from vpcal.io.screen_io import load_screen

        screen = load_screen(str(screen_path))
    except Exception:
        screen = None
    if screen is not None:
        report["processor_canvas"] = "1:1" if screen.processor is None else "declared"
        for issue in check_screen_consistency(screen):
            warnings.append(f"LED processor: {issue}")

    report["passed"] = True
    return report
