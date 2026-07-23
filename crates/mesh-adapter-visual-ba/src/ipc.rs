//! IPC types mirroring `python-sidecar/schema/ipc.schema.json`.
//!
//! Any change here must also update the JSON Schema and the pydantic
//! models in `python-sidecar/src/lmt_vba_sidecar/ipc.py`.

use nalgebra::{Matrix3, Vector3};
use serde::{Deserialize, Serialize};

pub type Vec3 = [f64; 3];
pub type Mat3 = [[f64; 3]; 3];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoordinateFrame {
    pub origin_world: Vec3,
    pub basis: Mat3,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CabinetArray {
    pub cols: u32,
    pub rows: u32,
    pub cabinet_size_mm: [f64; 2],
    #[serde(default)]
    pub absent_cells: Vec<(u32, u32)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ShapePrior {
    Flat(FlatTag),
    Curved { curved: CurvedShape },
    Folded { folded: FoldedShape },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FlatTag {
    Flat,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CurvedShape {
    pub radius_mm: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FoldedShape {
    pub fold_seam_columns: Vec<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrameAnchor {
    pub cabinet_col: u32,
    pub cabinet_row: u32,
    pub aruco_id: u32,
    pub position_world: Vec3,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Intrinsics {
    #[serde(rename = "K")]
    pub k: Mat3,
    pub dist_coeffs: Vec<f64>,
    pub image_size: [u32; 2],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PatternMetaCabinet {
    pub col: u32,
    pub row: u32,
    pub aruco_id_start: u32,
    pub aruco_id_end: u32,
    // v2: per-cabinet board geometry (pitch-matched generation)
    pub squares_x: u32,
    pub squares_y: u32,
    pub square_px: u32,
    pub pixel_pitch_mm: [f64; 2],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PatternMeta {
    pub schema_version: u32,
    pub aruco_dict: String,
    pub cabinets: Vec<PatternMetaCabinet>,
}

/// VP-QSP pattern metadata (method=vpqsp). No ArUco id ranges — each marker
/// self-encodes its identity — so marker counts come from the grid shape.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VpqspMarkerGrid {
    pub col: u32,
    pub row: u32,
    pub markers_x: u32,
    pub markers_y: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VpqspPatternMeta {
    pub schema_version: String,
    pub screen_id_code: u8,
    pub cabinets: Vec<VpqspMarkerGrid>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FrameStrategy {
    NominalAnchoring,
    ThreePoints,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReconstructProject {
    pub screen_id: String,
    pub cabinet_array: CabinetArray,
    #[serde(default = "default_flat_shape")]
    pub shape_prior: ShapePrior,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screen_id_code: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pattern_meta_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screen_mapping_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pose_report_path: Option<String>,
}

fn default_flat_shape() -> ShapePrior {
    ShapePrior::Flat(FlatTag::Flat)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReconstructInput {
    pub command: String,
    pub version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<ReconstructProject>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screens: Option<Vec<ReconstructProject>>,
    pub capture_manifest_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screen_mapping_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pose_report_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screen_transforms_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Uncertainty {
    Isotropic(f64),
    Covariance(Mat3),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PointSourceVisualBa {
    pub camera_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PointSource {
    pub visual_ba: PointSourceVisualBa,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeasuredPointDto {
    pub name: String,
    pub position: Vec3,
    pub uncertainty: Uncertainty,
    pub source: PointSource,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BaStats {
    pub rms_reprojection_px: f64,
    pub iterations: u32,
    pub converged: bool,
    // Geometric-outlier rejection counts (Stage A pre-clean + Stage B robust
    // trim). Older sidecars omit them → serde defaults to 0 so otherwise-valid
    // ResultEvents still deserialize.
    #[serde(default)]
    pub n_observations_total: usize,
    #[serde(default)]
    pub n_observations_used: usize,
    #[serde(default)]
    pub n_rejected: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScreenResultSummary {
    pub screen_id: String,
    #[serde(default)]
    pub pose_report_path: Option<String>,
    pub ba_rms_px: f64,
    pub cabinet_count: usize,
    #[serde(default)]
    pub bridge_views: usize,
}

/// Compact joint withheld-view + screen-consistency validation digest (mirrors the
/// sidecar `WithheldSummary`). All fields optional for forward/backward compat.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WithheldSummary {
    #[serde(default)]
    pub passed: bool,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub combined_rms_px: Option<f64>,
    #[serde(default)]
    pub limit_px: Option<f64>,
    #[serde(default)]
    pub screen_consistency_passed: Option<bool>,
    #[serde(default)]
    pub max_delta_t_mm: Option<f64>,
    #[serde(default)]
    pub max_delta_rot_deg: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResultData {
    pub measured_points: Vec<MeasuredPointDto>,
    pub ba_stats: BaStats,
    pub frame_strategy_used: FrameStrategy,
    // Forward compat: older sidecars (and the calibrate / generate_pattern
    // subcommands, which don't run Procrustes) may omit this. Default to 0.0
    // so Rust adapter doesn't reject otherwise-valid responses.
    #[serde(default)]
    pub procrustes_align_rms_m: f64,
    /// "file" | "auto_self_calibrated"; older sidecars omit it -> default "file".
    #[serde(default = "default_intrinsics_source")]
    pub intrinsics_source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screen_transforms_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screens: Option<Vec<ScreenResultSummary>>,
    /// Basenames of photos with no usable markers (older sidecars omit → []).
    #[serde(default)]
    pub ignored_photos: Vec<String>,
    #[serde(default)]
    pub photos_used: u32,
    #[serde(default)]
    pub photos_total: u32,
    #[serde(default)]
    pub withheld: Option<WithheldSummary>,
}

fn default_intrinsics_source() -> String {
    "file".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProgressEvent {
    pub stage: String,
    pub percent: f64,
    #[serde(default)]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WarningEvent {
    pub code: String,
    pub message: String,
    #[serde(default)]
    pub cabinet: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResultEnvelope {
    /// Raw result payload. The sidecar emits different `data` shapes per
    /// subcommand (reconstruct/calibrate/generate_pattern → `ResultData`,
    /// simulate → `SimulateResultData`, eval → `EvalResultData`), so we keep
    /// it untyped here and let each `api` fn deserialize into its concrete
    /// result type.
    pub data: serde_json::Value,
}

// --- Per-subcommand result-data mirrors (match the Python sidecar's IPC
// `SimulateResultData` / `EvalResultData`; see python-sidecar/.../ipc.py). ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SimulateResultData {
    pub dataset_dir: String,
    pub n_views: u32,
    pub n_observations: u32,
    pub seed: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvalResultData {
    pub method: String,
    /// Seed(s) of the dataset(s) actually evaluated (from the dataset's
    /// meta.json), NOT an echo of the requested seed_matrix (FIX-9).
    pub seeds: Vec<i64>,
    pub max_size_error_mm: f64,
    pub rms_size_error_mm: f64,
    pub max_distance_error_mm: f64,
    pub max_angle_error_deg: f64,
    /// FIX-9 headline: per-corner SE(3)-holdout error (align/score split
    /// disjoint by cabinet). Catches roll-about-normal / whole-wall normal
    /// rotations the center/normal/size metrics score as 0.0. `None` (JSON
    /// null) when the dataset has < 2 cabinets — the disjoint split is
    /// undefined there (Codex review P2).
    pub holdout_rms_mm: Option<f64>,
    pub holdout_p95_mm: Option<f64>,
    pub holdout_max_mm: Option<f64>,
}

// --- compare_known result mirror (matches CompareKnownResultData in
// python-sidecar/.../ipc.py). ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CabinetSizeCheck {
    pub cabinet_id: String,
    pub size_error_mm: f64,
    #[serde(rename = "pass")]
    pub pass: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairCheck {
    pub a: String,
    pub b: String,
    pub distance_error_mm: f64,
    pub angle_error_deg: f64,
    pub distance_pass: bool,
    pub angle_pass: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompareKnownResultData {
    pub cabinets: Vec<CabinetSizeCheck>,
    pub pairs: Vec<PairCheck>,
    pub passed: bool,
    pub thresholds: std::collections::BTreeMap<String, f64>,
}

/// One cabinet entry from the sidecar's `cabinet_pose_report.json`
/// (`CabinetPose` in python-sidecar/.../ipc.py). The adapter reads only the
/// summary fields it surfaces to mesh-app; the full report stays on disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CabinetSummary {
    pub cabinet_id: String,
    pub position_mm: [f64; 3],
    pub normal: [f64; 3],
    pub reprojection_rms_px: f64,
    pub observed_views: u32,
    /// Pose report field; older reports omit → 0.
    #[serde(default)]
    pub observed_points: u32,
    pub quality: String,
}

// --- structured-light meta mirror (matches StructuredLightMeta in
// python-sidecar/.../ipc.py). The adapter reads only the fields it needs for
// the result count (dot count + sequence.n_code_frames); the full meta stays on
// disk for the decode step. ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlDot {
    pub id: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StructuredLightMeta {
    pub schema_version: u32,
    pub dots: Vec<SlDot>,
    /// Kept untyped: we only read `sequence.n_code_frames` for the frame count.
    #[serde(default)]
    pub sequence: serde_json::Value,
}

// --- correspondence file mirror (matches CorrespondenceFile in
// python-sidecar/.../ipc.py). Carries provenance for Phase 3 validation; the
// adapter surfaces only the decoded-point count. ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CorrespondencePoint {
    pub id: u32,
    pub u: f64,
    pub v: f64,
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CorrespondenceFile {
    pub schema_version: u32,
    pub screen_id: String,
    pub sl_meta_sha256: String,
    /// Detection provenance: the screen ROI actually used (mirrors Python).
    /// Optional so older corr.json without it still deserialize.
    #[serde(default)]
    pub screen_roi: Option<[u32; 4]>,
    pub points: Vec<CorrespondencePoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProtocolErrorEvent {
    pub code: String,
    pub message: String,
    pub fatal: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum Event {
    Progress(ProgressEvent),
    Warning(WarningEvent),
    Result(ResultEnvelope),
    Error(ProtocolErrorEvent),
    /// FIX-28: tolerate unknown event tags from future sidecar versions.
    #[serde(other)]
    Unknown,
}

impl MeasuredPointDto {
    /// Convert to the IR `MeasuredPoint`.
    ///
    /// **Unit boundary**: the IPC channel carries values in meters (matching
    /// the sidecar's BA / Procrustes math), but `mesh_core::uncertainty::Uncertainty`
    /// documents `Isotropic` as millimeters and `Covariance3x3` consequently in
    /// mm². Convert here so M1 (total-station, mm) and M2 (visual-BA) feed the
    /// downstream reconstruction metrics in identical units.
    ///
    /// Position is left in meters (matches `MeasuredPoint::position` docstring).
    pub fn into_ir(self) -> mesh_core::point::MeasuredPoint {
        let position = Vector3::new(self.position[0], self.position[1], self.position[2]);
        let uncertainty = match self.uncertainty {
            Uncertainty::Isotropic(sigma_m) => {
                mesh_core::uncertainty::Uncertainty::Isotropic(sigma_m * 1000.0)
            }
            Uncertainty::Covariance(m) => {
                // m² → mm² (1 m² = 1e6 mm²)
                let scale = 1.0e6;
                mesh_core::uncertainty::Uncertainty::Covariance3x3(Matrix3::new(
                    m[0][0] * scale,
                    m[0][1] * scale,
                    m[0][2] * scale,
                    m[1][0] * scale,
                    m[1][1] * scale,
                    m[1][2] * scale,
                    m[2][0] * scale,
                    m[2][1] * scale,
                    m[2][2] * scale,
                ))
            }
        };
        mesh_core::point::MeasuredPoint {
            name: self.name,
            position,
            uncertainty,
            source: mesh_core::point::PointSource::VisualBA {
                camera_count: self.source.visual_ba.camera_count,
            },
        }
    }
}

#[cfg(test)]
mod corr_roi_tests {
    use super::CorrespondenceFile;

    #[test]
    fn correspondence_file_screen_roi_optional() {
        // Old corr.json without screen_roi still deserializes.
        let old = r#"{"schema_version":1,"screen_id":"MAIN","sl_meta_sha256":"x","points":[]}"#;
        let f: CorrespondenceFile = serde_json::from_str(old).unwrap();
        assert!(f.screen_roi.is_none());
        // New corr.json carries the used ROI.
        let new = r#"{"schema_version":1,"screen_id":"MAIN","sl_meta_sha256":"x","screen_roi":[1,2,3,4],"points":[]}"#;
        let f2: CorrespondenceFile = serde_json::from_str(new).unwrap();
        assert_eq!(f2.screen_roi, Some([1, 2, 3, 4]));
    }
}

#[cfg(test)]
mod rejection_fields_tests {
    use super::*;

    #[test]
    fn ba_stats_deserializes_rejection_counts_with_defaults() {
        // New sidecar payload with the fields.
        let v: BaStats = serde_json::from_value(serde_json::json!({
            "rms_reprojection_px": 0.4, "iterations": 12, "converged": true,
            "n_observations_total": 100, "n_observations_used": 97, "n_rejected": 3
        }))
        .unwrap();
        assert_eq!(v.n_rejected, 3);
        assert_eq!(v.n_observations_used, 97);
        // Old sidecar payload WITHOUT the fields -> serde defaults to 0.
        let old: BaStats = serde_json::from_value(serde_json::json!({
            "rms_reprojection_px": 0.4, "iterations": 12, "converged": true
        }))
        .unwrap();
        assert_eq!(old.n_rejected, 0);
    }
}

// --- plan_capture result mirror (matches sidecar PlanCaptureResultData) -----
#[derive(Debug, Clone, Deserialize)]
pub struct CaptureStationData {
    pub id: String,
    pub position_mm: [f64; 3],
    pub look_at_mm: [f64; 3],
    pub standoff_mm: f64,
    pub height_mm: f64,
    pub role: String,
    pub covers_cabinets: Vec<[u32; 2]>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CabinetCoverageData {
    pub col: u32,
    pub row: u32,
    pub p95_residual_mm: Option<f64>,
    pub n_views: u32,
    pub total_observations: u32,
    pub reconstructable: bool,
    pub low_observation: bool,
    pub bridged: bool,
    // Accept both `pass` (pydantic >=2.11 serialize_by_alias) and `pass_`
    // (older pydantic ignores that config key) so the wire contract is robust
    // across the `pydantic>=2.0,<3.0` pin range.
    #[serde(alias = "pass_")]
    pub pass: bool,
    #[serde(default)]
    pub fail_reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UnreachableRegionData {
    pub cabinets: Vec<[u32; 2]>,
    pub reason: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PlanCaptureResultData {
    pub stations: Vec<CaptureStationData>,
    pub coverage: Vec<CabinetCoverageData>,
    pub unreachable_regions: Vec<UnreachableRegionData>,
    pub all_pass: bool,
    pub target_p95_residual_mm: f64,
}
