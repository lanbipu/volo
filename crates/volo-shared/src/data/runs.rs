use crate::dto::ReconstructionRun;
use crate::error::VoloResult;
use rusqlite::{params, Connection};

pub struct NewRun {
    pub project_path: String,
    pub screen_id: String,
    pub measurements_path: String,
    pub method: String,
    pub measured_count: usize,
    pub expected_count: usize,
    /// FIX-12: 真实拟合残差统计;不可计算(精确插值无 holdout)= None → DB NULL。
    pub estimated_rms_mm: Option<f64>,
    pub estimated_p95_mm: Option<f64>,
    pub vertex_count: usize,
    pub report_json_path: String,
    pub warnings_json: String,
}

pub fn insert(conn: &Connection, run: &NewRun) -> VoloResult<i64> {
    conn.execute(
        "INSERT INTO reconstruction_runs(
            project_path, screen_id, measurements_path, method,
            measured_count, expected_count, estimated_rms_mm, estimated_p95_mm,
            vertex_count, report_json_path, warnings_json
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
        params![
            run.project_path,
            run.screen_id,
            run.measurements_path,
            run.method,
            run.measured_count as i64,
            run.expected_count as i64,
            run.estimated_rms_mm,
            run.estimated_p95_mm,
            run.vertex_count as i64,
            run.report_json_path,
            run.warnings_json,
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn update_export(
    conn: &Connection,
    run_id: i64,
    target: &str,
    output_obj_path: &str,
) -> VoloResult<()> {
    let n = conn.execute(
        "UPDATE reconstruction_runs
         SET target = ?1, output_obj_path = ?2
         WHERE id = ?3",
        params![target, output_obj_path, run_id],
    )?;
    if n == 0 {
        return Err(crate::error::VoloError::NotFound(format!("run id {run_id}")));
    }
    Ok(())
}

pub fn list_by_project(
    conn: &Connection,
    project_path: &str,
    screen_id: Option<&str>,
) -> VoloResult<Vec<ReconstructionRun>> {
    let mut sql = String::from(
        "SELECT id, screen_id, method, estimated_rms_mm, vertex_count, target, output_obj_path, created_at, is_current
         FROM reconstruction_runs WHERE project_path = ?1",
    );
    if screen_id.is_some() {
        sql.push_str(" AND screen_id = ?2");
    }
    sql.push_str(" ORDER BY created_at DESC");
    let mut stmt = conn.prepare(&sql)?;
    let map = |r: &rusqlite::Row<'_>| {
        Ok(ReconstructionRun {
            id: r.get(0)?,
            screen_id: r.get(1)?,
            method: r.get(2)?,
            estimated_rms_mm: r.get(3)?,
            vertex_count: r.get(4)?,
            target: r.get(5)?,
            output_obj_path: r.get(6)?,
            created_at: r.get(7)?,
            is_current: r.get::<_, i64>(8)? != 0,
        })
    };
    let rows: Vec<_> = if let Some(s) = screen_id {
        stmt.query_map(params![project_path, s], map)?
            .collect::<rusqlite::Result<Vec<_>>>()?
    } else {
        stmt.query_map(params![project_path], map)?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    Ok(rows)
}

/// Pin `run_id` as the current run for its (project_path, screen_id) pair,
/// unpinning any other run in that same scope.
pub fn set_current(conn: &Connection, run_id: i64) -> VoloResult<()> {
    let (project_path, screen_id): (String, String) = conn
        .query_row(
            "SELECT project_path, screen_id FROM reconstruction_runs WHERE id = ?1",
            [run_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| crate::error::VoloError::NotFound(format!("run id {run_id}")))?;
    conn.execute(
        "UPDATE reconstruction_runs SET is_current = 0 WHERE project_path = ?1 AND screen_id = ?2",
        params![project_path, screen_id],
    )?;
    conn.execute(
        "UPDATE reconstruction_runs SET is_current = 1 WHERE id = ?1",
        params![run_id],
    )?;
    Ok(())
}

pub fn get_report_path(conn: &Connection, run_id: i64) -> VoloResult<(String, String)> {
    conn.query_row(
        "SELECT project_path, report_json_path FROM reconstruction_runs WHERE id = ?1",
        [run_id],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
    )
    .map_err(|_| crate::error::VoloError::NotFound(format!("run id {run_id}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::{open_in_memory, schema};

    #[test]
    fn insert_list_update() {
        let db = open_in_memory().unwrap();
        {
            let mut conn = db.lock().unwrap();
            schema::migrate(&mut conn).unwrap();
        }
        let conn = db.lock().unwrap();
        let id = insert(
            &conn,
            &NewRun {
                project_path: "/p".into(),
                screen_id: "MAIN".into(),
                measurements_path: "measurements/m.yaml".into(),
                method: "direct_link".into(),
                measured_count: 100,
                expected_count: 100,
                estimated_rms_mm: Some(1.5),
                estimated_p95_mm: Some(3.0),
                vertex_count: 200,
                report_json_path: "reports/r.json".into(),
                warnings_json: "[]".into(),
            },
        )
        .unwrap();
        let runs = list_by_project(&conn, "/p", None).unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].method, "direct_link");
        assert!(runs[0].output_obj_path.is_none());

        update_export(&conn, id, "disguise", "output/foo.obj").unwrap();
        let runs = list_by_project(&conn, "/p", Some("MAIN")).unwrap();
        assert_eq!(runs[0].target.as_deref(), Some("disguise"));
        assert_eq!(runs[0].output_obj_path.as_deref(), Some("output/foo.obj"));
    }

    #[test]
    fn update_export_not_found() {
        let db = open_in_memory().unwrap();
        {
            let mut conn = db.lock().unwrap();
            schema::migrate(&mut conn).unwrap();
        }
        let conn = db.lock().unwrap();
        let err = update_export(&conn, 9999, "disguise", "x.obj").unwrap_err();
        assert!(matches!(err, crate::error::VoloError::NotFound(_)));
    }

    #[test]
    fn set_current_pins_one_run_per_screen() {
        let db = open_in_memory().unwrap();
        {
            let mut conn = db.lock().unwrap();
            schema::migrate(&mut conn).unwrap();
        }
        let conn = db.lock().unwrap();
        let new_run = |screen: &str| NewRun {
            project_path: "/p".into(),
            screen_id: screen.into(),
            measurements_path: "m.yaml".into(),
            method: "direct_link".into(),
            measured_count: 10,
            expected_count: 10,
            estimated_rms_mm: Some(1.0),
            estimated_p95_mm: Some(2.0),
            vertex_count: 20,
            report_json_path: "r.json".into(),
            warnings_json: "[]".into(),
        };
        let a = insert(&conn, &new_run("MAIN")).unwrap();
        let b = insert(&conn, &new_run("MAIN")).unwrap();
        let other_screen = insert(&conn, &new_run("CEIL")).unwrap();

        set_current(&conn, a).unwrap();
        let runs = list_by_project(&conn, "/p", Some("MAIN")).unwrap();
        assert!(runs.iter().find(|r| r.id == a).unwrap().is_current);
        assert!(!runs.iter().find(|r| r.id == b).unwrap().is_current);

        // Pinning b unpins a, but never touches the other screen's run.
        set_current(&conn, b).unwrap();
        let runs = list_by_project(&conn, "/p", Some("MAIN")).unwrap();
        assert!(!runs.iter().find(|r| r.id == a).unwrap().is_current);
        assert!(runs.iter().find(|r| r.id == b).unwrap().is_current);
        let ceil_runs = list_by_project(&conn, "/p", Some("CEIL")).unwrap();
        assert!(!ceil_runs.iter().find(|r| r.id == other_screen).unwrap().is_current);
    }

    #[test]
    fn set_current_missing_run() {
        let db = open_in_memory().unwrap();
        {
            let mut conn = db.lock().unwrap();
            schema::migrate(&mut conn).unwrap();
        }
        let conn = db.lock().unwrap();
        let err = set_current(&conn, 9999).unwrap_err();
        assert!(matches!(err, crate::error::VoloError::NotFound(_)));
    }

    #[test]
    fn get_report_path_ok_and_missing() {
        let db = open_in_memory().unwrap();
        {
            let mut conn = db.lock().unwrap();
            schema::migrate(&mut conn).unwrap();
        }
        let conn = db.lock().unwrap();
        let id = insert(
            &conn,
            &NewRun {
                project_path: "/proj".into(),
                screen_id: "S1".into(),
                measurements_path: "m.yaml".into(),
                method: "direct_link".into(),
                measured_count: 10,
                expected_count: 10,
                estimated_rms_mm: Some(0.5),
                estimated_p95_mm: Some(1.0),
                vertex_count: 50,
                report_json_path: "reports/rep.json".into(),
                warnings_json: "[]".into(),
            },
        )
        .unwrap();
        let (proj, report) = get_report_path(&conn, id).unwrap();
        assert_eq!(proj, "/proj");
        assert_eq!(report, "reports/rep.json");

        let err = get_report_path(&conn, 9999).unwrap_err();
        assert!(matches!(err, crate::error::VoloError::NotFound(_)));
    }
}
