//! Shared zen-server *operations* helpers — the pure business-logic layer
//! that both the CLI (`volo-cli`'s `domain_zen`) and the Tauri commands
//! (`src-tauri`'s `commands::zen`) drive. Extracted here in step 2c so the two
//! surfaces share one source of truth instead of the GUI command reaching into
//! the CLI crate (which is now a separate binary crate it cannot import from).
//!
//! Everything here is DB / sidecar plumbing + input validation; no `clap`,
//! no NDJSON emitter, no `tauri` — keeping cache-core zero-tauri.

use crate::core::zen::lua_config::{self, UpstreamInfo};
use crate::core::zen::redaction::redact;
use crate::data::{machines, operations, Db, Machine, ZenEndpoint};
use crate::core::zen::endpoint as zen_endpoint;
use crate::error::{VoloError, VoloResult};

/// Default Windows service name for zenserver.
///
/// **Not** `"ZenServer"` — UE's `ConditionalUpdateSystemServiceInstall()`
/// hardcodes that name and tries to update/uninstall the service when the
/// ImagePath doesn't match the running UE version's expectations. Using a
/// distinct name makes the Volo-managed service invisible to UE's built-in
/// service management so multiple UE versions (5.7, 5.8, …) can all connect
/// to it via HTTP without triggering conflict dialogs.
pub const DEFAULT_SERVICE_NAME: &str = "VoloZenServer";

/// Apply Plan §1.1 defaults when the operator didn't pin lifecycle:
/// `shared_upstream` requires `installed_service` (T2.1 enforces),
/// `local` defaults to `editor_owned`. Pass-through for anything else so the
/// validator in `core::zen::endpoint::register` produces the canonical error.
///
/// `pub(crate)` so the T2.6 Tauri command wrappers in `commands::zen` reuse
/// the same default-derivation rule and don't drift from the CLI.
pub fn default_lifecycle_for(role: &str) -> &'static str {
    match role {
        crate::core::zen::endpoint::ROLE_SHARED_UPSTREAM => "installed_service",
        _ => "editor_owned",
    }
}

/// Resolve the upstream UpstreamInfo for an endpoint that has
/// `upstream_endpoint_id = Some(_)`. Returns `Ok(None)` when the row has no
/// upstream pointer (consumer should pass `None` to `lua_config::render`).
pub fn resolve_upstream_info(db: &Db, ep: &ZenEndpoint) -> VoloResult<Option<UpstreamInfo>> {
    let Some(upstream_id) = ep.upstream_endpoint_id else {
        return Ok(None);
    };
    let upstream = zen_endpoint::get(db, upstream_id)?.ok_or_else(|| {
        VoloError::InvalidInput(format!(
            "endpoint id={} references upstream id={} which no longer exists",
            ep.id.unwrap_or(-1),
            upstream_id,
        ))
    })?;
    let upstream_machine = machines::find_by_id(db, upstream.machine_id)?.ok_or_else(|| {
        VoloError::InvalidInput(format!(
            "upstream endpoint id={} points at machine id={} which is missing",
            upstream_id, upstream.machine_id,
        ))
    })?;
    Ok(Some(UpstreamInfo {
        scheme: upstream.scheme,
        host: upstream_machine.ip,
        declared_port: upstream.declared_port,
    }))
}

pub fn render_lua_for(db: &Db, endpoint_id: i64) -> VoloResult<(ZenEndpoint, String)> {
    let ep = zen_endpoint::get(db, endpoint_id)?.ok_or_else(|| {
        VoloError::InvalidInput(format!("endpoint id={} not found", endpoint_id))
    })?;
    let upstream = resolve_upstream_info(db, &ep)?;
    let lua = lua_config::render(&ep, upstream.as_ref())?;
    Ok((ep, lua))
}

/// Codex P2 fix: don't trust the sidecar's `ok: true` alone — compare the
/// returned `sha256` against the local hash of the Lua text we asked it to
/// write. A stale/buggy/MITM'd sidecar that returns `ok: true` with
/// truncated or modified bytes would otherwise leave a different `zen.lua`
/// on disk than what we logged as written.
///
/// Also cross-checks `bytes_written` against the source length so a sidecar
/// that hashes the original bytes but truncates on write can't escape
/// detection (the read-back size in T2.4 reads `Get-Item Length`, so the
/// number reflects the *written* file, not the input string).
pub fn verify_write_response(
    response: &serde_json::Value,
    expected_sha: &str,
    expected_bytes: usize,
) -> VoloResult<serde_json::Value> {
    let remote_sha = response
        .get("sha256")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            VoloError::PowerShell(
                "zen-write-lua-config: missing sha256 field in success envelope".into(),
            )
        })?;
    if !remote_sha.eq_ignore_ascii_case(expected_sha) {
        return Err(VoloError::PowerShell(format!(
            "zen-write-lua-config: remote sha256 {remote_sha} does not match locally rendered {expected_sha} \
             — the file on disk does NOT match the requested config",
        )));
    }
    let remote_bytes = response
        .get("bytes_written")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| {
            VoloError::PowerShell(
                "zen-write-lua-config: missing bytes_written field in success envelope".into(),
            )
        })?;
    if remote_bytes != expected_bytes as i64 {
        return Err(VoloError::PowerShell(format!(
            "zen-write-lua-config: remote bytes_written={remote_bytes} does not match local len={expected_bytes}"
        )));
    }
    Ok(response.clone())
}

pub fn invoke_write_lua(
    host: &str,
    lua_text: &str,
    dest_path: &str,
    creds: Option<&(String, String)>,
) -> VoloResult<serde_json::Value> {
    // SSH key auth (uecm-svc); operator creds ignored (param kept as a shim).
    let _ = creds;
    let raw = run_node(
        host,
        "zen-write-lua-config.ps1",
        serde_json::json!({ "LuaText": lua_text, "DestPath": dest_path }),
    )?;
    parse_envelope(&raw, "zen-write-lua-config")
}

/// Write `lua` to `dest_path` on `host` and verify the SHA256 read-back,
/// recording the operation regardless of outcome. Shared by the CLI's
/// `apply_config`/`gc_set` and the Tauri `zen_apply_config`/
/// `zen_update_gc_settings` — all four derive `lua`/`dest_path` the same way
/// and push them with the identical redact/operations::start/
/// invoke_write_lua/verify/finalize_op sequence, so this lives once here
/// instead of being hand-rolled at each of the four call sites (where it
/// would silently drift if the write/verify contract ever changed).
pub fn write_and_verify_lua(
    db: &Db,
    machine_id: i64,
    host: &str,
    lua: &str,
    dest_path: &str,
    creds: Option<(String, String)>,
    op_kind: &'static str,
) -> VoloResult<(String, serde_json::Value)> {
    let invocation = redact(&format!(
        "zen-write-lua-config.ps1 -DestPath {dest_path} (lua {} bytes)",
        lua.len()
    ));
    let op_id = operations::start(db, op_kind, &[machine_id])?;
    let expected_sha = sha256_hex_of(lua);
    let result = invoke_write_lua(host, lua, dest_path, creds.as_ref())
        .and_then(|response| verify_write_response(&response, &expected_sha, lua.len()));
    finalize_op(db, op_id, &result, &invocation);
    let response = result?;
    Ok((expected_sha, response))
}

/// Directory component of a remote Windows path (string-level backslash/
/// forward-slash split — describes a path on the remote host, not the local
/// OS Volo runs on).
fn win_dirname(path: &str) -> VoloResult<&str> {
    path.rfind(['\\', '/']).map(|idx| &path[..idx]).ok_or_else(|| {
        VoloError::InvalidInput(format!("{path:?} has no directory component"))
    })
}

/// Copy the detected zen.exe's sibling zenserver.exe to `resolved.target_exe`
/// when `resolved.needs_copy` is set (install_dir made a directory other than
/// the detected binary's location authoritative) — no-op returning `Ok(None)`
/// otherwise. Shared by the CLI's `apply_config` and the Tauri
/// `zen_apply_config` — the only two callers that ever perform a copy
/// (`service install` / `gc_set` use `resolve_service_paths`, which never
/// copies, on the assumption `zen_apply_config` already ran first).
pub fn copy_binary_if_needed(
    db: &Db,
    machine_id: i64,
    host: &str,
    resolved: &ResolvedZenPaths,
) -> VoloResult<Option<serde_json::Value>> {
    if !resolved.needs_copy {
        return Ok(None);
    }
    let source_dir = win_dirname(&resolved.source_exe)?;
    let target_dir = win_dirname(&resolved.target_exe)?;
    let invocation = redact(&format!(
        "zen-copy-binary.ps1 -SourceDir {source_dir} -TargetDir {target_dir}"
    ));
    let op_id = operations::start(db, "zen.apply_config.copy_binary", &[machine_id])?;
    let result = run_node(
        host,
        "zen-copy-binary.ps1",
        serde_json::json!({ "SourceDir": source_dir, "TargetDir": target_dir }),
    )
    .and_then(|raw| parse_envelope(&raw, "zen-copy-binary"));
    finalize_op(db, op_id, &result, &invocation);
    Ok(Some(result?))
}

/// Stop then start the ZenServer Windows service so a rewritten
/// `zen_config.lua` actually takes effect (Zen doesn't hot-reload the config
/// file) — shared by the CLI's `gc_set` and the Tauri
/// `zen_update_gc_settings`, the only two callers that restart a running
/// service after a config rewrite. Stop is best-effort (a service that's
/// already stopped shouldn't block the start that matters); a failed start
/// is fatal — the whole point of restarting is to come back up on the new
/// config.
pub fn restart_service(db: &Db, machine_id: i64, host: &str) -> VoloResult<()> {
    let stop_invocation = redact(&format!("zen-down.ps1 -ServiceName {DEFAULT_SERVICE_NAME}"));
    let stop_op_id = operations::start(db, "zen.gc_settings_update.stop", &[machine_id])?;
    let stop_result = run_node(
        host,
        "zen-down.ps1",
        serde_json::json!({ "ServiceName": DEFAULT_SERVICE_NAME }),
    )
    .and_then(|raw| parse_envelope(&raw, "zen-down.ps1"));
    finalize_op(db, stop_op_id, &stop_result, &stop_invocation);

    let start_invocation = redact(&format!("zen-up.ps1 -ServiceName {DEFAULT_SERVICE_NAME}"));
    let start_op_id = operations::start(db, "zen.gc_settings_update.start", &[machine_id])?;
    let start_result = run_node(
        host,
        "zen-up.ps1",
        serde_json::json!({ "ServiceName": DEFAULT_SERVICE_NAME }),
    )
    .and_then(|raw| parse_envelope(&raw, "zen-up.ps1"));
    finalize_op(db, start_op_id, &start_result, &start_invocation);
    start_result?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
/// Pick the zen.exe to hand `zen service install` for an `installed_service`
/// endpoint, preferring the in-tree UE binary over the user-private install copy.
///
/// Bug 4 (2026-06-05 lanPC E2E, see
/// docs/research/2026-06-05-zen-service-install-e2e-findings.md): zen hardcodes
/// the service account to `NT AUTHORITY\LocalService` (zenutil/service.cpp:441)
/// and registers the sibling `zenserver.exe` of whichever zen.exe it is run with
/// (zen/cmds/service_cmd.cpp:431-437). `LocalService` is a member of
/// `BUILTIN\Users`, so it can only start a zenserver.exe whose ACL grants
/// `BUILTIN\Users:(RX)`. The in-tree copy under the UE install dir (Program
/// Files) grants that; the install copy under
/// `%LOCALAPPDATA%\UnrealEngine\Common\Zen\Install` grants only the owning UE
/// user + SYSTEM + Admins, so a service installed from it dies on start. Prefer
/// the in-tree binary; fall back to the install copy only when no UE in-tree
/// binary was detected.
pub fn pick_service_zen_exe(
    intree_cli: Option<String>,
    install_copy_cli: Option<String>,
) -> Option<String> {
    intree_cli.or(install_copy_cli)
}

/// ZEN-3: build the advisory co-location warning for `zen service install`.
///
/// `ue_runtime_user` is only set (via `machine set-ue-user`) on machines an
/// operator treats as interactive UE workstations. The shared ZenServer
/// service is meant to run on a dedicated server; co-locating it with an
/// editor-managed local Zen invites the port/ownership contention that BUG-5
/// resolved by splitting the two layers. Returns `None` for dedicated servers
/// (no `ue_runtime_user`). Pure DB read so the policy is unit-testable without
/// the SSH/SCM apply path.
pub fn workstation_colocation_warning(
    db: &Db,
    machine_id: i64,
) -> VoloResult<Option<String>> {
    Ok(machines::get_ue_runtime_user(db, machine_id)?.map(|user| {
        format!(
            "machine id={machine_id} looks like a UE workstation (ue_runtime_user={user:?} is \
             set); installing the shared ZenServer service here is not recommended — run it on a \
             dedicated server so it doesn't contend with the workstation's editor-managed local \
             Zen. Proceeding because this check is advisory only."
        )
    }))
}

/// Build the canonical `<scheme>://*:<port>/` reservation URL for an endpoint.
///
/// Must use `*` (strong wildcard), not `+`, to match zen's http.sys
/// `HttpAddUrl` registrations. A `+` reservation without a matching `+`
/// registration hijacks IP-based requests and yields http.sys HTTP 503 on probe.
pub fn url_prefix_for(ep: &ZenEndpoint) -> String {
    format!("{}://*:{}/", ep.scheme, ep.declared_port)
}

/// Whether a netsh URL ACL reservation is required for this service principal.
///
/// `LocalSystem` already has sufficient privilege to bind http.sys URLs; adding
/// a reservation also conflicts with zen's `http://*:<port>/` registration.
pub fn urlacl_needed_for(principal: &str) -> bool {
    let t = principal.trim().to_ascii_lowercase();
    !matches!(
        t.as_str(),
        "localsystem"
            | "nt authority\\system"
            | "nt authority\\localsystem"
            | ".\\localsystem"
    )
}

/// Resolve the zen.exe Volo hands `zen service install` for `machine_id`
/// (in-tree UE binary preferred over the user-private install copy — see
/// [`pick_service_zen_exe`]). Shared by `zen_apply_config` and
/// `zen_service_install` (CLI + Tauri) so both derive `{ZenInstall}` the
/// same way and can never disagree on where zenserver.exe lives.
pub fn resolve_service_zen_exe(db: &Db, machine_id: i64) -> VoloResult<String> {
    let install = crate::data::machine_zen_install::find(db, machine_id)?;
    let intree_cli = crate::data::machine_ue_installs::list_for_machine(db, machine_id)
        .ok()
        .and_then(|installs| installs.into_iter().find_map(|i| i.zen_cli_intree_path));
    pick_service_zen_exe(intree_cli, install.as_ref().and_then(|m| m.zen_cli_path.clone())).ok_or_else(|| {
        VoloError::InvalidInput(format!(
            "machine id={machine_id} has no zen.exe recorded — run \
             `machine refresh {machine_id}` then `zen detect-binary --machine {machine_id}` first"
        ))
    })
}

/// Derive the fixed `zen_config.lua` destination Epic's official guide
/// requires (source cited in `core::zen::lua_config`'s module doc): alongside
/// zenserver.exe in `{ZenInstall}`. The service is launched with
/// `--config={ZenInstall}\zen_config.lua` and nothing else tells zenserver
/// where to find its config, so `zen_apply_config` (write) and
/// `zen_service_install` (launch)
/// MUST derive the identical path from the same zen_exe — an operator-chosen
/// override here would silently detach the written config from the running
/// service, exactly like the pre-fix `zen.lua`-at-an-arbitrary-path scheme
/// this replaces. String-level backslash/forward-slash splitting (not
/// `std::path::Path`) because this path describes a remote Windows host, not
/// the local OS Volo happens to run on.
pub fn zen_config_lua_path(zen_exe_path: &str) -> VoloResult<String> {
    match zen_exe_path.rfind(|c| c == '\\' || c == '/') {
        Some(idx) => Ok(format!("{}\\zen_config.lua", &zen_exe_path[..idx])),
        None => Err(VoloError::InvalidInput(format!(
            "cannot derive zen_config.lua location: {zen_exe_path:?} has no directory component"
        ))),
    }
}

/// `resolve_service_zen_exe` + `zen_config_lua_path` in one call — the two
/// are always used as a pair (CLI's `apply_config`/`service_install`, Tauri's
/// `zen_apply_config`/`zen_service_install`), so callers get both values
/// without repeating the pairing at each of the 4 call sites.
pub fn resolve_zen_exe_and_config_path(db: &Db, machine_id: i64) -> VoloResult<(String, String)> {
    let zen_exe = resolve_service_zen_exe(db, machine_id)?;
    let config_path = zen_config_lua_path(&zen_exe)?;
    Ok((zen_exe, config_path))
}

/// Where `zenserver.exe` + `zen_config.lua` for an endpoint actually live,
/// install-dir-aware.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedZenPaths {
    /// The zen.exe `zen detect-binary` found (in-tree or install-copy).
    /// Always populated — it's the copy source when `needs_copy` is true, and
    /// equal to `target_exe` when it's already in the right place.
    pub source_exe: String,
    /// Where `zenserver.exe` must be for the service to launch it.
    pub target_exe: String,
    /// Where `zen_config.lua` must be, alongside `target_exe`.
    pub target_config: String,
    /// `true` iff `source_exe` and `target_exe` differ and the caller must
    /// copy the binary there before writing the config / installing the
    /// service.
    pub needs_copy: bool,
}

/// Install-dir-aware counterpart to [`resolve_zen_exe_and_config_path`].
///
/// `endpoint.install_dir == None` (rows from before this field existed, or
/// an operator who never set it) preserves the exact legacy behavior: derive
/// everything from wherever `zen detect-binary` found a usable zen.exe, no
/// copy involved.
///
/// `endpoint.install_dir == Some(dir)` makes `dir` authoritative — `dir` is
/// the `{ZenInstall}` Epic's guide describes, independent of wherever the
/// source binary happens to sit today (typically the UE-intree copy). The
/// caller (`zen_apply_config`) is responsible for actually copying
/// `source_exe` to `target_exe` when `needs_copy` is true, *before* writing
/// `target_config` — this function only resolves paths, it does no I/O.
pub fn resolve_install_paths(db: &Db, endpoint: &ZenEndpoint) -> VoloResult<ResolvedZenPaths> {
    let source_exe = resolve_service_zen_exe(db, endpoint.machine_id)?;
    let mut resolved = match endpoint.install_dir.as_deref() {
        None => {
            let target_config = zen_config_lua_path(&source_exe)?;
            ResolvedZenPaths {
                target_exe: source_exe.clone(),
                source_exe,
                target_config,
                needs_copy: false,
            }
        }
        Some(dir) => {
            let (target_exe, target_config) = install_dir_target_paths(dir)?;
            // `source_exe` is the *detected* zen.exe (zen_cli_intree_path /
            // zen_cli_path), never zenserver.exe itself — comparing the two
            // full paths would compare "...\zen.exe" against
            // "...\zenserver.exe" and never match, making needs_copy always
            // true. What actually matters is whether the detected binary's
            // DIRECTORY already is `dir`: zen-service-install.ps1 resolves
            // zenserver.exe as zen.exe's sibling, so if zen.exe already lives
            // in `dir`, so does its sibling zenserver.exe, and no copy is
            // needed.
            let trimmed_dir = dir.trim().trim_end_matches(['\\', '/']);
            let source_dir = source_exe.rfind(['\\', '/']).map(|idx| &source_exe[..idx]);
            let needs_copy = match source_dir {
                Some(sd) => !paths_equal_ci(sd, trimmed_dir),
                None => true,
            };
            ResolvedZenPaths {
                source_exe,
                target_exe,
                target_config,
                needs_copy,
            }
        }
    };

    // Manual override takes precedence over the install_dir-derived path.
    // Both `zen_apply_config` (write) and `zen_service_install` (launch via
    // `--config=`) call this same resolver, so an override here can never
    // desync the write location from the launch location — unlike an
    // ad-hoc per-call override would.
    apply_config_path_override(endpoint, &mut resolved.target_config)?;

    Ok(resolved)
}

/// Lightweight counterpart to [`resolve_install_paths`] for callers that
/// only need `target_exe`/`target_config` and never copy a binary — service
/// install and GC-settings updates, which assume `zen_apply_config` already
/// ran and put zenserver.exe wherever it needs to be.
///
/// Unlike `resolve_install_paths`, this does NOT call
/// [`resolve_service_zen_exe`] (and therefore does not require
/// `machine_zen_install`/`machine_ue_installs` detection metadata to exist)
/// when `endpoint.install_dir` is `Some` — `install_dir` alone is
/// authoritative for these paths, so a routine service-install or GC update
/// on an endpoint that's already running shouldn't fail just because the
/// machine's zen-detection metadata later went stale (engine reinstalled,
/// row never repopulated after a rescan, etc). Detection is only needed —
/// and only then does this function require it — on the legacy
/// `install_dir == None` path, exactly like `resolve_install_paths`.
pub fn resolve_service_paths(db: &Db, endpoint: &ZenEndpoint) -> VoloResult<(String, String)> {
    let (target_exe, mut target_config) = match endpoint.install_dir.as_deref() {
        Some(dir) => install_dir_target_paths(dir)?,
        None => {
            let zen_exe = resolve_service_zen_exe(db, endpoint.machine_id)?;
            let config = zen_config_lua_path(&zen_exe)?;
            (zen_exe, config)
        }
    };
    apply_config_path_override(endpoint, &mut target_config)?;
    Ok((target_exe, target_config))
}

/// Shared by [`resolve_install_paths`] and [`resolve_service_paths`]: derive
/// `{dir}\zenserver.exe` / `{dir}\zen_config.lua` from a trimmed
/// `install_dir`, rejecting a blank value.
fn install_dir_target_paths(dir: &str) -> VoloResult<(String, String)> {
    let dir = dir.trim().trim_end_matches(['\\', '/']);
    if dir.is_empty() {
        return Err(VoloError::InvalidInput(
            "install_dir is blank — clear it to None instead of an empty string".into(),
        ));
    }
    Ok((format!("{dir}\\zenserver.exe"), format!("{dir}\\zen_config.lua")))
}

/// Shared by [`resolve_install_paths`] and [`resolve_service_paths`]: apply
/// `endpoint.config_path_override` on top of an install_dir-derived config
/// path, if set.
fn apply_config_path_override(endpoint: &ZenEndpoint, target_config: &mut String) -> VoloResult<()> {
    if let Some(override_path) = endpoint.config_path_override.as_deref() {
        let trimmed = override_path.trim();
        if trimmed.is_empty() {
            return Err(VoloError::InvalidInput(
                "config_path_override is blank — clear it to None instead of an empty string"
                    .into(),
            ));
        }
        *target_config = trimmed.to_string();
    }
    Ok(())
}

/// Windows paths are case-insensitive and `\`/`/` are interchangeable as
/// separators; compare on that basis so `D:\Zen\zenserver.exe` and
/// `d:/zen/ZenServer.exe` are recognized as the same file.
fn paths_equal_ci(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.replace('/', "\\").to_ascii_lowercase();
    norm(a) == norm(b)
}

/// Run a staged node-pure zen script over SSH (`-File`), args via stdin JSON.
/// Returns stdout (the `{ok,...}` envelope; the script's `ok` flag is the source
/// of truth, so a non-zero exit still surfaces its stdout — mirrors the old
/// run_remote contract). SSH key auth (uecm-svc); operator creds are gone.
/// Replaces build_param_script + run_remote (WinRM) as zen migrates in P2.
/// pub(crate) so the Tauri `commands/zen.rs` backend reuses the same SSH path.
pub fn run_node(host: &str, script_name: &'static str, args: serde_json::Value) -> VoloResult<String> {
    use crate::core::ssh::RemoteExecutor;
    let exec = crate::core::ssh::SshExecutor::from_config()?;
    let out = exec.run(
        host,
        &crate::core::ssh::NodeScript { name: script_name, args, ssh_user: None },
    )?;
    if out.stdout.trim().is_empty() && out.exit_code != 0 {
        return Err(crate::core::ssh::map_exit(out.exit_code, &out.stderr));
    }
    Ok(out.stdout)
}

/// Parse a `{ ok: bool, ... }` envelope from a sidecar. Hardened per codex
/// review: ONLY treat `ok == true` (exactly the boolean `true`) as success.
/// Missing `ok`, `ok = null`, `ok = "true"` (string), or `ok = false` are all
/// failures. Anything else is a stale/overridden sidecar or a corrupted
/// envelope; surfacing it as "success" would let bad remote state masquerade
/// as a successful operation.
pub fn parse_envelope(raw: &str, sidecar: &str) -> VoloResult<serde_json::Value> {
    let envelope: serde_json::Value = serde_json::from_str(raw).map_err(|e| {
        VoloError::PowerShell(format!(
            "{sidecar} returned non-JSON output: {e}; raw: {}",
            raw.chars().take(200).collect::<String>()
        ))
    })?;
    match envelope.get("ok").and_then(|v| v.as_bool()) {
        Some(true) => Ok(envelope),
        Some(false) => {
            let msg = envelope
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown sidecar error");
            let detail = envelope
                .get("netsh_combined")
                .and_then(|v| v.as_str())
                .filter(|s| !s.trim().is_empty())
                .map(|s| format!(" ({})", s.trim()))
                .unwrap_or_default();
            Err(VoloError::PowerShell(format!("{sidecar}: {msg}{detail}")))
        }
        None => {
            // `ok` missing OR present-but-non-bool (e.g. `ok: null`, `ok: "true"`).
            // Treat as protocol violation, not success.
            Err(VoloError::PowerShell(format!(
                "{sidecar} returned envelope without a boolean `ok` field; raw: {}",
                raw.chars().take(200).collect::<String>()
            )))
        }
    }
}

/// Mirror `zen-service-install.ps1`'s `DataDir` validation: fully-qualified
/// drive-absolute or UNC, no device namespace, no forbidden system roots.
/// Stricter than `validate_data_dir_safe` because it also requires the path
/// to be absolute (the sidecar refuses `C:ZenCache` and `\ZenCache` outright).
/// Returns true if `user` names a Windows built-in service account that
/// requires no password. Mirrors `Normalize-Account` in
/// `zen-service-install.ps1`: accepts both short forms (`LocalSystem`,
/// `.\\LocalService`) and long forms (`NT AUTHORITY\\LocalService`).
pub fn is_builtin_service_account(user: &str) -> bool {
    let t = user.trim().to_ascii_lowercase();
    matches!(
        t.as_str(),
        "localsystem"
            | "nt authority\\system"
            | "nt authority\\localsystem"
            | ".\\localsystem"
            | "localservice"
            | "nt authority\\localservice"
            | ".\\localservice"
            | "networkservice"
            | "nt authority\\networkservice"
            | ".\\networkservice"
    )
}

/// Group Managed Service Accounts are named with a trailing `$` by Windows
/// convention (e.g. `CONTOSO\zen-svc$`) — this is how AD and the SCM tell a
/// gMSA apart from a regular account. A gMSA's password is managed
/// automatically by the domain controller and rotated on its own schedule;
/// `sc create` never takes a password for one (the account's AD object grants
/// the target computer's machine account permission to retrieve it directly).
///
/// **Not independently verified against a real AD domain in this repo** (no
/// domain environment available to test against) — this follows Microsoft's
/// published gMSA + Windows-service documentation. Verify on real
/// infrastructure before relying on it in production.
///
/// Requires a domain qualifier — `DOMAIN\name$` or the UPN form
/// `name$@domain.suffix` — in addition to the trailing `$` on the account
/// name portion. A bare `name$` is accepted by `sc create` syntactically but
/// is indistinguishable from an operator typo on a local account that
/// happens to end in `$` (e.g. a hand-typed test account). Requiring the
/// qualifier matches how every gMSA name this app itself constructs looks
/// (`domUser` is always `DOMAIN\user` in the UI) and closes off the
/// accidental "local account + no password" bypass this check exists to
/// prevent.
pub fn is_gmsa_account(user: &str) -> bool {
    let trimmed = user.trim();
    if let Some(idx) = trimmed.find('\\') {
        return idx > 0 && trimmed[idx + 1..].ends_with('$');
    }
    if let Some(idx) = trimmed.find('@') {
        return idx > 0 && trimmed[..idx].ends_with('$');
    }
    false
}

/// Validate the service-account / password coherency the PS sidecar will
/// enforce. Returning the error from here (instead of only the sidecar)
/// makes `--dry-run` reflect what real `--yes` apply would do.
///
/// Codex P3: callers historically passed `password.is_some()`, which
/// treated `Some("")` as supplied even though the sidecar's
/// `[string]::IsNullOrEmpty($ServicePassword)` check rejects it. Take the
/// password string here (rather than a bool) and coerce empty/whitespace
/// to "missing" so dry-run mirrors apply.
pub fn validate_service_account_pair(
    service_user: Option<&str>,
    service_pass: Option<&str>,
    service_pass_stdin: bool,
) -> VoloResult<()> {
    let Some(u) = service_user else {
        return Ok(());
    };
    if u.trim().is_empty() {
        return Ok(());
    }
    let pass_supplied = service_pass.map(|p| !p.is_empty()).unwrap_or(false)
        || service_pass_stdin;
    if !is_builtin_service_account(u) && !is_gmsa_account(u) && !pass_supplied {
        return Err(VoloError::InvalidInput(format!(
            "service_user {u:?} is not a Windows built-in account or a gMSA \
             (trailing '$'); a password is required (built-in accounts: \
             LocalSystem / LocalService / NetworkService). Pass \
             --service-pass / --service-pass-stdin, or pick a built-in/gMSA \
             account."
        )));
    }
    Ok(())
}

pub fn validate_service_data_dir(p: &str) -> VoloResult<()> {
    let trimmed = p.trim();
    if trimmed.is_empty() {
        return Err(VoloError::InvalidInput(
            "service data_dir is empty — re-register the endpoint with a valid path".into(),
        ));
    }
    if trimmed.starts_with(r"\\?\")
        || trimmed.starts_with(r"\\.\")
        || trimmed.starts_with("//?/")
        || trimmed.starts_with("//./")
    {
        return Err(VoloError::InvalidInput(format!(
            "service data_dir {p:?} uses a Win32 device namespace prefix; \
             re-register without the prefix"
        )));
    }
    let bytes = trimmed.as_bytes();
    let is_drive_abs = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/');
    let is_unc = trimmed.starts_with(r"\\") || trimmed.starts_with("//");
    if !(is_drive_abs || is_unc) {
        return Err(VoloError::InvalidInput(format!(
            "service data_dir must be a fully-qualified absolute path \
             (e.g. 'D:\\ZenCache' or '\\\\host\\share\\Zen'); \
             drive-relative / root-relative paths are rejected by zen.exe. Got: {p}"
        )));
    }
    // Reuse the system-root + traversal guard.
    validate_data_dir_safe(trimmed)
}

/// Shared "is this canonicalized path under one of these forbidden system
/// roots" check for `validate_data_dir_safe` and `validate_dest_path`. The
/// two intentionally use DIFFERENT root lists (`data_dir` still forbids
/// Program Files; `dest_path` no longer does, since it's always the
/// machine-derived `zen_config.lua` sibling, not operator input) — sharing
/// this comparison keeps that divergence explicit as two separate `FORBIDDEN`
/// consts, instead of two hand-maintained copies of the same loop that could
/// silently drift out of sync with each other.
fn reject_forbidden_root(
    original: &str,
    canonical_lower: &str,
    forbidden: &[&str],
    subject: &str,
    hint: &str,
) -> VoloResult<()> {
    for root in forbidden {
        if canonical_lower == *root || canonical_lower.starts_with(&format!("{root}\\")) {
            return Err(VoloError::InvalidInput(format!(
                "{subject} {original:?} resolves under a forbidden system location ({root}); {hint}"
            )));
        }
    }
    Ok(())
}

/// Validate a `data_dir` value that is about to be rendered into
/// `server.datadir` (lua-preview / apply-config / service-install all
/// share this guard). Codex round-20 P2: previously this helper only
/// blocked empty / Win32 device prefix / forbidden system roots, so a
/// DB row that pre-dated the new register-time validator (or a future
/// code path that bypassed `core::zen::endpoint::register`) could send
/// `D:ZenCache` / `\ZenCache` / `ZenCache` straight into `zen.lua`,
/// where Windows / zen would resolve against process CWD.
pub fn validate_data_dir_safe(p: &str) -> VoloResult<()> {
    let trimmed = p.trim();
    if trimmed.is_empty() {
        return Err(VoloError::InvalidInput(
            "endpoint data_dir is empty — re-register with a valid path".into(),
        ));
    }
    // Codex P2: reject Win32 device namespace BEFORE collapsing — otherwise
    // `\\?\C:\Windows\Zen` keeps its `\\?\` prefix through normalization and
    // the case-insensitive `c:\windows\` prefix check would miss it.
    if trimmed.starts_with(r"\\?\")
        || trimmed.starts_with(r"\\.\")
        || trimmed.starts_with("//?/")
        || trimmed.starts_with("//./")
    {
        return Err(VoloError::InvalidInput(format!(
            "endpoint data_dir {p:?} uses a Win32 device namespace prefix (\\\\?\\ / \\\\.\\); \
             re-register without the prefix"
        )));
    }
    // Codex round-20 P2: require fully-qualified absolute path (drive-abs
    // or UNC). Symmetric with `validate_service_data_dir` and the
    // register-time `core::zen::endpoint::validate_data_dir`. Without this,
    // a pre-existing relative `data_dir` row in the DB silently flows into
    // `zen.lua` and resolves against the editor / service process CWD.
    let bytes = trimmed.as_bytes();
    let is_drive_abs = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/');
    let is_unc = trimmed.starts_with(r"\\") || trimmed.starts_with("//");
    if !(is_drive_abs || is_unc) {
        return Err(VoloError::InvalidInput(format!(
            "endpoint data_dir {p:?} must be a fully-qualified absolute path \
             (e.g. 'D:\\ZenCache' or '\\\\host\\share\\Zen'); drive-relative / \
             root-relative paths resolve against process CWD on Windows. \
             Re-register the endpoint with an absolute path."
        )));
    }
    let normalized = trimmed.replace('/', r"\");
    let canonical = collapse_path_segments(&normalized);
    let canonical_lower = canonical.trim_end_matches('\\').to_lowercase();
    const FORBIDDEN: &[&str] = &[
        r"c:\windows",
        r"c:\program files",
        r"c:\program files (x86)",
    ];
    reject_forbidden_root(
        p,
        &canonical_lower,
        FORBIDDEN,
        "endpoint data_dir",
        "re-register the endpoint with a writable path under D:\\ or similar",
    )
}

/// Compute SHA-256 of the bytes we *intended* to write, for cross-checking
/// against the sidecar's `sha256` field after a successful write. Lowercase
/// hex to match the sidecar's `.ToLowerInvariant()` output.
pub fn sha256_hex_of(text: &str) -> String {
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    hasher.update(text.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Pre-validate the `--dest-path` argument so `--dry-run` matches what the
/// remote sidecar would actually accept. Mirrors `zen-write-lua-config.ps1`:
///   - non-empty after trim,
///   - no Win32 device namespace prefix (`\\?\`, `\\.\`, `//?/`, `//./`),
///   - fully-qualified drive-absolute (`C:\...` / `C:/...`) or UNC (`\\host\...`),
///   - not equal to or under `C:\Windows` (case-insensitive).
///
/// Program Files is deliberately NOT forbidden: `dest_path` is always the
/// fixed `{ZenInstall}\zen_config.lua` derived from the machine's detected
/// zen.exe (see `zen_config_lua_path`), which for the preferred in-tree
/// binary commonly lives under `C:\Program Files\Epic Games\...\Win64` — the
/// destination is no longer free-text operator input, so blocking Program
/// Files here would reject the standard UE install layout with no override.
pub fn validate_dest_path(p: &str) -> VoloResult<()> {
    let trimmed = p.trim();
    if trimmed.is_empty() {
        return Err(VoloError::InvalidInput(
            "dest-path must be a non-empty absolute Windows path".into(),
        ));
    }
    // Device namespace forms.
    let device_ns = |s: &str| -> bool {
        s.starts_with(r"\\?\") || s.starts_with(r"\\.\") || s.starts_with("//?/") || s.starts_with("//./")
    };
    if device_ns(trimmed) {
        return Err(VoloError::InvalidInput(format!(
            r"dest-path must not use Win32 device namespace prefixes (\\?\ / \\.\): {p}"
        )));
    }
    // Codex P2: paths ending in a separator (`C:\Zen\`) or a relative segment
    // (`C:\Zen\.`, `C:\Zen\..`) describe a directory, not a file. The remote
    // sidecar calls `File.WriteAllText` and would fail; reject up front.
    let trim_for_tail = trimmed.trim_end();
    let last_char = trim_for_tail.chars().last();
    if matches!(last_char, Some('\\') | Some('/')) {
        return Err(VoloError::InvalidInput(format!(
            "dest-path must point at a file, not a directory (ends in path separator): {p}"
        )));
    }
    let last_seg = trim_for_tail
        .rsplit(|c| c == '\\' || c == '/')
        .next()
        .unwrap_or("");
    if last_seg == "." || last_seg == ".." {
        return Err(VoloError::InvalidInput(format!(
            "dest-path must end in a file name, not '.' or '..': {p}"
        )));
    }
    // Drive-absolute (`X:\...` or `X:/...`) — first byte alphabetic, second
    // `:`, third `\` or `/`.
    let bytes = trimmed.as_bytes();
    let is_drive_abs = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/');
    let is_unc = trimmed.starts_with(r"\\") || trimmed.starts_with("//");
    if !(is_drive_abs || is_unc) {
        return Err(VoloError::InvalidInput(format!(
            r"dest-path must be a fully-qualified absolute path (e.g. 'C:\Zen\zen.lua' or '\\host\share\zen.lua'); got: {p}"
        )));
    }
    // Codex P2: also require a file component — `D:\` / `\\host\share` would
    // pass `is_drive_abs` / `is_unc` but `zen-write-lua-config.ps1` would
    // then trip on `GetDirectoryName` returning empty or write to a root.
    // Apply this check AFTER collapsing `..` segments so a sneaky path like
    // `D:\Zen\..` (normalizes to `D:\`) is also rejected.
    let normalized_sep = trimmed.replace('/', r"\");
    let canonical_pre = collapse_path_segments(&normalized_sep);
    if is_drive_abs && canonical_pre.trim_end_matches('\\').len() <= 2 {
        // `D:` (after trimming trailing `\`) means we collapsed back to the
        // drive root with no file component.
        return Err(VoloError::InvalidInput(format!(
            "dest-path must include a file component, not just a drive root: {p}"
        )));
    }
    if is_unc {
        // Count non-empty segments after the leading `\\` — both on the
        // raw input AND on the canonicalized form. A path that collapses
        // to `\\host\share` after `..` resolution still has no file part.
        for check in [normalized_sep.as_str(), canonical_pre.as_str()] {
            let rest = &check[2..];
            let parts: Vec<&str> = rest.split('\\').filter(|s| !s.is_empty()).collect();
            if parts.len() < 3 {
                return Err(VoloError::InvalidInput(format!(
                    r"dest-path must be a complete UNC file path \\host\share\file...; got: {p}"
                )));
            }
        }
    }
    // Normalize separators + collapse `.` / `..` segments before the
    // system-root comparison. Without this, a path like
    // `C:\Temp\..\Windows\zen.lua` would slip past the prefix check but
    // `zen-write-lua-config.ps1`'s `GetFullPath` collapses it to
    // `C:\Windows\zen.lua` and refuses — so the dry-run would approve a
    // plan the real apply path always rejects (codex P2 fix).
    let normalized = trimmed.replace('/', r"\");
    let canonical = collapse_path_segments(&normalized);
    let canonical_lower = canonical.trim_end_matches('\\').to_lowercase();
    // Program Files is deliberately NOT forbidden here (see the doc comment
    // above) — the fixed zen_config.lua destination commonly lives there.
    const FORBIDDEN: &[&str] = &[r"c:\windows"];
    reject_forbidden_root(p, &canonical_lower, FORBIDDEN, "dest-path", "choose a writable app directory")
}

/// Collapse `.` and `..` segments in a backslash-normalized Windows path.
/// Mirrors `[System.IO.Path]::GetFullPath` for the purpose of the system-root
/// guard — it doesn't expand to a full canonical path (no CWD resolution), it
/// just folds relative segments so `C:\Temp\..\Windows` becomes `C:\Windows`.
///
/// Tolerates either drive-absolute (`X:\rest`) or UNC (`\\host\share\rest`)
/// prefixes; for both, the prefix is preserved and only the "rest" portion
/// is collapsed. A `..` that would pop past the root stays at the root (no
/// error, matches Win32 behavior).
pub fn collapse_path_segments(p: &str) -> String {
    let (prefix, rest) = if p.len() >= 3
        && p.as_bytes()[0].is_ascii_alphabetic()
        && p.as_bytes()[1] == b':'
        && p.as_bytes()[2] == b'\\'
    {
        // X:\rest
        (&p[..3], &p[3..])
    } else if p.starts_with(r"\\") {
        // UNC `\\host\share\...` — keep the `\\host\share\` portion intact.
        // Locate the third backslash (end of host + share segment).
        let mut bs_count = 0;
        let mut split = p.len();
        for (i, ch) in p.char_indices() {
            if ch == '\\' {
                bs_count += 1;
                if bs_count == 4 {
                    split = i + 1;
                    break;
                }
            }
        }
        (&p[..split], &p[split..])
    } else {
        // Should not be called on relative paths (caller already rejected),
        // but be defensive — treat the whole thing as rest with no prefix.
        ("", p)
    };

    let mut stack: Vec<&str> = Vec::new();
    for seg in rest.split('\\') {
        match seg {
            "" | "." => {}
            ".." => {
                stack.pop();
            }
            other => stack.push(other),
        }
    }
    format!("{prefix}{}", stack.join("\\"))
}

/// Lookup helpers that turn "not found" into `InvalidInput` so the CLI exits
/// with code 2 (operator input error) instead of 1 (operation failed).
pub fn require_endpoint(db: &Db, endpoint_id: i64) -> VoloResult<ZenEndpoint> {
    zen_endpoint::get(db, endpoint_id)?.ok_or_else(|| {
        VoloError::InvalidInput(format!("endpoint id={} not found", endpoint_id))
    })
}

pub fn require_machine(db: &Db, machine_id: i64) -> VoloResult<Machine> {
    machines::find_by_id(db, machine_id)?.ok_or_else(|| {
        VoloError::InvalidInput(format!("machine id={} not found", machine_id))
    })
}

/// Update the `operations` row with the redacted invocation string and the
/// final status. Best-effort: a failed log write should not mask the real
/// operation result, so finish errors are dropped on the floor (operator
/// already sees the success/failure via the NDJSON Completed event).
pub fn finalize_op(
    db: &Db,
    op_id: i64,
    result: &VoloResult<serde_json::Value>,
    invocation: &str,
) {
    let status = if result.is_ok() { "ok" } else { "err" };
    let log_text = match result {
        Ok(_) => invocation.to_string(),
        Err(e) => format!("{invocation}\nerror: {}", redact(&e.to_string())),
    };
    let _ = operations::finish(db, op_id, status, Some(&log_text));
}

#[cfg(test)]
mod zen_config_lua_path_tests {
    use super::zen_config_lua_path;

    #[test]
    fn derives_sibling_path_from_intree_zen_exe() {
        assert_eq!(
            zen_config_lua_path(r"D:\Program Files\Epic Games\UE_5.8\Engine\Binaries\Win64\zen.exe")
                .unwrap(),
            r"D:\Program Files\Epic Games\UE_5.8\Engine\Binaries\Win64\zen_config.lua",
        );
    }

    #[test]
    fn derives_sibling_path_from_install_copy_zen_exe() {
        assert_eq!(
            zen_config_lua_path(r"C:\Users\me\AppData\Local\UnrealEngine\Common\Zen\Install\zen.exe")
                .unwrap(),
            r"C:\Users\me\AppData\Local\UnrealEngine\Common\Zen\Install\zen_config.lua",
        );
    }

    #[test]
    fn rejects_path_with_no_directory_component() {
        assert!(zen_config_lua_path("zen.exe").is_err());
    }
}

#[cfg(test)]
mod urlacl_tests {
    use super::*;

    #[test]
    fn url_prefix_uses_strong_wildcard_to_match_zen() {
        let ep = ZenEndpoint {
            declared_port: 8558,
            scheme: "http".into(),
            ..Default::default()
        };
        assert_eq!(url_prefix_for(&ep), "http://*:8558/");
    }

    #[test]
    fn urlacl_not_needed_for_localsystem_variants() {
        for name in [
            "LocalSystem",
            "NT AUTHORITY\\SYSTEM",
            "NT AUTHORITY\\LocalSystem",
            ".\\LocalSystem",
        ] {
            assert!(!urlacl_needed_for(name), "{name}");
        }
        assert!(urlacl_needed_for(r"DOMAIN\zen-svc"));
        assert!(urlacl_needed_for("NT AUTHORITY\\LocalService"));
    }
}

#[cfg(test)]
mod service_account_tests {
    use super::*;

    #[test]
    fn is_gmsa_account_requires_domain_qualifier_and_trailing_dollar() {
        assert!(is_gmsa_account("CONTOSO\\zen-svc$"));
        assert!(is_gmsa_account("zen-svc$@contoso.com"));
        // Bare `name$` with no domain qualifier is NOT accepted — indistinguishable
        // from an operator typo on a local account (the bug this check was tightened to avoid).
        assert!(!is_gmsa_account("zen-svc$"));
        assert!(!is_gmsa_account("CONTOSO\\zen-svc"));
        assert!(!is_gmsa_account("LocalSystem"));
    }

    #[test]
    fn validate_service_account_pair_allows_gmsa_without_password() {
        validate_service_account_pair(Some("CONTOSO\\zen-svc$"), None, false).unwrap();
    }

    #[test]
    fn validate_service_account_pair_still_rejects_plain_domain_account_without_password() {
        let err = validate_service_account_pair(Some("CONTOSO\\zen-svc"), None, false).unwrap_err();
        assert!(matches!(err, VoloError::InvalidInput(_)));
    }
}

#[cfg(test)]
mod resolve_install_paths_tests {
    use super::*;
    use crate::data::{machine_ue_installs::UeInstall, machines, open_in_memory, schema};

    fn setup_with_intree_zen(zen_exe: &str) -> (Db, i64) {
        let db = open_in_memory().unwrap();
        {
            let mut conn = db.lock().unwrap();
            schema::migrate(&mut conn).unwrap();
        }
        let machine_id = machines::insert(&db, &Machine::new("ZEN-01", "10.0.0.30")).unwrap();
        crate::data::machine_ue_installs::upsert(
            &db,
            &UeInstall {
                id: None,
                machine_id,
                version: "5.4".into(),
                install_path: r"D:\UE_5.4".into(),
                is_primary: true,
                zen_cli_intree_path: Some(zen_exe.to_string()),
                zen_cli_intree_version: None,
                zen_cli_intree_sha256: None,
                zenserver_intree_path: None,
                zenserver_intree_version: None,
                zenserver_intree_sha256: None,
            },
        )
        .unwrap();
        (db, machine_id)
    }

    fn endpoint_for(machine_id: i64, install_dir: Option<&str>) -> ZenEndpoint {
        ZenEndpoint {
            machine_id,
            install_dir: install_dir.map(str::to_string),
            ..Default::default()
        }
    }

    #[test]
    fn none_install_dir_preserves_legacy_derived_path() {
        let (db, machine_id) =
            setup_with_intree_zen(r"D:\UE_5.4\Engine\Binaries\Win64\zen.exe");
        let ep = endpoint_for(machine_id, None);
        let resolved = resolve_install_paths(&db, &ep).unwrap();
        assert_eq!(resolved.source_exe, r"D:\UE_5.4\Engine\Binaries\Win64\zen.exe");
        assert_eq!(resolved.target_exe, resolved.source_exe);
        assert_eq!(
            resolved.target_config,
            r"D:\UE_5.4\Engine\Binaries\Win64\zen_config.lua"
        );
        assert!(!resolved.needs_copy);
    }

    #[test]
    fn some_install_dir_different_from_source_requires_copy() {
        let (db, machine_id) =
            setup_with_intree_zen(r"D:\UE_5.4\Engine\Binaries\Win64\zen.exe");
        let ep = endpoint_for(machine_id, Some(r"C:\ZenServer"));
        let resolved = resolve_install_paths(&db, &ep).unwrap();
        assert_eq!(resolved.target_exe, r"C:\ZenServer\zenserver.exe");
        assert_eq!(resolved.target_config, r"C:\ZenServer\zen_config.lua");
        assert!(resolved.needs_copy);
    }

    #[test]
    fn some_install_dir_matching_source_case_insensitively_skips_copy() {
        // Realistic shape: the detected binary is always zen.exe (see
        // resolve_service_zen_exe), never zenserver.exe — needs_copy must
        // compare directories, not full paths, or this would always be true.
        let (db, machine_id) =
            setup_with_intree_zen(r"c:\zenserver\zen.exe");
        let ep = endpoint_for(machine_id, Some(r"C:\ZenServer"));
        let resolved = resolve_install_paths(&db, &ep).unwrap();
        assert!(!resolved.needs_copy);
    }

    #[test]
    fn some_install_dir_exactly_matching_source_dir_skips_copy() {
        // Same scenario without the case-folding — the most common real
        // case: an endpoint already deployed with install_dir set, whose
        // zen.exe was already copied there by a prior apply-config.
        let (db, machine_id) =
            setup_with_intree_zen(r"C:\ZenServer\zen.exe");
        let ep = endpoint_for(machine_id, Some(r"C:\ZenServer"));
        let resolved = resolve_install_paths(&db, &ep).unwrap();
        assert!(!resolved.needs_copy);
    }

    #[test]
    fn blank_install_dir_is_rejected() {
        let (db, machine_id) =
            setup_with_intree_zen(r"D:\UE_5.4\Engine\Binaries\Win64\zen.exe");
        let ep = endpoint_for(machine_id, Some("   "));
        assert!(resolve_install_paths(&db, &ep).is_err());
    }

    #[test]
    fn config_path_override_takes_precedence_over_install_dir() {
        let (db, machine_id) =
            setup_with_intree_zen(r"D:\UE_5.4\Engine\Binaries\Win64\zen.exe");
        let mut ep = endpoint_for(machine_id, Some(r"C:\ZenServer"));
        ep.config_path_override = Some(r"E:\Custom\zen_config.lua".into());
        let resolved = resolve_install_paths(&db, &ep).unwrap();
        assert_eq!(resolved.target_config, r"E:\Custom\zen_config.lua");
        // Override only affects the config path, not the exe target/copy decision.
        assert_eq!(resolved.target_exe, r"C:\ZenServer\zenserver.exe");
        assert!(resolved.needs_copy);
    }

    #[test]
    fn config_path_override_works_without_install_dir() {
        let (db, machine_id) =
            setup_with_intree_zen(r"D:\UE_5.4\Engine\Binaries\Win64\zen.exe");
        let mut ep = endpoint_for(machine_id, None);
        ep.config_path_override = Some(r"E:\Custom\zen_config.lua".into());
        let resolved = resolve_install_paths(&db, &ep).unwrap();
        assert_eq!(resolved.target_config, r"E:\Custom\zen_config.lua");
        assert_eq!(resolved.target_exe, r"D:\UE_5.4\Engine\Binaries\Win64\zen.exe");
        assert!(!resolved.needs_copy);
    }

    #[test]
    fn blank_config_path_override_is_rejected() {
        let (db, machine_id) =
            setup_with_intree_zen(r"D:\UE_5.4\Engine\Binaries\Win64\zen.exe");
        let mut ep = endpoint_for(machine_id, None);
        ep.config_path_override = Some("   ".into());
        assert!(resolve_install_paths(&db, &ep).is_err());
    }

    #[test]
    fn resolve_service_paths_with_install_dir_needs_no_detection_metadata() {
        // No machine_ue_installs / machine_zen_install row seeded at all —
        // resolve_install_paths would fail here (it always calls
        // resolve_service_zen_exe), but resolve_service_paths must succeed
        // because install_dir alone is authoritative for this lightweight path.
        let db = open_in_memory().unwrap();
        {
            let mut conn = db.lock().unwrap();
            schema::migrate(&mut conn).unwrap();
        }
        let machine_id = machines::insert(&db, &Machine::new("ZEN-02", "10.0.0.31")).unwrap();
        let ep = endpoint_for(machine_id, Some(r"C:\ZenServer"));
        let (target_exe, target_config) = resolve_service_paths(&db, &ep).unwrap();
        assert_eq!(target_exe, r"C:\ZenServer\zenserver.exe");
        assert_eq!(target_config, r"C:\ZenServer\zen_config.lua");
    }

    #[test]
    fn resolve_service_paths_without_install_dir_falls_back_to_detection() {
        let (db, machine_id) =
            setup_with_intree_zen(r"D:\UE_5.4\Engine\Binaries\Win64\zen.exe");
        let ep = endpoint_for(machine_id, None);
        let (target_exe, target_config) = resolve_service_paths(&db, &ep).unwrap();
        assert_eq!(target_exe, r"D:\UE_5.4\Engine\Binaries\Win64\zen.exe");
        assert_eq!(target_config, r"D:\UE_5.4\Engine\Binaries\Win64\zen_config.lua");
    }

    #[test]
    fn resolve_service_paths_without_install_dir_and_no_detection_fails() {
        let db = open_in_memory().unwrap();
        {
            let mut conn = db.lock().unwrap();
            schema::migrate(&mut conn).unwrap();
        }
        let machine_id = machines::insert(&db, &Machine::new("ZEN-03", "10.0.0.32")).unwrap();
        let ep = endpoint_for(machine_id, None);
        assert!(resolve_service_paths(&db, &ep).is_err());
    }

    #[test]
    fn resolve_service_paths_applies_config_path_override() {
        let db = open_in_memory().unwrap();
        {
            let mut conn = db.lock().unwrap();
            schema::migrate(&mut conn).unwrap();
        }
        let machine_id = machines::insert(&db, &Machine::new("ZEN-04", "10.0.0.33")).unwrap();
        let mut ep = endpoint_for(machine_id, Some(r"C:\ZenServer"));
        ep.config_path_override = Some(r"E:\Custom\zen_config.lua".into());
        let (target_exe, target_config) = resolve_service_paths(&db, &ep).unwrap();
        assert_eq!(target_exe, r"C:\ZenServer\zenserver.exe");
        assert_eq!(target_config, r"E:\Custom\zen_config.lua");
    }
}
