//! 工具页（键控实验 / 追踪模拟）的少量本机文件操作。
//!
//! - `save_file_bytes`：弹系统保存框，把前端生成的字节（键控导出的 PNG、基准测试报告）写到用户选的位置。
//! - `write_tracksim_config`：tracksim 的发送目标（地址 / 端口 / 传输）只能从配置文件读，
//!   这里把前端拼好的配置写到 app data 下的固定位置，返回路径给 `tracksim --config`。
//! - `read_tracksim_track`：读 `tracksim.track/1` 轨迹 JSON，给追踪模拟画整条轨迹。

use std::path::{Path, PathBuf};

use serde_json::Value;
use tauri::{AppHandle, Manager};

const MAX_SAVE_BYTES: usize = 256 * 1024 * 1024;
const MAX_CONFIG_BYTES: usize = 256 * 1024;
const MAX_TRACK_BYTES: u64 = 32 * 1024 * 1024;

#[tauri::command]
pub async fn save_file_bytes(
    app: AppHandle,
    default_name: String,
    filter_name: String,
    filter_extensions: Vec<String>,
    bytes: Vec<u8>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    if bytes.len() > MAX_SAVE_BYTES {
        return Err(format!("文件太大（{} 字节）", bytes.len()));
    }
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let ext_refs: Vec<&str> = filter_extensions.iter().map(String::as_str).collect();
        let mut dlg = app.dialog().file().set_file_name(&default_name);
        if !ext_refs.is_empty() {
            dlg = dlg.add_filter(&filter_name, &ext_refs);
        }
        dlg.blocking_save_file().and_then(|fp| fp.into_path().ok())
    })
    .await
    .map_err(|e| format!("保存框出错：{e}"))?;
    let Some(path) = picked else { return Ok(None) };
    std::fs::write(&path, &bytes).map_err(|e| format!("写入 {} 失败：{e}", path.display()))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

fn tracksim_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| format!("无法定位 app data 目录: {e}"))?;
    Ok(dir.join("tools").join("tracksim.json"))
}

#[tauri::command]
pub fn write_tracksim_config(app: AppHandle, config: Value) -> Result<String, String> {
    if !config.is_object() {
        return Err("tracksim 配置必须是对象".into());
    }
    let text = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    if text.len() > MAX_CONFIG_BYTES {
        return Err("tracksim 配置太大".into());
    }
    let path = tracksim_config_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建 {} 失败：{e}", parent.display()))?;
    }
    std::fs::write(&path, text).map_err(|e| format!("写入 {} 失败：{e}", path.display()))?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn read_tracksim_track(path: String) -> Result<Value, String> {
    let p = Path::new(&path);
    if p.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("json")) != Some(true) {
        return Err("只能预览 .json 轨迹".into());
    }
    let meta = std::fs::metadata(p).map_err(|e| format!("读不到 {path}：{e}"))?;
    if meta.len() > MAX_TRACK_BYTES {
        return Err("轨迹文件太大，不预览".into());
    }
    let text = std::fs::read_to_string(p).map_err(|e| format!("读不到 {path}：{e}"))?;
    let v: Value = serde_json::from_str(&text).map_err(|e| format!("不是有效的 JSON：{e}"))?;
    /* 和 tracksim 播放时的校验一致：schema 不对的文件预览了也发不出去 */
    if v.get("schema").and_then(Value::as_str) != Some("tracksim.track/1") || !v.get("frames").map(Value::is_array).unwrap_or(false) {
        return Err("不是 tracksim 轨迹（需要 schema = tracksim.track/1 和 frames）".into());
    }
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn track_rejects_non_json() {
        assert!(read_tracksim_track("/tmp/x.csv".into()).is_err());
    }

    #[test]
    fn track_reads_frames() {
        let dir = std::env::temp_dir().join(format!("volo-track-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("t.json");
        std::fs::write(&f, r#"{"schema":"tracksim.track/1","rate":25,"camera":"c","frames":[{"t":0,"pose":{"x":0}}]}"#).unwrap();
        let v = read_tracksim_track(f.to_string_lossy().into_owned()).unwrap();
        assert_eq!(v["frames"].as_array().unwrap().len(), 1);
        std::fs::write(&f, r#"{"rate":25}"#).unwrap();
        assert!(read_tracksim_track(f.to_string_lossy().into_owned()).is_err());
        std::fs::write(&f, r#"{"rate":25,"frames":[]}"#).unwrap();
        assert!(read_tracksim_track(f.to_string_lossy().into_owned()).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
