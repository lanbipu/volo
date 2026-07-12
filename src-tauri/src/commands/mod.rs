pub mod batch;
pub mod bootstrap;
pub mod consistency;
pub mod credentials;
pub mod deploy;
pub mod ddc_channels;
pub mod ddc_pak;
pub mod discovery;
pub mod env_vars;
pub mod gc;
pub mod gpu_consistency;
pub mod health_check;
pub mod ini_editor;
pub mod ini_scanner;
pub mod local_cache;
pub mod log_verify;
pub mod machines;
// operations-table logging wrapper for the filesystem-DDC commands (join/leave
// env write, project-INI backend field, local-cache create) — these otherwise
// leave no `operations` row, so failures had no DB error trail to analyze.
pub mod oplog;
// step 3c: mesh (LMT) command group. `mesh` holds the MeshDb state newtype;
// the `mesh_*` modules are the migrated LMT `#[tauri::command]` shims.
pub mod mesh;
pub mod mesh_export;
pub mod mesh_fuse;
pub mod mesh_measurements;
pub mod mesh_projects;
pub mod mesh_reconstruct;
pub mod mesh_total_station;
pub mod mesh_visual;
// live-capture plan Phase 3a: pattern player window (C1.3 playback host).
pub mod player;
pub mod projects;
pub mod pso;
pub mod shares;
// W3.1: generic long-running sidecar streaming bridge (stdout NDJSON events,
// stdin control, cancel). Builds on `sidecars::locate_by_name`.
pub mod sidecar_stream;
// review #15: spawn bridge for the argv-based vpcal / tracksim sidecars.
pub mod sidecars;
pub mod system;
pub mod vpcal_runs;
pub mod zen;
