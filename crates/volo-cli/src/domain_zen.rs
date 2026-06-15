//! `uecm-cli zen <action>` handlers (Plan 7 M1 T1.9).
//!
//! # NDJSON event schema
//!
//! Every subcommand here emits NDJSON events under the shared `cli::output::Event`
//! taxonomy. The schemas below describe the `summary` payload of `Completed`
//! events and the wrapping result documents emitted via `emit_result` so T1.10
//! Tauri commands can mirror them 1:1.
//!
//! ## `zen status`
//! Top-level result document: `{ "endpoints": [ ZenEndpointStatus, ... ] }` where
//! `ZenEndpointStatus = { endpoint_id, machine_id, hostname, declared_port,
//! scheme, role, lifecycle_mode, latest_probe?: { probed_at, reachable,
//! effective_port, build_version, error_message }, ok }`.
//!
//! ## `zen probe`
//! Per-endpoint `Completed` summary: `{ endpoint_id, reachable, build_version,
//! effective_port, error_message, probe_id }`. Top-level `Completed` summary:
//! `{ probed: <int>, reachable: <int>, unreachable: <int> }`.
//!
//! ## `zen cache-stats`
//! Per-endpoint `Completed` summary: `{ endpoint_id, providers: [<name>, ...],
//! records: <int>, error_message }`. Top-level `Completed` summary: `{ endpoints:
//! <int>, rows_inserted: <int> }`.
//!
//! ## `zen detect-binary`
//! Per-machine `Completed` summary: `{ machine_id, install_record_written: bool,
//! install_record_cleared: bool, intree_records_written: <int>, baseline_new_rows:
//! <int>, intree_ref_rows: <int>, warnings: [<string>, ...] }`. Top-level
//! `Completed` summary: `{ machines: <int>, ok: <int>, failed: <int> }`.
//!
//! ## `zen list-endpoints`
//! Result document is the raw `Vec<ZenEndpoint>` from the data layer.
//!
//! ## `zen baseline list` / `lock` / `unlock`
//! `list` emits the raw `Vec<ZenBinaryExpected>`. `lock`/`unlock` emit `Completed`
//! summaries `{ zen_build_version, kind, locked_by?, action: "lock"|"unlock" }`.
//!
//! # Exit codes (plan §2.4)
//! - 0 success
//! - 1 partial failure (some probes unreachable / some persists raised warnings)
//! - 2 arg / parse error (clap)
//! - 3 environment / DB / IO failure
//! - 4 credential / PowerShell failure (e.g. detect-binary can't reach host)

use crate::args::{ZenAction, ZenBaselineAction, ZenServiceAction, ZenUrlaclAction};
use crate::credential_args::CredentialArgs;
use crate::destructive::{self, Outcome};
use crate::output::Event;
use crate::run::Ctx;
use crate::EmitSerialize;
use cache_core::core::zen::endpoint as zen_endpoint;
use cache_core::core::zen::enable as zen_enable;
use cache_core::core::zen::redaction::redact;
use cache_core::core::zen::rules_loader as zen_rules;
use cache_core::core::zen::{binary as zen_binary, cache_stats as zen_cache, probe as zen_probe};
use cache_core::data::{
    machine_zen_install, machines, operations, project_locations, projects, zen_binary_expected,
    zen_endpoints, zen_probes, Db, Machine, ZenEndpoint,
};
use cache_core::error::{UecmError, UecmResult};
use serde::Serialize;
use std::time::Duration;

// step 2c: the pure zen-ops business-logic helpers moved into
// `cache_core::core::zen::ops` so both the CLI and the Tauri `commands::zen`
// surface share one source of truth (the GUI command crate can't import this
// CLI binary crate). Re-export them here so the rest of this module — and its
// tests — keep referring to them by their original unqualified names.
pub(crate) use cache_core::core::zen::ops::{
    default_lifecycle_for, finalize_op, invoke_write_lua, parse_envelope, pick_service_zen_exe,
    render_lua_for, require_endpoint, require_machine, run_node, sha256_hex_of, url_prefix_for,
    validate_data_dir_safe, validate_dest_path, validate_service_account_pair,
    validate_service_data_dir, verify_write_response, workstation_colocation_warning,
    DEFAULT_SERVICE_NAME,
};
// Only the tests below reach for `collapse_path_segments` directly (the prod
// path uses it transitively via the validators); keep the re-export test-gated
// so the GUI/CLI binary build doesn't flag it as unused.
#[cfg(test)]
pub(crate) use cache_core::core::zen::ops::collapse_path_segments;


const KIND_ZEN_CLI: &str = "zen_cli";
const KIND_ZENSERVER: &str = "zenserver";

pub fn handle(ctx: &mut Ctx<'_>, action: ZenAction) -> UecmResult<()> {
    match action {
        ZenAction::Status { machine, all } => status(ctx, machine, all),
        ZenAction::Probe { machine, all, timeout, cred } => probe(ctx, machine, all, timeout, &cred),
        ZenAction::CacheStats { endpoint_id, all, timeout } => {
            cache_stats(ctx, endpoint_id, all, timeout)
        }
        ZenAction::DetectBinary { machine, all, cred } => detect_binary(ctx, machine, all, &cred),
        ZenAction::ListEndpoints { machine } => list_endpoints(ctx, machine),
        ZenAction::Baseline { action } => match action {
            ZenBaselineAction::List { zen_build_version, kind } => {
                baseline_list(ctx, zen_build_version.as_deref(), kind.as_deref())
            }
            ZenBaselineAction::Lock { zen_build_version, kind, locked_by, yes, dry_run } => {
                baseline_lock(ctx, &zen_build_version, &kind, &locked_by, yes, dry_run)
            }
            ZenBaselineAction::Unlock { zen_build_version, kind, yes, dry_run } => {
                baseline_unlock(ctx, &zen_build_version, &kind, yes, dry_run)
            }
        },
        ZenAction::Register {
            machine,
            declared_port,
            scheme,
            role,
            upstream_endpoint_id,
            data_dir,
            httpserverclass,
            lifecycle,
        } => register(
            ctx,
            machine,
            declared_port,
            &scheme,
            &role,
            upstream_endpoint_id,
            &data_dir,
            &httpserverclass,
            lifecycle.as_deref(),
        ),
        ZenAction::Unregister { endpoint_id, yes, dry_run } => {
            unregister(ctx, endpoint_id, yes, dry_run)
        }
        ZenAction::ChangeRole {
            endpoint_id,
            new_role,
            upstream_endpoint_id,
            yes,
            dry_run,
        } => change_role(ctx, endpoint_id, &new_role, upstream_endpoint_id, yes, dry_run),
        ZenAction::ApplyConfig {
            endpoint_id,
            dest_path,
            yes,
            dry_run,
            cred,
        } => apply_config(ctx, endpoint_id, dest_path, yes, dry_run, &cred),
        ZenAction::LuaPreview { endpoint_id } => lua_preview(ctx, endpoint_id),
        ZenAction::SponsorDown { endpoint_id, yes, dry_run, cred } => {
            sponsor_down(ctx, endpoint_id, yes, dry_run, &cred)
        }
        ZenAction::Service { action } => match action {
            ZenServiceAction::Install {
                endpoint_id,
                service_user,
                service_pass,
                service_pass_stdin,
                yes,
                dry_run,
                cred,
            } => {
                // Codex P3: a password without a user gets silently dropped
                // (the PS sidecar only emits `-p` when `-u` is set). Reject
                // up-front so the operator never thinks they installed under
                // a specific account when in fact zen fell back to
                // LocalService. Mirror the PS-side IsNullOrWhiteSpace by
                // treating whitespace-only strings as missing. Empty
                // `--service-pass ""` is also treated as missing here so
                // the error message stays accurate.
                let pass_provided = service_pass
                    .as_deref()
                    .map(|p| !p.is_empty())
                    .unwrap_or(false)
                    || service_pass_stdin;
                if pass_provided
                    && service_user
                        .as_deref()
                        .map(|u| u.trim().is_empty())
                        .unwrap_or(true)
                {
                    return Err(UecmError::InvalidInput(
                        "--service-pass / --service-pass-stdin requires --service-user; \
                         the password is forwarded to zen only when the user is set"
                            .into(),
                    ));
                }
                // Codex P2: defer stdin read until service_install confirms
                // the request will actually be applied. dry-run / missing
                // --yes / preflight failures should not consume stdin.
                service_install(
                    ctx,
                    endpoint_id,
                    service_user.as_deref(),
                    service_pass.as_deref(),
                    service_pass_stdin,
                    yes,
                    dry_run,
                    &cred,
                )
            }
            ZenServiceAction::Uninstall { endpoint_id, yes, dry_run, cred } => {
                service_uninstall(ctx, endpoint_id, yes, dry_run, &cred)
            }
            ZenServiceAction::Start { endpoint_id, cred } => {
                service_simple(ctx, endpoint_id, ServiceVerb::Start, false, false, &cred)
            }
            ZenServiceAction::Stop { endpoint_id, yes, dry_run, cred } => {
                service_simple(ctx, endpoint_id, ServiceVerb::Stop, yes, dry_run, &cred)
            }
            ZenServiceAction::Status { endpoint_id, cred } => {
                service_status(ctx, endpoint_id, &cred)
            }
        },
        ZenAction::Urlacl { action } => match action {
            ZenUrlaclAction::Add { endpoint_id, principal, yes, dry_run, cred } => {
                urlacl_add(ctx, endpoint_id, &principal, yes, dry_run, &cred)
            }
            ZenUrlaclAction::List { machine, port_filter, cred } => {
                urlacl_list(ctx, machine, port_filter.as_deref(), &cred)
            }
            ZenUrlaclAction::Remove { endpoint_id, yes, dry_run, cred } => {
                urlacl_remove(ctx, endpoint_id, yes, dry_run, &cred)
            }
        },
        ZenAction::Enable {
            project_id,
            global,
            machines,
            upstream_endpoint_id,
            namespace,
            yes,
            dry_run,
            cred,
        } => {
            if global {
                global_enable(ctx, &machines, upstream_endpoint_id, &namespace, yes, dry_run, &cred)
            } else {
                let pid = project_id.ok_or_else(|| {
                    UecmError::InvalidInput(
                        "must supply --project-id or --global".to_string(),
                    )
                })?;
                project_enable(ctx, pid, &machines, upstream_endpoint_id, &namespace, yes, dry_run, &cred)
            }
        }
        ZenAction::Disable { project_id, global, machines, yes, dry_run, cred } => {
            if global {
                global_disable(ctx, &machines, yes, dry_run, &cred)
            } else {
                let pid = project_id.ok_or_else(|| {
                    UecmError::InvalidInput(
                        "must supply --project-id or --global".to_string(),
                    )
                })?;
                project_disable(ctx, pid, &machines, yes, dry_run, &cred)
            }
        }
        ZenAction::VerifyRules {
            ue_version,
            ue_install,
            write_verified,
            run_editor,
            machine,
            uproject_path,
            timeout_seconds,
            expected_host,
            expected_port,
            expected_namespace,
            cred,
        } => verify_rules(
            ctx,
            &ue_version,
            &ue_install,
            write_verified,
            run_editor,
            machine,
            uproject_path.as_deref(),
            timeout_seconds,
            expected_host.as_deref(),
            expected_port,
            expected_namespace.as_deref(),
            &cred,
        ),
        ZenAction::CleanEnv { machines, name, scopes, yes, dry_run, cred } => {
            clean_env(ctx, &machines, &name, &scopes, yes, dry_run, &cred)
        }
        ZenAction::SetRegionHost { machines, host, yes, dry_run, cred } => {
            set_region_host(ctx, &machines, &host, yes, dry_run, &cred)
        }
    }
}

// -----------------------------------------------------------------------------
// status
// -----------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
struct LatestProbeView {
    probed_at: Option<String>,
    reachable: bool,
    effective_port: Option<i64>,
    build_version: Option<String>,
    error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct EndpointStatus {
    endpoint_id: i64,
    machine_id: i64,
    hostname: String,
    ip: String,
    declared_port: i64,
    scheme: String,
    role: String,
    lifecycle_mode: String,
    latest_probe: Option<LatestProbeView>,
    /// `true` iff a latest probe exists and was reachable. Convenience field for
    /// dashboard rendering — saves consumers from reaching into `latest_probe`.
    ok: bool,
}

fn status(ctx: &mut Ctx<'_>, machine: Option<i64>, _all: bool) -> UecmResult<()> {
    let db = ctx.require_db()?;
    let endpoints = resolve_endpoints(db, machine, None)?;
    let mut out = Vec::with_capacity(endpoints.len());
    for ep in endpoints {
        let endpoint_id = ep.id.expect("endpoint from CRUD always has id");
        let machine_record = machines::find_by_id(db, ep.machine_id)?;
        let (hostname, ip) = machine_record
            .map(|m| (m.hostname, m.ip))
            .unwrap_or_else(|| (String::new(), String::new()));

        // Plan §3 health check 1 reads "latest" probe — that's the most-recent
        // row by probed_at. `list_recent` returns DESC, so head of the vec is it.
        let recent = zen_probes::list_recent(db, endpoint_id, 1)?;
        let latest_probe = recent.into_iter().next().map(|p| LatestProbeView {
            probed_at: p.probed_at,
            reachable: p.reachable,
            effective_port: p.effective_port,
            build_version: p.build_version,
            error_message: p.error_message,
        });
        let ok = latest_probe.as_ref().map(|p| p.reachable).unwrap_or(false);
        out.push(EndpointStatus {
            endpoint_id,
            machine_id: ep.machine_id,
            hostname,
            ip,
            declared_port: ep.declared_port,
            scheme: ep.scheme,
            role: ep.role,
            lifecycle_mode: ep.lifecycle_mode,
            latest_probe,
            ok,
        });
    }
    let doc = serde_json::json!({ "endpoints": out });
    ctx.emitter.emit_result(&doc).ok();
    Ok(())
}

// -----------------------------------------------------------------------------
// probe
// -----------------------------------------------------------------------------

fn probe(
    ctx: &mut Ctx<'_>,
    machine: Option<i64>,
    _all: bool,
    timeout_secs: u64,
    cred: &CredentialArgs,
) -> UecmResult<()> {
    // The credential pair is accepted today for forward compatibility (plan
    // notes anticipate a WinRM-tunneled probe variant). Validate flag
    // combinations against the DB so a typo'd alias fails fast.
    let db_clone = ctx.require_db()?.clone();
    cred.preflight(&db_clone)?;
    let _ = cred; // currently unused at runtime — direct HTTP only.

    let endpoints = resolve_endpoints(&db_clone, machine, None)?;
    let total = endpoints.len() as i64;
    ctx.emitter
        .emit_event(&Event::Started {
            task_type: "zen_probe".into(),
            task_id: None,
            metadata: serde_json::json!({ "endpoints": total, "timeout_secs": timeout_secs }),
        })
        .ok();

    let timeout = Duration::from_secs(timeout_secs);
    let mut reachable = 0i64;
    let mut unreachable = 0i64;
    for (idx, ep) in endpoints.iter().enumerate() {
        let endpoint_id = ep.id.expect("endpoint id");
        let host = match resolve_host(&db_clone, ep.machine_id)? {
            Some(h) => h,
            None => {
                ctx.emitter
                    .emit_event(&Event::ItemCompleted {
                        item_id: format!("endpoint:{}", endpoint_id),
                        index: idx as i64,
                        ok: false,
                        message: Some(format!(
                            "machine id={} not found; cannot resolve host",
                            ep.machine_id
                        )),
                    })
                    .ok();
                unreachable += 1;
                continue;
            }
        };

        let outcome = zen_probe::probe_endpoint(ep, &host, timeout);
        let record = outcome.record.clone();
        let probe_id = zen_probe::persist(&db_clone, &outcome)?;
        if record.reachable {
            reachable += 1;
        } else {
            unreachable += 1;
        }
        let summary = serde_json::json!({
            "endpoint_id": endpoint_id,
            "machine_id": ep.machine_id,
            "host": host,
            "reachable": record.reachable,
            "build_version": record.build_version,
            "effective_port": record.effective_port,
            "error_message": record.error_message,
            "probe_id": probe_id,
        });
        ctx.emitter.emit_event(&Event::Completed { summary }).ok();
    }

    let final_summary = serde_json::json!({
        "probed": total,
        "reachable": reachable,
        "unreachable": unreachable,
    });
    ctx.emitter.emit_event(&Event::Completed { summary: final_summary }).ok();
    // Partial failure → exit 1. UecmError::OperationFailed maps to exit 1 per
    // cli::output::exit_code_for, which keeps the dual-channel contract intact.
    if unreachable > 0 && reachable > 0 {
        return Err(UecmError::OperationFailed(format!(
            "{}/{} endpoints unreachable",
            unreachable, total
        )));
    }
    // All-failure stays as full failure → exit 1 too. All-success → exit 0.
    if unreachable == total && total > 0 {
        return Err(UecmError::OperationFailed(format!(
            "all {} endpoints unreachable",
            total
        )));
    }
    Ok(())
}

// -----------------------------------------------------------------------------
// cache-stats
// -----------------------------------------------------------------------------

fn cache_stats(
    ctx: &mut Ctx<'_>,
    endpoint_id: Option<i64>,
    _all: bool,
    timeout_secs: u64,
) -> UecmResult<()> {
    let db = ctx.require_db()?.clone();
    let endpoints = resolve_endpoints(&db, None, endpoint_id)?;
    let total = endpoints.len() as i64;
    ctx.emitter
        .emit_event(&Event::Started {
            task_type: "zen_cache_stats".into(),
            task_id: None,
            metadata: serde_json::json!({ "endpoints": total, "timeout_secs": timeout_secs }),
        })
        .ok();

    let timeout = Duration::from_secs(timeout_secs);
    let mut rows_inserted = 0i64;
    let mut partial_errors = 0i64;
    for (idx, ep) in endpoints.iter().enumerate() {
        let endpoint_id = ep.id.expect("endpoint id");
        let host = match resolve_host(&db, ep.machine_id)? {
            Some(h) => h,
            None => {
                ctx.emitter
                    .emit_event(&Event::ItemCompleted {
                        item_id: format!("endpoint:{}", endpoint_id),
                        index: idx as i64,
                        ok: false,
                        message: Some(format!("machine id={} not found", ep.machine_id)),
                    })
                    .ok();
                partial_errors += 1;
                continue;
            }
        };
        let outcome = zen_cache::fetch_cache_stats(ep, &host, timeout);
        let ids = zen_cache::persist(&db, &outcome)?;
        rows_inserted += ids.len() as i64;
        if outcome.error_message.is_some() {
            partial_errors += 1;
        }
        let summary = serde_json::json!({
            "endpoint_id": endpoint_id,
            "machine_id": ep.machine_id,
            "host": host,
            "providers": outcome.providers,
            "records": ids.len(),
            "error_message": outcome.error_message,
        });
        ctx.emitter.emit_event(&Event::Completed { summary }).ok();
    }

    let final_summary = serde_json::json!({
        "endpoints": total,
        "rows_inserted": rows_inserted,
        "partial_errors": partial_errors,
    });
    ctx.emitter.emit_event(&Event::Completed { summary: final_summary }).ok();
    // Treat "every endpoint failed" as a hard failure too — automation must
    // not see exit 0 when literally nothing was sampled. The intermediate
    // partial_errors < total branch covers mixed-success runs.
    if total > 0 && partial_errors == total {
        return Err(UecmError::OperationFailed(format!(
            "all {} endpoint(s) failed to fetch cache stats; no rows inserted",
            total
        )));
    }
    if partial_errors > 0 && partial_errors < total {
        return Err(UecmError::OperationFailed(format!(
            "{}/{} endpoints had errors fetching cache stats",
            partial_errors, total
        )));
    }
    Ok(())
}

// -----------------------------------------------------------------------------
// detect-binary
// -----------------------------------------------------------------------------

fn detect_binary(
    ctx: &mut Ctx<'_>,
    machine: Option<i64>,
    all: bool,
    cred: &CredentialArgs,
) -> UecmResult<()> {
    let db = ctx.require_db()?.clone();
    cred.preflight(&db)?;

    // Resolve target machines. --machine takes precedence; otherwise --all (or
    // no flag) scans every machine in inventory.
    let target_machines: Vec<cache_core::data::Machine> = match machine {
        Some(id) => {
            let m = machines::find_by_id(&db, id)?.ok_or_else(|| {
                UecmError::InvalidInput(format!("machine id={} not found", id))
            })?;
            vec![m]
        }
        None => {
            if !all && !ctx.json_mode {
                // No --machine and no --all is ambiguous — fall through to all but
                // make the convention explicit when humans run it (json mode
                // remains permissive for scripted batch use).
            }
            machines::list_all(&db)?
        }
    };

    let total = target_machines.len() as i64;
    ctx.emitter
        .emit_event(&Event::Started {
            task_type: "zen_detect_binary".into(),
            task_id: None,
            metadata: serde_json::json!({ "machines": total, "authenticated": true }),
        })
        .ok();

    let mut ok_count = 0i64;
    let mut failed = 0i64;
    for (idx, m) in target_machines.iter().enumerate() {
        let machine_id = m.id.expect("machine in inventory always has id");
        let host = &m.ip;
        let detection_result = invoke_detect_binary(host, None);
        match detection_result {
            Ok(detection) => {
                let report = zen_binary::persist(&db, machine_id, &detection)?;
                // F3: intree candidates seen but all skipped (no machine_ue_installs
                // row) and no install record → fail this machine with a fix hint
                // instead of reporting a hollow success.
                if zen_binary::detect_yielded_nothing(&detection, &report) {
                    failed += 1;
                    ctx.emitter
                        .emit_event(&Event::ItemCompleted {
                            item_id: format!("machine:{}", machine_id),
                            index: idx as i64,
                            ok: false,
                            message: Some(format!(
                                "detect-binary found intree zen.exe but machine_ue_installs is empty \
                                 for machine id={machine_id}; run `uecm-cli machine refresh {machine_id}` first"
                            )),
                        })
                        .ok();
                    continue;
                }
                ok_count += 1;
                let summary = serde_json::json!({
                    "machine_id": machine_id,
                    "hostname": m.hostname,
                    "ip": m.ip,
                    "install_record_written": report.install_record_written,
                    "install_record_cleared": report.install_record_cleared,
                    "intree_records_written": report.intree_records_written,
                    "baseline_new_rows": report.baseline_new_rows,
                    "intree_ref_rows": report.intree_ref_rows,
                    "warnings": report.warnings,
                });
                ctx.emitter.emit_event(&Event::Completed { summary }).ok();
            }
            Err(e) => {
                failed += 1;
                ctx.emitter
                    .emit_event(&Event::ItemCompleted {
                        item_id: format!("machine:{}", machine_id),
                        index: idx as i64,
                        ok: false,
                        message: Some(e.to_string()),
                    })
                    .ok();
            }
        }
    }

    let final_summary = serde_json::json!({
        "machines": total,
        "ok": ok_count,
        "failed": failed,
    });
    ctx.emitter.emit_event(&Event::Completed { summary: final_summary }).ok();
    if failed > 0 && ok_count > 0 {
        return Err(UecmError::OperationFailed(format!(
            "{}/{} machines failed detect-binary",
            failed, total
        )));
    }
    if failed == total && total > 0 {
        return Err(UecmError::PowerShell(format!(
            "all {} machines failed detect-binary",
            total
        )));
    }
    Ok(())
}

/// Run `zen-detect-binary.ps1` against `host` and parse the JSON payload.
///
/// Runs the sidecar remotely on the target over SSH. The script body is
/// forwarded inline (no args required by the script itself).
fn invoke_detect_binary(
    host: &str,
    creds: Option<&(String, String)>,
) -> UecmResult<zen_binary::BinaryDetection> {
    // SSH key auth (uecm-svc); operator creds ignored (param kept as a shim).
    // zen-detect-binary takes no args (param-less; ignores stdin).
    let _ = creds;
    let raw: String = run_node(host, "zen-detect-binary.ps1", serde_json::json!({}))?;

    // PS sidecars emit exit 0 even on expected failures, with `{ok:false,
    // message:"..."}` as the envelope (T1.8 contract). If we forward that
    // straight into parse_detection_json the parser treats missing
    // install/intree as "no install detected" — which then causes
    // zen_binary::persist to delete the existing machine_zen_install row
    // (T1.6 P2-1 fix: detection.install=None → drop stale). The result
    // would be sidecar failure silently nuking inventory, the exact bug
    // codex flagged. Inspect ok first.
    let envelope: serde_json::Value = serde_json::from_str(&raw).map_err(|e| {
        UecmError::OperationFailed(format!(
            "zen-detect-binary returned non-JSON output: {e}; raw: {}",
            raw.chars().take(200).collect::<String>()
        ))
    })?;
    if envelope.get("ok").and_then(|v| v.as_bool()) == Some(false) {
        let msg = envelope
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown sidecar error");
        return Err(UecmError::OperationFailed(format!(
            "zen-detect-binary on {host} reported failure: {msg}"
        )));
    }
    zen_binary::parse_detection_json(&raw)
}

// -----------------------------------------------------------------------------
// list-endpoints
// -----------------------------------------------------------------------------

fn list_endpoints(ctx: &mut Ctx<'_>, machine: Option<i64>) -> UecmResult<()> {
    let db = ctx.require_db()?;
    let rows = match machine {
        Some(id) => zen_endpoints::list_for_machine(db, id)?,
        None => zen_endpoints::list(db)?,
    };
    ctx.emitter.emit_result(&rows).ok();
    Ok(())
}

// -----------------------------------------------------------------------------
// baseline list / lock / unlock
// -----------------------------------------------------------------------------

fn baseline_list(
    ctx: &mut Ctx<'_>,
    version_filter: Option<&str>,
    kind_filter: Option<&str>,
) -> UecmResult<()> {
    if let Some(k) = kind_filter {
        validate_kind(k)?;
    }
    let db = ctx.require_db()?;
    let mut rows = zen_binary_expected::list(db)?;
    if let Some(v) = version_filter {
        rows.retain(|r| r.zen_build_version == v);
    }
    if let Some(k) = kind_filter {
        rows.retain(|r| r.binary_kind == k);
    }
    ctx.emitter.emit_result(&rows).ok();
    Ok(())
}

fn baseline_lock(
    ctx: &mut Ctx<'_>,
    version: &str,
    kind: &str,
    locked_by: &str,
    yes: bool,
    dry_run: bool,
) -> UecmResult<()> {
    validate_kind(kind)?;
    let outcome = destructive::check(yes, dry_run, "zen.baseline.lock")?;
    let db = ctx.require_db()?;

    // Existence check up front so the operator gets a clear message rather than
    // a silent no-op (UPDATE ... WHERE doesn't fail on zero rows in SQLite).
    if zen_binary_expected::find(db, version, kind)?.is_none() {
        return Err(UecmError::InvalidInput(format!(
            "no baseline row for zen_build_version={} kind={}; run detect-binary first",
            version, kind
        )));
    }

    if outcome == Outcome::DryRun {
        destructive::emit_plan(
            ctx.emitter.as_mut(),
            "zen.baseline.lock",
            serde_json::json!({
                "zen_build_version": version,
                "kind": kind,
                "locked_by": locked_by,
            }),
        );
        return Ok(());
    }

    zen_binary_expected::lock(db, version, kind, locked_by)?;
    let summary = serde_json::json!({
        "zen_build_version": version,
        "kind": kind,
        "locked_by": locked_by,
        "action": "lock",
    });
    ctx.emitter.emit_event(&Event::Completed { summary }).ok();
    Ok(())
}

fn baseline_unlock(
    ctx: &mut Ctx<'_>,
    version: &str,
    kind: &str,
    yes: bool,
    dry_run: bool,
) -> UecmResult<()> {
    validate_kind(kind)?;
    let outcome = destructive::check(yes, dry_run, "zen.baseline.unlock")?;
    let db = ctx.require_db()?;

    if zen_binary_expected::find(db, version, kind)?.is_none() {
        return Err(UecmError::InvalidInput(format!(
            "no baseline row for zen_build_version={} kind={}",
            version, kind
        )));
    }

    if outcome == Outcome::DryRun {
        destructive::emit_plan(
            ctx.emitter.as_mut(),
            "zen.baseline.unlock",
            serde_json::json!({
                "zen_build_version": version,
                "kind": kind,
            }),
        );
        return Ok(());
    }

    zen_binary_expected::unlock(db, version, kind)?;
    let summary = serde_json::json!({
        "zen_build_version": version,
        "kind": kind,
        "action": "unlock",
    });
    ctx.emitter.emit_event(&Event::Completed { summary }).ok();
    Ok(())
}

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

/// Resolve the set of endpoints a command should act on.
///
/// Priority order:
/// 1. `endpoint_id`  → single endpoint (used by `zen cache-stats`).
/// 2. `machine`      → all endpoints registered to that machine.
/// 3. neither given  → every registered endpoint (the implicit `--all`).
fn resolve_endpoints(
    db: &Db,
    machine: Option<i64>,
    endpoint_id: Option<i64>,
) -> UecmResult<Vec<ZenEndpoint>> {
    if let Some(id) = endpoint_id {
        let ep = zen_endpoints::get(db, id)?
            .ok_or_else(|| UecmError::InvalidInput(format!("endpoint id={} not found", id)))?;
        return Ok(vec![ep]);
    }
    if let Some(mid) = machine {
        // Sanity check: empty result on an unknown machine id should fail loudly
        // rather than silently no-op, matching the rest of the CLI.
        if machines::find_by_id(db, mid)?.is_none() {
            return Err(UecmError::InvalidInput(format!("machine id={} not found", mid)));
        }
        return zen_endpoints::list_for_machine(db, mid);
    }
    zen_endpoints::list(db)
}

/// Look up the IP for a machine row. Hostname can drift if the operator
/// renamed the row, so IP is the canonical connect target (matches the rest of
/// the CLI / discovery code path).
fn resolve_host(db: &Db, machine_id: i64) -> UecmResult<Option<String>> {
    Ok(machines::find_by_id(db, machine_id)?.map(|m| m.ip))
}

fn validate_kind(kind: &str) -> UecmResult<()> {
    if kind == KIND_ZEN_CLI || kind == KIND_ZENSERVER {
        Ok(())
    } else {
        Err(UecmError::InvalidInput(format!(
            "invalid binary kind '{}'; expected '{}' or '{}'",
            kind, KIND_ZEN_CLI, KIND_ZENSERVER
        )))
    }
}

// -----------------------------------------------------------------------------
// register / unregister (T2.5)
// -----------------------------------------------------------------------------


#[allow(clippy::too_many_arguments)]
fn register(
    ctx: &mut Ctx<'_>,
    machine: i64,
    declared_port: i64,
    scheme: &str,
    role: &str,
    upstream_endpoint_id: Option<i64>,
    data_dir: &str,
    httpserverclass: &str,
    lifecycle: Option<&str>,
) -> UecmResult<()> {
    let db = ctx.require_db()?.clone();
    // Sanity check that the machine row exists before we hit the endpoint
    // validator — gives a clearer error than the FK violation would.
    if machines::find_by_id(&db, machine)?.is_none() {
        return Err(UecmError::InvalidInput(format!(
            "machine id={} not found",
            machine
        )));
    }

    let lifecycle_mode = lifecycle
        .map(|s| s.to_string())
        .unwrap_or_else(|| default_lifecycle_for(role).to_string());

    let input = zen_endpoint::EndpointInput {
        machine_id: machine,
        declared_port,
        scheme: scheme.to_string(),
        role: role.to_string(),
        upstream_endpoint_id,
        data_dir: data_dir.to_string(),
        httpserverclass: httpserverclass.to_string(),
        lifecycle_mode: lifecycle_mode.clone(),
    };
    let outcome = zen_endpoint::register(&db, &input)?;
    // Idempotent contract (plan §7.2): when `inserted=false`, the existing
    // row's fields are kept. The caller passed *desired* values but DB state
    // didn't change, so we must return the *persisted* row — not the request
    // payload. Otherwise automation that re-runs register with new role /
    // lifecycle / data_dir would see JSON claiming success while subsequent
    // `lua-preview` / `apply-config` still observe the old row.
    let persisted = zen_endpoint::get(&db, outcome.id)?.ok_or_else(|| {
        UecmError::OperationFailed(format!(
            "register: row id={} disappeared between insert and readback",
            outcome.id
        ))
    })?;
    let doc = serde_json::json!({
        "ok": true,
        "endpoint_id": outcome.id,
        "inserted": outcome.inserted,
        "machine_id": persisted.machine_id,
        "declared_port": persisted.declared_port,
        "scheme": persisted.scheme,
        "role": persisted.role,
        "upstream_endpoint_id": persisted.upstream_endpoint_id,
        "lifecycle_mode": persisted.lifecycle_mode,
        "httpserverclass": persisted.httpserverclass,
        "data_dir": persisted.data_dir,
    });
    ctx.emitter.emit_result(&doc).ok();
    Ok(())
}

fn unregister(ctx: &mut Ctx<'_>, endpoint_id: i64, yes: bool, dry_run: bool) -> UecmResult<()> {
    let outcome = destructive::check(yes, dry_run, "zen.unregister")?;
    let db = ctx.require_db()?.clone();
    let ep = zen_endpoint::get(&db, endpoint_id)?.ok_or_else(|| {
        UecmError::InvalidInput(format!("endpoint id={} not found", endpoint_id))
    })?;

    // Surface "still referenced as upstream" in dry-run too. A dry-run plan
    // that succeeds while the real apply would be rejected misleads
    // automation — codex P2 fix. Scan the live row set for any endpoint
    // pointing here. zen_endpoints::list returns Db-mutex-guarded data so
    // the check matches whatever core::zen::endpoint::unregister would see
    // on the real path (modulo race conditions a millisecond later).
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
        return Err(UecmError::InvalidInput(format!(
            "cannot unregister endpoint {endpoint_id}: still referenced as upstream by [{list}]; un-point them first"
        )));
    }

    if outcome == Outcome::DryRun {
        destructive::emit_plan(
            ctx.emitter.as_mut(),
            "zen.unregister",
            serde_json::json!({
                "endpoint_id": endpoint_id,
                "machine_id": ep.machine_id,
                "declared_port": ep.declared_port,
                "role": ep.role,
            }),
        );
        return Ok(());
    }

    // Core layer also checks dependents under a transaction — this is
    // belt-and-braces in case a sibling registered between our pre-check and
    // the commit. Real apply path remains authoritative.
    zen_endpoint::unregister(&db, endpoint_id)?;
    let summary = serde_json::json!({
        "ok": true,
        "endpoint_id": endpoint_id,
        "machine_id": ep.machine_id,
        "action": "unregister",
    });
    ctx.emitter.emit_event(&Event::Completed { summary }).ok();
    Ok(())
}

/// `zen change-role` — flip an endpoint between `local` and
/// `shared_upstream` without unregister + re-register. Validation is
/// delegated to `core::zen::endpoint::change_role` (single transaction
/// covering current-state read, role/upstream/lifecycle/dependents
/// checks, and the update).
fn change_role(
    ctx: &mut Ctx<'_>,
    endpoint_id: i64,
    new_role: &str,
    new_upstream: Option<i64>,
    yes: bool,
    dry_run: bool,
) -> UecmResult<()> {
    let outcome = destructive::check(yes, dry_run, "zen.change-role")?;
    let db = ctx.require_db()?.clone();

    // Codex P2: run the same role/lifecycle/upstream/dependents checks the
    // real apply path runs — otherwise dry-run reports a plan as
    // executable when the real `--yes` would refuse (e.g.
    // editor_owned → shared_upstream, demote with dependents).
    let current = zen_endpoint::validate_change_role(
        &db,
        endpoint_id,
        new_role,
        new_upstream,
    )?;

    if outcome == Outcome::DryRun {
        destructive::emit_plan(
            ctx.emitter.as_mut(),
            "zen.change-role",
            serde_json::json!({
                "endpoint_id": endpoint_id,
                "machine_id": current.machine_id,
                "declared_port": current.declared_port,
                "current_role": current.role,
                "current_upstream_endpoint_id": current.upstream_endpoint_id,
                "new_role": new_role,
                "new_upstream_endpoint_id": new_upstream,
                "lifecycle_mode": current.lifecycle_mode,
            }),
        );
        return Ok(());
    }

    zen_endpoint::change_role(&db, endpoint_id, new_role, new_upstream)?;

    // Re-fetch so the JSON reflects the persisted row (in particular,
    // confirms the upstream pointer landed where the caller asked).
    let after = zen_endpoint::get(&db, endpoint_id)?.ok_or_else(|| {
        UecmError::OperationFailed(format!(
            "endpoint id={endpoint_id} disappeared between change_role and re-fetch"
        ))
    })?;

    let summary = serde_json::json!({
        "ok": true,
        "endpoint_id": endpoint_id,
        "machine_id": after.machine_id,
        "previous_role": current.role,
        "new_role": after.role,
        "previous_upstream_endpoint_id": current.upstream_endpoint_id,
        "new_upstream_endpoint_id": after.upstream_endpoint_id,
        "action": "change-role",
    });
    ctx.emitter.emit_event(&Event::Completed { summary }).ok();
    Ok(())
}

// -----------------------------------------------------------------------------
// apply-config / lua-preview (T2.5)
// -----------------------------------------------------------------------------


fn lua_preview(ctx: &mut Ctx<'_>, endpoint_id: i64) -> UecmResult<()> {
    let db = ctx.require_db()?.clone();
    let (ep, lua) = render_lua_for(&db, endpoint_id)?;
    // Codex P2: run the same data_dir safety guard as `apply-config` so
    // `lua-preview` doesn't render a config the subsequent `apply-config`
    // (even `--dry-run`) is guaranteed to refuse. The CLI doc string
    // promises the two use the "same engine"; without this check, an
    // endpoint with `data_dir = C:\Windows\Zen` would print a happy Lua
    // file from `lua-preview` then crash out of `apply-config`.
    validate_data_dir_safe(&ep.data_dir)?;
    let doc = serde_json::json!({
        "ok": true,
        "endpoint_id": endpoint_id,
        "machine_id": ep.machine_id,
        "lua": lua,
    });
    ctx.emitter.emit_result(&doc).ok();
    Ok(())
}

/// Derive the zen.lua destination from an install-dir zen.exe path
/// (`…\Zen\Install\zen.exe` → `…\Zen\Install\zen.lua`).
/// Uses string-level backslash/forward-slash splitting so it works on both
/// Windows (runtime) and macOS (unit tests).
fn derive_lua_dest(zen_exe: &str) -> Option<String> {
    // Find the last separator (backslash or forward-slash).
    let last_sep = zen_exe.rfind(|c| c == '\\' || c == '/');
    match last_sep {
        Some(idx) => Some(format!("{}\\zen.lua", &zen_exe[..idx])),
        None => Some("zen.lua".to_string()),
    }
}

fn apply_config(
    ctx: &mut Ctx<'_>,
    endpoint_id: i64,
    dest_path: Option<String>,
    yes: bool,
    dry_run: bool,
    cred: &CredentialArgs,
) -> UecmResult<()> {
    let db = ctx.require_db()?.clone();
    cred.preflight(&db)?;
    let (ep, lua) = render_lua_for(&db, endpoint_id)?;
    let machine = require_machine(&db, ep.machine_id)?;

    // F6: resolve dest_path — explicit value wins; when omitted, derive from
    // the recorded install-dir zen.exe (intree zen.exe lives in
    // Engine\Binaries\Win64 — wrong place for zen.lua, so intree-only
    // machines still require an explicit --dest-path).
    let dest_path: String = match dest_path {
        Some(p) => p,
        None => {
            let install = machine_zen_install::find(&db, ep.machine_id)?;
            let zen_exe = install
                .as_ref()
                .and_then(|m| m.zen_cli_path.clone())
                .ok_or_else(|| UecmError::InvalidInput(format!(
                    "cannot derive --dest-path: machine id={} has no install-dir zen.exe \
                     recorded; run `zen detect-binary` or pass --dest-path explicitly",
                    ep.machine_id
                )))?;
            derive_lua_dest(&zen_exe).ok_or_else(|| UecmError::InvalidInput(
                "recorded zen.exe path has no usable parent dir".into()))?
        }
    };

    // Codex P2 fix: mirror `zen-write-lua-config.ps1`'s destination-path
    // checks here so `--dry-run` doesn't approve a path the `--yes` apply
    // would deterministically reject. Catches relative paths, Win32 device
    // namespace, and forbidden system roots before any work happens.
    validate_dest_path(&dest_path)?;
    // Same guard on the endpoint's recorded `data_dir`. Plan §8 T2.2 writes
    // `server.datadir` straight from this field — if it points at C:\Windows
    // the rendered zen.lua would steer zen into a system root the moment
    // the service starts. T2.8's full datadir-safety guard isn't shipped yet,
    // but the system-root subset of that check is already a hard fail in
    // every sidecar we drive, so refuse here too (codex P2).
    validate_data_dir_safe(&ep.data_dir)?;

    if dry_run {
        // Print the rendered lua + the destination plan. No PS invocation.
        destructive::emit_plan(
            ctx.emitter.as_mut(),
            "zen.apply-config",
            serde_json::json!({
                "endpoint_id": endpoint_id,
                "machine_id": ep.machine_id,
                "host": machine.ip,
                // dest_path is operator-supplied, or (F6) derived from the
                // detected install-dir zen.exe → …\Zen\Install\zen.lua.
                "dest_path": &dest_path,
                "lua": lua,
            }),
        );
        return Ok(());
    }

    if !yes {
        return Err(UecmError::InvalidInput(
            "zen.apply-config is destructive; pass --yes to confirm or --dry-run to preview".into(),
        ));
    }

    // Reaching the PS sidecar requires Windows (lanPC). On the dev mac the
    // call below errors with `PowerShell("WinRM is Windows-only")` which
    // maps to exit 4 — same contract as M1 detect-binary.
    cred.preflight(&db)?;

    // operations log row — log the *redacted* invocation so secrets never
    // make it to disk.
    let invocation = redact(&format!(
        "zen-write-lua-config.ps1 -DestPath {dest_path} (lua {} bytes)",
        lua.len()
    ));
    let op_id = operations::start(&db, "zen.apply_config", &[ep.machine_id])?;

    let expected_sha = sha256_hex_of(&lua);
    let result = invoke_write_lua(&machine.ip, &lua, &dest_path, None)
        .and_then(|response| verify_write_response(&response, &expected_sha, lua.len()));
    finalize_op(&db, op_id, &result, &invocation);

    let response = result?;
    let summary = serde_json::json!({
        "ok": true,
        "endpoint_id": endpoint_id,
        "machine_id": ep.machine_id,
        "host": machine.ip,
        "dest_path": &dest_path,
        "sha256": expected_sha,
        "remote": response,
    });
    ctx.emitter.emit_event(&Event::Completed { summary }).ok();
    Ok(())
}


// -----------------------------------------------------------------------------
// service install / uninstall / start / stop / status (T2.5)
// -----------------------------------------------------------------------------

#[derive(Copy, Clone)]
enum ServiceVerb {
    Start,
    Stop,
}


fn service_install(
    ctx: &mut Ctx<'_>,
    endpoint_id: i64,
    service_user: Option<&str>,
    service_pass_inline: Option<&str>,
    service_pass_stdin: bool,
    yes: bool,
    dry_run: bool,
    cred: &CredentialArgs,
) -> UecmResult<()> {
    let db = ctx.require_db()?.clone();
    cred.preflight(&db)?;
    let ep = require_endpoint(&db, endpoint_id)?;
    let machine = require_machine(&db, ep.machine_id)?;

    // Resolve the zen.exe to hand `zen service install`. We wrap
    // `zen.exe service install`, which registers the sibling zenserver.exe as
    // the SCM service binary. Bug 4 (2026-06-05 lanPC E2E): the in-tree binary
    // must win over the user-private install copy so the hardcoded
    // `NT AUTHORITY\LocalService` account can actually start that zenserver.exe
    // — see `pick_service_zen_exe`.
    let install = machine_zen_install::find(&db, ep.machine_id)?;
    let intree_cli = cache_core::data::machine_ue_installs::list_for_machine(&db, ep.machine_id)
        .ok()
        .and_then(|installs| installs.into_iter().find_map(|i| i.zen_cli_intree_path));
    let zen_exe =
        pick_service_zen_exe(intree_cli, install.as_ref().and_then(|m| m.zen_cli_path.clone()))
            .ok_or_else(|| {
                UecmError::InvalidInput(format!(
                    "machine id={} has no zen.exe recorded — run \
                     `uecm-cli machine refresh {}` then \
                     `uecm-cli zen detect-binary --machine {}` first",
                    ep.machine_id, ep.machine_id, ep.machine_id,
                ))
            })?;

    // Codex P2: lifecycle is the DB source of truth. Refuse to install zen as
    // an OS service when the endpoint row claims `editor_owned` — otherwise
    // SCM and DB drift apart (status / lua-preview keep reporting
    // editor_owned while a real Windows service exists). Operator re-runs
    // `zen register` (or uses a future `change-lifecycle` command) to flip
    // the row to `installed_service` first.
    if ep.lifecycle_mode != "installed_service" {
        // Codex P2: the only working recovery is to delete the existing row
        // and re-register — `zen register` is idempotent on (machine, port)
        // and won't overwrite lifecycle on the conflict path, so a naive
        // re-register doesn't fix the drift. M3 will add a proper
        // `zen change-lifecycle` command; until then point the operator at
        // unregister + register so they don't loop on a "just re-register"
        // suggestion that doesn't apply.
        return Err(UecmError::InvalidInput(format!(
            "endpoint id={endpoint_id} has lifecycle_mode={:?}; service install \
             requires lifecycle_mode=\"installed_service\". To recover: \
             `zen unregister --endpoint-id {endpoint_id} --yes` followed by \
             `zen register --machine {} --declared-port {} --role {} \
             --lifecycle installed_service ...`",
            ep.lifecycle_mode, ep.machine_id, ep.declared_port, ep.role,
        )));
    }

    // Codex P2: `zen-service-install.ps1` rejects drive-relative, root-relative
    // and forbidden-system-root data dirs before SCM registration. Mirror
    // those checks here so `--dry-run` doesn't approve a plan the real apply
    // path always rejects.
    validate_service_data_dir(&ep.data_dir)?;
    // Codex P2: same idea for the service-account / password pair — the
    // sidecar would reject `.\\render-svc` without a password, so dry-run
    // must reject it too instead of printing an "approved" plan that the
    // real apply path fails.
    validate_service_account_pair(service_user, service_pass_inline, service_pass_stdin)?;

    // ZEN-3: workstation co-location pre-flight (advisory only — NOT a hard
    // error, since co-location can be a deliberate choice).
    let workstation_warning = workstation_colocation_warning(&db, ep.machine_id)?;
    if let Some(ref w) = workstation_warning {
        ctx.emitter
            .emit_event(&Event::LogLine {
                text: w.clone(),
                parsed_kind: Some("warning".into()),
            })
            .ok();
    }

    if dry_run {
        destructive::emit_plan(
            ctx.emitter.as_mut(),
            "zen.service.install",
            serde_json::json!({
                "endpoint_id": endpoint_id,
                "machine_id": ep.machine_id,
                "host": machine.ip,
                "service_name": DEFAULT_SERVICE_NAME,
                "zen_exe_path": zen_exe,
                "data_dir": ep.data_dir,
                "service_user": service_user,
                // Don't echo the password into the dry-run plan and don't
                // read stdin yet — preview should be side-effect free.
                // Empty `--service-pass ""` is reported as not-supplied
                // (the sidecar's IsNullOrEmpty check would also treat it
                // that way at apply time), so the preview stays honest.
                "service_pass_supplied": service_pass_inline
                    .map(|p| !p.is_empty())
                    .unwrap_or(false)
                    || service_pass_stdin,
                "warnings": workstation_warning
                    .as_ref()
                    .map(|w| vec![w.clone()])
                    .unwrap_or_default(),
            }),
        );
        return Ok(());
    }
    if !yes {
        return Err(UecmError::InvalidInput(
            "zen.service.install is destructive; pass --yes to confirm or --dry-run to preview".into(),
        ));
    }

    // Codex P2: read stdin only AFTER the dry-run / --yes guards pass so a
    // preview or rejected destructive command never consumes secret input.
    let resolved_pass: Option<String> = if service_pass_stdin {
        use std::io::BufRead;
        let mut line = String::new();
        std::io::stdin().lock().read_line(&mut line).map_err(|e| {
            UecmError::InvalidInput(format!(
                "read --service-pass-stdin from stdin: {e}"
            ))
        })?;
        Some(line.trim_end_matches(['\r', '\n']).to_string())
    } else {
        service_pass_inline.map(str::to_string)
    };
    let service_pass = resolved_pass.as_deref();

    // SSH key auth (uecm-svc); operator credential not needed. preflight validates
    // --cred-alias / flag combo without reading DPAPI or stdin for a discarded cred.
    cred.preflight(&db)?;
    // Build the invocation string for log_text. ServicePassword is wrapped
    // in `--password <REDACTED>`-shape to leverage the existing redactor —
    // the actual flag we pass to PS is `-ServicePassword` which the
    // flag-name-based redactor doesn't catch, so we redact manually.
    let pass_marker = if service_pass.is_some() {
        " -ServicePassword [REDACTED]"
    } else {
        ""
    };
    let user_marker = service_user
        .map(|u| format!(" -ServiceUser {u}"))
        .unwrap_or_default();
    let invocation = redact(&format!(
        "zen-service-install.ps1 -ZenExePath {zen_exe} -ServiceName {DEFAULT_SERVICE_NAME} -DataDir {} -Port {} -HttpServerClass {}{user_marker}{pass_marker}",
        ep.data_dir, ep.declared_port, ep.httpserverclass,
    ));
    let op_id = operations::start(&db, "zen.service_install", &[ep.machine_id])?;

    // Build the parameter object. ServiceUser / ServicePassword only added
    // when supplied — the node script defaults to '' (zen keeps LocalService)
    // when the field is absent.
    let mut args = serde_json::json!({
        "ZenExePath": zen_exe,
        "ServiceName": DEFAULT_SERVICE_NAME,
        "DataDir": ep.data_dir,
        // F2: zen's `service install` does NOT persist these into the SCM
        // ImagePath; the sidecar patches the registry so the service starts on
        // the declared port instead of relocating to base+100.
        "Port": ep.declared_port,
        "HttpServerClass": ep.httpserverclass,
    });
    if let Some(obj) = args.as_object_mut() {
        if let Some(u) = service_user {
            obj.insert("ServiceUser".into(), serde_json::Value::String(u.to_string()));
        }
        if let Some(p) = service_pass {
            obj.insert("ServicePassword".into(), serde_json::Value::String(p.to_string()));
        }
    }
    let result = run_node(&machine.ip, "zen-service-install.ps1", args)
        .and_then(|raw| parse_envelope(&raw, "zen-service-install"));
    finalize_op(&db, op_id, &result, &invocation);
    let response = result?;

    let summary = serde_json::json!({
        "ok": true,
        "endpoint_id": endpoint_id,
        "machine_id": ep.machine_id,
        "host": machine.ip,
        "service_name": DEFAULT_SERVICE_NAME,
        "remote": response,
        "warnings": workstation_warning
            .as_ref()
            .map(|w| vec![w.clone()])
            .unwrap_or_default(),
    });
    ctx.emitter.emit_event(&Event::Completed { summary }).ok();
    Ok(())
}

fn service_uninstall(
    ctx: &mut Ctx<'_>,
    endpoint_id: i64,
    yes: bool,
    dry_run: bool,
    cred: &CredentialArgs,
) -> UecmResult<()> {
    let outcome = destructive::check(yes, dry_run, "zen.service.uninstall")?;
    let db = ctx.require_db()?.clone();
    cred.preflight(&db)?;
    let ep = require_endpoint(&db, endpoint_id)?;
    let machine = require_machine(&db, ep.machine_id)?;
    // Service install/uninstall wrap `zen.exe service install|uninstall`, NOT
    // `zenserver.exe`. `zen.exe` is the CLI in the install dir and is what
    // `detect-binary` records as `zen_cli_path` (zenserver_path points at the
    // long-running daemon binary, which is the wrong tool for SCM registration).
    //
    // Codex P2: a missing `zen_cli_path` is a precondition error, NOT a
    // success no-op. The remote SCM could still have a `ZenServer` service
    // registered (manual install, stale DB, or detect-binary never run),
    // and silently returning ok=true would mislead operators into thinking
    // the host is clean. Fail with InvalidInput → exit 2 so automation
    // re-runs `detect-binary` (or supplies the path explicitly when T2.9
    // adds an override flag).
    let install = machine_zen_install::find(&db, ep.machine_id)?;
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
            UecmError::InvalidInput(format!(
                "machine id={} has no zen.exe (zen_cli) recorded — run \
                 `uecm-cli zen detect-binary --machine {}` first so we can \
                 invoke `zen.exe service uninstall` against the real binary",
                ep.machine_id, ep.machine_id,
            ))
        })?;

    if outcome == Outcome::DryRun {
        destructive::emit_plan(
            ctx.emitter.as_mut(),
            "zen.service.uninstall",
            serde_json::json!({
                "endpoint_id": endpoint_id,
                "machine_id": ep.machine_id,
                "host": machine.ip,
                "service_name": DEFAULT_SERVICE_NAME,
                "zen_exe_path": zen_exe,
            }),
        );
        return Ok(());
    }

    // SSH key auth (uecm-svc); operator credential not needed. preflight validates
    // --cred-alias / flag combo without reading DPAPI or stdin for a discarded cred.
    cred.preflight(&db)?;
    let invocation = redact(&format!(
        "zen-service-uninstall.ps1 -ZenExePath {zen_exe} -ServiceName {DEFAULT_SERVICE_NAME}"
    ));
    let op_id = operations::start(&db, "zen.service_uninstall", &[ep.machine_id])?;
    let result = run_node(
        &machine.ip,
        "zen-service-uninstall.ps1",
        serde_json::json!({ "ZenExePath": zen_exe, "ServiceName": DEFAULT_SERVICE_NAME }),
    )
    .and_then(|raw| parse_envelope(&raw, "zen-service-uninstall"));
    finalize_op(&db, op_id, &result, &invocation);
    let response = result?;
    let summary = serde_json::json!({
        "ok": true,
        "endpoint_id": endpoint_id,
        "machine_id": ep.machine_id,
        "host": machine.ip,
        "service_name": DEFAULT_SERVICE_NAME,
        "remote": response,
    });
    ctx.emitter.emit_event(&Event::Completed { summary }).ok();
    Ok(())
}

fn service_simple(
    ctx: &mut Ctx<'_>,
    endpoint_id: i64,
    verb: ServiceVerb,
    yes: bool,
    dry_run: bool,
    cred: &CredentialArgs,
) -> UecmResult<()> {
    let (script, op_kind, op_label, destructive_check) = match verb {
        ServiceVerb::Start => ("zen-up.ps1", "zen.service_start", "zen.service.start", false),
        // Stop is destructive — codex P2 fix. A stray `zen service stop` on a
        // `shared_upstream` master severs the whole cluster's cache forwarding.
        ServiceVerb::Stop => ("zen-down.ps1", "zen.service_stop", "zen.service.stop", true),
    };
    let db = ctx.require_db()?.clone();
    cred.preflight(&db)?;
    let ep = require_endpoint(&db, endpoint_id)?;
    let machine = require_machine(&db, ep.machine_id)?;

    // Codex P2: only `installed_service` endpoints have an SCM service we
    // can drive via `zen-up.ps1` / `zen-down.ps1`. An `editor_owned`
    // endpoint records "the editor sponsors zen on this machine" — it
    // doesn't own the host's `ZenServer` service. Driving the service
    // anyway would touch whatever stale install exists, creating exactly
    // the DB/SCM drift `service install` already guards against. Refuse.
    if ep.lifecycle_mode != "installed_service" {
        return Err(UecmError::InvalidInput(format!(
            "service {} requires endpoint id={} to have lifecycle_mode=\"installed_service\" \
             (got {:?}); `editor_owned` endpoints are sponsored by UE editor and have no SCM service",
            op_label, endpoint_id, ep.lifecycle_mode
        )));
    }

    if destructive_check {
        let outcome = destructive::check(yes, dry_run, op_label)?;
        if outcome == Outcome::DryRun {
            destructive::emit_plan(
                ctx.emitter.as_mut(),
                op_label,
                serde_json::json!({
                    "endpoint_id": endpoint_id,
                    "machine_id": ep.machine_id,
                    "host": machine.ip,
                    "service_name": DEFAULT_SERVICE_NAME,
                }),
            );
            return Ok(());
        }
    }

    // SSH key auth (uecm-svc); operator credential not needed. preflight validates
    // --cred-alias / flag combo without reading DPAPI or stdin for a discarded cred.
    cred.preflight(&db)?;

    let invocation = redact(&format!("{script} -ServiceName {DEFAULT_SERVICE_NAME}"));
    let op_id = operations::start(&db, op_kind, &[ep.machine_id])?;
    let result = run_node(
        &machine.ip,
        script,
        serde_json::json!({ "ServiceName": DEFAULT_SERVICE_NAME }),
    )
    .and_then(|raw| parse_envelope(&raw, script));
    finalize_op(&db, op_id, &result, &invocation);
    let response = result?;
    let summary = serde_json::json!({
        "ok": true,
        "endpoint_id": endpoint_id,
        "machine_id": ep.machine_id,
        "host": machine.ip,
        "service_name": DEFAULT_SERVICE_NAME,
        "remote": response,
    });
    ctx.emitter.emit_event(&Event::Completed { summary }).ok();
    Ok(())
}

fn sponsor_down(
    ctx: &mut Ctx<'_>,
    endpoint_id: i64,
    yes: bool,
    dry_run: bool,
    cred: &CredentialArgs,
) -> UecmResult<()> {
    let outcome = destructive::check(yes, dry_run, "zen.sponsor_down")?;
    let db = ctx.require_db()?.clone();
    cred.preflight(&db)?;
    let ep = require_endpoint(&db, endpoint_id)?;
    let machine = require_machine(&db, ep.machine_id)?;

    // Reuse the F1 resolution: install-dir zen.exe, else highest-version intree.
    let install = machine_zen_install::find(&db, ep.machine_id)?;
    let zen_exe = install
        .as_ref()
        .and_then(|m| m.zen_cli_path.clone())
        .or_else(|| {
            cache_core::data::machine_ue_installs::list_for_machine(&db, ep.machine_id)
                .ok()
                .and_then(|v| v.into_iter().find_map(|i| i.zen_cli_intree_path))
        })
        .ok_or_else(|| {
            UecmError::InvalidInput(format!(
                "machine id={} has no zen.exe (zen_cli) recorded — run \
                 `uecm-cli zen detect-binary --machine {}` first",
                ep.machine_id, ep.machine_id,
            ))
        })?;

    let invocation = format!(
        "zen-sponsor-down.ps1 -ZenExePath {zen_exe} -Port {} -ServiceName {DEFAULT_SERVICE_NAME} -DryRun {}",
        ep.declared_port,
        outcome == Outcome::DryRun
    );
    let op_id = operations::start(&db, "zen.sponsor_down", &[ep.machine_id])?;
    let result = run_node(
        &machine.ip,
        "zen-sponsor-down.ps1",
        serde_json::json!({
            "ZenExePath": zen_exe,
            "Port": ep.declared_port,
            "ServiceName": DEFAULT_SERVICE_NAME,
            "DryRun": outcome == Outcome::DryRun,
        }),
    )
    .and_then(|raw| parse_envelope(&raw, "zen-sponsor-down"));
    finalize_op(&db, op_id, &result, &invocation);
    let response = result?;
    let summary = serde_json::json!({
        "ok": true,
        "endpoint_id": endpoint_id,
        "machine_id": ep.machine_id,
        "host": machine.ip,
        "port": ep.declared_port,
        "dry_run": outcome == Outcome::DryRun,
        "remote": response,
    });
    ctx.emitter.emit_event(&Event::Completed { summary }).ok();
    Ok(())
}

fn service_status(
    ctx: &mut Ctx<'_>,
    endpoint_id: i64,
    cred: &CredentialArgs,
) -> UecmResult<()> {
    let db = ctx.require_db()?.clone();
    cred.preflight(&db)?;
    let ep = require_endpoint(&db, endpoint_id)?;
    let machine = require_machine(&db, ep.machine_id)?;
    // SSH key auth (uecm-svc); operator credential not needed. preflight validates
    // --cred-alias / flag combo without reading DPAPI or stdin for a discarded cred.
    cred.preflight(&db)?;

    let raw = run_node(
        &machine.ip,
        "zen-service-status.ps1",
        serde_json::json!({ "ServiceName": DEFAULT_SERVICE_NAME }),
    )?;
    let response = parse_envelope(&raw, "zen-service-status")?;
    let doc = serde_json::json!({
        "ok": true,
        "endpoint_id": endpoint_id,
        "machine_id": ep.machine_id,
        "host": machine.ip,
        "service_name": DEFAULT_SERVICE_NAME,
        "remote": response,
    });
    ctx.emitter.emit_result(&doc).ok();
    Ok(())
}

// -----------------------------------------------------------------------------
// urlacl add / list / remove (T2.5)
// -----------------------------------------------------------------------------


fn urlacl_add(
    ctx: &mut Ctx<'_>,
    endpoint_id: i64,
    principal: &str,
    yes: bool,
    dry_run: bool,
    cred: &CredentialArgs,
) -> UecmResult<()> {
    let outcome = destructive::check(yes, dry_run, "zen.urlacl.add")?;
    // Codex P3: empty / whitespace principal would make `zen-urlacl-add.ps1`
    // throw on its `IsNullOrWhiteSpace` check. Reject before dry-run so the
    // plan matches what `--yes` would actually accept.
    if principal.trim().is_empty() {
        return Err(UecmError::InvalidInput(
            "--principal must not be empty or whitespace (URL ACL needs a real account)".into(),
        ));
    }
    let db = ctx.require_db()?.clone();
    cred.preflight(&db)?;
    let ep = require_endpoint(&db, endpoint_id)?;
    let machine = require_machine(&db, ep.machine_id)?;
    let url_prefix = url_prefix_for(&ep);

    if outcome == Outcome::DryRun {
        destructive::emit_plan(
            ctx.emitter.as_mut(),
            "zen.urlacl.add",
            serde_json::json!({
                "endpoint_id": endpoint_id,
                "machine_id": ep.machine_id,
                "host": machine.ip,
                "url_prefix": url_prefix,
                "principal": principal,
            }),
        );
        return Ok(());
    }

    // SSH key auth (uecm-svc); operator credential not needed. preflight validates
    // --cred-alias / flag combo without reading DPAPI or stdin for a discarded cred.
    cred.preflight(&db)?;

    let invocation = redact(&format!(
        "zen-urlacl-add.ps1 -UrlPrefix {url_prefix} -UserAccount {principal}"
    ));
    let op_id = operations::start(&db, "zen.urlacl_add", &[ep.machine_id])?;
    let result = run_node(
        &machine.ip,
        "zen-urlacl-add.ps1",
        serde_json::json!({ "UrlPrefix": url_prefix, "UserAccount": principal }),
    )
    .and_then(|raw| parse_envelope(&raw, "zen-urlacl-add"));
    finalize_op(&db, op_id, &result, &invocation);
    let response = result?;
    let summary = serde_json::json!({
        "ok": true,
        "endpoint_id": endpoint_id,
        "machine_id": ep.machine_id,
        "host": machine.ip,
        "url_prefix": url_prefix,
        "principal": principal,
        "remote": response,
    });
    ctx.emitter.emit_event(&Event::Completed { summary }).ok();
    Ok(())
}

fn urlacl_list(
    ctx: &mut Ctx<'_>,
    machine: i64,
    port_filter: Option<&str>,
    cred: &CredentialArgs,
) -> UecmResult<()> {
    let db = ctx.require_db()?.clone();
    cred.preflight(&db)?;
    let m = require_machine(&db, machine)?;
    // SSH key auth (uecm-svc); operator credential not needed. preflight validates
    // --cred-alias / flag combo without reading DPAPI or stdin for a discarded cred.
    cred.preflight(&db)?;

    // PortFilter optional — null when no filter; the node script treats
    // null / empty as "list all reservations".
    let raw = run_node(
        &m.ip,
        "zen-urlacl-list.ps1",
        serde_json::json!({ "PortFilter": port_filter }),
    )?;
    let response = parse_envelope(&raw, "zen-urlacl-list")?;
    let doc = serde_json::json!({
        "ok": true,
        "machine_id": machine,
        "host": m.ip,
        "port_filter": port_filter,
        "remote": response,
    });
    ctx.emitter.emit_result(&doc).ok();
    Ok(())
}

fn urlacl_remove(
    ctx: &mut Ctx<'_>,
    endpoint_id: i64,
    yes: bool,
    dry_run: bool,
    cred: &CredentialArgs,
) -> UecmResult<()> {
    let outcome = destructive::check(yes, dry_run, "zen.urlacl.remove")?;
    let db = ctx.require_db()?.clone();
    cred.preflight(&db)?;
    let ep = require_endpoint(&db, endpoint_id)?;
    let machine = require_machine(&db, ep.machine_id)?;
    let url_prefix = url_prefix_for(&ep);

    if outcome == Outcome::DryRun {
        destructive::emit_plan(
            ctx.emitter.as_mut(),
            "zen.urlacl.remove",
            serde_json::json!({
                "endpoint_id": endpoint_id,
                "machine_id": ep.machine_id,
                "host": machine.ip,
                "url_prefix": url_prefix,
            }),
        );
        return Ok(());
    }

    // SSH key auth (uecm-svc); operator credential not needed. preflight validates
    // --cred-alias / flag combo without reading DPAPI or stdin for a discarded cred.
    cred.preflight(&db)?;

    let invocation = redact(&format!("zen-urlacl-remove.ps1 -UrlPrefix {url_prefix}"));
    let op_id = operations::start(&db, "zen.urlacl_remove", &[ep.machine_id])?;
    let result = run_node(
        &machine.ip,
        "zen-urlacl-remove.ps1",
        serde_json::json!({ "UrlPrefix": url_prefix }),
    )
    .and_then(|raw| parse_envelope(&raw, "zen-urlacl-remove"));
    finalize_op(&db, op_id, &result, &invocation);
    let response = result?;
    let summary = serde_json::json!({
        "ok": true,
        "endpoint_id": endpoint_id,
        "machine_id": ep.machine_id,
        "host": machine.ip,
        "url_prefix": url_prefix,
        "remote": response,
    });
    ctx.emitter.emit_event(&Event::Completed { summary }).ok();
    Ok(())
}

// -----------------------------------------------------------------------------
// PS sidecar plumbing (T2.5)
// -----------------------------------------------------------------------------


// -----------------------------------------------------------------------------
// project enable / disable (T3.7) — fan out across N machines
// -----------------------------------------------------------------------------

/// Per-machine record returned in the aggregate JSON. Mirrors the report
/// captured by `EnableOutcome` / `DisableOutcome` plus the env-cleanup leg
/// the orchestrator drives.
#[derive(Debug, Clone, Serialize)]
struct ProjectMachineResult {
    machine_id: i64,
    host: String,
    /// `true` when this machine's INI was mutated (or would have been).
    /// `false` for idempotent no-op runs (state already matches).
    changed: bool,
    ini_file: Option<String>,
    keys_set: Vec<KeyApplyView>,
    keys_removed: Vec<KeyApplyView>,
    backups: Vec<String>,
    env_cleanup_results: Vec<EnvCleanupResultView>,
    warnings: Vec<String>,
    /// Per-machine error message when this machine's leg failed. `None` on
    /// success. Set when the INI mutation or env-cleanup PS sidecar errored;
    /// other machines still get processed.
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct KeyApplyView {
    section: String,
    key: String,
    action: String,
    previous_value: Option<String>,
    new_value: Option<String>,
}

impl From<&zen_enable::KeyApplyRecord> for KeyApplyView {
    fn from(r: &zen_enable::KeyApplyRecord) -> Self {
        Self {
            section: r.section.clone(),
            key: r.key.clone(),
            action: r.action.clone(),
            previous_value: r.previous_value.clone(),
            new_value: r.new_value.clone(),
        }
    }
}

/// One PS-sidecar call result, captured as raw JSON for forward compatibility.
/// `ok=true` mirrors `zen-env-cleanup.ps1`'s envelope; `error` is set when the
/// call or response parse failed.
#[derive(Debug, Clone, Serialize)]
struct EnvCleanupResultView {
    var: String,
    scope: String,
    ok: bool,
    /// Raw response object from `zen-env-cleanup.ps1` on success.
    remote: Option<serde_json::Value>,
    error: Option<String>,
}

/// Resolve the `ue_version_major.minor` string the rules resolver expects.
/// Both halves must be populated — a project with an unresolved EngineAssociation
/// (e.g. raw GUID) has no version to gate rules on, so we refuse rather than
/// guess. Operator can re-discover or set the version manually.
fn project_ue_version_string(project: &cache_core::data::Project) -> UecmResult<String> {
    match (project.ue_version_major, project.ue_version_minor) {
        (Some(major), Some(minor)) => Ok(format!("{major}.{minor}")),
        _ => Err(UecmError::InvalidInput(format!(
            "project id={} has no resolved UE version (engine_association_kind={:?}); \
             zen enable/disable needs major.minor to pick the rule set. Re-run project \
             discovery or set the location with an EngineAssociation-bearing .uproject.",
            project.id.unwrap_or(-1),
            project.engine_association_kind,
        ))),
    }
}

/// Compose the absolute `DefaultEngine.ini` path on the target machine from a
/// `project_locations` row. The convention matches `core::ini_apply` /
/// `core::project_discovery` — both use `<abs_path>\Config\DefaultEngine.ini`.
///
/// Honors either Windows (`\`) or POSIX (`/`) abs_path separators since the
/// `abs_path` field is freeform operator input. The remote sidecar normalizes
/// either form, so we don't try to canonicalize here.
fn project_ini_path(abs_path: &str) -> String {
    let trimmed = abs_path.trim_end_matches(['\\', '/']);
    // Stick to backslashes — `abs_path` is a remote Windows path and that's
    // the convention every other UECM module uses (`core::ini_apply`,
    // `core::project_discovery`).
    format!("{trimmed}\\Config\\DefaultEngine.ini")
}

/// Build a `ClusterMaster` view from a `shared_upstream` endpoint id. The
/// endpoint's host comes from its machine row (IP — canonical connect target
/// in this CLI, mirroring `resolve_host` above). Refuses non-shared_upstream
/// upstream selections so an operator can't point an enable at a local-role
/// endpoint and end up writing a self-referential `ZenShared` value.
fn resolve_cluster_master(
    db: &Db,
    upstream_endpoint_id: i64,
    namespace: &str,
) -> UecmResult<zen_enable::ClusterMaster> {
    let ep = zen_endpoints::get(db, upstream_endpoint_id)?.ok_or_else(|| {
        UecmError::InvalidInput(format!(
            "upstream endpoint id={} not found",
            upstream_endpoint_id
        ))
    })?;
    if ep.role != zen_endpoint::ROLE_SHARED_UPSTREAM {
        return Err(UecmError::InvalidInput(format!(
            "upstream endpoint id={} has role={:?}; expected {:?}. \
             Register or pick a shared_upstream endpoint as the cluster master.",
            upstream_endpoint_id,
            ep.role,
            zen_endpoint::ROLE_SHARED_UPSTREAM,
        )));
    }
    let machine = machines::find_by_id(db, ep.machine_id)?.ok_or_else(|| {
        UecmError::OperationFailed(format!(
            "upstream endpoint id={} references machine id={} which is missing",
            upstream_endpoint_id, ep.machine_id,
        ))
    })?;
    Ok(zen_enable::ClusterMaster {
        host: machine.ip,
        port: ep.declared_port,
        namespace: namespace.to_string(),
    })
}

/// Invoke `zen-env-cleanup.ps1` once for a single (var, scope) pair. Returns
/// the parsed JSON envelope on success. Routes through the same SSH bridge
/// (`run_node`) the rest of the migrated zen domain uses.
fn invoke_env_cleanup(
    host: &str,
    var: &str,
    scope: &str,
    creds: Option<&(String, String)>,
) -> UecmResult<serde_json::Value> {
    // SSH key auth (uecm-svc); operator creds ignored (param kept as a shim).
    let _ = creds;
    // Scopes is an array on the node side (`foreach ($s in $Scopes)`); we fan
    // out one scope per call, so pass a single-element JSON array.
    let raw = run_node(
        host,
        "zen-env-cleanup.ps1",
        serde_json::json!({ "Name": var, "Scopes": [scope] }),
    )?;
    let envelope = parse_envelope(&raw, "zen-env-cleanup")?;

    // Codex P1: zen-env-cleanup.ps1 returns top-level ok=true even when an
    // individual scope failed (e.g. Machine scope without admin). The
    // failure surfaces inside `scopes[].error`. Walk every scope entry
    // and bubble up the first error so the orchestrator counts this as
    // a machine failure (otherwise `UE-SharedDataCachePath` could
    // remain active while the CLI reports success).
    if let Some(scopes) = envelope.get("scopes").and_then(|v| v.as_array()) {
        for scope_entry in scopes {
            if let Some(err) = scope_entry.get("error").and_then(|v| v.as_str()) {
                let scope_name = scope_entry
                    .get("scope")
                    .and_then(|v| v.as_str())
                    .unwrap_or("<unknown>");
                return Err(UecmError::OperationFailed(format!(
                    "zen-env-cleanup.ps1: scope {scope_name} for {var} failed: {err}"
                )));
            }
        }
    }
    Ok(envelope)
}

/// DESIGN-3: standalone `zen clean-env` — clear a machine environment variable
/// across N machines via `zen-env-cleanup.ps1`. This is the SAME mechanism
/// `zen enable` runs inline ([`invoke_env_cleanup`]), exposed as its own
/// command so an operator can revert a legacy SMB DDC (`UE-SharedDataCachePath`)
/// or a stale region override (`UE-ZenSharedDataCacheHost`) without re-running
/// enable.
#[allow(clippy::too_many_arguments)]
fn clean_env(
    ctx: &mut Ctx<'_>,
    machine_ids: &[i64],
    name: &str,
    scopes: &[String],
    yes: bool,
    dry_run: bool,
    cred: &CredentialArgs,
) -> UecmResult<()> {
    let gate = destructive::check(yes, dry_run, "zen.clean_env")?;
    if machine_ids.is_empty() {
        return Err(UecmError::InvalidInput(
            "--machines must list at least one machine id".into(),
        ));
    }
    if name.trim().is_empty() {
        return Err(UecmError::InvalidInput("--name must be non-empty".into()));
    }
    if scopes.is_empty() {
        return Err(UecmError::InvalidInput(
            "--scopes must list at least one of: machine, user".into(),
        ));
    }
    // Mirror the sidecar's scope validation up-front so --dry-run is honest.
    for s in scopes {
        let sl = s.to_ascii_lowercase();
        if sl != "machine" && sl != "user" {
            return Err(UecmError::InvalidInput(format!(
                "invalid scope {s:?}; allowed: machine, user"
            )));
        }
    }
    let db = ctx.require_db()?.clone();

    // Resolve machine ids → hosts up-front so a bad id fails before any write.
    let mut targets: Vec<Machine> = Vec::with_capacity(machine_ids.len());
    for &mid in machine_ids {
        let m = machines::find_by_id(&db, mid)?
            .ok_or_else(|| UecmError::InvalidInput(format!("machine id={mid} not found")))?;
        targets.push(m);
    }

    if gate == Outcome::DryRun {
        let planned: Vec<serde_json::Value> = targets
            .iter()
            .map(|m| serde_json::json!({ "machine_id": m.id, "host": m.ip, "hostname": m.hostname }))
            .collect();
        destructive::emit_plan(
            ctx.emitter.as_mut(),
            "zen.clean_env",
            serde_json::json!({ "name": name, "scopes": scopes, "machines": planned }),
        );
        return Ok(());
    }

    cred.preflight(&db)?;
    let total = targets.len() as i64;
    ctx.emitter
        .emit_event(&Event::Started {
            task_type: "zen_clean_env".into(),
            task_id: None,
            metadata: serde_json::json!({ "name": name, "scopes": scopes, "machines": total }),
        })
        .ok();

    let mut ok_count = 0i64;
    let mut fail_count = 0i64;
    for (idx, m) in targets.iter().enumerate() {
        ctx.emitter
            .emit_event(&Event::ItemStarted { item_id: m.ip.clone(), index: idx as i64, total })
            .ok();
        // Fan out one PS call per (var, scope); stop at the first scope error.
        let mut machine_err: Option<String> = None;
        for scope in scopes {
            if let Err(e) = invoke_env_cleanup(&m.ip, name, scope, None) {
                machine_err = Some(e.to_string());
                break;
            }
        }
        match machine_err {
            None => {
                ok_count += 1;
                ctx.emitter
                    .emit_event(&Event::ItemCompleted { item_id: m.ip.clone(), index: idx as i64, ok: true, message: None })
                    .ok();
            }
            Some(msg) => {
                fail_count += 1;
                ctx.emitter
                    .emit_event(&Event::ItemCompleted { item_id: m.ip.clone(), index: idx as i64, ok: false, message: Some(msg) })
                    .ok();
            }
        }
    }

    ctx.emitter
        .emit_event(&Event::Completed {
            summary: serde_json::json!({ "name": name, "machines": total, "ok": ok_count, "failed": fail_count }),
        })
        .ok();
    if fail_count > 0 {
        return Err(UecmError::OperationFailed(format!(
            "{fail_count}/{total} machines failed zen clean-env"
        )));
    }
    Ok(())
}

/// ZEN-4: normalize a region-host argument into a canonical Zen URI.
///
/// Accepts `http(s)://host:port`, `host:port`, or bare `host` (port defaults to
/// 8558), and returns `scheme://host:port`. Validates the hostname charset so a
/// malformed value can't be written into a machine env var. Handles bracketed
/// IPv6 literals (`[::1]:8558`).
fn normalize_region_host(raw: &str) -> UecmResult<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(UecmError::InvalidInput("--host must be non-empty".into()));
    }
    let (scheme, rest) = match trimmed.split_once("://") {
        Some((s, r)) => (s.to_ascii_lowercase(), r),
        None => ("http".to_string(), trimmed),
    };
    if scheme != "http" && scheme != "https" {
        return Err(UecmError::InvalidInput(format!(
            "--host scheme must be http or https, got {scheme:?}"
        )));
    }
    let authority = rest.split(['/', '?']).next().unwrap_or(rest).trim();
    if authority.is_empty() {
        return Err(UecmError::InvalidInput("--host must include a hostname".into()));
    }
    // An unbracketed authority with more than one ':' is an IPv6 literal that
    // wasn't bracketed — the host:port split below (rsplit_once(':')) would
    // mis-parse it (host=":", port=last hextet) and the loose charset check
    // would let that malformed value through. Require RFC-3986 bracketing.
    if !authority.starts_with('[') && authority.matches(':').count() > 1 {
        return Err(UecmError::InvalidInput(format!(
            "--host looks like an unbracketed IPv6 literal; wrap it in brackets, \
             e.g. http://[{authority}]:8558"
        )));
    }
    let (host, port): (String, Option<String>) = if let Some(r) = authority.strip_prefix('[') {
        let end = r
            .find(']')
            .ok_or_else(|| UecmError::InvalidInput("--host has an unterminated IPv6 literal".into()))?;
        let h = format!("[{}]", &r[..end]);
        let p = r[end + 1..].strip_prefix(':').map(|x| x.to_string());
        (h, p)
    } else if let Some((h, p)) = authority.rsplit_once(':') {
        (h.to_string(), Some(p.to_string()))
    } else {
        (authority.to_string(), None)
    };
    let host_inner = host.trim_start_matches('[').trim_end_matches(']');
    if host_inner.is_empty()
        || !host_inner
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':'))
    {
        return Err(UecmError::InvalidInput(format!(
            "--host contains an invalid hostname: {host:?}"
        )));
    }
    let port = match port {
        Some(p) => p.parse::<u16>().map_err(|_| {
            UecmError::InvalidInput(format!("--host port must be 1-65535, got {p:?}"))
        })?,
        None => 8558,
    };
    Ok(format!("{scheme}://{host}:{port}"))
}

/// ZEN-4: set the per-machine ZenShared region override
/// (`UE-ZenSharedDataCacheHost`) across N machines, reusing the same
/// Machine-scope env write (`setx-machine.ps1`) the `env set` domain uses. The
/// `[StorageServers] Shared` entry's `EnvHostOverride` makes this var win over
/// the INI Host, so workstations in different regions can point at their
/// nearest shared Zen server without per-project INI edits.
fn set_region_host(
    ctx: &mut Ctx<'_>,
    machine_ids: &[i64],
    host: &str,
    yes: bool,
    dry_run: bool,
    cred: &CredentialArgs,
) -> UecmResult<()> {
    const VAR: &str = "UE-ZenSharedDataCacheHost";
    let gate = destructive::check(yes, dry_run, "zen.set_region_host")?;
    if machine_ids.is_empty() {
        return Err(UecmError::InvalidInput(
            "--machines must list at least one machine id".into(),
        ));
    }
    let url = normalize_region_host(host)?;
    let db = ctx.require_db()?.clone();

    let mut targets: Vec<Machine> = Vec::with_capacity(machine_ids.len());
    for &mid in machine_ids {
        let m = machines::find_by_id(&db, mid)?
            .ok_or_else(|| UecmError::InvalidInput(format!("machine id={mid} not found")))?;
        targets.push(m);
    }

    if gate == Outcome::DryRun {
        let planned: Vec<serde_json::Value> = targets
            .iter()
            .map(|m| serde_json::json!({ "machine_id": m.id, "host": m.ip, "hostname": m.hostname }))
            .collect();
        destructive::emit_plan(
            ctx.emitter.as_mut(),
            "zen.set_region_host",
            serde_json::json!({ "env_var": VAR, "value": url, "machines": planned }),
        );
        return Ok(());
    }

    cred.preflight(&db)?;
    let total = targets.len() as i64;
    ctx.emitter
        .emit_event(&Event::Started {
            task_type: "zen_set_region_host".into(),
            task_id: None,
            metadata: serde_json::json!({ "env_var": VAR, "value": url, "machines": total }),
        })
        .ok();

    let mut ok_count = 0i64;
    let mut fail_count = 0i64;
    for (idx, m) in targets.iter().enumerate() {
        ctx.emitter
            .emit_event(&Event::ItemStarted { item_id: m.ip.clone(), index: idx as i64, total })
            .ok();
        match cache_core::core::env_vars::set(&m.ip, VAR, &url) {
            Ok(()) => {
                ok_count += 1;
                ctx.emitter
                    .emit_event(&Event::ItemCompleted { item_id: m.ip.clone(), index: idx as i64, ok: true, message: None })
                    .ok();
            }
            Err(e) => {
                fail_count += 1;
                ctx.emitter
                    .emit_event(&Event::ItemCompleted { item_id: m.ip.clone(), index: idx as i64, ok: false, message: Some(e.to_string()) })
                    .ok();
            }
        }
    }

    ctx.emitter
        .emit_event(&Event::Completed {
            summary: serde_json::json!({ "env_var": VAR, "value": url, "machines": total, "ok": ok_count, "failed": fail_count }),
        })
        .ok();
    if fail_count > 0 {
        return Err(UecmError::OperationFailed(format!(
            "{fail_count}/{total} machines failed zen set-region-host"
        )));
    }
    Ok(())
}

/// Load + resolve rules for global-mode operations (no project version
/// available). Uses `resolve_for_diagnostics` which downgrades the
/// `unverified_policy` from `refuse` → `warn`, so the base rule set applies
/// on all UE ≥ 5.4 machines regardless of which UE version each machine runs.
/// The namespace is embedded in `ClusterMaster` at call time, not here.
fn build_global_rules() -> UecmResult<zen_rules::ResolvedRules> {
    // 5.4 is the minimum version `applies_to: >=5.4` accepts; using it here
    // picks up the base rules without any per-version overrides.  This is
    // intentional: global UserEngine.ini should use the conservative defaults.
    let rules_raw = zen_rules::load_default()?;
    zen_rules::resolve_for_diagnostics(&rules_raw, "5.4")
}

#[allow(clippy::too_many_arguments)]
fn global_enable(
    ctx: &mut Ctx<'_>,
    machine_ids: &[i64],
    upstream_endpoint_id: i64,
    namespace: &str,
    yes: bool,
    dry_run: bool,
    cred: &CredentialArgs,
) -> UecmResult<()> {
    let outcome_gate = destructive::check(yes, dry_run, "zen.enable_global")?;
    if machine_ids.is_empty() {
        return Err(UecmError::InvalidInput(
            "--machines must list at least one machine id".into(),
        ));
    }
    let db = ctx.require_db()?.clone();

    // Pre-flight: every machine must have ue_runtime_user set.
    let mut targets: Vec<(Machine, String)> = Vec::with_capacity(machine_ids.len());
    for &mid in machine_ids {
        let m = machines::find_by_id(&db, mid)?
            .ok_or_else(|| UecmError::InvalidInput(format!("machine id={mid} not found")))?;
        let ue_user = machines::get_ue_runtime_user(&db, mid)?.ok_or_else(|| {
            UecmError::InvalidInput(format!(
                "machine id={mid} has no ue_runtime_user set — run \
                 `machine set-ue-user --machine {mid} --ue-user <USERNAME>` first"
            ))
        })?;
        let ini_path = format!(
            r"C:\Users\{ue_user}\AppData\Local\Unreal Engine\Engine\Config\UserEngine.ini"
        );
        targets.push((m, ini_path));
    }

    let master = resolve_cluster_master(&db, upstream_endpoint_id, namespace)?;
    let resolved = build_global_rules()?;

    if outcome_gate == Outcome::DryRun {
        let planned: Vec<serde_json::Value> = targets
            .iter()
            .map(|(m, p)| {
                serde_json::json!({
                    "machine_id": m.id,
                    "host": m.ip,
                    "hostname": m.hostname,
                    "ini_file": p,
                })
            })
            .collect();
        destructive::emit_plan(
            ctx.emitter.as_mut(),
            "zen.enable_global",
            serde_json::json!({
                "master_host": master.host,
                "master_port": master.port,
                "namespace": namespace,
                "rule_section": resolved.rules.enable_zen_shared.section,
                "rule_key": resolved.rules.enable_zen_shared.key,
                "machines": planned,
                "rule_warnings": resolved.warnings,
            }),
        );
        return Ok(());
    }

    cred.preflight(&db)?;

    let total = targets.len() as i64;
    ctx.emitter
        .emit_event(&Event::Started {
            task_type: "zen_enable_global".into(),
            task_id: None,
            metadata: serde_json::json!({ "machines": total }),
        })
        .ok();

    let mut results: Vec<serde_json::Value> = Vec::with_capacity(targets.len());
    let mut fail_count = 0i64;

    for (machine, ini_path) in &targets {
        let machine_id = machine.id.expect("machine in inventory always has id");
        let host = machine.ip.as_str();
        match zen_enable::enable_global(host, ini_path, &resolved, &master) {
            Ok(out) => {
                results.push(serde_json::json!({
                    "machine_id": machine_id,
                    "hostname": machine.hostname,
                    "ok": true,
                    "changed": out.changed,
                    "ini_file": ini_path,
                    "warnings": out.warnings,
                }));
            }
            Err(e) => {
                fail_count += 1;
                results.push(serde_json::json!({
                    "machine_id": machine_id,
                    "hostname": machine.hostname,
                    "ok": false,
                    "error": e.to_string(),
                }));
            }
        }
    }

    let all_ok = fail_count == 0;
    ctx.emitter
        .emit_result(&serde_json::json!({ "ok": all_ok, "results": results }))
        .ok();

    if all_ok {
        Ok(())
    } else {
        Err(UecmError::OperationFailed(format!(
            "zen.enable_global: {}/{} machine(s) failed",
            fail_count, total
        )))
    }
}

fn global_disable(
    ctx: &mut Ctx<'_>,
    machine_ids: &[i64],
    yes: bool,
    dry_run: bool,
    cred: &CredentialArgs,
) -> UecmResult<()> {
    let outcome_gate = destructive::check(yes, dry_run, "zen.disable_global")?;
    if machine_ids.is_empty() {
        return Err(UecmError::InvalidInput(
            "--machines must list at least one machine id".into(),
        ));
    }
    let db = ctx.require_db()?.clone();

    let mut targets: Vec<(Machine, String)> = Vec::with_capacity(machine_ids.len());
    for &mid in machine_ids {
        let m = machines::find_by_id(&db, mid)?
            .ok_or_else(|| UecmError::InvalidInput(format!("machine id={mid} not found")))?;
        let ue_user = machines::get_ue_runtime_user(&db, mid)?.ok_or_else(|| {
            UecmError::InvalidInput(format!(
                "machine id={mid} has no ue_runtime_user set — run \
                 `machine set-ue-user --machine {mid} --ue-user <USERNAME>` first"
            ))
        })?;
        let ini_path = format!(
            r"C:\Users\{ue_user}\AppData\Local\Unreal Engine\Engine\Config\UserEngine.ini"
        );
        targets.push((m, ini_path));
    }

    let resolved = build_global_rules()?;

    if outcome_gate == Outcome::DryRun {
        let planned: Vec<serde_json::Value> = targets
            .iter()
            .map(|(m, p)| {
                serde_json::json!({
                    "machine_id": m.id,
                    "host": m.ip,
                    "hostname": m.hostname,
                    "ini_file": p,
                })
            })
            .collect();
        destructive::emit_plan(
            ctx.emitter.as_mut(),
            "zen.disable_global",
            serde_json::json!({
                "rule_section": resolved.rules.enable_zen_shared.section,
                "rule_key": resolved.rules.enable_zen_shared.key,
                "machines": planned,
            }),
        );
        return Ok(());
    }

    cred.preflight(&db)?;

    let total = targets.len() as i64;
    ctx.emitter
        .emit_event(&Event::Started {
            task_type: "zen_disable_global".into(),
            task_id: None,
            metadata: serde_json::json!({ "machines": total }),
        })
        .ok();

    let mut results: Vec<serde_json::Value> = Vec::with_capacity(targets.len());
    let mut fail_count = 0i64;

    for (machine, ini_path) in &targets {
        let machine_id = machine.id.expect("machine in inventory always has id");
        let host = machine.ip.as_str();
        match zen_enable::disable_global(host, ini_path, &resolved) {
            Ok(out) => {
                results.push(serde_json::json!({
                    "machine_id": machine_id,
                    "hostname": machine.hostname,
                    "ok": true,
                    "changed": out.changed,
                    "ini_file": ini_path,
                    "warnings": out.warnings,
                }));
            }
            Err(e) => {
                fail_count += 1;
                results.push(serde_json::json!({
                    "machine_id": machine_id,
                    "hostname": machine.hostname,
                    "ok": false,
                    "error": e.to_string(),
                }));
            }
        }
    }

    let all_ok = fail_count == 0;
    ctx.emitter
        .emit_result(&serde_json::json!({ "ok": all_ok, "results": results }))
        .ok();

    if all_ok {
        Ok(())
    } else {
        Err(UecmError::OperationFailed(format!(
            "zen.disable_global: {}/{} machine(s) failed",
            fail_count, total
        )))
    }
}

#[allow(clippy::too_many_arguments)]
fn project_enable(
    ctx: &mut Ctx<'_>,
    project_id: i64,
    machine_ids: &[i64],
    upstream_endpoint_id: i64,
    namespace: &str,
    yes: bool,
    dry_run: bool,
    cred: &CredentialArgs,
) -> UecmResult<()> {
    let outcome_gate = destructive::check(yes, dry_run, "zen.enable")?;
    if machine_ids.is_empty() {
        return Err(UecmError::InvalidInput(
            "--machines must list at least one machine id".into(),
        ));
    }
    let db = ctx.require_db()?.clone();
    cred.preflight(&db)?;

    // Resolve project + UE version up front so a bad project id / missing
    // version fails before any per-machine I/O.
    let project = projects::get(&db, project_id)?
        .ok_or_else(|| UecmError::InvalidInput(format!("project id={} not found", project_id)))?;
    let ue_version = project_ue_version_string(&project)?;

    // Load + resolve rules (frozen — we never modify rules_loader from here).
    let rules_raw = zen_rules::load_default()?;
    let resolved = zen_rules::resolve(&rules_raw, &ue_version)?;
    let master = resolve_cluster_master(&db, upstream_endpoint_id, namespace)?;

    // Pre-collect machine → location pairs so a missing project_location for
    // any target fails up-front (rather than after K-1 machines have been
    // mutated).
    let mut targets: Vec<(Machine, String)> = Vec::with_capacity(machine_ids.len());
    for mid in machine_ids {
        let m = machines::find_by_id(&db, *mid)?
            .ok_or_else(|| UecmError::InvalidInput(format!("machine id={} not found", mid)))?;
        let loc = project_locations::get_for_project_machine(&db, project_id, *mid)?
            .ok_or_else(|| {
                UecmError::InvalidInput(format!(
                    "no project_location for project_id={} machine_id={}; bind the project to \
                     this machine first via `uecm-cli project set-location`",
                    project_id, mid
                ))
            })?;
        let ini = project_ini_path(&loc.abs_path);
        targets.push((m, ini));
    }

    // Dry-run path: emit a high-level plan and stop. Per task spec, we don't
    // touch per-machine INI files — operators who need a fine-grained diff
    // can run a real apply + revert. Keeps dry-run fully offline so it works
    // on macOS, matches what other Plan 7 destructive commands do.
    if outcome_gate == Outcome::DryRun {
        let env_cleanup_vars: Vec<serde_json::Value> = resolved
            .rules
            .disable_legacy_smb_shared
            .env_cleanup
            .iter()
            .map(|e| serde_json::json!({ "var": e.var, "scopes": e.scopes }))
            .collect();
        let planned_targets: Vec<serde_json::Value> = targets
            .iter()
            .map(|(m, ini)| {
                serde_json::json!({
                    "machine_id": m.id,
                    "host": m.ip,
                    "hostname": m.hostname,
                    "ini_file": ini,
                })
            })
            .collect();
        destructive::emit_plan(
            ctx.emitter.as_mut(),
            "zen.enable",
            serde_json::json!({
                "project_id": project_id,
                "ue_version": ue_version,
                "matched_rule_version": resolved.matched_version,
                "namespace": namespace,
                "upstream_endpoint_id": upstream_endpoint_id,
                "master_host": master.host,
                "master_port": master.port,
                "rule_section": resolved.rules.enable_zen_shared.section,
                "rule_key": resolved.rules.enable_zen_shared.key,
                "env_cleanup_plan": env_cleanup_vars,
                "machines": planned_targets,
                "rule_warnings": resolved.warnings,
            }),
        );
        return Ok(());
    }

    // SSH key auth: zen enable drives the node-pure ini sidecars over SSH, so no
    // operator credential is needed. preflight validates --cred-alias existence /
    // flag combo without reading DPAPI or stdin for a credential we'd discard.
    cred.preflight(&db)?;

    let total = targets.len() as i64;
    ctx.emitter
        .emit_event(&Event::Started {
            task_type: "zen_enable".into(),
            task_id: None,
            metadata: serde_json::json!({
                "project_id": project_id,
                "machines": total,
                "matched_rule_version": resolved.matched_version,
            }),
        })
        .ok();

    let op_id = operations::start(&db, "zen.enable", machine_ids)?;
    let invocation = redact(&format!(
        "zen.enable project_id={project_id} machines={machine_ids:?} \
         upstream_endpoint_id={upstream_endpoint_id} namespace={namespace}"
    ));

    let mut results: Vec<ProjectMachineResult> = Vec::with_capacity(targets.len());
    let mut ok_count = 0i64;
    let mut fail_count = 0i64;
    let mut any_changed = false;

    for (idx, (machine, ini_path)) in targets.iter().enumerate() {
        let machine_id = machine.id.expect("machine in inventory always has id");
        let host = machine.ip.as_str();
        let leg = zen_enable::enable_project(host, ini_path, &resolved, &master);
        match leg {
            Ok(out) => {
                if out.changed {
                    any_changed = true;
                }
                // Env-cleanup leg — Codex P2: drive from
                // `env_cleanup_planned` regardless of `changed`. The PS
                // sidecar is idempotent (`was_present=false → cleared=false`
                // for absent vars), and gating on `changed` means an
                // operator who fixes their cred / admin context after a
                // partial failure can never retry: a second `zen enable`
                // would return `changed=false` and silently skip the
                // cleanup that failed the first time, leaving the legacy
                // env var active forever.
                let mut env_results: Vec<EnvCleanupResultView> = Vec::new();
                let mut env_failed = false;
                if !out.env_cleanup_planned.is_empty() {
                    for req in &out.env_cleanup_planned {
                        // The rule may list multiple scopes per var; the PS
                        // script only handles one string list per call. We
                        // fan out one call per scope so a per-scope failure
                        // (e.g. non-admin session) is captured precisely.
                        for scope in &req.scopes {
                            match invoke_env_cleanup(host, &req.var, scope, None) {
                                Ok(remote) => {
                                    env_results.push(EnvCleanupResultView {
                                        var: req.var.clone(),
                                        scope: scope.clone(),
                                        ok: true,
                                        remote: Some(remote),
                                        error: None,
                                    });
                                }
                                Err(e) => {
                                    env_failed = true;
                                    env_results.push(EnvCleanupResultView {
                                        var: req.var.clone(),
                                        scope: scope.clone(),
                                        ok: false,
                                        remote: None,
                                        error: Some(e.to_string()),
                                    });
                                }
                            }
                        }
                    }
                }
                let machine_ok = !env_failed;
                if machine_ok {
                    ok_count += 1;
                } else {
                    fail_count += 1;
                }
                let result = ProjectMachineResult {
                    machine_id,
                    host: host.to_string(),
                    changed: out.changed,
                    ini_file: Some(out.ini_file.clone()),
                    keys_set: out.keys_set.iter().map(KeyApplyView::from).collect(),
                    keys_removed: out.keys_removed.iter().map(KeyApplyView::from).collect(),
                    backups: out.backups.clone(),
                    env_cleanup_results: env_results,
                    warnings: out.warnings.clone(),
                    error: if env_failed {
                        Some("one or more env cleanup scopes failed; see env_cleanup_results".into())
                    } else {
                        None
                    },
                };
                ctx.emitter
                    .emit_event(&Event::ItemCompleted {
                        item_id: format!("machine:{machine_id}"),
                        index: idx as i64,
                        ok: machine_ok,
                        message: result.error.clone(),
                    })
                    .ok();
                results.push(result);
            }
            Err(e) => {
                fail_count += 1;
                let result = ProjectMachineResult {
                    machine_id,
                    host: host.to_string(),
                    changed: false,
                    ini_file: Some(ini_path.clone()),
                    keys_set: Vec::new(),
                    keys_removed: Vec::new(),
                    backups: Vec::new(),
                    env_cleanup_results: Vec::new(),
                    warnings: Vec::new(),
                    error: Some(redact(&e.to_string())),
                };
                ctx.emitter
                    .emit_event(&Event::ItemCompleted {
                        item_id: format!("machine:{machine_id}"),
                        index: idx as i64,
                        ok: false,
                        message: result.error.clone(),
                    })
                    .ok();
                results.push(result);
            }
        }
    }

    let doc = serde_json::json!({
        "ok": fail_count == 0,
        "project_id": project_id,
        "matched_rule_version": resolved.matched_version,
        "namespace": namespace,
        "upstream_endpoint_id": upstream_endpoint_id,
        "master_host": master.host,
        "master_port": master.port,
        "machines": total,
        "ok_count": ok_count,
        "fail_count": fail_count,
        "any_changed": any_changed,
        "results": results,
    });
    ctx.emitter.emit_result(&doc).ok();
    // Codex P2: streaming consumers wait for a terminal Completed event
    // before they consider the run done. emit_result alone leaves
    // `--json zen enable --yes` without that marker; emit Completed
    // explicitly so the event stream matches other batch handlers.
    ctx.emitter
        .emit_event(&Event::Completed { summary: doc.clone() })
        .ok();

    let op_status = if fail_count == 0 { "ok" } else { "err" };
    let _ = operations::finish(&db, op_id, op_status, Some(&invocation));

    if fail_count == 0 {
        Ok(())
    } else if ok_count == 0 {
        Err(UecmError::OperationFailed(format!(
            "zen.enable: all {} machine(s) failed",
            total
        )))
    } else {
        Err(UecmError::OperationFailed(format!(
            "zen.enable: {}/{} machine(s) failed",
            fail_count, total
        )))
    }
}

fn project_disable(
    ctx: &mut Ctx<'_>,
    project_id: i64,
    machine_ids: &[i64],
    yes: bool,
    dry_run: bool,
    cred: &CredentialArgs,
) -> UecmResult<()> {
    let outcome_gate = destructive::check(yes, dry_run, "zen.disable")?;
    if machine_ids.is_empty() {
        return Err(UecmError::InvalidInput(
            "--machines must list at least one machine id".into(),
        ));
    }
    let db = ctx.require_db()?.clone();
    cred.preflight(&db)?;

    let project = projects::get(&db, project_id)?
        .ok_or_else(|| UecmError::InvalidInput(format!("project id={} not found", project_id)))?;
    let ue_version = project_ue_version_string(&project)?;
    let rules_raw = zen_rules::load_default()?;
    let resolved = zen_rules::resolve(&rules_raw, &ue_version)?;

    let mut targets: Vec<(Machine, String)> = Vec::with_capacity(machine_ids.len());
    for mid in machine_ids {
        let m = machines::find_by_id(&db, *mid)?
            .ok_or_else(|| UecmError::InvalidInput(format!("machine id={} not found", mid)))?;
        let loc = project_locations::get_for_project_machine(&db, project_id, *mid)?
            .ok_or_else(|| {
                UecmError::InvalidInput(format!(
                    "no project_location for project_id={} machine_id={}; bind the project to \
                     this machine first via `uecm-cli project set-location`",
                    project_id, mid
                ))
            })?;
        targets.push((m, project_ini_path(&loc.abs_path)));
    }

    if outcome_gate == Outcome::DryRun {
        let planned_targets: Vec<serde_json::Value> = targets
            .iter()
            .map(|(m, ini)| {
                serde_json::json!({
                    "machine_id": m.id,
                    "host": m.ip,
                    "hostname": m.hostname,
                    "ini_file": ini,
                })
            })
            .collect();
        destructive::emit_plan(
            ctx.emitter.as_mut(),
            "zen.disable",
            serde_json::json!({
                "project_id": project_id,
                "ue_version": ue_version,
                "matched_rule_version": resolved.matched_version,
                "rule_section": resolved.rules.enable_zen_shared.section,
                "rule_key": resolved.rules.enable_zen_shared.key,
                "machines": planned_targets,
                "note": "narrow disable: legacy Pak / CompressedPak / Shared keys are NOT auto-restored, \
                        and machine env vars are NOT touched",
            }),
        );
        return Ok(());
    }

    // SSH key auth: zen disable needs no operator credential (see zen enable).
    cred.preflight(&db)?;

    let total = targets.len() as i64;
    ctx.emitter
        .emit_event(&Event::Started {
            task_type: "zen_disable".into(),
            task_id: None,
            metadata: serde_json::json!({
                "project_id": project_id,
                "machines": total,
                "matched_rule_version": resolved.matched_version,
            }),
        })
        .ok();

    let op_id = operations::start(&db, "zen.disable", machine_ids)?;
    let invocation = redact(&format!(
        "zen.disable project_id={project_id} machines={machine_ids:?}"
    ));

    let mut results: Vec<ProjectMachineResult> = Vec::with_capacity(targets.len());
    let mut ok_count = 0i64;
    let mut fail_count = 0i64;
    let mut any_changed = false;

    for (idx, (machine, ini_path)) in targets.iter().enumerate() {
        let machine_id = machine.id.expect("machine in inventory always has id");
        let host = machine.ip.as_str();
        match zen_enable::disable_project(host, ini_path, &resolved) {
            Ok(out) => {
                if out.changed {
                    any_changed = true;
                }
                ok_count += 1;
                let result = ProjectMachineResult {
                    machine_id,
                    host: host.to_string(),
                    changed: out.changed,
                    ini_file: Some(out.ini_file.clone()),
                    keys_set: Vec::new(),
                    keys_removed: out.keys_removed.iter().map(KeyApplyView::from).collect(),
                    backups: out.backups.clone(),
                    env_cleanup_results: Vec::new(),
                    warnings: out.warnings.clone(),
                    error: None,
                };
                ctx.emitter
                    .emit_event(&Event::ItemCompleted {
                        item_id: format!("machine:{machine_id}"),
                        index: idx as i64,
                        ok: true,
                        message: None,
                    })
                    .ok();
                results.push(result);
            }
            Err(e) => {
                fail_count += 1;
                let result = ProjectMachineResult {
                    machine_id,
                    host: host.to_string(),
                    changed: false,
                    ini_file: Some(ini_path.clone()),
                    keys_set: Vec::new(),
                    keys_removed: Vec::new(),
                    backups: Vec::new(),
                    env_cleanup_results: Vec::new(),
                    warnings: Vec::new(),
                    error: Some(redact(&e.to_string())),
                };
                ctx.emitter
                    .emit_event(&Event::ItemCompleted {
                        item_id: format!("machine:{machine_id}"),
                        index: idx as i64,
                        ok: false,
                        message: result.error.clone(),
                    })
                    .ok();
                results.push(result);
            }
        }
    }

    let doc = serde_json::json!({
        "ok": fail_count == 0,
        "project_id": project_id,
        "matched_rule_version": resolved.matched_version,
        "machines": total,
        "ok_count": ok_count,
        "fail_count": fail_count,
        "any_changed": any_changed,
        "results": results,
    });
    ctx.emitter.emit_result(&doc).ok();
    // Codex P2 (mirror of project_enable): streaming consumers expect a
    // terminal Completed event after the per-machine ItemCompleted
    // stream. emit_result alone is fine for one-shot JSON but the
    // streamed-event pipeline needs the marker.
    ctx.emitter
        .emit_event(&Event::Completed { summary: doc.clone() })
        .ok();

    let op_status = if fail_count == 0 { "ok" } else { "err" };
    let _ = operations::finish(&db, op_id, op_status, Some(&invocation));

    if fail_count == 0 {
        Ok(())
    } else if ok_count == 0 {
        Err(UecmError::OperationFailed(format!(
            "zen.disable: all {} machine(s) failed",
            total
        )))
    } else {
        Err(UecmError::OperationFailed(format!(
            "zen.disable: {}/{} machine(s) failed",
            fail_count, total
        )))
    }
}

// -----------------------------------------------------------------------------
// verify-rules (T4.5) — resolve-only mode
// -----------------------------------------------------------------------------
//
// T4.4 (drive a headless UE editor + watch its log) and T4.6 (PS sidecar) are
// deferred — `verify-rules` ships the offline half: parse the yaml, resolve
// the effective rule set for the supplied UE version, render the plan as
// JSON, and (optionally) append the verified version back to the yaml.
//
// Output shape on success:
//   { ok: true, ue_version, matched_rule_version, ue_install, policy,
//     warnings: [...], rules: {...}, verified_versions_after: [...],
//     wrote: bool, yaml_path?: string }
//
// On resolve failure (e.g. unverified + policy=refuse), we still emit a
// single JSON document with `ok: false` and exit 0 — the JSON `ok` flag is
// the source of truth, per the CLI convention (matches `lua-preview` style).

/// Extract `major.minor` from a UE version string. Returns `None` on
/// non-numeric / missing components — the spec requires the rules loader's
/// resolver to do the real validation, so we only need a tolerant pre-check
/// for the failure-path message and the verified_versions write key.
fn major_minor_of(ue_version: &str) -> Option<String> {
    let trimmed = ue_version.trim();
    let mut parts = trimmed.split('.');
    let major = parts.next()?.trim();
    let minor = parts.next()?.trim();
    if major.is_empty() || minor.is_empty() {
        return None;
    }
    if major.parse::<u32>().is_err() || minor.parse::<u32>().is_err() {
        return None;
    }
    Some(format!("{}.{}", major, minor))
}

/// Resolve the yaml path the CLI is allowed to write back to. Mirrors the
/// `load_default()` discovery order (env override → on-disk candidates),
/// returning `None` when only the embedded build-time snapshot would be
/// available — we refuse to "write" to that since it's compiled in.
fn writable_rules_path() -> Option<std::path::PathBuf> {
    if let Ok(over) = std::env::var("UECM_ZEN_RULES_PATH") {
        let p = std::path::PathBuf::from(over);
        // Env override always wins. If the operator typoed the path,
        // load_default() already errored out before we got here.
        return Some(p);
    }
    let p = zen_rules::default_path();
    if p.is_file() {
        Some(p)
    } else {
        None
    }
}

/// Append `version` (major.minor) to the `verified_versions` array in the
/// yaml at `path` if it isn't already present. Returns `Ok(true)` when the
/// file was rewritten, `Ok(false)` when the version was already verified.
///
/// Reads the yaml as a `serde_yaml::Value` and mutates only the
/// `verified_versions` array — this preserves the wire-format `zen_ini:`
/// wrapping (which the public `ZenRules` flat serialization would lose) and
/// keeps unrelated fields intact. Comments are lost (serde_yaml limitation).
fn append_verified_version(path: &std::path::Path, version: &str) -> UecmResult<bool> {
    let text = std::fs::read_to_string(path).map_err(|e| {
        UecmError::Configuration(format!(
            "verify-rules: failed to read yaml at {} for write: {}",
            path.display(),
            e
        ))
    })?;
    let mut doc: serde_yaml::Value = serde_yaml::from_str(&text).map_err(|e| {
        UecmError::Configuration(format!(
            "verify-rules: yaml at {} did not parse as a generic document: {}",
            path.display(),
            e
        ))
    })?;
    // verified_versions must be a top-level sequence per the schema.
    let Some(map) = doc.as_mapping_mut() else {
        return Err(UecmError::Configuration(format!(
            "verify-rules: yaml at {} is not a mapping at the top level",
            path.display()
        )));
    };
    let key = serde_yaml::Value::String("verified_versions".to_string());
    let entry = map.entry(key).or_insert(serde_yaml::Value::Sequence(Vec::new()));
    let Some(seq) = entry.as_sequence_mut() else {
        return Err(UecmError::Configuration(format!(
            "verify-rules: yaml at {} has `verified_versions` but it isn't a sequence",
            path.display()
        )));
    };
    // Idempotent: skip if already present (string compare on major.minor).
    let already = seq.iter().any(|v| v.as_str().map(|s| s == version).unwrap_or(false));
    if already {
        return Ok(false);
    }
    seq.push(serde_yaml::Value::String(version.to_string()));

    let new_text = serde_yaml::to_string(&doc).map_err(|e| {
        UecmError::Configuration(format!(
            "verify-rules: failed to re-serialize yaml: {}",
            e
        ))
    })?;
    std::fs::write(path, new_text).map_err(|e| {
        UecmError::Configuration(format!(
            "verify-rules: failed to write yaml at {}: {}",
            path.display(),
            e
        ))
    })?;
    Ok(true)
}

#[allow(clippy::too_many_arguments)]
fn verify_rules(
    ctx: &mut Ctx<'_>,
    ue_version: &str,
    ue_install: &str,
    write_verified: bool,
    run_editor: bool,
    machine: Option<i64>,
    uproject_path: Option<&str>,
    timeout_seconds: Option<u64>,
    expected_host: Option<&str>,
    expected_port: Option<i64>,
    expected_namespace: Option<&str>,
    cred: &CredentialArgs,
) -> UecmResult<()> {
    // Codex P2: verifier-only flags without --run-editor are a script bug
    // we must surface, not silently drop. The resolve-only branch never
    // consults these fields, so accepting them would let CI/operators
    // believe the headless editor verifier had run when it had not.
    if !run_editor {
        let cred_set = cred.cred_alias.is_some()
            || cred.user.is_some()
            || cred.pass.is_some()
            || cred.pass_stdin;
        if machine.is_some()
            || uproject_path.is_some()
            || timeout_seconds.is_some()
            || expected_host.is_some()
            || expected_port.is_some()
            || expected_namespace.is_some()
            || cred_set
        {
            return Err(UecmError::InvalidInput(
                "--machine / --uproject-path / --timeout-seconds / --expected-* / \
                 credential flags require --run-editor; without it the resolve-only \
                 path ignores them and would falsely report a successful verifier run"
                    .into(),
            ));
        }
    }
    let timeout_seconds = timeout_seconds.unwrap_or(300);

    let rules = zen_rules::load_default()?;
    let policy_str = match rules.unverified_policy {
        zen_rules::UnverifiedPolicy::Refuse => "refuse",
        zen_rules::UnverifiedPolicy::Warn => "warn",
    };

    match zen_rules::resolve(&rules, ue_version) {
        Ok(resolved) => {
            // T4.4: when `--run-editor` is set we run the headless verifier
            // FIRST, so a failing verifier blocks the `--write-verified` leg
            // from promoting an unverified version. Codex P2 fix: previously
            // we wrote verified_versions first then ran the editor — a
            // verifier timeout / host mismatch / WinRM error would still
            // leave the yaml marked as verified, and subsequent `zen enable`
            // would bypass `unverified_policy=refuse`.
            let verify_outcome_json = if run_editor {
                Some(run_verify_editor(
                    ctx,
                    ue_install,
                    machine,
                    uproject_path,
                    timeout_seconds,
                    expected_host,
                    expected_port,
                    expected_namespace,
                    cred,
                )?)
            } else {
                None
            };
            let verifier_ok = match &verify_outcome_json {
                None => true,
                Some(v) => v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false),
            };

            // Successful resolve: render the plan + optionally append the
            // matched major.minor to verified_versions on disk. We skip the
            // write step when the verifier (if requested) reported failure.
            let mut wrote = false;
            let mut yaml_path_str: Option<String> = None;
            let mut verified_after: Vec<String> = rules.verified_versions.clone();

            if write_verified && verifier_ok {
                let already = verified_after.iter().any(|v| v == &resolved.matched_version);
                if !already {
                    let path = writable_rules_path().ok_or_else(|| {
                        UecmError::Configuration(
                            "verify-rules --write-verified: no on-disk yaml to write \
                             (only the embedded build-time snapshot is available; set \
                             UECM_ZEN_RULES_PATH or place zen-ini-rules.yaml next to the binary)"
                                .into(),
                        )
                    })?;
                    wrote = append_verified_version(&path, &resolved.matched_version)?;
                    if wrote {
                        verified_after.push(resolved.matched_version.clone());
                    }
                    yaml_path_str = Some(path.display().to_string());
                } else {
                    // Already verified — still report the yaml path for transparency.
                    if let Some(p) = writable_rules_path() {
                        yaml_path_str = Some(p.display().to_string());
                    }
                }
            }

            // Top-level `ok` ANDs the verifier's `ok` in when --run-editor
            // is set, so the caller can branch on a single flag.
            let combined_ok = verifier_ok;

            let doc = serde_json::json!({
                "ok": combined_ok,
                "ue_version": ue_version,
                "matched_rule_version": resolved.matched_version,
                "ue_install": ue_install,
                "policy": policy_str,
                "warnings": resolved.warnings,
                "rules": {
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
                },
                "verified_versions_after": verified_after,
                "wrote": wrote,
                "yaml_path": yaml_path_str,
                "verify_outcome": verify_outcome_json,
            });
            ctx.emitter.emit_result(&doc).ok();
            Ok(())
        }
        Err(UecmError::InvalidInput(msg)) => {
            // Resolve refused (e.g. version unverified under policy=refuse,
            // or below applies_to floor). Emit ok:false and exit 0 — the
            // JSON `ok` flag is the contract; exit code stays clean per the
            // T4.5 spec so automation can keep scripting around this without
            // wrapping each call in error trapping.
            //
            // We don't launch the editor when the resolve already refused —
            // the rules say this UE version isn't supported, so any verifier
            // outcome would be misleading.
            let mm = major_minor_of(ue_version).unwrap_or_else(|| ue_version.to_string());
            let doc = serde_json::json!({
                "ok": false,
                "ue_version": ue_version,
                "matched_rule_version": mm,
                "ue_install": ue_install,
                "policy": policy_str,
                "message": msg,
                "verified_versions_after": rules.verified_versions,
                "wrote": false,
                "verify_outcome": serde_json::Value::Null,
            });
            ctx.emitter.emit_result(&doc).ok();
            Ok(())
        }
        Err(other) => Err(other),
    }
}

/// T4.4: ship `zen-verify-rules.ps1` to the target machine via WinRM and
/// return the verifier's outcome as a serde_json `Value`. The CLI handler
/// embeds the result under `verify_outcome` in the top-level result doc, and
/// folds the inner `ok` into the outer `ok`.
///
/// Output shape (matches what UI / scripts consume from `verify_outcome`):
///
/// ```text
/// {
///   ok: bool,
///   matched: bool,
///   match_line?: string,
///   matched_host?: string, matched_port?: int, matched_namespace?: string,
///   elapsed_sec: int, editor_pid?: int, killed: bool,
///   log_tail: [string, ...],
///   message?: string,         // present when ok=false
///   exit_code?: int,          // present when editor crashed
///   machine_id: int, host: string,   // echoed back for joinability
/// }
/// ```
#[allow(clippy::too_many_arguments)]
fn run_verify_editor(
    ctx: &mut Ctx<'_>,
    ue_install: &str,
    machine: Option<i64>,
    uproject_path: Option<&str>,
    timeout_seconds: u64,
    expected_host: Option<&str>,
    expected_port: Option<i64>,
    expected_namespace: Option<&str>,
    cred: &CredentialArgs,
) -> UecmResult<serde_json::Value> {
    let machine_id = machine.ok_or_else(|| {
        UecmError::InvalidInput(
            "zen verify-rules --run-editor: --machine <id> is required".into(),
        )
    })?;
    let up = uproject_path.ok_or_else(|| {
        UecmError::InvalidInput(
            "zen verify-rules --run-editor: --uproject-path <PATH> is required".into(),
        )
    })?;
    if timeout_seconds == 0 {
        return Err(UecmError::InvalidInput(
            "zen verify-rules --run-editor: --timeout-seconds must be > 0".into(),
        ));
    }

    let db = ctx.require_db()?.clone();
    let m = machines::find_by_id(&db, machine_id)?.ok_or_else(|| {
        UecmError::InvalidInput(format!("machine id={} not found", machine_id))
    })?;
    cred.preflight(&db)?;

    let input = cache_core::core::zen::verify::VerifyInput {
        ue_root: ue_install.to_string(),
        uproject_path: up.to_string(),
        timeout_seconds,
        expected_host: expected_host.map(|s| s.to_string()),
        expected_port,
        expected_namespace: expected_namespace.map(|s| s.to_string()),
    };

    let invocation = redact(&format!(
        "zen-verify-rules.ps1 -UeRoot '{}' -UprojectPath '{}' -TimeoutSeconds {}",
        ue_install, up, timeout_seconds
    ));
    let op_id = operations::start(&db, "zen.verify_rules.run_editor", &[machine_id])?;

    let result = cache_core::core::zen::verify::verify_endpoint(&m.ip, None, &input);

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
                "machine_id": machine_id,
                "host": m.ip.clone(),
            });
            (Some(v), Ok::<serde_json::Value, UecmError>(serde_json::Value::Null))
        }
        Err(UecmError::PowerShell(msg)) => {
            // Codex P2: distinguish between
            //   (a) a sidecar that ran and returned `{ok:false,...}` →
            //       semantic failure; surface as JSON with ok=false and
            //       let the caller exit 0 (the run-editor outcome is
            //       legitimate data, not a transport failure).
            //   (b) a transport failure: WinRM unreachable, auth denied,
            //       PowerShell crashed before producing output → must
            //       propagate as `Err(PowerShell)` so `exit_code_for`
            //       returns 4 (powershell_failed) and automation can
            //       distinguish "verifier ran and disagreed" from
            //       "verifier never ran". Same contract as the other
            //       zen remote commands.
            //
            // parse_outcome_json embeds the sidecar envelope in the
            // error string as `... ; outcome: <json>` when it has one.
            // No such marker → no envelope → transport failure.
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
                        "machine_id": machine_id,
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
                        Err::<serde_json::Value, UecmError>(UecmError::PowerShell(msg)),
                    )
                }
                None => {
                    // Transport / protocol error — no envelope to surface.
                    // Log and re-raise as Err so the CLI exits with the
                    // powershell_failed code, mirroring zen probe /
                    // service-install / etc.
                    (None, Err(UecmError::PowerShell(msg)))
                }
            }
        }
        Err(other) => {
            // Non-PowerShell errors (Configuration, InvalidInput, etc.)
            // are also propagated — they aren't sidecar envelopes either.
            (None, Err(other))
        }
    };

    finalize_op(&db, op_id, &op_result_for_log, &invocation);

    if let Some(doc) = outcome_json {
        return Ok(doc);
    }
    // No envelope to surface — propagate the underlying error so the CLI
    // exit code reflects the transport failure (powershell_failed=4 etc.)
    // rather than 0.
    match op_result_for_log {
        Err(e) => Err(e),
        Ok(_) => Err(UecmError::OperationFailed(
            "verify_endpoint produced no envelope and no error".into(),
        )),
    }
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::output::{Emitter, NdjsonEmitter};
    use cache_core::data::{
        machines, open_in_memory, schema, zen_binary_expected, zen_endpoints, Machine,
        ZenBinaryExpected,
    };
    use std::path::PathBuf;

    fn fresh_ctx() -> Ctx<'static> {
        let db = open_in_memory().unwrap();
        {
            let mut conn = db.lock().unwrap();
            schema::migrate(&mut conn).unwrap();
        }
        let emitter: Box<dyn Emitter> = Box::new(NdjsonEmitter::new(Vec::new()));
        Ctx {
            db: Some(db),
            db_path: PathBuf::from(":memory:"),
            emitter,
            json_mode: true,
            operation_id: "zen.unmapped",
            request_id: "test-req".into(),
            no_input: false,
        }
    }

    fn seed_endpoint(db: &Db, machine_hostname: &str, ip: &str, port: i64) -> (i64, i64) {
        let machine_id = machines::insert(db, &Machine::new(machine_hostname, ip)).unwrap();
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

    #[test]
    fn status_on_empty_db_returns_empty_endpoints() {
        let mut ctx = fresh_ctx();
        status(&mut ctx, None, true).unwrap();
        // Successful no-op — handler emits a result document; not asserting
        // bytes since the test emitter sinks into a moved Vec.
    }

    #[test]
    fn status_with_seeded_endpoint_reports_no_probe_yet() {
        let mut ctx = fresh_ctx();
        let db = ctx.db.as_ref().unwrap().clone();
        seed_endpoint(&db, "ZEN-1", "10.0.0.10", 8558);
        status(&mut ctx, None, true).unwrap();

        // Direct DB read to verify the data shape the handler produced is
        // consistent with downstream consumers' expectations.
        let endpoints = zen_endpoints::list(&db).unwrap();
        assert_eq!(endpoints.len(), 1);
        let recent = zen_probes::list_recent(&db, endpoints[0].id.unwrap(), 1).unwrap();
        assert!(recent.is_empty(), "no probe rows expected on a fresh seed");
    }

    #[test]
    fn list_endpoints_empty_ok() {
        let mut ctx = fresh_ctx();
        list_endpoints(&mut ctx, None).unwrap();
    }

    #[test]
    fn list_endpoints_filtered_by_machine() {
        let mut ctx = fresh_ctx();
        let db = ctx.db.as_ref().unwrap().clone();
        let (m1, _) = seed_endpoint(&db, "ZEN-1", "10.0.0.10", 8558);
        let (_m2, _) = seed_endpoint(&db, "ZEN-2", "10.0.0.11", 8558);
        list_endpoints(&mut ctx, Some(m1)).unwrap();
        let just_m1 = zen_endpoints::list_for_machine(&db, m1).unwrap();
        assert_eq!(just_m1.len(), 1);
    }

    #[test]
    fn baseline_list_empty_ok() {
        let mut ctx = fresh_ctx();
        baseline_list(&mut ctx, None, None).unwrap();
    }

    #[test]
    fn baseline_list_filters_by_version_and_kind() {
        let mut ctx = fresh_ctx();
        let db = ctx.db.as_ref().unwrap().clone();
        seed_baseline(&db, "5.8.10-aaa", KIND_ZEN_CLI, "sha-cli-aaa");
        seed_baseline(&db, "5.8.10-aaa", KIND_ZENSERVER, "sha-srv-aaa");
        seed_baseline(&db, "5.7.6-bbb", KIND_ZEN_CLI, "sha-cli-bbb");
        // Filter handler runs against the live DB inside the call; we re-run
        // the filter logic locally to assert the resulting Vec shape.
        let all = zen_binary_expected::list(&db).unwrap();
        assert_eq!(all.len(), 3);
        let just_aaa: Vec<_> = all
            .iter()
            .filter(|r| r.zen_build_version == "5.8.10-aaa")
            .collect();
        assert_eq!(just_aaa.len(), 2);
        baseline_list(&mut ctx, Some("5.8.10-aaa"), Some(KIND_ZEN_CLI)).unwrap();
    }

    #[test]
    fn baseline_lock_requires_yes() {
        let mut ctx = fresh_ctx();
        let db = ctx.db.as_ref().unwrap().clone();
        seed_baseline(&db, "5.8.10-aaa", KIND_ZEN_CLI, "sha");
        let err = baseline_lock(&mut ctx, "5.8.10-aaa", KIND_ZEN_CLI, "op1", false, false)
            .unwrap_err();
        assert!(matches!(err, UecmError::InvalidInput(_)));
    }

    #[test]
    fn baseline_lock_dry_run_does_not_persist() {
        let mut ctx = fresh_ctx();
        let db = ctx.db.as_ref().unwrap().clone();
        seed_baseline(&db, "5.8.10-aaa", KIND_ZEN_CLI, "sha");
        baseline_lock(&mut ctx, "5.8.10-aaa", KIND_ZEN_CLI, "op1", false, true).unwrap();
        let row = zen_binary_expected::find(&db, "5.8.10-aaa", KIND_ZEN_CLI)
            .unwrap()
            .unwrap();
        assert!(row.locked_by.is_none(), "dry-run must not write");
    }

    #[test]
    fn baseline_lock_applies_with_yes() {
        let mut ctx = fresh_ctx();
        let db = ctx.db.as_ref().unwrap().clone();
        seed_baseline(&db, "5.8.10-aaa", KIND_ZEN_CLI, "sha");
        baseline_lock(&mut ctx, "5.8.10-aaa", KIND_ZEN_CLI, "op1", true, false).unwrap();
        let row = zen_binary_expected::find(&db, "5.8.10-aaa", KIND_ZEN_CLI)
            .unwrap()
            .unwrap();
        assert_eq!(row.locked_by.as_deref(), Some("op1"));
    }

    #[test]
    fn baseline_unlock_clears_marker() {
        let mut ctx = fresh_ctx();
        let db = ctx.db.as_ref().unwrap().clone();
        seed_baseline(&db, "5.8.10-aaa", KIND_ZEN_CLI, "sha");
        zen_binary_expected::lock(&db, "5.8.10-aaa", KIND_ZEN_CLI, "op1").unwrap();
        baseline_unlock(&mut ctx, "5.8.10-aaa", KIND_ZEN_CLI, true, false).unwrap();
        let row = zen_binary_expected::find(&db, "5.8.10-aaa", KIND_ZEN_CLI)
            .unwrap()
            .unwrap();
        assert!(row.locked_by.is_none());
    }

    #[test]
    fn baseline_lock_rejects_missing_row() {
        let mut ctx = fresh_ctx();
        let err = baseline_lock(&mut ctx, "nope-version", KIND_ZEN_CLI, "op1", true, false)
            .unwrap_err();
        match err {
            UecmError::InvalidInput(msg) => assert!(msg.contains("no baseline row")),
            other => panic!("expected InvalidInput, got {:?}", other),
        }
    }

    #[test]
    fn baseline_rejects_bad_kind() {
        let mut ctx = fresh_ctx();
        let err = baseline_list(&mut ctx, None, Some("bogus")).unwrap_err();
        match err {
            UecmError::InvalidInput(msg) => assert!(msg.contains("invalid binary kind")),
            other => panic!("expected InvalidInput, got {:?}", other),
        }
    }

    #[test]
    fn probe_with_unknown_machine_errors_out() {
        let mut ctx = fresh_ctx();
        let cred = CredentialArgs {
            cred_alias: None,
            user: None,
            pass: None,
            pass_stdin: false,        };
        let err = probe(&mut ctx, Some(9999), false, 2, &cred).unwrap_err();
        assert!(matches!(err, UecmError::InvalidInput(_)));
    }

    #[test]
    fn cache_stats_unknown_endpoint_errors() {
        let mut ctx = fresh_ctx();
        let err = cache_stats(&mut ctx, Some(9999), false, 2).unwrap_err();
        assert!(matches!(err, UecmError::InvalidInput(_)));
    }

    #[test]
    fn register_handler_persists_endpoint_with_defaults() {
        let mut ctx = fresh_ctx();
        let db = ctx.db.as_ref().unwrap().clone();
        let machine_id = machines::insert(&db, &Machine::new("ZEN-01", "10.0.0.10")).unwrap();
        register(
            &mut ctx,
            machine_id,
            8558,
            "http",
            "local",
            None,
            r"D:\ZenData",
            "asio",
            None, // no lifecycle override → default to editor_owned
        )
        .unwrap();
        let rows = zen_endpoints::list_for_machine(&db, machine_id).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].lifecycle_mode, "editor_owned");
        assert_eq!(rows[0].declared_port, 8558);
    }

    #[test]
    fn register_handler_rejects_unknown_machine() {
        let mut ctx = fresh_ctx();
        let err = register(
            &mut ctx,
            9999,
            8558,
            "http",
            "local",
            None,
            r"D:\ZenData",
            "asio",
            None,
        )
        .unwrap_err();
        assert!(matches!(err, UecmError::InvalidInput(_)));
    }

    #[test]
    fn register_handler_for_shared_upstream_defaults_to_installed_service() {
        let mut ctx = fresh_ctx();
        let db = ctx.db.as_ref().unwrap().clone();
        let machine_id = machines::insert(&db, &Machine::new("ZEN-01", "10.0.0.10")).unwrap();
        register(
            &mut ctx,
            machine_id,
            8559,
            "http",
            "shared_upstream",
            None,
            r"D:\ZenMaster",
            "asio",
            None, // shared_upstream → default to installed_service per T2.1
        )
        .unwrap();
        let rows = zen_endpoints::list_for_machine(&db, machine_id).unwrap();
        assert_eq!(rows[0].lifecycle_mode, "installed_service");
        assert_eq!(rows[0].role, "shared_upstream");
    }

    #[test]
    fn unregister_without_yes_or_dry_run_returns_invalid_input() {
        let mut ctx = fresh_ctx();
        let err = unregister(&mut ctx, 1, false, false).unwrap_err();
        assert!(matches!(err, UecmError::InvalidInput(_)));
    }

    #[test]
    fn unregister_unknown_endpoint_with_yes_returns_invalid_input() {
        let mut ctx = fresh_ctx();
        let err = unregister(&mut ctx, 9999, true, false).unwrap_err();
        assert!(matches!(err, UecmError::InvalidInput(_)));
    }

    #[test]
    fn validate_dest_path_accepts_normal_drive_absolute() {
        assert!(validate_dest_path(r"C:\Zen\zen.lua").is_ok());
        assert!(validate_dest_path("C:/Zen/zen.lua").is_ok());
        assert!(validate_dest_path(r"D:\App Data\Zen\zen.lua").is_ok());
    }

    #[test]
    fn validate_dest_path_accepts_unc() {
        assert!(validate_dest_path(r"\\host\share\zen.lua").is_ok());
    }

    #[test]
    fn validate_dest_path_rejects_empty() {
        assert!(matches!(
            validate_dest_path("   ").unwrap_err(),
            UecmError::InvalidInput(_)
        ));
    }

    #[test]
    fn validate_dest_path_rejects_relative_and_drive_relative() {
        // No drive letter at all.
        assert!(validate_dest_path(r"Zen\zen.lua").is_err());
        // Drive-relative `C:Zen\zen.lua` — has `:` but no separator after.
        assert!(validate_dest_path(r"C:Zen\zen.lua").is_err());
        // Root-relative `\Temp\zen.lua` — starts with `\` but not `\\`.
        assert!(validate_dest_path(r"\Temp\zen.lua").is_err());
    }

    #[test]
    fn validate_dest_path_rejects_device_namespace() {
        assert!(validate_dest_path(r"\\?\C:\Windows\zen.lua").is_err());
        assert!(validate_dest_path(r"\\.\C:\Windows\zen.lua").is_err());
        assert!(validate_dest_path(r"//?/C:/Windows/zen.lua").is_err());
    }

    #[test]
    fn validate_dest_path_rejects_system_locations() {
        for bad in [
            r"C:\Windows\zen.lua",
            r"c:\windows\system32\zen.lua",
            r"C:\Program Files\Zen\zen.lua",
            r"C:\Program Files (x86)\Zen\zen.lua",
            r"C:\Windows",
            r"C:\Windows\",
        ] {
            let err = validate_dest_path(bad).unwrap_err();
            assert!(
                matches!(err, UecmError::InvalidInput(_)),
                "should reject {bad}"
            );
        }
    }

    /// Codex P2 fix: `..` segments that resolve into a forbidden system
    /// location must be caught by the dry-run validator. Without
    /// `collapse_path_segments`, the path slipped through and the `--yes`
    /// apply path failed at the sidecar instead.
    #[test]
    fn validate_dest_path_rejects_traversal_into_system_locations() {
        for bad in [
            r"C:\Temp\..\Windows\zen.lua",
            r"C:\Temp\sub\..\..\Windows\zen.lua",
            r"C:\Tools\..\Program Files\Zen\zen.lua",
            r"C:/Temp/../Windows/zen.lua",
        ] {
            let err = validate_dest_path(bad).unwrap_err();
            assert!(
                matches!(err, UecmError::InvalidInput(_)),
                "should reject traversal: {bad}"
            );
        }
    }

    #[test]
    fn collapse_path_segments_handles_drive_absolute() {
        assert_eq!(
            collapse_path_segments(r"C:\Temp\..\Zen\zen.lua"),
            r"C:\Zen\zen.lua"
        );
        // `..` past the root just stays at the root.
        assert_eq!(
            collapse_path_segments(r"C:\..\Zen\zen.lua"),
            r"C:\Zen\zen.lua"
        );
        assert_eq!(
            collapse_path_segments(r"C:\Zen\.\sub\zen.lua"),
            r"C:\Zen\sub\zen.lua"
        );
    }

    #[test]
    fn collapse_path_segments_handles_unc() {
        assert_eq!(
            collapse_path_segments(r"\\host\share\Temp\..\Zen\zen.lua"),
            r"\\host\share\Zen\zen.lua"
        );
    }

    #[test]
    fn validate_data_dir_safe_accepts_normal_paths() {
        assert!(validate_data_dir_safe(r"D:\ZenData").is_ok());
        assert!(validate_data_dir_safe(r"E:\App Data\Zen").is_ok());
    }

    #[test]
    fn validate_data_dir_safe_rejects_system_roots_and_traversal() {
        for bad in [
            r"C:\Windows\Zen",
            r"C:\Program Files\Zen",
            r"C:\Temp\..\Windows\Zen",
            r"C:/Temp/../Windows/Zen",
        ] {
            assert!(
                matches!(
                    validate_data_dir_safe(bad).unwrap_err(),
                    UecmError::InvalidInput(_)
                ),
                "should reject {bad}"
            );
        }
    }

    // Codex round-20 P2: lua-preview / apply-config must reject the same
    // relative shapes the register-time guard now blocks. Without this,
    // a pre-existing DB row (registered before the new validator landed)
    // would silently flow into `server.datadir` and resolve against
    // process CWD.
    #[test]
    fn validate_data_dir_safe_rejects_relative_paths() {
        for bad in [
            "D:ZenCache",   // drive-relative
            r"\ZenCache",   // root-relative
            "ZenCache",     // bare relative
            r"sub\dir",
        ] {
            let err = validate_data_dir_safe(bad).unwrap_err();
            match err {
                UecmError::InvalidInput(msg) => assert!(
                    msg.contains("fully-qualified absolute path"),
                    "wrong error for {bad}: {msg}"
                ),
                other => panic!("expected InvalidInput for {bad}, got {other:?}"),
            }
        }
    }

    /// Codex P2: dest paths that are only a drive root or only `\\host\share`
    /// don't have a file component — `zen-write-lua-config.ps1` would either
    /// fail in `GetDirectoryName` or write to a directory root. Reject up
    /// front so dry-run doesn't approve a doomed plan.
    #[test]
    fn validate_dest_path_rejects_root_only_paths() {
        for bad in [
            r"D:\",
            "D:/",
            r"\\host",
            r"\\host\share",
            r"//host/share",
        ] {
            assert!(
                matches!(
                    validate_dest_path(bad).unwrap_err(),
                    UecmError::InvalidInput(_)
                ),
                "should reject root-only path {bad}"
            );
        }
    }

    /// Codex P2: dest paths that look like directories (trailing separator
    /// or final `.` / `..` segment) are not valid file targets for the
    /// remote sidecar's `File.WriteAllText`. Reject in the validator so
    /// `--dry-run` matches the real apply path.
    #[test]
    fn validate_dest_path_rejects_directory_like_endings() {
        for bad in [
            r"C:\Tools\UECM\",
            r"C:/Tools/UECM/",
            r"C:\Tools\UECM\.",
            r"C:\Tools\UECM\..",
            r"\\host\share\Zen\sub\..",
        ] {
            assert!(
                matches!(
                    validate_dest_path(bad).unwrap_err(),
                    UecmError::InvalidInput(_)
                ),
                "should reject dir-like dest {bad}"
            );
        }
    }

    /// `zen service install` must refuse endpoints whose lifecycle_mode is
    /// not `installed_service` so DB and SCM stay in sync.
    #[test]
    fn service_install_handler_refuses_editor_owned_endpoint() {
        let mut ctx = fresh_ctx();
        let db = ctx.db.as_ref().unwrap().clone();
        let machine_id = machines::insert(&db, &Machine::new("ZEN-01", "10.0.0.10")).unwrap();
        let endpoint_id = cache_core::core::zen::endpoint::register(
            &db,
            &cache_core::core::zen::endpoint::EndpointInput {
                machine_id,
                declared_port: 8558,
                scheme: "http".into(),
                role: "local".into(),
                upstream_endpoint_id: None,
                data_dir: r"D:\ZenData".into(),
                httpserverclass: "asio".into(),
                lifecycle_mode: "editor_owned".into(),
            },
        )
        .unwrap()
        .id;
        // Seed a zen.exe path so the binary lookup doesn't short-circuit first.
        use cache_core::data::MachineZenInstall;
        cache_core::data::machine_zen_install::upsert(
            &db,
            &MachineZenInstall {
                machine_id,
                install_dir: Some(r"C:\Zen".into()),
                zen_cli_path: Some(r"C:\Zen\zen.exe".into()),
                zen_cli_build_version: None,
                zen_cli_sha256: None,
                zenserver_path: Some(r"C:\Zen\zenserver.exe".into()),
                zenserver_build_version: None,
                zenserver_sha256: None,
                last_detected_at: None,
            },
        )
        .unwrap();

        let cred = CredentialArgs {
            cred_alias: None,
            user: None,
            pass: None,
            pass_stdin: false,        };
        // --dry-run with editor_owned must still error out (DB state matters,
        // not the dry-run flag).
        let err = service_install(&mut ctx, endpoint_id, None, None, false, false, true, &cred).unwrap_err();
        match err {
            UecmError::InvalidInput(msg) => {
                assert!(msg.contains("lifecycle"), "msg={msg}");
            }
            other => panic!("expected InvalidInput, got {:?}", other),
        }
    }

    // ZEN-3: `zen service install` should advise against co-locating the shared
    // ZenServer service on a machine that looks like a UE workstation
    // (`ue_runtime_user` set), but only as an advisory — never a hard error.
    #[test]
    fn workstation_warning_only_fires_when_ue_runtime_user_set() {
        let ctx = fresh_ctx();
        let db = ctx.db.as_ref().unwrap().clone();
        let (machine_id, _ep) = seed_endpoint(&db, "WS-1", "10.0.0.20", 8558);

        // Dedicated server (no ue_runtime_user) → no warning.
        assert!(
            workstation_colocation_warning(&db, machine_id).unwrap().is_none(),
            "a machine without ue_runtime_user is a dedicated server — no warning"
        );

        // Workstation (ue_runtime_user set) → advisory warning naming the user.
        machines::set_ue_runtime_user(&db, machine_id, Some("lanbp")).unwrap();
        let w = workstation_colocation_warning(&db, machine_id)
            .unwrap()
            .expect("workstation must produce a warning");
        assert!(w.contains("workstation"), "warning should call it a workstation: {w}");
        assert!(w.contains("lanbp"), "warning should name the ue_runtime_user: {w}");
        assert!(
            w.contains("not recommended"),
            "warning should be advisory wording: {w}"
        );
    }

    // ZEN-4: region-host normalization. Operators may pass a bare host, host:port,
    // or a full URI; the env var must always hold a canonical scheme://host:port.
    #[test]
    fn normalize_region_host_canonicalizes_accepted_forms() {
        assert_eq!(
            normalize_region_host("render-master").unwrap(),
            "http://render-master:8558"
        );
        assert_eq!(normalize_region_host("10.0.0.5:9000").unwrap(), "http://10.0.0.5:9000");
        assert_eq!(normalize_region_host("http://h:8558").unwrap(), "http://h:8558");
        assert_eq!(normalize_region_host("https://h:443").unwrap(), "https://h:443");
        // Trailing path/query is dropped — only the authority matters.
        assert_eq!(normalize_region_host("http://h:8558/api/v1").unwrap(), "http://h:8558");
        // Bracketed IPv6 literal, with and without an explicit port.
        assert_eq!(normalize_region_host("http://[::1]:8558").unwrap(), "http://[::1]:8558");
        assert_eq!(normalize_region_host("[::1]").unwrap(), "http://[::1]:8558");
    }

    #[test]
    fn normalize_region_host_rejects_bad_input() {
        assert!(normalize_region_host("   ").is_err(), "empty");
        assert!(normalize_region_host("ftp://h:21").is_err(), "bad scheme");
        assert!(normalize_region_host("h:notaport").is_err(), "non-numeric port");
        assert!(normalize_region_host("h:99999").is_err(), "port out of u16 range");
        assert!(normalize_region_host("ho st").is_err(), "whitespace in host");
        assert!(normalize_region_host("h\";evil").is_err(), "shell-hostile chars");
        // Bare (unbracketed) IPv6 must be rejected, not silently mis-parsed into
        // a malformed "http://::1" (host=":"). Operators must bracket IPv6.
        assert!(normalize_region_host("::1").is_err(), "bare unbracketed IPv6");
        assert!(normalize_region_host("fe80::1").is_err(), "bare unbracketed IPv6 (link-local)");
        assert!(
            normalize_region_host("http://2001:db8::1:8558").is_err(),
            "unbracketed IPv6 with port"
        );
    }

    fn no_cred() -> CredentialArgs {
        CredentialArgs { cred_alias: None, user: None, pass: None, pass_stdin: false }
    }

    // DESIGN-3: clean_env input-validation + dry-run gating (no SSH touched).
    #[test]
    fn clean_env_validates_inputs_and_dry_runs() {
        let mut ctx = fresh_ctx();
        let db = ctx.db.as_ref().unwrap().clone();
        let (machine_id, _ep) = seed_endpoint(&db, "WS-1", "10.0.0.20", 8558);
        let cred = no_cred();
        let var = "UE-SharedDataCachePath";

        // empty --machines → InvalidInput
        assert!(matches!(
            clean_env(&mut ctx, &[], var, &["machine".into()], false, true, &cred),
            Err(UecmError::InvalidInput(_))
        ));
        // invalid scope → InvalidInput
        assert!(matches!(
            clean_env(&mut ctx, &[machine_id], var, &["bogus".into()], false, true, &cred),
            Err(UecmError::InvalidInput(_))
        ));
        // neither --yes nor --dry-run → destructive guard
        assert!(matches!(
            clean_env(&mut ctx, &[machine_id], var, &["machine".into()], false, false, &cred),
            Err(UecmError::InvalidInput(_))
        ));
        // unknown machine id → InvalidInput (resolved before any side effect)
        assert!(matches!(
            clean_env(&mut ctx, &[99999], var, &["machine".into()], false, true, &cred),
            Err(UecmError::InvalidInput(_))
        ));
        // valid dry-run → Ok (emits a plan, performs no SSH/env mutation)
        assert!(clean_env(
            &mut ctx,
            &[machine_id],
            var,
            &["machine".into(), "user".into()],
            false,
            true,
            &cred
        )
        .is_ok());
    }

    // ZEN-4: set_region_host input-validation + dry-run gating (no SSH touched).
    #[test]
    fn set_region_host_validates_and_dry_runs() {
        let mut ctx = fresh_ctx();
        let db = ctx.db.as_ref().unwrap().clone();
        let (machine_id, _ep) = seed_endpoint(&db, "WS-2", "10.0.0.21", 8558);
        let cred = no_cred();

        // empty --machines → InvalidInput
        assert!(matches!(
            set_region_host(&mut ctx, &[], "http://h:8558", false, true, &cred),
            Err(UecmError::InvalidInput(_))
        ));
        // bad host (rejected by normalize_region_host) → InvalidInput
        assert!(matches!(
            set_region_host(&mut ctx, &[machine_id], "ftp://h:21", false, true, &cred),
            Err(UecmError::InvalidInput(_))
        ));
        // unknown machine id → InvalidInput
        assert!(matches!(
            set_region_host(&mut ctx, &[99999], "render-master", false, true, &cred),
            Err(UecmError::InvalidInput(_))
        ));
        // valid dry-run (bare host normalized) → Ok
        assert!(set_region_host(&mut ctx, &[machine_id], "render-master", false, true, &cred).is_ok());
    }

    /// Codex P2: `..` segments that collapse back to a drive/UNC root are
    /// also invalid — they have no file component once normalized. Catch
    /// here so `--dry-run` matches the real sidecar's `GetDirectoryName`
    /// failure path.
    #[test]
    fn validate_dest_path_rejects_paths_that_collapse_to_root() {
        for bad in [
            r"D:\Zen\..",
            r"D:\Zen\sub\..\..\",
            r"\\host\share\Zen\..",
            r"\\host\share\..\share\..",
        ] {
            assert!(
                matches!(
                    validate_dest_path(bad).unwrap_err(),
                    UecmError::InvalidInput(_)
                ),
                "should reject path that collapses to root: {bad}"
            );
        }
    }

    /// `validate_service_data_dir` must reject drive-relative + root-relative
    /// paths that `zen.exe service install` refuses at runtime.
    #[test]
    fn validate_service_data_dir_rejects_relative_and_devicens() {
        for bad in [
            "",
            "   ",
            r"C:ZenCache",       // drive-relative — no separator after `:`
            r"\ZenCache",         // root-relative
            r"ZenCache",          // pure relative
            r"\\?\D:\ZenCache",   // device namespace
            r"C:\Windows\Zen",    // forbidden system root
        ] {
            assert!(
                matches!(
                    validate_service_data_dir(bad).unwrap_err(),
                    UecmError::InvalidInput(_)
                ),
                "should reject service data_dir {bad}"
            );
        }
    }

    #[test]
    fn validate_service_data_dir_accepts_normal_paths() {
        assert!(validate_service_data_dir(r"D:\ZenCache").is_ok());
        assert!(validate_service_data_dir(r"\\host\share\Zen").is_ok());
    }

    /// Codex P2: device-namespace prefix must be rejected so it can't slip
    /// past the system-root prefix check by keeping `\\?\` glued to `C:\`.
    #[test]
    fn validate_data_dir_safe_rejects_device_namespace() {
        for bad in [
            r"\\?\C:\Windows\Zen",
            r"\\.\C:\Windows\Zen",
            r"//?/C:/Windows/Zen",
            r"//./C:/Windows/Zen",
            // Even when targeted at a normally-safe location — UECM never
            // wants to drive the device namespace.
            r"\\?\D:\ZenData",
        ] {
            assert!(
                matches!(
                    validate_data_dir_safe(bad).unwrap_err(),
                    UecmError::InvalidInput(_)
                ),
                "should reject device-ns path {bad}"
            );
        }
    }

    #[test]
    fn sha256_hex_of_matches_known_vector() {
        // "abc" → ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
        assert_eq!(
            sha256_hex_of("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn verify_write_response_accepts_matching_sha_and_bytes() {
        let lua = "server = {}\n";
        let sha = sha256_hex_of(lua);
        let env = serde_json::json!({
            "ok": true,
            "path": r"C:\Zen\zen.lua",
            "bytes_written": lua.len() as i64,
            "sha256": sha,
        });
        verify_write_response(&env, &sha, lua.len()).unwrap();
    }

    #[test]
    fn verify_write_response_rejects_sha_mismatch() {
        let lua = "server = {}\n";
        let env = serde_json::json!({
            "ok": true,
            "path": r"C:\Zen\zen.lua",
            "bytes_written": lua.len() as i64,
            "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
        });
        let err = verify_write_response(&env, &sha256_hex_of(lua), lua.len()).unwrap_err();
        match err {
            UecmError::PowerShell(msg) => assert!(msg.contains("sha256")),
            other => panic!("expected PowerShell err, got {:?}", other),
        }
    }

    #[test]
    fn verify_write_response_rejects_byte_count_mismatch() {
        let lua = "server = {}\n";
        let env = serde_json::json!({
            "ok": true,
            "path": r"C:\Zen\zen.lua",
            "bytes_written": (lua.len() - 1) as i64,
            "sha256": sha256_hex_of(lua),
        });
        let err = verify_write_response(&env, &sha256_hex_of(lua), lua.len()).unwrap_err();
        match err {
            UecmError::PowerShell(msg) => assert!(msg.contains("bytes_written")),
            other => panic!("expected PowerShell err, got {:?}", other),
        }
    }

    #[test]
    fn verify_write_response_rejects_missing_sha_field() {
        let env = serde_json::json!({ "ok": true, "bytes_written": 12 });
        assert!(matches!(
            verify_write_response(&env, "deadbeef", 12).unwrap_err(),
            UecmError::PowerShell(_)
        ));
    }

    #[test]
    fn parse_envelope_requires_explicit_ok_true() {
        // Success path: exactly `ok: true` works.
        let ok = parse_envelope(r#"{"ok": true, "data": 1}"#, "test").unwrap();
        assert_eq!(ok["data"], 1);

        // Codex P2 fix: missing `ok` is rejected, not silently treated as ok.
        let err = parse_envelope(r#"{"error": "bad"}"#, "test").unwrap_err();
        assert!(matches!(err, UecmError::PowerShell(_)));

        // String "true" is not boolean true → rejected.
        let err = parse_envelope(r#"{"ok": "true"}"#, "test").unwrap_err();
        assert!(matches!(err, UecmError::PowerShell(_)));

        // Null `ok` → rejected.
        let err = parse_envelope(r#"{"ok": null}"#, "test").unwrap_err();
        assert!(matches!(err, UecmError::PowerShell(_)));

        // Explicit false → rejected with the embedded message.
        let err = parse_envelope(r#"{"ok": false, "message": "bad path"}"#, "test").unwrap_err();
        match err {
            UecmError::PowerShell(msg) => assert!(msg.contains("bad path")),
            other => panic!("expected PowerShell err with bad path, got {:?}", other),
        }

        // Non-JSON input → PowerShell error with raw snippet.
        let err = parse_envelope("not json", "test").unwrap_err();
        assert!(matches!(err, UecmError::PowerShell(_)));
    }

    /// Codex P2 fix: a dry-run for an endpoint that is still pointed-at by a
    /// dependent must refuse just like the real apply path. Otherwise the
    /// dry-run output advertises a plan that cannot actually be applied.
    #[test]
    fn unregister_dry_run_refuses_when_dependents_exist() {
        let mut ctx = fresh_ctx();
        let db = ctx.db.as_ref().unwrap().clone();
        let machine_id = machines::insert(&db, &Machine::new("ZEN-01", "10.0.0.10")).unwrap();
        // master + child pointing at master.
        let master = cache_core::core::zen::endpoint::register(
            &db,
            &cache_core::core::zen::endpoint::EndpointInput {
                machine_id,
                declared_port: 8559,
                scheme: "http".into(),
                role: "shared_upstream".into(),
                upstream_endpoint_id: None,
                data_dir: r"D:\ZenMaster".into(),
                httpserverclass: "asio".into(),
                lifecycle_mode: "installed_service".into(),
            },
        )
        .unwrap()
        .id;
        let _ = cache_core::core::zen::endpoint::register(
            &db,
            &cache_core::core::zen::endpoint::EndpointInput {
                machine_id,
                declared_port: 8558,
                scheme: "http".into(),
                role: "local".into(),
                upstream_endpoint_id: Some(master),
                data_dir: r"D:\ZenLocal".into(),
                httpserverclass: "asio".into(),
                lifecycle_mode: "editor_owned".into(),
            },
        )
        .unwrap();
        let err = unregister(&mut ctx, master, false, true).unwrap_err();
        assert!(matches!(err, UecmError::InvalidInput(_)));
        // Master row must still be present after the refused dry-run.
        assert!(cache_core::core::zen::endpoint::get(&db, master).unwrap().is_some());
    }

    #[test]
    fn lua_preview_renders_for_seeded_endpoint() {
        let mut ctx = fresh_ctx();
        let db = ctx.db.as_ref().unwrap().clone();
        let machine_id = machines::insert(&db, &Machine::new("ZEN-01", "10.0.0.10")).unwrap();
        let input = cache_core::core::zen::endpoint::EndpointInput {
            machine_id,
            declared_port: 8558,
            scheme: "http".into(),
            role: "local".into(),
            upstream_endpoint_id: None,
            data_dir: r"D:\ZenData".into(),
            httpserverclass: "asio".into(),
            lifecycle_mode: "editor_owned".into(),
        };
        let endpoint_id = cache_core::core::zen::endpoint::register(&db, &input).unwrap().id;
        lua_preview(&mut ctx, endpoint_id).unwrap();
        // Direct re-render to confirm the handler's resolution matches the
        // pure renderer (which has its own exhaustive tests).
        let ep = cache_core::core::zen::endpoint::get(&db, endpoint_id).unwrap().unwrap();
        let rendered = cache_core::core::zen::lua_config::render(&ep, None).unwrap();
        assert!(rendered.contains("datadir = \"D:\\\\ZenData\""));
    }

    /// Re-registering an existing endpoint with different params must keep
    /// the original row intact AND return persisted state (not the request
    /// payload). This guards the codex P2 regression — the JSON output was
    /// previously echoing the request, misleading automation into thinking
    /// the DB had changed.
    #[test]
    fn register_idempotent_conflict_does_not_lie_about_persisted_state() {
        let mut ctx = fresh_ctx();
        let db = ctx.db.as_ref().unwrap().clone();
        let machine_id = machines::insert(&db, &Machine::new("ZEN-01", "10.0.0.10")).unwrap();
        // First insert: lifecycle=editor_owned, data_dir=D:\ZenData.
        register(
            &mut ctx,
            machine_id,
            8558,
            "http",
            "local",
            None,
            r"D:\ZenData",
            "asio",
            None,
        )
        .unwrap();
        // Re-register with different data_dir + lifecycle. core::zen::endpoint
        // ignores these (idempotent on (machine, port)) — the persisted row
        // must keep its original values.
        register(
            &mut ctx,
            machine_id,
            8558,
            "http",
            "local",
            None,
            r"E:\OtherZen",
            "asio",
            Some("installed_service"),
        )
        .unwrap();
        let rows = zen_endpoints::list_for_machine(&db, machine_id).unwrap();
        assert_eq!(rows.len(), 1, "no duplicate row should be created");
        assert_eq!(rows[0].data_dir, r"D:\ZenData");
        assert_eq!(rows[0].lifecycle_mode, "editor_owned");
    }

    // ---------- T3.7: enable / disable helpers ----------

    #[test]
    fn project_ini_path_appends_config_default_engine_ini() {
        assert_eq!(
            project_ini_path(r"C:\Projects\Demo"),
            r"C:\Projects\Demo\Config\DefaultEngine.ini"
        );
    }

    #[test]
    fn project_ini_path_trims_trailing_separators() {
        assert_eq!(
            project_ini_path(r"C:\Projects\Demo\"),
            r"C:\Projects\Demo\Config\DefaultEngine.ini"
        );
        assert_eq!(
            project_ini_path("C:/Projects/Demo/"),
            r"C:/Projects/Demo\Config\DefaultEngine.ini"
        );
    }

    fn make_project_with_version(major: Option<i64>, minor: Option<i64>) -> cache_core::data::Project {
        cache_core::data::Project {
            id: Some(1),
            uproject_name: "Demo.uproject".into(),
            uproject_stem_lower: "demo".into(),
            uproject_guid: None,
            display_name: None,
            first_seen_at: None,
            last_seen_at: None,
            ue_version_major: major,
            ue_version_minor: minor,
            engine_association_raw: Some("5.7".into()),
            engine_association_kind: Some("version".into()),
        }
    }

    #[test]
    fn project_ue_version_string_renders_major_minor() {
        let p = make_project_with_version(Some(5), Some(7));
        assert_eq!(project_ue_version_string(&p).unwrap(), "5.7");
    }

    #[test]
    fn project_ue_version_string_rejects_missing_components() {
        let p = make_project_with_version(None, Some(7));
        assert!(matches!(
            project_ue_version_string(&p).unwrap_err(),
            UecmError::InvalidInput(_)
        ));
        let p2 = make_project_with_version(Some(5), None);
        assert!(matches!(
            project_ue_version_string(&p2).unwrap_err(),
            UecmError::InvalidInput(_)
        ));
        let p3 = make_project_with_version(None, None);
        assert!(matches!(
            project_ue_version_string(&p3).unwrap_err(),
            UecmError::InvalidInput(_)
        ));
    }

    #[test]
    fn resolve_cluster_master_returns_master_view_for_shared_upstream() {
        let db = open_in_memory().unwrap();
        {
            let mut conn = db.lock().unwrap();
            cache_core::data::schema::migrate(&mut conn).unwrap();
        }
        let machine_id = machines::insert(&db, &Machine::new("ZEN-MASTER", "10.0.0.50")).unwrap();
        let endpoint_id = cache_core::core::zen::endpoint::register(
            &db,
            &cache_core::core::zen::endpoint::EndpointInput {
                machine_id,
                declared_port: 8559,
                scheme: "http".into(),
                role: "shared_upstream".into(),
                upstream_endpoint_id: None,
                data_dir: r"D:\ZenMaster".into(),
                httpserverclass: "asio".into(),
                lifecycle_mode: "installed_service".into(),
            },
        )
        .unwrap()
        .id;
        let master = resolve_cluster_master(&db, endpoint_id, "ue.ddc").unwrap();
        assert_eq!(master.host, "10.0.0.50");
        assert_eq!(master.port, 8559);
        assert_eq!(master.namespace, "ue.ddc");
    }

    #[test]
    fn resolve_cluster_master_refuses_non_shared_upstream_role() {
        let db = open_in_memory().unwrap();
        {
            let mut conn = db.lock().unwrap();
            cache_core::data::schema::migrate(&mut conn).unwrap();
        }
        let machine_id = machines::insert(&db, &Machine::new("ZEN-01", "10.0.0.30")).unwrap();
        let endpoint_id = cache_core::core::zen::endpoint::register(
            &db,
            &cache_core::core::zen::endpoint::EndpointInput {
                machine_id,
                declared_port: 8558,
                scheme: "http".into(),
                role: "local".into(),
                upstream_endpoint_id: None,
                data_dir: r"D:\ZenData".into(),
                httpserverclass: "asio".into(),
                lifecycle_mode: "editor_owned".into(),
            },
        )
        .unwrap()
        .id;
        let err = resolve_cluster_master(&db, endpoint_id, "ue.ddc").unwrap_err();
        match err {
            UecmError::InvalidInput(msg) => {
                assert!(msg.contains("shared_upstream"), "msg={msg}");
            }
            other => panic!("expected InvalidInput, got {:?}", other),
        }
    }

    #[test]
    fn resolve_cluster_master_rejects_unknown_endpoint_id() {
        let db = open_in_memory().unwrap();
        {
            let mut conn = db.lock().unwrap();
            cache_core::data::schema::migrate(&mut conn).unwrap();
        }
        let err = resolve_cluster_master(&db, 9999, "ue.ddc").unwrap_err();
        assert!(matches!(err, UecmError::InvalidInput(_)));
    }

    #[test]
    fn project_enable_without_yes_or_dry_run_errors() {
        let mut ctx = fresh_ctx();
        let cred = CredentialArgs {
            cred_alias: None,
            user: None,
            pass: None,
            pass_stdin: false,        };
        let err = project_enable(&mut ctx, 1, &[1], 1, "ue.ddc", false, false, &cred).unwrap_err();
        assert!(matches!(err, UecmError::InvalidInput(_)));
    }

    #[test]
    fn project_enable_rejects_empty_machine_list() {
        let mut ctx = fresh_ctx();
        let cred = CredentialArgs::default_for_test();
        let err = project_enable(&mut ctx, 1, &[], 1, "ue.ddc", true, false, &cred).unwrap_err();
        match err {
            UecmError::InvalidInput(msg) => assert!(msg.contains("--machines")),
            other => panic!("expected InvalidInput, got {:?}", other),
        }
    }

    #[test]
    fn project_disable_rejects_empty_machine_list() {
        let mut ctx = fresh_ctx();
        let cred = CredentialArgs::default_for_test();
        let err = project_disable(&mut ctx, 1, &[], true, false, &cred).unwrap_err();
        match err {
            UecmError::InvalidInput(msg) => assert!(msg.contains("--machines")),
            other => panic!("expected InvalidInput, got {:?}", other),
        }
    }

    #[test]
    fn project_enable_dry_run_emits_plan_for_seeded_project_and_machine() {
        let mut ctx = fresh_ctx();
        let db = ctx.db.as_ref().unwrap().clone();
        // Machine with project + location, plus a shared_upstream endpoint.
        let m1 = machines::insert(&db, &Machine::new("RENDER-01", "10.0.0.10")).unwrap();
        let master_machine =
            machines::insert(&db, &Machine::new("ZEN-MASTER", "10.0.0.50")).unwrap();
        let mut proj = make_project_with_version(Some(5), Some(7));
        proj.id = None;
        let project_id = cache_core::data::projects::upsert(&db, &proj).unwrap();
        cache_core::data::project_locations::upsert(
            &db,
            &cache_core::data::ProjectLocation {
                id: None,
                project_id,
                machine_id: m1,
                abs_path: r"C:\Projects\Demo".into(),
                uproject_path: r"Demo.uproject".into(),
                discovery_status: cache_core::data::DiscoveryStatus::ManualPath,
                discovered_at: None,
            },
        )
        .unwrap();
        let upstream_id = cache_core::core::zen::endpoint::register(
            &db,
            &cache_core::core::zen::endpoint::EndpointInput {
                machine_id: master_machine,
                declared_port: 8559,
                scheme: "http".into(),
                role: "shared_upstream".into(),
                upstream_endpoint_id: None,
                data_dir: r"D:\ZenMaster".into(),
                httpserverclass: "asio".into(),
                lifecycle_mode: "installed_service".into(),
            },
        )
        .unwrap()
        .id;
        let cred = CredentialArgs::default_for_test();
        // --dry-run path: no PS, no INI I/O, just plan emission.
        project_enable(
            &mut ctx,
            project_id,
            &[m1],
            upstream_id,
            "ue.ddc",
            false,
            true,
            &cred,
        )
        .unwrap();
    }

    #[test]
    fn project_enable_dry_run_rejects_machine_without_location() {
        let mut ctx = fresh_ctx();
        let db = ctx.db.as_ref().unwrap().clone();
        let m1 = machines::insert(&db, &Machine::new("RENDER-01", "10.0.0.10")).unwrap();
        let master_machine =
            machines::insert(&db, &Machine::new("ZEN-MASTER", "10.0.0.50")).unwrap();
        let mut proj = make_project_with_version(Some(5), Some(7));
        proj.id = None;
        let project_id = cache_core::data::projects::upsert(&db, &proj).unwrap();
        // Skip the project_locations row on purpose — should error out.
        let upstream_id = cache_core::core::zen::endpoint::register(
            &db,
            &cache_core::core::zen::endpoint::EndpointInput {
                machine_id: master_machine,
                declared_port: 8559,
                scheme: "http".into(),
                role: "shared_upstream".into(),
                upstream_endpoint_id: None,
                data_dir: r"D:\ZenMaster".into(),
                httpserverclass: "asio".into(),
                lifecycle_mode: "installed_service".into(),
            },
        )
        .unwrap()
        .id;
        let cred = CredentialArgs::default_for_test();
        let err = project_enable(
            &mut ctx,
            project_id,
            &[m1],
            upstream_id,
            "ue.ddc",
            false,
            true,
            &cred,
        )
        .unwrap_err();
        match err {
            UecmError::InvalidInput(msg) => {
                assert!(msg.contains("project_location"), "msg={msg}");
            }
            other => panic!("expected InvalidInput, got {:?}", other),
        }
    }

    #[test]
    fn project_disable_dry_run_emits_plan_without_endpoint_lookup() {
        // Disable doesn't need an upstream endpoint id, so dry-run only
        // requires project + location.
        let mut ctx = fresh_ctx();
        let db = ctx.db.as_ref().unwrap().clone();
        let m1 = machines::insert(&db, &Machine::new("RENDER-01", "10.0.0.10")).unwrap();
        let mut proj = make_project_with_version(Some(5), Some(7));
        proj.id = None;
        let project_id = cache_core::data::projects::upsert(&db, &proj).unwrap();
        cache_core::data::project_locations::upsert(
            &db,
            &cache_core::data::ProjectLocation {
                id: None,
                project_id,
                machine_id: m1,
                abs_path: r"C:\Projects\Demo".into(),
                uproject_path: r"Demo.uproject".into(),
                discovery_status: cache_core::data::DiscoveryStatus::ManualPath,
                discovered_at: None,
            },
        )
        .unwrap();
        let cred = CredentialArgs::default_for_test();
        project_disable(&mut ctx, project_id, &[m1], false, true, &cred).unwrap();
    }

    // ----- verify-rules (T4.5) -------------------------------------------

    /// Drop-in fixture yaml mirroring the production layout but verified-only
    /// on UE 5.7 so we can flex both the verified and unverified branches.
    const VERIFY_RULES_FIXTURE_YAML: &str = r#"
zen_ini:
  applies_to: ">=5.4"
  rules:
    enable_zen_shared:
      ini_file: DefaultEngine.ini
      section: InstalledDerivedDataBackendGraph
      key: ZenShared
      value_template: '(Type=Zen, Host="{host}", Port={port}, Namespace="{namespace}")'
      backup: true
    disable_legacy_smb_shared:
      ini_file: DefaultEngine.ini
      section: InstalledDerivedDataBackendGraph
      key: Shared
      action: remove
      backup: true
      env_cleanup:
        - var: UE-SharedDataCachePath
          scopes: [machine, user]
    disable_legacy_pak:
      ini_file: DefaultEngine.ini
      section: InstalledDerivedDataBackendGraph
      keys: [Pak, CompressedPak]
      action: remove
      backup: true

verified_versions:
  - "5.7"

unverified_policy: refuse

overrides: {}
"#;

    /// Spin up a tempdir + writable fixture yaml + UECM_ZEN_RULES_PATH
    /// override that persists for the lifetime of the returned tuple.
    /// Tests must hold the env guard for the duration of the load.
    fn fixture_yaml_dir() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("zen-ini-rules.yaml");
        std::fs::write(&p, VERIFY_RULES_FIXTURE_YAML).unwrap();
        (dir, p)
    }

    /// Same env-override guard pattern as the rules_loader tests — restores
    /// the previous value (or removes the var) on drop.
    struct EnvVarGuard {
        key: &'static str,
        prev: Option<String>,
    }
    impl EnvVarGuard {
        fn set(key: &'static str, val: &std::path::Path) -> Self {
            let prev = std::env::var(key).ok();
            std::env::set_var(key, val);
            Self { key, prev }
        }
    }
    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            match self.prev.take() {
                Some(v) => std::env::set_var(self.key, v),
                None => std::env::remove_var(self.key),
            }
        }
    }

    /// T4.5 / T4.4: verify_rules signature now carries 8 extra params for the
    /// run-editor path. Tests that only exercise the resolve-only branch
    /// route through this wrapper so the call sites stay readable.
    fn verify_rules_resolve_only(
        ctx: &mut Ctx<'_>,
        ue_version: &str,
        ue_install: &str,
        write_verified: bool,
    ) -> UecmResult<()> {
        verify_rules(
            ctx,
            ue_version,
            ue_install,
            write_verified,
            false,
            None,
            None,
            None,
            None,
            None,
            None,
            &CredentialArgs::default_for_test(),
        )
    }

    #[test]
    fn verify_rules_resolves_verified_version() {
        let (_dir, p) = fixture_yaml_dir();
        let _lock = crate::ENV_TEST_LOCK.lock().unwrap();
        let _guard = EnvVarGuard::set("UECM_ZEN_RULES_PATH", &p);
        let mut ctx = fresh_ctx();
        verify_rules_resolve_only(&mut ctx, "5.7", "C:\\UE\\5.7", false).unwrap();
        // Yaml on disk is unchanged.
        let after = std::fs::read_to_string(&p).unwrap();
        assert_eq!(after.trim(), VERIFY_RULES_FIXTURE_YAML.trim());
    }

    #[test]
    fn verify_rules_resolves_patch_tolerant() {
        let (_dir, p) = fixture_yaml_dir();
        let _lock = crate::ENV_TEST_LOCK.lock().unwrap();
        let _guard = EnvVarGuard::set("UECM_ZEN_RULES_PATH", &p);
        let mut ctx = fresh_ctx();
        // 5.7.4 must resolve via the patch-stripping resolver.
        verify_rules_resolve_only(&mut ctx, "5.7.4", "C:\\UE\\5.7.4", false).unwrap();
    }

    #[test]
    fn verify_rules_unverified_refuse_emits_ok_false_exit_zero() {
        let (_dir, p) = fixture_yaml_dir();
        let _lock = crate::ENV_TEST_LOCK.lock().unwrap();
        let _guard = EnvVarGuard::set("UECM_ZEN_RULES_PATH", &p);
        let mut ctx = fresh_ctx();
        // 5.8 not in verified_versions and policy=refuse → must return Ok(())
        // (the JSON ok:false flag carries the signal; exit code stays 0).
        let r = verify_rules_resolve_only(&mut ctx, "5.8", "C:\\UE\\5.8", false);
        assert!(r.is_ok(), "unverified+refuse must not propagate as Err; got {:?}", r);
    }

    #[test]
    fn verify_rules_write_verified_on_already_verified_is_noop() {
        let (_dir, p) = fixture_yaml_dir();
        let _lock = crate::ENV_TEST_LOCK.lock().unwrap();
        let _guard = EnvVarGuard::set("UECM_ZEN_RULES_PATH", &p);
        let before = std::fs::read_to_string(&p).unwrap();
        let mut ctx = fresh_ctx();
        verify_rules_resolve_only(&mut ctx, "5.7", "C:\\UE\\5.7", true).unwrap();
        let after = std::fs::read_to_string(&p).unwrap();
        assert_eq!(before, after, "5.7 already verified; file must be untouched");
    }

    #[test]
    fn verify_rules_write_verified_appends_new_version() {
        // Use the warn-policy variant so 5.8 resolves and is then promoted.
        let warn_yaml = VERIFY_RULES_FIXTURE_YAML.replace(
            "unverified_policy: refuse",
            "unverified_policy: warn",
        );
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("zen-ini-rules.yaml");
        std::fs::write(&p, &warn_yaml).unwrap();

        let _lock = crate::ENV_TEST_LOCK.lock().unwrap();
        let _guard = EnvVarGuard::set("UECM_ZEN_RULES_PATH", &p);
        let mut ctx = fresh_ctx();
        verify_rules_resolve_only(&mut ctx, "5.8", "C:\\UE\\5.8", true).unwrap();

        // Re-parse the written yaml and confirm 5.8 is now in verified_versions.
        let after = std::fs::read_to_string(&p).unwrap();
        let parsed = zen_rules::parse_str(&after).expect("rewritten yaml still parses");
        assert!(
            parsed.verified_versions.iter().any(|v| v == "5.8"),
            "expected 5.8 in {:?}",
            parsed.verified_versions
        );
        // Pre-existing 5.7 must survive.
        assert!(parsed.verified_versions.iter().any(|v| v == "5.7"));
    }

    #[test]
    fn verify_rules_write_verified_strips_patch_when_writing() {
        // Promote 5.8 via 5.8.3 input. The on-disk value must be the
        // major.minor key the resolver uses, not the input string.
        let warn_yaml = VERIFY_RULES_FIXTURE_YAML.replace(
            "unverified_policy: refuse",
            "unverified_policy: warn",
        );
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("zen-ini-rules.yaml");
        std::fs::write(&p, &warn_yaml).unwrap();

        let _lock = crate::ENV_TEST_LOCK.lock().unwrap();
        let _guard = EnvVarGuard::set("UECM_ZEN_RULES_PATH", &p);
        let mut ctx = fresh_ctx();
        verify_rules_resolve_only(&mut ctx, "5.8.3", "C:\\UE\\5.8.3", true).unwrap();

        let after = std::fs::read_to_string(&p).unwrap();
        let parsed = zen_rules::parse_str(&after).expect("rewritten yaml still parses");
        assert!(
            parsed.verified_versions.iter().any(|v| v == "5.8"),
            "must store 5.8 (major.minor), not 5.8.3; got {:?}",
            parsed.verified_versions
        );
    }

    #[test]
    fn major_minor_of_strips_patch() {
        assert_eq!(major_minor_of("5.7"), Some("5.7".into()));
        assert_eq!(major_minor_of("5.7.4"), Some("5.7".into()));
        assert_eq!(major_minor_of("5.7.4-pre"), Some("5.7".into()));
        assert_eq!(major_minor_of(""), None);
        assert_eq!(major_minor_of("5"), None);
        assert_eq!(major_minor_of("x.y"), None);
    }

    // Helper for tests: empty CredentialArgs.
    impl CredentialArgs {
        fn default_for_test() -> Self {
            CredentialArgs {
                cred_alias: None,
                user: None,
                pass: None,
                pass_stdin: false,            }
        }
    }

    // --- T5.2: operations.log_text never contains raw secrets -------------

    /// Read `operations.log_text` for `op_id` — small helper since
    /// `data::operations` doesn't expose a getter (production code never
    /// reads the column back; it's a forensic field for operators).
    fn read_log_text(db: &Db, op_id: i64) -> String {
        let conn = db.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT log_text FROM operations WHERE id = ?1")
            .unwrap();
        stmt.query_row(rusqlite::params![op_id], |row| {
            Ok(row.get::<_, Option<String>>(0)?)
        })
        .unwrap()
        .unwrap_or_default()
    }

    /// Verifies finalize_op stores the redacted invocation as-is when the
    /// op succeeds. The caller wraps `invocation` through `redact()` before
    /// passing it in, so by the time `finalize_op` writes the row the
    /// scrubbed form is what should land in `operations.log_text`.
    #[test]
    fn finalize_op_persists_redacted_invocation_on_success() {
        let ctx = fresh_ctx();
        let db = ctx.db.unwrap();
        let op_id =
            cache_core::data::operations::start(&db, "zen.test.success", &[1]).unwrap();
        let raw = "zen.exe service install --access-token sk_live_top_secret \
                   --password p@ssw0rd --api-key apk_xyz";
        let invocation = redact(raw);
        finalize_op(&db, op_id, &Ok(serde_json::json!({"ok": true})), &invocation);
        let log_text = read_log_text(&db, op_id);
        for forbidden in ["sk_live_top_secret", "p@ssw0rd", "apk_xyz"] {
            assert!(
                !log_text.contains(forbidden),
                "operations.log_text leaked secret {forbidden:?}: {log_text:?}"
            );
        }
        assert!(log_text.contains("[REDACTED]"));
    }

    /// On error, finalize_op appends `\nerror: {redacted_err}` to the
    /// invocation. Verify the error tail is scrubbed too — UE error
    /// messages often quote the offending command line back, which is the
    /// classic leak vector this redactor exists to prevent.
    #[test]
    fn finalize_op_persists_redacted_error_on_failure() {
        let ctx = fresh_ctx();
        let db = ctx.db.unwrap();
        let op_id =
            cache_core::data::operations::start(&db, "zen.test.failure", &[1]).unwrap();
        let invocation = redact("zen.exe service install --password leaked_in_invocation");
        // Simulate an error message that quotes the original command line
        // back with the secret embedded — the canonical leak shape.
        let err = UecmError::OperationFailed(
            "zen.exe service install --password leaked_in_error failed (exit 1)".to_string(),
        );
        finalize_op(&db, op_id, &Err(err), &invocation);
        let log_text = read_log_text(&db, op_id);
        assert!(
            !log_text.contains("leaked_in_invocation"),
            "log_text leaked secret in invocation: {log_text:?}"
        );
        assert!(
            !log_text.contains("leaked_in_error"),
            "log_text leaked secret in error tail: {log_text:?}"
        );
        // Marker present in both halves.
        assert_eq!(log_text.matches("[REDACTED]").count(), 2);
    }

    /// Stricter property check: regardless of which form the operator put
    /// the secret into (= vs space, quoted vs unquoted), none of the
    /// SENSITIVE_FLAGS values survive a round trip through finalize_op.
    #[test]
    fn finalize_op_redacts_all_sensitive_flag_forms() {
        let ctx = fresh_ctx();
        let db = ctx.db.unwrap();
        let raw_forms = [
            "cmd --access-token=secret_eq",
            "cmd --access-token secret_ws",
            "cmd --password=\"p w s\" tail",
            "cmd --password 'sq value' tail",
            "cmd --api-key=ApiSecretEq",
            "cmd --api-key ApiSecretWs",
        ];
        for (i, raw) in raw_forms.iter().enumerate() {
            let op_id =
                cache_core::data::operations::start(&db, "zen.test.forms", &[1]).unwrap();
            let inv = redact(raw);
            finalize_op(&db, op_id, &Ok(serde_json::json!({"ok": true})), &inv);
            let log_text = read_log_text(&db, op_id);
            for needle in [
                "secret_eq",
                "secret_ws",
                "p w s",
                "sq value",
                "ApiSecretEq",
                "ApiSecretWs",
            ] {
                assert!(
                    !log_text.contains(needle),
                    "form {} leaked {:?}: {:?}",
                    i, needle, log_text
                );
            }
            assert!(log_text.contains("[REDACTED]"));
        }
    }

    #[test]
    fn derive_lua_dest_from_install_zen_exe() {
        assert_eq!(
            super::derive_lua_dest(r"C:\Users\me\AppData\Local\UnrealEngine\Common\Zen\Install\zen.exe").as_deref(),
            Some(r"C:\Users\me\AppData\Local\UnrealEngine\Common\Zen\Install\zen.lua")
        );
        assert_eq!(super::derive_lua_dest("zen.exe").as_deref(), Some("zen.lua"));
    }

    #[test]
    fn pick_service_zen_exe_prefers_intree() {
        // Bug 4: the in-tree binary (Program Files, ACL grants BUILTIN\Users:RX)
        // must win over the user-private install copy so the hardcoded
        // LocalService account can start the registered zenserver.exe.
        let intree = r"D:\Program Files\Epic Games\UE_5.8\Engine\Binaries\Win64\zen.exe";
        let install_copy = r"C:\Users\lanPC\AppData\Local\UnrealEngine\Common\Zen\Install\zen.exe";
        assert_eq!(
            super::pick_service_zen_exe(Some(intree.into()), Some(install_copy.into())).as_deref(),
            Some(intree)
        );
        // Fall back to the install copy only when no in-tree binary was detected.
        assert_eq!(
            super::pick_service_zen_exe(None, Some(install_copy.into())).as_deref(),
            Some(install_copy)
        );
        assert_eq!(super::pick_service_zen_exe(None, None), None);
    }
}
