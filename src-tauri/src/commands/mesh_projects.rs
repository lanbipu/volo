//! Mesh (LMT) project metadata Tauri command shims.
//!
//! step 3c platformed LMT's `src-tauri/src/commands/projects.rs` here. Business
//! logic lives in `mesh_app::projects`; this file is transport translation only.
//! The mesh DB is managed as `MeshDb` (a newtype over `volo_shared::data::Db`)
//! to disambiguate from the cache `Db` — both resolve to the same
//! `Arc<Mutex<rusqlite::Connection>>` so Tauri's TypeId-keyed state map needs a
//! distinct wrapper type per database.

pub use mesh_app::projects::{
    load_project_yaml_from_path, save_project_yaml_to_path, seed_example_to_dir,
};

use crate::commands::mesh::MeshDb;
use std::path::Path;
use volo_shared::data::recent_projects;
use volo_shared::dto::{ProjectConfig, RecentProject};
use volo_shared::error::{LmtError, LmtResult};

#[tauri::command]
pub fn load_project_yaml(abs_path: String) -> LmtResult<ProjectConfig> {
    load_project_yaml_from_path(Path::new(&abs_path))
}

#[tauri::command]
pub fn save_project_yaml(abs_path: String, config: ProjectConfig) -> LmtResult<()> {
    save_project_yaml_to_path(Path::new(&abs_path), &config)
}

#[tauri::command]
pub fn list_recent_projects(state: tauri::State<'_, MeshDb>) -> LmtResult<Vec<RecentProject>> {
    let conn = state.0.lock().unwrap();
    recent_projects::list(&conn)
}

#[tauri::command]
pub fn add_recent_project(
    state: tauri::State<'_, MeshDb>,
    abs_path: String,
    display_name: String,
) -> LmtResult<RecentProject> {
    let conn = state.0.lock().unwrap();
    // 走 upsert_normalized,让 GUI 与 CLI 共用 DB 时 abs_path 落到同一字符串,
    // 避免同一项目被记录成两条 recent_projects(UNIQUE key 才有意义)。
    recent_projects::upsert_normalized(&conn, &abs_path, &display_name)
}

#[tauri::command]
pub fn remove_recent_project(state: tauri::State<'_, MeshDb>, id: i64) -> LmtResult<()> {
    let conn = state.0.lock().unwrap();
    recent_projects::delete(&conn, id)
}

#[tauri::command]
pub fn seed_example_project(
    app: tauri::AppHandle,
    target_dir: String,
    example: String,
) -> LmtResult<String> {
    use tauri::{Emitter, Manager};
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| LmtError::Io(e.to_string()))?;
    let examples_root = resource_dir.join("examples");
    let out = seed_example_to_dir(&examples_root, &example, Path::new(&target_dir))?;
    let _ = app.emit(
        "project-seeded",
        serde_json::json!({"abs_path": out.display().to_string()}),
    );
    Ok(out.display().to_string())
}
