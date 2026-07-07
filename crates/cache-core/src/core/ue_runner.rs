//! Async UE process orchestrator. Spawns UE and tails the project log.

use crate::error::{VoloError, VoloResult};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};
use tokio::time::{sleep, Duration};

const TAIL_INTERVAL: Duration = Duration::from_millis(1000);
const MAX_LOG_TAIL_LINES: usize = 200;
const MAX_CONSECUTIVE_TAIL_ERRORS: usize = 5;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UeRunnerBackend {
    Local,
    Remote,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UeRunnerEvent {
    Spawned {
        pid: i64,
        log_path: String,
    },
    LogLine {
        text: String,
        parsed_kind: Option<String>,
    },
    Progress {
        pct: Option<f32>,
        label: String,
    },
    Completed {
        exit_code: i32,
        log_tail: Vec<String>,
    },
    Cancelled,
    Error {
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UeRunSpec {
    pub backend: UeRunnerBackend,
    pub host: String,
    pub engine_path: String,
    pub project_path: String,
    pub extra_args: Vec<String>,
    pub credential_user: Option<String>,
    pub credential_pass: Option<String>,
    /// Launch in the target's interactive console session via a scheduled task.
    /// Kept for legacy editor runs; PSO warm-up now uses `hold_ssh_session`.
    /// Local backend ignores this — a local spawn already lives in the user session.
    pub interactive: bool,
    /// Keep the remote SSH session alive for the lifetime of the UE child.
    /// Windows sshd tears down the spawned process tree when the channel ends;
    /// PSO warm-up depends on this held session as the watchdog.
    pub hold_ssh_session: bool,
}

#[derive(Debug, Deserialize)]
struct StartScriptResult {
    ok: bool,
    pid: String,
    log_path: String,
    #[serde(default)]
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TailScriptResult {
    ok: bool,
    #[serde(default)]
    exists: bool,
    #[serde(default)]
    new_offset: String,
    #[serde(default)]
    new_text: String,
}

#[derive(Debug, Deserialize)]
struct StopScriptResult {
    ok: bool,
    #[serde(default)]
    killed: bool,
    #[serde(default)]
    message: String,
}

struct StartedProcess {
    result: StartScriptResult,
    held_session: Option<HeldSshSession>,
}

struct HeldSshSession {
    child: std::process::Child,
}

impl Drop for HeldSshSession {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub struct RunnerHandle {
    pub events: mpsc::UnboundedReceiver<UeRunnerEvent>,
    pub cancel: Arc<Mutex<RunnerCancel>>,
}

#[derive(Debug, Default)]
pub struct RunnerCancel {
    pub requested: bool,
    /// Set (together with `requested`) by the max-minutes watchdog: the run
    /// reached its planned duration — a completion, not an abort. Consumers
    /// use this to tell watchdog stops apart from user cancels.
    pub watchdog: bool,
    pub host: Option<String>,
    pub pid: Option<i64>,
    pub credential_user: Option<String>,
    pub credential_pass: Option<String>,
}

pub fn run(spec: UeRunSpec) -> RunnerHandle {
    let (tx, rx) = mpsc::unbounded_channel();
    let cancel = Arc::new(Mutex::new(RunnerCancel::default()));
    let cancel_handle = cancel.clone();

    tokio::spawn(async move {
        let started = match start_process(&spec).await {
            Ok(value) => value,
            Err(err) => {
                let _ = tx.send(UeRunnerEvent::Error {
                    message: format!("spawn failed: {}", err),
                });
                return;
            }
        };
        let start = started.result;
        let _held_session = started.held_session;

        let pid = match parse_pid(&start.pid) {
            Ok(pid) => pid,
            Err(err) => {
                let _ = tx.send(UeRunnerEvent::Error {
                    message: format!("spawn failed: {}", err),
                });
                return;
            }
        };
        {
            let mut state = cancel_handle.lock().await;
            state.host = Some(spec.host.clone());
            state.pid = Some(pid);
            state.credential_user = spec.credential_user.clone();
            state.credential_pass = spec.credential_pass.clone();
        }
        let _ = tx.send(UeRunnerEvent::Spawned {
            pid,
            log_path: start.log_path.clone(),
        });

        let mut offset = 0i64;
        let mut consecutive_tail_errors = 0usize;
        let mut log_tail = Vec::<String>::new();
        // Tail chunks are byte windows with no newline alignment: hold the
        // trailing partial line back until its remainder arrives, so a marker
        // line split across a chunk boundary is never matched as fragments.
        let mut pending = String::new();
        loop {
            {
                let state = cancel_handle.lock().await;
                if state.requested {
                    drop(state);
                    if let Err(err) = stop_process(
                        &spec.backend,
                        &spec.host,
                        pid,
                        spec.credential_user.as_deref(),
                        spec.credential_pass.as_deref(),
                    )
                    .await
                    {
                        let _ = tx.send(UeRunnerEvent::Error {
                            message: format!("cancel failed: {}", err),
                        });
                    }
                    let _ = tx.send(UeRunnerEvent::Cancelled);
                    return;
                }
            }

            sleep(TAIL_INTERVAL).await;
            let tail = match read_tail(
                &spec.backend,
                &spec.host,
                &start.log_path,
                offset,
                spec.credential_user.as_deref(),
                spec.credential_pass.as_deref(),
            )
            .await
            {
                Ok(value) => value,
                Err(err) => {
                    consecutive_tail_errors += 1;
                    if consecutive_tail_errors >= MAX_CONSECUTIVE_TAIL_ERRORS {
                        best_effort_stop(&spec, pid, "log tail failed").await;
                        let _ = tx.send(UeRunnerEvent::Error {
                            message: format!(
                                "log tail failed {} times; last error: {} (UE process {} stopped best-effort)",
                                consecutive_tail_errors, err, pid
                            ),
                        });
                        return;
                    }
                    continue;
                }
            };
            if !tail.ok {
                consecutive_tail_errors += 1;
                if consecutive_tail_errors >= MAX_CONSECUTIVE_TAIL_ERRORS {
                    best_effort_stop(&spec, pid, "log tail returned ok=false").await;
                    let _ = tx.send(UeRunnerEvent::Error {
                        message: format!(
                            "log tail returned ok=false {} times (UE process {} stopped best-effort)",
                            consecutive_tail_errors, pid
                        ),
                    });
                    return;
                }
                continue;
            }
            consecutive_tail_errors = 0;
            if !tail.exists || tail.new_text.is_empty() {
                continue;
            }
            offset = tail.new_offset.parse().unwrap_or(offset);

            let processable = match take_complete_lines(&mut pending, &tail.new_text) {
                Some(text) => text,
                None => continue,
            };

            let mut completed_exit = None;
            for raw_line in processable.lines() {
                let line = raw_line.to_string();
                log_tail.push(line.clone());
                if log_tail.len() > MAX_LOG_TAIL_LINES {
                    let drop_n = log_tail.len() - MAX_LOG_TAIL_LINES;
                    log_tail.drain(0..drop_n);
                }

                let parsed = parse_line(&line);
                if let Some(progress) = parsed.progress {
                    let _ = tx.send(UeRunnerEvent::Progress {
                        pct: progress.pct,
                        label: progress.label,
                    });
                }
                if let Some(exit) = parsed.completed_exit {
                    completed_exit = Some(exit);
                }
                let _ = tx.send(UeRunnerEvent::LogLine {
                    text: line,
                    parsed_kind: parsed.kind.map(str::to_string),
                });
            }

            if let Some(exit_code) = completed_exit {
                let _ = tx.send(UeRunnerEvent::Completed {
                    exit_code,
                    log_tail,
                });
                return;
            }
        }
    });

    RunnerHandle { events: rx, cancel }
}

/// Append a byte-window tail chunk and return only the complete lines
/// (up to the last newline); the trailing partial stays buffered until its
/// remainder arrives, or is flushed whole if it grows pathologically large.
fn take_complete_lines(pending: &mut String, incoming: &str) -> Option<String> {
    pending.push_str(incoming);
    match pending.rfind('\n') {
        Some(last_nl) => {
            let head = pending[..=last_nl].to_string();
            pending.drain(..=last_nl);
            Some(head)
        }
        None if pending.len() > 128 * 1024 => Some(std::mem::take(pending)),
        None => None,
    }
}

#[derive(Debug, Default)]
struct ParsedLine {
    kind: Option<&'static str>,
    progress: Option<ProgressInfo>,
    completed_exit: Option<i32>,
}

#[derive(Debug, Clone)]
struct ProgressInfo {
    pct: Option<f32>,
    label: String,
}

fn parse_line(line: &str) -> ParsedLine {
    let mut parsed = ParsedLine::default();
    if line.contains("LogDerivedDataCache: Display: Filling derived data cache for") {
        parsed.kind = Some("ddc_fill");
        parsed.progress = Some(ProgressInfo {
            pct: None,
            label: "Filling DDC".into(),
        });
    } else if line.contains("LogDerivedDataCache: Display: Saving pak") {
        parsed.kind = Some("ddc_pak_save");
        parsed.progress = Some(ProgressInfo {
            pct: extract_pct_in_parens(line),
            label: "Saving pak".into(),
        });
    } else if line.contains("LogDerivedDataCache: Display: Done filling derived data cache.") {
        parsed.kind = Some("ddc_done");
        parsed.progress = Some(ProgressInfo {
            pct: Some(0.95),
            label: "DDC fill complete".into(),
        });
    } else if line.contains("LogShaderPipelineCache: Display: Logging shader pipeline cache to") {
        parsed.kind = Some("pso_logging_started");
        parsed.progress = Some(ProgressInfo {
            pct: None,
            label: "PSO logging started".into(),
        });
    } else if line.contains("LogShaderPipelineCache: Display: PSO snapshot saved to") {
        parsed.kind = Some("pso_snapshot_saved");
        parsed.progress = Some(ProgressInfo {
            pct: None,
            label: "PSO snapshot saved".into(),
        });
    } else if line.contains("LogShaderPipelineCache: Display: PSO logging stopped.")
        && line.contains("Wrote")
        && line.contains("PSOs")
    {
        parsed.kind = Some("pso_logging_stopped");
        parsed.progress = Some(ProgressInfo {
            pct: Some(1.0),
            label: "PSO logging stopped".into(),
        });
    } else if line.contains("LogPSOHitching: ") && line.contains("PSO creation hitch") {
        // e.g. `LogPSOHitching: Verbose: Runtime graphics PSO creation hitch (29.86 msec) ...`
        parsed.kind = Some("pso_hitch");
    } else if line.contains("LogInit: Engine exit requested") || line.contains("LogExit: Exiting.")
    {
        parsed.kind = Some("exit_clean");
        parsed.completed_exit = Some(0);
    } else if line.contains("LogCore: Error: Critical fail")
        || line.contains("LogOutputDevice: Error: Assertion failed")
    {
        parsed.kind = Some("exit_critical");
        parsed.completed_exit = Some(1);
    }
    parsed
}

fn parse_pid(raw: &str) -> VoloResult<i64> {
    let pid = raw.trim().parse::<i64>().map_err(|_| {
        VoloError::OperationFailed(format!(
            "invalid process id returned by UE launcher: {:?}",
            raw
        ))
    })?;
    if pid <= 0 {
        return Err(VoloError::OperationFailed(format!(
            "invalid process id returned by UE launcher: {}",
            pid
        )));
    }
    Ok(pid)
}

fn extract_pct_in_parens(line: &str) -> Option<f32> {
    let open = line.rfind('(')?;
    let close = line.rfind(')')?;
    if close <= open {
        return None;
    }
    let inner = &line[open + 1..close];
    let (current, total) = inner.split_once('/')?;
    let current = current.trim().parse::<f32>().ok()?;
    let total = total.trim().parse::<f32>().ok()?;
    if total <= 0.0 {
        return None;
    }
    Some(current / total)
}

/// Kill the UE process when the runner loses the ability to monitor it —
/// leaving a `-game` instance rendering unmanaged on a node is worse than
/// tearing down a run we can no longer observe.
async fn best_effort_stop(spec: &UeRunSpec, pid: i64, reason: &str) {
    if let Err(err) = stop_process(
        &spec.backend,
        &spec.host,
        pid,
        spec.credential_user.as_deref(),
        spec.credential_pass.as_deref(),
    )
    .await
    {
        tracing::warn!(?err, pid, reason, "ue_runner: best-effort stop failed");
    }
}

async fn start_process(spec: &UeRunSpec) -> VoloResult<StartedProcess> {
    match spec.backend {
        UeRunnerBackend::Remote if crate::core::loopback::is_loopback_target(&spec.host) => {
            tracing::debug!(
                host = %spec.host,
                "ue_runner: target is local, short-circuit start to local backend"
            );
            start_local_process(spec).await
        }
        UeRunnerBackend::Remote => {
            // Blocking SSH (and the interactive script's up-to-90s appearance
            // poll) must not pin a tokio worker — fan-out warms N nodes at once.
            let spec = spec.clone();
            tokio::task::spawn_blocking(move || start_remote_process(&spec))
                .await
                .map_err(|err| VoloError::OperationFailed(format!("start task join: {err}")))?
        }
        UeRunnerBackend::Local => start_local_process(spec).await,
    }
}

fn start_remote_process(spec: &UeRunSpec) -> VoloResult<StartedProcess> {
    // SSH key auth; per-call WinRM cred ignored (kept on spec until A5).
    if spec.hold_ssh_session {
        return start_remote_held_process(spec);
    }
    let exec = crate::core::ssh::SshExecutor::from_config()?;
    let script_name = if spec.interactive {
        "start-ue-interactive.ps1"
    } else {
        "start-ue-process.ps1"
    };
    let result: StartScriptResult = crate::core::ssh::run_json(
        &exec,
        &spec.host,
        &crate::core::ssh::NodeScript {
            name: script_name,
            args: serde_json::json!({
                "EnginePath": spec.engine_path,
                "ProjectPath": spec.project_path,
                "ExtraArgs": spec.extra_args,
            }),
            ssh_user: None,
        },
    )?;
    if !result.ok {
        return Err(VoloError::OperationFailed(
            result.message.unwrap_or_else(|| "spawn failed".into()),
        ));
    }
    Ok(StartedProcess {
        result,
        held_session: None,
    })
}

fn start_remote_held_process(spec: &UeRunSpec) -> VoloResult<StartedProcess> {
    let exec = crate::core::ssh::SshExecutor::from_config()?;
    let mut child = exec.spawn_script(
        &spec.host,
        &crate::core::ssh::NodeScript {
            name: "start-ue-held.ps1",
            args: serde_json::json!({
                "EnginePath": spec.engine_path,
                "ProjectPath": spec.project_path,
                "ExtraArgs": spec.extra_args,
            }),
            ssh_user: None,
        },
    )?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| VoloError::SshConnect("open held ssh stdout failed".into()))?;
    let mut reader = BufReader::new(stdout);
    let mut first_line = String::new();
    let read = reader.read_line(&mut first_line).map_err(VoloError::Io)?;
    drop(reader);
    if read == 0 {
        let _ = child.kill();
        let _ = child.wait();
        return Err(VoloError::NodeScript {
            exit: -1,
            stderr: "held UE start script exited before reporting spawn result".into(),
        });
    }
    let result: StartScriptResult =
        serde_json::from_str(first_line.trim()).map_err(|err| VoloError::NodeScript {
            exit: 0,
            stderr: format!(
                "bad JSON from held UE start script: {} (stdout: {})",
                err,
                first_line.trim()
            ),
        })?;
    if !result.ok {
        let message = result
            .message
            .clone()
            .unwrap_or_else(|| "spawn failed".into());
        let _ = child.kill();
        let _ = child.wait();
        return Err(VoloError::OperationFailed(message));
    }
    Ok(StartedProcess {
        result,
        held_session: Some(HeldSshSession { child }),
    })
}

async fn start_local_process(spec: &UeRunSpec) -> VoloResult<StartedProcess> {
    #[cfg(windows)]
    {
        let exe = std::path::Path::new(&spec.engine_path)
            .join("Engine")
            .join("Binaries")
            .join("Win64")
            .join("UnrealEditor.exe");
        if !exe.exists() {
            return Err(VoloError::InvalidInput(format!(
                "UnrealEditor.exe not found at {}",
                exe.display()
            )));
        }
        let project = std::path::Path::new(&spec.project_path);
        if !project.exists() {
            return Err(VoloError::InvalidInput(format!(
                ".uproject not found at {}",
                project.display()
            )));
        }
        let mut command = tokio::process::Command::new(&exe);
        command.arg(project);
        for arg in &spec.extra_args {
            command.arg(arg);
        }
        let child = command.spawn().map_err(VoloError::Io)?;
        let pid = child.id().unwrap_or_default() as i64;
        let project_dir = project
            .parent()
            .ok_or_else(|| VoloError::InvalidInput("project parent missing".into()))?;
        let project_name = project
            .file_stem()
            .ok_or_else(|| VoloError::InvalidInput("project stem missing".into()))?
            .to_string_lossy();
        Ok(StartedProcess {
            result: StartScriptResult {
                ok: true,
                pid: pid.to_string(),
                log_path: ue_log_path(project_dir, &project_name, &spec.extra_args),
                message: None,
            },
            held_session: None,
        })
    }
    #[cfg(not(windows))]
    {
        let _ = spec;
        Err(VoloError::OperationFailed(
            "local UE backend requires Windows".into(),
        ))
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
fn ue_log_path(project_dir: &std::path::Path, project_name: &str, extra_args: &[String]) -> String {
    let logs_dir = project_dir.join("Saved").join("Logs");
    if let Some(log_value) = extra_args.iter().rev().find_map(|arg| parse_log_arg(arg)) {
        let path = std::path::Path::new(&log_value);
        if path.is_absolute() {
            return log_value;
        }
        return logs_dir.join(path).to_string_lossy().to_string();
    }
    logs_dir
        .join(format!("{}.log", project_name))
        .to_string_lossy()
        .to_string()
}

#[cfg_attr(not(windows), allow(dead_code))]
fn parse_log_arg(arg: &str) -> Option<String> {
    let (key, value) = arg.split_once('=')?;
    let key = key.trim_start_matches('-');
    if !key.eq_ignore_ascii_case("log") {
        return None;
    }
    let value = value.trim().trim_matches('"');
    (!value.is_empty()).then(|| value.to_string())
}

async fn read_tail(
    backend: &UeRunnerBackend,
    host: &str,
    log_path: &str,
    offset: i64,
    user: Option<&str>,
    pass: Option<&str>,
) -> VoloResult<TailScriptResult> {
    match backend {
        UeRunnerBackend::Remote => {
            if crate::core::loopback::is_loopback_target(host) {
                tracing::debug!(
                    host = %host,
                    "ue_runner: target is local, short-circuit log tail to local backend"
                );
                return read_tail_local(log_path, offset);
            }
            let _ = (user, pass); // SSH key auth; per-call WinRM cred ignored (kept until A5).
            let host = host.to_string();
            let log_path = log_path.to_string();
            tokio::task::spawn_blocking(move || {
                let exec = crate::core::ssh::SshExecutor::from_config()?;
                crate::core::ssh::run_json(
                    &exec,
                    &host,
                    &crate::core::ssh::NodeScript {
                        name: "tail-ue-log.ps1",
                        args: serde_json::json!({ "LogPath": log_path, "LastReadOffset": offset }),
                        ssh_user: None,
                    },
                )
            })
            .await
            .map_err(|err| VoloError::OperationFailed(format!("tail task join: {err}")))?
        }
        UeRunnerBackend::Local => read_tail_local(log_path, offset),
    }
}

fn read_tail_local(log_path: &str, offset: i64) -> VoloResult<TailScriptResult> {
    use std::io::{Read, Seek, SeekFrom};
    let path = std::path::Path::new(log_path);
    if !path.exists() {
        return Ok(TailScriptResult {
            ok: true,
            exists: false,
            new_offset: "0".into(),
            new_text: String::new(),
        });
    }
    let mut file = std::fs::File::open(path).map_err(VoloError::Io)?;
    let size = file.metadata().map_err(VoloError::Io)?.len() as i64;
    if size <= offset {
        return Ok(TailScriptResult {
            ok: true,
            exists: true,
            new_offset: size.to_string(),
            new_text: String::new(),
        });
    }
    file.seek(SeekFrom::Start(offset as u64))
        .map_err(VoloError::Io)?;
    let to_read = std::cmp::min(65536, (size - offset) as usize);
    let mut buf = vec![0u8; to_read];
    let read = file.read(&mut buf).map_err(VoloError::Io)?;
    Ok(TailScriptResult {
        ok: true,
        exists: true,
        new_offset: (offset + read as i64).to_string(),
        new_text: String::from_utf8_lossy(&buf[..read]).to_string(),
    })
}

async fn stop_process(
    backend: &UeRunnerBackend,
    host: &str,
    pid: i64,
    user: Option<&str>,
    pass: Option<&str>,
) -> VoloResult<()> {
    match backend {
        UeRunnerBackend::Remote => {
            if crate::core::loopback::is_loopback_target(host) {
                tracing::debug!(
                    host = %host,
                    "ue_runner: target is local, short-circuit stop to local backend"
                );
                return stop_local_process(pid);
            }
            let _ = (user, pass); // SSH key auth; per-call WinRM cred ignored (kept until A5).
            let host_owned = host.to_string();
            let result: StopScriptResult = tokio::task::spawn_blocking(move || {
                let exec = crate::core::ssh::SshExecutor::from_config()?;
                crate::core::ssh::run_json(
                    &exec,
                    &host_owned,
                    &crate::core::ssh::NodeScript {
                        name: "stop-ue-process.ps1",
                        args: serde_json::json!({ "TargetPid": pid }),
                        ssh_user: None,
                    },
                )
            })
            .await
            .map_err(|err| VoloError::OperationFailed(format!("stop task join: {err}")))??;
            if !result.ok {
                return Err(VoloError::OperationFailed(result.message));
            }
            if !result.killed {
                // Process already gone (e.g. UE exited in the watchdog window)
                // — the goal state is reached, don't surface it as a failure.
                tracing::debug!(pid, message = %result.message, "stop-ue-process: nothing to kill");
            }
            Ok(())
        }
        UeRunnerBackend::Local => stop_local_process(pid),
    }
}

fn stop_local_process(pid: i64) -> VoloResult<()> {
    #[cfg(windows)]
    {
        crate::core::proc::hide_console(std::process::Command::new("taskkill").args([
            "/PID",
            &pid.to_string(),
            "/F",
        ]))
        .output()
        .map_err(VoloError::Io)?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        Err(VoloError::OperationFailed(
            "local stop requires Windows".into(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_line_recognises_filling_progress() {
        let parsed =
            parse_line("LogDerivedDataCache: Display: Filling derived data cache for /Game/Foo");
        assert_eq!(parsed.kind, Some("ddc_fill"));
        assert!(parsed.progress.is_some());
    }

    #[test]
    fn parse_line_recognises_saving_pak_with_pct() {
        let parsed = parse_line("LogDerivedDataCache: Display: Saving pak (3/10)");
        assert_eq!(parsed.kind, Some("ddc_pak_save"));
        assert!((parsed.progress.unwrap().pct.unwrap() - 0.3).abs() < 0.001);
    }

    #[test]
    fn parse_line_recognises_clean_exit() {
        let parsed = parse_line("LogInit: Engine exit requested");
        assert_eq!(parsed.completed_exit, Some(0));
    }

    #[test]
    fn parse_line_recognises_pso_markers() {
        let started = parse_line(
            "LogShaderPipelineCache: Display: Logging shader pipeline cache to D:/X/Saved/CollectedPSOs/X.upipelinecache",
        );
        assert_eq!(started.kind, Some("pso_logging_started"));
        let snapshot = parse_line(
            "LogShaderPipelineCache: Display: PSO snapshot saved to D:/X/Saved/CollectedPSOs/X.upipelinecache",
        );
        assert_eq!(snapshot.kind, Some("pso_snapshot_saved"));
        let stopped =
            parse_line("LogShaderPipelineCache: Display: PSO logging stopped. Wrote 128 PSOs.");
        assert_eq!(stopped.kind, Some("pso_logging_stopped"));
        assert_eq!(stopped.progress.unwrap().pct, Some(1.0));
    }

    #[test]
    fn parse_line_recognises_pso_hitch() {
        let parsed = parse_line(
            "[2026.07.02-02.24.22:873][  0]LogPSOHitching: Verbose: Runtime graphics PSO creation hitch (29.86 msec) for Resource  in Pass Unknown (precache status: Unknown) - Breadcrumbs: Frame 0/SceneRender",
        );
        assert_eq!(parsed.kind, Some("pso_hitch"));
        assert!(parsed.completed_exit.is_none());
        // mentions of the log category on other channels must NOT count
        let raised =
            parse_line("LogHAL: Log category LogPSOHitching verbosity has been raised to Verbose.");
        assert_ne!(raised.kind, Some("pso_hitch"));
    }

    #[test]
    fn parse_line_recognises_critical_fail() {
        let parsed = parse_line("LogCore: Error: Critical fail in shader compile");
        assert_eq!(parsed.completed_exit, Some(1));
    }

    #[test]
    fn parse_line_ignores_unrelated() {
        let parsed = parse_line("LogTemp: nothing useful");
        assert!(parsed.kind.is_none());
        assert!(parsed.progress.is_none());
        assert!(parsed.completed_exit.is_none());
    }

    #[test]
    fn extract_pct_handles_garbage() {
        assert!(extract_pct_in_parens("no parens here").is_none());
        assert!(extract_pct_in_parens("(abc/def)").is_none());
        assert!(extract_pct_in_parens("(0/0)").is_none());
    }

    #[test]
    fn take_complete_lines_reassembles_split_marker() {
        let mut pending = String::new();
        // hitch line split across a chunk boundary must not surface as fragments
        assert_eq!(
            take_complete_lines(&mut pending, "[t]LogPSOHitching: "),
            None
        );
        let out = take_complete_lines(
            &mut pending,
            "Verbose: Runtime graphics PSO creation hitch (29.86 msec)\n[t]Log",
        )
        .unwrap();
        assert_eq!(out.lines().count(), 1);
        assert!(super::super::pso_warmup::is_hitch_line(
            out.lines().next().unwrap()
        ));
        assert_eq!(pending, "[t]Log");
    }

    #[test]
    fn take_complete_lines_returns_only_full_lines() {
        let mut pending = String::new();
        let out = take_complete_lines(&mut pending, "a\r\nb\nc-partial").unwrap();
        assert_eq!(out.lines().collect::<Vec<_>>(), vec!["a", "b"]);
        assert_eq!(pending, "c-partial");
        let out2 = take_complete_lines(&mut pending, "-rest\n").unwrap();
        assert_eq!(out2.lines().collect::<Vec<_>>(), vec!["c-partial-rest"]);
        assert!(pending.is_empty());
    }

    #[test]
    fn parse_pid_rejects_invalid_values() {
        assert_eq!(parse_pid("42").unwrap(), 42);
        assert!(parse_pid("").is_err());
        assert!(parse_pid("0").is_err());
        assert!(parse_pid("abc").is_err());
    }

    #[test]
    fn local_host_short_circuits() {
        assert!(crate::core::loopback::is_loopback_target("127.0.0.1"));
        assert!(crate::core::loopback::is_loopback_target("localhost"));
    }

    #[test]
    fn remote_host_does_not_short_circuit() {
        assert!(!crate::core::loopback::is_loopback_target("203.0.113.10"));
    }

    #[test]
    fn ue_log_path_honours_log_arg() {
        let project_dir = std::path::Path::new("/Project");
        let args = vec!["-game".into(), "Log=VoloPsoWarmup_Node_0.log".into()];
        let path = ue_log_path(project_dir, "Demo", &args);
        assert!(path.ends_with("Saved/Logs/VoloPsoWarmup_Node_0.log"));
    }

    #[test]
    fn parse_log_arg_accepts_dashless_and_dashed_forms() {
        assert_eq!(parse_log_arg("Log=Node.log").as_deref(), Some("Node.log"));
        assert_eq!(
            parse_log_arg("-LOG=\"Node 0.log\"").as_deref(),
            Some("Node 0.log")
        );
        assert_eq!(parse_log_arg("-LogCmds=Foo").as_deref(), None);
    }
}
