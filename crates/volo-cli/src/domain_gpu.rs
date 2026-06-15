//! `uecm-cli gpu <action>` handlers.

use crate::args::GpuAction;
use crate::output::EmitSerialize;
use crate::run::Ctx;
use cache_core::error::UecmResult;

pub fn handle(ctx: &mut Ctx<'_>, action: GpuAction) -> UecmResult<()> {
    match action {
        GpuAction::Matrix => matrix(ctx),
    }
}

fn matrix(ctx: &mut Ctx<'_>) -> UecmResult<()> {
    let db = ctx.require_db()?;
    let m = cache_core::core::gpu_consistency::build_matrix(db)?;
    ctx.emitter.emit_result(&m).ok();
    Ok(())
}
