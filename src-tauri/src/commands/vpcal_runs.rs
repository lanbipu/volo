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
    /// Absolute path to the session's `session.json` (tracked) or
    /// `fixed_run.json` (fixed / tracker-free). Empty string if neither.
    pub session_json_path: String,
    /// `"tracked"` (`session.json`) or `"fixed"` (`fixed_run.json` / stills).
    pub mode: String,
    /// True when `session.json` carries an inline `lens` profile, or when a
    /// fixed run already has `lens.json` from tracker-free lens-cal.
    pub lens_ready: bool,
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
        poses_captured,
        modified_at: file_mtime_rfc3339(session_json),
        output_dir: if output.is_dir() {
            Some(output.to_string_lossy().into_owned())
        } else {
            None
        },
        error: None,
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
    let lens_ready = dir.join("lens.json").is_file()
        || meta_value
            .as_ref()
            .and_then(|v| v.get("lens_json").and_then(Value::as_str).map(|s| !s.is_empty()))
            .unwrap_or(false);
    Some(LensSessionSummary {
        id,
        session_dir: dir.to_string_lossy().into_owned(),
        session_json_path: meta_path,
        mode: "fixed".into(),
        lens_ready,
        poses_captured: frames,
        modified_at,
        output_dir: Some(dir.to_string_lossy().into_owned()),
        error: meta_error,
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
/// `captures/normal/`. Thin transport for the lens-calibration flow.
#[tauri::command]
pub fn write_fixed_run_meta(session_dir: String, meta: Value) -> VoloResult<()> {
    let dir = Path::new(&session_dir);
    if !dir.is_dir() {
        fs::create_dir_all(dir).map_err(|e| {
            VoloError::Io(format!("failed to create session dir {session_dir}: {e}"))
        })?;
    }
    let path = dir.join("fixed_run.json");
    let bytes = serde_json::to_vec_pretty(&meta)
        .map_err(|e| VoloError::InvalidInput(format!("invalid fixed_run meta: {e}")))?;
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
