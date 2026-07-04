//! Tauri commands for first-contact node onboarding.
//!
//! Remote WinRM push has been retired (SSH migration P5a). These commands are
//! kept registered + signature-frozen for the published UI: `bootstrap_winrm`
//! now returns a graceful "use the USB bootstrap" result and
//! `get_winrm_bootstrap_script` returns the SSH node-onboarder script.

use cache_core::core::keystore::KeyStore;
use cache_core::core::powershell;
use cache_core::data::{credentials as data_credentials, machines as data_machines, CredentialKind, Db};
use cache_core::error::{VoloError, VoloResult};
use serde::{Deserialize, Serialize};
use tauri::State;

/// Frozen response shape (Vue reads `.ok` / `.message` / `.manual_script`).
/// Moved here from the deleted `core::bootstrap`; the name is kept for serde
/// compatibility with the Vue `WinrmBootstrapResult` TS type.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WinrmBootstrapResult {
    pub ok: bool,
    pub method: String,
    pub message: String,
    pub winrm_ok: bool,
    #[serde(default)]
    pub changed: Vec<String>,
    pub manual_script: Option<String>,
}

fn ssh_onboarder_script() -> String {
    include_str!("../../resources/ps-scripts/enable-ssh.ps1").to_string()
}

#[tauri::command]
pub fn get_winrm_bootstrap_script() -> VoloResult<String> {
    // Remote WinRM push retired; the manual onboarder is now the SSH node script.
    Ok(ssh_onboarder_script())
}

#[tauri::command]
pub fn bootstrap_winrm(
    db: State<'_, Db>,
    machine_id: i64,
    credential_alias: String,
    enable_local_account_remote_admin: bool,
) -> VoloResult<WinrmBootstrapResult> {
    let _ = enable_local_account_remote_admin; // accepted for back-compat; unused.

    // Validate inputs so the UI still gets precise errors, but do NOT push.
    let _machine = data_machines::find_by_id(&db, machine_id)?
        .ok_or_else(|| VoloError::InvalidInput(format!("machine {} not found", machine_id)))?;
    let credential = data_credentials::find_by_alias(&db, &credential_alias)?.ok_or_else(|| {
        VoloError::InvalidInput(format!("credential alias '{}' not found", credential_alias))
    })?;
    if credential.kind != CredentialKind::Winrm {
        return Err(VoloError::InvalidInput(format!(
            "credential alias '{}' is not a WinRM credential",
            credential_alias
        )));
    }

    Ok(WinrmBootstrapResult {
        ok: false,
        method: "ssh-onboard-required".into(),
        message: "Remote WinRM push has been retired. Onboard this node with the \
                  UECM-Bootstrap.cmd USB bundle (build it via `voloctl cache ssh package-bootstrap`), \
                  then use machine refresh over SSH."
            .into(),
        winrm_ok: false,
        changed: Vec::new(),
        manual_script: Some(ssh_onboarder_script()),
    })
}

/// Parsed stdout of `package-bootstrap.ps1` (extra keys ignored). Mirrors the
/// CLI's `domain_ssh::PackageOut` so the GUI export and `voloctl cache ssh
/// package-bootstrap` share the identical packager.
#[derive(Deserialize)]
struct PackageBootstrapRaw {
    ok: bool,
    message: String,
    output_directory: String,
    #[serde(default)]
    files: Vec<String>,
}

/// Result surfaced to the "制作入网 U 盘" drawer (snake_case DTO, like the CLI).
#[derive(Serialize)]
pub struct PackageBootstrapResult {
    pub output_directory: String,
    pub files: Vec<String>,
}

/// Assemble the USB SSH onboarding bundle into `out` (the GUI "制作入网 U 盘"
/// action). Ensures the operator keystore keypair exists, then shells out to the
/// Windows-only `package-bootstrap.ps1` — the same packager the CLI `voloctl cache
/// ssh package-bootstrap` uses — copying UECM-Bootstrap.cmd + enable-ssh.ps1 +
/// uecm.pub + PsExec64.exe + README into `out`. The bundle is global: one package
/// onboards every node. `local_admin_password` (optional) is baked into the .cmd
/// for one-double-click onboarding; the packager rejects `% " ^` (cmd.exe mangles
/// them) and surfaces that as the error message.
#[tauri::command]
pub fn package_ssh_bootstrap(
    out: String,
    local_admin_password: Option<String>,
) -> VoloResult<PackageBootstrapResult> {
    let cfg = cache_core::startup::resolve_config_dir()?;
    let ks = KeyStore::at(&cfg);
    ks.ensure_keypair()?;
    let pubkey = ks.public_key_path().to_string_lossy().into_owned();

    let mut args: Vec<&str> = vec!["-OutputDirectory", &out, "-UecmPublicKeyPath", &pubkey];
    if let Some(p) = local_admin_password.as_deref() {
        if !p.is_empty() {
            args.push("-LocalAdminPassword");
            args.push(p);
        }
    }
    let raw: PackageBootstrapRaw =
        powershell::run_json(&powershell::script_path("package-bootstrap.ps1"), &args)?;
    if !raw.ok {
        return Err(VoloError::OperationFailed(raw.message));
    }
    Ok(PackageBootstrapResult {
        output_directory: raw.output_directory,
        files: raw.files,
    })
}

/// Native folder picker backing the USB-export drawer's "浏览…" button. Returns
/// the chosen directory path, or `None` if the user cancelled. Runs the blocking
/// picker on a worker thread (it dispatches the OS panel to the main thread and
/// blocks the caller — calling it FROM the main thread would deadlock on macOS).
#[tauri::command]
pub async fn pick_directory(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .blocking_pick_folder()
            .and_then(|fp| fp.into_path().ok())
            .map(|p| p.to_string_lossy().into_owned())
    })
    .await
    .ok()
    .flatten()
}

/// Native file picker backing the Calibrate Lens panel's "选择 session 配置"
/// button (and, with an explicit filter, the Calibrate mesh 段 project/CSV
/// pickers). Returns the chosen file path, or `None` if the user cancelled.
/// Same worker-thread rationale as `pick_directory` (blocking picker would
/// deadlock the main thread on macOS).
///
/// `filter_name`/`filter_extensions` default to the original "Session Config"
/// / `json` filter when omitted, so existing zero-arg callers are unaffected.
#[tauri::command]
pub async fn pick_file(
    app: tauri::AppHandle,
    filter_name: Option<String>,
    filter_extensions: Option<Vec<String>>,
) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let (name, exts) = match (filter_name, filter_extensions) {
        (Some(n), Some(e)) if !e.is_empty() => (n, e),
        _ => ("Session Config".to_string(), vec!["json".to_string()]),
    };
    tauri::async_runtime::spawn_blocking(move || {
        let ext_refs: Vec<&str> = exts.iter().map(String::as_str).collect();
        app.dialog()
            .file()
            .add_filter(&name, &ext_refs)
            .blocking_pick_file()
            .and_then(|fp| fp.into_path().ok())
            .map(|p| p.to_string_lossy().into_owned())
    })
    .await
    .ok()
    .flatten()
}

/// Reveal a path in the OS file manager (the USB-export drawer's "在文件夹中显示").
#[tauri::command]
pub fn reveal_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| e.to_string())
}

/// Whether `host` (IP or hostname) resolves to the machine Volo itself runs
/// on. The frontend uses this to decide whether a project folder can be
/// revealed directly (`reveal_path` only ever acts on the operator's own
/// filesystem) or must go through `reveal_remote_path` for a genuinely
/// remote render node.
#[tauri::command]
pub fn is_loopback_machine(host: String) -> bool {
    cache_core::core::loopback::is_loopback_target(&host)
}

/// Reveals a project folder that lives on a remote machine (`host` — IP or
/// hostname), `path` being the Windows-style absolute path on that machine
/// (e.g. `D:\Projects\Aurora`). Volo itself ships for macOS as well as
/// Windows (see the per-OS menu/decorations branches in `lib.rs`), so this
/// can't just hand a Windows UNC string to `reveal_item_in_dir` unconditionally
/// — its `canonicalize()` step is `std::fs::canonicalize` on non-Windows,
/// which has no notion of `\\host\D$\...` and always fails there. Windows
/// keeps the existing admin-share UNC path (its `canonicalize` resolves UNC
/// via the Shell APIs); everywhere else this opens an `smb://` URL instead,
/// which Finder/most Linux file managers mount and navigate on demand.
#[tauri::command]
pub fn reveal_remote_path(app: tauri::AppHandle, host: String, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    #[cfg(windows)]
    {
        app.opener()
            .reveal_item_in_dir(&windows_admin_share_unc(&host, &path))
            .map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        app.opener()
            .open_url(smb_url(&host, &path), None::<&str>)
            .map_err(|e| e.to_string())
    }
}

/// `D:\Projects\Aurora` + `192.168.10.20` -> `\\192.168.10.20\D$\Projects\Aurora`.
/// Not cfg-gated to `windows` (unlike its caller above) so it stays unit-testable
/// from a non-Windows dev machine; only actually called there, hence the
/// `allow` (this file's non-Windows builds would otherwise warn on it).
#[cfg_attr(not(windows), allow(dead_code))]
fn windows_admin_share_unc(host: &str, path: &str) -> String {
    match path.split_once(':') {
        Some((drive, rest)) => format!("\\\\{host}\\{drive}${rest}"),
        None => path.to_string(),
    }
}

/// `D:\Unreal Projects\Aurora` + `192.168.10.20` ->
/// `smb://192.168.10.20/D$/Unreal%20Projects/Aurora`. Percent-encodes the
/// handful of characters that are common in Windows folder names and reserved
/// in URLs (a full percent-encoder is overkill for admin-share path segments).
/// Only actually called on non-Windows (see `reveal_remote_path`), hence the
/// `allow` for Windows builds.
#[cfg_attr(windows, allow(dead_code))]
fn smb_url(host: &str, path: &str) -> String {
    let encode_segment = |seg: &str| -> String {
        seg.chars()
            .map(|c| match c {
                ' ' => "%20".to_string(),
                '#' => "%23".to_string(),
                '?' => "%3F".to_string(),
                '%' => "%25".to_string(),
                other => other.to_string(),
            })
            .collect()
    };
    let (share, rest) = match path.split_once(':') {
        Some((drive, rest)) => (format!("{drive}$"), rest),
        None => (String::new(), path),
    };
    let segments: Vec<String> = rest
        .split(['\\', '/'])
        .filter(|s| !s.is_empty())
        .map(encode_segment)
        .collect();
    let mut url = format!("smb://{host}/{share}");
    if !segments.is_empty() {
        url.push('/');
        url.push_str(&segments.join("/"));
    }
    url
}

#[cfg(test)]
mod remote_path_tests {
    use super::*;

    #[test]
    fn windows_admin_share_unc_converts_drive_letter() {
        assert_eq!(
            windows_admin_share_unc("192.168.10.20", r"D:\Projects\Aurora"),
            r"\\192.168.10.20\D$\Projects\Aurora"
        );
    }

    #[test]
    fn windows_admin_share_unc_passes_through_non_drive_paths() {
        assert_eq!(
            windows_admin_share_unc("192.168.10.20", r"\\already\unc\path"),
            r"\\already\unc\path"
        );
    }

    #[test]
    fn smb_url_converts_drive_letter_and_encodes_spaces() {
        assert_eq!(
            smb_url("192.168.10.20", r"D:\Unreal Projects\Aurora"),
            "smb://192.168.10.20/D$/Unreal%20Projects/Aurora"
        );
    }

    #[test]
    fn smb_url_handles_bare_drive_root() {
        assert_eq!(smb_url("192.168.10.20", r"D:\"), "smb://192.168.10.20/D$");
    }
}
