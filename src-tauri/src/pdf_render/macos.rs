//! macOS: 用离屏 `WKWebView` 加载 HTML，调原生 `createPDF` 直出 PDF。
//!
//! 关键约束：`WKWebView` 的所有 API 都必须在主线程上访问，且加载是异步的。
//! 我们的流程：
//!   1. 调用线程通过 channel 阻塞等待结果（worst-case 30s 超时）。
//!   2. 把整个渲染过程 dispatch 到主线程，在主线程上 *递归 spin* runloop
//!      等到 `isLoading == false`，再调 `createPDF`，再 spin 等 completion
//!      block 触发。这种 spin 模式是 Cocoa 里同步等异步事件的惯用招。

use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{msg_send, MainThreadMarker, MainThreadOnly};
use objc2_core_foundation::CGRect;
use objc2_foundation::{NSData, NSDate, NSDefaultRunLoopMode, NSError, NSNumber, NSRunLoop, NSString};
use objc2_web_kit::{WKPDFConfiguration, WKWebView, WKWebViewConfiguration};

use volo_shared::error::{LmtError, LmtResult};

/// Letter portrait @ 96 dpi viewport width. CSS 里 `max-width: 900px` 的页面
/// 落在这个宽度内。高度用初始值，加载完后会按 `document.documentElement.scrollHeight`
/// resize，让 `createPDF` 能捕获完整内容（默认 rect 只取 visible bounds）。
const FRAME_WIDTH: f64 = 816.0;
const INITIAL_FRAME_HEIGHT: f64 = 1056.0;

/// Hard upper bound on the resized webview height. Defends against a runaway
/// JS measurement returning something absurd; A4 portrait full-page table at
/// 50 rows is ~3000 px, so 32 768 is generous.
const MAX_FRAME_HEIGHT: f64 = 32_768.0;

/// 给加载和渲染留的最大时间。30s 对 A4 一页绰绰有余，足以覆盖偶发的
/// Webview 启动慢；超时则视为出错而不是无限阻塞 UI 线程。
const TIMEOUT: Duration = Duration::from_secs(30);

/// 主线程 spin runloop 每次让出的时长。50ms 让出粒度对人眼无感，又能避免
/// 100% 占用 CPU。
const SPIN_TICK: Duration = Duration::from_millis(50);

pub fn render(app: &tauri::AppHandle, html: &str, dst: &Path) -> LmtResult<()> {
    let (tx, rx) = mpsc::channel::<Result<Vec<u8>, String>>();
    let html_owned = html.to_string();

    app.run_on_main_thread(move || {
        let result = unsafe { render_on_main_thread(&html_owned) };
        let _ = tx.send(result);
    })
    .map_err(|e| LmtError::Other(format!("dispatch to main thread: {e}")))?;

    let pdf_bytes = rx
        .recv_timeout(TIMEOUT)
        .map_err(|_| LmtError::Other(format!("PDF render timed out after {TIMEOUT:?}")))?
        .map_err(LmtError::Other)?;

    write_pdf(dst, &pdf_bytes)
}

/// Atomic enough for our caller: we write to `dst` directly. The outer
/// `run_save_pdf` already handles tmp-then-rename — this fn is the leaf
/// that just dumps the bytes.
fn write_pdf(dst: &Path, bytes: &[u8]) -> LmtResult<()> {
    if !bytes.starts_with(b"%PDF-") {
        return Err(LmtError::Other(
            "renderer returned non-PDF bytes (likely empty)".into(),
        ));
    }
    std::fs::write(dst, bytes)
        .map_err(|e| LmtError::Other(format!("write PDF to {}: {e}", dst.display())))?;
    Ok(())
}

/// SAFETY: caller must be on the AppKit main thread. We assert via
/// `MainThreadMarker::new()`.
unsafe fn render_on_main_thread(html: &str) -> Result<Vec<u8>, String> {
    let mtm = MainThreadMarker::new()
        .ok_or_else(|| "render_on_main_thread called off the main thread".to_string())?;

    // 1. Build webview with an initial frame. We'll resize once the document
    //    height is known so the PDF capture rect (default = visible bounds)
    //    spans the whole scrollable content.
    let frame = CGRect::new(
        objc2_core_foundation::CGPoint::new(0.0, 0.0),
        objc2_core_foundation::CGSize::new(FRAME_WIDTH, INITIAL_FRAME_HEIGHT),
    );
    let config = WKWebViewConfiguration::new(mtm);
    let webview: Retained<WKWebView> = unsafe {
        WKWebView::initWithFrame_configuration(WKWebView::alloc(mtm), frame, &config)
    };

    // 2. Kick off loadHTMLString. Returns immediately; the actual render
    //    happens on the WebProcess and surfaces on the main runloop.
    let html_ns = NSString::from_str(html);
    let _nav = unsafe { webview.loadHTMLString_baseURL(&html_ns, None) };

    // 3. Spin the main runloop until isLoading flips false.
    spin_until(TIMEOUT, || !unsafe { webview.isLoading() })
        .map_err(|_| "page never finished loading".to_string())?;

    // 4. Give the layout engine a few ticks to flush so JS measurements pick
    //    up the post-layout heights instead of an intermediate value.
    spin_for(Duration::from_millis(150));

    // 5. Measure scrollHeight and resize the webview to fit the entire page.
    //    Without this, createPDF only captures the visible 816x1056 viewport.
    let measured_height = measure_scroll_height(&webview)?;
    if measured_height > MAX_FRAME_HEIGHT {
        // Loud fail: silently clamping would drop rows below MAX_FRAME_HEIGHT
        // from the bottom of the PDF without any UI hint. Better to surface
        // the limit so the caller knows to split the export or request
        // a paginated path.
        return Err(format!(
            "instruction card is too tall to render to PDF in one pass \
             (measured {measured_height:.0}px, cap {MAX_FRAME_HEIGHT}px). \
             This usually means the LED screen has too many vertices for \
             a single PDF page; split the export or contact the maintainer \
             to add a paginated path."
        ));
    }
    let target_height = measured_height.max(INITIAL_FRAME_HEIGHT);
    let new_frame = CGRect::new(
        objc2_core_foundation::CGPoint::new(0.0, 0.0),
        objc2_core_foundation::CGSize::new(FRAME_WIDTH, target_height),
    );
    unsafe {
        let _: () = msg_send![&*webview, setFrame: new_frame];
    }
    // Flush layout again after the frame change.
    spin_for(Duration::from_millis(150));

    // 6. Call createPDF. completion handler signals via channel.
    let (pdf_tx, pdf_rx) = mpsc::channel::<Result<Vec<u8>, String>>();
    let pdf_config = unsafe { WKPDFConfiguration::new(mtm) };

    let tx_for_block = pdf_tx;
    let block = RcBlock::new(move |data: *mut NSData, err: *mut NSError| {
        let outcome = if data.is_null() {
            let msg = if err.is_null() {
                "createPDF returned no data and no error".to_string()
            } else {
                let err_obj: &NSError = unsafe { &*err };
                format!("createPDF failed: {}", err_obj.localizedDescription())
            };
            Err(msg)
        } else {
            let data_obj: &NSData = unsafe { &*data };
            Ok(data_obj.to_vec())
        };
        let _ = tx_for_block.send(outcome);
    });

    unsafe {
        webview.createPDFWithConfiguration_completionHandler(Some(&pdf_config), &block);
    }

    // 6. Spin runloop until completion handler fires.
    let mut result: Option<Result<Vec<u8>, String>> = None;
    spin_until(TIMEOUT, || match pdf_rx.try_recv() {
        Ok(r) => {
            result = Some(r);
            true
        }
        Err(mpsc::TryRecvError::Empty) => false,
        Err(mpsc::TryRecvError::Disconnected) => {
            result = Some(Err("PDF block channel disconnected".into()));
            true
        }
    })
    .map_err(|_| "createPDF completion never fired".to_string())?;

    // Keep webview retained until here so the WebProcess isn't torn down
    // mid-render. The `Retained<_>` drop happens at function end.
    drop(webview);

    result.unwrap_or_else(|| Err("internal: result missing".into()))
}

/// Evaluate JS that returns a number; spin the runloop until the completion
/// handler fires. Used to read `document.documentElement.scrollHeight` so we
/// can resize the webview before snapshotting.
///
/// SAFETY: caller must be on the main thread.
unsafe fn measure_scroll_height(webview: &WKWebView) -> Result<f64, String> {
    let (tx, rx) = mpsc::channel::<Result<f64, String>>();
    let tx_block = tx;

    let block = RcBlock::new(move |result: *mut AnyObject, err: *mut NSError| {
        let outcome = if !err.is_null() {
            let e: &NSError = unsafe { &*err };
            Err(format!("measure scrollHeight failed: {}", e.localizedDescription()))
        } else if result.is_null() {
            Err("measure scrollHeight: JS returned null".into())
        } else {
            // result should be an NSNumber for a numeric expression. We trust
            // the call site (a literal scrollHeight read) to never produce a
            // non-NSNumber value, but we still avoid panicking on a bad cast.
            let val: f64 = unsafe {
                let num: *const NSNumber = result.cast();
                (*num).doubleValue()
            };
            Ok(val)
        };
        let _ = tx_block.send(outcome);
    });

    let script = NSString::from_str(
        "Math.max(\
            document.documentElement.scrollHeight, \
            document.body ? document.body.scrollHeight : 0, \
            document.documentElement.offsetHeight\
        )",
    );
    unsafe {
        webview.evaluateJavaScript_completionHandler(&script, Some(&block));
    }

    let mut result: Option<Result<f64, String>> = None;
    spin_until(TIMEOUT, || match rx.try_recv() {
        Ok(r) => {
            result = Some(r);
            true
        }
        Err(mpsc::TryRecvError::Empty) => false,
        Err(mpsc::TryRecvError::Disconnected) => {
            result = Some(Err("scrollHeight channel disconnected".into()));
            true
        }
    })
    .map_err(|_| "scrollHeight evaluation never returned".to_string())?;

    result.unwrap_or_else(|| Err("internal: scrollHeight missing".into()))
}

/// Spin the current runloop until `cond()` returns true or `timeout` elapses.
/// Returns Ok(()) on cond, Err(()) on timeout.
fn spin_until(timeout: Duration, mut cond: impl FnMut() -> bool) -> Result<(), ()> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if cond() {
            return Ok(());
        }
        if std::time::Instant::now() >= deadline {
            return Err(());
        }
        run_one_tick();
    }
}

/// Spin the runloop for at least `dur`, ignoring any cond.
fn spin_for(dur: Duration) {
    let deadline = std::time::Instant::now() + dur;
    while std::time::Instant::now() < deadline {
        run_one_tick();
    }
}

fn run_one_tick() {
    unsafe {
        let rl = NSRunLoop::currentRunLoop();
        let deadline = NSDate::dateWithTimeIntervalSinceNow(SPIN_TICK.as_secs_f64());
        let mode: &NSString = NSDefaultRunLoopMode;
        // `runMode:beforeDate:` returns BOOL — declare the correct return type
        // so the objc2 FFI contract matches the Objective-C selector signature,
        // even though we discard the value.
        let _ran: bool = msg_send![&*rl, runMode: mode, beforeDate: &*deadline];
    }
}

