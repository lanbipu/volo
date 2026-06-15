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
use crate::error::{UecmError, UecmResult};

/// Default Windows service name for zenserver.
///
/// **Not** `"ZenServer"` — UE's `ConditionalUpdateSystemServiceInstall()`
/// hardcodes that name and tries to update/uninstall the service when the
/// ImagePath doesn't match the running UE version's expectations. Using a
/// distinct name makes the UECM-managed service invisible to UE's built-in
/// service management so multiple UE versions (5.7, 5.8, …) can all connect
/// to it via HTTP without triggering conflict dialogs.
pub const DEFAULT_SERVICE_NAME: &str = "UECMZenServer";

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
pub fn resolve_upstream_info(db: &Db, ep: &ZenEndpoint) -> UecmResult<Option<UpstreamInfo>> {
    let Some(upstream_id) = ep.upstream_endpoint_id else {
        return Ok(None);
    };
    let upstream = zen_endpoint::get(db, upstream_id)?.ok_or_else(|| {
        UecmError::InvalidInput(format!(
            "endpoint id={} references upstream id={} which no longer exists",
            ep.id.unwrap_or(-1),
            upstream_id,
        ))
    })?;
    let upstream_machine = machines::find_by_id(db, upstream.machine_id)?.ok_or_else(|| {
        UecmError::InvalidInput(format!(
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

pub fn render_lua_for(db: &Db, endpoint_id: i64) -> UecmResult<(ZenEndpoint, String)> {
    let ep = zen_endpoint::get(db, endpoint_id)?.ok_or_else(|| {
        UecmError::InvalidInput(format!("endpoint id={} not found", endpoint_id))
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
) -> UecmResult<serde_json::Value> {
    let remote_sha = response
        .get("sha256")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            UecmError::PowerShell(
                "zen-write-lua-config: missing sha256 field in success envelope".into(),
            )
        })?;
    if !remote_sha.eq_ignore_ascii_case(expected_sha) {
        return Err(UecmError::PowerShell(format!(
            "zen-write-lua-config: remote sha256 {remote_sha} does not match locally rendered {expected_sha} \
             — the file on disk does NOT match the requested config",
        )));
    }
    let remote_bytes = response
        .get("bytes_written")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| {
            UecmError::PowerShell(
                "zen-write-lua-config: missing bytes_written field in success envelope".into(),
            )
        })?;
    if remote_bytes != expected_bytes as i64 {
        return Err(UecmError::PowerShell(format!(
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
) -> UecmResult<serde_json::Value> {
    // SSH key auth (uecm-svc); operator creds ignored (param kept as a shim).
    let _ = creds;
    let raw = run_node(
        host,
        "zen-write-lua-config.ps1",
        serde_json::json!({ "LuaText": lua_text, "DestPath": dest_path }),
    )?;
    parse_envelope(&raw, "zen-write-lua-config")
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
) -> UecmResult<Option<String>> {
    Ok(machines::get_ue_runtime_user(db, machine_id)?.map(|user| {
        format!(
            "machine id={machine_id} looks like a UE workstation (ue_runtime_user={user:?} is \
             set); installing the shared ZenServer service here is not recommended — run it on a \
             dedicated server so it doesn't contend with the workstation's editor-managed local \
             Zen. Proceeding because this check is advisory only."
        )
    }))
}

/// Build the canonical `<scheme>://+:<port>/` reservation URL for an endpoint.
pub fn url_prefix_for(ep: &ZenEndpoint) -> String {
    format!("{}://+:{}/", ep.scheme, ep.declared_port)
}

/// Run a staged node-pure zen script over SSH (`-File`), args via stdin JSON.
/// Returns stdout (the `{ok,...}` envelope; the script's `ok` flag is the source
/// of truth, so a non-zero exit still surfaces its stdout — mirrors the old
/// run_remote contract). SSH key auth (uecm-svc); operator creds are gone.
/// Replaces build_param_script + run_remote (WinRM) as zen migrates in P2.
/// pub(crate) so the Tauri `commands/zen.rs` backend reuses the same SSH path.
pub fn run_node(host: &str, script_name: &'static str, args: serde_json::Value) -> UecmResult<String> {
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
pub fn parse_envelope(raw: &str, sidecar: &str) -> UecmResult<serde_json::Value> {
    let envelope: serde_json::Value = serde_json::from_str(raw).map_err(|e| {
        UecmError::PowerShell(format!(
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
            Err(UecmError::PowerShell(format!("{sidecar}: {msg}")))
        }
        None => {
            // `ok` missing OR present-but-non-bool (e.g. `ok: null`, `ok: "true"`).
            // Treat as protocol violation, not success.
            Err(UecmError::PowerShell(format!(
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
) -> UecmResult<()> {
    let Some(u) = service_user else {
        return Ok(());
    };
    if u.trim().is_empty() {
        return Ok(());
    }
    let pass_supplied = service_pass.map(|p| !p.is_empty()).unwrap_or(false)
        || service_pass_stdin;
    if !is_builtin_service_account(u) && !pass_supplied {
        return Err(UecmError::InvalidInput(format!(
            "service_user {u:?} is not a Windows built-in account; a password \
             is required (built-in accounts: LocalSystem / LocalService / \
             NetworkService). Pass --service-pass / --service-pass-stdin, or \
             pick a built-in account."
        )));
    }
    Ok(())
}

pub fn validate_service_data_dir(p: &str) -> UecmResult<()> {
    let trimmed = p.trim();
    if trimmed.is_empty() {
        return Err(UecmError::InvalidInput(
            "service data_dir is empty — re-register the endpoint with a valid path".into(),
        ));
    }
    if trimmed.starts_with(r"\\?\")
        || trimmed.starts_with(r"\\.\")
        || trimmed.starts_with("//?/")
        || trimmed.starts_with("//./")
    {
        return Err(UecmError::InvalidInput(format!(
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
        return Err(UecmError::InvalidInput(format!(
            "service data_dir must be a fully-qualified absolute path \
             (e.g. 'D:\\ZenCache' or '\\\\host\\share\\Zen'); \
             drive-relative / root-relative paths are rejected by zen.exe. Got: {p}"
        )));
    }
    // Reuse the system-root + traversal guard.
    validate_data_dir_safe(trimmed)
}

/// Validate a `data_dir` value that is about to be rendered into
/// `server.datadir` (lua-preview / apply-config / service-install all
/// share this guard). Codex round-20 P2: previously this helper only
/// blocked empty / Win32 device prefix / forbidden system roots, so a
/// DB row that pre-dated the new register-time validator (or a future
/// code path that bypassed `core::zen::endpoint::register`) could send
/// `D:ZenCache` / `\ZenCache` / `ZenCache` straight into `zen.lua`,
/// where Windows / zen would resolve against process CWD.
pub fn validate_data_dir_safe(p: &str) -> UecmResult<()> {
    let trimmed = p.trim();
    if trimmed.is_empty() {
        return Err(UecmError::InvalidInput(
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
        return Err(UecmError::InvalidInput(format!(
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
        return Err(UecmError::InvalidInput(format!(
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
    for root in FORBIDDEN {
        if canonical_lower == *root
            || canonical_lower.starts_with(&format!("{root}\\"))
        {
            return Err(UecmError::InvalidInput(format!(
                "endpoint data_dir {p:?} resolves under a forbidden system location ({root}); \
                 re-register the endpoint with a writable path under D:\\ or similar"
            )));
        }
    }
    Ok(())
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
///   - not equal to or under `C:\Windows`, `C:\Program Files`,
///     `C:\Program Files (x86)` (case-insensitive).
pub fn validate_dest_path(p: &str) -> UecmResult<()> {
    let trimmed = p.trim();
    if trimmed.is_empty() {
        return Err(UecmError::InvalidInput(
            "dest-path must be a non-empty absolute Windows path".into(),
        ));
    }
    // Device namespace forms.
    let device_ns = |s: &str| -> bool {
        s.starts_with(r"\\?\") || s.starts_with(r"\\.\") || s.starts_with("//?/") || s.starts_with("//./")
    };
    if device_ns(trimmed) {
        return Err(UecmError::InvalidInput(format!(
            r"dest-path must not use Win32 device namespace prefixes (\\?\ / \\.\): {p}"
        )));
    }
    // Codex P2: paths ending in a separator (`C:\Zen\`) or a relative segment
    // (`C:\Zen\.`, `C:\Zen\..`) describe a directory, not a file. The remote
    // sidecar calls `File.WriteAllText` and would fail; reject up front.
    let trim_for_tail = trimmed.trim_end();
    let last_char = trim_for_tail.chars().last();
    if matches!(last_char, Some('\\') | Some('/')) {
        return Err(UecmError::InvalidInput(format!(
            "dest-path must point at a file, not a directory (ends in path separator): {p}"
        )));
    }
    let last_seg = trim_for_tail
        .rsplit(|c| c == '\\' || c == '/')
        .next()
        .unwrap_or("");
    if last_seg == "." || last_seg == ".." {
        return Err(UecmError::InvalidInput(format!(
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
        return Err(UecmError::InvalidInput(format!(
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
        return Err(UecmError::InvalidInput(format!(
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
                return Err(UecmError::InvalidInput(format!(
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
    const FORBIDDEN: &[&str] = &[
        r"c:\windows",
        r"c:\program files",
        r"c:\program files (x86)",
    ];
    for root in FORBIDDEN {
        if canonical_lower == *root
            || canonical_lower.starts_with(&format!("{root}\\"))
        {
            return Err(UecmError::InvalidInput(format!(
                "dest-path {p:?} resolves under a forbidden system location ({root}); choose a writable app directory"
            )));
        }
    }
    Ok(())
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
pub fn require_endpoint(db: &Db, endpoint_id: i64) -> UecmResult<ZenEndpoint> {
    zen_endpoint::get(db, endpoint_id)?.ok_or_else(|| {
        UecmError::InvalidInput(format!("endpoint id={} not found", endpoint_id))
    })
}

pub fn require_machine(db: &Db, machine_id: i64) -> UecmResult<Machine> {
    machines::find_by_id(db, machine_id)?.ok_or_else(|| {
        UecmError::InvalidInput(format!("machine id={} not found", machine_id))
    })
}

/// Update the `operations` row with the redacted invocation string and the
/// final status. Best-effort: a failed log write should not mask the real
/// operation result, so finish errors are dropped on the floor (operator
/// already sees the success/failure via the NDJSON Completed event).
pub fn finalize_op(
    db: &Db,
    op_id: i64,
    result: &UecmResult<serde_json::Value>,
    invocation: &str,
) {
    let status = if result.is_ok() { "ok" } else { "err" };
    let log_text = match result {
        Ok(_) => invocation.to_string(),
        Err(e) => format!("{invocation}\nerror: {}", redact(&e.to_string())),
    };
    let _ = operations::finish(db, op_id, status, Some(&log_text));
}
