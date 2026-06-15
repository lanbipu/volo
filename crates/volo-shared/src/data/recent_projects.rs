use crate::dto::RecentProject;
use crate::error::{LmtError, LmtResult};
use rusqlite::Connection;
use std::path::Path;

/// 把 `abs_path` 规范化到一个稳定的字符串形式,再走 [`upsert`]。这是
/// GUI 与 CLI 共用 DB 时唯一的入口契约:同一个项目无论从哪边添加,
/// `recent_projects.abs_path`(UNIQUE key)都落到同一字符串,不会变成
/// 两条记录。
///
/// 规范化策略:
/// - 路径存在:`std::fs::canonicalize`(解符号链接 + 去 `.`/`..`)。
/// - 路径不存在:`std::path::absolute`(基于当前进程 cwd 转绝对)。
pub fn upsert_normalized(
    conn: &Connection,
    abs_path: &str,
    display_name: &str,
) -> LmtResult<RecentProject> {
    let raw = Path::new(abs_path);
    let normalized = if raw.exists() {
        std::fs::canonicalize(raw).map_err(|e| {
            LmtError::Io(format!("canonicalize recent project {abs_path}: {e}"))
        })?
    } else {
        std::path::absolute(raw)
            .map_err(|e| LmtError::Io(format!("absolutize recent project {abs_path}: {e}")))?
    };
    let normalized_str = normalized.display().to_string();
    // 如果 caller 传的 raw 跟规范化后字符串不同,DB 里可能有一条老 raw alias
    // (升级前写入的、或另一个 caller 用 symlink path 写入的)。在写 canonical
    // 之前先删掉 raw alias,这样同一项目永远只剩一条 row;否则 list-recent
    // 会显示两个看上去不同的入口,GUI / agent 都困惑。
    if abs_path != normalized_str.as_str() {
        conn.execute(
            "DELETE FROM recent_projects WHERE abs_path = ?1",
            rusqlite::params![abs_path],
        )?;
    }
    upsert(conn, &normalized_str, display_name)
}

/// Insert or update a recent project entry.
/// On conflict (same abs_path), updates display_name and last_opened_at.
/// Returns the full row after the upsert.
pub fn upsert(conn: &Connection, abs_path: &str, display_name: &str) -> LmtResult<RecentProject> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        r#"
        INSERT INTO recent_projects (abs_path, display_name, last_opened_at)
        VALUES (?1, ?2, ?3)
        ON CONFLICT(abs_path) DO UPDATE SET
            display_name    = excluded.display_name,
            last_opened_at  = excluded.last_opened_at
        "#,
        rusqlite::params![abs_path, display_name, now],
    )?;

    let row = conn.query_row(
        "SELECT id, abs_path, display_name, last_opened_at FROM recent_projects WHERE abs_path = ?1",
        rusqlite::params![abs_path],
        |r| {
            Ok(RecentProject {
                id: r.get(0)?,
                abs_path: r.get(1)?,
                display_name: r.get(2)?,
                last_opened_at: r.get(3)?,
            })
        },
    )?;

    Ok(row)
}

/// Return all recent projects ordered by last_opened_at descending (most recent first).
pub fn list(conn: &Connection) -> LmtResult<Vec<RecentProject>> {
    let mut stmt = conn.prepare(
        "SELECT id, abs_path, display_name, last_opened_at FROM recent_projects ORDER BY last_opened_at DESC",
    )?;

    let rows = stmt.query_map([], |r| {
        Ok(RecentProject {
            id: r.get(0)?,
            abs_path: r.get(1)?,
            display_name: r.get(2)?,
            last_opened_at: r.get(3)?,
        })
    })?;

    let mut projects = Vec::new();
    for row in rows {
        projects.push(row?);
    }
    Ok(projects)
}

/// Delete a recent project by id. No-op if the id does not exist.
pub fn delete(conn: &Connection, id: i64) -> LmtResult<()> {
    conn.execute(
        "DELETE FROM recent_projects WHERE id = ?1",
        rusqlite::params![id],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::schema;
    use rusqlite::Connection;

    fn setup() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        schema::migrate(&mut conn).unwrap();
        conn
    }

    #[test]
    fn upsert_and_list() {
        let conn = setup();

        // Insert /a and /b
        let a1 = upsert(&conn, "/a", "Project A").unwrap();
        let b = upsert(&conn, "/b", "Project B").unwrap();

        // Both paths should have different ids
        assert_ne!(a1.id, b.id);
        assert_eq!(a1.abs_path, "/a");
        assert_eq!(b.abs_path, "/b");

        // Small delay to ensure distinct last_opened_at timestamps
        std::thread::sleep(std::time::Duration::from_millis(10));

        // Upsert /a again — same id, updated timestamp
        let a2 = upsert(&conn, "/a", "Project A v2").unwrap();
        assert_eq!(a1.id, a2.id, "upsert should preserve the same row id");
        assert_eq!(a2.display_name, "Project A v2");
        // Timestamp must have advanced
        assert!(
            a2.last_opened_at > a1.last_opened_at,
            "last_opened_at should be updated: {} > {}",
            a2.last_opened_at,
            a1.last_opened_at
        );

        // list: 2 entries, /a first (most recently touched)
        let rows = list(&conn).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].abs_path, "/a");
        assert_eq!(rows[1].abs_path, "/b");
    }

    #[test]
    fn delete_by_id() {
        let conn = setup();

        let p = upsert(&conn, "/del", "Delete Me").unwrap();
        let before = list(&conn).unwrap();
        assert_eq!(before.len(), 1);

        delete(&conn, p.id).unwrap();
        let after = list(&conn).unwrap();
        assert_eq!(after.len(), 0);
    }

    #[test]
    fn delete_nonexistent_is_noop() {
        let conn = setup();
        // Should not error
        delete(&conn, 9999).unwrap();
    }
}
