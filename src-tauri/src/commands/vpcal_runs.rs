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
