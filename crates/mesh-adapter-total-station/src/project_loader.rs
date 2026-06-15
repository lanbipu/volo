use std::path::Path;

use crate::error::AdapterError;
use crate::project::ProjectConfig;

/// Load a project YAML, parse it, and run `ProjectConfig::validate()` to
/// reject impossible geometry at the parse boundary.
pub fn load_project(path: &Path) -> Result<ProjectConfig, AdapterError> {
    let s = std::fs::read_to_string(path)?;
    let cfg: ProjectConfig = serde_yaml::from_str(&s)?;
    cfg.validate()?;
    Ok(cfg)
}
