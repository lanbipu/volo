//! CRUD for the `zen_binary_intree` table.

use crate::data::Db;
use crate::error::VoloResult;
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ZenBinaryIntree {
    pub ue_version_major: i64,
    pub ue_version_minor: i64,
    pub binary_kind: String,
    pub build_version: Option<String>,
    pub sha256: Option<String>,
    pub last_seen_at: Option<String>,
}

pub fn upsert(db: &Db, row: &ZenBinaryIntree) -> VoloResult<()> {
    let conn = db.lock().unwrap();
    conn.execute(
        "INSERT INTO zen_binary_intree (
            ue_version_major, ue_version_minor, binary_kind,
            build_version, sha256, last_seen_at
         )
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(ue_version_major, ue_version_minor, binary_kind) DO UPDATE SET
            build_version = COALESCE(excluded.build_version, zen_binary_intree.build_version),
            sha256 = COALESCE(excluded.sha256, zen_binary_intree.sha256),
            last_seen_at = CURRENT_TIMESTAMP",
        params![
            row.ue_version_major,
            row.ue_version_minor,
            row.binary_kind,
            row.build_version,
            row.sha256,
        ],
    )?;
    Ok(())
}

pub fn list(db: &Db) -> VoloResult<Vec<ZenBinaryIntree>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT ue_version_major, ue_version_minor, binary_kind,
                build_version, sha256, last_seen_at
         FROM zen_binary_intree
         ORDER BY ue_version_major ASC, ue_version_minor ASC, binary_kind ASC",
    )?;
    let rows = stmt.query_map([], zen_binary_intree_from_row)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub fn find(
    db: &Db,
    ue_major: i64,
    ue_minor: i64,
    binary_kind: &str,
) -> VoloResult<Option<ZenBinaryIntree>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT ue_version_major, ue_version_minor, binary_kind,
                build_version, sha256, last_seen_at
         FROM zen_binary_intree
         WHERE ue_version_major = ? AND ue_version_minor = ? AND binary_kind = ?",
    )?;
    let mut rows = stmt.query(params![ue_major, ue_minor, binary_kind])?;
    if let Some(row) = rows.next()? {
        Ok(Some(zen_binary_intree_from_row(row)?))
    } else {
        Ok(None)
    }
}

pub fn delete(
    db: &Db,
    ue_major: i64,
    ue_minor: i64,
    binary_kind: &str,
) -> VoloResult<()> {
    let conn = db.lock().unwrap();
    conn.execute(
        "DELETE FROM zen_binary_intree
         WHERE ue_version_major = ? AND ue_version_minor = ? AND binary_kind = ?",
        params![ue_major, ue_minor, binary_kind],
    )?;
    Ok(())
}

fn zen_binary_intree_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<ZenBinaryIntree> {
    Ok(ZenBinaryIntree {
        ue_version_major: row.get(0)?,
        ue_version_minor: row.get(1)?,
        binary_kind: row.get(2)?,
        build_version: row.get(3)?,
        sha256: row.get(4)?,
        last_seen_at: row.get(5)?,
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

    fn sample(major: i64, minor: i64, kind: &str) -> ZenBinaryIntree {
        ZenBinaryIntree {
            ue_version_major: major,
            ue_version_minor: minor,
            binary_kind: kind.into(),
            build_version: Some("1.2.3".into()),
            sha256: Some("aaaa".into()),
            last_seen_at: None,
        }
    }

    #[test]
    fn upsert_inserts_when_new() {
        let db = setup();
        upsert(&db, &sample(5, 7, "zen.exe")).unwrap();
        let got = find(&db, 5, 7, "zen.exe").unwrap().unwrap();
        assert_eq!(got.build_version.as_deref(), Some("1.2.3"));
        assert_eq!(got.sha256.as_deref(), Some("aaaa"));
    }

    #[test]
    fn upsert_updates_when_pk_exists() {
        let db = setup();
        upsert(&db, &sample(5, 7, "zen.exe")).unwrap();
        let mut row = sample(5, 7, "zen.exe");
        row.build_version = Some("1.2.4".into());
        row.sha256 = Some("bbbb".into());
        upsert(&db, &row).unwrap();
        let got = find(&db, 5, 7, "zen.exe").unwrap().unwrap();
        assert_eq!(got.build_version.as_deref(), Some("1.2.4"));
        assert_eq!(got.sha256.as_deref(), Some("bbbb"));
    }

    #[test]
    fn upsert_preserves_fields_when_omitted() {
        let db = setup();
        upsert(&db, &sample(5, 7, "zen.exe")).unwrap();
        // Refresh without sha / version (e.g. file existed but hash failed).
        let stripped = ZenBinaryIntree {
            ue_version_major: 5,
            ue_version_minor: 7,
            binary_kind: "zen.exe".into(),
            build_version: None,
            sha256: None,
            last_seen_at: None,
        };
        upsert(&db, &stripped).unwrap();
        let got = find(&db, 5, 7, "zen.exe").unwrap().unwrap();
        assert_eq!(got.build_version.as_deref(), Some("1.2.3"));
        assert_eq!(got.sha256.as_deref(), Some("aaaa"));
    }

    #[test]
    fn upsert_different_kind_creates_new_row() {
        let db = setup();
        upsert(&db, &sample(5, 7, "zen.exe")).unwrap();
        upsert(&db, &sample(5, 7, "zenserver.exe")).unwrap();
        let rows = list(&db).unwrap();
        assert_eq!(rows.len(), 2);
    }

    #[test]
    fn list_orders_by_version_then_kind() {
        let db = setup();
        upsert(&db, &sample(5, 7, "zenserver.exe")).unwrap();
        upsert(&db, &sample(5, 7, "zen.exe")).unwrap();
        upsert(&db, &sample(5, 5, "zen.exe")).unwrap();
        let rows = list(&db).unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!((rows[0].ue_version_major, rows[0].ue_version_minor), (5, 5));
        assert_eq!(rows[1].binary_kind, "zen.exe");
        assert_eq!(rows[2].binary_kind, "zenserver.exe");
    }

    #[test]
    fn delete_removes_row() {
        let db = setup();
        upsert(&db, &sample(5, 7, "zen.exe")).unwrap();
        delete(&db, 5, 7, "zen.exe").unwrap();
        assert!(find(&db, 5, 7, "zen.exe").unwrap().is_none());
    }
}
