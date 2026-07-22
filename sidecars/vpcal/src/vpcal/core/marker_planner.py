"""Stage-level VP-QSP marker placement planner.

Decouples marker density from per-cabinet defaults: given selected screens and
an optional camera preview size, choose ``markers_per_cabinet`` (and report
placement priorities) so dual-screen framing can reach ≥60–100 decodable markers
with preference for image corners, screen perimeter, plane boundaries and depth
extremes.
"""

from __future__ import annotations

from dataclasses import dataclass

from vpcal.core.pattern import MAX_LOCAL
from vpcal.core.screen_geometry import section_grid
from vpcal.models.screen import ScreenDefinition


@dataclass(frozen=True)
class ScreenPlacementPlan:
    label: str
    screen_id: int
    cab_col_offset: int
    markers_per_cabinet: int
    estimated_markers: int
    notes: list[str]


@dataclass(frozen=True)
class StageMarkerPlan:
    screens: list[ScreenPlacementPlan]
    total_estimated_markers: int
    target_total: int
    formal_min_total: int = 60


def _cabinet_count(screen: ScreenDefinition) -> int:
    total = 0
    for section in screen.sections:
        n_rows, n_cols = section_grid(screen, section)
        total += n_rows * n_cols
    return max(total, 1)


def plan_markers_per_cabinet(
    screens: list[tuple[str, ScreenDefinition, int, int]],
    *,
    target_total: int = 100,
    formal_min_total: int = 60,
    preview_size: tuple[int, int] | None = None,
) -> StageMarkerPlan:
    """Choose per-screen ``markers_per_cabinet`` to hit density targets.

    ``screens`` entries are ``(label, screen, screen_id, cab_col_offset)``.
    """
    if not screens:
        return StageMarkerPlan(screens=[], total_estimated_markers=0, target_total=target_total)

    # Start from each screen's stored mpc, then raise uniformly until target.
    plans: list[ScreenPlacementPlan] = []
    mpc_values = [max(1, int(s.markers_per_cabinet)) for _, s, _, _ in screens]
    cab_counts = [_cabinet_count(s) for _, s, _, _ in screens]

    def estimate(mpcs: list[int]) -> int:
        return int(sum(c * m for c, m in zip(cab_counts, mpcs)))

    # Raise densest-needed screens first (fewest cabinets).
    order = sorted(range(len(screens)), key=lambda i: cab_counts[i])
    total = estimate(mpc_values)
    while total < target_total:
        progressed = False
        for i in order:
            if mpc_values[i] >= MAX_LOCAL + 1:
                continue
            # Prefer perfect squares / legacy 1,4 then grow
            nxt = mpc_values[i] + 1
            if mpc_values[i] < 4:
                nxt = 4 if mpc_values[i] == 1 else min(4, mpc_values[i] + 1)
            mpc_values[i] = min(nxt, MAX_LOCAL + 1)
            progressed = True
            total = estimate(mpc_values)
            if total >= target_total:
                break
        if not progressed:
            break

    for (label, _screen, screen_id, offset), mpc, cabs in zip(
        screens, mpc_values, cab_counts
    ):
        notes: list[str] = [
            "prefer_corners_perimeter_depth_extremes",
            "reject_seam_crop_bezel_truncation",
        ]
        if preview_size is not None:
            notes.append(f"preview={preview_size[0]}x{preview_size[1]}")
        plans.append(
            ScreenPlacementPlan(
                label=label,
                screen_id=screen_id,
                cab_col_offset=offset,
                markers_per_cabinet=mpc,
                estimated_markers=cabs * mpc,
                notes=notes,
            )
        )

    total_est = sum(p.estimated_markers for p in plans)
    return StageMarkerPlan(
        screens=plans,
        total_estimated_markers=total_est,
        target_total=target_total,
        formal_min_total=formal_min_total,
    )


def plan_to_dict(plan: StageMarkerPlan) -> dict:
    return {
        "target_total": plan.target_total,
        "formal_min_total": plan.formal_min_total,
        "total_estimated_markers": plan.total_estimated_markers,
        "meets_formal_min": plan.total_estimated_markers >= plan.formal_min_total,
        "screens": [
            {
                "label": s.label,
                "screen_id": s.screen_id,
                "cab_col_offset": s.cab_col_offset,
                "markers_per_cabinet": s.markers_per_cabinet,
                "estimated_markers": s.estimated_markers,
                "notes": s.notes,
            }
            for s in plan.screens
        ],
    }
