//! Single-machine INI section read + key write via PowerShell sidecar.

use crate::core::loopback;
use crate::core::ssh::{run_json, NodeScript, SshExecutor};
use crate::error::{VoloError, VoloResult};
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

pub fn read_section(host: &str, file_path: &str, section: &str) -> VoloResult<Vec<IniKey>> {
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
        return Err(VoloError::OperationFailed(format!(
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
) -> VoloResult<String> {
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
        return Err(VoloError::OperationFailed(format!(
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
) -> VoloResult<String> {
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
        return Err(VoloError::OperationFailed(format!(
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
) -> VoloResult<String> {
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
        return Err(VoloError::OperationFailed(format!(
            "remove key failed: {}",
            result.message
        )));
    }
    Ok(result.backup_path)
}

fn read_section_local(file_path: &str, section: &str) -> VoloResult<Vec<IniKey>> {
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
) -> VoloResult<String> {
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

/// Renders a brand-new `node_name=(field=value)` line — used when the target
/// node (or its whole section, or the file itself) doesn't exist yet.
fn fresh_backend_node_line(node_name: &str, field: &str, value: &str) -> String {
    let mut node = crate::core::ini_backend_graph::BackendNode {
        name: node_name.to_string(),
        fields: Vec::new(),
        line_number: 0,
    };
    crate::core::ini_backend_graph::upsert_field(&mut node, field, value);
    crate::core::ini_backend_graph::write_node(&node)
}

/// Writes a single field of a `[section]` `node_name=(...)` backend-graph
/// node, creating the node / section / file as needed when any of them don't
/// exist yet — a project's `DefaultEngine.ini` commonly has no
/// `[DerivedDataBackendGraph]` override at all until the first join/edit, and
/// erroring there would make the ② 共享 DDC 配置通道详情 panel's "设置" button
/// permanently unusable for such a project (mirrors `set_key_create`'s
/// create-on-first-write behavior for the sibling ini-key channel).
fn write_backend_field_local(
    file_path: &str, section: &str, node_name: &str, field: &str, value: &str,
) -> VoloResult<()> {
    use std::fs;
    let body = match fs::read_to_string(file_path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(VoloError::OperationFailed(format!("read {}: {}", file_path, e))),
    };
    let mut out: Vec<String> = Vec::with_capacity(body.lines().count() + 2);
    let mut in_section = false;
    let mut section_seen = false;
    let mut handled = false;
    for raw in body.lines() {
        let trimmed = raw.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            // Leaving our target section without having found the node — append
            // it as the section's last line before the next section header.
            if in_section && !handled {
                out.push(fresh_backend_node_line(node_name, field, value));
                handled = true;
            }
            in_section = trimmed[1..trimmed.len() - 1].eq_ignore_ascii_case(section);
            section_seen = section_seen || in_section;
            out.push(raw.to_string());
            continue;
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
    // Our target section was the last one in the file (loop ended still inside it).
    if in_section && !handled {
        out.push(fresh_backend_node_line(node_name, field, value));
        handled = true;
    }
    // Section never appeared at all — append a fresh `[section]` + node block.
    if !handled {
        if out.last().is_some_and(|line| !line.trim().is_empty()) {
            out.push(String::new());
        }
        out.push(format!("[{}]", section));
        out.push(fresh_backend_node_line(node_name, field, value));
    }
    out.push(String::new());
    fs::write(file_path, out.join("\n"))
        .map_err(|e| VoloError::OperationFailed(format!("write {}: {}", file_path, e)))?;
    Ok(())
}

/// Inverse of [`write_backend_field_local`]: drop a single field from a
/// struct-style backend node. Idempotent — a missing file/section/node/field is
/// a no-op success (returns false), matching the remote sidecar (which treats an
/// absent file as ok), because leave() rolls back best-effort and must not fail
/// just because an INI was hand-edited, deleted, or never had the join's fields.
/// Best-effort note: with no pre-join snapshot we can only remove the fields the
/// join wrote, not restore prior values.
fn remove_backend_field_local(
    file_path: &str, section: &str, node_name: &str, field: &str,
) -> VoloResult<bool> {
    use std::fs;
    let body = match fs::read_to_string(file_path) {
        Ok(b) => b,
        // Missing file == nothing wired to roll back (parity with remote sidecar).
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(VoloError::OperationFailed(format!("read {}: {}", file_path, e))),
    };
    let mut out: Vec<String> = Vec::with_capacity(body.lines().count() + 1);
    let mut in_section = false;
    let mut changed = false;
    for raw in body.lines() {
        let trimmed = raw.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            in_section = trimmed[1..trimmed.len() - 1].eq_ignore_ascii_case(section);
            out.push(raw.to_string()); continue;
        }
        if in_section && !changed {
            if let Ok(mut node) = crate::core::ini_backend_graph::parse_node(raw, 0) {
                if node.name.eq_ignore_ascii_case(node_name)
                    && crate::core::ini_backend_graph::remove_field(&mut node, field)
                {
                    out.push(crate::core::ini_backend_graph::write_node(&node));
                    changed = true;
                    continue;
                }
            }
        }
        out.push(raw.to_string());
    }
    if changed {
        out.push(String::new());
        fs::write(file_path, out.join("\n"))
            .map_err(|e| VoloError::OperationFailed(format!("write {}: {}", file_path, e)))?;
    }
    Ok(changed)
}

pub fn remove_backend_field(
    host: &str, file_path: &str, section: &str, node_name: &str, field: &str,
) -> VoloResult<String> {
    if loopback::is_loopback_target(host) {
        let changed = remove_backend_field_local(file_path, section, node_name, field)?;
        return Ok(if changed {
            format!("removed {}.{} locally", node_name, field)
        } else {
            format!("{}.{} already absent locally", node_name, field)
        });
    }
    let exec = SshExecutor::from_config()?;
    let r: BackendFieldResult = run_json(
        &exec,
        host,
        &NodeScript {
            name: "remove-backend-field.ps1",
            args: serde_json::json!({
                "FilePath": file_path, "SectionName": section, "NodeName": node_name,
                "FieldName": field
            }),
            ssh_user: None,
        },
    )?;
    if !r.ok { return Err(VoloError::OperationFailed(r.message)); }
    Ok(r.message)
}

#[derive(Debug, serde::Deserialize)]
struct BackendFieldResult { ok: bool, message: String }

pub fn set_backend_field(
    host: &str, file_path: &str, section: &str, node_name: &str,
    field: &str, value: &str,
) -> VoloResult<String> {
    if loopback::is_loopback_target(host) {
        // Same create-on-first-write parent-dir handling as `set_key_create`:
        // `write_backend_field_local` now creates a missing section/node/file's
        // *content*, but `fs::write` still needs the parent directory to exist.
        if let Some(parent) = std::path::Path::new(file_path).parent() {
            std::fs::create_dir_all(parent)?;
        }
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
    if !r.ok { return Err(VoloError::OperationFailed(r.message)); }
    Ok(r.message)
}

/// True for either shape `read_section` uses to report a missing file: remote
/// reads throw `"file not found: <path>"` from `read-ini-section.ps1`
/// (wrapped as `OperationFailed`); a loopback target instead surfaces
/// `std::io::ErrorKind::NotFound` from `read_section_local`'s `std::fs` call
/// (same distinction `get_ddc_ini_overrides` in `ddc_channels.rs` needs for
/// the EditorSettings.ini channel — that command reuses this via the `pub`
/// visibility instead of keeping its own copy).
pub fn is_missing_file(e: &VoloError) -> bool {
    match e {
        VoloError::OperationFailed(msg) => msg.contains("file not found"),
        VoloError::Io(io) => io.kind() == std::io::ErrorKind::NotFound,
        _ => false,
    }
}

/// Read-side counterpart of [`set_backend_field`]/[`remove_backend_field`]:
/// reads one `[section]` `node_name=(...)` backend-graph node (e.g. the
/// `Shared` node's `Type`/`Path`/`EnvPathOverride`/... fields) and returns its
/// fields in source order. `None` means "no config yet" (file, section, or
/// node not found) — a real state for the 共享 DDC 配置通道 panel's per-project
/// rows, not an error; a genuine transport/parse failure still bubbles as Err.
pub fn get_backend_field(
    host: &str, file_path: &str, section: &str, node_name: &str,
) -> VoloResult<Option<Vec<(String, String)>>> {
    let keys = match read_section(host, file_path, section) {
        Ok(k) => k,
        Err(e) if is_missing_file(&e) => return Ok(None),
        Err(e) => return Err(e),
    };
    let Some(key) = keys.iter().find(|k| k.name.eq_ignore_ascii_case(node_name)) else {
        return Ok(None);
    };
    let line = format!("{}={}", key.name, key.value);
    // A parse failure here means the node LINE EXISTS but is malformed (hand-edited,
    // truncated, ...) — a real diagnostic condition, not "never configured". Bubbling
    // it as Err (rather than folding it into the same Ok(None) as "node absent") lets
    // callers surface "未核对 · <reason>" instead of a confident-looking "未设" that
    // would silently mask the corrupted config.
    crate::core::ini_backend_graph::parse_node(&line, 0)
        .map(|node| Some(node.fields))
        .map_err(|e| {
            VoloError::OperationFailed(format!(
                "malformed backend node [{}] {} in {}: {:?}",
                section, node_name, file_path, e
            ))
        })
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
    fn set_backend_field_creates_node_when_missing_from_existing_section() {
        // A project's DefaultEngine.ini may have a [DerivedDataBackendGraph]
        // section with other nodes but no Shared override yet — the ② panel's
        // first "设置" click for that project must still succeed.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("DefaultEngine.ini");
        std::fs::write(&path, "[DerivedDataBackendGraph]\nBoot=(Type=Boot)\n").unwrap();
        write_backend_field_local(path.to_str().unwrap(), "DerivedDataBackendGraph", "Shared", "Path", r"\\ddc01\Volo\DDC").unwrap();
        let body = std::fs::read_to_string(&path).unwrap();
        assert!(body.contains("Boot=(Type=Boot)"), "existing node preserved");
        let line = body.lines().find(|l| l.starts_with("Shared=")).unwrap();
        assert!(line.contains(r"Path=\\ddc01\Volo\DDC"));
    }

    #[test]
    fn set_backend_field_creates_section_when_missing_from_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("DefaultEngine.ini");
        std::fs::write(&path, "[SomeOtherSection]\nFoo=Bar\n").unwrap();
        write_backend_field_local(path.to_str().unwrap(), "DerivedDataBackendGraph", "Shared", "Path", r"\\ddc01\Volo\DDC").unwrap();
        let body = std::fs::read_to_string(&path).unwrap();
        assert!(body.contains("[SomeOtherSection]"), "existing section preserved");
        assert!(body.contains("[DerivedDataBackendGraph]"));
        let line = body.lines().find(|l| l.starts_with("Shared=")).unwrap();
        assert!(line.contains(r"Path=\\ddc01\Volo\DDC"));
    }

    #[test]
    fn set_backend_field_creates_file_when_missing() {
        // Through the public set_backend_field (not write_backend_field_local
        // directly) — parent-directory creation lives at that layer, same as
        // set_key_create's split of concerns.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("does-not-exist").join("DefaultEngine.ini");
        assert!(!path.exists());
        set_backend_field("localhost", path.to_str().unwrap(), "DerivedDataBackendGraph", "Shared", "Path", r"\\ddc01\Volo\DDC").unwrap();
        let body = std::fs::read_to_string(&path).unwrap();
        assert!(body.contains("[DerivedDataBackendGraph]"));
        let line = body.lines().find(|l| l.starts_with("Shared=")).unwrap();
        assert!(line.contains(r"Path=\\ddc01\Volo\DDC"));
    }

    #[test]
    fn remove_backend_field_drops_join_fields_and_preserves_rest() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("DefaultEngine.ini");
        std::fs::write(
            &path,
            "[DerivedDataBackendGraph]\nShared=(Type=FileSystem, ReadOnly=false, Path=\\\\LANPC\\Volo_DDC, EnvPathOverride=UE-SharedDataCachePath)\n",
        )
        .unwrap();
        assert!(remove_backend_field_local(path.to_str().unwrap(), "DerivedDataBackendGraph", "Shared", "Path").unwrap());
        assert!(remove_backend_field_local(path.to_str().unwrap(), "DerivedDataBackendGraph", "Shared", "EnvPathOverride").unwrap());
        let body = std::fs::read_to_string(&path).unwrap();
        let line = body.lines().find(|l| l.starts_with("Shared=")).unwrap();
        assert!(!line.contains("Path="));
        assert!(!line.contains("EnvPathOverride="));
        assert!(line.contains("Type=FileSystem"));
        assert!(line.contains("ReadOnly=false"));
    }

    #[test]
    fn remove_backend_field_missing_file_is_ok() {
        // Parity with the remote sidecar (file-absent -> ok): a project whose
        // DefaultEngine.ini was deleted/moved must not fail the best-effort leave.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("does-not-exist").join("DefaultEngine.ini");
        let changed = remove_backend_field_local(path.to_str().unwrap(), "DerivedDataBackendGraph", "Shared", "Path").unwrap();
        assert!(!changed);
    }

    #[test]
    fn remove_backend_field_is_idempotent_when_absent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("DefaultEngine.ini");
        std::fs::write(&path, "[DerivedDataBackendGraph]\nShared=(Type=FileSystem)\n").unwrap();
        // Field not present -> false, file untouched. Missing node -> false too.
        assert!(!remove_backend_field_local(path.to_str().unwrap(), "DerivedDataBackendGraph", "Shared", "Path").unwrap());
        assert!(!remove_backend_field_local(path.to_str().unwrap(), "DerivedDataBackendGraph", "Boot", "Path").unwrap());
        let body = std::fs::read_to_string(&path).unwrap();
        assert!(body.contains("Shared=(Type=FileSystem)"));
    }

    #[test]
    fn get_backend_field_returns_fields_in_source_order() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("DefaultEngine.ini");
        std::fs::write(
            &path,
            "[DerivedDataBackendGraph]\nShared=(Type=FileSystem, Path=\\\\ddc01\\Volo\\DDC, EnvPathOverride=UE-SharedDataCachePath)\n",
        )
        .unwrap();
        let fields = get_backend_field("localhost", path.to_str().unwrap(), "DerivedDataBackendGraph", "Shared")
            .unwrap()
            .expect("node should be found");
        assert_eq!(
            fields,
            vec![
                ("Type".to_string(), "FileSystem".to_string()),
                ("Path".to_string(), r"\\ddc01\Volo\DDC".to_string()),
                ("EnvPathOverride".to_string(), "UE-SharedDataCachePath".to_string()),
            ]
        );
    }

    #[test]
    fn get_backend_field_missing_node_is_none() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("DefaultEngine.ini");
        std::fs::write(&path, "[DerivedDataBackendGraph]\nBoot=(Type=Boot)\n").unwrap();
        assert!(get_backend_field("localhost", path.to_str().unwrap(), "DerivedDataBackendGraph", "Shared").unwrap().is_none());
    }

    #[test]
    fn get_backend_field_missing_file_is_none_not_error() {
        // A project whose DefaultEngine.ini hasn't been touched yet (never joined
        // a share) must read as "no config" for the shared-DDC channel panel, not
        // an error that surfaces as "未核对".
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("does-not-exist").join("DefaultEngine.ini");
        assert!(get_backend_field("localhost", path.to_str().unwrap(), "DerivedDataBackendGraph", "Shared").unwrap().is_none());
    }

    #[test]
    fn get_backend_field_malformed_node_is_error_not_unset() {
        // A node line that exists but fails to parse (hand-edited, truncated —
        // missing the closing paren here) is a real diagnostic condition and
        // must surface as Err ("未核对"), not silently read as "未设" like a
        // genuinely-absent node would.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("DefaultEngine.ini");
        std::fs::write(&path, "[DerivedDataBackendGraph]\nShared=(Type=FileSystem\n").unwrap();
        let r = get_backend_field("localhost", path.to_str().unwrap(), "DerivedDataBackendGraph", "Shared");
        assert!(matches!(r, Err(VoloError::OperationFailed(_))), "expected Err, got {:?}", r);
    }
}
