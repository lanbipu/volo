pub mod batch;
pub mod bootstrap;
pub mod consistency;
pub mod credentials;
pub mod deploy;
pub mod ddc_pak;
pub mod discovery;
pub mod env_vars;
pub mod gpu_consistency;
pub mod health_check;
pub mod ini_editor;
pub mod ini_scanner;
pub mod log_verify;
pub mod machines;
// step 3c: mesh (LMT) command group. `mesh` holds the MeshDb state newtype;
// the `mesh_*` modules are the migrated LMT `#[tauri::command]` shims.
pub mod mesh;
pub mod mesh_export;
pub mod mesh_measurements;
pub mod mesh_projects;
pub mod mesh_reconstruct;
pub mod mesh_total_station;
pub mod projects;
pub mod pso;
pub mod shares;
// review #15: spawn bridge for the argv-based vpcal / tracksim sidecars.
pub mod sidecars;
pub mod system;
pub mod zen;
