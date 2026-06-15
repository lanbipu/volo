//! M2 visual-BA adapter 的 service-layer helpers。
//!
//! Tauri GUI 的 `#[tauri::command]` 与 volo-cli 的子命令都通过 thin shim 调用本
//! 文件的 `run_*` 函数。每个 `run_*` 是 SYNC(CLI 是同步的):内部建一个临时
//! tokio runtime,`block_on` adapter 的 async fn,然后把 adapter 的输出映射成
//! `volo-shared` DTO。
//!
//! 单位约定见 adapter `MeasuredPointDto::into_ir`(IPC 用米,IR 用毫米/毫米²)。

use std::path::Path;

use mesh_adapter_visual_ba::api::{
    calibrate, calibrate_structured_light, compare_known, decode_structured_light, eval,
    generate_pattern, generate_structured_light, plan_capture, reconstruct,
    reconstruct_structured_light, simulate, CalibrateArgs, CalibrateStructuredLightArgs,
    CompareKnownArgs, DecodeStructuredLightArgs, EvalArgs, GeneratePatternArgs,
    GenerateStructuredLightArgs, PlanCaptureArgs, ReconstructArgs, ReconstructOut,
    ReconstructStructuredLightArgs, SimulateArgs,
};
use mesh_adapter_visual_ba::ipc;

use volo_shared::dto::{
    CabinetPoseSummary, CabinetSizeCheck, CalibrateResult, CompareKnownResult,
    DecodeStructuredLightResult, EvalResult, GeneratePatternResult, GenerateStructuredLightResult,
    PairCheck, SimulateResult, VisualReconstructResult, WarningDto,
};
use volo_shared::error::{LmtError, LmtResult};

use crate::projects::load_project_yaml_from_path;

/// A short-lived tokio runtime for `block_on`. The workspace tokio enables the
/// `rt` + `process` features (the adapter spawns the sidecar via tokio process).
fn rt() -> LmtResult<tokio::runtime::Runtime> {
    tokio::runtime::Runtime::new().map_err(|e| LmtError::Other(format!("tokio runtime: {e}")))
}

/// Map the adapter's sidecar-stream warnings to the public `WarningDto`. These ride the
/// result so they survive the headless path (the sidecar's live WarningEvents are dropped
/// when no progress consumer is attached).
fn map_warnings(warnings: Vec<ipc::WarningEvent>) -> Vec<WarningDto> {
    warnings
        .into_iter()
        .map(|w| WarningDto {
            code: w.code,
            message: w.message,
            cabinet: w.cabinet,
        })
        .collect()
}

/// Map adapter `VbaError` → `LmtError`, preserving the sidecar's error code so
/// the CLI exit code is correct (see Task 1.6 error-code table). The `Protocol`
/// `code` string is exactly the snake_case `kind` of the matching `LmtError`
/// variant, so the envelope re-emits the same `error_codes::*` string.
fn map_vba_err(e: mesh_adapter_visual_ba::error::VbaError) -> LmtError {
    use mesh_adapter_visual_ba::error::VbaError as V;
    match e {
        V::Protocol { code, message } => match code.as_str() {
            "detection_failed" => LmtError::DetectionFailed(message),
            "ba_diverged" => LmtError::BaDiverged(message),
            "procrustes_failed" => LmtError::ProcrustesFailed(message),
            "intrinsics_invalid" => LmtError::IntrinsicsInvalid(message),
            "observability_failed" => LmtError::ObservabilityFailed(message),
            "decode_failed" => LmtError::DecodeFailed(message),
            "invalid_input" => LmtError::InvalidInput(message),
            "internal_error" | "internal" => LmtError::Other(message),
            other => LmtError::Other(format!("{other}: {message}")),
        },
        // The sync run_* helpers never pass a cancel token, so this arm is
        // permanently defensive — cancel is only reachable from async (Tauri)
        // callers.
        V::Cancelled => LmtError::Other("cancelled".into()),
        V::InvalidInput(m) => LmtError::InvalidInput(m),
        other => LmtError::Other(other.to_string()),
    }
}

/// Convert volo-shared `ScreenConfig` → the adapter's `ipc::CabinetArray`.
/// Mirrors `export::build_cabinet_array` but targets the adapter's own ipc type
/// (which the sidecar wire contract uses) instead of `mesh_core::shape::CabinetArray`.
fn ipc_cabinet_array(screen_cfg: &volo_shared::dto::ScreenConfig) -> ipc::CabinetArray {
    use volo_shared::dto::ShapeMode;
    let [cols, rows] = screen_cfg.cabinet_count;
    let absent_cells = match screen_cfg.shape_mode {
        ShapeMode::Rectangle => Vec::new(),
        ShapeMode::Irregular => screen_cfg
            .irregular_mask
            .iter()
            .map(|&[c, r]| (c, r))
            .collect(),
    };
    ipc::CabinetArray {
        cols,
        rows,
        cabinet_size_mm: screen_cfg.cabinet_size_mm,
        absent_cells,
    }
}

/// Convert volo-shared `ShapePriorConfig` → the adapter's `ipc::ShapePrior`.
fn ipc_shape_prior(screen_cfg: &volo_shared::dto::ScreenConfig) -> ipc::ShapePrior {
    use volo_shared::dto::ShapePriorConfig;
    match &screen_cfg.shape_prior {
        ShapePriorConfig::Flat => ipc::ShapePrior::Flat(ipc::FlatTag::Flat),
        ShapePriorConfig::Curved { radius_mm, .. } => ipc::ShapePrior::Curved {
            curved: ipc::CurvedShape {
                radius_mm: *radius_mm,
            },
        },
        ShapePriorConfig::Folded {
            fold_seams_at_columns,
        } => ipc::ShapePrior::Folded {
            folded: ipc::FoldedShape {
                fold_seam_columns: fold_seams_at_columns.clone(),
            },
        },
    }
}

/// Look up a screen in project.yaml or fail with `NotFound`.
fn load_screen<'a>(
    cfg: &'a volo_shared::dto::ProjectConfig,
    screen_id: &str,
) -> LmtResult<&'a volo_shared::dto::ScreenConfig> {
    cfg.screens
        .get(screen_id)
        .ok_or_else(|| LmtError::NotFound(format!("screen '{screen_id}' not in project")))
}

// ---------------------------------------------------------------------------
// reconstruct
// ---------------------------------------------------------------------------

/// Run the visual-BA reconstruction for one screen. The durable product is
/// `<project>/measurements/<screen>_cabinet_pose_report.json`（sidecar 写出，
/// 含逐箱体角点 + 协方差）。
///
/// FIX-13 ④: 不再写 `measurements/measured.yaml` —— 旧行为会备份后**覆盖 M1
/// 全站仪数据**，而写出的内容（`MAIN_` 前缀 + 0-based 箱体中心点名）与 core
/// 重建器的 1-based 角点命名永不兼容，是纯数据损毁风险。逐箱体 BA 协方差
/// 迁移进 pose report 的 `covariance_mm2` 字段持久化。
///
/// The capture manifest references its own `screen_mapping` file, so we pass
/// `screen_mapping_path = None` and let the sidecar resolve it.
pub fn run_reconstruct(
    project_path: &Path,
    screen_id: &str,
    capture_manifest: &Path,
    intrinsics: Option<&str>,
    intrinsics_crosscheck: Option<&str>,
) -> LmtResult<VisualReconstructResult> {
    let cfg = load_project_yaml_from_path(project_path)?;
    let screen_cfg = load_screen(&cfg, screen_id)?;

    let project = ipc::ReconstructProject {
        screen_id: screen_id.to_string(),
        cabinet_array: ipc_cabinet_array(screen_cfg),
        shape_prior: ipc_shape_prior(screen_cfg),
    };

    // The sidecar writes the cabinet pose report here; the adapter reads it back
    // for the per-cabinet summaries.
    let measurements_dir = project_path.join("measurements");
    std::fs::create_dir_all(&measurements_dir)?;
    let pose_report_path = measurements_dir.join(format!("{screen_id}_cabinet_pose_report.json"));

    let args = ReconstructArgs {
        project,
        capture_manifest_path: capture_manifest.display().to_string(),
        screen_mapping_path: None,
        // `intrinsics` (CLI override) > manifest reference; "auto" = self-cal.
        intrinsics_path: intrinsics.map(str::to_string),
        crosscheck_intrinsics_path: intrinsics_crosscheck.map(str::to_string),
        pose_report_path: pose_report_path.display().to_string(),
        progress_tx: None,
        cancel: None,
    };

    let out = rt()?.block_on(reconstruct(args)).map_err(map_vba_err)?;
    Ok(build_reconstruct_result(screen_id, out))
}

/// Map the adapter's `ReconstructOut` → public `VisualReconstructResult`.
/// Shared by run_reconstruct (charuco) and run_reconstruct_structured_light.
///
/// FIX-13 ④: 纯映射,不再落任何 `measured.yaml`(见 [`run_reconstruct`] 注释);
/// M1 全站仪的 `measurements/measured.yaml` 在 visual 重建后保持原样。
fn build_reconstruct_result(
    screen_id: &str,
    out: ReconstructOut,
) -> VisualReconstructResult {
    VisualReconstructResult {
        screen_id: screen_id.to_string(),
        pose_report_path: out.pose_report_path,
        cabinet_count: out.measured_points.points.len(),
        ba_rms_px: out.ba_rms_px,
        ba_observations_total: out.ba_observations_total,
        ba_observations_used: out.ba_observations_used,
        ba_rejected: out.ba_rejected,
        procrustes_align_rms_m: out.procrustes_align_rms_m,
        intrinsics_source: out.intrinsics_source,
        warnings: map_warnings(out.warnings),
        cabinets: out
            .cabinet_summaries
            .iter()
            .map(|s| CabinetPoseSummary {
                cabinet_id: s.cabinet_id.clone(),
                position_mm: s.position_mm,
                normal: s.normal,
                reprojection_rms_px: s.reprojection_rms_px,
                observed_views: s.observed_views,
                quality: s.quality.clone(),
            })
            .collect(),
    }
}

/// Multi-view structured-light reconstruction: N correspondence files (decode
/// output) + sl_meta + intrinsics → cabinet_pose_report.json,
/// via the same model-constrained BA as `run_reconstruct`.
/// FIX-13 ④: 同样不再写 measured.yaml（见 [`run_reconstruct`]）。
pub fn run_reconstruct_structured_light(
    project_path: &Path,
    screen_id: &str,
    sl_meta: &Path,
    intrinsics: &str,
    intrinsics_crosscheck: Option<&str>,
    correspondences: &[String],
) -> LmtResult<VisualReconstructResult> {
    let cfg = load_project_yaml_from_path(project_path)?;
    let screen_cfg = load_screen(&cfg, screen_id)?;
    let project = ipc::ReconstructProject {
        screen_id: screen_id.to_string(),
        cabinet_array: ipc_cabinet_array(screen_cfg),
        shape_prior: ipc_shape_prior(screen_cfg),
    };

    let measurements_dir = project_path.join("measurements");
    std::fs::create_dir_all(&measurements_dir)?;
    let pose_report_path = measurements_dir.join(format!("{screen_id}_cabinet_pose_report.json"));

    let args = ReconstructStructuredLightArgs {
        project,
        correspondence_paths: correspondences.to_vec(),
        sl_meta_path: sl_meta.display().to_string(),
        intrinsics_path: intrinsics.to_string(),
        crosscheck_intrinsics_path: intrinsics_crosscheck.map(str::to_string),
        pose_report_path: pose_report_path.display().to_string(),
        progress_tx: None,
        cancel: None,
    };

    let out = rt()?
        .block_on(reconstruct_structured_light(args))
        .map_err(map_vba_err)?;
    Ok(build_reconstruct_result(screen_id, out))
}

// ---------------------------------------------------------------------------
// calibrate_structured_light
// ---------------------------------------------------------------------------

/// Calibrate camera intrinsics from multi-view structured-light correspondences.
/// Writes `<project>/calibration/<screen_id>_sl_intrinsics.json` (or `out` when
/// provided). Returns `Err(InvalidInput)` if the output file already exists and
/// `force` is false.
#[allow(clippy::too_many_arguments)]
pub fn run_calibrate_structured_light(
    project_path: &Path,
    screen_id: &str,
    sl_meta: &Path,
    correspondences: &[String],
    out: Option<&Path>,
    force: bool,
    max_rms_px: f64,
    intrinsics_crosscheck: Option<&str>,
) -> LmtResult<CalibrateResult> {
    let cfg = load_project_yaml_from_path(project_path)?;
    let screen_cfg = load_screen(&cfg, screen_id)?;
    let project = ipc::ReconstructProject {
        screen_id: screen_id.to_string(),
        cabinet_array: ipc_cabinet_array(screen_cfg),
        shape_prior: ipc_shape_prior(screen_cfg),
    };

    let calibration_dir = project_path.join("calibration");
    std::fs::create_dir_all(&calibration_dir)?;
    let output_path = match out {
        Some(p) => p.to_path_buf(),
        None => calibration_dir.join(format!("{screen_id}_sl_intrinsics.json")),
    };
    if output_path.exists() && !force {
        return Err(LmtError::InvalidInput(format!(
            "would overwrite existing intrinsics {}; pass --force or --out",
            output_path.display()
        )));
    }

    let args = CalibrateStructuredLightArgs {
        project,
        correspondence_paths: correspondences.to_vec(),
        sl_meta_path: sl_meta.display().to_string(),
        output_path: output_path.display().to_string(),
        max_rms_px,
        crosscheck_intrinsics_path: intrinsics_crosscheck.map(str::to_string),
        progress_tx: None,
        cancel: None,
    };

    let out = rt()?
        .block_on(calibrate_structured_light(args))
        .map_err(map_vba_err)?;

    Ok(CalibrateResult {
        intrinsics_path: out.intrinsics_path,
        reproj_error_px: out.reproj_error_px,
        frames_used: out.frames_used,
        distortion_model: out.distortion_model,
        focal_stddev_px: out.focal_stddev_px,
        pp_stddev_px: out.pp_stddev_px,
        warnings: map_warnings(out.warnings),
    })
}

// ---------------------------------------------------------------------------
// calibrate
// ---------------------------------------------------------------------------

/// Parse `"9x9"` → `[9, 9]`. Both factors must be positive integers.
fn parse_inner_corners(s: &str) -> LmtResult<[u32; 2]> {
    let (a, b) = s
        .split_once(['x', 'X'])
        .ok_or_else(|| LmtError::InvalidInput(format!("inner corners must be WxH, got '{s}'")))?;
    let parse = |t: &str, which: &str| -> LmtResult<u32> {
        t.trim()
            .parse::<u32>()
            .map_err(|_| LmtError::InvalidInput(format!("inner corners {which} '{t}' invalid")))
            .and_then(|v| {
                if v == 0 {
                    Err(LmtError::InvalidInput(format!(
                        "inner corners {which} must be > 0"
                    )))
                } else {
                    Ok(v)
                }
            })
    };
    Ok([parse(a, "width")?, parse(b, "height")?])
}

/// Calibrate camera intrinsics from a directory of checkerboard images.
/// Writes `<project>/calibration/<screen_id>_intrinsics.json`.
pub fn run_calibrate(
    project_path: &Path,
    screen_id: &str,
    checkerboard_dir: &Path,
    square_mm: f64,
    inner: &str,
) -> LmtResult<CalibrateResult> {
    let inner_corners = parse_inner_corners(inner)?;

    if !checkerboard_dir.is_dir() {
        return Err(LmtError::NotFound(format!(
            "checkerboard dir not found: {}",
            checkerboard_dir.display()
        )));
    }
    // Collect png/jpg/jpeg images, sorted for deterministic ordering.
    let mut images: Vec<String> = std::fs::read_dir(checkerboard_dir)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.extension()
                .and_then(|x| x.to_str())
                .map(|x| {
                    let x = x.to_ascii_lowercase();
                    x == "png" || x == "jpg" || x == "jpeg"
                })
                .unwrap_or(false)
        })
        .map(|p| p.display().to_string())
        .collect();
    images.sort();
    if images.is_empty() {
        return Err(LmtError::InvalidInput(format!(
            "no checkerboard images (png/jpg) found in {}",
            checkerboard_dir.display()
        )));
    }

    let calibration_dir = project_path.join("calibration");
    std::fs::create_dir_all(&calibration_dir)?;
    let output_path = calibration_dir.join(format!("{screen_id}_intrinsics.json"));

    let args = CalibrateArgs {
        checkerboard_images: images,
        inner_corners,
        square_size_mm: square_mm,
        output_path: output_path.display().to_string(),
        progress_tx: None,
        cancel: None,
    };

    let out = rt()?.block_on(calibrate(args)).map_err(map_vba_err)?;

    Ok(CalibrateResult {
        intrinsics_path: out.intrinsics_path,
        reproj_error_px: out.reproj_error_px,
        frames_used: out.frames_used,
        distortion_model: out.distortion_model,
        focal_stddev_px: out.focal_stddev_px,
        pp_stddev_px: out.pp_stddev_px,
        warnings: map_warnings(out.warnings),
    })
}

// ---------------------------------------------------------------------------
// generate_pattern
// ---------------------------------------------------------------------------

/// Resolve a `--screen-mapping` path to an absolute path, relative to the CURRENT
/// WORKING DIRECTORY — consistent with every other path argument the CLI accepts
/// (`project_path`, `--capture-manifest`, `--images`, …), all of which the OS
/// resolves against CWD. A relative path was previously joined onto `project_path`,
/// which double-concatenated when the operator passed a CWD-relative path that
/// already contained the project prefix (e.g. `proj/screen_mapping.json` while
/// `project_path = proj` → `proj/proj/screen_mapping.json`). Absolute paths pass
/// through unchanged; `None` (flag absent) stays `None`. The result is absolute so
/// the sidecar subprocess resolves it identically regardless of its own CWD.
fn resolve_screen_mapping_path(p: Option<&Path>) -> LmtResult<Option<std::path::PathBuf>> {
    match p {
        None => Ok(None),
        Some(p) if p.is_absolute() => Ok(Some(p.to_path_buf())),
        Some(p) => Ok(Some(std::env::current_dir()?.join(p))),
    }
}

/// Resolve the framebuffer `[w, h]` for one screen.
///
/// In `--screen-mapping` mode the framebuffer is the bounding box of the
/// per-cabinet `input_rect_px` (cabinets may be unequal / gapped); `pixels_per_
/// cabinet` is not used. In uniform mode it is `pixels_per_cabinet × cabinet_count`.
///
/// Shared by `run_generate_pattern` and `run_generate_structured_light` (both
/// must agree on the screen resolution they pass to the sidecar).
fn compute_screen_resolution(
    sm_abs: &Option<std::path::PathBuf>,
    screen_cfg: &volo_shared::dto::ScreenConfig,
    screen_id: &str,
) -> LmtResult<[u32; 2]> {
    match sm_abs {
        Some(p) => {
            let txt = std::fs::read_to_string(p).map_err(|e| {
                LmtError::InvalidInput(format!("screen_mapping '{}' unreadable: {e}", p.display()))
            })?;
            let v: serde_json::Value = serde_json::from_str(&txt).map_err(|e| {
                LmtError::InvalidInput(format!("screen_mapping '{}' invalid JSON: {e}", p.display()))
            })?;
            let cabs = v.get("cabinets").and_then(|c| c.as_array()).ok_or_else(|| {
                LmtError::InvalidInput("screen_mapping has no cabinets[]".into())
            })?;
            // Parse each coordinate via as_f64 (accepts both JSON int and float,
            // matching the Python side's int coercion) and reject negative /
            // non-finite values rather than silently treating them as 0. Sum in
            // u64 so a large rect can't overflow; cap the framebuffer at u32.
            let (mut max_w, mut max_h) = (0u64, 0u64);
            for c in cabs {
                let r = c.get("input_rect_px").and_then(|r| r.as_array()).ok_or_else(|| {
                    LmtError::InvalidInput("screen_mapping cabinet missing input_rect_px".into())
                })?;
                if r.len() != 4 {
                    return Err(LmtError::InvalidInput(
                        "input_rect_px must be [x, y, w, h]".into(),
                    ));
                }
                let g = |i: usize| -> Result<u64, LmtError> {
                    let f = r[i].as_f64().ok_or_else(|| {
                        LmtError::InvalidInput("input_rect_px values must be numbers".into())
                    })?;
                    if !f.is_finite() || f < 0.0 {
                        return Err(LmtError::InvalidInput(format!(
                            "input_rect_px values must be finite and non-negative, got {f}"
                        )));
                    }
                    Ok(f.round() as u64)
                };
                max_w = max_w.max(g(0)? + g(2)?);
                max_h = max_h.max(g(1)? + g(3)?);
            }
            if max_w > u32::MAX as u64 || max_h > u32::MAX as u64 {
                return Err(LmtError::InvalidInput(format!(
                    "screen_mapping framebuffer {max_w}x{max_h} exceeds u32 range"
                )));
            }
            Ok([max_w as u32, max_h as u32])
        }
        None => {
            let ppc = screen_cfg.pixels_per_cabinet.ok_or_else(|| {
                LmtError::InvalidInput(format!(
                    "screen '{screen_id}' has no pixels_per_cabinet; required for uniform pattern generation"
                ))
            })?;
            let [cols, rows] = screen_cfg.cabinet_count;
            Ok([ppc[0] * cols, ppc[1] * rows])
        }
    }
}

/// Generate ChArUco calibration patterns for one screen's cabinets, written to
/// `<project>/patterns/<screen_id>`.
pub fn run_generate_pattern(
    project_path: &Path,
    screen_id: &str,
    method: &str,
    screen_id_code: u8,
    screen_mapping_path: Option<&Path>,
) -> LmtResult<GeneratePatternResult> {
    if method != "charuco" && method != "vpqsp" {
        return Err(LmtError::InvalidInput(format!(
            "unsupported pattern method '{method}' (expected 'vpqsp' or 'charuco')"
        )));
    }

    let cfg = load_project_yaml_from_path(project_path)?;
    let screen_cfg = load_screen(&cfg, screen_id)?;
    let cabinet_array = ipc_cabinet_array(screen_cfg);

    // Resolve --screen-mapping relative to CWD (see resolve_screen_mapping_path).
    let sm_abs = resolve_screen_mapping_path(screen_mapping_path)?;

    let screen_resolution = compute_screen_resolution(&sm_abs, screen_cfg, screen_id)?;

    let output_dir = project_path.join("patterns").join(screen_id);
    std::fs::create_dir_all(&output_dir)?;

    let args = GeneratePatternArgs {
        screen_id: screen_id.to_string(),
        cabinet_array,
        output_dir: output_dir.display().to_string(),
        screen_resolution,
        method: method.to_string(),
        screen_id_code,
        screen_mapping_path: sm_abs.map(|p| p.display().to_string()),
        progress_tx: None,
        cancel: None,
    };

    let out = rt()?.block_on(generate_pattern(args)).map_err(map_vba_err)?;

    Ok(GeneratePatternResult {
        output_dir: out.output_dir,
        cabinet_count: out.cabinet_count as usize,
        total_markers: out.total_markers,
        warnings: map_warnings(out.warnings),
    })
}

// ---------------------------------------------------------------------------
// generate_structured_light
// ---------------------------------------------------------------------------

/// Generate a structured-light dot sequence for one screen into
/// `<project>/patterns/<screen_id>/sl`. Mapping-aware: with `screen_mapping_path`
/// the framebuffer is the input_rect_px bounding box (mirrors `run_generate_pattern`).
pub fn run_generate_structured_light(
    project_path: &Path,
    screen_id: &str,
    // None = auto-derive per cabinet from its pixel resolution (sidecar).
    dot_spacing_px: Option<u32>,
    dot_radius_px: u32,
    // None = auto-derive per cabinet from its pixel resolution (sidecar).
    margin_px: Option<u32>,
    // None = auto: emit the TIFF `.seq` iff the project's output.target == "disguise".
    emit_tiff_seq: Option<bool>,
    screen_mapping_path: Option<&Path>,
) -> LmtResult<GenerateStructuredLightResult> {
    let cfg = load_project_yaml_from_path(project_path)?;
    let emit_tiff_seq = emit_tiff_seq.unwrap_or_else(|| cfg.output.target == "disguise");
    let screen_cfg = load_screen(&cfg, screen_id)?;
    let cabinet_array = ipc_cabinet_array(screen_cfg);

    // Resolve --screen-mapping relative to CWD (see resolve_screen_mapping_path).
    let sm_abs = resolve_screen_mapping_path(screen_mapping_path)?;
    let screen_resolution = compute_screen_resolution(&sm_abs, screen_cfg, screen_id)?;

    let output_dir = project_path.join("patterns").join(screen_id).join("sl");
    std::fs::create_dir_all(output_dir.parent().unwrap())?;

    let args = GenerateStructuredLightArgs {
        project_screen_id: screen_id.to_string(),
        cabinet_array,
        output_dir: output_dir.display().to_string(),
        screen_resolution,
        screen_mapping_path: sm_abs.map(|p| p.display().to_string()),
        dot_spacing_px,
        dot_radius_px,
        margin_px,
        emit_tiff_seq,
        progress_tx: None,
        cancel: None,
    };

    let out = rt()?.block_on(generate_structured_light(args)).map_err(map_vba_err)?;

    Ok(GenerateStructuredLightResult {
        output_dir: out.output_dir,
        n_dots: out.n_dots as usize,
        n_frames: out.n_frames as usize,
    })
}

// ---------------------------------------------------------------------------
// decode_structured_light
// ---------------------------------------------------------------------------

/// Decode a recorded structured-light capture (video or frame directory) into a
/// provenance-stamped screen↔camera correspondence file at `output_path`.
pub fn run_decode_structured_light(
    input_path: &Path,
    sl_meta_path: &Path,
    output_path: &Path,
    // None = sidecar default (0.85). Lower for non-black / partially-filled frames.
    sentinel_threshold: Option<f64>,
    // None = sidecar auto-derives the screen ROI from the temporal-activity map.
    screen_roi: Option<[u32; 4]>,
    // When true the sidecar also writes <output_path>.debug.png.
    emit_debug_image: bool,
) -> LmtResult<DecodeStructuredLightResult> {
    let args = DecodeStructuredLightArgs {
        input_path: input_path.display().to_string(),
        sl_meta_path: sl_meta_path.display().to_string(),
        output_path: output_path.display().to_string(),
        sentinel_threshold,
        screen_roi,
        emit_debug_image,
        progress_tx: None,
        cancel: None,
    };

    let out = rt()?.block_on(decode_structured_light(args)).map_err(map_vba_err)?;

    Ok(DecodeStructuredLightResult {
        output_path: out.output_path,
        n_dots_decoded: out.n_dots_decoded as usize,
    })
}

// ---------------------------------------------------------------------------
// simulate
// ---------------------------------------------------------------------------

/// Run a synthetic-dataset simulation. `config_path` is the
/// `{scene, cameras, intrinsics, noise, seed}` JSON object; `out_dir` is
/// injected as `out_dir` (overriding any value in the config).
pub fn run_simulate(config_path: &Path, out_dir: &Path) -> LmtResult<SimulateResult> {
    let raw = std::fs::read_to_string(config_path)?;
    let mut config: serde_json::Value = serde_json::from_str(&raw)?;
    let obj = config.as_object_mut().ok_or_else(|| {
        LmtError::InvalidInput("simulate config must be a JSON object".into())
    })?;
    obj.insert(
        "out_dir".to_string(),
        serde_json::Value::String(out_dir.display().to_string()),
    );

    let args = SimulateArgs {
        config,
        progress_tx: None,
        cancel: None,
    };

    let out = rt()?.block_on(simulate(args)).map_err(map_vba_err)?;

    Ok(SimulateResult {
        dataset_dir: out.dataset_dir,
        n_views: out.n_views,
        n_observations: out.n_observations,
        seed: out.seed,
    })
}

// ---------------------------------------------------------------------------
// eval
// ---------------------------------------------------------------------------

/// Evaluate a method against a simulated dataset across a seed matrix, returning
/// the worst-case error metrics. `init` selects the BA initialisation:
/// "near_truth" (Phase-0 default) or "cold" (FIX-10a: the production init path).
pub fn run_eval(
    dataset_dir: &Path,
    method: &str,
    seed_matrix: Vec<i64>,
    init: &str,
) -> LmtResult<EvalResult> {
    let args = EvalArgs {
        dataset_dir: dataset_dir.display().to_string(),
        method: method.to_string(),
        seed_matrix,
        init: init.to_string(),
        progress_tx: None,
        cancel: None,
    };

    let out = rt()?.block_on(eval(args)).map_err(map_vba_err)?;

    Ok(EvalResult {
        method: out.method,
        seeds: out.seeds,
        max_size_error_mm: out.max_size_error_mm,
        rms_size_error_mm: out.rms_size_error_mm,
        max_distance_error_mm: out.max_distance_error_mm,
        max_angle_error_deg: out.max_angle_error_deg,
        holdout_rms_mm: out.holdout_rms_mm,
        holdout_p95_mm: out.holdout_p95_mm,
        holdout_max_mm: out.holdout_max_mm,
    })
}

// ---------------------------------------------------------------------------
// compare_known
// ---------------------------------------------------------------------------

/// Reconcile a reconstructed `cabinet_pose_report.json` against a user-filled
/// `known_geometry.json` (true monitor sizes + pairwise distances/angles).
/// Reads both files in the sidecar; writes nothing (write_safe).
pub fn run_compare_known(
    report_path: &Path,
    known_path: &Path,
    max_size_mm: Option<f64>,
    max_dist_mm: Option<f64>,
    max_angle_deg: Option<f64>,
) -> LmtResult<CompareKnownResult> {
    let args = CompareKnownArgs {
        report_path: report_path.display().to_string(),
        known_path: known_path.display().to_string(),
        max_size_mm,
        max_dist_mm,
        max_angle_deg,
        progress_tx: None,
        cancel: None,
    };

    let out = rt()?.block_on(compare_known(args)).map_err(map_vba_err)?;

    Ok(CompareKnownResult {
        cabinets: out
            .cabinets
            .into_iter()
            .map(|c| CabinetSizeCheck {
                cabinet_id: c.cabinet_id,
                size_error_mm: c.size_error_mm,
                pass: c.pass,
            })
            .collect(),
        pairs: out
            .pairs
            .into_iter()
            .map(|p| PairCheck {
                a: p.a,
                b: p.b,
                distance_error_mm: p.distance_error_mm,
                angle_error_deg: p.angle_error_deg,
                distance_pass: p.distance_pass,
                angle_pass: p.angle_pass,
            })
            .collect(),
        passed: out.passed,
        thresholds: out.thresholds,
    })
}

// ── plan-capture ──────────────────────────────────────────────────────────────

/// Parse `"3840x2160"` → `[3840, 2160]`.
fn parse_wxh(s: &str) -> LmtResult<[u32; 2]> {
    let (a, b) = s
        .split_once(['x', 'X'])
        .ok_or_else(|| LmtError::InvalidInput(format!("image-size must be WxH, got '{s}'")))?;
    let p = |t: &str| {
        t.trim()
            .parse::<u32>()
            .map_err(|_| LmtError::InvalidInput(format!("image-size component '{t}' invalid")))
            .and_then(|v| {
                if v == 0 {
                    Err(LmtError::InvalidInput(
                        "image-size components must be > 0".into(),
                    ))
                } else {
                    Ok(v)
                }
            })
    };
    Ok([p(a)?, p(b)?])
}

/// Parse `"2000..12000"` → `(2000.0, 12000.0)`; min must be < max.
fn parse_range(s: &str, name: &str) -> LmtResult<(f64, f64)> {
    let (a, b) = s
        .split_once("..")
        .ok_or_else(|| LmtError::InvalidInput(format!("{name} must be MIN..MAX, got '{s}'")))?;
    let lo = a
        .trim()
        .parse::<f64>()
        .map_err(|_| LmtError::InvalidInput(format!("{name} min '{a}' invalid")))?;
    let hi = b
        .trim()
        .parse::<f64>()
        .map_err(|_| LmtError::InvalidInput(format!("{name} max '{b}' invalid")))?;
    if !(lo < hi) {
        return Err(LmtError::InvalidInput(format!(
            "{name} needs MIN < MAX, got {lo}..{hi}"
        )));
    }
    Ok((lo, hi))
}

#[allow(clippy::too_many_arguments)]
pub fn run_plan_capture(
    project_path: &Path,
    screen_id: &str,
    image_size: &str,
    hfov_deg: Option<f64>,
    vfov_deg: Option<f64>,
    standoff: &str,
    height: &str,
    target_p95_residual_mm: f64,
    trials: u32,
    seed: u32,
    min_views: Option<u32>,
) -> LmtResult<volo_shared::dto::CapturePlan> {
    use volo_shared::dto::{CabinetCoverage, CapturePlan, CaptureStation, UnreachableRegion};

    if hfov_deg.is_some() == vfov_deg.is_some() {
        return Err(LmtError::InvalidInput(
            "pass exactly one of --hfov-deg / --vfov-deg".into(),
        ));
    }
    let image_size = parse_wxh(image_size)?;
    let (standoff_min_mm, standoff_max_mm) = parse_range(standoff, "standoff")?;
    let (height_min_mm, height_max_mm) = parse_range(height, "height")?;

    let cfg = load_project_yaml_from_path(project_path)?;
    let screen_cfg = load_screen(&cfg, screen_id)?;
    let project = ipc::ReconstructProject {
        screen_id: screen_id.to_string(),
        cabinet_array: ipc_cabinet_array(screen_cfg),
        shape_prior: ipc_shape_prior(screen_cfg),
    };

    let args = PlanCaptureArgs {
        project,
        image_size,
        hfov_deg,
        vfov_deg,
        standoff_min_mm,
        standoff_max_mm,
        height_min_mm,
        height_max_mm,
        target_p95_residual_mm,
        trials,
        seed,
        min_views,
        progress_tx: None,
        cancel: None,
    };
    let out = rt()?.block_on(plan_capture(args)).map_err(map_vba_err)?;

    Ok(CapturePlan {
        stations: out
            .stations
            .into_iter()
            .map(|s| CaptureStation {
                id: s.id,
                position_mm: s.position_mm,
                look_at_mm: s.look_at_mm,
                standoff_mm: s.standoff_mm,
                height_mm: s.height_mm,
                role: s.role,
                covers_cabinets: s.covers_cabinets,
            })
            .collect(),
        coverage: out
            .coverage
            .into_iter()
            .map(|c| CabinetCoverage {
                col: c.col,
                row: c.row,
                p95_residual_mm: c.p95_residual_mm,
                n_views: c.n_views,
                total_observations: c.total_observations,
                reconstructable: c.reconstructable,
                low_observation: c.low_observation,
                bridged: c.bridged,
                pass: c.pass,
                fail_reason: c.fail_reason,
            })
            .collect(),
        unreachable_regions: out
            .unreachable_regions
            .into_iter()
            .map(|u| UnreachableRegion {
                cabinets: u.cabinets,
                reason: u.reason,
            })
            .collect(),
        all_pass: out.all_pass,
        target_p95_residual_mm: out.target_p95_residual_mm,
    })
}

// ── capture guidance HTML card ────────────────────────────────────────────────

pub struct CardGeometry {
    pub total_width_mm: f64,
    pub total_height_mm: f64,
    pub radius_mm: Option<f64>,
    pub cols: u32,
    pub rows: u32,
}

pub struct CardIntrinsics {
    pub image_size: [u32; 2],
    pub hfov_deg: f64,
    pub vfov_deg: f64,
}


/// Render a self-contained interactive 3D HTML capture-guidance card (Three.js
/// inlined, fully offline). Serializes plan + geometry + intrinsics as JSON,
/// injects into the `capture_card_3d.html` template.
pub fn render_capture_card(
    plan: &volo_shared::dto::CapturePlan,
    geom: &CardGeometry,
    intrinsics: &CardIntrinsics,
    project_name: &str,
    screen_id: &str,
) -> String {
    let data = serde_json::json!({
        "project_name": project_name,
        "screen_id": screen_id,
        "screen": {
            "cols": geom.cols,
            "rows": geom.rows,
            "cabinet_size_mm": [
                geom.total_width_mm / geom.cols as f64,
                geom.total_height_mm / geom.rows as f64,
            ],
            "radius_mm": geom.radius_mm,
        },
        "intrinsics": {
            "image_size": intrinsics.image_size,
            "hfov_deg": intrinsics.hfov_deg,
            "vfov_deg": intrinsics.vfov_deg,
        },
        "plan": plan,
    });
    let three_bundle = include_str!("templates/three-bundle.min.js");
    let template = include_str!("templates/capture_card_3d.html");
    let safe_data = data.to_string()
        .replace("</", "<\\/")
        .replace("\u{2028}", "\\u2028")
        .replace("\u{2029}", "\\u2029");
    template
        .replacen("/*__THREE_BUNDLE__*/", three_bundle, 1)
        .replacen("/*__DATA__*/", &safe_data, 1)
}

#[allow(clippy::too_many_arguments)]
pub fn run_capture_card(
    project_path: &Path,
    screen_id: &str,
    image_size: &str,
    hfov_deg: Option<f64>,
    vfov_deg: Option<f64>,
    standoff: &str,
    height: &str,
    target_p95_residual_mm: f64,
    trials: u32,
    seed: u32,
) -> LmtResult<volo_shared::dto::CaptureCardResult> {
    let plan = run_plan_capture(
        project_path, screen_id, image_size, hfov_deg, vfov_deg, standoff, height,
        target_p95_residual_mm, trials, seed,
        None, // capture-card defers to the sidecar's default min_views (gates.MIN_VIEWS)
    )?;
    let cfg = load_project_yaml_from_path(project_path)?;
    let screen_cfg = load_screen(&cfg, screen_id)?;
    let [cols, rows] = screen_cfg.cabinet_count;
    let [cw, ch] = screen_cfg.cabinet_size_mm;
    let radius_mm = match &screen_cfg.shape_prior {
        volo_shared::dto::ShapePriorConfig::Curved { radius_mm, .. } => Some(*radius_mm),
        _ => None,
    };
    let geom = CardGeometry {
        total_width_mm: cols as f64 * cw,
        total_height_mm: rows as f64 * ch,
        radius_mm,
        cols,
        rows,
    };
    let img_sz = parse_wxh(image_size)?;
    let (hfov, vfov) = match (hfov_deg, vfov_deg) {
        (Some(h), None) => {
            let v = 2.0 * ((h / 2.0_f64).to_radians().tan() * img_sz[1] as f64 / img_sz[0] as f64).atan().to_degrees();
            (h, v)
        }
        (None, Some(v)) => {
            let h = 2.0 * ((v / 2.0_f64).to_radians().tan() * img_sz[0] as f64 / img_sz[1] as f64).atan().to_degrees();
            (h, v)
        }
        _ => unreachable!(),
    };
    let intrinsics = CardIntrinsics { image_size: img_sz, hfov_deg: hfov, vfov_deg: vfov };
    let html = render_capture_card(&plan, &geom, &intrinsics, &cfg.project.name, screen_id);
    Ok(volo_shared::dto::CaptureCardResult { html_content: html })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn render_capture_card_contains_3d_interactive_html() {
        use volo_shared::dto::{CabinetCoverage, CapturePlan, CaptureStation, UnreachableRegion};
        let plan = CapturePlan {
            stations: vec![
                CaptureStation {
                    id: "S01".into(),
                    position_mm: [250.0, 250.0, 3000.0],
                    look_at_mm: [250.0, 250.0, 0.0],
                    standoff_mm: 3000.0,
                    height_mm: 250.0,
                    role: "fan".into(),
                    covers_cabinets: vec![[0, 0]],
                },
                // a fan station LEFT of the 1000mm-wide wall (x < 0) — must not
                // be clipped off the SVG viewBox.
                CaptureStation {
                    id: "S02".into(),
                    position_mm: [-600.0, 250.0, 2000.0],
                    look_at_mm: [500.0, 250.0, 0.0],
                    standoff_mm: 2300.0,
                    height_mm: 250.0,
                    role: "fan".into(),
                    covers_cabinets: vec![[0, 0]],
                },
            ],
            coverage: vec![
                CabinetCoverage {
                    col: 0, row: 0, p95_residual_mm: Some(1.2), n_views: 4,
                    total_observations: 64, reconstructable: true, low_observation: false,
                    bridged: true, pass: true, fail_reason: None,
                },
                CabinetCoverage {
                    col: 1, row: 0, p95_residual_mm: None, n_views: 1,
                    total_observations: 16, reconstructable: false, low_observation: false,
                    bridged: false, pass: false, fail_reason: Some("low_coverage".into()),
                },
            ],
            unreachable_regions: vec![UnreachableRegion {
                cabinets: vec![[1, 0]],
                reason: "x".into(),
            }],
            all_pass: false,
            target_p95_residual_mm: 3.0,
        };
        let geom = CardGeometry {
            total_width_mm: 1000.0,
            total_height_mm: 500.0,
            radius_mm: None,
            cols: 2,
            rows: 1,
        };
        let intrinsics = CardIntrinsics {
            image_size: [1920, 1080],
            hfov_deg: 54.0,
            vfov_deg: 32.0,
        };
        let html = render_capture_card(&plan, &geom, &intrinsics, "Demo", "MAIN");
        assert!(html.starts_with("<!DOCTYPE html>"));
        assert!(html.contains("S01"), "station ID S01 in injected DATA");
        assert!(html.contains("PingFang SC"));
        assert!(html.contains("window.THREE"), "Three.js bundle inlined");
        assert!(html.contains("OrbitControls"), "OrbitControls inlined");
        assert!(html.contains("\"hfov_deg\":54"), "intrinsics injected");
        assert!(html.contains("\"cols\":2"), "screen geometry injected");
        assert!(!html.contains("/*__DATA__*/"), "DATA placeholder replaced");
        assert!(!html.contains("/*__THREE_BUNDLE__*/"), "THREE_BUNDLE placeholder replaced");
        assert!(!html.contains("https://"), "no CDN references — fully offline");
    }

    // ── sidecar wrapper plumbing (mirrors adapter's simulate_eval_test) ────────
    //
    // The real-sidecar round-trips below rely on a POSIX `.sh` wrapper and a
    // venv interpreter at `.venv/bin/python`, so they are `#[cfg(unix)]`-only.
    // On Windows the venv lives under `.venv/Scripts/` and there is no `.sh`
    // runner; these tests are excluded from compilation there (Windows CI
    // covers pytest + the cross-platform tests below + the packaging smoke).

    #[cfg(unix)]
    use std::path::PathBuf;
    #[cfg(unix)]
    use std::sync::Mutex;

    /// Serialize env-var mutation across tests in this binary, since they share
    /// the process and all touch LMT_VBA_SIDECAR_PATH.
    #[cfg(unix)]
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// Path to the project's python-sidecar venv interpreter, computed from this
    /// crate's manifest dir (`crates/mesh-app` → `../../python-sidecar/.venv/bin`).
    /// We canonicalize only the parent `.venv/bin` dir and KEEP the `python`
    /// basename: launching via that path activates the venv's sys.path, while
    /// canonicalizing the file would resolve the symlink to the bare interpreter.
    #[cfg(unix)]
    fn sidecar_python() -> Option<PathBuf> {
        let bin =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../python-sidecar/.venv/bin");
        let bin = bin.canonicalize().ok()?;
        let py = bin.join("python");
        if py.is_file() {
            Some(py)
        } else {
            None
        }
    }

    /// Write a `sh` wrapper that execs `python -m lmt_vba_sidecar "$@"`, chmod
    /// 0o755; locate_sidecar requires an existing FILE, so we point the env var
    /// at the script (not the bare interpreter).
    #[cfg(unix)]
    fn write_wrapper(dir: &Path, python: &Path) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let wrapper = dir.join("lmt-vba-sidecar");
        let script = format!(
            "#!/bin/sh\nexec \"{}\" -m lmt_vba_sidecar \"$@\"\n",
            python.display()
        );
        std::fs::write(&wrapper, script).expect("write wrapper");
        let mut perms = std::fs::metadata(&wrapper).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&wrapper, perms).expect("chmod wrapper");
        wrapper
    }

    // ── real-sidecar test: simulate → eval ─────────────────────────────────────

    #[cfg(unix)]
    #[test]
    fn simulate_then_eval_roundtrip() {
        let _guard = ENV_LOCK.lock().unwrap();

        let python = match sidecar_python() {
            Some(p) => p,
            None => {
                eprintln!("skipping simulate_then_eval_roundtrip: python-sidecar venv not found");
                return;
            }
        };

        let tmp = tempdir().expect("tmpdir");
        let wrapper = write_wrapper(tmp.path(), &python);
        std::env::set_var("LMT_VBA_SIDECAR_PATH", wrapper.to_str().unwrap());

        // Write a simulate config; out_dir is injected by run_simulate so we
        // leave it out here (the helper overwrites it anyway).
        let config = serde_json::json!({
            "scene": {
                "cabinet_array": {"cols": 2, "rows": 1, "cabinet_size_mm": [600, 340]},
                "shape_prior": "flat",
                "inter_board_angle_deg": 10.0
            },
            "cameras": {
                "n_views": 20,
                "distance_mm_range": [1500, 3000],
                "yaw_deg_range": [-40, 40],
                "pitch_deg_range": [-20, 20]
            },
            "intrinsics": {
                "K": [[2000, 0, 960], [0, 2000, 540], [0, 0, 1]],
                "dist_coeffs": [0, 0, 0, 0, 0],
                "image_size": [1920, 1080]
            },
            "noise": {"pixel_sigma": 0.3, "visibility_frac": 0.8},
            "seed": 2
        });
        let config_path = tmp.path().join("sim_config.json");
        std::fs::write(&config_path, serde_json::to_string(&config).unwrap()).unwrap();
        let dataset_dir = tmp.path().join("dataset");

        let sim = run_simulate(&config_path, &dataset_dir);
        let sim = match sim {
            Ok(s) => s,
            Err(e) => {
                std::env::remove_var("LMT_VBA_SIDECAR_PATH");
                panic!("run_simulate failed: {e}");
            }
        };
        assert_eq!(sim.n_views, 20, "n_views");
        assert_eq!(
            sim.dataset_dir,
            dataset_dir.display().to_string(),
            "dataset_dir echoes injected out_dir"
        );
        // scene.npz must exist on disk.
        assert!(
            dataset_dir.join("scene.npz").is_file(),
            "scene.npz missing in {}",
            dataset_dir.display()
        );

        let ev = run_eval(&dataset_dir, "charuco", vec![2], "near_truth");
        std::env::remove_var("LMT_VBA_SIDECAR_PATH");

        let ev = ev.expect("run_eval should succeed");
        assert_eq!(ev.method, "charuco");
        assert!(
            ev.max_distance_error_mm < 3.0,
            "max_distance_error_mm = {} should be < 3.0",
            ev.max_distance_error_mm
        );
    }

    // ── real-sidecar test: compare_known ───────────────────────────────────────

    #[cfg(unix)]
    #[test]
    fn compare_known_roundtrip() {
        let _guard = ENV_LOCK.lock().unwrap();

        let python = match sidecar_python() {
            Some(p) => p,
            None => {
                eprintln!("skipping compare_known_roundtrip: python-sidecar venv not found");
                return;
            }
        };

        let tmp = tempdir().expect("tmpdir");
        let wrapper = write_wrapper(tmp.path(), &python);

        let report = serde_json::json!({
            "schema_version": "visual_pose_report.v1",
            "frame": {},
            "cabinet_poses": [
                {
                    "cabinet_id": "V000_R000",
                    "position_mm": [0, 0, 0],
                    "normal": [0, 0, 1],
                    "rotation_matrix": [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                    "corners_mm": [[-300, -170, 0], [300, -170, 0], [300, 170, 0], [-300, 170, 0]],
                    "reprojection_rms_px": 0.4,
                    "observed_views": 7,
                    "observed_points": 120,
                    "quality": "ok"
                },
                {
                    "cabinet_id": "V001_R000",
                    "position_mm": [702, 0, 0],
                    "normal": [0.0, 0.0, 1.0],
                    "rotation_matrix": [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                    "corners_mm": [[-300, -170, 0], [300, -170, 0], [300, 170, 0], [-300, 170, 0]],
                    "reprojection_rms_px": 0.4,
                    "observed_views": 7,
                    "observed_points": 120,
                    "quality": "ok"
                }
            ]
        });
        let known = serde_json::json!({
            "cabinets": {"V000_R000": {"size_mm": [600, 340]}, "V001_R000": {"size_mm": [600, 340]}},
            "pairs": [{"a": "V000_R000", "b": "V001_R000", "distance_mm": 700.0, "angle_deg": 0.0}]
        });
        let report_path = tmp.path().join("report.json");
        let known_path = tmp.path().join("known.json");
        std::fs::write(&report_path, serde_json::to_string(&report).unwrap()).unwrap();
        std::fs::write(&known_path, serde_json::to_string(&known).unwrap()).unwrap();

        std::env::set_var("LMT_VBA_SIDECAR_PATH", wrapper.to_str().unwrap());
        let res = run_compare_known(&report_path, &known_path, None, None, None);
        // L4: a tighter --max-dist-mm 1.0 must flip the same 2mm error to a failure, and
        // the applied threshold is echoed back on the result.
        let tight = run_compare_known(&report_path, &known_path, None, Some(1.0), None);
        std::env::remove_var("LMT_VBA_SIDECAR_PATH");

        let res = res.expect("run_compare_known should succeed");
        assert!(res.passed, "2mm distance within default 3mm threshold");
        assert_eq!(res.pairs.len(), 1);
        assert!(
            (res.pairs[0].distance_error_mm - 2.0).abs() < 1e-6,
            "distance_error_mm = {} should be 2.0",
            res.pairs[0].distance_error_mm
        );

        let tight = tight.expect("run_compare_known (tight) should succeed");
        assert!(!tight.passed, "2mm distance must FAIL a 1.0mm threshold");
        assert_eq!(tight.thresholds.get("distance_mm"), Some(&1.0));
    }

    // ── error paths (no sidecar) ────────────────────────────────────────────────

    fn seed_project(dir: &Path) {
        let project_yaml = r#"
project:
  name: VBA_Test
  unit: mm
screens:
  MAIN:
    cabinet_count: [4, 2]
    cabinet_size_mm: [500.0, 500.0]
    pixels_per_cabinet: [256, 256]
    shape_prior:
      type: flat
    shape_mode: rectangle
    irregular_mask: []
coordinate_system:
  origin_point: MAIN_V001_R001
  x_axis_point: MAIN_V005_R001
  xy_plane_point: MAIN_V001_R003
output:
  target: neutral
  obj_filename: "{screen_id}.obj"
  weld_vertices_tolerance_mm: 1.0
  triangulate: true
"#;
        std::fs::write(dir.join("project.yaml"), project_yaml).unwrap();
    }

    #[test]
    fn reconstruct_unknown_screen_is_not_found() {
        let dir = tempdir().unwrap();
        seed_project(dir.path());
        let manifest = dir.path().join("capture_manifest.json");
        let err = run_reconstruct(dir.path(), "FLOOR", &manifest, None, None).unwrap_err();
        assert!(matches!(err, LmtError::NotFound(_)), "got: {err:?}");
        assert!(format!("{err}").contains("FLOOR"), "got: {err}");
    }

    #[test]
    fn reconstruct_missing_project_yaml_errors() {
        let dir = tempdir().unwrap();
        let manifest = dir.path().join("capture_manifest.json");
        let err = run_reconstruct(dir.path(), "MAIN", &manifest, None, None).unwrap_err();
        assert!(format!("{err}").contains("project.yaml"), "got: {err}");
    }

    #[test]
    fn generate_pattern_rejects_unknown_method() {
        let dir = tempdir().unwrap();
        seed_project(dir.path());
        let err = run_generate_pattern(dir.path(), "MAIN", "gray_code", 0, None).unwrap_err();
        assert!(matches!(err, LmtError::InvalidInput(_)), "got: {err:?}");
        assert!(format!("{err}").contains("vpqsp"), "got: {err}");
    }

    #[test]
    fn generate_pattern_unknown_screen_is_not_found() {
        let dir = tempdir().unwrap();
        seed_project(dir.path());
        let err = run_generate_pattern(dir.path(), "FLOOR", "charuco", 0, None).unwrap_err();
        assert!(matches!(err, LmtError::NotFound(_)), "got: {err:?}");
    }

    #[test]
    fn calibrate_missing_dir_is_not_found() {
        let dir = tempdir().unwrap();
        let missing = dir.path().join("does_not_exist");
        let err = run_calibrate(dir.path(), "MAIN", &missing, 25.0, "9x9").unwrap_err();
        assert!(matches!(err, LmtError::NotFound(_)), "got: {err:?}");
    }

    #[test]
    fn calibrate_bad_inner_corners_is_invalid_input() {
        let dir = tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("imgs")).unwrap();
        let err =
            run_calibrate(dir.path(), "MAIN", &dir.path().join("imgs"), 25.0, "nope").unwrap_err();
        assert!(matches!(err, LmtError::InvalidInput(_)), "got: {err:?}");
    }

    #[test]
    fn parse_inner_corners_ok_and_errors() {
        assert_eq!(parse_inner_corners("9x9").unwrap(), [9, 9]);
        assert_eq!(parse_inner_corners("7X5").unwrap(), [7, 5]);
        assert!(parse_inner_corners("9").is_err());
        assert!(parse_inner_corners("0x5").is_err());
    }
}
