//! Top-level dispatch. Bin entry parses args, builds emitter, opens DB only
//! when the requested command needs it, hands off to domain.

use crate::args::{Cli, Domain, OutputFormat};
use crate::output::{Emitter, HumanEmitter, NdjsonEmitter, exit_code_for};
use crate::{domain_cred, domain_ddc, domain_deploy, domain_env, domain_gpu, domain_health, domain_ini, domain_local_cache, domain_machine, domain_project, domain_pso, domain_secret, domain_share, domain_ssh, domain_system, domain_zen};
use cache_core::data::Db;
use cache_core::error::UecmError;
use cache_core::startup;
use std::io::{self, Write};
use std::path::PathBuf;

pub struct Ctx<'a> {
    /// `None` for diagnostic / write-free commands (e.g. `system version`,
    /// `ssh package-bootstrap`). Handlers that need DB access must call
    /// `ctx.require_db()` and propagate the error.
    pub db: Option<Db>,
    /// The DB path the CLI would open / opened. Handlers MUST use this rather
    /// than re-resolving via `startup::resolve_db_path()`, otherwise CLI-level
    /// `--db-path` overrides become inconsistent between commands.
    pub db_path: PathBuf,
    pub emitter: Box<dyn Emitter + 'a>,
    pub json_mode: bool,
    /// Canonical operation identifier (spec §2.2 / §4.1). Set at dispatch time.
    pub operation_id: &'static str,
    /// Per-request UUID v4 correlation id (spec §4.1). Set at dispatch time.
    pub request_id: String,
    /// `--no-input`: refuse any implicit stdin / interactive prompt. Handlers
    /// that would otherwise block reading stdin (e.g. `secret set` without
    /// `--value`, `--pass-stdin`) must error with `InvalidInput` instead.
    pub no_input: bool,
}

impl<'a> Ctx<'a> {
    /// Convenience for DB-requiring handlers. Panics with a structured
    /// `UecmError` if `needs_db` was wrong — never panics in correct code.
    pub fn require_db(&self) -> Result<&Db, UecmError> {
        self.db.as_ref().ok_or_else(|| {
            UecmError::OperationFailed(
                "internal: this command requires a DB but Ctx was built DB-less".into(),
            )
        })
    }
}

/// Whether a parsed command actually needs SQLite to be open.
///
/// DB-free commands (system version / db-path / ps-dir, ssh package-bootstrap)
/// remain runnable even when the data directory is unwritable or the DB file
/// is broken. Per Codex review feedback on Task 1.4 / 2.1.
fn needs_db(cmd: &Domain) -> bool {
    use crate::args::{MachineAction, SystemAction, ZenAction};
    match cmd {
        // `machine scan` is a stateless network probe — no DB writes.
        // Everything else in the Machine domain reads or writes tables.
        Domain::Machine { action } => !matches!(action, MachineAction::Scan { .. }),
        // `system echo` and the path-printing variants don't open DB;
        // only `migrate-db` does.
        Domain::System { action } => matches!(action, SystemAction::MigrateDb),
        // `ssh probe` spawns ssh; `ssh package-bootstrap` touches the keystore +
        // file packager. Neither needs SQLite.
        Domain::Ssh { .. } => false,
        // `secret` talks only to the file-backed SecretStore; no DB.
        Domain::Secret { .. } => false,
        // Phase 2 domains (cred/env/ini/share) — all will require DB for now.
        Domain::Cred { .. } => true,
        Domain::Env { .. } => true,
        Domain::Ini { .. } => true,
        Domain::Share { .. } => true,
        Domain::Project { .. } => true,
        Domain::Health { .. } => true,
        Domain::Gpu { .. } => true,
        Domain::Ddc { .. } => true,
        Domain::Pso { .. } => true,
        Domain::Log { .. } => true,
        Domain::LocalCache { .. } => true,
        Domain::Deploy { .. } => true,
        // Most zen commands need DB (endpoints / probes / cache_stats /
        // baselines / binary inventory rows). Exception: `zen verify-rules`
        // is a pure yaml-resolver in the resolve-only mode — no DB access.
        // Codex P2 fix from T4.5 review: forcing DB-open here makes the
        // command unusable when the data dir is read-only or the SQLite
        // file is broken, even though verify-rules only needs the embedded
        // yaml.
        //
        // T4.4 added `--run-editor` which DOES need DB (machine lookup +
        // operations row). Re-enable DB-open for that branch only.
        Domain::Zen { action } => match action {
            ZenAction::VerifyRules { run_editor, .. } => *run_editor,
            _ => true,
        },
        Domain::Manifest => false,
    }
}

pub fn run(cli: Cli) -> i32 {
    // Load --config defaults (explicit CLI flags still win).
    let file_cfg = match &cli.config {
        Some(p) => match crate::config_file::load(p) {
            Ok(c) => c,
            Err(e) => return finish_error(&e, startup_error_is_json(&cli)),
        },
        None => crate::config_file::FileConfig::default(),
    };
    let mut cli = cli; // shadow as mutable to apply config fallbacks
    if cli.db_path.is_none() {
        cli.db_path = file_cfg.db_path.clone();
    }
    if cli.log_level == "warn" {
        // "warn" is the clap default; treat as "not explicitly set". Tradeoff:
        // an explicit `--log-level warn` is indistinguishable from the default,
        // so a config `log_level` will win in that one edge case (acceptable
        // per spec — both yield identical behavior anyway).
        if let Some(lvl) = &file_cfg.log_level {
            cli.log_level = lvl.clone();
        }
    }
    if cli.output.is_none() && !cli.json {
        if let Some(out) = file_cfg.output.as_deref() {
            cli.output = match out {
                "text" => Some(crate::args::OutputFormat::Text),
                "json" => Some(crate::args::OutputFormat::Json),
                "ndjson" | "stream-json" => Some(crate::args::OutputFormat::Ndjson),
                _ => {
                    tracing::warn!("config: unknown output value {:?}, ignoring", out);
                    None
                }
            };
        }
    }

    // tracing init
    let level = crate::args::effective_log_level(&cli.log_level, cli.verbose, cli.quiet);
    let filter = tracing_subscriber::EnvFilter::try_new(&level)
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(io::stderr)
        .try_init();

    // DB path resolves cheaply (no I/O beyond create_dir_all on default path).
    // Doing it unconditionally keeps `system db-path` working without DB.
    let db_path = match cli.db_path.clone() {
        Some(p) => PathBuf::from(p),
        None => match startup::resolve_db_path() {
            Ok(p) => p,
            Err(e) => return finish_error(&e, startup_error_is_json(&cli)),
        },
    };

    // Only open + migrate the DB if the chosen command actually uses it.
    let db = if needs_db(&cli.command) {
        match startup::open_and_migrate_db(&db_path) {
            Ok(db) => Some(db),
            Err(e) => return finish_error(&e, startup_error_is_json(&cli)),
        }
    } else {
        None
    };

    // Compute per-request envelope fields (spec §2.2 / §4.1) before emitter construction.
    // `started` is consumed by Task 5's envelope-aware emitter.
    let operation_id = crate::manifest::operation_id_for(&cli.command);
    let request_id = crate::envelope::gen_request_id();
    let started = std::time::Instant::now();

    // Emitter selection (spec §3.5). text -> human; json/ndjson -> NDJSON emitter.
    // True single-object buffering for `json` (vs streamed `ndjson`) is refined in
    // the P1 envelope plan; here both structured modes share the NDJSON emitter.
    let fmt = cli.resolved_output();
    let json_mode = !matches!(fmt, OutputFormat::Text);
    let stdout = io::stdout();
    let stderr = io::stderr();
    let emitter: Box<dyn Emitter> = match fmt {
        OutputFormat::Text => {
            let color = crate::args::use_color(
                cli.no_color,
                atty::is(atty::Stream::Stdout),
                std::env::var_os("NO_COLOR").is_some(),
            );
            Box::new(HumanEmitter::new(stdout.lock(), stderr.lock(), color))
        }
        OutputFormat::Ndjson => {
            let env = crate::output::EnvelopeCtx { operation_id: operation_id.to_string(), request_id: request_id.clone(), started };
            Box::new(NdjsonEmitter::new(stdout.lock()).with_envelope(env))
        }
        OutputFormat::Json => {
            let env = crate::output::EnvelopeCtx { operation_id: operation_id.to_string(), request_id: request_id.clone(), started };
            Box::new(crate::output::JsonEmitter::new(stdout.lock(), env))
        }
    };

    let mut ctx = Ctx { db, db_path, emitter, json_mode, operation_id, request_id, no_input: cli.no_input };

    let result = match cli.command {
        Domain::System { action } => domain_system::handle(&mut ctx, action),
        Domain::Machine { action } => domain_machine::handle(&mut ctx, action),
        Domain::Ssh { action } => domain_ssh::handle(&mut ctx, action),
        Domain::Cred { action } => domain_cred::handle(&mut ctx, action),
        Domain::Secret { action } => domain_secret::handle(&mut ctx, action),
        Domain::Env { action } => domain_env::handle(&mut ctx, action),
        Domain::Ini { action } => domain_ini::handle(&mut ctx, action),
        Domain::Share { action } => domain_share::handle(&mut ctx, action),
        Domain::Project { action } => domain_project::handle(&mut ctx, action),
        Domain::Health { action } => domain_health::handle(&mut ctx, action),
        Domain::Gpu { action } => domain_gpu::handle(&mut ctx, action),
        Domain::Ddc { action } => domain_ddc::handle(&mut ctx, action),
        Domain::Pso { action } => domain_pso::handle(&mut ctx, action),
        Domain::Log { action } => crate::domain_log::handle(&mut ctx, action),
        Domain::LocalCache { action } => domain_local_cache::handle(&mut ctx, action),
        Domain::Deploy { action } => domain_deploy::handle(&mut ctx, action),
        Domain::Zen { action } => domain_zen::handle(&mut ctx, action),
        Domain::Manifest => {
            ctx.emitter.emit_value(&crate::manifest::manifest_json()).ok();
            Ok(())
        }
    };

    match result {
        Ok(()) => { let _ = ctx.emitter.finish(); 0 }
        Err(e) => {
            ctx.emitter.emit_error(&e);
            let _ = ctx.emitter.finish();
            exit_code_for(&e)
        }
    }
}

/// Whether startup-phase errors (db-path resolve / db open, before the emitter
/// exists) should be rendered as JSON. Honors `--output json|ndjson` and the
/// `--json` alias via the resolved format, not just the raw `--json` bool.
fn startup_error_is_json(cli: &Cli) -> bool {
    !matches!(cli.resolved_output(), crate::args::OutputFormat::Text)
}

fn finish_error(err: &UecmError, json: bool) -> i32 {
    if json {
        // Startup-phase failures (db-path resolve / db open / `--config` load)
        // happen BEFORE the envelope-aware emitter is built, so we can't reuse
        // it. Emit the full ErrorEnvelope inline to stderr (spec §4), mirroring
        // the usage-error path in `bin/uecm-cli.rs`. `operation_id` is unknown
        // this early, so it is empty.
        let payload = serde_json::json!({
            "schema_version": crate::envelope::SCHEMA_VERSION,
            "status": "error",
            "operation_id": "",
            "error": {
                "code": crate::output::error_code(err),
                "exit_code": exit_code_for(err),
                "message": err.to_string(),
                "retryable": crate::envelope::retryable_for(err),
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
        let _ = stderr.flush();
    } else {
        let _ = writeln!(io::stderr(), "✗ {}", err);
    }
    exit_code_for(err)
}
