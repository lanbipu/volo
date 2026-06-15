//! Error types for the visual-BA adapter.

use std::io;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum VbaError {
    #[error("sidecar binary not found: searched {tried:?}")]
    SidecarNotFound { tried: Vec<String> },

    #[error("failed to spawn sidecar: {0}")]
    SpawnFailed(#[from] io::Error),

    #[error("sidecar exited non-zero (code {code:?}): {message}")]
    SidecarFailed { code: Option<i32>, message: String },

    #[error("sidecar emitted no result event before exit")]
    NoResultEvent,

    #[error("sidecar emitted invalid event JSON: {0}")]
    BadEventJson(#[from] serde_json::Error),

    #[error("sidecar emitted protocol error: code={code} message={message}")]
    Protocol { code: String, message: String },

    #[error("operation cancelled by caller")]
    Cancelled,

    #[error("invalid input: {0}")]
    InvalidInput(String),
}

pub type VbaResult<T> = std::result::Result<T, VbaError>;
