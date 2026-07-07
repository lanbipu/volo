//! CRUD for the `pso_warmup_runs` table (per-node warm-up & verification runs).

use crate::data::Db;
use crate::error::VoloResult;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum WarmupStatus {
    Running,
    /// Both phases ran to planned completion AND the verify phase counted
    /// zero hitches. Only this status is green-light eligible.
    Ok,
    Err,
    /// Stopped early by an operator cancel — the node was NOT verified.
    Cancelled,
    /// Verify phase ran to planned completion but still counted hitches:
    /// the run finished cleanly yet the node is NOT ready (distinct from
    /// Err = the run itself broke).
    #[serde(rename = "not_ready")]
    NotReady,
}

impl WarmupStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            WarmupStatus::Running => "running",
            WarmupStatus::Ok => "ok",
            WarmupStatus::Err => "err",
            WarmupStatus::Cancelled => "cancelled",
            WarmupStatus::NotReady => "not_ready",
        }
    }

    fn from_str(raw: &str) -> Self {
        match raw {
            "ok" => WarmupStatus::Ok,
            "err" => WarmupStatus::Err,
            "cancelled" => WarmupStatus::Cancelled,
            "not_ready" => WarmupStatus::NotReady,
            _ => WarmupStatus::Running,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, schemars::JsonSchema)]
pub struct PsoWarmupRun {
    pub id: Option<i64>,
    pub project_id: i64,
    pub machine_id: i64,
    pub resolution_w: i64,
    pub resolution_h: i64,
    pub max_minutes: i64,
    pub mode: String,
    pub dc_node: Option<String>,
    pub driver_cache_growth_bytes: Option<i64>,
    /// Prerun-phase hitches (absorption count, informational).
    /// None while running; Some(n) once finished.
    pub hitch_count: Option<i64>,
    /// Verify-phase hitches — the green-light basis (0 = ready).
    /// None while running or when the run never reached the verify phase.
    pub verify_hitch_count: Option<i64>,
    pub verify_duration_secs: Option<i64>,
    /// 是否启用了 RC 遍历（驱动舞台扫场）。
    pub traversal: bool,
    /// 预跑段是否以收敛提前完成（None = 未启用遍历或无采样结论）。
    pub converged: Option<bool>,
    pub status: WarmupStatus,
    pub error_message: Option<String>,
    pub started_at: Option<String>,
    pub duration_secs: Option<i64>,
}

#[allow(clippy::too_many_arguments)]
pub fn insert_started(
    db: &Db,
    project_id: i64,
    machine_id: i64,
    resolution: (u32, u32),
    max_minutes: u32,
    mode: &str,
    dc_node: Option<&str>,
    traversal: bool,
) -> VoloResult<i64> {
    let conn = db.lock().unwrap();
    conn.execute(
        "INSERT INTO pso_warmup_runs
         (project_id, machine_id, resolution_w, resolution_h, max_minutes, mode, dc_node, traversal, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running')",
        rusqlite::params![
            project_id,
            machine_id,
            resolution.0 as i64,
            resolution.1 as i64,
            max_minutes as i64,
            mode,
            dc_node,
            traversal as i64,
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

/// 遍历收敛结论（预跑段结束后写入；未启用遍历的 run 保持 NULL）。
pub fn record_convergence(db: &Db, run_id: i64, converged: bool) -> VoloResult<()> {
    let conn = db.lock().unwrap();
    conn.execute(
        "UPDATE pso_warmup_runs SET converged = ? WHERE id = ?",
        rusqlite::params![converged as i64, run_id],
    )?;
    Ok(())
}

pub fn finish(
    db: &Db,
    run_id: i64,
    status: WarmupStatus,
    hitch_count: Option<i64>,
    error_message: Option<&str>,
    duration_secs: i64,
    driver_cache_growth_bytes: Option<i64>,
) -> VoloResult<()> {
    let conn = db.lock().unwrap();
    conn.execute(
        "UPDATE pso_warmup_runs
         SET status = ?, hitch_count = ?, error_message = ?, duration_secs = ?,
             driver_cache_growth_bytes = ?
         WHERE id = ?",
        rusqlite::params![
            status.as_str(),
            hitch_count,
            error_message,
            duration_secs,
            driver_cache_growth_bytes,
            run_id,
        ],
    )?;
    Ok(())
}

/// Verify-phase results are written before `finish` so a terminal row always
/// carries both phases; a run that never reaches verify simply keeps NULLs.
pub fn record_verify_phase(
    db: &Db,
    run_id: i64,
    verify_hitch_count: i64,
    verify_duration_secs: i64,
) -> VoloResult<()> {
    let conn = db.lock().unwrap();
    conn.execute(
        "UPDATE pso_warmup_runs
         SET verify_hitch_count = ?, verify_duration_secs = ?
         WHERE id = ?",
        rusqlite::params![verify_hitch_count, verify_duration_secs, run_id],
    )?;
    Ok(())
}

/// Lazy reaper: rows stuck at 'running' past their planned window (watchdog
/// max_minutes + 30min grace) can only mean the supervising process died
/// (app quit / crash / reboot) — mark them err so they never read as in-flight
/// forever. Called from the list paths (UI command + CLI) before querying.
pub fn reap_overdue(db: &Db) -> VoloResult<usize> {
    let conn = db.lock().unwrap();
    let changed = conn.execute(
        "UPDATE pso_warmup_runs
         SET status = 'err',
             error_message = 'orphaned: still running past planned duration (supervisor exited?)'
         WHERE status = 'running'
           AND datetime(started_at, printf('+%d minutes', max_minutes + 30)) < datetime('now')",
        [],
    )?;
    Ok(changed)
}

pub fn list_by_project(
    db: &Db,
    project_id: i64,
    machine_id: Option<i64>,
) -> VoloResult<Vec<PsoWarmupRun>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, project_id, machine_id, resolution_w, resolution_h, max_minutes,
                mode, dc_node, driver_cache_growth_bytes,
                hitch_count, status, error_message, started_at, duration_secs,
                verify_hitch_count, verify_duration_secs, traversal, converged
         FROM pso_warmup_runs
         WHERE project_id = ? AND (?2 IS NULL OR machine_id = ?2)
         ORDER BY started_at DESC, id DESC",
    )?;
    let rows = stmt.query_map(rusqlite::params![project_id, machine_id], row_to_run)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

fn row_to_run(row: &rusqlite::Row<'_>) -> rusqlite::Result<PsoWarmupRun> {
    let status_raw: String = row.get(10)?;
    Ok(PsoWarmupRun {
        id: Some(row.get(0)?),
        project_id: row.get(1)?,
        machine_id: row.get(2)?,
        resolution_w: row.get(3)?,
        resolution_h: row.get(4)?,
        max_minutes: row.get(5)?,
        mode: row.get(6)?,
        dc_node: row.get(7)?,
        driver_cache_growth_bytes: row.get(8)?,
        hitch_count: row.get(9)?,
        verify_hitch_count: row.get(14)?,
        verify_duration_secs: row.get(15)?,
        traversal: row.get::<_, i64>(16)? != 0,
        converged: row.get::<_, Option<i64>>(17)?.map(|v| v != 0),
        status: WarmupStatus::from_str(&status_raw),
        error_message: row.get(11)?,
        started_at: row.get(12)?,
        duration_secs: row.get(13)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::{machines, open_in_memory, projects, schema, Machine, Project};

    fn insert_started_test(db: &Db, project_id: i64, machine_id: i64) -> i64 {
        insert_started(
            db,
            project_id,
            machine_id,
            (1920, 1080),
            20,
            "ndisplay_offscreen",
            Some("Node_0"),
            false,
        )
        .unwrap()
    }

    fn setup() -> (Db, i64, i64) {
        let db = open_in_memory().unwrap();
        {
            let mut conn = db.lock().unwrap();
            schema::migrate(&mut conn).unwrap();
        }
        let machine_id =
            machines::insert(&db, &Machine::new("RENDER-01", "192.168.10.21")).unwrap();
        let project_id = projects::upsert(
            &db,
            &Project {
                id: None,
                uproject_name: "X.uproject".into(),
                uproject_stem_lower: "x".into(),
                uproject_guid: None,
                display_name: None,
                first_seen_at: None,
                last_seen_at: None,
                ue_version_major: None,
                ue_version_minor: None,
                engine_association_raw: None,
                engine_association_kind: None,
            },
        )
        .unwrap();
        (db, machine_id, project_id)
    }

    #[test]
    fn insert_then_finish_roundtrip() {
        let (db, machine_id, project_id) = setup();
        let run_id = insert_started_test(&db, project_id, machine_id);
        let running = list_by_project(&db, project_id, None).unwrap();
        assert_eq!(running.len(), 1);
        assert_eq!(running[0].status, WarmupStatus::Running);
        assert_eq!(running[0].mode, "ndisplay_offscreen");
        assert_eq!(running[0].dc_node.as_deref(), Some("Node_0"));
        assert_eq!(running[0].hitch_count, None);

        finish(
            &db,
            run_id,
            WarmupStatus::Ok,
            Some(0),
            None,
            300,
            Some(1234),
        )
        .unwrap();
        let done = list_by_project(&db, project_id, Some(machine_id)).unwrap();
        assert_eq!(done[0].status, WarmupStatus::Ok);
        assert_eq!(done[0].hitch_count, Some(0));
        assert_eq!(done[0].duration_secs, Some(300));
        assert_eq!(done[0].driver_cache_growth_bytes, Some(1234));
    }

    #[test]
    fn verify_phase_roundtrip_and_not_ready_status() {
        let (db, machine_id, project_id) = setup();
        let run_id = insert_started_test(&db, project_id, machine_id);
        record_verify_phase(&db, run_id, 3, 120).unwrap();
        finish(
            &db,
            run_id,
            WarmupStatus::NotReady,
            Some(119),
            None,
            420,
            None,
        )
        .unwrap();
        let rows = list_by_project(&db, project_id, None).unwrap();
        assert_eq!(rows[0].status, WarmupStatus::NotReady);
        assert_eq!(rows[0].hitch_count, Some(119));
        assert_eq!(rows[0].verify_hitch_count, Some(3));
        assert_eq!(rows[0].verify_duration_secs, Some(120));
        // DB string and serde wire format must agree on "not_ready".
        assert_eq!(WarmupStatus::NotReady.as_str(), "not_ready");
        assert_eq!(
            serde_json::to_string(&WarmupStatus::NotReady).unwrap(),
            "\"not_ready\""
        );
    }

    #[test]
    fn machine_filter_excludes_other_machines() {
        let (db, machine_id, project_id) = setup();
        insert_started_test(&db, project_id, machine_id);
        let other = list_by_project(&db, project_id, Some(machine_id + 999)).unwrap();
        assert!(other.is_empty());
    }

    #[test]
    fn cancelled_status_roundtrip() {
        let (db, machine_id, project_id) = setup();
        let run_id = insert_started_test(&db, project_id, machine_id);
        finish(
            &db,
            run_id,
            WarmupStatus::Cancelled,
            Some(3),
            None,
            12,
            None,
        )
        .unwrap();
        let rows = list_by_project(&db, project_id, None).unwrap();
        assert_eq!(rows[0].status, WarmupStatus::Cancelled);
        assert_eq!(rows[0].hitch_count, Some(3));
    }

    #[test]
    fn reap_overdue_only_hits_expired_running_rows() {
        let (db, machine_id, project_id) = setup();
        let fresh = insert_started_test(&db, project_id, machine_id);
        let stale = insert_started_test(&db, project_id, machine_id);
        {
            let conn = db.lock().unwrap();
            conn.execute(
                "UPDATE pso_warmup_runs SET started_at = datetime('now', '-2 hours') WHERE id = ?",
                [stale],
            )
            .unwrap();
        }
        assert_eq!(reap_overdue(&db).unwrap(), 1);
        let rows = list_by_project(&db, project_id, None).unwrap();
        let stale_row = rows.iter().find(|r| r.id == Some(stale)).unwrap();
        let fresh_row = rows.iter().find(|r| r.id == Some(fresh)).unwrap();
        assert_eq!(stale_row.status, WarmupStatus::Err);
        assert_eq!(fresh_row.status, WarmupStatus::Running);
    }
}
