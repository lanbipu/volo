//! GPU/driver consistency matrix for PSO cache safety checks.

use crate::data::{machine_gpus, machines, Db, GpuInfo, GpuVendor};
use crate::error::UecmResult;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash, schemars::JsonSchema)]
pub struct GpuSignature {
    pub vendor: String,
    pub model: String,
    pub driver: String,
}

impl GpuSignature {
    pub fn as_string(&self) -> String {
        format!(
            "{}:{}:{}",
            normalize_signature_component(&self.vendor),
            normalize_signature_component(&self.model),
            normalize_signature_component(&self.driver)
        )
    }
}

pub fn normalize_signature_string(value: &str) -> String {
    value
        .split(':')
        .map(normalize_signature_component)
        .collect::<Vec<_>>()
        .join(":")
}

fn normalize_signature_component(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase()
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CellStatus {
    Match,
    Deviation,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
pub struct MachineGpuCell {
    pub machine_id: i64,
    pub hostname: String,
    pub signature: Option<GpuSignature>,
    pub status: CellStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
pub struct GpuSignatureCount {
    pub signature: GpuSignature,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
pub struct GpuMatrix {
    pub signatures: Vec<GpuSignatureCount>,
    pub baseline: Option<GpuSignature>,
    pub cells: Vec<MachineGpuCell>,
}

pub fn build_matrix(db: &Db) -> UecmResult<GpuMatrix> {
    let machines = machines::list_all(db)?;
    let mut by_machine = HashMap::<i64, GpuSignature>::new();
    let mut counts = HashMap::<GpuSignature, i64>::new();

    for machine in &machines {
        let Some(machine_id) = machine.id else {
            continue;
        };
        let gpus = machine_gpus::list_for_machine(db, machine_id)?;
        let Some(gpu) = gpus.first() else {
            continue;
        };
        let signature = signature_from_gpu(gpu);
        by_machine.insert(machine_id, signature.clone());
        *counts.entry(signature).or_insert(0) += 1;
    }

    let mut signatures: Vec<_> = counts
        .into_iter()
        .map(|(signature, count)| GpuSignatureCount { signature, count })
        .collect();
    signatures.sort_by(|left, right| {
        right
            .count
            .cmp(&left.count)
            .then_with(|| left.signature.as_string().cmp(&right.signature.as_string()))
    });
    let baseline = signatures.first().map(|entry| entry.signature.clone());

    let cells = machines
        .into_iter()
        .filter_map(|machine| {
            let machine_id = machine.id?;
            let signature = by_machine.get(&machine_id).cloned();
            let status = match (&signature, &baseline) {
                (None, _) => CellStatus::Unknown,
                (Some(signature), Some(baseline)) if signature == baseline => CellStatus::Match,
                _ => CellStatus::Deviation,
            };
            Some(MachineGpuCell {
                machine_id,
                hostname: machine.hostname,
                signature,
                status,
            })
        })
        .collect();

    Ok(GpuMatrix {
        signatures,
        baseline,
        cells,
    })
}

pub fn signature_from_gpu(gpu: &GpuInfo) -> GpuSignature {
    GpuSignature {
        vendor: vendor_label(gpu.vendor).into(),
        model: normalize_signature_component(&gpu.gpu_model),
        driver: normalize_signature_component(&gpu.driver_version),
    }
}

fn vendor_label(vendor: GpuVendor) -> &'static str {
    match vendor {
        GpuVendor::Nvidia => "nvidia",
        GpuVendor::Amd => "amd",
        GpuVendor::Intel => "intel",
        GpuVendor::Unknown => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::{machine_gpus, machines, open_in_memory, schema, GpuInfo, Machine};

    fn setup() -> Db {
        let db = open_in_memory().unwrap();
        {
            let mut conn = db.lock().unwrap();
            schema::migrate(&mut conn).unwrap();
        }
        db
    }

    fn seed(db: &Db, hostname: &str, ip: &str, model: &str, driver: &str) -> i64 {
        let machine_id = machines::insert(db, &Machine::new(hostname, ip)).unwrap();
        machine_gpus::insert(
            db,
            &GpuInfo {
                id: None,
                machine_id,
                gpu_model: model.into(),
                driver_version: driver.into(),
                vendor: GpuVendor::Nvidia,
                vram_mb: Some(24576),
            },
        )
        .unwrap();
        machine_id
    }

    #[test]
    fn baseline_picks_majority_signature() {
        let db = setup();
        seed(&db, "A", "1.1.1.1", "RTX 3080", "535.98");
        seed(&db, "B", "2.2.2.2", "RTX 3080", "535.98");
        seed(&db, "C", "3.3.3.3", "RTX 4090", "560.00");

        let matrix = build_matrix(&db).unwrap();
        assert_eq!(matrix.baseline.unwrap().model, "rtx 3080");
        assert_eq!(
            matrix
                .cells
                .iter()
                .filter(|cell| cell.status == CellStatus::Match)
                .count(),
            2
        );
        assert_eq!(
            matrix
                .cells
                .iter()
                .filter(|cell| cell.status == CellStatus::Deviation)
                .count(),
            1
        );
    }

    #[test]
    fn machine_without_gpu_row_is_unknown() {
        let db = setup();
        seed(&db, "A", "1.1.1.1", "RTX 3080", "535.98");
        machines::insert(&db, &Machine::new("B", "2.2.2.2")).unwrap();

        let matrix = build_matrix(&db).unwrap();
        let cell = matrix.cells.iter().find(|cell| cell.hostname == "B").unwrap();
        assert_eq!(cell.status, CellStatus::Unknown);
    }

    #[test]
    fn empty_db_returns_empty_matrix() {
        let db = setup();
        let matrix = build_matrix(&db).unwrap();
        assert!(matrix.signatures.is_empty());
        assert!(matrix.baseline.is_none());
        assert!(matrix.cells.is_empty());
    }

    #[test]
    fn signatures_are_trimmed_and_case_insensitive() {
        let db = setup();
        seed(&db, "A", "1.1.1.1", " RTX 3080 ", "535.98 ");
        seed(&db, "B", "2.2.2.2", "rtx   3080", " 535.98");

        let matrix = build_matrix(&db).unwrap();
        assert_eq!(matrix.signatures.len(), 1);
        assert_eq!(
            matrix.signatures[0].signature.as_string(),
            "nvidia:rtx 3080:535.98"
        );
        assert!(matrix
            .cells
            .iter()
            .all(|cell| cell.status == CellStatus::Match));
    }
}
