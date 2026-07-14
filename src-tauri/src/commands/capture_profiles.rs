//! Persistent Calibrate capture profiles.
//!
//! Profiles are transport configuration consumed by `vpcal capture session`,
//! so they belong in the native app data directory rather than WebView storage.

use std::{fs, path::PathBuf};

use base64::Engine;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

fn last_json_line(output: &str) -> Option<Value> {
    output
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str(line).ok())
}

fn structured_error(stdout: &str, stderr: &str) -> String {
    if let Some(error) = last_json_line(stdout).and_then(|value| value.get("error").cloned()) {
        if let Ok(json) = serde_json::to_string(&error) {
            return json;
        }
    }
    let detail = if stderr.trim().is_empty() {
        stdout.trim()
    } else {
        stderr.trim()
    };
    if detail.is_empty() {
        "vpcal operation failed".into()
    } else {
        detail.into()
    }
}

/// Run a sidecar command with a wall-clock bound, killing the entire process
/// tree on timeout. The packaged vpcal is a PyInstaller `--onefile` bootloader
/// whose real Python worker runs as a *child*; terminating only the immediate
/// process (`kill_on_drop`) would orphan that worker — and a capture probe's
/// worker still holds the DeckLink card open, so the card would stay occupied
/// until it is killed by hand or the machine reboots. On Windows we walk the
/// tree with `taskkill /T`; `kill_on_drop` remains a backstop for the immediate
/// child on every platform.
async fn run_sidecar_bounded(
    mut base: std::process::Command,
    timeout: std::time::Duration,
    timeout_msg: &str,
) -> Result<std::process::Output, String> {
    base.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut command = tokio::process::Command::from(base);
    command.kill_on_drop(true);
    let child = command
        .spawn()
        .map_err(|e| format!("启动 vpcal 失败: {e}"))?;
    let pid = child.id();
    tokio::select! {
        result = child.wait_with_output() => {
            result.map_err(|e| format!("等待 vpcal 结束失败: {e}"))
        }
        _ = tokio::time::sleep(timeout) => {
            // The wait_with_output future is not dropped until this arm returns,
            // so the bootloader (the taskkill parent PID) is still alive here.
            #[cfg(windows)]
            if let Some(pid) = pid {
                let _ = std::process::Command::new("taskkill")
                    .args(["/F", "/T", "/PID", &pid.to_string()])
                    .output();
            }
            #[cfg(not(windows))]
            let _ = pid;
            Err(timeout_msg.to_string())
        }
    }
}

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
        return Ok(CaptureProfilesState {
            profiles: Vec::new(),
            initialized: false,
        });
    }
    let bytes =
        fs::read(&path).map_err(|e| format!("读取采集配置失败 ({}): {e}", path.display()))?;
    let profiles = serde_json::from_slice(&bytes)
        .map_err(|e| format!("采集配置文件格式无效 ({}): {e}", path.display()))?;
    Ok(CaptureProfilesState {
        profiles,
        initialized: true,
    })
}

#[tauri::command]
pub fn list_capture_profiles(app: AppHandle) -> Result<CaptureProfilesState, String> {
    load_from_path(&profiles_path(&app)?)
}

fn save_to_path(path: &std::path::Path, profiles: &[Value]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "采集配置路径无父目录".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("创建采集配置目录失败 ({}): {e}", parent.display()))?;
    let tmp = path.with_extension("json.tmp");
    let backup = path.with_extension("json.bak");
    let bytes =
        serde_json::to_vec_pretty(&profiles).map_err(|e| format!("序列化采集配置失败: {e}"))?;
    fs::write(&tmp, bytes).map_err(|e| format!("写入采集配置失败 ({}): {e}", tmp.display()))?;

    // `rename(tmp, path)` replaces atomically on Unix but fails when `path`
    // exists on Windows. A backup swap gives both platforms the same behavior
    // and preserves the last valid file if the final rename fails.
    if backup.exists() {
        fs::remove_file(&backup)
            .map_err(|e| format!("清理采集配置备份失败 ({}): {e}", backup.display()))?;
    }
    if path.exists() {
        fs::rename(path, &backup)
            .map_err(|e| format!("备份采集配置失败 ({}): {e}", path.display()))?;
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

#[derive(Serialize)]
pub struct TrackingProbeResult {
    pub frames: usize,
    pub latest: Option<Value>,
}

#[derive(Serialize)]
pub struct VideoProbeResult {
    pub frames: u64,
    pub mean_fps: f64,
    pub preview_data_url: Option<String>,
    pub source: Option<Value>,
}

#[derive(Serialize)]
pub struct VideoSourceList {
    pub backend: String,
    pub timeout_s: f64,
    pub sources: Vec<Value>,
}

#[tauri::command]
pub async fn enumerate_video_sources(
    backend: String,
    timeout_s: Option<f64>,
) -> Result<VideoSourceList, String> {
    if !["ndi", "decklink", "synthetic"].contains(&backend.as_str()) {
        return Err(format!("不支持枚举的视频 backend: {backend}"));
    }
    let timeout_s = timeout_s.unwrap_or(3.0);
    if !timeout_s.is_finite() || !(0.0..=30.0).contains(&timeout_s) {
        return Err("视频源枚举 timeout_s 必须在 0 到 30 秒之间".into());
    }
    let exe = super::sidecars::locate_by_name("vpcal").map_err(|e| e.to_string())?;
    let timeout_arg = timeout_s.to_string();
    let mut base = super::sidecars::sidecar_command(exe);
    base.args([
        "capture",
        "enumerate",
        "--backend",
        backend.as_str(),
        "--timeout",
        &timeout_arg,
        "--output",
        "json",
    ]);
    // Bound the enumeration like the probe: a wedged/contended DeckLink driver
    // can make list_devices() block forever, hanging the UI's scan spinner with
    // no way to recover. Allow vpcal's own --timeout to fire first, then cut it.
    let output = run_sidecar_bounded(
        base,
        std::time::Duration::from_secs_f64(timeout_s + 10.0),
        "视频源枚举超时（采集卡驱动无响应，请检查 Desktop Video 驱动状态）",
    )
    .await?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() {
        return Err(structured_error(&stdout, &stderr));
    }
    let envelope =
        last_json_line(&stdout).ok_or_else(|| "vpcal 视频源枚举未返回 JSON".to_string())?;
    let data = envelope.get("data").unwrap_or(&envelope);
    let sources = data
        .get("sources")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(VideoSourceList {
        backend,
        timeout_s: data
            .get("timeout_s")
            .and_then(Value::as_f64)
            .unwrap_or(timeout_s),
        sources,
    })
}

#[tauri::command]
pub async fn probe_video_source(
    app: AppHandle,
    backend: String,
    device: String,
    width: Option<u32>,
    height: Option<u32>,
    fps: Option<f64>,
    transfer_function: String,
) -> Result<VideoProbeResult, String> {
    if !["uvc", "ndi", "decklink", "synthetic"].contains(&backend.as_str()) {
        return Err(format!("不支持的视频 backend: {backend}"));
    }
    let exe = super::sidecars::locate_by_name("vpcal").map_err(|e| e.to_string())?;
    let probe_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("无法定位 app cache 目录: {e}"))?
        .join(format!("video-probe-{}", std::process::id()));
    let _ = fs::remove_dir_all(&probe_dir);
    fs::create_dir_all(&probe_dir).map_err(|e| format!("创建视频探测目录失败: {e}"))?;
    let mut args: Vec<String> = vec![
        "capture".into(),
        "video".into(),
        "--backend".into(),
        backend,
        "--device".into(),
        device,
        "--duration".into(),
        "1".into(),
        "--max-frames".into(),
        "5".into(),
        "--allow-hx".into(),
        "--transfer-function".into(),
        transfer_function,
        "--output".into(),
        "json".into(),
        "--out".into(),
        probe_dir.to_string_lossy().into_owned(),
    ];
    if let Some(v) = width {
        args.extend(["--width".into(), v.to_string()]);
    }
    if let Some(v) = height {
        args.extend(["--height".into(), v.to_string()]);
    }
    if let Some(v) = fps {
        args.extend(["--fps".into(), v.to_string()]);
    }
    // A wedged/occupied device (driver hang, contended card) can make `capture
    // video` block indefinitely; bound the probe so the UI never hangs. On
    // timeout the whole process tree is killed (see run_sidecar_bounded) so the
    // DeckLink card is freed rather than left occupied by an orphaned worker.
    let mut base = super::sidecars::sidecar_command(exe);
    base.args(&args);
    let output = match run_sidecar_bounded(
        base,
        std::time::Duration::from_secs(20),
        "视频探测超时（设备可能被其他程序占用或驱动无响应）",
    )
    .await
    {
        Ok(output) => output,
        Err(msg) => {
            let _ = fs::remove_dir_all(&probe_dir);
            return Err(msg);
        }
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() {
        let error = structured_error(&stdout, &stderr);
        let _ = fs::remove_dir_all(&probe_dir);
        return Err(error);
    }
    let envelope: Value =
        last_json_line(&stdout).ok_or_else(|| "vpcal 视频探测未返回 JSON".to_string())?;
    let data = envelope.get("data").unwrap_or(&envelope);
    let preview_data_url = fs::read(probe_dir.join("000000.png")).ok().map(|bytes| {
        format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        )
    });
    let _ = fs::remove_dir_all(probe_dir);
    Ok(VideoProbeResult {
        frames: data.get("frames").and_then(Value::as_u64).unwrap_or(0),
        mean_fps: data.get("mean_fps").and_then(Value::as_f64).unwrap_or(0.0),
        preview_data_url,
        source: data.get("source").filter(|value| !value.is_null()).cloned(),
    })
}

/// Bind the requested tracking endpoint briefly through the real vpcal decoder.
/// This validates socket binding, protocol decoding and payload contents without
/// creating a user-visible capture session.
#[tauri::command]
pub async fn probe_tracking_source(
    app: AppHandle,
    protocol: String,
    host: String,
    port: u16,
) -> Result<TrackingProbeResult, String> {
    if protocol != "freed" && protocol != "opentrackio" {
        return Err(format!("不支持的追踪协议: {protocol}"));
    }
    let exe = super::sidecars::locate_by_name("vpcal").map_err(|e| e.to_string())?;
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("无法定位 app cache 目录: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建追踪探测目录失败: {e}"))?;
    let out = dir.join(format!("tracking-probe-{}.jsonl", std::process::id()));
    let _ = fs::remove_file(&out);
    let out_for_task = out.clone();
    let output = tokio::task::spawn_blocking(move || {
        let args = vec![
            "capture".into(),
            "track".into(),
            "--protocol".into(),
            protocol,
            "--host".into(),
            host,
            "--port".into(),
            port.to_string(),
            "--duration".into(),
            "2".into(),
            "--max-packets".into(),
            "30".into(),
            "--out".into(),
            out_for_task.to_string_lossy().into_owned(),
            "--output".into(),
            "json".into(),
        ];
        super::sidecars::sidecar_command(exe).args(args).output()
    })
    .await
    .map_err(|e| format!("追踪探测任务失败: {e}"))?
    .map_err(|e| format!("启动 vpcal 追踪探测失败: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let detail = if stderr.trim().is_empty() {
            stdout.trim()
        } else {
            stderr.trim()
        };
        return Err(if detail.is_empty() {
            format!("vpcal 追踪探测失败 (exit {:?})", output.status.code())
        } else {
            detail.to_string()
        });
    }
    let lines = fs::read_to_string(&out).map_err(|e| format!("读取追踪探测结果失败: {e}"))?;
    let parsed: Vec<Value> = lines
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();
    let result = TrackingProbeResult {
        frames: parsed.len(),
        latest: parsed.last().cloned(),
    };
    let _ = fs::remove_file(out);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distinguishes_uninitialized_and_persisted_empty_state() {
        let root =
            std::env::temp_dir().join(format!("volo-capture-profiles-{}", std::process::id()));
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
        let root = std::env::temp_dir().join(format!(
            "volo-capture-profiles-replace-{}",
            std::process::id()
        ));
        let path = root.join("capture-profiles.json");
        let _ = fs::remove_dir_all(&root);
        save_to_path(&path, &[serde_json::json!({"id":"old"})]).unwrap();
        save_to_path(&path, &[serde_json::json!({"id":"new"})]).unwrap();
        assert_eq!(load_from_path(&path).unwrap().profiles[0]["id"], "new");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn reads_last_ndjson_envelope() {
        let output = "{\"type\":\"start\"}\n{\"type\":\"result\",\"data\":{\"frames\":5}}\n";
        assert_eq!(last_json_line(output).unwrap()["data"]["frames"], 5);
    }

    #[test]
    fn extracts_structured_sidecar_error() {
        let stdout = concat!(
            "{\"type\":\"start\"}\n",
            "{\"type\":\"error\",\"error\":{\"code\":\"PRECONDITION_FAILED\",",
            "\"message\":\"source missing\",\"details\":{\"reason\":\"source_not_found\"}}}\n",
        );
        let error: Value = serde_json::from_str(&structured_error(stdout, "warning")).unwrap();
        assert_eq!(error["code"], "PRECONDITION_FAILED");
        assert_eq!(error["details"]["reason"], "source_not_found");
    }
}
