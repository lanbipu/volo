//! Shared output envelope (spec §4). One-shot results -> SuccessEnvelope; failures
//! -> ErrorEnvelope; ndjson events get per-event metadata (see output.rs).
//! `ErrorBody` derives JsonSchema so it can serve as the manifest error_schema.

use cache_core::error::UecmError;
use schemars::JsonSchema;
use serde::Serialize;

pub const SCHEMA_VERSION: &str = "1.0";

#[derive(Debug, Serialize)]
pub struct Meta {
    pub request_id: String,
    pub duration_ms: u128,
    pub timestamp: String,
}

#[derive(Debug, Serialize)]
pub struct SuccessEnvelope<'a> {
    pub schema_version: &'static str,
    pub status: &'static str, // "ok"
    pub operation_id: &'a str,
    pub data: serde_json::Value,
    pub meta: Meta,
}

/// 错误信封的 `error` 体。**派生 JsonSchema** 作为 manifest 的共享 error_schema。
#[derive(Debug, Serialize, JsonSchema)]
pub struct ErrorBody {
    pub code: String,
    pub exit_code: i32,
    pub message: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "serde_json::Value::is_null")]
    #[schemars(skip)]
    pub details: serde_json::Value,
}

#[derive(Debug, Serialize)]
pub struct ErrorEnvelope<'a> {
    pub schema_version: &'static str,
    pub status: &'static str, // "error"
    pub operation_id: &'a str,
    pub error: ErrorBody,
    pub meta: Meta,
}

/// 瞬态故障可重试；参数/配置类不可重试（spec §4.2 retryable）。
pub fn retryable_for(err: &UecmError) -> bool {
    matches!(
        err,
        UecmError::Timeout(_)
            | UecmError::SshConnect(_)
            | UecmError::PowerShell(_)
            | UecmError::NodeScript { .. }
    )
}

/// uuid-v4 形态随机 request id（用已有 rand，避免引 uuid crate）。
pub fn gen_request_id() -> String {
    use rand::RngCore;
    let mut b = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        b[0],b[1],b[2],b[3],b[4],b[5],b[6],b[7],b[8],b[9],b[10],b[11],b[12],b[13],b[14],b[15]
    )
}

/// 当前 UTC ISO-8601 时间戳（spec §4.5）。
pub fn now_iso8601() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_id_is_uuid_v4_shaped() {
        let id = gen_request_id();
        assert_eq!(id.len(), 36);
        assert_eq!(id.as_bytes()[14], b'4');
        assert_eq!(id.matches('-').count(), 4);
    }

    #[test]
    fn retryable_classification() {
        assert!(retryable_for(&UecmError::Timeout("t".into())));
        assert!(!retryable_for(&UecmError::InvalidInput("x".into())));
    }

    #[test]
    fn timestamp_is_utc_z() {
        assert!(now_iso8601().ends_with('Z'));
    }

    #[test]
    fn error_body_has_schema() {
        let s = serde_json::to_value(schemars::schema_for!(ErrorBody)).unwrap();
        assert!(s["properties"]["code"].is_object());
        assert!(s["properties"]["exit_code"].is_object());
        assert!(s["properties"]["retryable"].is_object());
    }
}
