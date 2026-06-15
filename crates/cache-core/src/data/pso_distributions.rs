//! CRUD for the `pso_distributions` table.

use crate::data::Db;
use crate::error::UecmResult;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DistributionStatus {
    Pending,
    Running,
    Ok,
    Err,
    Cancelled,
}

impl DistributionStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            DistributionStatus::Pending => "pending",
            DistributionStatus::Running => "running",
            DistributionStatus::Ok => "ok",
            DistributionStatus::Err => "err",
            DistributionStatus::Cancelled => "cancelled",
        }
    }

    fn from_sql(value: &str) -> Self {
        match value {
            "running" => DistributionStatus::Running,
            "ok" => DistributionStatus::Ok,
            "err" => DistributionStatus::Err,
            "cancelled" => DistributionStatus::Cancelled,
            _ => DistributionStatus::Pending,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PsoDistribution {
    pub id: Option<i64>,
    pub pso_cache_file_id: i64,
    pub target_machine_id: i64,
    pub status: DistributionStatus,
    pub bytes_copied: i64,
    pub distributed_at: Option<String>,
    pub error_message: Option<String>,
    pub created_at: Option<String>,
}

pub fn upsert(db: &Db, distribution: &PsoDistribution) -> UecmResult<i64> {
    let conn = db.lock().unwrap();
    conn.execute(
        "INSERT INTO pso_distributions
         (pso_cache_file_id, target_machine_id, status, bytes_copied, distributed_at, error_message)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(pso_cache_file_id, target_machine_id) DO UPDATE SET
           status = excluded.status,
           bytes_copied = excluded.bytes_copied,
           distributed_at = excluded.distributed_at,
           error_message = excluded.error_message",
        rusqlite::params![
            distribution.pso_cache_file_id,
            distribution.target_machine_id,
            distribution.status.as_str(),
            distribution.bytes_copied,
            distribution.distributed_at,
            distribution.error_message,
        ],
    )?;
    let id = conn.query_row(
        "SELECT id FROM pso_distributions WHERE pso_cache_file_id = ? AND target_machine_id = ?",
        rusqlite::params![distribution.pso_cache_file_id, distribution.target_machine_id],
        |row| row.get(0),
    )?;
    Ok(id)
}

pub fn list_for_file(db: &Db, file_id: i64) -> UecmResult<Vec<PsoDistribution>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, pso_cache_file_id, target_machine_id, status, bytes_copied, distributed_at, error_message, created_at
         FROM pso_distributions
         WHERE pso_cache_file_id = ?
         ORDER BY target_machine_id",
    )?;
    let rows = stmt.query_map([file_id], |row| {
        let status: String = row.get(3)?;
        Ok(PsoDistribution {
            id: Some(row.get(0)?),
            pso_cache_file_id: row.get(1)?,
            target_machine_id: row.get(2)?,
            status: DistributionStatus::from_sql(&status),
            bytes_copied: row.get(4)?,
            distributed_at: row.get(5)?,
            error_message: row.get(6)?,
            created_at: row.get(7)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::{machines, open_in_memory, projects, pso_cache_files, schema, Machine, Project};

    fn setup() -> (Db, i64, i64) {
        let db = open_in_memory().unwrap();
        {
            let mut conn = db.lock().unwrap();
            schema::migrate(&mut conn).unwrap();
        }
        let source_id = machines::insert(&db, &Machine::new("SOURCE", "192.168.10.21")).unwrap();
        let target_id = machines::insert(&db, &Machine::new("TARGET", "192.168.10.22")).unwrap();
        let project_id = projects::upsert(
            &db,
            &Project {
                id: None,
                uproject_name: "PluralityProject.uproject".into(),
                uproject_stem_lower: "pluralityproject".into(),
                uproject_guid: None,
                display_name: None,
                first_seen_at: None,
                last_seen_at: None,
                ue_version_major: None,
                ue_version_minor: None,
                engine_association_raw: None,
                engine_association_kind: None,
            },
        )
        .unwrap();
        let file_id = pso_cache_files::upsert(
            &db,
            &pso_cache_files::PsoCacheFile {
                id: None,
                project_id,
                source_machine_id: source_id,
                file_path: "D:\\Plurality\\Saved\\CollectedPSOs\\a.upipelinecache".into(),
                file_name: "a.upipelinecache".into(),
                size_bytes: 1024,
                gpu_signature: "nvidia:RTX 4090:551.86".into(),
                ue_version: None,
                collected_at: None,
            },
        )
        .unwrap();
        (db, file_id, target_id)
    }

    #[test]
    fn upsert_status_change_persists() {
        let (db, file_id, target_id) = setup();
        let first = upsert(
            &db,
            &PsoDistribution {
                id: None,
                pso_cache_file_id: file_id,
                target_machine_id: target_id,
                status: DistributionStatus::Running,
                bytes_copied: 0,
                distributed_at: None,
                error_message: None,
                created_at: None,
            },
        )
        .unwrap();
        let second = upsert(
            &db,
            &PsoDistribution {
                id: None,
                pso_cache_file_id: file_id,
                target_machine_id: target_id,
                status: DistributionStatus::Ok,
                bytes_copied: 1024,
                distributed_at: Some("2026-05-05T00:00:00Z".into()),
                error_message: None,
                created_at: None,
            },
        )
        .unwrap();
        assert_eq!(first, second);
        let rows = list_for_file(&db, file_id).unwrap();
        assert_eq!(rows[0].status, DistributionStatus::Ok);
        assert_eq!(rows[0].bytes_copied, 1024);
    }
}
