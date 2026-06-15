//! CRUD operations for the `machines` table.

use crate::data::Db;
use crate::error::{UecmError, UecmResult};
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Machine {
    pub id: Option<i64>,
    pub hostname: String,
    pub ip: String,
    pub role: String,        // "host" | "render" | "dev" | "editor" | "unknown"
    pub status: String,      // "online" | "offline" | "unknown"
    pub last_seen_at: Option<String>,
}

impl Machine {
    pub fn new(hostname: &str, ip: &str) -> Self {
        Self {
            id: None,
            hostname: hostname.to_string(),
            ip: ip.to_string(),
            role: "unknown".to_string(),
            status: "unknown".to_string(),
            last_seen_at: None,
        }
    }
}

pub fn insert(db: &Db, machine: &Machine) -> UecmResult<i64> {
    let conn = db.lock().unwrap();
    conn.execute(
        "INSERT INTO machines (hostname, ip, role, status, last_seen_at) VALUES (?, ?, ?, ?, ?)",
        params![
            machine.hostname,
            machine.ip,
            machine.role,
            machine.status,
            machine.last_seen_at,
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn find_by_id(db: &Db, id: i64) -> UecmResult<Option<Machine>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, hostname, ip, role, status, last_seen_at FROM machines WHERE id = ?",
    )?;
    let mut rows = stmt.query(params![id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(Machine {
            id: Some(row.get(0)?),
            hostname: row.get(1)?,
            ip: row.get(2)?,
            role: row.get(3)?,
            status: row.get(4)?,
            last_seen_at: row.get(5)?,
        }))
    } else {
        Ok(None)
    }
}

pub fn find_by_ip(db: &Db, ip: &str) -> UecmResult<Option<Machine>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, hostname, ip, role, status, last_seen_at FROM machines WHERE ip = ?",
    )?;
    let mut rows = stmt.query(params![ip])?;
    if let Some(row) = rows.next()? {
        Ok(Some(Machine {
            id: Some(row.get(0)?),
            hostname: row.get(1)?,
            ip: row.get(2)?,
            role: row.get(3)?,
            status: row.get(4)?,
            last_seen_at: row.get(5)?,
        }))
    } else {
        Ok(None)
    }
}

pub fn find_by_hostname(db: &Db, hostname: &str) -> UecmResult<Option<Machine>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, hostname, ip, role, status, last_seen_at FROM machines WHERE hostname = ?",
    )?;
    let mut rows = stmt.query(params![hostname])?;
    if let Some(row) = rows.next()? {
        Ok(Some(Machine {
            id: Some(row.get(0)?),
            hostname: row.get(1)?,
            ip: row.get(2)?,
            role: row.get(3)?,
            status: row.get(4)?,
            last_seen_at: row.get(5)?,
        }))
    } else {
        Ok(None)
    }
}

pub fn list_all(db: &Db) -> UecmResult<Vec<Machine>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, hostname, ip, role, status, last_seen_at FROM machines ORDER BY hostname",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(Machine {
            id: Some(row.get(0)?),
            hostname: row.get(1)?,
            ip: row.get(2)?,
            role: row.get(3)?,
            status: row.get(4)?,
            last_seen_at: row.get(5)?,
        })
    })?;
    let mut result = Vec::new();
    for r in rows {
        result.push(r?);
    }
    Ok(result)
}

pub fn delete(db: &Db, id: i64) -> UecmResult<()> {
    let conn = db.lock().unwrap();
    conn.execute("DELETE FROM machines WHERE id = ?", params![id])?;
    Ok(())
}

/// Updates the hostname for a machine row. Returns `InvalidInput` when no row matched.
/// Plan 3 T6: lets users rename a machine after first discovery via the detail panel.
pub fn rename(db: &Db, id: i64, new_hostname: &str) -> UecmResult<()> {
    let conn = db.lock().unwrap();
    let updated = conn.execute(
        "UPDATE machines SET hostname = ? WHERE id = ?",
        params![new_hostname, id],
    )?;
    if updated == 0 {
        return Err(UecmError::InvalidInput(format!("machine {} not found", id)));
    }
    Ok(())
}

/// Returns the per-machine SSH login user, or None when unset (caller uses
/// the default `uecm-svc`). Added in migration 022 for the SSH transport.
pub fn get_ssh_user(db: &Db, id: i64) -> UecmResult<Option<String>> {
    let conn = db.lock().unwrap();
    let user: Option<String> = conn.query_row(
        "SELECT ssh_user FROM machines WHERE id = ?",
        params![id],
        |row| row.get(0),
    )?;
    Ok(user)
}

/// Sets (or clears, with `None`) the per-machine SSH login user.
/// Returns `InvalidInput` when no row matched.
pub fn set_ssh_user(db: &Db, id: i64, user: Option<&str>) -> UecmResult<()> {
    let conn = db.lock().unwrap();
    let updated = conn.execute(
        "UPDATE machines SET ssh_user = ? WHERE id = ?",
        params![user, id],
    )?;
    if updated == 0 {
        return Err(UecmError::InvalidInput(format!("machine {} not found", id)));
    }
    Ok(())
}

/// Returns the Windows username of the account that runs UE on this machine,
/// or None when unset. Used by `zen enable --global` to construct the
/// UserEngine.ini absolute path without relying on %APPDATA% expansion in the
/// uecm-svc SSH session.
pub fn get_ue_runtime_user(db: &Db, id: i64) -> UecmResult<Option<String>> {
    let conn = db.lock().unwrap();
    let user: Option<String> = conn.query_row(
        "SELECT ue_runtime_user FROM machines WHERE id = ?",
        params![id],
        |row| row.get(0),
    )?;
    Ok(user)
}

/// Sets (or clears, with `None`) the per-machine UE runtime Windows username.
/// Returns `InvalidInput` when no row matched.
pub fn set_ue_runtime_user(db: &Db, id: i64, user: Option<&str>) -> UecmResult<()> {
    let conn = db.lock().unwrap();
    let updated = conn.execute(
        "UPDATE machines SET ue_runtime_user = ? WHERE id = ?",
        params![user, id],
    )?;
    if updated == 0 {
        return Err(UecmError::InvalidInput(format!("machine {} not found", id)));
    }
    Ok(())
}

/// Stamps the machine row with `CURRENT_TIMESTAMP` and a fresh status.
/// Called by `refresh_machine` so the UI online/offline badge reflects truth.
pub fn mark_seen(db: &Db, id: i64, status: &str) -> UecmResult<()> {
    let conn = db.lock().unwrap();
    conn.execute(
        "UPDATE machines SET last_seen_at = CURRENT_TIMESTAMP, status = ? WHERE id = ?",
        params![status, id],
    )?;
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

    #[test]
    fn insert_returns_new_id() {
        let db = setup();
        let m = Machine::new("RENDER-01", "192.168.10.21");
        let id = insert(&db, &m).unwrap();
        assert!(id > 0);
    }

    #[test]
    fn ssh_user_round_trips_and_defaults_none() {
        let db = setup();
        let id = insert(&db, &Machine::new("RENDER-09", "192.168.10.29")).unwrap();
        assert_eq!(get_ssh_user(&db, id).unwrap(), None);
        set_ssh_user(&db, id, Some("uecm-svc")).unwrap();
        assert_eq!(get_ssh_user(&db, id).unwrap(), Some("uecm-svc".to_string()));
        set_ssh_user(&db, id, None).unwrap();
        assert_eq!(get_ssh_user(&db, id).unwrap(), None);
    }

    #[test]
    fn list_all_returns_inserted_machines_in_alphabetical_order() {
        let db = setup();
        insert(&db, &Machine::new("RENDER-02", "192.168.10.22")).unwrap();
        insert(&db, &Machine::new("RENDER-01", "192.168.10.21")).unwrap();

        let machines = list_all(&db).unwrap();
        assert_eq!(machines.len(), 2);
        assert_eq!(machines[0].hostname, "RENDER-01");
        assert_eq!(machines[1].hostname, "RENDER-02");
    }

    #[test]
    fn delete_removes_machine() {
        let db = setup();
        let id = insert(&db, &Machine::new("RENDER-01", "192.168.10.21")).unwrap();
        delete(&db, id).unwrap();
        let machines = list_all(&db).unwrap();
        assert!(machines.is_empty());
    }

    #[test]
    fn find_by_id_returns_match_or_none() {
        let db = setup();
        let id = insert(&db, &Machine::new("RENDER-01", "192.168.10.21")).unwrap();
        let found = find_by_id(&db, id).unwrap();
        assert!(found.is_some());
        assert_eq!(found.unwrap().hostname, "RENDER-01");
        assert!(find_by_id(&db, 9999).unwrap().is_none());
    }

    #[test]
    fn find_by_ip_returns_match_or_none() {
        let db = setup();
        insert(&db, &Machine::new("RENDER-01", "192.168.10.21")).unwrap();
        let found = find_by_ip(&db, "192.168.10.21").unwrap();
        assert!(found.is_some());
        assert_eq!(found.unwrap().hostname, "RENDER-01");
        assert!(find_by_ip(&db, "10.0.0.99").unwrap().is_none());
    }

    #[test]
    fn duplicate_ip_returns_database_error() {
        let db = setup();
        insert(&db, &Machine::new("A", "192.168.10.1")).unwrap();
        let result = insert(&db, &Machine::new("B", "192.168.10.1"));
        assert!(result.is_err());
    }

    #[test]
    fn mark_seen_updates_status_and_last_seen() {
        let db = setup();
        let id = insert(&db, &Machine::new("RENDER-01", "192.168.10.21")).unwrap();
        // Sanity: fresh row starts with default status + null last_seen_at.
        let before = find_by_id(&db, id).unwrap().unwrap();
        assert_eq!(before.status, "unknown");
        assert!(before.last_seen_at.is_none());

        mark_seen(&db, id, "online").unwrap();

        let after = find_by_id(&db, id).unwrap().unwrap();
        assert_eq!(after.status, "online");
        assert!(after.last_seen_at.is_some());
    }

    #[test]
    fn rename_updates_hostname_for_existing_machine() {
        let db = setup();
        let id = insert(&db, &Machine::new("RENDER-OLD", "192.168.10.30")).unwrap();
        rename(&db, id, "RENDER-NEW").unwrap();
        let after = find_by_id(&db, id).unwrap().unwrap();
        assert_eq!(after.hostname, "RENDER-NEW");
    }

    #[test]
    fn rename_returns_error_for_unknown_id() {
        let db = setup();
        let result = rename(&db, 9999, "X");
        assert!(result.is_err());
        match result.unwrap_err() {
            UecmError::InvalidInput(msg) => assert!(msg.contains("9999")),
            other => panic!("expected InvalidInput, got {:?}", other),
        }
    }

    #[test]
    fn mark_seen_bumps_last_seen_on_each_call() {
        // SQLite's CURRENT_TIMESTAMP has 1-second granularity, so two
        // back-to-back calls in a fast test may produce identical strings.
        // We intentionally do NOT assert strict ordering — only that each
        // call leaves last_seen_at populated and the latest status sticks.
        let db = setup();
        let id = insert(&db, &Machine::new("RENDER-02", "192.168.10.22")).unwrap();

        mark_seen(&db, id, "online").unwrap();
        let first = find_by_id(&db, id).unwrap().unwrap();
        assert!(first.last_seen_at.is_some());
        assert_eq!(first.status, "online");

        mark_seen(&db, id, "offline").unwrap();
        let second = find_by_id(&db, id).unwrap().unwrap();
        assert!(second.last_seen_at.is_some());
        assert_eq!(second.status, "offline");
    }

    #[test]
    fn ue_runtime_user_defaults_none_and_round_trips() {
        let db = setup();
        let id = insert(&db, &Machine::new("R01", "10.0.0.1")).unwrap();
        assert_eq!(get_ue_runtime_user(&db, id).unwrap(), None);
        set_ue_runtime_user(&db, id, Some("lanbp")).unwrap();
        assert_eq!(
            get_ue_runtime_user(&db, id).unwrap(),
            Some("lanbp".to_string())
        );
        set_ue_runtime_user(&db, id, None).unwrap();
        assert_eq!(get_ue_runtime_user(&db, id).unwrap(), None);
    }

    #[test]
    fn set_ue_runtime_user_returns_error_for_unknown_id() {
        let db = setup();
        let result = set_ue_runtime_user(&db, 9999, Some("x"));
        assert!(result.is_err());
        match result.unwrap_err() {
            UecmError::InvalidInput(msg) => assert!(msg.contains("9999")),
            other => panic!("expected InvalidInput, got {:?}", other),
        }
    }
}
