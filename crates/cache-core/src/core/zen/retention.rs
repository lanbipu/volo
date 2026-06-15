//! Retention / GC for the `zen_probes` and `zen_cache_stats` time-series tables.
//!
//! Per plan 7 §1.4 the policy is the UNION of two windows, applied per endpoint:
//!   - keep every row whose timestamp is within the last N days (default 7)
//!   - keep the M most-recent rows (default 100), even if older than N days
//!
//! Anything outside both sets is deleted.
//!
//! TODO(plan7 T1.10): wire `core::zen::retention::run` into app startup once the
//! Tauri command surface lands. This module is intentionally caller-driven and
//! does no scheduling of its own.
//!
//! Implementation note: each table is purged by a single DELETE statement.
//! SQLite wraps a bare DELETE in an implicit transaction, so an interrupted run
//! leaves the table consistent (either fully purged or untouched). The keep-set
//! is computed inline with a window function (`ROW_NUMBER() OVER (...)`),
//! which requires SQLite >= 3.25; rusqlite 0.31's bundled SQLite is well past
//! that.

use crate::data::Db;
use crate::error::{UecmError, UecmResult};
use rusqlite::params;

/// Maximum age (in days) a row can have before it falls out of the time window.
/// Plan §1.4 specifies 7 days.
pub const DEFAULT_AGE_RETENTION_DAYS: i64 = 7;

/// Per-endpoint floor: keep this many most-recent rows even if older than the
/// age window. Plan §1.4 specifies 100.
pub const DEFAULT_COUNT_RETENTION: i64 = 100;

#[derive(Debug, Clone, PartialEq, Default)]
pub struct RetentionReport {
    pub zen_probes_deleted: u64,
    pub zen_cache_stats_deleted: u64,
}

/// Apply the default retention policy (plan §1.4: 7 days + 100 rows per endpoint).
pub fn run(db: &Db) -> UecmResult<RetentionReport> {
    run_with(db, DEFAULT_AGE_RETENTION_DAYS, DEFAULT_COUNT_RETENTION)
}

/// Apply retention with caller-controlled thresholds. Used by tests to avoid
/// waiting 7 real days for the age window to bite.
///
/// `age_retention_days` must be `>= 0`; a value of `0` collapses the age window
/// to "right now", so only the count-based floor protects rows.
pub fn run_with(
    db: &Db,
    age_retention_days: i64,
    count_retention: i64,
) -> UecmResult<RetentionReport> {
    if age_retention_days < 0 {
        return Err(UecmError::InvalidInput(format!(
            "age_retention_days must be >= 0, got {age_retention_days}"
        )));
    }
    if count_retention < 0 {
        return Err(UecmError::InvalidInput(format!(
            "count_retention must be >= 0, got {count_retention}"
        )));
    }

    // SQLite's datetime() takes the modifier as a literal arg, so the modifier
    // text is built from a validated integer here rather than bound as a param.
    let age_modifier = format!("-{age_retention_days} days");

    let conn = db.lock().unwrap();

    // Wrap probed_at/sampled_at in datetime() so SQLite normalises ISO-8601
    // 'T...Z' strings and space-separated CURRENT_TIMESTAMP output to the
    // same comparable form. Without this, lexicographic TEXT comparison
    // treats 'T' (0x54) > ' ' (0x20), so a row stamped via the CRUD layer
    // with an ISO timestamp would always appear newer than the cutoff and
    // never age out. ORDER BY also wraps for consistency.
    let zen_probes_deleted = conn.execute(
        "DELETE FROM zen_probes
         WHERE id NOT IN (
             SELECT id FROM zen_probes
             WHERE datetime(probed_at) > datetime('now', ?1)
             UNION
             SELECT id FROM (
                 SELECT id, ROW_NUMBER() OVER (
                     PARTITION BY endpoint_id
                     ORDER BY datetime(probed_at) DESC, id DESC
                 ) AS rn
                 FROM zen_probes
             ) WHERE rn <= ?2
         )",
        params![age_modifier, count_retention],
    )? as u64;

    let zen_cache_stats_deleted = conn.execute(
        "DELETE FROM zen_cache_stats
         WHERE id NOT IN (
             SELECT id FROM zen_cache_stats
             WHERE datetime(sampled_at) > datetime('now', ?1)
             UNION
             SELECT id FROM (
                 SELECT id, ROW_NUMBER() OVER (
                     PARTITION BY endpoint_id
                     ORDER BY datetime(sampled_at) DESC, id DESC
                 ) AS rn
                 FROM zen_cache_stats
             ) WHERE rn <= ?2
         )",
        params![age_modifier, count_retention],
    )? as u64;

    Ok(RetentionReport {
        zen_probes_deleted,
        zen_cache_stats_deleted,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::{machines, open_in_memory, schema, zen_endpoints, Db, Machine};
    use rusqlite::params;

    fn setup() -> (Db, i64) {
        let db = open_in_memory().unwrap();
        {
            let mut conn = db.lock().unwrap();
            schema::migrate(&mut conn).unwrap();
        }
        let machine_id = machines::insert(&db, &Machine::new("ZEN-01", "192.168.10.30")).unwrap();
        let endpoint_id = zen_endpoints::upsert(
            &db,
            &zen_endpoints::ZenEndpoint {
                id: None,
                machine_id,
                declared_port: 8558,
                scheme: "http".into(),
                role: "primary".into(),
                upstream_endpoint_id: None,
                data_dir: "C:\\ZenData".into(),
                httpserverclass: "asio".into(),
                lifecycle_mode: "managed".into(),
                created_at: None,
                updated_at: None,
            },
        )
        .unwrap();
        (db, endpoint_id)
    }

    fn make_endpoint(db: &Db, machine_id: i64, port: i64, role: &str, data_dir: &str) -> i64 {
        zen_endpoints::upsert(
            db,
            &zen_endpoints::ZenEndpoint {
                id: None,
                machine_id,
                declared_port: port,
                scheme: "http".into(),
                role: role.into(),
                upstream_endpoint_id: None,
                data_dir: data_dir.into(),
                httpserverclass: "asio".into(),
                lifecycle_mode: "managed".into(),
                created_at: None,
                updated_at: None,
            },
        )
        .unwrap()
    }

    fn machine_for_endpoint(db: &Db, endpoint_id: i64) -> i64 {
        let conn = db.lock().unwrap();
        conn.query_row(
            "SELECT machine_id FROM zen_endpoints WHERE id = ?",
            params![endpoint_id],
            |row| row.get(0),
        )
        .unwrap()
    }

    /// Insert a zen_probes row at `datetime('now', age_modifier)`.
    fn insert_probe_at(db: &Db, endpoint_id: i64, age_modifier: &str) {
        let conn = db.lock().unwrap();
        conn.execute(
            "INSERT INTO zen_probes (endpoint_id, probed_at, reachable, schema_version)
             VALUES (?1, datetime('now', ?2), 1, 1)",
            params![endpoint_id, age_modifier],
        )
        .unwrap();
    }

    /// Insert a zen_probes row with an exact ISO-8601 timestamp string.
    fn insert_probe_at_exact(db: &Db, endpoint_id: i64, probed_at: &str) {
        let conn = db.lock().unwrap();
        conn.execute(
            "INSERT INTO zen_probes (endpoint_id, probed_at, reachable, schema_version)
             VALUES (?1, ?2, 1, 1)",
            params![endpoint_id, probed_at],
        )
        .unwrap();
    }

    fn insert_cache_stats_at(db: &Db, endpoint_id: i64, age_modifier: &str) {
        let conn = db.lock().unwrap();
        conn.execute(
            "INSERT INTO zen_cache_stats (endpoint_id, sampled_at, provider_path, raw_cb)
             VALUES (?1, datetime('now', ?2), '/stats/z$', X'00')",
            params![endpoint_id, age_modifier],
        )
        .unwrap();
    }

    fn count_probes(db: &Db) -> i64 {
        let conn = db.lock().unwrap();
        conn.query_row("SELECT COUNT(*) FROM zen_probes", [], |row| row.get(0))
            .unwrap()
    }

    fn count_probes_for(db: &Db, endpoint_id: i64) -> i64 {
        let conn = db.lock().unwrap();
        conn.query_row(
            "SELECT COUNT(*) FROM zen_probes WHERE endpoint_id = ?1",
            params![endpoint_id],
            |row| row.get(0),
        )
        .unwrap()
    }

    fn count_cache_stats(db: &Db) -> i64 {
        let conn = db.lock().unwrap();
        conn.query_row("SELECT COUNT(*) FROM zen_cache_stats", [], |row| row.get(0))
            .unwrap()
    }

    #[test]
    fn run_on_empty_db_returns_zero_counts() {
        let (db, _ep) = setup();
        let report = run(&db).unwrap();
        assert_eq!(report, RetentionReport::default());
    }

    #[test]
    fn keeps_recent_rows_under_age_threshold() {
        let (db, ep) = setup();
        for offset in 1..=5 {
            insert_probe_at(&db, ep, &format!("-{offset} days"));
        }
        assert_eq!(count_probes(&db), 5);
        let report = run(&db).unwrap();
        assert_eq!(report.zen_probes_deleted, 0);
        assert_eq!(count_probes(&db), 5);
    }

    #[test]
    fn deletes_rows_beyond_age_and_count_thresholds() {
        // Fixture: 110 rows for one endpoint, split into:
        //   - 30 rows aged 1..=30 hours (all within the 7-day window)
        //   - 80 rows aged 8..=87 days  (all outside the 7-day window)
        //
        // Retention keeps UNION(within-7d, top-100). The 30 fresh rows are the
        // newest, so the top-100 = 30 fresh + 70 of the 80 aged rows.
        // Deleted = 10 (the oldest of the aged bucket).
        let (db, ep) = setup();
        for hour in 1..=30 {
            insert_probe_at(&db, ep, &format!("-{hour} hours"));
        }
        for day in 8..=87 {
            insert_probe_at(&db, ep, &format!("-{day} days"));
        }
        assert_eq!(count_probes(&db), 110);
        let report = run(&db).unwrap();
        assert_eq!(report.zen_probes_deleted, 10);
        assert_eq!(count_probes(&db), 100);
    }

    #[test]
    fn retention_isolates_by_endpoint_id() {
        // Endpoint A: 110 aged rows => loses 10 (110 - 100).
        // Endpoint B:  50 aged rows => loses  0 (50 < 100 floor).
        let (db, ep_a) = setup();
        let machine_id = machine_for_endpoint(&db, ep_a);
        let ep_b = make_endpoint(&db, machine_id, 8559, "secondary", "C:\\ZenData2");

        // All aged > 7 days so the age window protects nothing.
        for day in 8..=117 {
            insert_probe_at(&db, ep_a, &format!("-{day} days"));
        }
        for day in 8..=57 {
            insert_probe_at(&db, ep_b, &format!("-{day} days"));
        }
        assert_eq!(count_probes_for(&db, ep_a), 110);
        assert_eq!(count_probes_for(&db, ep_b), 50);

        let report = run(&db).unwrap();
        assert_eq!(report.zen_probes_deleted, 10);
        assert_eq!(count_probes_for(&db, ep_a), 100);
        assert_eq!(count_probes_for(&db, ep_b), 50);
    }

    #[test]
    fn cache_stats_table_retained_independently_from_probes() {
        // Aged rows in zen_probes (should be purged), fresh rows in zen_cache_stats
        // (should be untouched). Verifies the two DELETEs don't bleed into each other.
        let (db, ep) = setup();
        // Use count_retention=3 to make probe purging deterministic with a small fixture.
        for day in 8..=17 {
            insert_probe_at(&db, ep, &format!("-{day} days"));
        }
        for hour in 1..=5 {
            insert_cache_stats_at(&db, ep, &format!("-{hour} hours"));
        }
        assert_eq!(count_probes(&db), 10);
        assert_eq!(count_cache_stats(&db), 5);

        let report = run_with(&db, DEFAULT_AGE_RETENTION_DAYS, 3).unwrap();
        assert_eq!(report.zen_probes_deleted, 7);
        assert_eq!(report.zen_cache_stats_deleted, 0);
        assert_eq!(count_probes(&db), 3);
        assert_eq!(count_cache_stats(&db), 5);
    }

    #[test]
    fn run_with_custom_thresholds_for_test_speed() {
        // age_retention_days=0 collapses the age window so only the count floor
        // protects rows. With count_retention=3, 10 rows => 7 deleted.
        let (db, ep) = setup();
        for hour in 1..=10 {
            insert_probe_at(&db, ep, &format!("-{hour} hours"));
        }
        let report = run_with(&db, 0, 3).unwrap();
        assert_eq!(report.zen_probes_deleted, 7);
        assert_eq!(count_probes(&db), 3);
    }

    #[test]
    fn count_retention_uses_probed_at_then_id_tiebreak() {
        // Two rows with identical probed_at; count_retention=1 should keep the
        // row with the larger id (insertion-order tiebreak, matching list_recent).
        let (db, ep) = setup();
        insert_probe_at_exact(&db, ep, "2020-01-01T00:00:00Z");
        insert_probe_at_exact(&db, ep, "2020-01-01T00:00:00Z");
        let survivor_id_before: i64 = {
            let conn = db.lock().unwrap();
            conn.query_row(
                "SELECT MAX(id) FROM zen_probes WHERE endpoint_id = ?1",
                params![ep],
                |row| row.get(0),
            )
            .unwrap()
        };

        let report = run_with(&db, 0, 1).unwrap();
        assert_eq!(report.zen_probes_deleted, 1);

        let conn = db.lock().unwrap();
        let survivor_id: i64 = conn
            .query_row(
                "SELECT id FROM zen_probes WHERE endpoint_id = ?1",
                params![ep],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(survivor_id, survivor_id_before);
    }

    #[test]
    fn invalid_negative_age_returns_input_error() {
        let (db, _ep) = setup();
        let err = run_with(&db, -1, 100).unwrap_err();
        assert!(
            matches!(err, UecmError::InvalidInput(_)),
            "expected InvalidInput, got {err:?}"
        );
    }

    #[test]
    fn invalid_negative_count_returns_input_error() {
        let (db, _ep) = setup();
        let err = run_with(&db, 7, -1).unwrap_err();
        assert!(
            matches!(err, UecmError::InvalidInput(_)),
            "expected InvalidInput, got {err:?}"
        );
    }

    #[test]
    fn report_counts_match_actual_row_delta() {
        let (db, ep) = setup();
        for hour in 1..=20 {
            insert_probe_at(&db, ep, &format!("-{hour} hours"));
        }
        for hour in 1..=15 {
            insert_cache_stats_at(&db, ep, &format!("-{hour} hours"));
        }
        let before_probes = count_probes(&db);
        let before_stats = count_cache_stats(&db);
        let report = run_with(&db, 0, 5).unwrap();
        let after_probes = count_probes(&db);
        let after_stats = count_cache_stats(&db);
        assert_eq!(
            report.zen_probes_deleted,
            (before_probes - after_probes) as u64
        );
        assert_eq!(
            report.zen_cache_stats_deleted,
            (before_stats - after_stats) as u64
        );
        assert_eq!(report.zen_probes_deleted, 15);
        assert_eq!(report.zen_cache_stats_deleted, 10);
    }

    #[test]
    fn iso8601_timestamps_age_out_correctly() {
        // CRUD callers persist `probed_at` as ISO-8601 'YYYY-MM-DDTHH:MM:SSZ'
        // (see data/zen_cache_stats.rs:189). Without datetime() normalisation,
        // raw TEXT compare would always treat 'T' > ' ' and let ISO rows
        // escape the age window. This test inserts an old ISO row and asserts
        // it gets deleted by an age-only purge.
        let (db, ep) = setup();
        let conn = db.lock().unwrap();
        // 30 days ago — older than any reasonable retention window.
        conn.execute(
            "INSERT INTO zen_probes (endpoint_id, probed_at, reachable, schema_version)
             VALUES (?1, ?2, 1, 1)",
            params![ep, "2020-01-01T00:00:00Z"],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO zen_cache_stats (endpoint_id, sampled_at, provider_path, raw_cb)
             VALUES (?1, ?2, '/stats/z$', X'00')",
            params![ep, "2020-01-01T00:00:00Z"],
        )
        .unwrap();
        drop(conn);

        // count_retention = 0 forces the age window to be the only retention
        // anchor; both old ISO-stamped rows must drop.
        let report = run_with(&db, 7, 0).unwrap();
        assert_eq!(report.zen_probes_deleted, 1);
        assert_eq!(report.zen_cache_stats_deleted, 1);
        assert_eq!(count_probes(&db), 0);
        assert_eq!(count_cache_stats(&db), 0);
    }
}
