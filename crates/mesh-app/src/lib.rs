//! LMT 服务层。
//!
//! 承载 `run_*` 风格的 transport-agnostic business helpers——同时被
//! Tauri GUI 的 `#[tauri::command]` shim 与 `volo-cli` 的子命令调用。
//!
//! 与 `volo-shared` 的分工:
//! - `volo-shared` = 共享契约层(DTO / error / envelope / 数据访问)。
//! - `mesh-app` = service 层,把 `volo-shared` 的契约 + `mesh-adapter-*` 的
//!   领域算子组装成一个个独立的 use case 函数。
//!
//! 本 crate 不依赖 `tauri`——所有 `#[tauri::command]` 装饰留在 src-tauri 一侧。

pub mod export;
pub mod fuse;
pub mod measurements;
pub mod ndisplay;
pub mod output;
pub mod projects;
pub mod reconstruct;
pub mod total_station;
pub mod total_station_mapper;
pub mod visual;
