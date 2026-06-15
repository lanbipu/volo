//! CRUD for the `pso_cache_files` table.

use crate::data::Db;
use crate::error::UecmResult;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, schemars::JsonSchema)]
pub struct PsoCacheFile {
    pub id: Option<i64>,
    pub project_id: i64,
    pub source_machine_id: i64,
    pub file_path: String,
    pub file_name: String,
    pub size_bytes: i64,
    pub gpu_signature: String,
    pub ue_version: Option<String>,
    pub collected_at: Option<String>,
}

pub fn upsert(db: &Db, file: &PsoCacheFile) -> UecmResult<i64> {
    let conn = db.lock().unwrap();
    conn.execute(
        "INSERT INTO pso_cache_files
         (project_id, source_machine_id, file_path, file_name, size_bytes, gpu_signature, ue_version)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, source_machine_id, file_name) DO UPDATE SET
           file_path = excluded.file_path,
           size_bytes = excluded.size_bytes,
           gpu_signature = excluded.gpu_signature,
           ue_version = COALESCE(excluded.ue_version, pso_cache_files.ue_version),
           collected_at = CURRENT_TIMESTAMP",
        rusqlite::params![
            file.project_id,
            file.source_machine_id,
            file.file_path,
            file.file_name,
            file.size_bytes,
            file.gpu_signature,
            file.ue_version,
        ],
    )?;
    let id = conn.query_row(
        "SELECT id FROM pso_cache_files
         WHERE project_id = ? AND source_machine_id = ? AND file_name = ?",
        rusqlite::params![file.project_id, file.source_machine_id, file.file_name],
        |row| row.get(0),
    )?;
    Ok(id)
}

pub fn list_by_project(db: &Db, project_id: i64) -> UecmResult<Vec<PsoCacheFile>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, project_id, source_machine_id, file_path, file_name, size_bytes, gpu_signature, ue_version, collected_at
         FROM pso_cache_files
         WHERE project_id = ?
         ORDER BY collected_at DESC, id DESC",
    )?;
    let rows = stmt.query_map([project_id], row_to_file)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub fn get(db: &Db, file_id: i64) -> UecmResult<Option<PsoCacheFile>> {
    let conn = db.lock().unwrap();
    let result = conn.query_row(
        "SELECT id, project_id, source_machine_id, file_path, file_name, size_bytes, gpu_signature, ue_version, collected_at
         FROM pso_cache_files WHERE id = ?",
        [file_id],
        row_to_file,
    );
    match result {
        Ok(file) => Ok(Some(file)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(err) => Err(err.into()),
    }
}

pub fn delete(db: &Db, file_id: i64) -> UecmResult<()> {
    let conn = db.lock().unwrap();
    conn.execute("DELETE FROM pso_cache_files WHERE id = ?", [file_id])?;
    Ok(())
}

fn row_to_file(row: &rusqlite::Row<'_>) -> rusqlite::Result<PsoCacheFile> {
    Ok(PsoCacheFile {
        id: Some(row.get(0)?),
        project_id: row.get(1)?,
        source_machine_id: row.get(2)?,
        file_path: row.get(3)?,
        file_name: row.get(4)?,
        size_bytes: row.get(5)?,
        gpu_signature: row.get(6)?,
        ue_version: row.get(7)?,
        collected_at: row.get(8)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::{machines, open_in_memory, projects, schema, Machine, Project};

    fn setup() -> (Db, i64, i64) {
        let db = open_in_memory().unwrap();
        {
            let mut conn = db.lock().unwrap();
            schema::migrate(&mut conn).unwrap();
        }
        let machine_id = machines::insert(&db, &Machine::new("RENDER-01", "192.168.10.21")).unwrap();
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
        (db, machine_id, project_id)
    }

    fn sample(project_id: i64, machine_id: i64, file_name: &str) -> PsoCacheFile {
        PsoCacheFile {
            id: None,
            project_id,
            source_machine_id: machine_id,
            file_path: format!("D:\\Plurality\\Saved\\CollectedPSOs\\{}", file_name),
            file_name: file_name.into(),
            size_bytes: 1024,
            gpu_signature: "nvidia:RTX 4090:551.86".into(),
            ue_version: Some("5.4.4".into()),
            collected_at: None,
        }
    }

    #[test]
    fn upsert_is_idempotent_on_project_machine_file() {
        let (db, machine_id, project_id) = setup();
        let file = sample(project_id, machine_id, "Plurality.upipelinecache");
        let first = upsert(&db, &file).unwrap();
        let second = upsert(&db, &file).unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn list_by_project_filters_rows() {
        let (db, machine_id, project_id) = setup();
        upsert(&db, &sample(project_id, machine_id, "a.upipelinecache")).unwrap();
        let rows = list_by_project(&db, project_id).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].file_name, "a.upipelinecache");
    }

    #[test]
    fn get_returns_none_for_missing_id() {
        let (db, _, _) = setup();
        assert!(get(&db, 999).unwrap().is_none());
    }
}
