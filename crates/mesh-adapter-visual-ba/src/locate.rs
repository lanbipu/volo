//! Locate the sidecar binary on disk.
//!
//! Search order:
//!   1. env var `LMT_VBA_SIDECAR_PATH` (always honored — dev / Tauri vendor)
//!   2. compile-time workspace target dir (cargo dev runs)
//!   3. `current_exe()`-relative `sidecar-vendor/<platform>/lmt-vba-sidecar`
//!      (packaged runtime — Tauri ships the sidecar next to the host binary)
//!   4. `PATH` lookup ONLY if `LMT_VBA_ALLOW_PATH=1` is set explicitly
//!      (off by default — protects against PATH-injection of an attacker-
//!      controlled `lmt-vba-sidecar`).

use std::env;
use std::path::PathBuf;

use crate::error::{VbaError, VbaResult};

const ENV_OVERRIDE: &str = "LMT_VBA_SIDECAR_PATH";
const ENV_ALLOW_PATH: &str = "LMT_VBA_ALLOW_PATH";
const BINARY_NAME: &str = "lmt-vba-sidecar";

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

fn binary_filename() -> &'static str {
    if cfg!(windows) {
        "lmt-vba-sidecar.exe"
    } else {
        "lmt-vba-sidecar"
    }
}

/// Compile-time workspace target dir resolution. `env!` is evaluated when
/// this crate is built, so the path is baked in regardless of runtime env.
fn workspace_target_from_compile_time() -> Option<PathBuf> {
    let manifest = env!("CARGO_MANIFEST_DIR");
    let mut dir = PathBuf::from(manifest);
    while dir.pop() {
        let candidate = dir.join("target");
        if candidate.is_dir() {
            return Some(candidate);
        }
    }
    None
}

/// In packaged runtimes (Tauri bundle), the sidecar lives next to the host
/// binary under `sidecar-vendor/<platform>/`.
fn sidecar_next_to_exe() -> Option<PathBuf> {
    let exe = env::current_exe().ok()?;
    let dir = exe.parent()?;
    let candidate = dir
        .join("sidecar-vendor")
        .join(platform_dir())
        .join(binary_filename());
    if candidate.is_file() {
        Some(candidate)
    } else {
        None
    }
}

fn search_path(name: &str) -> Option<PathBuf> {
    let path = env::var_os("PATH")?;
    for dir in env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

pub fn locate_sidecar() -> VbaResult<PathBuf> {
    let mut tried: Vec<String> = Vec::new();

    if let Ok(p) = env::var(ENV_OVERRIDE) {
        let path = PathBuf::from(&p);
        if path.is_file() {
            return Ok(path);
        }
        tried.push(format!("env {ENV_OVERRIDE}={p}"));
    }

    // Workspace-relative dev resolution (single compile-time ancestor-walk).
    // Prefer the editable venv sidecar (always current with source) over the
    // possibly-stale vendored bundle. Both are fixed workspace-relative paths
    // (NOT a PATH search), so no PATH-injection risk; both are absent in packaged
    // installs, where this whole block falls through to the exe-relative lookup.
    if let Some(target) = workspace_target_from_compile_time() {
        // venv console scripts live in `Scripts` on Windows, `bin` elsewhere.
        if let Some(workspace) = target.parent() {
            let venv_bin = if cfg!(windows) { "Scripts" } else { "bin" };
            let venv = workspace
                .join("python-sidecar")
                .join(".venv")
                .join(venv_bin)
                .join(binary_filename());
            if venv.is_file() {
                return Ok(venv);
            }
            tried.push(venv.to_string_lossy().into_owned());
        }
        let vendored = target
            .join("sidecar-vendor")
            .join(platform_dir())
            .join(binary_filename());
        if vendored.is_file() {
            return Ok(vendored);
        }
        tried.push(vendored.to_string_lossy().into_owned());
    }

    if let Some(p) = sidecar_next_to_exe() {
        return Ok(p);
    }
    tried.push(format!(
        "current_exe-relative sidecar-vendor/{}/{}",
        platform_dir(),
        binary_filename()
    ));

    // PATH fallback is off by default — opt-in for dev / system-installed sidecars.
    if env::var(ENV_ALLOW_PATH).map(|v| v == "1").unwrap_or(false) {
        if let Some(p) = search_path(binary_filename()) {
            return Ok(p);
        }
        tried.push(format!(
            "PATH:{BINARY_NAME} (LMT_VBA_ALLOW_PATH=1, not found)"
        ));
    } else {
        tried.push(format!(
            "PATH lookup disabled (set {ENV_ALLOW_PATH}=1 to enable)"
        ));
    }

    Err(VbaError::SidecarNotFound { tried })
}
