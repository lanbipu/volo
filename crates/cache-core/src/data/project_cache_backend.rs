//! CRUD for the `project_cache_backend` table.

use crate::data::Db;
use crate::error::UecmResult;
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProjectCacheBackend {
    pub project_id: i64,
    pub machine_id: i64,
    pub backend: String,
    pub zen_endpoint_id: Option<i64>,
    pub notes: Option<String>,
    pub updated_at: Option<String>,
}

pub fn upsert(db: &Db, row: &ProjectCacheBackend) -> UecmResult<i64> {
    let conn = db.lock().unwrap();
    conn.execute(
        "INSERT INTO project_cache_backend (
            project_id, machine_id, backend, zen_endpoint_id, notes, updated_at
         )
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(project_id, machine_id) DO UPDATE SET
            backend = excluded.backend,
            zen_endpoint_id = excluded.zen_endpoint_id,
            notes = excluded.notes,
            updated_at = CURRENT_TIMESTAMP",
        params![
            row.project_id,
            row.machine_id,
            row.backend,
            row.zen_endpoint_id,
            row.notes,
        ],
    )?;
    Ok(conn.changes() as i64)
}

pub fn list(db: &Db) -> UecmResult<Vec<ProjectCacheBackend>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT project_id, machine_id, backend, zen_endpoint_id, notes, updated_at
         FROM project_cache_backend
         ORDER BY project_id ASC, machine_id ASC",
    )?;
    let rows = stmt.query_map([], project_cache_backend_from_row)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub fn find(
    db: &Db,
    project_id: i64,
    machine_id: i64,
) -> UecmResult<Option<ProjectCacheBackend>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT project_id, machine_id, backend, zen_endpoint_id, notes, updated_at
         FROM project_cache_backend WHERE project_id = ? AND machine_id = ?",
    )?;
    let mut rows = stmt.query(params![project_id, machine_id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(project_cache_backend_from_row(row)?))
    } else {
        Ok(None)
    }
}

pub fn delete(db: &Db, project_id: i64, machine_id: i64) -> UecmResult<()> {
    let conn = db.lock().unwrap();
    conn.execute(
        "DELETE FROM project_cache_backend WHERE project_id = ? AND machine_id = ?",
        params![project_id, machine_id],
    )?;
    Ok(())
}

fn project_cache_backend_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<ProjectCacheBackend> {
    Ok(ProjectCacheBackend {
        project_id: row.get(0)?,
        machine_id: row.get(1)?,
        backend: row.get(2)?,
        zen_endpoint_id: row.get(3)?,
        notes: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::{machines, open_in_memory, projects, schema, Machine};

    fn setup() -> (Db, i64, i64) {
        let db = open_in_memory().unwrap();
        {
            let mut conn = db.lock().unwrap();
            schema::migrate(&mut conn).unwrap();
        }
        let machine_id = machines::insert(&db, &Machine::new("RENDER-01", "192.168.10.21")).unwrap();
        let project_id = projects::upsert(
            &db,
            &projects::Project {
                id: None,
                uproject_name: "Demo.uproject".into(),
                uproject_stem_lower: "demo".into(),
                uproject_guid: None,
                display_name: None,
                first_seen_at: None,
                last_seen_at: None,
                ue_version_major: Some(5),
                ue_version_minor: Some(7),
                engine_association_raw: Some("5.7".into()),
                engine_association_kind: Some("version".into()),
            },
        )
        .unwrap();
        (db, project_id, machine_id)
    }

    fn sample(project_id: i64, machine_id: i64, backend: &str) -> ProjectCacheBackend {
        ProjectCacheBackend {
            project_id,
            machine_id,
            backend: backend.into(),
            zen_endpoint_id: None,
            notes: None,
            updated_at: None,
        }
    }

    #[test]
    fn upsert_inserts_when_new() {
        let (db, project_id, machine_id) = setup();
        upsert(&db, &sample(project_id, machine_id, "legacy")).unwrap();
        let got = find(&db, project_id, machine_id).unwrap().unwrap();
        assert_eq!(got.backend, "legacy");
    }

    #[test]
    fn upsert_updates_when_pk_exists() {
        let (db, project_id, machine_id) = setup();
        upsert(&db, &sample(project_id, machine_id, "legacy")).unwrap();
        let mut row = sample(project_id, machine_id, "zen");
        row.notes = Some("switched to zen".into());
        upsert(&db, &row).unwrap();
        let got = find(&db, project_id, machine_id).unwrap().unwrap();
        assert_eq!(got.backend, "zen");
        assert_eq!(got.notes.as_deref(), Some("switched to zen"));
    }

    #[test]
    fn upsert_different_machine_creates_new_row() {
        let (db, project_id, machine_id) = setup();
        let other_machine = machines::insert(&db, &Machine::new("RENDER-02", "192.168.10.22")).unwrap();
        upsert(&db, &sample(project_id, machine_id, "legacy")).unwrap();
        upsert(&db, &sample(project_id, other_machine, "zen")).unwrap();
        let rows = list(&db).unwrap();
        assert_eq!(rows.len(), 2);
    }

    #[test]
    fn find_returns_none_when_missing() {
        let (db, project_id, machine_id) = setup();
        assert!(find(&db, project_id, machine_id).unwrap().is_none());
    }

    #[test]
    fn list_orders_by_project_then_machine() {
        let (db, project_id, machine_id) = setup();
        let other_machine = machines::insert(&db, &Machine::new("RENDER-02", "192.168.10.22")).unwrap();
        upsert(&db, &sample(project_id, other_machine, "zen")).unwrap();
        upsert(&db, &sample(project_id, machine_id, "legacy")).unwrap();
        let rows = list(&db).unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows[0].machine_id <= rows[1].machine_id);
    }

    #[test]
    fn delete_removes_row() {
        let (db, project_id, machine_id) = setup();
        upsert(&db, &sample(project_id, machine_id, "legacy")).unwrap();
        delete(&db, project_id, machine_id).unwrap();
        assert!(find(&db, project_id, machine_id).unwrap().is_none());
    }
}
