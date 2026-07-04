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

/// Resolves what `reveal_item_in_dir` should actually be given for a path that
/// lives on `host`, a machine other than the one Volo itself runs on.
///
/// Only meaningful on Windows: `reveal_item_in_dir` there natively understands
/// UNC prefixes, so a remote machine's `D:\...` can be rewritten to the
/// `\\host\D$\...` admin-share form and opened directly. Zen's own `data_dir` /
/// `install_dir` validation (`validate_data_dir` et al.) also accepts an
/// already-UNC value outright — that must pass through unrewritten instead of
/// being mistaken for a bare drive-rooted path and rejected.
#[cfg(target_os = "windows")]
fn remote_reveal_target(host: &str, abs_path: &str) -> Result<String, String> {
    let normalized = abs_path.replace('/', "\\");
    if normalized.starts_with(r"\\") {
        return Ok(normalized);
    }
    let mut chars = normalized.chars();
    let drive = chars
        .next()
        .filter(char::is_ascii_alphabetic)
        .ok_or_else(|| format!("path is not drive-rooted: {abs_path}"))?;
    if chars.next() != Some(':') {
        return Err(format!("path is not a drive-rooted Windows path: {abs_path}"));
    }
    // `chars` has already consumed the drive letter + colon; `as_str()` hands
    // back the remainder at its current (guaranteed char-boundary) position —
    // no manual byte-offset slicing, so a multi-byte first character can't
    // land the cut mid-codepoint and panic.
    let rest = chars.as_str().trim_start_matches('\\');
    Ok(format!("\\\\{host}\\{drive}$\\{rest}"))
}

/// On macOS/Linux there is no admin-share equivalent, and `reveal_item_in_dir`
/// canonicalizes via `std::fs::canonicalize`, which treats backslashes as
/// literal filename characters rather than a UNC path — handing it a rewritten
/// `\\host\D$\...` string would just fail with "not found". Say so plainly
/// instead of pretending the reveal could work.
#[cfg(not(target_os = "windows"))]
fn remote_reveal_target(host: &str, abs_path: &str) -> Result<String, String> {
    Err(format!(
        "{abs_path} 位于远程机器 {host} 上，Volo 所在系统无法直接跳转 —— 请在该 Windows 机器上打开，\
         或在 Finder 用「前往 · 连接服务器」手动挂载 smb://{host}/ 对应的共享。"
    ))
}

/// Reveal a path in the OS file manager (the USB-export drawer's "在文件夹中显示",
/// and Zen cache-address rows). `host` names the machine the path actually lives
/// on; omit it (or pass the local machine) for a path on the machine Volo itself
/// runs on. For any other host, see `remote_reveal_target` — this requires the
/// current session to have admin access to that machine's `<drive>$` share,
/// which is a different credential story than the SSH automation account Volo
/// otherwise uses.
#[tauri::command]
pub fn reveal_path(app: tauri::AppHandle, path: String, host: Option<String>) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let Some(h) = host.filter(|h| !h.is_empty() && !cache_core::core::loopback::is_loopback_target(h))
    else {
        return app
            .opener()
            .reveal_item_in_dir(&path)
            .map_err(|e| e.to_string());
    };
    let target = remote_reveal_target(&h, &path)?;
    app.opener().reveal_item_in_dir(&target).map_err(|e| {
        let raw = e.to_string();
        // Two workgroup Windows boxes with different local-account passwords is the
        // single most common way this admin-share open fails — worth spelling out
        // since the raw OS message ("拒绝访问"/"Access is denied") gives the operator
        // no next step on its own.
        if raw.contains("拒绝访问") || raw.to_lowercase().contains("access is denied") {
            format!(
                "{raw} —— 本机对 {h} 的管理共享（{target}）没有访问权限。工作组环境下两台机器本地账户/\
                 密码不一致时常见，需要先在本机对 {h} 建立已认证连接（如执行 `net use \\\\{h}` 并输入其\
                 账户密码），或在 {h} 上把注册表 LocalAccountTokenFilterPolicy 设为 1 以放开本地账户的\
                 远程管理共享限制。"
            )
        } else {
            format!("{raw}（尝试打开 {target}）")
        }
    })
}
