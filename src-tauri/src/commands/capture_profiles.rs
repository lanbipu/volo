//! Persistent Calibrate capture profiles.
//!
//! Profiles are transport configuration consumed by `vpcal capture session`,
//! so they belong in the native app data directory rather than WebView storage.

use std::{fs, path::PathBuf};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

fn profiles_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位 app data 目录: {e}"))?;
    Ok(dir.join("calibrate").join("capture-profiles.json"))
}

#[derive(Serialize)]
pub struct CaptureProfilesState {
    pub profiles: Vec<Value>,
    /// False only before this backend has ever persisted profiles. The frontend
    /// uses it for the one-time migration from the previous localStorage store.
    pub initialized: bool,
}

fn load_from_path(path: &std::path::Path) -> Result<CaptureProfilesState, String> {
    if !path.exists() {
        return Ok(CaptureProfilesState { profiles: Vec::new(), initialized: false });
    }
    let bytes = fs::read(&path).map_err(|e| format!("读取采集配置失败 ({}): {e}", path.display()))?;
    let profiles = serde_json::from_slice(&bytes)
        .map_err(|e| format!("采集配置文件格式无效 ({}): {e}", path.display()))?;
    Ok(CaptureProfilesState { profiles, initialized: true })
}

#[tauri::command]
pub fn list_capture_profiles(app: AppHandle) -> Result<CaptureProfilesState, String> {
    load_from_path(&profiles_path(&app)?)
}

fn save_to_path(path: &std::path::Path, profiles: &[Value]) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| "采集配置路径无父目录".to_string())?;
    fs::create_dir_all(parent).map_err(|e| format!("创建采集配置目录失败 ({}): {e}", parent.display()))?;
    let tmp = path.with_extension("json.tmp");
    let backup = path.with_extension("json.bak");
    let bytes = serde_json::to_vec_pretty(&profiles).map_err(|e| format!("序列化采集配置失败: {e}"))?;
    fs::write(&tmp, bytes).map_err(|e| format!("写入采集配置失败 ({}): {e}", tmp.display()))?;

    // `rename(tmp, path)` replaces atomically on Unix but fails when `path`
    // exists on Windows. A backup swap gives both platforms the same behavior
    // and preserves the last valid file if the final rename fails.
    if backup.exists() {
        fs::remove_file(&backup).map_err(|e| format!("清理采集配置备份失败 ({}): {e}", backup.display()))?;
    }
    if path.exists() {
        fs::rename(path, &backup).map_err(|e| format!("备份采集配置失败 ({}): {e}", path.display()))?;
    }
    if let Err(e) = fs::rename(&tmp, path) {
        if backup.exists() {
            let _ = fs::rename(&backup, path);
        }
        return Err(format!("提交采集配置失败 ({}): {e}", path.display()));
    }
    if backup.exists() {
        // The new file is already committed. A stale backup is harmless and
        // must not turn a successful save into an error seen by the frontend.
        let _ = fs::remove_file(&backup);
    }
    Ok(())
}

#[tauri::command]
pub fn save_capture_profiles(app: AppHandle, profiles: Vec<Value>) -> Result<(), String> {
    save_to_path(&profiles_path(&app)?, &profiles)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distinguishes_uninitialized_and_persisted_empty_state() {
        let root = std::env::temp_dir().join(format!("volo-capture-profiles-{}", std::process::id()));
        let path = root.join("capture-profiles.json");
        let _ = fs::remove_dir_all(&root);
        assert!(!load_from_path(&path).unwrap().initialized);
        save_to_path(&path, &[]).unwrap();
        let loaded = load_from_path(&path).unwrap();
        assert!(loaded.initialized);
        assert!(loaded.profiles.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn replaces_an_existing_profile_file() {
        let root = std::env::temp_dir().join(format!("volo-capture-profiles-replace-{}", std::process::id()));
        let path = root.join("capture-profiles.json");
        let _ = fs::remove_dir_all(&root);
        save_to_path(&path, &[serde_json::json!({"id":"old"})]).unwrap();
        save_to_path(&path, &[serde_json::json!({"id":"new"})]).unwrap();
        assert_eq!(load_from_path(&path).unwrap().profiles[0]["id"], "new");
        let _ = fs::remove_dir_all(root);
    }
}
