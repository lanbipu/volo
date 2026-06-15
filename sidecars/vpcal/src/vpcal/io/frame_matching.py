"""Image <-> tracking frame alignment strategies (spec §3.6).

Each captured image must map to exactly one tracking record. Three strategies
are supported, selected by a string:

- ``"frame_id"`` (default): the trailing integer in the image filename stem
  equals the tracking record's ``frame_id`` field.
- ``"line_number"``: the Nth tracking record (0-based) matches the Nth image
  after sorting image filenames in natural (numeric-aware) order.
- ``"timestamp"``: each image's timestamp is matched to the nearest tracking
  ``timestamp_s`` within a tolerance (default 0.05s).

The matcher reports soft cases (unmatched images, unused tracking records)
rather than raising. The caller decides hard-fail policy (e.g. matched < 3).
"""

from __future__ import annotations

import os
import re
import warnings
from dataclasses import dataclass

__all__ = [
    "FrameMatch",
    "MatchReport",
    "parse_frame_number",
    "match_frames",
]

_DIGITS_RE = re.compile(r"\d+")
_NATURAL_SPLIT_RE = re.compile(r"(\d+)")


@dataclass
class FrameMatch:
    """One image paired with exactly one tracking record."""

    image: str          # image filename or path (as given)
    tracking_index: int  # index into the tracking list


@dataclass
class MatchReport:
    """Result of aligning images against tracking records."""

    matched: list[FrameMatch]
    unmatched_images: list[str]
    unused_tracking: list[int]


def parse_frame_number(filename: str) -> int | None:
    """Extract the trailing integer from a filename stem.

    Uses the LAST run of digits found in the basename stem (the basename with
    its final extension removed). Returns ``None`` if no integer is present.

    Examples:
        ``"captures/normal/0012.png"`` -> ``12``
        ``"frame_12.PNG"`` -> ``12``
        ``"img_2_5.png"`` -> ``5``
        ``"abc.png"`` -> ``None``
    """
    stem = os.path.splitext(os.path.basename(filename))[0]
    matches = _DIGITS_RE.findall(stem)
    if not matches:
        return None
    return int(matches[-1])


def match_frames(
    images: list[str],
    tracking_frame_ids: list[int],
    *,
    strategy: str = "frame_id",
    image_timestamps: list[float] | None = None,
    tracking_timestamps: list[float] | None = None,
    timestamp_tolerance_s: float = 0.05,
) -> MatchReport:
    """Align ``images`` to tracking records, returning a structured report.

    ``tracking_frame_ids`` carries the per-record ``frame_id`` values; its
    length defines the number of tracking records (indices ``0..N-1``). For the
    ``line_number`` strategy only the length matters.

    Args:
        images: image filenames or paths (as given, any order).
        tracking_frame_ids: ``frame_id`` of each tracking record, in record order.
        strategy: one of ``"frame_id"``, ``"line_number"``, ``"timestamp"``.
        image_timestamps: per-image timestamps (seconds); required for
            ``"timestamp"``, must align positionally with ``images``.
        tracking_timestamps: per-record timestamps (seconds); required for
            ``"timestamp"``, must align positionally with ``tracking_frame_ids``.
        timestamp_tolerance_s: max allowed |Δt| for a timestamp match.

    Returns:
        MatchReport with matched pairs, unmatched images, unused tracking indices.

    Raises:
        ValueError: unknown strategy, or missing timestamp arrays for
            ``"timestamp"``.
    """
    if strategy == "frame_id":
        return _match_frame_id(images, tracking_frame_ids)
    if strategy == "line_number":
        return _match_line_number(images, tracking_frame_ids)
    if strategy == "timestamp":
        return _match_timestamp(
            images,
            tracking_frame_ids,
            image_timestamps,
            tracking_timestamps,
            timestamp_tolerance_s,
        )
    raise ValueError(
        f"unknown frame_matching strategy: {strategy!r} "
        "(expected 'frame_id', 'line_number', or 'timestamp')"
    )


def _match_frame_id(
    images: list[str],
    tracking_frame_ids: list[int],
) -> MatchReport:
    # Build frame_id -> index. Duplicate frame_ids: first occurrence is canonical.
    by_frame_id: dict[int, int] = {}
    for index, frame_id in enumerate(tracking_frame_ids):
        by_frame_id.setdefault(frame_id, index)

    matched: list[FrameMatch] = []
    unmatched_images: list[str] = []
    used: set[int] = set()

    for image in images:
        number = parse_frame_number(image)
        if number is None or number not in by_frame_id:
            unmatched_images.append(image)
            continue
        index = by_frame_id[number]
        matched.append(FrameMatch(image=image, tracking_index=index))
        used.add(index)

    unused_tracking = [i for i in range(len(tracking_frame_ids)) if i not in used]
    return MatchReport(matched, unmatched_images, unused_tracking)


def _natural_key(path: str) -> list:
    """Sort key treating digit runs numerically (``img2`` < ``img10``)."""
    stem = os.path.basename(path)
    return [int(seg) if seg.isdigit() else seg for seg in _NATURAL_SPLIT_RE.split(stem)]


def _match_line_number(
    images: list[str],
    tracking_frame_ids: list[int],
) -> MatchReport:
    # Natural sort: lexicographic order mispairs un-zero-padded names
    # ("img10.png" < "img2.png"), silently shifting every match after the
    # mismatch (D5).  Warn when the two orders differ so the user knows the
    # filenames are not zero-padded.
    sorted_images = sorted(images, key=_natural_key)
    if sorted_images != sorted(images):
        warnings.warn(
            "image filenames are not zero-padded; line_number matching uses "
            "natural (numeric) sort order",
            stacklevel=3,
        )
    n_tracking = len(tracking_frame_ids)
    n_pairs = min(len(sorted_images), n_tracking)

    matched = [
        FrameMatch(image=sorted_images[i], tracking_index=i) for i in range(n_pairs)
    ]
    unmatched_images = list(sorted_images[n_pairs:])
    unused_tracking = list(range(n_pairs, n_tracking))
    return MatchReport(matched, unmatched_images, unused_tracking)


def _match_timestamp(
    images: list[str],
    tracking_frame_ids: list[int],
    image_timestamps: list[float] | None,
    tracking_timestamps: list[float] | None,
    tolerance_s: float,
) -> MatchReport:
    if image_timestamps is None or tracking_timestamps is None:
        raise ValueError(
            "timestamp strategy requires both image_timestamps and "
            "tracking_timestamps"
        )
    if len(image_timestamps) != len(images):
        raise ValueError(
            "image_timestamps length must match images length "
            f"({len(image_timestamps)} != {len(images)})"
        )
    if len(tracking_timestamps) != len(tracking_frame_ids):
        raise ValueError(
            "tracking_timestamps length must match tracking_frame_ids length "
            f"({len(tracking_timestamps)} != {len(tracking_frame_ids)})"
        )

    matched: list[FrameMatch] = []
    unmatched_images: list[str] = []
    used: set[int] = set()

    # Greedy nearest-neighbour in input order: each tracking record taken once.
    for image, image_ts in zip(images, image_timestamps):
        best_index: int | None = None
        best_delta: float | None = None
        for index, track_ts in enumerate(tracking_timestamps):
            if index in used:
                continue
            delta = abs(image_ts - track_ts)
            if delta > tolerance_s:
                continue
            if best_delta is None or delta < best_delta:
                best_delta = delta
                best_index = index
        if best_index is None:
            unmatched_images.append(image)
            continue
        used.add(best_index)
        matched.append(FrameMatch(image=image, tracking_index=best_index))

    unused_tracking = [i for i in range(len(tracking_frame_ids)) if i not in used]
    return MatchReport(matched, unmatched_images, unused_tracking)
