//! `voloctl` entry point — unified VP CLI.
//!
//! step 2b 把 Volo 的 Cache/DDC/Zen CLI 层平移进来，挂成顶层子命令组
//! `voloctl cache <原命令...>`，为 step 3 的 `voloctl lmt ...` 预留同级命名空间。
//! 原本的命令树 (machine/ini/zen/...) 整体作为 `cache` 子命令的 body，
//! `args::Cli` 不动。
//!
//! Two-stage parse (逐字保留语义，仅适配多出的 `cache` 前缀):
//! 1. 从裸 argv 嗅探 structured-output 意图（`--json` 别名 + `--output`/`-o
//!    json|ndjson|stream-json`，外加 `AI_AGENT=1` env），决定 clap parse 失败时
//!    如何格式化（此时结构化的 `Cli` 还没解析出来）。`--json`/`--output` 是
//!    `global = true`，可出现在 `cache` 前缀前后任意位置，故 token 扫描天然
//!    与前缀无关，无需特殊处理。
//! 2. 正式 parse 顶层 `voloctl` command（含 `cache` 子命令）；失败时按 json_mode
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
// step 3c: LMT's CLI layer, platformed as the `lmt` subcommand group (parallel
// to `cache`). Its clap tree + envelope/dispatch are kept intact under `lmt::`.
pub mod lmt;
/// nDisplay output runtime (`voloctl output show|start|stop|play-sequence|…`).
pub mod ndisplay_output;

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

/// Subcommand names used to mount + dispatch the two clap trees in
/// `voloctl_command()`. Single source of truth so the mount, the
/// `matches.subcommand()` arm, and `argv_targets_lmt`'s token scan can't
/// drift out of sync with each other.
const CACHE_SUBCOMMAND: &str = "cache";
const LMT_SUBCOMMAND: &str = "lmt";
const OUTPUT_SUBCOMMAND: &str = "output";

/// 顶层 `voloctl` command:含 `cache` 子命令组,body 是 Volo Cache 的 `Cli` 命令树。
/// `Cli::command()` 直接以 name = "cache" 定义,这里只是把它挂到顶层 `voloctl`
/// 下面。manifest/schema/completion 仍直接调 `Cli::command()`,完全不受这层
/// 包装影响。
fn voloctl_command() -> clap::Command {
    let cache = Cli::command().name(CACHE_SUBCOMMAND);
    // step 3c: mount LMT's clap tree as a sibling subcommand `lmt`. Like the
    // `cache` reparent above, `lmt::cli::Cli::command()` returns the original
    // LMT tree (name = "lmt"); renaming is a no-op but kept explicit for parity.
    let lmt = lmt::cli::Cli::command().name(LMT_SUBCOMMAND);
    let output = ndisplay_output::Cli::command().name(OUTPUT_SUBCOMMAND);
    clap::Command::new("voloctl")
        .about("VP unified command-line interface")
        .subcommand_required(true)
        .arg_required_else_help(true)
        .subcommand(cache)
        .subcommand(lmt)
        .subcommand(output)
}

fn main() {
    // The combined cache+lmt clap tree overflows the default 1 MiB main-thread
    // stack on Windows debug builds (`--help` alone crashed with "thread 'main'
    // has overflowed its stack"). Run the real CLI on a thread with an explicit
    // 16 MiB stack; `cli_main` exits the process itself, so join() only returns
    // if it panicked.
    let handle = std::thread::Builder::new()
        .name("voloctl-cli".into())
        .stack_size(16 * 1024 * 1024)
        .spawn(cli_main)
        .expect("failed to spawn voloctl cli thread");
    match handle.join() {
        Ok(()) => std::process::exit(0),
        Err(_) => std::process::exit(101),
    }
}

fn cli_main() {
    // Use args_os to tolerate non-UTF-8 paths (e.g. someone passes a binary
    // --db-path on Unix). `args()` would panic before clap can parse.
    let argv: Vec<OsString> = std::env::args_os().collect();
    // Sniff structured-output intent from raw argv so clap parse errors are
    // formatted as a JSON envelope when the caller asked for json/ndjson.
    // 全 token 扫描,与新增的 `cache` 前缀无关(`--json`/`--output` 是 global)。
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
            // only `cache` exists; step 3 adds `lmt`. Reconstruct the `Cli`
            // from the `cache` submatches and hand off to the unchanged dispatch.
            match matches.subcommand() {
                Some((CACHE_SUBCOMMAND, sub)) => {
                    let cli = match Cli::from_arg_matches(sub) {
                        Ok(c) => c,
                        Err(e) => emit_parse_error(e, json_mode),
                    };
                    let code = run::run(cli);
                    std::process::exit(code);
                }
                // step 3c: `lmt` group. Reconstruct the LMT `Cli` from the
                // `lmt` submatches and hand to LMT's own dispatch, preserving
                // its envelope / exit-code contract verbatim. A from_arg_matches
                // failure here is formatted with LMT's invalid_input envelope
                // (its native parse-error contract) rather than the cache one.
                Some((LMT_SUBCOMMAND, sub)) => {
                    let cli = match lmt::cli::Cli::from_arg_matches(sub) {
                        Ok(c) => c,
                        Err(e) => emit_lmt_parse_error(e, json_mode),
                    };
                    let code = lmt::commands::dispatch(cli);
                    std::process::exit(code);
                }
                Some((OUTPUT_SUBCOMMAND, sub)) => {
                    let cli = match ndisplay_output::Cli::from_arg_matches(sub) {
                        Ok(c) => c,
                        Err(e) => emit_parse_error(e, json_mode),
                    };
                    let code = ndisplay_output::dispatch(cli);
                    std::process::exit(code);
                }
                // Unreachable while subcommand_required is set.
                _ => {
                    let _ = writeln!(io::stderr(), "voloctl: no matching subcommand");
                    std::process::exit(64);
                }
            }
        }
        // Top-level parse failure (e.g. an unknown flag like `--bogus`, or a bad
        // value) errors *before* `matches.subcommand()` can route it. Detect
        // whether the failing argv targeted the `lmt` subtree and, if so, format
        // the error with LMT's native `invalid_input`/exit-2 envelope instead of
        // cache's `usage_error`/exit-64. Otherwise fall back to the cache path.
        //
        // FIX (review #2): without this, `voloctl lmt reconstruct --bogus --json`
        // leaked the cache `usage_error` envelope (exit 64). The post-match
        // `from_arg_matches` arm already used `emit_lmt_parse_error`, but a clap
        // tokenization error never reaches it.
        Err(e) => {
            if argv_targets_lmt(&argv) {
                emit_lmt_parse_error(e, json_mode)
            } else {
                emit_parse_error(e, json_mode)
            }
        }
    }
}

/// True if the first positional token in `argv` (the subcommand name) is `lmt`.
/// Scans past the program name and any leading `global` flags (`--json`,
/// `--output <v>`, `-o <v>`) so a flag before the subcommand doesn't mask it.
/// Used only to pick the right parse-error envelope when the top-level clap
/// parse fails before the subcommand can be matched.
fn argv_targets_lmt(argv: &[OsString]) -> bool {
    let mut iter = argv.iter().skip(1); // skip argv[0] = program name
    while let Some(tok) = iter.next() {
        let s = tok.to_string_lossy();
        if s == "--output" || s == "-o" {
            // value-taking global flag: skip its value too.
            iter.next();
            continue;
        }
        if s.starts_with('-') {
            // any other flag (incl. `--json`, `--output=...`, `-o=...`): skip.
            continue;
        }
        // first non-flag token is the subcommand name.
        return s == LMT_SUBCOMMAND;
    }
    false
}

/// Render a clap parse error consistently with the cache-tree contract:
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

/// LMT's native parse-error contract (from its standalone `main`): `--help` /
/// `--version` pass through; a real argv error under `--json` becomes an
/// `invalid_input` ErrorEnvelope via LMT's own `output::err`; otherwise clap's
/// native rendering. Kept separate from `emit_parse_error` so the `lmt` group
/// preserves LMT's envelope shape (distinct from cache's usage_error envelope).
/// Never returns.
fn emit_lmt_parse_error(e: clap::Error, json_mode: bool) -> ! {
    if matches!(e.kind(), ErrorKind::DisplayHelp | ErrorKind::DisplayVersion) {
        e.exit();
    }
    if json_mode {
        let api = volo_shared::envelope::ApiError::new(
            volo_shared::envelope::error_codes::INVALID_INPUT,
            format!("argument parse error: {e}"),
        );
        let exit = lmt::output::err(lmt::output::Mode::Json, api);
        std::process::exit(exit);
    } else {
        let _ = writeln!(io::stderr(), "{}", e);
        std::process::exit(64);
    }
}
