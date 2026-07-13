use rusqlite::Connection;

const MIGRATIONS: &[(&str, &str)] = &[
    (
        "001_recent_projects",
        r#"
        CREATE TABLE IF NOT EXISTS recent_projects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            abs_path TEXT NOT NULL UNIQUE,
            display_name TEXT NOT NULL,
            last_opened_at TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_recent_projects_last_opened
            ON recent_projects(last_opened_at DESC);
        "#,
    ),
    (
        "002_reconstruction_runs",
        r#"
        CREATE TABLE IF NOT EXISTS reconstruction_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_path TEXT NOT NULL,
            screen_id TEXT NOT NULL,
            measurements_path TEXT NOT NULL,
            method TEXT NOT NULL,
            measured_count INTEGER NOT NULL,
            expected_count INTEGER NOT NULL,
            estimated_rms_mm REAL NOT NULL,
            estimated_p95_mm REAL NOT NULL,
            vertex_count INTEGER NOT NULL,
            output_obj_path TEXT,
            report_json_path TEXT NOT NULL,
            target TEXT,
            warnings_json TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_runs_project_screen
            ON reconstruction_runs(project_path, screen_id, created_at DESC);
        "#,
    ),
    (
        // FIX-12: estimated_rms_mm / estimated_p95_mm 语义改为真实拟合残差,
        // 不可计算时为 NULL(此前是输入 σ 冒充 + 永远 0 的 p95)。SQLite 不能
        // 原位放宽 NOT NULL → 标准 rebuild。
        "003_runs_nullable_quality_metrics",
        r#"
        CREATE TABLE reconstruction_runs_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_path TEXT NOT NULL,
            screen_id TEXT NOT NULL,
            measurements_path TEXT NOT NULL,
            method TEXT NOT NULL,
            measured_count INTEGER NOT NULL,
            expected_count INTEGER NOT NULL,
            estimated_rms_mm REAL,
            estimated_p95_mm REAL,
            vertex_count INTEGER NOT NULL,
            output_obj_path TEXT,
            report_json_path TEXT NOT NULL,
            target TEXT,
            warnings_json TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO reconstruction_runs_new (
            id, project_path, screen_id, measurements_path, method,
            measured_count, expected_count, estimated_rms_mm, estimated_p95_mm,
            vertex_count, output_obj_path, report_json_path, target,
            warnings_json, created_at)
        SELECT
            id, project_path, screen_id, measurements_path, method,
            measured_count, expected_count, estimated_rms_mm, estimated_p95_mm,
            vertex_count, output_obj_path, report_json_path, target,
            warnings_json, created_at
        FROM reconstruction_runs;
        DROP TABLE reconstruction_runs;
        ALTER TABLE reconstruction_runs_new RENAME TO reconstruction_runs;
        CREATE INDEX IF NOT EXISTS idx_runs_project_screen
            ON reconstruction_runs(project_path, screen_id, created_at DESC);
        "#,
    ),
    (
        // 网格校正新 IA：run 列表需要一个显式「设为当前」指针，而不是永远
        // 隐式等于 created_at 最新一条（用户可能想把视口钉在某个旧 run 上
        // 对比）。0/1 用 INTEGER 而不是 BOOLEAN —— rusqlite 对 SQLite 的
        // NUMERIC 亲和类型习惯用 i64。
        "004_run_is_current",
        r#"
        ALTER TABLE reconstruction_runs ADD COLUMN is_current INTEGER NOT NULL DEFAULT 0;
        "#,
    ),
];

pub fn migrate(conn: &mut Connection) -> rusqlite::Result<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            name TEXT PRIMARY KEY,
            applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )",
        [],
    )?;
    for (name, sql) in MIGRATIONS {
        let already: i64 = conn.query_row(
            "SELECT COUNT(*) FROM schema_migrations WHERE name = ?1",
            [name],
            |r| r.get(0),
        )?;
        if already > 0 {
            continue;
        }
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.execute("INSERT INTO schema_migrations(name) VALUES (?1)", [name])?;
        tx.commit()?;
    }
    // Application-level path normalization sweep —— 不进 schema_migrations 表
    // (这是 idempotent 的数据修复,不是 schema change),每次 open 都跑一次。
    // 用途:把 patch 之前以 raw / symlink path 写入的老 row 合并到 canonical key,
    // 让 GUI 和 CLI 共用 DB 时不出现重复或"消失"的历史。
    normalize_legacy_paths(conn)?;
    Ok(())
}

/// 把 `recent_projects.abs_path` 与 `reconstruction_runs.project_path` 里的
/// 老 raw / symlink path 规范化到 canonical 字符串。无对应文件 / canonicalize
/// 失败的 row 原样保留。`recent_projects` 上的 UNIQUE conflict 通过删除 raw
/// alias / 把 row UPDATE 到 canonical 合并。
///
/// 幂等:已 canonical 的 row 不会再被 touch。
fn normalize_legacy_paths(conn: &mut Connection) -> rusqlite::Result<()> {
    // ── reconstruction_runs ────────────────────────────────────────────────
    let run_rows: Vec<(i64, String)> = {
        let mut stmt = conn.prepare("SELECT id, project_path FROM reconstruction_runs")?;
        let rs = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
        rs.collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (id, raw) in run_rows {
        if let Ok(canon) = std::fs::canonicalize(&raw) {
            let canon_str = canon.display().to_string();
            if canon_str != raw {
                conn.execute(
                    "UPDATE reconstruction_runs SET project_path = ?1 WHERE id = ?2",
                    rusqlite::params![canon_str, id],
                )?;
            }
        }
    }

    // ── recent_projects(UNIQUE abs_path) ───────────────────────────────────
    let recent_rows: Vec<(i64, String)> = {
        let mut stmt = conn.prepare("SELECT id, abs_path FROM recent_projects ORDER BY id")?;
        let rs = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
        rs.collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (id, raw) in recent_rows {
        if let Ok(canon) = std::fs::canonicalize(&raw) {
            let canon_str = canon.display().to_string();
            if canon_str == raw {
                continue;
            }
            // canonical row 已存在?有就删 raw alias(保留 canonical 的元数据);
            // 否则把 raw row UPDATE 到 canonical。
            let canon_exists: Option<i64> = conn
                .query_row(
                    "SELECT id FROM recent_projects WHERE abs_path = ?1",
                    [&canon_str],
                    |r| r.get(0),
                )
                .ok();
            if let Some(canon_id) = canon_exists {
                // 并发 sweep 保护:如果 canonical row 的 id 就是当前正在
                // 处理的 raw row id,说明另一个进程刚刚把它 UPDATE 过来,
                // 我们再 DELETE id 等于删掉唯一一条记录。跳过即可。
                if canon_id == id {
                    continue;
                }
                // canonical row 已存在(且是另一条 row)。比较 last_opened_at,
                // 把较新的 metadata(display_name + last_opened_at)合并到
                // canonical row,再删除 raw alias。
                //
                // 所有中间 query_row 都用 .ok() 容错:并发场景下另一个 sweep
                // 可能已经 DELETE 了这两条 row 中的一条,此时我们应该静默
                // 跳过这个项目,而不是让整个 migrate 失败 propagate 出去
                // 让 DB open 报错。
                let raw_meta: Option<(String, String)> = conn
                    .query_row(
                        "SELECT last_opened_at, display_name FROM recent_projects WHERE id = ?1",
                        [id],
                        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
                    )
                    .ok();
                let canon_last: Option<String> = conn
                    .query_row(
                        "SELECT last_opened_at FROM recent_projects WHERE abs_path = ?1",
                        [&canon_str],
                        |r| r.get(0),
                    )
                    .ok();
                if let (Some((raw_last, raw_name)), Some(canon_last)) = (raw_meta, canon_last) {
                    if raw_last > canon_last {
                        conn.execute(
                            "UPDATE recent_projects SET last_opened_at = ?1, display_name = ?2 WHERE abs_path = ?3",
                            rusqlite::params![raw_last, raw_name, canon_str],
                        )?;
                    }
                }
                // DELETE 在 raw row 已经被并发 sweep 删过时返回 0 affected,
                // 这是 idempotent 的,SQLite 不会报错。
                conn.execute("DELETE FROM recent_projects WHERE id = ?1", [id])?;
            } else {
                conn.execute(
                    "UPDATE recent_projects SET abs_path = ?1 WHERE id = ?2",
                    rusqlite::params![canon_str, id],
                )?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn migrate_is_idempotent() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        migrate(&mut conn).unwrap(); // 跑第二次应该无副作用
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='recent_projects'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    /// 在 macOS `/tmp` ↔ `/private/tmp` symlink 别名下,验证 normalize sweep
    /// 把 raw alias row 合并到 canonical row。其他 OS 没有这种 alias 时跳过。
    #[test]
    fn normalize_legacy_paths_merges_alias_into_canonical_row() {
        use tempfile::tempdir;
        let dir = tempdir().unwrap();
        let canonical = dir.path().to_path_buf();
        // macOS 下 dir.path() 通常是 /var/folders/...(已 canonical 到 /private/var/folders/...
        // 也可能就是 /private/var/...)。我们尝试把 /private 前缀去掉造一个 alias path,
        // 然后看 canonicalize 能否解回 canonical;不能的 OS 直接 skip。
        let alias_candidate = std::path::PathBuf::from(
            canonical.display().to_string().replacen("/private", "", 1),
        );
        let alias_works = alias_candidate != canonical
            && std::fs::canonicalize(&alias_candidate).ok().as_ref() == Some(&canonical);
        if !alias_works {
            eprintln!("skip: no /private/<x> alias on this host");
            return;
        }

        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        conn.execute(
            "INSERT INTO recent_projects(abs_path, display_name, last_opened_at) VALUES (?1, 'raw', '2026-01-01T00:00:00')",
            [alias_candidate.display().to_string()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO recent_projects(abs_path, display_name, last_opened_at) VALUES (?1, 'canonical', '2026-01-02T00:00:00')",
            [canonical.display().to_string()],
        )
        .unwrap();
        assert_eq!(
            conn.query_row::<i64, _, _>("SELECT COUNT(*) FROM recent_projects", [], |r| r.get(0))
                .unwrap(),
            2
        );

        // 再跑一次 migrate —— normalize sweep 应该合并 raw 到 canonical,
        // 且 raw 的 last_opened_at 较新(2026-01-02 > 2026-01-01),
        // 所以 raw 的 display_name 'canonical' (注:raw row 用了 'raw' 但
        // last_opened_at 较旧) 不应替换 canonical row 的 display_name。
        // 这里测试用 raw='2026-01-01'(更旧)、canonical='2026-01-02'(更新)
        // 验证 canonical 的 metadata 被保留。
        migrate(&mut conn).unwrap();
        let rows: Vec<(String, String, String)> = {
            let mut stmt = conn
                .prepare("SELECT abs_path, display_name, last_opened_at FROM recent_projects")
                .unwrap();
            stmt.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
        };
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].0, canonical.display().to_string());
        // canonical row 的 metadata 比 raw 新(2026-01-02 > 2026-01-01),被保留。
        assert_eq!(rows[0].1, "canonical");
        assert_eq!(rows[0].2, "2026-01-02T00:00:00");
    }

    /// 翻转 metadata 新旧关系:raw 更新,canonical 更老。合并时应把 raw
    /// 的 display_name + last_opened_at 抢回 canonical row,再删 raw row。
    #[test]
    fn normalize_legacy_paths_keeps_newer_metadata_on_merge() {
        use tempfile::tempdir;
        let dir = tempdir().unwrap();
        // 关键:tempdir().path() 在 macOS 上通常是 /var/folders/...,但
        // canonicalize 才会展开成 /private/var/folders/...。如果不先 canonicalize,
        // `replacen("/private", "", 1)` 是 no-op,alias_works 一律 false,
        // 测试就静默 skip 等于没测。
        let canonical = std::fs::canonicalize(dir.path()).unwrap();
        let alias_candidate = std::path::PathBuf::from(
            canonical.display().to_string().replacen("/private", "", 1),
        );
        let alias_works = alias_candidate != canonical
            && std::fs::canonicalize(&alias_candidate).ok().as_ref() == Some(&canonical);
        if !alias_works {
            return;
        }

        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        // raw 新,canonical 老
        conn.execute(
            "INSERT INTO recent_projects(abs_path, display_name, last_opened_at) VALUES (?1, 'raw-newer', '2026-02-02T00:00:00')",
            [alias_candidate.display().to_string()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO recent_projects(abs_path, display_name, last_opened_at) VALUES (?1, 'canonical-older', '2026-01-01T00:00:00')",
            [canonical.display().to_string()],
        )
        .unwrap();

        migrate(&mut conn).unwrap();
        let row: (String, String, String) = conn
            .query_row(
                "SELECT abs_path, display_name, last_opened_at FROM recent_projects",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(row.0, canonical.display().to_string());
        // raw 的较新 metadata 抢到了 canonical row 上。
        assert_eq!(row.1, "raw-newer");
        assert_eq!(row.2, "2026-02-02T00:00:00");
    }

    /// FIX-12 migration 003:升级路径(002 的 NOT NULL 表 → rebuild 成
    /// nullable)必须保留旧数据,且新表接受 NULL 残差。
    #[test]
    fn migration_003_preserves_rows_and_accepts_null_metrics() {
        let mut conn = Connection::open_in_memory().unwrap();
        // 手动只跑 001+002(模拟旧版本 DB),插入一行,再全量 migrate。
        conn.execute_batch(
            "CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
        )
        .unwrap();
        for (name, sql) in &MIGRATIONS[..2] {
            conn.execute_batch(sql).unwrap();
            conn.execute("INSERT INTO schema_migrations(name) VALUES (?1)", [name])
                .unwrap();
        }
        conn.execute(
            "INSERT INTO reconstruction_runs(project_path, screen_id, measurements_path, method, measured_count, expected_count, estimated_rms_mm, estimated_p95_mm, vertex_count, report_json_path, warnings_json) VALUES ('/p', 'MAIN', 'm.yaml', 'direct_link', 10, 10, 1.5, 3.0, 50, 'r.json', '[]')",
            [],
        )
        .unwrap();

        migrate(&mut conn).unwrap();

        // 旧行保留、数值不变。
        let (rms, p95): (Option<f64>, Option<f64>) = conn
            .query_row(
                "SELECT estimated_rms_mm, estimated_p95_mm FROM reconstruction_runs WHERE project_path='/p'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(rms, Some(1.5));
        assert_eq!(p95, Some(3.0));
        // 新表接受 NULL(direct_link / radial_basis 的诚实输出)。
        conn.execute(
            "INSERT INTO reconstruction_runs(project_path, screen_id, measurements_path, method, measured_count, expected_count, estimated_rms_mm, estimated_p95_mm, vertex_count, report_json_path, warnings_json) VALUES ('/p2', 'MAIN', 'm.yaml', 'direct_link', 10, 10, NULL, NULL, 50, 'r.json', '[]')",
            [],
        )
        .unwrap();
    }

    /// reconstruction_runs 没 UNIQUE,所以 normalize 是 in-place UPDATE,
    /// row 数不变,但 project_path 都变成 canonical 字符串。
    #[test]
    fn normalize_legacy_paths_updates_run_paths_to_canonical() {
        use tempfile::tempdir;
        let dir = tempdir().unwrap();
        // 关键:tempdir().path() 在 macOS 上通常是 /var/folders/...,但
        // canonicalize 才会展开成 /private/var/folders/...。如果不先 canonicalize,
        // `replacen("/private", "", 1)` 是 no-op,alias_works 一律 false,
        // 测试就静默 skip 等于没测。
        let canonical = std::fs::canonicalize(dir.path()).unwrap();
        let alias_candidate = std::path::PathBuf::from(
            canonical.display().to_string().replacen("/private", "", 1),
        );
        let alias_works = alias_candidate != canonical
            && std::fs::canonicalize(&alias_candidate).ok().as_ref() == Some(&canonical);
        if !alias_works {
            return;
        }

        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        conn.execute(
            "INSERT INTO reconstruction_runs(project_path, screen_id, measurements_path, method, measured_count, expected_count, estimated_rms_mm, estimated_p95_mm, vertex_count, report_json_path, warnings_json) VALUES (?1, 'MAIN', 'm.yaml', 'direct_link', 10, 10, 1.0, 2.0, 50, 'r.json', '[]')",
            [alias_candidate.display().to_string()],
        ).unwrap();

        migrate(&mut conn).unwrap();
        let path: String = conn
            .query_row(
                "SELECT project_path FROM reconstruction_runs",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(path, canonical.display().to_string());
    }
}
