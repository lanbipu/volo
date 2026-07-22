use mesh_core::{shape::CabinetArray, surface::QualityMetrics, surface::ReconstructedSurface};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct RecentProject {
    pub id: i64,
    pub abs_path: String,
    pub display_name: String,
    pub last_opened_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ProjectConfig {
    pub project: ProjectMeta,
    pub screens: BTreeMap<String, ScreenConfig>,
    pub coordinate_system: CoordinateSystemConfig,
    pub output: OutputConfig,
    /// Stage-level nDisplay output topology (unique global object for the whole
    /// stage). Prefer this over per-screen `ScreenConfig.output_topology`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_topology: Option<OutputTopology>,
    /// Rigid alignment applied to rebuilt (not nominal) meshes. Absent on legacy
    /// projects; see `docs/calibrate/rebuilt-alignment-spec.md`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rebuilt_alignment: Option<RebuiltAlignment>,
    /// Stage cameras for lens calibration (pose / lens / tracking). Absent on
    /// legacy projects; see `docs/calibrate/lens-calibration-redesign-spec.md` §8.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cameras: Vec<ProjectCamera>,
}

/// One stage camera persisted in `project.yaml` (`cameras:` list).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ProjectCamera {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lens: Option<ProjectCameraLens>,
    /// `null` / omitted = no tracking (fixed pose).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tracking: Option<ProjectCameraTracking>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video_profile_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manual_pose: Option<ProjectCameraPose>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub solve_pose: Option<ProjectCameraPose>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_run_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ProjectCameraLens {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sensor_w_mm: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sensor_h_mm: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focal_mm: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub k1: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub k2: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub k3: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cx: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cy: Option<f64>,
    /// Independently calibrated pixel-domain profile used by formal fixed-pose
    /// solves. Numeric/manual fields above are display/edit values only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_path: Option<String>,
    #[serde(default)]
    pub is_master: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calibration_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_size: Option<[u32; 2]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calibration_rms_px: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calibration_poses: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calibration_points: Option<u32>,
    #[serde(default)]
    pub session_coupled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ProjectCameraTracking {
    pub protocol: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub camera_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ProjectCameraPose {
    pub t_mm: [f64; 3],
    pub euler_deg: [f64; 3],
    /// Legacy poses omit this and are never eligible for formal AR/export.
    #[serde(default)]
    pub formal: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_artifact: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rms_reprojection_px: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_size: Option<[u32; 2]>,
    #[serde(default)]
    pub preflight_passed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema_version: Option<String>,
    #[serde(default)]
    pub qualification_passed: bool,
    #[serde(default)]
    pub master_lens: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub solve_kind: Option<String>,
    #[serde(default)]
    pub fail_closed: bool,
}

/// Per-project rebuilt-mesh alignment groups (`A` in `P_s = A ∘ B_s`).
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct RebuiltAlignment {
    pub groups: Vec<RebuiltAlignmentGroup>,
}

impl<'de> Deserialize<'de> for RebuiltAlignment {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        struct Raw {
            groups: Vec<RebuiltAlignmentGroup>,
        }
        let raw = Raw::deserialize(d)?;
        validate_alignment_groups(&raw.groups).map_err(serde::de::Error::custom)?;
        Ok(Self {
            groups: raw.groups,
        })
    }
}

fn validate_alignment_groups(groups: &[RebuiltAlignmentGroup]) -> Result<(), String> {
    let mut seen = std::collections::BTreeSet::new();
    for (gi, g) in groups.iter().enumerate() {
        if g.screens.is_empty() {
            return Err(format!("rebuilt_alignment.groups[{gi}]: screens must be non-empty"));
        }
        for sid in &g.screens {
            if !seen.insert(sid.clone()) {
                return Err(format!(
                    "screen '{sid}' appears in more than one rebuilt_alignment group"
                ));
            }
        }
    }
    Ok(())
}

/// One joint (or single-screen) rebuilt alignment entry.
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct RebuiltAlignmentGroup {
    pub screens: Vec<String>,
    /// Row-major 3×3 rotation (right-handed orthonormal).
    pub rotation: [[f64; 3]; 3],
    pub t_m: [f64; 3],
    pub ref_points: RebuiltAlignmentRefPoints,
    /// Path to the joint `*_screen_transforms.json` used when applied; null for
    /// single-screen groups.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub solve_ref: Option<String>,
    pub applied_at: String,
}

#[derive(Deserialize)]
struct RebuiltAlignmentGroupRaw {
    screens: Vec<String>,
    rotation: [[f64; 3]; 3],
    t_m: [f64; 3],
    ref_points: RebuiltAlignmentRefPoints,
    #[serde(default)]
    solve_ref: Option<String>,
    applied_at: String,
}

impl<'de> Deserialize<'de> for RebuiltAlignmentGroup {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let raw = RebuiltAlignmentGroupRaw::deserialize(d)?;
        mesh_core::rigid::RigidTransform::validate_rotation(&raw.rotation)
            .map_err(serde::de::Error::custom)?;
        for (i, v) in raw.t_m.iter().enumerate() {
            if !v.is_finite() {
                return Err(serde::de::Error::custom(format!(
                    "t_m[{i}] is not finite: {v}"
                )));
            }
        }
        Ok(Self {
            screens: raw.screens,
            rotation: raw.rotation,
            t_m: raw.t_m,
            ref_points: raw.ref_points,
            solve_ref: raw.solve_ref,
            applied_at: raw.applied_at,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct RebuiltAlignmentRefPoints {
    pub origin: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x_axis: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub xy_plane: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ProjectMeta {
    pub name: String,
    pub unit: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<SurveyMethod>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum SurveyMethod {
    M1,
    M2,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ScreenConfig {
    pub cabinet_count: [u32; 2],
    pub cabinet_size_mm: [f64; 2],
    #[serde(default)]
    pub pixels_per_cabinet: Option<[u32; 2]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_topology: Option<OutputTopology>,
    pub shape_prior: ShapePriorConfig,
    pub shape_mode: ShapeMode,
    #[serde(default)]
    pub irregular_mask: Vec<[u32; 2]>,
    #[serde(default)]
    pub bottom_completion: Option<BottomCompletionConfig>,
    /// World-space placement for multi-screen stages. Defaults to the origin
    /// with no rotation so pre-existing `project.yaml` files (no such field)
    /// keep loading unchanged.
    #[serde(default)]
    pub position_m: [f64; 3],
    /// Rotation about the model-frame Z axis (the wall's own "up", i.e. the row
    /// axis — not world Y), in degrees. See `mesh_app::placement::nominal_placement`.
    #[serde(default)]
    pub yaw_deg: f64,
    /// Bottom-edge height off the ground, in millimetres. Applied as an extra
    /// world-Z translation alongside `position_m` (see `nominal_placement`);
    /// defaults to 0 so pre-existing `project.yaml` files keep loading unchanged.
    #[serde(default)]
    pub height_offset_mm: f64,
    /// Reverse the screen's presentation-side normal. This is authored by the
    /// Calibrate viewport and persisted with the rest of the screen design.
    #[serde(default)]
    pub normal_flip: bool,
    /// True after the authored origin reference vertex has been translated to
    /// the world-space origin. Legacy projects default to false.
    #[serde(default)]
    pub origin_aligned: bool,
}

/// nDisplay `renderSyncPolicy.type`. Software ethernet barrier is the default
/// so sequence playback (and static show) present-align across cluster nodes.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, JsonSchema, Default)]
#[serde(rename_all = "snake_case")]
pub enum RenderSyncPolicy {
    None,
    #[default]
    EthernetBarrier,
}

impl RenderSyncPolicy {
    /// Value written into `.ndisplay` `renderSyncPolicy.type`.
    pub fn as_ndisplay_type(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::EthernetBarrier => "ethernet_barrier",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema, Default)]
pub struct OutputTopology {
    pub nodes: Vec<OutputNode>,
    /// Cluster present alignment. Absent in legacy project.yaml → ethernet_barrier.
    #[serde(default)]
    pub render_sync: RenderSyncPolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
pub struct OutputNode {
    pub node_id: String,
    pub machine: MachineRef,
    pub viewport_rect_px: [u32; 4],
    pub window_px: [u32; 2],
    /// Top-left corner of the output window on the node's virtual desktop.
    /// Signed because secondary monitors can sit at negative coordinates.
    /// Defaults to [40, 40] so topologies saved before this field existed keep
    /// the historical placement.
    #[serde(default = "default_window_origin_px")]
    pub window_origin_px: [i32; 2],
    pub fullscreen: bool,
    pub primary: bool,
}

fn default_window_origin_px() -> [i32; 2] {
    [40, 40]
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
pub struct MachineRef {
    pub hostname: String,
    pub ip: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ShapePriorConfig {
    Flat,
    Curved {
        radius_mm: f64,
        #[serde(default)]
        fold_seams_at_columns: Vec<u32>,
    },
    Folded {
        fold_seams_at_columns: Vec<u32>,
    },
    /// Symmetric arc: a flat center span, then a constant per-column turn
    /// angle accumulating outward on both sides.
    Arc {
        center_flat_cols: u32,
        angle_per_col_deg: f64,
    },
    /// Two straight legs meeting at one corner. `right_cols` (the second
    /// leg's length) is derived as `total_cols - left_cols - soften_cols`
    /// by the geometry generator, not stored here.
    LShape {
        left_cols: u32,
        #[serde(default)]
        soften_cols: u32,
        corner_angle_deg: f64,
    },
    /// Two symmetric corners (a center span flanked by two equal wings).
    UShape {
        wing_cols: u32,
        #[serde(default)]
        soften_cols: u32,
        corner_angle_deg: f64,
    },
    /// Explicit column-run segments, each carrying the cumulative turn
    /// angle in effect for that run. Segment `cols` must sum to the
    /// screen's total column count.
    CustomSegments { segments: Vec<ShapeSegment> },
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ShapeSegment {
    pub cols: u32,
    pub cum_angle_deg: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ShapeMode {
    Rectangle,
    Irregular,
}

/// mesh-core 的 `SamplingMode` 镜像，用于 schema dump（core 不派生 JsonSchema）。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SamplingModeInfo {
    Grid,
    Scatter,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct BottomCompletionConfig {
    pub lowest_measurable_row: u32,
    pub fallback_method: String,
    pub assumed_height_mm: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CoordinateSystemConfig {
    pub origin_point: String,
    pub x_axis_point: String,
    pub xy_plane_point: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct OutputConfig {
    pub target: String,
    pub obj_filename: String,
    pub weld_vertices_tolerance_mm: f64,
    pub triangulate: bool,
}

// ── Scatter-fit DTO types ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", tag = "shape")]
pub enum ScatterShapeInfo {
    Plane { normal: [f64; 3] },
    Cylinder { radius_mm: f64, axis: [f64; 3] },
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ScatterOutlierInfo {
    pub point_id: String,
    pub source_row: usize,
    pub coordinates: [f64; 3],
    pub residual_mm: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct FrameDerivationInfo {
    pub axis: [f64; 3],
    pub origin: [f64; 3],
    pub unwrap_dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct BoundaryCheckInfo {
    pub verdict: String,
    pub projected_size_mm: [f64; 2],
    pub expected_size_mm: [f64; 2],
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ScatterFitInfo {
    pub shape: ScatterShapeInfo,
    pub inlier_count: usize,
    pub outliers: Vec<ScatterOutlierInfo>,
    pub param_range: [f64; 4],
    pub boundary_check: BoundaryCheckInfo,
    pub frame_derivation: FrameDerivationInfo,
}

impl From<mesh_core::reconstruct::surface_fit::ScatterFit> for ScatterFitInfo {
    fn from(c: mesh_core::reconstruct::surface_fit::ScatterFit) -> Self {
        use mesh_core::reconstruct::surface_fit::ScatterShape as S;
        ScatterFitInfo {
            shape: match c.shape {
                S::Plane { normal } => ScatterShapeInfo::Plane { normal },
                S::Cylinder { radius_mm, axis } => ScatterShapeInfo::Cylinder { radius_mm, axis },
            },
            inlier_count: c.inlier_count,
            outliers: c
                .outliers
                .into_iter()
                .map(|o| ScatterOutlierInfo {
                    point_id: o.point_id,
                    source_row: o.source_row,
                    coordinates: o.coordinates,
                    residual_mm: o.residual_mm,
                })
                .collect(),
            param_range: c.param_range,
            boundary_check: BoundaryCheckInfo {
                verdict: c.boundary_check.verdict,
                projected_size_mm: c.boundary_check.projected_size_mm,
                expected_size_mm: c.boundary_check.expected_size_mm,
            },
            frame_derivation: FrameDerivationInfo {
                axis: c.frame_derivation.axis,
                origin: c.frame_derivation.origin,
                unwrap_dir: c.frame_derivation.unwrap_dir,
            },
        }
    }
}

// ── Reconstruction types ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct ReconstructionResult {
    pub run_id: i64,
    pub surface: ReconstructedSurface,
    pub report_json_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ReconstructionRun {
    pub id: i64,
    pub screen_id: String,
    pub method: String,
    /// FIX-12: 真实拟合残差 RMS(mm);精确插值方法无 holdout 时为 None。
    #[serde(default)]
    pub estimated_rms_mm: Option<f64>,
    pub vertex_count: i64,
    pub target: Option<String>,
    pub output_obj_path: Option<String>,
    pub created_at: String,
    /// Explicit "pinned as current" flag (§ set_current_run). When no run
    /// for a (project_path, screen_id) pair has this set, callers fall back
    /// to the most recent by `created_at` — same as before this field
    /// existed, so older DBs need no backfill.
    #[serde(default)]
    pub is_current: bool,
    /// Path to `visual_solve_digest.v1` JSON (visual BA runs only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visual_solve_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReconstructionReport {
    pub surface: ReconstructedSurface,
    pub quality_metrics: QualityMetrics,
    pub project_path: String,
    pub screen_id: String,
    pub measurements_path: String,
    pub created_at: String,
    /// Cabinet array snapshot captured at reconstruction time.
    /// Export uses this instead of re-reading project.yaml.
    pub cabinet_array: CabinetArray,
    /// Weld tolerance (mm) snapshot captured at reconstruction time.
    pub weld_tolerance_mm: f64,
    /// Scatter 路径的拟合元数据；grid 路径为 None。
    #[serde(default)]
    pub scatter_fit: Option<ScatterFitInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TotalStationImportResult {
    /// 相对 project_abs_path 的路径，e.g. "measurements/measured.yaml"
    pub measurements_yaml_path: String,
    /// 相对 project_abs_path 的路径
    pub report_json_path: String,
    pub measured_count: usize,
    pub fabricated_count: usize,
    pub outlier_count: usize,
    pub missing_count: usize,
    pub warnings: Vec<String>,
}

// ── Visual reconstruction (camera-branch) DTO types ──────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CabinetPoseSummary {
    pub cabinet_id: String,
    pub position_mm: [f64; 3],
    pub normal: [f64; 3],
    pub reprojection_rms_px: f64,
    pub observed_views: u32,
    /// Pose-report `observed_points`; older summaries omit → 0.
    #[serde(default)]
    pub observed_points: u32,
    pub quality: String,
}

fn default_intrinsics_source() -> String {
    "file".to_string()
}

/// One non-fatal warning surfaced by a sidecar-backed command. The sidecar emits these
/// as streaming `WarningEvent`s; the adapter collects them off the event stream and rides
/// them on the result so they survive the headless CLI path (where no progress consumer is
/// attached and the live events would otherwise be dropped). Codes today: `no_intrinsics_anchor`,
/// `high_rejection`, `cabinet_quality`, `missing_covariance`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct WarningDto {
    pub code: String,
    pub message: String,
    #[serde(default)]
    pub cabinet: Option<String>,
}

/// Per-screen digest for joint multi-screen visual reconstruct.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct VisualScreenSummary {
    pub screen_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pose_report_path: Option<String>,
    pub ba_rms_px: f64,
    pub cabinet_count: usize,
    #[serde(default)]
    pub bridge_views: usize,
    #[serde(default)]
    pub cabinets: Vec<CabinetPoseSummary>,
}

/// `visual_screen_transforms.v1` — joint-frame SE(3) of each screen relative
/// to `frame_screen_id` (first screen / gauge).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ScreenTransformsFile {
    pub schema_version: String,
    pub frame_screen_id: String,
    pub transforms: Vec<ScreenTransformEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ScreenTransformEntry {
    pub screen_id: String,
    /// 3×3 rotation (row-major nested arrays). Sidecar field name is `R`.
    #[serde(rename = "R")]
    pub rotation: [[f64; 3]; 3],
    pub t_mm: [f64; 3],
    pub rms_px: f64,
    pub bridge_views: usize,
}

/// FIX-13 ④: `measured_yaml_path` 字段已删除 —— visual 重建不再写
/// `measurements/measured.yaml`（旧行为会覆盖 M1 全站仪数据，且写出的点名
/// 与 core 重建器永不兼容）。持久化产物只有 `pose_report_path`，逐箱体
/// 协方差在 pose report 的 `covariance_mm2` 字段。
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct VisualReconstructResult {
    pub screen_id: String,
    pub pose_report_path: String,
    pub cabinet_count: usize,
    pub ba_rms_px: f64,
    pub ba_observations_total: usize,
    pub ba_observations_used: usize,
    pub ba_rejected: usize,
    /// align_to_nominal 把整墙刚体配准到 nominal 设计帧的对齐残差（米）。
    /// SL 路径 > 0（残差越大说明 as-built 与 nominal 偏差越大 / shape_prior 可能选错）；
    /// charuco/fix_root_cabinet 路径恒为 0（不做配准）。
    #[serde(default)]
    pub procrustes_align_rms_m: f64,
    /// "file" (provided intrinsics) | "auto_self_calibrated" (--intrinsics auto).
    #[serde(default = "default_intrinsics_source")]
    pub intrinsics_source: String,
    /// Non-fatal warnings collected from the sidecar run (e.g. `no_intrinsics_anchor` when
    /// `--intrinsics auto` self-calibrated without an anchor, `high_rejection`/`cabinet_quality`/
    /// `missing_covariance` per cabinet). Empty = clean run. See [`WarningDto`].
    #[serde(default)]
    pub warnings: Vec<WarningDto>,
    pub cabinets: Vec<CabinetPoseSummary>,
    /// Joint multi-screen: path to `visual_screen_transforms.v1` JSON.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screen_transforms_path: Option<String>,
    /// Joint multi-screen: per-screen summaries (None for single-screen).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screens: Option<Vec<VisualScreenSummary>>,
    /// Basenames of photos with no markers (ignored by BA).
    #[serde(default)]
    pub ignored_photos: Vec<String>,
    #[serde(default)]
    pub photos_used: u32,
    #[serde(default)]
    pub photos_total: u32,
}

/// Durable visual-BA solve digest for the「重建记录」UI (timestamped, not overwritten).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct VisualSolveDigest {
    pub schema_version: String,
    /// success | partial | failed
    pub status: String,
    #[serde(default)]
    pub empty: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ba_rms_px: Option<f64>,
    pub photos_used: u32,
    pub photos_total: u32,
    pub observation_points: usize,
    pub finished_at: String,
    #[serde(default)]
    pub ignored_photos: Vec<String>,
    pub ref_screen_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screen_transforms_path: Option<String>,
    pub screens: Vec<VisualSolveScreenDigest>,
    #[serde(default)]
    pub warnings: Vec<WarningDto>,
    #[serde(default = "default_intrinsics_source")]
    pub intrinsics_source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct VisualSolveScreenDigest {
    pub screen_id: String,
    pub ba_rms_px: f64,
    /// ok | warn | fail
    pub status: String,
    pub n_ok: usize,
    pub n_warn: usize,
    pub n_fail: usize,
    pub cabinets: Vec<VisualSolveCabinetDigest>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct VisualSolveCabinetDigest {
    pub cabinet_id: String,
    pub observed_views: u32,
    pub observed_points: u32,
    /// ok | warn | fail (UI tri-state; mapped from pose-report quality)
    pub quality: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SimulateResult {
    pub dataset_dir: String,
    pub n_views: u32,
    pub n_observations: u32,
    pub seed: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct EvalResult {
    pub method: String,
    pub max_size_error_mm: f64,
    pub rms_size_error_mm: f64,
    pub max_distance_error_mm: f64,
    pub max_angle_error_deg: f64,
    /// FIX-9 headline: per-corner SE(3)-holdout error (align/score split
    /// disjoint by cabinet) — non-zero for roll-about-normal / whole-wall
    /// normal rotations that the legacy metrics score as 0.0. `None` (JSON
    /// null) when the dataset has < 2 cabinets: the disjoint split is
    /// undefined there and a fake 0.0 would read as "perfect".
    pub holdout_rms_mm: Option<f64>,
    pub holdout_p95_mm: Option<f64>,
    pub holdout_max_mm: Option<f64>,
    /// Seed(s) of the dataset(s) actually evaluated (from the dataset's
    /// meta.json), NOT an echo of the requested seed_matrix (FIX-9).
    pub seeds: Vec<i64>,
}

/// Per-cabinet size reconciliation: reconstructed size (from corners) vs known.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CabinetSizeCheck {
    pub cabinet_id: String,
    pub size_error_mm: f64,
    #[serde(rename = "pass")]
    pub pass: bool,
}

/// Per-pair distance/angle reconciliation against known monitor geometry.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PairCheck {
    pub a: String,
    pub b: String,
    pub distance_error_mm: f64,
    pub angle_error_deg: f64,
    pub distance_pass: bool,
    pub angle_pass: bool,
}

/// Result of reconciling a cabinet_pose_report against known monitor geometry
/// (size from corners, distance from positions, angle from normals).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CompareKnownResult {
    pub cabinets: Vec<CabinetSizeCheck>,
    pub pairs: Vec<PairCheck>,
    pub passed: bool,
    pub thresholds: BTreeMap<String, f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CalibrateResult {
    pub intrinsics_path: String,
    pub reproj_error_px: f64,
    pub frames_used: u32,
    /// "radial2" (k1,k2) | "full" (k1,k2,k3+tangential). The checkerboard `visual
    /// calibrate` path calls cv2.calibrateCamera with no CALIB_FIX flags, so it is "full".
    #[serde(default)]
    pub distortion_model: String,
    #[serde(default)]
    pub focal_stddev_px: Option<[f64; 2]>,
    #[serde(default)]
    pub pp_stddev_px: Option<[f64; 2]>,
    /// Non-fatal warnings collected from the sidecar run (e.g. `no_intrinsics_anchor` when
    /// `--intrinsics-crosscheck` was omitted on a curved wall). Empty = clean run.
    #[serde(default)]
    pub warnings: Vec<WarningDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct GeneratePatternResult {
    pub output_dir: String,
    pub cabinet_count: usize,
    /// Total ArUco markers across all cabinets (per-cabinet counts vary in v2).
    pub total_markers: u32,
    /// Non-fatal warnings from generation (FIX-7: `low_marker_count` when a
    /// cabinet carries 4..7 VP-QSP markers — it then needs >= 2 covering views
    /// to clear the runtime observability gate). Durable on the headless path.
    #[serde(default)]
    pub warnings: Vec<WarningDto>,
}

/// `lmt visual generate-structured-light` 结果：点阵序列生成到
/// `patterns/<screen_id>/sl/`(frames + sequence.mp4 + sl_meta.json)。
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct GenerateStructuredLightResult {
    pub output_dir: String,
    pub n_dots: usize,
    pub n_frames: usize,
}

/// `lmt visual decode-structured-light` 结果：解码出的屏幕↔相机对应文件路径
/// 与解码成功的点数。
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DecodeStructuredLightResult {
    pub output_path: String,
    pub n_dots_decoded: usize,
}

// ── Pose-OBJ export DTO types ─────────────────────────────────────────────────

/// pose report 的 `frame.gauge_strategy` 帧版本位。
/// `fix_root_cabinet` = 旧的根箱体局部帧（导出需猜朝向）；
/// `align_to_nominal` = 已稳健配准到 nominal 设计帧（导出跳过猜测）。
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PoseReportGauge {
    #[default]
    FixRootCabinet,
    AlignToNominal,
}

/// 读 `cabinet_pose_report.json` 的 `frame` 帧版本位（其余 frame 字段忽略）。
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct PoseReportFrame {
    #[serde(default)]
    pub gauge_strategy: PoseReportGauge,
}

/// 读 `cabinet_pose_report.json`（visual reconstruct 产出）用的精简视图，
/// 只取导出 OBJ 需要的字段。完整 schema 见 python-sidecar 的 `CabinetPoseReport`。
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CabinetPoseReportFile {
    pub schema_version: String,
    #[serde(default)]
    pub frame: PoseReportFrame,
    pub cabinet_poses: Vec<CabinetPoseEntry>,
}

/// 单块 cabinet 的 4 个世界系角点（mm，顺序 BL,BR,TR,TL）。
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CabinetPoseEntry {
    pub cabinet_id: String,
    pub corners_mm: [[f64; 3]; 4],
    /// Views that observed this cabinet (from full pose report). Absent in
    /// older reports → 0; callers that need a camera_count floor use max(..., 1).
    #[serde(default)]
    pub observed_views: u32,
    /// FIX-13 ④: BA 输出的逐箱体 3×3 平移协方差（mm²，箱体中心）。
    /// 旧 report / 协方差不可用（>2400 参数跳过等）时为 None。
    /// 此前协方差只活在被覆盖的 measured.yaml 死端里——现在 pose report
    /// 是它的唯一持久化位置。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub covariance_mm2: Option<[[f64; 3]; 3]>,
}

/// FIX-13 ③: python-sidecar `screen_mapping.json` 的最小消费视图——导出端
/// 只需要 cabinet_id + input_rect_px（其余字段容忍并忽略）。完整 schema 见
/// python-sidecar 的 `ScreenMapping` pydantic model。
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ScreenMappingFile {
    #[serde(default)]
    pub screen_id: Option<String>,
    pub cabinets: Vec<ScreenMappingCabinetRect>,
}

/// screen_mapping 中单块 cabinet 在输入画布上的 feed 矩形。
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ScreenMappingCabinetRect {
    pub cabinet_id: String,
    /// `[x, y, w, h]`，像素，画布原点在左上、y 向下（与 disguise feed 约定一致）。
    pub input_rect_px: [i64; 4],
}

/// `lmt export pose-obj` 结果。
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ExportPoseObjResult {
    pub target: String,
    pub cabinet_count: usize,
    /// 合并模式：单个 OBJ 路径。`--split` 模式时为输出目录。
    pub file: String,
    /// `--split` 模式：per-cabinet OBJ 路径列表。合并模式时为空。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<String>,
}

// ── W6 R1: M1(total-station)+ M2(visual BA) fuse DTO types ───────────────────

/// Per-anchor alignment residual (mm) — one row per matched grid-vertex point.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct FuseAnchorResidual {
    /// Grid-vertex point name shared by both sides, e.g. `MAIN_V001_R001`.
    pub point_name: String,
    pub residual_mm: f64,
    pub delta_mm: [f64; 3],
}

/// `lmt fuse run` 结果:视觉重建(M2 cabinet_pose_report)对齐到全站仪
/// 测点(M1 measured.yaml)的刚体/相似变换 + 逐锚点残差。
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct FuseResult {
    pub screen_id: String,
    /// 参与配准的锚点数(两侧按 grid-vertex 命名匹配上的点)。
    pub anchor_count: usize,
    /// 3×3 旋转矩阵(行主序)。
    pub rotation: [[f64; 3]; 3],
    pub translation_mm: [f64; 3],
    /// 相似变换缩放因子。`scale_locked=true` 时恒为 1.0。
    pub scale: f64,
    /// `--allow-scale` 未传时为 true(scale 锁 1.0,不吸收系统性误差)。
    pub scale_locked: bool,
    pub anchor_residuals: Vec<FuseAnchorResidual>,
    pub anchor_rms_mm: f64,
    /// 对齐后的 cabinet_pose_report 副本路径(全部角点 + 协方差已变换)。
    pub fused_pose_report_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InstructionCardResult {
    /// HTML 字符串，前端 iframe srcdoc 渲染。PDF 通过单独的
    /// `save_instruction_pdf` 命令按用户选定的目标路径写盘。
    pub html_content: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pose_report_file_frame_defaults_to_fix_root() {
        let old = r#"{"schema_version":"visual_pose_report.v1","cabinet_poses":[]}"#;
        let r: CabinetPoseReportFile = serde_json::from_str(old).unwrap();
        assert_eq!(r.frame.gauge_strategy, PoseReportGauge::FixRootCabinet);
    }

    #[test]
    fn pose_report_file_reads_align_to_nominal() {
        // Real reports carry extra frame fields (type/units/handedness/...) — ignored.
        let s = r#"{"schema_version":"visual_pose_report.v1",
            "frame":{"type":"screen_local","gauge_strategy":"align_to_nominal",
                     "root_cabinet":[0,0],"units":"mm","handedness":"right","z_axis":"outward"},
            "cabinet_poses":[]}"#;
        let r: CabinetPoseReportFile = serde_json::from_str(s).unwrap();
        assert_eq!(r.frame.gauge_strategy, PoseReportGauge::AlignToNominal);
    }

    #[test]
    fn new_shape_prior_variants_match_frontend_wire_format() {
        // { type: "arc"|"l_shape"|"u_shape"|"custom_segments", ... } — must match
        // src/volo/api/types.ts's discriminated union exactly (tag = "type").
        let arc = ShapePriorConfig::Arc { center_flat_cols: 2, angle_per_col_deg: 9.0 };
        let json = serde_json::to_string(&arc).unwrap();
        assert_eq!(json, r#"{"type":"arc","center_flat_cols":2,"angle_per_col_deg":9.0}"#);

        let l = ShapePriorConfig::LShape { left_cols: 4, soften_cols: 1, corner_angle_deg: 90.0 };
        let json = serde_json::to_string(&l).unwrap();
        assert_eq!(
            json,
            r#"{"type":"l_shape","left_cols":4,"soften_cols":1,"corner_angle_deg":90.0}"#
        );

        let u = ShapePriorConfig::UShape { wing_cols: 3, soften_cols: 1, corner_angle_deg: 90.0 };
        let json = serde_json::to_string(&u).unwrap();
        assert_eq!(
            json,
            r#"{"type":"u_shape","wing_cols":3,"soften_cols":1,"corner_angle_deg":90.0}"#
        );

        let custom = ShapePriorConfig::CustomSegments {
            segments: vec![ShapeSegment { cols: 3, cum_angle_deg: 0.0 }],
        };
        let json = serde_json::to_string(&custom).unwrap();
        let back: ShapePriorConfig = serde_json::from_str(&json).unwrap();
        assert!(matches!(back, ShapePriorConfig::CustomSegments { segments } if segments.len() == 1));
    }

    #[test]
    fn screen_config_defaults_position_and_yaw_when_absent_from_yaml() {
        // Screens saved before position_m/yaw_deg existed must still load.
        let yaml = r#"
cabinet_count: [4, 2]
cabinet_size_mm: [500.0, 500.0]
shape_prior: { type: flat }
shape_mode: rectangle
"#;
        let cfg: ScreenConfig = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(cfg.position_m, [0.0, 0.0, 0.0]);
        assert_eq!(cfg.yaw_deg, 0.0);
        assert!(!cfg.origin_aligned);
        assert!(cfg.output_topology.is_none());
    }

    #[test]
    fn visual_dtos_roundtrip() {
        // VisualReconstructResult
        let cabinet = CabinetPoseSummary {
            cabinet_id: "MAIN_V001_R001".into(),
            position_mm: [100.0, 200.0, 300.0],
            normal: [0.0, 0.0, 1.0],
            reprojection_rms_px: 0.42,
            observed_views: 8,
            observed_points: 120,
            quality: "good".into(),
        };
        let vr = VisualReconstructResult {
            screen_id: "MAIN".into(),
            pose_report_path: "measurements/pose_report.json".into(),
            cabinet_count: 1,
            ba_rms_px: 0.35,
            ba_observations_total: 96,
            ba_observations_used: 94,
            ba_rejected: 2,
            procrustes_align_rms_m: 0.0017,
            intrinsics_source: "file".into(),
            warnings: vec![WarningDto {
                code: "no_intrinsics_anchor".into(),
                message: "auto intrinsics solved without an independent anchor".into(),
                cabinet: None,
            }],
            cabinets: vec![cabinet],
            screen_transforms_path: None,
            screens: None,
            ignored_photos: vec!["DSC04412.ARW".into()],
            photos_used: 42,
            photos_total: 45,
        };
        let json = serde_json::to_string(&vr).unwrap();
        assert!(json.contains("\"screen_id\":\"MAIN\""));
        assert!(json.contains("\"ba_rms_px\":0.35"));
        let back: VisualReconstructResult = serde_json::from_str(&json).unwrap();
        assert_eq!(back.screen_id, "MAIN");
        assert_eq!(back.cabinets[0].cabinet_id, "MAIN_V001_R001");
        assert_eq!(back.cabinets[0].observed_views, 8);
        // warnings survive the round-trip (the headless contract): WarningDto derives serde.
        assert_eq!(back.warnings.len(), 1);
        assert_eq!(back.warnings[0].code, "no_intrinsics_anchor");
        assert_eq!(back.warnings[0].cabinet, None);

        // SimulateResult
        let sim = SimulateResult {
            dataset_dir: "/tmp/sim".into(),
            n_views: 12,
            n_observations: 480,
            seed: 42,
        };
        let sim_json = serde_json::to_string(&sim).unwrap();
        let sim_back: SimulateResult = serde_json::from_str(&sim_json).unwrap();
        assert_eq!(sim_back.seed, 42);

        // EvalResult
        let eval = EvalResult {
            method: "visual".into(),
            max_size_error_mm: 1.5,
            rms_size_error_mm: 0.9,
            max_distance_error_mm: 2.0,
            max_angle_error_deg: 0.3,
            holdout_rms_mm: Some(0.7),
            holdout_p95_mm: Some(1.2),
            holdout_max_mm: Some(1.9),
            seeds: vec![1, 2, 3],
        };
        let eval_json = serde_json::to_string(&eval).unwrap();
        let eval_back: EvalResult = serde_json::from_str(&eval_json).unwrap();
        assert_eq!(eval_back.seeds, vec![1, 2, 3]);

        // CalibrateResult
        let cal = CalibrateResult {
            intrinsics_path: "intrinsics.yaml".into(),
            reproj_error_px: 0.25,
            frames_used: 30,
            distortion_model: "radial2".into(),
            focal_stddev_px: Some([0.4, 0.4]),
            pp_stddev_px: Some([1.1, 1.2]),
            warnings: vec![],
        };
        let cal_json = serde_json::to_string(&cal).unwrap();
        let cal_back: CalibrateResult = serde_json::from_str(&cal_json).unwrap();
        assert_eq!(cal_back.frames_used, 30);

        // GeneratePatternResult
        let gp = GeneratePatternResult {
            output_dir: "/tmp/patterns".into(),
            cabinet_count: 12,
            total_markers: 480,
            warnings: vec![WarningDto {
                code: "low_marker_count".into(),
                message: "V000_R000(4)".into(),
                cabinet: None,
            }],
        };
        let gp_json = serde_json::to_string(&gp).unwrap();
        let gp_back: GeneratePatternResult = serde_json::from_str(&gp_json).unwrap();
        assert_eq!(gp_back.cabinet_count, 12);
        // FIX-7 warnings survive the round-trip (headless contract), and the
        // serde(default) keeps pre-FIX-7 JSON (no warnings key) deserializable.
        assert_eq!(gp_back.warnings.len(), 1);
        let legacy: GeneratePatternResult = serde_json::from_str(
            r#"{"output_dir":"/tmp/p","cabinet_count":1,"total_markers":8}"#).unwrap();
        assert!(legacy.warnings.is_empty());

        // Verify schemas are generated without panic (schemars::schema_for! is compile-time;
        // exercising dump_all() covers this at runtime).
        let dump = crate::schema::dump_all();
        for name in [
            "VisualReconstructResult",
            "CabinetPoseSummary",
            "SimulateResult",
            "EvalResult",
            "CalibrateResult",
            "GeneratePatternResult",
        ] {
            assert!(
                dump["types"][name].is_object(),
                "schema missing for {name}"
            );
        }
    }

    #[test]
    fn scatter_fit_info_from_core_roundtrips_and_has_schema() {
        use mesh_core::reconstruct::surface_fit::{
            BoundaryCheck, FrameDerivation, ScatterFit, ScatterOutlier, ScatterShape,
        };
        let core = ScatterFit {
            shape: ScatterShape::Cylinder {
                radius_mm: 9523.0,
                axis: [0.0, 0.0, 1.0],
            },
            inlier_count: 120,
            outliers: vec![ScatterOutlier {
                point_id: "row6_LEDB-1".into(),
                source_row: 6,
                coordinates: [1.0, 2.0, 3.0],
                residual_mm: 4.2,
            }],
            param_range: [-1.4, 1.4, 0.0, 7.5],
            boundary_check: BoundaryCheck {
                verdict: "ok".into(),
                projected_size_mm: [27480.0, 7500.0],
                expected_size_mm: [27500.0, 7500.0],
            },
            frame_derivation: FrameDerivation {
                axis: [0.0, 0.0, 1.0],
                origin: [0.0, 0.0, 0.0],
                unwrap_dir: "theta".into(),
            },
        };
        let dto: ScatterFitInfo = core.into();
        assert_eq!(dto.outliers[0].point_id, "row6_LEDB-1");
        let dump = crate::schema::dump_all();
        assert!(dump["types"]["ScatterFitInfo"].is_object());
    }
}

#[cfg(test)]
mod method_tests {
    use super::*;

    fn parse(yaml: &str) -> ProjectConfig {
        serde_yaml::from_str(yaml).unwrap()
    }

    const BASE: &str = r#"
project:
  name: Test
  unit: mm
{method_line}
screens:
  MAIN:
    cabinet_count: [4, 2]
    cabinet_size_mm: [500, 500]
    shape_prior:
      type: flat
    shape_mode: rectangle
    irregular_mask: []
coordinate_system:
  origin_point: MAIN_V001_R001
  x_axis_point: MAIN_V004_R001
  xy_plane_point: MAIN_V001_R002
output:
  target: disguise
  obj_filename: "{screen_id}.obj"
  weld_vertices_tolerance_mm: 1.0
  triangulate: true
"#;

    fn build(method_line: &str) -> String {
        BASE.replace("{method_line}", method_line)
    }

    #[test]
    fn method_missing_yaml_parses_as_none() {
        let cfg = parse(&build(""));
        assert_eq!(cfg.project.method, None);
    }

    #[test]
    fn method_null_yaml_parses_as_none() {
        let cfg = parse(&build("  method: null"));
        assert_eq!(cfg.project.method, None);
    }

    #[test]
    fn method_m1_yaml_roundtrips() {
        let cfg = parse(&build("  method: m1"));
        assert_eq!(cfg.project.method, Some(SurveyMethod::M1));
        let s = serde_yaml::to_string(&cfg).unwrap();
        assert!(s.contains("method: m1"), "serialized form: {}", s);
    }

    #[test]
    fn method_m2_yaml_roundtrips() {
        let cfg = parse(&build("  method: m2"));
        assert_eq!(cfg.project.method, Some(SurveyMethod::M2));
        let s = serde_yaml::to_string(&cfg).unwrap();
        assert!(s.contains("method: m2"), "serialized form: {}", s);
    }

    #[test]
    fn method_invalid_value_errors() {
        let result: Result<ProjectConfig, _> = serde_yaml::from_str(&build("  method: m3"));
        assert!(result.is_err());
    }

    #[test]
    fn none_omitted_on_serialize() {
        let cfg = parse(&build(""));
        let s = serde_yaml::to_string(&cfg).unwrap();
        assert!(!s.contains("method:"), "expected method field omitted, got: {}", s);
    }

    #[test]
    fn rebuilt_alignment_absent_omitted_on_roundtrip() {
        let cfg = parse(&build(""));
        assert!(cfg.rebuilt_alignment.is_none());
        let s = serde_yaml::to_string(&cfg).unwrap();
        assert!(
            !s.contains("rebuilt_alignment"),
            "legacy projects must not grow the section: {s}"
        );
    }

    #[test]
    fn rebuilt_alignment_roundtrips() {
        let mut yaml = build("");
        yaml.push_str(
            r#"
rebuilt_alignment:
  groups:
    - screens: [ASUS, LG]
      rotation:
        - [1.0, 0.0, 0.0]
        - [0.0, 1.0, 0.0]
        - [0.0, 0.0, 1.0]
      t_m: [-1.5, 0.25, 0.0]
      ref_points:
        origin: LG_V001_R001
        x_axis: LG_V009_R001
        xy_plane: LG_V001_R005
      solve_ref: measurements/ASUS+LG_screen_transforms.json
      applied_at: "2026-07-19T12:00:00Z"
"#,
        );
        let cfg = parse(&yaml);
        let align = cfg.rebuilt_alignment.as_ref().expect("section present");
        assert_eq!(align.groups.len(), 1);
        let g = &align.groups[0];
        assert_eq!(g.screens, vec!["ASUS", "LG"]);
        assert_eq!(g.t_m, [-1.5, 0.25, 0.0]);
        assert_eq!(g.ref_points.origin, "LG_V001_R001");
        assert_eq!(
            g.solve_ref.as_deref(),
            Some("measurements/ASUS+LG_screen_transforms.json")
        );
        let out = serde_yaml::to_string(&cfg).unwrap();
        let back: ProjectConfig = serde_yaml::from_str(&out).unwrap();
        assert_eq!(
            back.rebuilt_alignment.as_ref().unwrap().groups[0].t_m,
            [-1.5, 0.25, 0.0]
        );
    }

    #[test]
    fn rebuilt_alignment_rejects_bad_rotation() {
        let mut yaml = build("");
        yaml.push_str(
            r#"
rebuilt_alignment:
  groups:
    - screens: [MAIN]
      rotation:
        - [1.0, 0.0, 0.0]
        - [0.0, 1.0, 0.0]
        - [0.0, 0.0, -1.0]
      t_m: [0.0, 0.0, 0.0]
      ref_points:
        origin: MAIN_V001_R001
      applied_at: "2026-07-19T12:00:00Z"
"#,
        );
        let result: Result<ProjectConfig, _> = serde_yaml::from_str(&yaml);
        assert!(result.is_err(), "left-handed R must be rejected");
    }

    #[test]
    fn rebuilt_alignment_rejects_overlapping_screens() {
        let mut yaml = build("");
        yaml.push_str(
            r#"
rebuilt_alignment:
  groups:
    - screens: [ASUS, LG]
      rotation:
        - [1.0, 0.0, 0.0]
        - [0.0, 1.0, 0.0]
        - [0.0, 0.0, 1.0]
      t_m: [0.0, 0.0, 0.0]
      ref_points:
        origin: LG_V001_R001
      applied_at: "2026-07-19T12:00:00Z"
    - screens: [LG]
      rotation:
        - [1.0, 0.0, 0.0]
        - [0.0, 1.0, 0.0]
        - [0.0, 0.0, 1.0]
      t_m: [0.0, 0.0, 0.0]
      ref_points:
        origin: LG_V002_R001
      applied_at: "2026-07-19T12:00:00Z"
"#,
        );
        let result: Result<ProjectConfig, _> = serde_yaml::from_str(&yaml);
        assert!(result.is_err(), "overlapping screens must be rejected");
    }
}

// ── Capture guidance planner DTO ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CaptureStation {
    pub id: String,
    pub position_mm: [f64; 3],
    pub look_at_mm: [f64; 3],
    pub standoff_mm: f64,
    pub height_mm: f64,
    pub role: String,
    pub covers_cabinets: Vec<[u32; 2]>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CabinetCoverage {
    pub col: u32,
    pub row: u32,
    pub p95_residual_mm: Option<f64>,
    pub n_views: u32,
    pub total_observations: u32,
    pub reconstructable: bool,
    pub low_observation: bool,
    pub bridged: bool,
    pub pass: bool,
    /// WHY a cabinet fails (observability diagnostic, not a gate): "low_coverage"
    /// (too few views/points or unbridged) vs "low_parallax" (count-reconstructable but
    /// p95 over target = degenerate baseline). None when the cabinet passes.
    #[serde(default)]
    pub fail_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct UnreachableRegion {
    pub cabinets: Vec<[u32; 2]>,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CapturePlan {
    pub stations: Vec<CaptureStation>,
    pub coverage: Vec<CabinetCoverage>,
    pub unreachable_regions: Vec<UnreachableRegion>,
    pub all_pass: bool,
    pub target_p95_residual_mm: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CaptureCardResult {
    /// Self-contained HTML (inline SVG, no external deps).
    pub html_content: String,
}
