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
use serde::Serialize;
use serde_json::Value;
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
    /// Absolute path to the session's `session.json`.
    pub session_json_path: String,
    /// True when `session.json` carries an inline `lens` profile (a session
    /// captured without one still solves via `quick run`, just without a
    /// known lens to disambiguate QLE from).
    pub lens_ready: bool,
    /// Captured pose count — counted from `tracking/poses.jsonl` lines (one
    /// JSON line per pose). Not persisted anywhere else in the session, so
    /// this is the only honest source; `None` if the file is missing/unreadable.
    pub poses_captured: Option<u64>,
    /// `session.json` mtime, RFC3339 (best-effort; `None` if unreadable).
    pub modified_at: Option<String>,
}

fn summarize_session(session_json: &Path) -> Option<LensSessionSummary> {
    let txt = fs::read_to_string(session_json).ok()?;
    let v: Value = serde_json::from_str(&txt).ok()?;
    let session_dir = session_json.parent()?;
    let id = session_dir
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "session".to_string());
    let lens_ready = v.get("lens").is_some();
    let poses_captured = fs::read_to_string(session_dir.join("tracking").join("poses.jsonl"))
        .ok()
        .map(|txt| txt.lines().filter(|l| !l.trim().is_empty()).count() as u64);
    let modified_at = fs::metadata(session_json)
        .ok()
        .and_then(|m| m.modified().ok())
        .map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339());
    Some(LensSessionSummary {
        id,
        session_dir: session_dir.to_string_lossy().into_owned(),
        session_json_path: session_json.to_string_lossy().into_owned(),
        lens_ready,
        poses_captured,
        modified_at,
    })
}

/// List lens capture sessions under `sessions_root` by scanning for
/// `session.json` files (the root itself and its immediate child
/// directories, matching `list_ar_runs`'s convention). Newest-first.
#[tauri::command]
pub fn list_lens_sessions(sessions_root: String) -> VoloResult<Vec<LensSessionSummary>> {
    let root = Path::new(&sessions_root);
    if !root.is_dir() {
        return Err(VoloError::InvalidInput(format!(
            "sessions_root is not a directory: {sessions_root}"
        )));
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    let root_session = root.join("session.json");
    if root_session.is_file() {
        candidates.push(root_session);
    }
    for entry in fs::read_dir(root)?.flatten() {
        let p = entry.path();
        if p.is_dir() {
            let sj = p.join("session.json");
            if sj.is_file() {
                candidates.push(sj);
            }
        }
    }

    let mut sessions: Vec<LensSessionSummary> =
        candidates.iter().filter_map(|p| summarize_session(p)).collect();
    // Newest first; entries without a readable mtime sort last.
    sessions.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    Ok(sessions)
}

/// Read a local image file and return it as a `data:` URL, so the frontend
/// can display arbitrary on-disk images (e.g. `verify overlay`'s
/// `annotated_images[]` PNGs) without a Tauri asset-protocol scope — these
/// live under whatever runs/output directory the operator points the AR
/// workspace at, which isn't known at build time, so a static capability
/// scope pattern wouldn't cover them.
///
/// `base_dir` scopes the read: `path` must canonicalize to a descendant of
/// `base_dir` (symlink targets included), and only recognized image
/// extensions under a size cap are served — this command must never become a
/// generic "read any file on disk" primitive (code review finding: the
/// unscoped first version did exactly that). Callers pass the same output
/// directory `verify overlay --out` just wrote to, so `path`/`base_dir` are
/// both derived from that one real backend response rather than hand-typed.
#[tauri::command]
pub fn read_image_as_data_url(path: String, base_dir: String) -> VoloResult<String> {
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

    let canon_base = Path::new(&base_dir)
        .canonicalize()
        .map_err(|e| VoloError::Io(format!("failed to resolve base_dir {base_dir}: {e}")))?;
    let canon_path = Path::new(&path)
        .canonicalize()
        .map_err(|e| VoloError::Io(format!("failed to resolve image path {path}: {e}")))?;
    if !canon_path.starts_with(&canon_base) {
        return Err(VoloError::InvalidInput(format!(
            "{path} is outside the approved output directory {base_dir}"
        )));
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
