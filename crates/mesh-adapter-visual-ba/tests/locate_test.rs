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

fn binary_filename() -> &'static str {
    if cfg!(windows) {
        "lmt-vba-sidecar.exe"
    } else {
        "lmt-vba-sidecar"
    }
}

fn platform_dir() -> &'static str {
    if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "windows-x86_64"
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "darwin-arm64"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "darwin-x86_64"
    } else {
        "linux-x86_64"
    }
}

/// Mirror locate.rs's compile-time workspace resolution: ALL ancestor `target/`
/// dirs (nearest first — a git worktree nested in the main repo yields several),
/// each contributing a (venv sidecar, vendored sidecar) candidate pair in the
/// order locate_sidecar checks them.
fn compile_time_candidate_pairs() -> Vec<(PathBuf, PathBuf)> {
    let manifest = env!("CARGO_MANIFEST_DIR");
    let mut dir = PathBuf::from(manifest);
    let mut out = Vec::new();
    while dir.pop() {
        let target = dir.join("target");
        if !target.is_dir() {
            continue;
        }
        let venv_bin = if cfg!(windows) { "Scripts" } else { "bin" };
        let venv = dir
            .join("sidecars")
            .join("mesh-vba")
            .join(".venv")
            .join(venv_bin)
            .join(binary_filename());
        let vendored = target
            .join("sidecar-vendor")
            .join(platform_dir())
            .join(binary_filename());
        out.push((venv, vendored));
    }
    out
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

/// Stash every workspace sidecar candidate (all ancestors' venv + vendored) so
/// the locator genuinely has nothing to resolve from the dev tree.
fn stash_all(
    pairs: &[(PathBuf, PathBuf)],
) -> Vec<(PathBuf, Option<PathBuf>)> {
    let mut out = Vec::new();
    for (venv, vendored) in pairs {
        out.push((venv.clone(), stash(venv)));
        out.push((vendored.clone(), stash(vendored)));
    }
    out
}

fn unstash_all(stashes: Vec<(PathBuf, Option<PathBuf>)>) {
    for (path, stashed) in stashes {
        unstash(&path, stashed);
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

    // Temporarily stash every real workspace sidecar candidate (all ancestor
    // workspaces' venv + vendored — a worktree nested in the main repo has
    // several) so the locator genuinely has nothing to resolve and must hit
    // the error path. env_lock serializes env-mutating tests, so no concurrent
    // test sees the binaries missing.
    let stashes = stash_all(&compile_time_candidate_pairs());

    env::remove_var("LMT_VBA_SIDECAR_PATH");
    env::remove_var("LMT_VBA_ALLOW_PATH");
    let result = locate_sidecar();

    // Restore the binaries BEFORE asserting, so a failed assertion never leaves
    // a half-stashed dev tree.
    unstash_all(stashes);

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
    let fake = tmp.path().join(binary_filename());
    make_executable_fake(&fake);

    // Stash every real workspace sidecar (all ancestors' vendor + dev venv) so
    // the locator can't short-circuit on them (all are checked before PATH).
    // This forces the opt-in PATH branch to fire deterministically whether or
    // not the dev tree ran a build / has a venv.
    let stashes = stash_all(&compile_time_candidate_pairs());

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
    unstash_all(stashes);

    let resolved = result.unwrap();
    assert_eq!(resolved, fake);
}

#[test]
fn vendor_path_preferred_over_path() {
    let _guard = env_lock();

    // Ensure a binary exists at the NEAREST workspace's vendor path (first
    // candidate pair). If a real PyInstaller build produced one, reuse it;
    // otherwise drop a fake so the test is self-contained. Track whether we
    // created it so we only clean up our own mess.
    let pairs = compile_time_candidate_pairs();
    let (venv, vendor) = pairs.first().expect("workspace target dir not found").clone();
    let mut created_vendor = false;
    if !vendor.is_file() {
        fs::create_dir_all(vendor.parent().unwrap()).unwrap();
        make_executable_fake(&vendor);
        created_vendor = true;
    }
    // Stage a competing binary on PATH and opt PATH lookup in. The vendor path
    // is checked before PATH, so it must win.
    let tmp = tempdir().unwrap();
    let path_fake = tmp.path().join(binary_filename());
    make_executable_fake(&path_fake);

    // The same-workspace dev venv is preferred over vendored, so stash it to
    // assert the vendored-over-PATH precedence specifically. Stash AFTER the
    // panic-prone tempdir/make_executable_fake setup above so an early panic
    // can never strand the developer's real venv binary renamed to `.stashed`.
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
    // Dev-only behavior: requires an editable venv sidecar to exist in some
    // ancestor workspace. Candidates before it (closer ancestors) must be
    // stashed so they can't win first.
    let pairs = compile_time_candidate_pairs();
    let venv_idx = match pairs.iter().position(|(venv, _)| venv.is_file()) {
        Some(i) => i,
        None => {
            eprintln!("skipping venv_preferred_over_vendor: no dev venv sidecar present");
            return;
        }
    };
    let earlier_stashes = stash_all(&pairs[..venv_idx]);
    let (venv, vendor) = pairs[venv_idx].clone();

    // Ensure a vendored binary also exists in the SAME workspace so we're
    // genuinely testing precedence (venv is checked before the vendored
    // bundle of the same ancestor). Clean up only our own fake.
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
    unstash_all(earlier_stashes);
    assert_eq!(
        result.unwrap(),
        venv,
        "dev venv sidecar must be preferred over the vendored bundle"
    );
}
