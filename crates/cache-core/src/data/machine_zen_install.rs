//! CRUD for the `machine_zen_install` table (one row per machine).

use crate::data::Db;
use crate::error::UecmResult;
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MachineZenInstall {
    pub machine_id: i64,
    pub install_dir: Option<String>,
    pub zen_cli_path: Option<String>,
    pub zen_cli_build_version: Option<String>,
    pub zen_cli_sha256: Option<String>,
    pub zenserver_path: Option<String>,
    pub zenserver_build_version: Option<String>,
    pub zenserver_sha256: Option<String>,
    pub last_detected_at: Option<String>,
}

pub fn upsert(db: &Db, row: &MachineZenInstall) -> UecmResult<()> {
    let conn = db.lock().unwrap();
    conn.execute(
        "INSERT INTO machine_zen_install (
            machine_id, install_dir,
            zen_cli_path, zen_cli_build_version, zen_cli_sha256,
            zenserver_path, zenserver_build_version, zenserver_sha256,
            last_detected_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(machine_id) DO UPDATE SET
            install_dir = excluded.install_dir,
            zen_cli_path = excluded.zen_cli_path,
            zen_cli_build_version = excluded.zen_cli_build_version,
            zen_cli_sha256 = excluded.zen_cli_sha256,
            zenserver_path = excluded.zenserver_path,
            zenserver_build_version = excluded.zenserver_build_version,
            zenserver_sha256 = excluded.zenserver_sha256,
            last_detected_at = CURRENT_TIMESTAMP",
        params![
            row.machine_id,
            row.install_dir,
            row.zen_cli_path,
            row.zen_cli_build_version,
            row.zen_cli_sha256,
            row.zenserver_path,
            row.zenserver_build_version,
            row.zenserver_sha256,
        ],
    )?;
    Ok(())
}

pub fn list(db: &Db) -> UecmResult<Vec<MachineZenInstall>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT machine_id, install_dir,
                zen_cli_path, zen_cli_build_version, zen_cli_sha256,
                zenserver_path, zenserver_build_version, zenserver_sha256,
                last_detected_at
         FROM machine_zen_install
         ORDER BY machine_id ASC",
    )?;
    let rows = stmt.query_map([], machine_zen_install_from_row)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub fn find(db: &Db, machine_id: i64) -> UecmResult<Option<MachineZenInstall>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT machine_id, install_dir,
                zen_cli_path, zen_cli_build_version, zen_cli_sha256,
                zenserver_path, zenserver_build_version, zenserver_sha256,
                last_detected_at
         FROM machine_zen_install WHERE machine_id = ?",
    )?;
    let mut rows = stmt.query(params![machine_id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(machine_zen_install_from_row(row)?))
    } else {
        Ok(None)
    }
}

/// Returns true when a row was deleted, false when none existed for this
/// machine. Callers use the bool to decide whether to log "cleared stale
/// state" vs no-op (T1.6 install-uninstalled handling).
pub fn delete(db: &Db, machine_id: i64) -> UecmResult<bool> {
    let conn = db.lock().unwrap();
    let rows = conn.execute(
        "DELETE FROM machine_zen_install WHERE machine_id = ?",
        params![machine_id],
    )?;
    Ok(rows > 0)
}

fn machine_zen_install_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<MachineZenInstall> {
    Ok(MachineZenInstall {
        machine_id: row.get(0)?,
        install_dir: row.get(1)?,
        zen_cli_path: row.get(2)?,
        zen_cli_build_version: row.get(3)?,
        zen_cli_sha256: row.get(4)?,
        zenserver_path: row.get(5)?,
        zenserver_build_version: row.get(6)?,
        zenserver_sha256: row.get(7)?,
        last_detected_at: row.get(8)?,
    })
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
        let machine_id = machines::insert(&db, &Machine::new("ZEN-01", "192.168.10.30")).unwrap();
        (db, machine_id)
    }

    fn sample(machine_id: i64) -> MachineZenInstall {
        MachineZenInstall {
            machine_id,
            install_dir: Some("C:\\Tools\\Zen".into()),
            zen_cli_path: Some("C:\\Tools\\Zen\\zen.exe".into()),
            zen_cli_build_version: Some("1.2.3".into()),
            zen_cli_sha256: Some("aaaa".into()),
            zenserver_path: Some("C:\\Tools\\Zen\\zenserver.exe".into()),
            zenserver_build_version: Some("1.2.3".into()),
            zenserver_sha256: Some("bbbb".into()),
            last_detected_at: None,
        }
    }

    #[test]
    fn upsert_inserts_when_new() {
        let (db, machine_id) = setup();
        upsert(&db, &sample(machine_id)).unwrap();
        let got = find(&db, machine_id).unwrap().unwrap();
        assert_eq!(got.zen_cli_build_version.as_deref(), Some("1.2.3"));
        assert_eq!(got.zenserver_sha256.as_deref(), Some("bbbb"));
    }

    #[test]
    fn upsert_updates_when_machine_exists() {
        let (db, machine_id) = setup();
        upsert(&db, &sample(machine_id)).unwrap();
        let mut row = sample(machine_id);
        row.zen_cli_build_version = Some("1.2.4".into());
        row.zen_cli_sha256 = Some("cccc".into());
        upsert(&db, &row).unwrap();
        let got = find(&db, machine_id).unwrap().unwrap();
        assert_eq!(got.zen_cli_build_version.as_deref(), Some("1.2.4"));
        assert_eq!(got.zen_cli_sha256.as_deref(), Some("cccc"));
        // Verify only one row exists for this machine.
        let rows = list(&db).unwrap();
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn upsert_clears_field_when_set_to_none() {
        let (db, machine_id) = setup();
        upsert(&db, &sample(machine_id)).unwrap();
        let mut row = sample(machine_id);
        row.zenserver_path = None;
        row.zenserver_build_version = None;
        row.zenserver_sha256 = None;
        upsert(&db, &row).unwrap();
        let got = find(&db, machine_id).unwrap().unwrap();
        assert!(got.zenserver_path.is_none());
        assert!(got.zenserver_sha256.is_none());
        // zen_cli fields should remain.
        assert_eq!(got.zen_cli_path.as_deref(), Some("C:\\Tools\\Zen\\zen.exe"));
    }

    #[test]
    fn find_returns_none_when_missing() {
        let (db, machine_id) = setup();
        assert!(find(&db, machine_id).unwrap().is_none());
    }

    #[test]
    fn list_returns_all_machines() {
        let (db, machine_id) = setup();
        let other = machines::insert(&db, &Machine::new("ZEN-02", "192.168.10.31")).unwrap();
        upsert(&db, &sample(machine_id)).unwrap();
        upsert(&db, &sample(other)).unwrap();
        let rows = list(&db).unwrap();
        assert_eq!(rows.len(), 2);
    }

    #[test]
    fn delete_removes_row() {
        let (db, machine_id) = setup();
        upsert(&db, &sample(machine_id)).unwrap();
        delete(&db, machine_id).unwrap();
        assert!(find(&db, machine_id).unwrap().is_none());
    }
}
