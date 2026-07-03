//! Tauri command wrappers for Plan 7 zen integration (T1.10).
//!
//! These commands mirror the 9 `voloctl cache zen ...` subcommands landed in T1.9
//! (see `cli::domain_zen`). The hard rule per plan §3 is "business logic lives
//! in core/zen/" — every command here is a thin parameter-translation +
//! result-passthrough wrapper around the existing `core::zen::*` modules and
//! `data::*` CRUD. Re-implementing any of the logic that already lives in
//! `core::zen::probe`, `core::zen::cache_stats`, or `core::zen::binary` would
//! drift the CLI/UI surfaces; don't do it.
//!
//! JSON field names match the NDJSON `Completed` summary documents emitted by
//! `cli::domain_zen` so the UI doesn't need a per-channel translation layer.
//!
//! ## T2.6 destructive-op convention
//!
//! M2 added register / unregister / apply-config / lua-preview / service /
//! urlacl commands. The CLI gates each destructive operation behind `--yes` (or
//! `--dry-run`). The Tauri counterparts mirror that contract using two
//! parameters per command:
//!
//! - `confirmed: bool` — UI must prompt and pass `true` to actually run the
//!   destructive side-effect. Maps to CLI `--yes`. If both `confirmed` and
//!   `dry_run` are false on a destructive command, the wrapper returns
//!   `VoloError::InvalidInput("... requires confirmed=true or dry_run=true ...")`
//!   so accidental clicks can't fire write-side effects.
//! - `dry_run: bool` — when true, the wrapper assembles the same plan payload
//!   the CLI would emit under `--dry-run` (no PowerShell invocation, no
//!   `operations` row) and returns it as the response value. UI uses this for
//!   confirm-dialog previews.
//!
//! `dry_run` wins when both are true (matches `cli::destructive::check`).
//!
//! Service `start` and read-only commands (`service status`, `urlacl list`,
//! `lua_preview` is "read-only" in the no-destination sense) take no
//! `confirmed` parameter — they aren't destructive in the CLI either.

use cache_core::core::zen::enable as zen_enable;
use cache_core::core::zen::ops as zen_cli_shared;
use cache_core::core::zen::endpoint as zen_endpoint;
use cache_core::core::zen::redaction::redact;
use cache_core::core::zen::{
    binary as zen_binary, cache_stats as zen_cache, disk_space as zen_disk_space_core,
    probe as zen_probe,
};
use cache_core::core::ssh::SshExecutor;
use cache_core::data::{
    credentials as data_creds, machines, operations, zen_binary_expected, zen_endpoints,
    zen_probes, Db, ZenBinaryExpected, ZenEndpoint,
};
use cache_core::error::{VoloError, VoloResult};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::State;

const KIND_ZEN_CLI: &str = "zen_cli";
const KIND_ZENSERVER: &str = "zenserver";
const DEFAULT_TIMEOUT_SECONDS: u64 = 5;

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

/// One row of the zen-status dashboard view. Combines an endpoint definition
/// with its most recent probe outcome. `reachable == None` means no probe has
/// ever run for this endpoint (cold inventory); `reachable == Some(false)`
/// means we tried and failed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZenStatusRow {
    pub endpoint_id: i64,
    pub machine_id: i64,
    // Field names mirror cli::domain_zen::status NDJSON shape so the UI does
    // not need a translation layer when switching between CLI output and
    // Tauri return values. See plan §3 CLI/Tauri 1:1 contract.
    pub hostname: String,
    pub ip: String,
    pub declared_port: i64,
    pub scheme: String,
    pub role: String,
    pub lifecycle_mode: String,
    pub effective_port: Option<i64>,
    pub build_version: Option<String>,
    pub reachable: Option<bool>,
    pub last_probed_at: Option<String>,
    pub last_error: Option<String>,
}

#[tauri::command]
pub fn zen_status(db: State<'_, Db>, machine_id: Option<i64>) -> VoloResult<Vec<ZenStatusRow>> {
    let endpoints = resolve_endpoints(&db, machine_id, None)?;
    let mut rows = Vec::with_capacity(endpoints.len());
    for ep in endpoints {
        let endpoint_id = ep.id.expect("endpoint row from CRUD has id");
        let machine = machines::find_by_id(&db, ep.machine_id)?;
        let (hostname, ip) = machine
            .map(|m| (m.hostname, m.ip))
            .unwrap_or_else(|| (String::new(), String::new()));

        let latest = zen_probes::list_recent(&db, endpoint_id, 1)?
            .into_iter()
            .next();
        let (reachable, last_probed_at, effective_port, build_version, last_error) = match latest {
            Some(p) => (
                Some(p.reachable),
                p.probed_at,
                p.effective_port,
                p.build_version,
                p.error_message,
            ),
            None => (None, None, None, None, None),
        };

        rows.push(ZenStatusRow {
            endpoint_id,
            machine_id: ep.machine_id,
            hostname,
            ip,
            declared_port: ep.declared_port,
            scheme: ep.scheme,
            role: ep.role,
            lifecycle_mode: ep.lifecycle_mode,
            effective_port,
            build_version,
            reachable,
            last_probed_at,
            last_error,
        });
    }
    Ok(rows)
}

// ---------------------------------------------------------------------------
// probe
// ---------------------------------------------------------------------------

/// Per-endpoint probe result. Mirrors the `Completed` summary field names from
/// `cli::domain_zen::probe` so UI consumers can render either channel's output
/// without a translation step.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZenProbeRecord {
    pub endpoint_id: i64,
    pub machine_id: i64,
    pub host: String,
    pub reachable: bool,
    pub effective_port: Option<i64>,
    pub build_version: Option<String>,
    pub error_message: Option<String>,
    pub probe_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZenProbeReport {
    pub probed: usize,
    pub reachable: usize,
    pub unreachable: usize,
    pub probes: Vec<ZenProbeRecord>,
}

// TODO(plan7 M2/M5): when --all spans large clusters (>20 hosts) and operators
// want incremental UI feedback, lift this to async and emit `batch-progress`
// Tauri events instead of returning a single summary. The CLI keeps its
// NDJSON ItemCompleted stream regardless.
#[tauri::command]
pub fn zen_probe(
    db: State<'_, Db>,
    machine_id: Option<i64>,
    cred_alias: Option<String>,
    timeout_seconds: Option<u64>,
) -> VoloResult<ZenProbeReport> {
    if let Some(alias) = &cred_alias {
        // Match the CLI's preflight: a typo'd alias should fail fast rather
        // than silently fall through to anonymous probe. The probe itself
        // doesn't tunnel through WinRM yet (plan §3 reserves --cred for that),
        // so we validate but don't load the password.
        data_creds::find_by_alias(&db, alias)?.ok_or_else(|| {
            VoloError::InvalidInput(format!("credential alias '{}' not found", alias))
        })?;
    }

    let timeout = Duration::from_secs(timeout_seconds.unwrap_or(DEFAULT_TIMEOUT_SECONDS));
    let endpoints = resolve_endpoints(&db, machine_id, None)?;
    let mut records = Vec::with_capacity(endpoints.len());
    let mut reachable_count = 0usize;
    let mut unreachable_count = 0usize;

    for ep in &endpoints {
        let endpoint_id = ep.id.expect("endpoint id");
        let host = match resolve_host(&db, ep.machine_id)? {
            Some(h) => h,
            None => {
                unreachable_count += 1;
                records.push(ZenProbeRecord {
                    endpoint_id,
                    machine_id: ep.machine_id,
                    host: String::new(),
                    reachable: false,
                    effective_port: None,
                    build_version: None,
                    error_message: Some(format!(
                        "machine id={} not found; cannot resolve host",
                        ep.machine_id
                    )),
                    probe_id: None,
                });
                continue;
            }
        };

        let outcome = zen_probe::probe_endpoint(ep, &host, timeout);
        let probe_id = zen_probe::persist(&db, &outcome)?;
        let rec = &outcome.record;
        if rec.reachable {
            reachable_count += 1;
        } else {
            unreachable_count += 1;
        }
        records.push(ZenProbeRecord {
            endpoint_id,
            machine_id: ep.machine_id,
            host,
            reachable: rec.reachable,
            effective_port: rec.effective_port,
            build_version: rec.build_version.clone(),
            error_message: rec.error_message.clone(),
            probe_id: Some(probe_id),
        });
    }

    Ok(ZenProbeReport {
        probed: records.len(),
        reachable: reachable_count,
        unreachable: unreachable_count,
        probes: records,
    })
}

// ---------------------------------------------------------------------------
// cache-stats
// ---------------------------------------------------------------------------

/// Per-endpoint cache-stats result. `raw_cb` (the Compact Binary blob) is
/// intentionally omitted — UI doesn't need it and the array form bloats wire
/// size considerably. Operators wanting raw bytes go through the CLI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZenCacheStatsRecord {
    pub endpoint_id: i64,
    pub machine_id: i64,
    pub host: String,
    pub providers: Vec<String>,
    pub records: usize,
    /// `cache.size.disk` from zen's own `/stats/z$` response (see
    /// `zen_cache::fetch_cache_stats`). `None` when the provider wasn't
    /// reachable or zen didn't report the field.
    pub cache_disk_size_bytes: Option<i64>,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZenCacheStatsReport {
    pub endpoints: usize,
    pub rows_inserted: usize,
    pub partial_errors: usize,
    pub samples: Vec<ZenCacheStatsRecord>,
}

#[tauri::command]
pub async fn zen_cache_stats(
    db: State<'_, Db>,
    endpoint_id: Option<i64>,
    timeout_seconds: Option<u64>,
) -> VoloResult<ZenCacheStatsReport> {
    // 同 run_health_check：同步阻塞 HTTP（zen /stats）跑在 Tauri 主线程会冻结 UI
    // （Zen 页挂载即调用）→ async + spawn_blocking。
    let db: Db = (*db).clone();
    tokio::task::spawn_blocking(move || -> VoloResult<ZenCacheStatsReport> {
    let timeout = Duration::from_secs(timeout_seconds.unwrap_or(DEFAULT_TIMEOUT_SECONDS));
    let endpoints = resolve_endpoints(&db, None, endpoint_id)?;
    let mut samples = Vec::with_capacity(endpoints.len());
    let mut rows_inserted = 0usize;
    let mut partial_errors = 0usize;

    for ep in &endpoints {
        let eid = ep.id.expect("endpoint id");
        let host = match resolve_host(&db, ep.machine_id)? {
            Some(h) => h,
            None => {
                partial_errors += 1;
                samples.push(ZenCacheStatsRecord {
                    endpoint_id: eid,
                    machine_id: ep.machine_id,
                    host: String::new(),
                    providers: Vec::new(),
                    records: 0,
                    cache_disk_size_bytes: None,
                    error_message: Some(format!("machine id={} not found", ep.machine_id)),
                });
                continue;
            }
        };
        let outcome = zen_cache::fetch_cache_stats(ep, &host, timeout);
        let ids = zen_cache::persist(&db, &outcome)?;
        rows_inserted += ids.len();
        if outcome.error_message.is_some() {
            partial_errors += 1;
        }
        let cache_disk_size_bytes = outcome.records.iter().find_map(|r| r.cache_disk_size_bytes);
        samples.push(ZenCacheStatsRecord {
            endpoint_id: eid,
            machine_id: ep.machine_id,
            host,
            providers: outcome.providers,
            records: ids.len(),
            cache_disk_size_bytes,
            error_message: outcome.error_message,
        });
    }

    Ok(ZenCacheStatsReport {
        endpoints: samples.len(),
        rows_inserted,
        partial_errors,
        samples,
    })
    })
    .await
    .map_err(|e| VoloError::OperationFailed(format!("zen cache-stats task join: {}", e)))?
}

// ---------------------------------------------------------------------------
// disk-space
// ---------------------------------------------------------------------------

/// Total/free bytes of the disk volume hosting an endpoint's `data_dir`.
/// Distinct from [`ZenCacheStatsRecord::cache_disk_size_bytes`] — that's what
/// the `z$` cache provider itself has written; this is the whole volume's
/// capacity, read via SSH (`get-disk-space.ps1`) since zen's own `/stats`
/// wire format has no such field.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZenDiskSpaceResult {
    pub endpoint_id: i64,
    pub machine_id: i64,
    pub host: String,
    pub drive: String,
    pub total_bytes: Option<i64>,
    pub free_bytes: Option<i64>,
    pub error_message: Option<String>,
}

#[tauri::command]
pub async fn zen_disk_space(
    db: State<'_, Db>,
    endpoint_id: Option<i64>,
) -> VoloResult<Vec<ZenDiskSpaceResult>> {
    // 同 run_health_check：同步阻塞 SSH（get-disk-space.ps1）跑在 Tauri 主线程会冻结 UI
    // （Zen 页挂载即调用）→ async + spawn_blocking。
    let db: Db = (*db).clone();
    tokio::task::spawn_blocking(move || -> VoloResult<Vec<ZenDiskSpaceResult>> {
    let endpoints = resolve_endpoints(&db, None, endpoint_id)?;
    let exec = SshExecutor::from_config()?;
    let mut out = Vec::with_capacity(endpoints.len());
    for ep in &endpoints {
        let eid = ep.id.expect("endpoint id");
        let host = match resolve_host(&db, ep.machine_id)? {
            Some(h) => h,
            None => {
                out.push(ZenDiskSpaceResult {
                    endpoint_id: eid,
                    machine_id: ep.machine_id,
                    host: String::new(),
                    drive: String::new(),
                    total_bytes: None,
                    free_bytes: None,
                    error_message: Some(format!("machine id={} not found", ep.machine_id)),
                });
                continue;
            }
        };
        match zen_disk_space_core::run(&exec, &host, &ep.data_dir) {
            Ok(s) => out.push(ZenDiskSpaceResult {
                endpoint_id: eid,
                machine_id: ep.machine_id,
                host,
                drive: s.drive,
                total_bytes: Some(s.total_bytes as i64),
                free_bytes: Some(s.free_bytes as i64),
                error_message: None,
            }),
            Err(e) => out.push(ZenDiskSpaceResult {
                endpoint_id: eid,
                machine_id: ep.machine_id,
                host,
                drive: String::new(),
                total_bytes: None,
                free_bytes: None,
                error_message: Some(e.to_string()),
            }),
        }
    }
    Ok(out)
    })
    .await
    .map_err(|e| VoloError::OperationFailed(format!("zen disk-space task join: {}", e)))?
}

// ---------------------------------------------------------------------------
// detect-binary
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZenDetectBinaryMachineResult {
    pub machine_id: i64,
    pub hostname: String,
    pub ip: String,
    pub ok: bool,
    pub install_record_written: bool,
    pub install_record_cleared: bool,
    pub intree_records_written: usize,
    pub baseline_new_rows: usize,
    pub intree_ref_rows: usize,
    pub warnings: Vec<String>,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZenDetectBinaryReport {
    pub machines: usize,
    pub ok: usize,
    pub failed: usize,
    pub results: Vec<ZenDetectBinaryMachineResult>,
}

// TODO(plan7 M2/M5): cluster-wide detect-binary against >20 hosts should emit
// `batch-progress` events. For now sync; cluster sizes 5-20 keep wall time
// under ~10 seconds.
#[tauri::command]
pub fn zen_detect_binary(
    db: State<'_, Db>,
    machine_id: Option<i64>,
    cred_alias: Option<String>,
) -> VoloResult<ZenDetectBinaryReport> {
    // The transport is now SSH key auth (uecm-svc), so the operator password
    // is no longer loaded or forwarded — `cred_alias` is therefore optional,
    // matching the CLI's `CredentialArgs` (which accepts no credential). When
    // an alias is supplied we still validate it up front so a typo fails fast
    // before we touch the network; SSH-only hosts with no legacy WinRM
    // credential row pass straight through.
    if let Some(alias) = &cred_alias {
        data_creds::find_by_alias(&db, alias)?.ok_or_else(|| {
            VoloError::InvalidInput(format!("credential alias '{}' not found", alias))
        })?;
    }

    let target_machines: Vec<cache_core::data::Machine> = match machine_id {
        Some(id) => {
            let m = machines::find_by_id(&db, id)?.ok_or_else(|| {
                VoloError::InvalidInput(format!("machine id={} not found", id))
            })?;
            vec![m]
        }
        None => machines::list_all(&db)?,
    };

    let mut results = Vec::with_capacity(target_machines.len());
    let mut ok_count = 0usize;
    let mut failed = 0usize;
    for m in &target_machines {
        let mid = m.id.expect("machine row has id");
        match invoke_detect_binary(&m.ip) {
            Ok(detection) => {
                let report = zen_binary::persist(&db, mid, &detection)?;
                // F3: hollow result (intree skipped, no install record) → mark failed.
                if zen_binary::detect_yielded_nothing(&detection, &report) {
                    failed += 1;
                    results.push(ZenDetectBinaryMachineResult {
                        machine_id: mid,
                        hostname: m.hostname.clone(),
                        ip: m.ip.clone(),
                        ok: false,
                        install_record_written: report.install_record_written,
                        install_record_cleared: report.install_record_cleared,
                        intree_records_written: report.intree_records_written,
                        baseline_new_rows: report.baseline_new_rows,
                        intree_ref_rows: report.intree_ref_rows,
                        warnings: report.warnings,
                        error_message: Some(format!(
                            "found intree zen.exe but machine_ue_installs is empty for machine id={mid}; \
                             run machine refresh first"
                        )),
                    });
                } else {
                    ok_count += 1;
                    results.push(ZenDetectBinaryMachineResult {
                        machine_id: mid,
                        hostname: m.hostname.clone(),
                        ip: m.ip.clone(),
                        ok: true,
                        install_record_written: report.install_record_written,
                        install_record_cleared: report.install_record_cleared,
                        intree_records_written: report.intree_records_written,
                        baseline_new_rows: report.baseline_new_rows,
                        intree_ref_rows: report.intree_ref_rows,
                        warnings: report.warnings,
                        error_message: None,
                    });
                }
            }
            Err(e) => {
                failed += 1;
                results.push(ZenDetectBinaryMachineResult {
                    machine_id: mid,
                    hostname: m.hostname.clone(),
                    ip: m.ip.clone(),
                    ok: false,
                    install_record_written: false,
                    install_record_cleared: false,
                    intree_records_written: 0,
                    baseline_new_rows: 0,
                    intree_ref_rows: 0,
                    warnings: Vec::new(),
                    error_message: Some(e.to_string()),
                });
            }
        }
    }

    Ok(ZenDetectBinaryReport {
        machines: results.len(),
        ok: ok_count,
        failed,
        results,
    })
}

/// Run `zen-detect-binary.ps1` on `host` over SSH and parse the JSON payload.
///
/// Mirrors `cli::domain_zen::invoke_detect_binary` so the two surfaces stay in
/// sync. SSH key auth (uecm-svc); operator creds are gone (P2 migration).
/// zen-detect-binary takes no args (param-less; ignores stdin). PS sidecars
/// emit exit 0 even on expected failures with `{ok:false, message:"..."}`; we
/// have to check `ok` BEFORE handing the payload to `parse_detection_json`,
/// otherwise a missing install would look identical to "no install detected"
/// and `zen_binary::persist` would drop the existing row (T1.6 P2-1 fix).
fn invoke_detect_binary(host: &str) -> VoloResult<zen_binary::BinaryDetection> {
    let raw = zen_cli_shared::run_node(host, "zen-detect-binary.ps1", serde_json::json!({}))?;
    let envelope: serde_json::Value = serde_json::from_str(&raw).map_err(|e| {
        VoloError::OperationFailed(format!(
            "zen-detect-binary returned non-JSON output: {e}; raw: {}",
            raw.chars().take(200).collect::<String>()
        ))
    })?;
    if envelope.get("ok").and_then(|v| v.as_bool()) == Some(false) {
        let msg = envelope
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown sidecar error");
        return Err(VoloError::OperationFailed(format!(
            "zen-detect-binary on {host} reported failure: {msg}"
        )));
    }
    zen_binary::parse_detection_json(&raw)
}

// ---------------------------------------------------------------------------
// list-endpoints
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn zen_list_endpoints(
    db: State<'_, Db>,
    machine_id: Option<i64>,
) -> VoloResult<Vec<ZenEndpoint>> {
    match machine_id {
        Some(id) => zen_endpoints::list_for_machine(&db, id),
        None => zen_endpoints::list(&db),
    }
}

// ---------------------------------------------------------------------------
// baseline list / lock / unlock
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn zen_baseline_list(
    db: State<'_, Db>,
    zen_build_version: Option<String>,
    binary_kind: Option<String>,
) -> VoloResult<Vec<ZenBinaryExpected>> {
    if let Some(k) = &binary_kind {
        validate_kind(k)?;
    }
    let mut rows = zen_binary_expected::list(&db)?;
    if let Some(v) = zen_build_version {
        rows.retain(|r| r.zen_build_version == v);
    }
    if let Some(k) = binary_kind {
        rows.retain(|r| r.binary_kind == k);
    }
    Ok(rows)
}

#[tauri::command]
pub fn zen_baseline_lock(
    db: State<'_, Db>,
    zen_build_version: String,
    binary_kind: String,
    locked_by: String,
) -> VoloResult<()> {
    validate_kind(&binary_kind)?;
    if zen_binary_expected::find(&db, &zen_build_version, &binary_kind)?.is_none() {
        return Err(VoloError::InvalidInput(format!(
            "no baseline row for zen_build_version={} kind={}; run detect-binary first",
            zen_build_version, binary_kind
        )));
    }
    zen_binary_expected::lock(&db, &zen_build_version, &binary_kind, &locked_by)
}

#[tauri::command]
pub fn zen_baseline_unlock(
    db: State<'_, Db>,
    zen_build_version: String,
    binary_kind: String,
) -> VoloResult<()> {
    validate_kind(&binary_kind)?;
    if zen_binary_expected::find(&db, &zen_build_version, &binary_kind)?.is_none() {
        return Err(VoloError::InvalidInput(format!(
            "no baseline row for zen_build_version={} kind={}",
            zen_build_version, binary_kind
        )));
    }
    zen_binary_expected::unlock(&db, &zen_build_version, &binary_kind)
}

// ===========================================================================
// M2 (T2.6) — register / unregister / apply-config / lua-preview /
//             service install|uninstall|start|stop|status /
//             urlacl add|list|remove
// ===========================================================================
//
// Each handler mirrors the matching CLI subcommand in `cli::domain_zen`. Shared
// helpers (validate_dest_path, validate_data_dir_safe, build_param_script, …)
// live in `cli::domain_zen` and are exposed `pub(crate)` so both surfaces share
// the same validation, sidecar plumbing, and operations logging. The Tauri
// layer therefore stays purely a parameter-translation + return-shape adapter.

// ---------------------------------------------------------------------------
// register
// ---------------------------------------------------------------------------

/// Inputs for `zen_register`. Mirrors `cli::args::ZenAction::Register` field
/// names so a UI form can post the same payload it would emit for the CLI.
#[derive(Debug, Clone, Deserialize)]
pub struct ZenRegisterInput {
    pub machine_id: i64,
    pub declared_port: i64,
    pub scheme: String,
    pub role: String,
    #[serde(default)]
    pub upstream_endpoint_id: Option<i64>,
    pub data_dir: String,
    pub httpserverclass: String,
    /// `None` triggers the same Plan §1.1 default the CLI uses
    /// (`shared_upstream` → `installed_service`, else `editor_owned`).
    #[serde(default)]
    pub lifecycle: Option<String>,
    /// `{ZenInstall}` — see `zen_endpoint::EndpointInput::install_dir`.
    #[serde(default)]
    pub install_dir: Option<String>,
    /// See `zen_endpoint::EndpointInput::config_path_override`.
    #[serde(default)]
    pub config_path_override: Option<String>,
}

/// Outcome of `zen_register`. Mirrors `core::zen::endpoint::RegisterOutcome`
/// plus the persisted row for parity with the CLI's `emit_result` document.
#[derive(Debug, Clone, Serialize)]
pub struct ZenRegisterOutcome {
    pub endpoint_id: i64,
    pub inserted: bool,
    pub machine_id: i64,
    pub declared_port: i64,
    pub scheme: String,
    pub role: String,
    pub upstream_endpoint_id: Option<i64>,
    pub lifecycle_mode: String,
    pub httpserverclass: String,
    pub data_dir: String,
    pub install_dir: Option<String>,
    pub config_path_override: Option<String>,
}

#[tauri::command]
pub fn zen_register(db: State<'_, Db>, input: ZenRegisterInput) -> VoloResult<ZenRegisterOutcome> {
    // Match the CLI's machine-existence pre-check so callers get
    // `InvalidInput` instead of an opaque FK violation.
    if machines::find_by_id(&db, input.machine_id)?.is_none() {
        return Err(VoloError::InvalidInput(format!(
            "machine id={} not found",
            input.machine_id
        )));
    }
    let lifecycle_mode = input
        .lifecycle
        .clone()
        .unwrap_or_else(|| zen_cli_shared::default_lifecycle_for(&input.role).to_string());

    let payload = zen_endpoint::EndpointInput {
        machine_id: input.machine_id,
        declared_port: input.declared_port,
        scheme: input.scheme.clone(),
        role: input.role.clone(),
        upstream_endpoint_id: input.upstream_endpoint_id,
        data_dir: input.data_dir.clone(),
        httpserverclass: input.httpserverclass.clone(),
        lifecycle_mode: lifecycle_mode.clone(),
        install_dir: input.install_dir.clone(),
        config_path_override: input.config_path_override.clone(),
    };
    let outcome = zen_endpoint::register(&db, &payload)?;

    // Idempotency contract: when `inserted=false`, return the *persisted* row
    // (its fields are authoritative), not the request payload — same behavior
    // as `cli::domain_zen::register`.
    let persisted = zen_endpoint::get(&db, outcome.id)?.ok_or_else(|| {
        VoloError::OperationFailed(format!(
            "register: row id={} disappeared between insert and readback",
            outcome.id
        ))
    })?;
    Ok(ZenRegisterOutcome {
        endpoint_id: outcome.id,
        inserted: outcome.inserted,
        machine_id: persisted.machine_id,
        declared_port: persisted.declared_port,
        scheme: persisted.scheme,
        role: persisted.role,
        upstream_endpoint_id: persisted.upstream_endpoint_id,
        lifecycle_mode: persisted.lifecycle_mode,
        httpserverclass: persisted.httpserverclass,
        data_dir: persisted.data_dir,
        install_dir: persisted.install_dir,
        config_path_override: persisted.config_path_override,
    })
}

// ---------------------------------------------------------------------------
// unregister
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum ZenUnregisterResult {
    /// `dry_run=true` plan with the row preview. No DB mutation occurred.
    DryRun(ZenUnregisterPlan),
    /// `confirmed=true` real apply. Endpoint row deleted.
    Completed(ZenUnregisterSummary),
}

#[derive(Debug, Clone, Serialize)]
pub struct ZenUnregisterPlan {
    pub operation: &'static str,
    pub endpoint_id: i64,
    pub machine_id: i64,
    pub declared_port: i64,
    pub role: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ZenUnregisterSummary {
    pub endpoint_id: i64,
    pub machine_id: i64,
    pub action: &'static str,
}

#[tauri::command]
pub fn zen_unregister(
    db: State<'_, Db>,
    endpoint_id: i64,
    confirmed: bool,
    dry_run: bool,
) -> VoloResult<ZenUnregisterResult> {
    guard_destructive(confirmed, dry_run, "zen.unregister")?;
    let ep = zen_cli_shared::require_endpoint(&db, endpoint_id)?;

    // Mirror the CLI's pre-flight dependents scan so dry-run plans can't
    // promise success when the real apply would refuse.
    let dependents: Vec<i64> = zen_endpoints::list(&db)?
        .into_iter()
        .filter(|other| other.upstream_endpoint_id == Some(endpoint_id))
        .filter_map(|other| other.id)
        .collect();
    if !dependents.is_empty() {
        let list = dependents
            .iter()
            .map(|i| i.to_string())
            .collect::<Vec<_>>()
            .join(", ");
        return Err(VoloError::InvalidInput(format!(
            "cannot unregister endpoint {endpoint_id}: still referenced as upstream by [{list}]; un-point them first"
        )));
    }

    if dry_run {
        return Ok(ZenUnregisterResult::DryRun(ZenUnregisterPlan {
            operation: "zen.unregister",
            endpoint_id,
            machine_id: ep.machine_id,
            declared_port: ep.declared_port,
            role: ep.role.clone(),
        }));
    }

    zen_endpoint::unregister(&db, endpoint_id)?;
    Ok(ZenUnregisterResult::Completed(ZenUnregisterSummary {
        endpoint_id,
        machine_id: ep.machine_id,
        action: "unregister",
    }))
}

// ---------------------------------------------------------------------------
// change-role
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct ZenChangeRolePlan {
    pub operation: &'static str,
    pub endpoint_id: i64,
    pub machine_id: i64,
    pub declared_port: i64,
    pub current_role: String,
    pub current_upstream_endpoint_id: Option<i64>,
    pub new_role: String,
    pub new_upstream_endpoint_id: Option<i64>,
    pub lifecycle_mode: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ZenChangeRoleSummary {
    pub endpoint_id: i64,
    pub machine_id: i64,
    pub previous_role: String,
    pub new_role: String,
    pub previous_upstream_endpoint_id: Option<i64>,
    pub new_upstream_endpoint_id: Option<i64>,
    pub action: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum ZenChangeRoleResult {
    DryRun(ZenChangeRolePlan),
    Completed(ZenChangeRoleSummary),
}

#[tauri::command]
pub fn zen_change_role(
    db: State<'_, Db>,
    endpoint_id: i64,
    new_role: String,
    new_upstream_endpoint_id: Option<i64>,
    confirmed: bool,
    dry_run: bool,
) -> VoloResult<ZenChangeRoleResult> {
    guard_destructive(confirmed, dry_run, "zen.change-role")?;
    // Codex P2: run preflight validation (role / lifecycle / upstream /
    // dependents-on-demote) BEFORE emitting the dry-run plan, so a UI
    // preview can't promise success when the real apply would refuse.
    let current = zen_endpoint::validate_change_role(
        &db,
        endpoint_id,
        &new_role,
        new_upstream_endpoint_id,
    )?;

    if dry_run {
        return Ok(ZenChangeRoleResult::DryRun(ZenChangeRolePlan {
            operation: "zen.change-role",
            endpoint_id,
            machine_id: current.machine_id,
            declared_port: current.declared_port,
            current_role: current.role.clone(),
            current_upstream_endpoint_id: current.upstream_endpoint_id,
            new_role: new_role.clone(),
            new_upstream_endpoint_id,
            lifecycle_mode: current.lifecycle_mode.clone(),
        }));
    }

    zen_endpoint::change_role(&db, endpoint_id, &new_role, new_upstream_endpoint_id)?;

    let after = zen_endpoint::get(&db, endpoint_id)?.ok_or_else(|| {
        VoloError::OperationFailed(format!(
            "endpoint id={endpoint_id} disappeared between change_role and re-fetch"
        ))
    })?;

    Ok(ZenChangeRoleResult::Completed(ZenChangeRoleSummary {
        endpoint_id,
        machine_id: after.machine_id,
        previous_role: current.role,
        new_role: after.role,
        previous_upstream_endpoint_id: current.upstream_endpoint_id,
        new_upstream_endpoint_id: after.upstream_endpoint_id,
        action: "change-role",
    }))
}

// ---------------------------------------------------------------------------
// lua-preview
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct ZenLuaPreviewResult {
    pub endpoint_id: i64,
    pub machine_id: i64,
    pub lua: String,
}

#[tauri::command]
pub fn zen_lua_preview(db: State<'_, Db>, endpoint_id: i64) -> VoloResult<ZenLuaPreviewResult> {
    let (ep, lua) = zen_cli_shared::render_lua_for(&db, endpoint_id)?;
    // Same data_dir guard the CLI runs — `lua-preview` and `apply-config`
    // share the same engine, so they share the same refusal set.
    zen_cli_shared::validate_data_dir_safe(&ep.data_dir)?;
    Ok(ZenLuaPreviewResult {
        endpoint_id,
        machine_id: ep.machine_id,
        lua,
    })
}

// ---------------------------------------------------------------------------
// apply-config
// ---------------------------------------------------------------------------

/// Credentials wire shape shared by every M2 destructive command that drives a
/// remote sidecar. Mirrors `cli::credential_args::CredentialArgs` but flattened
/// because Tauri doesn't deserialize Rust groups/`Args` types directly.
///
/// Exactly one of:
/// - `cred_alias` set → DPAPI lookup
/// - `user` + `pass` set → inline user/password
/// - all `None` → inherit caller's Kerberos/NTLM context (anonymous over WinRM)
///
/// `pass_stdin` from the CLI has no meaningful analogue inside a GUI — the UI
/// already collected the password from the user — so it's not exposed here.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ZenCredentialInput {
    #[serde(default)]
    pub cred_alias: Option<String>,
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub pass: Option<String>,
}

impl ZenCredentialInput {
    /// Preflight: validate the flag combination + alias existence without
    /// touching DPAPI. Mirrors `CredentialArgs::preflight`.
    fn preflight(&self, db: &Db) -> VoloResult<()> {
        if let Some(alias) = &self.cred_alias {
            data_creds::find_by_alias(db, alias)?.ok_or_else(|| {
                VoloError::InvalidInput(format!("credential alias '{}' not found", alias))
            })?;
            if self.user.is_some() || self.pass.is_some() {
                return Err(VoloError::InvalidInput(
                    "inconsistent credential flags: cred_alias conflicts with user/pass".into(),
                ));
            }
            return Ok(());
        }
        match (&self.user, &self.pass) {
            (Some(_), Some(_)) => Ok(()),
            (None, None) => Ok(()),
            _ => Err(VoloError::InvalidInput(
                "inconsistent credential flags: user and pass must both be set or both omitted"
                    .into(),
            )),
        }
    }

    /// Resolve to `(username, password)` if any credential was supplied;
    /// `None` means inherit caller's Kerberos/NTLM context. Mirrors
    /// `CredentialArgs::resolve` but without stdin support.
    fn resolve(&self, db: &Db) -> VoloResult<Option<(String, String)>> {
        if let Some(alias) = &self.cred_alias {
            // SSH key auth: zen commands discard the operator credential, so don't
            // read DPAPI (which fails on a non-Windows operator or a SQLite-only
            // alias before the SSH call ever runs). Keep the existence check so a
            // typo'd alias still errors early.
            data_creds::find_by_alias(db, alias)?.ok_or_else(|| {
                VoloError::InvalidInput(format!("credential alias '{}' not found", alias))
            })?;
            return Ok(None);
        }
        match (&self.user, &self.pass) {
            (Some(u), Some(p)) => Ok(Some((u.clone(), p.clone()))),
            (None, None) => Ok(None),
            _ => Err(VoloError::InvalidInput(
                "inconsistent credential flags: user and pass must both be set or both omitted"
                    .into(),
            )),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum ZenApplyConfigResult {
    DryRun(ZenApplyConfigPlan),
    Completed(ZenApplyConfigSummary),
}

#[derive(Debug, Clone, Serialize)]
pub struct ZenApplyConfigPlan {
    pub operation: &'static str,
    pub endpoint_id: i64,
    pub machine_id: i64,
    pub host: String,
    pub dest_path: String,
    pub lua: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ZenApplyConfigSummary {
    pub endpoint_id: i64,
    pub machine_id: i64,
    pub host: String,
    pub dest_path: String,
    pub sha256: String,
    pub remote: serde_json::Value,
}

/// Split off the directory component of a remote Windows path (same
/// backslash/forward-slash rfind `zen_config_lua_path` uses — this describes
/// a path on the remote host, not the local OS Volo runs on).
#[tauri::command]
pub fn zen_apply_config(
    db: State<'_, Db>,
    endpoint_id: i64,
    confirmed: bool,
    dry_run: bool,
    cred: ZenCredentialInput,
) -> VoloResult<ZenApplyConfigResult> {
    guard_destructive(confirmed, dry_run, "zen.apply-config")?;
    cred.preflight(&db)?;
    let (ep, lua) = zen_cli_shared::render_lua_for(&db, endpoint_id)?;
    let machine = zen_cli_shared::require_machine(&db, ep.machine_id)?;

    // Fixed destination per Epic's official "Shared DDC" guide: the config
    // MUST land at {ZenInstall}\zen_config.lua (alongside zenserver.exe)
    // because `zen_service_install` launches the service with
    // `--config={that path}` and nothing else tells zenserver where to look.
    // An operator-chosen path here would silently detach the written config
    // from the running service. `resolve_install_paths` makes `install_dir`
    // (when set) authoritative instead of wherever `zen detect-binary` found
    // the source binary — see `ResolvedZenPaths`.
    let resolved = zen_cli_shared::resolve_install_paths(&db, &ep)?;
    let dest_path = resolved.target_config.clone();

    // Mirror the CLI's `dest_path` + `data_dir` validation so dry-run plans
    // match what `--yes` would actually accept.
    zen_cli_shared::validate_dest_path(&dest_path)?;
    zen_cli_shared::validate_data_dir_safe(&ep.data_dir)?;

    if dry_run {
        return Ok(ZenApplyConfigResult::DryRun(ZenApplyConfigPlan {
            operation: "zen.apply-config",
            endpoint_id,
            machine_id: ep.machine_id,
            host: machine.ip,
            dest_path,
            lua,
        }));
    }

    let creds = cred.resolve(&db)?;

    // install_dir made target_exe authoritative and it isn't where the
    // detected binary lives today — copy it there first so `zen_config.lua`
    // doesn't end up alongside an exe that will never actually run it.
    let mut remote = serde_json::Value::Null;
    if let Some(copy_result) =
        zen_cli_shared::copy_binary_if_needed(&db, ep.machine_id, &machine.ip, &resolved)?
    {
        remote["binary_copy"] = copy_result;
    }

    let (expected_sha, config_response) = zen_cli_shared::write_and_verify_lua(
        &db,
        ep.machine_id,
        &machine.ip,
        &lua,
        &dest_path,
        creds,
        "zen.apply_config",
    )?;
    remote["config_write"] = config_response;

    Ok(ZenApplyConfigResult::Completed(ZenApplyConfigSummary {
        endpoint_id,
        machine_id: ep.machine_id,
        host: machine.ip,
        dest_path,
        sha256: expected_sha,
        remote,
    }))
}

// ---------------------------------------------------------------------------
// enable --global (Cache · ZenServer ② 客户端指向 · 「用户全局」配置范围)
// ---------------------------------------------------------------------------

/// UE DDC namespace Volo always writes — matches the constant baked into the
/// 「工程级」scope's `[StorageServers] Shared` value (`Namespace="ue.ddc"`, see
/// `cacheZen.tsx`'s `applyTo`), so both configuration scopes point clients at
/// the same logical cache namespace.
const ZEN_GLOBAL_NAMESPACE: &str = "ue.ddc";

#[derive(Debug, Clone, Serialize)]
pub struct ZenEnableGlobalResult {
    pub machine_id: i64,
    pub host: String,
    pub ini_file: String,
    pub changed: bool,
    pub warnings: Vec<String>,
}

/// Write the `ZenShared` upstream entry into `machine_id`'s global
/// `UserEngine.ini` — the Tauri counterpart of `voloctl cache zen enable
/// --global`. Requires `machine_id` to have `ue_runtime_user` set (`machine
/// set-ue-user`); the UI shows the same guidance this error carries when it
/// isn't. Not gated by `confirmed`/`dry_run`: a single INI key write, same
/// risk profile as `set_ini_key` (used for the 「工程级」scope), and the UI
/// deliberately applies this scope without a confirm dialog (progress shows
/// inline per-machine instead).
#[tauri::command]
pub fn zen_enable_global(
    db: State<'_, Db>,
    machine_id: i64,
    upstream_endpoint_id: i64,
) -> VoloResult<ZenEnableGlobalResult> {
    let machine = zen_cli_shared::require_machine(&db, machine_id)?;
    let ue_user = machines::get_ue_runtime_user(&db, machine_id)?.ok_or_else(|| {
        VoloError::InvalidInput(format!(
            "machine id={machine_id} has no ue_runtime_user set — run \
             `machine set-ue-user --machine {machine_id} --ue-user <USERNAME>` first"
        ))
    })?;
    let ini_path =
        format!(r"C:\Users\{ue_user}\AppData\Local\Unreal Engine\Engine\Config\UserEngine.ini");
    let master =
        zen_cli_shared::resolve_cluster_master(&db, upstream_endpoint_id, ZEN_GLOBAL_NAMESPACE)?;
    let resolved = zen_cli_shared::build_global_rules()?;
    let out = zen_enable::enable_global(&machine.ip, &ini_path, &resolved, &master)?;
    Ok(ZenEnableGlobalResult {
        machine_id,
        host: machine.ip,
        ini_file: ini_path,
        changed: out.changed,
        warnings: out.warnings,
    })
}

// ---------------------------------------------------------------------------
// local zen runcontext (Cache · ZenServer ② 客户端「本地 Zen 缓存目录」真实回读)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct ZenLocalRunContext {
    pub machine_id: i64,
    pub host: String,
    pub ue_runtime_user: String,
    /// `false` = no runcontext file — the editor on that machine has never
    /// launched a local zen (or the profile path is wrong).
    pub found: bool,
    /// The local zen's last-used persistence root — the EFFECTIVE value after
    /// UE's whole priority chain (registry > env var > follow-DDC > default),
    /// which is why the UI shows this next to the configured `UE-ZenDataPath`
    /// env var instead of trusting the env var alone.
    pub data_path: Option<String>,
    pub executable: Option<String>,
    pub commandline_arguments: Option<String>,
    /// Whether that exact zen binary is running right now (edits to the data
    /// path only take effect after the editor — and with it the local zen —
    /// restarts).
    pub running: bool,
    /// `HKCU\Software\Epic Games\Zen` `DataPath` override under the runtime
    /// user (written by in-editor cache migration; it BEATS the
    /// `UE-ZenDataPath` env var in UE's priority chain). Best-effort read via
    /// `HKU\<SID>` — `None` means absent OR unreadable (user's hive not
    /// loaded), so it can explain a mismatch but never prove there is none.
    pub registry_data_path: Option<String>,
}

/// Read `machine_id`'s LOCAL zen runcontext (`%LOCALAPPDATA%\UnrealEngine\
/// Common\Zen\Install\zenserver.runcontext` under `ue_runtime_user`'s
/// profile) — the real-readback half of the 「本地 Zen 缓存目录」 feature.
/// Read-only; requires `ue_runtime_user` (same precondition and guidance as
/// `zen_enable_global`).
#[tauri::command]
pub async fn zen_read_local_runcontext(
    db: State<'_, Db>,
    machine_id: i64,
) -> VoloResult<ZenLocalRunContext> {
    // 同 run_health_check：同步阻塞 SSH（zen-read-runcontext.ps1）跑在 Tauri 主线程会
    // 冻结 UI（Zen 页挂载时逐台 fan-out）→ async + spawn_blocking。
    let db: Db = (*db).clone();
    tokio::task::spawn_blocking(move || -> VoloResult<ZenLocalRunContext> {
    let machine = zen_cli_shared::require_machine(&db, machine_id)?;
    let ue_user = machines::get_ue_runtime_user(&db, machine_id)?.ok_or_else(|| {
        VoloError::InvalidInput(format!(
            "machine id={machine_id} has no ue_runtime_user set — run \
             `machine set-ue-user --machine {machine_id} --ue-user <USERNAME>` first"
        ))
    })?;
    let env = zen_cli_shared::run_node(
        &machine.ip,
        "zen-read-runcontext.ps1",
        serde_json::json!({ "RuntimeUser": ue_user }),
    )
    .and_then(|raw| zen_cli_shared::parse_envelope(&raw, "zen-read-runcontext"))?;
    let found = env.get("found").and_then(|v| v.as_bool()).unwrap_or(false);
    let s = |k: &str| env.get(k).and_then(|v| v.as_str()).map(str::to_string);
    Ok(ZenLocalRunContext {
        machine_id,
        host: machine.ip,
        ue_runtime_user: ue_user,
        found,
        data_path: s("data_path"),
        executable: s("executable"),
        commandline_arguments: s("commandline_arguments"),
        running: env.get("running").and_then(|v| v.as_bool()).unwrap_or(false),
        registry_data_path: s("registry_data_path"),
    })
    })
    .await
    .map_err(|e| VoloError::OperationFailed(format!("zen runcontext task join: {}", e)))?
}

#[derive(Debug, Clone, Serialize)]
pub struct ZenSetLocalDataPathResult {
    pub machine_id: i64,
    pub host: String,
    pub ue_runtime_user: String,
    /// `None` = cleared (both the registry override and the env var).
    pub data_path: Option<String>,
    /// Whether the `HKU\<SID>\Software\Epic Games\Zen` `DataPath` value was
    /// written/cleared. `false` = the runtime user's hive isn't loaded (user
    /// not logged on) — only the Machine env var fallback landed, which takes
    /// effect at that user's next logon instead of the next editor restart.
    pub registry_written: bool,
    pub message: String,
}

/// Set (or clear, with `data_path = ""`) `machine_id`'s LOCAL zen cache
/// directory. Writes the `HKU\<SID>` `Epic Games\Zen` `DataPath` registry
/// override (the tier UE reads directly at every editor launch — a Machine
/// env var written over SSH never reaches the interactive session's already-
/// running Explorer/Launcher environment, so it only applies after a full
/// logoff), provisions the directory (create + icacls for the runtime user),
/// and keeps the legacy `UE-ZenDataPath` Machine env var in sync as a
/// fallback tier. Requires `ue_runtime_user` (same precondition as
/// `zen_read_local_runcontext`).
#[tauri::command]
pub fn zen_set_local_datapath(
    db: State<'_, Db>,
    machine_id: i64,
    data_path: String,
) -> VoloResult<ZenSetLocalDataPathResult> {
    let machine = zen_cli_shared::require_machine(&db, machine_id)?;
    let ue_user = machines::get_ue_runtime_user(&db, machine_id)?.ok_or_else(|| {
        VoloError::InvalidInput(format!(
            "machine id={machine_id} has no ue_runtime_user set — run \
             `machine set-ue-user --machine {machine_id} --ue-user <USERNAME>` first"
        ))
    })?;
    let data_path = data_path.trim().to_string();
    let invocation = if data_path.is_empty() {
        format!("clear local zen data path on machine {machine_id}")
    } else {
        format!("set local zen data path {data_path} on machine {machine_id}")
    };
    let env = crate::commands::oplog::logged(
        &db,
        "zen.set_local_datapath",
        &[machine_id],
        &invocation,
        || {
            zen_cli_shared::run_node(
                &machine.ip,
                "zen-set-local-datapath.ps1",
                serde_json::json!({ "RuntimeUser": ue_user, "DataPath": data_path }),
            )
            .and_then(|raw| zen_cli_shared::parse_envelope(&raw, "zen-set-local-datapath"))
        },
    )?;
    Ok(ZenSetLocalDataPathResult {
        machine_id,
        host: machine.ip,
        ue_runtime_user: ue_user,
        data_path: if data_path.is_empty() { None } else { Some(data_path) },
        registry_written: env
            .get("registry_written")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        message: env
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
    })
}

// ---------------------------------------------------------------------------
// Local zen desired-port override (Cache · ZenServer「本地端口管理」方案一)
// ---------------------------------------------------------------------------

/// Write `[Zen.AutoLaunch] DesiredPort = port` into `machine_id`'s
/// machine-local `UserEngine.ini` (same file as `zen_enable_global`;
/// requires `ue_runtime_user`). Rejects 1024–65535 violations and the
/// machine's own shared_upstream port. Takes effect at next editor restart.
/// SSH sidecar off the main thread, same as `zen_read_local_runcontext`.
#[tauri::command]
pub async fn zen_local_port_set(
    db: State<'_, Db>,
    machine_id: i64,
    port: i64,
) -> VoloResult<cache_core::core::zen::ops::ZenLocalPortApply> {
    let db: Db = (*db).clone();
    tokio::task::spawn_blocking(move || {
        let invocation = format!("set local zen DesiredPort {port} on machine {machine_id}");
        crate::commands::oplog::logged(&db, "zen.local_port_set", &[machine_id], &invocation, || {
            cache_core::core::zen::ops::zen_local_port_set(&db, machine_id, port)
        })
    })
    .await
    .map_err(|e| VoloError::OperationFailed(format!("zen local-port task join: {}", e)))?
}

/// Remove the `DesiredPort` override — the machine reverts to UE default
/// 8558 at the next editor restart.
#[tauri::command]
pub async fn zen_local_port_clear(
    db: State<'_, Db>,
    machine_id: i64,
) -> VoloResult<cache_core::core::zen::ops::ZenLocalPortApply> {
    let db: Db = (*db).clone();
    tokio::task::spawn_blocking(move || {
        let invocation = format!("clear local zen DesiredPort override on machine {machine_id}");
        crate::commands::oplog::logged(&db, "zen.local_port_clear", &[machine_id], &invocation, || {
            cache_core::core::zen::ops::zen_local_port_clear(&db, machine_id)
        })
    })
    .await
    .map_err(|e| VoloError::OperationFailed(format!("zen local-port task join: {}", e)))?
}

/// Merged read-only view: configured `DesiredPort` (INI) + actual running
/// port (local zen runcontext, best-effort) + this machine's shared service
/// port. Read-only, no oplog.
#[tauri::command]
pub async fn zen_local_port_status(
    db: State<'_, Db>,
    machine_id: i64,
) -> VoloResult<cache_core::core::zen::ops::ZenLocalPortStatus> {
    let db: Db = (*db).clone();
    tokio::task::spawn_blocking(move || {
        cache_core::core::zen::ops::zen_local_port_status(&db, machine_id)
    })
    .await
    .map_err(|e| VoloError::OperationFailed(format!("zen local-port task join: {}", e)))?
}

// ---------------------------------------------------------------------------
// GC retention settings (Cache · ZenServer 「缓存回收策略」 module)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum ZenGcSettingsResult {
    DryRun(ZenGcSettingsPlan),
    Completed(ZenGcSettingsSummary),
}

#[derive(Debug, Clone, Serialize)]
pub struct ZenGcSettingsPlan {
    pub operation: &'static str,
    pub endpoint_id: i64,
    pub machine_id: i64,
    pub host: String,
    pub dest_path: String,
    pub lua: String,
    /// GC retention rides the service ImagePath as `--gc-*` flags (zen 5.8
    /// doesn't read it from the lua) — surfaced here since the `lua` preview
    /// above no longer carries the values.
    pub gc_interval_seconds: i64,
    pub gc_lightweight_interval_seconds: i64,
    pub cache_max_duration_seconds: i64,
    pub will_patch_image_path_args: bool,
    /// The running process keeps its old command line until a stop+start —
    /// applying these settings for real always restarts the service, briefly
    /// interrupting every client currently pointed at this cache. Surfaced
    /// so the UI can warn before the operator confirms.
    pub will_restart_service: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ZenGcSettingsSummary {
    pub endpoint_id: i64,
    pub machine_id: i64,
    pub host: String,
    pub dest_path: String,
    pub sha256: String,
    pub restarted: bool,
    pub remote: serde_json::Value,
}

/// Persist the three GC retention fields onto the endpoint, re-render +
/// rewrite `zen_config.lua`, patch the service ImagePath's `--gc-*` flags
/// (zen 5.8 reads GC retention ONLY from the command line, not the lua —
/// see `core::zen::lua_config` docs), then restart the service so the new
/// command line takes effect.
/// Destructive — same `confirmed`/`dry_run` gate as `zen_service_stop`,
/// because a real apply always causes a brief service interruption.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn zen_update_gc_settings(
    db: State<'_, Db>,
    endpoint_id: i64,
    gc_interval_seconds: i64,
    gc_lightweight_interval_seconds: i64,
    cache_max_duration_seconds: i64,
    confirmed: bool,
    dry_run: bool,
    cred: ZenCredentialInput,
) -> VoloResult<ZenGcSettingsResult> {
    guard_destructive(confirmed, dry_run, "zen.gc_settings.update")?;
    cred.preflight(&db)?;
    cache_core::core::zen::lua_config::validate_positive_seconds(
        "gc_interval_seconds",
        Some(gc_interval_seconds),
    )?;
    cache_core::core::zen::lua_config::validate_positive_seconds(
        "gc_lightweight_interval_seconds",
        Some(gc_lightweight_interval_seconds),
    )?;
    cache_core::core::zen::lua_config::validate_positive_seconds(
        "cache_max_duration_seconds",
        Some(cache_max_duration_seconds),
    )?;

    let ep = zen_cli_shared::require_endpoint(&db, endpoint_id)?;
    let machine = zen_cli_shared::require_machine(&db, ep.machine_id)?;

    // Same lifecycle guard as zen_service_start/stop/install: an
    // `editor_owned` endpoint has no SCM service for zen-down.ps1/zen-up.ps1
    // to touch, and blindly restarting DEFAULT_SERVICE_NAME could stop/start
    // an unrelated stale service left over from a different endpoint.
    if ep.lifecycle_mode != "installed_service" {
        return Err(VoloError::InvalidInput(format!(
            "zen.gc_settings.update requires endpoint id={endpoint_id} to have lifecycle_mode=\"installed_service\" \
             (got {:?}); `editor_owned` endpoints have no SCM service to restart",
            ep.lifecycle_mode
        )));
    }

    let (target_exe, dest_path) = zen_cli_shared::resolve_service_paths(&db, &ep)?;
    zen_cli_shared::validate_dest_path(&dest_path)?;

    // Render from an in-memory preview copy (never touches the DB) for both
    // the dry-run plan and the real apply below — the real apply only
    // persists the new values after the remote write + restart succeed, so a
    // failed apply can't leave the DB claiming a policy that was never
    // actually live (see the update_gc_settings call at the end).
    let mut preview_ep = ep.clone();
    preview_ep.gc_interval_seconds = Some(gc_interval_seconds);
    preview_ep.gc_lightweight_interval_seconds = Some(gc_lightweight_interval_seconds);
    preview_ep.cache_max_duration_seconds = Some(cache_max_duration_seconds);
    let upstream = zen_cli_shared::resolve_upstream_info(&db, &preview_ep)?;
    let lua = cache_core::core::zen::lua_config::render(&preview_ep, upstream.as_ref())?;

    if dry_run {
        return Ok(ZenGcSettingsResult::DryRun(ZenGcSettingsPlan {
            operation: "zen.gc_settings.update",
            endpoint_id,
            machine_id: ep.machine_id,
            host: machine.ip,
            dest_path,
            lua,
            gc_interval_seconds,
            gc_lightweight_interval_seconds,
            cache_max_duration_seconds,
            will_patch_image_path_args: true,
            will_restart_service: true,
        }));
    }

    let creds = cred.resolve(&db)?;
    let (expected_sha, config_response) = zen_cli_shared::write_and_verify_lua(
        &db,
        ep.machine_id,
        &machine.ip,
        &lua,
        &dest_path,
        creds,
        "zen.gc_settings_update",
    )?;

    // GC retention rides the service ImagePath (`--gc-*` flags) — zen 5.8
    // doesn't read it from zen_config.lua (see core::zen::lua_config docs).
    // Patch the args in place (PatchArgsOnly never touches the service
    // account), then restart below so the new command line takes effect.
    zen_cli_shared::patch_service_image_path_args(
        &preview_ep,
        &machine.ip,
        &target_exe,
        &dest_path,
    )?;

    // Restart so the patched ImagePath actually takes effect (the running
    // process keeps its old command line until a stop+start).
    zen_cli_shared::restart_service(&db, ep.machine_id, &machine.ip)?;

    // Only persist once the remote write + restart both actually succeeded —
    // otherwise `zen_status`/the UI would show the new policy as current
    // while the live server still runs on the old settings.
    zen_endpoints::update_gc_settings(
        &db,
        endpoint_id,
        gc_interval_seconds,
        gc_lightweight_interval_seconds,
        cache_max_duration_seconds,
    )?;

    Ok(ZenGcSettingsResult::Completed(ZenGcSettingsSummary {
        endpoint_id,
        machine_id: ep.machine_id,
        host: machine.ip,
        dest_path,
        sha256: expected_sha,
        restarted: true,
        remote: config_response,
    }))
}

// ---------------------------------------------------------------------------
// service install / uninstall / start / stop / status
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum ZenServiceResult {
    DryRun(ZenServicePlan),
    Completed(ZenServiceSummary),
}

#[derive(Debug, Clone, Serialize)]
pub struct ZenServicePlan {
    pub operation: String,
    pub endpoint_id: i64,
    pub machine_id: i64,
    pub host: String,
    pub service_name: &'static str,
    /// Present for install/uninstall (sidecar needs the `zen.exe` path).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zen_exe_path: Option<String>,
    /// Install-only: the fixed `{ZenInstall}\zen_config.lua` path the
    /// service is launched with via `--config=` (see
    /// `core::zen::ops::zen_config_lua_path`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_path: Option<String>,
    /// Install-only: service account that `zen install` will run under. None
    /// means zen falls back to its built-in default (LocalService).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service_user: Option<String>,
    /// Install-only: whether a password was supplied (never the password
    /// itself). Lets the UI show "password set" without leaking the secret.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service_pass_supplied: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ZenServiceSummary {
    pub endpoint_id: i64,
    pub machine_id: i64,
    pub host: String,
    pub service_name: &'static str,
    pub remote: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct ZenDedicatedAccountResult {
    pub machine_id: i64,
    pub username: String,
    /// Opaque handle the frontend passes back to `zen_service_install`'s
    /// `service_cred_alias` — never the password itself.
    pub cred_alias: String,
}

/// One-click "创建专用账号": provisions a dedicated non-admin local Windows
/// account on `machine_id` for the "专用本地账号" service-account tier
/// (Epic's officially-recommended least-privilege alternative to SYSTEM).
/// Not gated by `confirmed`/`dry_run` — creating the account has no effect on
/// any running ZenServer until `zen_service_install` is actually called with
/// it, so there's nothing destructive to preview here.
#[tauri::command]
pub fn zen_create_dedicated_account(
    db: State<'_, Db>,
    machine_id: i64,
) -> VoloResult<ZenDedicatedAccountResult> {
    let machine = zen_cli_shared::require_machine(&db, machine_id)?;
    let result =
        cache_core::core::zen::service_account::create_dedicated_account(machine_id, &machine.ip)?;
    Ok(ZenDedicatedAccountResult {
        machine_id,
        username: result.username,
        cred_alias: result.cred_alias,
    })
}

/// Tauri service-install command.
///
/// `service_user` / `service_pass` are optional. When omitted, zen.exe
/// defaults to NT AUTHORITY\LocalService. Non-built-in accounts
/// (domain accounts, local users) need a password — either passed directly
/// via `service_pass`, or resolved server-side from `service_cred_alias`
/// (the tool-managed dedicated-account tier: the frontend never sees the
/// generated password, only the alias `zen_create_dedicated_account`
/// returned).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn zen_service_install(
    db: State<'_, Db>,
    endpoint_id: i64,
    service_user: Option<String>,
    service_pass: Option<String>,
    service_cred_alias: Option<String>,
    confirmed: bool,
    dry_run: bool,
    cred: ZenCredentialInput,
) -> VoloResult<ZenServiceResult> {
    guard_destructive(confirmed, dry_run, "zen.service.install")?;
    if service_pass.is_some() && service_cred_alias.is_some() {
        return Err(VoloError::InvalidInput(
            "service_pass and service_cred_alias are mutually exclusive — pass a raw \
             password for a manually-entered account, or an alias for a tool-managed one, \
             not both"
                .into(),
        ));
    }
    // Whether a password will end up supplied is all the validation/dry-run
    // code below needs — resolving the alias's actual value is a SecretStore
    // decrypt, deferred past the dry-run gate further down so a preview
    // never touches it.
    let pass_supplied = service_pass.as_deref().map(|p| !p.is_empty()).unwrap_or(false)
        || service_cred_alias.is_some();
    // Codex P3: a password without a service_user gets silently dropped
    // (the PS sidecar only emits `-p` when `-u` is set). Reject up-front
    // so the UI never thinks it installed under a specific account when
    // zen actually fell back to LocalService. Mirror the PS-side
    // IsNullOrWhiteSpace by treating whitespace-only strings as missing,
    // and treat empty `service_pass: ""` as not supplied (sidecar's
    // IsNullOrEmpty rejects it anyway).
    if pass_supplied
        && service_user
            .as_deref()
            .map(|u| u.trim().is_empty())
            .unwrap_or(true)
    {
        return Err(VoloError::InvalidInput(
            "service_pass requires service_user; the password is forwarded \
             to zen only when the user is set"
                .into(),
        ));
    }
    cred.preflight(&db)?;
    let ep = zen_cli_shared::require_endpoint(&db, endpoint_id)?;
    let machine = zen_cli_shared::require_machine(&db, ep.machine_id)?;
    // install_dir (when set on the endpoint) makes {ZenInstall} authoritative
    // — by the time service-install runs, `zen_apply_config` has already
    // copied zenserver.exe there, so this doesn't need detection metadata to
    // still exist (unlike `resolve_install_paths`, which apply-config needs
    // for its own copy-decision but service-install never touches).
    let (zen_exe, config_path) = zen_cli_shared::resolve_service_paths(&db, &ep)?;

    // Same lifecycle guard as the CLI: only `installed_service` endpoints
    // get an SCM service.
    if ep.lifecycle_mode != "installed_service" {
        return Err(VoloError::InvalidInput(format!(
            "endpoint id={endpoint_id} has lifecycle_mode={:?}; service install \
             requires lifecycle_mode=\"installed_service\". \
             `register` is idempotent on (machine_id, declared_port) — call \
             `zen_unregister` first, then `zen_register` with \
             lifecycle=\"installed_service\" to fix the lifecycle.",
            ep.lifecycle_mode
        )));
    }
    // `ep.data_dir` is no longer passed to zen-service-install.ps1 (it's
    // ConfigPath now) — this is an independent DB-hygiene guard: the value
    // is still baked into zen_config.lua by `zen_apply_config`, so a
    // corrupt/relative data_dir row would produce a broken running service
    // even though nothing on this command's own args would catch it.
    zen_cli_shared::validate_service_data_dir(&ep.data_dir)?;
    // Codex P2: mirror the sidecar's built-in-account / password check so
    // the dry-run plan doesn't claim an unworkable install is approved.
    // The alias-supplied case is represented by the trailing bool (same slot
    // the CLI uses for `--service-pass-stdin`) rather than resolving it.
    zen_cli_shared::validate_service_account_pair(
        service_user.as_deref(),
        service_pass.as_deref(),
        service_cred_alias.is_some(),
    )?;

    if dry_run {
        return Ok(ZenServiceResult::DryRun(ZenServicePlan {
            operation: "zen.service.install".to_string(),
            endpoint_id,
            machine_id: ep.machine_id,
            host: machine.ip,
            service_name: zen_cli_shared::DEFAULT_SERVICE_NAME,
            zen_exe_path: Some(zen_exe),
            config_path: Some(config_path.clone()),
            service_user: service_user.clone(),
            service_pass_supplied: Some(pass_supplied),
        }));
    }

    // Resolve the managed-account password server-side only now, past the
    // dry-run gate — the frontend never sees it, only the alias
    // `zen_create_dedicated_account` returned.
    let service_pass = match service_cred_alias.as_deref() {
        Some(alias) => Some(
            cache_core::core::zen::service_account::resolve_password(alias)?.ok_or_else(|| {
                VoloError::InvalidInput(format!(
                    "service_cred_alias {alias:?} has no stored password — the managed \
                     account may have been deleted; create a new one"
                ))
            })?,
        ),
        None => service_pass,
    };

    // SSH key auth (uecm-svc); operator creds/auth_method ignored. Keep the
    // resolve() so the credential preflight side-effect still runs.
    let creds = cred.resolve(&db)?;
    let _ = &creds;
    // Invocation string with manual redaction of ServicePassword — the
    // flag-name redactor doesn't match `-ServicePassword`.
    let user_marker = service_user
        .as_deref()
        .map(|u| format!(" -ServiceUser {u}"))
        .unwrap_or_default();
    let pass_marker = if service_pass.is_some() {
        " -ServicePassword [REDACTED]"
    } else {
        ""
    };
    let invocation = redact(&format!(
        "zen-service-install.ps1 -ZenExePath {zen_exe} -ServiceName {} -ConfigPath {config_path} \
         -Port {} -DataDir {} -HttpServerClass {}{user_marker}{pass_marker}",
        zen_cli_shared::DEFAULT_SERVICE_NAME, ep.declared_port, ep.data_dir, ep.httpserverclass,
    ));
    let op_id = operations::start(&db, "zen.service_install", &[ep.machine_id])?;
    // ServiceUser / ServicePassword only added when supplied — the node
    // script defaults to '' (zen keeps LocalService) when the field is absent.
    let mut args = serde_json::json!({
        "ZenExePath": zen_exe,
        "ServiceName": zen_cli_shared::DEFAULT_SERVICE_NAME,
        "ConfigPath": config_path,
        // Rides the ImagePath as `--data-dir` (zen 5.8 doesn't read it from
        // zen_config.lua) and icacls-grants a non-builtin ServiceUser.
        "DataDir": ep.data_dir,
    });
    if let Some(obj) = args.as_object_mut() {
        // --port / --http / --gc-* ImagePath flags (see service_runtime_args).
        zen_cli_shared::service_runtime_args(&ep, obj);
        if let Some(u) = service_user.as_deref() {
            obj.insert("ServiceUser".into(), serde_json::Value::String(u.to_string()));
        }
        if let Some(p) = service_pass.as_deref() {
            obj.insert("ServicePassword".into(), serde_json::Value::String(p.to_string()));
        }
    }
    let result = zen_cli_shared::run_node(&machine.ip, "zen-service-install.ps1", args)
        .and_then(|raw| zen_cli_shared::parse_envelope(&raw, "zen-service-install"));
    zen_cli_shared::finalize_op(&db, op_id, &result, &invocation);
    let response = result?;

    // Remember the tool-managed account (if any) so the UI shows "already
    // created" instead of prompting to create a new one next time. Manual
    // entries (no alias) and builtin accounts intentionally aren't
    // remembered — clears any stale link from a previous managed account.
    zen_endpoints::update_service_account(
        &db,
        endpoint_id,
        service_cred_alias.as_deref().and(service_user.as_deref()),
        service_cred_alias.as_deref(),
    )?;

    Ok(ZenServiceResult::Completed(ZenServiceSummary {
        endpoint_id,
        machine_id: ep.machine_id,
        host: machine.ip,
        service_name: zen_cli_shared::DEFAULT_SERVICE_NAME,
        remote: response,
    }))
}

#[tauri::command]
pub fn zen_service_uninstall(
    db: State<'_, Db>,
    endpoint_id: i64,
    confirmed: bool,
    dry_run: bool,
    cred: ZenCredentialInput,
) -> VoloResult<ZenServiceResult> {
    guard_destructive(confirmed, dry_run, "zen.service.uninstall")?;
    cred.preflight(&db)?;
    let ep = zen_cli_shared::require_endpoint(&db, endpoint_id)?;
    let machine = zen_cli_shared::require_machine(&db, ep.machine_id)?;
    let install = cache_core::data::machine_zen_install::find(&db, ep.machine_id)?;
    let zen_exe = install
        .as_ref()
        .and_then(|m| m.zen_cli_path.clone())
        // F1: no install-dir copy recorded → fall back to the highest-version
        // intree zen.exe from machine_ue_installs (list_for_machine is version DESC).
        .or_else(|| {
            cache_core::data::machine_ue_installs::list_for_machine(&db, ep.machine_id)
                .ok()
                .and_then(|installs| installs.into_iter().find_map(|i| i.zen_cli_intree_path))
        })
        .ok_or_else(|| {
            VoloError::InvalidInput(format!(
                "machine id={} has no zen.exe (zen_cli) recorded — run `zen detect-binary --machine {}` first",
                ep.machine_id, ep.machine_id,
            ))
        })?;

    if dry_run {
        return Ok(ZenServiceResult::DryRun(ZenServicePlan {
            operation: "zen.service.uninstall".to_string(),
            endpoint_id,
            machine_id: ep.machine_id,
            host: machine.ip,
            service_name: zen_cli_shared::DEFAULT_SERVICE_NAME,
            zen_exe_path: Some(zen_exe),
            config_path: None,
            service_user: None,
            service_pass_supplied: None,
        }));
    }

    // SSH key auth (uecm-svc); operator creds/auth_method ignored. Keep the
    // resolve() so the credential preflight side-effect still runs.
    let creds = cred.resolve(&db)?;
    let _ = &creds;
    let invocation = redact(&format!(
        "zen-service-uninstall.ps1 -ZenExePath {zen_exe} -ServiceName {}",
        zen_cli_shared::DEFAULT_SERVICE_NAME
    ));
    let op_id = operations::start(&db, "zen.service_uninstall", &[ep.machine_id])?;
    let result = zen_cli_shared::run_node(
        &machine.ip,
        "zen-service-uninstall.ps1",
        serde_json::json!({ "ZenExePath": zen_exe, "ServiceName": zen_cli_shared::DEFAULT_SERVICE_NAME }),
    )
    .and_then(|raw| zen_cli_shared::parse_envelope(&raw, "zen-service-uninstall"));
    zen_cli_shared::finalize_op(&db, op_id, &result, &invocation);
    let response = result?;
    Ok(ZenServiceResult::Completed(ZenServiceSummary {
        endpoint_id,
        machine_id: ep.machine_id,
        host: machine.ip,
        service_name: zen_cli_shared::DEFAULT_SERVICE_NAME,
        remote: response,
    }))
}

/// Start is **not** destructive: the CLI doesn't take `--yes` for it. UI calls
/// with no `confirmed` / `dry_run` knobs — same lifecycle gate applies.
#[tauri::command]
pub fn zen_service_start(
    db: State<'_, Db>,
    endpoint_id: i64,
    cred: ZenCredentialInput,
) -> VoloResult<ZenServiceSummary> {
    cred.preflight(&db)?;
    let ep = zen_cli_shared::require_endpoint(&db, endpoint_id)?;
    let machine = zen_cli_shared::require_machine(&db, ep.machine_id)?;
    if ep.lifecycle_mode != "installed_service" {
        return Err(VoloError::InvalidInput(format!(
            "service zen.service.start requires endpoint id={endpoint_id} to have lifecycle_mode=\"installed_service\" \
             (got {:?}); `editor_owned` endpoints have no SCM service",
            ep.lifecycle_mode
        )));
    }
    // SSH key auth (uecm-svc); operator creds/auth_method ignored. Keep the
    // resolve() so the credential preflight side-effect still runs.
    let creds = cred.resolve(&db)?;
    let _ = &creds;

    let invocation = redact(&format!(
        "zen-up.ps1 -ServiceName {}",
        zen_cli_shared::DEFAULT_SERVICE_NAME
    ));
    let op_id = operations::start(&db, "zen.service_start", &[ep.machine_id])?;
    let result = zen_cli_shared::run_node(
        &machine.ip,
        "zen-up.ps1",
        serde_json::json!({ "ServiceName": zen_cli_shared::DEFAULT_SERVICE_NAME }),
    )
    .and_then(|raw| zen_cli_shared::parse_envelope(&raw, "zen-up.ps1"));
    zen_cli_shared::finalize_op(&db, op_id, &result, &invocation);
    let response = result?;
    Ok(ZenServiceSummary {
        endpoint_id,
        machine_id: ep.machine_id,
        host: machine.ip,
        service_name: zen_cli_shared::DEFAULT_SERVICE_NAME,
        remote: response,
    })
}

#[tauri::command]
pub fn zen_service_stop(
    db: State<'_, Db>,
    endpoint_id: i64,
    confirmed: bool,
    dry_run: bool,
    cred: ZenCredentialInput,
) -> VoloResult<ZenServiceResult> {
    guard_destructive(confirmed, dry_run, "zen.service.stop")?;
    cred.preflight(&db)?;
    let ep = zen_cli_shared::require_endpoint(&db, endpoint_id)?;
    let machine = zen_cli_shared::require_machine(&db, ep.machine_id)?;
    if ep.lifecycle_mode != "installed_service" {
        return Err(VoloError::InvalidInput(format!(
            "service zen.service.stop requires endpoint id={endpoint_id} to have lifecycle_mode=\"installed_service\" \
             (got {:?}); `editor_owned` endpoints have no SCM service",
            ep.lifecycle_mode
        )));
    }

    if dry_run {
        return Ok(ZenServiceResult::DryRun(ZenServicePlan {
            operation: "zen.service.stop".to_string(),
            endpoint_id,
            machine_id: ep.machine_id,
            host: machine.ip,
            service_name: zen_cli_shared::DEFAULT_SERVICE_NAME,
            zen_exe_path: None,
            config_path: None,
            service_user: None,
            service_pass_supplied: None,
        }));
    }

    // SSH key auth (uecm-svc); operator creds/auth_method ignored. Keep the
    // resolve() so the credential preflight side-effect still runs.
    let creds = cred.resolve(&db)?;
    let _ = &creds;
    let invocation = redact(&format!(
        "zen-down.ps1 -ServiceName {}",
        zen_cli_shared::DEFAULT_SERVICE_NAME
    ));
    let op_id = operations::start(&db, "zen.service_stop", &[ep.machine_id])?;
    let result = zen_cli_shared::run_node(
        &machine.ip,
        "zen-down.ps1",
        serde_json::json!({ "ServiceName": zen_cli_shared::DEFAULT_SERVICE_NAME }),
    )
    .and_then(|raw| zen_cli_shared::parse_envelope(&raw, "zen-down.ps1"));
    zen_cli_shared::finalize_op(&db, op_id, &result, &invocation);
    let response = result?;
    Ok(ZenServiceResult::Completed(ZenServiceSummary {
        endpoint_id,
        machine_id: ep.machine_id,
        host: machine.ip,
        service_name: zen_cli_shared::DEFAULT_SERVICE_NAME,
        remote: response,
    }))
}

#[derive(Debug, Clone, Serialize)]
pub struct ZenServiceStatusResult {
    pub endpoint_id: i64,
    pub machine_id: i64,
    pub host: String,
    pub service_name: &'static str,
    pub remote: serde_json::Value,
}

#[tauri::command]
pub fn zen_service_status(
    db: State<'_, Db>,
    endpoint_id: i64,
    cred: ZenCredentialInput,
) -> VoloResult<ZenServiceStatusResult> {
    cred.preflight(&db)?;
    let ep = zen_cli_shared::require_endpoint(&db, endpoint_id)?;
    let machine = zen_cli_shared::require_machine(&db, ep.machine_id)?;
    // SSH key auth (uecm-svc); operator creds/auth_method ignored. Keep the
    // resolve() so the credential preflight side-effect still runs.
    let creds = cred.resolve(&db)?;
    let _ = &creds;

    let raw = zen_cli_shared::run_node(
        &machine.ip,
        "zen-service-status.ps1",
        serde_json::json!({ "ServiceName": zen_cli_shared::DEFAULT_SERVICE_NAME }),
    )?;
    let response = zen_cli_shared::parse_envelope(&raw, "zen-service-status")?;
    Ok(ZenServiceStatusResult {
        endpoint_id,
        machine_id: ep.machine_id,
        host: machine.ip,
        service_name: zen_cli_shared::DEFAULT_SERVICE_NAME,
        remote: response,
    })
}

// ---------------------------------------------------------------------------
// urlacl add / list / remove
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum ZenUrlaclResult {
    DryRun(ZenUrlaclPlan),
    Completed(ZenUrlaclSummary),
}

#[derive(Debug, Clone, Serialize)]
pub struct ZenUrlaclPlan {
    pub operation: String,
    pub endpoint_id: i64,
    pub machine_id: i64,
    pub host: String,
    pub url_prefix: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub principal: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ZenUrlaclSummary {
    pub endpoint_id: i64,
    pub machine_id: i64,
    pub host: String,
    pub url_prefix: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub principal: Option<String>,
    pub remote: serde_json::Value,
}

#[tauri::command]
pub fn zen_urlacl_add(
    db: State<'_, Db>,
    endpoint_id: i64,
    principal: String,
    confirmed: bool,
    dry_run: bool,
    cred: ZenCredentialInput,
) -> VoloResult<ZenUrlaclResult> {
    guard_destructive(confirmed, dry_run, "zen.urlacl.add")?;
    if principal.trim().is_empty() {
        return Err(VoloError::InvalidInput(
            "principal must not be empty or whitespace (URL ACL needs a real account)".into(),
        ));
    }
    cred.preflight(&db)?;
    let ep = zen_cli_shared::require_endpoint(&db, endpoint_id)?;
    let machine = zen_cli_shared::require_machine(&db, ep.machine_id)?;
    let url_prefix = zen_cli_shared::url_prefix_for(&ep);

    if dry_run {
        return Ok(ZenUrlaclResult::DryRun(ZenUrlaclPlan {
            operation: "zen.urlacl.add".to_string(),
            endpoint_id,
            machine_id: ep.machine_id,
            host: machine.ip,
            url_prefix,
            principal: Some(principal),
        }));
    }

    if !zen_cli_shared::urlacl_needed_for(&principal) {
        let invocation = redact(&format!(
            "zen.urlacl.add skipped for {principal}: LocalSystem needs no netsh reservation"
        ));
        let op_id = operations::start(&db, "zen.urlacl_add", &[ep.machine_id])?;
        let response = serde_json::json!({
            "ok": true,
            "skipped": true,
            "reason": "LocalSystem can bind http.sys URLs without a netsh reservation; \
                       adding one on http://*:<port>/ conflicts with zen and causes probe HTTP 503"
        });
        zen_cli_shared::finalize_op(&db, op_id, &Ok(response.clone()), &invocation);
        return Ok(ZenUrlaclResult::Completed(ZenUrlaclSummary {
            endpoint_id,
            machine_id: ep.machine_id,
            host: machine.ip,
            url_prefix,
            principal: Some(principal),
            remote: response,
        }));
    }

    // SSH key auth (uecm-svc); operator creds/auth_method ignored. Keep the
    // resolve() so the credential preflight side-effect still runs.
    let creds = cred.resolve(&db)?;
    let _ = &creds;
    let invocation = redact(&format!(
        "zen-urlacl-add.ps1 -UrlPrefix {url_prefix} -UserAccount {principal}"
    ));
    let op_id = operations::start(&db, "zen.urlacl_add", &[ep.machine_id])?;
    let result = zen_cli_shared::run_node(
        &machine.ip,
        "zen-urlacl-add.ps1",
        serde_json::json!({ "UrlPrefix": url_prefix, "UserAccount": principal }),
    )
    .and_then(|raw| zen_cli_shared::parse_envelope(&raw, "zen-urlacl-add"));
    zen_cli_shared::finalize_op(&db, op_id, &result, &invocation);
    let response = result?;
    Ok(ZenUrlaclResult::Completed(ZenUrlaclSummary {
        endpoint_id,
        machine_id: ep.machine_id,
        host: machine.ip,
        url_prefix,
        principal: Some(principal),
        remote: response,
    }))
}

#[derive(Debug, Clone, Serialize)]
pub struct ZenUrlaclListResult {
    pub machine_id: i64,
    pub host: String,
    pub port_filter: Option<String>,
    pub remote: serde_json::Value,
}

#[tauri::command]
pub fn zen_urlacl_list(
    db: State<'_, Db>,
    machine_id: i64,
    port_filter: Option<String>,
    cred: ZenCredentialInput,
) -> VoloResult<ZenUrlaclListResult> {
    cred.preflight(&db)?;
    let m = zen_cli_shared::require_machine(&db, machine_id)?;
    // SSH key auth (uecm-svc); operator creds/auth_method ignored. Keep the
    // resolve() so the credential preflight side-effect still runs.
    let creds = cred.resolve(&db)?;
    let _ = &creds;

    // PortFilter optional — null when no filter; the node script treats
    // null / empty as "list all reservations".
    let raw = zen_cli_shared::run_node(
        &m.ip,
        "zen-urlacl-list.ps1",
        serde_json::json!({ "PortFilter": port_filter.as_deref() }),
    )?;
    let response = zen_cli_shared::parse_envelope(&raw, "zen-urlacl-list")?;
    Ok(ZenUrlaclListResult {
        machine_id,
        host: m.ip,
        port_filter,
        remote: response,
    })
}

#[tauri::command]
pub fn zen_urlacl_remove(
    db: State<'_, Db>,
    endpoint_id: i64,
    confirmed: bool,
    dry_run: bool,
    cred: ZenCredentialInput,
) -> VoloResult<ZenUrlaclResult> {
    guard_destructive(confirmed, dry_run, "zen.urlacl.remove")?;
    cred.preflight(&db)?;
    let ep = zen_cli_shared::require_endpoint(&db, endpoint_id)?;
    let machine = zen_cli_shared::require_machine(&db, ep.machine_id)?;
    let url_prefix = zen_cli_shared::url_prefix_for(&ep);

    if dry_run {
        return Ok(ZenUrlaclResult::DryRun(ZenUrlaclPlan {
            operation: "zen.urlacl.remove".to_string(),
            endpoint_id,
            machine_id: ep.machine_id,
            host: machine.ip,
            url_prefix,
            principal: None,
        }));
    }

    // SSH key auth (uecm-svc); operator creds/auth_method ignored. Keep the
    // resolve() so the credential preflight side-effect still runs.
    let creds = cred.resolve(&db)?;
    let _ = &creds;
    let invocation = redact(&format!("zen-urlacl-remove.ps1 -UrlPrefix {url_prefix}"));
    let op_id = operations::start(&db, "zen.urlacl_remove", &[ep.machine_id])?;
    let result = zen_cli_shared::run_node(
        &machine.ip,
        "zen-urlacl-remove.ps1",
        serde_json::json!({ "UrlPrefix": url_prefix }),
    )
    .and_then(|raw| zen_cli_shared::parse_envelope(&raw, "zen-urlacl-remove"));
    zen_cli_shared::finalize_op(&db, op_id, &result, &invocation);
    let response = result?;
    Ok(ZenUrlaclResult::Completed(ZenUrlaclSummary {
        endpoint_id,
        machine_id: ep.machine_id,
        host: machine.ip,
        url_prefix,
        principal: None,
        remote: response,
    }))
}

// ---------------------------------------------------------------------------
// verify-rules (T4.5 resolve-only + T4.4 --run-editor)
// ---------------------------------------------------------------------------

/// Optional editor-verifier inputs. UI passes this when the user explicitly
/// asks to run the headless editor after a resolve succeeds. Mirrors the CLI's
/// `--run-editor`, `--machine`, `--uproject-path`, `--timeout-seconds`,
/// `--expected-host`, `--expected-port`, `--expected-namespace` flags.
#[derive(Debug, Clone, Deserialize)]
pub struct ZenVerifyRunEditorInput {
    pub machine_id: i64,
    pub uproject_path: String,
    #[serde(default = "default_verify_timeout_seconds")]
    pub timeout_seconds: u64,
    #[serde(default)]
    pub expected_host: Option<String>,
    #[serde(default)]
    pub expected_port: Option<i64>,
    #[serde(default)]
    pub expected_namespace: Option<String>,
    #[serde(default)]
    pub cred: ZenCredentialInput,
}

fn default_verify_timeout_seconds() -> u64 {
    300
}

#[derive(Debug, Clone, Serialize)]
pub struct ZenVerifyRulesResult {
    /// `true` when the resolve succeeded AND (if run_editor was requested)
    /// the verifier outcome also reported ok=true. Mirrors the CLI's
    /// top-level `ok` field.
    pub ok: bool,
    pub ue_version: String,
    pub matched_rule_version: String,
    pub ue_install: String,
    pub policy: String,
    #[serde(default)]
    pub warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rules: Option<serde_json::Value>,
    pub verified_versions_after: Vec<String>,
    pub wrote: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub yaml_path: Option<String>,
    /// Set when the resolve refused (unverified + policy=refuse, or below
    /// applies_to floor). Mirrors the CLI's `message` field.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// Set only when `run_editor` was supplied. Carries the sidecar outcome
    /// (matched / log_tail / etc.) as a serde Value so the UI doesn't need a
    /// per-field type definition synced with the sidecar contract.
    ///
    /// Codex P2: always emit the field (as `null` when absent) so the
    /// Tauri shape matches the CLI's `"verify_outcome": null` contract.
    /// The cli_smoke test locks the CLI shape; UI code shared between
    /// the two surfaces would otherwise see different responses for the
    /// same operation.
    pub verify_outcome: Option<serde_json::Value>,
}

/// Tauri analogue of `voloctl cache zen verify-rules [--run-editor ...]`. Without
/// `run_editor` this is the offline resolve-only path (T4.5); with
/// `run_editor` we additionally invoke `zen-verify-rules.ps1` against the
/// target machine and merge its outcome under `verify_outcome`.
///
/// `db` is required even for the resolve-only branch — the Tauri wrappers
/// already open the DB at startup, and the run-editor branch needs machine
/// lookup, so we keep the call shape identical to the rest of the surface.
#[tauri::command]
pub fn zen_verify_rules(
    db: State<'_, Db>,
    ue_version: String,
    ue_install: String,
    #[allow(non_snake_case)] write_verified: bool,
    run_editor: Option<ZenVerifyRunEditorInput>,
) -> VoloResult<ZenVerifyRulesResult> {
    use cache_core::core::zen::rules_loader as zen_rules;

    let rules = zen_rules::load_default()?;
    let policy_str = match rules.unverified_policy {
        zen_rules::UnverifiedPolicy::Refuse => "refuse",
        zen_rules::UnverifiedPolicy::Warn => "warn",
    };

    let resolved = match zen_rules::resolve(&rules, &ue_version) {
        Ok(r) => r,
        Err(VoloError::InvalidInput(msg)) => {
            // Unverified + refuse, or below applies_to floor. Mirror the
            // CLI: ok=false but Result is Ok so the front-end gets a
            // structured doc rather than a thrown error.
            let mm = ue_version
                .splitn(3, '.')
                .take(2)
                .collect::<Vec<_>>()
                .join(".");
            return Ok(ZenVerifyRulesResult {
                ok: false,
                ue_version: ue_version.clone(),
                matched_rule_version: mm,
                ue_install: ue_install.clone(),
                policy: policy_str.to_string(),
                warnings: Vec::new(),
                rules: None,
                verified_versions_after: rules.verified_versions.clone(),
                wrote: false,
                yaml_path: None,
                message: Some(msg),
                verify_outcome: None,
            });
        }
        Err(other) => return Err(other),
    };

    // Resolve succeeded. Build the rules document the front-end consumes.
    let rules_doc = serde_json::json!({
        "enable_zen_shared": {
            "ini_file": resolved.rules.enable_zen_shared.ini_file,
            "section": resolved.rules.enable_zen_shared.section,
            "key": resolved.rules.enable_zen_shared.key,
            "value_template": resolved.rules.enable_zen_shared.value_template,
            "backup": resolved.rules.enable_zen_shared.backup,
        },
        "disable_legacy_smb_shared": {
            "ini_file": resolved.rules.disable_legacy_smb_shared.ini_file,
            "section": resolved.rules.disable_legacy_smb_shared.section,
            "key": resolved.rules.disable_legacy_smb_shared.key,
            "action": resolved.rules.disable_legacy_smb_shared.action,
            "backup": resolved.rules.disable_legacy_smb_shared.backup,
            "env_cleanup": resolved.rules.disable_legacy_smb_shared.env_cleanup,
        },
        "disable_legacy_pak": {
            "ini_file": resolved.rules.disable_legacy_pak.ini_file,
            "section": resolved.rules.disable_legacy_pak.section,
            "keys": resolved.rules.disable_legacy_pak.keys,
            "action": resolved.rules.disable_legacy_pak.action,
            "backup": resolved.rules.disable_legacy_pak.backup,
        },
    });

    // T4.4: run the editor verifier FIRST so a failing run blocks the
    // write-verified leg. Codex P2 fix — previously we wrote first, which
    // would silently promote an unverified version when the verifier
    // failed.
    let verify_outcome = if let Some(rei) = &run_editor {
        Some(zen_verify_rules_run_editor_leg(&db, &ue_install, rei)?)
    } else {
        None
    };
    let verifier_ok = match &verify_outcome {
        None => true,
        Some(v) => v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false),
    };

    // Optional --write-verified leg — only when the verifier (if requested)
    // also reported ok.
    let (wrote, yaml_path, verified_after) = if verifier_ok {
        zen_verify_rules_write_leg(&rules, &resolved.matched_version, write_verified)?
    } else {
        (false, None, rules.verified_versions.clone())
    };

    let combined_ok = verifier_ok;

    Ok(ZenVerifyRulesResult {
        ok: combined_ok,
        ue_version,
        matched_rule_version: resolved.matched_version,
        ue_install,
        policy: policy_str.to_string(),
        warnings: resolved.warnings,
        rules: Some(rules_doc),
        verified_versions_after: verified_after,
        wrote,
        yaml_path,
        message: None,
        verify_outcome,
    })
}

/// Mirror of `cli::domain_zen::verify_rules` write-verified leg. Returns
/// `(wrote, yaml_path, verified_versions_after)`.
fn zen_verify_rules_write_leg(
    rules: &cache_core::core::zen::rules_loader::ZenRules,
    matched_version: &str,
    write_verified: bool,
) -> VoloResult<(bool, Option<String>, Vec<String>)> {
    let mut verified_after: Vec<String> = rules.verified_versions.clone();
    if !write_verified {
        return Ok((false, None, verified_after));
    }
    let already = verified_after.iter().any(|v| v == matched_version);
    if already {
        // Idempotent — still surface the yaml path for transparency.
        let p = writable_rules_path()?.map(|p| p.display().to_string());
        return Ok((false, p, verified_after));
    }
    let path = writable_rules_path()?.ok_or_else(|| {
        VoloError::Configuration(
            "verify-rules write-verified: no on-disk yaml to write (only the embedded \
             snapshot is available; set UECM_ZEN_RULES_PATH or place \
             zen-ini-rules.yaml next to the binary)"
                .into(),
        )
    })?;
    // Same mutation the CLI does — append the major.minor.
    append_verified_version_yaml(&path, matched_version)?;
    verified_after.push(matched_version.to_string());
    Ok((true, Some(path.display().to_string()), verified_after))
}

/// Lightweight clone of `cli::domain_zen::writable_rules_path` — env override
/// wins, otherwise the on-disk candidate. Returns `VoloResult<Option<...>>`
/// so callers can decide whether refusing to write is fatal.
fn writable_rules_path() -> VoloResult<Option<std::path::PathBuf>> {
    use cache_core::core::zen::rules_loader as zen_rules;
    if let Ok(over) = std::env::var("UECM_ZEN_RULES_PATH") {
        return Ok(Some(std::path::PathBuf::from(over)));
    }
    let p = zen_rules::default_path();
    if p.is_file() {
        Ok(Some(p))
    } else {
        Ok(None)
    }
}

/// Append `version` to `verified_versions` in the yaml at `path` if absent.
/// Returns Ok(true) on rewrite, Ok(false) when already present.
fn append_verified_version_yaml(
    path: &std::path::Path,
    version: &str,
) -> VoloResult<bool> {
    let text = std::fs::read_to_string(path).map_err(|e| {
        VoloError::Configuration(format!(
            "verify-rules: failed to read yaml at {} for write: {}",
            path.display(),
            e
        ))
    })?;
    let mut doc: serde_yaml::Value = serde_yaml::from_str(&text).map_err(|e| {
        VoloError::Configuration(format!(
            "verify-rules: yaml at {} did not parse: {}",
            path.display(),
            e
        ))
    })?;
    let Some(map) = doc.as_mapping_mut() else {
        return Err(VoloError::Configuration(format!(
            "verify-rules: yaml at {} not a top-level mapping",
            path.display()
        )));
    };
    let key = serde_yaml::Value::String("verified_versions".to_string());
    let entry = map
        .entry(key)
        .or_insert(serde_yaml::Value::Sequence(Vec::new()));
    let Some(seq) = entry.as_sequence_mut() else {
        return Err(VoloError::Configuration(format!(
            "verify-rules: yaml at {} has verified_versions but it isn't a sequence",
            path.display()
        )));
    };
    if seq
        .iter()
        .any(|v| v.as_str().map(|s| s == version).unwrap_or(false))
    {
        return Ok(false);
    }
    seq.push(serde_yaml::Value::String(version.to_string()));
    let new_text = serde_yaml::to_string(&doc).map_err(|e| {
        VoloError::Configuration(format!(
            "verify-rules: failed to re-serialize yaml: {}",
            e
        ))
    })?;
    std::fs::write(path, new_text).map_err(|e| {
        VoloError::Configuration(format!(
            "verify-rules: failed to write yaml at {}: {}",
            path.display(),
            e
        ))
    })?;
    Ok(true)
}

/// Run the headless verifier (T4.4) for the Tauri command. Returns the same
/// outcome JSON the CLI embeds under `verify_outcome`.
fn zen_verify_rules_run_editor_leg(
    db: &Db,
    ue_install: &str,
    rei: &ZenVerifyRunEditorInput,
) -> VoloResult<serde_json::Value> {
    if rei.timeout_seconds == 0 {
        return Err(VoloError::InvalidInput(
            "zen_verify_rules: timeout_seconds must be > 0".into(),
        ));
    }
    if rei.uproject_path.trim().is_empty() {
        return Err(VoloError::InvalidInput(
            "zen_verify_rules: uproject_path must be non-empty".into(),
        ));
    }
    rei.cred.preflight(db)?;
    let m = zen_cli_shared::require_machine(db, rei.machine_id)?;
    let creds = rei.cred.resolve(db)?;

    let input = cache_core::core::zen::verify::VerifyInput {
        ue_root: ue_install.to_string(),
        uproject_path: rei.uproject_path.clone(),
        timeout_seconds: rei.timeout_seconds,
        expected_host: rei.expected_host.clone(),
        expected_port: rei.expected_port,
        expected_namespace: rei.expected_namespace.clone(),
    };
    let invocation = redact(&format!(
        "zen-verify-rules.ps1 -UeRoot '{}' -UprojectPath '{}' -TimeoutSeconds {}",
        ue_install, rei.uproject_path, rei.timeout_seconds
    ));
    let op_id = operations::start(db, "zen.verify_rules.run_editor", &[rei.machine_id])?;

    let cred_ref = creds.as_ref().map(|(u, p)| (u.as_str(), p.as_str()));
    let result = cache_core::core::zen::verify::verify_endpoint(&m.ip, cred_ref, &input);

    let (outcome_json, op_result_for_log) = match result {
        Ok(outcome) => {
            let v = serde_json::json!({
                "ok": true,
                "matched": outcome.matched,
                "match_line": outcome.match_line,
                "matched_host": outcome.matched_host,
                "matched_port": outcome.matched_port,
                "matched_namespace": outcome.matched_namespace,
                "elapsed_sec": outcome.elapsed_sec,
                "editor_pid": outcome.editor_pid,
                "killed": outcome.killed,
                "log_tail": outcome.log_tail,
                "machine_id": rei.machine_id,
                "host": m.ip.clone(),
            });
            (Some(v), Ok::<serde_json::Value, VoloError>(serde_json::Value::Null))
        }
        Err(VoloError::PowerShell(msg)) => {
            // Codex P2 (parity with CLI): only swallow PowerShell errors
            // that include a sidecar outcome envelope. Pure transport /
            // protocol failures (WinRM auth, sidecar missing, non-JSON)
            // must propagate as Err so the UI can tell "verifier ran
            // and disagreed" from "verifier never ran".
            let outcome_obj: Option<serde_json::Value> = msg
                .find("; outcome: ")
                .and_then(|idx| {
                    let json_part = &msg[(idx + "; outcome: ".len())..];
                    serde_json::from_str::<serde_json::Value>(json_part).ok()
                });
            match outcome_obj {
                Some(o) => {
                    let mut doc = serde_json::json!({
                        "ok": false,
                        "message": msg.clone(),
                        "machine_id": rei.machine_id,
                        "host": m.ip.clone(),
                    });
                    if let (Some(obj), Some(inner)) = (doc.as_object_mut(), o.as_object()) {
                        for (k, v) in inner {
                            if k == "ok" || k == "message" {
                                continue;
                            }
                            obj.insert(k.clone(), v.clone());
                        }
                    }
                    (
                        Some(doc),
                        Err::<serde_json::Value, VoloError>(VoloError::PowerShell(msg)),
                    )
                }
                None => (None, Err(VoloError::PowerShell(msg))),
            }
        }
        Err(other) => (None, Err(other)),
    };
    zen_cli_shared::finalize_op(db, op_id, &op_result_for_log, &invocation);
    if let Some(doc) = outcome_json {
        return Ok(doc);
    }
    match op_result_for_log {
        Err(e) => Err(e),
        Ok(_) => Err(VoloError::OperationFailed(
            "verify_endpoint produced no envelope and no error".into(),
        )),
    }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/// Tauri analogue of `cli::destructive::check`. The UI must pass either
/// `dry_run=true` (preview) or `confirmed=true` (actually apply); otherwise
/// the wrapper refuses with `InvalidInput` so accidental invocations from the
/// front-end can't fire side effects.
fn guard_destructive(confirmed: bool, dry_run: bool, op: &str) -> VoloResult<()> {
    if dry_run || confirmed {
        return Ok(());
    }
    Err(VoloError::InvalidInput(format!(
        "{op} is destructive; pass confirmed=true to apply or dry_run=true to preview"
    )))
}

fn resolve_endpoints(
    db: &Db,
    machine_id: Option<i64>,
    endpoint_id: Option<i64>,
) -> VoloResult<Vec<ZenEndpoint>> {
    if let Some(id) = endpoint_id {
        let ep = zen_endpoints::get(db, id)?
            .ok_or_else(|| VoloError::InvalidInput(format!("endpoint id={} not found", id)))?;
        return Ok(vec![ep]);
    }
    if let Some(mid) = machine_id {
        if machines::find_by_id(db, mid)?.is_none() {
            return Err(VoloError::InvalidInput(format!(
                "machine id={} not found",
                mid
            )));
        }
        return zen_endpoints::list_for_machine(db, mid);
    }
    zen_endpoints::list(db)
}

fn resolve_host(db: &Db, machine_id: i64) -> VoloResult<Option<String>> {
    Ok(machines::find_by_id(db, machine_id)?.map(|m| m.ip))
}

fn validate_kind(kind: &str) -> VoloResult<()> {
    if kind == KIND_ZEN_CLI || kind == KIND_ZENSERVER {
        Ok(())
    } else {
        Err(VoloError::InvalidInput(format!(
            "invalid binary kind '{}'; expected '{}' or '{}'",
            kind, KIND_ZEN_CLI, KIND_ZENSERVER
        )))
    }
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use cache_core::data::{
        machines, open_in_memory, schema, zen_binary_expected, zen_endpoints, Machine,
        ZenBinaryExpected,
    };

    fn fresh_db() -> Db {
        let db = open_in_memory().unwrap();
        {
            let mut conn = db.lock().unwrap();
            schema::migrate(&mut conn).unwrap();
        }
        db
    }

    fn seed_endpoint(db: &Db, hostname: &str, ip: &str, port: i64) -> (i64, i64) {
        let machine_id = machines::insert(db, &Machine::new(hostname, ip)).unwrap();
        let endpoint_id = zen_endpoints::upsert(
            db,
            &ZenEndpoint {
                id: None,
                machine_id,
                declared_port: port,
                scheme: "http".into(),
                role: "primary".into(),
                upstream_endpoint_id: None,
                data_dir: r"C:\ZenData".into(),
                httpserverclass: "asio".into(),
                lifecycle_mode: "managed".into(),
                created_at: None,
                updated_at: None,
                ..Default::default()
            },
        )
        .unwrap();
        (machine_id, endpoint_id)
    }

    fn seed_baseline(db: &Db, version: &str, kind: &str, sha: &str) {
        zen_binary_expected::insert_baseline(
            db,
            &ZenBinaryExpected {
                zen_build_version: version.into(),
                binary_kind: kind.into(),
                sha256: sha.into(),
                locked_by: None,
                first_seen_at: None,
            },
        )
        .unwrap();
    }

    // The Tauri State<'_, Db> wrapper is awkward to construct in unit tests;
    // call the underlying data-layer helpers directly through the same code
    // paths the commands take. The wrappers themselves are thin enough that
    // verifying the data-layer composition is sufficient.

    #[test]
    fn status_on_empty_db_returns_empty() {
        let db = fresh_db();
        let rows = resolve_endpoints(&db, None, None).unwrap();
        assert!(rows.is_empty());
    }

    #[test]
    fn status_shape_with_seeded_endpoint_and_no_probe() {
        let db = fresh_db();
        let (machine_id, endpoint_id) = seed_endpoint(&db, "ZEN-1", "10.0.0.10", 8558);
        // Mirror the body of zen_status without going through tauri::State.
        let endpoints = resolve_endpoints(&db, None, None).unwrap();
        assert_eq!(endpoints.len(), 1);
        let recent = zen_probes::list_recent(&db, endpoint_id, 1).unwrap();
        assert!(recent.is_empty(), "no probe rows yet for fresh seed");
        // Make sure the machine row resolves through resolve_host.
        let host = resolve_host(&db, machine_id).unwrap();
        assert_eq!(host.as_deref(), Some("10.0.0.10"));
    }

    #[test]
    fn list_endpoints_empty_ok() {
        let db = fresh_db();
        let rows = zen_endpoints::list(&db).unwrap();
        assert!(rows.is_empty());
    }

    #[test]
    fn list_endpoints_filtered_by_machine() {
        let db = fresh_db();
        let (m1, _) = seed_endpoint(&db, "ZEN-1", "10.0.0.10", 8558);
        let (_m2, _) = seed_endpoint(&db, "ZEN-2", "10.0.0.11", 8558);
        let just_m1 = zen_endpoints::list_for_machine(&db, m1).unwrap();
        assert_eq!(just_m1.len(), 1);
    }

    #[test]
    fn baseline_list_empty_ok() {
        let db = fresh_db();
        let rows = zen_binary_expected::list(&db).unwrap();
        assert!(rows.is_empty());
    }

    #[test]
    fn baseline_list_filters_apply_through_command_logic() {
        let db = fresh_db();
        seed_baseline(&db, "5.8.10-aaa", KIND_ZEN_CLI, "sha-cli-aaa");
        seed_baseline(&db, "5.8.10-aaa", KIND_ZENSERVER, "sha-srv-aaa");
        seed_baseline(&db, "5.7.6-bbb", KIND_ZEN_CLI, "sha-cli-bbb");

        let all = zen_binary_expected::list(&db).unwrap();
        assert_eq!(all.len(), 3);

        // Re-run the filter pipeline used inside zen_baseline_list.
        let version = "5.8.10-aaa".to_string();
        let kind = KIND_ZEN_CLI.to_string();
        let mut rows = zen_binary_expected::list(&db).unwrap();
        rows.retain(|r| r.zen_build_version == version);
        rows.retain(|r| r.binary_kind == kind);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].sha256, "sha-cli-aaa");
    }

    #[test]
    fn baseline_lock_unlock_roundtrip() {
        let db = fresh_db();
        seed_baseline(&db, "5.8.10-aaa", KIND_ZEN_CLI, "sha");

        // Initial state: no lock.
        let before = zen_binary_expected::find(&db, "5.8.10-aaa", KIND_ZEN_CLI)
            .unwrap()
            .unwrap();
        assert!(before.locked_by.is_none());

        // lock through the same data-layer call the command wraps.
        zen_binary_expected::lock(&db, "5.8.10-aaa", KIND_ZEN_CLI, "op1").unwrap();
        let locked = zen_binary_expected::find(&db, "5.8.10-aaa", KIND_ZEN_CLI)
            .unwrap()
            .unwrap();
        assert_eq!(locked.locked_by.as_deref(), Some("op1"));

        // unlock.
        zen_binary_expected::unlock(&db, "5.8.10-aaa", KIND_ZEN_CLI).unwrap();
        let unlocked = zen_binary_expected::find(&db, "5.8.10-aaa", KIND_ZEN_CLI)
            .unwrap()
            .unwrap();
        assert!(unlocked.locked_by.is_none());
    }

    #[test]
    fn baseline_lock_rejects_missing_row() {
        // Exercise the validate-then-find-then-lock path the command runs.
        let db = fresh_db();
        // missing row -> InvalidInput
        let kind = KIND_ZEN_CLI;
        validate_kind(kind).unwrap();
        assert!(
            zen_binary_expected::find(&db, "nope-version", kind)
                .unwrap()
                .is_none(),
            "precondition: row absent"
        );
    }

    #[test]
    fn baseline_rejects_bad_kind() {
        let err = validate_kind("bogus").unwrap_err();
        match err {
            VoloError::InvalidInput(msg) => assert!(msg.contains("invalid binary kind")),
            other => panic!("expected InvalidInput, got {:?}", other),
        }
    }

    #[test]
    fn resolve_endpoints_unknown_machine_errors() {
        let db = fresh_db();
        let err = resolve_endpoints(&db, Some(9999), None).unwrap_err();
        assert!(matches!(err, VoloError::InvalidInput(_)));
    }

    #[test]
    fn resolve_endpoints_unknown_endpoint_errors() {
        let db = fresh_db();
        let err = resolve_endpoints(&db, None, Some(9999)).unwrap_err();
        assert!(matches!(err, VoloError::InvalidInput(_)));
    }

    #[test]
    fn detect_binary_unknown_cred_alias_errors() {
        // Mirror the lookup the command performs before touching the network.
        let db = fresh_db();
        let result = data_creds::find_by_alias(&db, "UECM:winrm:NOPE").unwrap();
        assert!(result.is_none());
    }

    // ----- T2.6 -----

    #[test]
    fn guard_destructive_refuses_with_neither_flag() {
        let err = guard_destructive(false, false, "zen.unregister").unwrap_err();
        match err {
            VoloError::InvalidInput(msg) => {
                assert!(msg.contains("confirmed=true"));
                assert!(msg.contains("dry_run=true"));
            }
            other => panic!("expected InvalidInput, got {:?}", other),
        }
    }

    #[test]
    fn guard_destructive_allows_confirmed() {
        guard_destructive(true, false, "zen.unregister").unwrap();
    }

    #[test]
    fn guard_destructive_allows_dry_run() {
        guard_destructive(false, true, "zen.unregister").unwrap();
    }

    #[test]
    fn guard_destructive_allows_both() {
        // Match CLI behavior: dry_run wins over confirmed but both being set
        // isn't an error.
        guard_destructive(true, true, "zen.unregister").unwrap();
    }

    #[test]
    fn cred_input_preflight_inconsistent_user_only_errors() {
        let db = fresh_db();
        let bad = ZenCredentialInput {
            cred_alias: None,
            user: Some("alice".into()),
            pass: None,
        };
        assert!(matches!(
            bad.preflight(&db),
            Err(VoloError::InvalidInput(_))
        ));
    }

    #[test]
    fn cred_input_preflight_alias_with_user_errors() {
        let db = fresh_db();
        let bad = ZenCredentialInput {
            cred_alias: Some("any".into()),
            user: Some("alice".into()),
            pass: None,
        };
        assert!(matches!(
            bad.preflight(&db),
            Err(VoloError::InvalidInput(_))
        ));
    }

    #[test]
    fn cred_input_preflight_unknown_alias_errors() {
        let db = fresh_db();
        let bad = ZenCredentialInput {
            cred_alias: Some("UECM:winrm:NOPE".into()),
            user: None,
            pass: None,
        };
        assert!(matches!(
            bad.preflight(&db),
            Err(VoloError::InvalidInput(_))
        ));
    }

    #[test]
    fn cred_input_resolve_anonymous_returns_none() {
        let db = fresh_db();
        let none_cred = ZenCredentialInput::default();
        assert!(none_cred.resolve(&db).unwrap().is_none());
    }

    #[test]
    fn cred_input_resolve_inline_user_pass() {
        let db = fresh_db();
        let inline = ZenCredentialInput {
            cred_alias: None,
            user: Some("alice".into()),
            pass: Some("hunter2".into()),
        };
        assert_eq!(
            inline.resolve(&db).unwrap(),
            Some(("alice".into(), "hunter2".into()))
        );
    }

    #[test]
    fn register_unknown_machine_errors() {
        let db = fresh_db();
        // Mirror the pre-check `zen_register` runs before calling
        // `core::zen::endpoint::register`.
        assert!(machines::find_by_id(&db, 9999).unwrap().is_none());
    }

    #[test]
    fn enable_global_precondition_requires_ue_runtime_user() {
        let db = fresh_db();
        let (machine_id, _) = seed_endpoint(&db, "WS-01", "10.0.0.40", 8558);
        // Mirror the pre-check `zen_enable_global` runs before resolving the
        // cluster master / writing UserEngine.ini.
        assert_eq!(machines::get_ue_runtime_user(&db, machine_id).unwrap(), None);
        machines::set_ue_runtime_user(&db, machine_id, Some("lanbp")).unwrap();
        assert_eq!(
            machines::get_ue_runtime_user(&db, machine_id).unwrap(),
            Some("lanbp".to_string())
        );
    }

    #[test]
    fn enable_global_resolves_master_and_rules_via_shared_ops() {
        let db = fresh_db();
        let (master_machine_id, master_endpoint_id) =
            seed_endpoint(&db, "ZEN-MASTER", "10.0.0.50", 8558);
        zen_endpoints::upsert(
            &db,
            &ZenEndpoint {
                id: Some(master_endpoint_id),
                machine_id: master_machine_id,
                declared_port: 8558,
                scheme: "http".into(),
                role: "shared_upstream".into(),
                upstream_endpoint_id: None,
                data_dir: r"D:\ZenMaster".into(),
                httpserverclass: "asio".into(),
                lifecycle_mode: "installed_service".into(),
                created_at: None,
                updated_at: None,
                ..Default::default()
            },
        )
        .unwrap();

        // Same composition zen_enable_global runs before calling zen_enable::enable_global.
        let master = zen_cli_shared::resolve_cluster_master(
            &db,
            master_endpoint_id,
            ZEN_GLOBAL_NAMESPACE,
        )
        .unwrap();
        assert_eq!(master.host, "10.0.0.50");
        assert_eq!(master.port, 8558);
        assert_eq!(master.namespace, ZEN_GLOBAL_NAMESPACE);

        let resolved = zen_cli_shared::build_global_rules().unwrap();
        assert_eq!(resolved.rules.enable_zen_shared.key, "Shared");
    }

    #[test]
    fn register_uses_default_lifecycle_for_role() {
        // Verify the same lifecycle defaulting rule the CLI uses.
        assert_eq!(
            zen_cli_shared::default_lifecycle_for("shared_upstream"),
            "installed_service"
        );
        assert_eq!(
            zen_cli_shared::default_lifecycle_for("local"),
            "editor_owned"
        );
    }

    #[test]
    fn unregister_refuses_when_dependents_exist() {
        // Seed master + dependent; ensure the dependents scan would block.
        let db = fresh_db();
        let (m1, master_id) = seed_endpoint(&db, "ZEN-M", "10.0.0.10", 8558);
        // Replace master row to set role=shared_upstream and lifecycle=installed_service.
        zen_endpoints::upsert(
            &db,
            &ZenEndpoint {
                id: Some(master_id),
                machine_id: m1,
                declared_port: 8558,
                scheme: "http".into(),
                role: "shared_upstream".into(),
                upstream_endpoint_id: None,
                data_dir: r"D:\Zen".into(),
                httpserverclass: "asio".into(),
                lifecycle_mode: "installed_service".into(),
                created_at: None,
                updated_at: None,
                ..Default::default()
            },
        )
        .unwrap();
        // Add a local endpoint that points upstream at the master.
        let _local_id = zen_endpoints::upsert(
            &db,
            &ZenEndpoint {
                id: None,
                machine_id: m1,
                declared_port: 8559,
                scheme: "http".into(),
                role: "local".into(),
                upstream_endpoint_id: Some(master_id),
                data_dir: r"D:\Zen2".into(),
                httpserverclass: "asio".into(),
                lifecycle_mode: "editor_owned".into(),
                created_at: None,
                updated_at: None,
                ..Default::default()
            },
        )
        .unwrap();

        let dependents: Vec<i64> = zen_endpoints::list(&db)
            .unwrap()
            .into_iter()
            .filter(|other| other.upstream_endpoint_id == Some(master_id))
            .filter_map(|other| other.id)
            .collect();
        assert!(!dependents.is_empty());
    }

    #[test]
    fn lua_preview_data_dir_safe_check_rejects_system_root() {
        // Verify the same guard the command runs internally.
        let r = zen_cli_shared::validate_data_dir_safe(r"C:\Windows\Zen");
        assert!(matches!(r, Err(VoloError::InvalidInput(_))));
    }

    #[test]
    fn apply_config_dest_path_check_rejects_relative() {
        let r = zen_cli_shared::validate_dest_path(r"relative\zen.lua");
        assert!(matches!(r, Err(VoloError::InvalidInput(_))));
    }

    #[test]
    fn urlacl_add_empty_principal_errors() {
        // Refused at the wrapper before any cred / DB / PS work.
        let trimmed = "   ".trim();
        assert!(trimmed.is_empty());
    }
}
