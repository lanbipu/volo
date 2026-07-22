"""Session configuration model.

Mirrors the session config JSON schema in spec §3.2.  Parsed with Pydantic v2;
the CLI loads a JSON/YAML file into :class:`SessionConfig` and passes it to the
core pipeline.
"""

from __future__ import annotations

from typing import Annotated, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator

from vpcal.models.lens import LensProfile

CoordinateSystem = Literal["unreal", "optitrack", "vicon", "freeDEuler", "opentrackio", "custom"]
FrameMatching = Literal["frame_id", "line_number", "timestamp"]
RobustLoss = Literal["huber", "cauchy", "none"]
RobustScale = float | Literal["auto"]
LensParam = Literal["k1", "k2", "cx", "cy"]


class ImagesConfig(BaseModel):
    """Where the captured image frames live."""

    model_config = ConfigDict(populate_by_name=True)

    path: str
    format: str = "png"


class TrackingConfig(BaseModel):
    """Tracking data source + coordinate-system / frame-alignment policy."""

    model_config = ConfigDict(populate_by_name=True)

    path: str
    coordinate_system: CoordinateSystem = "unreal"
    frame_matching: FrameMatching = "frame_id"
    timestamp_tolerance_s: float = Field(default=0.05, ge=0.0)
    custom_transform: Optional[
        Annotated[list[list[float]], Field(min_length=4, max_length=4)]
    ] = None
    """Required 4x4 matrix when ``coordinate_system == 'custom'`` (§10.2)."""


class ScreenConfig(BaseModel):
    """One LED calibration target in a shared Stage coordinate frame.

    ``screen_id`` and ``cab_col_offset`` are part of the VP-QSP marker identity
    contract.  They must match pattern generation; keeping them in the session
    prevents a non-primary screen from being detected and then silently
    discarded by a world map built with the legacy zero defaults.
    """

    model_config = ConfigDict(populate_by_name=True)

    path: str
    id: Optional[str] = None
    screen_id: int = Field(default=0, ge=0, le=15)
    cab_col_offset: int = Field(default=0, ge=0)


class MarkerMapConfig(BaseModel):
    """Path to a surveyed marker map (AR mode ground-truth source, plan Phase A).

    Present ⇒ the detect stage routes to the physical ArUco/AprilTag detector
    and marker 3D coordinates come from the map instead of a screen definition.
    Mutually exclusive with ``screen``.
    """

    model_config = ConfigDict(populate_by_name=True)

    path: str
    fingerprint: Optional[str] = None
    """Optional sha256 of the map embedded when the session was captured."""
    ground_tolerance_mm: float = Field(default=5.0, gt=0)
    """Ground-plane offset warning threshold (Phase B2)."""
    ground_tolerance_deg: float = Field(default=0.2, gt=0)
    """Ground-plane tilt warning threshold (Phase B2)."""


class RigidPrior(BaseModel):
    """A rigid-transform prior: translation (mm) + quaternion (w, x, y, z)."""

    model_config = ConfigDict(populate_by_name=True)

    translation: Annotated[list[float], Field(min_length=3, max_length=3)] = [
        0.0,
        0.0,
        0.0,
    ]
    rotation: Annotated[list[float], Field(min_length=4, max_length=4)] = [
        1.0,
        0.0,
        0.0,
        0.0,
    ]


class LensEstimateConfig(BaseModel):
    """Quick Lens Estimate config (Level 2, Quick Lens Estimate spec §3.1).

    Default ``enabled=False`` reproduces Phase-1 behaviour exactly (lens fully
    fixed).  When enabled, the listed ``params`` become free variables in the
    joint bundle adjustment, gated by the observability checks in
    ``qa/observability.py``.  The result is always a session-coupled, non-master
    estimate carrying an identifiability warning.
    """

    model_config = ConfigDict(populate_by_name=True)

    enabled: bool = False
    params: set[LensParam] = Field(default_factory=lambda: {"k1", "k2", "cx", "cy"})
    refine_focal: bool = False
    focal_prior_weight: float = Field(default=1000.0, gt=0)
    principal_point_margin_mm: float = Field(default=5.0, ge=0.0)
    k_bounds: tuple[float, float] = (-0.5, 0.5)
    cv2_bootstrap: bool = False

    # Observability gate thresholds (documented architecture constraints, not
    # magic numbers; QA always prints measured-vs-threshold so they can be
    # re-tuned without code changes).
    min_poses: int = Field(default=8, gt=0)
    min_observations: int = Field(default=60, gt=0)
    min_edge_obs_fraction: float = Field(default=0.25, ge=0.0, le=1.0)
    edge_radius_fraction: float = Field(default=0.35, gt=0.0, le=1.0)
    max_spatial_rms_px_for_center: float = Field(default=2.0, gt=0)
    max_spatial_rms_px_for_k: float = Field(default=1.0, gt=0)
    condition_number_limit: float = Field(default=1.0e4, gt=0)
    correlation_limit: float = Field(default=0.8, gt=0, le=1.0)
    cross_subset_k_abs_delta: float = Field(default=0.05, ge=0.0)
    cross_subset_k_rel_delta: float = Field(default=0.30, ge=0.0)
    min_improvement_pct: float = Field(default=3.0, ge=0.0)

    @model_validator(mode="after")
    def _check_params(self) -> "LensEstimateConfig":
        # k2 is meaningless without k1 (spec §2.2 / §3.2).
        if "k2" in self.params and "k1" not in self.params:
            raise ValueError(
                "lens_estimate.params contains 'k2' without 'k1'; "
                "k2 may only be estimated jointly with k1"
            )
        if self.k_bounds[0] >= self.k_bounds[1]:
            raise ValueError("lens_estimate.k_bounds must be (lo, hi) with lo < hi")
        return self


_PRIOR_SIGMA_ROTATION_RAD = 0.034906585039886591  # 2° — expected hand-eye rotation error
_PRIOR_SIGMA_TRANSLATION_MM = 10.0                # expected hand-eye translation error
DEFAULT_PRIOR_WEIGHT_ROTATION = 1.0 / _PRIOR_SIGMA_ROTATION_RAD**2    # ≈ 820.7
DEFAULT_PRIOR_WEIGHT_TRANSLATION = 1.0 / _PRIOR_SIGMA_TRANSLATION_MM**2  # 0.01


class SolverConfig(BaseModel):
    """Solver tuning knobs (spec §3.2 / §5.3)."""

    model_config = ConfigDict(populate_by_name=True)

    refine_tracker_to_camera: bool = False
    tracker_to_camera_prior: RigidPrior = Field(default_factory=RigidPrior)
    prior_weight_rotation: float = Field(default=DEFAULT_PRIOR_WEIGHT_ROTATION, gt=0)
    """Camera-from-tracker prior weight on the rotation residual (rad⁻²).

    Defaults to 1/σ² with σ = 2°.  Replaces the single
    ``tracker_to_camera_prior_weight``, which applied one weight to mm and rad
    residuals alike — equivalent to σ ≈ 0.03 mm translation (a hard freeze)
    next to σ ≈ 1.8° rotation (remediation A3.2).
    """
    prior_weight_translation: float = Field(default=DEFAULT_PRIOR_WEIGHT_TRANSLATION, gt=0)
    """Camera-from-tracker prior weight on the translation residual (mm⁻²).

    Defaults to 1/σ² with σ = 10 mm.
    """
    tracker_to_camera_prior_weight: Optional[float] = Field(default=None, gt=0)
    """DEPRECATED single prior weight (schema <= 1.1).

    When set, it is applied to BOTH rotation and translation residuals unless
    the split fields are given explicitly — reproducing the legacy behaviour
    for old session files.
    """
    robust_loss: RobustLoss = "huber"
    robust_loss_scale: RobustScale = 1.0
    """Robust scale in px, or ``auto`` for a MAD-derived second solve."""
    max_iterations: int = Field(default=200, gt=0)
    timeout_seconds: float = Field(default=300.0, gt=0)
    timing_delay_bound_ms: float = Field(default=66.0, gt=0)
    handeye_deviation_warn_mm: float = Field(default=5.0, gt=0)
    handeye_deviation_warn_deg: float = Field(default=2.0, gt=0)
    diagnose_scale: bool = False
    marker_uncertainty_weighting: bool = False
    lens_estimate: LensEstimateConfig = Field(default_factory=LensEstimateConfig)

    @model_validator(mode="after")
    def _legacy_prior_weight(self) -> "SolverConfig":
        # Deprecated alias: a legacy single weight fills BOTH split fields when
        # they were not given explicitly (bit-compatible with schema <= 1.1).
        if self.tracker_to_camera_prior_weight is not None:
            if "prior_weight_rotation" not in self.model_fields_set:
                self.prior_weight_rotation = self.tracker_to_camera_prior_weight
            if "prior_weight_translation" not in self.model_fields_set:
                self.prior_weight_translation = self.tracker_to_camera_prior_weight
        if self.robust_loss_scale != "auto" and self.robust_loss_scale <= 0:
            raise ValueError("solver.robust_loss_scale must be > 0 or 'auto'")
        return self


class ValidationConfig(BaseModel):
    """Held-out validation poses (remediation A4).

    Frames listed in ``holdout_frames`` (or selected by ``holdout_ratio``,
    evenly spaced over the sorted frame ids) are EXCLUDED from the solve; the
    solved transform is then evaluated on them, giving an independent
    ``validation_rms_px`` — in-sample RMS only proves self-consistency, not
    that the perspective is right.
    """

    model_config = ConfigDict(populate_by_name=True)

    holdout_frames: Optional[list[int]] = None
    """Explicit frame ids to hold out (takes precedence over the ratio)."""
    holdout_ratio: float = Field(default=0.2, gt=0.0, lt=1.0)
    """Fraction of frames (not observations) to hold out when no list is given."""


class ProcessorCheckConfig(BaseModel):
    """LED-processor 1:1 canvas mapping verification (architecture §3.3a, W9.1).

    Only enforced when the referenced screen declares a ``processor``
    (:class:`vpcal.models.screen.ProcessorCanvas`) — a screen with no processor
    is assumed direct-drive 1:1 (Phase-1 default), so sessions without one see
    no behaviour change.  When a processor IS declared, ``validate_session``
    requires either ``processor_verified=true`` (self-attested, e.g. verified
    once out-of-band for a fixed installation) or a ``mapping_image`` that
    passes :func:`vpcal.core.mapping_verify.verify_mapping_image`.
    """

    model_config = ConfigDict(populate_by_name=True)

    mapping_image: Optional[str] = None
    """Path (relative to the session dir, or absolute) to a pixel-accurate
    mapping-verify capture (processor output frame grab, NOT a camera photo)."""
    expected_width_px: Optional[int] = None
    """Input canvas width the mapping-verify pattern was generated at (required with ``mapping_image``)."""
    expected_height_px: Optional[int] = None
    """Input canvas height the mapping-verify pattern was generated at (required with ``mapping_image``)."""
    processor_verified: bool = False
    """Skip the mandatory check: the operator attests the processor mapping was already verified."""


class SessionConfig(BaseModel):
    """Top-level session configuration (spec §3.2)."""

    model_config = ConfigDict(populate_by_name=True)

    images: ImagesConfig
    tracking: TrackingConfig
    screen: Optional[ScreenConfig] = None
    """Legacy single LED target.  New captures write ``screens`` instead."""
    screens: Optional[list[ScreenConfig]] = Field(default=None, min_length=1)
    """One or more LED targets whose definitions share the Stage frame."""
    marker_map: Optional[MarkerMapConfig] = None
    """Surveyed marker map (marker 3D truth for the AR path)."""
    lens: LensProfile
    solver: SolverConfig = Field(default_factory=SolverConfig)
    validation: Optional[ValidationConfig] = None
    """Held-out validation config; omit for the legacy no-holdout behaviour."""
    capture_mode: Literal["legacy", "dual_frame"] = "legacy"
    processor_check: Optional[ProcessorCheckConfig] = None
    """LED-processor mapping verification (W9.1); ``None`` = not yet attested.
    Only enforced when the screen declares a ``processor`` (see
    :class:`ProcessorCheckConfig`)."""

    @model_validator(mode="after")
    def _screen_xor_marker_map(self) -> "SessionConfig":
        led_sources = int(self.screen is not None) + int(self.screens is not None)
        if led_sources + int(self.marker_map is not None) != 1:
            raise ValueError(
                "exactly one of 'screen' (legacy LED), 'screens' (multi-screen "
                "LED), or 'marker_map' (AR path) must be configured"
            )
        if self.screens is not None:
            keys = [(target.screen_id, target.cab_col_offset) for target in self.screens]
            if len(keys) != len(set(keys)):
                raise ValueError("screens contains duplicate screen_id/cab_col_offset assignments")
        return self

    @property
    def screen_targets(self) -> list[ScreenConfig]:
        """Normalized LED targets while preserving legacy session support."""
        if self.screens is not None:
            return list(self.screens)
        return [self.screen] if self.screen is not None else []
