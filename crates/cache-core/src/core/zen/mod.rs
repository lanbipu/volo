//! Zen-server wire format support.
//!
//! Volo only ever reads zen's responses (`/health/info`, `/stats`, `/stats/z$`)
//! and the `.lock` lockfile. Both are serialized in UE's Compact Binary (CB)
//! format. Submodules here implement a read-only mini-parser for that format;
//! we never produce CB ourselves.

pub mod binary;
pub mod cache_stats;
pub mod cb_parser;
pub mod disk_space;
pub mod enable;
pub mod endpoint;
pub mod local_port;
pub mod lockfile;
pub mod lua_config;
pub mod ops;
pub mod probe;
pub mod redaction;
pub mod rules_loader;
pub mod retention;
pub mod service_account;
pub mod verify;

#[cfg(test)]
pub mod test_http;
