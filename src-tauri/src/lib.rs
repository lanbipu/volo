//! volo Tauri backend entry point.
//!
//! step 2c platformed Volo's transport layer here: `commands/` holds the
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

/// macOS 全局菜单栏（屏幕顶端，归操作系统所有）—— 把原型的
/// 文件/编辑/视图/舞台/渲染/现场/窗口/帮助 放进系统菜单栏。编辑 / 窗口用系统预定义项，
/// 其余暂为占位（待建设）。Windows/Linux 不走原生菜单（菜单画在窗口顶部，见前端 win-topbar）。
#[cfg(target_os = "macos")]
fn build_macos_menu<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};

    let placeholder = |title: &str| -> tauri::Result<Submenu<R>> {
        Submenu::with_items(
            app,
            title,
            true,
            &[&MenuItem::new(app, "（待建设）", false, None::<&str>)?],
        )
    };

    let app_menu = Submenu::with_items(
        app,
        "Volo",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("Volo"), None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "编辑",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "窗口",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    Menu::with_items(
        app,
        &[
            &app_menu,
            &placeholder("文件")?,
            &edit,
            &placeholder("视图")?,
            &placeholder("舞台")?,
            &placeholder("渲染")?,
            &placeholder("现场")?,
            &window,
            &placeholder("帮助")?,
        ],
    )
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
        // wired it for the native save dialog); opener is shared with Volo.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // Windows Win11 Snap Layouts：在自绘最大化按钮（前端 id="snap-btn"）上叠一个
        // 透明原生 child HWND 返回 HTMAXBUTTON，让 DWM 在 hover 时弹布局菜单——这是
        // WebView2 覆盖标题栏下还原 Snap Layouts 的标准做法（issue #4531）。跨平台 no-op。
        .plugin(tauri_plugin_snap_layout::init().button_id("snap-btn").build())
        .setup(|app| {
            // Volo setup: open + migrate the SQLite DB, manage it as shared
            // state, and register the long-running UE job tracker.
            let db_path =
                cache_core::startup::resolve_db_path().expect("failed to resolve DB path");
            let db = cache_core::startup::open_and_migrate_db(&db_path)
                .expect("failed to open / migrate DB");
            app.manage(db);
            app.manage(commands::ddc_pak::UeJobRegistry::default());
            app.manage(commands::sidecar_stream::SidecarStreamRegistry::default());
            app.manage(commands::sidecar_stream::ApprovedImagePaths::default());
            app.manage(commands::mesh_visual::MeshVisualJobRegistry::default());
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

            // macOS：把应用菜单装进系统菜单栏（屏幕顶端）。Windows/Linux 菜单画在窗口顶部
            // （前端 win-topbar），不设原生菜单，故 cfg-gate 到 macOS。
            #[cfg(target_os = "macos")]
            {
                let handle = app.handle().clone();
                let menu = build_macos_menu(&handle)?;
                app.set_menu(menu)?;
            }

            // Windows：关掉原生标题栏（decorations），让前端自绘的 win-topbar 成为
            // 唯一标题栏 —— 与 macOS 的 Overlay 交通灯同策略（单一标题栏）。
            // conf 的 `titleBarStyle: Overlay` 是 macOS 专属、Windows 不认，否则
            // Windows 会退回默认原生标题栏并与 win-topbar 并排成两条。窗口最小化/
            // 最大化/关闭由前端 winctl 调 window API（capabilities 已放行）。
            // Windows：关掉原生标题栏（decorations），让前端自绘的 win-topbar 成为
            // 唯一标题栏。Snap Layouts 由 tauri-plugin-snap-layout 的 overlay 还原
            // （见上方 builder）。conf 的 titleBarStyle:Overlay 是 macOS 专属、
            // Windows 不认，否则会退回原生标题栏与 win-topbar 并排成两条。
            #[cfg(target_os = "windows")]
            {
                if let Some(win) = app.get_webview_window("main") {
                    if let Err(e) = win.set_decorations(false) {
                        tracing::warn!("set_decorations(false) failed: {e}");
                    }
                } else {
                    tracing::warn!("main window not found; decorations not disabled");
                }
            }
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
            commands::machines::list_ue_runtime_users,
            commands::machines::set_ue_runtime_user,
            commands::bootstrap::bootstrap_winrm,
            commands::bootstrap::get_winrm_bootstrap_script,
            commands::bootstrap::package_ssh_bootstrap,
            commands::bootstrap::pick_directory,
            commands::bootstrap::pick_file,
            commands::bootstrap::reveal_path,
            commands::bootstrap::is_loopback_machine,
            commands::bootstrap::reveal_remote_path,
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
            commands::env_vars::get_ddc_registry_overrides,
            commands::ddc_channels::get_ddc_ini_overrides,
            commands::ddc_channels::set_ddc_ini_path,
            commands::ddc_channels::set_ddc_registry_local_path,
            commands::ddc_channels::set_ddc_registry_shared_path,
            commands::ddc_channels::scan_command_line_args,
            commands::ddc_channels::test_path_reachable,
            commands::local_cache::create_local_cache,
            commands::oplog::record_operation,
            commands::ini_editor::read_ini_section,
            commands::ini_editor::set_ini_key,
            commands::ini_editor::set_machine_backend_field,
            commands::ini_editor::remove_machine_backend_field,
            commands::ini_editor::get_machine_backend_field,
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
            commands::gc::gc_pause,
            commands::gc::gc_resume,
            commands::gc::zen_gc_pause,
            commands::gc::zen_gc_resume,
            commands::batch::batch_set_env_var,
            commands::batch::batch_set_ini_key,
            commands::shares::create_share,
            commands::shares::inject_share_credential_to_clients,
            commands::shares::prepare_open_share_clients,
            commands::shares::unprepare_open_share_clients,
            commands::shares::prepare_managed_share_clients,
            commands::shares::unprepare_managed_share_clients,
            commands::shares::list_shares,
            commands::shares::delete_share,
            commands::shares::teardown_share,
            commands::shares::ensure_open_dir_share,
            commands::shares::remove_open_dir_share,
            commands::projects::list_projects,
            commands::projects::list_project_locations,
            commands::projects::discover_projects,
            commands::projects::set_project_location,
            commands::projects::delete_project,
            commands::projects::delete_project_location,
            commands::projects::create_project_manual,
            commands::projects::set_project_cache_backend,
            commands::projects::get_project_thumbnail,
            commands::projects::list_remote_directories,
            commands::ddc_pak::generate_ddc_pak,
            commands::ddc_pak::cancel_ue_job,
            commands::ddc_pak::verify_pak_output,
            commands::ddc_pak::distribute_ddc_pak,
            commands::ddc_pak::list_deployed_ddc_paks,
            commands::ddc_pak::delete_ddc_pak,
            commands::pso::start_pso_warmup,
            commands::pso::start_pso_coldtest,
            commands::pso::list_pso_warmup_runs,
            commands::pso::list_pso_status,
            commands::pso::clear_driver_cache,
            commands::pso::probe_driver_cache,
            commands::pso::list_driver_cache_snapshots,
            commands::pso::get_pso_project_settings,
            commands::pso::set_pso_project_settings,
            commands::pso::discover_ndisplay_assets,
            commands::pso::discover_project_maps,
            commands::pso::check_pso_config_preflight,
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
            commands::zen::zen_disk_space,
            commands::zen::zen_detect_binary,
            commands::zen::zen_list_endpoints,
            commands::zen::zen_baseline_list,
            commands::zen::zen_baseline_lock,
            commands::zen::zen_baseline_unlock,
            commands::zen::zen_register,
            commands::zen::zen_update_deploy_config,
            commands::zen::zen_unregister,
            commands::zen::zen_change_role,
            commands::zen::zen_apply_config,
            commands::zen::zen_enable_global,
            commands::zen::zen_read_local_runcontext,
            commands::zen::zen_set_local_datapath,
            commands::zen::zen_local_port_set,
            commands::zen::zen_local_port_clear,
            commands::zen::zen_local_port_status,
            commands::zen::zen_update_gc_settings,
            commands::zen::zen_lua_preview,
            commands::zen::zen_create_dedicated_account,
            commands::zen::zen_service_install,
            commands::zen::zen_service_uninstall,
            commands::zen::zen_migrate_data_dir,
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
            commands::mesh_reconstruct::set_run_current,
            commands::vpcal_runs::list_ar_runs,
            commands::vpcal_runs::list_lens_sessions,
            commands::vpcal_runs::read_image_as_data_url,
            commands::vpcal_runs::read_lens_qa_report,
            commands::capture_profiles::list_capture_profiles,
            commands::capture_profiles::save_capture_profiles,
            commands::capture_profiles::probe_tracking_source,
            commands::capture_profiles::probe_video_source,
            commands::capture_profiles::enumerate_video_sources,
            commands::mesh_export::export_obj,
            commands::mesh_export::export_vpcal_screen,
            commands::system::list_net_interfaces,
            commands::mesh_total_station::import_total_station_csv,
            commands::mesh_total_station::generate_instruction_card,
            commands::mesh_total_station::save_instruction_pdf,
            // review #15: argv-based vpcal / tracksim sidecar spawn bridge.
            commands::sidecars::spawn_sidecar,
            // W3.1: streaming sidecar bridge (long-running, stdout NDJSON events).
            commands::player::list_monitors,
            commands::player::open_pattern_player,
            commands::player::close_pattern_player,
            commands::player::player_show_pattern,
            commands::player::player_clear,
            commands::sidecar_stream::spawn_sidecar_streaming,
            commands::sidecar_stream::sidecar_stdin_write,
            commands::sidecar_stream::cancel_sidecar_task,
            commands::sidecar_stream::cancel_sidecar_tasks_by_program,
            // W4: M2 visual-BA group (backend-only; UI pending Claude Design handoff).
            commands::mesh_visual::mesh_visual_generate_pattern,
            commands::mesh_visual::mesh_visual_generate_structured_light,
            commands::mesh_visual::mesh_visual_decode_structured_light,
            commands::mesh_visual::mesh_visual_calibrate,
            commands::mesh_visual::mesh_visual_calibrate_structured_light,
            commands::mesh_visual::mesh_visual_reconstruct,
            commands::mesh_visual::mesh_visual_reconstruct_structured_light,
            commands::mesh_visual::mesh_visual_cancel,
            commands::mesh_visual::mesh_visual_simulate,
            commands::mesh_visual::mesh_visual_eval,
            commands::mesh_visual::mesh_visual_compare_known,
            commands::mesh_visual::mesh_visual_plan_capture,
            commands::mesh_visual::mesh_visual_capture_card,
            commands::mesh_visual::mesh_visual_load_pose_report,
            commands::mesh_visual::mesh_visual_export_pose_obj,
            // W6 R1: M1+M2 fuse (backend-only; no UI wiring this pass).
            commands::mesh_fuse::mesh_fuse_run,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
