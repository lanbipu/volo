//! cache-core — Volo cache 纯业务逻辑层（零 tauri）。
//!
//! 从 `ue-cache-manager/src-tauri/src/` 平移 core/data/startup/error 四层，
//! 不含 cli/commands/tauri::Builder。供 volo 的 CLI (step 2b) 与
//! tauri commands (step 2c) 共同依赖。

pub mod core;
pub mod data;
pub mod error;
pub mod startup;

/// Crate-wide lock for tests that mutate process-global env vars (`UECM_*`).
/// Multiple modules touch the same env vars; without a single shared mutex,
/// parallel tests in different modules can interleave set/remove calls and
/// produce flaky reads. Acquire this lock at the top of any env-mutating test.
#[cfg(test)]
pub(crate) static ENV_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
