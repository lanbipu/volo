"""Screen geometry definition models.

Defines the LED wall/volume geometry as a collection of sections (planes and
arcs).  See spec §4.1 for the JSON schema and parametric equations.  Each
section provides a ``uv_to_world(u, v)`` mapping (UV in ``[0,1]²`` → 3D world
point in the UE/Stage frame), the basis the marker field is built on.
"""

from __future__ import annotations

import math
from typing import Annotated, Literal, Optional, Union

import numpy as np
from numpy.typing import NDArray
from pydantic import BaseModel, ConfigDict, Field


def _quat_to_matrix(q: list[float]) -> NDArray[np.float64]:
    """Local copy of quaternion(w,x,y,z) → 3x3 to keep the model dependency-light."""
    w, x, y, z = q
    n = math.sqrt(w * w + x * x + y * y + z * z) or 1.0
    w, x, y, z = w / n, x / n, y / n, z / n
    return np.array(
        [
            [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
            [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
            [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
        ],
        dtype=np.float64,
    )


class _WallSectionBase(BaseModel):
    """Common fields for all wall section types."""

    model_config = ConfigDict(populate_by_name=True)

    name: str
    origin: Annotated[list[float], Field(min_length=3, max_length=3)] = [0.0, 0.0, 0.0]
    rotation: Annotated[list[float], Field(min_length=4, max_length=4)] = [
        1.0,
        0.0,
        0.0,
        0.0,
    ]
    """Quaternion (w, x, y, z) orientation of this section."""

    def _local_to_world(self, local: NDArray[np.float64]) -> NDArray[np.float64]:
        R = _quat_to_matrix(self.rotation)
        return R @ local + np.asarray(self.origin, dtype=np.float64)

    def uv_to_world(self, u: float, v: float) -> NDArray[np.float64]:  # pragma: no cover
        raise NotImplementedError

    def u_extent_mm(self) -> float:  # pragma: no cover
        raise NotImplementedError

    def v_extent_mm(self) -> float:  # pragma: no cover
        raise NotImplementedError


class PlaneSection(_WallSectionBase):
    """A flat rectangular wall section (spec §4.1.2).

    Parametric (UV → local, before rotation + origin):
        local_x = (u - 0.5) * width_mm
        local_y = 0
        local_z = v * height_mm
    """

    type: Literal["plane"] = "plane"
    width_mm: float = Field(gt=0)
    height_mm: float = Field(gt=0)

    def uv_to_world(self, u: float, v: float) -> NDArray[np.float64]:
        local = np.array([(u - 0.5) * self.width_mm, 0.0, v * self.height_mm], dtype=np.float64)
        return self._local_to_world(local)

    def u_extent_mm(self) -> float:
        return self.width_mm

    def v_extent_mm(self) -> float:
        return self.height_mm


class ArcSection(_WallSectionBase):
    """A vertical cylindrical arc wall section (spec §4.1.1).

    Parametric (UV → local, before rotation + origin):
        angle   = arc_center_angle_deg + (u - 0.5) * arc_angle_deg   (deg → rad)
        local_x = R * cos(angle)
        local_y = R * sin(angle)
        local_z = v * height_mm
    """

    type: Literal["arc"] = "arc"
    arc_radius_mm: float = Field(gt=0)
    arc_angle_deg: float = Field(gt=0, le=360)
    arc_center_angle_deg: float = 180.0
    height_mm: float = Field(gt=0)

    def uv_to_world(self, u: float, v: float) -> NDArray[np.float64]:
        angle = math.radians(self.arc_center_angle_deg + (u - 0.5) * self.arc_angle_deg)
        local = np.array(
            [
                self.arc_radius_mm * math.cos(angle),
                self.arc_radius_mm * math.sin(angle),
                v * self.height_mm,
            ],
            dtype=np.float64,
        )
        return self._local_to_world(local)

    def u_extent_mm(self) -> float:
        return self.arc_radius_mm * math.radians(self.arc_angle_deg)

    def v_extent_mm(self) -> float:
        return self.height_mm


WallSection = Annotated[Union[ArcSection, PlaneSection], Field(discriminator="type")]
"""Discriminated union of section types, keyed on the ``type`` field."""


class ProcessorCanvas(BaseModel):
    """LED-processor input-canvas → physical-pixel mapping (remediation C0).

    Real LED walls almost always sit behind a processor (Brompton / Megapixel /
    Nova) that may scale or offset the input canvas before it reaches the
    physical LED grid.  If that mapping is not 1:1 the marker 3D lookup is wrong.
    The mapping is affine per axis: ``physical_px = input_px · scale + offset``.
    The identity (scale 1, offset 0) means a verified 1:1 canvas.
    """

    model_config = ConfigDict(populate_by_name=True)

    input_width_px: int = Field(gt=0)
    input_height_px: int = Field(gt=0)
    scale_x: float = 1.0
    scale_y: float = 1.0
    offset_x_px: float = 0.0
    offset_y_px: float = 0.0


class ScreenDefinition(BaseModel):
    """Top-level screen geometry definition for an LED volume (spec §4.1)."""

    model_config = ConfigDict(populate_by_name=True)

    name: str
    unit: str = "mm"
    cabinet_size: tuple[float, float]
    """(width, height) of a single LED cabinet in ``unit``."""
    led_pixel_pitch_mm: float = Field(gt=0)
    markers_per_cabinet: int = Field(default=4, ge=1, le=4)
    """Markers laid out per cabinet.  Legacy default is 4 (sub-quadrant
    layout) for backward compatibility with existing screen JSON files.
    New screens created via ``screen create`` use 1 (cell-centred layout)
    when auto cabinet sizing is active.  Stored on the screen (the shared
    artifact) so pattern generation, simulation and the solve-stage 3D
    lookup cannot drift out of sync."""
    sections: list[WallSection]
    processor: Optional[ProcessorCanvas] = None
    """Optional LED-processor canvas mapping (C0); ``None`` ⇒ assume a direct 1:1
    physical canvas (the Phase-1 assumption)."""
    geometry_provenance: Optional[dict] = None
    """Formal fixed-pose geometry qualification emitted by Volo screen export."""

    def section_by_name(self, name: str) -> WallSection | None:
        for s in self.sections:
            if s.name == name:
                return s
        return None
