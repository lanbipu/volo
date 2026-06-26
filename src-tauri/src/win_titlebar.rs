//! Windows 自绘标题栏的命中测试（Win11 Snap Layouts）。
//!
//! `decorations:false` 后窗口没有原生 caption，系统就不会在最大化按钮上
//! 弹出 Snap Layouts。但 wry 默认开了 WebView2 的
//! `IsNonClientRegionSupportEnabled`，于是 webview 内标了 `app-region: drag`
//! 的元素，其鼠标命中会作为「非客户区」转发给**宿主窗口过程**（也就是这里
//! 子类化的窗口）。
//!
//! 前端只把最大化按钮（`.winctl button.wc-max`）标成 `app-region: drag`，
//! 这里就把它的矩形报成 `HTMAXBUTTON` —— 系统随即在它上面 hover 弹出
//! Snap Layouts，点击时由我们执行最大化/还原。拖动（data-tauri-drag-region）、
//! 最小化/关闭（前端 onClick）都不经过这里，保持原样。
//!
//! 布局常量必须与前端 CSS 同步（`.win-topbar` 高度 / `.winctl button` 宽度）。
//! winctl 按钮自左到右为 min · max · close（close 贴最右）。常量是 CSS 逻辑
//! 像素，命中测试时按窗口 DPI 缩放成物理像素。

use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::ScreenToClient;
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{
    GetClientRect, IsZoomed, SendMessageW, HTMAXBUTTON, SC_MAXIMIZE, SC_RESTORE, WM_NCHITTEST,
    WM_NCLBUTTONDBLCLK, WM_NCLBUTTONDOWN, WM_NCLBUTTONUP, WM_SYSCOMMAND,
};

/// 标题栏高度（CSS 逻辑像素），须 = `.win.is-win` grid 首行轨（app.css 38px）。
const TITLEBAR_H: f32 = 38.0;
/// `.winctl button` 的宽度（CSS 逻辑像素）。
const BTN_W: f32 = 46.0;
/// 子类化 id（任意常量，'VOLO'）。
const SUBCLASS_ID: usize = 0x564F_4C4F;

/// 给主窗口装上自绘标题栏的命中测试。`hwnd` 取自 `WebviewWindow::hwnd().0`
/// 转成的 isize（与 tauri 的 windows crate 版本解耦）。
pub fn attach(hwnd: isize) {
    let hwnd = HWND(hwnd as *mut core::ffi::c_void);
    // SAFETY: hwnd 来自 tauri 主窗口、在主线程 setup 阶段调用，proc 是 'static fn。
    unsafe {
        if !SetWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID, 0).as_bool() {
            tracing::warn!("SetWindowSubclass failed; Snap Layouts hit-test inactive");
        }
    }
}

/// 最大化按钮矩形（物理客户区像素）：水平 [cw-2W·s, cw-W·s)，垂直 [0, H·s)。
/// `s` = DPI 缩放，`cw` = 客户区宽度。screen_x/y 为屏幕坐标（来自 NCHITTEST）。
unsafe fn hit_maxbutton(hwnd: HWND, screen_x: i32, screen_y: i32) -> bool {
    let mut rc = RECT::default();
    if GetClientRect(hwnd, &mut rc).is_err() {
        return false;
    }
    let mut pt = POINT {
        x: screen_x,
        y: screen_y,
    };
    let _ = ScreenToClient(hwnd, &mut pt);
    let s = GetDpiForWindow(hwnd) as f32 / 96.0;
    let cw = rc.right as f32;
    let (x, y) = (pt.x as f32, pt.y as f32);
    x >= cw - 2.0 * BTN_W * s && x < cw - BTN_W * s && y >= 0.0 && y < TITLEBAR_H * s
}

unsafe extern "system" fn subclass_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    _data: usize,
) -> LRESULT {
    match msg {
        WM_NCHITTEST => {
            // lParam 低 16 位 = x、高 16 位 = y（带符号，屏幕坐标）。
            let x = (lparam.0 & 0xFFFF) as i16 as i32;
            let y = ((lparam.0 >> 16) & 0xFFFF) as i16 as i32;
            if hit_maxbutton(hwnd, x, y) {
                return LRESULT(HTMAXBUTTON as isize);
            }
            DefSubclassProc(hwnd, msg, wparam, lparam)
        }
        // 非真 caption 窗口，HTMAXBUTTON 的点击不会被 DefWindowProc 自动执行，
        // 这里自己 toggle 最大化/还原。在「按下」即 toggle（而非松开）：双击时
        // 第二次按下走的是 DBLCLK 而非 DOWN，故单击/双击都净 toggle 一次（双击=
        // 最大化，不会被第二次 toggle 还原）；UP/DBLCLK 一并吞掉，杜绝
        // DefSubclassProc 再补发一次 SC_MAXIMIZE。
        WM_NCLBUTTONDOWN if wparam.0 == HTMAXBUTTON as usize => {
            let cmd = if IsZoomed(hwnd).as_bool() {
                SC_RESTORE
            } else {
                SC_MAXIMIZE
            };
            SendMessageW(hwnd, WM_SYSCOMMAND, Some(WPARAM(cmd as usize)), Some(LPARAM(0)));
            LRESULT(0)
        }
        WM_NCLBUTTONUP | WM_NCLBUTTONDBLCLK if wparam.0 == HTMAXBUTTON as usize => LRESULT(0),
        _ => DefSubclassProc(hwnd, msg, wparam, lparam),
    }
}
