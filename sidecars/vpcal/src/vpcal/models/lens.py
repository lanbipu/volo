"""Lens profile and distortion models.

Phase 1 uses the Brown-Conrady 5-parameter model (k1, k2, k3, p1, p2).
See spec section 4.3 for the full definition and computed properties.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, computed_field


class BrownConradyDistortion(BaseModel):
    """Brown-Conrady radial + tangential distortion coefficients.

    Phase 1 supports 5 parameters only.  If k4/k5/k6 (rational model)
    are needed, the validate stage will reject the input.
    """

    model_config = ConfigDict(
        populate_by_name=True,
    )

    model: Literal["brown_conrady"] = "brown_conrady"
    k1: float = 0.0
    k2: float = 0.0
    k3: float = 0.0
    p1: float = 0.0
    p2: float = 0.0


class LensProfile(BaseModel):
    """Unified internal lens representation.

    Computed properties ``fx``, ``fy``, ``cx``, ``cy`` derive the camera
    intrinsic matrix values (in pixels) from the physical parameters.
    """

    model_config = ConfigDict(
        populate_by_name=True,
    )

    focal_length_mm: float = Field(gt=0)
    sensor_width_mm: float = Field(gt=0)
    sensor_height_mm: float = Field(gt=0)
    principal_point_offset_mm: tuple[float, float] = (0.0, 0.0)
    """(cx_offset, cy_offset) relative to sensor center, in mm."""
    image_width_px: int = Field(gt=0)
    image_height_px: int = Field(gt=0)
    distortion: BrownConradyDistortion = Field(
        default_factory=BrownConradyDistortion,
    )
    entrance_pupil_offset_mm: float | None = None
    """Entrance pupil offset along the optical axis (architecture v2.2 §4.3).

    ``None`` (default) reproduces the pre-W8 behaviour exactly (no shift).
    Sign follows OpenLensIO/OpenTrackIO ``entrancePupilOffset``: positive when
    the entrance pupil sits on the object side of the nominal reference plane.
    For a fixed (non-zoom) lens this is degenerate with the Z component of
    ``T_C_from_B`` when the latter is jointly refined (``refine_tracker_to_camera``)
    — both add a constant shift along the camera's optical axis; the solver
    cannot separate them from reprojection error alone. QA surfaces this via
    ``lens_observability_warning`` / camera-prior diagnostics when both are in
    play. For a zoom lens, the offset should vary with focus/zoom (FIZ table)
    — not modelled yet (architecture 4.1 LensCal)."""

    @computed_field  # type: ignore[prop-decorator]
    @property
    def fx(self) -> float:
        """Focal length in pixels (horizontal)."""
        return self.focal_length_mm * self.image_width_px / self.sensor_width_mm

    @computed_field  # type: ignore[prop-decorator]
    @property
    def fy(self) -> float:
        """Focal length in pixels (vertical)."""
        return self.focal_length_mm * self.image_height_px / self.sensor_height_mm

    @computed_field  # type: ignore[prop-decorator]
    @property
    def cx(self) -> float:
        """Principal point x in pixels."""
        return (
            self.image_width_px / 2.0
            + self.principal_point_offset_mm[0]
            * self.image_width_px
            / self.sensor_width_mm
        )

    @computed_field  # type: ignore[prop-decorator]
    @property
    def cy(self) -> float:
        """Principal point y in pixels."""
        return (
            self.image_height_px / 2.0
            + self.principal_point_offset_mm[1]
            * self.image_height_px
            / self.sensor_height_mm
        )
