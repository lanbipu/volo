use cache_core::core::consistency_check::{self, HostSnapshot, Inconsistency};

#[tauri::command]
pub async fn run_consistency_check(
    hosts: Vec<String>,
    credential_alias: Option<String>,
) -> Result<(Vec<HostSnapshot>, Vec<Inconsistency>), String> {
    // SSH key auth: credential_alias kept on the command surface for UI compat
    // (cleaned up in sub-project B), not used for transport.
    let _ = &credential_alias;
    tokio::task::spawn_blocking(move || -> Result<(Vec<HostSnapshot>, Vec<Inconsistency>), String> {
        let exec = cache_core::core::ssh::SshExecutor::from_config().map_err(|e| e.to_string())?;
        let mut snaps = Vec::new();
        for h in &hosts {
            snaps.push(consistency_check::snapshot(&exec, h).map_err(|e| e.to_string())?);
        }
        let inc = consistency_check::compare(&snaps);
        Ok((snaps, inc))
    })
    .await
    .map_err(|e| format!("task join: {}", e))?
}
