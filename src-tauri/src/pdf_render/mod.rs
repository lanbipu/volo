//! Render HTML to PDF using the platform's native webview engine.
//!
//! 把 `instruction_card::html::generate_html` 的输出直接喂给原生 webview
//! （macOS WKWebView / Windows WebView2），让浏览器自己产出 PDF。预览和
//! 导出共享同一份 HTML，从根本上消除两套渲染管线之间的 drift。

use std::path::Path;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
use volo_shared::error::VoloError;
use volo_shared::error::VoloResult;

#[cfg(target_os = "macos")]
mod macos;

#[cfg(target_os = "windows")]
mod windows;

/// 离屏渲染 HTML 字符串为 PDF 写到 `dst`。
///
/// 必须从 Tauri 主线程之外调用（Tauri command 默认环境）：内部会把对原生
/// webview 的调用 dispatch 到主线程并阻塞等待结果。
///
/// 失败时不写盘——调用方负责 atomic rename。
pub fn render_html_to_pdf(app: &tauri::AppHandle, html: &str, dst: &Path) -> VoloResult<()> {
    #[cfg(target_os = "macos")]
    {
        return macos::render(app, html, dst);
    }

    #[cfg(target_os = "windows")]
    {
        return windows::render(app, html, dst);
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (app, html, dst);
        Err(VoloError::Other(
            "PDF export on Linux is not supported in this build \
             (macOS and Windows only)"
                .into(),
        ))
    }
}
