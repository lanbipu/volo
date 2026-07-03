//! Local zen desired-port override (`[Zen.AutoLaunch] DesiredPort`).
//!
//! UE 5.8 reads `DesiredPort` (default 8558) when the editor auto-launches a
//! LOCAL zen daemon (`ZenServerInterface.cpp:1547`) and passes it verbatim as
//! `--port <n>` — a busy port is NOT retried with another. On a workstation
//! that also hosts the SHARED zen service (which owns 8558), the local zen
//! therefore needs a per-machine override, written to the machine-local
//! `UserEngine.ini` (same file / path construction as `zen enable --global`:
//! `C:\Users\{ue_runtime_user}\AppData\Local\Unreal Engine\Engine\Config\
//! UserEngine.ini`), affecting every UE project on that machine and taking
//! effect at the next editor restart.
//!
//! This module owns the pure INI half:
//! * [`set_local_port`] / [`clear_local_port`] — idempotent write/remove via
//!   the per-key PS sidecar (`.bak.<timestamp>` on every mutation).
//! * [`read_configured_port`] — current `DesiredPort` value, `None` when the
//!   file/section/key is absent (UE default 8558 applies).
//! * [`parse_port_from_cmdline`] — extract `--port <n>` from a zen
//!   runcontext's `commandline_arguments`, the "actual running port" half of
//!   the status readout (runcontext fetch itself stays with its existing
//!   owners in the CLI / Tauri layers).
//! * [`validate_port`] — range 1024–65535 and ≠ the shared upstream's
//!   `declared_port` on the same machine (caller resolves that from the DB
//!   and passes it as `forbidden`).

use crate::core::ini_editor::{read_section, remove_key, set_key_create};
use crate::error::{VoloError, VoloResult};

/// INI section UE's auto-launch reads.
pub const SECTION: &str = "Zen.AutoLaunch";
/// Key within [`SECTION`].
pub const KEY: &str = "DesiredPort";
/// UE default local zen port when no override is present.
pub const DEFAULT_PORT: i64 = 8558;

/// Outcome of [`set_local_port`] / [`clear_local_port`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PortWriteOutcome {
    /// `false` when the INI was already at the target state (no write issued).
    pub changed: bool,
    /// Pre-change `DesiredPort` value, if the key existed.
    pub previous: Option<i64>,
    /// `.bak.<timestamp>` path from the PS sidecar; `None` on no-op.
    pub backup: Option<String>,
}

/// Validate a desired local port. `forbidden` is the shared upstream zen
/// service's `declared_port` on the SAME machine (the conflict this whole
/// feature exists to avoid) — pass `None` when the machine hosts no shared
/// service.
pub fn validate_port(port: i64, forbidden: Option<i64>) -> VoloResult<()> {
    if !(1024..=65535).contains(&port) {
        return Err(VoloError::InvalidInput(format!(
            "port {port} out of range — DesiredPort must be 1024–65535"
        )));
    }
    if Some(port) == forbidden {
        return Err(VoloError::InvalidInput(format!(
            "port {port} is the shared zen service's declared_port on this machine — \
             pick a different local port (e.g. 8559)"
        )));
    }
    Ok(())
}

/// Read the configured `DesiredPort` from `ini_path` on `host`.
/// `None` = file/section/key absent (UE default 8558 applies) — a missing
/// file is NOT an error, matching `enable_global`'s read semantics. Any other
/// read failure (SSH unreachable, sidecar error) propagates: reporting an
/// unreadable machine as "no override" would be a lie the status view acts on.
pub fn read_configured_port(host: &str, ini_path: &str) -> VoloResult<Option<i64>> {
    let rows = match read_section(host, ini_path, SECTION) {
        Ok(rows) => rows,
        // Missing file means "no override yet", not a failure. Local loopback
        // surfaces io NotFound — match on the ErrorKind, NOT the message: on
        // Windows the io::Error Display text is a localized FormatMessageW
        // string that contains neither "file not found" nor "No such file".
        Err(VoloError::Io(ref io)) if io.kind() == std::io::ErrorKind::NotFound => {
            return Ok(None);
        }
        // The read-ini-section.ps1 sidecar throws its own fixed English
        // "file not found: <path>" for an absent remote file.
        Err(e) if e.to_string().contains("file not found") => return Ok(None),
        Err(e) => return Err(e),
    };
    Ok(rows
        .iter()
        .find(|k| k.name.eq_ignore_ascii_case(KEY))
        .and_then(|k| k.value.trim().parse::<i64>().ok()))
}

/// Write `DesiredPort = port` into `[Zen.AutoLaunch]` of `ini_path` on
/// `host`, creating the file if absent. Idempotent: if the key already holds
/// `port`, no write is issued and `changed = false`.
pub fn set_local_port(
    host: &str,
    ini_path: &str,
    port: i64,
    forbidden: Option<i64>,
) -> VoloResult<PortWriteOutcome> {
    validate_port(port, forbidden)?;
    let previous = read_configured_port(host, ini_path)?;
    if previous == Some(port) {
        return Ok(PortWriteOutcome { changed: false, previous, backup: None });
    }
    let backup = set_key_create(host, ini_path, SECTION, KEY, &port.to_string())?;
    Ok(PortWriteOutcome {
        changed: true,
        previous,
        backup: Some(backup),
    })
}

/// Remove the `DesiredPort` override (machine reverts to UE default 8558 at
/// next editor restart). No-op when the file or key is already absent.
pub fn clear_local_port(host: &str, ini_path: &str) -> VoloResult<PortWriteOutcome> {
    let previous = read_configured_port(host, ini_path)?;
    if previous.is_none() {
        return Ok(PortWriteOutcome { changed: false, previous: None, backup: None });
    }
    let backup = remove_key(host, ini_path, SECTION, KEY)?;
    Ok(PortWriteOutcome {
        changed: true,
        previous,
        backup: Some(backup),
    })
}

/// Extract the `--port <n>` value from a zen runcontext's
/// `commandline_arguments` string — the port the LOCAL zen was actually
/// launched with. `None` when the flag is absent or malformed.
pub fn parse_port_from_cmdline(args: &str) -> Option<u16> {
    let mut it = args.split_whitespace();
    while let Some(tok) = it.next() {
        if tok == "--port" {
            return it.next().and_then(|v| v.trim_matches('"').parse::<u16>().ok());
        }
        if let Some(v) = tok.strip_prefix("--port=") {
            return v.trim_matches('"').parse::<u16>().ok();
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_ini(name: &str) -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(name).to_string_lossy().into_owned();
        (dir, path)
    }

    #[test]
    fn validate_rejects_out_of_range_and_forbidden() {
        assert!(validate_port(1023, None).is_err());
        assert!(validate_port(65536, None).is_err());
        assert!(validate_port(8558, Some(8558)).is_err());
        assert!(validate_port(8559, Some(8558)).is_ok());
        assert!(validate_port(8558, None).is_ok());
    }

    #[test]
    fn set_creates_file_and_is_idempotent() {
        let (_d, ini) = tmp_ini("UserEngine.ini");
        // File absent → configured port None.
        assert_eq!(read_configured_port("127.0.0.1", &ini).unwrap(), None);

        let out = set_local_port("127.0.0.1", &ini, 8559, Some(8558)).unwrap();
        assert!(out.changed);
        assert_eq!(out.previous, None);
        let text = std::fs::read_to_string(&ini).unwrap();
        assert!(text.contains("[Zen.AutoLaunch]"));
        assert!(text.contains("DesiredPort=8559"));
        assert_eq!(read_configured_port("127.0.0.1", &ini).unwrap(), Some(8559));

        // Same value again → no-op.
        let out2 = set_local_port("127.0.0.1", &ini, 8559, Some(8558)).unwrap();
        assert!(!out2.changed);
        assert_eq!(out2.previous, Some(8559));
        assert!(out2.backup.is_none());
    }

    #[test]
    fn clear_removes_key_and_is_idempotent() {
        let (_d, ini) = tmp_ini("UserEngine.ini");
        // Clear on absent file → no-op, not an error.
        let out0 = clear_local_port("127.0.0.1", &ini).unwrap();
        assert!(!out0.changed);

        set_local_port("127.0.0.1", &ini, 8559, None).unwrap();
        let out = clear_local_port("127.0.0.1", &ini).unwrap();
        assert!(out.changed);
        assert_eq!(out.previous, Some(8559));
        assert_eq!(read_configured_port("127.0.0.1", &ini).unwrap(), None);
    }

    #[test]
    fn set_rejects_forbidden_port_without_touching_file() {
        let (_d, ini) = tmp_ini("UserEngine.ini");
        assert!(set_local_port("127.0.0.1", &ini, 8558, Some(8558)).is_err());
        assert!(!std::path::Path::new(&ini).exists());
    }

    #[test]
    fn parse_port_from_cmdline_variants() {
        assert_eq!(parse_port_from_cmdline("--port 8559 --owner-pid 123"), Some(8559));
        assert_eq!(parse_port_from_cmdline("--owner-pid 123 --port=8558"), Some(8558));
        assert_eq!(parse_port_from_cmdline("--port \"8559\""), Some(8559));
        assert_eq!(parse_port_from_cmdline("--owner-pid 123"), None);
        assert_eq!(parse_port_from_cmdline("--port abc"), None);
    }
}
