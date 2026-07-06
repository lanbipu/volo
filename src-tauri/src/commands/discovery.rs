//! Tauri commands for network scan + per-machine refresh.

use cache_core::core::ssh::{RemoteExecutor, SshExecutor};
use cache_core::core::{discovery, network};
use cache_core::data::{
    machine_gpus, machine_ue_installs, machines as data_machines, Db, GpuInfo, Machine, UeInstall,
};
use cache_core::error::{VoloError, VoloResult};
use serde::Serialize;
use tauri::State;

#[derive(Debug, Serialize)]
pub struct ScanResult {
    pub probed: Vec<network::ProbedHost>,
}

#[tauri::command]
pub async fn scan_network(cidr: String) -> VoloResult<ScanResult> {
    let probed = network::scan_cidr(&cidr, network::DEFAULT_TIMEOUT_MS).await?;
    Ok(ScanResult { probed })
}

/// Adds a discovered IP as a Machine row (or no-op if already present).
/// hostname defaults to the IP — caller can rename later.
#[tauri::command]
pub fn add_discovered_machine(
    db: State<'_, Db>,
    ip: String,
    hostname: Option<String>,
) -> VoloResult<i64> {
    if let Some(existing) = data_machines::find_by_ip(&db, &ip)? {
        // SQLite-loaded rows always have id; the Option exists only for the
        // pre-insert sentinel state of `Machine::new`.
        return Ok(existing.id.expect("machine row from SQLite must have id"));
    }
    let display_name = hostname.unwrap_or_else(|| ip.clone());
    let machine = Machine::new(&display_name, &ip);
    data_machines::insert(&db, &machine)
}

#[derive(Debug, Serialize)]
pub struct RefreshResult {
    pub machine_id: i64,
    pub winrm_ok: bool,
    pub ue_installs: Vec<UeInstall>,
    pub gpus: Vec<GpuInfo>,
    pub error: Option<String>,
}

fn refresh_err(machine_id: i64, winrm_ok: bool, msg: impl Into<String>) -> RefreshResult {
    RefreshResult {
        machine_id,
        winrm_ok,
        ue_installs: vec![],
        gpus: vec![],
        error: Some(msg.into()),
    }
}

/// Probes WinRM connectivity to a known machine, then re-queries UE + GPU
/// info if reachable, persisting results into the data layer.
///
/// Order matters here:
/// 1. Probe + `mark_seen` first — UI online/offline badge stays correct even
///    when a later detection step fails.
/// 2. UE detect + persist BEFORE GPU detect — if GPU detection blows up, the
///    UE list we already saved survives instead of being discarded.
#[tauri::command]
pub async fn refresh_machine(db: State<'_, Db>, machine_id: i64) -> VoloResult<RefreshResult> {
    let db: Db = (*db).clone();
    tokio::task::spawn_blocking(move || {
    let machine = data_machines::find_by_id(&db, machine_id)?
        .ok_or_else(|| VoloError::InvalidInput(format!("machine {} not found", machine_id)))?;

    // Probe + mark online/offline immediately so the UI badge is correct even
    // when subsequent detection steps fail. SSH key auth (uecm-svc); the exec is
    // reused for UE/GPU detection below. (RefreshResult.winrm_ok kept as the
    // Vue-facing field name per the migration contract.)
    let exec = SshExecutor::from_config()?;
    match exec.probe(&machine.ip, None) {
        Ok(p) if p.ok => {
            data_machines::mark_seen(&db, machine_id, "online")?;
        }
        Ok(_) => {
            data_machines::mark_seen(&db, machine_id, "offline")?;
            return Ok(refresh_err(machine_id, false, "node unreachable over SSH"));
        }
        Err(e) => {
            data_machines::mark_seen(&db, machine_id, "offline")?;
            return Ok(refresh_err(machine_id, false, format!("probe failed: {}", e)));
        }
    }

    // UE detect + persist BEFORE GPU detect — partial-failure tolerance.
    let detected_ue = match discovery::detect_ue_versions(&exec, &machine.ip) {
        Ok(v) => v,
        Err(e) => return Ok(refresh_err(machine_id, true, format!("UE detection failed: {}", e))),
    };
    // Numerical primary selection (mirrors cli/domain_machine.rs::refresh):
    // string-compare puts "4.9" > "4.27" and would put "5.10" < "5.8" once UE 5.10 ships.
    fn parse_version(v: &str) -> (u32, u32) {
        let mut parts = v.split('.');
        let major = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        let minor = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        (major, minor)
    }
    let primary_idx = detected_ue
        .iter()
        .enumerate()
        .max_by_key(|(_, d)| parse_version(&d.version))
        .map(|(i, _)| i);
    // Snapshot existing rows so the intree_* metadata persisted by Plan 7
    // T1.6 (zen-detect-binary) survives a `machine refresh` — discovery and
    // zen-binary scans are independent flows and one must not wipe the
    // other's columns. Keys on (version, install_path) which together
    // uniquely identify an existing UeInstall row for this machine.
    let existing = machine_ue_installs::list_for_machine(&db, machine_id)?;
    let intree_for = |version: &str, install_path: &str| {
        existing
            .iter()
            .find(|u| u.version == version && u.install_path == install_path)
    };

    // Replace the whole set so removed installs (e.g. Launcher stub previously
    // recorded as version "4.0") get cleared, and a stale `is_primary` flag
    // from an earlier refresh cannot survive a hardware/install change.
    machine_ue_installs::delete_for_machine(&db, machine_id)?;
    for (idx, d) in detected_ue.iter().enumerate() {
        let prior = intree_for(&d.version, &d.install_path);
        machine_ue_installs::upsert(
            &db,
            &UeInstall {
                id: None,
                machine_id,
                version: d.version.clone(),
                install_path: d.install_path.clone(),
                is_primary: Some(idx) == primary_idx,
                zen_cli_intree_path: prior.and_then(|p| p.zen_cli_intree_path.clone()),
                zen_cli_intree_version: prior.and_then(|p| p.zen_cli_intree_version.clone()),
                zen_cli_intree_sha256: prior.and_then(|p| p.zen_cli_intree_sha256.clone()),
                zenserver_intree_path: prior.and_then(|p| p.zenserver_intree_path.clone()),
                zenserver_intree_version: prior.and_then(|p| p.zenserver_intree_version.clone()),
                zenserver_intree_sha256: prior.and_then(|p| p.zenserver_intree_sha256.clone()),
            },
        )?;
    }
    let persisted_ue = machine_ue_installs::list_for_machine(&db, machine_id)?;

    // GPU detect AFTER UE is persisted. If GPU fails, return what we have —
    // do NOT use `refresh_err` here because that drops the persisted UE list.
    let detected_gpus = match discovery::detect_gpus(&exec, &machine.ip) {
        Ok(v) => v,
        Err(e) => {
            return Ok(RefreshResult {
                machine_id,
                winrm_ok: true,
                ue_installs: persisted_ue,
                gpus: vec![],
                error: Some(format!("GPU detection failed: {}", e)),
            });
        }
    };

    // GPUs change as a unit on hardware swap, so replace the whole set.
    let gpu_records: Vec<GpuInfo> = detected_gpus
        .iter()
        .map(|g| GpuInfo {
            id: None,
            machine_id,
            gpu_model: g.gpu_model.clone(),
            driver_version: g.driver_version.clone(),
            vendor: g.vendor,
            vram_mb: g.vram_mb,
        })
        .collect();
    machine_gpus::replace_for_machine(&db, machine_id, &gpu_records)?;

    Ok(RefreshResult {
        machine_id,
        winrm_ok: true,
        ue_installs: persisted_ue,
        gpus: machine_gpus::list_for_machine(&db, machine_id)?,
        error: None,
    })
    })
    .await
    .map_err(|e| VoloError::OperationFailed(format!("machine refresh task join: {}", e)))?
}
