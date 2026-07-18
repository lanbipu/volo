"""Pydantic models for sidecar IPC. Mirrors python-sidecar/schema/ipc.schema.json."""
from __future__ import annotations

from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, Field, model_serializer, model_validator

# Vec3 / Mat3 enforce proper nesting + length so ragged / short arrays are
# rejected at the IPC boundary, not later inside BA / projection code.
Vec3 = Annotated[list[float], Field(min_length=3, max_length=3)]
Mat3 = Annotated[list[Vec3], Field(min_length=3, max_length=3)]


class CoordinateFrame(BaseModel):
    origin_world: Vec3
    basis: Mat3


PositiveSizePair = Annotated[
    list[Annotated[float, Field(gt=0.0)]],
    Field(min_length=2, max_length=2),
]


class CabinetArray(BaseModel):
    cols: int = Field(ge=1)
    rows: int = Field(ge=1)
    cabinet_size_mm: PositiveSizePair
    absent_cells: list[tuple[int, int]] = Field(default_factory=list)


class ShapePriorCurvedBody(BaseModel):
    radius_mm: float


class ShapePriorCurved(BaseModel):
    """`{"curved": {"radius_mm": ...}}`"""
    curved: ShapePriorCurvedBody


class ShapePriorFoldedBody(BaseModel):
    fold_seam_columns: list[Annotated[int, Field(ge=0)]]


class ShapePriorFolded(BaseModel):
    """`{"folded": {"fold_seam_columns": [...]}}`"""
    folded: ShapePriorFoldedBody


ShapePrior = Union[Literal["flat"], ShapePriorCurved, ShapePriorFolded]


class FrameAnchor(BaseModel):
    cabinet_col: int = Field(ge=0)
    cabinet_row: int = Field(ge=0)
    aruco_id: int = Field(ge=0)
    position_world: Vec3


PositiveIntPair = Annotated[
    list[Annotated[int, Field(gt=0)]],
    Field(min_length=2, max_length=2),
]


class Intrinsics(BaseModel):
    K: Mat3
    dist_coeffs: Annotated[list[float], Field(min_length=4, max_length=8)]
    image_size: PositiveIntPair


class PatternMetaCabinet(BaseModel):
    col: int
    row: int
    aruco_id_start: int
    aruco_id_end: int
    # v2: per-cabinet board geometry (pitch-matched generation)
    squares_x: int = Field(ge=2)
    squares_y: int = Field(ge=2)
    square_px: int = Field(gt=0)
    pixel_pitch_mm: PositiveSizePair  # [pitch_x, pitch_y]

    @property
    def markers(self) -> int:
        """Markers this board consumes (alternating cells of squares_x×squares_y)."""
        return (self.squares_x * self.squares_y) // 2

    @property
    def inner_x(self) -> int:
        return self.squares_x - 1

    @property
    def inner_y(self) -> int:
        return self.squares_y - 1


class PatternMeta(BaseModel):
    schema_version: Literal[2]
    aruco_dict: str
    cabinets: list[PatternMetaCabinet]


class VpqspMarkerGrid(BaseModel):
    """Per-cabinet VP-QSP marker grid geometry (vpqsp pattern_meta).

    Unlike PatternMetaCabinet there is no ArUco id range — each marker self-encodes
    its (screen_id, col, row, local_id), so the only routing data is the grid shape
    needed to map a decoded local_id back to its nominal local-mm position.
    """

    col: int
    row: int
    resolution_px: PositiveIntPair      # [width_px, height_px] of the cabinet canvas
    markers_x: int = Field(ge=1)
    markers_y: int = Field(ge=1)
    marker_px: int = Field(gt=0)
    pixel_pitch_mm: PositiveSizePair    # [pitch_x, pitch_y]

    @property
    def markers(self) -> int:
        return self.markers_x * self.markers_y


class VpqspPatternMeta(BaseModel):
    """VP-QSP pattern metadata (replaces the ChArUco PatternMeta for method=vpqsp).

    `screen_id_code` is the 4-bit numeric screen id encoded into every marker on
    this screen; reconstruct filters detections to it for multi-screen Volumes.
    """

    schema_version: Literal["vpqsp.v1"]
    screen_id_code: int = Field(ge=0, le=15)
    cabinets: list[VpqspMarkerGrid]


class ReconstructProject(BaseModel):
    screen_id: str
    cabinet_array: CabinetArray
    shape_prior: ShapePrior = "flat"
    # VP-QSP 4-bit screen code (0–15). Required for multi-screen joint solve so
    # detections can be bucketed without re-reading each pattern_meta. Optional
    # for the single-screen `project` compat path (code then comes from meta).
    screen_id_code: int | None = Field(default=None, ge=0, le=15)
    # Optional per-screen overrides for joint reconstruct (when set, preferred
    # over the capture manifest's top-level pattern_meta / screen_mapping).
    pattern_meta_path: str | None = None
    screen_mapping_path: str | None = None
    # Per-screen pose report path; when null, falls back to ReconstructInput.pose_report_path
    # (single-screen) or is derived by the caller.
    pose_report_path: str | None = None


class ReconstructInput(BaseModel):
    command: Literal["reconstruct"]
    version: Literal[1]
    # Single-screen compat entry. Mutually exclusive with `screens` (`screens` wins).
    project: ReconstructProject | None = None
    # Multi-screen joint solve: one ReconstructProject per screen. When set,
    # preferred over `project`. First entry is the gauge / frame screen.
    screens: list[ReconstructProject] | None = None
    capture_manifest_path: str
    # Optional override of the manifest's screen_mapping reference; when null
    # the sidecar uses the path the capture manifest points to.
    screen_mapping_path: str | None = None
    # If set, the sidecar writes cabinet_pose_report.json (spec §9) here.
    pose_report_path: str | None = None
    # Joint multi-screen SE(3) transforms (visual_screen_transforms.v1). Required
    # output path when len(screens) > 1; ignored for single-screen.
    screen_transforms_path: str | None = None
    # Optional override of the manifest's intrinsics reference. The reserved value
    # "auto" runs inline self-calibration from the captured VP-QSP markers (vpqsp
    # method only); a file path loads {K, dist_coeffs, image_size}. When null the
    # sidecar uses the manifest's intrinsics reference.
    intrinsics_path: str | None = None
    # Optional independent intrinsics anchor for the --intrinsics auto anti-
    # absorption cross-check (vpqsp self-cal only).
    crosscheck_intrinsics_path: str | None = None

    @model_validator(mode="after")
    def _require_project_or_screens(self) -> "ReconstructInput":
        if self.screens:
            if len(self.screens) == 0:
                raise ValueError("screens must be non-empty when provided")
            for i, s in enumerate(self.screens):
                if s.screen_id_code is None:
                    raise ValueError(
                        f"screens[{i}].screen_id_code is required for joint reconstruct"
                    )
            return self
        if self.project is None:
            raise ValueError("project or screens is required")
        return self


class ReconstructStructuredLightInput(BaseModel):
    command: Literal["reconstruct_structured_light"]
    version: Literal[1]
    project: ReconstructProject
    # One CorrespondenceFile per camera pose (decode_structured_light output).
    correspondence_paths: Annotated[list[str], Field(min_length=2)]
    sl_meta_path: str
    # Camera intrinsics JSON (visual calibrate output): {K, dist_coeffs, image_size}.
    # The reserved value "auto" runs inline self-calibration from these same corr files.
    intrinsics_path: str
    # If set, the sidecar writes cabinet_pose_report.json here (spec §9).
    pose_report_path: str | None = None
    # Optional independent intrinsics anchor for the --intrinsics auto cross-check.
    crosscheck_intrinsics_path: str | None = None


class CalibrateStructuredLightInput(BaseModel):
    command: Literal["calibrate_structured_light"]
    version: Literal[1]
    project: ReconstructProject
    # One CorrespondenceFile per camera pose of ONE camera (decode_structured_light output).
    correspondence_paths: Annotated[list[str], Field(min_length=1)]
    sl_meta_path: str
    # Where the intrinsics JSON is written (NON-destructive default chosen by lmt-app).
    output_path: str
    # reproj RMS gate (px). Looser than checkerboard's 0.5 — SL centroids are noisier.
    # Upper cap: beyond 5 px the fit is garbage and the quality gate is effectively disabled.
    max_rms_px: float = Field(default=1.5, gt=0.0, le=5.0)
    # Optional independent intrinsics anchor (checkerboard intrinsics.json) for the
    # anti-absorption cross-check. Without it, a coplanar (flat) wall is refused.
    crosscheck_intrinsics_path: str | None = None


class CalibrateInput(BaseModel):
    command: Literal["calibrate"]
    version: Literal[1]
    checkerboard_images: Annotated[list[str], Field(min_length=5)]
    inner_corners: Annotated[list[int], Field(min_length=2, max_length=2)]
    square_size_mm: float = Field(gt=0.0)
    output_path: str


class GeneratePatternProject(BaseModel):
    screen_id: str
    cabinet_array: CabinetArray


class GeneratePatternInput(BaseModel):
    command: Literal["generate_pattern"]
    version: Literal[1]
    project: GeneratePatternProject
    output_dir: str
    screen_resolution: PositiveIntPair
    # When set, per-cabinet board geometry (size/pitch) is read from this
    # screen_mapping.json; when None, uniform grid generation is used.
    screen_mapping_path: str | None = None
    # Marker family. "vpqsp" (the CLI default) renders self-encoding VP-QSP markers
    # with no dictionary capacity limit; "charuco" keeps the legacy ChArUco path.
    # The model default stays "charuco" so direct-model callers are unchanged; the
    # CLI/adapter always send the resolved method explicitly.
    method: Literal["charuco", "vpqsp"] = "charuco"
    # 4-bit numeric screen id baked into every VP-QSP marker (method=vpqsp only);
    # distinct per screen in a multi-screen Volume. Ignored for charuco.
    screen_id_code: int = Field(default=0, ge=0, le=15)


class GenerateStructuredLightInput(BaseModel):
    command: Literal["generate_structured_light"]
    version: Literal[1]
    project: GeneratePatternProject
    output_dir: str
    screen_resolution: PositiveIntPair
    # When set, per-cabinet placement (input_rect_px) + pitch come from this
    # screen_mapping.json -- same single-source-of-truth contract as generate_pattern.
    screen_mapping_path: str | None = None
    # None = auto: derived per-cabinet from its pixel resolution so ANY screen
    # size/cabinet fills correctly with no tuning (spacing ~= 1/8 of the cabinet's
    # shorter edge, margin ~= 1/16 -> a roughly 8x8 filled grid). Explicit values
    # override. dot_radius stays fixed (appearance-only, gamma-immune at decode).
    dot_spacing_px: int | None = Field(default=None, gt=0)
    dot_radius_px: int = Field(gt=0, default=6)
    margin_px: int | None = Field(default=None, ge=0)
    hold_ms: int = Field(gt=0, default=500)
    fps: int = Field(gt=0, default=30)
    # Also emit a disguise-ready image sequence: <screen_id>.seq/ of uncompressed
    # 24-bit TIFFs named <screen_id>_NNNNN.tif from 0 (disguise .seq convention).
    emit_tiff_seq: bool = Field(default=False)


class StructuredLightDot(BaseModel):
    id: int = Field(ge=0)
    u: float
    v: float
    cabinet: Annotated[list[int], Field(min_length=2, max_length=2)]


class CabinetRect(BaseModel):
    col: int
    row: int
    input_rect_px: Annotated[list[int], Field(min_length=4, max_length=4)]
    pixel_pitch_mm: PositiveSizePair


class CodeSpec(BaseModel):
    data_bits: int = Field(ge=1)
    total_bits: int = Field(ge=2)
    parity: Literal["even"] = "even"
    encoding: Literal["binary"] = "binary"


class SequenceSpec(BaseModel):
    sentinel: Literal["white_full"] = "white_full"
    anchor: Literal["all_on"] = "all_on"
    n_code_frames: int = Field(ge=1)   # == code.total_bits
    hold_ms: int = Field(gt=0)
    fps: int = Field(gt=0)


class StructuredLightMeta(BaseModel):
    schema_version: Literal[1]
    screen_id: str
    screen_resolution: PositiveIntPair
    dot_radius_px: int = Field(gt=0)
    code: CodeSpec
    sequence: SequenceSpec
    cabinets: list[CabinetRect]
    dots: list[StructuredLightDot]


class DecodeStructuredLightInput(BaseModel):
    command: Literal["decode_structured_light"]
    version: Literal[1]
    input_path: str           # a video file OR a directory of frame images (PNG/JPG/BMP/TIFF or disguise 10-bit .dpx)
    sl_meta_path: str
    output_path: str
    sentinel_threshold: float = Field(gt=0.0, le=1.0, default=0.85)
    # None = auto: Pass-1 temporal-activity map derives the screen ROI. A manual
    # [x, y, w, h] overrides it (fallback when auto fails on hard scenes).
    screen_roi: tuple[int, int, int, int] | None = None
    # Write the Pass-3 seed binary mask to <output_path>.debug.png for eyeball QA.
    emit_debug_image: bool = False


class CorrespondencePoint(BaseModel):
    id: int = Field(ge=0)
    u: float   # screen pixel (from sl_meta)
    v: float
    x: float   # camera pixel (sub-pixel centroid)
    y: float


class CorrespondenceFile(BaseModel):
    schema_version: Literal[1]
    screen_id: str
    sl_meta_sha256: str        # provenance: which pattern/meta produced this
    screen_resolution: PositiveIntPair
    camera_image_size: Annotated[list[int], Field(min_length=2, max_length=2)]
    source_input: str          # the decoded video/dir path
    # Detection provenance: the screen ROI actually used (auto-derived or manual).
    # Optional so old corr.json still validate; reconstruct ignores it.
    screen_roi: tuple[int, int, int, int] | None = None
    points: list[CorrespondencePoint]


class Uncertainty(BaseModel):
    """Externally tagged: exactly one of {isotropic, covariance} must be set.

    JSON form mirrors `lmt_core::uncertainty::Uncertainty`:
      {"isotropic": 0.005} or {"covariance": [[...], [...], [...]]}.
    """

    isotropic: float | None = None
    covariance: Mat3 | None = None

    @model_validator(mode="after")
    def _exactly_one(self) -> "Uncertainty":
        provided = sum(v is not None for v in (self.isotropic, self.covariance))
        if provided != 1:
            raise ValueError("Uncertainty must set exactly one of {isotropic, covariance}")
        return self

    @model_serializer
    def _serialize(self) -> dict[str, Any]:
        if self.isotropic is not None:
            return {"isotropic": self.isotropic}
        return {"covariance": self.covariance}


class PointSourceVisualBa(BaseModel):
    camera_count: int = Field(ge=1)


class PointSource(BaseModel):
    visual_ba: PointSourceVisualBa


class MeasuredPoint(BaseModel):
    name: str
    position: Vec3
    uncertainty: Uncertainty
    source: PointSource


class BaStats(BaseModel):
    rms_reprojection_px: float
    iterations: int
    converged: bool
    n_observations_total: int = 0
    n_observations_used: int = 0
    n_rejected: int = 0


class ScreenResultSummary(BaseModel):
    """Per-screen digest nested under joint ResultData.screens."""

    screen_id: str
    pose_report_path: str | None = None
    ba_rms_px: float = Field(ge=0.0)
    cabinet_count: int = Field(ge=0)
    bridge_views: int = Field(default=0, ge=0)


class ResultData(BaseModel):
    measured_points: list[MeasuredPoint]
    ba_stats: BaStats
    frame_strategy_used: Literal["nominal_anchoring", "three_points"]
    # Optional for forward/backward compat with subcommands that don't run
    # Procrustes (calibrate, generate_pattern) and with older sidecar versions.
    procrustes_align_rms_m: float = Field(default=0.0, ge=0.0)
    # "file" (provided intrinsics) | "auto_self_calibrated" (--intrinsics auto).
    intrinsics_source: str = "file"
    # Joint multi-screen: path to visual_screen_transforms.v1 JSON (None for single).
    screen_transforms_path: str | None = None
    # Joint multi-screen: per-screen summaries (None / omitted for single-screen).
    screens: list[ScreenResultSummary] | None = None
    # Photos with no usable markers (basenames); empty = all photos contributed.
    ignored_photos: list[str] = Field(default_factory=list)
    # Capture photo counts (used = total − ignored). Older sidecars omit → 0.
    photos_used: int = Field(default=0, ge=0)
    photos_total: int = Field(default=0, ge=0)


class ScreenTransformEntry(BaseModel):
    screen_id: str
    R: Mat3
    t_mm: Vec3
    rms_px: float = Field(ge=0.0)
    bridge_views: int = Field(ge=0)


class ScreenTransformsReport(BaseModel):
    schema_version: Literal["visual_screen_transforms.v1"]
    frame_screen_id: str
    transforms: list[ScreenTransformEntry]


class ProgressEvent(BaseModel):
    event: Literal["progress"]
    stage: Literal[
        "load",
        "detect_charuco",
        "detect_vpqsp",
        "subpixel_refine",
        "bundle_adjustment",
        "procrustes_align",
        "output",
    ]
    percent: float = Field(ge=0.0, le=1.0)
    message: str | None = None


class WarningEvent(BaseModel):
    event: Literal["warning"]
    code: str
    message: str
    cabinet: str | None = None


class ResultEvent(BaseModel):
    event: Literal["result"]
    data: ResultData


class ErrorEvent(BaseModel):
    event: Literal["error"]
    code: Literal[
        "invalid_input",
        "image_load_failed",
        "detection_failed",
        "observability_failed",
        "screens_disconnected",
        "ba_diverged",
        "procrustes_failed",
        "intrinsics_invalid",
        "decode_failed",
        "internal_error",
    ]
    message: str
    fatal: bool


# ---------------------------------------------------------------------------
# Camera-visual branch: simulate / eval / pose DTOs (zero total-station)
# ---------------------------------------------------------------------------

class CameraSamplingSpec(BaseModel):
    n_views: int = Field(ge=2)
    distance_mm_range: Annotated[list[float], Field(min_length=2, max_length=2)]
    yaw_deg_range: Annotated[list[float], Field(min_length=2, max_length=2)]
    pitch_deg_range: Annotated[list[float], Field(min_length=2, max_length=2)]
    # FIX-10a: "orbit" (default) = every camera aims at the wall centroid;
    # "along_wall" = stations spread along the wall, each at distance_mm_range
    # standoff along the LOCAL surface normal aiming at its own wall segment
    # (segmented wide-wall capture; yaw/pitch ranges jitter the standoff
    # direction). With FOV clipping this produces partial per-view coverage —
    # the geometry that exposes init-chaining bugs (FIX-3 class).
    trajectory: Literal["orbit", "along_wall"] = "orbit"


class NoiseSpec(BaseModel):
    pixel_sigma: float = Field(ge=0.0)
    outlier_frac: float = Field(ge=0.0, le=1.0, default=0.0)
    visibility_frac: float = Field(gt=0.0, le=1.0, default=1.0)
    pixel_pitch_error_frac: float = Field(ge=0.0, default=0.0)


class SimulateScene(BaseModel):
    cabinet_array: CabinetArray
    shape_prior: ShapePrior = "flat"
    inter_board_angle_deg: float = 0.0  # inter-board angle for multi-panel rigs (monitor bench)


class SimulateInput(BaseModel):
    command: Literal["simulate"]
    version: Literal[1]
    scene: SimulateScene
    cameras: CameraSamplingSpec
    intrinsics: Intrinsics
    noise: NoiseSpec
    seed: int = 0
    out_dir: str | None = None


class EvalInput(BaseModel):
    command: Literal["eval"]
    version: Literal[1]
    dataset_dir: str
    method: Literal["free_point", "charuco", "structured_light"] = "charuco"
    seed_matrix: Annotated[list[int], Field(min_length=1)] = Field(default_factory=lambda: [0])
    # FIX-10a: "near_truth" (default, Phase-0) initialises BA from true camera
    # poses + true cabinet translations; "cold" runs the PRODUCTION init path
    # (transitive bridging + nominal fallback + joint PnP cameras + Stage-B) so
    # the eval exercises what real captures run. Requires a dataset whose
    # meta.json carries the design (cols/rows/shape_prior).
    init: Literal["near_truth", "cold"] = "near_truth"


class FrameSpec(BaseModel):
    type: Literal["screen_local"] = "screen_local"
    gauge_strategy: Literal["fix_root_cabinet", "align_to_nominal"] = "fix_root_cabinet"
    root_cabinet: Annotated[list[int], Field(min_length=2, max_length=2)] = Field(
        default_factory=lambda: [0, 0]
    )
    units: Literal["mm"] = "mm"
    handedness: Literal["right"] = "right"
    z_axis: Literal["outward"] = "outward"


class CabinetPose(BaseModel):
    cabinet_id: str
    position_mm: Vec3
    rotation_matrix: Mat3
    normal: Vec3
    corners_mm: Annotated[list[Vec3], Field(min_length=4, max_length=4)]
    reprojection_rms_px: float = Field(ge=0.0)
    observed_views: int
    observed_points: int
    rejected_points: int = 0
    quality: Literal["ok", "low_observation", "high_residual"]
    # FIX-13 ④: BA 逐箱体 3×3 平移协方差（mm²，箱体中心）。协方差不可用
    # （大规模跳过 / 非有限）时为 None。pose report 是它的唯一持久化位置
    # （measured.yaml 写出已删除）。
    covariance_mm2: Mat3 | None = None


class CabinetPoseReport(BaseModel):
    schema_version: Literal["visual_pose_report.v1"]
    frame: FrameSpec
    cabinet_poses: list[CabinetPose]


# ---------------------------------------------------------------------------
# simulate / eval result events — separate from ResultData to avoid polluting
# the reconstruct contract (which requires measured_points / ba_stats / etc.)
# ---------------------------------------------------------------------------

class SimulateResultData(BaseModel):
    dataset_dir: str
    n_views: int
    n_observations: int
    seed: int


class SimulateResultEvent(BaseModel):
    event: Literal["result"]
    data: SimulateResultData


class EvalResultData(BaseModel):
    method: str
    # The seed(s) of the dataset(s) actually evaluated (read from the dataset's
    # meta.json) — NOT an echo of the requested seed_matrix (FIX-9: the old
    # echo claimed multi-seed coverage for a single-scene evaluation).
    seeds: list[int]
    max_size_error_mm: float
    rms_size_error_mm: float
    max_distance_error_mm: float
    max_angle_error_deg: float
    # FIX-9 headline: per-corner SE(3)-holdout error (align/score disjoint by
    # cabinet). Catches roll-about-normal and whole-wall normal rotations that
    # the center/normal/size metrics score as 0.0. None (JSON null) when the
    # dataset has < 2 cabinets — the disjoint split is undefined there and a
    # fake 0.0 would read as "perfect" (Codex review P2).
    holdout_rms_mm: float | None
    holdout_p95_mm: float | None
    holdout_max_mm: float | None


class EvalResultEvent(BaseModel):
    event: Literal["result"]
    data: EvalResultData


# ---------------------------------------------------------------------------
# compare_known — reconcile a pose report against known monitor geometry
# ---------------------------------------------------------------------------

class CompareKnownInput(BaseModel):
    command: Literal["compare_known"]
    version: Literal[1]
    report_path: str
    known_path: str
    # Optional per-key tolerance overrides (size_mm, distance_mm, angle_deg).
    # The sidecar honors these, but the current CLI / adapter / lmt-app path
    # never sends them — it always uses the spec §10.3 defaults (size≤2.0mm /
    # distance≤3.0mm / angle≤0.3°). The field is kept as forward-compat for a
    # future `--threshold` CLI flag (out of scope for Task 2.1).
    thresholds: dict[str, float] | None = None


class CabinetSizeCheck(BaseModel):
    cabinet_id: str
    size_error_mm: float
    # `pass` is a Python keyword; expose it via alias so the JSON field is `pass`.
    # serialize_by_alias makes model_dump_json emit `pass` (not `pass_`); the
    # Rust DTO and adapter both read the bare `pass` key.
    pass_: bool = Field(alias="pass")

    model_config = {"populate_by_name": True, "serialize_by_alias": True}


class PairCheck(BaseModel):
    a: str
    b: str
    distance_error_mm: float
    angle_error_deg: float
    distance_pass: bool
    angle_pass: bool


class CompareKnownResultData(BaseModel):
    cabinets: list[CabinetSizeCheck]
    pairs: list[PairCheck]
    passed: bool
    thresholds: dict[str, float]


class CompareKnownResultEvent(BaseModel):
    event: Literal["result"]
    data: CompareKnownResultData


# ---------------------------------------------------------------------------
# plan_capture — recommend camera capture stations for a screen
# ---------------------------------------------------------------------------

class CaptureIntrinsicsSpec(BaseModel):
    image_size: tuple[int, int]               # [w, h] px
    hfov_deg: float | None = None
    vfov_deg: float | None = None


class ReachableShell(BaseModel):
    standoff_min_mm: float
    standoff_max_mm: float
    height_min_mm: float
    height_max_mm: float


class PlanCaptureInput(BaseModel):
    command: Literal["plan_capture"]
    version: Literal[1]
    project: ReconstructProject               # screen_id + cabinet_array + shape_prior
    intrinsics: CaptureIntrinsicsSpec
    shell: ReachableShell
    target_p95_residual_mm: float = 3.0
    pixel_sigma_px: float = 0.3
    nominal_deviation_mm: float = 2.0
    focal_err_frac: float = 0.0
    incidence_max_deg: float = 60.0
    # Precision capture profile can demand >=3 covering views/cabinet to be reconstructable.
    # Floor is 2 (reconstruct's observation gate — a single view can never triangulate). The
    # default literal 2 is pinned to gates.MIN_VIEWS by a mirror test in test_capture_planner_gates.
    min_views: int = Field(default=2, ge=2)
    sample_grid: tuple[int, int] = (4, 4)
    n_fan: int = 5
    max_stations: int = 24
    n_standoff: int = 2
    n_height: int = 3
    n_azimuth: int = 7
    trials: int = 20
    seed: int = 0


class CaptureStationData(BaseModel):
    id: str
    position_mm: list[float]                  # [x, y, z] model frame
    look_at_mm: list[float]                   # optical axis hit on wall plane z=0
    standoff_mm: float
    height_mm: float
    role: str                                 # fan | top | bottom | added
    covers_cabinets: list[list[int]]          # [[col, row], ...]


class CabinetCoverageData(BaseModel):
    col: int
    row: int
    p95_residual_mm: float | None             # null when not reconstructable (no NaN in JSON)
    n_views: int
    total_observations: int
    reconstructable: bool
    low_observation: bool
    bridged: bool
    pass_: bool = Field(alias="pass")
    # WHY a cabinet fails (observability diagnostic, not a gate): "low_coverage"
    # (too few views/points or unbridged) vs "low_parallax" (count-reconstructable
    # but p95 over target = degenerate baseline). None when the cabinet passes. A
    # Literal so a producer typo is a validation error, not a silent wrong reason.
    fail_reason: Literal["low_coverage", "low_parallax"] | None = None

    model_config = {"populate_by_name": True, "serialize_by_alias": True}


class UnreachableRegionData(BaseModel):
    cabinets: list[list[int]]
    reason: str


class PlanCaptureResultData(BaseModel):
    stations: list[CaptureStationData]
    coverage: list[CabinetCoverageData]
    unreachable_regions: list[UnreachableRegionData]
    all_pass: bool
    target_p95_residual_mm: float


class PlanCaptureResultEvent(BaseModel):
    event: Literal["result"]
    data: PlanCaptureResultData
