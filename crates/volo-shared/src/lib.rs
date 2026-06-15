//! LMT shared platform layer.
//!
//! 把"非 transport 的 platform 类型"(DTO、错误模型、sqlite 数据层)
//! 从 lmt-tauri 提级到 workspace 共享 crate,让 CLI / 日后 HTTP API
//! 与现有 Tauri GUI 共用同一份契约。
//!
//! - `mesh-core` 仍是纯 domain 层,本 crate 不会反向污染。
//! - 本 crate 不依赖 tauri / axum 等 transport 框架。

pub mod data;
pub mod dto;
pub mod envelope;
pub mod error;
pub mod exit_codes;
pub mod manifest;
pub mod schema;

pub use envelope::{ApiError, Envelope, ErrorEnvelope};
pub use error::{LmtError, LmtResult};
