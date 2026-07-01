//! Cross-machine consistency probe: UE version / Plugin version / RHI / GPU /
//! Driver across N hosts. snapshot() invokes the PS sidecar; compare() is a
//! pure function over the resulting snapshots.

use crate::core::ssh::{run_json, NodeScript, RemoteExecutor};
use crate::error::{VoloError, VoloResult};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct UeInstall {
    #[serde(rename = "Version")] pub version: String,
    #[serde(rename = "Path")] pub path: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct GpuInfo {
    #[serde(rename = "Name")] pub name: String,
    #[serde(rename = "Driver")] pub driver: String,
    #[serde(rename = "DriverDate")] pub driver_date: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ProjectDir {
    #[serde(rename = "Path")] pub path: String,
    #[serde(rename = "UProject")] pub uproject: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct HostSnapshot {
    pub host: String,
    pub ue_installs: Vec<UeInstall>,
    pub gpu: Option<GpuInfo>,
    pub rhi: Option<String>,
    pub projects: Vec<ProjectDir>,
    pub renderstream_version: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ScriptResult {
    ok: bool,
    data: Option<HostSnapshot>,
    message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Inconsistency {
    UeVersionMismatch { found: BTreeMap<String, Vec<String>> },
    RenderStreamVersionMismatch { found: BTreeMap<String, Vec<String>> },
    RhiMismatch { found: BTreeMap<String, Vec<String>> },
    GpuModelMismatch { found: BTreeMap<String, Vec<String>> },
    GpuDriverMismatch { found: BTreeMap<String, Vec<String>> },
    MissingUe { hosts: Vec<String> },
}

pub fn snapshot(exec: &dyn RemoteExecutor, host: &str) -> VoloResult<HostSnapshot> {
    let r: ScriptResult = run_json(
        exec,
        host,
        &NodeScript {
            name: "consistency-snapshot.ps1",
            args: serde_json::json!({}),
            ssh_user: None,
        },
    )?;
    if !r.ok {
        return Err(VoloError::OperationFailed(r.message.unwrap_or_default()));
    }
    let mut snap = r.data.ok_or_else(|| VoloError::OperationFailed("no data".into()))?;
    snap.host = host.to_string();
    Ok(snap)
}

pub fn compare(snaps: &[HostSnapshot]) -> Vec<Inconsistency> {
    let mut out = Vec::new();

    // UE versions (highest installed per host)
    let mut ue_versions: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut missing_ue: Vec<String> = Vec::new();
    for s in snaps {
        if let Some(latest) = s.ue_installs.iter().map(|u| u.version.clone()).max() {
            ue_versions.entry(latest).or_default().push(s.host.clone());
        } else {
            missing_ue.push(s.host.clone());
        }
    }
    if ue_versions.len() > 1 {
        out.push(Inconsistency::UeVersionMismatch { found: ue_versions });
    }
    if !missing_ue.is_empty() {
        out.push(Inconsistency::MissingUe { hosts: missing_ue });
    }

    // RS version
    let mut rs: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for s in snaps {
        rs.entry(s.renderstream_version.clone().unwrap_or_else(|| "(none)".into()))
            .or_default()
            .push(s.host.clone());
    }
    if rs.len() > 1 {
        out.push(Inconsistency::RenderStreamVersionMismatch { found: rs });
    }

    // RHI
    let mut rhi: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for s in snaps {
        rhi.entry(s.rhi.clone().unwrap_or_else(|| "(default)".into()))
            .or_default()
            .push(s.host.clone());
    }
    if rhi.len() > 1 {
        out.push(Inconsistency::RhiMismatch { found: rhi });
    }

    // GPU model + driver
    let mut models: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut drivers: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for s in snaps {
        let g = s.gpu.as_ref();
        models
            .entry(g.map(|g| g.name.clone()).unwrap_or_else(|| "(unknown)".into()))
            .or_default()
            .push(s.host.clone());
        drivers
            .entry(g.map(|g| g.driver.clone()).unwrap_or_else(|| "(unknown)".into()))
            .or_default()
            .push(s.host.clone());
    }
    if models.len() > 1 {
        out.push(Inconsistency::GpuModelMismatch { found: models });
    }
    if drivers.len() > 1 {
        out.push(Inconsistency::GpuDriverMismatch { found: drivers });
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::ssh::{NodeScript, ProbeResult, RemoteExecutor, ScriptOutput};

    struct FakeExec(String);
    impl RemoteExecutor for FakeExec {
        fn run(&self, _h: &str, _s: &NodeScript) -> VoloResult<ScriptOutput> {
            Ok(ScriptOutput { stdout: self.0.clone(), stderr: String::new(), exit_code: 0 })
        }
        fn probe(&self, _h: &str, _u: Option<&str>) -> VoloResult<ProbeResult> {
            unreachable!()
        }
    }

    #[test]
    fn snapshot_parses_and_sets_host() {
        let exec = FakeExec(
            r#"{"ok":true,"data":{"host":"NODE","ue_installs":[{"Version":"5.4","Path":"C:\\UE"}],"gpu":null,"rhi":"DX12","projects":[],"renderstream_version":null}}"#
                .to_string(),
        );
        let s = snapshot(&exec, "RENDER-07").unwrap();
        assert_eq!(s.host, "RENDER-07"); // overridden from arg, not the script's "NODE"
        assert_eq!(s.ue_installs.len(), 1);
        assert_eq!(s.rhi.as_deref(), Some("DX12"));
    }

    fn snap(host: &str, ue: &str, gpu_name: &str, drv: &str, rs: Option<&str>) -> HostSnapshot {
        HostSnapshot {
            host: host.into(),
            ue_installs: vec![UeInstall { version: ue.into(), path: "C:\\UE".into() }],
            gpu: Some(GpuInfo {
                name: gpu_name.into(),
                driver: drv.into(),
                driver_date: "".into(),
            }),
            rhi: Some("D3D12".into()),
            projects: vec![],
            renderstream_version: rs.map(String::from),
        }
    }

    #[test]
    fn matched_cluster_returns_no_findings() {
        let snaps = vec![
            snap("A", "5.5", "RTX 4090", "555.85", Some("r24")),
            snap("B", "5.5", "RTX 4090", "555.85", Some("r24")),
        ];
        assert!(compare(&snaps).is_empty());
    }

    #[test]
    fn detects_ue_version_mismatch() {
        let snaps = vec![
            snap("A", "5.5", "RTX 4090", "555.85", Some("r24")),
            snap("B", "5.4", "RTX 4090", "555.85", Some("r24")),
        ];
        let f = compare(&snaps);
        assert!(f.iter().any(|x| matches!(x, Inconsistency::UeVersionMismatch { .. })));
    }

    #[test]
    fn detects_driver_mismatch() {
        let snaps = vec![
            snap("A", "5.5", "RTX 4090", "555.85", Some("r24")),
            snap("B", "5.5", "RTX 4090", "537.42", Some("r24")),
        ];
        let f = compare(&snaps);
        assert!(f.iter().any(|x| matches!(x, Inconsistency::GpuDriverMismatch { .. })));
    }

    #[test]
    fn detects_gpu_model_mismatch() {
        let snaps = vec![
            snap("A", "5.5", "RTX 4090", "555.85", Some("r24")),
            snap("B", "5.5", "RTX 3090", "555.85", Some("r24")),
        ];
        let f = compare(&snaps);
        assert!(f.iter().any(|x| matches!(x, Inconsistency::GpuModelMismatch { .. })));
    }

    #[test]
    fn detects_renderstream_version_mismatch() {
        let snaps = vec![
            snap("A", "5.5", "RTX 4090", "555.85", Some("r24")),
            snap("B", "5.5", "RTX 4090", "555.85", Some("r23")),
        ];
        let f = compare(&snaps);
        assert!(f.iter().any(|x| matches!(x, Inconsistency::RenderStreamVersionMismatch { .. })));
    }
}
