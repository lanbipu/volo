//! Top-level error type for UECM. All fallible operations return Result<T, UecmError>.
//! Frontend receives errors as JSON via Tauri command return values.

use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum UecmError {
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("powershell error: {0}")]
    PowerShell(String),

    #[error("invalid input: {0}")]
    InvalidInput(String),

    #[error("operation failed: {0}")]
    OperationFailed(String),

    #[error("configuration error: {0}")]
    Configuration(String),

    #[error("ssh connect failed: {0}")]
    SshConnect(String),

    #[error("node script failed (exit {exit}): {stderr}")]
    NodeScript { exit: i32, stderr: String },

    #[error("operation timed out: {0}")]
    Timeout(String),

    #[error("script staging failed: {0}")]
    ScriptStaging(String),
}

/// Frontend-friendly error representation.
#[derive(Debug, Serialize)]
pub struct ErrorPayload {
    pub code: String,
    pub message: String,
}

impl From<UecmError> for ErrorPayload {
    fn from(err: UecmError) -> Self {
        let code = match &err {
            UecmError::Database(_) => "DATABASE",
            UecmError::Io(_) => "IO",
            UecmError::PowerShell(_) => "POWERSHELL",
            UecmError::InvalidInput(_) => "INVALID_INPUT",
            UecmError::OperationFailed(_) => "OPERATION_FAILED",
            UecmError::Configuration(_) => "CONFIGURATION",
            UecmError::SshConnect(_) => "SSH_CONNECT",
            UecmError::NodeScript { .. } => "NODE_SCRIPT",
            UecmError::Timeout(_) => "TIMEOUT",
            UecmError::ScriptStaging(_) => "SCRIPT_STAGING",
        };
        ErrorPayload {
            code: code.to_string(),
            message: err.to_string(),
        }
    }
}

/// Implement Serialize for UecmError so Tauri can return it directly.
/// Serializes as the ErrorPayload form.
impl Serialize for UecmError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let payload: ErrorPayload = ErrorPayload {
            code: match self {
                UecmError::Database(_) => "DATABASE",
                UecmError::Io(_) => "IO",
                UecmError::PowerShell(_) => "POWERSHELL",
                UecmError::InvalidInput(_) => "INVALID_INPUT",
                UecmError::OperationFailed(_) => "OPERATION_FAILED",
                UecmError::Configuration(_) => "CONFIGURATION",
                UecmError::SshConnect(_) => "SSH_CONNECT",
                UecmError::NodeScript { .. } => "NODE_SCRIPT",
                UecmError::Timeout(_) => "TIMEOUT",
                UecmError::ScriptStaging(_) => "SCRIPT_STAGING",
            }
            .to_string(),
            message: self.to_string(),
        };
        payload.serialize(serializer)
    }
}

pub type UecmResult<T> = Result<T, UecmError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_input_error_serializes_with_correct_code() {
        let err = UecmError::InvalidInput("missing field".to_string());
        let payload: ErrorPayload = err.into();
        assert_eq!(payload.code, "INVALID_INPUT");
        assert!(payload.message.contains("missing field"));
    }

    #[test]
    fn database_error_serializes_with_database_code() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        let err: UecmError = conn.execute("INVALID SQL", []).unwrap_err().into();
        let payload: ErrorPayload = err.into();
        assert_eq!(payload.code, "DATABASE");
    }

    #[test]
    fn uecm_error_serializes_to_json() {
        let err = UecmError::PowerShell("script crashed".to_string());
        let json = serde_json::to_string(&err).unwrap();
        assert!(json.contains("POWERSHELL"));
        assert!(json.contains("script crashed"));
    }

    #[test]
    fn ssh_connect_error_serializes_with_code() {
        let err = UecmError::SshConnect("port 22 refused".to_string());
        let payload: ErrorPayload = err.into();
        assert_eq!(payload.code, "SSH_CONNECT");
        assert!(payload.message.contains("port 22 refused"));
    }

    #[test]
    fn node_script_error_carries_exit_and_stderr() {
        let err = UecmError::NodeScript { exit: 3, stderr: "boom".to_string() };
        let payload: ErrorPayload = err.into();
        assert_eq!(payload.code, "NODE_SCRIPT");
        assert!(payload.message.contains("3"));
        assert!(payload.message.contains("boom"));
    }
}
