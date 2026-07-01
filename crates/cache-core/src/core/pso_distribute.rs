//! PSO cache distribution wrapper over `core::pak_distribute`.

use crate::core::pak_distribute::{
    self, DistributeOutcome, DistributePlanItem, DistributeProfile,
};
use crate::data::{project_locations, Db, PsoCacheFile};
use crate::error::{UecmError, UecmResult};

pub type PsoDistributePlanItem = DistributePlanItem;
pub type PsoDistributeOutcome = DistributeOutcome;

#[allow(clippy::too_many_arguments)]
pub fn plan(
    db: &Db,
    source_host: &str,
    file: &PsoCacheFile,
    target_machine_ids: &[i64],
    named_share_unc: Option<&str>,
    source_smb_user: Option<String>,
    source_smb_pass: Option<String>,
) -> UecmResult<Vec<PsoDistributePlanItem>> {
    let source_location =
        project_locations::get_for_project_machine(db, file.project_id, file.source_machine_id)?
            .ok_or_else(|| UecmError::InvalidInput("source project location missing".into()))?;
    let mut items = pak_distribute::plan(
        &DistributeProfile::pso_cache(),
        db,
        file.source_machine_id,
        source_host,
        &source_location,
        target_machine_ids,
        file.project_id,
        named_share_unc,
        source_smb_user,
        source_smb_pass,
    )?;
    for item in &mut items {
        item.file_name = Some(file.file_name.clone());
    }
    Ok(items)
}

pub async fn preflight_one(item: &PsoDistributePlanItem) -> UecmResult<()> {
    let profile = DistributeProfile::pso_cache();
    pak_distribute::preflight_one_with_profile(&profile, item).await
}

pub async fn run_one(item: PsoDistributePlanItem) -> UecmResult<PsoDistributeOutcome> {
    let profile = DistributeProfile::pso_cache();
    pak_distribute::run_one_with_profile(&profile, item).await
}
