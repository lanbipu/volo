//! CRUD for the `machine_gpus` table.

use crate::data::Db;
use crate::error::VoloResult;
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GpuVendor {
    Nvidia,
    Amd,
    Intel,
    Unknown,
}

impl GpuVendor {
    fn as_sql(self) -> &'static str {
        match self {
            GpuVendor::Nvidia => "nvidia",
            GpuVendor::Amd => "amd",
            GpuVendor::Intel => "intel",
            GpuVendor::Unknown => "unknown",
        }
    }

    fn from_sql(s: &str) -> Self {
        match s {
            "nvidia" => GpuVendor::Nvidia,
            "amd" => GpuVendor::Amd,
            "intel" => GpuVendor::Intel,
            _ => GpuVendor::Unknown,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GpuInfo {
    pub id: Option<i64>,
    pub machine_id: i64,
    pub gpu_model: String,
    pub driver_version: String,
    pub vendor: GpuVendor,
    pub vram_mb: Option<i64>,
}

pub fn insert(db: &Db, gpu: &GpuInfo) -> VoloResult<i64> {
    let conn = db.lock().unwrap();
    conn.execute(
        "INSERT INTO machine_gpus (machine_id, gpu_model, driver_version, vendor, vram_mb)
         VALUES (?, ?, ?, ?, ?)",
        params![
            gpu.machine_id,
            gpu.gpu_model,
            gpu.driver_version,
            gpu.vendor.as_sql(),
            gpu.vram_mb,
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn list_for_machine(db: &Db, machine_id: i64) -> VoloResult<Vec<GpuInfo>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, machine_id, gpu_model, driver_version, vendor, vram_mb
         FROM machine_gpus WHERE machine_id = ? ORDER BY id",
    )?;
    let rows = stmt.query_map(params![machine_id], |row| {
        Ok(GpuInfo {
            id: Some(row.get(0)?),
            machine_id: row.get(1)?,
            gpu_model: row.get(2)?,
            driver_version: row.get(3)?,
            vendor: GpuVendor::from_sql(&row.get::<_, String>(4)?),
            vram_mb: row.get(5)?,
        })
    })?;
    let mut result = Vec::new();
    for r in rows {
        result.push(r?);
    }
    Ok(result)
}

pub fn replace_for_machine(db: &Db, machine_id: i64, gpus: &[GpuInfo]) -> VoloResult<()> {
    let mut conn = db.lock().unwrap();
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM machine_gpus WHERE machine_id = ?", params![machine_id])?;
    for gpu in gpus {
        tx.execute(
            "INSERT INTO machine_gpus (machine_id, gpu_model, driver_version, vendor, vram_mb)
             VALUES (?, ?, ?, ?, ?)",
            params![
                machine_id,
                gpu.gpu_model,
                gpu.driver_version,
                gpu.vendor.as_sql(),
                gpu.vram_mb,
            ],
        )?;
    }
    tx.commit()?;
    Ok(())
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
        let machine_id = machines::insert(
            &db,
            &Machine::new("RENDER-01", "192.168.10.21"),
        )
        .unwrap();
        (db, machine_id)
    }

    fn sample_gpu(machine_id: i64, model: &str) -> GpuInfo {
        GpuInfo {
            id: None,
            machine_id,
            gpu_model: model.to_string(),
            driver_version: "551.86".to_string(),
            vendor: GpuVendor::Nvidia,
            vram_mb: Some(24576),
        }
    }

    #[test]
    fn insert_returns_new_id() {
        let (db, machine_id) = setup();
        let id = insert(&db, &sample_gpu(machine_id, "RTX 4090")).unwrap();
        assert!(id > 0);
    }

    #[test]
    fn list_for_machine_returns_inserted_gpus() {
        let (db, machine_id) = setup();
        insert(&db, &sample_gpu(machine_id, "RTX 4090")).unwrap();
        insert(&db, &sample_gpu(machine_id, "RTX 4080")).unwrap();
        let gpus = list_for_machine(&db, machine_id).unwrap();
        assert_eq!(gpus.len(), 2);
    }

    #[test]
    fn replace_for_machine_atomically_swaps_gpu_set() {
        let (db, machine_id) = setup();
        insert(&db, &sample_gpu(machine_id, "RTX 4090")).unwrap();
        insert(&db, &sample_gpu(machine_id, "RTX 4080")).unwrap();

        replace_for_machine(&db, machine_id, &[sample_gpu(machine_id, "RTX 5090")]).unwrap();

        let gpus = list_for_machine(&db, machine_id).unwrap();
        assert_eq!(gpus.len(), 1);
        assert_eq!(gpus[0].gpu_model, "RTX 5090");
    }
}
