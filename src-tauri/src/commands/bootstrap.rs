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

/// If a share registered on the machine known as `host` covers `abs_path`
/// (its `local_path` is a case-insensitive path-prefix of it), rewrite the
/// path into that share: a `\\host\share\...` UNC on Windows, an `smb://`
/// URL elsewhere (Finder mounts guest shares on demand). Longest matching
/// prefix wins. `None` → caller falls back to the admin-share route.
fn share_reveal_target(db: &Db, host: &str, abs_path: &str) -> Option<String> {
    let machine = data_machines::list_all(db)
        .ok()?
        .into_iter()
        .find(|m| m.ip.eq_ignore_ascii_case(host) || m.hostname.eq_ignore_ascii_case(host))?;
    let shares = cache_core::data::share_configs::find_by_host(db, machine.id?).ok()?;
    // ASCII-only lowering keeps byte offsets valid for slicing the original.
    let norm = |p: &str| p.replace('/', "\\").trim_end_matches('\\').to_ascii_lowercase();
    let path_norm = abs_path.replace('/', "\\");
    let path_low = norm(abs_path);
    let (share, rel) = shares
        .iter()
        .filter_map(|s| {
            let base_low = norm(&s.local_path);
            if base_low.is_empty() {
                return None;
            }
            if path_low == base_low {
                Some((s, ""))
            } else if path_low.starts_with(&base_low)
                && path_low.as_bytes().get(base_low.len()) == Some(&b'\\')
            {
                Some((s, path_norm[base_low.len() + 1..].trim_end_matches('\\')))
            } else {
                None
            }
        })
        .max_by_key(|(s, _)| s.local_path.len())?;
    // Rebuild the UNC around the caller-supplied `host` (the address the UI
    // actually reaches the machine by — typically its IP) instead of trusting
    // `share.unc_path`: that one carries the remote `$env:COMPUTERNAME`, which
    // an IP-only workgroup with no NetBIOS/DNS resolution can't resolve. The
    // client-prep step registers cmdkey/net use for both IP and hostname
    // variants, so either spelling authenticates.
    if cfg!(target_os = "windows") {
        Some(if rel.is_empty() {
            format!("\\\\{host}\\{}", share.share_name)
        } else {
            format!("\\\\{host}\\{}\\{rel}", share.share_name)
        })
    } else {
        let share_name = share.share_name.clone();
        let encode = |seg: &str| {
            seg.chars()
                .map(|c| match c {
                    ' ' => "%20".to_string(),
                    '#' => "%23".to_string(),
                    '?' => "%3F".to_string(),
                    '%' => "%25".to_string(),
                    other => other.to_string(),
                })
                .collect::<String>()
        };
        let mut url = format!("smb://{host}/{encoded}", encoded = encode(&share_name));
        for seg in rel.split('\\').filter(|s| !s.is_empty()) {
            url.push('/');
            url.push_str(&encode(seg));
        }
        Some(url)
    }
}

/// Reveal a path in the OS file manager (the USB-export drawer's "在文件夹中显示",
/// and Zen cache-address rows). `host` names the machine the path actually lives
/// on; omit it (or pass the local machine) for a path on the machine Volo itself
/// runs on. For any other host, see `remote_reveal_target` — this requires the
/// current session to have admin access to that machine's `<drive>$` share,
/// which is a different credential story than the SSH automation account Volo
/// otherwise uses.
#[tauri::command]
pub fn reveal_path(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    path: String,
    host: Option<String>,
) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let Some(h) = host.filter(|h| !h.is_empty() && !cache_core::core::loopback::is_loopback_target(h))
    else {
        return app
            .opener()
            .reveal_item_in_dir(&path)
            .map_err(|e| e.to_string());
    };
    // A registered share covering the path beats the admin-share fallback:
    // guest/managed shares are exactly what Volo provisions so workgroup
    // machines can reach each other without local-account credentials, while
    // `\\host\D$` is dead on arrival between mutually-distrusting boxes.
    if let Some(target) = share_reveal_target(&db, &h, &path) {
        #[cfg(target_os = "windows")]
        return app
            .opener()
            .reveal_item_in_dir(&target)
            .map_err(|e| format!("{e}（{target}）"));
        #[cfg(not(target_os = "windows"))]
        return app
            .opener()
            .open_url(&target, None::<&str>)
            .map_err(|e| format!("{e}（{target}）"));
    }
    let target = remote_reveal_target(&h, &path)?;
    app.opener().reveal_item_in_dir(&target).map_err(|e| {
        // tauri-plugin-opener's Windows existence pre-check is a bare
        // `path.exists()` (see its windows_shell_path::absolute_and_check_exists) —
        // it swallows the real OS error and always reports "path doesn't exist",
        // so an admin-share access-denied looks byte-for-byte identical to a
        // genuinely missing folder. For a remote target that's overwhelmingly the
        // former (two workgroup Windows boxes with no shared local-account
        // credentials), so spell out the fix rather than let the ambiguous message
        // send the operator chasing a "missing folder" that isn't actually missing.
        format!(
            "{e}（{target}）—— 这条报错既可能是目标路径真的不存在，也可能是本机对 {h} 的管理共享没有\
             访问权限（tauri 无法区分两者，工作组环境下两台机器本地账户/密码不一致时会得到一模一样的\
             提示）。先确认路径本身没写错；如果确认无误，需要先在本机对 {h} 建立已认证连接（如执行\
             `net use \\\\{h}` 并输入其账户密码），或在 {h} 上把注册表 LocalAccountTokenFilterPolicy\
             设为 1 以放开本地账户的远程管理共享限制。"
        )
    })
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
///
/// Like `reveal_path`, a registered share covering the path (DDC Mode A/B
/// shares, the auto `volo-zen` dir share) is preferred over `\\host\<drive>$`:
/// workgroup machines can't reach each other's admin shares, but Volo-managed
/// shares come with cmdkey / guest client prep that authenticates silently.
#[tauri::command]
pub fn reveal_remote_path(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    host: String,
    path: String,
) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    if let Some(target) = share_reveal_target(&db, &host, &path) {
        #[cfg(windows)]
        return app
            .opener()
            .reveal_item_in_dir(&target)
            .map_err(|e| format!("{e}（{target}）"));
        #[cfg(not(windows))]
        return app
            .opener()
            .open_url(&target, None::<&str>)
            .map_err(|e| format!("{e}（{target}）"));
    }
    #[cfg(windows)]
    {
        let target = windows_admin_share_unc(&host, &path);
        app.opener().reveal_item_in_dir(&target).map_err(|e| {
            // Same ambiguity as reveal_path: the opener's Windows pre-check
            // collapses access-denied and not-found into one message.
            format!(
                "{e}（{target}）—— 这条报错既可能是目标路径真的不存在，也可能是本机对 {host} 的\
                 管理共享没有访问权限（工作组环境两台机器本地账户互不信任时必然如此）。该目录在 \
                 Volo 里开放为共享（DDC 部署共享 / Zen「设置缓存目录」自动共享）后即可免凭据打开。"
            )
        })
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
