//! CRUD for the `zen_binary_expected` table.
//!
//! This table is the **baseline** for R016 binary intact checks. Once a
//! (zen_build_version, binary_kind) row exists, its `sha256` is frozen —
//! `insert_baseline` is INSERT ... ON CONFLICT DO NOTHING so a routine
//! `detect-binary` re-scan never overwrites the recorded expected hash.
//! Operator-driven changes go through explicit `lock` / `unlock` /
//! `set_sha256` so any baseline mutation is auditable.

use crate::data::Db;
use crate::error::UecmResult;
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ZenBinaryExpected {
    pub zen_build_version: String,
    pub binary_kind: String,
    pub sha256: String,
    pub locked_by: Option<String>,
    pub first_seen_at: Option<String>,
}

/// First-write-wins baseline insert. If a row already exists for
/// (zen_build_version, binary_kind), this is a no-op and returns
/// `Ok(false)`. Returns `Ok(true)` when a new baseline row is recorded.
pub fn insert_baseline(db: &Db, row: &ZenBinaryExpected) -> UecmResult<bool> {
    let conn = db.lock().unwrap();
    let changed = conn.execute(
        "INSERT INTO zen_binary_expected (zen_build_version, binary_kind, sha256, locked_by)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(zen_build_version, binary_kind) DO NOTHING",
        params![row.zen_build_version, row.binary_kind, row.sha256, row.locked_by],
    )?;
    Ok(changed > 0)
}

/// Operator-driven explicit baseline override (e.g. `uecm-cli zen baseline
/// lock --sha256 ...`). Use sparingly — the audit trail is `locked_by`.
pub fn set_sha256(
    db: &Db,
    zen_build_version: &str,
    binary_kind: &str,
    sha256: &str,
) -> UecmResult<()> {
    let conn = db.lock().unwrap();
    conn.execute(
        "UPDATE zen_binary_expected
         SET sha256 = ?
         WHERE zen_build_version = ? AND binary_kind = ?",
        params![sha256, zen_build_version, binary_kind],
    )?;
    Ok(())
}

/// Records who locked the baseline. Setting `locked_by` does not change
/// `sha256`; it marks the baseline as operator-pinned so reviewers know
/// the row was vetted.
pub fn lock(
    db: &Db,
    zen_build_version: &str,
    binary_kind: &str,
    locked_by: &str,
) -> UecmResult<()> {
    let conn = db.lock().unwrap();
    conn.execute(
        "UPDATE zen_binary_expected
         SET locked_by = ?
         WHERE zen_build_version = ? AND binary_kind = ?",
        params![locked_by, zen_build_version, binary_kind],
    )?;
    Ok(())
}

/// Clears the lock marker. `sha256` is untouched.
pub fn unlock(db: &Db, zen_build_version: &str, binary_kind: &str) -> UecmResult<()> {
    let conn = db.lock().unwrap();
    conn.execute(
        "UPDATE zen_binary_expected
         SET locked_by = NULL
         WHERE zen_build_version = ? AND binary_kind = ?",
        params![zen_build_version, binary_kind],
    )?;
    Ok(())
}

pub fn list(db: &Db) -> UecmResult<Vec<ZenBinaryExpected>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT zen_build_version, binary_kind, sha256, locked_by, first_seen_at
         FROM zen_binary_expected
         ORDER BY zen_build_version ASC, binary_kind ASC",
    )?;
    let rows = stmt.query_map([], zen_binary_expected_from_row)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub fn find(
    db: &Db,
    zen_build_version: &str,
    binary_kind: &str,
) -> UecmResult<Option<ZenBinaryExpected>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT zen_build_version, binary_kind, sha256, locked_by, first_seen_at
         FROM zen_binary_expected
         WHERE zen_build_version = ? AND binary_kind = ?",
    )?;
    let mut rows = stmt.query(params![zen_build_version, binary_kind])?;
    if let Some(row) = rows.next()? {
        Ok(Some(zen_binary_expected_from_row(row)?))
    } else {
        Ok(None)
    }
}

pub fn delete(db: &Db, zen_build_version: &str, binary_kind: &str) -> UecmResult<()> {
    let conn = db.lock().unwrap();
    conn.execute(
        "DELETE FROM zen_binary_expected
         WHERE zen_build_version = ? AND binary_kind = ?",
        params![zen_build_version, binary_kind],
    )?;
    Ok(())
}

fn zen_binary_expected_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<ZenBinaryExpected> {
    Ok(ZenBinaryExpected {
        zen_build_version: row.get(0)?,
        binary_kind: row.get(1)?,
        sha256: row.get(2)?,
        locked_by: row.get(3)?,
        first_seen_at: row.get(4)?,
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

    fn sample(version: &str, kind: &str, sha: &str) -> ZenBinaryExpected {
        ZenBinaryExpected {
            zen_build_version: version.into(),
            binary_kind: kind.into(),
            sha256: sha.into(),
            locked_by: None,
            first_seen_at: None,
        }
    }

    #[test]
    fn insert_baseline_writes_first_time_only() {
        let db = setup();
        let was_inserted = insert_baseline(&db, &sample("1.2.3", "zen.exe", "aaaa")).unwrap();
        assert!(was_inserted, "first insert should record the baseline");
        let got = find(&db, "1.2.3", "zen.exe").unwrap().unwrap();
        assert_eq!(got.sha256, "aaaa");
    }

    #[test]
    fn insert_baseline_is_noop_on_duplicate_pk() {
        // R016 relies on this: a second detect-binary scan with a tampered
        // file must NOT overwrite the recorded baseline.
        let db = setup();
        insert_baseline(&db, &sample("1.2.3", "zen.exe", "aaaa")).unwrap();
        let was_inserted = insert_baseline(&db, &sample("1.2.3", "zen.exe", "TAMPERED")).unwrap();
        assert!(!was_inserted, "duplicate PK insert must be a no-op");
        let got = find(&db, "1.2.3", "zen.exe").unwrap().unwrap();
        assert_eq!(got.sha256, "aaaa", "baseline must remain frozen");
    }

    #[test]
    fn insert_baseline_different_kind_creates_new_row() {
        let db = setup();
        insert_baseline(&db, &sample("1.2.3", "zen.exe", "aaaa")).unwrap();
        insert_baseline(&db, &sample("1.2.3", "zenserver.exe", "bbbb")).unwrap();
        let rows = list(&db).unwrap();
        assert_eq!(rows.len(), 2);
    }

    #[test]
    fn set_sha256_overrides_baseline_explicitly() {
        let db = setup();
        insert_baseline(&db, &sample("1.2.3", "zen.exe", "aaaa")).unwrap();
        set_sha256(&db, "1.2.3", "zen.exe", "cccc").unwrap();
        let got = find(&db, "1.2.3", "zen.exe").unwrap().unwrap();
        assert_eq!(got.sha256, "cccc");
    }

    #[test]
    fn lock_and_unlock_toggle_marker() {
        let db = setup();
        insert_baseline(&db, &sample("1.2.3", "zen.exe", "aaaa")).unwrap();
        lock(&db, "1.2.3", "zen.exe", "operator-1").unwrap();
        let locked = find(&db, "1.2.3", "zen.exe").unwrap().unwrap();
        assert_eq!(locked.locked_by.as_deref(), Some("operator-1"));
        unlock(&db, "1.2.3", "zen.exe").unwrap();
        let unlocked = find(&db, "1.2.3", "zen.exe").unwrap().unwrap();
        assert!(unlocked.locked_by.is_none());
    }

    #[test]
    fn list_orders_by_version_then_kind() {
        let db = setup();
        insert_baseline(&db, &sample("1.2.3", "zenserver.exe", "x")).unwrap();
        insert_baseline(&db, &sample("1.2.3", "zen.exe", "y")).unwrap();
        insert_baseline(&db, &sample("1.1.0", "zen.exe", "z")).unwrap();
        let rows = list(&db).unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].zen_build_version, "1.1.0");
        assert_eq!(rows[1].binary_kind, "zen.exe");
        assert_eq!(rows[2].binary_kind, "zenserver.exe");
    }

    #[test]
    fn delete_removes_row() {
        let db = setup();
        insert_baseline(&db, &sample("1.2.3", "zen.exe", "aaaa")).unwrap();
        delete(&db, "1.2.3", "zen.exe").unwrap();
        assert!(find(&db, "1.2.3", "zen.exe").unwrap().is_none());
    }
}
