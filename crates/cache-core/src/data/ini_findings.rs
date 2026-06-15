//! CRUD for the `ini_findings` table. Each row is a single diagnostic produced
//! by `core::ini_diagnostics`. Findings are immutable once inserted; the only
//! mutations are `mark_fixed` / `mark_skipped` which stamp a timestamp.

use crate::data::Db;
use crate::error::UecmResult;
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, schemars::JsonSchema)]
pub struct IniFinding {
    pub id: Option<i64>,
    pub scan_run_id: i64,
    pub machine_id: i64,
    pub rule_id: String,
    pub severity: String,
    pub category: String,
    pub file_path: String,
    pub section: Option<String>,
    pub key_name: Option<String>,
    pub line_number: Option<i64>,
    pub snippet_before: String,
    pub snippet_after: Option<String>,
    pub recommended_action: String,
    pub recommended_value: Option<String>,
    pub symptom: String,
    pub rationale: String,
    pub fixed_at: Option<String>,
    pub skipped_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct SeverityCounts {
    pub critical: i64,
    pub warning: i64,
    pub healthy: i64,
}

pub fn insert(db: &Db, f: &IniFinding) -> UecmResult<i64> {
    let conn = db.lock().unwrap();
    conn.execute(
        "INSERT INTO ini_findings (
            scan_run_id, machine_id, rule_id, severity, category, file_path,
            section, key_name, line_number, snippet_before, snippet_after,
            recommended_action, recommended_value, symptom, rationale
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            f.scan_run_id,
            f.machine_id,
            f.rule_id,
            f.severity,
            f.category,
            f.file_path,
            f.section,
            f.key_name,
            f.line_number,
            f.snippet_before,
            f.snippet_after,
            f.recommended_action,
            f.recommended_value,
            f.symptom,
            f.rationale,
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

fn row_to_ini_finding(row: &rusqlite::Row) -> rusqlite::Result<IniFinding> {
    Ok(IniFinding {
        id: Some(row.get(0)?),
        scan_run_id: row.get(1)?,
        machine_id: row.get(2)?,
        rule_id: row.get(3)?,
        severity: row.get(4)?,
        category: row.get(5)?,
        file_path: row.get(6)?,
        section: row.get(7)?,
        key_name: row.get(8)?,
        line_number: row.get(9)?,
        snippet_before: row.get(10)?,
        snippet_after: row.get(11)?,
        recommended_action: row.get(12)?,
        recommended_value: row.get(13)?,
        symptom: row.get(14)?,
        rationale: row.get(15)?,
        fixed_at: row.get(16)?,
        skipped_at: row.get(17)?,
    })
}

pub fn find_by_id(db: &Db, id: i64) -> UecmResult<Option<IniFinding>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, scan_run_id, machine_id, rule_id, severity, category, file_path,
                section, key_name, line_number, snippet_before, snippet_after,
                recommended_action, recommended_value, symptom, rationale,
                fixed_at, skipped_at
         FROM ini_findings WHERE id = ?",
    )?;
    let mut rows = stmt.query(params![id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(row_to_ini_finding(row)?))
    } else {
        Ok(None)
    }
}

pub fn list_for_run(db: &Db, scan_run_id: i64) -> UecmResult<Vec<IniFinding>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, scan_run_id, machine_id, rule_id, severity, category, file_path,
                section, key_name, line_number, snippet_before, snippet_after,
                recommended_action, recommended_value, symptom, rationale,
                fixed_at, skipped_at
         FROM ini_findings
         WHERE scan_run_id = ?
         ORDER BY machine_id, severity, file_path",
    )?;
    let rows = stmt.query_map(params![scan_run_id], |row| row_to_ini_finding(row))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn mark_fixed(db: &Db, id: i64) -> UecmResult<()> {
    let conn = db.lock().unwrap();
    conn.execute(
        "UPDATE ini_findings SET fixed_at = CURRENT_TIMESTAMP WHERE id = ?",
        params![id],
    )?;
    Ok(())
}

pub fn mark_skipped(db: &Db, id: i64) -> UecmResult<()> {
    let conn = db.lock().unwrap();
    conn.execute(
        "UPDATE ini_findings SET skipped_at = CURRENT_TIMESTAMP WHERE id = ?",
        params![id],
    )?;
    Ok(())
}

pub fn count_by_severity_for_machine(
    db: &Db,
    scan_run_id: i64,
    machine_id: i64,
) -> UecmResult<SeverityCounts> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT severity, COUNT(*)
         FROM ini_findings
         WHERE scan_run_id = ? AND machine_id = ? AND fixed_at IS NULL AND skipped_at IS NULL
         GROUP BY severity",
    )?;
    let rows = stmt.query_map(params![scan_run_id, machine_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?;

    let mut counts = SeverityCounts::default();
    for r in rows {
        let (severity, count) = r?;
        match severity.as_str() {
            "critical" => counts.critical = count,
            "warning" => counts.warning = count,
            "healthy" => counts.healthy = count,
            _ => {}
        }
    }
    Ok(counts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::machines::{insert as insert_machine, Machine};
    use crate::data::{open_in_memory, scan_runs, schema};

    fn setup() -> (Db, i64, i64) {
        let db = open_in_memory().unwrap();
        {
            let mut conn = db.lock().unwrap();
            schema::migrate(&mut conn).unwrap();
        }
        let machine_id = insert_machine(&db, &Machine::new("RENDER-01", "192.168.10.21")).unwrap();
        let scan_id = scan_runs::insert(&db, "ini", &[machine_id]).unwrap();
        (db, scan_id, machine_id)
    }

    fn sample(scan_id: i64, machine_id: i64) -> IniFinding {
        IniFinding {
            id: None,
            scan_run_id: scan_id,
            machine_id,
            rule_id: "R001".into(),
            severity: "critical".into(),
            category: "project".into(),
            file_path: "C:\\Project\\Config\\DefaultEngine.ini".into(),
            section: Some("/Script/UnrealEd.DerivedDataCacheSettings".into()),
            key_name: Some("Path".into()),
            line_number: Some(42),
            snippet_before: "Path=D:\\OldDDC".into(),
            snippet_after: Some("EnvPathOverride=UE-SharedDataCachePath".into()),
            recommended_action: "set".into(),
            recommended_value: Some("UE-SharedDataCachePath".into()),
            symptom: "DDC silently falls back to local".into(),
            rationale: "Hardcoded path overrides env var".into(),
            fixed_at: None,
            skipped_at: None,
        }
    }

    #[test]
    fn insert_assigns_id() {
        let (db, scan_id, machine_id) = setup();
        let f = sample(scan_id, machine_id);
        let id = insert(&db, &f).unwrap();
        assert!(id > 0);
        let found = find_by_id(&db, id).unwrap().unwrap();
        assert_eq!(found.rule_id, "R001");
        assert_eq!(found.severity, "critical");
        assert_eq!(found.id, Some(id));
    }

    #[test]
    fn list_for_run_returns_inserted_rows() {
        let (db, scan_id, machine_id) = setup();
        let f = sample(scan_id, machine_id);
        insert(&db, &f).unwrap();
        insert(&db, &f).unwrap();
        let rows = list_for_run(&db, scan_id).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].rule_id, "R001");
    }

    #[test]
    fn mark_fixed_sets_timestamp() {
        let (db, scan_id, machine_id) = setup();
        let id = insert(&db, &sample(scan_id, machine_id)).unwrap();
        let before = find_by_id(&db, id).unwrap().unwrap();
        assert!(before.fixed_at.is_none());
        mark_fixed(&db, id).unwrap();
        let after = find_by_id(&db, id).unwrap().unwrap();
        assert!(after.fixed_at.is_some());
    }

    #[test]
    fn mark_skipped_sets_timestamp() {
        let (db, scan_id, machine_id) = setup();
        let id = insert(&db, &sample(scan_id, machine_id)).unwrap();
        let before = find_by_id(&db, id).unwrap().unwrap();
        assert!(before.skipped_at.is_none());
        mark_skipped(&db, id).unwrap();
        let after = find_by_id(&db, id).unwrap().unwrap();
        assert!(after.skipped_at.is_some());
    }

    #[test]
    fn count_by_severity_for_machine_returns_critical_count() {
        let (db, scan_id, machine_id) = setup();
        // Insert 1 critical
        insert(&db, &sample(scan_id, machine_id)).unwrap();
        // Insert 1 warning
        let mut warning = sample(scan_id, machine_id);
        warning.severity = "warning".into();
        insert(&db, &warning).unwrap();

        let counts = count_by_severity_for_machine(&db, scan_id, machine_id).unwrap();
        assert_eq!(counts.critical, 1);
        assert_eq!(counts.warning, 1);
        assert_eq!(counts.healthy, 0);
    }
}
