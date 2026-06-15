//! Windows: 用离屏 `WebView2` 加载 HTML，调 `PrintToPdf` 直出 PDF。
//!
//! 跟 macOS 路径一致的思路：HTML 走平台原生 webview，避免维护两套渲染。
//! 实现细节：
//!   - WebView2 需要 STA + Win32 message pump，所以我们 spawn 一个独立 OS
//!     thread 专门跑这套（不会污染 Tauri 自己的主线程）。
//!   - 所有 WebView2 异步 API 通过 callback 链链接起来：env → controller →
//!     navigate → NavigationCompleted → PrintToPdf → completion handler。
//!   - PrintToPdf 直接写到目标路径（跟 macOS 的"先拿字节再写盘"不同）；
//!     上层 `run_save_pdf` 仍然走 tmp → rename 的 atomic 写。
//!
//! 此模块只在 `cfg(target_os = "windows")` 下编译；在 macOS dev 环境下不参与
//! check。**未在 Windows 上实地运行过**，等首次部署到 Windows 时由 codex
//! 或人工 review 跟进。

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use webview2_com::{
    CreateCoreWebView2ControllerCompletedHandler,
    CreateCoreWebView2EnvironmentCompletedHandler, Microsoft::Web::WebView2::Win32::*,
    NavigationCompletedEventHandler, PrintToPdfCompletedHandler,
};
use windows::core::{Interface, BOOL, HSTRING, PCWSTR, PWSTR};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, PostQuitMessage,
    RegisterClassW, TranslateMessage, CW_USEDEFAULT, HWND_MESSAGE, MSG, WINDOW_EX_STYLE,
    WNDCLASSW, WS_OVERLAPPEDWINDOW,
};

use volo_shared::error::{VoloError, VoloResult};

const TIMEOUT: Duration = Duration::from_secs(30);

pub fn render(app: &tauri::AppHandle, html: &str, dst: &Path) -> VoloResult<()> {
    use tauri::Manager;

    // Resolve a writable user-data folder for WebView2. Default (null) puts it
    // next to the .exe, which is read-only when the app is installed under
    // Program Files — environment creation would fail.
    let user_data: PathBuf = app
        .path()
        .app_data_dir()
        .map_err(|e| VoloError::Other(format!("resolve app_data_dir: {e}")))?
        .join("webview2-pdf");
    std::fs::create_dir_all(&user_data)
        .map_err(|e| VoloError::Other(format!("create WebView2 user data dir: {e}")))?;

    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    let html_owned = html.to_string();
    let dst_owned: PathBuf = dst.to_path_buf();

    // WebView2 needs STA + a Win32 message pump. We give it a dedicated
    // OS thread so the pump can spin freely without affecting Tauri.
    thread::Builder::new()
        .name("volo-pdf-webview2".into())
        .spawn(move || {
            let result = run_on_sta_thread(&html_owned, &dst_owned, &user_data);
            let _ = tx.send(result);
        })
        .map_err(|e| VoloError::Other(format!("spawn webview2 thread: {e}")))?;

    let outcome = rx
        .recv_timeout(TIMEOUT)
        .map_err(|_| VoloError::Other(format!("PDF render timed out after {TIMEOUT:?}")))?;

    outcome.map_err(VoloError::Other)
}

fn run_on_sta_thread(html: &str, dst: &Path, user_data: &Path) -> Result<(), String> {
    // 1. COM init for this thread.
    unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
        .ok()
        .map_err(|e| format!("CoInitializeEx: {e}"))?;
    struct ComGuard;
    impl Drop for ComGuard {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }
    let _com_guard = ComGuard;

    // 2. A hidden message-only window to host the WebView2 controller.
    //    WebView2 requires a parent HWND even if we never show it.
    let hwnd = create_hidden_hwnd()?;

    // 3. The result channel is shared with all async callbacks so any
    //    failure along the chain surfaces to the outer thread.
    let (result_tx, result_rx) = mpsc::channel::<Result<(), String>>();
    let result_tx_for_env = result_tx.clone();

    // We need to keep the controller alive until PrintToPdf completes.
    // It lives in this slot, captured by every callback layer.
    let controller_slot: Arc<Mutex<Option<ICoreWebView2Controller>>> = Arc::new(Mutex::new(None));

    let html_for_env = html.to_string();
    let dst_for_env = dst.to_path_buf();
    let controller_slot_for_env = controller_slot.clone();

    // 4. env → controller → navigate → print, all wired up via callbacks.
    let env_handler = CreateCoreWebView2EnvironmentCompletedHandler::create(Box::new(
        move |code, env| {
            if let Err(e) = code.ok() {
                let _ = result_tx_for_env.send(Err(format!("env init failed: {e}")));
                signal_quit();
                return Ok(());
            }
            let env = match env {
                Some(e) => e,
                None => {
                    let _ = result_tx_for_env.send(Err("env handler: no environment".into()));
                    signal_quit();
                    return Ok(());
                }
            };

            let html_for_ctrl = html_for_env.clone();
            let dst_for_ctrl = dst_for_env.clone();
            let result_tx_for_ctrl = result_tx_for_env.clone();
            let controller_slot_for_ctrl = controller_slot_for_env.clone();

            let ctrl_handler = CreateCoreWebView2ControllerCompletedHandler::create(Box::new(
                move |code, controller| {
                    if let Err(e) = code.ok() {
                        let _ = result_tx_for_ctrl
                            .send(Err(format!("controller init failed: {e}")));
                        signal_quit();
                        return Ok(());
                    }
                    let controller = match controller {
                        Some(c) => c,
                        None => {
                            let _ = result_tx_for_ctrl
                                .send(Err("controller handler: no controller".into()));
                            signal_quit();
                            return Ok(());
                        }
                    };

                    // Sized webview — viewport for the page layout. PrintToPdf
                    // uses its own page-size config, not this rect, so this is
                    // really only setting the CSS viewport width.
                    let bounds = RECT {
                        left: 0,
                        top: 0,
                        right: 816,
                        bottom: 1056,
                    };
                    let _ = unsafe { controller.SetBounds(bounds) };

                    let webview = match unsafe { controller.CoreWebView2() } {
                        Ok(w) => w,
                        Err(e) => {
                            let _ = result_tx_for_ctrl.send(Err(format!("CoreWebView2: {e}")));
                            signal_quit();
                            return Ok(());
                        }
                    };

                    // Park the controller in the shared slot — keeps it alive
                    // for the lifetime of the print operation.
                    if let Ok(mut slot) = controller_slot_for_ctrl.lock() {
                        *slot = Some(controller);
                    }

                    let dst_for_nav = dst_for_ctrl.clone();
                    let result_tx_for_nav = result_tx_for_ctrl.clone();
                    let nav_handler = NavigationCompletedEventHandler::create(Box::new(
                        move |sender, _args| {
                            let webview = match sender {
                                Some(w) => w,
                                None => {
                                    let _ = result_tx_for_nav
                                        .send(Err("navigation event: no sender".into()));
                                    signal_quit();
                                    return Ok(());
                                }
                            };

                            // PrintToPdf lives on ICoreWebView2_7 (Edge 87+).
                            // Cast and call.
                            let webview_7: ICoreWebView2_7 = match webview.cast() {
                                Ok(w) => w,
                                Err(e) => {
                                    let _ = result_tx_for_nav.send(Err(format!(
                                        "WebView2 runtime too old, missing ICoreWebView2_7: {e}"
                                    )));
                                    signal_quit();
                                    return Ok(());
                                }
                            };

                            let dst_wide: HSTRING = HSTRING::from(dst_for_nav.as_os_str());
                            let result_tx_for_pdf = result_tx_for_nav.clone();
                            let pdf_handler =
                                PrintToPdfCompletedHandler::create(Box::new(move |code, ok| {
                                    let outcome = match code.ok() {
                                        Err(e) => Err(format!("PrintToPdf error: {e}")),
                                        Ok(()) if ok.as_bool() => Ok(()),
                                        Ok(()) => Err("PrintToPdf returned success=FALSE".into()),
                                    };
                                    let _ = result_tx_for_pdf.send(outcome);
                                    signal_quit();
                                    Ok(())
                                }));

                            if let Err(e) = unsafe {
                                webview_7.PrintToPdf(
                                    PCWSTR(dst_wide.as_ptr()),
                                    None,
                                    &pdf_handler,
                                )
                            } {
                                let _ = result_tx_for_nav.send(Err(format!("PrintToPdf call: {e}")));
                                signal_quit();
                            }
                            Ok(())
                        },
                    ));

                    let mut nav_token = Default::default();
                    if let Err(e) =
                        unsafe { webview.add_NavigationCompleted(&nav_handler, &mut nav_token) }
                    {
                        let _ = result_tx_for_ctrl.send(Err(format!("add_NavigationCompleted: {e}")));
                        signal_quit();
                        return Ok(());
                    }

                    let html_wide: HSTRING = HSTRING::from(html_for_ctrl.as_str());
                    if let Err(e) =
                        unsafe { webview.NavigateToString(PCWSTR(html_wide.as_ptr())) }
                    {
                        let _ = result_tx_for_ctrl.send(Err(format!("NavigateToString: {e}")));
                        signal_quit();
                    }
                    Ok(())
                },
            ));

            if let Err(e) = unsafe {
                env.CreateCoreWebView2Controller(hwnd, &ctrl_handler)
            } {
                let _ = result_tx_for_env.send(Err(format!("CreateCoreWebView2Controller: {e}")));
                signal_quit();
            }
            Ok(())
        },
    ));

    let user_data_wide: HSTRING = HSTRING::from(user_data.as_os_str());
    unsafe {
        CreateCoreWebView2EnvironmentWithOptions(
            PCWSTR::null(),
            PCWSTR(user_data_wide.as_ptr()),
            None,
            &env_handler,
        )
    }
    .map_err(|e| {
        format!(
            "CreateCoreWebView2EnvironmentWithOptions: {e} — \
             WebView2 Runtime may be missing; install from Microsoft Edge installer"
        )
    })?;

    // 5. Pump messages until any handler calls signal_quit().
    pump_message_loop();

    // 6. Collect the final outcome.
    drop(controller_slot); // OK to release now
    result_rx
        .recv_timeout(Duration::from_secs(1))
        .map_err(|_| "no result from WebView2 chain".to_string())?
}

fn signal_quit() {
    unsafe { PostQuitMessage(0) };
}

fn pump_message_loop() {
    let mut msg: MSG = unsafe { std::mem::zeroed() };
    while unsafe { GetMessageW(&mut msg, None, 0, 0) }.as_bool() {
        unsafe {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

/// Register a stub window class once per thread and create a hidden
/// message-only window — that's our HWND parent for the WebView2 controller.
fn create_hidden_hwnd() -> Result<HWND, String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    let class_name: Vec<u16> = OsStr::new("LmtPdfHostWindow\0").encode_wide().collect();

    let hinstance = unsafe { GetModuleHandleW(None) }
        .map_err(|e| format!("GetModuleHandleW: {e}"))?
        .into();

    let wc = WNDCLASSW {
        lpfnWndProc: Some(stub_wnd_proc),
        hInstance: hinstance,
        lpszClassName: PCWSTR(class_name.as_ptr()),
        ..Default::default()
    };
    // RegisterClassW returns 0 on failure; ERROR_CLASS_ALREADY_EXISTS is OK
    // for repeated calls on the same thread.
    let _atom = unsafe { RegisterClassW(&wc) };

    let hwnd = unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            PCWSTR(class_name.as_ptr()),
            PCWSTR::null(),
            WS_OVERLAPPEDWINDOW,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            816,
            1056,
            Some(HWND_MESSAGE),
            None,
            Some(hinstance),
            None,
        )
    }
    .map_err(|e| format!("CreateWindowExW: {e}"))?;

    if hwnd.0.is_null() {
        return Err("CreateWindowExW returned null HWND".into());
    }
    Ok(hwnd)
}

extern "system" fn stub_wnd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}
