//! Mesh (LMT) total-station Tauri command shims. Business logic in `mesh_app`.

pub use mesh_app::total_station::{run_generate_card, run_import, run_save_pdf};

use std::path::Path;
use volo_shared::dto::{InstructionCardResult, TotalStationImportResult};
use volo_shared::error::{LmtError, LmtResult};

use crate::pdf_render::render_html_to_pdf;

/// Import a total-station CSV into the project measurements.
///
/// - `mode` — `"grid"` (default / None) for Trimble SOP grid import,
///   `"scatter"` for raw scatter points (no SOP, fitting deferred to
///   `reconstruct surface`).
/// - `columns` — only used when `mode == "scatter"`. Format:
///   `"x=C,y=C,z=C[,label=C]"` (1-based column numbers). Omit to let
///   the adapter auto-detect from the CSV header.
///
/// Transport translation only — business logic lives in `mesh_app`.
#[tauri::command]
pub fn import_total_station_csv(
    project_abs_path: String,
    csv_path: String,
    screen_id: String,
    mode: Option<String>,
    columns: Option<String>,
) -> LmtResult<TotalStationImportResult> {
    match mode.as_deref().unwrap_or("grid") {
        "grid" | "" => run_import(
            Path::new(&project_abs_path),
            &screen_id,
            Path::new(&csv_path),
        ),
        "scatter" => {
            let col_map = match columns.as_deref() {
                Some(s) => {
                    let cm = mesh_app::total_station::parse_column_map(s)
                        .map_err(LmtError::InvalidInput)?;
                    Some(cm)
                }
                None => None,
            };
            mesh_app::total_station::run_import_scatter(
                Path::new(&project_abs_path),
                &screen_id,
                Path::new(&csv_path),
                col_map,
            )
        }
        other => Err(LmtError::InvalidInput(format!(
            "unknown import mode '{other}'; expected 'grid' or 'scatter'"
        ))),
    }
}

#[tauri::command]
pub fn generate_instruction_card(
    project_abs_path: String,
    screen_id: String,
) -> LmtResult<InstructionCardResult> {
    run_generate_card(Path::new(&project_abs_path), &screen_id)
}

#[tauri::command]
pub async fn save_instruction_pdf(
    app: tauri::AppHandle,
    project_abs_path: String,
    screen_id: String,
    dst_pdf_path: String,
) -> LmtResult<String> {
    // CRITICAL: the macOS PDF renderer dispatches a closure onto the AppKit
    // main thread and then blocks on a channel waiting for the result. If
    // this command itself runs on the main thread (which is where sync
    // Tauri commands land on macOS), the queued closure can never execute
    // and we'd deadlock for the full 30s timeout. Route through
    // `spawn_blocking` so we're guaranteed to be on a worker thread.
    tokio::task::spawn_blocking(move || {
        run_save_pdf(
            Path::new(&project_abs_path),
            &screen_id,
            Path::new(&dst_pdf_path),
            |html, tmp| render_html_to_pdf(&app, html, tmp),
        )
    })
    .await
    .map_err(|e| LmtError::Other(format!("PDF task join: {e}")))?
}
