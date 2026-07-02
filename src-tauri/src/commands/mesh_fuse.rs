//! W6 R1: M1(全站仪)+ M2(视觉 BA)融合 Tauri command shim。业务逻辑在
//! `mesh_app::fuse::run_fuse`,本文件只做 transport 翻译。

use std::path::Path;

use volo_shared::dto::FuseResult;
use volo_shared::error::VoloResult;

#[tauri::command]
pub fn mesh_fuse_run(
    project_path: String,
    screen_id: String,
    pose_report_path: String,
    measurements_path: String,
    allow_scale: bool,
) -> VoloResult<FuseResult> {
    mesh_app::fuse::run_fuse(
        Path::new(&project_path),
        &screen_id,
        Path::new(&pose_report_path),
        Path::new(&measurements_path),
        allow_scale,
    )
}
