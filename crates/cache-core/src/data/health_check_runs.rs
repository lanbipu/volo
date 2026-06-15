//! Per-machine results within a single health-check `scan_runs` session.

use crate::data::Db;
use crate::error::{UecmError, UecmResult};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, schemars::JsonSchema)]
pub struct HealthCheckRow {
    pub scan_run_id: i64,
    pub machine_id: i64,
    pub machine_results: JsonValue,
}

pub fn upsert(db: &Db, scan_run_id: i64, machine_id: i64, results: &JsonValue) -> UecmResult<()> {
    let conn = db.lock().unwrap();
    let results_json = serde_json::to_string(results)
        .map_err(|e| UecmError::OperationFailed(e.to_string()))?;
    conn.execute(
        "INSERT INTO health_check_runs (scan_run_id, machine_id, machine_results_json)
         VALUES (?, ?, ?)
         ON CONFLICT(scan_run_id, machine_id) DO UPDATE SET
             machine_results_json = excluded.machine_results_json",
        params![scan_run_id, machine_id, results_json],
    )?;
    Ok(())
}

fn row_to_health_check_row(row: &rusqlite::Row) -> rusqlite::Result<HealthCheckRow> {
    let scan_run_id: i64 = row.get(0)?;
    let machine_id: i64 = row.get(1)?;
    let results_json: String = row.get(2)?;

    let machine_results: JsonValue = serde_json::from_str(&results_json).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(
            2,
            rusqlite::types::Type::Text,
            format!("machine_results_json parse error: {}", e).into(),
        )
    })?;

    Ok(HealthCheckRow {
        scan_run_id,
        machine_id,
        machine_results,
    })
}

pub fn find(db: &Db, scan_run_id: i64, machine_id: i64) -> UecmResult<Option<HealthCheckRow>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT scan_run_id, machine_id, machine_results_json
         FROM health_check_runs
         WHERE scan_run_id = ? AND machine_id = ?",
    )?;
    let mut rows = stmt.query(params![scan_run_id, machine_id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(row_to_health_check_row(row)?))
    } else {
        Ok(None)
    }
}

pub fn list_for_run(db: &Db, scan_run_id: i64) -> UecmResult<Vec<HealthCheckRow>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT scan_run_id, machine_id, machine_results_json
         FROM health_check_runs
         WHERE scan_run_id = ?
         ORDER BY machine_id",
    )?;
    let rows =
        stmt.query_map(params![scan_run_id], |row| row_to_health_check_row(row))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::machines::{insert as insert_machine, Machine};
    use crate::data::{open_in_memory, scan_runs, schema};
    use serde_json::json;

    fn setup() -> (Db, i64, i64) {
        let db = open_in_memory().unwrap();
        {
            let mut conn = db.lock().unwrap();
            schema::migrate(&mut conn).unwrap();
        }
        let machine_id = insert_machine(&db, &Machine::new("RENDER-01", "192.168.10.21")).unwrap();
        let scan_id = scan_runs::insert(&db, "health", &[machine_id]).unwrap();
        (db, scan_id, machine_id)
    }

    #[test]
    fn upsert_inserts_on_first_call() {
        let (db, scan_id, machine_id) = setup();
        upsert(&db, scan_id, machine_id, &json!({"status": "ok"})).unwrap();
        let row = find(&db, scan_id, machine_id).unwrap().unwrap();
        assert_eq!(row.machine_results["status"], "ok");
    }

    #[test]
    fn upsert_replaces_on_second_call() {
        let (db, scan_id, machine_id) = setup();
        upsert(&db, scan_id, machine_id, &json!({"status": "warning"})).unwrap();
        upsert(&db, scan_id, machine_id, &json!({"status": "critical"})).unwrap();
        let row = find(&db, scan_id, machine_id).unwrap().unwrap();
        assert_eq!(row.machine_results["status"], "critical");
    }

    #[test]
    fn list_for_run_returns_one_row_per_machine() {
        let db = open_in_memory().unwrap();
        {
            let mut conn = db.lock().unwrap();
            schema::migrate(&mut conn).unwrap();
        }
        let machine1 =
            insert_machine(&db, &Machine::new("RENDER-01", "192.168.10.21")).unwrap();
        let machine2 =
            insert_machine(&db, &Machine::new("RENDER-02", "192.168.10.22")).unwrap();
        let scan_id = scan_runs::insert(&db, "health", &[machine1, machine2]).unwrap();

        upsert(&db, scan_id, machine1, &json!({"m": 1})).unwrap();
        upsert(&db, scan_id, machine2, &json!({"m": 2})).unwrap();

        let rows = list_for_run(&db, scan_id).unwrap();
        assert_eq!(rows.len(), 2);
    }
}
