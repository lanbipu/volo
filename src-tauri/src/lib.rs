//! volo Tauri backend entry point.
//!
//! step 2c platformed UECM's transport layer here: `commands/` holds the
//! ~80 `#[tauri::command]` thin wrappers that drive `cache_core`
//! (core/data/startup/error). The DB handle + `UeJobRegistry` are `app.manage`d
//! in `setup` so `State<Db>` / `State<UeJobRegistry>` injection works.

pub mod commands;

use tauri::Manager;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn ping() -> String {
    format!("pong · volo v{}", env!("CARGO_PKG_VERSION"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // UECM setup: open + migrate the SQLite DB, manage it as shared
            // state, and register the long-running UE job tracker.
            let db_path =
                cache_core::startup::resolve_db_path().expect("failed to resolve DB path");
            let db = cache_core::startup::open_and_migrate_db(&db_path)
                .expect("failed to open / migrate DB");
            app.manage(db);
            app.manage(commands::ddc_pak::UeJobRegistry::default());
            tracing::info!("volo started, cache database at {}", db_path.display());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            ping,
            commands::machines::list_machines,
            commands::machines::add_machine,
            commands::machines::delete_machine,
            commands::machines::rename_machine,
            commands::machines::get_machine_detail,
            commands::bootstrap::bootstrap_winrm,
            commands::bootstrap::get_winrm_bootstrap_script,
            commands::discovery::scan_network,
            commands::discovery::add_discovered_machine,
            commands::discovery::refresh_machine,
            commands::credentials::list_credentials,
            commands::credentials::save_credential,
            commands::credentials::delete_credential,
            commands::env_vars::set_machine_env_var,
            commands::env_vars::get_machine_env_var,
            commands::env_vars::set_machine_env_var_with_credential,
            commands::env_vars::get_machine_env_var_with_credential,
            commands::ini_editor::read_ini_section,
            commands::ini_editor::set_ini_key,
            commands::ini_editor::read_ini_section_with_credential,
            commands::ini_editor::set_ini_key_with_credential,
            commands::ini_scanner::scan_inis,
            commands::ini_scanner::list_findings_for_run,
            commands::ini_scanner::list_findings,
            commands::ini_scanner::list_recent_ini_runs,
            commands::ini_scanner::list_scan_runs,
            commands::ini_scanner::get_finding,
            commands::ini_scanner::apply_finding,
            commands::ini_scanner::skip_finding,
            commands::batch::batch_set_env_var,
            commands::batch::batch_set_ini_key,
            commands::shares::create_share,
            commands::shares::inject_share_credential_to_clients,
            commands::shares::list_shares,
            commands::shares::delete_share,
            commands::projects::list_projects,
            commands::projects::list_project_locations,
            commands::projects::discover_projects,
            commands::projects::set_project_location,
            commands::projects::delete_project,
            commands::projects::delete_project_location,
            commands::projects::create_project_manual,
            commands::ddc_pak::generate_ddc_pak,
            commands::ddc_pak::cancel_ue_job,
            commands::ddc_pak::verify_pak_output,
            commands::ddc_pak::distribute_ddc_pak,
            commands::pso::start_pso_collection,
            commands::pso::list_pso_cache_files,
            commands::pso::distribute_pso_cache,
            commands::gpu_consistency::get_gpu_consistency_matrix,
            commands::ini_scanner::verify_pso_precaching,
            commands::system::test_powershell_bridge,
            commands::health_check::run_health_check,
            commands::health_check::list_recent_health_runs,
            commands::health_check::list_health_results_for_run,
            commands::log_verify::run_log_verify,
            commands::deploy::deploy_ddc_run,
            commands::deploy::deploy_ddc_plan_preview,
            commands::consistency::run_consistency_check,
            commands::zen::zen_status,
            commands::zen::zen_probe,
            commands::zen::zen_cache_stats,
            commands::zen::zen_detect_binary,
            commands::zen::zen_list_endpoints,
            commands::zen::zen_baseline_list,
            commands::zen::zen_baseline_lock,
            commands::zen::zen_baseline_unlock,
            commands::zen::zen_register,
            commands::zen::zen_unregister,
            commands::zen::zen_change_role,
            commands::zen::zen_apply_config,
            commands::zen::zen_lua_preview,
            commands::zen::zen_service_install,
            commands::zen::zen_service_uninstall,
            commands::zen::zen_service_start,
            commands::zen::zen_service_stop,
            commands::zen::zen_service_status,
            commands::zen::zen_urlacl_add,
            commands::zen::zen_urlacl_list,
            commands::zen::zen_urlacl_remove,
            commands::zen::zen_verify_rules,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
