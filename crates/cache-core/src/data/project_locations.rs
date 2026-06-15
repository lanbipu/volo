//! CRUD for the `project_locations` table.

use crate::data::Db;
use crate::error::{UecmError, UecmResult};
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DiscoveryStatus {
    Auto,
    ManualAlias,
    ManualPath,
}

impl DiscoveryStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            DiscoveryStatus::Auto => "auto",
            DiscoveryStatus::ManualAlias => "manual_alias",
            DiscoveryStatus::ManualPath => "manual_path",
        }
    }

    pub fn parse(value: &str) -> UecmResult<Self> {
        match value {
            "auto" => Ok(DiscoveryStatus::Auto),
            "manual_alias" => Ok(DiscoveryStatus::ManualAlias),
            "manual_path" => Ok(DiscoveryStatus::ManualPath),
            other => Err(UecmError::InvalidInput(format!(
                "unknown discovery_status: {}",
                other
            ))),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, schemars::JsonSchema)]
pub struct ProjectLocation {
    pub id: Option<i64>,
    pub project_id: i64,
    pub machine_id: i64,
    pub abs_path: String,
    pub uproject_path: String,
    pub discovery_status: DiscoveryStatus,
    pub discovered_at: Option<String>,
}

pub fn upsert(db: &Db, loc: &ProjectLocation) -> UecmResult<i64> {
    let conn = db.lock().unwrap();
    conn.execute(
        "INSERT INTO project_locations (project_id, machine_id, abs_path, uproject_path, discovery_status)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project_id, machine_id) DO UPDATE SET
            abs_path = excluded.abs_path,
            uproject_path = excluded.uproject_path,
            discovery_status = excluded.discovery_status,
            discovered_at = CURRENT_TIMESTAMP",
        params![
            loc.project_id,
            loc.machine_id,
            loc.abs_path,
            loc.uproject_path,
            loc.discovery_status.as_str(),
        ],
    )?;
    let id = conn.query_row(
        "SELECT id FROM project_locations WHERE project_id = ? AND machine_id = ?",
        params![loc.project_id, loc.machine_id],
        |row| row.get(0),
    )?;
    Ok(id)
}

pub fn list_by_project(db: &Db, project_id: i64) -> UecmResult<Vec<ProjectLocation>> {
    list_where(db, "project_id", project_id, "machine_id")
}

pub fn list_by_machine(db: &Db, machine_id: i64) -> UecmResult<Vec<ProjectLocation>> {
    list_where(db, "machine_id", machine_id, "project_id")
}

pub fn get_for_project_machine(
    db: &Db,
    project_id: i64,
    machine_id: i64,
) -> UecmResult<Option<ProjectLocation>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, project_id, machine_id, abs_path, uproject_path, discovery_status, discovered_at
         FROM project_locations WHERE project_id = ? AND machine_id = ?",
    )?;
    let mut rows = stmt.query(params![project_id, machine_id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(location_from_row(row)?))
    } else {
        Ok(None)
    }
}

pub fn delete(db: &Db, location_id: i64) -> UecmResult<()> {
    let conn = db.lock().unwrap();
    conn.execute(
        "DELETE FROM project_locations WHERE id = ?",
        params![location_id],
    )?;
    Ok(())
}

fn list_where(
    db: &Db,
    column: &'static str,
    value: i64,
    order_column: &'static str,
) -> UecmResult<Vec<ProjectLocation>> {
    let conn = db.lock().unwrap();
    let sql = format!(
        "SELECT id, project_id, machine_id, abs_path, uproject_path, discovery_status, discovered_at
         FROM project_locations WHERE {} = ? ORDER BY {}",
        column, order_column
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![value], location_from_row)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

fn location_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProjectLocation> {
    let status: String = row.get(5)?;
    let discovery_status = DiscoveryStatus::parse(&status).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(
            5,
            rusqlite::types::Type::Text,
            e.to_string().into(),
        )
    })?;
    Ok(ProjectLocation {
        id: Some(row.get(0)?),
        project_id: row.get(1)?,
        machine_id: row.get(2)?,
        abs_path: row.get(3)?,
        uproject_path: row.get(4)?,
        discovery_status,
        discovered_at: row.get(6)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::{machines, open_in_memory, projects, schema, Machine, Project};

    fn setup() -> (Db, i64, i64, i64) {
        let db = open_in_memory().unwrap();
        {
            let mut conn = db.lock().unwrap();
            schema::migrate(&mut conn).unwrap();
        }
        let m1 = machines::insert(&db, &Machine::new("RENDER-01", "1.1.1.1")).unwrap();
        let m2 = machines::insert(&db, &Machine::new("RENDER-02", "2.2.2.2")).unwrap();
        let p = Project {
            id: None,
            uproject_name: "Demo.uproject".into(),
            uproject_stem_lower: "demo".into(),
            uproject_guid: None,
            display_name: None,
            first_seen_at: None,
            last_seen_at: None,
            ue_version_major: None,
            ue_version_minor: None,
            engine_association_raw: None,
            engine_association_kind: None,
        };
        let project_id = projects::upsert(&db, &p).unwrap();
        (db, project_id, m1, m2)
    }

    fn loc(project_id: i64, machine_id: i64, root: &str) -> ProjectLocation {
        ProjectLocation {
            id: None,
            project_id,
            machine_id,
            abs_path: root.to_string(),
            uproject_path: format!("{}\\Demo.uproject", root),
            discovery_status: DiscoveryStatus::Auto,
            discovered_at: None,
        }
    }

    #[test]
    fn upsert_is_idempotent_on_project_machine_pair() {
        let (db, project_id, machine_id, _) = setup();
        let id1 = upsert(&db, &loc(project_id, machine_id, "D:\\Demo")).unwrap();
        let id2 = upsert(&db, &loc(project_id, machine_id, "E:\\Demo")).unwrap();
        assert_eq!(id1, id2);
        let got = get_for_project_machine(&db, project_id, machine_id)
            .unwrap()
            .unwrap();
        assert_eq!(got.abs_path, "E:\\Demo");
    }

    #[test]
    fn list_by_project_returns_only_that_project() {
        let (db, project_id, m1, m2) = setup();
        upsert(&db, &loc(project_id, m1, "D:\\Demo")).unwrap();
        upsert(&db, &loc(project_id, m2, "E:\\Demo")).unwrap();
        let rows = list_by_project(&db, project_id).unwrap();
        assert_eq!(rows.len(), 2);
    }

    #[test]
    fn list_by_machine_returns_only_that_machine() {
        let (db, project_id, m1, m2) = setup();
        upsert(&db, &loc(project_id, m1, "D:\\Demo")).unwrap();
        upsert(&db, &loc(project_id, m2, "E:\\Demo")).unwrap();
        let rows = list_by_machine(&db, m1).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].machine_id, m1);
    }
}
