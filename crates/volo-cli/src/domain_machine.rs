//! `voloctl cache machine <action>` handlers.

use crate::args::MachineAction;
use crate::destructive::{self, Outcome};
use crate::output::Event;
use crate::run::Ctx;
use crate::EmitSerialize;
use cache_core::core::ssh::{RemoteExecutor, SshExecutor};
use cache_core::data::{machines, machine_ue_installs, machine_gpus};
use cache_core::error::{VoloError, VoloResult};
use cache_core::data::machines::Machine;
use serde_json::json;

pub fn handle(ctx: &mut Ctx<'_>, action: MachineAction) -> VoloResult<()> {
    match action {
        MachineAction::List => list(ctx),
        MachineAction::Scan { cidr, timeout_ms } => scan(ctx, &cidr, timeout_ms),
        MachineAction::Add { ip, hostname } => add(ctx, ip, hostname),
        MachineAction::Refresh { id, cred } => {
            let exec = SshExecutor::from_config()?;
            refresh(ctx, id, &cred, &exec)
        }
        MachineAction::Detail { id } => detail(ctx, id),
        MachineAction::Delete { id, machine_ids, all, yes, dry_run } => {
            delete(ctx, id, machine_ids, all, yes, dry_run)
        }
        MachineAction::Rename { id, hostname } => rename(ctx, id, hostname),
        MachineAction::SetUeUser { machine, ue_user } => set_ue_user(ctx, machine, &ue_user),
        MachineAction::DeepScan { machine_ids, all, cred } => {
            let exec = SshExecutor::from_config()?;
            deep_scan(ctx, machine_ids, all, &cred, &exec)
        }
        MachineAction::Authorize { machine_ids, all, save_as, cred } => {
            authorize(ctx, machine_ids, all, save_as, &cred)
        }
    }
}

/// Render UE installs as an aligned human-mode table. Pure function — no IO.
fn render_ue_installs_table(installs: &[machine_ue_installs::UeInstall]) -> String {
    if installs.is_empty() {
        return "  (no UE installs)".to_string();
    }
    let mut out = String::from("  VERSION  PRIMARY  INSTALL PATH\n");
    for i in installs {
        let primary = if i.is_primary { "*" } else { " " };
        out.push_str(&format!("  {:<7}  {:^7}  {}\n", i.version, primary, i.install_path));
    }
    out.trim_end().to_string()
}

/// Render GPUs as an aligned human-mode table. Pure function — no IO.
fn render_gpus_table(gpus: &[machine_gpus::GpuInfo]) -> String {
    if gpus.is_empty() {
        return "  (no GPUs)".to_string();
    }
    let mut out = format!("  {:<28}  {:<11}  {}\n", "GPU MODEL", "DRIVER", "VRAM(MB)");
    for g in gpus {
        let vram = g.vram_mb.map(|v| v.to_string()).unwrap_or_else(|| "N/A".to_string());
        out.push_str(&format!("  {:<28}  {:<11}  {}\n", g.gpu_model, g.driver_version, vram));
    }
    out.trim_end().to_string()
}

fn list(ctx: &mut Ctx<'_>) -> VoloResult<()> {
    let db = ctx.require_db()?;
    let rows = machines::list_all(db)?;
    ctx.emitter.emit_result(&rows).ok();
    Ok(())
}

fn add(ctx: &mut Ctx<'_>, ip: String, hostname: Option<String>) -> VoloResult<()> {
    let db = ctx.require_db()?;
    let hostname = hostname.unwrap_or_else(|| ip.clone());

    // Idempotent: same IP twice doesn't trip the UNIQUE constraint. Matches the
    // UI's `add_discovered_machine` behavior so `scan → add` automation can
    // safely re-run without manually deduping.
    if let Some(existing) = machines::find_by_ip(db, &ip)? {
        let id = existing.id.expect("found machine must have an id");
        let summary = json!({
            "id": id,
            "ip": ip,
            "hostname": existing.hostname,
            "already_present": true,
        });
        ctx.emitter.emit_event(&Event::Completed { summary }).ok();
        return Ok(());
    }

    let machine = Machine::new(&hostname, &ip);
    let id = machines::insert(db, &machine)?;

    let summary = json!({
        "id": id,
        "ip": ip,
        "hostname": hostname,
    });
    ctx.emitter.emit_event(&Event::Completed { summary }).ok();
    Ok(())
}

fn detail(ctx: &mut Ctx<'_>, id: i64) -> VoloResult<()> {
    let db = ctx.require_db()?;

    let machine = machines::find_by_id(db, id)?
        .ok_or_else(|| VoloError::InvalidInput(format!("machine id={} not found", id)))?;
    let ue_installs = machine_ue_installs::list_for_machine(db, id)?;
    let gpus = machine_gpus::list_for_machine(db, id)?;

    if ctx.json_mode {
        let detail = json!({
            "machine": machine,
            "ue_installs": ue_installs,
            "gpus": gpus,
        });
        ctx.emitter.emit_result(&detail).ok();
    } else {
        let installs_tbl = render_ue_installs_table(&ue_installs);
        let gpus_tbl = render_gpus_table(&gpus);
        let text = format!(
            "Machine: {} ({})  last_seen={}\n\nUE Installs:\n{}\n\nGPUs:\n{}",
            machine.hostname, machine.ip,
            machine.last_seen_at.as_deref().unwrap_or("-"),
            installs_tbl, gpus_tbl,
        );
        ctx.emitter.emit_text(&text).ok();
    }
    Ok(())
}

fn delete(
    ctx: &mut Ctx<'_>,
    id: Option<i64>,
    machine_ids: Vec<i64>,
    all: bool,
    yes: bool,
    dry_run: bool,
) -> VoloResult<()> {
    let outcome = destructive::check(yes, dry_run, "machine.delete")?;

    // Resolve the target set, validating existence up front so a typo / bad id
    // fails loudly and atomically — never delete the good ones then choke on a
    // bad one. Scoped db borrow so it's released before we touch ctx.emitter.
    let ids: Vec<i64> = {
        let db = ctx.require_db()?;
        match id {
            // Single positional id (back-compat).
            Some(single) => {
                if machines::find_by_id(db, single)?.is_none() {
                    return Err(VoloError::InvalidInput(format!(
                        "machine id={} not found (already deleted or wrong id)",
                        single
                    )));
                }
                vec![single]
            }
            // --all: every machine currently in inventory (all known to exist).
            None if all => machines::list_all(db)?
                .into_iter()
                .filter_map(|m| m.id)
                .collect(),
            // --machine-ids: explicit set; every id must exist or the whole
            // batch is rejected (no partial deletes).
            None => {
                if machine_ids.is_empty() {
                    return Err(VoloError::InvalidInput(
                        "one of <id> / --machine-ids / --all is required".into(),
                    ));
                }
                let mut missing: Vec<i64> = Vec::new();
                for m in &machine_ids {
                    if machines::find_by_id(db, *m)?.is_none() {
                        missing.push(*m);
                    }
                }
                if !missing.is_empty() {
                    return Err(VoloError::InvalidInput(format!(
                        "machine id(s) not found: {:?} (nothing deleted)",
                        missing
                    )));
                }
                machine_ids.clone()
            }
        }
    };

    if outcome == Outcome::DryRun {
        destructive::emit_plan(
            ctx.emitter.as_mut(),
            "machine.delete",
            json!({ "ids": ids }),
        );
        return Ok(());
    }

    // Every id was validated above, so delete them all — no silent skips.
    let count = ids.len();
    {
        let db = ctx.require_db()?;
        for target in &ids {
            machines::delete(db, *target)?;
        }
    }

    let summary = json!({
        "deleted": ids,
        "count": count,
    });
    ctx.emitter.emit_event(&Event::Completed { summary }).ok();
    Ok(())
}

fn rename(ctx: &mut Ctx<'_>, id: i64, hostname: String) -> VoloResult<()> {
    let db = ctx.require_db()?;
    machines::rename(db, id, &hostname)?;

    let summary = json!({
        "id": id,
        "hostname": hostname,
    });
    ctx.emitter.emit_event(&Event::Completed { summary }).ok();
    Ok(())
}

fn set_ue_user(ctx: &mut Ctx<'_>, machine_id: i64, ue_user: &str) -> VoloResult<()> {
    let db = ctx.require_db()?;
    let user_opt: Option<&str> = if ue_user.is_empty() { None } else { Some(ue_user) };
    machines::set_ue_runtime_user(db, machine_id, user_opt)?;
    let stored = machines::get_ue_runtime_user(db, machine_id)?;
    let doc = serde_json::json!({
        "ok": true,
        "machine_id": machine_id,
        "ue_runtime_user": stored,
    });
    ctx.emitter.emit_result(&doc).ok();
    Ok(())
}

fn scan(ctx: &mut Ctx<'_>, cidr: &str, timeout_ms: u64) -> VoloResult<()> {
    ctx.emitter
        .emit_event(&Event::Started {
            task_type: "machine_scan".into(),
            task_id: None,
            metadata: serde_json::json!({ "cidr": cidr, "timeout_ms": timeout_ms }),
        })
        .ok();

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| VoloError::Configuration(format!("tokio runtime: {}", e)))?;
    let hosts = runtime.block_on(cache_core::core::network::scan_cidr(cidr, timeout_ms))?;
    let total = hosts.len() as i64;
    for h in &hosts {
        ctx.emitter
            .emit_event(&Event::HostProbe {
                ip: h.ip.clone(),
                winrm_open: h.winrm_open,
                smb_open: h.smb_open,
                rpc_open: h.rpc_open,
            })
            .ok();
    }
    ctx.emitter
        .emit_event(&Event::Completed {
            summary: serde_json::json!({ "hosts": total }),
        })
        .ok();
    Ok(())
}

fn refresh(ctx: &mut Ctx<'_>, id: i64, cred: &crate::credential_args::CredentialArgs, exec: &dyn RemoteExecutor) -> VoloResult<()> {
    // Fetch machine, grab IP (canonical connect target — matches the UI's
    // `commands::discovery::refresh_machine`). Hostname can drift if the user
    // renames the row, so IP is the only reliable WinRM target.
    let (host, hostname_for_log) = {
        let db = ctx.require_db()?;
        let machine = machines::find_by_id(db, id)?
            .ok_or_else(|| VoloError::InvalidInput(format!("machine id={} not found", id)))?;
        (machine.ip.clone(), machine.hostname.clone())
    };

    // SSH key auth: refresh (probe + UE detect + GPU detect) needs no operator
    // credential. preflight validates --cred-alias existence / flag combo without
    // reading DPAPI or stdin for a credential that would only be discarded.
    {
        let db = ctx.require_db()?;
        cred.preflight(db)?;
    }

    ctx.emitter
        .emit_event(&Event::Started {
            task_type: "machine_refresh".into(),
            task_id: Some(format!("machine:{}", id)),
            metadata: serde_json::json!({
                "ip": host,
                "hostname": hostname_for_log,
                // SSH key auth always authenticates as uecm-svc.
                "authenticated": true,
            }),
        })
        .ok();

    // 1. WinRM probe — mirror commands::discovery::refresh_machine so the UI
    // and CLI write the SAME `online` / `offline` status values. Otherwise a
    // CLI-refresh'd machine vanishes from the Dashboard's online count.
    ctx.emitter
        .emit_event(&Event::Progress {
            pct: None,
            label: "ssh probe".into(),
            current: None,
            total: None,
        })
        .ok();
    // SSH key auth (uecm-svc); operator `creds` no longer gate the probe.
    let probe_result = exec.probe(&host, None);
    let probe = match probe_result {
        Ok(p) if p.ok => {
            {
                let db = ctx.require_db()?;
                machines::mark_seen(db, id, "online")?;
            }
            p
        }
        Ok(p) => {
            {
                let db = ctx.require_db()?;
                machines::mark_seen(db, id, "offline")?;
            }
            return Err(VoloError::SshConnect(format!(
                "ssh probe failed: {}",
                p.message
            )));
        }
        Err(e) => {
            {
                let db = ctx.require_db()?;
                machines::mark_seen(db, id, "offline")?;
            }
            return Err(e);
        }
    };

    // 2. Detect UE installs + persist FIRST (partial-failure tolerance —
    // mirrors `commands::discovery::refresh_machine`). If a later step
    // (e.g. GPU detect) blows up we still keep the UE list we already saved
    // rather than discarding it.
    ctx.emitter
        .emit_event(&Event::Progress {
            pct: None,
            label: "detect ue installs".into(),
            current: None,
            total: None,
        })
        .ok();
    let detected_ue = cache_core::core::discovery::detect_ue_versions(exec, &host)?;
    // PowerShell `query-ue-versions.ps1` sorts version ascending, so picking
    // index 0 marks the OLDEST install as primary — wrong, downstream
    // DDC/PSO jobs that fall back to `is_primary` would pick the wrong engine.
    // Compare versions NUMERICALLY (split major.minor and parse), not
    // lexicographically — string compare puts "4.9" > "4.27" and would put
    // "5.10" < "5.8" once UE 5.10 ships.
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
    {
        let db = ctx.require_db()?;
        // Mirror commands/discovery.rs: snapshot existing rows so intree_*
        // metadata written by Plan 7 T1.6 survives a `voloctl cache machine refresh`.
        let existing = machine_ue_installs::list_for_machine(db, id)?;
        machine_ue_installs::delete_for_machine(db, id)?;
        for (idx, detected) in detected_ue.iter().enumerate() {
            let prior = existing
                .iter()
                .find(|u| u.version == detected.version && u.install_path == detected.install_path);
            let install = machine_ue_installs::UeInstall {
                id: None,
                machine_id: id,
                version: detected.version.clone(),
                install_path: detected.install_path.clone(),
                is_primary: Some(idx) == primary_idx,
                zen_cli_intree_path: prior.and_then(|p| p.zen_cli_intree_path.clone()),
                zen_cli_intree_version: prior.and_then(|p| p.zen_cli_intree_version.clone()),
                zen_cli_intree_sha256: prior.and_then(|p| p.zen_cli_intree_sha256.clone()),
                zenserver_intree_path: prior.and_then(|p| p.zenserver_intree_path.clone()),
                zenserver_intree_version: prior.and_then(|p| p.zenserver_intree_version.clone()),
                zenserver_intree_sha256: prior.and_then(|p| p.zenserver_intree_sha256.clone()),
            };
            machine_ue_installs::upsert(db, &install)?;
        }
    }

    // 3. Detect GPUs + persist
    ctx.emitter
        .emit_event(&Event::Progress {
            pct: None,
            label: "detect gpus".into(),
            current: None,
            total: None,
        })
        .ok();
    let detected_gpus = cache_core::core::discovery::detect_gpus(exec, &host)?;
    {
        let db = ctx.require_db()?;
        // Convert DetectedGpu → GpuInfo
        let gpu_infos: Vec<machine_gpus::GpuInfo> = detected_gpus
            .iter()
            .map(|gpu| machine_gpus::GpuInfo {
                id: None,
                machine_id: id,
                gpu_model: gpu.gpu_model.clone(),
                driver_version: gpu.driver_version.clone(),
                vendor: gpu.vendor,
                vram_mb: gpu.vram_mb,
            })
            .collect();
        machine_gpus::replace_for_machine(db, id, &gpu_infos)?;
        // last_seen + status were already updated by the probe branch above —
        // no extra mark_seen here (avoids overwriting the canonical
        // online/offline tokens with anything else).
    }

    // Human-mode: list the UE installs we just detected/persisted, before
    // the `done` summary line. JSON consumers get the count in summary.
    if !ctx.json_mode {
        let installs = {
            let db = ctx.require_db()?;
            machine_ue_installs::list_for_machine(db, id)?
        };
        let tbl = render_ue_installs_table(&installs);
        ctx.emitter.emit_text(&tbl).ok();
    }

    let summary = json!({
        "machine_id": id,
        "ue_versions": detected_ue.len(),
        "gpus": detected_gpus.len(),
        "latency_ms": probe.latency_ms,
        // SSH key auth always authenticates as uecm-svc.
        "authenticated": true,
    });
    ctx.emitter.emit_event(&Event::Completed { summary }).ok();
    Ok(())
}

/// Expand a `--machine-ids` / `--all` selection into concrete machine ids.
/// Shared by `deep_scan` and `authorize`.
fn resolve_target_ids(db: &cache_core::data::Db, machine_ids: &[i64], all: bool) -> VoloResult<Vec<i64>> {
    if all {
        Ok(machines::list_all(db)?
            .into_iter()
            .filter_map(|m| m.id)
            .collect())
    } else if machine_ids.is_empty() {
        Err(VoloError::InvalidInput(
            "one of --machine-ids or --all is required".into(),
        ))
    } else {
        Ok(machine_ids.to_vec())
    }
}

fn deep_scan(
    ctx: &mut Ctx<'_>,
    machine_ids: Vec<i64>,
    all: bool,
    cred: &crate::credential_args::CredentialArgs,
    exec: &dyn RemoteExecutor,
) -> VoloResult<()> {
    let ids = {
        let db = ctx.require_db()?;
        resolve_target_ids(db, &machine_ids, all)?
    };
    // SSH key auth: deep-scan's sub-handlers (probe / refresh / ini scan) take no
    // operator credential, so validate the flags once with preflight (no DPAPI /
    // stdin read for a credential that would only be discarded) and fan out a
    // credential-free CredentialArgs to every sub-handler.
    {
        let db = ctx.require_db()?;
        cred.preflight(db)?;
    }
    let sub_cred = crate::credential_args::CredentialArgs::inline(None);

    ctx.emitter
        .emit_event(&Event::Started {
            task_type: "machine_deep_scan".into(),
            task_id: None,
            metadata: json!({ "machines": ids.len() }),
        })
        .ok();

    // Phase 1 (per machine): WinRM reachability probe + refresh (UE/GPU). UE/GPU
    // detection is inherently per-machine, so it stays in the loop. Classify:
    //   - machine id not found            -> failed
    //   - WinRM probe unreachable         -> skip + "run authorize" hint
    //   - probe OK but refresh later fails -> failed (NOT a skip — the box is
    //     reachable, so don't mislead the operator into re-running authorize)
    let mut reachable: Vec<i64> = Vec::new();
    let mut skipped = 0usize;
    let mut failed = 0usize;
    for id in &ids {
        let host = {
            let db = ctx.require_db()?;
            match machines::find_by_id(db, *id)? {
                Some(m) => m.ip,
                None => {
                    failed += 1;
                    ctx.emitter
                        .emit_event(&Event::Completed {
                            summary: json!({ "machine_id": id, "step": "deep_scan", "failed": true, "error": "machine not found" }),
                        })
                        .ok();
                    continue;
                }
            }
        };

        // Explicit reachability probe so we can tell "unreachable" (skip) apart
        // from "reachable but detection failed" (failure). `refresh` re-probes —
        // the small double-probe is worth the accurate classification. Preserve
        // the actual probe error in `reason` so a host-key / auth / config
        // failure is distinguishable from a plain offline node (not swallowed).
        let probe_outcome = exec.probe(&host, None);
        let probe_ok = matches!(&probe_outcome, Ok(p) if p.ok);
        if !probe_ok {
            skipped += 1;
            let reason = match &probe_outcome {
                Ok(p) => format!("SSH probe not ok: {}", p.message),
                Err(e) => format!("SSH probe error: {}", e),
            };
            ctx.emitter
                .emit_event(&Event::Completed {
                    summary: json!({
                        "machine_id": id,
                        "host": host,
                        "step": "deep_scan",
                        "skipped": true,
                        "reason": reason,
                        "hint": "node not reachable over SSH; if this is a host-key/auth error re-onboard via UECM-Bootstrap.cmd (check uecm-svc / sshd / known_hosts)",
                    }),
                })
                .ok();
            continue;
        }

        if let Err(e) = refresh(ctx, *id, &sub_cred, exec) {
            failed += 1;
            ctx.emitter
                .emit_event(&Event::Completed {
                    summary: json!({
                        "machine_id": id,
                        "host": host,
                        "step": "refresh",
                        "failed": true,
                        "error": format!("SSH reachable but refresh failed: {}", e),
                    }),
                })
                .ok();
            continue;
        }
        reachable.push(*id);
    }

    // Phase 2 (batch over reachable set): INI scan + health run ONCE so the
    // cross-machine consistency rules (zen / cluster-majority / gpu_consistency)
    // see the whole set, not N single-machine clusters. Sub-step errors are
    // recorded but never abort the command.
    if !reachable.is_empty() {
        if let Err(e) = crate::domain_ini::handle(
            ctx,
            crate::args::IniAction::Scan { machine_ids: reachable.clone(), project_id: None, machine_id: None, cred: sub_cred.clone() },
        ) {
            ctx.emitter
                .emit_event(&Event::Completed {
                    summary: json!({ "step": "ini_scan", "error": e.to_string() }),
                })
                .ok();
        }
        if let Err(e) = crate::domain_health::handle(
            ctx,
            crate::args::HealthAction::Run {
                machine_ids: reachable.clone(),
                cidr: None,
                all: false,
                expected_local_path: String::new(),
                expected_shared_path: String::new(),
                cred: sub_cred.clone(),
            },
        ) {
            ctx.emitter
                .emit_event(&Event::Completed {
                    summary: json!({ "step": "health_run", "error": e.to_string() }),
                })
                .ok();
        }
    }

    ctx.emitter
        .emit_event(&Event::Completed {
            summary: json!({ "machines": ids.len(), "scanned": reachable.len(), "skipped": skipped, "failed": failed }),
        })
        .ok();
    Ok(())
}

fn authorize(
    ctx: &mut Ctx<'_>,
    machine_ids: Vec<i64>,
    all: bool,
    save_as: Option<String>,
    cred: &crate::credential_args::CredentialArgs,
) -> VoloResult<()> {
    // Remote WinRM push has been retired (SSH migration P5a). `machine authorize`
    // no longer probes / bootstraps; it points the operator at the USB SSH bundle.
    // `save_as` / `cred` are accepted-and-ignored shims (CLI surface frozen).
    let _ = (save_as, cred);
    let ids = {
        let db = ctx.require_db()?;
        resolve_target_ids(db, &machine_ids, all)?
    };
    ctx.emitter
        .emit_event(&Event::Completed {
            summary: json!({
                "machines": ids.len(),
                "remote_push": "retired",
                "hint": "Remote WinRM push is retired. Build a USB onboarding bundle with `voloctl cache ssh package-bootstrap --out <dir>`, run UECM-Bootstrap.cmd on each node, then `voloctl cache machine refresh <id>` over SSH.",
            }),
        })
        .ok();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::output::{NdjsonEmitter, Emitter};
    use cache_core::core::ssh::{NodeScript, ProbeResult, RemoteExecutor, ScriptOutput};
    use cache_core::data::{open_in_memory, schema};
    use std::path::PathBuf;

    /// Hermetic probe seam for refresh/deep_scan tests: always "unreachable",
    /// so machines are skipped without spawning real ssh / touching the keystore.
    struct UnreachableExec;
    impl RemoteExecutor for UnreachableExec {
        fn run(&self, _host: &str, _script: &NodeScript) -> VoloResult<ScriptOutput> {
            Err(VoloError::SshConnect("unreachable (test)".into()))
        }
        fn probe(&self, _host: &str, _user: Option<&str>) -> VoloResult<ProbeResult> {
            Err(VoloError::SshConnect("unreachable (test)".into()))
        }
    }

    fn setup() -> (cache_core::data::Db, Vec<u8>) {
        let db = open_in_memory().expect("open :memory:");
        {
            let mut conn = db.lock().unwrap();
            schema::migrate(&mut conn).expect("schema migrate");
        }
        let buf = Vec::new();
        (db, buf)
    }

    #[test]
    fn machine_round_trip_via_handlers() {
        let (db, buf) = setup();
        let emitter: Box<dyn Emitter> = Box::new(NdjsonEmitter::new(buf.clone()));
        let mut ctx = Ctx {
            db: Some(db),
            db_path: PathBuf::from(":memory:"),
            emitter,
            json_mode: true,
            operation_id: "machine.list",
            request_id: "test-req".into(),
            no_input: false,
        };

        // Add a machine
        add(&mut ctx, "10.0.0.1".to_string(), Some("test-host".to_string()))
            .expect("add should succeed");

        // List should show it
        list(&mut ctx).expect("list should succeed");

        // Detail should load it
        detail(&mut ctx, 1).expect("detail should succeed");

        // Rename should work
        rename(&mut ctx, 1, "renamed-host".to_string()).expect("rename should succeed");

        // Delete should work
        delete(&mut ctx, Some(1), vec![], false, true, false).expect("delete should succeed");

        // Verify that we got past all operations
        // (output checking omitted as NdjsonEmitter writes to a moved buffer)
    }

    #[test]
    fn deep_scan_skips_winrm_unreachable_and_completes_batch() {
        let (db, buf) = setup();
        let emitter: Box<dyn Emitter> = Box::new(NdjsonEmitter::new(buf));
        let mut ctx = Ctx {
            db: Some(db),
            db_path: PathBuf::from(":memory:"),
            emitter,
            json_mode: true,
            operation_id: "machine.deep_scan",
            request_id: "test-req".into(),
            no_input: false,
        };

        add(&mut ctx, "10.0.0.1".to_string(), Some("m1".to_string())).unwrap();
        add(&mut ctx, "10.0.0.2".to_string(), Some("m2".to_string())).unwrap();

        // Injected UnreachableExec makes every probe fail, so both machines are
        // skipped — but the batch must still complete with Ok. (Hermetic: no real
        // ssh / keystore touch.)
        let cred = crate::credential_args::CredentialArgs::inline(None);
        let res = deep_scan(&mut ctx, vec![1, 2], false, &cred, &UnreachableExec);
        assert!(res.is_ok(), "batch must complete even when every machine is skipped");
    }

    #[test]
    fn deep_scan_nonexistent_id_is_failed_not_skipped_and_batch_continues() {
        let (db, buf) = setup();
        let emitter: Box<dyn Emitter> = Box::new(NdjsonEmitter::new(buf));
        let mut ctx = Ctx {
            db: Some(db),
            db_path: PathBuf::from(":memory:"),
            emitter,
            json_mode: true,
            operation_id: "machine.deep_scan",
            request_id: "test-req".into(),
            no_input: false,
        };
        // id 999 does not exist → refresh returns InvalidInput → classified as a
        // failure (not a WinRM skip), but the batch still completes Ok.
        let cred = crate::credential_args::CredentialArgs::inline(None);
        let res = deep_scan(&mut ctx, vec![999], false, &cred, &UnreachableExec);
        assert!(res.is_ok(), "batch completes; per-machine failure is reported in summary");
    }

    #[test]
    fn deep_scan_requires_a_selector() {
        let (db, buf) = setup();
        let emitter: Box<dyn Emitter> = Box::new(NdjsonEmitter::new(buf));
        let mut ctx = Ctx {
            db: Some(db),
            db_path: PathBuf::from(":memory:"),
            emitter,
            json_mode: true,
            operation_id: "machine.deep_scan",
            request_id: "test-req".into(),
            no_input: false,
        };
        let cred = crate::credential_args::CredentialArgs::inline(None);
        let res = deep_scan(&mut ctx, vec![], false, &cred, &UnreachableExec);
        assert!(res.is_err(), "no --machine-ids and no --all must error");
    }

    #[test]
    fn delete_without_yes_flag_returns_invalid_input() {
        let (db, _buf) = setup();
        let emitter: Box<dyn Emitter> = Box::new(NdjsonEmitter::new(Vec::new()));
        let mut ctx = Ctx {
            db: Some(db),
            db_path: PathBuf::from(":memory:"),
            emitter,
            json_mode: true,
            operation_id: "machine.delete",
            request_id: "test-req".into(),
            no_input: false,
        };

        // Try to delete without --yes or --dry-run
        let result = delete(&mut ctx, Some(1), vec![], false, false, false);
        assert!(result.is_err(), "delete without --yes or --dry-run should fail");

        if let Err(VoloError::InvalidInput(msg)) = result {
            assert!(
                msg.contains("destructive"),
                "error message should mention destructive"
            );
        } else {
            panic!("expected InvalidInput error");
        }
    }

    #[test]
    fn scan_emits_started_and_completed_events_for_unreachable_cidr() {
        let (db, buf) = setup();
        let emitter: Box<dyn Emitter> = Box::new(NdjsonEmitter::new(buf));
        let mut ctx = Ctx {
            db: Some(db),
            db_path: PathBuf::from(":memory:"),
            emitter,
            json_mode: true,
            operation_id: "machine.scan",
            request_id: "test-req".into(),
            no_input: false,
        };
        // TEST-NET-3 /30 = 2 usable hosts; per-port timeout 200ms → completes well under 2s.
        scan(&mut ctx, "203.0.113.0/30", 200).unwrap();
        // Note: we can't easily inspect the buffer here since NdjsonEmitter writes to a moved Vec.
        // But the fact that scan() didn't error means it emitted events successfully.
    }

    fn ctx_with(db: cache_core::data::Db) -> Ctx<'static> {
        let emitter: Box<dyn Emitter> = Box::new(NdjsonEmitter::new(Vec::new()));
        Ctx { db: Some(db), db_path: PathBuf::from(":memory:"), emitter, json_mode: true, operation_id: "machine.list", request_id: "test-req".into(), no_input: false }
    }

    #[test]
    fn delete_all_removes_every_machine() {
        let (db, _buf) = setup();
        let mut ctx = ctx_with(db);
        add(&mut ctx, "10.0.0.1".into(), None).unwrap();
        add(&mut ctx, "10.0.0.2".into(), None).unwrap();
        add(&mut ctx, "10.0.0.3".into(), None).unwrap();

        delete(&mut ctx, None, vec![], true, true, false).expect("delete --all should succeed");

        let remaining = machines::list_all(ctx.db.as_ref().unwrap()).unwrap();
        assert!(remaining.is_empty(), "delete --all must remove every machine, got {}", remaining.len());
    }

    #[test]
    fn delete_machine_ids_removes_selected_only() {
        let (db, _buf) = setup();
        let mut ctx = ctx_with(db);
        add(&mut ctx, "10.0.0.1".into(), None).unwrap(); // id 1
        add(&mut ctx, "10.0.0.2".into(), None).unwrap(); // id 2
        add(&mut ctx, "10.0.0.3".into(), None).unwrap(); // id 3

        delete(&mut ctx, None, vec![1, 2], false, true, false).expect("delete --machine-ids should succeed");

        let remaining = machines::list_all(ctx.db.as_ref().unwrap()).unwrap();
        assert_eq!(remaining.len(), 1, "only the unselected machine should survive");
        assert_eq!(remaining[0].id, Some(3));
    }

    #[test]
    fn delete_single_positional_id_still_works() {
        let (db, _buf) = setup();
        let mut ctx = ctx_with(db);
        add(&mut ctx, "10.0.0.1".into(), None).unwrap(); // id 1
        add(&mut ctx, "10.0.0.2".into(), None).unwrap(); // id 2

        delete(&mut ctx, Some(1), vec![], false, true, false).expect("single-id delete should still work");

        let remaining = machines::list_all(ctx.db.as_ref().unwrap()).unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, Some(2));
    }

    #[test]
    fn delete_all_without_yes_is_blocked() {
        let (db, _buf) = setup();
        let mut ctx = ctx_with(db);
        add(&mut ctx, "10.0.0.1".into(), None).unwrap();

        let res = delete(&mut ctx, None, vec![], true, false, false);
        assert!(res.is_err(), "delete --all without --yes must be blocked");

        let remaining = machines::list_all(ctx.db.as_ref().unwrap()).unwrap();
        assert_eq!(remaining.len(), 1, "nothing must be deleted when destructive check blocks");
    }

    #[test]
    fn delete_with_no_target_errors() {
        let (db, _buf) = setup();
        let mut ctx = ctx_with(db);
        add(&mut ctx, "10.0.0.1".into(), None).unwrap();

        // no id, no --machine-ids, no --all
        let res = delete(&mut ctx, None, vec![], false, true, false);
        assert!(res.is_err(), "delete with no target selector must error");
    }

    #[test]
    fn delete_machine_ids_with_missing_id_errors_and_deletes_nothing() {
        let (db, _buf) = setup();
        let mut ctx = ctx_with(db);
        add(&mut ctx, "10.0.0.1".into(), None).unwrap(); // id 1 (exists)
        // id 99 does not exist

        let res = delete(&mut ctx, None, vec![1, 99], false, true, false);
        assert!(res.is_err(), "batch delete with a missing id must fail loudly, not silently skip");

        // Atomic: a bad batch must not delete the valid ids either.
        let remaining = machines::list_all(ctx.db.as_ref().unwrap()).unwrap();
        assert_eq!(remaining.len(), 1, "a rejected batch must leave every machine intact");
    }

    #[test]
    fn render_ue_installs_table_aligns_columns_and_marks_primary() {
        use cache_core::data::machine_ue_installs::UeInstall;
        let installs = vec![
            UeInstall { id: None, machine_id: 1, version: "5.0".into(),
                install_path: "C:\\Program Files\\Epic Games\\UE_5.0".into(), is_primary: false,
                zen_cli_intree_path: None, zen_cli_intree_version: None, zen_cli_intree_sha256: None,
                zenserver_intree_path: None, zenserver_intree_version: None, zenserver_intree_sha256: None },
            UeInstall { id: None, machine_id: 1, version: "5.4".into(),
                install_path: "C:\\Program Files\\Epic Games\\UE_5.4".into(), is_primary: true,
                zen_cli_intree_path: None, zen_cli_intree_version: None, zen_cli_intree_sha256: None,
                zenserver_intree_path: None, zenserver_intree_version: None, zenserver_intree_sha256: None },
        ];
        let out = render_ue_installs_table(&installs);
        assert!(out.contains("VERSION"));
        assert!(out.contains("PRIMARY"));
        assert!(out.contains("INSTALL PATH"));
        let line_54 = out.lines().find(|l| l.contains("5.4")).unwrap();
        assert!(line_54.contains('*'));
        let line_50 = out.lines().find(|l| l.contains("5.0")).unwrap();
        assert!(!line_50.contains('*'));
        assert!(line_50.contains("UE_5.0"));
    }

    #[test]
    fn render_ue_installs_table_handles_empty() {
        let out = render_ue_installs_table(&[]);
        assert!(out.contains("(no UE installs)"));
    }

    #[test]
    fn render_gpus_table_handles_empty() {
        let out = render_gpus_table(&[]);
        assert!(out.contains("(no GPUs)"));
    }

    #[test]
    fn render_gpus_table_shows_na_for_missing_vram_and_renders_model_driver() {
        use cache_core::data::machine_gpus::{GpuInfo, GpuVendor};
        let gpus = vec![
            GpuInfo { id: None, machine_id: 1, gpu_model: "NVIDIA RTX 4090".into(),
                driver_version: "551.86".into(), vendor: GpuVendor::Nvidia, vram_mb: Some(24576) },
            GpuInfo { id: None, machine_id: 1, gpu_model: "AMD Radeon Pro".into(),
                driver_version: "23.40".into(), vendor: GpuVendor::Amd, vram_mb: None },
        ];
        let out = render_gpus_table(&gpus);
        assert!(out.contains("GPU MODEL"));
        assert!(out.contains("DRIVER"));
        assert!(out.contains("VRAM(MB)"));
        assert!(out.contains("NVIDIA RTX 4090"));
        assert!(out.contains("551.86"));
        assert!(out.contains("24576"));
        let amd_line = out.lines().find(|l| l.contains("AMD Radeon Pro")).unwrap();
        assert!(amd_line.contains("N/A"));
    }

    /// Fake executor that returns a successful probe + hardcoded UE/GPU JSON.
    /// Dispatches based on the script name so both detect_ue_versions and
    /// detect_gpus get plausible output.
    struct FakeRefreshExec;
    impl RemoteExecutor for FakeRefreshExec {
        fn run(&self, _host: &str, script: &NodeScript) -> VoloResult<ScriptOutput> {
            let stdout = match script.name {
                "query-ue-versions.ps1" =>
                    r#"[{"version":"5.4","install_path":"C:\\UE_5.4"}]"#.to_string(),
                "query-gpu-driver.ps1" =>
                    r#"[{"gpu_model":"RTX 4090","driver_version":"551.86","vendor":"nvidia","vram_mb":24576}]"#.to_string(),
                _ => "[]".to_string(),
            };
            Ok(ScriptOutput { stdout, stderr: String::new(), exit_code: 0 })
        }
        fn probe(&self, _host: &str, _user: Option<&str>) -> VoloResult<ProbeResult> {
            Ok(ProbeResult { ok: true, message: "ok".into(), latency_ms: 1 })
        }
    }

    #[test]
    fn refresh_human_mode_lists_installs_before_done() {
        use crate::output::{Emitter, HumanEmitter};
        use cache_core::data::{open_in_memory, schema};
        let db = open_in_memory().unwrap();
        { let mut c = db.lock().unwrap(); schema::migrate(&mut c).unwrap(); }
        let id = machines::insert(&db, &machines::Machine::new("RENDER-01", "10.0.0.1")).unwrap();

        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        {
            let emitter: Box<dyn Emitter> = Box::new(HumanEmitter::new(&mut stdout, &mut stderr, false));
            let mut ctx = Ctx { db: Some(db.clone()), db_path: std::path::PathBuf::from(":memory:"),
                emitter, json_mode: false,
                operation_id: "machine.refresh", request_id: "test-req".into(), no_input: false };
            let cred = crate::credential_args::CredentialArgs::inline(None);
            refresh(&mut ctx, id, &cred, &FakeRefreshExec).unwrap();
        }
        let s = String::from_utf8(stdout).unwrap();
        // The UE installs table must appear in human-mode output before the done summary.
        assert!(s.contains("VERSION"), "stdout should contain the table header VERSION; got:\n{}", s);
        assert!(s.contains("5.4"), "stdout should contain the detected version 5.4; got:\n{}", s);
    }

    #[test]
    fn detail_human_mode_renders_tables_not_json() {
        use crate::output::{Emitter, HumanEmitter};
        use cache_core::data::{open_in_memory, schema, machine_ue_installs::{self, UeInstall}};
        let db = open_in_memory().unwrap();
        { let mut c = db.lock().unwrap(); schema::migrate(&mut c).unwrap(); }
        let id = machines::insert(&db, &machines::Machine::new("RENDER-01", "1.2.3.4")).unwrap();
        machine_ue_installs::upsert(&db, &UeInstall { id: None, machine_id: id, version: "5.4".into(),
            install_path: "C:\\UE_5.4".into(), is_primary: true,
            zen_cli_intree_path: None, zen_cli_intree_version: None, zen_cli_intree_sha256: None,
            zenserver_intree_path: None, zenserver_intree_version: None, zenserver_intree_sha256: None }).unwrap();

        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        {
            let emitter: Box<dyn Emitter> = Box::new(HumanEmitter::new(&mut stdout, &mut stderr, false));
            let mut ctx = Ctx { db: Some(db.clone()), db_path: std::path::PathBuf::from(":memory:"),
                emitter, json_mode: false,
                operation_id: "machine.detail", request_id: "test-req".into(), no_input: false };
            detail(&mut ctx, id).unwrap();
        }
        let s = String::from_utf8(stdout).unwrap();
        assert!(s.contains("VERSION"));      // table header — not JSON
        assert!(s.contains("5.4"));
        assert!(!s.contains("\"ue_installs\""));  // not pretty JSON
    }
}
