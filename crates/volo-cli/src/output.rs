//! Event types + emitter abstraction. NDJSON for `--json` mode; human-readable otherwise.
//!
//! Event taxonomy matches §8.2 of the design spec.

use crate::envelope::{ErrorBody, ErrorEnvelope, Meta, SuccessEnvelope, SCHEMA_VERSION};
use cache_core::error::UecmError;
use serde::Serialize;
use std::io::{self, Write};

/// All events emitted to stdout. Long-running tasks emit one event per stream item.
// JsonSchema feeds manifest::event_schema(). The `serde_json::Value` fields
// (metadata/summary/details) become permissive `{}` schemas (any JSON allowed).
#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    Started {
        task_type: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        task_id: Option<String>,
        #[serde(skip_serializing_if = "serde_json::Value::is_null")]
        metadata: serde_json::Value,
    },
    HostProbe {
        ip: String,
        winrm_open: bool,
        smb_open: bool,
        rpc_open: bool,
    },
    Spawned {
        pid: i64,
        log_path: String,
    },
    LogLine {
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        parsed_kind: Option<String>,
    },
    Progress {
        #[serde(skip_serializing_if = "Option::is_none")]
        pct: Option<f32>,
        label: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        current: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        total: Option<i64>,
    },
    ItemStarted {
        item_id: String,
        index: i64,
        total: i64,
    },
    ItemCompleted {
        item_id: String,
        index: i64,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    Finding {
        rule_id: String,
        severity: String,
        file_path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        section: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        key: Option<String>,
    },
    Cancelled {
        reason: String,
    },
    Error {
        code: String,
        message: String,
        #[serde(skip_serializing_if = "serde_json::Value::is_null")]
        details: serde_json::Value,
    },
    Completed {
        summary: serde_json::Value,
    },
}

/// Map `UecmError` to a stable string code for the `error` event.
///
/// Database / IO failures map to `environment_error` (same family as
/// Configuration) so automation can tell environment problems apart from
/// regular operation failures.
pub fn error_code(err: &UecmError) -> &'static str {
    match err {
        UecmError::InvalidInput(_) => "invalid_input",
        UecmError::OperationFailed(_) => "operation_failed",
        UecmError::PowerShell(_) => "powershell_failed",
        UecmError::Configuration(_) | UecmError::Database(_) | UecmError::Io(_) => {
            "environment_error"
        }
        UecmError::SshConnect(_) => "ssh_connect",
        UecmError::NodeScript { .. } => "node_script_failed",
        UecmError::Timeout(_) => "timeout",
        UecmError::ScriptStaging(_) => "script_staging_failed",
    }
}

/// Process exit code mapping (§6.3 of spec).
///
/// `Database` and `Io` errors share the exit code (3 = environment failure)
/// with `Configuration` — DB unwritable, ps-scripts missing, and similar I/O
/// issues are all "user needs to fix their environment" cases.
pub fn exit_code_for(err: &UecmError) -> i32 {
    match err {
        UecmError::InvalidInput(_) => 2,
        UecmError::Configuration(_) | UecmError::Database(_) | UecmError::Io(_) => 3,
        UecmError::PowerShell(_) => 4,
        UecmError::OperationFailed(_) => 1,
        UecmError::NodeScript { .. } => 4,
        UecmError::SshConnect(_) | UecmError::Timeout(_) | UecmError::ScriptStaging(_) => 3,
    }
}

/// Per-request envelope context (spec §4.1). Carries the canonical
/// `operation_id`, the request correlation id, and the dispatch start instant
/// so emitters can compute `meta.duration_ms` at finish time.
pub struct EnvelopeCtx {
    pub operation_id: String,
    pub request_id: String,
    pub started: std::time::Instant,
}
impl EnvelopeCtx {
    fn meta(&self) -> Meta {
        Meta { request_id: self.request_id.clone(), duration_ms: self.started.elapsed().as_millis(), timestamp: crate::envelope::now_iso8601() }
    }
    fn success(&self, data: serde_json::Value) -> serde_json::Value {
        serde_json::to_value(SuccessEnvelope { schema_version: SCHEMA_VERSION, status: "ok", operation_id: &self.operation_id, data, meta: self.meta() }).expect("EnvelopeCtx serialization is infallible")
    }
    fn error(&self, err: &UecmError) -> serde_json::Value {
        let body = ErrorBody { code: error_code(err).into(), exit_code: exit_code_for(err), message: err.to_string(), retryable: crate::envelope::retryable_for(err), details: serde_json::Value::Null };
        serde_json::to_value(ErrorEnvelope { schema_version: SCHEMA_VERSION, status: "error", operation_id: &self.operation_id, error: body, meta: self.meta() }).expect("EnvelopeCtx serialization is infallible")
    }
}
fn is_terminal(event: &Event) -> bool {
    matches!(event, Event::Completed{..} | Event::Cancelled{..} | Event::Error{..})
}

/// Object-safe emitter trait.
///
/// `emit_value` takes an already-serialized `serde_json::Value` so the trait
/// remains object-safe — generic methods cannot live on the trait directly or
/// `Box<dyn Emitter>` would not compile. Handlers should call `emit_result`
/// from the `EmitSerialize` extension trait below, which serializes for them.
pub trait Emitter {
    fn emit_event(&mut self, event: &Event) -> io::Result<()>;
    fn emit_value(&mut self, value: &serde_json::Value) -> io::Result<()>;
    fn emit_error(&mut self, err: &UecmError);
    /// Raw human-facing text line to stdout. JSON emitters ignore it
    /// (handlers must branch on `ctx.json_mode` and only call this in
    /// human mode). Default = no-op so NDJSON stays clean.
    fn emit_text(&mut self, _text: &str) -> io::Result<()> {
        Ok(())
    }
    /// 终结输出。JsonEmitter 在此吐出恰好一个 envelope；其它实现 no-op。
    fn finish(&mut self) -> io::Result<()> { Ok(()) }
}

/// Convenience generic method available on every `Emitter`, including
/// `Box<dyn Emitter>`. Provided as an extension trait with a blanket impl so
/// the underlying `Emitter` trait stays object-safe.
pub trait EmitSerialize: Emitter {
    fn emit_result<T: Serialize>(&mut self, value: &T) -> io::Result<()> {
        let v = serde_json::to_value(value)
            .map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;
        self.emit_value(&v)
    }
}

impl<E: Emitter + ?Sized> EmitSerialize for E {}

pub struct NdjsonEmitter<W: Write, E: Write = io::Stderr> {
    pub writer: W,
    pub error_writer: E,
    /// Tracks whether `emit_event` has written anything to `writer`. Used by
    /// `emit_error` to decide whether to emit a stdout `cancelled` stream
    /// terminator. One-shot JSON commands (`machine refresh 9999`) skip the
    /// terminator and keep stdout empty; stream commands (`machine scan`
    /// already emitted `started`) get a terminal marker so NDJSON consumers
    /// can detect end-of-stream.
    stream_started: bool,
    /// Set when a terminal event (`completed` / `cancelled` / `error`) has
    /// already been written to stdout. Suppresses a second terminator from
    /// `emit_error` so NDJSON consumers don't see `completed` then `cancelled`
    /// back-to-back (e.g. batch ops that summarize then return Err).
    stream_terminated: bool,
    /// Per-request envelope context (spec §4.1). When set, `emit_value` wraps
    /// the one-shot result in a `SuccessEnvelope`, `emit_event` decorates each
    /// stream item with `sequence`/`timestamp`/`request_id`/`schema_version`
    /// (+`final` on terminals), and `emit_error` writes an `ErrorEnvelope`.
    /// `None` keeps the legacy bare-event behavior (startup-error path).
    envelope: Option<EnvelopeCtx>,
    /// Monotonic per-stream event index, surfaced as `sequence` when an
    /// envelope is attached.
    sequence: u64,
}

impl<W: Write> NdjsonEmitter<W, io::Stderr> {
    /// Default constructor. Data events stream to `writer` (stdout in
    /// production); error envelopes go to process stderr per spec §4.
    pub fn new(writer: W) -> Self {
        Self {
            writer,
            error_writer: io::stderr(),
            stream_started: false,
            stream_terminated: false,
            envelope: None,
            sequence: 0,
        }
    }
}

impl<W: Write, E: Write> NdjsonEmitter<W, E> {
    /// Test / advanced use: pin both writers explicitly so error envelopes
    /// can be captured.
    pub fn with_error_writer(writer: W, error_writer: E) -> Self {
        Self {
            writer,
            error_writer,
            stream_started: false,
            stream_terminated: false,
            envelope: None,
            sequence: 0,
        }
    }

    /// Attach a per-request envelope context so structured `ndjson` output
    /// carries `sequence`/`request_id`/`schema_version` per event and wraps
    /// one-shot values in a `SuccessEnvelope`.
    pub fn with_envelope(mut self, ctx: EnvelopeCtx) -> Self { self.envelope = Some(ctx); self }
}

impl<W: Write, E: Write> Emitter for NdjsonEmitter<W, E> {
    fn emit_event(&mut self, event: &Event) -> io::Result<()> {
        let mut obj = serde_json::to_value(event)?;
        if let (Some(c), Some(map)) = (&self.envelope, obj.as_object_mut()) {
            map.insert("sequence".into(), serde_json::json!(self.sequence));
            map.insert("timestamp".into(), serde_json::json!(crate::envelope::now_iso8601()));
            map.insert("request_id".into(), serde_json::json!(c.request_id));
            map.insert("schema_version".into(), serde_json::json!(SCHEMA_VERSION));
            if is_terminal(event) { map.insert("final".into(), serde_json::json!(true)); }
        }
        self.sequence += 1;
        serde_json::to_writer(&mut self.writer, &obj)?;
        self.writer.write_all(b"\n")?;
        self.writer.flush()?;
        self.stream_started = true;
        // `Completed` / `Cancelled` / `Error` all mean "no more events". Once
        // any of them has been emitted, suppress a follow-up `cancelled` from
        // `emit_error` so NDJSON consumers never see two terminal events.
        // Handlers MUST NOT emit `Completed` while later steps could still
        // fail (see `pso collect`, which delays Completed until persist).
        if is_terminal(event) {
            self.stream_terminated = true;
        }
        Ok(())
    }

    fn emit_value(&mut self, value: &serde_json::Value) -> io::Result<()> {
        let payload = match &self.envelope { Some(c) => c.success(value.clone()), None => value.clone() };
        serde_json::to_writer(&mut self.writer, &payload)?;
        self.writer.write_all(b"\n")?;
        self.writer.flush()
    }

    fn emit_error(&mut self, err: &UecmError) {
        // Stream terminator only when a stream has already started AND has
        // not already terminated. One-shot JSON commands keep stdout empty;
        // batch commands that already emitted a `completed` summary before
        // returning Err must not double-terminate with `cancelled`.
        // Route through `emit_event` so the terminator is decorated like every
        // other stream event (sequence/timestamp/request_id/schema_version +
        // final:true) and `stream_terminated` is set there — never write the
        // synthetic event directly or it would land undecorated.
        if self.stream_started && !self.stream_terminated {
            let _ = self.emit_event(&Event::Cancelled {
                reason: err.to_string(),
            });
        }

        // Full error envelope to stderr per spec §4 always.
        let env = match &self.envelope {
            Some(c) => c.error(err),
            None => serde_json::json!({ "type":"error", "code": error_code(err), "message": err.to_string() }),
        };
        if serde_json::to_writer(&mut self.error_writer, &env).is_ok() {
            let _ = self.error_writer.write_all(b"\n");
            let _ = self.error_writer.flush();
        }
    }
}

pub struct HumanEmitter<W: Write, E: Write> {
    pub stdout: W,
    pub stderr: E,
    pub use_color: bool,
}

impl<W: Write, E: Write> HumanEmitter<W, E> {
    pub fn new(stdout: W, stderr: E, use_color: bool) -> Self {
        Self { stdout, stderr, use_color }
    }
}

impl<W: Write, E: Write> Emitter for HumanEmitter<W, E> {
    fn emit_event(&mut self, event: &Event) -> io::Result<()> {
        match event {
            Event::Started { task_type, .. } => {
                writeln!(self.stderr, "→ starting {}", task_type)?;
            }
            Event::HostProbe { ip, winrm_open, smb_open, rpc_open } => {
                let badges = format!(
                    "winrm={} smb={} rpc={}",
                    if *winrm_open { "✓" } else { "✗" },
                    if *smb_open { "✓" } else { "✗" },
                    if *rpc_open { "✓" } else { "✗" }
                );
                writeln!(self.stdout, "  {}  {}", ip, badges)?;
            }
            Event::Spawned { pid, log_path } => {
                writeln!(self.stderr, "→ spawned pid={} log={}", pid, log_path)?;
            }
            Event::LogLine { text, .. } => {
                writeln!(self.stderr, "  | {}", text)?;
            }
            Event::Progress { pct, label, current, total, .. } => {
                let suffix = match (current, total) {
                    (Some(c), Some(t)) => format!(" ({}/{})", c, t),
                    _ => String::new(),
                };
                match pct {
                    Some(p) => writeln!(self.stderr, "→ [{:>5.1}%] {}{}", p * 100.0, label, suffix)?,
                    None => writeln!(self.stderr, "→ {}{}", label, suffix)?,
                }
            }
            Event::ItemStarted { item_id, index, total } => {
                writeln!(self.stderr, "→ [{}/{}] {}", index + 1, total, item_id)?;
            }
            Event::ItemCompleted { item_id, ok, message, .. } => {
                let mark = if *ok { "✓" } else { "✗" };
                let suffix = message.as_deref().unwrap_or("");
                writeln!(self.stderr, "  {} {} {}", mark, item_id, suffix)?;
            }
            Event::Finding { rule_id, severity, file_path, section, key } => {
                writeln!(
                    self.stdout,
                    "  [{}] {} {} :: {} {}",
                    severity, rule_id, file_path,
                    section.as_deref().unwrap_or("-"),
                    key.as_deref().unwrap_or("-"),
                )?;
            }
            Event::Cancelled { reason } => {
                writeln!(self.stderr, "✗ cancelled: {}", reason)?;
            }
            Event::Error { code, message, .. } => {
                writeln!(self.stderr, "✗ error ({}): {}", code, message)?;
            }
            Event::Completed { summary } => {
                writeln!(self.stderr, "✓ done {}", summary)?;
            }
        }
        Ok(())
    }

    fn emit_value(&mut self, value: &serde_json::Value) -> io::Result<()> {
        // Default human rendering of arbitrary value: pretty JSON to stdout.
        // Individual handlers can take over with custom table rendering.
        let s = serde_json::to_string_pretty(value).unwrap_or_else(|_| "<unserializable>".into());
        writeln!(self.stdout, "{}", s)
    }

    fn emit_error(&mut self, err: &UecmError) {
        let _ = writeln!(self.stderr, "✗ error: {}", err);
    }

    fn emit_text(&mut self, text: &str) -> io::Result<()> {
        writeln!(self.stdout, "{}", text)?;
        self.stdout.flush()
    }
}

/// 单对象 JSON 输出（spec §3.5 的 `json`）。缓冲所有 emit，在 finish 吐出恰好一个
/// envelope；流事件收进 data.events，确保 `--output json` 永远是一个可被 jq 解析的对象。
pub struct JsonEmitter<W: Write, E: Write = io::Stderr> {
    writer: W,
    error_writer: E,
    envelope: EnvelopeCtx,
    /// All `emit_value`/`emit_result` payloads, accumulated losslessly. A
    /// handler may emit more than once (`deploy ddc` emits one value per
    /// `DeployEvent`); keeping a `Vec` ensures none are dropped. `finish()`
    /// collapses a lone value back to the bare one-shot shape.
    values: Vec<serde_json::Value>,
    events: Vec<serde_json::Value>,
    errored: bool,
    finished: bool,
}

impl<W: Write> JsonEmitter<W, io::Stderr> {
    pub fn new(writer: W, envelope: EnvelopeCtx) -> Self {
        Self { writer, error_writer: io::stderr(), envelope, values: Vec::new(), events: Vec::new(), errored: false, finished: false }
    }
}

impl<W: Write, E: Write> Emitter for JsonEmitter<W, E> {
    fn emit_event(&mut self, event: &Event) -> io::Result<()> {
        self.events.push(serde_json::to_value(event)?);
        Ok(())
    }
    fn emit_value(&mut self, value: &serde_json::Value) -> io::Result<()> {
        self.values.push(value.clone());
        Ok(())
    }
    fn emit_error(&mut self, err: &UecmError) {
        self.errored = true;
        let env = self.envelope.error(err);
        if serde_json::to_writer(&mut self.error_writer, &env).is_ok() {
            let _ = self.error_writer.write_all(b"\n");
            let _ = self.error_writer.flush();
        }
    }
    fn finish(&mut self) -> io::Result<()> {
        if self.finished { return Ok(()); }
        self.finished = true;
        if self.errored { return Ok(()); } // 错误已发 stderr，stdout 不发成功体
        let values = std::mem::take(&mut self.values);
        let events = std::mem::take(&mut self.events);
        let data = match (values.len(), events.is_empty()) {
            // 什么都没 emit（如 `system completion` 直写裸 shell 脚本到 stdout，
            // 绕过 emitter）-> finish no-op，避免在裸输出后再吐一个空 envelope 污染 stdout。
            (0, true) => return Ok(()),
            // ONE-SHOT: 恰好一个 value 且无事件 -> data 即裸 value（不包裹），
            // 保持 `v["data"]["version"]` 这类既有契约不变。
            (1, true) => values.into_iter().next().expect("len checked == 1"),
            // 纯流事件 collapse（无 value）-> data.events。
            (0, false) => serde_json::json!({ "events": events }),
            // 多 value，或 value+event 混发 -> 全部保留，谁都不丢。
            _ => serde_json::json!({ "results": values, "events": events }),
        };
        let payload = self.envelope.success(data);
        serde_json::to_writer(&mut self.writer, &payload)?;
        self.writer.write_all(b"\n")?;
        self.writer.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_ctx() -> EnvelopeCtx {
        EnvelopeCtx { operation_id: "system.version".into(), request_id: "rq".into(), started: std::time::Instant::now() }
    }

    #[test]
    fn ndjson_stream_events_carry_type_sequence_and_final() {
        let mut buf = Vec::new();
        {
            let mut e = NdjsonEmitter::new(&mut buf).with_envelope(env_ctx());
            e.emit_event(&Event::HostProbe{ ip:"1.1.1.1".into(), winrm_open:true, smb_open:false, rpc_open:false }).unwrap();
            e.emit_event(&Event::Completed{ summary: serde_json::json!({"n":1}) }).unwrap();
            e.finish().unwrap();
        }
        let s = String::from_utf8(buf).unwrap();
        let lines: Vec<&str> = s.trim_end().split('\n').collect();
        let l0: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(l0["type"], "host_probe");
        assert_eq!(l0["sequence"], 0);
        assert_eq!(l0["request_id"], "rq");
        let l1: serde_json::Value = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(l1["type"], "completed");
        assert_eq!(l1["final"], true);
    }

    #[test]
    fn ndjson_error_after_stream_started_emits_decorated_cancelled_terminator() {
        // A stream that has started and then errors must emit a `cancelled`
        // stdout terminator decorated like any other stream event (type +
        // sequence + final), not a bare undecorated object.
        let mut out = Vec::new();
        let mut err = Vec::new();
        {
            let mut e = NdjsonEmitter::with_error_writer(&mut out, &mut err).with_envelope(env_ctx());
            e.emit_event(&Event::Started { task_type: "scan".into(), task_id: None, metadata: serde_json::Value::Null }).unwrap();
            e.emit_error(&UecmError::Timeout("boom".into()));
        }
        let s = String::from_utf8(out).unwrap();
        let lines: Vec<&str> = s.trim_end().split('\n').collect();
        // started (seq 0) then cancelled terminator (seq 1).
        assert_eq!(lines.len(), 2, "stdout: {}", lines.join("|"));
        let term: serde_json::Value = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(term["type"], "cancelled");
        assert_eq!(term["sequence"], 1);
        assert_eq!(term["request_id"], "rq");
        assert_eq!(term["schema_version"], SCHEMA_VERSION);
        assert_eq!(term["final"], true);
        // ErrorEnvelope still goes to stderr.
        let env: serde_json::Value = serde_json::from_str(String::from_utf8(err).unwrap().trim_end()).unwrap();
        assert_eq!(env["status"], "error");
    }

    #[test]
    fn json_emitter_one_shot_is_single_success_envelope() {
        let mut buf = Vec::new();
        {
            let mut e = JsonEmitter::new(&mut buf, env_ctx());
            e.emit_value(&serde_json::json!({"version":"0.1.0"})).unwrap();
            e.finish().unwrap();
        }
        // 必须恰好一个 JSON 对象（整 buf 可被 jq/from_slice 一次解析）
        let v: serde_json::Value = serde_json::from_slice(&buf).unwrap();
        assert_eq!(v["status"], "ok");
        assert_eq!(v["operation_id"], "system.version");
        assert_eq!(v["data"]["version"], "0.1.0");
    }

    #[test]
    fn json_emitter_stream_collapses_to_single_object() {
        let mut buf = Vec::new();
        {
            let mut e = JsonEmitter::new(&mut buf, env_ctx());
            e.emit_event(&Event::HostProbe{ ip:"1.1.1.1".into(), winrm_open:true, smb_open:true, rpc_open:true }).unwrap();
            e.emit_event(&Event::Completed{ summary: serde_json::json!({"n":1}) }).unwrap();
            e.finish().unwrap();
        }
        // 仍是恰好一个对象；流事件收进 data.events
        let v: serde_json::Value = serde_json::from_slice(&buf).unwrap();
        assert_eq!(v["status"], "ok");
        assert_eq!(v["data"]["events"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn json_emitter_multiple_values_all_survive_in_results() {
        // Regression: `deploy ddc` emits one value per DeployEvent. The old
        // `data: Option<Value>` overwrote on every emit, keeping only the LAST.
        // All values must now survive losslessly under `data.results`.
        let mut buf = Vec::new();
        {
            let mut e = JsonEmitter::new(&mut buf, env_ctx());
            e.emit_value(&serde_json::json!({"step":1})).unwrap();
            e.emit_value(&serde_json::json!({"step":2})).unwrap();
            e.emit_value(&serde_json::json!({"step":3})).unwrap();
            e.finish().unwrap();
        }
        let v: serde_json::Value = serde_json::from_slice(&buf).unwrap();
        assert_eq!(v["status"], "ok");
        let results = v["data"]["results"].as_array().unwrap();
        assert_eq!(results.len(), 3);
        assert_eq!(results[0]["step"], 1);
        assert_eq!(results[1]["step"], 2);
        assert_eq!(results[2]["step"], 3);
    }

    #[test]
    fn json_emitter_value_and_event_mix_keeps_both() {
        // Regression: `zen enable` emits a one-shot result value AND a terminal
        // `Completed` event. The old finish() dropped the buffered events when
        // data was set (debug_assert would even panic). Both must survive.
        let mut buf = Vec::new();
        {
            let mut e = JsonEmitter::new(&mut buf, env_ctx());
            e.emit_value(&serde_json::json!({"ok_count":2})).unwrap();
            e.emit_event(&Event::Completed{ summary: serde_json::json!({"ok_count":2}) }).unwrap();
            e.finish().unwrap();
        }
        let v: serde_json::Value = serde_json::from_slice(&buf).unwrap();
        assert_eq!(v["status"], "ok");
        let results = v["data"]["results"].as_array().unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0]["ok_count"], 2);
        let events = v["data"]["events"].as_array().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["type"], "completed");
    }

    #[test]
    fn ndjson_emits_one_line_per_event() {
        let mut buf = Vec::new();
        {
            let mut emitter = NdjsonEmitter::new(&mut buf);
            emitter
                .emit_event(&Event::HostProbe {
                    ip: "192.168.10.20".into(),
                    winrm_open: true,
                    smb_open: true,
                    rpc_open: true,
                })
                .unwrap();
            emitter
                .emit_event(&Event::Completed {
                    summary: serde_json::json!({"hosts": 1}),
                })
                .unwrap();
        }
        let s = String::from_utf8(buf).unwrap();
        let lines: Vec<&str> = s.trim_end().split('\n').collect();
        assert_eq!(lines.len(), 2);
        let parsed: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(parsed["type"], "host_probe");
        assert_eq!(parsed["ip"], "192.168.10.20");
        assert_eq!(parsed["winrm_open"], true);
        assert_eq!(parsed["rpc_open"], true);
    }

    #[test]
    fn ndjson_omits_none_fields() {
        let mut buf = Vec::new();
        {
            let mut emitter = NdjsonEmitter::new(&mut buf);
            emitter
                .emit_event(&Event::LogLine {
                    text: "hello".into(),
                    parsed_kind: None,
                })
                .unwrap();
        }
        let s = String::from_utf8(buf).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(s.trim_end()).unwrap();
        assert!(parsed.get("parsed_kind").is_none());
    }

    #[test]
    fn error_event_uses_stable_code() {
        let err = UecmError::InvalidInput("bad".into());
        assert_eq!(error_code(&err), "invalid_input");
        assert_eq!(exit_code_for(&err), 2);
    }

    #[test]
    fn human_emits_host_probe_with_badges() {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        {
            let mut emitter = HumanEmitter::new(&mut stdout, &mut stderr, false);
            emitter
                .emit_event(&Event::HostProbe {
                    ip: "192.168.10.20".into(),
                    winrm_open: true,
                    smb_open: false,
                    rpc_open: true,
                })
                .unwrap();
        }
        let s = String::from_utf8(stdout).unwrap();
        assert!(s.contains("192.168.10.20"));
        assert!(s.contains("winrm=✓"));
        assert!(s.contains("smb=✗"));
        assert!(s.contains("rpc=✓"));
    }

    #[test]
    fn human_emit_text_writes_to_stdout() {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        {
            let mut emitter = HumanEmitter::new(&mut stdout, &mut stderr, false);
            emitter.emit_text("VERSION  PRIMARY").unwrap();
        }
        let s = String::from_utf8(stdout).unwrap();
        assert_eq!(s, "VERSION  PRIMARY\n");
    }

    #[test]
    fn ndjson_emit_text_is_noop() {
        let mut buf = Vec::new();
        {
            let mut emitter = NdjsonEmitter::new(&mut buf);
            emitter.emit_text("should not appear").unwrap();
        }
        assert!(buf.is_empty());
    }
}
