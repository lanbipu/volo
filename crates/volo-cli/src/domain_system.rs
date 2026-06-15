//! `voloctl uecm system <action>` handlers.

use crate::args::SystemAction;
use crate::output::Event;
use crate::run::Ctx;
use crate::EmitSerialize;   // brings emit_result(&T) into scope on dyn Emitter
use cache_core::error::UecmResult;
use cache_core::startup;
use serde::Serialize;

#[derive(Serialize, schemars::JsonSchema)]
pub struct VersionInfo {
    pub binary: &'static str,
    pub version: &'static str,
}

#[derive(Serialize, schemars::JsonSchema)]
pub struct PathInfo {
    pub path: String,
}

pub fn handle(ctx: &mut Ctx<'_>, action: SystemAction) -> UecmResult<()> {
    match action {
        SystemAction::Version => version(ctx),
        SystemAction::DbPath => db_path(ctx),
        SystemAction::PsDir => ps_dir(ctx),
        SystemAction::MigrateDb => migrate_db(ctx),
        SystemAction::Echo { message } => echo(ctx, &message),
        SystemAction::Schema => schema(ctx),
        SystemAction::ExitCodes => exit_codes(ctx),
        SystemAction::Completion { shell } => completion(ctx, shell),
    }
}

fn version(ctx: &mut Ctx<'_>) -> UecmResult<()> {
    let info = VersionInfo { binary: "voloctl uecm", version: env!("CARGO_PKG_VERSION") };
    ctx.emitter.emit_result(&info).ok();
    Ok(())
}

fn db_path(ctx: &mut Ctx<'_>) -> UecmResult<()> {
    // Report the path the CLI actually opened, respecting `--db-path` / `UECM_DB_PATH`.
    let info = PathInfo { path: ctx.db_path.to_string_lossy().into() };
    ctx.emitter.emit_result(&info).ok();
    Ok(())
}

fn ps_dir(ctx: &mut Ctx<'_>) -> UecmResult<()> {
    let path = startup::resolve_ps_script_dir();
    let info = PathInfo { path: path.to_string_lossy().into() };
    ctx.emitter.emit_result(&info).ok();
    Ok(())
}

fn migrate_db(ctx: &mut Ctx<'_>) -> UecmResult<()> {
    // Re-runs migration on the SAME DB the CLI opened (no path re-resolution).
    // open_and_migrate_db is idempotent so running here is a no-op if startup already ran.
    let _ = startup::open_and_migrate_db(&ctx.db_path)?;
    let summary = serde_json::json!({ "migrated": true, "path": ctx.db_path.to_string_lossy() });
    ctx.emitter.emit_event(&Event::Completed { summary }).ok();
    Ok(())
}

fn echo(ctx: &mut Ctx<'_>, message: &str) -> UecmResult<()> {
    let result: serde_json::Value = cache_core::core::powershell::run_json(
        &cache_core::core::powershell::script_path("test-echo.ps1"),
        &["-Message", message],
    )?;
    ctx.emitter.emit_value(&result).ok();
    Ok(())
}

fn schema(ctx: &mut Ctx<'_>) -> UecmResult<()> {
    use clap::CommandFactory;
    let cmd = crate::args::Cli::command();
    let tree = command_to_json(&cmd);
    let payload = serde_json::json!({
        "binary": "voloctl uecm",
        "version": env!("CARGO_PKG_VERSION"),
        "spec_version": 1,
        "command_tree": tree,
        "exit_codes": exit_code_table(),
        "error_codes": error_code_table(),
    });
    ctx.emitter.emit_value(&payload).ok();
    Ok(())
}

fn exit_codes(ctx: &mut Ctx<'_>) -> UecmResult<()> {
    let payload = serde_json::json!({
        "exit_codes": exit_code_table(),
        "error_codes": error_code_table(),
    });
    ctx.emitter.emit_value(&payload).ok();
    Ok(())
}

/// Documented exit-code table. Mirrors `cli::output::exit_code_for` plus the
/// clap usage-error code (64) emitted from the bin entry point.
fn exit_code_table() -> serde_json::Value {
    serde_json::json!([
        {"code": 0,  "name": "ok",                "meaning": "success"},
        {"code": 1,  "name": "operation_failed",  "meaning": "runtime business-logic failure"},
        {"code": 2,  "name": "invalid_input",     "meaning": "user-provided runtime data invalid (e.g. unknown id, bad cidr)"},
        {"code": 3,  "name": "environment_error", "meaning": "configuration / database / IO problem the user must fix"},
        {"code": 4,  "name": "powershell_failed", "meaning": "remote PowerShell sidecar invocation failed"},
        {"code": 64, "name": "usage_error",       "meaning": "argv malformed: missing required flag, unknown subcommand, mutex violation (sysexits.h EX_USAGE)"},
    ])
}

/// Documented `--json` error-envelope `code` field values.
fn error_code_table() -> serde_json::Value {
    serde_json::json!([
        {"code": "invalid_input",     "exit": 2,  "source": "handler validation"},
        {"code": "operation_failed",  "exit": 1,  "source": "handler runtime failure"},
        {"code": "environment_error", "exit": 3,  "source": "config / database / IO"},
        {"code": "powershell_failed", "exit": 4,  "source": "remote PowerShell"},
        {"code": "usage_error",       "exit": 64, "source": "clap argv parse"},
    ])
}

fn completion(_ctx: &mut Ctx<'_>, shell: clap_complete::Shell) -> UecmResult<()> {
    use clap::CommandFactory;
    let mut cmd = crate::args::Cli::command();
    let bin = cmd.get_name().to_string();
    // 补全脚本是 shell 源码，不是结构化数据——直接写裸 stdout，不走 envelope。
    let mut out: Vec<u8> = Vec::new();
    clap_complete::generate(shell, &mut cmd, bin, &mut out);
    use std::io::Write;
    let _ = std::io::stdout().write_all(&out);
    Ok(())
}

fn command_to_json(cmd: &clap::Command) -> serde_json::Value {
    let args: Vec<serde_json::Value> = cmd
        .get_arguments()
        .filter(|a| a.get_id().as_str() != "help" && a.get_id().as_str() != "version")
        .map(arg_to_json)
        .collect();
    let subs: Vec<serde_json::Value> = cmd
        .get_subcommands()
        .filter(|s| s.get_name() != "help")
        .map(command_to_json)
        .collect();
    serde_json::json!({
        "name": cmd.get_name(),
        "about": cmd.get_about().map(|s| s.to_string()),
        "args": args,
        "subcommands": subs,
    })
}

fn arg_to_json(arg: &clap::Arg) -> serde_json::Value {
    let value_names: Option<Vec<String>> = arg
        .get_value_names()
        .map(|vs| vs.iter().map(|v| v.to_string()).collect());
    serde_json::json!({
        "id": arg.get_id().as_str(),
        "long": arg.get_long(),
        "short": arg.get_short(),
        "help": arg.get_help().map(|s| s.to_string()),
        "required": arg.is_required_set(),
        "positional": arg.is_positional(),
        "takes_value": arg.get_action().takes_values(),
        "value_names": value_names,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::output::{Emitter, NdjsonEmitter};
    use cache_core::data::open_in_memory;

    #[test]
    fn test_version_info() {
        // Sanity check: VersionInfo should serialize with correct fields.
        let info = VersionInfo { binary: "voloctl uecm", version: "0.1.0" };
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(json["binary"], "voloctl uecm");
        assert_eq!(json["version"], "0.1.0");
    }

    #[test]
    fn test_path_info() {
        // Sanity check: PathInfo should serialize correctly.
        let info = PathInfo { path: "/some/path".to_string() };
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(json["path"], "/some/path");
    }

    #[cfg(not(windows))]
    #[test]
    fn echo_returns_powershell_error_on_non_windows() {
        let db = open_in_memory().unwrap();
        {
            let mut conn = db.lock().unwrap();
            cache_core::data::schema::migrate(&mut conn).unwrap();
        }
        let mut buf: Vec<u8> = Vec::new();
        let emitter: Box<dyn Emitter> = Box::new(NdjsonEmitter::new(&mut buf));
        let mut ctx = Ctx {
            db: Some(db),
            db_path: std::path::PathBuf::from(":memory:"),
            emitter,
            json_mode: true,
            operation_id: "system.echo",
            request_id: "test-req".into(),
            no_input: false,
        };
        let result = echo(&mut ctx, "hello");
        assert!(matches!(result, Err(cache_core::error::UecmError::PowerShell(_))));
    }
}
