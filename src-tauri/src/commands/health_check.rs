//! Tauri commands for the cluster health check.

use cache_core::core::health_check::{
    aggregate_gpu_consistency, probe_tcp_ports, zen_health_for_machine, CheckOutcome,
};
use cache_core::core::health_probes;
use cache_core::core::ini_scanner;
use cache_core::core::probe_keys;
use cache_core::data::{
    credentials as data_credentials, ini_findings, machine_gpus,
    machines as data_machines, scan_runs, share_configs,
    health_check_runs, Db,
};
use cache_core::error::{UecmError, UecmResult};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Serialize, Clone)]
pub struct HealthProgressEvent {
    pub scan_run_id: i64,
    pub machine_id: i64,
    pub done: bool,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct HealthRunSummary {
    pub scan_run_id: i64,
    pub healthy: i64,
    pub warning: i64,
    pub critical: i64,
    pub offline: i64,
    /// `na` outcomes — probe could not run (no creds, no share configured, etc).
    /// Separated from `healthy`/`warning`/`critical` so the UI does not inflate green.
    pub skipped: i64,
    pub total: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RunHealthCheckRequest {
    pub machine_ids: Vec<i64>,
    pub credential_alias: String,
    pub project_paths: Vec<String>,
    /// Expected value for UE-LocalDataCachePath. When `None` or empty string,
    /// the env_local probe only checks that the variable is set (presence-only).
    #[serde(default)]
    pub expected_local_path: Option<String>,
    /// Expected value for UE-SharedDataCachePath. Same semantics as
    /// `expected_local_path`. When unset, falls back to the cluster share UNC.
    #[serde(default)]
    pub expected_shared_path: Option<String>,
}

#[tauri::command]
pub async fn run_health_check(
    db: State<'_, Db>,
    app: AppHandle,
    request: RunHealthCheckRequest,
) -> UecmResult<HealthRunSummary> {
    // 改 async + spawn_blocking：原 body 是同步阻塞 SSH/探活，跑在 Tauri 主线程会冻结 UI。
    // Db = Arc<Mutex<Connection>>，clone 出 owned 句柄遮蔽 db；body 一行不动地搬进 blocking 线程。
    let db: Db = (*db).clone();
    tokio::task::spawn_blocking(move || -> UecmResult<HealthRunSummary> {
    let machine_ids = request.machine_ids;
    let credential_alias = request.credential_alias;
    let expected_local_path = request.expected_local_path.unwrap_or_default();
    let expected_shared_path = request.expected_shared_path.unwrap_or_default();
    let project_paths_per_machine: HashMap<i64, Vec<String>> = machine_ids
        .iter()
        .map(|machine_id| (*machine_id, request.project_paths.clone()))
        .collect();
    if machine_ids.is_empty() {
        return Err(UecmError::InvalidInput("machine_ids required".into()));
    }
    let _ = credential_alias; // accepted-but-ignored shim (SSH key auth); Vue still sends it.

    let scan_id = scan_runs::insert(&db, "health", &machine_ids)?;

    let all_gpus: Vec<machine_gpus::GpuInfo> = {
        let mut acc = Vec::new();
        for &mid in &machine_ids {
            acc.extend(machine_gpus::list_for_machine(&db, mid)?);
        }
        acc
    };
    let gpu_report = aggregate_gpu_consistency(&all_gpus);

    // Cluster-wide DDC share to validate from every machine. Fix codex P1:
    // previously this used `share_configs::find_by_host(mid)` per row, which
    // returned shares hosted ON the machine being checked, so client machines
    // probed an empty UNC and reported `na` for share_reachable / ntfs_perm /
    // system_write instead of validating their access to the configured share.
    let primary_share = share_configs::list_all(&db).unwrap_or_default()
        .into_iter().next();
    let cluster_share_unc = primary_share.as_ref().map(|s| s.unc_path.clone()).unwrap_or_default();
    // The share's stored `credential_alias` is the UECM alias (e.g.
    // `UECM:share:HOST-A:ddc-svc`); resolve it to the actual Windows account
    // name (`ddc-svc`) before passing to health-probes.ps1.
    let cluster_svc_username = match primary_share.as_ref().and_then(|s| s.credential_alias.clone()) {
        Some(alias) => data_credentials::find_by_alias(&db, &alias)?
            .map(|c| c.username)
            .unwrap_or_else(|| "ddc-svc".to_string()),
        None => "ddc-svc".to_string(),
    };

    let mut summary = HealthRunSummary {
        scan_run_id: scan_id,
        healthy: 0, warning: 0, critical: 0, offline: 0, skipped: 0,
        total: 0,
    };

    // Single Tokio runtime for L1 TCP probes — the Tauri command is sync.
    let rt = tokio::runtime::Runtime::new()
        .map_err(|e| UecmError::OperationFailed(e.to_string()))?;

    // DESIGN-1: cluster-level Zen-shared signal, computed once. When active,
    // env_shared/env_vars probes are relaxed (UE-SharedDataCachePath is
    // intentionally cleared in Zen shared mode). Mirrors cli/domain_health.rs.
    let zen_shared_active = cache_core::core::health_check::cluster_has_shared_zen(&db);

    for &mid in &machine_ids {
        let machine = match data_machines::find_by_id(&db, mid)? {
            Some(m) => m,
            None => continue,
        };

        let share_unc = cluster_share_unc.clone();
        let svc_username = cluster_svc_username.clone();
        let expected_shared = share_unc.clone();

        // Use operator-supplied expected paths when provided; fall back to the
        // cluster share UNC for env_shared (existing behaviour) and empty string
        // for env_local (presence-only check).
        let eff_expected_shared = if expected_shared_path.is_empty() {
            expected_shared.as_str()
        } else {
            expected_shared_path.as_str()
        };
        let probes = match health_probes::run(
            &machine.ip,
            &share_unc,
            &svc_username,
            eff_expected_shared,
            &expected_local_path,
            None,
        ) {
            Ok(map) => map,
            Err(e) => {
                let _ = app.emit("health-progress", HealthProgressEvent {
                    scan_run_id: scan_id, machine_id: mid, done: true,
                    error: Some(e.to_string()),
                });
                // Offline branch: fill registry keys with `offline`, then inject L1
                // (operator may have lost WinRM but kept TCP visibility).
                let mut row = HashMap::<String, CheckOutcome>::new();
                for k in probe_keys::offline_probe_keys() {
                    row.insert(k.into(), CheckOutcome {
                        status: "offline".into(),
                        message: e.to_string(),
                        sample: "".into(),
                        remediation: "Bring the host online (verify network + SSH) before retrying.".into(),
                    });
                }
                let l1 = rt.block_on(probe_tcp_ports(&machine.ip, 1000));
                for (k, v) in l1 { row.insert(k, v); }
                // Codex P2: merge Zen health rows on the offline path too
                // so the UI gets the same stable layout regardless of
                // WinRM reachability. Most Zen rows will land as
                // "unknown" because they rely on probe / install data
                // that's likely missing for an offline host, but having
                // the keys present beats leaving holes in the schema.
                //
                // Codex round-18 P3: when the underlying query itself
                // fails, the previous `if let Ok` swallowed the error
                // and left ALL 4 keys missing — same stable-layout
                // violation the online path already fixes. Emit
                // `unknown` for the 4 keys in the error branch.
                match zen_health_for_machine(&db, mid, Some(&machine_ids)) {
                    Ok(zen_rows) => {
                        for (k, v) in zen_rows {
                            row.insert(k, v);
                        }
                    }
                    Err(zen_err) => {
                        eprintln!(
                            "[health_check] offline zen_health_for_machine({}) failed: {}",
                            mid, zen_err
                        );
                        let msg = format!("zen health probe failed: {}", zen_err);
                        let remediation =
                            "Inspect the UECM log; the underlying DB query for zen state failed.".to_string();
                        for key in [
                            "zen_reachable",
                            "zen_version_consistent",
                            "zen_binary_intact",
                            "zen_cache_provider_ready",
                        ] {
                            row.insert(
                                key.into(),
                                CheckOutcome {
                                    status: "unknown".into(),
                                    message: msg.clone(),
                                    sample: String::new(),
                                    remediation: remediation.clone(),
                                },
                            );
                        }
                    }
                }
                tally_summary(&mut summary, &row);
                health_check_runs::upsert(&db, scan_id, mid, &serde_json::to_value(&row).unwrap())?;
                continue;
            }
        };

        let ini_outcome = derive_ini_outcome(&db, mid)?;

        let pso_outcome = derive_pso_cvar_outcome(
            &machine.ip,
            project_paths_per_machine.get(&mid).cloned().unwrap_or_default(),
        );

        let gpu_outcome = gpu_report.outcomes.get(&mid).cloned()
            .unwrap_or(CheckOutcome { status: "unknown".into(), message: "no GPU data".into(), sample: "".into(), remediation: String::new() });

        let mut row: HashMap<String, CheckOutcome> = probes;
        row.insert("ini_consistency".into(), ini_outcome);
        row.insert("pso_precaching".into(), pso_outcome);
        row.insert("gpu_consistency".into(), gpu_outcome);

        // Augment the round-trip with rs_service from core::renderstream_service.
        // The probe is L3Business but not PS-emitted (ps_emitted=false in
        // PROBE_REGISTRY); it is computed here so we can detect both LocalSystem
        // service installs AND local interactive users. Probe failure leaves
        // any previous slot untouched.
        if let Ok(rs_exec) = cache_core::core::ssh::SshExecutor::from_config() {
            if let Ok(rs_report) = cache_core::core::renderstream_service::report(&rs_exec, &machine.ip) {
                row.insert(
                    "rs_service".into(),
                    cache_core::core::renderstream_service::into_check_outcome(&rs_report),
                );
            }
        }

        // L1 ports — creds-independent, always run.
        let l1 = rt.block_on(probe_tcp_ports(&machine.ip, 1000));
        for (k, v) in l1 { row.insert(k, v); }

        // Zen health rows (T4.2 / T4.3): always emit the 4 keys so the UI
        // sees a stable layout. The function returns "unknown" rows for
        // machines that have no zen install / no endpoints / no probes —
        // that's by design so an operator can tell "no data yet" apart
        // from "data says it's broken".
        match zen_health_for_machine(&db, mid, Some(&machine_ids)) {
            Ok(zen_rows) => {
                for (k, v) in zen_rows {
                    row.insert(k, v);
                }
            }
            Err(e) => {
                // Codex round-16 P2: the zen health contract is that every
                // row carries ALL FOUR `zen_*` keys with a stable layout,
                // even when the source query failed. Previously this
                // branch only emitted `zen_reachable`, leaving
                // `zen_version_consistent` / `zen_binary_intact` /
                // `zen_cache_provider_ready` missing — UI / CLI clients
                // that read keys by name would silently render them as
                // gaps instead of "unknown".
                eprintln!("[health_check] zen_health_for_machine({}) failed: {}", mid, e);
                let msg = format!("zen health probe failed: {}", e);
                let remediation =
                    "Inspect the UECM log; the underlying DB query for zen state failed.".to_string();
                for key in [
                    "zen_reachable",
                    "zen_version_consistent",
                    "zen_binary_intact",
                    "zen_cache_provider_ready",
                ] {
                    row.insert(
                        key.into(),
                        CheckOutcome {
                            status: "unknown".into(),
                            message: msg.clone(),
                            sample: String::new(),
                            remediation: remediation.clone(),
                        },
                    );
                }
            }
        }

        // DESIGN-1: relax env_shared/env_vars false-positives under Zen shared mode.
        cache_core::core::health_check::relax_env_shared_under_zen(&mut row, zen_shared_active);

        tally_summary(&mut summary, &row);
        health_check_runs::upsert(&db, scan_id, mid, &serde_json::to_value(&row).unwrap())?;
        let _ = app.emit("health-progress", HealthProgressEvent {
            scan_run_id: scan_id, machine_id: mid, done: true, error: None,
        });
    }

    let summary_json = json!({
        "healthy": summary.healthy, "warning": summary.warning,
        "critical": summary.critical, "offline": summary.offline,
        "skipped": summary.skipped, "total": summary.total,
    });
    scan_runs::finish(&db, scan_id, &summary_json)?;
    Ok(summary)
    })
    .await
    .map_err(|e| UecmError::OperationFailed(format!("health check task join: {}", e)))?
}

/// Tally one machine's per-key outcomes into the run summary.
/// `na` is segregated into `skipped` (does NOT count toward healthy/warning/critical).
/// Mirrors the `Counters::tally` logic in `cli/domain_health.rs` so UI and CLI agree.
fn tally_summary(summary: &mut HealthRunSummary, row: &HashMap<String, CheckOutcome>) {
    for v in row.values() {
        match v.status.as_str() {
            "healthy"  => { summary.healthy  += 1; summary.total += 1; }
            "warning"  => { summary.warning  += 1; summary.total += 1; }
            "critical" => { summary.critical += 1; summary.total += 1; }
            "offline"  => { summary.offline  += 1; summary.total += 1; }
            "na"       => { summary.skipped  += 1; }
            _          => {}
        }
    }
}

fn derive_ini_outcome(db: &Db, machine_id: i64) -> UecmResult<CheckOutcome> {
    let recent = scan_runs::list_recent(db, "ini", 1)?;
    let Some(latest) = recent.first() else {
        return Ok(CheckOutcome { status: "unknown".into(), message: "no INI scan run yet".into(), sample: "".into(), remediation: String::new() });
    };
    let counts = ini_findings::count_by_severity_for_machine(db, latest.id.unwrap(), machine_id)?;
    let status = if counts.critical > 0 { "critical" }
        else if counts.warning > 0 { "warning" }
        else { "healthy" };
    Ok(CheckOutcome {
        status: status.into(),
        message: format!("{} critical / {} warning open", counts.critical, counts.warning),
        sample: format!("scan_run #{}", latest.id.unwrap()),
        remediation: String::new(),
    })
}

fn derive_pso_cvar_outcome(
    host: &str,
    project_roots: Vec<String>,
) -> CheckOutcome {
    if project_roots.is_empty() {
        return CheckOutcome {
            status: "na".into(),
            message: "no project paths supplied".into(),
            sample: "".into(),
            remediation: String::new(),
        };
    }
    let target = ini_scanner::TargetFile {
        path: format!("{}\\Config\\ConsoleVariables.ini", project_roots[0].trim_end_matches('\\')),
        category: cache_core::core::ini_diagnostics::Category::Project,
    };
    let parsed = match ini_scanner::read_file(host, &target, None) {
        Ok(Some(pf)) => pf,
        Ok(None) => return CheckOutcome { status: "warning".into(), message: "ConsoleVariables.ini missing".into(), sample: target.path, remediation: String::new() },
        Err(e) => return CheckOutcome { status: "offline".into(), message: e.to_string(), sample: target.path, remediation: String::new() },
    };
    let cvar_value = parsed.sections.iter()
        .flat_map(|s| s.keys.iter())
        .find(|k| k.name.eq_ignore_ascii_case("r.PSOPrecaching"))
        .map(|k| k.value.clone());
    match cvar_value.as_deref() {
        Some("1") => CheckOutcome { status: "healthy".into(), message: "r.PSOPrecaching=1".into(), sample: parsed.path, remediation: String::new() },
        Some(other) => CheckOutcome { status: "warning".into(), message: format!("r.PSOPrecaching={}", other), sample: parsed.path, remediation: String::new() },
        None => CheckOutcome { status: "warning".into(), message: "r.PSOPrecaching not set".into(), sample: parsed.path, remediation: String::new() },
    }
}

#[tauri::command]
pub fn list_recent_health_runs(db: State<'_, Db>, limit: i64) -> UecmResult<Vec<scan_runs::ScanRun>> {
    scan_runs::list_recent(&db, "health", limit)
}

#[tauri::command]
pub fn list_health_results_for_run(db: State<'_, Db>, scan_run_id: i64) -> UecmResult<Vec<health_check_runs::HealthCheckRow>> {
    health_check_runs::list_for_run(&db, scan_run_id)
}

#[cfg(test)]
mod tests {
    //! Smoke tests for the production wiring of `zen_health_for_machine`.
    //!
    //! `run_health_check` itself can't be invoked directly without a Tauri
    //! `AppHandle` (it emits progress events). The wiring under test is the
    //! merge step right before `health_check_runs::upsert`: take the 4-row
    //! map from `zen_health_for_machine`, fold it into the existing per-
    //! machine `row`, and persist via `upsert`. These tests exercise that
    //! merge directly with the same DB seeding the production path uses.
    use super::*;
    use cache_core::data::{
        machines::Machine, open_in_memory, scan_runs, schema,
        machines as machines_data,
    };

    fn wiring_db() -> Db {
        let db = open_in_memory().unwrap();
        {
            let mut conn = db.lock().unwrap();
            schema::migrate(&mut conn).unwrap();
        }
        db
    }

    #[test]
    fn zen_health_merge_persists_four_keys_in_health_check_runs_row() {
        // Seed: one machine, no zen endpoints / probes / installs. The
        // function returns the four canonical keys with "unknown" / "critical"
        // outcomes for the missing-data cases — that's exactly the shape
        // the UI expects so the layout stays stable.
        let db = wiring_db();
        let mid =
            machines_data::insert(&db, &Machine::new("RENDER-01", "192.168.10.21")).unwrap();
        let scan_id = scan_runs::insert(&db, "health", &[mid]).unwrap();

        // Mimic the production merge: start from an existing per-machine row
        // (here we use a stand-in "ini_consistency" outcome so the test
        // proves the merge doesn't drop existing keys), call
        // `zen_health_for_machine`, fold its 4 keys in, then upsert.
        let mut row: std::collections::HashMap<String, CheckOutcome> =
            std::collections::HashMap::new();
        row.insert(
            "ini_consistency".into(),
            CheckOutcome {
                status: "healthy".into(),
                message: "no findings".into(),
                sample: String::new(),
                remediation: String::new(),
            },
        );
        let zen_rows = zen_health_for_machine(&db, mid, None).unwrap();
        for (k, v) in zen_rows {
            row.insert(k, v);
        }

        health_check_runs::upsert(&db, scan_id, mid, &serde_json::to_value(&row).unwrap())
            .unwrap();

        // Read back through the same DB helper the Tauri command uses.
        let rows = health_check_runs::list_for_run(&db, scan_id).unwrap();
        assert_eq!(rows.len(), 1);
        let merged = &rows[0].machine_results;
        for key in [
            "ini_consistency",
            "zen_reachable",
            "zen_version_consistent",
            "zen_binary_intact",
            "zen_cache_provider_ready",
        ] {
            assert!(
                merged.get(key).is_some(),
                "merged row missing key {} — wiring would have dropped a zen check; got keys: {:?}",
                key,
                merged.as_object().map(|o| o.keys().collect::<Vec<_>>())
            );
        }
    }

    /// Regression guard (Task 3.4 isolation).
    ///
    /// A project deep-scan writes `scan_type = "ini_project"`. Health reads the
    /// latest `"ini"` run via `scan_runs::list_recent(db, "ini", 1)`. This test
    /// verifies that inserting a *later* `"ini_project"` run with zero findings
    /// does NOT displace the earlier `"ini"` run, so Health still returns the
    /// machine's real INI signal (critical = 1) rather than an empty slate.
    ///
    /// Approach: call `derive_ini_outcome` directly (it's `fn` in the same file,
    /// reachable via `use super::*`). Also assert `list_recent("ini", 1)` returns
    /// the correct run id for an additional layer of clarity.
    #[test]
    fn project_scan_does_not_poison_health_ini_signal() {
        use cache_core::data::ini_findings::{self, IniFinding};

        let db = wiring_db();
        let m1 = machines_data::insert(
            &db,
            &Machine::new("RENDER-INI-GUARD", "192.168.10.99"),
        )
        .unwrap();

        // 1. Insert a real machine INI scan run and one critical finding for m1.
        let r_ini = scan_runs::insert(&db, "ini", &[m1]).unwrap();
        ini_findings::insert(
            &db,
            &IniFinding {
                id: None,
                scan_run_id: r_ini,
                machine_id: m1,
                rule_id: "TEST_RULE_01".into(),
                severity: "critical".into(),
                category: "engine".into(),
                file_path: "C:\\UE\\Config\\Engine.ini".into(),
                section: Some("[/Script/Engine]".into()),
                key_name: Some("r.Shadow.Virtual.Enable".into()),
                line_number: Some(42),
                snippet_before: "0".into(),
                snippet_after: Some("1".into()),
                recommended_action: "Set to 1".into(),
                recommended_value: Some("1".into()),
                symptom: "VSM disabled".into(),
                rationale: "required for quality".into(),
                fixed_at: None,
                skipped_at: None,
            },
        )
        .unwrap();

        // 2. Insert a *later* project deep-scan run with NO findings.
        //    In production this is written by `commands::ini_project_scan` which
        //    uses scan_type="ini_project" (Task 3.4 fix).
        let _r_proj = scan_runs::insert(&db, "ini_project", &[m1]).unwrap();
        // (no ini_findings inserted for r_proj — simulates a clean project scan)

        // 3. Verify list_recent("ini", 1) still returns r_ini, not r_proj.
        let recent_ini = scan_runs::list_recent(&db, "ini", 1).unwrap();
        assert_eq!(
            recent_ini.len(),
            1,
            "list_recent(\"ini\", 1) should return exactly one run"
        );
        assert_eq!(
            recent_ini[0].id.unwrap(),
            r_ini,
            "list_recent(\"ini\", 1) returned the ini_project run instead of the ini run — \
             Task 3.4 isolation is broken"
        );

        // 4. Verify derive_ini_outcome sees critical=1 (from r_ini), not 0.
        let outcome = derive_ini_outcome(&db, m1).unwrap();
        assert_eq!(
            outcome.status, "critical",
            "derive_ini_outcome returned '{}' — expected 'critical'; \
             ini_project run is poisoning Health INI signal",
            outcome.status
        );
        assert!(
            outcome.message.contains("1 critical"),
            "expected '1 critical' in message, got: {}",
            outcome.message
        );
    }

    #[test]
    fn zen_health_merge_does_not_drop_existing_keys() {
        // Production-side concern: if a future change ever made the zen-rows
        // merge overwrite keys it shouldn't (e.g. "gpu_consistency" or
        // "tcp_5985"), the UI would lose those rows silently. Pin the merge
        // semantics: a key OUTSIDE the zen set must survive.
        let db = wiring_db();
        let mid =
            machines_data::insert(&db, &Machine::new("RENDER-02", "192.168.10.22")).unwrap();
        let mut row: std::collections::HashMap<String, CheckOutcome> =
            std::collections::HashMap::new();
        row.insert(
            "gpu_consistency".into(),
            CheckOutcome {
                status: "healthy".into(),
                message: "single GPU".into(),
                sample: String::new(),
                remediation: String::new(),
            },
        );
        let zen_rows = zen_health_for_machine(&db, mid, None).unwrap();
        for (k, v) in zen_rows {
            row.insert(k, v);
        }
        assert_eq!(row.get("gpu_consistency").unwrap().status, "healthy");
        // And all four zen keys also landed.
        assert!(row.contains_key("zen_reachable"));
        assert!(row.contains_key("zen_version_consistent"));
        assert!(row.contains_key("zen_binary_intact"));
        assert!(row.contains_key("zen_cache_provider_ready"));
    }
}
