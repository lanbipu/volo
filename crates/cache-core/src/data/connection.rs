//! SQLite connection management. Wraps a single connection in an Arc<Mutex>
//! suitable for sharing across Tauri command handlers (Tauri commands are
//! invoked on a thread pool so we need interior mutability).

use crate::error::UecmResult;
use rusqlite::Connection;
use std::path::Path;
use std::sync::{Arc, Mutex};

pub type Db = Arc<Mutex<Connection>>;

pub fn open(path: &Path) -> UecmResult<Db> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(Arc::new(Mutex::new(conn)))
}

pub fn open_in_memory() -> UecmResult<Db> {
    let conn = Connection::open_in_memory()?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(Arc::new(Mutex::new(conn)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn open_creates_database_file() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("test.sqlite");
        let _db = open(&path).unwrap();
        assert!(path.exists());
    }

    #[test]
    fn open_in_memory_returns_usable_connection() {
        let db = open_in_memory().unwrap();
        let conn = db.lock().unwrap();
        let result: i32 = conn.query_row("SELECT 1", [], |r| r.get(0)).unwrap();
        assert_eq!(result, 1);
    }

    #[test]
    fn wal_mode_is_enabled_for_file_db() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("test.sqlite");
        let db = open(&path).unwrap();
        let conn = db.lock().unwrap();
        let mode: String = conn.query_row("PRAGMA journal_mode", [], |r| r.get(0)).unwrap();
        assert_eq!(mode.to_lowercase(), "wal");
    }
}
