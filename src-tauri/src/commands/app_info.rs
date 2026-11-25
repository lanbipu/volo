//! 设置页「关于 / 数据」用的本机信息：版本号和 app data 目录。

use serde::Serialize;
use tauri::{AppHandle, Manager};

#[derive(Serialize)]
pub struct AppInfo {
    pub version: String,
    pub data_dir: Option<String>,
    pub debug: bool,
}

#[tauri::command]
pub fn app_info(app: AppHandle) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        data_dir: app.path().app_data_dir().ok().map(|p| p.to_string_lossy().into_owned()),
        debug: cfg!(debug_assertions),
    }
}
