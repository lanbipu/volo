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
         (machine_id, gpu_model, gpu_driver_version, interactive_user,
          local_appdata_dxcache_path, local_appdata_dxcache_exists,
          local_appdata_dxcache_file_count, local_appdata_dxcache_total_bytes,
          local_appdata_dxcache_newest_mtime,
          locallow_per_driver_dxcache_path, locallow_per_driver_dxcache_exists,
          locallow_per_driver_dxcache_file_count, locallow_per_driver_dxcache_total_bytes,
          locallow_per_driver_dxcache_newest_mtime,
          total_file_count, total_bytes, newest_mtime)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            input.machine_id,
            input.gpu_model.as_deref(),
            input.gpu_driver_version.as_deref(),
            input.interactive_user.as_deref(),
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

fn get_by_id_locked(
    conn: &rusqlite::Connection,
    id: i64,
) -> rusqlite::Result<DriverCacheSnapshot> {
    conn.query_row(
        "SELECT id, machine_id, gpu_model, gpu_driver_version, interactive_user,
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
        local_appdata_dxcache: DriverCacheDirectorySnapshot {
            kind: "local_appdata_dxcache".into(),
            path: row.get(5)?,
            exists: row.get::<_, i64>(6)? != 0,
            file_count: row.get(7)?,
            total_bytes: row.get(8)?,
            newest_mtime: row.get(9)?,
        },
        locallow_per_driver_dxcache: DriverCacheDirectorySnapshot {
            kind: "locallow_per_driver_dxcache".into(),
            path: row.get(10)?,
            exists: row.get::<_, i64>(11)? != 0,
            file_count: row.get(12)?,
            total_bytes: row.get(13)?,
            newest_mtime: row.get(14)?,
        },
        total_file_count: row.get(15)?,
        total_bytes: row.get(16)?,
        newest_mtime: row.get(17)?,
        captured_at: row.get(18)?,
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
        assert_eq!(got.local_appdata_dxcache.exists, true);
        assert_eq!(got.locallow_per_driver_dxcache.exists, false);
        assert_eq!(got.total_file_count, 24);
        assert!(got.captured_at.is_some());
    }
}
