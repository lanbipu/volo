//! Mesh (LMT) total-station Tauri command shims. Business logic in `mesh_app`.

pub use mesh_app::total_station::{run_generate_card, run_import, run_save_pdf};

use std::path::Path;
use volo_shared::dto::{InstructionCardResult, TotalStationImportResult};
use volo_shared::error::{VoloError, VoloResult};

use crate::pdf_render::render_html_to_pdf;

/// M1 currently derives its frame from CSV instrument IDs 1/2/3. Until the
/// adapter accepts named reference points, fail closed when project.yaml asks
/// for any other coordinate-system anchors; silently accepting those fields
/// would claim an alignment that never happened.
fn validate_effective_coordinate_system(
    project_abs_path: &Path,
    screen_id: &str,
) -> VoloResult<()> {
    let cfg = mesh_app::projects::load_project_yaml_from_path(project_abs_path)?;
    let screen = cfg
        .screens
        .get(screen_id)
        .ok_or_else(|| VoloError::NotFound(format!("screen '{screen_id}' not in project")))?;
    let origin_row = screen
        .bottom_completion
        .as_ref()
        .map(|b| b.lowest_measurable_row)
        .unwrap_or(1);
    let effective = [
        format!("{screen_id}_V001_R{origin_row:03}"),
        format!(
            "{screen_id}_V{:03}_R{origin_row:03}",
            screen.cabinet_count[0] + 1
        ),
        format!("{screen_id}_V001_R{:03}", screen.cabinet_count[1] + 1),
    ];
    let configured = [
        cfg.coordinate_system.origin_point.as_str(),
        cfg.coordinate_system.x_axis_point.as_str(),
        cfg.coordinate_system.xy_plane_point.as_str(),
    ];
    if configured
        != effective
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>()
            .as_slice()
    {
        return Err(VoloError::InvalidInput(format!(
            "coordinate_system does not yet take effect for custom M1 anchors: configured [{}, {}, {}], effective CSV instrument IDs 1/2/3 map to [{}, {}, {}]",
            configured[0], configured[1], configured[2], effective[0], effective[1], effective[2]
        )));
    }
    Ok(())
}

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
) -> VoloResult<TotalStationImportResult> {
    match mode.as_deref().unwrap_or("grid") {
        "grid" | "" => {
            validate_effective_coordinate_system(Path::new(&project_abs_path), &screen_id)?;
            run_import(
                Path::new(&project_abs_path),
                &screen_id,
                Path::new(&csv_path),
            )
        }
        "scatter" => {
            let col_map = match columns.as_deref() {
                Some(s) => {
                    let cm = mesh_app::total_station::parse_column_map(s)
                        .map_err(VoloError::InvalidInput)?;
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
        other => Err(VoloError::InvalidInput(format!(
            "unknown import mode '{other}'; expected 'grid' or 'scatter'"
        ))),
    }
}

#[cfg(test)]
mod coordinate_system_tests {
    use super::*;
    use tempfile::tempdir;

    fn write_project(path: &Path, x_axis: &str) {
        std::fs::write(
            path.join("project.yaml"),
            format!(
                r#"
project: {{ name: T, unit: mm }}
screens:
  MAIN:
    cabinet_count: [4, 2]
    cabinet_size_mm: [500, 500]
    pixels_per_cabinet: [256, 256]
    shape_prior: {{ type: flat }}
    shape_mode: rectangle
coordinate_system:
  origin_point: MAIN_V001_R001
  x_axis_point: {x_axis}
  xy_plane_point: MAIN_V001_R003
output: {{ target: neutral, obj_filename: "{{screen_id}}.obj", weld_vertices_tolerance_mm: 1, triangulate: true }}
"#
            ),
        )
        .unwrap();
    }

    #[test]
    fn sop_reference_names_are_accepted() {
        let dir = tempdir().unwrap();
        write_project(dir.path(), "MAIN_V005_R001");
        validate_effective_coordinate_system(dir.path(), "MAIN").unwrap();
    }

    #[test]
    fn custom_reference_names_fail_closed() {
        let dir = tempdir().unwrap();
        write_project(dir.path(), "MAIN_V004_R001");
        let err = validate_effective_coordinate_system(dir.path(), "MAIN").unwrap_err();
        assert!(format!("{err}").contains("does not yet take effect"));
    }
}

#[tauri::command]
pub fn generate_instruction_card(
    project_abs_path: String,
    screen_id: String,
) -> VoloResult<InstructionCardResult> {
    run_generate_card(Path::new(&project_abs_path), &screen_id)
}

#[tauri::command]
pub async fn save_instruction_pdf(
    app: tauri::AppHandle,
    project_abs_path: String,
    screen_id: String,
    dst_pdf_path: String,
) -> VoloResult<String> {
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
    .map_err(|e| VoloError::Other(format!("PDF task join: {e}")))?
}
