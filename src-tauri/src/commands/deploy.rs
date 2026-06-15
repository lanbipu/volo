use cache_core::core::deploy_workflow::{self, DeployEvent, DeployPlan, DeployStep, RunOptions};
use cache_core::data::{credentials as data_credentials, Db};
use cache_core::error::UecmError;
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub fn deploy_ddc_plan_preview(plan: DeployPlan) -> Vec<DeployStep> {
    deploy_workflow::plan_steps(&plan)
}

#[tauri::command]
pub async fn deploy_ddc_run(
    db: State<'_, Db>,
    app: AppHandle,
    plan: DeployPlan,
    credential_alias: Option<String>,
    stop_on_failure: bool,
) -> Result<(), String> {
    // DESIGN-2: enforce feature-gated required fields (resolution / editor_exe)
    // before doing any work — only required when the corresponding feature is on.
    plan.validate().map_err(|e: UecmError| e.to_string())?;
    // SSH key auth: run_plan no longer consumes an operator credential (the
    // distribute steps resolve the source SMB credential from the share's
    // SecretStore alias). Keep credential_alias as an accepted-ignored shim (Vue
    // compat) — validate it exists so a typo errors early, but don't read a
    // password that would be discarded (which used to fail on a non-Windows
    // operator or a SecretStore-only alias).
    if let Some(a) = credential_alias.as_deref() {
        if !a.is_empty() {
            data_credentials::find_by_alias(&db, a)
                .map_err(|e: UecmError| e.to_string())?
                .ok_or_else(|| format!("credential '{}' not found", a))?;
        }
    }
    let creds: Option<(String, String)> = None;

    // Clone the Db handle for the blocking task. Db is Arc-backed and cheap to clone.
    let db_clone = (*db).clone();
    let app_inner = app.clone();
    let plan_owned = plan;

    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let mut plan_mut = plan_owned;
        deploy_workflow::run_plan(
            &db_clone,
            &mut plan_mut,
            creds.as_ref().map(|(u, p)| (u.as_str(), p.as_str())),
            RunOptions { stop_on_step_failure: stop_on_failure },
            &mut |e: DeployEvent| {
                app_inner.emit("deploy-event", &e).ok();
            },
        );
        Ok(())
    })
    .await
    .map_err(|e| format!("task join: {}", e))?
}
