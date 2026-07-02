//! Spawn bridge for the argv-based Python sidecars `vpcal` and `tracksim`
//! (review #15).
//!
//! Unlike `mesh-vba` (a long-lived stdin-JSON / stdout-NDJSON channel driven by
//! the `mesh-adapter-visual-ba` crate), vpcal and tracksim are **plain argv CLIs**
//! (`vpcal <subcommand> …`, `tracksim <subcommand> …`) that print a JSON
//! envelope to stdout under `--output json`. So the bridge here is a simple
//! "locate the binary, run it with argv, capture stdout/stderr/exit-code"
//! command — not an NDJSON event stream. Streaming progress to the frontend is
//! deferred until the feature UIs are designed; the backend通路 just needs to be
//! reachable, which this provides.
//!
//! Binary resolution (mirrors `mesh-adapter-visual-ba::locate`):
//!   1. env override `VOLO_<SIDECAR>_SIDECAR_PATH` (e.g. `VOLO_VPCAL_SIDECAR_PATH`)
//!   2. workspace-relative editable venv `sidecars/<name>/.venv/{bin,Scripts}/<cli>`
//!   3. workspace `target/sidecar-vendor/<platform>/<cli>` (PyInstaller vendor)
//!   4. `current_exe()`-relative `sidecar-vendor/<platform>/<cli>` (packaged)

use std::path::PathBuf;
use std::process::Command;

use serde::Serialize;
use volo_shared::error::{VoloError, VoloResult};

/// The two argv-based sidecars this bridge can spawn. Kept as an explicit enum
/// (not a free-form string) so the frontend can't ask us to exec an arbitrary
/// binary name off disk.
#[derive(Debug, Clone, Copy)]
enum Sidecar {
    Vpcal,
    Tracksim,
}

impl Sidecar {
    fn parse(name: &str) -> VoloResult<Self> {
        match name {
            "vpcal" => Ok(Sidecar::Vpcal),
            "tracksim" => Ok(Sidecar::Tracksim),
            other => Err(VoloError::InvalidInput(format!(
                "unknown sidecar '{other}' (expected 'vpcal' or 'tracksim')"
            ))),
        }
    }

    /// Sidecar package dir name under `sidecars/` and the console-script binary
    /// name (they are the same for both).
    fn cli_name(self) -> &'static str {
        match self {
            Sidecar::Vpcal => "vpcal",
            Sidecar::Tracksim => "tracksim",
        }
    }

    /// `VOLO_VPCAL_SIDECAR_PATH` / `VOLO_TRACKSIM_SIDECAR_PATH`.
    fn env_override(self) -> &'static str {
        match self {
            Sidecar::Vpcal => "VOLO_VPCAL_SIDECAR_PATH",
            Sidecar::Tracksim => "VOLO_TRACKSIM_SIDECAR_PATH",
        }
    }
}

/// PyInstaller vendor platform dir, identical to
/// `mesh-adapter-visual-ba::locate::platform_dir` so all three sidecars share
/// one `target/sidecar-vendor/<platform>/` layout.
fn platform_dir() -> &'static str {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        "windows-x86_64"
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "darwin-arm64"
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        "darwin-x86_64"
    }
    #[cfg(target_os = "linux")]
    {
        "linux-x86_64"
    }
}

fn binary_filename(cli: &str) -> String {
    if cfg!(windows) {
        format!("{cli}.exe")
    } else {
        cli.to_string()
    }
}

/// First `target/` dir walking up from this crate at compile time = the
/// workspace root's target/ (same trick as the visual-ba locator).
fn workspace_target_from_compile_time() -> Option<PathBuf> {
    let mut dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    while dir.pop() {
        let candidate = dir.join("target");
        if candidate.is_dir() {
            return Some(candidate);
        }
    }
    None
}

fn locate(sidecar: Sidecar) -> VoloResult<PathBuf> {
    let cli = sidecar.cli_name();
    let mut tried: Vec<String> = Vec::new();

    // 1. env override.
    if let Ok(p) = std::env::var(sidecar.env_override()) {
        let path = PathBuf::from(&p);
        if path.is_file() {
            return Ok(path);
        }
        tried.push(format!("env {}={p}", sidecar.env_override()));
    }

    if let Some(target) = workspace_target_from_compile_time() {
        if let Some(workspace) = target.parent() {
            // 2. editable venv console script.
            let venv_bin = if cfg!(windows) { "Scripts" } else { "bin" };
            let venv = workspace
                .join("sidecars")
                .join(cli)
                .join(".venv")
                .join(venv_bin)
                .join(binary_filename(cli));
            if venv.is_file() {
                return Ok(venv);
            }
            tried.push(venv.to_string_lossy().into_owned());
        }
        // 3. workspace-root vendored PyInstaller bundle.
        let vendored = target
            .join("sidecar-vendor")
            .join(platform_dir())
            .join(binary_filename(cli));
        if vendored.is_file() {
            return Ok(vendored);
        }
        tried.push(vendored.to_string_lossy().into_owned());
    }

    // 4. packaged runtime: next to the host binary, or in the macOS bundle's
    //    Contents/Resources (where the `../target/sidecar-vendor` tauri.conf
    //    resource lands — exe is in Contents/MacOS, resources one dir over).
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            for rel in ["sidecar-vendor", "../Resources/sidecar-vendor"] {
                let candidate = parent
                    .join(rel)
                    .join(platform_dir())
                    .join(binary_filename(cli));
                if candidate.is_file() {
                    return Ok(candidate);
                }
                tried.push(candidate.to_string_lossy().into_owned());
            }
        }
    }

    Err(VoloError::NotFound(format!(
        "sidecar '{cli}' not found; tried: {}",
        tried.join(", ")
    )))
}

/// Resolve a sidecar binary path by its CLI name (`"vpcal"` / `"tracksim"`).
/// Shared with `sidecar_stream` so the long-running streaming bridge uses the
/// exact same binary-resolution precedence as the one-shot `spawn_sidecar`.
pub(crate) fn locate_by_name(name: &str) -> VoloResult<PathBuf> {
    locate(Sidecar::parse(name)?)
}

/// Result of running a sidecar once: its exit code plus captured streams.
#[derive(Serialize)]
pub struct SidecarOutput {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Run an argv-based sidecar (`vpcal` / `tracksim`) once and return its
/// exit-code + captured stdout/stderr. The frontend passes the sidecar name and
/// the argv after it (e.g. `["manifest", "--output", "json"]`). This is the
/// minimal backend通路 so the Tauri host can reach both sidecars; richer
/// streaming/UX is added once the feature designs land.
#[tauri::command]
pub fn spawn_sidecar(name: String, args: Vec<String>) -> VoloResult<SidecarOutput> {
    let sidecar = Sidecar::parse(&name)?;
    let exe = locate(sidecar)?;

    let output = Command::new(&exe)
        .args(&args)
        .output()
        .map_err(|e| VoloError::Io(format!("failed to spawn {}: {e}", exe.display())))?;

    Ok(SidecarOutput {
        // 128 stands in for "killed by signal, no code" — keeps the field a
        // plain i32 for the frontend rather than an Option.
        exit_code: output.status.code().unwrap_or(128),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_rejects_unknown_sidecar() {
        assert!(matches!(
            Sidecar::parse("bogus"),
            Err(VoloError::InvalidInput(_))
        ));
        assert!(Sidecar::parse("vpcal").is_ok());
        assert!(Sidecar::parse("tracksim").is_ok());
    }

    #[test]
    fn env_override_resolves_when_pointed_at_a_real_file() {
        // Point the override at a known-existing file (this source file) and
        // confirm `locate` honors it. Proves the precedence-1 path without
        // depending on any installed venv.
        let here = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/commands/sidecars.rs");
        std::env::set_var("VOLO_VPCAL_SIDECAR_PATH", &here);
        let got = locate(Sidecar::Vpcal).unwrap();
        std::env::remove_var("VOLO_VPCAL_SIDECAR_PATH");
        assert_eq!(got, here);
    }
}
