//! Tauri commands for Cache · 文件系统 DDC ③ 本地 DDC · 「DDC 配置通道详情」——
//! the two channels the env-var/registry commands in `env_vars.rs` don't cover
//! yet: the EditorSettings.ini `EditorOverrideSetting` key and the read-only
//! command-line scan, plus the write/clear half of the registry channel.
//!
//! Priority order UE actually resolves a FileSystem DDC store's path in
//! (`FFileSystemCacheStoreParams::Parse`, Engine/Source/Developer/
//! DerivedDataCache/Private/FileSystemCacheStore.cpp — later checks overwrite
//! earlier ones, so the LAST match wins): base `Path=` < env var
//! (`EnvPathOverride`) < registry (`HKCU\Software\Epic Games\
//! GlobalDataCachePath`, same key name) < command line (`CommandLineOverride`)
//! < `EditorOverrideSetting` ini key. BaseEngine.ini's `[DerivedDataBackendGraph]`
//! `Local=`/`Shared=` nodes pin the exact names used on this engine branch:
//!   Local:  EnvPathOverride=UE-LocalDataCachePath, CommandLineOverride=LocalDataCachePath, EditorOverrideSetting=LocalDerivedDataCache
//!   Shared: EnvPathOverride=UE-SharedDataCachePath, CommandLineOverride=SharedDataCachePath, EditorOverrideSetting=SharedDerivedDataCache
//! `EditorOverrideSetting` reads `GConfig->GetString("/Script/UnrealEd.EditorSettings", Key, ..., GEditorSettingsIni)` —
//! ini category `EditorSettings` (UEditorSettings' `UCLASS(config=EditorSettings)`)
//! is explicitly project-agnostic (`LoadRemainingConfigFiles`: "Project agnostic
//! editor ini files, so save them to a shared location (Engine, not Project)",
//! `GeneratedConfigDir = FPaths::EngineEditorSettingsDir()` =
//! `%APPDATA%\Unreal Engine\<major.minor>\Config\`), so it's one file per
//! (runtime user, UE major.minor) — not per project, matching this page's
//! per-machine (not per-project) row model.

use cache_core::core::{command_line_scanner, ini_editor};
use cache_core::data::{machine_ue_installs, machines as data_machines, Db};
use cache_core::error::{VoloError, VoloResult};
use tauri::State;

use super::env_vars::ip_for;

const INI_SECTION: &str = "/Script/UnrealEd.EditorSettings";
const INI_KEY_LOCAL: &str = "LocalDerivedDataCache";
const INI_KEY_SHARED: &str = "SharedDerivedDataCache";

fn require_ue_runtime_user(db: &Db, machine_id: i64) -> VoloResult<String> {
    let user = data_machines::get_ue_runtime_user(db, machine_id)?.ok_or_else(|| {
        VoloError::InvalidInput(format!(
            "machine id={machine_id} has no ue_runtime_user set — 先在机器详情①填「UE 运行用户」"
        ))
    })?;
    validate_runtime_user(&user)?;
    Ok(user)
}

/// The primary (or, absent one, first-seen) UE install's `major.minor`
/// version string — `EditorSettings.ini`'s per-user path is keyed by this,
/// not by any one project's engine association.
fn primary_ue_version(db: &Db, machine_id: i64) -> VoloResult<String> {
    let installs = machine_ue_installs::list_for_machine(db, machine_id)?;
    installs
        .iter()
        .find(|i| i.is_primary)
        .or_else(|| installs.first())
        .map(|i| i.version.clone())
        .ok_or_else(|| {
            VoloError::InvalidInput(format!(
                "machine id={machine_id} 未发现 UE 引擎安装，无法定位 EditorSettings.ini"
            ))
        })
}

/// Rejects path-separator/traversal characters in a value that's about to be
/// interpolated into a filesystem path or registry key — same class of check
/// `ddc-write-registry.ps1`/`ddc-read-registry.ps1` already apply to this
/// exact field over there (`-match '[\/:*?"<>|]' -or Contains('..')`).
/// `ue_runtime_user` is free-text (`set_ue_runtime_user` only trims it), and
/// unlike the registry channel — where the value only ever reaches a
/// PowerShell `-match` guard — the ini channel interpolates it directly into
/// a `C:\Users\<user>\...` path on the Rust side with no such guard, so a
/// corrupted or malicious `ue_runtime_user` (backslashes, `..`) could read or
/// write an ini file outside that user's profile.
fn validate_runtime_user(runtime_user: &str) -> VoloResult<()> {
    if runtime_user.is_empty()
        || runtime_user.contains("..")
        || runtime_user.contains(['\\', '/', ':', '*', '?', '"', '<', '>', '|'])
    {
        return Err(VoloError::InvalidInput(format!(
            "ue_runtime_user contains invalid characters: {runtime_user}"
        )));
    }
    Ok(())
}

fn editor_settings_ini_path(runtime_user: &str, ue_version: &str) -> String {
    format!(
        "C:\\Users\\{runtime_user}\\AppData\\Roaming\\Unreal Engine\\{ue_version}\\Config\\Windows\\EditorSettings.ini"
    )
}

/// Mirrors `FString::ReplaceCharWithEscapedCharInline` (Engine/Source/Runtime/
/// Core/Private/Containers/String.cpp.inl) — the exact escaping UE applies
/// when exporting an FString property to ini text. Windows paths are all
/// backslash-separated (UNC shares start with `\\`), so skipping this
/// entirely turned every saved path into a UE ini parse hazard — e.g.
/// `\\ddc01\Volo\DDC` would round-trip back as `\ddc01\Volo\DDC` (one `\\`
/// collapsed by the read-side unescape below).
///
/// Single left-to-right pass over the ORIGINAL characters (not 6 sequential
/// whole-string `.replace()` calls): each source character is escaped and
/// emitted exactly once, so a just-emitted `\\` can never be re-read as the
/// start of a later rule's pattern. That whole-string-chaining shape is what
/// the engine's own `ReplaceInline`-per-rule loop does, and it has a genuine
/// collision — a path segment starting with `t`/`n`/`r`/`'`/`"` right after a
/// backslash (`D:\temp\DDC`, or a share host named `\\network\...`) makes the
/// unescape side misread the second `\` of an escaped `\\` as the start of
/// `\t`/`\n`/`\r`. A prior version of this function chained `.replace()`
/// calls the same way and reproduced that bug; going single-pass here avoids
/// it entirely rather than betting on whether the real editor has the same
/// quirk for the same input.
fn ue_escape_string(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for c in raw.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\'' => out.push_str("\\'"),
            '"' => out.push_str("\\\""),
            _ => out.push(c),
        }
    }
    out
}

/// Inverse of [`ue_escape_string`] — also a single left-to-right pass, so an
/// escape sequence is consumed atomically and never re-examined once emitted
/// (the collision [`ue_escape_string`]'s doc describes is specifically a
/// unescape-side bug: sequential 2-character-pattern passes let the tail of
/// one escape sequence combine with unrelated following text into a
/// false-positive match for a later rule). A lone backslash not followed by a
/// recognized escape char is passed through as-is (defensive — `ue_escape_string`
/// never emits one, but a hand-edited ini could).
fn ue_unescape_string(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.peek() {
            Some('\\') => { out.push('\\'); chars.next(); }
            Some('n') => { out.push('\n'); chars.next(); }
            Some('r') => { out.push('\r'); chars.next(); }
            Some('t') => { out.push('\t'); chars.next(); }
            Some('\'') => { out.push('\''); chars.next(); }
            Some('"') => { out.push('"'); chars.next(); }
            _ => out.push('\\'),
        }
    }
    out
}

/// `FDirectoryPath` ini struct export is `(Path="...")`; unwrap it into a
/// plain path (unescaping per [`ue_unescape_string`]), treating an empty
/// `Path=` as unset (never `Some("")`).
fn parse_directory_path(raw: &str) -> Option<String> {
    let key = "Path=\"";
    let start = raw.find(key)? + key.len();
    let rest = &raw[start..];
    let end = rest.find('"')?;
    let value = &rest[..end];
    if value.is_empty() {
        None
    } else {
        Some(ue_unescape_string(value))
    }
}

fn wrap_directory_path(value: &str) -> String {
    format!("(Path=\"{}\")", ue_escape_string(value))
}

/// True for either shape `ini_editor::read_section` uses to report a missing
/// file — see the call site in `get_ddc_ini_overrides` for why there are two.
fn is_missing_ini_file(e: &VoloError) -> bool {
    match e {
        VoloError::OperationFailed(msg) => msg.contains("file not found"),
        VoloError::Io(io) => io.kind() == std::io::ErrorKind::NotFound,
        _ => false,
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DdcIniOverrides {
    pub machine_id: i64,
    pub ue_runtime_user: String,
    pub ue_version: String,
    /// `false` = `EditorSettings.ini` doesn't exist yet for this (user, UE
    /// version) pair — the editor's "Project Local/Shared DDC Path" fields
    /// were never touched, not an error.
    pub found: bool,
    pub local_path: Option<String>,
    pub shared_path: Option<String>,
}

/// Read `machine_id`'s `EditorSettings.ini` `[/Script/UnrealEd.EditorSettings]`
/// `LocalDerivedDataCache`/`SharedDerivedDataCache` overrides — the highest-
/// priority of the 4 local-DDC-path config channels (see module doc). Requires
/// `ue_runtime_user` (whose `%APPDATA%` profile hosts the file) and at least
/// one detected UE install (whose `major.minor` names the per-version file).
#[tauri::command]
pub async fn get_ddc_ini_overrides(
    db: State<'_, Db>,
    machine_id: i64,
) -> VoloResult<DdcIniOverrides> {
    let db: Db = (*db).clone();
    tokio::task::spawn_blocking(move || -> VoloResult<DdcIniOverrides> {
        let host = ip_for(&db, machine_id)?;
        let ue_user = require_ue_runtime_user(&db, machine_id)?;
        let ue_version = primary_ue_version(&db, machine_id)?;
        let file_path = editor_settings_ini_path(&ue_user, &ue_version);
        match ini_editor::read_section(&host, &file_path, INI_SECTION) {
            Ok(keys) => {
                let get = |name: &str| {
                    keys.iter()
                        .find(|k| k.name.eq_ignore_ascii_case(name))
                        .and_then(|k| parse_directory_path(&k.value))
                };
                Ok(DdcIniOverrides {
                    machine_id,
                    ue_runtime_user: ue_user,
                    ue_version,
                    found: true,
                    local_path: get(INI_KEY_LOCAL),
                    shared_path: get(INI_KEY_SHARED),
                })
            }
            // Missing EditorSettings.ini means the editor has never written
            // this per-version file yet — a real "从未配置过" state, not a
            // probe failure. Two distinct shapes reach here depending on
            // whether `host` resolves as a loopback target: remote reads go
            // through read-ini-section.ps1, which throws "file not found:
            // <path>" (wrapped as OperationFailed by ini_editor::read_section);
            // a loopback target instead reads the file directly via std::fs
            // (ini_editor::read_section_local), surfacing a missing file as
            // VoloError::Io(NotFound) — same pitfall already hit and fixed for
            // this exact read_section callee in
            // crates/cache-core/src/core/zen/local_port.rs::read_configured_port.
            Err(e) if is_missing_ini_file(&e) => Ok(DdcIniOverrides {
                machine_id,
                ue_runtime_user: ue_user,
                ue_version,
                found: false,
                local_path: None,
                shared_path: None,
            }),
            Err(e) => Err(e),
        }
    })
    .await
    .map_err(|e| VoloError::OperationFailed(format!("ddc ini task join: {}", e)))?
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DdcIniSetResult {
    pub machine_id: i64,
    pub field: String,
    pub value: Option<String>,
}

/// Set (or clear, with `value = ""`) `machine_id`'s `EditorSettings.ini`
/// `LocalDerivedDataCache` (`field = "local"`) or `SharedDerivedDataCache`
/// (`field = "shared"`) override. Creates the ini (and its parent dirs) on
/// first write via `ini_editor::set_key_create` — the editor may never have
/// run on that (user, UE version) pair yet.
#[tauri::command]
pub async fn set_ddc_ini_path(
    db: State<'_, Db>,
    machine_id: i64,
    field: String,
    value: String,
) -> VoloResult<DdcIniSetResult> {
    let key = match field.as_str() {
        "local" => INI_KEY_LOCAL,
        "shared" => INI_KEY_SHARED,
        _ => return Err(VoloError::InvalidInput(format!("unknown ini field: {field}"))),
    };
    let db: Db = (*db).clone();
    tokio::task::spawn_blocking(move || -> VoloResult<DdcIniSetResult> {
        let host = ip_for(&db, machine_id)?;
        let ue_user = require_ue_runtime_user(&db, machine_id)?;
        let ue_version = primary_ue_version(&db, machine_id)?;
        let file_path = editor_settings_ini_path(&ue_user, &ue_version);
        let value = value.trim().to_string();
        let invocation = if value.is_empty() {
            format!("clear EditorSettings.ini {key} on machine {machine_id}")
        } else {
            format!("set EditorSettings.ini {key}={value} on machine {machine_id}")
        };
        crate::commands::oplog::logged(
            &db,
            "ddc.set_ini_path",
            &[machine_id],
            &invocation,
            || -> VoloResult<()> {
                if value.is_empty() {
                    ini_editor::remove_key(&host, &file_path, INI_SECTION, key)?;
                } else {
                    ini_editor::set_key_create(
                        &host,
                        &file_path,
                        INI_SECTION,
                        key,
                        &wrap_directory_path(&value),
                    )?;
                }
                Ok(())
            },
        )?;
        Ok(DdcIniSetResult {
            machine_id,
            field,
            value: if value.is_empty() { None } else { Some(value) },
        })
    })
    .await
    .map_err(|e| VoloError::OperationFailed(format!("ddc ini set task join: {}", e)))?
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DdcRegistrySetResult {
    pub machine_id: i64,
    pub value: Option<String>,
    pub message: String,
}

/// Set (or clear, with `value = ""`) `machine_id`'s `UE-LocalDataCachePath`
/// registry override (`HKCU\SOFTWARE\Epic Games\GlobalDataCachePath`, under
/// `ue_runtime_user`'s hive). Write-side companion of
/// `get_ddc_registry_overrides` — registry-only, does not touch the Machine
/// env var (an independent, lower-priority channel; see module doc).
#[tauri::command]
pub async fn set_ddc_registry_local_path(
    db: State<'_, Db>,
    machine_id: i64,
    value: String,
) -> VoloResult<DdcRegistrySetResult> {
    use cache_core::core::zen::ops as node;
    let db: Db = (*db).clone();
    tokio::task::spawn_blocking(move || -> VoloResult<DdcRegistrySetResult> {
        let host = ip_for(&db, machine_id)?;
        let ue_user = require_ue_runtime_user(&db, machine_id)?;
        let value = value.trim().to_string();
        let invocation = if value.is_empty() {
            format!("clear ddc registry local path on machine {machine_id}")
        } else {
            format!("set ddc registry local path {value} on machine {machine_id}")
        };
        let env = crate::commands::oplog::logged(
            &db,
            "ddc.set_registry_local_path",
            &[machine_id],
            &invocation,
            || {
                node::run_node(
                    &host,
                    "ddc-write-registry.ps1",
                    serde_json::json!({ "RuntimeUser": ue_user, "Value": value }),
                )
                .and_then(|raw| node::parse_envelope(&raw, "ddc-write-registry"))
            },
        )?;
        let message = env
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        Ok(DdcRegistrySetResult {
            machine_id,
            value: if value.is_empty() { None } else { Some(value) },
            message,
        })
    })
    .await
    .map_err(|e| VoloError::OperationFailed(format!("ddc registry set task join: {}", e)))?
}

/// Read-only scan of `machine_id`'s desktop/start-menu shortcuts, `.bat`
/// scripts, and Win32 services for `-LocalDataCachePath=`/
/// `-SharedDataCachePath=` command-line overrides (the ② channel — never
/// writable, since it's baked into whatever launched the process).
#[tauri::command]
pub async fn scan_command_line_args(
    db: State<'_, Db>,
    machine_id: i64,
) -> VoloResult<Vec<command_line_scanner::CmdLineHit>> {
    let db: Db = (*db).clone();
    tokio::task::spawn_blocking(move || {
        let host = ip_for(&db, machine_id)?;
        let exec = cache_core::core::ssh::SshExecutor::from_config()?;
        command_line_scanner::scan(&exec, &host)
    })
    .await
    .map_err(|e| VoloError::OperationFailed(format!("cmdline scan task join: {}", e)))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn directory_path_round_trips_unc_share() {
        // The exact corruption this guards against: an unescaped write would
        // serialize a UNC path's leading `\\` unchanged, and UE's own
        // ReplaceEscapedCharWithCharInline (run on read) would then collapse
        // that `\\` down to a single `\`, silently turning a shared path into
        // a relative one.
        let value = r"\\ddc01\Volo\DDC";
        let wrapped = wrap_directory_path(value);
        assert_eq!(wrapped, r#"(Path="\\\\ddc01\\Volo\\DDC")"#);
        assert_eq!(parse_directory_path(&wrapped).as_deref(), Some(value));
    }

    #[test]
    fn directory_path_round_trips_plain_local_path() {
        // Ordinary backslash-separated path (this codebase's own default,
        // cacheDdc.tsx's commonLocalDir) — no segment starts with a
        // lowercase t/n/r right after a backslash, so it's clear of the
        // engine's own escape-collision limitation documented on
        // `ue_escape_string`.
        let value = r"D:\UE_DDC\Local";
        let wrapped = wrap_directory_path(value);
        assert_eq!(parse_directory_path(&wrapped).as_deref(), Some(value));
    }

    #[test]
    fn directory_path_round_trips_segment_after_backslash_collision_risk() {
        // Regression case for the whole-string-chained-.replace() bug found
        // in code review: a segment starting with t/n/r right after a
        // backslash (D:\temp\DDC — or a share host \\network\...) is exactly
        // where 6-sequential-.replace() unescaping misreads the 2nd `\` of an
        // escaped `\\` as the start of `\t`/`\n`/`\r`. The single-pass
        // escape/unescape must not have this collision.
        for value in [r"D:\temp\DDC", r"D:\network\DDC", r"D:\root\DDC", r"\\nas01\DDC"] {
            let wrapped = wrap_directory_path(value);
            assert_eq!(parse_directory_path(&wrapped).as_deref(), Some(value), "input: {value}");
        }
    }

    #[test]
    fn directory_path_empty_is_unset() {
        assert_eq!(parse_directory_path(r#"(Path="")"#), None);
    }

    #[test]
    fn runtime_user_rejects_path_traversal_and_separators() {
        assert!(validate_runtime_user("svc-ddc").is_ok());
        assert!(validate_runtime_user("svc\\..\\..\\ProgramData").is_err());
        assert!(validate_runtime_user("a/b").is_err());
        assert!(validate_runtime_user("..").is_err());
        assert!(validate_runtime_user("").is_err());
    }
}
