//! Database schema migrations. Runs idempotently on app startup.
//! Each migration is wrapped in a transaction.

use crate::error::VoloResult;
use rusqlite::Connection;

const MIGRATIONS: &[(&str, &str)] = &[
    (
        "001_machines_table",
        r#"
        CREATE TABLE IF NOT EXISTS machines (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            hostname TEXT NOT NULL,
            ip TEXT NOT NULL UNIQUE,
            role TEXT NOT NULL DEFAULT 'unknown',
            status TEXT NOT NULL DEFAULT 'unknown',
            last_seen_at TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_machines_status ON machines(status);
        "#,
    ),
    (
        "003_machine_ue_installs",
        r#"
        CREATE TABLE IF NOT EXISTS machine_ue_installs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            machine_id INTEGER NOT NULL,
            version TEXT NOT NULL,
            install_path TEXT NOT NULL,
            is_primary INTEGER NOT NULL DEFAULT 0,
            detected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(machine_id, version),
            FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_machine_ue_installs_machine ON machine_ue_installs(machine_id);
        "#,
    ),
    (
        "004_machine_gpus",
        r#"
        CREATE TABLE IF NOT EXISTS machine_gpus (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            machine_id INTEGER NOT NULL,
            gpu_model TEXT NOT NULL,
            driver_version TEXT NOT NULL,
            vendor TEXT NOT NULL DEFAULT 'unknown',
            vram_mb INTEGER,
            detected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_machine_gpus_machine ON machine_gpus(machine_id);
        "#,
    ),
    (
        "005_credentials",
        r#"
        CREATE TABLE IF NOT EXISTS credentials (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            alias TEXT NOT NULL UNIQUE,
            kind TEXT NOT NULL,
            username TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_credentials_alias ON credentials(alias);
        "#,
    ),
    (
        "006_share_configs",
        r#"
        CREATE TABLE IF NOT EXISTS share_configs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            host_machine_id INTEGER NOT NULL,
            share_name TEXT NOT NULL,
            unc_path TEXT NOT NULL,
            local_path TEXT NOT NULL,
            mode TEXT NOT NULL,
            credential_alias TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(host_machine_id, share_name),
            FOREIGN KEY (host_machine_id) REFERENCES machines(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_share_configs_host ON share_configs(host_machine_id);
        "#,
    ),
    (
        "007_diagnostics_tables",
        r#"
        CREATE TABLE IF NOT EXISTS scan_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scan_type TEXT NOT NULL,                    -- "ini" | "health"
            started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            finished_at TEXT,
            machine_ids_json TEXT NOT NULL,             -- JSON array of machine ids in scope
            summary_json TEXT                           -- JSON: {critical, warning, healthy, total, ...}
        );
        CREATE INDEX IF NOT EXISTS idx_scan_runs_type_started ON scan_runs(scan_type, started_at DESC);

        CREATE TABLE IF NOT EXISTS ini_findings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scan_run_id INTEGER NOT NULL,
            machine_id INTEGER NOT NULL,
            rule_id TEXT NOT NULL,                      -- e.g. "R001"
            severity TEXT NOT NULL,                     -- "critical" | "warning" | "healthy" | "info"
            category TEXT NOT NULL,                     -- "project" | "user" | "engine"
            file_path TEXT NOT NULL,                    -- absolute path on the machine
            section TEXT,                               -- INI [section]
            key_name TEXT,                              -- when applicable
            line_number INTEGER,                        -- 1-based, null if N/A
            snippet_before TEXT NOT NULL,               -- multi-line excerpt
            snippet_after TEXT,                         -- suggested fix (null when remove-only)
            recommended_action TEXT NOT NULL,           -- "set" | "remove" | "manual"
            recommended_value TEXT,                     -- payload for "set"
            symptom TEXT NOT NULL,                      -- user-facing description
            rationale TEXT NOT NULL,                    -- "why" explanation
            fixed_at TEXT,                              -- non-null when applied
            skipped_at TEXT,                            -- non-null when user skipped
            FOREIGN KEY (scan_run_id) REFERENCES scan_runs(id) ON DELETE CASCADE,
            FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_ini_findings_run ON ini_findings(scan_run_id);
        CREATE INDEX IF NOT EXISTS idx_ini_findings_machine ON ini_findings(machine_id);
        CREATE INDEX IF NOT EXISTS idx_ini_findings_severity ON ini_findings(severity);

        CREATE TABLE IF NOT EXISTS health_check_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scan_run_id INTEGER NOT NULL,
            machine_id INTEGER NOT NULL,
            machine_results_json TEXT NOT NULL,         -- JSON: {check_id: {status, message, sample_output}}
            FOREIGN KEY (scan_run_id) REFERENCES scan_runs(id) ON DELETE CASCADE,
            FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_health_check_runs_run ON health_check_runs(scan_run_id);
        CREATE INDEX IF NOT EXISTS idx_health_check_runs_machine ON health_check_runs(machine_id);
        CREATE UNIQUE INDEX IF NOT EXISTS uq_health_check_runs_run_machine
            ON health_check_runs(scan_run_id, machine_id);
        "#,
    ),
    (
        "008_operations_table",
        r#"
        CREATE TABLE IF NOT EXISTS operations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            action_type TEXT NOT NULL,
            target_machines TEXT NOT NULL DEFAULT '[]',
            status TEXT NOT NULL DEFAULT 'pending',
            started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            finished_at TEXT,
            log_text TEXT,
            snapshot_blob BLOB
        );
        CREATE INDEX IF NOT EXISTS idx_operations_action_type ON operations(action_type);
        CREATE INDEX IF NOT EXISTS idx_operations_status ON operations(status);
        "#,
    ),
    (
        "009_projects_table",
        r#"
        CREATE TABLE IF NOT EXISTS projects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            uproject_name TEXT NOT NULL,
            uproject_stem_lower TEXT NOT NULL UNIQUE,
            uproject_guid TEXT,
            display_name TEXT,
            first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            last_seen_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_projects_stem ON projects(uproject_stem_lower);
        "#,
    ),
    (
        "010_project_locations_table",
        r#"
        CREATE TABLE IF NOT EXISTS project_locations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            machine_id INTEGER NOT NULL,
            abs_path TEXT NOT NULL,
            uproject_path TEXT NOT NULL,
            discovery_status TEXT NOT NULL DEFAULT 'auto',
            discovered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(project_id, machine_id),
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
            FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_project_locations_project ON project_locations(project_id);
        CREATE INDEX IF NOT EXISTS idx_project_locations_machine ON project_locations(machine_id);
        "#,
    ),
    (
        "011_pso_cache_files_table",
        r#"
        CREATE TABLE IF NOT EXISTS pso_cache_files (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            source_machine_id INTEGER NOT NULL,
            file_path TEXT NOT NULL,
            file_name TEXT NOT NULL,
            size_bytes INTEGER NOT NULL DEFAULT 0,
            gpu_signature TEXT NOT NULL,
            ue_version TEXT,
            collected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(project_id, source_machine_id, file_name),
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
            FOREIGN KEY (source_machine_id) REFERENCES machines(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_pso_cache_files_project ON pso_cache_files(project_id);
        CREATE INDEX IF NOT EXISTS idx_pso_cache_files_signature ON pso_cache_files(gpu_signature);
        "#,
    ),
    (
        "012_pso_distributions_table",
        r#"
        CREATE TABLE IF NOT EXISTS pso_distributions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pso_cache_file_id INTEGER NOT NULL,
            target_machine_id INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            bytes_copied INTEGER NOT NULL DEFAULT 0,
            distributed_at TEXT,
            error_message TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(pso_cache_file_id, target_machine_id),
            FOREIGN KEY (pso_cache_file_id) REFERENCES pso_cache_files(id) ON DELETE CASCADE,
            FOREIGN KEY (target_machine_id) REFERENCES machines(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_pso_distributions_file ON pso_distributions(pso_cache_file_id);
        "#,
    ),
    (
        "013_projects_zen_engine_association",
        r#"
        ALTER TABLE projects ADD COLUMN ue_version_major INTEGER;
        ALTER TABLE projects ADD COLUMN ue_version_minor INTEGER;
        ALTER TABLE projects ADD COLUMN engine_association_raw TEXT;
        ALTER TABLE projects ADD COLUMN engine_association_kind TEXT;
        "#,
    ),
    (
        "014_zen_endpoints_table",
        r#"
        CREATE TABLE IF NOT EXISTS zen_endpoints (
            id INTEGER PRIMARY KEY,
            machine_id INTEGER NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
            declared_port INTEGER NOT NULL DEFAULT 8558,
            scheme TEXT NOT NULL DEFAULT 'http',
            role TEXT NOT NULL,
            upstream_endpoint_id INTEGER REFERENCES zen_endpoints(id) ON DELETE SET NULL,
            data_dir TEXT NOT NULL,
            httpserverclass TEXT NOT NULL DEFAULT 'asio',
            lifecycle_mode TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(machine_id, declared_port)
        );
        CREATE INDEX IF NOT EXISTS idx_zen_endpoints_machine ON zen_endpoints(machine_id);
        "#,
    ),
    (
        "015_zen_probes_table",
        r#"
        CREATE TABLE IF NOT EXISTS zen_probes (
            id INTEGER PRIMARY KEY,
            endpoint_id INTEGER NOT NULL REFERENCES zen_endpoints(id) ON DELETE CASCADE,
            probed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            reachable INTEGER NOT NULL,
            schema_version INTEGER NOT NULL DEFAULT 1,
            effective_port INTEGER,
            pid INTEGER,
            uptime_seconds INTEGER,
            data_root TEXT,
            is_dedicated INTEGER,
            build_version TEXT,
            health_info_cb BLOB,
            health_version_text TEXT,
            stats_providers_cb BLOB,
            error_message TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_zen_probes_endpoint_time ON zen_probes(endpoint_id, probed_at);
        "#,
    ),
    (
        "016_zen_cache_stats_table",
        r#"
        CREATE TABLE IF NOT EXISTS zen_cache_stats (
            id INTEGER PRIMARY KEY,
            endpoint_id INTEGER NOT NULL REFERENCES zen_endpoints(id) ON DELETE CASCADE,
            sampled_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            cache_hit_ratio REAL,
            cache_disk_size_bytes INTEGER,
            cache_memory_size_bytes INTEGER,
            provider_path TEXT NOT NULL DEFAULT '/stats/z$',
            raw_cb BLOB NOT NULL,
            schema_version INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX IF NOT EXISTS idx_zen_cache_stats_endpoint_time ON zen_cache_stats(endpoint_id, sampled_at);
        "#,
    ),
    (
        "017_project_cache_backend_table",
        r#"
        CREATE TABLE IF NOT EXISTS project_cache_backend (
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            machine_id INTEGER NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
            backend TEXT NOT NULL,
            zen_endpoint_id INTEGER REFERENCES zen_endpoints(id) ON DELETE SET NULL,
            notes TEXT,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (project_id, machine_id)
        );
        "#,
    ),
    (
        "018_zen_binary_expected_table",
        r#"
        CREATE TABLE IF NOT EXISTS zen_binary_expected (
            zen_build_version TEXT NOT NULL,
            binary_kind TEXT NOT NULL,
            sha256 TEXT NOT NULL,
            locked_by TEXT,
            first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (zen_build_version, binary_kind)
        );
        "#,
    ),
    (
        "019_zen_binary_intree_table",
        r#"
        CREATE TABLE IF NOT EXISTS zen_binary_intree (
            ue_version_major INTEGER NOT NULL,
            ue_version_minor INTEGER NOT NULL,
            binary_kind TEXT NOT NULL,
            build_version TEXT,
            sha256 TEXT,
            last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (ue_version_major, ue_version_minor, binary_kind)
        );
        "#,
    ),
    (
        "020_machine_zen_install_table",
        r#"
        CREATE TABLE IF NOT EXISTS machine_zen_install (
            machine_id INTEGER PRIMARY KEY REFERENCES machines(id) ON DELETE CASCADE,
            install_dir TEXT,
            zen_cli_path TEXT,
            zen_cli_build_version TEXT,
            zen_cli_sha256 TEXT,
            zenserver_path TEXT,
            zenserver_build_version TEXT,
            zenserver_sha256 TEXT,
            last_detected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        "#,
    ),
    (
        "021_machine_ue_installs_zen_intree_columns",
        r#"
        ALTER TABLE machine_ue_installs ADD COLUMN zen_cli_intree_path TEXT;
        ALTER TABLE machine_ue_installs ADD COLUMN zen_cli_intree_version TEXT;
        ALTER TABLE machine_ue_installs ADD COLUMN zen_cli_intree_sha256 TEXT;
        ALTER TABLE machine_ue_installs ADD COLUMN zenserver_intree_path TEXT;
        ALTER TABLE machine_ue_installs ADD COLUMN zenserver_intree_version TEXT;
        ALTER TABLE machine_ue_installs ADD COLUMN zenserver_intree_sha256 TEXT;
        "#,
    ),
    (
        "022_machines_ssh_user",
        r#"
        ALTER TABLE machines ADD COLUMN ssh_user TEXT;
        "#,
    ),
    (
        "023_ini_config_snapshots",
        r#"
        CREATE TABLE IF NOT EXISTS ini_config_snapshots (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            scan_run_id  INTEGER NOT NULL,
            machine_id   INTEGER NOT NULL,
            file_path    TEXT NOT NULL,
            ue_version   TEXT,
            domain       TEXT NOT NULL,
            section      TEXT NOT NULL,
            key_name     TEXT NOT NULL,
            value        TEXT NOT NULL,
            line_number  INTEGER,
            FOREIGN KEY (scan_run_id) REFERENCES scan_runs(id) ON DELETE CASCADE,
            FOREIGN KEY (machine_id)  REFERENCES machines(id)  ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_ini_config_snapshots_run
            ON ini_config_snapshots(scan_run_id);
        CREATE INDEX IF NOT EXISTS idx_ini_config_snapshots_machine
            ON ini_config_snapshots(machine_id);
        "#,
    ),
    (
        "024_machines_ue_runtime_user",
        r#"
        ALTER TABLE machines ADD COLUMN ue_runtime_user TEXT;
        "#,
    ),
    (
        "025_zen_endpoints_gc_install_account",
        r#"
        ALTER TABLE zen_endpoints ADD COLUMN install_dir TEXT;
        ALTER TABLE zen_endpoints ADD COLUMN gc_interval_seconds INTEGER;
        ALTER TABLE zen_endpoints ADD COLUMN gc_lightweight_interval_seconds INTEGER;
        ALTER TABLE zen_endpoints ADD COLUMN cache_max_duration_seconds INTEGER;
        ALTER TABLE zen_endpoints ADD COLUMN service_account_username TEXT;
        ALTER TABLE zen_endpoints ADD COLUMN service_account_cred_alias TEXT;
        ALTER TABLE zen_endpoints ADD COLUMN config_path_override TEXT;
        "#,
    ),
    (
        "026_pso_warmup_runs_table",
        r#"
        CREATE TABLE IF NOT EXISTS pso_warmup_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            machine_id INTEGER NOT NULL,
            resolution_w INTEGER NOT NULL,
            resolution_h INTEGER NOT NULL,
            max_minutes INTEGER NOT NULL,
            hitch_count INTEGER,
            status TEXT NOT NULL DEFAULT 'running',
            error_message TEXT,
            started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            duration_secs INTEGER,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
            FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_pso_warmup_runs_project ON pso_warmup_runs(project_id);
        CREATE INDEX IF NOT EXISTS idx_pso_warmup_runs_machine ON pso_warmup_runs(machine_id);
        "#,
    ),
    (
        "027_project_locations_ue_version",
        r#"
        ALTER TABLE project_locations ADD COLUMN ue_version_major INTEGER;
        ALTER TABLE project_locations ADD COLUMN ue_version_minor INTEGER;
        "#,
    ),
    (
        "028_pso_warmup_runs_ndisplay_fields",
        r#"
        ALTER TABLE pso_warmup_runs ADD COLUMN mode TEXT NOT NULL DEFAULT 'legacy_game';
        ALTER TABLE pso_warmup_runs ADD COLUMN dc_node TEXT;
        ALTER TABLE pso_warmup_runs ADD COLUMN driver_cache_growth_bytes INTEGER;
        "#,
    ),
    (
        "029_driver_cache_snapshots_table",
        r#"
        CREATE TABLE IF NOT EXISTS driver_cache_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            machine_id INTEGER NOT NULL,
            gpu_model TEXT,
            gpu_driver_version TEXT,
            interactive_user TEXT,
            local_appdata_dxcache_path TEXT NOT NULL,
            local_appdata_dxcache_exists INTEGER NOT NULL,
            local_appdata_dxcache_file_count INTEGER NOT NULL,
            local_appdata_dxcache_total_bytes INTEGER NOT NULL,
            local_appdata_dxcache_newest_mtime TEXT,
            locallow_per_driver_dxcache_path TEXT NOT NULL,
            locallow_per_driver_dxcache_exists INTEGER NOT NULL,
            locallow_per_driver_dxcache_file_count INTEGER NOT NULL,
            locallow_per_driver_dxcache_total_bytes INTEGER NOT NULL,
            locallow_per_driver_dxcache_newest_mtime TEXT,
            total_file_count INTEGER NOT NULL,
            total_bytes INTEGER NOT NULL,
            newest_mtime TEXT,
            captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_driver_cache_snapshots_machine
            ON driver_cache_snapshots(machine_id, captured_at DESC);
        "#,
    ),
    (
        "030_pso_invalidation_events_table",
        r#"
        ALTER TABLE driver_cache_snapshots ADD COLUMN node_last_boot_time TEXT;

        CREATE TABLE IF NOT EXISTS pso_invalidation_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            machine_id INTEGER NOT NULL,
            warmup_run_id INTEGER NOT NULL,
            driver_cache_snapshot_id INTEGER NOT NULL,
            reason TEXT NOT NULL,
            detail TEXT NOT NULL,
            detected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
            FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE,
            FOREIGN KEY (warmup_run_id) REFERENCES pso_warmup_runs(id) ON DELETE CASCADE,
            FOREIGN KEY (driver_cache_snapshot_id) REFERENCES driver_cache_snapshots(id) ON DELETE CASCADE,
            UNIQUE(project_id, machine_id, warmup_run_id, driver_cache_snapshot_id, reason)
        );
        CREATE INDEX IF NOT EXISTS idx_pso_invalidation_events_project_machine
            ON pso_invalidation_events(project_id, machine_id, detected_at DESC);
        CREATE INDEX IF NOT EXISTS idx_pso_invalidation_events_warmup
            ON pso_invalidation_events(warmup_run_id, detected_at DESC);
        "#,
    ),
    (
        // Two-phase warmup: the prerun phase absorbs hitches (hitch_count),
        // the verify phase re-runs the same spec and its hitch count is the
        // green-light basis (0 = ok, >0 = not_ready).
        "031_pso_warmup_runs_verify_phase",
        r#"
        ALTER TABLE pso_warmup_runs ADD COLUMN verify_hitch_count INTEGER;
        ALTER TABLE pso_warmup_runs ADD COLUMN verify_duration_secs INTEGER;
        "#,
    ),
    (
        // Traversal engine: whether the run drove the stage via Remote Control
        // (traversal=1) and whether the prerun phase ended by convergence
        // (hitch + cache-growth curves flat) instead of the max-minutes cap.
        "032_pso_warmup_runs_traversal",
        r#"
        ALTER TABLE pso_warmup_runs ADD COLUMN traversal INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE pso_warmup_runs ADD COLUMN converged INTEGER;
        "#,
    ),
    (
        "033_pso_project_settings_table",
        r#"
        CREATE TABLE IF NOT EXISTS pso_project_settings (
            project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
            dc_cfg_source TEXT NOT NULL DEFAULT 'manual',
            dc_cfg_asset TEXT,
            dc_cfg_manual_path TEXT,
            extra_args TEXT NOT NULL DEFAULT '',
            offscreen INTEGER NOT NULL DEFAULT 1,
            target_machine_ids TEXT NOT NULL DEFAULT '[]',
            max_minutes INTEGER NOT NULL DEFAULT 20,
            probe_interval_secs INTEGER NOT NULL DEFAULT 30,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        "#,
    ),
    (
        // 遍历引擎的地图包路径（TraversalRequest.map_path）设计稿标「只读」但实际必填才能启用
        // 遍历——按工程持久化，留空 = 该工程预跑不启用遍历（退化为固定机位，行为不变）。
        "034_pso_project_settings_map_path",
        r#"
        ALTER TABLE pso_project_settings ADD COLUMN map_path TEXT;
        "#,
    ),
    (
        // nDisplay 集群节点 id（-dc_node / -StageFriendlyName）此前代码错误地从 dc_cfg_asset
        // 文件路径派生（或冷启动验证里硬编码 "Node_0"），两者都与 .ndisplay 配置内定义的真实
        // 节点名无关——按工程持久化为独立字段，留空时调用方退回 "Node_0"。
        "035_pso_project_settings_dc_node",
        r#"
        ALTER TABLE pso_project_settings ADD COLUMN dc_node TEXT;
        "#,
    ),
];

pub fn migrate(conn: &mut Connection) -> VoloResult<()> {
    // Bootstrap: ensure migrations table exists.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            name TEXT PRIMARY KEY,
            applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )",
        [],
    )?;

    for (name, sql) in MIGRATIONS {
        let already_applied: bool = conn
            .query_row(
                "SELECT 1 FROM schema_migrations WHERE name = ?",
                [name],
                |_| Ok(true),
            )
            .unwrap_or(false);

        if already_applied {
            continue;
        }

        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.execute("INSERT INTO schema_migrations (name) VALUES (?)", [name])?;
        tx.commit()?;
        tracing::info!("applied migration: {}", name);
    }

    // Drift repair: migration 025 was edited in place during development —
    // DBs that applied the interim version (recorded as applied, so the batch
    // is skipped forever) lack `config_path_override`, and every SELECT in
    // zen_endpoints.rs then fails with "no such column" (the UI shows a
    // deployed server as 未部署). ALTER ... ADD COLUMN has no IF NOT EXISTS
    // in SQLite, so backfill conditionally here.
    if !has_column(conn, "zen_endpoints", "config_path_override")? {
        conn.execute(
            "ALTER TABLE zen_endpoints ADD COLUMN config_path_override TEXT",
            [],
        )?;
        tracing::info!(
            "backfilled zen_endpoints.config_path_override (migration 025 drift repair)"
        );
    }

    Ok(())
}

fn has_column(conn: &Connection, table: &str, column: &str) -> VoloResult<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let name: String = row.get(1)?;
        if name == column {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::open_in_memory;

    #[test]
    fn migrate_creates_machines_table() {
        let db = open_in_memory().unwrap();
        let mut conn = db.lock().unwrap();
        migrate(&mut conn).unwrap();

        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='machines'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn migrate_is_idempotent() {
        let db = open_in_memory().unwrap();
        let mut conn = db.lock().unwrap();
        migrate(&mut conn).unwrap();
        migrate(&mut conn).unwrap(); // run twice
                                     // Should not error.
    }

    #[test]
    fn migrate_records_applied_migrations() {
        let db = open_in_memory().unwrap();
        let mut conn = db.lock().unwrap();
        migrate(&mut conn).unwrap();

        let count: i64 = conn
            .query_row("SELECT count(*) FROM schema_migrations", [], |r| r.get(0))
            .unwrap();
        assert!(count >= 1);
    }

    #[test]
    fn migrate_backfills_config_path_override_on_drifted_db() {
        // Simulate a DB that applied the interim (in-place edited) migration
        // 025: all migrations recorded as applied, but the column is missing.
        let db = open_in_memory().unwrap();
        let mut conn = db.lock().unwrap();
        migrate(&mut conn).unwrap();
        conn.execute(
            "ALTER TABLE zen_endpoints DROP COLUMN config_path_override",
            [],
        )
        .unwrap();
        assert!(!has_column(&conn, "zen_endpoints", "config_path_override").unwrap());

        migrate(&mut conn).unwrap(); // batches all skipped; repair must kick in
        assert!(has_column(&conn, "zen_endpoints", "config_path_override").unwrap());
    }

    #[test]
    fn migrate_creates_machine_ue_installs_table() {
        let db = open_in_memory().unwrap();
        let mut conn = db.lock().unwrap();
        migrate(&mut conn).unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='machine_ue_installs'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn migrate_creates_machine_gpus_table() {
        let db = open_in_memory().unwrap();
        let mut conn = db.lock().unwrap();
        migrate(&mut conn).unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='machine_gpus'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn migrate_creates_credentials_table() {
        let db = open_in_memory().unwrap();
        let mut conn = db.lock().unwrap();
        migrate(&mut conn).unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='credentials'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn migrate_creates_share_configs_table() {
        let db = open_in_memory().unwrap();
        let mut conn = db.lock().unwrap();
        migrate(&mut conn).unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='share_configs'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn migrate_creates_scan_runs_table() {
        let db = open_in_memory().unwrap();
        let mut conn = db.lock().unwrap();
        migrate(&mut conn).unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='scan_runs'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn migrate_creates_ini_findings_table() {
        let db = open_in_memory().unwrap();
        let mut conn = db.lock().unwrap();
        migrate(&mut conn).unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='ini_findings'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn migrate_creates_health_check_runs_table() {
        let db = open_in_memory().unwrap();
        let mut conn = db.lock().unwrap();
        migrate(&mut conn).unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='health_check_runs'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    // ---- Plan 7 zen integration schema (migrations 014-021) ----

    fn table_columns(conn: &Connection, table: &str) -> Vec<(String, String, bool)> {
        // Returns (name, type, notnull) for each column. Uses PRAGMA table_info.
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info({})", table))
            .unwrap();
        let rows = stmt
            .query_map([], |r| {
                let name: String = r.get(1)?;
                let ty: String = r.get(2)?;
                let notnull: i64 = r.get(3)?;
                Ok((name, ty, notnull != 0))
            })
            .unwrap();
        rows.collect::<Result<Vec<_>, _>>().unwrap()
    }

    fn table_exists(conn: &Connection, table: &str) -> bool {
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?",
                [table],
                |r| r.get(0),
            )
            .unwrap();
        count == 1
    }

    fn assert_has_columns(conn: &Connection, table: &str, expected: &[(&str, &str, bool)]) {
        let cols = table_columns(conn, table);
        for (name, ty, notnull) in expected {
            let found = cols
                .iter()
                .find(|(n, _, _)| n == name)
                .unwrap_or_else(|| panic!("table {} missing column {}", table, name));
            assert_eq!(
                &found.1, ty,
                "table {} column {} expected type {} got {}",
                table, name, ty, found.1
            );
            assert_eq!(
                found.2, *notnull,
                "table {} column {} expected notnull={} got {}",
                table, name, notnull, found.2
            );
        }
    }

    #[test]
    fn migrate_creates_zen_endpoints_table_with_expected_columns() {
        let db = open_in_memory().unwrap();
        let mut conn = db.lock().unwrap();
        migrate(&mut conn).unwrap();
        assert!(table_exists(&conn, "zen_endpoints"));
        assert_has_columns(
            &conn,
            "zen_endpoints",
            &[
                ("id", "INTEGER", false),
                ("machine_id", "INTEGER", true),
                ("declared_port", "INTEGER", true),
                ("scheme", "TEXT", true),
                ("role", "TEXT", true),
                ("upstream_endpoint_id", "INTEGER", false),
                ("data_dir", "TEXT", true),
                ("httpserverclass", "TEXT", true),
                ("lifecycle_mode", "TEXT", true),
                ("created_at", "TEXT", true),
                ("updated_at", "TEXT", true),
                ("install_dir", "TEXT", false),
                ("gc_interval_seconds", "INTEGER", false),
                ("gc_lightweight_interval_seconds", "INTEGER", false),
                ("cache_max_duration_seconds", "INTEGER", false),
                ("service_account_username", "TEXT", false),
                ("service_account_cred_alias", "TEXT", false),
                ("config_path_override", "TEXT", false),
            ],
        );
    }

    #[test]
    fn migrate_creates_zen_probes_table_with_expected_columns() {
        let db = open_in_memory().unwrap();
        let mut conn = db.lock().unwrap();
        migrate(&mut conn).unwrap();
        assert!(table_exists(&conn, "zen_probes"));
        assert_has_columns(
            &conn,
            "zen_probes",
            &[
                ("id", "INTEGER", false),
                ("endpoint_id", "INTEGER", true),
                ("probed_at", "TEXT", true),
                ("reachable", "INTEGER", true),
                ("schema_version", "INTEGER", true),
                ("effective_port", "INTEGER", false),
                ("pid", "INTEGER", false),
                ("uptime_seconds", "INTEGER", false),
                ("data_root", "TEXT", false),
                ("is_dedicated", "INTEGER", false),
                ("build_version", "TEXT", false),
                ("health_info_cb", "BLOB", false),
                ("health_version_text", "TEXT", false),
                ("stats_providers_cb", "BLOB", false),
                ("error_message", "TEXT", false),
            ],
        );
    }

    #[test]
    fn migrate_creates_zen_cache_stats_table_with_expected_columns() {
        let db = open_in_memory().unwrap();
        let mut conn = db.lock().unwrap();
        migrate(&mut conn).unwrap();
        assert!(table_exists(&conn, "zen_cache_stats"));
        assert_has_columns(
            &conn,
            "zen_cache_stats",
            &[
                ("id", "INTEGER", false),
                ("endpoint_id", "INTEGER", true),
                ("sampled_at", "TEXT", true),
                ("cache_hit_ratio", "REAL", false),
                ("cache_disk_size_bytes", "INTEGER", false),
                ("cache_memory_size_bytes", "INTEGER", false),
                ("provider_path", "TEXT", true),
                ("raw_cb", "BLOB", true),
                ("schema_version", "INTEGER", true),
            ],
        );
    }

    #[test]
    fn migrate_creates_driver_cache_snapshots_table_with_expected_columns() {
        let db = open_in_memory().unwrap();
        let mut conn = db.lock().unwrap();
        migrate(&mut conn).unwrap();
        assert!(table_exists(&conn, "driver_cache_snapshots"));
        assert_has_columns(
            &conn,
            "driver_cache_snapshots",
            &[
                ("id", "INTEGER", false),
                ("machine_id", "INTEGER", true),
                ("gpu_model", "TEXT", false),
                ("gpu_driver_version", "TEXT", false),
                ("interactive_user", "TEXT", false),
                ("node_last_boot_time", "TEXT", false),
                ("local_appdata_dxcache_path", "TEXT", true),
                ("local_appdata_dxcache_exists", "INTEGER", true),
                ("local_appdata_dxcache_file_count", "INTEGER", true),
                ("local_appdata_dxcache_total_bytes", "INTEGER", true),
                ("local_appdata_dxcache_newest_mtime", "TEXT", false),
                ("locallow_per_driver_dxcache_path", "TEXT", true),
                ("locallow_per_driver_dxcache_exists", "INTEGER", true),
                ("locallow_per_driver_dxcache_file_count", "INTEGER", true),
                ("locallow_per_driver_dxcache_total_bytes", "INTEGER", true),
                ("locallow_per_driver_dxcache_newest_mtime", "TEXT", false),
                ("total_file_count", "INTEGER", true),
                ("total_bytes", "INTEGER", true),
                ("newest_mtime", "TEXT", false),
                ("captured_at", "TEXT", true),
            ],
        );
    }

    #[test]
    fn migrate_creates_pso_invalidation_events_table_with_expected_columns() {
        let db = open_in_memory().unwrap();
        let mut conn = db.lock().unwrap();
        migrate(&mut conn).unwrap();
        assert!(table_exists(&conn, "pso_invalidation_events"));
        assert_has_columns(
            &conn,
            "pso_invalidation_events",
            &[
                ("id", "INTEGER", false),
                ("project_id", "INTEGER", true),
                ("machine_id", "INTEGER", true),
                ("warmup_run_id", "INTEGER", true),
                ("driver_cache_snapshot_id", "INTEGER", true),
                ("reason", "TEXT", true),
                ("detail", "TEXT", true),
                ("detected_at", "TEXT", true),
            ],
        );
    }

    #[test]
    fn migrate_creates_project_cache_backend_table_with_expected_columns() {
        let db = open_in_memory().unwrap();
        let mut conn = db.lock().unwrap();
        migrate(&mut conn).unwrap();
        assert!(table_exists(&conn, "project_cache_backend"));
        // Composite PRIMARY KEY columns are NOT NULL implicitly via the constraint;
        // PRAGMA table_info reports notnull=1 for them in SQLite.
        assert_has_columns(
            &conn,
            "project_cache_backend",
            &[
                ("project_id", "INTEGER", true),
                ("machine_id", "INTEGER", true),
                ("backend", "TEXT", true),
                ("zen_endpoint_id", "INTEGER", false),
                ("notes", "TEXT", false),
                ("updated_at", "TEXT", true),
            ],
        );
    }

    #[test]
    fn migrate_creates_zen_binary_expected_table_with_expected_columns() {
        let db = open_in_memory().unwrap();
        let mut conn = db.lock().unwrap();
        migrate(&mut conn).unwrap();
        assert!(table_exists(&conn, "zen_binary_expected"));
        assert_has_columns(
            &conn,
            "zen_binary_expected",
            &[
                ("zen_build_version", "TEXT", true),
                ("binary_kind", "TEXT", true),
                ("sha256", "TEXT", true),
                ("locked_by", "TEXT", false),
                ("first_seen_at", "TEXT", true),
            ],
        );
    }

    #[test]
    fn migrate_creates_zen_binary_intree_table_with_expected_columns() {
        let db = open_in_memory().unwrap();
        let mut conn = db.lock().unwrap();
        migrate(&mut conn).unwrap();
        assert!(table_exists(&conn, "zen_binary_intree"));
        assert_has_columns(
            &conn,
            "zen_binary_intree",
            &[
                ("ue_version_major", "INTEGER", true),
                ("ue_version_minor", "INTEGER", true),
                ("binary_kind", "TEXT", true),
                ("build_version", "TEXT", false),
                ("sha256", "TEXT", false),
                ("last_seen_at", "TEXT", true),
            ],
        );
    }

    #[test]
    fn migrate_creates_machine_zen_install_table_with_expected_columns() {
        let db = open_in_memory().unwrap();
        let mut conn = db.lock().unwrap();
        migrate(&mut conn).unwrap();
        assert!(table_exists(&conn, "machine_zen_install"));
        assert_has_columns(
            &conn,
            "machine_zen_install",
            &[
                ("machine_id", "INTEGER", false),
                ("install_dir", "TEXT", false),
                ("zen_cli_path", "TEXT", false),
                ("zen_cli_build_version", "TEXT", false),
                ("zen_cli_sha256", "TEXT", false),
                ("zenserver_path", "TEXT", false),
                ("zenserver_build_version", "TEXT", false),
                ("zenserver_sha256", "TEXT", false),
                ("last_detected_at", "TEXT", true),
            ],
        );
    }

    #[test]
    fn migrate_adds_zen_intree_columns_to_machine_ue_installs() {
        let db = open_in_memory().unwrap();
        let mut conn = db.lock().unwrap();
        migrate(&mut conn).unwrap();
        assert_has_columns(
            &conn,
            "machine_ue_installs",
            &[
                ("zen_cli_intree_path", "TEXT", false),
                ("zen_cli_intree_version", "TEXT", false),
                ("zen_cli_intree_sha256", "TEXT", false),
                ("zenserver_intree_path", "TEXT", false),
                ("zenserver_intree_version", "TEXT", false),
                ("zenserver_intree_sha256", "TEXT", false),
            ],
        );
    }

    #[test]
    fn migrate_creates_zen_endpoints_unique_machine_port_index() {
        // Verifies the UNIQUE(machine_id, declared_port) constraint by attempting
        // to insert two rows for the same (machine_id, declared_port) and asserting
        // the second insert fails.
        let db = open_in_memory().unwrap();
        let mut conn = db.lock().unwrap();
        migrate(&mut conn).unwrap();
        conn.execute(
            "INSERT INTO machines (hostname, ip, role, status) VALUES ('h1', '10.0.0.1', 'unknown', 'unknown')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO zen_endpoints (machine_id, declared_port, role, data_dir, lifecycle_mode) \
             VALUES (1, 8558, 'local', '/tmp/zen', 'editor_owned')",
            [],
        )
        .unwrap();
        let dup = conn.execute(
            "INSERT INTO zen_endpoints (machine_id, declared_port, role, data_dir, lifecycle_mode) \
             VALUES (1, 8558, 'local', '/tmp/zen2', 'editor_owned')",
            [],
        );
        assert!(
            dup.is_err(),
            "expected UNIQUE constraint to reject duplicate"
        );
    }

    #[test]
    fn zen_child_tables_cascade_on_machine_delete() {
        // Plan §1.1: deleting a `machines` row must cascade through every Zen
        // child table that hangs off it (zen_endpoints, zen_probes,
        // zen_cache_stats, project_cache_backend, machine_zen_install) so
        // existing data::machines::delete keeps working after Plan 7 lands.
        let db = open_in_memory().unwrap();
        let mut conn = db.lock().unwrap();
        migrate(&mut conn).unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();

        conn.execute(
            "INSERT INTO machines (hostname, ip, role, status) VALUES ('h1', '10.0.0.1', 'unknown', 'unknown')",
            [],
        )
        .unwrap();
        let machine_id: i64 = conn
            .query_row("SELECT id FROM machines WHERE hostname = 'h1'", [], |r| {
                r.get(0)
            })
            .unwrap();

        conn.execute(
            "INSERT INTO zen_endpoints (machine_id, declared_port, role, data_dir, lifecycle_mode) \
             VALUES (?1, 8558, 'local', '/tmp/zen', 'editor_owned')",
            [machine_id],
        )
        .unwrap();
        let endpoint_id: i64 = conn
            .query_row(
                "SELECT id FROM zen_endpoints WHERE machine_id = ?1",
                [machine_id],
                |r| r.get(0),
            )
            .unwrap();

        conn.execute(
            "INSERT INTO zen_probes (endpoint_id, reachable) VALUES (?1, 1)",
            [endpoint_id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO zen_cache_stats (endpoint_id, raw_cb) VALUES (?1, X'00')",
            [endpoint_id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO machine_zen_install (machine_id) VALUES (?1)",
            [machine_id],
        )
        .unwrap();

        conn.execute("DELETE FROM machines WHERE id = ?1", [machine_id])
            .unwrap();

        for (table, where_clause) in [
            ("zen_endpoints", "machine_id = ?1"),
            ("zen_probes", "endpoint_id = ?1"),
            ("zen_cache_stats", "endpoint_id = ?1"),
            ("machine_zen_install", "machine_id = ?1"),
        ] {
            let bind: i64 = if table == "zen_probes" || table == "zen_cache_stats" {
                endpoint_id
            } else {
                machine_id
            };
            let remaining: i64 = conn
                .query_row(
                    &format!("SELECT count(*) FROM {} WHERE {}", table, where_clause),
                    [bind],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(remaining, 0, "{} should have been cascaded", table);
        }
    }

    #[test]
    fn project_cache_backend_clears_zen_endpoint_on_endpoint_delete() {
        // zen_endpoint_id is a soft reference — deleting the endpoint should
        // SET NULL on project_cache_backend so the backend choice remains
        // recorded and operator can re-point at another endpoint later.
        let db = open_in_memory().unwrap();
        let mut conn = db.lock().unwrap();
        migrate(&mut conn).unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();

        conn.execute(
            "INSERT INTO machines (hostname, ip, role, status) VALUES ('h1', '10.0.0.1', 'unknown', 'unknown')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO projects (uproject_name, uproject_stem_lower) VALUES ('p.uproject', 'p')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO zen_endpoints (machine_id, declared_port, role, data_dir, lifecycle_mode) \
             VALUES (1, 8558, 'local', '/tmp/zen', 'editor_owned')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_cache_backend (project_id, machine_id, backend, zen_endpoint_id) \
             VALUES (1, 1, 'zen', 1)",
            [],
        )
        .unwrap();

        conn.execute("DELETE FROM zen_endpoints WHERE id = 1", [])
            .unwrap();

        let endpoint_ref: Option<i64> = conn
            .query_row(
                "SELECT zen_endpoint_id FROM project_cache_backend WHERE project_id = 1 AND machine_id = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            endpoint_ref.is_none(),
            "zen_endpoint_id should be NULL after endpoint deletion"
        );
    }

    #[test]
    fn ini_config_snapshots_table_exists_after_migrate() {
        let db = open_in_memory().unwrap();
        let mut conn = db.lock().unwrap();
        migrate(&mut conn).unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='ini_config_snapshots'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn migrate_creates_pso_project_settings_table_with_expected_columns() {
        let db = open_in_memory().unwrap();
        let mut conn = db.lock().unwrap();
        migrate(&mut conn).unwrap();
        assert!(table_exists(&conn, "pso_project_settings"));
        assert_has_columns(
            &conn,
            "pso_project_settings",
            &[
                ("project_id", "INTEGER", false),
                ("dc_cfg_source", "TEXT", true),
                ("dc_cfg_asset", "TEXT", false),
                ("dc_cfg_manual_path", "TEXT", false),
                ("extra_args", "TEXT", true),
                ("offscreen", "INTEGER", true),
                ("target_machine_ids", "TEXT", true),
                ("max_minutes", "INTEGER", true),
                ("probe_interval_secs", "INTEGER", true),
                ("updated_at", "TEXT", true),
            ],
        );
    }
}
