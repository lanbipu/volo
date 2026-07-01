//! CRUD for the `zen_cache_stats` table (append-only time series).

use crate::data::Db;
use crate::error::UecmResult;
use rusqlite::params;
use serde::{Deserialize, Serialize};

// TODO(plan7 T1.10): wrap `raw_cb` with `#[serde(with = "serde_bytes")]` once
// the crate is added; default Vec<u8> serializes as a JSON number array.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ZenCacheStats {
    pub id: Option<i64>,
    pub endpoint_id: i64,
    pub sampled_at: Option<String>,
    pub cache_hit_ratio: Option<f64>,
    pub cache_disk_size_bytes: Option<i64>,
    pub cache_memory_size_bytes: Option<i64>,
    pub provider_path: String,
    pub raw_cb: Vec<u8>,
    pub schema_version: i64,
}

pub fn insert(db: &Db, stats: &ZenCacheStats) -> UecmResult<i64> {
    let conn = db.lock().unwrap();
    conn.execute(
        "INSERT INTO zen_cache_stats (
            endpoint_id, sampled_at, cache_hit_ratio,
            cache_disk_size_bytes, cache_memory_size_bytes,
            provider_path, raw_cb, schema_version
         )
         VALUES (?, COALESCE(?, CURRENT_TIMESTAMP), ?, ?, ?, ?, ?, ?)",
        params![
            stats.endpoint_id,
            stats.sampled_at,
            stats.cache_hit_ratio,
            stats.cache_disk_size_bytes,
            stats.cache_memory_size_bytes,
            stats.provider_path,
            stats.raw_cb,
            stats.schema_version,
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn list(db: &Db) -> UecmResult<Vec<ZenCacheStats>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, endpoint_id, sampled_at, cache_hit_ratio,
                cache_disk_size_bytes, cache_memory_size_bytes,
                provider_path, raw_cb, schema_version
         FROM zen_cache_stats ORDER BY id ASC",
    )?;
    let rows = stmt.query_map([], zen_cache_stats_from_row)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub fn list_recent(db: &Db, endpoint_id: i64, limit: i64) -> UecmResult<Vec<ZenCacheStats>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, endpoint_id, sampled_at, cache_hit_ratio,
                cache_disk_size_bytes, cache_memory_size_bytes,
                provider_path, raw_cb, schema_version
         FROM zen_cache_stats WHERE endpoint_id = ?
         ORDER BY sampled_at DESC, id DESC
         LIMIT ?",
    )?;
    let rows = stmt.query_map(params![endpoint_id, limit], zen_cache_stats_from_row)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub fn get(db: &Db, stats_id: i64) -> UecmResult<Option<ZenCacheStats>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, endpoint_id, sampled_at, cache_hit_ratio,
                cache_disk_size_bytes, cache_memory_size_bytes,
                provider_path, raw_cb, schema_version
         FROM zen_cache_stats WHERE id = ?",
    )?;
    let mut rows = stmt.query(params![stats_id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(zen_cache_stats_from_row(row)?))
    } else {
        Ok(None)
    }
}

pub fn delete(db: &Db, stats_id: i64) -> UecmResult<()> {
    let conn = db.lock().unwrap();
    conn.execute(
        "DELETE FROM zen_cache_stats WHERE id = ?",
        params![stats_id],
    )?;
    Ok(())
}

fn zen_cache_stats_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ZenCacheStats> {
    Ok(ZenCacheStats {
        id: Some(row.get(0)?),
        endpoint_id: row.get(1)?,
        sampled_at: row.get(2)?,
        cache_hit_ratio: row.get(3)?,
        cache_disk_size_bytes: row.get(4)?,
        cache_memory_size_bytes: row.get(5)?,
        provider_path: row.get(6)?,
        raw_cb: row.get(7)?,
        schema_version: row.get(8)?,
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
                ..Default::default()
            },
        )
        .unwrap();
        (db, endpoint_id)
    }

    fn sample(endpoint_id: i64, sampled_at: Option<&str>) -> ZenCacheStats {
        ZenCacheStats {
            id: None,
            endpoint_id,
            sampled_at: sampled_at.map(|s| s.to_string()),
            cache_hit_ratio: Some(0.87),
            cache_disk_size_bytes: Some(123_456_789),
            cache_memory_size_bytes: Some(2_048),
            provider_path: "/stats/z$".into(),
            raw_cb: vec![0xDE, 0xAD, 0xBE, 0xEF],
            schema_version: 1,
        }
    }

    #[test]
    fn insert_creates_stats_with_blob() {
        let (db, endpoint_id) = setup();
        let id = insert(&db, &sample(endpoint_id, Some("2026-05-18T00:00:00Z"))).unwrap();
        let got = get(&db, id).unwrap().unwrap();
        assert_eq!(got.endpoint_id, endpoint_id);
        assert_eq!(got.cache_hit_ratio, Some(0.87));
        assert_eq!(got.raw_cb, vec![0xDE, 0xAD, 0xBE, 0xEF]);
        assert_eq!(got.provider_path, "/stats/z$");
    }

    #[test]
    fn list_recent_returns_descending_limited() {
        let (db, endpoint_id) = setup();
        for ts in [
            "2026-05-18T00:00:01Z",
            "2026-05-18T00:00:02Z",
            "2026-05-18T00:00:03Z",
            "2026-05-18T00:00:04Z",
        ] {
            insert(&db, &sample(endpoint_id, Some(ts))).unwrap();
        }
        let recent = list_recent(&db, endpoint_id, 2).unwrap();
        assert_eq!(recent.len(), 2);
        assert_eq!(recent[0].sampled_at.as_deref(), Some("2026-05-18T00:00:04Z"));
        assert_eq!(recent[1].sampled_at.as_deref(), Some("2026-05-18T00:00:03Z"));
    }

    #[test]
    fn list_recent_isolates_by_endpoint() {
        let (db, endpoint_id) = setup();
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
                    ..Default::default()
                },
            )
            .unwrap()
        };
        insert(&db, &sample(endpoint_id, Some("2026-05-18T00:00:01Z"))).unwrap();
        insert(&db, &sample(other, Some("2026-05-18T00:00:02Z"))).unwrap();
        let recent = list_recent(&db, endpoint_id, 10).unwrap();
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].endpoint_id, endpoint_id);
    }

    #[test]
    fn delete_removes_stats_row() {
        let (db, endpoint_id) = setup();
        let id = insert(&db, &sample(endpoint_id, Some("2026-05-18T00:00:00Z"))).unwrap();
        delete(&db, id).unwrap();
        assert!(get(&db, id).unwrap().is_none());
    }

    #[test]
    fn list_returns_all_rows() {
        let (db, endpoint_id) = setup();
        insert(&db, &sample(endpoint_id, Some("2026-05-18T00:00:01Z"))).unwrap();
        insert(&db, &sample(endpoint_id, Some("2026-05-18T00:00:02Z"))).unwrap();
        let rows = list(&db).unwrap();
        assert_eq!(rows.len(), 2);
    }
}
