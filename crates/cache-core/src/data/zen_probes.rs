//! CRUD for the `zen_probes` table (append-only time series).

use crate::data::Db;
use crate::error::UecmResult;
use rusqlite::params;
use serde::{Deserialize, Serialize};

// TODO(plan7 T1.10): if/when this struct is exposed via Tauri commands, wrap
// the BLOB fields with `#[serde(with = "serde_bytes")]` once `serde_bytes` is
// added to Cargo.toml. Default Vec<u8> serializes as a JSON number array,
// which bloats the wire considerably for probe payloads.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ZenProbe {
    pub id: Option<i64>,
    pub endpoint_id: i64,
    pub probed_at: Option<String>,
    pub reachable: bool,
    pub schema_version: i64,
    pub effective_port: Option<i64>,
    pub pid: Option<i64>,
    pub uptime_seconds: Option<i64>,
    pub data_root: Option<String>,
    pub is_dedicated: Option<bool>,
    pub build_version: Option<String>,
    pub health_info_cb: Option<Vec<u8>>,
    pub health_version_text: Option<String>,
    pub stats_providers_cb: Option<Vec<u8>>,
    pub error_message: Option<String>,
}

pub fn insert(db: &Db, probe: &ZenProbe) -> UecmResult<i64> {
    let conn = db.lock().unwrap();
    conn.execute(
        "INSERT INTO zen_probes (
            endpoint_id, probed_at, reachable, schema_version,
            effective_port, pid, uptime_seconds, data_root, is_dedicated,
            build_version, health_info_cb, health_version_text,
            stats_providers_cb, error_message
         )
         VALUES (?, COALESCE(?, CURRENT_TIMESTAMP), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            probe.endpoint_id,
            probe.probed_at,
            probe.reachable as i32,
            probe.schema_version,
            probe.effective_port,
            probe.pid,
            probe.uptime_seconds,
            probe.data_root,
            probe.is_dedicated.map(|b| b as i32),
            probe.build_version,
            probe.health_info_cb,
            probe.health_version_text,
            probe.stats_providers_cb,
            probe.error_message,
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn list(db: &Db) -> UecmResult<Vec<ZenProbe>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, endpoint_id, probed_at, reachable, schema_version,
                effective_port, pid, uptime_seconds, data_root, is_dedicated,
                build_version, health_info_cb, health_version_text,
                stats_providers_cb, error_message
         FROM zen_probes ORDER BY id ASC",
    )?;
    let rows = stmt.query_map([], zen_probe_from_row)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub fn list_recent(db: &Db, endpoint_id: i64, limit: i64) -> UecmResult<Vec<ZenProbe>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, endpoint_id, probed_at, reachable, schema_version,
                effective_port, pid, uptime_seconds, data_root, is_dedicated,
                build_version, health_info_cb, health_version_text,
                stats_providers_cb, error_message
         FROM zen_probes WHERE endpoint_id = ?
         ORDER BY probed_at DESC, id DESC
         LIMIT ?",
    )?;
    let rows = stmt.query_map(params![endpoint_id, limit], zen_probe_from_row)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub fn get(db: &Db, probe_id: i64) -> UecmResult<Option<ZenProbe>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, endpoint_id, probed_at, reachable, schema_version,
                effective_port, pid, uptime_seconds, data_root, is_dedicated,
                build_version, health_info_cb, health_version_text,
                stats_providers_cb, error_message
         FROM zen_probes WHERE id = ?",
    )?;
    let mut rows = stmt.query(params![probe_id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(zen_probe_from_row(row)?))
    } else {
        Ok(None)
    }
}

pub fn delete(db: &Db, probe_id: i64) -> UecmResult<()> {
    let conn = db.lock().unwrap();
    conn.execute("DELETE FROM zen_probes WHERE id = ?", params![probe_id])?;
    Ok(())
}

fn zen_probe_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ZenProbe> {
    let is_dedicated: Option<i64> = row.get(9)?;
    Ok(ZenProbe {
        id: Some(row.get(0)?),
        endpoint_id: row.get(1)?,
        probed_at: row.get(2)?,
        reachable: row.get::<_, i64>(3)? != 0,
        schema_version: row.get(4)?,
        effective_port: row.get(5)?,
        pid: row.get(6)?,
        uptime_seconds: row.get(7)?,
        data_root: row.get(8)?,
        is_dedicated: is_dedicated.map(|v| v != 0),
        build_version: row.get(10)?,
        health_info_cb: row.get(11)?,
        health_version_text: row.get(12)?,
        stats_providers_cb: row.get(13)?,
        error_message: row.get(14)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::{machines, open_in_memory, schema, zen_endpoints, Machine};

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

    fn sample(endpoint_id: i64, probed_at: Option<&str>, reachable: bool) -> ZenProbe {
        ZenProbe {
            id: None,
            endpoint_id,
            probed_at: probed_at.map(|s| s.to_string()),
            reachable,
            schema_version: 1,
            effective_port: Some(8558),
            pid: Some(1234),
            uptime_seconds: Some(60),
            data_root: Some("C:\\ZenData".into()),
            is_dedicated: Some(true),
            build_version: Some("zen-1.2.3".into()),
            health_info_cb: Some(vec![0x01, 0x02, 0x03]),
            health_version_text: Some("v1".into()),
            stats_providers_cb: Some(vec![0xAA, 0xBB]),
            error_message: None,
        }
    }

    #[test]
    fn insert_creates_probe_with_blobs() {
        let (db, endpoint_id) = setup();
        let id = insert(&db, &sample(endpoint_id, Some("2026-05-18T00:00:00Z"), true)).unwrap();
        let got = get(&db, id).unwrap().unwrap();
        assert_eq!(got.endpoint_id, endpoint_id);
        assert!(got.reachable);
        assert_eq!(got.health_info_cb.as_deref(), Some(&[0x01, 0x02, 0x03][..]));
        assert_eq!(got.stats_providers_cb.as_deref(), Some(&[0xAA, 0xBB][..]));
        assert_eq!(got.is_dedicated, Some(true));
    }

    #[test]
    fn insert_records_unreachable_probe() {
        let (db, endpoint_id) = setup();
        let mut p = sample(endpoint_id, Some("2026-05-18T00:00:00Z"), false);
        p.health_info_cb = None;
        p.stats_providers_cb = None;
        p.error_message = Some("connection refused".into());
        let id = insert(&db, &p).unwrap();
        let got = get(&db, id).unwrap().unwrap();
        assert!(!got.reachable);
        assert_eq!(got.error_message.as_deref(), Some("connection refused"));
        assert!(got.health_info_cb.is_none());
    }

    #[test]
    fn list_recent_returns_descending_limited() {
        let (db, endpoint_id) = setup();
        for ts in [
            "2026-05-18T00:00:01Z",
            "2026-05-18T00:00:02Z",
            "2026-05-18T00:00:03Z",
            "2026-05-18T00:00:04Z",
            "2026-05-18T00:00:05Z",
        ] {
            insert(&db, &sample(endpoint_id, Some(ts), true)).unwrap();
        }
        let recent = list_recent(&db, endpoint_id, 3).unwrap();
        assert_eq!(recent.len(), 3);
        assert_eq!(recent[0].probed_at.as_deref(), Some("2026-05-18T00:00:05Z"));
        assert_eq!(recent[1].probed_at.as_deref(), Some("2026-05-18T00:00:04Z"));
        assert_eq!(recent[2].probed_at.as_deref(), Some("2026-05-18T00:00:03Z"));
    }

    #[test]
    fn list_recent_isolates_by_endpoint() {
        let (db, endpoint_id) = setup();
        // second endpoint on same machine
        let other = {
            let conn = db.lock().unwrap();
            let machine_id: i64 = conn
                .query_row(
                    "SELECT machine_id FROM zen_endpoints WHERE id = ?",
                    params![endpoint_id],
                    |row| row.get(0),
                )
                .unwrap();
            drop(conn);
            zen_endpoints::upsert(
                &db,
                &zen_endpoints::ZenEndpoint {
                    id: None,
                    machine_id,
                    declared_port: 8559,
                    scheme: "http".into(),
                    role: "secondary".into(),
                    upstream_endpoint_id: None,
                    data_dir: "C:\\ZenData2".into(),
                    httpserverclass: "asio".into(),
                    lifecycle_mode: "managed".into(),
                    created_at: None,
                    updated_at: None,
                },
            )
            .unwrap()
        };
        insert(&db, &sample(endpoint_id, Some("2026-05-18T00:00:01Z"), true)).unwrap();
        insert(&db, &sample(other, Some("2026-05-18T00:00:02Z"), true)).unwrap();
        let recent = list_recent(&db, endpoint_id, 10).unwrap();
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].endpoint_id, endpoint_id);
    }

    #[test]
    fn delete_removes_probe() {
        let (db, endpoint_id) = setup();
        let id = insert(&db, &sample(endpoint_id, Some("2026-05-18T00:00:00Z"), true)).unwrap();
        delete(&db, id).unwrap();
        assert!(get(&db, id).unwrap().is_none());
    }

    #[test]
    fn list_returns_all_rows() {
        let (db, endpoint_id) = setup();
        insert(&db, &sample(endpoint_id, Some("2026-05-18T00:00:01Z"), true)).unwrap();
        insert(&db, &sample(endpoint_id, Some("2026-05-18T00:00:02Z"), false)).unwrap();
        let rows = list(&db).unwrap();
        assert_eq!(rows.len(), 2);
    }
}
