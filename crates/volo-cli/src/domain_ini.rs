//! `voloctl cache ini <action>` handlers.

use std::collections::HashMap;

use crate::args::{BackendGraphAction, IniAction};
use crate::credential_args::CredentialArgs;
use crate::destructive::{self, Outcome};
use crate::host_args::HostTarget;
use crate::output::{EmitSerialize, Event};
use crate::run::Ctx;
use cache_core::core::ini_apply::{self, ApplyContext};
use cache_core::core::ini_editor;
use cache_core::core::ini_scanner::{self, ScanInputs};
use cache_core::core::ini_diagnostics::EnvVarState;
use cache_core::core::env_vars;
use cache_core::data::{
    ini_config_snapshots, ini_findings, machine_ue_installs, machines as data_machines,
    project_locations, scan_runs, IniFinding,
};
use cache_core::error::{VoloError, VoloResult};
use serde::Serialize;
use sha2::{Digest, Sha256};

fn value_sha256_prefix(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    let mut out = String::with_capacity(8);
    for b in &digest[..4] {
        use std::fmt::Write as _;
        write!(out, "{:02x}", b).unwrap();
    }
    out
}

fn redact_in_string(msg: String, value: &str) -> String {
    // Redact any non-empty value occurrence — short ini values like `K=v`
    // would otherwise slip through earlier `len >= 4` guard.
    if !value.is_empty() && msg.contains(value) {
        msg.replace(value, "[REDACTED:value]")
    } else {
        msg
    }
}

fn redact_error(e: VoloError, value: &str) -> VoloError {
    match e {
        VoloError::PowerShell(msg) => VoloError::PowerShell(redact_in_string(msg, value)),
        VoloError::OperationFailed(msg) => VoloError::OperationFailed(redact_in_string(msg, value)),
        other => other,
    }
}

#[derive(Serialize)]
struct IniReadOut<'a> {
    host: &'a str,
    file: &'a str,
    section: &'a str,
    keys: Vec<ini_editor::IniKey>,
}

pub fn handle(ctx: &mut Ctx<'_>, action: IniAction) -> VoloResult<()> {
    match action {
        IniAction::Read { host, file, section, cred } => {
            read(ctx, &host, &file, &section, &cred)
        }
        IniAction::Set { target, file, section, key, value, yes, dry_run, cred } => {
            let t = target.require_one()?;
            let outcome = destructive::check(yes, dry_run, "ini.set")?;
            let db = ctx.require_db()?;
            // Preflight only — see env.set for stdin-double-read rationale.
            cred.preflight(db)?;
            if outcome == Outcome::DryRun {
                let hosts: Vec<String> = match &t {
                    HostTarget::Single(h) => vec![h.clone()],
                    HostTarget::Batch(hs) => hs.clone(),
                };
                destructive::emit_plan(
                    ctx.emitter.as_mut(),
                    "ini.set",
                    serde_json::json!({
                        "hosts": hosts,
                        "file": file,
                        "section": section,
                        "key": key,
                        "value_len": value.chars().count(),
                        "value_sha256_prefix": value_sha256_prefix(&value),
                    }),
                );
                return Ok(());
            }
            match t {
                HostTarget::Single(h) => set_single(ctx, &h, &file, &section, &key, &value, &cred),
                HostTarget::Batch(hs) => set_batch(ctx, &hs, &file, &section, &key, &value, &cred),
            }
        }
        IniAction::Remove { target, file, section, key, yes, dry_run, cred } => {
            let t = target.require_one()?;
            let outcome = destructive::check(yes, dry_run, "ini.remove")?;
            let db = ctx.require_db()?;
            // SSH key auth: `ini remove` needs no operator credential. Preflight
            // validates --cred-alias existence / flag shape without consuming stdin.
            cred.preflight(db)?;
            if outcome == Outcome::DryRun {
                let hosts: Vec<String> = match &t {
                    HostTarget::Single(h) => vec![h.clone()],
                    HostTarget::Batch(hs) => hs.clone(),
                };
                destructive::emit_plan(
                    ctx.emitter.as_mut(),
                    "ini.remove",
                    serde_json::json!({
                        "hosts": hosts,
                        "file": file,
                        "section": section,
                        "key": key,
                    }),
                );
                return Ok(());
            }
            match t {
                HostTarget::Single(h) => remove_single(ctx, &h, &file, &section, &key, &cred),
                HostTarget::Batch(hs) => remove_batch(ctx, &hs, &file, &section, &key, &cred),
            }
        }
        // Plan-3 additions:
        IniAction::Scan { machine_ids, project_id, machine_id, cred } =>
            scan_dispatch(ctx, machine_ids, project_id, machine_id, &cred),
        IniAction::Runs { limit } => list_runs(ctx, limit),
        IniAction::Findings { scan_run_id, severity } => {
            list_findings(ctx, scan_run_id, severity.as_deref())
        }
        IniAction::GetFinding { finding_id } => get_finding(ctx, finding_id),
        IniAction::Apply { finding_id, yes, dry_run, cred } => {
            let outcome = destructive::check(yes, dry_run, "ini.apply")?;
            // Mirror the --yes path's preconditions locally so dry-run cannot
            // succeed on inputs that the real command would immediately reject:
            // the finding row must exist. SSH key auth: no operator credential
            // required; preflight only validates --cred-alias / flag shape.
            let db = ctx.require_db()?;
            cred.preflight(db)?;
            let finding = ini_findings::find_by_id(db, finding_id)?.ok_or_else(|| {
                VoloError::InvalidInput(format!("finding id={} not found", finding_id))
            })?;
            if outcome == Outcome::DryRun {
                // Mirror `core::ini_apply::apply` validation so dry-run can
                // only succeed on findings the real --yes path can actually
                // execute. Manual / incomplete findings must reject in both
                // paths to keep automation honest.
                if finding.section.as_deref().is_none() {
                    return Err(VoloError::InvalidInput(
                        "finding has no section".into(),
                    ));
                }
                match finding.recommended_action.as_str() {
                    "set" => {
                        if finding.key_name.is_none() {
                            return Err(VoloError::InvalidInput(
                                "finding has no key_name".into(),
                            ));
                        }
                        if finding.recommended_value.is_none() {
                            return Err(VoloError::InvalidInput(
                                "finding has no recommended_value".into(),
                            ));
                        }
                    }
                    "remove" => {
                        // R002 reads keys from snippet_before; others require key_name.
                        if finding.rule_id != "R002" && finding.key_name.is_none() {
                            return Err(VoloError::InvalidInput(
                                "remove needs key_name".into(),
                            ));
                        }
                    }
                    "manual" => {
                        return Err(VoloError::InvalidInput(
                            "manual findings cannot be auto-applied; open the file directly"
                                .into(),
                        ));
                    }
                    other => {
                        return Err(VoloError::InvalidInput(format!(
                            "unknown action: {}",
                            other
                        )));
                    }
                }
                destructive::emit_plan(
                    ctx.emitter.as_mut(),
                    "ini.apply",
                    serde_json::json!({
                        "finding_id": finding_id,
                        "rule_id": finding.rule_id,
                        "severity": finding.severity,
                        "machine_id": finding.machine_id,
                        "file_path": finding.file_path,
                        "section": finding.section,
                        "key": finding.key_name,
                        "recommended_action": finding.recommended_action,
                    }),
                );
                return Ok(());
            }
            apply_finding(ctx, finding_id, &cred)
        }
        IniAction::Skip { finding_id } => skip_finding(ctx, finding_id),
        IniAction::Config { scan_run_id, domain } => config(ctx, scan_run_id, domain.as_deref()),
        IniAction::VerifyPsoPrecaching { project_id, cred } => {
            scan_dispatch(ctx, vec![], Some(project_id), None, &cred)
        }
        IniAction::GcPause { target, project_id, yes, dry_run, cred } => {
            let hosts: Vec<String> = match target.require_one()? {
                HostTarget::Single(h) => vec![h],
                HostTarget::Batch(hs) => hs,
            };
            let outcome = destructive::check(yes, dry_run, "ini.gc-pause")?;
            let db = ctx.require_db()?;
            cred.preflight(db)?;
            if outcome == Outcome::DryRun {
                destructive::emit_plan(ctx.emitter.as_mut(), "ini.gc-pause",
                    serde_json::json!({"hosts": hosts, "project_id": project_id}));
                return Ok(());
            }
            for host in &hosts {
                cache_core::core::ddc_retention::pause_gc(db, project_id, host)?;
            }
            Ok(())
        }
        IniAction::GcResume { target, project_id, unused_file_age, yes, dry_run, cred } => {
            let hosts: Vec<String> = match target.require_one()? {
                HostTarget::Single(h) => vec![h],
                HostTarget::Batch(hs) => hs,
            };
            let outcome = destructive::check(yes, dry_run, "ini.gc-resume")?;
            let db = ctx.require_db()?;
            cred.preflight(db)?;
            if outcome == Outcome::DryRun {
                destructive::emit_plan(ctx.emitter.as_mut(), "ini.gc-resume",
                    serde_json::json!({"hosts": hosts, "project_id": project_id,
                        "unused_file_age": unused_file_age}));
                return Ok(());
            }
            for host in &hosts {
                cache_core::core::ddc_retention::resume_gc(db, project_id, host, unused_file_age)?;
            }
            Ok(())
        }
        IniAction::ZenGcPause { target, project_id, yes, dry_run, cred } => {
            let hosts: Vec<String> = match target.require_one()? {
                HostTarget::Single(h) => vec![h],
                HostTarget::Batch(hs) => hs,
            };
            let outcome = destructive::check(yes, dry_run, "ini.zen-gc-pause")?;
            let db = ctx.require_db()?;
            cred.preflight(db)?;
            if outcome == Outcome::DryRun {
                destructive::emit_plan(ctx.emitter.as_mut(), "ini.zen-gc-pause",
                    serde_json::json!({"hosts": hosts, "project_id": project_id,
                        "gc_seconds": cache_core::core::ddc_retention::ZEN_NEVER_EXPIRE_SECONDS}));
                return Ok(());
            }
            for host in &hosts {
                cache_core::core::ddc_retention::set_zen_gc_duration(
                    db, project_id, host,
                    cache_core::core::ddc_retention::ZEN_NEVER_EXPIRE_SECONDS,
                )?;
            }
            Ok(())
        }
        IniAction::ZenGcResume { target, project_id, gc_seconds, yes, dry_run, cred } => {
            let hosts: Vec<String> = match target.require_one()? {
                HostTarget::Single(h) => vec![h],
                HostTarget::Batch(hs) => hs,
            };
            let outcome = destructive::check(yes, dry_run, "ini.zen-gc-resume")?;
            let db = ctx.require_db()?;
            cred.preflight(db)?;
            if outcome == Outcome::DryRun {
                destructive::emit_plan(ctx.emitter.as_mut(), "ini.zen-gc-resume",
                    serde_json::json!({"hosts": hosts, "project_id": project_id,
                        "gc_seconds": gc_seconds}));
                return Ok(());
            }
            for host in &hosts {
                cache_core::core::ddc_retention::set_zen_gc_duration(
                    db, project_id, host, gc_seconds,
                )?;
            }
            Ok(())
        }
        IniAction::BackendGraph { action } => match action {
            BackendGraphAction::Get { host, file_path, node, field, cred } => {
                let db = ctx.require_db()?;
                cred.preflight(db)?;
                let target = ini_scanner::TargetFile {
                    path: file_path.clone(),
                    category: cache_core::core::ini_diagnostics::Category::Project,
                };
                let parsed = ini_scanner::read_file(&host, &target, None)?;
                let value = parsed.as_ref()
                    .and_then(|pf| pf.sections.iter()
                        .flat_map(|s| s.backend_nodes.iter())
                        .filter(|n| n.name.eq_ignore_ascii_case(&node))
                        .find_map(|n| cache_core::core::ini_backend_graph::get_field(n, &field).map(String::from)));
                ctx.emitter.emit_result(&serde_json::json!({
                    "host": host, "file": file_path, "node": node, "field": field, "value": value
                })).ok();
                Ok(())
            }
            BackendGraphAction::Set { target, file_path, node, field, value, yes, dry_run, cred } => {
                let hosts: Vec<String> = match target.require_one()? {
                    crate::host_args::HostTarget::Single(h) => vec![h],
                    crate::host_args::HostTarget::Batch(hs) => hs,
                };
                let outcome = destructive::check(yes, dry_run, "ini.backend-graph.set")?;
                let db = ctx.require_db()?;
                cred.preflight(db)?;
                if outcome == Outcome::DryRun {
                    destructive::emit_plan(ctx.emitter.as_mut(), "ini.backend-graph.set",
                        serde_json::json!({ "hosts": hosts, "file": file_path, "node": node, "field": field, "value": value }));
                    return Ok(());
                }
                for host in &hosts {
                    ini_editor::set_backend_field(
                        host, &file_path, "DerivedDataBackendGraph", &node, &field, &value)?;
                }
                Ok(())
            }
            BackendGraphAction::Scan { host, file_path, cred } => {
                let db = ctx.require_db()?;
                cred.preflight(db)?;
                let target = ini_scanner::TargetFile {
                    path: file_path.clone(),
                    category: cache_core::core::ini_diagnostics::Category::Project,
                };
                let parsed = ini_scanner::read_file(&host, &target, None)?;
                let nodes: Vec<_> = parsed.map(|pf| pf.sections.into_iter()
                    .flat_map(|s| s.backend_nodes.into_iter()).collect())
                    .unwrap_or_default();
                ctx.emitter.emit_result(&nodes).ok();
                Ok(())
            }
        },
    }
}

fn read(
    ctx: &mut Ctx<'_>,
    host: &str,
    file: &str,
    section: &str,
    cred: &CredentialArgs,
) -> VoloResult<()> {
    let db = ctx.require_db()?;
    cred.preflight(db)?;
    let keys = ini_editor::read_section(host, file, section)?;
    ctx.emitter
        .emit_result(&IniReadOut { host, file, section, keys })
        .ok();
    Ok(())
}

fn set_single(
    ctx: &mut Ctx<'_>,
    host: &str,
    file: &str,
    section: &str,
    key: &str,
    value: &str,
    cred: &CredentialArgs,
) -> VoloResult<()> {
    let db = ctx.require_db()?;
    cred.preflight(db)?;
    let res = ini_editor::set_key(host, file, section, key, value);
    res.map_err(|e| redact_error(e, value))?;
    ctx.emitter
        .emit_event(&Event::Completed {
            summary: serde_json::json!({
                "host": host,
                "file": file,
                "section": section,
                "key": key,
                "value_len": value.chars().count(),
                "value_sha256_prefix": value_sha256_prefix(value),
            }),
        })
        .ok();
    Ok(())
}

fn set_batch(
    ctx: &mut Ctx<'_>,
    hosts: &[String],
    file: &str,
    section: &str,
    key: &str,
    value: &str,
    cred: &CredentialArgs,
) -> VoloResult<()> {
    let db = ctx.require_db()?;
    cred.preflight(db)?;
    let total = hosts.len() as i64;

    ctx.emitter
        .emit_event(&Event::Started {
            task_type: "ini_set".into(),
            task_id: None,
            metadata: serde_json::json!({
                "hosts": total,
                "file": file,
                "section": section,
                "key": key,
                "value_len": value.chars().count(),
                "value_sha256_prefix": value_sha256_prefix(value),
            }),
        })
        .ok();

    let mut ok_count: i64 = 0;
    let mut fail_count: i64 = 0;
    for (idx, host) in hosts.iter().enumerate() {
        ctx.emitter
            .emit_event(&Event::ItemStarted {
                item_id: host.clone(),
                index: idx as i64,
                total,
            })
            .ok();
        let res = ini_editor::set_key(host, file, section, key, value);
        match res {
            Ok(_) => {
                ok_count += 1;
                ctx.emitter
                    .emit_event(&Event::ItemCompleted {
                        item_id: host.clone(),
                        index: idx as i64,
                        ok: true,
                        message: None,
                    })
                    .ok();
            }
            Err(e) => {
                fail_count += 1;
                let msg = redact_in_string(e.to_string(), value);
                ctx.emitter
                    .emit_event(&Event::ItemCompleted {
                        item_id: host.clone(),
                        index: idx as i64,
                        ok: false,
                        message: Some(msg),
                    })
                    .ok();
            }
        }
    }
    ctx.emitter
        .emit_event(&Event::Completed {
            summary: serde_json::json!({
                "hosts": total,
                "ok": ok_count,
                "failed": fail_count,
            }),
        })
        .ok();
    if fail_count > 0 {
        return Err(VoloError::OperationFailed(format!(
            "{}/{} hosts failed ini set",
            fail_count, total
        )));
    }
    Ok(())
}

fn remove_single(
    ctx: &mut Ctx<'_>,
    host: &str,
    file: &str,
    section: &str,
    key: &str,
    cred: &CredentialArgs,
) -> VoloResult<()> {
    let db = ctx.require_db()?;
    cred.preflight(db)?;
    ini_editor::remove_key(host, file, section, key)?;
    ctx.emitter
        .emit_event(&Event::Completed {
            summary: serde_json::json!({
                "host": host,
                "file": file,
                "section": section,
                "key": key,
                "removed": true,
            }),
        })
        .ok();
    Ok(())
}

fn remove_batch(
    ctx: &mut Ctx<'_>,
    hosts: &[String],
    file: &str,
    section: &str,
    key: &str,
    cred: &CredentialArgs,
) -> VoloResult<()> {
    let db = ctx.require_db()?;
    cred.preflight(db)?;
    let total = hosts.len() as i64;

    ctx.emitter
        .emit_event(&Event::Started {
            task_type: "ini_remove".into(),
            task_id: None,
            metadata: serde_json::json!({
                "hosts": total,
                "file": file,
                "section": section,
                "key": key,
            }),
        })
        .ok();

    let mut ok_count: i64 = 0;
    let mut fail_count: i64 = 0;
    for (idx, host) in hosts.iter().enumerate() {
        ctx.emitter
            .emit_event(&Event::ItemStarted {
                item_id: host.clone(),
                index: idx as i64,
                total,
            })
            .ok();
        match ini_editor::remove_key(host, file, section, key) {
            Ok(_) => {
                ok_count += 1;
                ctx.emitter
                    .emit_event(&Event::ItemCompleted {
                        item_id: host.clone(),
                        index: idx as i64,
                        ok: true,
                        message: None,
                    })
                    .ok();
            }
            Err(e) => {
                fail_count += 1;
                ctx.emitter
                    .emit_event(&Event::ItemCompleted {
                        item_id: host.clone(),
                        index: idx as i64,
                        ok: false,
                        message: Some(e.to_string()),
                    })
                    .ok();
            }
        }
    }
    ctx.emitter
        .emit_event(&Event::Completed {
            summary: serde_json::json!({
                "hosts": total,
                "ok": ok_count,
                "failed": fail_count,
            }),
        })
        .ok();
    if fail_count > 0 {
        return Err(VoloError::OperationFailed(format!(
            "{}/{} hosts failed ini remove",
            fail_count, total
        )));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Plan-3: cluster scan + findings workflow
// ---------------------------------------------------------------------------

/// Resolve the right machine set and project roots, then delegate to `scan_cluster`.
///
/// When `project_id` is `None`, falls back to the original machine-only scan
/// (empty roots map, scan_type "ini").  When `project_id` is `Some`, the
/// `project_locations` table is queried for the registered (machine, abs_path)
/// pairs; if none exist, returns `InvalidInput` so the operator is told to run
/// `project discover` first.
pub(crate) fn scan_dispatch(
    ctx: &mut Ctx<'_>,
    machine_ids: Vec<i64>,
    project_id: Option<i64>,
    machine_id: Option<i64>,
    cred: &CredentialArgs,
) -> VoloResult<()> {
    match project_id {
        None => scan_cluster(ctx, &machine_ids, HashMap::new(), "ini", None, cred),
        Some(pid) => {
            let (mids, roots) = {
                let db = ctx.require_db()?;
                let mut locs = project_locations::list_by_project(db, pid)?;
                if let Some(only) = machine_id {
                    locs.retain(|l| l.machine_id == only);
                }
                if locs.is_empty() {
                    return Err(VoloError::InvalidInput(format!(
                        "project {} has no locations (run `project discover` first)",
                        pid
                    )));
                }
                let mut roots: HashMap<i64, Vec<String>> = HashMap::new();
                let mut mids: Vec<i64> = Vec::new();
                for l in &locs {
                    roots.entry(l.machine_id).or_default().push(l.abs_path.clone());
                    if !mids.contains(&l.machine_id) {
                        mids.push(l.machine_id);
                    }
                }
                (mids, roots)
            };
            scan_cluster(ctx, &mids, roots, "ini_project", Some(pid), cred)
        }
    }
}

/// Render an INI scan's aggregate result as a readable two-line summary for
/// human (text) mode. Pure function — no IO. JSON/NDJSON consumers get the same
/// numbers in the `completed` event's structured summary instead.
fn render_ini_scan_summary(
    scan_run_id: i64,
    scan_type: &str,
    machine_count: usize,
    read: usize,
    not_found: usize,
    errors: usize,
    critical: i64,
    warning: i64,
    healthy: i64,
    info: i64,
) -> String {
    let machines_word = if machine_count == 1 { "machine" } else { "machines" };
    format!(
        "  scan_run #{}  ({}, {} {})\n  \
         files read={} not_found={} errors={}  ·  \
         findings: critical={} warning={} healthy={} info={}",
        scan_run_id, scan_type, machine_count, machines_word,
        read, not_found, errors,
        critical, warning, healthy, info,
    )
}

/// Render INI findings as an aligned human-mode table. Pure function — no IO.
/// Mirrors the compact `rule file :: section :: key` shape of the streaming
/// `Finding` event, plus the DB id + machine id so the operator can target a
/// row with `ini get` / `ini apply`.
fn render_findings_table(findings: &[IniFinding]) -> String {
    if findings.is_empty() {
        return "  (no findings)".to_string();
    }
    let mut out = format!(
        "  {:<6} {:<9} {:<6} {:<7}  {}\n",
        "ID", "SEV", "RULE", "MACHINE", "FILE :: SECTION :: KEY"
    );
    for f in findings {
        let id = f.id.map(|i| i.to_string()).unwrap_or_else(|| "-".to_string());
        out.push_str(&format!(
            "  {:<6} {:<9} {:<6} {:<7}  {} :: {} :: {}\n",
            id,
            f.severity,
            f.rule_id,
            f.machine_id,
            f.file_path,
            f.section.as_deref().unwrap_or("-"),
            f.key_name.as_deref().unwrap_or("-"),
        ));
    }
    out.trim_end().to_string()
}

/// Resolve the UE version to stamp on a config snapshot. Engine-category files
/// (`<install>\Engine\Config\BaseEngine.ini`) belong to one specific install,
/// so map the snapshot's `file_path` back to that install's version instead of
/// stamping the machine's highest-version hint on every file. Reuses
/// `enumerate_engine_paths` (1:1 with `installs`, same order) so the path
/// formula can't drift. Files that match no install engine path (e.g. a
/// project's `DefaultEngine.ini`) fall back to `hint`.
fn resolve_snapshot_ue_version(
    file_path: &str,
    installs: &[(String, String)],
    hint: Option<&str>,
) -> Option<String> {
    ini_scanner::enumerate_engine_paths(installs)
        .iter()
        .zip(installs.iter())
        .find(|(tf, _)| tf.path == file_path)
        .map(|(_, (ver, _root))| ver.clone())
        .or_else(|| hint.map(str::to_string))
}

/// Run a full INI scan across a set of machines identified by DB id.
///
/// Flow mirrors `commands::ini_scanner::scan_inis_summary`:
///   1. Create a scan_runs row → scan_run_id.
///   2. For each machine_id: load UE installs, read env vars, build ScanInputs,
///      call core::ini_scanner::scan_machine, persist findings.
///   3. Emit NDJSON events: started → per-machine item_started / item_completed
///      → completed with final counts.
fn scan_cluster(
    ctx: &mut Ctx<'_>,
    machine_ids: &[i64],
    project_paths_per_machine: HashMap<i64, Vec<String>>,
    scan_type: &str,
    project_id: Option<i64>,
    cred: &CredentialArgs,
) -> VoloResult<()> {
    if machine_ids.is_empty() {
        return Err(VoloError::InvalidInput("--machine-ids must not be empty".into()));
    }
    // Clone the Arc<Mutex<>> so we can hold a Db handle independently of the
    // ctx borrow, allowing interleaved db ops and ctx.emitter calls.
    let db = ctx.require_db()?.clone();
    cred.preflight(&db)?;

    // Create the scan_runs row up front.
    let scan_run_id = scan_runs::insert(&db, scan_type, machine_ids)?;
    let total = machine_ids.len() as i64;

    ctx.emitter
        .emit_event(&Event::Started {
            task_type: "ini_scan".into(),
            task_id: Some(scan_run_id.to_string()),
            metadata: serde_json::json!({
                "machines": total,
                "scan_run_id": scan_run_id,
            }),
        })
        .ok();

    let mut total_critical = 0i64;
    let mut total_warning = 0i64;
    let mut total_healthy = 0i64;
    let mut total_info = 0i64;
    let mut all_errors: Vec<String> = Vec::new();
    let mut all_not_found: Vec<String> = Vec::new();
    let mut total_read: usize = 0;

    for (idx, &mid) in machine_ids.iter().enumerate() {
        ctx.emitter
            .emit_event(&Event::ItemStarted {
                item_id: mid.to_string(),
                index: idx as i64,
                total,
            })
            .ok();

        // All DB operations in a scoped block so the borrow ends before
        // ctx.emitter is borrowed mutably below.
        let machine_result: VoloResult<(i64, i64, i64, i64, usize, Vec<String>, Vec<String>)> = {
            let machine = data_machines::find_by_id(&db, mid)?
                .ok_or_else(|| VoloError::InvalidInput(format!("machine {} not found", mid)))?;
            let installs_rows = machine_ue_installs::list_for_machine(&db, mid)?;
            let installs: Vec<(String, String)> = installs_rows
                .into_iter()
                .map(|i| (i.version, i.install_path))
                .collect();

            let mut env_state = EnvVarState::default();
            env_state.shared_data_cache_path = env_vars::get(
                &machine.ip, "UE-SharedDataCachePath",
            ).ok().flatten();
            env_state.local_data_cache_path = env_vars::get(
                &machine.ip, "UE-LocalDataCachePath",
            ).ok().flatten();

            // Auto-enable zen rules when the machine has at least one
            // registered endpoint. The builder returns Ok(None) for
            // legacy clusters → zen rules silently skip.
            //
            // UE version pick: highest install on this machine. Machine-
            // scoped scans don't know which project the operator is
            // targeting, so the highest-version install is the closest
            // proxy — that's what `core::cache_backend::resolve_for`
            // already uses for the routing decision.
            // Codex P2: numeric (major, minor) ordering — `String::max()`
            // would order "5.9" > "5.10" lexicographically.
            let ue_version_hint: Option<String> =
                ini_scanner::pick_highest_ue_version(&installs);
            let zen_ctx_owned = ini_scanner::build_zen_ctx_for_machine(
                &db,
                mid,
                ue_version_hint.as_deref(),
                // Codex round-21 P2: restrict R018's cluster majority
                // to the scan's machine set.
                Some(machine_ids),
            )?;
            let zen_ctx = zen_ctx_owned.as_ref().map(|o| o.as_ctx());

            let project_roots: Vec<String> =
                project_paths_per_machine.get(&mid).cloned().unwrap_or_default();
            let inputs = ScanInputs {
                host: &machine.ip,
                credential: None,
                installs: &installs,
                user_profile: "",
                project_roots: &project_roots,
                env_state,
                zen_ctx: zen_ctx.as_ref(),
                user_engine_ini_path: None,
                machine_id: 0,
            };
            let outcome = ini_scanner::scan_machine(&inputs)?;
            let read_count = outcome.read_count;
            let m_errors: Vec<String> = outcome.errors.iter()
                .map(|e| format!("{}: {}", machine.hostname, e)).collect();
            let m_not_found: Vec<String> = outcome.not_found.iter()
                .map(|nf| format!("{}: {}", machine.hostname, nf)).collect();

            let mut crit = 0i64;
            let mut warn = 0i64;
            let mut healthy = 0i64;
            let mut info = 0i64;
            for f in outcome.findings {
                let row = IniFinding {
                    id: None,
                    scan_run_id,
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
                    "critical" => crit += 1,
                    "warning" => warn += 1,
                    "healthy" => healthy += 1,
                    _ => info += 1,
                }
                ini_findings::insert(&db, &row)?;
            }
            // Persist config snapshots (DDC/PSO/Zen actual values). Stamp each
            // snapshot with the version of the install that owns its file (not
            // the machine-wide highest-version hint) so a UE_5.0 BaseEngine.ini
            // isn't labeled "5.8".
            for entry in &outcome.config_snapshots {
                ini_config_snapshots::insert(&db, &ini_config_snapshots::ConfigSnapshot {
                    id: None,
                    scan_run_id,
                    machine_id: mid,
                    file_path: entry.file_path.clone(),
                    ue_version: resolve_snapshot_ue_version(
                        &entry.file_path,
                        &installs,
                        ue_version_hint.as_deref(),
                    ),
                    domain: entry.domain.to_string(),
                    section: entry.section.clone(),
                    key_name: entry.key_name.clone(),
                    value: entry.value.clone(),
                    line_number: Some(entry.line_number),
                })?;
            }
            Ok((crit, warn, healthy, info, read_count, m_errors, m_not_found))
        };

        match machine_result {
            Ok((crit, warn, healthy, info, read_count, m_errors, m_not_found)) => {
                total_critical += crit;
                total_warning += warn;
                total_healthy += healthy;
                total_info += info;
                total_read += read_count;
                all_errors.extend(m_errors);
                all_not_found.extend(m_not_found);
                ctx.emitter
                    .emit_event(&Event::ItemCompleted {
                        item_id: mid.to_string(),
                        index: idx as i64,
                        ok: true,
                        message: Some(format!(
                            "critical={} warning={} healthy={} info={}",
                            crit, warn, healthy, info
                        )),
                    })
                    .ok();
            }
            Err(e) => {
                ctx.emitter
                    .emit_event(&Event::ItemCompleted {
                        item_id: mid.to_string(),
                        index: idx as i64,
                        ok: false,
                        message: Some(e.to_string()),
                    })
                    .ok();
            }
        }
    }

    let summary = serde_json::json!({
        "scan_run_id": scan_run_id,
        "project_id": project_id,
        "critical": total_critical,
        "warning": total_warning,
        "healthy": total_healthy,
        "info": total_info,
        "total_files_read": total_read,
        "errors_count": all_errors.len(),
        "not_found_count": all_not_found.len(),
    });
    scan_runs::finish(&db, scan_run_id, &summary)?;

    // Human-mode: a readable roll-up before the `done` summary line, mirroring
    // `machine refresh`. JSON/NDJSON consumers read the same numbers from the
    // `completed` event's structured summary.
    if !ctx.json_mode {
        let text = render_ini_scan_summary(
            scan_run_id,
            scan_type,
            machine_ids.len(),
            total_read,
            all_not_found.len(),
            all_errors.len(),
            total_critical,
            total_warning,
            total_healthy,
            total_info,
        );
        ctx.emitter.emit_text(&text).ok();
    }

    ctx.emitter
        .emit_event(&Event::Completed { summary })
        .ok();
    Ok(())
}

fn list_runs(ctx: &mut Ctx<'_>, limit: i64) -> VoloResult<()> {
    let db = ctx.require_db()?;
    let runs = scan_runs::list_recent_types(db, &["ini", "ini_project"], limit)?;
    ctx.emitter.emit_result(&runs).ok();
    Ok(())
}

fn config(ctx: &mut Ctx<'_>, scan_run_id: i64, domain: Option<&str>) -> VoloResult<()> {
    let db = ctx.require_db()?;
    let rows = match domain {
        Some(d) => ini_config_snapshots::list_for_run_domain(db, scan_run_id, d)?,
        None => ini_config_snapshots::list_for_run(db, scan_run_id)?,
    };
    if ctx.json_mode {
        ctx.emitter.emit_result(&rows).ok();
    } else {
        let mut text = String::new();
        let mut last_key = (i64::MIN, String::new()); // (machine_id, file_path)
        for r in &rows {
            let key = (r.machine_id, r.file_path.clone());
            if key != last_key {
                text.push_str(&format!("\nmachine {} — {} (UE {})\n",
                    r.machine_id, r.file_path, r.ue_version.as_deref().unwrap_or("?")));
                last_key = key;
            }
            text.push_str(&format!("  [{}] [{}] {} = {}\n",
                r.domain, r.section, r.key_name, r.value));
        }
        if rows.is_empty() { text.push_str("(no config snapshots)\n"); }
        ctx.emitter.emit_text(text.trim_end()).ok();
    }
    Ok(())
}

fn list_findings(
    ctx: &mut Ctx<'_>,
    scan_run_id: i64,
    severity: Option<&str>,
) -> VoloResult<()> {
    let db = ctx.require_db()?;
    let mut findings = ini_findings::list_for_run(db, scan_run_id)?;
    if let Some(sev) = severity {
        findings.retain(|f| f.severity.eq_ignore_ascii_case(sev));
    }
    if ctx.json_mode {
        ctx.emitter.emit_result(&findings).ok();
    } else {
        ctx.emitter.emit_text(&render_findings_table(&findings)).ok();
    }
    Ok(())
}

fn get_finding(ctx: &mut Ctx<'_>, finding_id: i64) -> VoloResult<()> {
    let db = ctx.require_db()?;
    let finding = ini_findings::find_by_id(db, finding_id)?;
    ctx.emitter.emit_result(&finding).ok();
    Ok(())
}

fn apply_finding(
    ctx: &mut Ctx<'_>,
    finding_id: i64,
    cred: &CredentialArgs,
) -> VoloResult<()> {
    let db = ctx.require_db()?;
    cred.preflight(db)?;
    let f = ini_findings::find_by_id(db, finding_id)?
        .ok_or_else(|| VoloError::InvalidInput(format!("finding {} not found", finding_id)))?;
    let machine = data_machines::find_by_id(db, f.machine_id)?
        .ok_or_else(|| {
            VoloError::InvalidInput(format!("machine {} not found", f.machine_id))
        })?;
    let apply_ctx = ApplyContext { host: &machine.ip };
    let backup = ini_apply::apply(&apply_ctx, &f)?;
    ini_findings::mark_fixed(db, finding_id)?;
    ctx.emitter
        .emit_event(&Event::Completed {
            summary: serde_json::json!({
                "finding_id": finding_id,
                "applied": true,
                "backup_path": backup,
            }),
        })
        .ok();
    Ok(())
}

fn skip_finding(ctx: &mut Ctx<'_>, finding_id: i64) -> VoloResult<()> {
    let db = ctx.require_db()?;
    ini_findings::mark_skipped(db, finding_id)?;
    ctx.emitter
        .emit_event(&Event::Completed {
            summary: serde_json::json!({
                "finding_id": finding_id,
                "skipped": true,
            }),
        })
        .ok();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::output::{Emitter, NdjsonEmitter};
    use cache_core::data::{open_in_memory, schema, Db};

    fn fresh_db() -> Db {
        let db = open_in_memory().unwrap();
        {
            let mut conn = db.lock().unwrap();
            schema::migrate(&mut conn).unwrap();
        }
        db
    }

    fn make_ctx<'a>(buf: &'a mut Vec<u8>, db: &'a Db) -> Ctx<'a> {
        let emitter: Box<dyn Emitter> = Box::new(NdjsonEmitter::new(buf));
        Ctx {
            db: Some(db.clone()),
            db_path: std::path::PathBuf::from(":memory:"),
            emitter,
            json_mode: true,
            operation_id: "ini.unmapped",
            request_id: "test-req".into(),
            no_input: false,
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn ini_set_hosts_emits_lifecycle_with_no_value_leak() {
        let db = fresh_db();
        let mut buf: Vec<u8> = Vec::new();
        let mut ctx = make_ctx(&mut buf, &db);
        let cred = CredentialArgs { cred_alias: None, user: None, pass: None, pass_stdin: false };
        let secret = "INI-SECRET-NEVER-LEAK-VALUE";
        let _ = set_batch(&mut ctx, &["192.0.2.1".into()], "C:\\test.ini", "S", "K", secret, &cred);
        drop(ctx);
        let s = String::from_utf8(buf).unwrap();
        assert!(s.contains("\"type\":\"started\""));
        assert!(s.contains("\"type\":\"item_completed\""));
        assert!(s.contains("\"type\":\"completed\""));
        assert!(!s.contains(secret), "value leaked: {}", s);
    }

    // (Removed `remove_single_without_creds_returns_invalid_input`: under SSH key
    // auth `ini remove` no longer requires an operator credential — the
    // require-creds gate it asserted was deleted in P4. The no-credential path is
    // covered by the loopback set/read/remove tests in core::ini_editor.)

    #[test]
    fn config_handler_emits_snapshots() {
        use cache_core::data::{scan_runs, machines, ini_config_snapshots as ics};
        let db = fresh_db();
        let mid = machines::insert(&db, &machines::Machine::new("R1", "1.1.1.1")).unwrap();
        let run = scan_runs::insert(&db, "ini", &[mid]).unwrap();
        ics::insert(&db, &ics::ConfigSnapshot { id: None, scan_run_id: run, machine_id: mid,
            file_path: "C:\\P\\Config\\DefaultEngine.ini".into(), ue_version: Some("5.4".into()),
            domain: "ddc".into(), section: "DerivedDataBackendGraph".into(),
            key_name: "Root".into(), value: "(Type=KeyLength)".into(), line_number: Some(3) }).unwrap();
        let mut buf: Vec<u8> = Vec::new();
        let mut ctx = make_ctx(&mut buf, &db);
        config(&mut ctx, run, None).unwrap();
        drop(ctx);
        let s = String::from_utf8(buf).unwrap();
        assert!(s.contains("DerivedDataBackendGraph"));
        assert!(s.contains("Root"));
    }

    #[test]
    fn config_handler_filters_by_domain() {
        use cache_core::data::{scan_runs, machines, ini_config_snapshots as ics};
        let db = fresh_db();
        let mid = machines::insert(&db, &machines::Machine::new("R1", "1.1.1.1")).unwrap();
        let run = scan_runs::insert(&db, "ini", &[mid]).unwrap();
        ics::insert(&db, &ics::ConfigSnapshot { id: None, scan_run_id: run, machine_id: mid,
            file_path: "C:\\P\\Config\\DefaultEngine.ini".into(), ue_version: Some("5.4".into()),
            domain: "ddc".into(), section: "DerivedDataBackendGraph".into(),
            key_name: "Root".into(), value: "(Type=KeyLength)".into(), line_number: Some(3) }).unwrap();
        ics::insert(&db, &ics::ConfigSnapshot { id: None, scan_run_id: run, machine_id: mid,
            file_path: "C:\\P\\Config\\ConsoleVariables.ini".into(), ue_version: Some("5.4".into()),
            domain: "pso".into(), section: "ConsoleVariables".into(),
            key_name: "r.PSOPrecaching".into(), value: "1".into(), line_number: Some(7) }).unwrap();
        let mut buf: Vec<u8> = Vec::new();
        let mut ctx = make_ctx(&mut buf, &db);
        config(&mut ctx, run, Some("ddc")).unwrap();
        drop(ctx);
        let s = String::from_utf8(buf).unwrap();
        assert!(s.contains("Root"), "expected ddc row key, got: {}", s);
        assert!(!s.contains("r.PSOPrecaching"), "pso row leaked under --domain ddc: {}", s);
    }

    #[cfg(not(windows))]
    #[test]
    fn scan_cluster_project_mode_uses_ini_project_type_and_roots() {
        use cache_core::data::{scan_runs, machines};
        let db = fresh_db();
        let mid = machines::insert(&db, &machines::Machine::new("R1", "localhost")).unwrap();
        // tempdir with Config/DefaultEngine.ini containing a DDC section.
        // enumerate_project_paths builds "<root>\Config\DefaultEngine.ini" with backslash
        // separators. On non-Windows the backslashes are literal filename chars,
        // so we write the file at the same backslash-named path — mirrors Task 2.5.
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        let default_engine_path = format!("{}\\Config\\DefaultEngine.ini", root);
        std::fs::write(
            &default_engine_path,
            "[DerivedDataBackendGraph]\nRoot=(Type=KeyLength)\n",
        )
        .unwrap();

        let mut buf: Vec<u8> = Vec::new();
        let mut ctx = make_ctx(&mut buf, &db);
        let mut roots = HashMap::new();
        roots.insert(mid, vec![root]);
        let cred = CredentialArgs { cred_alias: None, user: None, pass: None, pass_stdin: false };
        scan_cluster(&mut ctx, &[mid], roots, "ini_project", None, &cred).unwrap();
        drop(ctx);

        let runs = scan_runs::list_recent(&db, "ini_project", 1).unwrap();
        assert_eq!(runs.len(), 1);
        let snaps = ini_config_snapshots::list_for_run(&db, runs[0].id.unwrap()).unwrap();
        assert!(snaps.iter().any(|s| s.domain == "ddc" && s.key_name == "Root"),
            "expected ddc/Root snapshot, got: {:?}",
            snaps.iter().map(|s| (s.domain.as_str(), s.key_name.as_str())).collect::<Vec<_>>());
    }

    #[cfg(not(windows))]
    #[test]
    fn scan_dispatch_project_resolves_locations() {
        use cache_core::data::{machines, projects::{self, Project}, project_locations::{self, ProjectLocation, DiscoveryStatus}};
        let db = fresh_db();
        let mid = machines::insert(&db, &machines::Machine::new("R1", "localhost")).unwrap();
        let tmp = tempfile::tempdir().unwrap();
        // enumerate_project_paths builds "<root>\Config\DefaultEngine.ini" with
        // backslash separators. On non-Windows, backslashes are literal filename
        // chars, so write the file at the same backslash-named path (mirrors Task 3.3).
        let root = tmp.path().to_string_lossy().to_string();
        let default_engine_path = format!("{}\\Config\\DefaultEngine.ini", root);
        std::fs::write(
            &default_engine_path,
            "[DerivedDataBackendGraph]\nRoot=(Type=KeyLength)\n",
        ).unwrap();
        let pid = projects::upsert(&db, &Project {
            id: None, uproject_name: "Demo.uproject".into(),
            uproject_stem_lower: "demo".into(), uproject_guid: None, display_name: None,
            first_seen_at: None, last_seen_at: None, ue_version_major: None, ue_version_minor: None,
            engine_association_raw: None, engine_association_kind: None,
        }).unwrap();
        project_locations::upsert(&db, &ProjectLocation {
            id: None, project_id: pid, machine_id: mid,
            abs_path: root.clone(),
            uproject_path: format!("{}\\Demo.uproject", root),
            discovery_status: DiscoveryStatus::Auto, discovered_at: None,
            ue_version_major: None, ue_version_minor: None,
        }).unwrap();

        let mut buf: Vec<u8> = Vec::new();
        let mut ctx = make_ctx(&mut buf, &db);
        let cred = CredentialArgs { cred_alias: None, user: None, pass: None, pass_stdin: false };
        scan_dispatch(&mut ctx, vec![], Some(pid), None, &cred).unwrap();
        drop(ctx);
        let runs = cache_core::data::scan_runs::list_recent(&db, "ini_project", 1).unwrap();
        assert_eq!(runs.len(), 1);
    }

    #[test]
    fn scan_dispatch_project_without_location_errors() {
        use cache_core::data::projects::{self, Project};
        let db = fresh_db();
        let pid = projects::upsert(&db, &Project {
            id: None, uproject_name: "X.uproject".into(),
            uproject_stem_lower: "x".into(), uproject_guid: None, display_name: None,
            first_seen_at: None, last_seen_at: None, ue_version_major: None, ue_version_minor: None,
            engine_association_raw: None, engine_association_kind: None,
        }).unwrap();
        let mut buf: Vec<u8> = Vec::new();
        let mut ctx = make_ctx(&mut buf, &db);
        let cred = CredentialArgs { cred_alias: None, user: None, pass: None, pass_stdin: false };
        let err = scan_dispatch(&mut ctx, vec![], Some(pid), None, &cred).unwrap_err();
        assert!(matches!(err, VoloError::InvalidInput(_)));
    }

    #[cfg(not(windows))]
    #[test]
    fn scan_dispatch_project_tags_summary_with_project_id() {
        use cache_core::data::{
            machines, projects::{self, Project},
            project_locations::{self, ProjectLocation, DiscoveryStatus},
            scan_runs,
        };
        let db = fresh_db();
        let mid = machines::insert(&db, &machines::Machine::new("R1", "localhost")).unwrap();
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        let default_engine_path = format!("{}\\Config\\DefaultEngine.ini", root);
        std::fs::write(
            &default_engine_path,
            "[DerivedDataBackendGraph]\nRoot=(Type=KeyLength)\n",
        )
        .unwrap();
        let pid = projects::upsert(&db, &Project {
            id: None, uproject_name: "Demo.uproject".into(),
            uproject_stem_lower: "demo".into(), uproject_guid: None, display_name: None,
            first_seen_at: None, last_seen_at: None, ue_version_major: None, ue_version_minor: None,
            engine_association_raw: None, engine_association_kind: None,
        })
        .unwrap();
        project_locations::upsert(&db, &ProjectLocation {
            id: None, project_id: pid, machine_id: mid,
            abs_path: root.clone(),
            uproject_path: format!("{}\\Demo.uproject", root),
            discovery_status: DiscoveryStatus::Auto, discovered_at: None,
            ue_version_major: None, ue_version_minor: None,
        })
        .unwrap();

        let mut buf: Vec<u8> = Vec::new();
        let mut ctx = make_ctx(&mut buf, &db);
        let cred = CredentialArgs { cred_alias: None, user: None, pass: None, pass_stdin: false };
        scan_dispatch(&mut ctx, vec![], Some(pid), None, &cred).unwrap();
        drop(ctx);

        let run = scan_runs::list_recent(&db, "ini_project", 1).unwrap().remove(0);
        let summary = run.summary.as_ref().expect("summary must be set");
        assert_eq!(
            summary["project_id"].as_i64(),
            Some(pid),
            "summary must carry project_id={}, got: {}",
            pid,
            summary
        );
    }

    #[test]
    fn list_runs_includes_project_scans() {
        use cache_core::data::scan_runs;
        let db = fresh_db();
        scan_runs::insert(&db, "ini", &[1]).unwrap();
        scan_runs::insert(&db, "ini_project", &[1]).unwrap();
        let mut buf: Vec<u8> = Vec::new();
        let mut ctx = make_ctx(&mut buf, &db);
        list_runs(&mut ctx, 10).unwrap();
        drop(ctx);
        let s = String::from_utf8(buf).unwrap();
        assert!(s.contains("ini_project"));
        assert!(s.contains("ini"));
    }

    #[cfg(not(windows))]
    #[test]
    fn scan_persists_config_snapshots_to_db() {
        use cache_core::data::{ini_config_snapshots, machines as data_machines, machine_ue_installs, scan_runs};

        let db = fresh_db();

        // Insert a machine with IP "localhost" so the loopback path is used
        // by read_local_file (no SSH/WinRM needed in unit tests).
        let mid = data_machines::insert(
            &db,
            &data_machines::Machine::new("TEST-NODE", "localhost"),
        )
        .unwrap();

        // Create a temp dir that serves as the UE install root.
        // enumerate_engine_paths produces: "<install_path>\\Engine\\Config\\BaseEngine.ini"
        // On non-Windows, the backslashes are literal filename characters —
        // std::fs::write and std::fs::read_to_string both use the same string,
        // so the round-trip works correctly (mirrors Task 2.4's approach).
        let install_dir = tempfile::tempdir().unwrap();
        let install_path = install_dir.path().to_string_lossy().to_string();
        let engine_ini_path = format!("{}\\Engine\\Config\\BaseEngine.ini", install_path);
        std::fs::write(
            &engine_ini_path,
            "[DerivedDataBackendGraph]\nRoot=(Type=KeyLength)\n",
        )
        .unwrap();

        machine_ue_installs::upsert(
            &db,
            &machine_ue_installs::UeInstall {
                id: None,
                machine_id: mid,
                version: "5.4".to_string(),
                install_path: install_path.clone(),
                is_primary: true,
                zen_cli_intree_path: None,
                zen_cli_intree_version: None,
                zen_cli_intree_sha256: None,
                zenserver_intree_path: None,
                zenserver_intree_version: None,
                zenserver_intree_sha256: None,
            },
        )
        .unwrap();

        let mut buf: Vec<u8> = Vec::new();
        let mut ctx = make_ctx(&mut buf, &db);
        let cred = CredentialArgs { cred_alias: None, user: None, pass: None, pass_stdin: false };
        scan_cluster(&mut ctx, &[mid], HashMap::new(), "ini", None, &cred).unwrap();

        let run_id = scan_runs::list_recent(&db, "ini", 1).unwrap()[0]
            .id
            .unwrap();
        let snapshots = ini_config_snapshots::list_for_run(&db, run_id).unwrap();
        assert!(
            snapshots.iter().any(|s| s.domain == "ddc" && s.key_name == "Root"),
            "expected ddc/Root in ini_config_snapshots, got: {:?}",
            snapshots
                .iter()
                .map(|s| (s.domain.as_str(), s.key_name.as_str()))
                .collect::<Vec<_>>()
        );
    }

    fn sample_finding(id: i64) -> IniFinding {
        IniFinding {
            id: Some(id),
            scan_run_id: 39,
            machine_id: 12,
            rule_id: "R003".into(),
            severity: "critical".into(),
            category: "ddc".into(),
            file_path: "D:\\Proj\\Config\\DefaultEngine.ini".into(),
            section: Some("Core.System".into()),
            key_name: Some("DerivedDataCache.Path".into()),
            line_number: Some(12),
            snippet_before: String::new(),
            snippet_after: None,
            recommended_action: "rewrite".into(),
            recommended_value: Some("X".into()),
            symptom: "hardcoded path".into(),
            rationale: "r".into(),
            fixed_at: None,
            skipped_at: None,
        }
    }

    #[test]
    fn render_findings_table_handles_empty() {
        let out = render_findings_table(&[]);
        assert_eq!(out, "  (no findings)");
        assert!(!out.contains('{'));
    }

    #[test]
    fn render_findings_table_shows_id_machine_rule_and_is_not_json() {
        let out = render_findings_table(&[sample_finding(41)]);
        assert!(out.contains("ID") && out.contains("RULE") && out.contains("MACHINE"));
        assert!(out.contains("41"), "missing finding id; got:\n{}", out);
        assert!(out.contains("R003"));
        assert!(out.contains("12"), "missing machine id; got:\n{}", out);
        assert!(out.contains("DefaultEngine.ini"));
        assert!(out.contains("Core.System"));
        assert!(!out.contains('{'), "human table must not be JSON: {}", out);
    }

    #[test]
    fn render_ini_scan_summary_is_readable_not_json() {
        let out = render_ini_scan_summary(39, "ini", 1, 6, 6, 0, 0, 0, 0, 0);
        assert!(out.contains("scan_run #39"));
        assert!(out.contains("1 machine"));
        assert!(out.contains("read=6"));
        assert!(out.contains("not_found=6"));
        assert!(out.contains("critical=0"));
        assert!(!out.contains('{'), "summary must not be JSON: {}", out);
    }

    #[test]
    fn render_ini_scan_summary_pluralizes_machines() {
        let out = render_ini_scan_summary(7, "ini_project", 3, 9, 0, 0, 2, 1, 5, 0);
        assert!(out.contains("3 machines"));
        assert!(out.contains("ini_project"));
    }

    #[test]
    fn list_findings_human_mode_renders_table_not_json() {
        use crate::output::HumanEmitter;
        use cache_core::data::{machines as data_machines, scan_runs};
        let db = fresh_db();
        let mid = data_machines::insert(&db, &data_machines::Machine::new("R01", "10.0.0.9"))
            .unwrap();
        let run = scan_runs::insert(&db, "ini", &[mid]).unwrap();
        let mut f = sample_finding(0);
        f.id = None;
        f.scan_run_id = run;
        f.machine_id = mid;
        ini_findings::insert(&db, &f).unwrap();

        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        {
            let emitter: Box<dyn Emitter> =
                Box::new(HumanEmitter::new(&mut stdout, &mut stderr, false));
            let mut ctx = Ctx {
                db: Some(db.clone()),
                db_path: std::path::PathBuf::from(":memory:"),
                emitter,
                json_mode: false,
                operation_id: "ini.findings",
                request_id: "test-req".into(),
                no_input: false,
            };
            list_findings(&mut ctx, run, None).unwrap();
        }
        let s = String::from_utf8(stdout).unwrap();
        assert!(s.contains("R003"), "should contain rule id; got:\n{}", s);
        assert!(s.contains("DefaultEngine.ini"), "should contain file path; got:\n{}", s);
        assert!(!s.contains('{'), "human mode must not emit JSON; got:\n{}", s);
    }

    #[test]
    fn resolve_snapshot_ue_version_maps_engine_file_to_its_install() {
        let installs = vec![
            ("5.0".to_string(), "C:\\Epic\\UE_5.0".to_string()),
            ("5.4".to_string(), "C:\\Epic\\UE_5.4".to_string()),
        ];
        let p50 = "C:\\Epic\\UE_5.0\\Engine\\Config\\BaseEngine.ini";
        let p54 = "C:\\Epic\\UE_5.4\\Engine\\Config\\BaseEngine.ini";
        // Engine file → its own install's version, regardless of the hint.
        assert_eq!(resolve_snapshot_ue_version(p50, &installs, Some("5.4")), Some("5.0".to_string()));
        assert_eq!(resolve_snapshot_ue_version(p54, &installs, Some("5.0")), Some("5.4".to_string()));
        // Project file matches no engine path → falls back to hint.
        let proj = "D:\\Proj\\Config\\DefaultEngine.ini";
        assert_eq!(resolve_snapshot_ue_version(proj, &installs, Some("5.4")), Some("5.4".to_string()));
        // No match + no hint → None.
        assert_eq!(resolve_snapshot_ue_version(proj, &installs, None), None);
    }

    #[cfg(not(windows))]
    #[test]
    fn scan_stamps_each_snapshot_with_its_files_ue_version() {
        use cache_core::data::{
            ini_config_snapshots, machine_ue_installs, machines as data_machines, scan_runs,
        };
        let db = fresh_db();
        let mid = data_machines::insert(
            &db,
            &data_machines::Machine::new("NODE", "localhost"),
        )
        .unwrap();

        // Two installs of different versions, each with its own BaseEngine.ini.
        // On non-Windows the backslashes are literal filename chars; write/read
        // round-trip on the same string (mirrors scan_persists_config_snapshots).
        let dir50 = tempfile::tempdir().unwrap();
        let dir54 = tempfile::tempdir().unwrap();
        let path50 = dir50.path().to_string_lossy().to_string();
        let path54 = dir54.path().to_string_lossy().to_string();
        let ini50 = format!("{}\\Engine\\Config\\BaseEngine.ini", path50);
        let ini54 = format!("{}\\Engine\\Config\\BaseEngine.ini", path54);
        std::fs::write(&ini50, "[DerivedDataBackendGraph]\nRoot=(Type=KeyLength)\n").unwrap();
        std::fs::write(&ini54, "[DerivedDataBackendGraph]\nRoot=(Type=KeyLength)\n").unwrap();

        for (ver, path) in [("5.0", &path50), ("5.4", &path54)] {
            machine_ue_installs::upsert(
                &db,
                &machine_ue_installs::UeInstall {
                    id: None,
                    machine_id: mid,
                    version: ver.to_string(),
                    install_path: path.to_string(),
                    is_primary: ver == "5.4",
                    zen_cli_intree_path: None,
                    zen_cli_intree_version: None,
                    zen_cli_intree_sha256: None,
                    zenserver_intree_path: None,
                    zenserver_intree_version: None,
                    zenserver_intree_sha256: None,
                },
            )
            .unwrap();
        }

        let mut buf: Vec<u8> = Vec::new();
        let mut ctx = make_ctx(&mut buf, &db);
        let cred = CredentialArgs { cred_alias: None, user: None, pass: None, pass_stdin: false };
        scan_cluster(&mut ctx, &[mid], HashMap::new(), "ini", None, &cred).unwrap();

        let run = scan_runs::list_recent(&db, "ini", 1).unwrap()[0].id.unwrap();
        let snaps = ini_config_snapshots::list_for_run(&db, run).unwrap();
        // pick_highest_ue_version → "5.4"; without the per-file fix every
        // snapshot would be stamped "5.4". Assert the 5.0 file keeps "5.0".
        let v50: Vec<_> = snaps.iter().filter(|s| s.file_path == ini50).collect();
        let v54: Vec<_> = snaps.iter().filter(|s| s.file_path == ini54).collect();
        assert!(
            !v50.is_empty() && !v54.is_empty(),
            "expected snapshots from both files; got: {:?}",
            snaps.iter().map(|s| (s.file_path.clone(), s.ue_version.clone())).collect::<Vec<_>>()
        );
        assert!(
            v50.iter().all(|s| s.ue_version.as_deref() == Some("5.0")),
            "5.0 file mislabeled: {:?}",
            v50.iter().map(|s| s.ue_version.clone()).collect::<Vec<_>>()
        );
        assert!(
            v54.iter().all(|s| s.ue_version.as_deref() == Some("5.4")),
            "5.4 file mislabeled: {:?}",
            v54.iter().map(|s| s.ue_version.clone()).collect::<Vec<_>>()
        );
    }
}
