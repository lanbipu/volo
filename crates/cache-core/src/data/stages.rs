//! Stage ownership of Cache machines and UE projects (migration 037).
//!
//! The Stage document is the Calibrate `project.yaml` (portable, keyed by its
//! `stage_id` UUID). The cache DB does not store Stages — it only records which
//! of its machines / UE projects belong to which `stage_id`. Many-to-many: one
//! machine (e.g. the shared DDC server) may belong to several Stages.

use crate::data::Db;
use crate::error::{VoloError, VoloResult};
use rusqlite::params;
use serde::Serialize;

/// Everything the cache DB knows about one Stage.
#[derive(Debug, Clone, Default, Serialize, PartialEq, schemars::JsonSchema)]
pub struct StageMembership {
    pub stage_id: String,
    pub machine_ids: Vec<i64>,
    pub project_ids: Vec<i64>,
}

fn check_stage_id(stage_id: &str) -> VoloResult<&str> {
    let s = stage_id.trim();
    if s.is_empty() {
        return Err(VoloError::InvalidInput("stage_id must not be empty".into()));
    }
    Ok(s)
}

fn ensure_exists(conn: &rusqlite::Connection, table: &str, id: i64) -> VoloResult<()> {
    let found: bool = conn
        .query_row(&format!("SELECT 1 FROM {table} WHERE id = ?"), params![id], |_| Ok(true))
        .unwrap_or(false);
    if !found {
        let what = if table == "machines" { "machine" } else { "project" };
        return Err(VoloError::InvalidInput(format!("{what} {id} not found")));
    }
    Ok(())
}

fn ids(conn: &rusqlite::Connection, sql: &str, arg: &dyn rusqlite::ToSql) -> VoloResult<Vec<i64>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([arg], |r| r.get::<_, i64>(0))?;
    Ok(rows.collect::<Result<Vec<i64>, rusqlite::Error>>()?)
}

fn strings(conn: &rusqlite::Connection, sql: &str, id: i64) -> VoloResult<Vec<String>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(params![id], |r| r.get::<_, String>(0))?;
    Ok(rows.collect::<Result<Vec<String>, rusqlite::Error>>()?)
}

/// Attach a machine to a Stage. Idempotent.
pub fn assign_machine(db: &Db, stage_id: &str, machine_id: i64) -> VoloResult<()> {
    let stage_id = check_stage_id(stage_id)?;
    let conn = db.lock().unwrap();
    ensure_exists(&conn, "machines", machine_id)?;
    conn.execute(
        "INSERT OR IGNORE INTO stage_machines (stage_id, machine_id) VALUES (?, ?)",
        params![stage_id, machine_id],
    )?;
    Ok(())
}

/// Detach a machine from a Stage. No-op when it wasn't attached.
pub fn unassign_machine(db: &Db, stage_id: &str, machine_id: i64) -> VoloResult<()> {
    let stage_id = check_stage_id(stage_id)?;
    let conn = db.lock().unwrap();
    conn.execute(
        "DELETE FROM stage_machines WHERE stage_id = ? AND machine_id = ?",
        params![stage_id, machine_id],
    )?;
    Ok(())
}

/// Attach a UE project (cache `projects.id`) to a Stage. Idempotent.
pub fn assign_project(db: &Db, stage_id: &str, project_id: i64) -> VoloResult<()> {
    let stage_id = check_stage_id(stage_id)?;
    let conn = db.lock().unwrap();
    ensure_exists(&conn, "projects", project_id)?;
    conn.execute(
        "INSERT OR IGNORE INTO stage_projects (stage_id, project_id) VALUES (?, ?)",
        params![stage_id, project_id],
    )?;
    Ok(())
}

/// Detach a UE project from a Stage. No-op when it wasn't attached.
pub fn unassign_project(db: &Db, stage_id: &str, project_id: i64) -> VoloResult<()> {
    let stage_id = check_stage_id(stage_id)?;
    let conn = db.lock().unwrap();
    conn.execute(
        "DELETE FROM stage_projects WHERE stage_id = ? AND project_id = ?",
        params![stage_id, project_id],
    )?;
    Ok(())
}

/// Machines and UE projects owned by `stage_id` (ascending ids).
pub fn membership(db: &Db, stage_id: &str) -> VoloResult<StageMembership> {
    let stage_id = check_stage_id(stage_id)?;
    let conn = db.lock().unwrap();
    Ok(StageMembership {
        stage_id: stage_id.to_string(),
        machine_ids: ids(
            &conn,
            "SELECT machine_id FROM stage_machines WHERE stage_id = ? ORDER BY machine_id",
            &stage_id,
        )?,
        project_ids: ids(
            &conn,
            "SELECT project_id FROM stage_projects WHERE stage_id = ? ORDER BY project_id",
            &stage_id,
        )?,
    })
}

/// Every Stage a machine belongs to.
pub fn stages_for_machine(db: &Db, machine_id: i64) -> VoloResult<Vec<String>> {
    let conn = db.lock().unwrap();
    strings(
        &conn,
        "SELECT stage_id FROM stage_machines WHERE machine_id = ? ORDER BY stage_id",
        machine_id,
    )
}

/// Every Stage a UE project belongs to.
pub fn stages_for_project(db: &Db, project_id: i64) -> VoloResult<Vec<String>> {
    let conn = db.lock().unwrap();
    strings(
        &conn,
        "SELECT stage_id FROM stage_projects WHERE project_id = ? ORDER BY stage_id",
        project_id,
    )
}

/// Drop all ownership rows for a Stage (e.g. the project folder was deleted).
/// Machines / projects themselves are untouched.
pub fn forget_stage(db: &Db, stage_id: &str) -> VoloResult<()> {
    let stage_id = check_stage_id(stage_id)?;
    let conn = db.lock().unwrap();
    conn.execute("DELETE FROM stage_machines WHERE stage_id = ?", params![stage_id])?;
    conn.execute("DELETE FROM stage_projects WHERE stage_id = ?", params![stage_id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::{machines, open_in_memory, schema, Machine};

    fn setup() -> Db {
        let db = open_in_memory().unwrap();
        schema::migrate(&mut db.lock().unwrap()).unwrap();
        db
    }

    fn project(db: &Db, stem: &str) -> i64 {
        let conn = db.lock().unwrap();
        conn.execute(
            "INSERT INTO projects (uproject_name, uproject_stem_lower) VALUES (?, ?)",
            params![stem, stem],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    #[test]
    fn machine_can_belong_to_several_stages() {
        let db = setup();
        let ddc = machines::insert(&db, &Machine::new("lanPC", "192.168.10.20")).unwrap();
        let rn = machines::insert(&db, &Machine::new("RN01", "192.168.10.21")).unwrap();
        assign_machine(&db, "stage-a", ddc).unwrap();
        assign_machine(&db, "stage-a", rn).unwrap();
        assign_machine(&db, "stage-a", rn).unwrap(); // idempotent
        assign_machine(&db, "stage-b", ddc).unwrap();

        assert_eq!(membership(&db, "stage-a").unwrap().machine_ids, vec![ddc, rn]);
        assert_eq!(membership(&db, "stage-b").unwrap().machine_ids, vec![ddc]);
        assert_eq!(stages_for_machine(&db, ddc).unwrap(), vec!["stage-a", "stage-b"]);

        unassign_machine(&db, "stage-a", ddc).unwrap();
        assert_eq!(stages_for_machine(&db, ddc).unwrap(), vec!["stage-b"]);
    }

    #[test]
    fn projects_assign_and_forget() {
        let db = setup();
        let p = project(&db, "vpstage");
        assign_project(&db, "stage-a", p).unwrap();
        assert_eq!(membership(&db, "stage-a").unwrap().project_ids, vec![p]);
        assert_eq!(stages_for_project(&db, p).unwrap(), vec!["stage-a"]);
        unassign_project(&db, "stage-a", p).unwrap();
        assert!(stages_for_project(&db, p).unwrap().is_empty());

        assign_project(&db, "stage-a", p).unwrap();
        forget_stage(&db, "stage-a").unwrap();
        assert_eq!(membership(&db, "stage-a").unwrap(), StageMembership {
            stage_id: "stage-a".into(),
            ..Default::default()
        });
    }

    #[test]
    fn rejects_unknown_ids_and_empty_stage() {
        let db = setup();
        assert!(matches!(assign_machine(&db, "s", 999), Err(VoloError::InvalidInput(_))));
        assert!(matches!(assign_project(&db, "s", 999), Err(VoloError::InvalidInput(_))));
        let m = machines::insert(&db, &Machine::new("RN", "10.0.0.9")).unwrap();
        assert!(matches!(assign_machine(&db, "  ", m), Err(VoloError::InvalidInput(_))));
    }

    #[test]
    fn deleting_machine_cascades_membership() {
        let db = setup();
        let m = machines::insert(&db, &Machine::new("RN", "10.0.0.9")).unwrap();
        assign_machine(&db, "s", m).unwrap();
        machines::delete(&db, m).unwrap();
        assert!(membership(&db, "s").unwrap().machine_ids.is_empty());
    }
}
