//! W3.1: generic long-running sidecar streaming bridge.
//!
//! Unlike `sidecars::spawn_sidecar` (argv in, one JSON envelope out) and
//! `mesh-adapter-visual-ba::sidecar` (argv in, stdin payload once, read until
//! one `result` event), this bridge keeps the child process alive for the
//! whole task: stdout is forwarded line-by-line as Tauri events, stdin stays
//! open for control messages, and the caller can cancel mid-stream.
//!
//! The streaming/process logic (`run_streaming_sidecar`) takes no `AppHandle`
//! — it is generic over `SidecarEventSink` — so it can be unit-tested without
//! a Tauri runtime. The `#[tauri::command]` fns at the bottom are thin
//! wrappers that resolve the sidecar binary, generate a task id, spawn the
//! core fn on a `TauriEventSink`, and register/deregister it in
//! `SidecarStreamRegistry` so `sidecar_stdin_write` / `cancel_sidecar_task`
//! can reach the running task.

use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, Mutex as TokioMutex};

use volo_shared::error::{VoloError, VoloResult};

use super::sidecars::{locate_by_name, sidecar_command};

/// How long a cancelled task gets to exit after stdin is closed before we
/// escalate to a hard kill. Conservative default: no `SIGTERM`-then-`SIGKILL`
/// staging (would need a `libc`/`nix` dependency for cross-platform signals
/// this crate doesn't otherwise pull in) — "graceful" here means "close
/// stdin and give the child a grace window", then `Child::start_kill()`.
const DEFAULT_CANCEL_GRACE: Duration = Duration::from_secs(3);

/// Tail of stderr kept for the terminal event, matching the 4KB budget used by
/// `mesh-adapter-visual-ba::sidecar`.
const STDERR_TAIL_LIMIT: usize = 4096;

/// Upper bound on draining remaining stdout after the child is reaped, so an
/// orphaned grandchild holding the stdout pipe open can't hang the terminal
/// event indefinitely (see `run_streaming_sidecar`).
const READER_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);

/// Event streamed to the frontend on the per-task channel `sidecar://<task_id>`.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SidecarStreamEvent {
    /// One line of sidecar stdout. `parsed` is `Some` when the line parsed as
    /// JSON, `None` for non-JSON "raw" lines — both are forwarded rather than
    /// dropped (LMT precedent tolerates stray non-JSON stdout lines; here we
    /// don't know each sidecar's protocol well enough to treat them as fatal).
    Line {
        task_id: String,
        raw: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        parsed: Option<serde_json::Value>,
    },
    /// Terminal event, emitted exactly once when the child has been reaped.
    /// `fatal` is true for a non-zero/missing exit code that wasn't the
    /// result of our own cancellation; `cancelled` is true iff
    /// `cancel_sidecar_task` triggered the shutdown.
    Exit {
        task_id: String,
        exit_code: Option<i32>,
        stderr_tail: String,
        fatal: bool,
        cancelled: bool,
    },
}

/// Control-plane messages sent into a running task via its registry entry.
pub(crate) enum ControlMsg {
    WriteLine(String),
    Cancel,
}

/// Where `run_streaming_sidecar` emits events. Implemented by `TauriEventSink`
/// for the real command and by a plain channel sender in tests, so the core
/// process/streaming logic never touches `AppHandle`.
pub(crate) trait SidecarEventSink: Clone + Send + 'static {
    fn emit(&self, event: SidecarStreamEvent);
}

#[derive(Clone)]
struct TauriEventSink {
    app: AppHandle,
    channel: String,
}

impl SidecarEventSink for TauriEventSink {
    fn emit(&self, event: SidecarStreamEvent) {
        if let SidecarStreamEvent::Line {
            parsed: Some(v), ..
        } = &event
        {
            register_approved_images(&self.app, v);
        }
        let _ = self.app.emit(&self.channel, event);
    }
}

/// `read_image_as_data_url` (vpcal_runs.rs) must never become a generic
/// "read any file on disk" primitive reachable from the webview. A
/// caller-supplied "base directory" doesn't help — the caller controls both
/// the path and the claimed base, so it can always pick one that contains
/// the other. The only signals a compromised renderer can't forge are paths
/// Rust observed in real subprocess output or produced through a Rust-owned
/// generator. Streamed `{..., data: {annotated_images: [...]}}` paths and
/// synchronous generator artifacts are canonicalized into this allowlist.
/// `read_image_as_data_url` then only serves paths present in this set.
#[derive(Default)]
pub struct ApprovedImagePaths(pub(crate) StdMutex<std::collections::HashSet<std::path::PathBuf>>);

/// Approve an image path that Rust itself produced or observed. Besides streamed
/// vpcal overlays, synchronous generators use this for their own image artifacts
/// so the renderer can preview them without receiving arbitrary filesystem read
/// access.
pub(crate) fn approve_image_path(app: &AppHandle, path: &Path) -> VoloResult<()> {
    let canon = path.canonicalize().map_err(|e| {
        VoloError::Io(format!(
            "failed to resolve generated image {}: {e}",
            path.display()
        ))
    })?;
    let registry = app.state::<ApprovedImagePaths>();
    let mut approved = registry
        .0
        .lock()
        .map_err(|e| VoloError::Io(format!("approved-image registry poisoned: {e}")))?;
    approved.insert(canon);
    Ok(())
}

fn register_approved_images(app: &AppHandle, envelope: &serde_json::Value) {
    let Some(images) = envelope
        .get("data")
        .and_then(|d| d.get("annotated_images"))
        .and_then(|a| a.as_array())
    else {
        return;
    };
    let registry = app.state::<ApprovedImagePaths>();
    let Ok(mut approved) = registry.0.lock() else {
        return;
    };
    for image in images {
        if let Some(raw) = image.as_str() {
            if let Ok(canon) = Path::new(raw).canonicalize() {
                approved.insert(canon);
            }
        }
    }
}

/// Concurrent stderr drain, mirroring `mesh-adapter-visual-ba::sidecar`: reads
/// stderr off the critical path so a full pipe can't stall stdout streaming,
/// keeping only the last `STDERR_TAIL_LIMIT` bytes for the exit event.
fn spawn_stderr_drain(child: &mut Child) -> Option<Arc<StdMutex<Vec<u8>>>> {
    let mut stderr = child.stderr.take()?;
    let buf = Arc::new(StdMutex::new(Vec::<u8>::new()));
    let buf_writer = buf.clone();
    tokio::spawn(async move {
        let mut chunk = [0u8; 4096];
        loop {
            match stderr.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if let Ok(mut g) = buf_writer.lock() {
                        g.extend_from_slice(&chunk[..n]);
                        if g.len() > STDERR_TAIL_LIMIT {
                            let drop_n = g.len() - STDERR_TAIL_LIMIT;
                            g.drain(..drop_n);
                        }
                    }
                }
            }
        }
    });
    Some(buf)
}

fn stderr_tail(buf: &Option<Arc<StdMutex<Vec<u8>>>>) -> String {
    buf.as_ref()
        .and_then(|b| {
            b.lock()
                .ok()
                .map(|g| String::from_utf8_lossy(&g).into_owned())
        })
        .unwrap_or_default()
}

/// Core streaming loop: spawn `cmd`, forward stdout lines to `sink` as they
/// arrive, service `control_rx` for stdin writes / cancellation, and emit a
/// single terminal `Exit` event once the child is reaped. Takes no
/// `AppHandle` so it is directly unit-testable.
pub(crate) async fn run_streaming_sidecar<S: SidecarEventSink>(
    task_id: String,
    mut cmd: Command,
    sink: S,
    mut control_rx: mpsc::UnboundedReceiver<ControlMsg>,
    cancel_grace: Duration,
) {
    let mut child = match cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            sink.emit(SidecarStreamEvent::Exit {
                task_id,
                exit_code: None,
                stderr_tail: format!("failed to spawn sidecar: {e}"),
                fatal: true,
                cancelled: false,
            });
            return;
        }
    };

    let mut stdin = child.stdin.take();
    let stdout = child.stdout.take().expect("stdout piped at spawn");
    let stderr_buf = spawn_stderr_drain(&mut child);

    // Own the stdout reader on a separate task so a slow/absent frontend
    // listener can never backpressure the child (mirrors the stderr drain).
    let reader_sink = sink.clone();
    let reader_task_id = task_id.clone();
    let reader_handle = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(raw)) => {
                    let parsed = serde_json::from_str::<serde_json::Value>(&raw).ok();
                    reader_sink.emit(SidecarStreamEvent::Line {
                        task_id: reader_task_id.clone(),
                        raw,
                        parsed,
                    });
                }
                _ => break, // EOF or read error: nothing more to forward.
            }
        }
    });

    let mut cancelled = false;
    let exit_status = loop {
        tokio::select! {
            status = child.wait() => break status.ok(),
            msg = control_rx.recv() => match msg {
                Some(ControlMsg::WriteLine(line)) => {
                    if let Some(s) = stdin.as_mut() {
                        if s.write_all(line.as_bytes()).await.is_ok() {
                            let _ = s.write_all(b"\n").await;
                            let _ = s.flush().await;
                        }
                    }
                }
                Some(ControlMsg::Cancel) => {
                    cancelled = true;
                    // Graceful: drop stdin so the child sees EOF; escalate to
                    // a hard kill only if it doesn't exit within the grace
                    // window.
                    stdin.take();
                    break match tokio::time::timeout(cancel_grace, child.wait()).await {
                        Ok(status) => status.ok(),
                        Err(_elapsed) => {
                            let _ = child.start_kill();
                            child.wait().await.ok()
                        }
                    };
                }
                // Registry entry dropped without an explicit cancel (should
                // not happen in normal operation — cleanup runs after this
                // fn returns — but fall back to a plain wait rather than
                // spinning on a closed channel).
                None => break child.wait().await.ok(),
            },
        }
    };

    // Let the stdout reader observe EOF (guaranteed once the tracked child is
    // reaped, *unless* it forked a grandchild that inherited the stdout pipe
    // and outlived it — that grandchild, not the reaped child, would then be
    // the one still holding the write end open). Bound the wait so such an
    // orphan can't hang the terminal event forever; abort the reader past the
    // bound and accept a possibly-truncated tail as the trade-off.
    let abort_reader = reader_handle.abort_handle();
    if tokio::time::timeout(READER_DRAIN_TIMEOUT, reader_handle)
        .await
        .is_err()
    {
        abort_reader.abort();
    }

    let exit_code = exit_status.and_then(|s| s.code());
    let fatal = !cancelled && exit_code != Some(0);
    sink.emit(SidecarStreamEvent::Exit {
        task_id,
        exit_code,
        stderr_tail: stderr_tail(&stderr_buf),
        fatal,
        cancelled,
    });
}

/// Global task table: `task_id` -> control-plane sender for the running
/// `run_streaming_sidecar` task. Managed as Tauri state; entries are removed
/// once the task's terminal event has been emitted.
#[derive(Default)]
pub struct SidecarStreamRegistry {
    tasks: TokioMutex<HashMap<String, (String, mpsc::UnboundedSender<ControlMsg>)>>,
}

impl SidecarStreamRegistry {
    async fn insert(&self, task_id: String, program: String, tx: mpsc::UnboundedSender<ControlMsg>) {
        self.tasks.lock().await.insert(task_id, (program, tx));
    }

    async fn remove(&self, task_id: &str) {
        self.tasks.lock().await.remove(task_id);
    }

    /// Returns `true` iff a task with `task_id` was found and the message was
    /// handed to its control channel (task may still race an exit before it
    /// is processed — callers should treat `false` as "already gone").
    async fn send(&self, task_id: &str, msg: ControlMsg) -> bool {
        let tx = self.tasks.lock().await.get(task_id).map(|(_, tx)| tx.clone());
        match tx {
            Some(tx) => tx.send(msg).is_ok(),
            None => false,
        }
    }

    /// Cancel every running task spawned from `program`. Sweep for orphans: a
    /// webview reload loses all frontend task handles, so tasks from the
    /// previous page generation keep running (and e.g. keep a DeckLink device
    /// exclusively open) with no one able to cancel them. Returns the number
    /// of tasks a cancel was delivered to.
    async fn cancel_by_program(&self, program: &str) -> u32 {
        let txs: Vec<_> = self
            .tasks
            .lock()
            .await
            .values()
            .filter(|(p, _)| p == program)
            .map(|(_, tx)| tx.clone())
            .collect();
        txs.into_iter()
            .filter(|tx| tx.send(ControlMsg::Cancel).is_ok())
            .count() as u32
    }
}

static TASK_SEQ: AtomicU64 = AtomicU64::new(0);

fn generate_task_id() -> String {
    let seq = TASK_SEQ.fetch_add(1, Ordering::Relaxed);
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default();
    format!("sst-{millis}-{seq}")
}

#[derive(Debug, Clone, Serialize)]
pub struct SpawnStreamingResponse {
    pub task_id: String,
    pub channel: String,
}

/// Spawn a long-running sidecar (`vpcal` / `tracksim` — same binary
/// resolution as `sidecars::spawn_sidecar`) and stream its stdout as
/// `SidecarStreamEvent`s on the Tauri event channel `sidecar://<task_id>`.
#[tauri::command]
pub async fn spawn_sidecar_streaming(
    app: AppHandle,
    registry: State<'_, SidecarStreamRegistry>,
    name: String,
    args: Vec<String>,
) -> VoloResult<SpawnStreamingResponse> {
    let exe = locate_by_name(&name)?;
    let task_id = generate_task_id();
    let channel = format!("sidecar://{task_id}");

    let (control_tx, control_rx) = mpsc::unbounded_channel();
    registry.insert(task_id.clone(), name.clone(), control_tx).await;

    let mut cmd = Command::from(sidecar_command(exe));
    cmd.args(&args);

    let sink = TauriEventSink {
        app: app.clone(),
        channel: channel.clone(),
    };
    let task_id_for_task = task_id.clone();
    tokio::spawn(async move {
        run_streaming_sidecar(
            task_id_for_task.clone(),
            cmd,
            sink,
            control_rx,
            DEFAULT_CANCEL_GRACE,
        )
        .await;
        app.state::<SidecarStreamRegistry>()
            .remove(&task_id_for_task)
            .await;
    });

    Ok(SpawnStreamingResponse { task_id, channel })
}

/// Write one line to a running streaming task's stdin (newline appended by
/// the bridge). Returns `false` if `task_id` is unknown (already exited).
#[tauri::command]
pub async fn sidecar_stdin_write(
    registry: State<'_, SidecarStreamRegistry>,
    task_id: String,
    line: String,
) -> VoloResult<bool> {
    Ok(registry.send(&task_id, ControlMsg::WriteLine(line)).await)
}

/// Request cancellation of a running streaming task: stdin is closed
/// immediately, and the child is force-killed if it hasn't exited within the
/// grace window. Returns `false` if `task_id` is unknown (already exited).
/// Cancel all running streaming tasks of one sidecar program (orphan sweep —
/// called by the frontend on page load; see `cancel_by_program`).
#[tauri::command]
pub async fn cancel_sidecar_tasks_by_program(
    registry: State<'_, SidecarStreamRegistry>,
    program: String,
) -> VoloResult<u32> {
    Ok(registry.cancel_by_program(&program).await)
}

#[tauri::command]
pub async fn cancel_sidecar_task(
    registry: State<'_, SidecarStreamRegistry>,
    task_id: String,
) -> VoloResult<bool> {
    Ok(registry.send(&task_id, ControlMsg::Cancel).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone)]
    struct ChannelSink(mpsc::UnboundedSender<SidecarStreamEvent>);

    impl SidecarEventSink for ChannelSink {
        fn emit(&self, event: SidecarStreamEvent) {
            let _ = self.0.send(event);
        }
    }

    fn sh_command(script: &str) -> Command {
        let mut cmd = Command::new("sh");
        cmd.arg("-c").arg(script);
        cmd
    }

    async fn drain(rx: &mut mpsc::UnboundedReceiver<SidecarStreamEvent>) -> Vec<SidecarStreamEvent> {
        let mut events = Vec::new();
        while let Ok(Some(event)) =
            tokio::time::timeout(Duration::from_secs(5), rx.recv()).await
        {
            events.push(event);
        }
        events
    }

    // Unix-only, matching the mesh-adapter-visual-ba cancel/kill test
    // convention: `sh -c` fixtures spawned inline, cross-platform kill
    // semantics not exercised on Windows CI.
    #[cfg(unix)]
    #[tokio::test]
    async fn streams_ndjson_lines_in_order_and_reports_clean_exit() {
        let cmd = sh_command(r#"echo '{"a":1}'; echo '{"a":2}'; echo 'not json'; exit 0"#);
        let (event_tx, mut event_rx) = mpsc::unbounded_channel();
        let (_control_tx, control_rx) = mpsc::unbounded_channel();

        run_streaming_sidecar(
            "t1".into(),
            cmd,
            ChannelSink(event_tx),
            control_rx,
            Duration::from_secs(3),
        )
        .await;

        let mut events = Vec::new();
        while let Ok(event) = event_rx.try_recv() {
            events.push(event);
        }

        assert_eq!(events.len(), 4, "3 lines + 1 exit event: {events:?}");
        match &events[0] {
            SidecarStreamEvent::Line { raw, parsed, .. } => {
                assert_eq!(raw, r#"{"a":1}"#);
                assert_eq!(parsed.as_ref().unwrap()["a"], 1);
            }
            other => panic!("expected Line, got {other:?}"),
        }
        match &events[2] {
            SidecarStreamEvent::Line { raw, parsed, .. } => {
                assert_eq!(raw, "not json");
                assert!(parsed.is_none(), "non-JSON line must tolerate, not drop");
            }
            other => panic!("expected Line, got {other:?}"),
        }
        match &events[3] {
            SidecarStreamEvent::Exit {
                exit_code,
                fatal,
                cancelled,
                ..
            } => {
                assert_eq!(*exit_code, Some(0));
                assert!(!fatal);
                assert!(!cancelled);
            }
            other => panic!("expected Exit, got {other:?}"),
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stdin_roundtrip_is_echoed_back() {
        let cmd = sh_command("while IFS= read -r line; do echo \"echo:$line\"; done");
        let (event_tx, mut event_rx) = mpsc::unbounded_channel();
        let (control_tx, control_rx) = mpsc::unbounded_channel();

        let task = tokio::spawn(run_streaming_sidecar(
            "t2".into(),
            cmd,
            ChannelSink(event_tx),
            control_rx,
            Duration::from_secs(3),
        ));

        control_tx
            .send(ControlMsg::WriteLine("hello".into()))
            .unwrap();
        let first = tokio::time::timeout(Duration::from_secs(3), event_rx.recv())
            .await
            .expect("line should arrive")
            .expect("channel open");
        match first {
            SidecarStreamEvent::Line { raw, .. } => assert_eq!(raw, "echo:hello"),
            other => panic!("expected Line, got {other:?}"),
        }

        control_tx.send(ControlMsg::Cancel).unwrap();
        task.await.unwrap();

        let mut saw_exit = false;
        while let Ok(event) = event_rx.try_recv() {
            if let SidecarStreamEvent::Exit { cancelled, .. } = event {
                assert!(cancelled);
                saw_exit = true;
            }
        }
        assert!(saw_exit, "cancel must still emit a terminal Exit event");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancel_kills_a_hung_child_within_the_grace_window() {
        // `sleep` never reads stdin, so closing it (our "graceful" step) has
        // no effect — the grace window always elapses and forces the kill
        // escalation path. No trap/subshell here: `sh -c "sleep 30"` execs
        // straight into `sleep` (single tail command, nothing left in the
        // script), so killing the tracked PID kills the real sleeper with no
        // orphaned grandchild left behind after the test.
        let cmd = sh_command("sleep 30");
        let (event_tx, mut event_rx) = mpsc::unbounded_channel();
        let (control_tx, control_rx) = mpsc::unbounded_channel();

        let task = tokio::spawn(run_streaming_sidecar(
            "t3".into(),
            cmd,
            ChannelSink(event_tx),
            control_rx,
            Duration::from_millis(300),
        ));

        tokio::time::sleep(Duration::from_millis(100)).await;
        let start = std::time::Instant::now();
        control_tx.send(ControlMsg::Cancel).unwrap();

        tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .expect("cancel must not hang past the 5s test budget")
            .unwrap();
        let elapsed = start.elapsed();
        assert!(elapsed < Duration::from_secs(3), "took {elapsed:?}");

        let events = drain(&mut event_rx).await;
        let exit = events
            .iter()
            .find_map(|e| match e {
                SidecarStreamEvent::Exit { cancelled, .. } => Some(*cancelled),
                _ => None,
            })
            .expect("exit event must be emitted");
        assert!(exit, "kill escalation is still a cancellation, not a crash");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn crash_exit_is_flagged_fatal_not_cancelled() {
        let cmd = sh_command(r#"echo '{"warn":true}'; exit 7"#);
        let (event_tx, mut event_rx) = mpsc::unbounded_channel();
        let (_control_tx, control_rx) = mpsc::unbounded_channel();

        run_streaming_sidecar(
            "t4".into(),
            cmd,
            ChannelSink(event_tx),
            control_rx,
            Duration::from_secs(3),
        )
        .await;

        let events = drain(&mut event_rx).await;
        let exit = events
            .iter()
            .find_map(|e| match e {
                SidecarStreamEvent::Exit {
                    exit_code,
                    fatal,
                    cancelled,
                    ..
                } => Some((*exit_code, *fatal, *cancelled)),
                _ => None,
            })
            .expect("exit event must be emitted");
        assert_eq!(exit, (Some(7), true, false));
    }

    #[tokio::test]
    async fn spawn_failure_reports_a_fatal_exit_event_not_a_panic() {
        let cmd = Command::new("volo-sidecar-stream-test-binary-that-does-not-exist");
        let (event_tx, mut event_rx) = mpsc::unbounded_channel();
        let (_control_tx, control_rx) = mpsc::unbounded_channel();

        run_streaming_sidecar(
            "t5".into(),
            cmd,
            ChannelSink(event_tx),
            control_rx,
            Duration::from_secs(3),
        )
        .await;

        let events = drain(&mut event_rx).await;
        assert_eq!(events.len(), 1);
        match &events[0] {
            SidecarStreamEvent::Exit {
                exit_code,
                fatal,
                cancelled,
                ..
            } => {
                assert!(exit_code.is_none());
                assert!(fatal);
                assert!(!cancelled);
            }
            other => panic!("expected Exit, got {other:?}"),
        }
    }
}
