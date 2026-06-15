//! Locate sidecar tests. Use a serial mutex because env var mutation is
//! global and parallel tests would race.

use std::env;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use mesh_adapter_visual_ba::locate::locate_sidecar;
use tempfile::tempdir;

static ENV_LOCK: Mutex<()> = Mutex::new(());

/// Acquire the env lock, recovering from poisoning. These tests mutate
/// process-global env vars, so a panic in one must not cascade-fail the rest
/// via a poisoned mutex — the guard's only job is mutual exclusion.
fn env_lock() -> std::sync::MutexGuard<'static, ()> {
    ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

fn make_executable_fake(path: &std::path::Path) {
    fs::write(path, b"#!/bin/sh\necho hi\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }
}

/// Mirror locate.rs's compile-time vendor path resolution so the test can
/// assert on the exact path the locator prefers (workspace target dir, walking
/// up from CARGO_MANIFEST_DIR to the first `target/` dir).
fn compile_time_vendor_path() -> Option<PathBuf> {
    let manifest = env!("CARGO_MANIFEST_DIR");
    let mut dir = PathBuf::from(manifest);
    let target = loop {
        if !dir.pop() {
            return None;
        }
        let candidate = dir.join("target");
        if candidate.is_dir() {
            break candidate;
        }
    };
    let filename = if cfg!(windows) {
        "lmt-vba-sidecar.exe"
    } else {
        "lmt-vba-sidecar"
    };
    let platform = if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "windows-x86_64"
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "darwin-arm64"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "darwin-x86_64"
    } else {
        "linux-x86_64"
    };
    Some(target.join("sidecar-vendor").join(platform).join(filename))
}

/// Mirror locate.rs's dev venv-sidecar path (workspace root + sidecars/mesh-vba/
/// .venv/bin/<bin>). locate_sidecar prefers this editable install over the
/// vendored bundle, so fallback tests must stash it (like the vendor binary)
/// to exercise the lower-precedence branches deterministically.
fn compile_time_venv_path() -> Option<PathBuf> {
    let manifest = env!("CARGO_MANIFEST_DIR");
    let mut dir = PathBuf::from(manifest);
    let workspace = loop {
        if !dir.pop() {
            return None;
        }
        if dir.join("target").is_dir() {
            break dir.clone();
        }
    };
    let filename = if cfg!(windows) {
        "lmt-vba-sidecar.exe"
    } else {
        "lmt-vba-sidecar"
    };
    let venv_bin = if cfg!(windows) { "Scripts" } else { "bin" };
    Some(
        workspace
            .join("sidecars")
            .join("mesh-vba")
            .join(".venv")
            .join(venv_bin)
            .join(filename),
    )
}

/// Rename `path` → `path.stashed` if it exists; returns the stashed path so the
/// caller can restore it. Used to hide real workspace sidecar binaries (vendor /
/// venv) so the locator's lower-precedence branches are exercised deterministically.
fn stash(path: &std::path::Path) -> Option<PathBuf> {
    let stashed = path.with_extension("stashed");
    if path.is_file() && fs::rename(path, &stashed).is_ok() {
        Some(stashed)
    } else {
        None
    }
}

fn unstash(path: &std::path::Path, stashed: Option<PathBuf>) {
    if let Some(s) = stashed {
        let _ = fs::rename(&s, path);
    }
}

#[test]
fn env_var_override_takes_precedence() {
    let _guard = env_lock();
    let tmp = tempdir().unwrap();
    let fake = tmp.path().join("fake-sidecar");
    make_executable_fake(&fake);
    env::set_var("LMT_VBA_SIDECAR_PATH", fake.to_str().unwrap());
    let resolved = locate_sidecar().unwrap();
    assert_eq!(resolved, fake);
    env::remove_var("LMT_VBA_SIDECAR_PATH");
}

#[test]
fn missing_sidecar_returns_error_when_path_disabled() {
    let _guard = env_lock();

    // Temporarily stash any real workspace vendor binary (e.g. one produced by
    // build_exe.sh) so the locator genuinely has nothing to resolve and must
    // hit the error path. Without this, a dev tree that ran the build would
    // silently skip the regression check. env_lock serializes env-mutating
    // tests, so no concurrent test sees the binary missing.
    let vendor = compile_time_vendor_path().expect("workspace target dir not found");
    let venv = compile_time_venv_path().expect("workspace not found");
    let vendor_stash = stash(&vendor);
    let venv_stash = stash(&venv);

    env::remove_var("LMT_VBA_SIDECAR_PATH");
    env::remove_var("LMT_VBA_ALLOW_PATH");
    let result = locate_sidecar();

    // Restore the binaries BEFORE asserting, so a failed assertion never leaves
    // a half-stashed dev tree.
    unstash(&vendor, vendor_stash);
    unstash(&venv, venv_stash);

    let err_str = format!(
        "{:?}",
        result
            .err()
            .expect("must error when no sidecar present and PATH lookup disabled")
    );
    assert!(
        err_str.contains("PATH lookup disabled"),
        "expected PATH disabled note, got {err_str}"
    );
}

#[test]
fn path_fallback_opt_in_finds_binary() {
    let _guard = env_lock();
    let tmp = tempdir().unwrap();
    let fake = tmp.path().join(if cfg!(windows) {
        "lmt-vba-sidecar.exe"
    } else {
        "lmt-vba-sidecar"
    });
    make_executable_fake(&fake);

    // Stash any real workspace sidecar (vendor + dev venv) so the locator can't
    // short-circuit on them (both are checked before PATH). This forces the
    // opt-in PATH branch to fire deterministically whether or not the dev tree
    // ran a build / has a venv.
    let vendor = compile_time_vendor_path().expect("workspace target dir not found");
    let venv = compile_time_venv_path().expect("workspace not found");
    let vendor_stash = stash(&vendor);
    let venv_stash = stash(&venv);

    env::remove_var("LMT_VBA_SIDECAR_PATH");
    let saved = env::var_os("PATH");
    env::set_var("PATH", tmp.path());
    env::set_var("LMT_VBA_ALLOW_PATH", "1");

    let result = locate_sidecar();

    // Restore env + binaries BEFORE asserting so a failure can't leave a
    // half-stashed dev tree or a clobbered PATH.
    if let Some(p) = saved {
        env::set_var("PATH", p);
    }
    env::remove_var("LMT_VBA_ALLOW_PATH");
    unstash(&vendor, vendor_stash);
    unstash(&venv, venv_stash);

    let resolved = result.unwrap();
    assert_eq!(resolved, fake);
}

#[test]
fn vendor_path_preferred_over_path() {
    let _guard = env_lock();

    // Ensure a binary exists at the compile-time workspace vendor path. If a
    // real PyInstaller build produced one, reuse it; otherwise drop a fake so
    // the test is self-contained. Track whether we created it so we only clean
    // up our own mess (never delete a real built binary).
    let vendor = compile_time_vendor_path().expect("workspace target dir not found");
    let mut created_vendor = false;
    if !vendor.is_file() {
        fs::create_dir_all(vendor.parent().unwrap()).unwrap();
        make_executable_fake(&vendor);
        created_vendor = true;
    }
    // Stage a competing binary on PATH and opt PATH lookup in. The vendor path
    // is checked before PATH, so it must win.
    let tmp = tempdir().unwrap();
    let path_fake = tmp.path().join(if cfg!(windows) {
        "lmt-vba-sidecar.exe"
    } else {
        "lmt-vba-sidecar"
    });
    make_executable_fake(&path_fake);

    // The dev venv is preferred over vendored, so stash it to assert the
    // vendored-over-PATH precedence specifically. Stash AFTER the panic-prone
    // tempdir/make_executable_fake setup above so an early panic can never strand
    // the developer's real (editable) venv binary renamed to `.stashed`.
    let venv = compile_time_venv_path().expect("workspace not found");
    let venv_stash = stash(&venv);

    env::remove_var("LMT_VBA_SIDECAR_PATH");
    let saved_path = env::var_os("PATH");
    env::set_var("PATH", tmp.path());
    env::set_var("LMT_VBA_ALLOW_PATH", "1");

    let result = locate_sidecar();

    if let Some(p) = saved_path {
        env::set_var("PATH", p);
    }
    env::remove_var("LMT_VBA_ALLOW_PATH");
    unstash(&venv, venv_stash);
    if created_vendor {
        let _ = fs::remove_file(&vendor);
    }

    let resolved = result.unwrap();
    assert_eq!(
        resolved, vendor,
        "vendor path should be preferred over PATH candidate {path_fake:?}"
    );
}

#[test]
fn venv_preferred_over_vendor() {
    let _guard = env_lock();
    // Dev-only behavior: requires the editable venv sidecar to exist.
    let venv = compile_time_venv_path().expect("workspace not found");
    if !venv.is_file() {
        eprintln!("skipping venv_preferred_over_vendor: no dev venv sidecar present");
        return;
    }
    // Ensure a vendored binary also exists so we're genuinely testing precedence
    // (venv is checked before the vendored bundle). Clean up only our own fake.
    let vendor = compile_time_vendor_path().expect("workspace target dir not found");
    let mut created_vendor = false;
    if !vendor.is_file() {
        fs::create_dir_all(vendor.parent().unwrap()).unwrap();
        make_executable_fake(&vendor);
        created_vendor = true;
    }

    env::remove_var("LMT_VBA_SIDECAR_PATH");
    let result = locate_sidecar();

    if created_vendor {
        let _ = fs::remove_file(&vendor);
    }
    assert_eq!(
        result.unwrap(),
        venv,
        "dev venv sidecar must be preferred over the vendored bundle"
    );
}
