//! Operations-table logging wrapper for the filesystem-DDC commands.
//!
//! The Zen / ddc-pak commands persist an `operations` row (start + finalize),
//! but the filesystem-DDC flow — the join/leave env-var write, the project-INI
//! backend-field write, and local-cache create — ran as plain command bodies,
//! so a failure left NO row in the operations table and no error trail to
//! analyze (the join error a user hit was invisible in the DB for exactly this
//! reason). This wraps those commands so each records a row: `ok` on success,
//! `err` + the exact error message on failure. Logging is best-effort and never
//! masks the real result — a failed start/finish is swallowed.

use cache_core::data::{operations as data_operations, Db};
use cache_core::error::UecmResult;
use tauri::State;

/// Run `f` inside an operations-table span: insert a `running` row, then finish
/// it `ok`/`err` with `invocation` (+ the error on failure) as `log_text`.
/// Mirrors the zen.rs `operations::start` + `finalize_op` pattern.
pub fn logged<T>(
    db: &Db,
    action_type: &str,
    targets: &[i64],
    invocation: &str,
    f: impl FnOnce() -> UecmResult<T>,
) -> UecmResult<T> {
    let op_id = data_operations::start(db, action_type, targets).ok();
    let result = f();
    if let Some(id) = op_id {
        let (status, log_text) = match &result {
            Ok(_) => ("ok", invocation.to_string()),
            Err(e) => ("err", format!("{invocation}\nerror: {e}")),
        };
        let _ = data_operations::finish(db, id, status, Some(&log_text));
    }
    result
}

/// Frontend-facing: persist a finished operation row in one shot. The shell's
/// `runCmd` calls this on the failure path so frontend-orchestrated operations
/// (share join/leave, etc.) that fail BEFORE any backend command runs — i.e.
/// the error never reaches a `logged(...)`-wrapped command — still leave a DB
/// error trail to analyze. Best-effort: a logging failure must not surface to
/// the UI as the operation's error, so the shell ignores this call's result.
#[tauri::command]
pub fn record_operation(
    db: State<'_, Db>,
    action_type: String,
    target_machines: Vec<i64>,
    status: String,
    log_text: String,
) -> UecmResult<()> {
    let id = data_operations::start(&db, &action_type, &target_machines)?;
    data_operations::finish(&db, id, &status, Some(&log_text))?;
    Ok(())
}
