//! Tauri commands for the INI scanner: dispatch a scan, list findings,
//! apply / skip a single finding.

use cache_core::core::ini_apply::{self, ApplyContext};
use cache_core::core::ini_diagnostics::EnvVarState;
use cache_core::core::ini_scanner::{self, ScanInputs};
use cache_core::core::env_vars;
use cache_core::data::{
    ini_config_snapshots, ini_findings, machine_ue_installs,
    machines as data_machines, scan_runs, Db, IniFinding,
};
use cache_core::error::{VoloError, VoloResult};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::State;

#[derive(Debug, Serialize)]
pub struct ScanRunSummary {
    pub scan_run_id: i64,
    pub critical: i64,
    pub warning: i64,
    pub healthy: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ScanInisRequest {
    pub machine_ids: Vec<i64>,
    pub credential_alias: String,
    pub project_paths: Vec<String>,
    pub user_profile_path: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct IniScanSummary {
    pub scan_run_id: i64,
    pub critical: i64,
    pub warning: i64,
    pub healthy: i64,
    pub info: i64,
    pub total_files: i64,
}

#[derive(Debug, Serialize)]
pub struct ScanInisResponse {
    pub scan_run_id: i64,
    pub summary: IniScanSummary,
    pub findings: Vec<IniFinding>,
}

#[tauri::command]
pub async fn scan_inis(
    db: State<'_, Db>,
    request: ScanInisRequest,
) -> VoloResult<ScanInisResponse> {
    // 改 async + spawn_blocking：原 body 同步阻塞 SSH 读 INI，跑主线程会冻结 UI。
    let db: Db = (*db).clone();
    tokio::task::spawn_blocking(move || -> VoloResult<ScanInisResponse> {
    let summary = scan_inis_summary(
        &db,
        request.machine_ids.clone(),
        paths_for_machines(&request.machine_ids, &request.project_paths),
        request.user_profile_path.unwrap_or_default(),
        request.credential_alias,
    )?;
    let findings = ini_findings::list_for_run(&db, summary.scan_run_id)?;
    Ok(ScanInisResponse {
        scan_run_id: summary.scan_run_id,
        summary: IniScanSummary {
            scan_run_id: summary.scan_run_id,
            critical: summary.critical,
            warning: summary.warning,
            healthy: summary.healthy,
            info: 0,
            total_files: 0,
        },
        findings,
    })
    })
    .await
    .map_err(|e| VoloError::OperationFailed(format!("ini scan task join: {}", e)))?
}

fn scan_inis_summary(
    db: &Db,
    machine_ids: Vec<i64>,
    project_paths_per_machine: std::collections::HashMap<i64, Vec<String>>,
    user_profile: String,
    credential_alias: String,
) -> VoloResult<ScanRunSummary> {
    if machine_ids.is_empty() {
        return Err(VoloError::InvalidInput("machine_ids must not be empty".into()));
    }
    let _ = credential_alias; // accepted-but-ignored shim (SSH key auth); Vue still sends it.
    let scan_id = scan_runs::insert(&db, "ini", &machine_ids)?;

    let mut total_critical = 0i64;
    let mut total_warning = 0i64;
    let mut total_healthy = 0i64;
    let mut total_read: usize = 0;
    let mut all_errors: Vec<String> = Vec::new();
    let mut all_not_found: Vec<String> = Vec::new();

    for &mid in &machine_ids {
        let machine = data_machines::find_by_id(&db, mid)?
            .ok_or_else(|| VoloError::InvalidInput(format!("machine {} not found", mid)))?;
        let installs_rows = machine_ue_installs::list_for_machine(&db, mid)?;
        let installs: Vec<(String, String)> = installs_rows.into_iter()
            .map(|i| (i.version, i.install_path)).collect();
        let project_roots: Vec<String> = project_paths_per_machine.get(&mid).cloned().unwrap_or_default();

        let mut env_state = EnvVarState::default();
        env_state.shared_data_cache_path = env_vars::get(
            &machine.ip, "UE-SharedDataCachePath",
        ).ok().flatten();
        env_state.local_data_cache_path = env_vars::get(
            &machine.ip, "UE-LocalDataCachePath",
        ).ok().flatten();

        // Auto-enable zen rules when the machine has a registered endpoint.
        // No flag — fewer surprises; the moment an operator runs
        // `voloctl cache zen register` the next INI scan starts reporting
        // R012-R018. UE version hint = highest install on this machine
        // by NUMERIC (major, minor) order. Codex P2: lexicographic max
        // would pick "5.9" over "5.10", routing R012-R015 through wrong
        // overrides / verified-version policy.
        let ue_version_hint: Option<String> = ini_scanner::pick_highest_ue_version(&installs);
        let zen_ctx_owned = ini_scanner::build_zen_ctx_for_machine(
            &db,
            mid,
            ue_version_hint.as_deref(),
            // Codex round-21 P2: restrict R018's cluster majority to
            // the scan's machine set so a separate cluster's installs
            // in the same DB don't pollute the vote.
            Some(&machine_ids),
        )?;
        let zen_ctx = zen_ctx_owned.as_ref().map(|o| o.as_ctx());

        let inputs = ScanInputs {
            host: &machine.ip,
            credential: None,
            installs: &installs,
            user_profile: &user_profile,
            project_roots: &project_roots,
            env_state,
            zen_ctx: zen_ctx.as_ref(),
            user_engine_ini_path: None,
            machine_id: 0,
        };

        let outcome = ini_scanner::scan_machine(&inputs)?;
        total_read += outcome.read_count;
        for err in &outcome.errors {
            all_errors.push(format!("{}: {}", machine.hostname, err));
        }
        for nf in &outcome.not_found {
            all_not_found.push(format!("{}: {}", machine.hostname, nf));
        }
        for f in outcome.findings {
            let row = IniFinding {
                id: None,
                scan_run_id: scan_id,
                machine_id: mid,
                rule_id: f.rule_id,
                severity: f.severity.as_str().into(),
                category: f.category.as_str().into(),
                file_path: f.file_path,
                section: f.section,
                key_name: f.key_name,
                line_number: f.line_number,
                snippet_before: f.snippet_before,
                snippet_after: f.snippet_after,
                recommended_action: f.recommended_action.as_str().into(),
                recommended_value: f.recommended_value,
                symptom: f.symptom,
                rationale: f.rationale,
                fixed_at: None,
                skipped_at: None,
            };
            match row.severity.as_str() {
                "critical" => total_critical += 1,
                "warning" => total_warning += 1,
                "healthy" => total_healthy += 1,
                _ => {}
            }
            ini_findings::insert(&db, &row)?;
        }
        // Persist config snapshots (DDC/PSO/Zen actual values).
        for entry in &outcome.config_snapshots {
            ini_config_snapshots::insert(&db, &ini_config_snapshots::ConfigSnapshot {
                id: None,
                scan_run_id: scan_id,
                machine_id: mid,
                file_path: entry.file_path.clone(),
                ue_version: ue_version_hint.clone(),
                domain: entry.domain.to_string(),
                section: entry.section.clone(),
                key_name: entry.key_name.clone(),
                value: entry.value.clone(),
                line_number: Some(entry.line_number),
            })?;
        }
    }

    let mut summary = json!({
        "critical": total_critical,
        "warning": total_warning,
        "healthy": total_healthy,
    });
    if !all_errors.is_empty() {
        let preview: Vec<String> = all_errors.iter().take(10).cloned().collect();
        summary["errors_count"] = json!(all_errors.len());
        summary["errors"] = json!(preview);
    }
    if !all_not_found.is_empty() {
        let preview: Vec<String> = all_not_found.iter().take(20).cloned().collect();
        summary["not_found_count"] = json!(all_not_found.len());
        summary["not_found"] = json!(preview);
    }
    summary["read_count"] = json!(total_read);
    scan_runs::finish(&db, scan_id, &summary)?;

    // Only surface failure when *no* file was actually read. A scan that read at
    // least one INI but happens to find nothing actionable, with optional files
    // missing on the side, is a legitimate "all clean" outcome — don't promote
    // that into a wizard error.
    if total_read == 0 {
        if !all_errors.is_empty() {
            return Err(VoloError::OperationFailed(format!(
                "INI scan read no files; {} read error(s). First: {}",
                all_errors.len(),
                all_errors.first().cloned().unwrap_or_default()
            )));
        }
        if !all_not_found.is_empty() {
            return Err(VoloError::OperationFailed(format!(
                "INI scan read no files: all {} target(s) missing. First: {}",
                all_not_found.len(),
                all_not_found.first().cloned().unwrap_or_default()
            )));
        }
    }

    Ok(ScanRunSummary {
        scan_run_id: scan_id,
        critical: total_critical,
        warning: total_warning,
        healthy: total_healthy,
    })
}

fn paths_for_machines(
    machine_ids: &[i64],
    project_paths: &[String],
) -> std::collections::HashMap<i64, Vec<String>> {
    machine_ids
        .iter()
        .map(|machine_id| (*machine_id, project_paths.to_vec()))
        .collect()
}


#[tauri::command]
pub fn list_findings_for_run(db: State<'_, Db>, scan_run_id: i64) -> VoloResult<Vec<IniFinding>> {
    ini_findings::list_for_run(&db, scan_run_id)
}

#[tauri::command]
pub fn list_findings(db: State<'_, Db>, scan_run_id: i64) -> VoloResult<Vec<IniFinding>> {
    ini_findings::list_for_run(&db, scan_run_id)
}

#[tauri::command]
pub fn list_recent_ini_runs(db: State<'_, Db>, limit: i64) -> VoloResult<Vec<scan_runs::ScanRun>> {
    scan_runs::list_recent(&db, "ini", limit)
}

#[tauri::command]
pub fn list_scan_runs(
    db: State<'_, Db>,
    scan_type: String,
    limit: i64,
) -> VoloResult<Vec<scan_runs::ScanRun>> {
    scan_runs::list_recent(&db, &scan_type, limit)
}

#[tauri::command]
pub fn get_finding(db: State<'_, Db>, finding_id: i64) -> VoloResult<Option<IniFinding>> {
    ini_findings::find_by_id(&db, finding_id)
}

#[tauri::command]
pub async fn apply_finding(
    db: State<'_, Db>,
    finding_id: i64,
    credential_alias: String,
) -> VoloResult<String> {
    // 改 async + spawn_blocking：ini_apply::apply 是阻塞 SSH 远程写，跑主线程会卡 UI。
    let db: Db = (*db).clone();
    tokio::task::spawn_blocking(move || -> VoloResult<String> {
    let f = ini_findings::find_by_id(&db, finding_id)?
        .ok_or_else(|| VoloError::InvalidInput(format!("finding {} not found", finding_id)))?;
    let machine = data_machines::find_by_id(&db, f.machine_id)?
        .ok_or_else(|| VoloError::InvalidInput(format!("machine {} not found", f.machine_id)))?;
    // SSH key auth: ini_apply uses the no-credential ini_editor fns, so there's
    // nothing to resolve. The credential_alias param stays as an accepted-ignored
    // shim (Vue compat).
    let _ = &credential_alias;
    let ctx = ApplyContext { host: &machine.ip };
    let backup = ini_apply::apply(&ctx, &f)?;
    ini_findings::mark_fixed(&db, finding_id)?;
    Ok(backup)
    })
    .await
    .map_err(|e| VoloError::OperationFailed(format!("apply finding task join: {}", e)))?
}

#[tauri::command]
pub fn skip_finding(db: State<'_, Db>, finding_id: i64) -> VoloResult<()> {
    ini_findings::mark_skipped(&db, finding_id)
}

#[tauri::command]
pub async fn verify_pso_precaching(
    db: State<'_, Db>,
    request: ScanInisRequest,
) -> VoloResult<ScanInisResponse> {
    if request.project_paths.is_empty() {
        return Err(VoloError::InvalidInput(
            "project_paths cannot be empty for PSO precaching verification".into(),
        ));
    }
    scan_inis(db, request).await
}
