//! CRUD for the `share_configs` table. Persists each SMB share Volo has
//! created (Mode A or Mode B) so the UI can list / delete them later and so
//! Mode B credential injection knows which alias to push to clients.

use crate::data::Db;
use crate::error::VoloResult;
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ShareMode {
    Open,
    Managed,
}

impl ShareMode {
    fn as_sql(self) -> &'static str {
        match self {
            ShareMode::Open => "open",
            ShareMode::Managed => "managed",
        }
    }

    fn from_sql(s: &str) -> rusqlite::Result<Self> {
        match s {
            "open" => Ok(ShareMode::Open),
            "managed" => Ok(ShareMode::Managed),
            other => Err(rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Text,
                format!("unknown share mode: {}", other).into(),
            )),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, schemars::JsonSchema)]
pub struct ShareConfig {
    pub id: Option<i64>,
    pub host_machine_id: i64,
    pub share_name: String,
    pub unc_path: String,
    pub local_path: String,
    pub mode: ShareMode,
    pub credential_alias: Option<String>,
}

pub fn insert(db: &Db, share: &ShareConfig) -> VoloResult<i64> {
    let conn = db.lock().unwrap();
    conn.execute(
        "INSERT INTO share_configs (host_machine_id, share_name, unc_path, local_path, mode, credential_alias) \
         VALUES (?, ?, ?, ?, ?, ?)",
        params![
            share.host_machine_id,
            share.share_name,
            share.unc_path,
            share.local_path,
            share.mode.as_sql(),
            share.credential_alias,
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn list_all(db: &Db) -> VoloResult<Vec<ShareConfig>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, host_machine_id, share_name, unc_path, local_path, mode, credential_alias \
         FROM share_configs ORDER BY id",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(ShareConfig {
            id: Some(row.get(0)?),
            host_machine_id: row.get(1)?,
            share_name: row.get(2)?,
            unc_path: row.get(3)?,
            local_path: row.get(4)?,
            mode: ShareMode::from_sql(&row.get::<_, String>(5)?)?,
            credential_alias: row.get(6)?,
        })
    })?;
    let mut result = Vec::new();
    for r in rows {
        result.push(r?);
    }
    Ok(result)
}

pub fn find_by_id(db: &Db, id: i64) -> VoloResult<Option<ShareConfig>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, host_machine_id, share_name, unc_path, local_path, mode, credential_alias \
         FROM share_configs WHERE id = ?",
    )?;
    let mut rows = stmt.query(params![id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(ShareConfig {
            id: Some(row.get(0)?),
            host_machine_id: row.get(1)?,
            share_name: row.get(2)?,
            unc_path: row.get(3)?,
            local_path: row.get(4)?,
            mode: ShareMode::from_sql(&row.get::<_, String>(5)?)?,
            credential_alias: row.get(6)?,
        }))
    } else {
        Ok(None)
    }
}

pub fn find_by_host(db: &Db, host_machine_id: i64) -> VoloResult<Vec<ShareConfig>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, host_machine_id, share_name, unc_path, local_path, mode, credential_alias \
         FROM share_configs WHERE host_machine_id = ? ORDER BY share_name",
    )?;
    let rows = stmt.query_map(params![host_machine_id], |row| {
        Ok(ShareConfig {
            id: Some(row.get(0)?),
            host_machine_id: row.get(1)?,
            share_name: row.get(2)?,
            unc_path: row.get(3)?,
            local_path: row.get(4)?,
            mode: ShareMode::from_sql(&row.get::<_, String>(5)?)?,
            credential_alias: row.get(6)?,
        })
    })?;
    let mut result = Vec::new();
    for r in rows {
        result.push(r?);
    }
    Ok(result)
}

pub fn delete(db: &Db, id: i64) -> VoloResult<()> {
    let conn = db.lock().unwrap();
    conn.execute("DELETE FROM share_configs WHERE id = ?", params![id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::machines::{insert as insert_machine, Machine};
    use crate::data::{open_in_memory, schema};

    fn setup_with_host() -> (Db, i64) {
        let db = open_in_memory().unwrap();
        {
            let mut conn = db.lock().unwrap();
            schema::migrate(&mut conn).unwrap();
        }
        let host_id = insert_machine(&db, &Machine::new("HOST-A", "192.168.10.21")).unwrap();
        (db, host_id)
    }

    fn sample(host_id: i64, name: &str, mode: ShareMode) -> ShareConfig {
        ShareConfig {
            id: None,
            host_machine_id: host_id,
            share_name: name.to_string(),
            unc_path: format!("\\\\HOST-A\\{}", name),
            local_path: format!("D:\\{}", name),
            mode,
            credential_alias: match mode {
                ShareMode::Open => None,
                ShareMode::Managed => Some(format!("UECM:share:HOST-A:ddc-svc")),
            },
        }
    }

    #[test]
    fn insert_returns_new_id() {
        let (db, host_id) = setup_with_host();
        let id = insert(&db, &sample(host_id, "DDC", ShareMode::Open)).unwrap();
        assert!(id > 0);
    }

    #[test]
    fn list_all_returns_inserted_rows() {
        let (db, host_id) = setup_with_host();
        insert(&db, &sample(host_id, "DDC", ShareMode::Open)).unwrap();
        insert(&db, &sample(host_id, "DDC2", ShareMode::Managed)).unwrap();
        let shares = list_all(&db).unwrap();
        assert_eq!(shares.len(), 2);
    }

    #[test]
    fn find_by_id_returns_match_or_none() {
        let (db, host_id) = setup_with_host();
        let id = insert(&db, &sample(host_id, "DDC", ShareMode::Managed)).unwrap();
        let found = find_by_id(&db, id).unwrap();
        assert!(found.is_some());
        let s = found.unwrap();
        assert_eq!(s.mode, ShareMode::Managed);
        assert_eq!(s.credential_alias.as_deref(), Some("UECM:share:HOST-A:ddc-svc"));
        assert!(find_by_id(&db, 9999).unwrap().is_none());
    }

    #[test]
    fn find_by_host_filters_correctly() {
        let (db, host_id) = setup_with_host();
        insert(&db, &sample(host_id, "DDC", ShareMode::Open)).unwrap();
        insert(&db, &sample(host_id, "DDC2", ShareMode::Open)).unwrap();
        let shares = find_by_host(&db, host_id).unwrap();
        assert_eq!(shares.len(), 2);
        // Non-existent host returns empty
        assert_eq!(find_by_host(&db, 9999).unwrap().len(), 0);
    }

    #[test]
    fn delete_removes_share() {
        let (db, host_id) = setup_with_host();
        let id = insert(&db, &sample(host_id, "DDC", ShareMode::Open)).unwrap();
        delete(&db, id).unwrap();
        assert!(find_by_id(&db, id).unwrap().is_none());
    }

    #[test]
    fn duplicate_host_share_name_returns_database_error() {
        let (db, host_id) = setup_with_host();
        insert(&db, &sample(host_id, "DDC", ShareMode::Open)).unwrap();
        let result = insert(&db, &sample(host_id, "DDC", ShareMode::Managed));
        assert!(result.is_err());
    }
}
