//! Pattern player window (live-capture plan Phase 3a — C1.3 playback host).
//!
//! A second frameless webview window ("pattern-player") is placed borderless
//! at a chosen monitor's origin/size (the output feeding the LED processor)
//! and driven via Tauri events:
//!
//!   `player://show`  { image_b64, mime, width, height, pattern, frame_index }
//!   `player://clear` {}
//!
//! Pattern images are read here (Rust) and shipped as a base64 data payload so
//! the player webview needs no asset-protocol scope over arbitrary paths.
//! `player_show_pattern` also performs the 1:1 pixel self-check from the plan
//! (window physical size vs pattern resolution — the full processor-canvas
//! validation is C0 scope, not here): a mismatch is *reported*, not blocking.
//!
//! Borderless-at-monitor-bounds is used instead of OS fullscreen: macOS
//! fullscreen spawns a separate Space with animations, which is exactly what
//! an LED output feed must not do.
//!
//! Multi-monitor / Windows assumptions
//! -----------------------------------
//! - Placement uses **physical** pixels (`PhysicalPosition` / `PhysicalSize`)
//!   so mixed-DPI desks (ASUS primary + LG G3 TV secondary) land on the
//!   intended output. Logical-coordinate builder APIs are avoided for the move.
//! - The player is created **hidden**, positioned, then shown — creating a
//!   visible window on the primary and then moving it is unreliable on
//!   Windows WebView2 (often sticks on the operator primary / ASUS).
//! - Windows: a short re-assert after first paint covers the HWND-init race
//!   where the first `SetWindowPos` is ignored.
//! - Requires Windows display mode **Extend** (not Duplicate). Duplicate
//!   collapses `available_monitors()` to one entry, so the TV cannot be
//!   targeted separately.

use std::io::Read;
use std::path::Path;

use base64::Engine as _;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use volo_shared::error::{VoloError, VoloResult};

pub const PLAYER_LABEL: &str = "pattern-player";

#[derive(Debug, Clone, Serialize)]
pub struct MonitorInfo {
    pub index: usize,
    pub name: Option<String>,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale_factor: f64,
    pub is_primary: bool,
}

/// Enumerate monitors for the player-output picker.
#[tauri::command]
pub fn list_monitors(app: AppHandle) -> VoloResult<Vec<MonitorInfo>> {
    let primary = app
        .primary_monitor()
        .map_err(|e| VoloError::Io(format!("primary_monitor: {e}")))?;
    let monitors = app
        .available_monitors()
        .map_err(|e| VoloError::Io(format!("available_monitors: {e}")))?;
    Ok(monitors
        .iter()
        .enumerate()
        .map(|(index, m)| MonitorInfo {
            index,
            name: m.name().cloned(),
            x: m.position().x,
            y: m.position().y,
            width: m.size().width,
            height: m.size().height,
            scale_factor: m.scale_factor(),
            is_primary: primary
                .as_ref()
                .map(|p| p.position() == m.position() && p.size() == m.size())
                .unwrap_or(false),
        })
        .collect())
}

#[derive(Debug, Clone, Serialize)]
pub struct PlayerWindowInfo {
    pub label: String,
    pub monitor_index: usize,
    /// Physical pixel size of the player window (what the LED path sees).
    pub width: u32,
    pub height: u32,
    pub scale_factor: f64,
}

fn place_player_on_monitor(
    window: &WebviewWindow,
    pos: tauri::PhysicalPosition<i32>,
    size: tauri::PhysicalSize<u32>,
) -> VoloResult<()> {
    window
        .set_position(pos)
        .and_then(|_| window.set_size(size))
        .map_err(|e| VoloError::Io(format!("place player window: {e}")))
}

/// Open (or move) the borderless player window on the given monitor.
#[tauri::command]
pub async fn open_pattern_player(app: AppHandle, monitor_index: usize) -> VoloResult<PlayerWindowInfo> {
    let monitors = app
        .available_monitors()
        .map_err(|e| VoloError::Io(format!("available_monitors: {e}")))?;
    let monitor = monitors.get(monitor_index).ok_or_else(|| {
        VoloError::InvalidInput(format!(
            "monitor index {monitor_index} out of range ({} available)",
            monitors.len()
        ))
    })?;
    let pos = *monitor.position();
    let size = *monitor.size();
    let scale = monitor.scale_factor();

    let window = match app.get_webview_window(PLAYER_LABEL) {
        Some(w) => w,
        None => {
            // Create hidden on purpose: a visible-first create lands on the
            // primary monitor; moving afterwards is flaky on Windows WebView2.
            WebviewWindowBuilder::new(
                &app,
                PLAYER_LABEL,
                WebviewUrl::App("index.html#/pattern-player".into()),
            )
            .title("Volo Pattern Player")
            .decorations(false)
            .resizable(false)
            .visible(false)
            .build()
            .map_err(|e| VoloError::Io(format!("create player window: {e}")))?
        }
    };

    // Hide existing windows too. Retargeting a visible WebView2 window can leave
    // it stuck on the old monitor even when SetWindowPos reports success.
    window
        .hide()
        .map_err(|e| VoloError::Io(format!("hide player window before placement: {e}")))?;
    place_player_on_monitor(&window, pos, size)?;

    // Windows WebView2: first SetWindowPos can be ignored while the HWND is
    // still initializing; re-assert after a short yield, then show.
    #[cfg(target_os = "windows")]
    {
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        place_player_on_monitor(&window, pos, size)?;
    }

    window
        .show()
        .map_err(|e| VoloError::Io(format!("show player window: {e}")))?;
    let _ = window.set_focus();

    #[cfg(target_os = "windows")]
    {
        // Second re-assert after show — covers DPI/per-monitor awareness races
        // when the TV (e.g. LG G3) is a large secondary at non-zero origin.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        place_player_on_monitor(&window, pos, size)?;
    }

    Ok(PlayerWindowInfo {
        label: PLAYER_LABEL.into(),
        monitor_index,
        width: size.width,
        height: size.height,
        scale_factor: scale,
    })
}

/// Close the player window if it exists. Returns whether one was open.
#[tauri::command]
pub fn close_pattern_player(app: AppHandle) -> VoloResult<bool> {
    match app.get_webview_window(PLAYER_LABEL) {
        Some(w) => {
            w.close()
                .map_err(|e| VoloError::Io(format!("close player window: {e}")))?;
            Ok(true)
        }
        None => Ok(false),
    }
}

/// Parse PNG IHDR dimensions (bytes 16..24, big-endian) without an image crate.
fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    const PNG_MAGIC: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    if bytes.len() < 24 || bytes[..8] != PNG_MAGIC || &bytes[12..16] != b"IHDR" {
        return None;
    }
    let w = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
    let h = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
    Some((w, h))
}

#[derive(Debug, Clone, Serialize)]
pub struct ShowPatternResult {
    pub pattern_width: u32,
    pub pattern_height: u32,
    pub window_width: u32,
    pub window_height: u32,
    /// True when window physical size ≠ pattern resolution — the C0 1:1 pixel
    /// mapping precondition is not met on this output (warn, don't block).
    pub resolution_mismatch: bool,
}

/// Load a pattern PNG and display it in the player window (event-driven).
///
/// `pattern` is a free-form tag echoed to the player and back to the capture
/// side ("normal" | "inverted" | …); `frame_index` matches the Gray-code tag
/// embedded by `vpcal pattern generate --graycode-tags` when used.
#[tauri::command]
pub fn player_show_pattern(
    app: AppHandle,
    image_path: String,
    pattern: String,
    frame_index: Option<u32>,
) -> VoloResult<ShowPatternResult> {
    let path = Path::new(&image_path);
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .and_then(|mut f| f.read_to_end(&mut bytes))
        .map_err(|e| VoloError::NotFound(format!("pattern image {image_path}: {e}")))?;
    let (pw, ph) = png_dimensions(&bytes).ok_or_else(|| {
        VoloError::InvalidInput(format!("{image_path} is not a PNG (player expects vpcal pattern PNGs)"))
    })?;

    let window = app.get_webview_window(PLAYER_LABEL).ok_or_else(|| {
        VoloError::NotFound("pattern player window is not open (call open_pattern_player first)".into())
    })?;
    let win_size = window
        .inner_size()
        .map_err(|e| VoloError::Io(format!("player window size: {e}")))?;

    let payload = serde_json::json!({
        "image_b64": base64::engine::general_purpose::STANDARD.encode(&bytes),
        "mime": "image/png",
        "width": pw,
        "height": ph,
        "pattern": pattern,
        "frame_index": frame_index,
    });
    app.emit_to(PLAYER_LABEL, "player://show", payload)
        .map_err(|e| VoloError::Io(format!("emit player://show: {e}")))?;

    Ok(ShowPatternResult {
        pattern_width: pw,
        pattern_height: ph,
        window_width: win_size.width,
        window_height: win_size.height,
        resolution_mismatch: pw != win_size.width || ph != win_size.height,
    })
}

/// Blank the player output (black frame).
#[tauri::command]
pub fn player_clear(app: AppHandle) -> VoloResult<()> {
    if let Some(_w) = app.get_webview_window(PLAYER_LABEL) {
        app.emit_to(PLAYER_LABEL, "player://clear", serde_json::json!({}))
            .map_err(|e| VoloError::Io(format!("emit player://clear: {e}")))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_dimensions_parses_ihdr() {
        // Minimal PNG header: magic + IHDR length/type + 64×32.
        let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        bytes.extend_from_slice(&13u32.to_be_bytes());
        bytes.extend_from_slice(b"IHDR");
        bytes.extend_from_slice(&64u32.to_be_bytes());
        bytes.extend_from_slice(&32u32.to_be_bytes());
        assert_eq!(png_dimensions(&bytes), Some((64, 32)));
        assert_eq!(png_dimensions(b"JPEGnope"), None);
    }
}
