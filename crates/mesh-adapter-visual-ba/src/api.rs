//! High-level public API for the visual-BA adapter.
//!
//! One async fn per sidecar subcommand. Each builds the JSON payload, runs the
//! sidecar via [`run_sidecar`] (which returns the raw result `data`), and
//! deserializes it into the subcommand's concrete result type. The adapter
//! keeps its OWN ipc/result types (mirroring the sidecar); mesh-app maps them to
//! volo-shared DTOs.

use std::path::Path;

use mesh_core::measured_points::MeasuredPoints;
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};

use crate::error::{VbaError, VbaResult};
use crate::ipc::{
    CabinetArray as IpcCabinetArray, CabinetSummary, CompareKnownResultData,
    CoordinateFrame as IpcCoordinateFrame, EvalResultData, Event, PlanCaptureResultData,
    ReconstructProject, ResultData, ShapePrior as IpcShapePrior, SimulateResultData, WarningEvent,
};
use crate::sidecar::{run_sidecar, SidecarRequest};

// ---------------------------------------------------------------------------
// reconstruct
// ---------------------------------------------------------------------------

pub struct ReconstructArgs {
    /// Single-screen project (compat). Ignored when `screens` is set.
    pub project: ReconstructProject,
    /// Multi-screen joint solve. When `Some` and len > 1, preferred over `project`.
    pub screens: Option<Vec<ReconstructProject>>,
    pub capture_manifest_path: String,
    /// Optional override of the manifest's screen_mapping reference. `None`
    /// tells the sidecar to use the path the capture manifest points to.
    pub screen_mapping_path: Option<String>,
    /// Optional override of the manifest's intrinsics reference. The reserved
    /// value `"auto"` runs inline self-calibration from the captured VP-QSP
    /// markers (vpqsp method only); a file path loads `{K, dist_coeffs,
    /// image_size}`. `None` tells the sidecar to use the manifest's reference.
    pub intrinsics_path: Option<String>,
    /// Optional independent intrinsics anchor for the `--intrinsics auto`
    /// anti-absorption cross-check (vpqsp self-cal only).
    pub crosscheck_intrinsics_path: Option<String>,
    /// Where the sidecar writes `cabinet_pose_report.json` (spec §9). The
    /// adapter reads it back to build `cabinet_summaries`. For joint mode this
    /// is the first screen's report path (per-screen paths live on each
    /// `ReconstructProject.pose_report_path`).
    pub pose_report_path: String,
    /// Joint multi-screen transforms output path (`visual_screen_transforms.v1`).
    pub screen_transforms_path: Option<String>,
    pub progress_tx: Option<mpsc::Sender<Event>>,
    pub cancel: Option<oneshot::Receiver<()>>,
}

/// Per-screen digest for joint reconstruct (mirrors sidecar `ScreenResultSummary`).
#[derive(Debug, Clone)]
pub struct ScreenReconstructSummary {
    pub screen_id: String,
    pub pose_report_path: Option<String>,
    pub ba_rms_px: f64,
    pub cabinet_count: usize,
    pub bridge_views: usize,
    pub cabinet_summaries: Vec<CabinetSummary>,
}

/// Output of [`reconstruct`]. `measured_points` is the primary product (cabinet
/// centers in screen-local frame); `cabinet_summaries` is a convenience digest
/// read back from the pose report on disk.
#[derive(Debug, Clone)]
pub struct ReconstructOut {
    pub measured_points: MeasuredPoints,
    pub pose_report_path: String,
    pub ba_rms_px: f64,
    pub ba_observations_total: usize,
    pub ba_observations_used: usize,
    pub ba_rejected: usize,
    /// align_to_nominal Procrustes 残差（米）；fix_root_cabinet 路径为 0。
    pub procrustes_align_rms_m: f64,
    /// "file" | "auto_self_calibrated" (--intrinsics auto).
    pub intrinsics_source: String,
    /// Non-fatal warnings collected off the sidecar event stream (e.g.
    /// `no_intrinsics_anchor`, `high_rejection`, `cabinet_quality`, `missing_covariance`).
    pub warnings: Vec<WarningEvent>,
    pub cabinet_summaries: Vec<CabinetSummary>,
    pub screen_transforms_path: Option<String>,
    pub screens: Option<Vec<ScreenReconstructSummary>>,
    pub ignored_photos: Vec<String>,
    pub photos_used: u32,
    pub photos_total: u32,
}

fn ipc_to_ir_coord(c: &IpcCoordinateFrame) -> VbaResult<mesh_core::coordinate::CoordinateFrame> {
    let json = serde_json::json!({
        "origin_world": c.origin_world,
        "basis": c.basis,
    });
    serde_json::from_value(json).map_err(|e| {
        VbaError::InvalidInput(format!("coordinate_frame failed core validation: {e}"))
    })
}

fn ipc_to_ir_cabinet(c: &IpcCabinetArray) -> VbaResult<mesh_core::shape::CabinetArray> {
    let json = serde_json::json!({
        "cols": c.cols,
        "rows": c.rows,
        "cabinet_size_mm": c.cabinet_size_mm,
        "absent_cells": c.absent_cells,
    });
    serde_json::from_value(json)
        .map_err(|e| VbaError::InvalidInput(format!("cabinet_array failed core validation: {e}")))
}

fn ipc_to_ir_shape(s: &IpcShapePrior) -> VbaResult<mesh_core::shape::ShapePrior> {
    let json = match s {
        IpcShapePrior::Flat(_) => serde_json::json!("flat"),
        IpcShapePrior::Curved { curved } => {
            serde_json::json!({"curved": {"radius_mm": curved.radius_mm}})
        }
        IpcShapePrior::Folded { folded } => {
            serde_json::json!({"folded": {"fold_seam_columns": folded.fold_seam_columns}})
        }
    };
    serde_json::from_value(json)
        .map_err(|e| VbaError::InvalidInput(format!("shape_prior failed core validation: {e}")))
}

/// Identity screen-local frame: origin at [0,0,0], basis = I. The
/// model-constrained reconstruction is already expressed in the root cabinet's
/// (screen-local) frame per spec §3, so the IR frame is identity.
fn identity_frame() -> VbaResult<mesh_core::coordinate::CoordinateFrame> {
    ipc_to_ir_coord(&IpcCoordinateFrame {
        origin_world: [0.0, 0.0, 0.0],
        basis: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
    })
}

/// Pre-validate the project against the core IR's stricter rules so we fail
/// fast — before spawning a multi-minute sidecar run — when dimensions are
/// oversized or sizes are non-positive. (Coordinate frame is no longer part of
/// the project; the output uses an identity screen-local frame.)
fn validate_project_eagerly(p: &ReconstructProject) -> VbaResult<()> {
    ipc_to_ir_cabinet(&p.cabinet_array)?;
    ipc_to_ir_shape(&p.shape_prior)?;
    Ok(())
}

/// Best-effort read of the cabinet pose report into summaries. A missing or
/// unreadable report is not fatal — the MeasuredPoints are the primary output —
/// so this returns an empty Vec rather than an error in that case. (The adapter
/// is a library: it writes nothing to stdout.)
fn read_cabinet_summaries(
    pose_report_path: &str,
) -> (Vec<CabinetSummary>, Vec<WarningEvent>) {
    let mut warnings = Vec::new();
    let raw = match std::fs::read_to_string(pose_report_path) {
        Ok(s) => s,
        Err(e) => {
            warnings.push(WarningEvent {
                code: "pose_report_missing".into(),
                message: format!("pose report unreadable: {pose_report_path}: {e}"),
                cabinet: None,
            });
            return (Vec::new(), warnings);
        }
    };
    let report: Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            warnings.push(WarningEvent {
                code: "pose_report_corrupt".into(),
                message: format!("pose report parse failed: {pose_report_path}: {e}"),
                cabinet: None,
            });
            return (Vec::new(), warnings);
        }
    };
    let summaries = match report.get("cabinet_poses") {
        Some(poses) => serde_json::from_value(poses.clone()).unwrap_or_default(),
        None => Vec::new(),
    };
    (summaries, warnings)
}

pub async fn reconstruct(args: ReconstructArgs) -> VbaResult<ReconstructOut> {
    let joint = args
        .screens
        .as_ref()
        .is_some_and(|s| s.len() > 1);
    if joint {
        for p in args.screens.as_ref().unwrap() {
            validate_project_eagerly(p)?;
        }
    } else {
        validate_project_eagerly(&args.project)?;
    }

    let mut payload = json!({
        "command": "reconstruct",
        "version": 1,
        "capture_manifest_path": &args.capture_manifest_path,
        "pose_report_path": &args.pose_report_path,
    });
    if joint {
        payload["screens"] = json!(&args.screens);
    } else {
        payload["project"] = json!(&args.project);
    }
    // Omit screen_mapping_path when None so the sidecar falls back to the
    // manifest's reference (its `None` default).
    if let Some(p) = &args.screen_mapping_path {
        payload["screen_mapping_path"] = json!(p);
    }
    // Same for intrinsics: omit when None so the sidecar uses the manifest's
    // reference; "auto" or a file path is forwarded verbatim.
    if let Some(p) = &args.intrinsics_path {
        payload["intrinsics_path"] = json!(p);
    }
    if let Some(p) = &args.crosscheck_intrinsics_path {
        payload["crosscheck_intrinsics_path"] = json!(p);
    }
    if let Some(p) = &args.screen_transforms_path {
        payload["screen_transforms_path"] = json!(p);
    }

    let out = run_sidecar(SidecarRequest {
        subcommand: "reconstruct".into(),
        payload,
        progress_tx: args.progress_tx,
        cancel: args.cancel,
    })
    .await?;
    let mut warnings = out.warnings;

    // A result we can't decode is a sidecar protocol violation, not caller
    // error → BadEventJson, not InvalidInput.
    let result: ResultData = serde_json::from_value(out.data).map_err(VbaError::BadEventJson)?;

    let ba_rms_px = result.ba_stats.rms_reprojection_px;
    let ba_observations_total = result.ba_stats.n_observations_total;
    let ba_observations_used = result.ba_stats.n_observations_used;
    let ba_rejected = result.ba_stats.n_rejected;
    let procrustes_align_rms_m = result.procrustes_align_rms_m;
    let intrinsics_source = result.intrinsics_source.clone();
    let screen_transforms_path = result
        .screen_transforms_path
        .clone()
        .or_else(|| args.screen_transforms_path.clone());
    let points: Vec<mesh_core::point::MeasuredPoint> = result
        .measured_points
        .into_iter()
        .map(|dto| dto.into_ir())
        .collect();

    let primary = if joint {
        args.screens.as_ref().unwrap().first().unwrap()
    } else {
        &args.project
    };
    let measured_points = MeasuredPoints {
        screen_id: primary.screen_id.clone(),
        coordinate_frame: identity_frame()?,
        cabinet_array: ipc_to_ir_cabinet(&primary.cabinet_array)?,
        shape_prior: ipc_to_ir_shape(&primary.shape_prior)?,
        points,
        sampling_mode: mesh_core::sampling::SamplingMode::Grid,
    };

    let (cabinet_summaries, report_warnings) =
        read_cabinet_summaries(&args.pose_report_path);
    warnings.extend(report_warnings);

    let screens = if let Some(summaries) = result.screens {
        let mut out_screens = Vec::with_capacity(summaries.len());
        for s in summaries {
            let path = s.pose_report_path.clone().or_else(|| {
                args.screens.as_ref().and_then(|list| {
                    list.iter()
                        .find(|p| p.screen_id == s.screen_id)
                        .and_then(|p| p.pose_report_path.clone())
                })
            });
            let (cabs, more_warn) = path
                .as_deref()
                .map(read_cabinet_summaries)
                .unwrap_or_default();
            warnings.extend(more_warn);
            out_screens.push(ScreenReconstructSummary {
                screen_id: s.screen_id,
                pose_report_path: path,
                ba_rms_px: s.ba_rms_px,
                cabinet_count: s.cabinet_count,
                bridge_views: s.bridge_views,
                cabinet_summaries: cabs,
            });
        }
        Some(out_screens)
    } else {
        None
    };

    Ok(ReconstructOut {
        measured_points,
        pose_report_path: args.pose_report_path,
        ba_rms_px,
        ba_observations_total,
        ba_observations_used,
        ba_rejected,
        procrustes_align_rms_m,
        intrinsics_source,
        warnings,
        cabinet_summaries,
        screen_transforms_path,
        screens,
        ignored_photos: result.ignored_photos,
        photos_used: result.photos_used,
        photos_total: result.photos_total,
    })
}

// ---------------------------------------------------------------------------
// reconstruct_structured_light
// ---------------------------------------------------------------------------

pub struct ReconstructStructuredLightArgs {
    pub project: ReconstructProject,
    /// One CorrespondenceFile path per camera pose (decode_structured_light out).
    pub correspondence_paths: Vec<String>,
    pub sl_meta_path: String,
    /// File path, or the reserved string "auto" for inline self-calibration.
    pub intrinsics_path: String,
    /// Optional independent intrinsics anchor for the --intrinsics auto cross-check.
    pub crosscheck_intrinsics_path: Option<String>,
    /// Where the sidecar writes `cabinet_pose_report.json`; read back for summaries.
    pub pose_report_path: String,
    pub progress_tx: Option<mpsc::Sender<Event>>,
    pub cancel: Option<oneshot::Receiver<()>>,
}

/// Multi-view structured-light reconstruction. Same `ReconstructOut` shape as
/// [`reconstruct`] (the sidecar runs the same model-constrained BA); only the
/// observation source differs (decoded screen↔camera correspondences).
pub async fn reconstruct_structured_light(
    args: ReconstructStructuredLightArgs,
) -> VbaResult<ReconstructOut> {
    validate_project_eagerly(&args.project)?;

    let payload = json!({
        "command": "reconstruct_structured_light",
        "version": 1,
        "project": &args.project,
        "correspondence_paths": &args.correspondence_paths,
        "sl_meta_path": &args.sl_meta_path,
        "intrinsics_path": &args.intrinsics_path,
        "crosscheck_intrinsics_path": &args.crosscheck_intrinsics_path,
        "pose_report_path": &args.pose_report_path,
    });

    let out = run_sidecar(SidecarRequest {
        subcommand: "reconstruct_structured_light".into(),
        payload,
        progress_tx: args.progress_tx,
        cancel: args.cancel,
    })
    .await?;
    let mut warnings = out.warnings;

    let result: ResultData = serde_json::from_value(out.data).map_err(VbaError::BadEventJson)?;

    let ba_rms_px = result.ba_stats.rms_reprojection_px;
    let ba_observations_total = result.ba_stats.n_observations_total;
    let ba_observations_used = result.ba_stats.n_observations_used;
    let ba_rejected = result.ba_stats.n_rejected;
    let procrustes_align_rms_m = result.procrustes_align_rms_m;
    let intrinsics_source = result.intrinsics_source.clone();
    let points: Vec<mesh_core::point::MeasuredPoint> = result
        .measured_points
        .into_iter()
        .map(|dto| dto.into_ir())
        .collect();

    let measured_points = MeasuredPoints {
        screen_id: args.project.screen_id.clone(),
        coordinate_frame: identity_frame()?,
        cabinet_array: ipc_to_ir_cabinet(&args.project.cabinet_array)?,
        shape_prior: ipc_to_ir_shape(&args.project.shape_prior)?,
        points,
        sampling_mode: mesh_core::sampling::SamplingMode::Grid,
    };

    let (cabinet_summaries, report_warnings) =
        read_cabinet_summaries(&args.pose_report_path);
    warnings.extend(report_warnings);

    Ok(ReconstructOut {
        measured_points,
        pose_report_path: args.pose_report_path,
        ba_rms_px,
        ba_observations_total,
        ba_observations_used,
        ba_rejected,
        procrustes_align_rms_m,
        intrinsics_source,
        warnings,
        cabinet_summaries,
        screen_transforms_path: None,
        screens: None,
        ignored_photos: result.ignored_photos,
        photos_used: result.photos_used,
        photos_total: result.photos_total,
    })
}

// ---------------------------------------------------------------------------
// calibrate
// ---------------------------------------------------------------------------

pub struct CalibrateArgs {
    pub checkerboard_images: Vec<String>,
    pub inner_corners: [u32; 2],
    pub square_size_mm: f64,
    pub output_path: String,
    pub progress_tx: Option<mpsc::Sender<Event>>,
    pub cancel: Option<oneshot::Receiver<()>>,
}

#[derive(Debug, Clone)]
pub struct CalibrateOut {
    pub intrinsics_path: String,
    pub reproj_error_px: f64,
    pub frames_used: u32,
    /// "radial2" | "full" (SL adaptive); the checkerboard calibrate path is "full"
    /// (cv2.calibrateCamera with no CALIB_FIX flags estimates k1,k2,p1,p2,k3).
    pub distortion_model: String,
    pub focal_stddev_px: Option<[f64; 2]>,
    pub pp_stddev_px: Option<[f64; 2]>,
    /// Non-fatal warnings collected off the sidecar event stream (e.g.
    /// `no_intrinsics_anchor` when `--intrinsics-crosscheck` was omitted on a curved wall).
    pub warnings: Vec<WarningEvent>,
}

pub async fn calibrate(args: CalibrateArgs) -> VbaResult<CalibrateOut> {
    let payload = json!({
        "command": "calibrate",
        "version": 1,
        "checkerboard_images": &args.checkerboard_images,
        "inner_corners": args.inner_corners,
        "square_size_mm": args.square_size_mm,
        "output_path": &args.output_path,
    });

    // calibrate's result event is a vestigial ResultData (`iterations` is
    // hard-coded to 0 in the sidecar — see calibrate.py), so it's NOT a
    // reliable source for the frame count. Run for side effects + error
    // surfacing, then read the authoritative values from the intrinsics JSON
    // the sidecar writes to `output_path` (it carries both `reproj_error_px`
    // and `frames_used = len(obj_points)`), mirroring how `generate_pattern`
    // reads pattern_meta.json.
    let out = run_sidecar(SidecarRequest {
        subcommand: "calibrate".into(),
        payload,
        progress_tx: args.progress_tx,
        cancel: args.cancel,
    })
    .await?;

    #[derive(serde::Deserialize)]
    struct IntrinsicsFile {
        reproj_error_px: f64,
        frames_used: u32,
    }

    let intr: IntrinsicsFile = serde_json::from_str(
        &std::fs::read_to_string(&args.output_path)
            .map_err(|e| VbaError::InvalidInput(format!("intrinsics file unreadable: {e}")))?,
    )
    .map_err(|e| VbaError::InvalidInput(format!("intrinsics file decode failed: {e}")))?;

    Ok(CalibrateOut {
        intrinsics_path: args.output_path,
        reproj_error_px: intr.reproj_error_px,
        // Checkerboard calibrate.py calls cv2.calibrateCamera with NO CALIB_FIX flags,
        // so it estimates k1,k2,p1,p2,k3 — that is the "full" distortion model, not radial2.
        frames_used: intr.frames_used,
        distortion_model: "full".to_string(),
        focal_stddev_px: None,
        pp_stddev_px: None,
        warnings: out.warnings,
    })
}

// ---------------------------------------------------------------------------
// calibrate_structured_light
// ---------------------------------------------------------------------------

pub struct CalibrateStructuredLightArgs {
    pub project: ReconstructProject,
    pub correspondence_paths: Vec<String>,
    pub sl_meta_path: String,
    pub output_path: String,
    pub max_rms_px: f64,
    /// Optional independent intrinsics anchor for the anti-absorption cross-check.
    pub crosscheck_intrinsics_path: Option<String>,
    pub progress_tx: Option<mpsc::Sender<Event>>,
    pub cancel: Option<oneshot::Receiver<()>>,
}

pub async fn calibrate_structured_light(
    args: CalibrateStructuredLightArgs,
) -> VbaResult<CalibrateOut> {
    validate_project_eagerly(&args.project)?;

    let payload = json!({
        "command": "calibrate_structured_light",
        "version": 1,
        "project": &args.project,
        "correspondence_paths": &args.correspondence_paths,
        "sl_meta_path": &args.sl_meta_path,
        "output_path": &args.output_path,
        "max_rms_px": args.max_rms_px,
        "crosscheck_intrinsics_path": &args.crosscheck_intrinsics_path,
    });

    let out = run_sidecar(SidecarRequest {
        subcommand: "calibrate_structured_light".into(),
        payload,
        progress_tx: args.progress_tx,
        cancel: args.cancel,
    })
    .await?;

    // Read authoritative reproj_error_px + frames_used (+ precision provenance) from
    // the intrinsics JSON the sidecar wrote (same pattern as `calibrate`).
    #[derive(serde::Deserialize)]
    struct IntrinsicsFile {
        reproj_error_px: f64,
        frames_used: u32,
        #[serde(default)]
        distortion_model: String,
        #[serde(default)]
        focal_stddev_px: Option<[f64; 2]>,
        #[serde(default)]
        pp_stddev_px: Option<[f64; 2]>,
    }
    let intr: IntrinsicsFile = serde_json::from_str(
        &std::fs::read_to_string(&args.output_path)
            .map_err(|e| VbaError::InvalidInput(format!("intrinsics file unreadable: {e}")))?,
    )
    .map_err(|e| VbaError::InvalidInput(format!("intrinsics file decode failed: {e}")))?;

    Ok(CalibrateOut {
        intrinsics_path: args.output_path,
        reproj_error_px: intr.reproj_error_px,
        frames_used: intr.frames_used,
        distortion_model: if intr.distortion_model.is_empty() {
            "radial2".to_string()
        } else {
            intr.distortion_model
        },
        focal_stddev_px: intr.focal_stddev_px,
        pp_stddev_px: intr.pp_stddev_px,
        warnings: out.warnings,
    })
}

// ---------------------------------------------------------------------------
// generate_pattern
// ---------------------------------------------------------------------------

pub struct GeneratePatternArgs {
    pub screen_id: String,
    pub cabinet_array: IpcCabinetArray,
    pub output_dir: String,
    pub screen_resolution: [u32; 2],
    /// "vpqsp" (default) renders self-encoding VP-QSP markers (no capacity ceiling);
    /// "charuco" keeps the legacy ChArUco path.
    pub method: String,
    /// 4-bit numeric screen id baked into every VP-QSP marker (vpqsp only).
    pub screen_id_code: u8,
    /// When set, per-cabinet board geometry (size/pitch) is read from this
    /// screen_mapping.json instead of the uniform grid.
    pub screen_mapping_path: Option<String>,
    pub progress_tx: Option<mpsc::Sender<Event>>,
    pub cancel: Option<oneshot::Receiver<()>>,
}

#[derive(Debug, Clone)]
pub struct GeneratePatternOut {
    pub output_dir: String,
    pub cabinet_count: u32,
    /// Total ArUco markers across all cabinets. Per-cabinet counts vary in v2
    /// (non-square / pitch-matched boards), so a single per-cabinet number is no
    /// longer meaningful — the total is the unambiguous summary.
    pub total_markers: u32,
    /// Non-fatal warnings collected off the sidecar event stream (FIX-7:
    /// `low_marker_count` when a cabinet carries 4..7 markers and therefore
    /// needs >= 2 covering views to clear the runtime observability gate).
    pub warnings: Vec<WarningEvent>,
}

pub async fn generate_pattern(args: GeneratePatternArgs) -> VbaResult<GeneratePatternOut> {
    let mut payload = json!({
        "command": "generate_pattern",
        "version": 1,
        "project": {
            "screen_id": &args.screen_id,
            "cabinet_array": &args.cabinet_array,
        },
        "output_dir": &args.output_dir,
        "screen_resolution": args.screen_resolution,
        "method": &args.method,
        "screen_id_code": args.screen_id_code,
    });
    // Omit screen_mapping_path when None so the sidecar uses uniform generation.
    if let Some(p) = &args.screen_mapping_path {
        payload["screen_mapping_path"] = json!(p);
    }

    // generate_pattern's result event is an empty ResultData; the real product
    // is the files on disk. Run for the side effects + error/warning surfacing,
    // then read the produced pattern_meta.json for counts.
    let out = run_sidecar(SidecarRequest {
        subcommand: "generate_pattern".into(),
        payload,
        progress_tx: args.progress_tx,
        cancel: args.cancel,
    })
    .await?;
    let warnings = out.warnings;

    let meta_path = Path::new(&args.output_dir).join("pattern_meta.json");
    let meta_text = std::fs::read_to_string(&meta_path)
        .map_err(|e| VbaError::InvalidInput(format!("pattern_meta.json unreadable: {e}")))?;

    // Parse the method-appropriate pattern_meta and total the markers. VP-QSP
    // markers self-encode their identity (no ArUco id ranges), so the count comes
    // from the per-cabinet grid shape.
    let (cabinet_count, total_markers) = if args.method == "vpqsp" {
        let meta: crate::ipc::VpqspPatternMeta = serde_json::from_str(&meta_text)
            .map_err(|e| VbaError::InvalidInput(format!("vpqsp pattern_meta.json decode failed: {e}")))?;
        let total: u32 = meta
            .cabinets
            .iter()
            .map(|c| c.markers_x.saturating_mul(c.markers_y))
            .fold(0u32, |acc, n| acc.saturating_add(n));
        (meta.cabinets.len() as u32, total)
    } else {
        let meta: crate::ipc::PatternMeta = serde_json::from_str(&meta_text)
            .map_err(|e| VbaError::InvalidInput(format!("pattern_meta.json decode failed: {e}")))?;
        // Saturating arithmetic: a malformed/hand-edited pattern_meta with
        // aruco_id_end < aruco_id_start must not panic (debug) or wrap (release).
        let total: u32 = meta
            .cabinets
            .iter()
            .map(|c| c.aruco_id_end.saturating_sub(c.aruco_id_start).saturating_add(1))
            .fold(0u32, |acc, n| acc.saturating_add(n));
        (meta.cabinets.len() as u32, total)
    };
    Ok(GeneratePatternOut {
        output_dir: args.output_dir,
        cabinet_count,
        total_markers,
        warnings,
    })
}

// ---------------------------------------------------------------------------
// generate_structured_light
// ---------------------------------------------------------------------------

pub struct GenerateStructuredLightArgs {
    pub project_screen_id: String,
    pub cabinet_array: IpcCabinetArray,
    pub output_dir: String,
    pub screen_resolution: [u32; 2],
    /// When set, per-cabinet placement (input_rect_px) + pitch come from this
    /// screen_mapping.json instead of the uniform grid.
    pub screen_mapping_path: Option<String>,
    /// None = auto-derive per-cabinet from the cabinet pixel resolution (sidecar).
    pub dot_spacing_px: Option<u32>,
    pub dot_radius_px: u32,
    /// None = auto-derive per-cabinet from the cabinet pixel resolution (sidecar).
    pub margin_px: Option<u32>,
    /// Also emit a disguise-ready `<screen_id>.seq/` of uncompressed 24-bit TIFFs.
    pub emit_tiff_seq: bool,
    pub progress_tx: Option<mpsc::Sender<Event>>,
    pub cancel: Option<oneshot::Receiver<()>>,
}

#[derive(Debug, Clone)]
pub struct GenerateStructuredLightOut {
    pub output_dir: String,
    pub n_dots: u32,
    pub n_frames: u32,
}

pub async fn generate_structured_light(
    args: GenerateStructuredLightArgs,
) -> VbaResult<GenerateStructuredLightOut> {
    let mut payload = json!({
        "command": "generate_structured_light",
        "version": 1,
        "project": {
            "screen_id": &args.project_screen_id,
            "cabinet_array": &args.cabinet_array,
        },
        "output_dir": &args.output_dir,
        "screen_resolution": args.screen_resolution,
        "dot_radius_px": args.dot_radius_px,
        "emit_tiff_seq": args.emit_tiff_seq,
    });
    // Omit spacing/margin when None so the sidecar auto-derives them per cabinet.
    if let Some(s) = args.dot_spacing_px {
        payload["dot_spacing_px"] = json!(s);
    }
    if let Some(m) = args.margin_px {
        payload["margin_px"] = json!(m);
    }
    // Omit screen_mapping_path when None so the sidecar uses uniform generation.
    if let Some(p) = &args.screen_mapping_path {
        payload["screen_mapping_path"] = json!(p);
    }

    // generate_structured_light's result event is an empty ResultData; the real
    // product is the files on disk. Run for the side effects + error surfacing,
    // then read the produced sl_meta.json for counts (mirrors generate_pattern).
    let _value = run_sidecar(SidecarRequest {
        subcommand: "generate_structured_light".into(),
        payload,
        progress_tx: args.progress_tx,
        cancel: args.cancel,
    })
    .await?;

    let meta_path = Path::new(&args.output_dir).join("sl_meta.json");
    let meta: crate::ipc::StructuredLightMeta = serde_json::from_str(
        &std::fs::read_to_string(&meta_path)
            .map_err(|e| VbaError::InvalidInput(format!("sl_meta.json unreadable: {e}")))?,
    )
    .map_err(|e| VbaError::InvalidInput(format!("sl_meta.json decode failed: {e}")))?;

    // total_bits == sequence.n_code_frames; frames = WHITE + ALL-ON anchor +
    // total_bits code frames + WHITE = total_bits + 3.
    let total_bits = meta
        .sequence
        .get("n_code_frames")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;
    Ok(GenerateStructuredLightOut {
        output_dir: args.output_dir,
        n_dots: meta.dots.len() as u32,
        n_frames: total_bits.saturating_add(3),
    })
}

// ---------------------------------------------------------------------------
// decode_structured_light
// ---------------------------------------------------------------------------

pub struct DecodeStructuredLightArgs {
    pub input_path: String,
    pub sl_meta_path: String,
    pub output_path: String,
    /// None = sidecar default (0.85). Lower it when the screen does not fill the
    /// frame / the background is not black (e.g. disguise visualiser gray stage),
    /// so the full-white sentinel frames are still detected.
    pub sentinel_threshold: Option<f64>,
    /// None = sidecar auto-derives the ROI from the temporal-activity map.
    pub screen_roi: Option<[u32; 4]>,
    /// Write <output_path>.debug.png (Pass-3 seed mask) for eyeball QA.
    pub emit_debug_image: bool,
    pub progress_tx: Option<mpsc::Sender<Event>>,
    pub cancel: Option<oneshot::Receiver<()>>,
}

#[derive(Debug, Clone)]
pub struct DecodeStructuredLightOut {
    pub output_path: String,
    pub n_dots_decoded: u32,
}

pub async fn decode_structured_light(
    args: DecodeStructuredLightArgs,
) -> VbaResult<DecodeStructuredLightOut> {
    let mut payload = json!({
        "command": "decode_structured_light",
        "version": 1,
        "input_path": &args.input_path,
        "sl_meta_path": &args.sl_meta_path,
        "output_path": &args.output_path,
    });
    // Omit when None so the sidecar uses its default sentinel_threshold (0.85).
    if let Some(t) = args.sentinel_threshold {
        payload["sentinel_threshold"] = json!(t);
    }
    // ROI is sent only when manually overridden; otherwise the sidecar auto-derives.
    if let Some(roi) = args.screen_roi {
        payload["screen_roi"] = json!(roi);
    }
    // emit_debug_image defaults false on the sidecar; only send when explicitly on.
    if args.emit_debug_image {
        payload["emit_debug_image"] = json!(true);
    }

    // decode's result event is an empty ResultData; the product is the
    // correspondence file on disk. Run for side effects + error surfacing, then
    // read the produced correspondence file for the decoded-point count.
    let _value = run_sidecar(SidecarRequest {
        subcommand: "decode_structured_light".into(),
        payload,
        progress_tx: args.progress_tx,
        cancel: args.cancel,
    })
    .await?;

    let corr: crate::ipc::CorrespondenceFile = serde_json::from_str(
        &std::fs::read_to_string(&args.output_path)
            .map_err(|e| VbaError::InvalidInput(format!("correspondence unreadable: {e}")))?,
    )
    .map_err(|e| VbaError::InvalidInput(format!("correspondence decode failed: {e}")))?;

    Ok(DecodeStructuredLightOut {
        output_path: args.output_path,
        n_dots_decoded: corr.points.len() as u32,
    })
}

// ---------------------------------------------------------------------------
// simulate
// ---------------------------------------------------------------------------

pub struct SimulateArgs {
    /// The `{scene, cameras, intrinsics, noise, seed, out_dir}` object. The
    /// adapter merges `command`/`version` in. (simulate config is large and
    /// owned by the caller, so it's passed through untyped.)
    ///
    /// The caller's config MUST NOT contain `command` or `version` keys: the
    /// merge writes them last, so a caller-supplied value would override the
    /// adapter's injected `"simulate"` / `1` and break the wire contract.
    pub config: Value,
    pub progress_tx: Option<mpsc::Sender<Event>>,
    pub cancel: Option<oneshot::Receiver<()>>,
}

pub async fn simulate(args: SimulateArgs) -> VbaResult<SimulateResultData> {
    // Merge command/version into the caller-supplied config object →
    // {"command":"simulate","version":1, ...config}.
    let mut payload = json!({"command": "simulate", "version": 1});
    let obj = payload
        .as_object_mut()
        .expect("payload literal is an object");
    let config = args
        .config
        .as_object()
        .ok_or_else(|| VbaError::InvalidInput("simulate config must be a JSON object".into()))?;
    for (k, v) in config {
        obj.insert(k.clone(), v.clone());
    }

    let value = run_sidecar(SidecarRequest {
        subcommand: "simulate".into(),
        payload,
        progress_tx: args.progress_tx,
        cancel: args.cancel,
    })
    .await?;

    // Undecodable result = sidecar protocol violation → BadEventJson.
    serde_json::from_value(value.data).map_err(VbaError::BadEventJson)
}

// ---------------------------------------------------------------------------
// eval
// ---------------------------------------------------------------------------

pub struct EvalArgs {
    pub dataset_dir: String,
    pub method: String,
    pub seed_matrix: Vec<i64>,
    /// FIX-10a: "near_truth" (Phase-0 default) or "cold" (production init
    /// path: transitive bridging + nominal fallback + Stage-B).
    pub init: String,
    pub progress_tx: Option<mpsc::Sender<Event>>,
    pub cancel: Option<oneshot::Receiver<()>>,
}

pub async fn eval(args: EvalArgs) -> VbaResult<EvalResultData> {
    let payload = json!({
        "command": "eval",
        "version": 1,
        "dataset_dir": &args.dataset_dir,
        "method": &args.method,
        "seed_matrix": &args.seed_matrix,
        "init": &args.init,
    });

    let value = run_sidecar(SidecarRequest {
        subcommand: "eval".into(),
        payload,
        progress_tx: args.progress_tx,
        cancel: args.cancel,
    })
    .await?;

    // Undecodable result = sidecar protocol violation → BadEventJson.
    serde_json::from_value(value.data).map_err(VbaError::BadEventJson)
}

// ---------------------------------------------------------------------------
// compare_known
// ---------------------------------------------------------------------------

pub struct CompareKnownArgs {
    pub report_path: String,
    pub known_path: String,
    /// Optional acceptance-threshold overrides. Mapped to the sidecar's
    /// DEFAULT_THRESHOLDS keys (size_mm / distance_mm / angle_deg); only the
    /// provided ones are sent, so omitted ones keep the Python defaults.
    pub max_size_mm: Option<f64>,
    pub max_dist_mm: Option<f64>,
    pub max_angle_deg: Option<f64>,
    pub progress_tx: Option<mpsc::Sender<Event>>,
    pub cancel: Option<oneshot::Receiver<()>>,
}

pub async fn compare_known(args: CompareKnownArgs) -> VbaResult<CompareKnownResultData> {
    // Build the optional thresholds map: CLI --max-* flags -> sidecar threshold keys.
    // Empty -> null = "use DEFAULT_THRESHOLDS" (the existing Python contract).
    let mut thresholds = serde_json::Map::new();
    if let Some(v) = args.max_size_mm { thresholds.insert("size_mm".into(), v.into()); }
    if let Some(v) = args.max_dist_mm { thresholds.insert("distance_mm".into(), v.into()); }
    if let Some(v) = args.max_angle_deg { thresholds.insert("angle_deg".into(), v.into()); }
    let payload = json!({
        "command": "compare_known",
        "version": 1,
        "report_path": &args.report_path,
        "known_path": &args.known_path,
        "thresholds": if thresholds.is_empty() { serde_json::Value::Null }
                      else { serde_json::Value::Object(thresholds) },
    });

    let value = run_sidecar(SidecarRequest {
        subcommand: "compare_known".into(),
        payload,
        progress_tx: args.progress_tx,
        cancel: args.cancel,
    })
    .await?;

    // Undecodable result = sidecar protocol violation → BadEventJson.
    serde_json::from_value(value.data).map_err(VbaError::BadEventJson)
}

// ---------------------------------------------------------------------------
// plan_capture
// ---------------------------------------------------------------------------

pub struct PlanCaptureArgs {
    pub project: ReconstructProject,
    pub image_size: [u32; 2],
    pub hfov_deg: Option<f64>,
    pub vfov_deg: Option<f64>,
    pub standoff_min_mm: f64,
    pub standoff_max_mm: f64,
    pub height_min_mm: f64,
    pub height_max_mm: f64,
    pub target_p95_residual_mm: f64,
    pub trials: u32,
    pub seed: u32,
    /// None = let the sidecar use its default (gates.MIN_VIEWS); Some = the precision override.
    pub min_views: Option<u32>,
    pub progress_tx: Option<mpsc::Sender<Event>>,
    pub cancel: Option<oneshot::Receiver<()>>,
}

pub async fn plan_capture(args: PlanCaptureArgs) -> VbaResult<PlanCaptureResultData> {
    let mut payload = json!({
        "command": "plan_capture",
        "version": 1,
        "project": &args.project,
        "intrinsics": {
            "image_size": [args.image_size[0], args.image_size[1]],
            "hfov_deg": args.hfov_deg,
            "vfov_deg": args.vfov_deg,
        },
        "shell": {
            "standoff_min_mm": args.standoff_min_mm,
            "standoff_max_mm": args.standoff_max_mm,
            "height_min_mm": args.height_min_mm,
            "height_max_mm": args.height_max_mm,
        },
        "target_p95_residual_mm": args.target_p95_residual_mm,
        "trials": args.trials,
        "seed": args.seed,
    });
    // Send min_views only when overridden — omitting the key (not sending null, which would
    // fail PlanCaptureInput's int validator) lets the sidecar fill gates.MIN_VIEWS.
    if let Some(mv) = args.min_views {
        payload["min_views"] = mv.into();
    }

    let value = run_sidecar(SidecarRequest {
        subcommand: "plan_capture".into(),
        payload,
        progress_tx: args.progress_tx,
        cancel: args.cancel,
    })
    .await?;

    serde_json::from_value(value.data).map_err(VbaError::BadEventJson)
}
