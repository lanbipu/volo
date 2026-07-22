//! AR (vpcal) solve-run history.
//!
//! vpcal `quick run` writes each solve to `<output_dir>/result.json`
//! (`CalibrationResult.model_dump`, sidecars/vpcal .../models/calibration.py).
//! There is no separate runs registry, so "history" here is a directory scan:
//! given a runs-root the operator points at, we enumerate its immediate child
//! dirs (and the root itself) that contain a `result.json`, parse each, and
//! return a summary sorted newest-first. No new on-disk format is invented —
//! we read what the pipeline already emits. Non-parseable entries are skipped.

use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use mesh_app::lens_workspace::{
    assignment_from_screens, LensAssignment, LensPatternsMeta, PATTERNS_META_SCHEMA,
};
use mesh_app::projects::load_project_yaml_from_path;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use volo_shared::error::{VoloError, VoloResult};

#[derive(Debug, Clone, Serialize)]
pub struct ArRunSummary {
    /// Run identifier — the containing directory name.
    pub id: String,
    /// Absolute path to the run's `result.json`.
    pub result_path: String,
    /// ISO timestamp from `result.json` (`timestamp`), when present.
    pub timestamp: Option<String>,
    pub schema_version: Option<String>,
    pub reprojection_rms_px: Option<f64>,
    pub validation_rms_px: Option<f64>,
    pub confidence: Option<String>,
    pub num_poses: Option<u64>,
}

fn summarize(result_json: &Path) -> Option<ArRunSummary> {
    let txt = fs::read_to_string(result_json).ok()?;
    let v: Value = serde_json::from_str(&txt).ok()?;
    let q = v.get("quality");
    let id = result_json
        .parent()
        .and_then(|p| p.file_name())
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "run".to_string());
    Some(ArRunSummary {
        id,
        result_path: result_json.to_string_lossy().into_owned(),
        timestamp: v.get("timestamp").and_then(Value::as_str).map(str::to_string),
        schema_version: v
            .get("schema_version")
            .and_then(Value::as_str)
            .map(str::to_string),
        reprojection_rms_px: q
            .and_then(|q| q.get("reprojection_rms_px"))
            .and_then(Value::as_f64),
        validation_rms_px: q
            .and_then(|q| q.get("validation_rms_px"))
            .and_then(Value::as_f64),
        confidence: q
            .and_then(|q| q.get("confidence"))
            .and_then(Value::as_str)
            .map(str::to_string),
        num_poses: q.and_then(|q| q.get("num_poses")).and_then(Value::as_u64),
    })
}

/// List AR solve runs under `runs_root` by scanning for `result.json` files
/// (the root itself and its immediate child directories). Newest-first.
#[tauri::command]
pub fn list_ar_runs(runs_root: String) -> VoloResult<Vec<ArRunSummary>> {
    let root = Path::new(&runs_root);
    if !root.is_dir() {
        return Err(VoloError::InvalidInput(format!(
            "runs_root is not a directory: {runs_root}"
        )));
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    let root_result = root.join("result.json");
    if root_result.is_file() {
        candidates.push(root_result);
    }
    for entry in fs::read_dir(root)?.flatten() {
        let p = entry.path();
        if p.is_dir() {
            let rj = p.join("result.json");
            if rj.is_file() {
                candidates.push(rj);
            }
        }
    }

    let mut runs: Vec<ArRunSummary> = candidates.iter().filter_map(|p| summarize(p)).collect();
    // Newest first; entries without a timestamp sort last.
    runs.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Ok(runs)
}

/// Lens capture session summary — scanned from `session.json` written by
/// `vpcal capture session` (`CaptureSessionRunner._assemble`,
/// sidecars/vpcal/src/vpcal/core/capture_session.py). Same directory-scan
/// approach as `list_ar_runs`: no separate session registry exists, we read
/// what the capture pipeline already writes to disk.
#[derive(Debug, Clone, Serialize)]
pub struct LensSessionSummary {
    /// Session identifier — the containing directory name.
    pub id: String,
    /// Absolute path to the session directory.
    pub session_dir: String,
    /// Absolute path to the session's `session.json` (tracked) or
    /// `fixed_run.json` (fixed / tracker-free). Empty string if neither.
    pub session_json_path: String,
    /// `"tracked"` (`session.json`) or `"fixed"` (`fixed_run.json` / stills).
    pub mode: String,
    /// True when the run carries capture-time intrinsics / lens suitable for
    /// solve (does **not** mean a Stage pose has already been solved).
    pub lens_ready: bool,
    /// True when a fixed Stage pose artifact exists (`stage_pose.json` or
    /// `fixed_run.json` meta `stage_pose` / `stage_pose_json`).
    pub stage_pose_ready: bool,
    /// `missing`, `invalid`, or `formal`; legacy/unqualified artifacts are invalid.
    pub stage_pose_status: String,
    /// Solved Stage pose payload (RMS / inliers / camera_from_stage, …) when
    /// available — from `stage_pose.json` or embedded meta `stage_pose`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage_pose: Option<Value>,
    /// Captured pose/frame count — tracked: `tracking/poses.jsonl` lines;
    /// fixed: `captures/normal/*.png` count (or `fixed_run.json` frames).
    pub poses_captured: Option<u64>,
    /// Meta mtime, RFC3339 (best-effort; `None` if unreadable).
    pub modified_at: Option<String>,
    /// Absolute path to quick-run / fixed output dir when known
    /// (`<session>/output` or stills dir itself).
    pub output_dir: Option<String>,
    /// Non-fatal scan issue (e.g. corrupt `fixed_run.json`); entry is still listed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Capture-time multi-screen target contract (paths + VP-QSP assignments).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub targets: Option<Value>,
    /// Camera/run ownership and immutable fixed-run intrinsics snapshot.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub camera_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lens_json: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intrinsics: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intrinsics_error: Option<String>,
}

fn count_normal_pngs(session_dir: &Path) -> Option<u64> {
    let dir = session_dir.join("captures").join("normal");
    if !dir.is_dir() {
        return None;
    }
    let n = fs::read_dir(&dir)
        .ok()?
        .flatten()
        .filter(|e| {
            e.path()
                .extension()
                .and_then(|x| x.to_str())
                .map(|x| x.eq_ignore_ascii_case("png"))
                .unwrap_or(false)
        })
        .count() as u64;
    Some(n)
}

fn qualified_master_lens(path: &Path) -> bool {
    let Ok(text) = fs::read_to_string(path) else { return false };
    let Ok(lens) = serde_json::from_str::<Value>(&text) else { return false };
    let image_size_ok = lens
        .get("image_size")
        .and_then(Value::as_array)
        .is_some_and(|v| v.len() >= 2 && v[0].as_u64().unwrap_or(0) > 0 && v[1].as_u64().unwrap_or(0) > 0);
    lens.get("is_master").and_then(Value::as_bool) == Some(true)
        && lens.get("session_coupled").and_then(Value::as_bool) != Some(true)
        && matches!(
            lens.get("calibration_kind").and_then(Value::as_str),
            Some("multi_view_intrinsics" | "offline_chart")
        )
        && lens.get("num_images").and_then(Value::as_u64).unwrap_or(0) >= 8
        && lens.get("num_points").and_then(Value::as_u64).unwrap_or(0) >= 60
        && lens.get("rms").and_then(Value::as_f64).is_some_and(|v| v.is_finite() && v < 2.0)
        && image_size_ok
}

fn formal_stage_pose(value: &Value) -> bool {
    let image_size_ok = value
        .get("image_size")
        .and_then(Value::as_array)
        .is_some_and(|v| v.len() >= 2 && v[0].as_u64().unwrap_or(0) > 0 && v[1].as_u64().unwrap_or(0) > 0);
    value.get("schema_version").and_then(Value::as_str) == Some("volo_stage_pose.v2")
        && value.get("formal").and_then(Value::as_bool) == Some(true)
        && value.pointer("/qualification/passed").and_then(Value::as_bool) == Some(true)
        && value.pointer("/qualification/master_lens").and_then(Value::as_bool) == Some(true)
        && value.pointer("/preflight/passed").and_then(Value::as_bool) == Some(true)
        && value.get("rms_reprojection_px").and_then(Value::as_f64).is_some_and(|v| v.is_finite() && v < 2.0)
        && image_size_ok
}

fn file_mtime_rfc3339(path: &Path) -> Option<String> {
    fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339())
}

fn summarize_session(session_json: &Path) -> Option<LensSessionSummary> {
    let txt = fs::read_to_string(session_json).ok()?;
    let v: Value = serde_json::from_str(&txt).ok()?;
    let session_dir = session_json.parent()?;
    let id = session_dir
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "session".to_string());
    /* Tracked: lens profile inline in session.json (SessionConfig.lens).
       Do NOT treat output/result.json alone as ready — that is solve output,
       not the lens profile quick-run requires. */
    let lens_ready = v.get("lens").is_some();
    let poses_captured = fs::read_to_string(session_dir.join("tracking").join("poses.jsonl"))
        .ok()
        .map(|txt| txt.lines().filter(|l| !l.trim().is_empty()).count() as u64);
    let output = session_dir.join("output");
    Some(LensSessionSummary {
        id,
        session_dir: session_dir.to_string_lossy().into_owned(),
        session_json_path: session_json.to_string_lossy().into_owned(),
        mode: "tracked".into(),
        lens_ready,
        stage_pose_ready: false,
        stage_pose_status: "missing".into(),
        stage_pose: None,
        poses_captured,
        modified_at: file_mtime_rfc3339(session_json),
        output_dir: if output.is_dir() {
            Some(output.to_string_lossy().into_owned())
        } else {
            None
        },
        error: None,
        targets: v.get("screens").cloned(),
        camera_id: None,
        lens_json: None,
        intrinsics: None,
        intrinsics_error: None,
    })
}

fn summarize_fixed_run(dir: &Path) -> Option<LensSessionSummary> {
    let fixed_meta = dir.join("fixed_run.json");
    let has_meta = fixed_meta.is_file();
    let png_count = count_normal_pngs(dir).unwrap_or(0);
    if !has_meta && png_count == 0 {
        return None;
    }
    /* Prefer fixed_run.json; also accept stills dirs that only have captures. */
    if !has_meta {
        /* Avoid treating tracked sessions (session.json) as fixed. */
        if dir.join("session.json").is_file() {
            return None;
        }
    }
    let id = dir
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "fixed".to_string());
    let mut meta_error: Option<String> = None;
    let meta_value = if has_meta {
        match fs::read_to_string(&fixed_meta) {
            Ok(txt) => match serde_json::from_str::<Value>(&txt) {
                Ok(v) => Some(v),
                Err(e) => {
                    meta_error = Some(format!("fixed_run.json 损坏: {e}"));
                    None
                }
            },
            Err(e) => {
                meta_error = Some(format!("无法读取 fixed_run.json: {e}"));
                None
            }
        }
    } else {
        None
    };
    let (frames, modified_at, meta_path) = if let Some(ref v) = meta_value {
        let frames = v
            .get("frames_captured")
            .and_then(Value::as_u64)
            .or(Some(png_count));
        (
            frames,
            file_mtime_rfc3339(&fixed_meta),
            fixed_meta.to_string_lossy().into_owned(),
        )
    } else {
        (
            Some(png_count),
            if has_meta {
                file_mtime_rfc3339(&fixed_meta)
            } else {
                file_mtime_rfc3339(dir)
            },
            if has_meta {
                fixed_meta.to_string_lossy().into_owned()
            } else {
                String::new()
            },
        )
    };
    let lens_json = meta_value
        .as_ref()
        .and_then(|v| v.get("lens_json"))
        .and_then(Value::as_str)
        .filter(|path| !path.is_empty())
        .map(str::to_string)
        .or_else(|| {
            let path = dir.join("lens.json");
            path.is_file().then(|| path.to_string_lossy().into_owned())
        });
    let intrinsics = meta_value.as_ref().and_then(|v| v.get("intrinsics")).cloned();
    /* Capture-time intrinsics / lens only — Stage pose is tracked separately. */
    let lens_ready = lens_json
        .as_deref()
        .map(Path::new)
        .is_some_and(qualified_master_lens);
    let stage_pose_path = meta_value
        .as_ref()
        .and_then(|v| v.get("stage_pose_json"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .filter(|p| p.is_file())
        .or_else(|| {
            let path = dir.join("stage_pose.json");
            path.is_file().then_some(path)
        });
    let stage_pose = stage_pose_path
        .as_ref()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|txt| serde_json::from_str::<Value>(&txt).ok())
        .or_else(|| {
            meta_value
                .as_ref()
                .and_then(|v| v.get("stage_pose"))
                .filter(|v| v.is_object())
                .cloned()
        });
    let stage_pose_ready = stage_pose.as_ref().is_some_and(formal_stage_pose);
    let stage_pose_status = if stage_pose_ready {
        "formal"
    } else if stage_pose.is_some() || stage_pose_path.is_some() {
        "invalid"
    } else {
        "missing"
    };
    let targets = meta_value.as_ref().and_then(|v| v.get("targets")).cloned();
    let camera_id = meta_value
        .as_ref()
        .and_then(|v| v.get("camera_id"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let intrinsics_error = meta_value
        .as_ref()
        .and_then(|v| v.get("intrinsics_error"))
        .and_then(Value::as_str)
        .map(str::to_string);
    Some(LensSessionSummary {
        id,
        session_dir: dir.to_string_lossy().into_owned(),
        session_json_path: meta_path,
        mode: "fixed".into(),
        lens_ready,
        stage_pose_ready,
        stage_pose_status: stage_pose_status.into(),
        stage_pose,
        poses_captured: frames,
        modified_at,
        output_dir: Some(dir.to_string_lossy().into_owned()),
        error: meta_error,
        targets,
        camera_id,
        lens_json,
        intrinsics,
        intrinsics_error,
    })
}

fn approve_capture_pngs(
    approved: &tauri::State<'_, crate::commands::sidecar_stream::ApprovedImagePaths>,
    session_dir: &Path,
) {
    let dir = session_dir.join("captures").join("normal");
    let Ok(entries) = fs::read_dir(&dir) else {
        return;
    };
    let Ok(mut guard) = approved.0.lock() else {
        return;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if crate::commands::sidecar_stream::is_preview_image_path(&p) {
            if let Ok(canon) = p.canonicalize() {
                guard.insert(canon);
            }
        }
    }
}

/// List lens capture sessions under `sessions_root` by scanning for
/// `session.json` (tracked) and `fixed_run.json` / stills dirs (fixed).
/// Newest-first. Also approves `captures/normal/*` images for thumbnail reads.
#[tauri::command]
pub fn list_lens_sessions(
    approved: tauri::State<'_, crate::commands::sidecar_stream::ApprovedImagePaths>,
    sessions_root: String,
) -> VoloResult<Vec<LensSessionSummary>> {
    let root = Path::new(&sessions_root);
    if !root.is_dir() {
        return Err(VoloError::InvalidInput(format!(
            "sessions_root is not a directory: {sessions_root}"
        )));
    }

    let mut sessions: Vec<LensSessionSummary> = Vec::new();
    let mut seen = std::collections::HashSet::<PathBuf>::new();

    let mut consider_dir = |dir: &Path| {
        let canon = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
        if !seen.insert(canon.clone()) {
            return;
        }
        if let Some(s) = summarize_session(&dir.join("session.json")) {
            approve_capture_pngs(&approved, dir);
            sessions.push(s);
            return;
        }
        if let Some(s) = summarize_fixed_run(dir) {
            approve_capture_pngs(&approved, dir);
            sessions.push(s);
        }
    };

    consider_dir(root);
    for entry in fs::read_dir(root)?.flatten() {
        let p = entry.path();
        if p.is_dir() {
            consider_dir(&p);
        }
    }

    sessions.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    Ok(sessions)
}

/// Read a local image file and return it as a `data:` URL, so the frontend
/// can display on-disk images (`verify overlay`'s `annotated_images[]` PNGs)
/// without a Tauri asset-protocol scope — these live under whatever
/// runs/output directory the operator points the AR workspace at, which
/// isn't known at build time, so a static capability scope pattern wouldn't
/// cover them.
///
/// `path` must be one Rust itself already saw or produced: either a real
/// subprocess image reported through parsed stdout, or an image artifact from
/// a Rust-owned generator such as `mesh_visual_generate_pattern`.
/// A caller-supplied "base directory" was tried first and rejected in
/// review: the caller controls both the path and the claimed base, so it
/// could always pick a base that contains whatever path it wanted — that
/// check constrained nothing. Membership in a Rust-populated allowlist is
/// the only check a compromised renderer can't route around by construction.
#[tauri::command]
pub fn read_image_as_data_url(
    approved: tauri::State<'_, crate::commands::sidecar_stream::ApprovedImagePaths>,
    path: String,
) -> VoloResult<String> {
    const MAX_IMAGE_BYTES: u64 = 50 * 1024 * 1024;

    let mime = match Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        other => {
            return Err(VoloError::InvalidInput(format!(
                "unsupported image extension: {other:?}"
            )));
        }
    };

    let canon_path = Path::new(&path)
        .canonicalize()
        .map_err(|e| VoloError::Io(format!("failed to resolve image path {path}: {e}")))?;
    {
        let allowed = approved
            .0
            .lock()
            .map_err(|e| VoloError::Io(format!("approved-image registry poisoned: {e}")))?;
        if !allowed.contains(&canon_path) {
            return Err(VoloError::InvalidInput(format!(
                "{path} was not approved by a Rust-owned image workflow this session"
            )));
        }
    }

    let meta = fs::metadata(&canon_path)
        .map_err(|e| VoloError::Io(format!("failed to stat image {path}: {e}")))?;
    if meta.len() > MAX_IMAGE_BYTES {
        return Err(VoloError::InvalidInput(format!(
            "{path} is {} bytes, exceeds the {MAX_IMAGE_BYTES}-byte cap",
            meta.len()
        )));
    }

    let bytes = fs::read(&canon_path)
        .map_err(|e| VoloError::Io(format!("failed to read image {path}: {e}")))?;
    Ok(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

/// Read the one QA artifact the Lens report UI consumes. The renderer cannot
/// provide a filename: it provides a run directory and Rust fixes the relative
/// allowlist entry to `qa/reprojection.json`. Canonical containment rejects a
/// symlinked `qa` directory or report file that escapes the run directory.
#[tauri::command]
pub fn read_lens_qa_report(run_dir: String) -> VoloResult<Value> {
    const MAX_REPORT_BYTES: u64 = 16 * 1024 * 1024;

    let root = Path::new(&run_dir).canonicalize().map_err(|e| {
        VoloError::Io(format!(
            "failed to resolve lens run directory {run_dir}: {e}"
        ))
    })?;
    if !root.is_dir() {
        return Err(VoloError::InvalidInput(format!(
            "lens run path is not a directory: {run_dir}"
        )));
    }
    let report = root.join("qa").join("reprojection.json");
    let report = report.canonicalize().map_err(|e| {
        VoloError::Io(format!(
            "failed to resolve {}/qa/reprojection.json: {e}",
            root.display()
        ))
    })?;
    if !report.starts_with(&root) {
        return Err(VoloError::InvalidInput(
            "qa/reprojection.json escapes the selected lens run directory".into(),
        ));
    }
    let meta = fs::metadata(&report)?;
    if !meta.is_file() {
        return Err(VoloError::InvalidInput(
            "qa/reprojection.json is not a regular file".into(),
        ));
    }
    if meta.len() > MAX_REPORT_BYTES {
        return Err(VoloError::InvalidInput(format!(
            "qa/reprojection.json is {} bytes, exceeds the {MAX_REPORT_BYTES}-byte cap",
            meta.len()
        )));
    }
    let bytes = fs::read(&report)?;
    serde_json::from_slice(&bytes)
        .map_err(|e| VoloError::InvalidInput(format!("invalid qa/reprojection.json: {e}")))
}

/// Persist fixed-pose stills run metadata (`fixed_run.json`) next to
/// `captures/normal/`. Existing fields are preserved so solve-time updates do
/// not discard capture-time targets/intrinsics. When supplied, the external
/// lens profile is copied into the run as immutable `lens.json`.
#[tauri::command]
pub fn write_fixed_run_meta(
    session_dir: String,
    meta: Value,
    lens_source_path: Option<String>,
) -> VoloResult<()> {
    let dir = Path::new(&session_dir);
    if !dir.is_dir() {
        fs::create_dir_all(dir).map_err(|e| {
            VoloError::Io(format!("failed to create session dir {session_dir}: {e}"))
        })?;
    }
    let path = dir.join("fixed_run.json");
    let mut merged = if path.is_file() {
        fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default()
    } else {
        serde_json::Map::new()
    };
    let incoming = meta.as_object().ok_or_else(|| {
        VoloError::InvalidInput("fixed_run meta must be a JSON object".into())
    })?;
    for (key, value) in incoming {
        merged.insert(key.clone(), value.clone());
    }

    if let Some(source) = lens_source_path.filter(|value| !value.trim().is_empty()) {
        const MAX_LENS_BYTES: u64 = 4 * 1024 * 1024;
        let source = Path::new(&source).canonicalize().map_err(|e| {
            VoloError::Io(format!("failed to resolve lens profile {source}: {e}"))
        })?;
        let metadata = fs::metadata(&source)?;
        if !metadata.is_file() || metadata.len() > MAX_LENS_BYTES {
            return Err(VoloError::InvalidInput(format!(
                "lens profile must be a regular JSON file no larger than {MAX_LENS_BYTES} bytes"
            )));
        }
        let lens_bytes = fs::read(&source)?;
        let lens_value: Value = serde_json::from_slice(&lens_bytes)
            .map_err(|e| VoloError::InvalidInput(format!("invalid lens profile JSON: {e}")))?;
        if !lens_value.is_object() {
            return Err(VoloError::InvalidInput(
                "lens profile JSON must contain an object".into(),
            ));
        }
        let snapshot = dir.join("lens.json");
        fs::write(&snapshot, &lens_bytes).map_err(|e| {
            VoloError::Io(format!("failed to snapshot {}: {e}", snapshot.display()))
        })?;
        merged.insert(
            "lens_json".into(),
            Value::String(snapshot.to_string_lossy().into_owned()),
        );
        merged.insert(
            "lens_sha256".into(),
            Value::String(format!("{:x}", Sha256::digest(&lens_bytes))),
        );
    }

    let bytes = serde_json::to_vec_pretty(&Value::Object(merged))
        .map_err(|e| VoloError::InvalidInput(format!("invalid fixed_run meta: {e}")))?;
    fs::write(&path, bytes)
        .map_err(|e| VoloError::Io(format!("failed to write {}: {e}", path.display())))?;
    Ok(())
}

/// Delete one lens capture session directory under `sessions_root`.
/// Path must canonicalize to a real subdirectory of the sessions root (not the
/// root itself) so the renderer cannot escape into arbitrary filesystem trees.
#[tauri::command]
pub fn delete_lens_session(sessions_root: String, session_dir: String) -> VoloResult<()> {
    let root = Path::new(&sessions_root).canonicalize().map_err(|e| {
        VoloError::Io(format!(
            "failed to resolve sessions_root {sessions_root}: {e}"
        ))
    })?;
    if !root.is_dir() {
        return Err(VoloError::InvalidInput(format!(
            "sessions_root is not a directory: {sessions_root}"
        )));
    }
    let dir = Path::new(&session_dir).canonicalize().map_err(|e| {
        VoloError::Io(format!("failed to resolve session_dir {session_dir}: {e}"))
    })?;
    if !dir.is_dir() {
        return Err(VoloError::InvalidInput(format!(
            "session_dir is not a directory: {session_dir}"
        )));
    }
    if dir == root {
        return Err(VoloError::InvalidInput(
            "refusing to delete the sessions root itself".into(),
        ));
    }
    if !dir.starts_with(&root) {
        return Err(VoloError::InvalidInput(format!(
            "session_dir escapes sessions_root: {session_dir}"
        )));
    }
    let looks_like_session = dir.join("session.json").is_file()
        || dir.join("fixed_run.json").is_file()
        || dir.join("captures").join("normal").is_dir();
    if !looks_like_session {
        return Err(VoloError::InvalidInput(format!(
            "refusing to delete non-session directory: {session_dir}"
        )));
    }
    fs::remove_dir_all(&dir).map_err(|e| {
        VoloError::Io(format!("failed to delete {}: {e}", dir.display()))
    })?;
    Ok(())
}

/* ============================================================================
   Lens capture auto-path workspace (B1–B3)
   ————————————————————————————————————————————————————————————————————————————
   Directory skeleton (§2), assignment.json sync (§3.3) and patterns meta.json
   read/write (§3.2). Paths are derived from `project_path` here so no page can
   drift on layout; pattern generation itself stays in the frontend sidecar path.
   ========================================================================== */

fn vpcal_dir(project_path: &str) -> PathBuf {
    Path::new(project_path).join("vpcal")
}

fn patterns_dir(project_path: &str, screen_id: &str) -> PathBuf {
    vpcal_dir(project_path).join("patterns").join(screen_id)
}

/// B1 — create the §2 directory skeleton (idempotent). Called at project
/// open/create as a pre-warm; every writer still `create_dir_all`s lazily.
#[tauri::command]
pub fn lens_workspace_ensure(project_path: String) -> VoloResult<()> {
    let root = vpcal_dir(&project_path);
    for sub in ["patterns", "captures"] {
        fs::create_dir_all(root.join(sub)).map_err(|e| {
            VoloError::Io(format!(
                "failed to create {}: {e}",
                root.join(sub).display()
            ))
        })?;
    }
    Ok(())
}

/// B3 — recompute the deterministic screen-id / cab-col-offset assignment from
/// `project.yaml` and persist `<project>/vpcal/assignment.json`. Returns the
/// full table so the caller can pick per-screen `{code, offset}`.
#[tauri::command]
pub fn lens_assignment_sync(project_path: String) -> VoloResult<LensAssignment> {
    let config = load_project_yaml_from_path(Path::new(&project_path))?;
    let assignment = assignment_from_screens(&config.screens)?;
    let root = vpcal_dir(&project_path);
    fs::create_dir_all(&root)
        .map_err(|e| VoloError::Io(format!("failed to create {}: {e}", root.display())))?;
    let path = root.join("assignment.json");
    let bytes = serde_json::to_vec_pretty(&assignment)
        .map_err(|e| VoloError::InvalidInput(format!("invalid assignment: {e}")))?;
    fs::write(&path, bytes)
        .map_err(|e| VoloError::Io(format!("failed to write {}: {e}", path.display())))?;
    Ok(assignment)
}

/// B2 (read) — parse `patterns/<screen_id>/meta.json` plus a disk stat of the
/// referenced PNGs, so the frontend freshness check (§3.2) can also detect a
/// meta whose image files were deleted. A missing / unparseable / wrong-schema
/// meta returns `meta: None` (treated as stale → regenerate).
#[derive(Debug, Clone, Serialize)]
pub struct LensPatternsMetaStatus {
    pub meta: Option<LensPatternsMeta>,
    pub files_present: bool,
}

#[tauri::command]
pub fn lens_patterns_meta_read(
    project_path: String,
    screen_id: String,
) -> VoloResult<LensPatternsMetaStatus> {
    let dir = patterns_dir(&project_path, &screen_id);
    let meta_path = dir.join("meta.json");
    let meta: Option<LensPatternsMeta> = match fs::read_to_string(&meta_path) {
        Ok(txt) => match serde_json::from_str::<LensPatternsMeta>(&txt) {
            Ok(m) if m.schema_version == PATTERNS_META_SCHEMA => Some(m),
            _ => None,
        },
        Err(_) => None,
    };
    let files_present = match &meta {
        Some(m) if !m.files.is_empty() => m.files.iter().all(|f| dir.join(f).is_file()),
        _ => false,
    };
    Ok(LensPatternsMetaStatus {
        meta,
        files_present,
    })
}

/// B2 (write) — persist `patterns/<screen_id>/meta.json` after a successful
/// generation. `create_dir_all` covers the lazy-creation contract (D1). The
/// typed input makes serde reject a malformed meta; schema_version is enforced.
#[tauri::command]
pub fn lens_patterns_meta_write(
    project_path: String,
    screen_id: String,
    meta: LensPatternsMeta,
) -> VoloResult<()> {
    if meta.schema_version != PATTERNS_META_SCHEMA {
        return Err(VoloError::InvalidInput(format!(
            "lens patterns meta schema_version must be {PATTERNS_META_SCHEMA}, got {}",
            meta.schema_version
        )));
    }
    let dir = patterns_dir(&project_path, &screen_id);
    fs::create_dir_all(&dir)
        .map_err(|e| VoloError::Io(format!("failed to create {}: {e}", dir.display())))?;
    let path = dir.join("meta.json");
    let bytes = serde_json::to_vec_pretty(&meta)
        .map_err(|e| VoloError::InvalidInput(format!("invalid patterns meta: {e}")))?;
    fs::write(&path, bytes)
        .map_err(|e| VoloError::Io(format!("failed to write {}: {e}", path.display())))?;
    Ok(())
}

#[cfg(test)]
mod qa_report_tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn reads_only_fixed_qa_report_child() {
        let run = tempdir().unwrap();
        fs::create_dir(run.path().join("qa")).unwrap();
        fs::write(
            run.path().join("qa/reprojection.json"),
            br#"{"global_rms_px":0.5,"per_pose":[]}"#,
        )
        .unwrap();
        let value = read_lens_qa_report(run.path().display().to_string()).unwrap();
        assert_eq!(value["global_rms_px"], 0.5);
    }

    #[test]
    fn fixed_run_preserves_capture_snapshot_across_solve_updates() {
        let run = tempdir().unwrap();
        let source = tempdir().unwrap();
        let source_lens = source.path().join("profile.json");
        fs::write(
            &source_lens,
            br#"{"fx":1200,"fy":1200,"cx":960,"cy":540,"dist_coeffs":[0,0,0,0,0],"image_size":[1920,1080],"rms":0.4,"num_images":8,"num_points":120,"calibration_kind":"multi_view_intrinsics","is_master":true,"session_coupled":false}"#,
        )
        .unwrap();

        write_fixed_run_meta(
            run.path().display().to_string(),
            serde_json::json!({
                "mode": "fixed",
                "camera_id": "cam-a",
                "targets": [{"id": "screen-a", "screenJson": "/stage/a.screen.json"}],
                "intrinsics": {
                    "fx": 1200.0, "fy": 1200.0, "cx": 960.0, "cy": 540.0,
                    "image_size": [1920, 1080]
                }
            }),
            Some(source_lens.display().to_string()),
        )
        .unwrap();
        write_fixed_run_meta(
            run.path().display().to_string(),
            serde_json::json!({
                "stage_pose_json": run.path().join("stage_pose.json").display().to_string()
            }),
            None,
        )
        .unwrap();

        let meta: Value = serde_json::from_slice(
            &fs::read(run.path().join("fixed_run.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(meta["camera_id"], "cam-a");
        assert_eq!(meta["targets"][0]["id"], "screen-a");
        assert_eq!(meta["intrinsics"]["image_size"], serde_json::json!([1920, 1080]));
        assert!(run.path().join("lens.json").is_file());
        assert_eq!(meta["lens_sha256"].as_str().unwrap().len(), 64);

        let summary = summarize_fixed_run(run.path()).unwrap();
        assert_eq!(summary.camera_id.as_deref(), Some("cam-a"));
        assert_eq!(summary.lens_json.as_deref(), meta["lens_json"].as_str());
        assert!(summary.intrinsics.is_some());
        assert!(summary.lens_ready);
        /* A recorded path is not a solved artifact. */
        assert!(!summary.stage_pose_ready);
        assert_eq!(summary.stage_pose_status, "missing");
        assert!(summary.stage_pose.is_none());

        fs::write(
            run.path().join("stage_pose.json"),
            br#"{"rms_reprojection_px":0.42,"num_inliers":8,"num_markers":10}"#,
        )
        .unwrap();
        let legacy = summarize_fixed_run(run.path()).unwrap();
        assert!(!legacy.stage_pose_ready);
        assert_eq!(legacy.stage_pose_status, "invalid");

        fs::write(
            run.path().join("stage_pose.json"),
            br#"{"schema_version":"volo_stage_pose.v2","formal":true,"image_size":[1920,1080],"rms_reprojection_px":0.42,"num_inliers":16,"num_markers":24,"preflight":{"passed":true},"qualification":{"passed":true,"master_lens":true,"fail_closed":true}}"#,
        )
        .unwrap();
        let solved = summarize_fixed_run(run.path()).unwrap();
        assert!(solved.stage_pose_ready);
        assert_eq!(solved.stage_pose_status, "formal");
        assert_eq!(solved.stage_pose.as_ref().unwrap()["rms_reprojection_px"], 0.42);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape() {
        use std::os::unix::fs::symlink;

        let run = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::create_dir(outside.path().join("qa")).unwrap();
        fs::write(outside.path().join("qa/reprojection.json"), b"{}").unwrap();
        symlink(outside.path().join("qa"), run.path().join("qa")).unwrap();

        let err = read_lens_qa_report(run.path().display().to_string()).unwrap_err();
        assert!(format!("{err}").contains("escapes"), "got: {err}");
    }
}
