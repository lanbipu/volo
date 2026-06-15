//! Minimal job history helpers backed by the `operations` table.

use crate::data::Db;
use crate::error::{UecmError, UecmResult};
use rusqlite::params;

pub fn start(db: &Db, action_type: &str, target_machines: &[i64]) -> UecmResult<i64> {
    let target_json = serde_json::to_string(target_machines).map_err(|e| {
        UecmError::OperationFailed(format!("serialize target_machines: {}", e))
    })?;
    let conn = db.lock().unwrap();
    conn.execute(
        "INSERT INTO operations (action_type, target_machines, status)
         VALUES (?, ?, 'running')",
        params![action_type, target_json],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn finish(db: &Db, id: i64, status: &str, log_text: Option<&str>) -> UecmResult<()> {
    let conn = db.lock().unwrap();
    conn.execute(
        "UPDATE operations
         SET status = ?, finished_at = CURRENT_TIMESTAMP, log_text = COALESCE(?, log_text)
         WHERE id = ?",
        params![status, log_text, id],
    )?;
    Ok(())
}

/// Mark any `status='running'` operations whose `started_at` is older than
/// `older_than_seconds` as `interrupted`. Called at startup to clean up
/// rows abandoned by a hard process crash or kill — without this the
/// operations table accretes phantom "still running" rows forever, which
/// makes the operator's "what's in flight" view useless.
///
/// Plan 7 §8 M5 T5.3: the threshold is **1 hour** (3600s). Operations that
/// genuinely run longer than an hour are rare in UECM (DDC pak distribute
/// caps under 30 minutes in practice); anything older is almost certainly
/// stale. Returns the number of rows updated.
pub fn sweep_running(db: &Db, older_than_seconds: i64) -> UecmResult<i64> {
    let conn = db.lock().unwrap();
    let changed = conn.execute(
        "UPDATE operations
         SET status = 'interrupted',
             finished_at = CURRENT_TIMESTAMP,
             log_text = COALESCE(log_text, '') ||
                        '\n[startup-sweep] marked interrupted: status was running for >'
                        || ?1 || ' seconds'
         WHERE status = 'running'
           AND datetime(started_at) < datetime('now', '-' || ?1 || ' seconds')",
        params![older_than_seconds],
    )?;
    Ok(changed as i64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::{open_in_memory, schema};

    #[test]
    fn start_and_finish_operation() {
        let db = open_in_memory().unwrap();
        {
            let mut conn = db.lock().unwrap();
            schema::migrate(&mut conn).unwrap();
        }
        let id = start(&db, "ddc_pak.generate", &[1]).unwrap();
        finish(&db, id, "ok", Some("done")).unwrap();
        let conn = db.lock().unwrap();
        let status: String = conn
            .query_row("SELECT status FROM operations WHERE id = ?", [id], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(status, "ok");
    }

    fn setup_db() -> Db {
        let db = open_in_memory().unwrap();
        {
            let mut conn = db.lock().unwrap();
            schema::migrate(&mut conn).unwrap();
        }
        db
    }

    fn get_status_and_log(db: &Db, id: i64) -> (String, Option<String>) {
        let conn = db.lock().unwrap();
        conn.query_row(
            "SELECT status, log_text FROM operations WHERE id = ?",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap()
    }

    #[test]
    fn sweep_running_marks_stale_rows_as_interrupted() {
        let db = setup_db();
        let id_old = start(&db, "ddc_pak.distribute", &[1]).unwrap();
        // Force the row's started_at to be > 2 hours ago.
        {
            let conn = db.lock().unwrap();
            conn.execute(
                "UPDATE operations SET started_at = datetime('now', '-7200 seconds') WHERE id = ?",
                [id_old],
            )
            .unwrap();
        }
        let id_fresh = start(&db, "ddc_pak.distribute", &[1]).unwrap();
        // Sweep with 1-hour threshold.
        let changed = sweep_running(&db, 3600).unwrap();
        assert_eq!(changed, 1, "only the stale row should be swept");
        let (old_status, old_log) = get_status_and_log(&db, id_old);
        assert_eq!(old_status, "interrupted");
        let log = old_log.unwrap_or_default();
        assert!(
            log.contains("[startup-sweep]"),
            "log_text should record the sweep reason: {log:?}"
        );
        let (fresh_status, _) = get_status_and_log(&db, id_fresh);
        assert_eq!(fresh_status, "running", "fresh row must be untouched");
    }

    #[test]
    fn sweep_running_ignores_already_finished_rows() {
        let db = setup_db();
        let id = start(&db, "x.y", &[]).unwrap();
        finish(&db, id, "ok", Some("done")).unwrap();
        // Backdate even though it's not running — sweep must still skip it.
        {
            let conn = db.lock().unwrap();
            conn.execute(
                "UPDATE operations SET started_at = datetime('now', '-7200 seconds') WHERE id = ?",
                [id],
            )
            .unwrap();
        }
        let changed = sweep_running(&db, 3600).unwrap();
        assert_eq!(changed, 0);
    }

    #[test]
    fn sweep_running_appends_to_existing_log_text() {
        let db = setup_db();
        let id = start(&db, "x.y", &[]).unwrap();
        // Seed an existing log_text via finish(), then re-set status to running
        // + backdate so the sweep picks it up.
        {
            let conn = db.lock().unwrap();
            conn.execute(
                "UPDATE operations
                 SET status = 'running',
                     log_text = 'preexisting partial output',
                     started_at = datetime('now', '-7200 seconds')
                 WHERE id = ?",
                [id],
            )
            .unwrap();
        }
        sweep_running(&db, 3600).unwrap();
        let (_, log) = get_status_and_log(&db, id);
        let log = log.unwrap_or_default();
        assert!(log.starts_with("preexisting partial output"));
        assert!(log.contains("[startup-sweep]"));
    }
}
