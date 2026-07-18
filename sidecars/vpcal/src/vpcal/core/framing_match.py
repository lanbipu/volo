"""Framing-guidance match score (topology / coverage level, not pixel align).

Used by the stills capture window: hit-rate of expected cabinets vs observed,
plus a coarse bbox-area ratio term. Hysteresis avoids green/red flicker.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Sequence

Cabinet = tuple[int, int]  # (col, row)
BBox = Sequence[float]  # [x0, y0, x1, y1] normalized 0..1

HIT_WEIGHT = 0.75
BBOX_WEIGHT = 0.25
MATCH_ENTER = 80.0
MATCH_EXIT = 70.0


def cabinets_norm_bbox(
    cabinets: Iterable[Cabinet],
    cols: int,
    rows: int,
) -> list[float] | None:
    """Axis-aligned bbox of cabinets in normalized screen UV (0..1)."""
    cols = max(1, int(cols))
    rows = max(1, int(rows))
    items = list(cabinets)
    if not items:
        return None
    c0 = min(c for c, _r in items)
    c1 = max(c for c, _r in items)
    r0 = min(r for _c, r in items)
    r1 = max(r for _c, r in items)
    return [c0 / cols, r0 / rows, (c1 + 1) / cols, (r1 + 1) / rows]


def _area(bbox: BBox | None) -> float:
    if not bbox or len(bbox) < 4:
        return 0.0
    return max(0.0, float(bbox[2]) - float(bbox[0])) * max(
        0.0, float(bbox[3]) - float(bbox[1])
    )


def compute_framing_score(
    expected: Iterable[Cabinet],
    observed: Iterable[Cabinet],
    *,
    expected_bbox: BBox | None = None,
    observed_bbox: BBox | None = None,
) -> float:
    """Return match percent 0..100 (topology hit-rate + bbox area tolerance)."""
    exp = {(int(c), int(r)) for c, r in expected}
    obs = {(int(c), int(r)) for c, r in observed}
    if not exp:
        hit = 1.0 if not obs else 0.0
    else:
        hit = len(exp & obs) / len(exp)

    ea = _area(expected_bbox)
    oa = _area(observed_bbox)
    if ea > 1e-9 and oa > 1e-9:
        ratio = oa / ea
        if 0.6 <= ratio <= 1.5:
            bbox_s = 1.0
        else:
            # Decay outside the tolerance band (log-space, ~3× → 0).
            bbox_s = max(0.0, 1.0 - abs(math.log(ratio)) / math.log(3.0))
    else:
        bbox_s = hit

    return round(100.0 * (HIT_WEIGHT * hit + BBOX_WEIGHT * bbox_s), 2)


def apply_match_hysteresis(
    score: float,
    matched: bool,
    *,
    enter: float = MATCH_ENTER,
    exit_: float = MATCH_EXIT,
) -> bool:
    """Enter green at ``enter``, leave below ``exit_`` (default 80 / 70)."""
    if matched:
        return float(score) >= float(exit_)
    return float(score) >= float(enter)


def missing_cabinets_hint(
    expected: Iterable[Cabinet],
    observed: Iterable[Cabinet],
) -> str:
    """Short Chinese hint listing missing expected cabinets."""
    exp = {(int(c), int(r)) for c, r in expected}
    obs = {(int(c), int(r)) for c, r in observed}
    miss = sorted(exp - obs)
    if not miss:
        return "匹配达标 · 画面稳定即自动拍摄"
    sample = ", ".join(f"{c}×{r}" for c, r in miss[:3])
    more = f" 等 {len(miss)} 个" if len(miss) > 3 else f" · 共 {len(miss)} 个"
    return f"还差箱体 {sample}{more}"


def summarize_detections(dets, image_shape) -> dict:
    """Build detect_state extras from ``detect_markers`` output.

    Returns ``{count, cabinets: [[screen_id,col,row],...], bbox_frac}``.
    """
    from vpcal.core.observations import MarkerId

    cabinets: list[list[int]] = []
    seen: set[tuple[int, int, int]] = set()
    us: list[float] = []
    vs: list[float] = []
    for d in dets:
        mid = d.marker_id
        if isinstance(mid, MarkerId):
            key = (mid.screen_id, mid.cab_col, mid.cab_row)
            if key not in seen:
                seen.add(key)
                cabinets.append([mid.screen_id, mid.cab_col, mid.cab_row])
        us.append(float(d.pixel_u))
        vs.append(float(d.pixel_v))
    h = int(image_shape[0]) if image_shape is not None else 0
    w = int(image_shape[1]) if image_shape is not None and len(image_shape) > 1 else 0
    bbox_frac = None
    if us and w > 0 and h > 0:
        # Quantize so 1px jitter does not defeat detect_state emit dedup.
        bbox_frac = [
            round(max(0.0, min(us) / w), 3),
            round(max(0.0, min(vs) / h), 3),
            round(min(1.0, max(us) / w), 3),
            round(min(1.0, max(vs) / h), 3),
        ]
    return {"count": len(dets), "cabinets": cabinets, "bbox_frac": bbox_frac}
