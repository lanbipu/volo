//! Shared `--yes` / `--dry-run` guard for destructive CLI commands.
//!
//! Spec §1 + §7 require:
//! - Destructive operations must take an explicit `--yes` flag (no implicit confirm).
//! - Destructive operations must support `--dry-run` to preview without side effect.
//!
//! Each destructive subcommand carries two booleans (`yes`, `dry_run`) and
//! calls [`check`] at the top of its handler. The handler then:
//! - returns early on [`Outcome::DryRun`] after emitting a plan event;
//! - performs the action on [`Outcome::Proceed`].

use crate::output::{Emitter, Event};
use cache_core::error::{UecmError, UecmResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// `--yes` was supplied; handler should perform the action.
    Proceed,
    /// `--dry-run` was supplied; handler should emit a plan and return Ok.
    DryRun,
}

/// Returns `Proceed` if `yes` is set, `DryRun` if `dry_run` is set.
///
/// If both are set, `dry_run` wins (safer default). If neither is set,
/// returns `InvalidInput` so the caller exits with code 2 + a stderr envelope.
pub fn check(yes: bool, dry_run: bool, op_name: &str) -> UecmResult<Outcome> {
    if dry_run {
        return Ok(Outcome::DryRun);
    }
    if !yes {
        return Err(UecmError::InvalidInput(format!(
            "{op_name} is destructive; pass --yes to confirm or --dry-run to preview"
        )));
    }
    Ok(Outcome::Proceed)
}

/// Emit a uniform "dry run plan" Completed event so consumers can parse the
/// planned action out of NDJSON.
pub fn emit_plan(emitter: &mut dyn Emitter, op: &str, details: serde_json::Value) {
    let summary = serde_json::json!({
        "dry_run": true,
        "operation": op,
        "details": details,
    });
    emitter.emit_event(&Event::Completed { summary }).ok();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dry_run_wins_over_yes() {
        assert_eq!(check(true, true, "op").unwrap(), Outcome::DryRun);
    }

    #[test]
    fn yes_alone_proceeds() {
        assert_eq!(check(true, false, "op").unwrap(), Outcome::Proceed);
    }

    #[test]
    fn dry_run_alone_returns_dry_run() {
        assert_eq!(check(false, true, "op").unwrap(), Outcome::DryRun);
    }

    #[test]
    fn neither_returns_invalid_input() {
        let err = check(false, false, "machine.delete").unwrap_err();
        assert!(matches!(err, UecmError::InvalidInput(_)));
        let msg = err.to_string();
        assert!(msg.contains("machine.delete"));
        assert!(msg.contains("--yes"));
        assert!(msg.contains("--dry-run"));
    }
}
