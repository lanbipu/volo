"""Shared multi-screen VP-QSP target loading and marker-map construction."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import numpy as np
from numpy.typing import NDArray

from vpcal.core.errors import PreconditionError
from vpcal.core.observations import MarkerId
from vpcal.core.screen_geometry import enumerate_markers
from vpcal.io.screen_io import load_screen
from vpcal.models.screen import ScreenDefinition
from vpcal.models.session import ScreenConfig, SessionConfig


@dataclass(frozen=True)
class LoadedScreenTarget:
    config: ScreenConfig
    screen: ScreenDefinition

    @property
    def label(self) -> str:
        return self.config.id or self.screen.name


def resolve_path(session_dir: Path, raw: str) -> Path:
    path = Path(raw)
    return path if path.is_absolute() else session_dir / path


def load_screen_targets(session: SessionConfig, session_dir: Path) -> list[LoadedScreenTarget]:
    return [
        LoadedScreenTarget(config=target, screen=load_screen(resolve_path(session_dir, target.path)))
        for target in session.screen_targets
    ]


def combined_world_map(
    targets: list[LoadedScreenTarget],
    *,
    transform: Callable[[NDArray[np.float64]], NDArray[np.float64]] | None = None,
) -> tuple[dict[MarkerId, NDArray[np.float64]], dict[str, set[MarkerId]]]:
    """Build one Stage world map; individual targets may be absent per frame."""
    world: dict[MarkerId, NDArray[np.float64]] = {}
    marker_ids_by_target: dict[str, set[MarkerId]] = {}
    for target in targets:
        markers = enumerate_markers(
            target.screen,
            markers_per_cabinet=target.screen.markers_per_cabinet,
            screen_id=target.config.screen_id,
            cab_col_offset=target.config.cab_col_offset,
        )
        current = {
            marker.marker_id: np.asarray(marker.world, dtype=np.float64)
            for marker in markers
        }
        collisions = set(current).intersection(world)
        if collisions:
            sample = next(iter(collisions))
            raise PreconditionError(
                "multi-screen marker identity collision; screen_id/cab_col_offset assignments "
                "must be unique",
                details={"target": target.label, "marker_id": str(sample)},
            )
        marker_ids_by_target[target.label] = set(current)
        for marker_id, point in current.items():
            p = np.asarray(point, dtype=np.float64)
            world[marker_id] = transform(p) if transform is not None else p
    return world, marker_ids_by_target


__all__ = [
    "LoadedScreenTarget",
    "combined_world_map",
    "load_screen_targets",
    "resolve_path",
]
