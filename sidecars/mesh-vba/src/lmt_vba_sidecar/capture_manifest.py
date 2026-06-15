"""Capture manifest loader for the visual-branch reconstruct pipeline.

A capture_manifest.json describes all views captured for a single screen:
  - "charuco" method: each view has one or more images with visible ChArUco markers.
  - "structured-light" method: reserved for future; 'frames' field is preserved as-is.

The loader resolves all relative paths (intrinsics, pattern_meta, screen_mapping,
image paths) to absolute paths anchored at the manifest file's parent directory so
downstream code is location-independent.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ValidationError


class CaptureManifestError(Exception):
    """Raised for any load/validation failure of a capture manifest."""


class CaptureView(BaseModel):
    """One captured view: a camera position with its associated image(s).

    'frames' is reserved for structured-light sequences and is stored verbatim;
    it is not parsed or validated beyond JSON round-trip this release.
    """

    view_id: str
    images: list[str] = []
    # Structured-light reserved field — optional, not used this round.
    frames: list[dict] | None = None


class CaptureManifest(BaseModel):
    """Top-level capture manifest model."""

    method: Literal["charuco", "vpqsp", "structured-light"]
    # Camera intrinsics JSON path. Optional: when omitted, reconstruct must get
    # intrinsics another way — an `--intrinsics <path>` CLI override, or
    # `--intrinsics auto` self-calibration from the captured markers (vpqsp). A
    # null is preserved verbatim through load (not path-resolved).
    intrinsics: str | None = None
    pattern_meta: str
    screen_mapping: str
    views: list[CaptureView]


def _resolve(path: str, base: Path) -> str:
    """Return a normalized absolute path string.

    Relative paths are anchored at *base*; both branches run through resolve()
    so the two manifest entry points (load + from-dir) emit identical path forms
    (no leftover '..' segments).
    """
    p = Path(path)
    if p.is_absolute():
        return str(p.resolve())
    return str((base / p).resolve())


def load_capture_manifest(path: str) -> CaptureManifest:
    """Load and validate a capture manifest JSON file.

    Relative paths for intrinsics, pattern_meta, screen_mapping, and each
    view's images list are resolved to absolute paths anchored at the manifest's
    parent directory.  Image existence is NOT checked here; that is left to the
    reconstruct pipeline.

    Raises:
        CaptureManifestError: on missing file, invalid JSON, pydantic validation
            failure, empty views list, or a charuco view with neither images nor
            frames.
    """
    manifest_path = Path(path)

    # --- read raw JSON ---
    try:
        raw = manifest_path.read_text(encoding="utf-8")
    except FileNotFoundError:
        raise CaptureManifestError(f"Manifest file not found: {path}") from None
    except OSError as exc:
        raise CaptureManifestError(f"Cannot read manifest: {exc}") from exc

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise CaptureManifestError(f"Invalid JSON in manifest: {exc}") from exc

    # --- pydantic validation ---
    try:
        manifest = CaptureManifest.model_validate(data)
    except ValidationError as exc:
        raise CaptureManifestError(f"Manifest schema error: {exc}") from exc

    # --- semantic validation ---
    if len(manifest.views) == 0:
        raise CaptureManifestError("Manifest must have at least one view.")

    if manifest.method in ("charuco", "vpqsp"):
        for view in manifest.views:
            if not view.images and not view.frames:
                raise CaptureManifestError(
                    f"View '{view.view_id}' has no images and no frames."
                )

    # --- resolve relative paths to absolute ---
    base = manifest_path.parent
    # Preserve the "auto" self-calibration sentinel verbatim (vpqsp); only real
    # path references are absolutized.
    if manifest.intrinsics is not None and manifest.intrinsics != "auto":
        manifest.intrinsics = _resolve(manifest.intrinsics, base)
    manifest.pattern_meta = _resolve(manifest.pattern_meta, base)
    manifest.screen_mapping = _resolve(manifest.screen_mapping, base)

    for view in manifest.views:
        view.images = [_resolve(img, base) for img in view.images]
        # Preserve frames verbatim — resolve 'path' keys inside frames if present.
        if view.frames:
            resolved_frames = []
            for frame in view.frames:
                if "path" in frame and isinstance(frame["path"], str):
                    frame = {**frame, "path": _resolve(frame["path"], base)}
                resolved_frames.append(frame)
            view.frames = resolved_frames

    return manifest


def manifest_from_images_dir(
    images_dir: str,
    *,
    method: str,
    intrinsics: str,
    pattern_meta: str,
    screen_mapping: str,
) -> CaptureManifest:
    """Build a CaptureManifest from a flat image directory.

    Scans *images_dir* for *.png, *.jpg, *.jpeg files (case-insensitive, sorted
    by filename) and creates one view per image with view_id = file stem.
    All image paths in the returned manifest are absolute.

    This is the convenience path for the ``--images <dir>`` CLI flag.
    """
    image_dir = Path(images_dir).resolve()
    extensions = {".png", ".jpg", ".jpeg"}
    image_files = sorted(
        [f for f in image_dir.iterdir() if f.suffix.lower() in extensions],
        key=lambda f: f.name,
    )

    views = [
        CaptureView(view_id=f.stem, images=[str(f)])
        for f in image_files
    ]

    # Mirror the load path's empty-views rejection: a directory with no images
    # is an error, not a silently-valid zero-view manifest.
    if not views:
        raise CaptureManifestError(f"No image files found in {image_dir}")

    # Build the manifest dict and let pydantic validate it (catches bad method, etc.)
    try:
        return CaptureManifest(
            method=method,  # type: ignore[arg-type]
            intrinsics=intrinsics,
            pattern_meta=pattern_meta,
            screen_mapping=screen_mapping,
            views=views,
        )
    except ValidationError as exc:
        raise CaptureManifestError(f"manifest_from_images_dir validation error: {exc}") from exc
