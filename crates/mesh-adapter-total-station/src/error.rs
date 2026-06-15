use thiserror::Error;

#[derive(Debug, Error)]
#[non_exhaustive]
pub enum AdapterError {
    #[error("invalid input: {0}")]
    InvalidInput(String),

    #[error("csv parse error: {0}")]
    Csv(#[from] csv::Error),

    #[error("yaml parse error: {0}")]
    Yaml(#[from] serde_yaml::Error),

    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("core error: {0}")]
    Core(#[from] mesh_core::CoreError),
}
