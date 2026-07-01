//! Shared startup paths and bootstrapping for both binaries (`uecm`, `uecm-cli`).
//!
//! Replaces the Tauri-only `app.path().app_data_dir()` and `app.path().resolve()`
//! lookups so the CLI can initialize without a Tauri Builder context.

use crate::data::{self, Db};
use crate::error::{VoloError, VoloResult};
use directories::BaseDirs;
use std::env;
use std::path::{Path, PathBuf};

/// Bundle identifier that mirrors `src-tauri/tauri.conf.json::identifier`.
/// MUST stay in sync with that file, otherwise CLI and UI will open different
/// SQLite files and the UI/CLI shared-state guarantee breaks.
///
/// Tauri 2's `app.path().app_data_dir()` resolves to `<system data dir>/<identifier>`
/// on all three platforms; mirroring that path keeps both binaries on the same DB.
pub const APP_IDENTIFIER: &str = "com.lanbipu.uecm";

/// Resolves the SQLite DB path. Same location for UI and CLI so both share state.
/// Override with `VOLO_DB_PATH` env var (used in tests and ad-hoc debug sessions).
///
/// Resolution mirrors Tauri 2 `app_data_dir()`:
/// - Windows: `%APPDATA%\com.lanbipu.uecm\uecm.sqlite`
/// - macOS:   `~/Library/Application Support/com.lanbipu.uecm/uecm.sqlite`
/// - Linux:   `$XDG_DATA_HOME/com.lanbipu.uecm/uecm.sqlite` (or `~/.local/share/...`)
pub fn resolve_db_path() -> VoloResult<PathBuf> {
    if let Ok(override_path) = env::var("VOLO_DB_PATH") {
        return Ok(PathBuf::from(override_path));
    }
    let base = BaseDirs::new().ok_or_else(|| {
        VoloError::Configuration("failed to resolve user base directories".into())
    })?;
    // Side-effect-free: no `create_dir_all` here. `open_and_migrate_db` creates
    // the parent directory when it actually opens the DB, so DB-free commands
    // (`system version`, `system db-path`, `system ps-dir`) never touch the
    // filesystem just to print a path.
    Ok(base.data_dir().join(APP_IDENTIFIER).join("uecm.sqlite"))
}

/// Resolves the UECM config directory (where the SSH transport key, public
/// key, and known_hosts live). Mirrors `resolve_db_path`'s parent so a
/// `VOLO_DB_PATH` test override keeps key material next to the test DB.
pub fn resolve_config_dir() -> VoloResult<PathBuf> {
    if let Ok(override_path) = env::var("VOLO_DB_PATH") {
        if let Some(parent) = Path::new(&override_path).parent() {
            return Ok(parent.to_path_buf());
        }
    }
    let base = BaseDirs::new().ok_or_else(|| {
        VoloError::Configuration("failed to resolve user base directories".into())
    })?;
    Ok(base.data_dir().join(APP_IDENTIFIER))
}

/// Opens the DB (WAL mode is set inside `data::open`) and runs idempotent
/// migrations. Both binaries call this. Creates the parent directory if it
/// does not exist — important for `VOLO_DB_PATH` overrides that point at a
/// fresh location.
///
/// After migrations succeed, runs Plan 7 §1.4 retention GC on zen_probes /
/// zen_cache_stats as best-effort. A failed GC must not block startup — the
/// app should still come up and serve cached state, so we log via tracing
/// and continue.
pub fn open_and_migrate_db(path: &Path) -> VoloResult<Db> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| {
                VoloError::Configuration(format!(
                    "create DB parent dir {}: {}",
                    parent.display(),
                    e
                ))
            })?;
        }
    }
    let db = data::open(path)?;
    {
        let mut conn = db.lock().unwrap();
        data::schema::migrate(&mut conn)?;
    }

    match crate::core::zen::retention::run(&db) {
        Ok(report) => {
            if report.zen_probes_deleted > 0 || report.zen_cache_stats_deleted > 0 {
                tracing::info!(
                    target: "zen.retention",
                    zen_probes_deleted = report.zen_probes_deleted,
                    zen_cache_stats_deleted = report.zen_cache_stats_deleted,
                    "startup retention GC complete"
                );
            }
        }
        Err(e) => {
            tracing::warn!(target: "zen.retention", "startup retention GC failed: {e}");
        }
    }

    // Plan 7 §8 M5 T5.3: mark any `status='running'` operation rows older
    // than an hour as `interrupted`. Hard process crashes / SIGKILL leave
    // phantom rows behind; without this sweep the operations table grows
    // a steady tail of "in flight" entries that nothing ever finishes.
    match crate::data::operations::sweep_running(&db, 3600) {
        Ok(0) => {}
        Ok(n) => {
            tracing::info!(
                target: "operations.sweep",
                interrupted_rows = n,
                "marked {n} stale operations row(s) as interrupted at startup"
            );
        }
        Err(e) => {
            tracing::warn!(target: "operations.sweep", "startup sweep failed: {e}");
        }
    }

    Ok(db)
}

/// Resolves the directory containing PowerShell sidecar scripts.
/// Priority:
///   1. `UECM_PS_DIR` env var
///   2. `<exe-dir>/ps-scripts` (release binaries ship scripts alongside,
///      via `tauri.conf.json` `bundle.resources`)
///   3. dev fallback: the in-tree resources copy at
///      `<workspace-root>/src-tauri/resources/ps-scripts`.
///
/// step 2c moved the scripts under `src-tauri/resources/` (Tauri bundle
/// source) and `cache-core` lives at `<workspace>/crates/cache-core`, so the
/// dev fallback walks two parents up from `CARGO_MANIFEST_DIR` to the
/// workspace root before locating `src-tauri/resources/ps-scripts`. The env
/// override and release exe-dir legs are unchanged.
pub fn resolve_ps_script_dir() -> PathBuf {
    if let Ok(override_path) = env::var("UECM_PS_DIR") {
        return PathBuf::from(override_path);
    }
    if let Ok(exe) = env::current_exe() {
        if let Some(parent) = exe.parent() {
            let candidate = parent.join("ps-scripts");
            if candidate.is_dir() {
                return candidate;
            }
        }
    }
    // CARGO_MANIFEST_DIR = <workspace>/crates/cache-core → up two to the
    // workspace root, then into the bundled resources copy.
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let workspace_root = manifest_dir
        .parent() // <workspace>/crates
        .and_then(Path::parent) // <workspace>
        .unwrap_or_else(|| Path::new("."));
    workspace_root.join("src-tauri/resources/ps-scripts")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ENV_TEST_LOCK;

    #[test]
    fn resolve_db_path_uses_env_override() {
        let _lock = ENV_TEST_LOCK.lock().unwrap();
        let custom = "/tmp/test-override-uecm.sqlite";
        env::set_var("VOLO_DB_PATH", custom);
        let path = resolve_db_path().unwrap();
        assert_eq!(path, PathBuf::from(custom));
        env::remove_var("VOLO_DB_PATH");
    }

    #[test]
    fn resolve_db_path_uses_tauri_identifier_subdir() {
        let _lock = ENV_TEST_LOCK.lock().unwrap();
        env::remove_var("VOLO_DB_PATH");
        let path = resolve_db_path().unwrap();
        assert!(path.ends_with("uecm.sqlite"));
        // Path must include the Tauri identifier so UI and CLI converge on the same DB.
        let s = path.to_string_lossy().into_owned();
        assert!(
            s.contains(APP_IDENTIFIER),
            "DB path {} must contain identifier {}",
            s,
            APP_IDENTIFIER
        );
        // Don't assert parent.is_dir() — resolve_db_path is side-effect-free
        // now (post-Task-2.3 fix); the parent only materializes when
        // open_and_migrate_db actually opens the DB.
        assert!(
            path.parent().is_some(),
            "DB path must have a parent component"
        );
    }

    #[test]
    fn config_dir_follows_db_path_override() {
        let _lock = ENV_TEST_LOCK.lock().unwrap();
        env::set_var("VOLO_DB_PATH", "/tmp/uecm-test-abc/uecm.sqlite");
        let dir = resolve_config_dir().unwrap();
        assert_eq!(dir, PathBuf::from("/tmp/uecm-test-abc"));
        env::remove_var("VOLO_DB_PATH");
    }

    #[test]
    fn resolve_ps_script_dir_uses_env_override() {
        let _lock = ENV_TEST_LOCK.lock().unwrap();
        let custom = "/tmp/test-ps-uecm";
        env::set_var("UECM_PS_DIR", custom);
        let path = resolve_ps_script_dir();
        assert_eq!(path, PathBuf::from(custom));
        env::remove_var("UECM_PS_DIR");
    }

    #[test]
    fn resolve_ps_script_dir_finds_repo_scripts_in_dev() {
        let _lock = ENV_TEST_LOCK.lock().unwrap();
        env::remove_var("UECM_PS_DIR");
        let path = resolve_ps_script_dir();
        assert!(
            path.ends_with("ps-scripts"),
            "expected path ending in ps-scripts, got {}",
            path.display()
        );
    }

    #[test]
    fn open_and_migrate_db_creates_and_migrates() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.sqlite");
        let db = open_and_migrate_db(&path).unwrap();
        let conn = db.lock().unwrap();
        let mode: String = conn
            .pragma_query_value(None, "journal_mode", |row| row.get(0))
            .unwrap();
        assert_eq!(mode.to_lowercase(), "wal");
        let count: i64 = conn
            .query_row("SELECT count(*) FROM machines", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }
}
