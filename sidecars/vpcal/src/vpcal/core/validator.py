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
        raw_lens = raw_session.get("lens", {}) or {}
        raw_model = str(raw_lens.get("model", raw_lens.get("projection_model", ""))).lower()
        if "anamorphic" in raw_model or raw_lens.get("anamorphic_squeeze") is not None:
            raise PreconditionError(
                "anamorphic lens models are not supported by this calibration pipeline",
                details={"model": raw_model or "anamorphic"},
            )
        dist = raw_lens.get("distortion", {}) or {}
        bad = _UNSUPPORTED_DISTORTION_KEYS & dist.keys()
        if bad:
            raise PreconditionError(
                f"unsupported lens distortion parameters: {sorted(bad)}; "
                "Phase 1 supports Brown-Conrady k1,k2,k3,p1,p2 only",
                details={"unsupported": sorted(bad)},
            )
    if session.lens.image_domain == "unknown":
        warnings.append(
            "lens calibration pixel domain is unknown; parameters calibrated on a "
            "scaled monitor output can be systematically wrong in the delivery domain"
        )

    # 2. Referenced files exist.
    import json as _json

    images_dir = _resolve(session_dir, session.images.path)
    tracking_path = _resolve(session_dir, session.tracking.path)
    if not tracking_path.exists():
        raise ResourceNotFoundError(
            f"tracking file not found: {tracking_path}", details={"path": str(tracking_path)}
        )
    screen_paths = []
    for target in session.screen_targets:
        screen_path = _resolve(session_dir, target.path)
        if not screen_path.exists():
            raise ResourceNotFoundError(
                f"screen file not found: {screen_path}", details={"path": str(screen_path)}
            )
        screen_paths.append(screen_path)
    if session.marker_map is not None:
        # AR path (plan A2): load + geometric/degeneracy validation of the map.
        from vpcal.core.marker_map import validate_marker_map
        from vpcal.io.marker_map_io import load_marker_map

        marker_map_path = _resolve(session_dir, session.marker_map.path)
        marker_map = load_marker_map(marker_map_path)
        if session.marker_map.fingerprint:
            import hashlib

            actual = "sha256:" + hashlib.sha256(marker_map_path.read_bytes()).hexdigest()
            if actual != session.marker_map.fingerprint:
                warnings.append(
                    "session marker map fingerprint differs from the current workspace map; "
                    "the map may have been rebased or levelled after capture"
                )
            report["marker_map_fingerprint"] = {
                "captured": session.marker_map.fingerprint,
                "current": actual,
                "matches": actual == session.marker_map.fingerprint,
            }
        map_report = validate_marker_map(marker_map)
        warnings.extend(map_report.pop("warnings"))
        report["marker_map"] = map_report

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

    # Static-capture timing immunity is valid only when continuous samples from
    # each *capture window* prove negligible motion.  poses.jsonl contains one
    # mean pose per image, so adjacent records describe intentional moves
    # between poses and must never be used for this estimate.
    staticity = {"status": "unverifiable"}
    capture_meta_path = session_dir / "capture_meta.json"
    if capture_meta_path.exists():
        try:
            capture_meta = _json.loads(capture_meta_path.read_text(encoding="utf-8"))
            windows = (capture_meta.get("timings") or {}).get("poses") or []
            trans = [float(w["translation_p2p_mm"]) for w in windows
                     if w.get("translation_p2p_mm") is not None]
            rot = [float(w["rotation_p2p_deg"]) for w in windows
                   if w.get("rotation_p2p_deg") is not None]
        except (OSError, ValueError, TypeError, KeyError):
            trans, rot = [], []
        if trans and rot and len(trans) == len(rot) == len(windows):
            p95_mm = float(np.percentile(trans, 95))
            p95_deg = float(np.percentile(rot, 95))
            status = "verified" if p95_mm <= 1.0 and p95_deg <= 0.1 else "warning"
            staticity = {
                "status": status,
                "timing_delay_bound_ms": session.solver.timing_delay_bound_ms,
                "p95_translation_error_bound_mm": p95_mm,
                "p95_rotation_error_bound_deg": p95_deg,
            }
            if status == "warning":
                warnings.append(
                    "capture-window motion makes timing error non-negligible: "
                    f"p95 {p95_mm:.2f} mm / {p95_deg:.3f} deg "
                    "(limits 1.0 mm / 0.1 deg)"
                )
    report["staticity"] = staticity

    # FIZ constancy: a single-lens calibration session must not cross zoom or
    # focus states. FreeD values are raw encoder counts; tolerate two counts of
    # transport/encoder chatter and identify the affected frame interval.
    fiz_report = {}
    for field in ("zoom_raw", "focus_raw"):
        values = [(f.frame_id, getattr(f, field)) for f in frames
                  if getattr(f, field) is not None]
        if not values:
            continue
        baseline = values[0][1]
        changed = [fid for fid, value in values if abs(value - baseline) > 2]
        fiz_report[field] = {"min": min(v for _, v in values),
                             "max": max(v for _, v in values),
                             "constant": not changed, "deadband_counts": 2}
        if changed:
            warnings.append(
                f"FIZ {field} changed beyond 2 counts during frames "
                f"{min(changed)}-{max(changed)}; use a constant lens state or split the session"
            )
    if fiz_report:
        report["fiz_constancy"] = fiz_report

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

        screens = [load_screen(str(path)) for path in screen_paths]
    except Exception:
        screens = []
    if screens:
        if session.screens is None:
            report["processor_canvas"] = "1:1" if screens[0].processor is None else "declared"
        else:
            report["processor_canvas"] = {
                screen.name: "1:1" if screen.processor is None else "declared"
                for screen in screens
            }
        for screen in screens:
            for issue in check_screen_consistency(screen):
                prefix = "LED processor" if session.screens is None else f"LED processor ({screen.name})"
                warnings.append(f"{prefix}: {issue}")

    # 6c. LED processor mapping verification (architecture §3.3a, W9.1): a
    #     declared processor is a hard precondition for a real capture — a
    #     scale/offset in the input→physical canvas mapping silently corrupts
    #     the marker 3D lookup.  Scoped to screens that declare a processor
    #     (6b); screens with none are the Phase-1 direct-drive 1:1 assumption
    #     and see no behaviour change.  ``processor_verified=true`` opts out
    #     (self-attested, e.g. a fixed installation verified once out-of-band).
    processor_screens = [screen for screen in screens if screen.processor is not None]
    if processor_screens:
        pc = session.processor_check
        if pc is not None and pc.processor_verified:
            report["processor_mapping_verified"] = "skipped (processor_verified=true)"
        elif pc is not None and pc.mapping_image and pc.expected_width_px and pc.expected_height_px:
            from vpcal.core.mapping_verify import verify_mapping_image

            # The verification only certifies the canvas it was run at — a
            # pattern generated at some other resolution passing the check says
            # nothing about the declared processor input canvas.
            for screen in processor_screens:
                declared = (screen.processor.input_width_px, screen.processor.input_height_px)
                if (pc.expected_width_px, pc.expected_height_px) != declared:
                    raise PreconditionError(
                        f"processor_check canvas {pc.expected_width_px}x{pc.expected_height_px} "
                        f"does not match screen '{screen.name}' declared processor input canvas "
                        f"{declared[0]}x{declared[1]} — regenerate the mapping-verify "
                        "pattern at the declared resolution (`vpcal verify mapping --generate`)",
                        details={
                            "screen": screen.name,
                            "expected_width_px": pc.expected_width_px,
                            "expected_height_px": pc.expected_height_px,
                            "declared_input_width_px": declared[0],
                            "declared_input_height_px": declared[1],
                        },
                    )
            mapping_image = _resolve(session_dir, pc.mapping_image)
            mapping = verify_mapping_image(mapping_image, pc.expected_width_px, pc.expected_height_px)
            report["processor_mapping_verified"] = "checked"
            report["processor_mapping"] = {
                "scale_x": mapping.scale_x, "scale_y": mapping.scale_y,
                "offset_x_px": mapping.offset_x_px, "offset_y_px": mapping.offset_y_px,
            }
        else:
            raise PreconditionError(
                "screen declares a LED processor but its 1:1 canvas mapping is "
                "not verified: set processor_check.processor_verified=true (if "
                "already verified out-of-band) or processor_check.mapping_image "
                "+ expected_width_px/expected_height_px (see `vpcal verify mapping`)",
                details={"screens": [screen.name for screen in processor_screens]},
            )

    report["passed"] = True
    return report
