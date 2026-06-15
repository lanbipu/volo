//! 输出 + 退出码 helper。
//!
//! 关键约定(对齐 `cli_spec` 的 JSON 约定):
//! - 成功 → stdout 单条 JSON envelope(`--json` 模式)/ 人类摘要(human 模式)。
//! - 失败 → stderr 单条 `ErrorEnvelope`(`--json` 模式)/ `error: <code> — <message>`
//!   (human 模式)。stdout 在失败时一律为空,便于 agent / pipeline 用
//!   `lmt foo > out.json` 时通过 "stdout 空 + 非零 exit code" 直接判定失败。
//! - 退出码由 [`volo_shared::exit_codes::from_api_error_code`] 派生,
//!   成功一律 0。

use crate::lmt::cli::OutputFormat;
use volo_shared::envelope::{ApiError, Envelope, ErrorEnvelope};
use volo_shared::exit_codes;
use serde::Serialize;
use std::io::Write;

/// 输出模式;由 `--output` / `--json` flag 触发。
#[derive(Debug, Clone, Copy)]
pub enum Mode {
    Human,
    Json,
    Ndjson,
}

impl Mode {
    /// 由 --output 值映射。
    pub fn from_format(fmt: OutputFormat) -> Self {
        match fmt {
            OutputFormat::Text => Mode::Human,
            OutputFormat::Json => Mode::Json,
            OutputFormat::Ndjson => Mode::Ndjson,
        }
    }
}

/// 构造一条 ndjson `result` 事件(单次命令的终态)。长任务将来可在前面插
/// `start` / `progress` 事件,此处只覆盖单结果场景。
pub fn result_event<T: Serialize>(data: &T) -> String {
    let ev = serde_json::json!({
        "type": "result",
        "sequence": 0,
        "final": true,
        "status": "ok",
        "schema_version": volo_shared::envelope::SCHEMA_VERSION,
        "data": data,
    });
    serde_json::to_string(&ev).expect("result event is serializable")
}

/// 成功输出。
///
/// - Json:序列化 `Envelope<T>` 到 stdout(单行紧凑 JSON,便于 pipeline 解析)。
/// - Ndjson:序列化单条 `result` 事件到 stdout。
/// - Human:调用方提供的 `summary` 闭包负责写 stdout,可以多行。
///
/// 返回值是退出码,统一 0。把 `summary` 失败也吞掉——CLI 写 stdout 出错通常
/// 意味着 broken pipe,这种场景没必要再上报 envelope。
pub fn ok<T: Serialize>(mode: Mode, data: T, summary: impl FnOnce(&T)) -> i32 {
    match mode {
        Mode::Json => {
            let env = Envelope::ok(data);
            let s = serde_json::to_string(&env).expect("Envelope is always serializable");
            let _ = writeln!(std::io::stdout(), "{s}");
        }
        Mode::Ndjson => {
            let s = result_event(&data);
            let _ = writeln!(std::io::stdout(), "{s}");
        }
        Mode::Human => {
            summary(&data);
        }
    }
    exit_codes::OK
}

/// 失败输出。stdout 保持空白;envelope / 错误信息一律走 stderr,这是
/// `cli_spec` 的 JSON 约定(成功 → stdout / 失败 → stderr)。
///
/// 退出码按 `error.code` 字符串映射;未知 code 落到 `UNKNOWN`。
pub fn err(mode: Mode, error: ApiError) -> i32 {
    let exit = exit_codes::from_api_error_code(&error.code);
    match mode {
        Mode::Json | Mode::Ndjson => {
            let env = ErrorEnvelope::from_error(error);
            let s = serde_json::to_string(&env).expect("ErrorEnvelope is always serializable");
            let _ = writeln!(std::io::stderr(), "{s}");
        }
        Mode::Human => {
            let _ = writeln!(std::io::stderr(), "error: {} — {}", error.code, error.message);
            if let Some(details) = &error.details {
                let _ = writeln!(std::io::stderr(), "details: {details}");
            }
        }
    }
    exit
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn ndjson_ok_emits_single_result_event_with_final_true() {
        // 用一个内存 buffer 替代 stdout 不方便(ok 直接写 stdout)。
        // 改为验证事件构造函数 result_event 的形状。
        let ev = result_event(&serde_json::json!({"foo": 1}));
        let v: Value = serde_json::from_str(&ev).unwrap();
        assert_eq!(v["type"], "result");
        assert_eq!(v["final"], true);
        assert_eq!(v["status"], "ok");
        assert_eq!(v["data"]["foo"], 1);
        assert!(v["sequence"].is_number());
    }
}
