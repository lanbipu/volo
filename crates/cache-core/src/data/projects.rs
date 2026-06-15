//! CRUD for the `projects` table.

use crate::data::Db;
use crate::error::UecmResult;
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, schemars::JsonSchema)]
pub struct Project {
    pub id: Option<i64>,
    pub uproject_name: String,
    pub uproject_stem_lower: String,
    pub uproject_guid: Option<String>,
    pub display_name: Option<String>,
    pub first_seen_at: Option<String>,
    pub last_seen_at: Option<String>,
    /// Parsed major version from `.uproject` EngineAssociation, when the
    /// association is in `"5.7"` / `"5.7.0"` form. `None` for guid/empty/
    /// unknown — downstream backend routing treats `None` as "force legacy".
    pub ue_version_major: Option<i64>,
    pub ue_version_minor: Option<i64>,
    /// EngineAssociation string as it appears in the `.uproject`, preserved
    /// verbatim for audit even when we cannot map it to a version.
    pub engine_association_raw: Option<String>,
    /// Classification of `engine_association_raw`: "version" | "guid" |
    /// "empty" | "unknown". See `core::project_identity::parse_engine_association`.
    pub engine_association_kind: Option<String>,
}

pub fn upsert(db: &Db, project: &Project) -> UecmResult<i64> {
    let conn = db.lock().unwrap();
    conn.execute(
        "INSERT INTO projects (
            uproject_name,
            uproject_stem_lower,
            uproject_guid,
            display_name,
            ue_version_major,
            ue_version_minor,
            engine_association_raw,
            engine_association_kind,
            last_seen_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(uproject_stem_lower) DO UPDATE SET
            uproject_name = excluded.uproject_name,
            uproject_guid = COALESCE(excluded.uproject_guid, projects.uproject_guid),
            display_name = COALESCE(excluded.display_name, projects.display_name),
            ue_version_major = excluded.ue_version_major,
            ue_version_minor = excluded.ue_version_minor,
            engine_association_raw = excluded.engine_association_raw,
            engine_association_kind = excluded.engine_association_kind,
            last_seen_at = CURRENT_TIMESTAMP",
        params![
            project.uproject_name,
            project.uproject_stem_lower,
            project.uproject_guid,
            project.display_name,
            project.ue_version_major,
            project.ue_version_minor,
            project.engine_association_raw,
            project.engine_association_kind,
        ],
    )?;
    let id = conn.query_row(
        "SELECT id FROM projects WHERE uproject_stem_lower = ?",
        params![project.uproject_stem_lower],
        |row| row.get(0),
    )?;
    Ok(id)
}

pub fn list(db: &Db) -> UecmResult<Vec<Project>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, uproject_name, uproject_stem_lower, uproject_guid, display_name,
                first_seen_at, last_seen_at,
                ue_version_major, ue_version_minor,
                engine_association_raw, engine_association_kind
         FROM projects ORDER BY uproject_name",
    )?;
    let rows = stmt.query_map([], project_from_row)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub fn get(db: &Db, project_id: i64) -> UecmResult<Option<Project>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, uproject_name, uproject_stem_lower, uproject_guid, display_name,
                first_seen_at, last_seen_at,
                ue_version_major, ue_version_minor,
                engine_association_raw, engine_association_kind
         FROM projects WHERE id = ?",
    )?;
    let mut rows = stmt.query(params![project_id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(project_from_row(row)?))
    } else {
        Ok(None)
    }
}

pub fn delete(db: &Db, project_id: i64) -> UecmResult<()> {
    let conn = db.lock().unwrap();
    conn.execute("DELETE FROM projects WHERE id = ?", params![project_id])?;
    Ok(())
}

fn project_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Project> {
    Ok(Project {
        id: Some(row.get(0)?),
        uproject_name: row.get(1)?,
        uproject_stem_lower: row.get(2)?,
        uproject_guid: row.get(3)?,
        display_name: row.get(4)?,
        first_seen_at: row.get(5)?,
        last_seen_at: row.get(6)?,
        ue_version_major: row.get(7)?,
        ue_version_minor: row.get(8)?,
        engine_association_raw: row.get(9)?,
        engine_association_kind: row.get(10)?,
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

    fn sample(name: &str, stem: &str) -> Project {
        Project {
            id: None,
            uproject_name: name.to_string(),
            uproject_stem_lower: stem.to_string(),
            uproject_guid: None,
            display_name: None,
            first_seen_at: None,
            last_seen_at: None,
            ue_version_major: None,
            ue_version_minor: None,
            engine_association_raw: None,
            engine_association_kind: None,
        }
    }

    #[test]
    fn upsert_creates_then_updates() {
        let db = setup();
        let id1 = upsert(&db, &sample("Plurality.uproject", "plurality")).unwrap();
        let id2 = upsert(&db, &sample("PluralityRenamed.uproject", "plurality")).unwrap();
        assert_eq!(id1, id2);
        let got = get(&db, id1).unwrap().unwrap();
        assert_eq!(got.uproject_name, "PluralityRenamed.uproject");
    }

    #[test]
    fn list_orders_by_name() {
        let db = setup();
        upsert(&db, &sample("B.uproject", "b")).unwrap();
        upsert(&db, &sample("A.uproject", "a")).unwrap();
        let rows = list(&db).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].uproject_name, "A.uproject");
    }

    #[test]
    fn delete_removes_project() {
        let db = setup();
        let id = upsert(&db, &sample("A.uproject", "a")).unwrap();
        delete(&db, id).unwrap();
        assert!(get(&db, id).unwrap().is_none());
    }

    #[test]
    fn upsert_persists_engine_association_fields() {
        let db = setup();
        let mut p = sample("Demo.uproject", "demo");
        p.ue_version_major = Some(5);
        p.ue_version_minor = Some(7);
        p.engine_association_raw = Some("5.7".into());
        p.engine_association_kind = Some("version".into());
        let id = upsert(&db, &p).unwrap();
        let got = get(&db, id).unwrap().unwrap();
        assert_eq!(got.ue_version_major, Some(5));
        assert_eq!(got.ue_version_minor, Some(7));
        assert_eq!(got.engine_association_raw.as_deref(), Some("5.7"));
        assert_eq!(got.engine_association_kind.as_deref(), Some("version"));
    }

    #[test]
    fn upsert_rediscovery_refreshes_engine_association_atomically() {
        // EngineAssociation can legitimately change between discoveries (operator
        // re-points a project at a custom build, swaps to a new UE major, etc.).
        // The four derived fields must move as a unit so backend routing never
        // sees a stale kind/version mismatch (plan §1.3 / §4.2).
        let db = setup();
        let mut first = sample("Demo.uproject", "demo");
        first.ue_version_major = Some(5);
        first.ue_version_minor = Some(7);
        first.engine_association_raw = Some("5.7".into());
        first.engine_association_kind = Some("version".into());
        let id = upsert(&db, &first).unwrap();

        let mut second = sample("Demo.uproject", "demo");
        second.engine_association_raw = Some("{8B3F8B3F-1234-5678-90AB-CDEF12345678}".into());
        second.engine_association_kind = Some("guid".into());
        upsert(&db, &second).unwrap();

        let got = get(&db, id).unwrap().unwrap();
        assert_eq!(got.ue_version_major, None);
        assert_eq!(got.ue_version_minor, None);
        assert_eq!(
            got.engine_association_raw.as_deref(),
            Some("{8B3F8B3F-1234-5678-90AB-CDEF12345678}")
        );
        assert_eq!(got.engine_association_kind.as_deref(), Some("guid"));
    }
}
