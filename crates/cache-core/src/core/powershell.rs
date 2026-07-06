//! PowerShell sidecar invocation. On Windows, runs powershell.exe with
//! provided script + args, captures stdout, returns parsed JSON result.
//! On non-Windows, returns an error (sidecar is Windows-only).

use crate::error::{VoloError, VoloResult};
use serde::de::DeserializeOwned;
use std::fs;
use std::path::{Path, PathBuf};
#[cfg(windows)]
use std::process::Command;

/// Decode bytes captured from a Windows subprocess (powershell.exe,
/// robocopy.exe, etc.).
///
/// PowerShell 5.x and other native Windows tools on Chinese Windows emit
/// stderr in the OEM/ANSI codepage (CP936 / GBK) rather than UTF-8, so
/// `from_utf8_lossy` produces a wall of U+FFFD replacement characters that
/// hides the real error. Try strict UTF-8 first (covers English systems and
/// PowerShell 7+ defaults), fall back to GBK on failure.
#[cfg(any(windows, test))]
pub(crate) fn decode_subprocess_output(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => {
            let (cow, _, had_errors) = encoding_rs::GBK.decode(bytes);
            if had_errors {
                tracing::warn!(
                    bytes_len = bytes.len(),
                    "powershell output is neither valid UTF-8 nor clean GBK; \
                     decoded string may contain U+FFFD"
                );
            }
            cow.into_owned()
        }
    }
}

/// Resolve a sidecar script name to its on-disk path.
/// Respects `UECM_PS_DIR` env override (returned unconditionally — caller wants
/// that exact dir), then searches per-file:
///   1. `<exe-dir>/ps-scripts/<name>` — production install (Tauri bundle.resources)
///   2. `<workspace-root>/src-tauri/resources/ps-scripts/<name>` — dev builds
///      via `CARGO_MANIFEST_DIR` (cache-core is two dirs below the root)
///
/// File-existence is checked per `name` so a partially-populated exe-dir
/// (e.g. an older copy missing a newly added script) still falls back to the
/// repo-root copy. If no candidate exists, the manifest-relative path is
/// returned as a last resort so the caller's `fs::read` failure surfaces a
/// useful error message.
pub fn script_path(name: &str) -> PathBuf {
    if let Ok(over) = std::env::var("UECM_PS_DIR") {
        return PathBuf::from(over).join(name);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let candidate = parent.join("ps-scripts").join(name);
            if candidate.is_file() {
                return candidate;
            }
            // Packaged Tauri app on macOS: resources live in Contents/Resources,
            // i.e. <exe-dir>/../Resources/ps-scripts.
            let bundled = parent.join("../Resources/ps-scripts").join(name);
            if bundled.is_file() {
                return bundled;
            }
        }
    }
    // step 2c dev fallback: scripts moved under <workspace>/src-tauri/resources.
    // CARGO_MANIFEST_DIR = <workspace>/crates/cache-core → up two to the root.
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(std::path::Path::parent)
        .unwrap_or_else(|| std::path::Path::new("."))
        .join("src-tauri/resources/ps-scripts")
        .join(name)
}

/// Candidate sidecar dirs in `script_path`'s priority order. Used to enumerate
/// the full node-script set for staging; callers resolve each name via
/// `script_path` so a stale/partial exe-dir still falls back to repo-root
/// per-file (matching how scripts are resolved for execution).
pub fn script_dirs() -> Vec<PathBuf> {
    if let Ok(over) = std::env::var("UECM_PS_DIR") {
        return vec![PathBuf::from(over)];
    }
    let mut dirs = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let dir = parent.join("ps-scripts");
            if dir.is_dir() {
                dirs.push(dir);
            }
            // Packaged Tauri app on macOS: <exe-dir>/../Resources/ps-scripts.
            let bundled = parent.join("../Resources/ps-scripts");
            if bundled.is_dir() {
                dirs.push(bundled);
            }
        }
    }
    dirs.push(
        // step 2c dev fallback: <workspace>/src-tauri/resources/ps-scripts.
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(Path::parent)
            .unwrap_or_else(|| Path::new("."))
            .join("src-tauri/resources/ps-scripts"),
    );
    dirs
}

/// Load a sidecar script's text. Used when the script body is forwarded to a
/// node and run there (over SSH) rather than executed locally.
pub fn read_script(name: &str) -> VoloResult<String> {
    Ok(fs::read_to_string(script_path(name))?)
}

/// Resolve a vendored binary's on-disk path (e.g. `PsExec64.exe`).
/// Respects `UECM_VENDOR_DIR` env override, then searches (mirrors
/// [`script_path`], which resolves `ps-scripts` symmetrically):
///   1. `<exe-dir>/vendor/<name>` — production install
///   2. `<exe-dir>/../Resources/vendor/<name>` — packaged Tauri app on macOS
///   3. `<workspace>/src-tauri/resources/vendor/<name>` — dev fallback
pub fn vendor_path(name: &str) -> PathBuf {
    if let Ok(over) = std::env::var("UECM_VENDOR_DIR") {
        return PathBuf::from(over).join(name);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let candidate = parent.join("vendor").join(name);
            if candidate.exists() {
                return candidate;
            }
            // Packaged Tauri app on macOS: resources live in Contents/Resources,
            // i.e. <exe-dir>/../Resources/vendor.
            let bundled = parent.join("../Resources/vendor").join(name);
            if bundled.exists() {
                return bundled;
            }
        }
    }
    // FIX (review #5): dev fallback was `<repo-root>/vendor` (= crates/vendor,
    // which never existed). Vendor resources actually live under
    // src-tauri/resources/vendor, bundled exactly like ps-scripts. Walk up TWO
    // levels (CARGO_MANIFEST_DIR = <workspace>/crates/cache-core → workspace
    // root) and join src-tauri/resources/vendor, symmetric with script_path.
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(std::path::Path::parent)
        .unwrap_or_else(|| std::path::Path::new("."))
        .join("src-tauri/resources/vendor")
        .join(name)
}

#[derive(Debug)]
pub struct ScriptResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

/// Run a .ps1 script with the given arguments. Returns raw output.
pub fn run_script(script_path: &Path, args: &[&str]) -> VoloResult<ScriptResult> {
    #[cfg(windows)]
    {
        let mut cmd = Command::new("powershell.exe");
        crate::core::proc::hide_console(&mut cmd);
        cmd.arg("-NoProfile")
            .arg("-ExecutionPolicy")
            .arg("Bypass")
            .arg("-File")
            .arg(script_path);
        for arg in args {
            cmd.arg(arg);
        }
        let output = cmd.output().map_err(|e| {
            VoloError::PowerShell(format!("failed to spawn powershell.exe: {}", e))
        })?;
        Ok(ScriptResult {
            stdout: decode_subprocess_output(&output.stdout),
            stderr: decode_subprocess_output(&output.stderr),
            exit_code: output.status.code().unwrap_or(-1),
        })
    }
    #[cfg(not(windows))]
    {
        let _ = (script_path, args);
        Err(VoloError::PowerShell(
            "PowerShell sidecar is Windows-only".to_string(),
        ))
    }
}

/// Run a .ps1 script feeding `stdin` to its standard input. The node-pure
/// scripts read their JSON args via `[Console]::In.ReadLine()`, so this lets the
/// loopback distribute path run the SAME script locally as the remote SSH path.
pub fn run_script_stdin(script_path: &Path, stdin: &str) -> VoloResult<ScriptResult> {
    #[cfg(windows)]
    {
        use std::io::Write;
        use std::process::Stdio;
        let mut child = crate::core::proc::hide_console(Command::new("powershell.exe").arg("-NoProfile"))
            .arg("-NonInteractive")
            .arg("-ExecutionPolicy")
            .arg("Bypass")
            .arg("-File")
            .arg(script_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| {
                VoloError::PowerShell(format!("failed to spawn powershell.exe: {}", e))
            })?;
        child
            .stdin
            .take()
            .ok_or_else(|| VoloError::PowerShell("failed to open powershell stdin".into()))?
            .write_all(stdin.as_bytes())
            .map_err(|e| {
                VoloError::PowerShell(format!("failed to write powershell stdin: {}", e))
            })?;
        let output = child.wait_with_output().map_err(|e| {
            VoloError::PowerShell(format!("failed to wait for powershell.exe: {}", e))
        })?;
        Ok(ScriptResult {
            stdout: decode_subprocess_output(&output.stdout),
            stderr: decode_subprocess_output(&output.stderr),
            exit_code: output.status.code().unwrap_or(-1),
        })
    }
    #[cfg(not(windows))]
    {
        let _ = (script_path, stdin);
        Err(VoloError::PowerShell(
            "PowerShell sidecar is Windows-only".to_string(),
        ))
    }
}

/// Parse a sidecar's stdout as JSON of type T.
///
/// Most sidecars emit `{ ok: bool, ... }` to stdout AND `exit 1` on the
/// catch path so callers that only check exit code see an empty stderr.
/// Try to parse stdout first regardless of exit code — if it deserializes
/// to T, return it (caller inspects the `ok` field). Only fall back to the
/// raw exit-code error message when stdout doesn't parse cleanly.
fn parse_script_json<T: DeserializeOwned>(result: ScriptResult) -> VoloResult<T> {
    if !result.stdout.trim().is_empty() {
        if let Ok(parsed) = serde_json::from_str::<T>(&result.stdout) {
            return Ok(parsed);
        }
    }
    if result.exit_code != 0 {
        return Err(VoloError::PowerShell(format!(
            "script exited with code {}: {}",
            result.exit_code,
            if result.stderr.trim().is_empty() {
                result.stdout.trim()
            } else {
                result.stderr.trim()
            }
        )));
    }
    serde_json::from_str(&result.stdout).map_err(|e| {
        VoloError::PowerShell(format!(
            "failed to parse JSON output: {} (stdout: {})",
            e, result.stdout
        ))
    })
}

/// Run a script with args and parse stdout as JSON of type T.
pub fn run_json<T: DeserializeOwned>(script_path: &Path, args: &[&str]) -> VoloResult<T> {
    parse_script_json(run_script(script_path, args)?)
}

/// Like `run_json`, but feeds `stdin` to the script (for node-pure scripts that
/// read their JSON args from standard input rather than `-File` arguments).
pub fn run_json_stdin<T: DeserializeOwned>(script_path: &Path, stdin: &str) -> VoloResult<T> {
    parse_script_json(run_script_stdin(script_path, stdin)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ENV_TEST_LOCK;
    #[cfg(windows)]
    use serde::Deserialize;

    #[cfg(windows)]
    #[derive(Debug, Deserialize)]
    struct EchoOutput {
        received: String,
        machine: String,
    }

    #[cfg(windows)]
    #[test]
    fn test_echo_script_returns_parsed_json() {
        let script = Path::new("../ps-scripts/test-echo.ps1");
        let result: EchoOutput = run_json(script, &["world"]).unwrap();
        assert_eq!(result.received, "world");
        assert!(!result.machine.is_empty());
    }

    #[cfg(not(windows))]
    #[test]
    fn run_script_returns_error_on_non_windows() {
        let script = Path::new("../ps-scripts/test-echo.ps1");
        let result = run_script(script, &[]);
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), VoloError::PowerShell(_)));
    }

    #[test]
    fn decode_handles_pure_ascii() {
        let bytes = b"-File ..\\ps-scripts\\test-echo.ps1";
        assert_eq!(
            decode_subprocess_output(bytes),
            "-File ..\\ps-scripts\\test-echo.ps1"
        );
    }

    #[test]
    fn decode_handles_valid_utf8() {
        let bytes = "hello UTF-8 中文".as_bytes();
        assert_eq!(decode_subprocess_output(bytes), "hello UTF-8 中文");
    }

    #[test]
    fn decode_falls_back_to_gbk_for_chinese_windows_stderr() {
        // GBK bytes for "无法找到文件" — a fragment of PowerShell 5.x's
        // ScriptFileNotProvided message on zh-CN Windows. Decoder must
        // recover the original characters without producing U+FFFD.
        let gbk_bytes: &[u8] = &[
            0xCE, 0xDE, 0xB7, 0xA8, 0xD5, 0xD2, 0xB5, 0xBD, 0xCE, 0xC4, 0xBC, 0xFE,
        ];
        let decoded = decode_subprocess_output(gbk_bytes);
        assert_eq!(decoded, "无法找到文件");
        assert!(!decoded.contains('\u{FFFD}'));
    }

    #[test]
    fn script_path_respects_env_override() {
        let _lock = ENV_TEST_LOCK.lock().unwrap();
        std::env::set_var("UECM_PS_DIR", "/tmp/test-ps-override");
        let p = script_path("foo.ps1");
        assert_eq!(p, std::path::PathBuf::from("/tmp/test-ps-override/foo.ps1"));
        std::env::remove_var("UECM_PS_DIR");
    }
}
