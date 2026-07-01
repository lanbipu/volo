//! CRUD for the `scan_runs` table. Each row is one INI-scan-or-health-check session.

use crate::data::Db;
use crate::error::{VoloError, VoloResult};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, schemars::JsonSchema)]
pub struct ScanRun {
    pub id: Option<i64>,
    pub scan_type: String, // "ini" | "health"
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub machine_ids: Vec<i64>,
    pub summary: Option<JsonValue>,
}

pub fn insert(db: &Db, scan_type: &str, machine_ids: &[i64]) -> VoloResult<i64> {
    let conn = db.lock().unwrap();
    let machine_ids_json = serde_json::to_string(machine_ids)
        .map_err(|e| VoloError::OperationFailed(e.to_string()))?;
    conn.execute(
        "INSERT INTO scan_runs (scan_type, machine_ids_json) VALUES (?, ?)",
        params![scan_type, machine_ids_json],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn finish(db: &Db, id: i64, summary: &JsonValue) -> VoloResult<()> {
    let conn = db.lock().unwrap();
    let summary_json = serde_json::to_string(summary)
        .map_err(|e| VoloError::OperationFailed(e.to_string()))?;
    conn.execute(
        "UPDATE scan_runs SET finished_at = CURRENT_TIMESTAMP, summary_json = ? WHERE id = ?",
        params![summary_json, id],
    )?;
    Ok(())
}

pub fn find_by_id(db: &Db, id: i64) -> VoloResult<Option<ScanRun>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, scan_type, started_at, finished_at, machine_ids_json, summary_json
         FROM scan_runs WHERE id = ?",
    )?;
    let mut rows = stmt.query(params![id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(row_to_scan_run(row)?))
    } else {
        Ok(None)
    }
}

pub fn list_recent_types(db: &Db, scan_types: &[&str], limit: i64) -> VoloResult<Vec<ScanRun>> {
    if scan_types.is_empty() {
        return Ok(Vec::new());
    }
    let conn = db.lock().unwrap();
    let placeholders = vec!["?"; scan_types.len()].join(",");
    let sql = format!(
        "SELECT id, scan_type, started_at, finished_at, machine_ids_json, summary_json
         FROM scan_runs WHERE scan_type IN ({}) ORDER BY started_at DESC, id DESC LIMIT ?",
        placeholders
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut params_vec: Vec<&dyn rusqlite::ToSql> = Vec::new();
    for t in scan_types {
        params_vec.push(t);
    }
    params_vec.push(&limit);
    let rows = stmt.query_map(params_vec.as_slice(), |row| row_to_scan_run(row))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn list_recent(db: &Db, scan_type: &str, limit: i64) -> VoloResult<Vec<ScanRun>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, scan_type, started_at, finished_at, machine_ids_json, summary_json
         FROM scan_runs WHERE scan_type = ? ORDER BY started_at DESC LIMIT ?",
    )?;
    let rows = stmt.query_map(params![scan_type, limit], |row| row_to_scan_run(row))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

fn row_to_scan_run(row: &rusqlite::Row) -> rusqlite::Result<ScanRun> {
    let id: i64 = row.get(0)?;
    let scan_type: String = row.get(1)?;
    let started_at: Option<String> = row.get(2)?;
    let finished_at: Option<String> = row.get(3)?;
    let ids_json: String = row.get(4)?;
    let summary_json: Option<String> = row.get(5)?;

    let machine_ids: Vec<i64> = serde_json::from_str(&ids_json).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(
            4,
            rusqlite::types::Type::Text,
            format!("machine_ids_json parse error: {}", e).into(),
        )
    })?;

    let summary: Option<JsonValue> = match summary_json {
        Some(s) => Some(serde_json::from_str(&s).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(
                5,
                rusqlite::types::Type::Text,
                format!("summary_json parse error: {}", e).into(),
            )
        })?),
        None => None,
    };

    Ok(ScanRun {
        id: Some(id),
        scan_type,
        started_at,
        finished_at,
        machine_ids,
        summary,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::{open_in_memory, schema};

    fn setup() -> Db {
        let db = open_in_memory().unwrap();
        {
            let mut conn = db.lock().unwrap();
            schema::migrate(&mut conn).unwrap();
        }
        db
    }

    #[test]
    fn insert_returns_new_id_with_started_at() {
        let db = setup();
        let id = insert(&db, "ini", &[1, 2, 3]).unwrap();
        assert!(id > 0);
        let row = find_by_id(&db, id).unwrap().unwrap();
        assert_eq!(row.scan_type, "ini");
        assert_eq!(row.machine_ids, vec![1, 2, 3]);
        assert!(row.started_at.is_some());
        assert!(row.finished_at.is_none());
    }

    #[test]
    fn finish_updates_summary_and_finished_at() {
        let db = setup();
        let id = insert(&db, "ini", &[1]).unwrap();
        finish(
            &db,
            id,
            &serde_json::json!({"critical": 0, "warning": 1, "healthy": 4}),
        )
        .unwrap();
        let row = find_by_id(&db, id).unwrap().unwrap();
        assert!(row.finished_at.is_some());
        let summary = row.summary.as_ref().unwrap();
        assert_eq!(summary["warning"], 1);
    }

    #[test]
    fn list_recent_returns_descending() {
        let db = setup();
        let _a = insert(&db, "ini", &[1]).unwrap();
        let b = insert(&db, "health", &[1]).unwrap();
        let recent = list_recent(&db, "health", 10).unwrap();
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].id, Some(b));
    }

    #[test]
    fn list_recent_types_includes_both_ini_kinds() {
        let db = setup();
        let _a = insert(&db, "ini", &[1]).unwrap();
        let b = insert(&db, "ini_project", &[1]).unwrap();
        let _h = insert(&db, "health", &[1]).unwrap();
        let rows = list_recent_types(&db, &["ini", "ini_project"], 10).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, Some(b)); // newest first
    }
}
