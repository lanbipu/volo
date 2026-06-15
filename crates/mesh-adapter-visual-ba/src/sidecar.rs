//! Spawn the sidecar as a one-shot subprocess and parse its NDJSON stream.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};

use crate::error::{VbaError, VbaResult};
use crate::ipc::{Event, WarningEvent};
use crate::locate::locate_sidecar;

pub struct SidecarRequest {
    pub subcommand: String,
    pub payload: Value,
    pub progress_tx: Option<mpsc::Sender<Event>>,
    pub cancel: Option<oneshot::Receiver<()>>,
}

/// Result of a sidecar run: the last `result` event's raw `data` plus every
/// `WarningEvent` collected off the stream (durable even with no progress consumer).
#[derive(Debug, Clone)]
pub struct SidecarOutput {
    pub data: Value,
    pub warnings: Vec<WarningEvent>,
}

async fn write_payload(child: &mut Child, payload: &Value) -> VbaResult<()> {
    // Take stdin out so the pipe FD is closed when the local goes out of scope —
    // `child.stdin.as_mut()` keeps the option alive and the pipe open even after
    // `shutdown()`, which causes the child's `read` to wait forever.
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| VbaError::SpawnFailed(std::io::Error::other("stdin missing")))?;
    let bytes = serde_json::to_vec(payload)?;
    stdin.write_all(&bytes).await?;
    drop(stdin);
    Ok(())
}

async fn read_events(
    child: &mut Child,
    progress_tx: Option<mpsc::Sender<Event>>,
) -> VbaResult<(Option<Value>, Vec<WarningEvent>)> {
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| VbaError::SpawnFailed(std::io::Error::other("stdout missing")))?;
    let mut lines = BufReader::new(stdout).lines();
    // Keep the raw `data` payload of the last `result` event. Each subcommand
    // emits a different `data` shape, so callers deserialize it themselves.
    let mut last_result: Option<Value> = None;
    // Collect every WarningEvent so it survives even when no progress consumer is
    // attached (the headless CLI/app path passes progress_tx=None). The live
    // forwarding below is best-effort; this list is the durable carrier.
    let mut warnings: Vec<WarningEvent> = Vec::new();
    let mut non_json_lines: usize = 0;
    const MAX_NON_JSON: usize = 50;
    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        // FIX-28①: tolerate non-JSON lines (third-party library prints, debug
        // output). Count them; only fail if the stream is predominantly garbage.
        let event: Event = match serde_json::from_str(&line) {
            Ok(e) => e,
            Err(_) => {
                non_json_lines += 1;
                if non_json_lines > MAX_NON_JSON {
                    return Err(VbaError::Protocol {
                        code: "protocol_error".into(),
                        message: format!(
                            "sidecar stdout: >{MAX_NON_JSON} non-JSON lines (last: {line})"
                        ),
                    });
                }
                continue;
            }
        };
        match &event {
            Event::Result(r) => last_result = Some(r.data.clone()),
            Event::Warning(w) => warnings.push(w.clone()),
            // FIX-28③: respect the `fatal` flag. Non-fatal errors become
            // warnings; only fatal errors abort the run.
            Event::Error(e) if e.fatal => {
                return Err(VbaError::Protocol {
                    code: e.code.clone(),
                    message: e.message.clone(),
                });
            }
            Event::Error(e) => {
                warnings.push(WarningEvent {
                    code: e.code.clone(),
                    message: e.message.clone(),
                    cabinet: None,
                });
            }
            // FIX-28②: unknown event tags are silently tolerated (forward compat).
            Event::Unknown => {}
            _ => {}
        }
        if let Some(tx) = progress_tx.as_ref() {
            let _ = tx.try_send(event);
        }
    }
    Ok((last_result, warnings))
}

const STDERR_TAIL_LIMIT: usize = 4096;

/// Concurrent stderr drain. Returns the last `STDERR_TAIL_LIMIT` bytes so a
/// hung-pipe scenario cannot stall the child, and crash diagnostics are
/// preserved when the child exits non-zero.
fn spawn_stderr_drain(child: &mut Child) -> Option<Arc<Mutex<Vec<u8>>>> {
    let mut stderr = child.stderr.take()?;
    let buf = Arc::new(Mutex::new(Vec::<u8>::new()));
    let buf_writer = buf.clone();
    tokio::spawn(async move {
        let mut chunk = [0u8; 4096];
        loop {
            match stderr.read(&mut chunk).await {
                Ok(0) => break,
                Ok(n) => {
                    if let Ok(mut g) = buf_writer.lock() {
                        g.extend_from_slice(&chunk[..n]);
                        if g.len() > STDERR_TAIL_LIMIT {
                            let drop_n = g.len() - STDERR_TAIL_LIMIT;
                            g.drain(..drop_n);
                        }
                    }
                }
                Err(_) => break,
            }
        }
    });
    Some(buf)
}

fn stderr_tail(buf: &Option<Arc<Mutex<Vec<u8>>>>) -> String {
    buf.as_ref()
        .and_then(|b| {
            b.lock()
                .ok()
                .map(|g| String::from_utf8_lossy(&g).into_owned())
        })
        .unwrap_or_default()
}

/// Run the sidecar and return the raw `data` of its `result` event. Each
/// subcommand emits a different result shape, so the caller deserializes the
/// returned [`Value`] into the concrete type it expects.
pub async fn run_sidecar(req: SidecarRequest) -> VbaResult<SidecarOutput> {
    let exe: PathBuf = locate_sidecar()?;
    let mut cmd = Command::new(&exe);
    cmd.arg(&req.subcommand)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd.spawn()?;
    let stderr_buf = spawn_stderr_drain(&mut child);

    write_payload(&mut child, &req.payload).await?;

    let cancel_fut = async move {
        if let Some(rx) = req.cancel {
            let _ = rx.await;
            true
        } else {
            std::future::pending::<bool>().await
        }
    };

    let read_fut = read_events(&mut child, req.progress_tx);

    tokio::select! {
        cancelled = cancel_fut => {
            if cancelled {
                let _ = child.start_kill();
                let _ = child.wait().await;
                return Err(VbaError::Cancelled);
            }
            unreachable!();
        }
        result = read_fut => {
            let (data, warnings) = result?;
            let status = child.wait().await?;
            if !status.success() {
                let code = status.code();
                let tail = stderr_tail(&stderr_buf);
                return Err(VbaError::SidecarFailed {
                    code,
                    message: format!(
                        "sidecar `{}` exited non-zero{}",
                        req.subcommand,
                        if tail.is_empty() { String::new() } else { format!("; stderr tail: {tail}") },
                    ),
                });
            }
            let data = data.ok_or(VbaError::NoResultEvent)?;
            Ok(SidecarOutput { data, warnings })
        }
    }
}
