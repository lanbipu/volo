//! CRUD for the `machine_ue_installs` table.

use crate::data::Db;
use crate::error::UecmResult;
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UeInstall {
    pub id: Option<i64>,
    pub machine_id: i64,
    pub version: String,        // e.g. "5.4", "5.5"
    pub install_path: String,   // e.g. "C:\\Program Files\\Epic Games\\UE_5.4"
    pub is_primary: bool,
    // Zen InTree binary fields (one copy ships per UE install at
    // <UE_root>\Engine\Binaries\Win64\). These are reference-only; R016 / R018
    // check the install copy under %LOCALAPPDATA%\UnrealEngine\Common\Zen\Install\.
    // All Optional<String> so an InTree-less upsert (e.g. discovery before
    // binary detect) leaves them NULL.
    #[serde(default)]
    pub zen_cli_intree_path: Option<String>,
    #[serde(default)]
    pub zen_cli_intree_version: Option<String>,
    #[serde(default)]
    pub zen_cli_intree_sha256: Option<String>,
    #[serde(default)]
    pub zenserver_intree_path: Option<String>,
    #[serde(default)]
    pub zenserver_intree_version: Option<String>,
    #[serde(default)]
    pub zenserver_intree_sha256: Option<String>,
}

pub fn upsert(db: &Db, install: &UeInstall) -> UecmResult<i64> {
    let conn = db.lock().unwrap();
    conn.execute(
        "INSERT INTO machine_ue_installs (
            machine_id, version, install_path, is_primary,
            zen_cli_intree_path, zen_cli_intree_version, zen_cli_intree_sha256,
            zenserver_intree_path, zenserver_intree_version, zenserver_intree_sha256
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(machine_id, version) DO UPDATE SET
            install_path = excluded.install_path,
            is_primary = excluded.is_primary,
            zen_cli_intree_path = excluded.zen_cli_intree_path,
            zen_cli_intree_version = excluded.zen_cli_intree_version,
            zen_cli_intree_sha256 = excluded.zen_cli_intree_sha256,
            zenserver_intree_path = excluded.zenserver_intree_path,
            zenserver_intree_version = excluded.zenserver_intree_version,
            zenserver_intree_sha256 = excluded.zenserver_intree_sha256,
            detected_at = CURRENT_TIMESTAMP",
        params![
            install.machine_id,
            install.version,
            install.install_path,
            install.is_primary as i32,
            install.zen_cli_intree_path,
            install.zen_cli_intree_version,
            install.zen_cli_intree_sha256,
            install.zenserver_intree_path,
            install.zenserver_intree_version,
            install.zenserver_intree_sha256,
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn list_for_machine(db: &Db, machine_id: i64) -> UecmResult<Vec<UeInstall>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, machine_id, version, install_path, is_primary,
                zen_cli_intree_path, zen_cli_intree_version, zen_cli_intree_sha256,
                zenserver_intree_path, zenserver_intree_version, zenserver_intree_sha256
         FROM machine_ue_installs WHERE machine_id = ? ORDER BY version DESC",
    )?;
    let rows = stmt.query_map(params![machine_id], machine_ue_install_from_row)?;
    let mut result = Vec::new();
    for r in rows {
        result.push(r?);
    }
    Ok(result)
}

/// Find a UE install row by machine + major/minor version. T1.6 callers pass
/// the version as two integers (matches the PS sidecar JSON contract); we
/// rebuild the canonical "<major>.<minor>" string used by the UNIQUE index.
pub fn find(
    db: &Db,
    machine_id: i64,
    ue_major: i64,
    ue_minor: i64,
) -> UecmResult<Option<UeInstall>> {
    let version = format!("{ue_major}.{ue_minor}");
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, machine_id, version, install_path, is_primary,
                zen_cli_intree_path, zen_cli_intree_version, zen_cli_intree_sha256,
                zenserver_intree_path, zenserver_intree_version, zenserver_intree_sha256
         FROM machine_ue_installs WHERE machine_id = ? AND version = ?",
    )?;
    let mut rows = stmt.query(params![machine_id, version])?;
    if let Some(row) = rows.next()? {
        Ok(Some(machine_ue_install_from_row(row)?))
    } else {
        Ok(None)
    }
}

pub fn delete_for_machine(db: &Db, machine_id: i64) -> UecmResult<()> {
    let conn = db.lock().unwrap();
    conn.execute(
        "DELETE FROM machine_ue_installs WHERE machine_id = ?",
        params![machine_id],
    )?;
    Ok(())
}

fn machine_ue_install_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<UeInstall> {
    Ok(UeInstall {
        id: Some(row.get(0)?),
        machine_id: row.get(1)?,
        version: row.get(2)?,
        install_path: row.get(3)?,
        is_primary: row.get::<_, i32>(4)? != 0,
        zen_cli_intree_path: row.get(5)?,
        zen_cli_intree_version: row.get(6)?,
        zen_cli_intree_sha256: row.get(7)?,
        zenserver_intree_path: row.get(8)?,
        zenserver_intree_version: row.get(9)?,
        zenserver_intree_sha256: row.get(10)?,
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
        let machine_id = machines::insert(
            &db,
            &Machine::new("RENDER-01", "192.168.10.21"),
        )
        .unwrap();
        (db, machine_id)
    }

    fn ue(machine_id: i64, version: &str, path: &str, is_primary: bool) -> UeInstall {
        UeInstall {
            id: None,
            machine_id,
            version: version.to_string(),
            install_path: path.to_string(),
            is_primary,
            zen_cli_intree_path: None,
            zen_cli_intree_version: None,
            zen_cli_intree_sha256: None,
            zenserver_intree_path: None,
            zenserver_intree_version: None,
            zenserver_intree_sha256: None,
        }
    }

    #[test]
    fn upsert_inserts_when_new() {
        let (db, machine_id) = setup();
        let id = upsert(&db, &ue(machine_id, "5.4", "C:\\UE_5.4", true)).unwrap();
        assert!(id > 0);
    }

    #[test]
    fn upsert_updates_when_machine_version_exists() {
        let (db, machine_id) = setup();
        upsert(&db, &ue(machine_id, "5.4", "C:\\OldPath", false)).unwrap();
        upsert(&db, &ue(machine_id, "5.4", "C:\\NewPath", true)).unwrap();

        let installs = list_for_machine(&db, machine_id).unwrap();
        assert_eq!(installs.len(), 1);
        assert_eq!(installs[0].install_path, "C:\\NewPath");
        assert!(installs[0].is_primary);
    }

    #[test]
    fn list_for_machine_returns_all_versions_desc() {
        let (db, machine_id) = setup();
        upsert(&db, &ue(machine_id, "5.3", "C:\\A", false)).unwrap();
        upsert(&db, &ue(machine_id, "5.5", "C:\\C", false)).unwrap();
        upsert(&db, &ue(machine_id, "5.4", "C:\\B", true)).unwrap();

        let installs = list_for_machine(&db, machine_id).unwrap();
        assert_eq!(installs.len(), 3);
        assert_eq!(installs[0].version, "5.5");
        assert_eq!(installs[1].version, "5.4");
        assert_eq!(installs[2].version, "5.3");
    }

    #[test]
    fn delete_for_machine_removes_all_installs() {
        let (db, machine_id) = setup();
        upsert(&db, &ue(machine_id, "5.4", "C:\\A", true)).unwrap();
        delete_for_machine(&db, machine_id).unwrap();
        let installs = list_for_machine(&db, machine_id).unwrap();
        assert!(installs.is_empty());
    }

    #[test]
    fn find_returns_row_when_present_else_none() {
        let (db, machine_id) = setup();
        upsert(&db, &ue(machine_id, "5.7", "C:\\UE_5.7", true)).unwrap();
        let got = find(&db, machine_id, 5, 7).unwrap().unwrap();
        assert_eq!(got.install_path, "C:\\UE_5.7");
        assert!(find(&db, machine_id, 5, 9).unwrap().is_none());
    }

    #[test]
    fn upsert_roundtrips_intree_columns() {
        let (db, machine_id) = setup();
        let mut row = ue(machine_id, "5.7", "C:\\UE_5.7", false);
        row.zen_cli_intree_path = Some("C:\\UE_5.7\\Engine\\Binaries\\Win64\\zen.exe".into());
        row.zen_cli_intree_version = Some("5.7.6-fake".into());
        row.zen_cli_intree_sha256 = Some("aaaa".into());
        row.zenserver_intree_path = Some("C:\\UE_5.7\\Engine\\Binaries\\Win64\\zenserver.exe".into());
        row.zenserver_intree_version = Some("5.7.6-fake".into());
        row.zenserver_intree_sha256 = Some("bbbb".into());
        upsert(&db, &row).unwrap();
        let got = find(&db, machine_id, 5, 7).unwrap().unwrap();
        assert_eq!(got.zen_cli_intree_sha256.as_deref(), Some("aaaa"));
        assert_eq!(got.zenserver_intree_version.as_deref(), Some("5.7.6-fake"));
    }
}
