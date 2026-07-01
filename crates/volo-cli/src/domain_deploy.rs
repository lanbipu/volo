//! `voloctl cache deploy <action>` handlers.
use crate::args::DeployAction;
use crate::destructive::{self, Outcome};
use crate::EmitSerialize;
use crate::run::Ctx;
use cache_core::core::deploy_workflow::{self, DeployEvent, DeployPlan, RunOptions};
use cache_core::error::{VoloError, VoloResult};

pub fn handle(ctx: &mut Ctx<'_>, action: DeployAction) -> VoloResult<()> {
    match action {
        DeployAction::Ddc { plan, stop_on_failure, yes, dry_run, cred } => {
            let body = std::fs::read_to_string(&plan).map_err(|e| {
                VoloError::OperationFailed(format!("read plan {}: {}", plan.display(), e))
            })?;
            let mut p: DeployPlan = serde_json::from_str(&body)
                .map_err(|e| VoloError::InvalidInput(format!("bad plan: {}", e)))?;
            // DESIGN-2: enforce feature-gated required fields (resolution /
            // editor_exe) only when the corresponding feature is enabled.
            p.validate()?;

            let outcome = destructive::check(yes, dry_run, "deploy.ddc")?;
            let db = ctx.require_db()?.clone();
            cred.preflight(&db)?;
            if outcome == Outcome::DryRun {
                destructive::emit_plan(
                    ctx.emitter.as_mut(),
                    "deploy.ddc",
                    serde_json::json!({
                        "steps": deploy_workflow::plan_steps(&p),
                        "source_machine_id": p.source_machine_id,
                        "target_machine_ids": p.target_machine_ids
                    }),
                );
                return Ok(());
            }
            // SSH key auth: deploy steps take no operator credential. preflight
            // validates flags without reading DPAPI/stdin for a discarded cred.
            cred.preflight(&db)?;
            deploy_workflow::run_plan(
                &db,
                &mut p,
                None,
                RunOptions { stop_on_step_failure: stop_on_failure },
                &mut |e: DeployEvent| {
                    ctx.emitter.emit_result(&e).ok();
                },
            );
            Ok(())
        }
    }
}
