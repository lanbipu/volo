//! Single-machine INI section read + key write via PowerShell sidecar.

use crate::core::loopback;
use crate::core::ssh::{run_json, NodeScript, SshExecutor};
use crate::error::{UecmError, UecmResult};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IniKey {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Deserialize)]
pub struct ReadResult {
    pub ok: bool,
    pub keys: Vec<IniKey>,
    pub message: String,
}

#[derive(Debug, Deserialize)]
pub struct WriteResult {
    pub ok: bool,
    pub backup_path: String,
    pub message: String,
}

pub fn read_section(host: &str, file_path: &str, section: &str) -> UecmResult<Vec<IniKey>> {
    if loopback::is_loopback_target(host) {
        return read_section_local(file_path, section);
    }

    let exec = SshExecutor::from_config()?;
    let result: ReadResult = run_json(
        &exec,
        host,
        &NodeScript {
            name: "read-ini-section.ps1",
            args: serde_json::json!({ "FilePath": file_path, "Section": section }),
            ssh_user: None,
        },
    )?;
    if !result.ok {
        return Err(UecmError::OperationFailed(format!(
            "read INI failed: {}",
            result.message
        )));
    }
    Ok(result.keys)
}

pub fn set_key(
    host: &str,
    file_path: &str,
    section: &str,
    name: &str,
    value: &str,
) -> UecmResult<String> {
    if loopback::is_loopback_target(host) {
        return write_key_local(file_path, section, name, Some(value));
    }

    let exec = SshExecutor::from_config()?;
    let result: WriteResult = run_json(
        &exec,
        host,
        &NodeScript {
            name: "write-ini-key.ps1",
            args: serde_json::json!({
                "FilePath": file_path, "Section": section, "Name": name,
                "Value": value, "Remove": false
            }),
            ssh_user: None,
        },
    )?;
    if !result.ok {
        return Err(UecmError::OperationFailed(format!(
            "write INI failed: {}",
            result.message
        )));
    }
    Ok(result.backup_path)
}

/// Same as [`set_key`] but passes `CreateIfMissing: true` to the PS sidecar,
/// so the file (and its parent directory) are created when absent.
/// Used by `zen enable --global` to write `UserEngine.ini` on machines where
/// the user has never opened UE Engine Settings.
pub fn set_key_create(
    host: &str,
    file_path: &str,
    section: &str,
    name: &str,
    value: &str,
) -> UecmResult<String> {
    if loopback::is_loopback_target(host) {
        // Local path: create parent dir + empty file if missing, then write.
        if let Some(parent) = std::path::Path::new(file_path).parent() {
            std::fs::create_dir_all(parent)?;
        }
        if !std::path::Path::new(file_path).exists() {
            std::fs::write(file_path, "")?;
        }
        return write_key_local(file_path, section, name, Some(value));
    }

    let exec = SshExecutor::from_config()?;
    let result: WriteResult = run_json(
        &exec,
        host,
        &NodeScript {
            name: "write-ini-key.ps1",
            args: serde_json::json!({
                "FilePath": file_path, "Section": section, "Name": name,
                "Value": value, "Remove": false, "CreateIfMissing": true
            }),
            ssh_user: None,
        },
    )?;
    if !result.ok {
        return Err(UecmError::OperationFailed(format!(
            "write INI (create) failed: {}",
            result.message
        )));
    }
    Ok(result.backup_path)
}

/// Removes a key from an INI section on a remote host (or locally for a loopback
/// target). Returns the backup path created by the PS sidecar.
pub fn remove_key(
    host: &str,
    file_path: &str,
    section: &str,
    name: &str,
) -> UecmResult<String> {
    if loopback::is_loopback_target(host) {
        return write_key_local(file_path, section, name, None);
    }

    let exec = SshExecutor::from_config()?;
    let result: WriteResult = run_json(
        &exec,
        host,
        &NodeScript {
            name: "write-ini-key.ps1",
            args: serde_json::json!({
                "FilePath": file_path, "Section": section, "Name": name,
                "Value": "", "Remove": true
            }),
            ssh_user: None,
        },
    )?;
    if !result.ok {
        return Err(UecmError::OperationFailed(format!(
            "remove key failed: {}",
            result.message
        )));
    }
    Ok(result.backup_path)
}

fn read_section_local(file_path: &str, section: &str) -> UecmResult<Vec<IniKey>> {
    let contents = std::fs::read_to_string(file_path)?;
    let mut keys = Vec::new();
    let mut in_section = false;
    let section_marker = format!("[{}]", section);

    for line in contents.lines() {
        let trim = line.trim();
        if trim.eq_ignore_ascii_case(&section_marker) {
            in_section = true;
            continue;
        }
        if in_section && trim.starts_with('[') && trim.ends_with(']') {
            break;
        }
        if in_section
            && !trim.is_empty()
            && !trim.starts_with(';')
            && !trim.starts_with('#')
        {
            if let Some(eq) = trim.find('=') {
                if eq > 0 {
                    keys.push(IniKey {
                        name: trim[..eq].trim().to_string(),
                        value: trim[eq + 1..].trim().to_string(),
                    });
                }
            }
        }
    }

    Ok(keys)
}

fn write_key_local(
    file_path: &str,
    section: &str,
    name: &str,
    value: Option<&str>,
) -> UecmResult<String> {
    let contents = std::fs::read_to_string(file_path)?;
    let backup = local_backup_path(file_path);
    std::fs::copy(file_path, &backup)?;

    let remove = value.is_none();
    let mut out = Vec::new();
    let mut in_section = false;
    let mut section_seen = false;
    let mut written = false;
    let section_marker = format!("[{}]", section);

    for line in contents.lines() {
        let trim = line.trim();
        if trim.eq_ignore_ascii_case(&section_marker) {
            in_section = true;
            section_seen = true;
            out.push(line.to_string());
            continue;
        }
        if in_section && trim.starts_with('[') && trim.ends_with(']') {
            if !remove && !written {
                out.push(format!("{}={}", name, value.unwrap_or_default()));
                written = true;
            }
            in_section = false;
            out.push(line.to_string());
            continue;
        }
        if in_section && key_matches(trim, name) {
            if remove {
                continue;
            }
            out.push(format!("{}={}", name, value.unwrap_or_default()));
            written = true;
            continue;
        }
        out.push(line.to_string());
    }

    if !remove && !written && in_section {
        out.push(format!("{}={}", name, value.unwrap_or_default()));
    }

    if !remove && !section_seen {
        if out.last().is_some_and(|line| !line.trim().is_empty()) {
            out.push(String::new());
        }
        out.push(section_marker);
        out.push(format!("{}={}", name, value.unwrap_or_default()));
    }

    let mut updated = out.join("\n");
    if contents.ends_with('\n') || !updated.is_empty() {
        updated.push('\n');
    }
    std::fs::write(file_path, updated)?;

    Ok(backup)
}

/// Codex round-15 P2: case-INSENSITIVE comparison to match UE's INI
/// reader and the `write-ini-key.ps1` sidecar (both treat keys
/// case-insensitively). The previous `==` left a path where the
/// caller had matched an existing key via `eq_ignore_ascii_case`
/// (e.g. `zenshared` vs canonical `ZenShared`) but the local-loopback
/// writer here used `==`, leaving the existing row untouched while
/// reporting `changed=true`. Aligning with the sidecar means both
/// transport paths converge on the same disk state.
fn key_matches(trimmed_line: &str, name: &str) -> bool {
    trimmed_line
        .find('=')
        .map(|eq| trimmed_line[..eq].trim().eq_ignore_ascii_case(name))
        .unwrap_or(false)
}

fn local_backup_path(file_path: &str) -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{}.bak.{}", file_path, millis)
}

fn write_backend_field_local(
    file_path: &str, section: &str, node_name: &str, field: &str, value: &str,
) -> UecmResult<()> {
    use std::fs;
    let body = fs::read_to_string(file_path)
        .map_err(|e| UecmError::OperationFailed(format!("read {}: {}", file_path, e)))?;
    let mut out: Vec<String> = Vec::with_capacity(body.lines().count() + 1);
    let mut in_section = false;
    let mut handled = false;
    for raw in body.lines() {
        let trimmed = raw.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            in_section = trimmed[1..trimmed.len() - 1].eq_ignore_ascii_case(section);
            out.push(raw.to_string()); continue;
        }
        if in_section && !handled {
            if let Ok(mut node) = crate::core::ini_backend_graph::parse_node(raw, 0) {
                if node.name.eq_ignore_ascii_case(node_name) {
                    crate::core::ini_backend_graph::upsert_field(&mut node, field, value);
                    out.push(crate::core::ini_backend_graph::write_node(&node));
                    handled = true;
                    continue;
                }
            }
        }
        out.push(raw.to_string());
    }
    if !handled {
        return Err(UecmError::OperationFailed(format!(
            "section [{}] node {} not found in {}", section, node_name, file_path)));
    }
    out.push(String::new());
    fs::write(file_path, out.join("\n"))
        .map_err(|e| UecmError::OperationFailed(format!("write {}: {}", file_path, e)))?;
    Ok(())
}

#[derive(Debug, serde::Deserialize)]
struct BackendFieldResult { ok: bool, message: String }

pub fn set_backend_field(
    host: &str, file_path: &str, section: &str, node_name: &str,
    field: &str, value: &str,
) -> UecmResult<String> {
    if loopback::is_loopback_target(host) {
        write_backend_field_local(file_path, section, node_name, field, value)?;
        return Ok(format!("wrote {}.{} locally", node_name, field));
    }
    let exec = SshExecutor::from_config()?;
    let r: BackendFieldResult = run_json(
        &exec,
        host,
        &NodeScript {
            name: "set-backend-field.ps1",
            args: serde_json::json!({
                "FilePath": file_path, "SectionName": section, "NodeName": node_name,
                "FieldName": field, "FieldValue": value
            }),
            ssh_user: None,
        },
    )?;
    if !r.ok { return Err(UecmError::OperationFailed(r.message)); }
    Ok(r.message)
}

#[cfg(test)]
mod tests {
    use super::*;

    // (Old `#[cfg(not(windows))]` "returns PowerShell error" tests removed: remote
    // read/write paths now go over SSH — they error at ssh connect and from_config
    // would touch the real config dir. Loopback behavior is covered by the tests
    // below; remote behavior is validated on a real node.)

    #[test]
    fn set_key_create_creates_missing_file_and_writes_key() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("subdir").join("UserEngine.ini");
        let path_str = path.to_str().unwrap();
        // File and parent dir do not exist yet.
        assert!(!path.exists());
        set_key_create("127.0.0.1", path_str, "InstalledDerivedDataBackendGraph", "ZenShared", "(Type=Zen)")
            .expect("set_key_create should create file and write key");
        let contents = std::fs::read_to_string(&path).unwrap();
        assert!(contents.contains("ZenShared=(Type=Zen)"));
    }

    #[test]
    fn set_key_writes_directly_for_loopback_target() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("DefaultEngine.ini");
        std::fs::write(&path, "[DDC]\nPath=Old\n").unwrap();

        let backup = set_key(
            "localhost",
            &path.to_string_lossy(),
            "DDC",
            "Path",
            "New",
        )
        .unwrap();

        let updated = std::fs::read_to_string(&path).unwrap();
        assert!(updated.contains("Path=New"));
        assert!(std::path::Path::new(&backup).exists());
    }

    #[test]
    fn read_section_local_is_case_insensitive() {
        // The file uses [DDC] but caller asks for "ddc" — should still match,
        // matching the remote PowerShell path's case-insensitive comparison.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("DefaultEngine.ini");
        std::fs::write(&path, "[DDC]\nPath=Old\nSize=1024\n").unwrap();

        let keys = read_section_local(path.to_str().unwrap(), "ddc").unwrap();
        assert!(keys.iter().any(|k| k.name == "Path" && k.value == "Old"));
        assert!(keys.iter().any(|k| k.name == "Size" && k.value == "1024"));
    }

    #[test]
    fn set_key_section_match_is_case_insensitive() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("DefaultEngine.ini");
        std::fs::write(&path, "[DDC]\nPath=Old\n").unwrap();

        set_key(
            "localhost", &path.to_string_lossy(),
            "ddc", "Path", "New",
        ).unwrap();

        let updated = std::fs::read_to_string(&path).unwrap();
        assert!(updated.contains("[DDC]"), "original section header preserved");
        assert!(updated.contains("Path=New"));
        assert!(!updated.contains("Path=Old"));
    }

    #[test]
    fn remove_key_writes_directly_for_loopback_target() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("DefaultEngine.ini");
        std::fs::write(&path, "[DDC]\nPath=Old\nKeep=1\n").unwrap();

        remove_key(
            "localhost",
            &path.to_string_lossy(),
            "DDC",
            "Path",
        )
        .unwrap();

        let updated = std::fs::read_to_string(&path).unwrap();
        assert!(!updated.contains("Path=Old"));
        assert!(updated.contains("Keep=1"));
    }

    // Codex round-15 P2: local-loopback writer must match keys
    // case-insensitively, same as the remote PS sidecar and UE's
    // INI reader. Without this a lowercase `zenshared` row would
    // survive a `remove ZenShared` call while `changed=true` was
    // reported.
    #[test]
    fn remove_key_loopback_matches_existing_case_variant() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("DefaultEngine.ini");
        // Existing row uses lowercase key; canonical caller asks to
        // remove the camelCase form.
        std::fs::write(
            &path,
            "[InstalledDerivedDataBackendGraph]\nzenshared=(Type=Zen, Host=\"x\", Port=1, Namespace=\"y\")\nKeep=1\n",
        )
        .unwrap();

        remove_key(
            "localhost",
            &path.to_string_lossy(),
            "InstalledDerivedDataBackendGraph",
            "ZenShared",
        )
        .unwrap();

        let updated = std::fs::read_to_string(&path).unwrap();
        assert!(
            !updated.to_ascii_lowercase().contains("zenshared="),
            "case-mismatched legacy key must be removed, got: {}",
            updated
        );
        assert!(updated.contains("Keep=1"), "unrelated key must survive");
    }

    #[test]
    fn set_key_loopback_overwrites_existing_case_variant() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("DefaultEngine.ini");
        std::fs::write(&path, "[DDC]\npath=old\n").unwrap();

        set_key(
            "localhost",
            &path.to_string_lossy(),
            "DDC",
            "Path",
            "new",
        )
        .unwrap();

        let updated = std::fs::read_to_string(&path).unwrap();
        // The original `path=old` row should be gone, replaced by canonical
        // `Path=new` — no duplicate row left behind.
        let path_lines: Vec<_> = updated
            .lines()
            .filter(|l| l.to_ascii_lowercase().starts_with("path="))
            .collect();
        assert_eq!(path_lines.len(), 1, "expected exactly one Path row, got: {:?}", path_lines);
        assert!(updated.contains("Path=new"));
        assert!(!updated.contains("path=old"));
    }

    #[test]
    fn set_backend_field_preserves_order_and_updates_value() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("DefaultEngine.ini");
        std::fs::write(&path, "[DerivedDataBackendGraph]\nShared=(Type=FileSystem, ReadOnly=true, Path=\\\\NAS\\DDC)\n").unwrap();

        write_backend_field_local(path.to_str().unwrap(), "DerivedDataBackendGraph", "Shared", "ReadOnly", "false").unwrap();
        let body = std::fs::read_to_string(&path).unwrap();
        let line = body.lines().find(|l| l.starts_with("Shared=")).unwrap();
        let type_idx = line.find("Type=").unwrap();
        let ro_idx = line.find("ReadOnly=").unwrap();
        let path_idx = line.find("Path=").unwrap();
        assert!(type_idx < ro_idx && ro_idx < path_idx);
        assert!(body.contains("ReadOnly=false"));
        assert!(!body.contains("ReadOnly=true"));
    }

    #[test]
    fn set_backend_field_appends_missing_field_at_end() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("DefaultEngine.ini");
        std::fs::write(&path, "[DerivedDataBackendGraph]\nShared=(Type=FileSystem)\n").unwrap();
        write_backend_field_local(path.to_str().unwrap(), "DerivedDataBackendGraph", "Shared", "ReadOnly", "false").unwrap();
        let body = std::fs::read_to_string(&path).unwrap();
        let line = body.lines().find(|l| l.starts_with("Shared=")).unwrap();
        assert!(line.find("Type=").unwrap() < line.find("ReadOnly=").unwrap());
    }

    #[test]
    fn set_backend_field_errors_when_node_missing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("DefaultEngine.ini");
        std::fs::write(&path, "[DerivedDataBackendGraph]\nBoot=(Type=Boot)\n").unwrap();
        let r = write_backend_field_local(path.to_str().unwrap(), "DerivedDataBackendGraph", "Shared", "ReadOnly", "false");
        assert!(matches!(r, Err(UecmError::OperationFailed(_))));
    }
}
