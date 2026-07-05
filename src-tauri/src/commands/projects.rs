//! Project management commands.

use cache_core::core::project_discovery::{self, DiscoveryResult};
use cache_core::core::project_identity::stem_lower;
use cache_core::core::project_thumbnail::{self, ProjectProbe};
use cache_core::data::{
    machines as data_machines, project_cache_backend, project_locations, projects, Db,
    DiscoveryStatus, Project, ProjectLocation, ProjectCacheBackend,
};
use cache_core::error::{VoloError, VoloResult};
use serde::Serialize;
use tauri::State;

#[derive(Debug, Serialize)]
pub struct ProjectSummary {
    pub id: i64,
    pub uproject_name: String,
    pub display_name: Option<String>,
    pub uproject_guid: Option<String>,
    pub ue_version_major: Option<i64>,
    pub ue_version_minor: Option<i64>,
    pub location_count: i64,
}

#[tauri::command]
pub fn list_projects(db: State<'_, Db>) -> VoloResult<Vec<ProjectSummary>> {
    let mut out = Vec::new();
    for project in projects::list(&db)? {
        let id = project.id.unwrap_or_default();
        let locations = project_locations::list_by_project(&db, id)?;
        out.push(ProjectSummary {
            id,
            uproject_name: project.uproject_name,
            display_name: project.display_name,
            uproject_guid: project.uproject_guid,
            ue_version_major: project.ue_version_major,
            ue_version_minor: project.ue_version_minor,
            location_count: locations.len() as i64,
        });
    }
    Ok(out)
}

#[tauri::command]
pub fn list_project_locations(
    db: State<'_, Db>,
    project_id: i64,
) -> VoloResult<Vec<ProjectLocation>> {
    project_locations::list_by_project(&db, project_id)
}

#[tauri::command]
pub fn discover_projects(
    db: State<'_, Db>,
    machine_id: i64,
    search_roots: Vec<String>,
    operator_credential_alias: Option<String>,
) -> VoloResult<Vec<DiscoveryResult>> {
    let machine = data_machines::find_by_id(&db, machine_id)?
        .ok_or_else(|| VoloError::InvalidInput(format!("machine {} not found", machine_id)))?;
    // SSH key auth: operator cred no longer used; param kept as accepted-ignored
    // shim (Vue compat). run_discovery ignores the user/pass under SSH.
    let _ = operator_credential_alias;
    project_discovery::run_discovery(&db, machine_id, &machine.ip, &search_roots, None, None)
}

#[tauri::command]
pub fn set_project_location(
    db: State<'_, Db>,
    project_id: i64,
    machine_id: i64,
    abs_path: String,
    uproject_path: String,
    manual: bool,
) -> VoloResult<i64> {
    let discovery_status = if manual {
        DiscoveryStatus::ManualPath
    } else {
        DiscoveryStatus::ManualAlias
    };
    // Manual path/alias correction carries no version info of its own — pass None and
    // let `project_locations::upsert` decide atomically whether the previously-scanned
    // version is still valid (same abs_path/uproject_path) or must reset to unknown
    // (path actually changed, so the old version described a different location).
    project_locations::upsert(
        &db,
        &ProjectLocation {
            id: None,
            project_id,
            machine_id,
            abs_path,
            uproject_path,
            discovery_status,
            discovered_at: None,
            ue_version_major: None,
            ue_version_minor: None,
        },
    )
}

#[tauri::command]
pub fn delete_project(db: State<'_, Db>, project_id: i64) -> VoloResult<()> {
    projects::delete(&db, project_id)
}

#[tauri::command]
pub fn delete_project_location(db: State<'_, Db>, location_id: i64) -> VoloResult<()> {
    project_locations::delete(&db, location_id)
}

#[tauri::command]
pub fn create_project_manual(
    db: State<'_, Db>,
    uproject_name: String,
    display_name: Option<String>,
) -> VoloResult<i64> {
    projects::upsert(
        &db,
        &Project {
            id: None,
            uproject_stem_lower: stem_lower(&uproject_name),
            uproject_name,
            uproject_guid: None,
            display_name,
            first_seen_at: None,
            last_seen_at: None,
            ue_version_major: None,
            ue_version_minor: None,
            engine_association_raw: None,
            engine_association_kind: None,
        },
    )
}

/// Probes the project on `machine_id`'s copy: thumbnail (same-name PNG next
/// to the .uproject, else `Saved\auto_screenshot.png`, else
/// `Saved\autosequence_shot.png`, else null — the frontend falls back to a
/// generic icon) + the project directory's total size, in one round-trip.
#[tauri::command]
pub async fn get_project_thumbnail(
    db: State<'_, Db>,
    project_id: i64,
    machine_id: i64,
) -> VoloResult<ProjectProbe> {
    let machine = data_machines::find_by_id(&db, machine_id)?
        .ok_or_else(|| VoloError::InvalidInput(format!("machine {} not found", machine_id)))?;
    let location = project_locations::get_for_project_machine(&db, project_id, machine_id)?
        .ok_or_else(|| {
            VoloError::InvalidInput(format!(
                "project {} not located on machine {}",
                project_id, machine_id
            ))
        })?;
    let stem = project_thumbnail::uproject_stem(&location.uproject_path);
    let host = machine.ip;
    let project_dir = location.abs_path;
    tokio::task::spawn_blocking(move || project_thumbnail::read_thumbnail(&host, &project_dir, &stem))
        .await
        .map_err(|err| VoloError::OperationFailed(format!("get_project_thumbnail task failed: {err}")))?
}

#[tauri::command]
pub fn set_project_cache_backend(
    db: State<'_, Db>,
    project_id: i64,
    machine_id: i64,
    backend: String,
) -> VoloResult<()> {
    match backend.as_str() {
        "zen" | "legacy_pak" | "auto" => {}
        other => {
            return Err(VoloError::InvalidInput(format!(
                "backend must be 'zen', 'legacy_pak', or 'auto', got {other:?}"
            )))
        }
    }
    project_cache_backend::upsert(
        &db,
        &ProjectCacheBackend {
            project_id,
            machine_id,
            backend,
            zen_endpoint_id: None,
            notes: None,
            updated_at: None,
        },
    )?;
    Ok(())
}
