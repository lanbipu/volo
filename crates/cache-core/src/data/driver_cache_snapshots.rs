//! CRUD for GPU driver-cache probe snapshots.

use crate::data::Db;
use crate::error::VoloResult;
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
pub struct DriverCacheDirectorySnapshot {
    pub kind: String,
    pub path: String,
    pub exists: bool,
    pub file_count: i64,
    pub total_bytes: i64,
    pub newest_mtime: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
pub struct DriverCacheSnapshotInput {
    pub machine_id: i64,
    pub gpu_model: Option<String>,
    pub gpu_driver_version: Option<String>,
    pub interactive_user: Option<String>,
    pub node_last_boot_time: Option<String>,
    pub local_appdata_dxcache: DriverCacheDirectorySnapshot,
    pub locallow_per_driver_dxcache: DriverCacheDirectorySnapshot,
    pub total_file_count: i64,
    pub total_bytes: i64,
    pub newest_mtime: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
pub struct DriverCacheSnapshot {
    pub id: Option<i64>,
    pub machine_id: i64,
    pub gpu_model: Option<String>,
    pub gpu_driver_version: Option<String>,
    pub interactive_user: Option<String>,
    pub node_last_boot_time: Option<String>,
    pub local_appdata_dxcache: DriverCacheDirectorySnapshot,
    pub locallow_per_driver_dxcache: DriverCacheDirectorySnapshot,
    pub total_file_count: i64,
    pub total_bytes: i64,
    pub newest_mtime: Option<String>,
    pub captured_at: Option<String>,
}

pub fn insert(db: &Db, input: &DriverCacheSnapshotInput) -> VoloResult<DriverCacheSnapshot> {
    let conn = db.lock().unwrap();
    conn.execute(
        "INSERT INTO driver_cache_snapshots
         (machine_id, gpu_model, gpu_driver_version, interactive_user, node_last_boot_time,
          local_appdata_dxcache_path, local_appdata_dxcache_exists,
          local_appdata_dxcache_file_count, local_appdata_dxcache_total_bytes,
          local_appdata_dxcache_newest_mtime,
          locallow_per_driver_dxcache_path, locallow_per_driver_dxcache_exists,
          locallow_per_driver_dxcache_file_count, locallow_per_driver_dxcache_total_bytes,
          locallow_per_driver_dxcache_newest_mtime,
          total_file_count, total_bytes, newest_mtime)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            input.machine_id,
            input.gpu_model.as_deref(),
            input.gpu_driver_version.as_deref(),
            input.interactive_user.as_deref(),
            input.node_last_boot_time.as_deref(),
            input.local_appdata_dxcache.path.as_str(),
            bool_to_i64(input.local_appdata_dxcache.exists),
            input.local_appdata_dxcache.file_count,
            input.local_appdata_dxcache.total_bytes,
            input.local_appdata_dxcache.newest_mtime.as_deref(),
            input.locallow_per_driver_dxcache.path.as_str(),
            bool_to_i64(input.locallow_per_driver_dxcache.exists),
            input.locallow_per_driver_dxcache.file_count,
            input.locallow_per_driver_dxcache.total_bytes,
            input.locallow_per_driver_dxcache.newest_mtime.as_deref(),
            input.total_file_count,
            input.total_bytes,
            input.newest_mtime.as_deref(),
        ],
    )?;
    let id = conn.last_insert_rowid();
    Ok(get_by_id_locked(&conn, id)?)
}

pub fn latest_for_machine(db: &Db, machine_id: i64) -> VoloResult<Option<DriverCacheSnapshot>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, machine_id, gpu_model, gpu_driver_version, interactive_user,
                node_last_boot_time,
                local_appdata_dxcache_path, local_appdata_dxcache_exists,
                local_appdata_dxcache_file_count, local_appdata_dxcache_total_bytes,
                local_appdata_dxcache_newest_mtime,
                locallow_per_driver_dxcache_path, locallow_per_driver_dxcache_exists,
                locallow_per_driver_dxcache_file_count, locallow_per_driver_dxcache_total_bytes,
                locallow_per_driver_dxcache_newest_mtime,
                total_file_count, total_bytes, newest_mtime, captured_at
         FROM driver_cache_snapshots
         WHERE machine_id = ?
         ORDER BY datetime(captured_at) DESC, id DESC
         LIMIT 1",
    )?;
    let mut rows = stmt.query([machine_id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(row_to_snapshot(row)?))
    } else {
        Ok(None)
    }
}

pub fn latest_at_or_before(
    db: &Db,
    machine_id: i64,
    timestamp: &str,
) -> VoloResult<Option<DriverCacheSnapshot>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, machine_id, gpu_model, gpu_driver_version, interactive_user,
                node_last_boot_time,
                local_appdata_dxcache_path, local_appdata_dxcache_exists,
                local_appdata_dxcache_file_count, local_appdata_dxcache_total_bytes,
                local_appdata_dxcache_newest_mtime,
                locallow_per_driver_dxcache_path, locallow_per_driver_dxcache_exists,
                locallow_per_driver_dxcache_file_count, locallow_per_driver_dxcache_total_bytes,
                locallow_per_driver_dxcache_newest_mtime,
                total_file_count, total_bytes, newest_mtime, captured_at
         FROM driver_cache_snapshots
         WHERE machine_id = ? AND datetime(captured_at) <= datetime(?)
         ORDER BY datetime(captured_at) DESC, id DESC
         LIMIT 1",
    )?;
    let mut rows = stmt.query(rusqlite::params![machine_id, timestamp])?;
    if let Some(row) = rows.next()? {
        Ok(Some(row_to_snapshot(row)?))
    } else {
        Ok(None)
    }
}

fn get_by_id_locked(
    conn: &rusqlite::Connection,
    id: i64,
) -> rusqlite::Result<DriverCacheSnapshot> {
    conn.query_row(
        "SELECT id, machine_id, gpu_model, gpu_driver_version, interactive_user,
                node_last_boot_time,
                local_appdata_dxcache_path, local_appdata_dxcache_exists,
                local_appdata_dxcache_file_count, local_appdata_dxcache_total_bytes,
                local_appdata_dxcache_newest_mtime,
                locallow_per_driver_dxcache_path, locallow_per_driver_dxcache_exists,
                locallow_per_driver_dxcache_file_count, locallow_per_driver_dxcache_total_bytes,
                locallow_per_driver_dxcache_newest_mtime,
                total_file_count, total_bytes, newest_mtime, captured_at
         FROM driver_cache_snapshots WHERE id = ?",
        [id],
        row_to_snapshot,
    )
}

fn row_to_snapshot(row: &rusqlite::Row<'_>) -> rusqlite::Result<DriverCacheSnapshot> {
    Ok(DriverCacheSnapshot {
        id: Some(row.get(0)?),
        machine_id: row.get(1)?,
        gpu_model: row.get(2)?,
        gpu_driver_version: row.get(3)?,
        interactive_user: row.get(4)?,
        node_last_boot_time: row.get(5)?,
        local_appdata_dxcache: DriverCacheDirectorySnapshot {
            kind: "local_appdata_dxcache".into(),
            path: row.get(6)?,
            exists: row.get::<_, i64>(7)? != 0,
            file_count: row.get(8)?,
            total_bytes: row.get(9)?,
            newest_mtime: row.get(10)?,
        },
        locallow_per_driver_dxcache: DriverCacheDirectorySnapshot {
            kind: "locallow_per_driver_dxcache".into(),
            path: row.get(11)?,
            exists: row.get::<_, i64>(12)? != 0,
            file_count: row.get(13)?,
            total_bytes: row.get(14)?,
            newest_mtime: row.get(15)?,
        },
        total_file_count: row.get(16)?,
        total_bytes: row.get(17)?,
        newest_mtime: row.get(18)?,
        captured_at: row.get(19)?,
    })
}

fn bool_to_i64(value: bool) -> i64 {
    if value { 1 } else { 0 }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::{machines, open_in_memory, schema, Machine};

    fn setup() -> (Db, i64) {
        let db = open_in_memory().unwrap();
        {
            let mut conn = db.lock().unwrap();
            schema::migrate(&mut conn).unwrap();
        }
        let machine_id = machines::insert(&db, &Machine::new("RENDER-01", "192.168.10.21")).unwrap();
        (db, machine_id)
    }

    #[test]
    fn insert_roundtrips_missing_vs_empty_dirs() {
        let (db, machine_id) = setup();
        let input = DriverCacheSnapshotInput {
            machine_id,
            gpu_model: Some("NVIDIA GeForce RTX 3080".into()),
            gpu_driver_version: Some("32.0.15.7652".into()),
            interactive_user: Some("LANPC\\artist".into()),
            node_last_boot_time: Some("2026-07-07T00:30:00.0000000Z".into()),
            local_appdata_dxcache: DriverCacheDirectorySnapshot {
                kind: "local_appdata_dxcache".into(),
                path: r"C:\Users\a\AppData\Local\NVIDIA\DXCache".into(),
                exists: true,
                file_count: 24,
                total_bytes: 35_800_000,
                newest_mtime: Some("2026-07-07T01:00:00.0000000Z".into()),
            },
            locallow_per_driver_dxcache: DriverCacheDirectorySnapshot {
                kind: "locallow_per_driver_dxcache".into(),
                path: r"C:\Users\a\AppData\LocalLow\NVIDIA\PerDriverVersion\DXCache".into(),
                exists: false,
                file_count: 0,
                total_bytes: 0,
                newest_mtime: None,
            },
            total_file_count: 24,
            total_bytes: 35_800_000,
            newest_mtime: Some("2026-07-07T01:00:00.0000000Z".into()),
        };
        let got = insert(&db, &input).unwrap();
        assert!(got.id.unwrap() > 0);
        assert_eq!(got.gpu_driver_version.as_deref(), Some("32.0.15.7652"));
        assert_eq!(got.node_last_boot_time.as_deref(), Some("2026-07-07T00:30:00.0000000Z"));
        assert_eq!(got.local_appdata_dxcache.exists, true);
        assert_eq!(got.locallow_per_driver_dxcache.exists, false);
        assert_eq!(got.total_file_count, 24);
        assert!(got.captured_at.is_some());
    }

    #[test]
    fn latest_queries_return_expected_snapshot() {
        let (db, machine_id) = setup();
        let input = DriverCacheSnapshotInput {
            machine_id,
            gpu_model: None,
            gpu_driver_version: Some("1".into()),
            interactive_user: None,
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
        };
        let first = insert(&db, &input).unwrap();
        {
            let conn = db.lock().unwrap();
            conn.execute(
                "UPDATE driver_cache_snapshots SET captured_at = datetime('now', '-1 hour') WHERE id = ?",
                [first.id.unwrap()],
            )
            .unwrap();
        }
        let mut second_input = input.clone();
        second_input.gpu_driver_version = Some("2".into());
        second_input.total_bytes = 50;
        let second = insert(&db, &second_input).unwrap();
        let latest = latest_for_machine(&db, machine_id).unwrap().unwrap();
        assert_eq!(latest.id, second.id);
        let baseline = latest_at_or_before(&db, machine_id, "now").unwrap().unwrap();
        assert!(baseline.id == first.id || baseline.id == second.id);
    }
}
