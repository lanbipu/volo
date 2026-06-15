//! volo Tauri backend entry point.
//!
//! step 2c platformed UECM's transport layer here: `commands/` holds the
//! ~80 `#[tauri::command]` thin wrappers that drive `cache_core`
//! (core/data/startup/error). The DB handle + `UeJobRegistry` are `app.manage`d
//! in `setup` so `State<Db>` / `State<UeJobRegistry>` injection works.

pub mod commands;
// step 3c: native PDF render backend for the mesh `save_instruction_pdf`
// command (macOS WKWebView / Windows WebView2, cfg-gated; Linux returns a
// graceful "unsupported" error). Lives at crate root so command shims can
// `use crate::pdf_render::render_html_to_pdf`.
pub mod pdf_render;

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
        // step 3c: mesh `save_instruction_pdf` uses tauri-plugin-dialog (LMT
        // wired it for the native save dialog); opener is shared with UECM.
        .plugin(tauri_plugin_dialog::init())
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

            // step 3c mesh setup: open + migrate the separate LMT SQLite DB and
            // manage it as `MeshDb` to keep it distinct from the cache `Db` in
            // the TypeId-keyed state map.
            //
            // FIX (review #1): resolve the path via `volo_shared::data::
            // default_db_path()` (→ `<data_dir>/com.lanbipu.lmt/lmt.sqlite`),
            // **not** the Tauri `app_data_dir()` (→ `com.lanbipu.volo/...`,
            // the GUI bundle identifier). `voloctl lmt` uses default_db_path()
            // too, so this guarantees GUI and CLI open the same file. Using
            // app_data_dir forked them into two distinct DBs.
            let mesh_db_path = volo_shared::data::connection::default_db_path()
                .expect("failed to resolve mesh DB path");
            std::fs::create_dir_all(mesh_db_path.parent().unwrap())
                .expect("failed to create mesh DB dir");
            let mesh_db = volo_shared::data::open(&mesh_db_path)
                .expect("failed to open mesh DB");
            {
                let mut conn = mesh_db.lock().unwrap();
                volo_shared::data::schema::migrate(&mut conn)
                    .expect("failed to migrate mesh DB");
            }
            app.manage(commands::mesh::MeshDb(mesh_db));
            tracing::info!("volo mesh database at {}", mesh_db_path.display());
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
            // step 3c: mesh (LMT) command group. No name collisions with the
            // 82 cache commands above, so original names are preserved.
            commands::mesh_projects::list_recent_projects,
            commands::mesh_projects::add_recent_project,
            commands::mesh_projects::remove_recent_project,
            commands::mesh_projects::seed_example_project,
            commands::mesh_projects::load_project_yaml,
            commands::mesh_projects::save_project_yaml,
            commands::mesh_measurements::load_measurements_yaml,
            commands::mesh_reconstruct::reconstruct_surface,
            commands::mesh_reconstruct::list_runs,
            commands::mesh_reconstruct::get_run_report,
            commands::mesh_export::export_obj,
            commands::mesh_total_station::import_total_station_csv,
            commands::mesh_total_station::generate_instruction_card,
            commands::mesh_total_station::save_instruction_pdf,
            // review #15: argv-based vpcal / tracksim sidecar spawn bridge.
            commands::sidecars::spawn_sidecar,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
