//! `voloctl` entry point — unified VP CLI.
//!
//! step 2b 把 UECM 的 CLI 层平移进来，挂成顶层子命令组 `voloctl uecm <原命令...>`，
//! 为 step 3 的 `voloctl lmt ...` 预留同级命名空间。UECM 原本的命令树
//! (machine/ini/zen/...) 整体作为 `uecm` 子命令的 body，`args::Cli` 不动。
//!
//! Two-stage parse (UECM 契约，逐字保留语义，仅适配多出的 `uecm` 前缀):
//! 1. 从裸 argv 嗅探 structured-output 意图（`--json` 别名 + `--output`/`-o
//!    json|ndjson|stream-json`，外加 `AI_AGENT=1` env），决定 clap parse 失败时
//!    如何格式化（此时结构化的 `Cli` 还没解析出来）。`--json`/`--output` 是
//!    `global = true`，可出现在 `uecm` 前缀前后任意位置，故 token 扫描天然
//!    与前缀无关，无需特殊处理。
//! 2. 正式 parse 顶层 `voloctl` command（含 `uecm` 子命令）；失败时按 json_mode
//!    输出 JSON 错误信封到 stderr 并 exit 64 (sysexits.h EX_USAGE)，否则让 clap
//!    渲染原生 usage 并 exit 64。

pub mod args;
pub mod config_file;
pub mod stdin_input;
pub mod credential_args;
pub mod destructive;
pub mod host_args;
pub mod output;
pub mod run;
pub mod domain_system;
pub mod domain_machine;
pub mod domain_ssh;
pub mod domain_cred;
pub mod domain_secret;
pub mod domain_env;
pub mod domain_ini;
pub mod domain_share;
pub mod domain_project;
pub mod domain_health;
pub mod domain_gpu;
pub mod domain_ddc;
pub mod domain_pso;
pub mod domain_log;
pub mod domain_local_cache;
pub mod domain_deploy;
pub mod domain_zen;
pub mod envelope;
pub mod manifest;

// Re-export the emitter trait + the generic extension trait so domain handlers
// can `use crate::{Emitter, EmitSerialize}` in one line.
pub use output::{Emitter, EmitSerialize};

/// Crate-wide lock for tests that mutate process-global env vars (`UECM_*`).
/// Replicates the `ENV_TEST_LOCK` that lived in UECM's `uecm_lib` crate root:
/// the migrated `domain_zen` env tests still acquire `crate::ENV_TEST_LOCK` at
/// the top of any env-mutating test to serialize set/remove across modules.
#[cfg(test)]
pub(crate) static ENV_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

use clap::error::ErrorKind;
use clap::{CommandFactory, FromArgMatches};
use std::ffi::OsString;
use std::io::{self, Write};

use args::Cli;

/// 顶层 `voloctl` command:含 `uecm` 子命令组,body 是 UECM 的 `Cli` 命令树。
/// `Cli::command()` 仍返回原 UECM 树(name = "uecm-cli"),只是在这里被 reparent
/// 成名为 `uecm` 的子命令挂上去。manifest/schema/completion 仍直接调
/// `Cli::command()`,完全不受这层包装影响。
fn voloctl_command() -> clap::Command {
    let uecm = Cli::command().name("uecm");
    clap::Command::new("voloctl")
        .about("VP unified command-line interface")
        .subcommand_required(true)
        .arg_required_else_help(true)
        .subcommand(uecm)
}

fn main() {
    // Use args_os to tolerate non-UTF-8 paths (e.g. someone passes a binary
    // --db-path on Unix). `args()` would panic before clap can parse.
    let argv: Vec<OsString> = std::env::args_os().collect();
    // Sniff structured-output intent from raw argv so clap parse errors are
    // formatted as a JSON envelope when the caller asked for json/ndjson.
    // 全 token 扫描,与新增的 `uecm` 前缀无关(`--json`/`--output` 是 global)。
    let json_mode = argv.iter().enumerate().any(|(i, a)| {
        let s = a.as_os_str();
        s == "--json"
            || s == "--output=json" || s == "--output=ndjson" || s == "--output=stream-json"
            // Best-effort only, for error formatting — clap's canonical short
            // form is `-o json` (the `=` glued forms below aren't clap-valid
            // but cost nothing to recognize here).
            || s == "-o=json" || s == "-o=ndjson" || s == "-o=stream-json"
            || ((s == "--output" || s == "-o")
                && argv.get(i + 1).map(|n| {
                    n == "json" || n == "ndjson" || n == "stream-json"
                }).unwrap_or(false))
    });
    let json_mode = json_mode || std::env::var("AI_AGENT").map(|v| v == "1").unwrap_or(false);

    let top = voloctl_command();
    match top.try_get_matches_from(&argv) {
        Ok(matches) => {
            // `subcommand_required(true)` guarantees a subcommand matched. Today
            // only `uecm` exists; step 3 adds `lmt`. Reconstruct the UECM `Cli`
            // from the `uecm` submatches and hand off to the unchanged dispatch.
            match matches.subcommand() {
                Some(("uecm", sub)) => {
                    let cli = match Cli::from_arg_matches(sub) {
                        Ok(c) => c,
                        Err(e) => emit_parse_error(e, json_mode),
                    };
                    let code = run::run(cli);
                    std::process::exit(code);
                }
                // Unreachable while `uecm` is the only subcommand and
                // subcommand_required is set; future-proof for `lmt`.
                _ => {
                    let _ = writeln!(io::stderr(), "voloctl: no matching subcommand");
                    std::process::exit(64);
                }
            }
        }
        Err(e) => emit_parse_error(e, json_mode),
    }
}

/// Render a clap parse error consistently with the UECM contract:
/// `--help`/`--version` pass through (stdout, exit 0); everything else is a
/// usage error → exit 64, formatted as a JSON envelope when structured output
/// was requested. Never returns.
fn emit_parse_error(e: clap::Error, json_mode: bool) -> ! {
    // `--help` and `--version` are clap "errors" that print to stdout and exit
    // 0. Pass those through unchanged. Missing-subcommand / missing-required-arg
    // are real usage errors and go through the exit-64 path below so automation
    // can distinguish argv-shape failures (64) from handler-level
    // invalid_input (2).
    if matches!(e.kind(), ErrorKind::DisplayHelp | ErrorKind::DisplayVersion) {
        e.exit();
    }

    if json_mode {
        let payload = serde_json::json!({
            "schema_version": "1.0",
            "status": "error",
            "operation_id": "",
            "error": {
                "code": "usage_error",
                "exit_code": 64,
                "message": e.to_string(),
                "retryable": false,
                "clap_kind": format!("{:?}", e.kind()),
            },
            "meta": {
                "request_id": "",
                "duration_ms": 0,
                "timestamp": crate::envelope::now_iso8601(),
            }
        });
        let mut stderr = io::stderr().lock();
        let _ = serde_json::to_writer(&mut stderr, &payload);
        let _ = stderr.write_all(b"\n");
        std::process::exit(64);
    } else {
        // Reproduce clap's native rendering on stderr, then exit 64 so non-JSON
        // automation can still distinguish usage errors from runtime failures.
        let _ = writeln!(io::stderr(), "{}", e);
        std::process::exit(64);
    }
}
