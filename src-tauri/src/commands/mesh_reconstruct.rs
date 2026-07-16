//! Mesh (LMT) reconstruction Tauri command shims. Business logic in `mesh_app`.

pub use mesh_app::reconstruct::{
    list_runs_for, read_run_report, run_reconstruction, set_current_run,
};

use crate::commands::mesh::MeshDb;
use serde::Serialize;
use std::path::Path;
use tauri::Emitter;
use volo_shared::dto::{ReconstructionResult, ReconstructionRun};
use volo_shared::error::{VoloError, VoloResult};

const RECONSTRUCT_PROGRESS_EVENT: &str = "mesh-reconstruct-progress";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
enum ReconstructState {
    Started,
    Completed,
    Failed,
}

/// M1 has no progress or cancellation hook. This contract is deliberately
/// indeterminate (`percent: None`, `cancellable: false`) and emits only real
/// lifecycle boundaries around the blocking service call.
#[derive(Debug, Clone, Serialize)]
pub struct ReconstructProgressEvent {
    project_path: String,
    screen_id: String,
    state: ReconstructState,
    percent: Option<u8>,
    cancellable: bool,
    message: String,
}

fn progress_payload(
    project_path: &str,
    screen_id: &str,
    state: ReconstructState,
    message: impl Into<String>,
) -> ReconstructProgressEvent {
    ReconstructProgressEvent {
        project_path: project_path.to_string(),
        screen_id: screen_id.to_string(),
        state,
        percent: None,
        cancellable: false,
        message: message.into(),
    }
}

#[tauri::command]
pub async fn reconstruct_surface(
    app: tauri::AppHandle,
    state: tauri::State<'_, MeshDb>,
    project_path: String,
    screen_id: String,
    measurements_path: String,
) -> VoloResult<ReconstructionResult> {
    let _ = app.emit(
        RECONSTRUCT_PROGRESS_EVENT,
        progress_payload(
            &project_path,
            &screen_id,
            ReconstructState::Started,
            "reconstructing",
        ),
    );
    let db = state.0.clone();
    let project_for_task = project_path.clone();
    let screen_for_task = screen_id.clone();
    let joined = tokio::task::spawn_blocking(move || {
        run_reconstruction(
            db,
            Path::new(&project_for_task),
            &screen_for_task,
            &measurements_path,
        )
    })
    .await;
    let result = match joined {
        Ok(result) => result,
        Err(error) => {
            let error = VoloError::Other(format!("M1 reconstruction task join failed: {error}"));
            let _ = app.emit(
                RECONSTRUCT_PROGRESS_EVENT,
                progress_payload(
                    &project_path,
                    &screen_id,
                    ReconstructState::Failed,
                    error.to_string(),
                ),
            );
            return Err(error);
        }
    };
    match &result {
        Ok(_) => {
            let _ = app.emit(
                RECONSTRUCT_PROGRESS_EVENT,
                progress_payload(
                    &project_path,
                    &screen_id,
                    ReconstructState::Completed,
                    "reconstruction completed",
                ),
            );
        }
        Err(error) => {
            let _ = app.emit(
                RECONSTRUCT_PROGRESS_EVENT,
                progress_payload(
                    &project_path,
                    &screen_id,
                    ReconstructState::Failed,
                    error.to_string(),
                ),
            );
        }
    }
    result
}

#[tauri::command]
pub fn list_runs(
    state: tauri::State<'_, MeshDb>,
    project_path: String,
    screen_id: Option<String>,
) -> VoloResult<Vec<ReconstructionRun>> {
    list_runs_for(state.0.clone(), &project_path, screen_id.as_deref())
}

#[tauri::command]
pub fn get_run_report(
    state: tauri::State<'_, MeshDb>,
    run_id: i64,
) -> VoloResult<serde_json::Value> {
    read_run_report(state.0.clone(), run_id)
}

#[tauri::command]
pub fn set_run_current(state: tauri::State<'_, MeshDb>, run_id: i64) -> VoloResult<()> {
    set_current_run(state.0.clone(), run_id)
}

#[cfg(test)]
mod progress_tests {
    use super::*;

    #[test]
    fn m1_progress_is_honestly_indeterminate_and_not_cancellable() {
        let value = serde_json::to_value(progress_payload(
            "/tmp/p",
            "MAIN",
            ReconstructState::Started,
            "reconstructing",
        ))
        .unwrap();
        assert!(value["percent"].is_null());
        assert_eq!(value["cancellable"], false);
        assert_eq!(value["state"], "started");
    }
}
