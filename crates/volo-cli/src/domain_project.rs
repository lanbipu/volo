//! `voloctl cache project <action>` handlers.

use crate::args::ProjectAction;
use crate::destructive::{self, Outcome};
use crate::output::{EmitSerialize, Event};
use crate::run::Ctx;
use cache_core::core::project_identity::stem_lower;
use cache_core::data::{
    machines as data_machines, project_locations as data_locations, projects as data_projects,
    DiscoveryStatus, Project, ProjectLocation,
};
use cache_core::error::{VoloError, VoloResult};
use rusqlite::OptionalExtension;

pub fn handle(ctx: &mut Ctx<'_>, action: ProjectAction) -> VoloResult<()> {
    match action {
        ProjectAction::List => list(ctx),
        ProjectAction::Locations { project_id } => locations(ctx, project_id),
        ProjectAction::Discover { machine_id, roots, cred } => {
            discover(ctx, machine_id, &roots, &cred)
        }
        ProjectAction::CreateManual { uproject_name, display_name } => {
            create_manual(ctx, &uproject_name, display_name)
        }
        ProjectAction::SetLocation { project_id, machine_id, abs_path, uproject_path, manual_path } => {
            set_location(ctx, project_id, machine_id, &abs_path, &uproject_path, manual_path)
        }
        ProjectAction::Delete { id, yes, dry_run } => delete(ctx, id, yes, dry_run),
        ProjectAction::DeleteLocation { id, yes, dry_run } => delete_location(ctx, id, yes, dry_run),
        ProjectAction::BrowseDir { machine_id, path } => browse_dir(ctx, machine_id, path.as_deref()),
    }
}

fn list(ctx: &mut Ctx<'_>) -> VoloResult<()> {
    let db = ctx.require_db()?;
    let rows = data_projects::list(db)?;
    ctx.emitter.emit_result(&rows).ok();
    Ok(())
}

fn locations(ctx: &mut Ctx<'_>, project_id: i64) -> VoloResult<()> {
    let db = ctx.require_db()?;
    let rows = data_locations::list_by_project(db, project_id)?;
    ctx.emitter.emit_result(&rows).ok();
    Ok(())
}

fn discover(
    ctx: &mut Ctx<'_>,
    machine_id: i64,
    roots: &[String],
    cred: &crate::credential_args::CredentialArgs,
) -> VoloResult<()> {
    // Look up host IP via machine_id.
    let host = {
        let db = ctx.require_db()?;
        let machine = data_machines::find_by_id(db, machine_id)?.ok_or_else(|| {
            VoloError::InvalidInput(format!("machine id={} not found", machine_id))
        })?;
        machine.ip.clone()
    };
    // SSH key auth: no operator credential needed. preflight validates flags
    // without reading DPAPI/stdin for a credential that would only be discarded.
    {
        let db = ctx.require_db()?;
        cred.preflight(db)?;
    }
    let (op_user, op_pass): (Option<String>, Option<String>) = (None, None);

    ctx.emitter
        .emit_event(&Event::Started {
            task_type: "project_discover".into(),
            task_id: Some(format!("machine:{}", machine_id)),
            metadata: serde_json::json!({ "host": host, "roots": roots.len() }),
        })
        .ok();

    let db = ctx.require_db()?;
    let items = cache_core::core::project_discovery::run_discovery(
        db,
        machine_id,
        &host,
        roots,
        op_user.as_deref(),
        op_pass.as_deref(),
    )?;

    let summary = serde_json::json!({
        "discovered": items.len(),
        "items": items,
    });
    ctx.emitter.emit_event(&Event::Completed { summary }).ok();
    Ok(())
}

fn create_manual(
    ctx: &mut Ctx<'_>,
    uproject_name: &str,
    display_name: Option<String>,
) -> VoloResult<()> {
    let db = ctx.require_db()?;
    let project_id = data_projects::upsert(
        db,
        &Project {
            id: None,
            uproject_stem_lower: stem_lower(uproject_name),
            uproject_name: uproject_name.to_string(),
            uproject_guid: None,
            display_name,
            first_seen_at: None,
            last_seen_at: None,
            ue_version_major: None,
            ue_version_minor: None,
            engine_association_raw: None,
            engine_association_kind: None,
        },
    )?;
    ctx.emitter
        .emit_event(&Event::Completed {
            summary: serde_json::json!({
                "project_id": project_id,
                "uproject_name": uproject_name,
            }),
        })
        .ok();
    Ok(())
}

fn set_location(
    ctx: &mut Ctx<'_>,
    project_id: i64,
    machine_id: i64,
    abs_path: &str,
    uproject_path: &str,
    manual_path: bool,
) -> VoloResult<()> {
    let discovery_status = if manual_path {
        DiscoveryStatus::ManualPath
    } else {
        DiscoveryStatus::ManualAlias
    };
    let db = ctx.require_db()?;
    // Manual path/alias correction carries no version info of its own — pass None and
    // let `project_locations::upsert` decide atomically whether the previously-scanned
    // version is still valid (same abs_path/uproject_path) or must reset to unknown
    // (path actually changed, so the old version described a different location).
    let location_id = data_locations::upsert(
        db,
        &ProjectLocation {
            id: None,
            project_id,
            machine_id,
            abs_path: abs_path.to_string(),
            uproject_path: uproject_path.to_string(),
            discovery_status,
            discovered_at: None,
            ue_version_major: None,
            ue_version_minor: None,
        },
    )?;
    ctx.emitter
        .emit_event(&Event::Completed {
            summary: serde_json::json!({
                "project_id": project_id,
                "location_id": location_id,
            }),
        })
        .ok();
    Ok(())
}

fn browse_dir(ctx: &mut Ctx<'_>, machine_id: i64, path: Option<&str>) -> VoloResult<()> {
    let host = {
        let db = ctx.require_db()?;
        let machine = data_machines::find_by_id(db, machine_id)?.ok_or_else(|| {
            VoloError::InvalidInput(format!("machine id={} not found", machine_id))
        })?;
        machine.ip.clone()
    };
    let entries = cache_core::core::remote_fs::list_remote_dirs(&host, path)?;
    ctx.emitter.emit_result(&entries).ok();
    Ok(())
}

fn delete(ctx: &mut Ctx<'_>, id: i64, yes: bool, dry_run: bool) -> VoloResult<()> {
    let outcome = destructive::check(yes, dry_run, "project.delete")?;
    let db = ctx.require_db()?;
    if data_projects::get(db, id)?.is_none() {
        return Err(VoloError::InvalidInput(format!("project id={} not found", id)));
    }
    if outcome == Outcome::DryRun {
        let locations = data_locations::list_by_project(db, id)?;
        destructive::emit_plan(
            ctx.emitter.as_mut(),
            "project.delete",
            serde_json::json!({
                "id": id,
                "cascade_locations": locations.len(),
            }),
        );
        return Ok(());
    }
    data_projects::delete(db, id)?;
    ctx.emitter
        .emit_event(&Event::Completed {
            summary: serde_json::json!({ "id": id, "deleted": true }),
        })
        .ok();
    Ok(())
}

fn delete_location(ctx: &mut Ctx<'_>, id: i64, yes: bool, dry_run: bool) -> VoloResult<()> {
    let outcome = destructive::check(yes, dry_run, "project.delete-location")?;
    let db = ctx.require_db()?;
    // Mirror `project delete` / `machine delete`: refuse to pretend success
    // on a typo'd id, in both --yes and --dry-run paths. `project_locations`
    // has no `find_by_id` helper in the data layer; query inline to avoid
    // adding new data:: functions.
    let row: Option<(i64, i64)> = {
        let conn = db.lock().unwrap();
        conn.query_row(
            "SELECT project_id, machine_id FROM project_locations WHERE id = ?",
            rusqlite::params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(cache_core::error::VoloError::from)?
    };
    let (project_id, machine_id) = row.ok_or_else(|| {
        VoloError::InvalidInput(format!("project_location id={} not found", id))
    })?;
    if outcome == Outcome::DryRun {
        destructive::emit_plan(
            ctx.emitter.as_mut(),
            "project.delete-location",
            serde_json::json!({
                "id": id,
                "project_id": project_id,
                "machine_id": machine_id,
            }),
        );
        return Ok(());
    }
    data_locations::delete(db, id)?;
    ctx.emitter
        .emit_event(&Event::Completed {
            summary: serde_json::json!({ "id": id, "deleted": true }),
        })
        .ok();
    Ok(())
}
