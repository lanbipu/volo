//! `voloctl cache health <action>` handlers.

use crate::args::HealthAction;
use crate::credential_args::CredentialArgs;
use crate::output::{EmitSerialize, Event};
use crate::run::Ctx;
use cache_core::core::{health_check::aggregate_gpu_consistency, health_probes};
use cache_core::data::{
    credentials as data_credentials, health_check_runs, machine_gpus, machines as data_machines,
    scan_runs, share_configs,
};
use cache_core::error::VoloResult;
use std::collections::HashMap;

/// Tally health probe outcomes by status. `na` is segregated into `skipped` so
/// the summary distinguishes "probe ran and succeeded" from "probe was not run
/// (e.g. no creds, no share configured)".
#[derive(Default, Debug)]
pub(crate) struct Counters {
    pub healthy: i64,
    pub warning: i64,
    pub critical: i64,
    pub offline: i64,
    pub skipped: i64,
    pub total_ran: i64,
}

impl Counters {
    pub fn tally(&mut self, outcome: &cache_core::core::health_check::CheckOutcome) {
        match outcome.status.as_str() {
            "healthy"  => { self.healthy  += 1; self.total_ran += 1; }
            "warning"  => { self.warning  += 1; self.total_ran += 1; }
            "critical" => { self.critical += 1; self.total_ran += 1; }
            "offline"  => { self.offline  += 1; self.total_ran += 1; }
            "na"       => { self.skipped  += 1; }
            _          => { /* unknown/sample states ignored */ }
        }
    }
}

pub fn handle(ctx: &mut Ctx<'_>, action: HealthAction) -> VoloResult<()> {
    match action {
        HealthAction::Run {
            machine_ids,
            cidr,
            all,
            expected_local_path,
            expected_shared_path,
            cred,
        } => run_dispatch(
            ctx,
            machine_ids,
            cidr,
            all,
            &expected_local_path,
            &expected_shared_path,
            &cred,
        ),
        HealthAction::Runs { limit } => list_runs(ctx, limit),
        HealthAction::Results { scan_run_id } => list_results(ctx, scan_run_id),
        HealthAction::ConsistencyCheck { hosts, cred: _ } => {
            let exec = cache_core::core::ssh::SshExecutor::from_config()?;
            let mut snaps = Vec::new();
            for h in &hosts {
                snaps.push(cache_core::core::consistency_check::snapshot(&exec, h)?);
            }
            let findings = cache_core::core::consistency_check::compare(&snaps);
            ctx.emitter.emit_result(&serde_json::json!({
                "snapshots": snaps,
                "inconsistencies": findings
            })).ok();
            Ok(())
        }
        HealthAction::ScanCommandLine { host, cred: _ } => {
            // SSH key auth: per-call WinRM creds no longer used (kept on the CLI
            // surface until A5 cleanup). Discovery/scan run over the SSH executor.
            let exec = cache_core::core::ssh::SshExecutor::from_config()?;
            let hits = cache_core::core::command_line_scanner::scan(&exec, &host)?;
            ctx.emitter.emit_result(&hits).ok();
            Ok(())
        }
        HealthAction::FileStats { host, local_path, shared_path, cred: _ } => {
            let exec = cache_core::core::ssh::SshExecutor::from_config()?;
            let stats = cache_core::core::ddc_file_stats::run(&exec, &host, &local_path, &shared_path)?;
            let imbalance = cache_core::core::ddc_file_stats::classify_imbalance(&stats);
            ctx.emitter.emit_result(&serde_json::json!({
                "stats": stats,
                "imbalance": imbalance,
            })).ok();
            Ok(())
        }
        HealthAction::AnalyzeAdvisories {
            host, editor_exe, project, local_path, shared_path, timeout, cred,
        } => {
            let db = ctx.require_db()?;
            cred.preflight(db)?;
            let verify = cache_core::core::ue_log_verify::run_for_host(
                &host, &editor_exe, &project, timeout, None,
            )?;
            let ddc_exec = cache_core::core::ssh::SshExecutor::from_config()?;
            let stats = cache_core::core::ddc_file_stats::run(&ddc_exec, &host, &local_path, &shared_path).ok();
            let advisories = cache_core::core::ddc_symptom_recognizer::analyze(&verify, stats.as_ref());
            ctx.emitter.emit_result(&serde_json::json!({
                "verify": verify,
                "stats": stats,
                "advisories": advisories,
            })).ok();
            Ok(())
        }
    }
}

fn run_dispatch(
    ctx: &mut Ctx<'_>,
    machine_ids: Vec<i64>,
    cidr: Option<String>,
    all: bool,
    expected_local_path: &str,
    expected_shared_path: &str,
    cred: &CredentialArgs,
) -> VoloResult<()> {
    // clap conflicts_with_all enforces "no two at once" but not "exactly one of three".
    // Reject the all-empty case explicitly so the user gets a helpful error instead of
    // a silent zero-machine run.
    if machine_ids.is_empty() && cidr.is_none() && !all {
        return Err(cache_core::error::VoloError::InvalidInput(
            "health run requires exactly one of: --machine-ids, --cidr, or --all".into(),
        ));
    }

    // Build the Tokio runtime once. voloctl's main() is sync (main.rs:84),
    // so creating a new runtime here is safe (no outer runtime to conflict with).
    let rt = tokio::runtime::Runtime::new()
        .map_err(|e| cache_core::error::VoloError::OperationFailed(e.to_string()))?;

    if let Some(cidr_str) = cidr {
        return run_cidr(ctx, &rt, &cidr_str);
    }
    if all {
        let db = ctx.require_db()?.clone();
        let ids = resolve_all_machine_ids(&db)?;
        if ids.is_empty() {
            return Err(cache_core::error::VoloError::InvalidInput(
                "--all requested but inventory is empty (run `voloctl cache machine scan` first)".into(),
            ));
        }
        return run_with_rt(ctx, &rt, &ids, expected_local_path, expected_shared_path, cred);
    }
    run_with_rt(ctx, &rt, &machine_ids, expected_local_path, expected_shared_path, cred)
}

fn resolve_all_machine_ids(db: &cache_core::data::Db) -> VoloResult<Vec<i64>> {
    Ok(cache_core::data::machines::list_all(db)?
        .into_iter()
        .filter_map(|m| m.id)
        .collect())
}

fn run_with_rt(
    ctx: &mut Ctx<'_>,
    rt: &tokio::runtime::Runtime,
    machine_ids: &[i64],
    expected_local_path: &str,
    expected_shared_path: &str,
    cred: &CredentialArgs,
) -> VoloResult<()> {
    let db = ctx.require_db()?.clone();

    // SSH key auth: no operator credential needed. preflight validates flags
    // without reading DPAPI/stdin for a credential that would only be discarded.
    cred.preflight(&db)?;
    let (op_user, op_pass) = (String::new(), String::new());

    let total = machine_ids.len() as i64;

    ctx.emitter
        .emit_event(&Event::Started {
            task_type: "health_run".into(),
            task_id: None,
            metadata: serde_json::json!({ "machines": total }),
        })
        .ok();

    // Mirror commands::health_check::run_health_check exactly:
    // 1. aggregate GPU consistency across all machines
    // 2. resolve primary share (cluster-wide)
    // 3. per-machine: run probes + derive ini/pso/gpu outcomes, upsert row
    // 4. finish scan_run with summary

    let all_gpus: Vec<machine_gpus::GpuInfo> = {
        let mut acc = Vec::new();
        for &mid in machine_ids {
            acc.extend(machine_gpus::list_for_machine(&db, mid)?);
        }
        acc
    };
    let gpu_report = aggregate_gpu_consistency(&all_gpus);

    let primary_share = share_configs::list_all(&db)
        .unwrap_or_default()
        .into_iter()
        .next();
    let cluster_share_unc = primary_share
        .as_ref()
        .map(|s| s.unc_path.clone())
        .unwrap_or_default();
    let cluster_svc_username = match primary_share
        .as_ref()
        .and_then(|s| s.credential_alias.clone())
    {
        Some(alias) => data_credentials::find_by_alias(&db, &alias)?
            .map(|c| c.username)
            .unwrap_or_else(|| "ddc-svc".to_string()),
        None => "ddc-svc".to_string(),
    };

    // env_shared probe arg: prefer operator-supplied --expected-shared-path; fall
    // back to cluster share UNC (existing behaviour mirrors UI command).
    let eff_expected_shared: &str = if expected_shared_path.is_empty() {
        cluster_share_unc.as_str()
    } else {
        expected_shared_path
    };

    let scan_id = scan_runs::insert(&db, "health", machine_ids)?;

    // DESIGN-1: cluster-level Zen-shared signal, computed once. When active,
    // env_shared/env_vars probes are relaxed because UE-SharedDataCachePath is
    // intentionally cleared in Zen shared mode.
    let zen_shared_active = cache_core::core::health_check::cluster_has_shared_zen(&db);

    let mut healthy: i64 = 0;
    let mut warning: i64 = 0;
    let mut critical: i64 = 0;
    let mut offline: i64 = 0;
    let mut skipped: i64 = 0;
    let mut total_checks: i64 = 0;

    for (idx, &mid) in machine_ids.iter().enumerate() {
        let machine = match data_machines::find_by_id(&db, mid)? {
            Some(m) => m,
            None => {
                // Don't silently no-op — operator passed an id that doesn't exist.
                // Emit ItemStarted+ItemCompleted so progress + summary match input length.
                ctx.emitter
                    .emit_event(&Event::ItemStarted {
                        item_id: format!("machine:{}", mid),
                        index: idx as i64,
                        total,
                    })
                    .ok();
                ctx.emitter
                    .emit_event(&Event::ItemCompleted {
                        item_id: format!("machine:{}", mid),
                        index: idx as i64,
                        ok: false,
                        message: Some(format!(
                            "machine id {} not found in inventory (run `voloctl cache machine list` to see valid ids)",
                            mid
                        )),
                    })
                    .ok();
                continue;
            }
        };

        ctx.emitter
            .emit_event(&Event::ItemStarted {
                item_id: format!("machine:{}", mid),
                index: idx as i64,
                total,
            })
            .ok();

        // SSH key auth: L2/L3 probes always run over SSH now (no WinRM credential
        // gate). The old no-credential skip is obsolete -- health_probes::run no
        // longer needs a per-call credential.
        let probes: HashMap<String, cache_core::core::health_check::CheckOutcome> = {
                let cred_opt = Some((op_user.as_str(), op_pass.as_str()));
                match health_probes::run(
                    &machine.ip,
                    &cluster_share_unc,
                    &cluster_svc_username,
                    eff_expected_shared,
                    expected_local_path,
                    cred_opt,
                ) {
                    Ok(map) => map,
                    Err(e) => {
                        // Offline branch: fill registry-derived keys with `offline`,
                        // then still inject L1 ports so the row width matches.
                        let mut row: HashMap<String, cache_core::core::health_check::CheckOutcome> = HashMap::new();
                        for k in cache_core::core::probe_keys::offline_probe_keys() {
                            row.insert(
                                k.into(),
                                cache_core::core::health_check::CheckOutcome {
                                    status: "offline".into(),
                                    message: e.to_string(),
                                    sample: "".into(),
                                    remediation: "Bring the host online (verify network + SSH) before retrying.".into(),
                                },
                            );
                        }
                        // L1 ports still probed — operator may have lost WinRM but kept TCP visibility.
                        let l1 = rt.block_on(cache_core::core::health_check::probe_tcp_ports(&machine.ip, 1000));
                        for (k, v) in l1 { row.insert(k, v); }
                        // Merge zen health rows on the offline path too —
                        // codex P2 from T4.1-T4.3 review wants stable layout
                        // regardless of WinRM reachability. Most rows will
                        // be "unknown" but the keys present.
                        //
                        // Codex round-18 P3: same as online path — when
                        // the DB query errors, emit `unknown` for all 4
                        // keys instead of dropping them, so consumers
                        // never see gaps in the row schema.
                        match cache_core::core::health_check::zen_health_for_machine(&db, mid, Some(machine_ids)) {
                            Ok(zen_rows) => {
                                for (k, v) in zen_rows {
                                    row.insert(k, v);
                                }
                            }
                            Err(zen_err) => {
                                eprintln!(
                                    "[health run] offline zen_health_for_machine({}) failed: {}",
                                    mid, zen_err
                                );
                                let msg = format!("zen health query failed: {zen_err}");
                                let remediation =
                                    "Inspect tracing logs; re-run when DB is recovered.".to_string();
                                for key in [
                                    "zen_reachable",
                                    "zen_version_consistent",
                                    "zen_binary_intact",
                                    "zen_cache_provider_ready",
                                ] {
                                    row.insert(
                                        key.into(),
                                        cache_core::core::health_check::CheckOutcome {
                                            status: "unknown".into(),
                                            message: msg.clone(),
                                            sample: "".into(),
                                            remediation: remediation.clone(),
                                        },
                                    );
                                }
                            }
                        }
                        health_check_runs::upsert(&db, scan_id, mid, &serde_json::to_value(&row).unwrap())?;
                        let mut rc = Counters::default();
                        for v in row.values() { rc.tally(v); }
                        healthy += rc.healthy;
                        warning += rc.warning;
                        critical += rc.critical;
                        offline += rc.offline;
                        skipped += rc.skipped;
                        total_checks += rc.total_ran;
                        ctx.emitter.emit_event(&Event::ItemCompleted {
                            item_id: format!("machine:{}", mid),
                            index: idx as i64,
                            ok: false,
                            message: Some(e.to_string()),
                        }).ok();
                        continue;
                    }
                }
            };

        // Inject L1 port outcomes onto every machine row — operator console
        // probes are creds-independent, so they always contribute to the picture.
        // (Offline branch already injects L1 inline; this top-level injection only
        // fires on success + no-creds paths, no double-injection.)
        let mut probes = probes; // make mutable
        rt.block_on(inject_l1_ports(&mut probes, &machine.ip, 1000));

        // Derived checks (mirrors UI command — ini_consistency, pso_precaching, gpu_consistency).
        // pso_precaching requires project paths which CLI doesn't expose; emit "na" like the
        // UI command does when project_paths is empty.
        let ini_outcome = derive_ini_outcome(&db, mid)?;
        let pso_outcome = cache_core::core::health_check::CheckOutcome {
            status: "na".into(),
            message: "no project paths supplied via CLI".into(),
            sample: "".into(),
            remediation: String::new(),
        };
        let gpu_outcome = gpu_report
            .outcomes
            .get(&mid)
            .cloned()
            .unwrap_or(cache_core::core::health_check::CheckOutcome {
                status: "unknown".into(),
                message: "no GPU data".into(),
                sample: "".into(),
                remediation: String::new(),
            });

        let mut row = probes;
        row.insert("ini_consistency".into(), ini_outcome);
        row.insert("pso_precaching".into(), pso_outcome);
        row.insert("gpu_consistency".into(), gpu_outcome);

        // T4.2 / T4.3 wiring (mirror commands::health_check::run_health_check):
        // Always emit the 4 zen keys so the row has a stable layout. The
        // helper returns "unknown" rows when no zen install / endpoints /
        // probes exist — operators can distinguish "no data" from
        // "data says broken". A DB error doesn't nuke the whole run.
        match cache_core::core::health_check::zen_health_for_machine(&db, mid, Some(machine_ids)) {
            Ok(zen_rows) => {
                for (k, v) in zen_rows {
                    row.insert(k, v);
                }
            }
            Err(e) => {
                // Codex round-16 P2: keep the stable 4-key zen layout
                // even on DB-error fallback (mirror of
                // commands::health_check::run_health_check).
                eprintln!("[health run] zen_health_for_machine({}) failed: {}", mid, e);
                let msg = format!("zen health query failed: {e}");
                let remediation =
                    "Inspect tracing logs; re-run when DB is recovered.".to_string();
                for key in [
                    "zen_reachable",
                    "zen_version_consistent",
                    "zen_binary_intact",
                    "zen_cache_provider_ready",
                ] {
                    row.insert(
                        key.into(),
                        cache_core::core::health_check::CheckOutcome {
                            status: "unknown".into(),
                            message: msg.clone(),
                            sample: "".into(),
                            remediation: remediation.clone(),
                        },
                    );
                }
            }
        }

        // Augment with rs_service from core::renderstream_service (ps_emitted=false
        // in PROBE_REGISTRY, so the round-trip does not provide it). Probe failure
        // leaves the slot untouched.
        // RenderStream service probe runs over the SSH executor (key auth).
        // Best-effort: a keystore or probe failure leaves the slot untouched.
        if let Ok(rs_exec) = cache_core::core::ssh::SshExecutor::from_config() {
            if let Ok(rs_report) = cache_core::core::renderstream_service::report(&rs_exec, &machine.ip) {
                row.insert(
                    "rs_service".into(),
                    cache_core::core::renderstream_service::into_check_outcome(&rs_report),
                );
            }
        }

        // DESIGN-1: relax env_shared/env_vars false-positives under Zen shared mode.
        cache_core::core::health_check::relax_env_shared_under_zen(&mut row, zen_shared_active);

        let machine_checks = row.len() as i64;
        let mut row_counters = Counters::default();
        for v in row.values() {
            row_counters.tally(v);
        }
        healthy      += row_counters.healthy;
        warning      += row_counters.warning;
        critical     += row_counters.critical;
        offline      += row_counters.offline;
        skipped      += row_counters.skipped;
        total_checks += row_counters.total_ran;

        health_check_runs::upsert(&db, scan_id, mid, &serde_json::to_value(&row).unwrap())?;

        ctx.emitter
            .emit_event(&Event::ItemCompleted {
                item_id: format!("machine:{}", mid),
                index: idx as i64,
                ok: true,
                message: Some(format!("{} checks", machine_checks)),
            })
            .ok();
    }

    let summary_json = serde_json::json!({
        "healthy": healthy,
        "warning": warning,
        "critical": critical,
        "offline": offline,
        "skipped": skipped,
        "total": total_checks,
    });
    scan_runs::finish(&db, scan_id, &summary_json)?;

    ctx.emitter
        .emit_event(&Event::Completed {
            summary: serde_json::json!({
                "scan_run_id": scan_id,
                "machines": total,
                "healthy": healthy,
                "warning": warning,
                "critical": critical,
                "offline": offline,
                "skipped": skipped,
                "total_checks": total_checks,
            }),
        })
        .ok();

    Ok(())
}

fn run_cidr(ctx: &mut Ctx<'_>, rt: &tokio::runtime::Runtime, cidr: &str) -> VoloResult<()> {
    let outcomes = rt.block_on(scan_and_probe_l1(cidr, 1000))?;

    ctx.emitter
        .emit_event(&Event::Started {
            task_type: "health_run_cidr".into(),
            task_id: None,
            metadata: serde_json::json!({
                "cidr": cidr,
                "hosts": outcomes.len(),
                "note": "CIDR mode probes every IP in range (including all-closed). L1 only — no creds, no DB persistence."
            }),
        })
        .ok();

    let total = outcomes.len() as i64;
    let mut hosts_with_any_open = 0i64;
    for (idx, (ip, port_outcomes)) in outcomes.iter().enumerate() {
        let any_open = port_outcomes.values().any(|o| o.status == "healthy");
        if any_open { hosts_with_any_open += 1; }
        ctx.emitter
            .emit_event(&Event::ItemCompleted {
                item_id: format!("ip:{}", ip),
                index: idx as i64,
                ok: any_open,
                message: Some(serde_json::to_string(port_outcomes).unwrap_or_default()),
            })
            .ok();
    }

    let summary = serde_json::json!({
        "mode": "cidr",
        "cidr": cidr,
        "hosts_total": total,
        "hosts_with_any_open_port": hosts_with_any_open,
        "persisted": false,
        "next_step": "For deeper L2+L3 diagnosis, run `voloctl cache machine add --ip <X>` to inventory the host, then `voloctl cache health run --machine-ids <id> --cred-alias <alias>`."
    });
    ctx.emitter.emit_event(&Event::Completed { summary }).ok();
    Ok(())
}

/// CIDR-mode L1 scan: probe every IP in the CIDR range (including fully-closed
/// hosts), return outcomes per IP. Unlike `core::network::scan_cidr` which
/// filters out fully-closed hosts, we keep them — operators want "this IP is
/// dark" as an answer too.
///
/// Concurrency capped at 50 (same as scan_cidr) to avoid socket exhaustion.
async fn scan_and_probe_l1(
    cidr: &str,
    timeout_ms: u64,
) -> VoloResult<Vec<(String, std::collections::HashMap<String, cache_core::core::health_check::CheckOutcome>)>> {
    use ipnet::Ipv4Net;
    use std::str::FromStr;
    use std::sync::Arc;
    use tokio::sync::Semaphore;

    let net = Ipv4Net::from_str(cidr).map_err(|e| {
        cache_core::error::VoloError::InvalidInput(format!("invalid CIDR '{}': {}", cidr, e))
    })?;
    let hosts: Vec<String> = net.hosts().map(|ip| ip.to_string()).collect();
    if hosts.len() > cache_core::core::network::MAX_HOSTS {
        return Err(cache_core::error::VoloError::InvalidInput(format!(
            "CIDR expands to {} hosts (max {})",
            hosts.len(),
            cache_core::core::network::MAX_HOSTS
        )));
    }

    let semaphore = Arc::new(Semaphore::new(50));
    let mut handles = Vec::with_capacity(hosts.len());
    for ip in hosts {
        let sem = semaphore.clone();
        handles.push(tokio::spawn(async move {
            let _permit = sem.acquire_owned().await.ok()?;
            let outcomes = cache_core::core::health_check::probe_tcp_ports(&ip, timeout_ms).await;
            Some((ip, outcomes))
        }));
    }
    let mut out = Vec::with_capacity(handles.len());
    for h in handles {
        if let Ok(Some(pair)) = h.await {
            out.push(pair);
        }
    }
    Ok(out)
}

fn derive_ini_outcome(
    db: &cache_core::data::Db,
    machine_id: i64,
) -> VoloResult<cache_core::core::health_check::CheckOutcome> {
    use cache_core::data::ini_findings;
    let recent = scan_runs::list_recent(db, "ini", 1)?;
    let Some(latest) = recent.first() else {
        return Ok(cache_core::core::health_check::CheckOutcome {
            status: "unknown".into(),
            message: "no INI scan run yet".into(),
            sample: "".into(),
            remediation: String::new(),
        });
    };
    let counts =
        ini_findings::count_by_severity_for_machine(db, latest.id.unwrap(), machine_id)?;
    let status = if counts.critical > 0 {
        "critical"
    } else if counts.warning > 0 {
        "warning"
    } else {
        "healthy"
    };
    Ok(cache_core::core::health_check::CheckOutcome {
        status: status.into(),
        message: format!(
            "{} critical / {} warning open",
            counts.critical, counts.warning
        ),
        sample: format!("scan_run #{}", latest.id.unwrap()),
        remediation: String::new(),
    })
}

/// Inject L1 (port-layer) outcomes into a probe row. Runs the 3 TCP probes
/// against the host and merges their outcomes into the given map. Existing
/// keys are NOT overwritten — uses `entry().or_insert()` so a row that
/// somehow already carries a `tcp_*` key (e.g. an upstream caller pre-seeded
/// it) wins over the probe result. In normal flow the keys never collide
/// since PS / derived sources don't emit `tcp_*`.
pub(crate) async fn inject_l1_ports(
    row: &mut std::collections::HashMap<String, cache_core::core::health_check::CheckOutcome>,
    ip: &str,
    timeout_ms: u64,
) {
    let l1 = cache_core::core::health_check::probe_tcp_ports(ip, timeout_ms).await;
    for (k, v) in l1 {
        // Debug-only safety net: probe_tcp_ports should only return keys whose
        // registry entry is L1Port. If a probe ever drifts and emits e.g. a
        // bootstrap-layer key, catch it under cargo test before it ships.
        debug_assert_eq!(
            cache_core::core::probe_keys::layer_for(&k),
            Some(cache_core::core::probe_keys::Layer::L1Port),
            "probe_tcp_ports emitted non-L1 key '{}'", k
        );
        row.entry(k).or_insert(v);
    }
}

fn list_runs(ctx: &mut Ctx<'_>, limit: i64) -> VoloResult<()> {
    let db = ctx.require_db()?;
    let rows = scan_runs::list_recent(db, "health", limit)?;
    ctx.emitter.emit_result(&rows).ok();
    Ok(())
}

fn list_results(ctx: &mut Ctx<'_>, scan_run_id: i64) -> VoloResult<()> {
    let db = ctx.require_db()?;
    let rows = health_check_runs::list_for_run(db, scan_run_id)?;
    ctx.emitter.emit_result(&rows).ok();
    Ok(())
}

#[cfg(test)]
mod tests {
    use cache_core::core::health_check::CheckOutcome;

    fn outcome(status: &str) -> CheckOutcome {
        CheckOutcome {
            status: status.into(),
            message: "".into(),
            sample: "".into(),
            remediation: "".into(),
        }
    }

    #[test]
    fn na_outcomes_increment_skipped_not_other_counters() {
        let mut counters = super::Counters::default();
        counters.tally(&outcome("healthy"));
        counters.tally(&outcome("warning"));
        counters.tally(&outcome("na"));
        counters.tally(&outcome("na"));
        counters.tally(&outcome("critical"));

        assert_eq!(counters.healthy, 1);
        assert_eq!(counters.warning, 1);
        assert_eq!(counters.critical, 1);
        assert_eq!(counters.offline, 0);
        assert_eq!(counters.skipped, 2, "na must increment skipped");
        assert_eq!(counters.total_ran, 3);
    }

    #[test]
    fn offline_probe_keys_derives_from_registry() {
        let keys = cache_core::core::probe_keys::offline_probe_keys();
        // 4 L2 + 10 L3Business (incl env_local, env_shared, rs_service) = 14
        assert_eq!(keys.len(), 14);
        assert!(keys.contains(&"lanman_server"));
        assert!(keys.contains(&"firewall_445"));
        assert!(keys.contains(&"env_local"));
        assert!(keys.contains(&"env_shared"));
        assert!(keys.contains(&"rs_service"));
        assert!(!keys.contains(&"tcp_5985"), "L1 must not be in offline keys");
        assert!(!keys.contains(&"ini_consistency"), "derived must not be in offline keys");
    }

    use cache_core::data::machines::{insert as insert_machine, Machine};
    use cache_core::data::{open_in_memory, schema};

    fn setup_db_with_two_machines() -> cache_core::data::Db {
        let db = open_in_memory().unwrap();
        {
            let mut conn = db.lock().unwrap();
            schema::migrate(&mut conn).unwrap();
        }
        let _ = insert_machine(&db, &Machine::new("RENDER-A", "192.168.10.21")).unwrap();
        let _ = insert_machine(&db, &Machine::new("RENDER-B", "192.168.10.22")).unwrap();
        db
    }

    #[test]
    fn resolve_all_machine_ids_returns_both() {
        let db = setup_db_with_two_machines();
        let ids = super::resolve_all_machine_ids(&db).unwrap();
        assert_eq!(ids.len(), 2);
    }

    #[test]
    fn resolve_all_machine_ids_returns_empty_on_empty_inventory() {
        let db = open_in_memory().unwrap();
        {
            let mut conn = db.lock().unwrap();
            schema::migrate(&mut conn).unwrap();
        }
        assert_eq!(super::resolve_all_machine_ids(&db).unwrap().len(), 0);
    }

    #[tokio::test]
    async fn scan_and_probe_l1_returns_one_outcome_set_per_ip() {
        // /30 in TEST-NET-3 yields 2 usable hosts; all closed, all kept.
        let outcomes = super::scan_and_probe_l1("203.0.113.0/30", 50).await.unwrap();
        assert_eq!(outcomes.len(), 2, "expected /30 to yield 2 hosts, got {}", outcomes.len());
        for (ip, port_outcomes) in &outcomes {
            assert!(ip.starts_with("203.0.113."));
            assert_eq!(port_outcomes.len(), 3, "expected 3 L1 keys per IP");
            assert!(port_outcomes.contains_key("tcp_5985"));
            assert!(port_outcomes.contains_key("tcp_445"));
            assert!(port_outcomes.contains_key("tcp_135"));
        }
    }

    #[test]
    fn cidr_too_large_returns_invalid_input() {
        // /16 = 65534 hosts, blocked by MAX_HOSTS guard.
        let rt = tokio::runtime::Runtime::new().unwrap();
        let r = rt.block_on(super::scan_and_probe_l1("10.0.0.0/16", 50));
        assert!(matches!(r, Err(cache_core::error::VoloError::InvalidInput(_))));
    }

    #[tokio::test]
    async fn inject_l1_ports_adds_three_keys_to_row() {
        use std::collections::HashMap;
        let mut row: HashMap<String, cache_core::core::health_check::CheckOutcome> = HashMap::new();
        row.insert("lanman_server".into(), outcome("healthy"));
        // Use TEST-NET-3 — closed ports, fast timeout.
        super::inject_l1_ports(&mut row, "203.0.113.3", 50).await;
        assert!(row.contains_key("tcp_5985"));
        assert!(row.contains_key("tcp_445"));
        assert!(row.contains_key("tcp_135"));
        assert!(row.contains_key("lanman_server")); // existing key preserved
    }

    #[tokio::test]
    async fn inject_l1_ports_does_not_overwrite_preseeded_tcp_key() {
        use std::collections::HashMap;
        let mut row: HashMap<String, cache_core::core::health_check::CheckOutcome> = HashMap::new();
        // Pre-seed tcp_5985 with a sentinel that the real probe could not produce
        // (status='warning' + a distinct message). After inject_l1_ports runs,
        // this entry MUST survive — that's the invariant the doc comment promises.
        let sentinel = cache_core::core::health_check::CheckOutcome {
            status: "warning".into(),
            message: "pre-seeded sentinel".into(),
            sample: "".into(),
            remediation: "".into(),
        };
        row.insert("tcp_5985".into(), sentinel.clone());
        super::inject_l1_ports(&mut row, "203.0.113.4", 50).await;
        assert_eq!(row.get("tcp_5985"), Some(&sentinel),
            "inject_l1_ports must not overwrite pre-seeded tcp_5985 entry");
        // Other two keys still added.
        assert!(row.contains_key("tcp_445"));
        assert!(row.contains_key("tcp_135"));
    }
}
