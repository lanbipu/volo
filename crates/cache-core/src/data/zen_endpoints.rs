//! CRUD for the `zen_endpoints` table.
//!
//! All operations come in two flavors:
//!
//! - `*_tx` helpers take `&Connection`. Call these from inside a single
//!   `MutexGuard<Connection>` / `Transaction` when several queries must observe
//!   the same DB snapshot (used by `core::zen::endpoint` for register / role
//!   transitions where field validation, upstream existence checks and the
//!   write must all be atomic).
//! - Plain helpers take `&Db` and are thin wrappers that lock the mutex and
//!   delegate to the `_tx` variant. They are the right choice for one-shot
//!   reads / writes where no other DB access has to happen under the same
//!   lock acquisition.

use crate::data::Db;
use crate::error::VoloResult;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ZenEndpoint {
    pub id: Option<i64>,
    pub machine_id: i64,
    pub declared_port: i64,
    pub scheme: String,
    pub role: String,
    pub upstream_endpoint_id: Option<i64>,
    pub data_dir: String,
    pub httpserverclass: String,
    pub lifecycle_mode: String,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    /// `{ZenInstall}` — the directory `zenserver.exe` + `zen_config.lua` must
    /// live in. `None` means legacy behavior: derive it from wherever
    /// `zen detect-binary` found a usable zen.exe (see
    /// `core::zen::ops::resolve_install_paths`). `Some(dir)` makes this
    /// directory authoritative — the resolver copies the detected zen.exe
    /// here if it isn't already, so the field can't drift from the config
    /// file's actual location.
    pub install_dir: Option<String>,
    /// `gc.intervalseconds` — full GC scan interval, in seconds.
    pub gc_interval_seconds: Option<i64>,
    /// `gc.lightweightintervalseconds` — lightweight GC scan interval, in seconds.
    pub gc_lightweight_interval_seconds: Option<i64>,
    /// `cache.maxdurationseconds` — max cache retention, in seconds.
    pub cache_max_duration_seconds: Option<i64>,
    /// Username of the tool-managed dedicated local service account, if one
    /// was auto-created for this endpoint (see `core::zen::service_account`).
    pub service_account_username: Option<String>,
    /// `SecretStore` alias holding that account's password. Never the
    /// password itself.
    pub service_account_cred_alias: Option<String>,
    /// Manual override for where `zen_config.lua` lands, taking precedence
    /// over the `install_dir`-derived path in
    /// `core::zen::ops::resolve_install_paths`. Both `zen_apply_config`
    /// (write) and `zen_service_install` (launch via `--config=`) read this
    /// same field through the same resolver, so an override here can never
    /// drift the two apart the way an ad-hoc per-call override would.
    pub config_path_override: Option<String>,
}

pub fn upsert_tx(conn: &Connection, endpoint: &ZenEndpoint) -> VoloResult<i64> {
    // upstream_endpoint_id is operator-driven topology (cluster master / local
    // peer); explicit None must clear it so role transitions (local ↔
    // shared_upstream / standalone) don't leave a stale upstream reference.
    conn.execute(
        "INSERT INTO zen_endpoints (
            machine_id,
            declared_port,
            scheme,
            role,
            upstream_endpoint_id,
            data_dir,
            httpserverclass,
            lifecycle_mode,
            install_dir,
            config_path_override,
            updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(machine_id, declared_port) DO UPDATE SET
            scheme = excluded.scheme,
            role = excluded.role,
            upstream_endpoint_id = excluded.upstream_endpoint_id,
            data_dir = excluded.data_dir,
            httpserverclass = excluded.httpserverclass,
            lifecycle_mode = excluded.lifecycle_mode,
            install_dir = excluded.install_dir,
            config_path_override = excluded.config_path_override,
            updated_at = CURRENT_TIMESTAMP",
        params![
            endpoint.machine_id,
            endpoint.declared_port,
            endpoint.scheme,
            endpoint.role,
            endpoint.upstream_endpoint_id,
            endpoint.data_dir,
            endpoint.httpserverclass,
            endpoint.lifecycle_mode,
            endpoint.install_dir,
            endpoint.config_path_override,
        ],
    )?;
    let id = conn.query_row(
        "SELECT id FROM zen_endpoints WHERE machine_id = ? AND declared_port = ?",
        params![endpoint.machine_id, endpoint.declared_port],
        |row| row.get(0),
    )?;
    Ok(id)
}

pub fn upsert(db: &Db, endpoint: &ZenEndpoint) -> VoloResult<i64> {
    let conn = db.lock().unwrap();
    upsert_tx(&conn, endpoint)
}

/// Insert-only counterpart to [`upsert_tx`]. Used by `core::zen::endpoint` to
/// honor plan §7.2's idempotency contract (a duplicate `register` MUST return
/// the existing id without overwriting fields).
///
/// Returns `(id, inserted)` where `inserted` is `true` iff a new row was
/// created. On conflict the caller's `endpoint` is discarded and the existing
/// row's id is returned.
pub fn insert_only_tx(conn: &Connection, endpoint: &ZenEndpoint) -> VoloResult<(i64, bool)> {
    let changed = conn.execute(
        "INSERT INTO zen_endpoints (
            machine_id,
            declared_port,
            scheme,
            role,
            upstream_endpoint_id,
            data_dir,
            httpserverclass,
            lifecycle_mode,
            install_dir,
            config_path_override,
            updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(machine_id, declared_port) DO NOTHING",
        params![
            endpoint.machine_id,
            endpoint.declared_port,
            endpoint.scheme,
            endpoint.role,
            endpoint.upstream_endpoint_id,
            endpoint.data_dir,
            endpoint.httpserverclass,
            endpoint.lifecycle_mode,
            endpoint.install_dir,
            endpoint.config_path_override,
        ],
    )?;
    let id = conn.query_row(
        "SELECT id FROM zen_endpoints WHERE machine_id = ? AND declared_port = ?",
        params![endpoint.machine_id, endpoint.declared_port],
        |row| row.get(0),
    )?;
    Ok((id, changed == 1))
}

pub fn insert_only(db: &Db, endpoint: &ZenEndpoint) -> VoloResult<(i64, bool)> {
    let conn = db.lock().unwrap();
    insert_only_tx(&conn, endpoint)
}

pub fn list_tx(conn: &Connection) -> VoloResult<Vec<ZenEndpoint>> {
    let mut stmt = conn.prepare(
        "SELECT id, machine_id, declared_port, scheme, role, upstream_endpoint_id,
                data_dir, httpserverclass, lifecycle_mode, created_at, updated_at,
                install_dir, gc_interval_seconds, gc_lightweight_interval_seconds,
                cache_max_duration_seconds, service_account_username, service_account_cred_alias,
                config_path_override
         FROM zen_endpoints ORDER BY id ASC",
    )?;
    let rows = stmt.query_map([], zen_endpoint_from_row)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub fn list(db: &Db) -> VoloResult<Vec<ZenEndpoint>> {
    let conn = db.lock().unwrap();
    list_tx(&conn)
}

pub fn list_for_machine_tx(conn: &Connection, machine_id: i64) -> VoloResult<Vec<ZenEndpoint>> {
    let mut stmt = conn.prepare(
        "SELECT id, machine_id, declared_port, scheme, role, upstream_endpoint_id,
                data_dir, httpserverclass, lifecycle_mode, created_at, updated_at,
                install_dir, gc_interval_seconds, gc_lightweight_interval_seconds,
                cache_max_duration_seconds, service_account_username, service_account_cred_alias,
                config_path_override
         FROM zen_endpoints WHERE machine_id = ? ORDER BY declared_port ASC",
    )?;
    let rows = stmt.query_map(params![machine_id], zen_endpoint_from_row)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub fn list_for_machine(db: &Db, machine_id: i64) -> VoloResult<Vec<ZenEndpoint>> {
    let conn = db.lock().unwrap();
    list_for_machine_tx(&conn, machine_id)
}

pub fn get_tx(conn: &Connection, endpoint_id: i64) -> VoloResult<Option<ZenEndpoint>> {
    let mut stmt = conn.prepare(
        "SELECT id, machine_id, declared_port, scheme, role, upstream_endpoint_id,
                data_dir, httpserverclass, lifecycle_mode, created_at, updated_at,
                install_dir, gc_interval_seconds, gc_lightweight_interval_seconds,
                cache_max_duration_seconds, service_account_username, service_account_cred_alias,
                config_path_override
         FROM zen_endpoints WHERE id = ?",
    )?;
    let mut rows = stmt.query(params![endpoint_id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(zen_endpoint_from_row(row)?))
    } else {
        Ok(None)
    }
}

pub fn get(db: &Db, endpoint_id: i64) -> VoloResult<Option<ZenEndpoint>> {
    let conn = db.lock().unwrap();
    get_tx(&conn, endpoint_id)
}

pub fn delete_tx(conn: &Connection, endpoint_id: i64) -> VoloResult<()> {
    conn.execute(
        "DELETE FROM zen_endpoints WHERE id = ?",
        params![endpoint_id],
    )?;
    Ok(())
}

pub fn delete(db: &Db, endpoint_id: i64) -> VoloResult<()> {
    let conn = db.lock().unwrap();
    delete_tx(&conn, endpoint_id)
}

fn zen_endpoint_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ZenEndpoint> {
    Ok(ZenEndpoint {
        id: Some(row.get(0)?),
        machine_id: row.get(1)?,
        declared_port: row.get(2)?,
        scheme: row.get(3)?,
        role: row.get(4)?,
        upstream_endpoint_id: row.get(5)?,
        data_dir: row.get(6)?,
        httpserverclass: row.get(7)?,
        lifecycle_mode: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
        install_dir: row.get(11)?,
        gc_interval_seconds: row.get(12)?,
        gc_lightweight_interval_seconds: row.get(13)?,
        cache_max_duration_seconds: row.get(14)?,
        service_account_username: row.get(15)?,
        service_account_cred_alias: row.get(16)?,
        config_path_override: row.get(17)?,
    })
}

/// Persist the three GC retention settings onto an existing endpoint row.
/// Called after re-rendering + pushing `zen_config.lua` so the DB stays the
/// source of truth the next render reads back from.
pub fn update_gc_settings_tx(
    conn: &Connection,
    endpoint_id: i64,
    gc_interval_seconds: i64,
    gc_lightweight_interval_seconds: i64,
    cache_max_duration_seconds: i64,
) -> VoloResult<()> {
    conn.execute(
        "UPDATE zen_endpoints SET
            gc_interval_seconds = ?,
            gc_lightweight_interval_seconds = ?,
            cache_max_duration_seconds = ?,
            updated_at = CURRENT_TIMESTAMP
         WHERE id = ?",
        params![
            gc_interval_seconds,
            gc_lightweight_interval_seconds,
            cache_max_duration_seconds,
            endpoint_id,
        ],
    )?;
    Ok(())
}

pub fn update_gc_settings(
    db: &Db,
    endpoint_id: i64,
    gc_interval_seconds: i64,
    gc_lightweight_interval_seconds: i64,
    cache_max_duration_seconds: i64,
) -> VoloResult<()> {
    let conn = db.lock().unwrap();
    update_gc_settings_tx(
        &conn,
        endpoint_id,
        gc_interval_seconds,
        gc_lightweight_interval_seconds,
        cache_max_duration_seconds,
    )
}

/// Remember which tool-managed dedicated service account (if any) this
/// endpoint's service was last installed under, so the UI can show "already
/// created" instead of prompting to create a new one on every page load.
/// `cred_alias` points into `core::secrets::SecretStore`; the password
/// itself never touches this table.
pub fn update_service_account_tx(
    conn: &Connection,
    endpoint_id: i64,
    username: Option<&str>,
    cred_alias: Option<&str>,
) -> VoloResult<()> {
    conn.execute(
        "UPDATE zen_endpoints SET
            service_account_username = ?,
            service_account_cred_alias = ?,
            updated_at = CURRENT_TIMESTAMP
         WHERE id = ?",
        params![username, cred_alias, endpoint_id],
    )?;
    Ok(())
}

pub fn update_service_account(
    db: &Db,
    endpoint_id: i64,
    username: Option<&str>,
    cred_alias: Option<&str>,
) -> VoloResult<()> {
    let conn = db.lock().unwrap();
    update_service_account_tx(&conn, endpoint_id, username, cred_alias)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::{machines, open_in_memory, schema, Machine};

    fn setup() -> (Db, i64) {
        let db = open_in_memory().unwrap();
        {
            let mut conn = db.lock().unwrap();
            schema::migrate(&mut conn).unwrap();
        }
        let machine_id = machines::insert(&db, &Machine::new("ZEN-01", "192.168.10.30")).unwrap();
        (db, machine_id)
    }

    fn sample(machine_id: i64, port: i64) -> ZenEndpoint {
        ZenEndpoint {
            id: None,
            machine_id,
            declared_port: port,
            scheme: "http".into(),
            role: "primary".into(),
            upstream_endpoint_id: None,
            data_dir: "C:\\ZenData".into(),
            httpserverclass: "asio".into(),
            lifecycle_mode: "managed".into(),
            created_at: None,
            updated_at: None,
            install_dir: None,
            gc_interval_seconds: None,
            gc_lightweight_interval_seconds: None,
            cache_max_duration_seconds: None,
            service_account_username: None,
            service_account_cred_alias: None,
            config_path_override: None,
        }
    }

    #[test]
    fn upsert_creates_endpoint() {
        let (db, machine_id) = setup();
        let id = upsert(&db, &sample(machine_id, 8558)).unwrap();
        assert!(id > 0);
        let got = get(&db, id).unwrap().unwrap();
        assert_eq!(got.declared_port, 8558);
        assert_eq!(got.scheme, "http");
    }

    #[test]
    fn upsert_updates_on_machine_port_conflict() {
        let (db, machine_id) = setup();
        let id1 = upsert(&db, &sample(machine_id, 8558)).unwrap();
        let mut second = sample(machine_id, 8558);
        second.scheme = "https".into();
        second.lifecycle_mode = "external".into();
        let id2 = upsert(&db, &second).unwrap();
        assert_eq!(id1, id2);
        let got = get(&db, id1).unwrap().unwrap();
        assert_eq!(got.scheme, "https");
        assert_eq!(got.lifecycle_mode, "external");
    }

    #[test]
    fn upsert_clears_upstream_when_set_to_none() {
        // Operator topology change: a `shared_upstream` endpoint reconfigured
        // back to `local` must drop the stale upstream pointer, not keep it.
        let (db, machine_id) = setup();
        let upstream_id = upsert(&db, &sample(machine_id, 8559)).unwrap();
        let mut child = sample(machine_id, 8558);
        child.upstream_endpoint_id = Some(upstream_id);
        let child_id = upsert(&db, &child).unwrap();

        let mut refresh = sample(machine_id, 8558);
        refresh.upstream_endpoint_id = None;
        upsert(&db, &refresh).unwrap();
        let got = get(&db, child_id).unwrap().unwrap();
        assert!(got.upstream_endpoint_id.is_none());
    }

    #[test]
    fn unique_machine_port_constraint() {
        let (db, machine_id) = setup();
        upsert(&db, &sample(machine_id, 8558)).unwrap();
        // Different port for same machine creates a new row.
        upsert(&db, &sample(machine_id, 8559)).unwrap();
        let rows = list_for_machine(&db, machine_id).unwrap();
        assert_eq!(rows.len(), 2);
    }

    #[test]
    fn list_orders_by_id_asc() {
        let (db, machine_id) = setup();
        upsert(&db, &sample(machine_id, 8560)).unwrap();
        upsert(&db, &sample(machine_id, 8558)).unwrap();
        upsert(&db, &sample(machine_id, 8559)).unwrap();
        let rows = list(&db).unwrap();
        assert_eq!(rows.len(), 3);
        assert!(rows[0].id < rows[1].id);
        assert!(rows[1].id < rows[2].id);
    }

    #[test]
    fn insert_only_returns_existing_id_on_conflict_without_overwriting() {
        let (db, machine_id) = setup();
        let (id1, inserted1) = insert_only(&db, &sample(machine_id, 8558)).unwrap();
        assert!(inserted1);

        let mut second = sample(machine_id, 8558);
        second.scheme = "https".into();
        second.data_dir = "C:\\Other".into();
        let (id2, inserted2) = insert_only(&db, &second).unwrap();
        assert_eq!(id1, id2);
        assert!(!inserted2);

        // The original row is intact — conflict didn't overwrite.
        let got = get(&db, id1).unwrap().unwrap();
        assert_eq!(got.scheme, "http");
        assert_eq!(got.data_dir, "C:\\ZenData");
    }

    #[test]
    fn delete_removes_endpoint() {
        let (db, machine_id) = setup();
        let id = upsert(&db, &sample(machine_id, 8558)).unwrap();
        delete(&db, id).unwrap();
        assert!(get(&db, id).unwrap().is_none());
    }

    #[test]
    fn update_gc_settings_persists_all_three_fields() {
        let (db, machine_id) = setup();
        let id = upsert(&db, &sample(machine_id, 8558)).unwrap();
        update_gc_settings(&db, id, 28800, 3600, 864000).unwrap();
        let got = get(&db, id).unwrap().unwrap();
        assert_eq!(got.gc_interval_seconds, Some(28800));
        assert_eq!(got.gc_lightweight_interval_seconds, Some(3600));
        assert_eq!(got.cache_max_duration_seconds, Some(864000));
    }

    #[test]
    fn update_service_account_persists_username_and_alias() {
        let (db, machine_id) = setup();
        let id = upsert(&db, &sample(machine_id, 8558)).unwrap();
        update_service_account(&db, id, Some("zen-svc-ab12cd"), Some("zen-svc:1:zen-svc-ab12cd"))
            .unwrap();
        let got = get(&db, id).unwrap().unwrap();
        assert_eq!(got.service_account_username.as_deref(), Some("zen-svc-ab12cd"));
        assert_eq!(
            got.service_account_cred_alias.as_deref(),
            Some("zen-svc:1:zen-svc-ab12cd")
        );
    }

    #[test]
    fn update_service_account_can_clear_to_none() {
        let (db, machine_id) = setup();
        let id = upsert(&db, &sample(machine_id, 8558)).unwrap();
        update_service_account(&db, id, Some("zen-svc-ab12cd"), Some("alias")).unwrap();
        update_service_account(&db, id, None, None).unwrap();
        let got = get(&db, id).unwrap().unwrap();
        assert!(got.service_account_username.is_none());
        assert!(got.service_account_cred_alias.is_none());
    }
}
