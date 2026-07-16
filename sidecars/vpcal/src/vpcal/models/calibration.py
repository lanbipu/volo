"""Calibration result model.

Serialised to ``result.json`` (spec §4.4).  ``schema_version`` tracks the
result schema independently of the tool version.
"""

from __future__ import annotations

from typing import Annotated, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

Confidence = Literal["high", "medium", "low", "very_low"]


class RigidTransform(BaseModel):
    """A solved rigid transform: translation (mm) + quaternion (w, x, y, z).

    ``matrix_4x4`` is the homogeneous form, included for direct consumption by
    downstream tools (e.g. manual UE/nDisplay application).
    """

    model_config = ConfigDict(populate_by_name=True)

    translation: Annotated[list[float], Field(min_length=3, max_length=3)]
    rotation: Annotated[list[float], Field(min_length=4, max_length=4)]
    matrix_4x4: Optional[list[list[float]]] = None


class CameraFromTracker(RigidTransform):
    """camera-from-tracker delta, with a flag for whether it was refined."""

    refined: bool = False


class EstimatedLensParam(BaseModel):
    """One estimated lens scalar with its observability verdict (QLE spec §6.1)."""

    model_config = ConfigDict(populate_by_name=True)

    value: float
    std: Optional[float] = None
    observable: bool = False
    """True iff the param was freed AND passed every gate AND was kept."""
    locked_reason: Optional[str] = None
    """Why a param was not freed or was reverted (None when kept)."""


class EstimatedLens(BaseModel):
    """Session-coupled quick lens estimate (Level 2, QLE spec §6.1).

    Present only when ``solver.lens_estimate.enabled``.  ``is_master`` is always
    False and ``session_coupled`` always True — this estimate must never be
    treated as a master lens or reused across stages.
    """

    model_config = ConfigDict(populate_by_name=True)

    is_master: Literal[False] = False
    session_coupled: Literal[True] = True
    focal_length_mm: Optional[EstimatedLensParam] = None
    principal_point_offset_mm: Optional[
        Annotated[list[EstimatedLensParam], Field(min_length=2, max_length=2)]
    ] = None
    distortion_k1: Optional[EstimatedLensParam] = None
    distortion_k2: Optional[EstimatedLensParam] = None
    spatial_only_rms_px: float
    refined_rms_px: float
    identifiability_flags: list[str] = Field(default_factory=list)
    confidence: Literal["high", "medium", "low"] = "low"


class Quality(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    reprojection_rms_px: float
    total_observations: int
    inlier_observations: int
    outlier_ratio: float
    num_poses: int
    confidence: Confidence
    validation_rms_px: Optional[float] = None
    """Independent reprojection RMS on held-out validation frames (A4);
    None when the session configures no holdout."""
    validation_observations: int = 0
    lens_residual_pattern: Literal["none", "radial", "tangential"] = "none"
    lens_estimate: Optional[EstimatedLens] = None
    """Quick Lens Estimate block; None in Phase-1 (lens-fixed) mode."""
    lens_observability_warning: bool = False
    """Always True whenever ``lens_estimate`` is present (spec §5.5)."""
    handeye_deviation_mm: Optional[float] = None
    handeye_deviation_deg: Optional[float] = None
    warnings: list[str] = Field(default_factory=list)
    staticity: Literal["verified", "warning", "unverifiable"] = "unverifiable"


class Inputs(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    session_config_hash: str
    image_count: int
    screen_definition: str


class CovarianceStd(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    tx_mm: float
    ty_mm: float
    tz_mm: float
    rx_deg: float
    ry_deg: float
    rz_deg: float


class ParameterCovariance(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    available: bool = False
    tracker_to_stage_std: Optional[CovarianceStd] = None


class SolverDiagnostics(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    num_iterations: int
    initial_cost: float
    final_cost: float
    termination_type: str
    termination_message: str = ""
    num_residual_blocks: int
    num_inliers: int
    num_outliers: int
    outlier_ratio: float
    solver_backend: Literal["ceres", "scipy"]
    degraded_backend: bool = False
    scale_estimate: Optional[float] = None
    parameter_covariance: ParameterCovariance = Field(
        default_factory=ParameterCovariance
    )


class CalibrationResult(BaseModel):
    """Top-level calibration result (spec §4.4)."""

    model_config = ConfigDict(populate_by_name=True)

    schema_version: str = "1.2"
    vpcal_version: str
    timestamp: str
    tracker_to_stage: RigidTransform
    tracker_to_camera: CameraFromTracker
    quality: Quality
    inputs: Inputs
    solver_diagnostics: SolverDiagnostics
