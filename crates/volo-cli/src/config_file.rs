//! `--config <path>` loader. Supports YAML / JSON (JSON is a YAML subset, parsed
//! by serde_yaml). Enforces file mode <= 0600 on unix per spec §9.

use cache_core::error::{UecmError, UecmResult};
use serde::Deserialize;
use std::path::Path;

/// CLI defaults loaded from a config file. All fields optional; explicit CLI
/// flags always win over file values.
#[derive(Debug, Deserialize, Default, PartialEq)]
pub struct FileConfig {
    pub db_path: Option<String>,
    pub log_level: Option<String>,
    pub output: Option<String>,
}

pub fn load(path: &Path) -> UecmResult<FileConfig> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(path)
            .map_err(|e| UecmError::Configuration(format!("config {}: {}", path.display(), e)))?
            .permissions()
            .mode();
        if mode & 0o077 != 0 {
            return Err(UecmError::Configuration(format!(
                "config file {} is too permissive (mode {:o}); chmod 600 it (spec §9)",
                path.display(),
                mode & 0o777
            )));
        }
    }
    let text = std::fs::read_to_string(path)
        .map_err(|e| UecmError::Configuration(format!("read config {}: {}", path.display(), e)))?;
    serde_yaml::from_str(&text)
        .map_err(|e| UecmError::Configuration(format!("parse config {}: {}", path.display(), e)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn parses_yaml_fields() {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        write!(f, "db_path: /tmp/x.db\nlog_level: debug\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(f.path(), std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        let cfg = load(f.path()).unwrap();
        assert_eq!(cfg.db_path.as_deref(), Some("/tmp/x.db"));
        assert_eq!(cfg.log_level.as_deref(), Some("debug"));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_world_readable_config() {
        use std::os::unix::fs::PermissionsExt;
        let mut f = tempfile::NamedTempFile::new().unwrap();
        write!(f, "log_level: info\n").unwrap();
        std::fs::set_permissions(f.path(), std::fs::Permissions::from_mode(0o644)).unwrap();
        let err = load(f.path()).unwrap_err();
        assert!(matches!(err, UecmError::Configuration(_)));
    }
}
