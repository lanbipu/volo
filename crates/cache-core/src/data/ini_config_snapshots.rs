//! CRUD for `ini_config_snapshots`. One row per captured DDC/PSO/Zen config
//! key from an INI scan. Rows are immutable; FK cascade cleans them on
//! scan_run / machine deletion.

use crate::data::Db;
use crate::error::UecmResult;
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, schemars::JsonSchema)]
pub struct ConfigSnapshot {
    pub id: Option<i64>,
    pub scan_run_id: i64,
    pub machine_id: i64,
    pub file_path: String,
    pub ue_version: Option<String>,
    pub domain: String, // "ddc" | "pso" | "zen"
    pub section: String,
    pub key_name: String,
    pub value: String,
    pub line_number: Option<i64>,
}

pub fn insert(db: &Db, s: &ConfigSnapshot) -> UecmResult<i64> {
    let conn = db.lock().unwrap();
    conn.execute(
        "INSERT INTO ini_config_snapshots (
            scan_run_id, machine_id, file_path, ue_version, domain,
            section, key_name, value, line_number
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            s.scan_run_id, s.machine_id, s.file_path, s.ue_version, s.domain,
            s.section, s.key_name, s.value, s.line_number,
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

fn row_to_snapshot(row: &rusqlite::Row) -> rusqlite::Result<ConfigSnapshot> {
    Ok(ConfigSnapshot {
        id: Some(row.get(0)?),
        scan_run_id: row.get(1)?,
        machine_id: row.get(2)?,
        file_path: row.get(3)?,
        ue_version: row.get(4)?,
        domain: row.get(5)?,
        section: row.get(6)?,
        key_name: row.get(7)?,
        value: row.get(8)?,
        line_number: row.get(9)?,
    })
}

pub fn list_for_run(db: &Db, scan_run_id: i64) -> UecmResult<Vec<ConfigSnapshot>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, scan_run_id, machine_id, file_path, ue_version, domain,
                section, key_name, value, line_number
         FROM ini_config_snapshots
         WHERE scan_run_id = ?
         ORDER BY machine_id, file_path, domain, section, key_name",
    )?;
    let rows = stmt.query_map(params![scan_run_id], row_to_snapshot)?;
    let mut out = Vec::new();
    for r in rows { out.push(r?); }
    Ok(out)
}

pub fn list_for_run_domain(db: &Db, scan_run_id: i64, domain: &str) -> UecmResult<Vec<ConfigSnapshot>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, scan_run_id, machine_id, file_path, ue_version, domain,
                section, key_name, value, line_number
         FROM ini_config_snapshots
         WHERE scan_run_id = ? AND domain = ?
         ORDER BY machine_id, file_path, section, key_name",
    )?;
    let rows = stmt.query_map(params![scan_run_id, domain], row_to_snapshot)?;
    let mut out = Vec::new();
    for r in rows { out.push(r?); }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::machines::{insert as insert_machine, Machine};
    use crate::data::{open_in_memory, scan_runs, schema};

    fn setup() -> (Db, i64, i64) {
        let db = open_in_memory().unwrap();
        { let mut conn = db.lock().unwrap(); schema::migrate(&mut conn).unwrap(); }
        let machine_id = insert_machine(&db, &Machine::new("RENDER-01", "192.168.10.21")).unwrap();
        let scan_id = scan_runs::insert(&db, "ini", &[machine_id]).unwrap();
        (db, scan_id, machine_id)
    }

    fn sample(scan_id: i64, machine_id: i64, domain: &str, key: &str) -> ConfigSnapshot {
        ConfigSnapshot {
            id: None, scan_run_id: scan_id, machine_id,
            file_path: "C:\\Proj\\Config\\DefaultEngine.ini".into(),
            ue_version: Some("5.4".into()), domain: domain.into(),
            section: "DerivedDataBackendGraph".into(), key_name: key.into(),
            value: "(Type=FileSystem)".into(), line_number: Some(10),
        }
    }

    #[test]
    fn insert_and_list_for_run() {
        let (db, scan_id, mid) = setup();
        insert(&db, &sample(scan_id, mid, "ddc", "Root")).unwrap();
        insert(&db, &sample(scan_id, mid, "pso", "r.PSOPrecaching")).unwrap();
        let rows = list_for_run(&db, scan_id).unwrap();
        assert_eq!(rows.len(), 2);
    }

    #[test]
    fn list_for_run_domain_filters() {
        let (db, scan_id, mid) = setup();
        insert(&db, &sample(scan_id, mid, "ddc", "Root")).unwrap();
        insert(&db, &sample(scan_id, mid, "pso", "r.PSOPrecaching")).unwrap();
        let ddc = list_for_run_domain(&db, scan_id, "ddc").unwrap();
        assert_eq!(ddc.len(), 1);
        assert_eq!(ddc[0].domain, "ddc");
    }

    #[test]
    fn fk_cascade_clears_snapshots_on_scan_run_delete() {
        let (db, scan_id, mid) = setup();
        insert(&db, &sample(scan_id, mid, "ddc", "Root")).unwrap();
        {
            let conn = db.lock().unwrap();
            conn.execute("DELETE FROM scan_runs WHERE id = ?", params![scan_id]).unwrap();
        }
        let rows = list_for_run(&db, scan_id).unwrap();
        assert!(rows.is_empty(), "FK cascade should have cleared snapshots");
    }
}
