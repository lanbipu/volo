//! CRUD for PSO green-light invalidation events.

use crate::data::Db;
use crate::error::VoloResult;
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PsoInvalidationReason {
    GpuDriverChanged,
    CacheShrunk,
    CacheDirectoryMissing,
    InteractiveUserChanged,
    NodeRebooted,
}

impl PsoInvalidationReason {
    pub fn as_str(self) -> &'static str {
        match self {
            PsoInvalidationReason::GpuDriverChanged => "gpu_driver_changed",
            PsoInvalidationReason::CacheShrunk => "cache_shrunk",
            PsoInvalidationReason::CacheDirectoryMissing => "cache_directory_missing",
            PsoInvalidationReason::InteractiveUserChanged => "interactive_user_changed",
            PsoInvalidationReason::NodeRebooted => "node_rebooted",
        }
    }

    fn from_str(raw: &str) -> Self {
        match raw {
            "gpu_driver_changed" => PsoInvalidationReason::GpuDriverChanged,
            "cache_shrunk" => PsoInvalidationReason::CacheShrunk,
            "cache_directory_missing" => PsoInvalidationReason::CacheDirectoryMissing,
            "interactive_user_changed" => PsoInvalidationReason::InteractiveUserChanged,
            "node_rebooted" => PsoInvalidationReason::NodeRebooted,
            _ => PsoInvalidationReason::CacheShrunk,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
pub struct PsoInvalidationEvent {
    pub id: Option<i64>,
    pub project_id: i64,
    pub machine_id: i64,
    pub warmup_run_id: i64,
    pub driver_cache_snapshot_id: i64,
    pub reason: PsoInvalidationReason,
    pub detail: String,
    pub detected_at: Option<String>,
}

pub fn insert_if_absent(db: &Db, event: &PsoInvalidationEvent) -> VoloResult<()> {
    let conn = db.lock().unwrap();
    conn.execute(
        "INSERT OR IGNORE INTO pso_invalidation_events
         (project_id, machine_id, warmup_run_id, driver_cache_snapshot_id, reason, detail)
         VALUES (?, ?, ?, ?, ?, ?)",
        params![
            event.project_id,
            event.machine_id,
            event.warmup_run_id,
            event.driver_cache_snapshot_id,
            event.reason.as_str(),
            event.detail.as_str(),
        ],
    )?;
    Ok(())
}

pub fn list_for_warmup(
    db: &Db,
    project_id: i64,
    machine_id: i64,
    warmup_run_id: i64,
) -> VoloResult<Vec<PsoInvalidationEvent>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, project_id, machine_id, warmup_run_id, driver_cache_snapshot_id,
                reason, detail, detected_at
         FROM pso_invalidation_events
         WHERE project_id = ? AND machine_id = ? AND warmup_run_id = ?
         ORDER BY datetime(detected_at) DESC, id DESC",
    )?;
    let rows = stmt.query_map(params![project_id, machine_id, warmup_run_id], row_to_event)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

fn row_to_event(row: &rusqlite::Row<'_>) -> rusqlite::Result<PsoInvalidationEvent> {
    let reason_raw: String = row.get(5)?;
    Ok(PsoInvalidationEvent {
        id: Some(row.get(0)?),
        project_id: row.get(1)?,
        machine_id: row.get(2)?,
        warmup_run_id: row.get(3)?,
        driver_cache_snapshot_id: row.get(4)?,
        reason: PsoInvalidationReason::from_str(&reason_raw),
        detail: row.get(6)?,
        detected_at: row.get(7)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::driver_cache_snapshots::{
        DriverCacheDirectorySnapshot, DriverCacheSnapshotInput,
    };
    use crate::data::{
        driver_cache_snapshots, machines, open_in_memory, projects, pso_warmup_runs, schema,
        Machine, Project, WarmupStatus,
    };

    fn setup() -> (Db, i64, i64, i64, i64) {
        let db = open_in_memory().unwrap();
        {
            let mut conn = db.lock().unwrap();
            schema::migrate(&mut conn).unwrap();
        }
        let machine_id = machines::insert(&db, &Machine::new("RENDER-01", "192.168.10.21")).unwrap();
        let project_id = projects::upsert(
            &db,
            &Project {
                id: None,
                uproject_name: "X.uproject".into(),
                uproject_stem_lower: "x".into(),
                uproject_guid: None,
                display_name: None,
                first_seen_at: None,
                last_seen_at: None,
                ue_version_major: None,
                ue_version_minor: None,
                engine_association_raw: None,
                engine_association_kind: None,
            },
        )
        .unwrap();
        let run_id = pso_warmup_runs::insert_started(
            &db,
            project_id,
            machine_id,
            (1920, 1080),
            5,
            "ndisplay_offscreen",
            Some("Node_0"),
            false,
        )
        .unwrap();
        pso_warmup_runs::finish(&db, run_id, WarmupStatus::Ok, Some(0), None, 30, None).unwrap();
        let snapshot = driver_cache_snapshots::insert(
            &db,
            &DriverCacheSnapshotInput {
                machine_id,
                gpu_model: None,
                gpu_driver_version: Some("1".into()),
                interactive_user: Some("LANPC\\artist".into()),
                node_last_boot_time: None,
                local_appdata_dxcache: DriverCacheDirectorySnapshot {
                    kind: "local_appdata_dxcache".into(),
                    path: "A".into(),
                    exists: true,
                    file_count: 1,
                    total_bytes: 100,
                    newest_mtime: None,
                },
                locallow_per_driver_dxcache: DriverCacheDirectorySnapshot {
                    kind: "locallow_per_driver_dxcache".into(),
                    path: "B".into(),
                    exists: false,
                    file_count: 0,
                    total_bytes: 0,
                    newest_mtime: None,
                },
                total_file_count: 1,
                total_bytes: 100,
                newest_mtime: None,
            },
        )
        .unwrap();
        (db, project_id, machine_id, run_id, snapshot.id.unwrap())
    }

    #[test]
    fn insert_if_absent_is_idempotent() {
        let (db, project_id, machine_id, run_id, snapshot_id) = setup();
        let event = PsoInvalidationEvent {
            id: None,
            project_id,
            machine_id,
            warmup_run_id: run_id,
            driver_cache_snapshot_id: snapshot_id,
            reason: PsoInvalidationReason::GpuDriverChanged,
            detail: "driver 1 -> 2".into(),
            detected_at: None,
        };
        insert_if_absent(&db, &event).unwrap();
        insert_if_absent(&db, &event).unwrap();
        let rows = list_for_warmup(&db, project_id, machine_id, run_id).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].reason, PsoInvalidationReason::GpuDriverChanged);
    }
}
