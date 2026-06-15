//! CRUD for the `credentials` table. Stores ONLY alias metadata (kind + display
//! username); the actual secret lives in the cross-platform SecretStore (AES-GCM).

use crate::data::Db;
use crate::error::UecmResult;
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum CredentialKind {
    Winrm,
    Share,
}

impl CredentialKind {
    fn as_sql(self) -> &'static str {
        match self {
            CredentialKind::Winrm => "winrm",
            CredentialKind::Share => "share",
        }
    }

    fn from_sql(s: &str) -> rusqlite::Result<Self> {
        match s {
            "winrm" => Ok(CredentialKind::Winrm),
            "share" => Ok(CredentialKind::Share),
            // Tolerate an unknown / legacy kind instead of failing the whole
            // credential list (one bad row would otherwise break the UI's
            // credential picker). Map it to Winrm — the conservative default the
            // UI's kind==='winrm' filters already expect.
            other => {
                tracing::warn!(kind = %other, "unknown credential kind in DB; decoding as winrm");
                Ok(CredentialKind::Winrm)
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, schemars::JsonSchema)]
pub struct CredentialRecord {
    pub id: Option<i64>,
    pub alias: String, // e.g. "UECM:winrm:RENDER-01"
    pub kind: CredentialKind,
    pub username: String,
}

pub fn insert(db: &Db, cred: &CredentialRecord) -> UecmResult<i64> {
    let conn = db.lock().unwrap();
    conn.execute(
        "INSERT INTO credentials (alias, kind, username) VALUES (?, ?, ?)",
        params![cred.alias, cred.kind.as_sql(), cred.username],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn list_all(db: &Db) -> UecmResult<Vec<CredentialRecord>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, alias, kind, username FROM credentials ORDER BY alias",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(CredentialRecord {
            id: Some(row.get(0)?),
            alias: row.get(1)?,
            kind: CredentialKind::from_sql(&row.get::<_, String>(2)?)?,
            username: row.get(3)?,
        })
    })?;
    let mut result = Vec::new();
    for r in rows {
        result.push(r?);
    }
    Ok(result)
}

pub fn find_by_alias(db: &Db, alias: &str) -> UecmResult<Option<CredentialRecord>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, alias, kind, username FROM credentials WHERE alias = ?",
    )?;
    let mut rows = stmt.query(params![alias])?;
    if let Some(row) = rows.next()? {
        Ok(Some(CredentialRecord {
            id: Some(row.get(0)?),
            alias: row.get(1)?,
            kind: CredentialKind::from_sql(&row.get::<_, String>(2)?)?,
            username: row.get(3)?,
        }))
    } else {
        Ok(None)
    }
}

pub fn delete_by_alias(db: &Db, alias: &str) -> UecmResult<()> {
    let conn = db.lock().unwrap();
    conn.execute("DELETE FROM credentials WHERE alias = ?", params![alias])?;
    Ok(())
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

    fn sample(alias: &str, user: &str) -> CredentialRecord {
        CredentialRecord {
            id: None,
            alias: alias.to_string(),
            kind: CredentialKind::Winrm,
            username: user.to_string(),
        }
    }

    #[test]
    fn insert_returns_new_id() {
        let db = setup();
        let id = insert(&db, &sample("UECM:winrm:HOST-A", "admin")).unwrap();
        assert!(id > 0);
    }

    #[test]
    fn list_all_returns_inserted_in_alpha_order() {
        let db = setup();
        insert(&db, &sample("UECM:winrm:B-HOST", "admin")).unwrap();
        insert(&db, &sample("UECM:winrm:A-HOST", "admin")).unwrap();
        let creds = list_all(&db).unwrap();
        assert_eq!(creds.len(), 2);
        assert_eq!(creds[0].alias, "UECM:winrm:A-HOST");
    }

    #[test]
    fn find_by_alias_returns_matching_record() {
        let db = setup();
        insert(&db, &sample("UECM:winrm:HOST-A", "admin")).unwrap();
        let found = find_by_alias(&db, "UECM:winrm:HOST-A").unwrap();
        assert!(found.is_some());
        assert_eq!(found.unwrap().username, "admin");
    }

    #[test]
    fn find_by_alias_returns_none_when_missing() {
        let db = setup();
        let found = find_by_alias(&db, "UECM:winrm:UNKNOWN").unwrap();
        assert!(found.is_none());
    }

    #[test]
    fn delete_by_alias_removes_record() {
        let db = setup();
        insert(&db, &sample("UECM:winrm:HOST-A", "admin")).unwrap();
        delete_by_alias(&db, "UECM:winrm:HOST-A").unwrap();
        assert!(find_by_alias(&db, "UECM:winrm:HOST-A").unwrap().is_none());
    }

    #[test]
    fn duplicate_alias_returns_database_error() {
        let db = setup();
        insert(&db, &sample("UECM:winrm:HOST-A", "admin")).unwrap();
        let result = insert(&db, &sample("UECM:winrm:HOST-A", "other"));
        assert!(result.is_err());
    }
}
