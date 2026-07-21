//! Mesh (LMT) M2 visual-BA group Tauri command shims. Business logic in
//! `mesh_app::visual` / `mesh_app::export`; this file is transport only, plus
//! the streaming/cancel glue `mesh_visual_reconstruct` needs (the adapter's
//! BA reconstruction can run for minutes).

use std::collections::HashMap;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use mesh_adapter_visual_ba::ipc::Event as VbaEvent;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{mpsc, oneshot, Mutex};

use volo_shared::dto::{
    CabinetPoseReportFile, CalibrateResult, CaptureCardResult, CapturePlan,
    CompareKnownResult, DecodeStructuredLightResult, EvalResult, ExportPoseObjResult,
    GeneratePatternResult, GenerateStructuredLightResult, ReconstructionResult,
    ScreenTransformsFile, SimulateResult, VisualReconstructResult, VisualSolveDigest,
};
use volo_shared::error::VoloResult;

const PROGRESS_EVENT: &str = "mesh-visual-progress";
const DONE_EVENT: &str = "mesh-visual-reconstruct-done";

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default()
}

/// Tracks in-flight `mesh_visual_reconstruct` jobs so `mesh_visual_cancel` can
/// fire the adapter's (single-shot) cancel token. Mirrors `ddc_pak::UeJobRegistry`,
/// simplified for a `oneshot` cancel instead of a re-armable `RunnerCancel` flag.
#[derive(Default)]
pub struct MeshVisualJobRegistry {
    jobs: Mutex<HashMap<String, oneshot::Sender<()>>>,
}

impl MeshVisualJobRegistry {
    async fn insert(&self, job_id: &str, cancel_tx: oneshot::Sender<()>) {
        self.jobs.lock().await.insert(job_id.to_string(), cancel_tx);
    }

    async fn remove(&self, job_id: &str) {
        self.jobs.lock().await.remove(job_id);
    }

    async fn cancel(&self, job_id: &str) -> bool {
        match self.jobs.lock().await.remove(job_id) {
            Some(tx) => tx.send(()).is_ok(),
            None => false,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct MeshVisualJobResponse {
    pub job_id: String,
}

#[derive(Clone, Serialize)]
struct ProgressPayload<'a> {
    job_id: &'a str,
    event: &'a VbaEvent,
}

#[derive(Clone, Serialize)]
struct DonePayload {
    job_id: String,
    result: Option<VisualReconstructResult>,
    error: Option<String>,
}

// ---------------------------------------------------------------------------
// reconstruct (streaming) + cancel
// ---------------------------------------------------------------------------

/// Kick off a BA reconstruction job and return immediately with a `job_id`.
/// Progress rides `mesh-visual-progress` events (payload: `{job_id, event}`,
/// `event` is the adapter's raw `ipc::Event` — `progress`/`warning`/`result`/
/// `error` tagged); completion rides one `mesh-visual-reconstruct-done` event
/// (payload: `{job_id, result, error}`, exactly one of the two set).
#[tauri::command]
pub async fn mesh_visual_reconstruct(
    app: AppHandle,
    registry: State<'_, MeshVisualJobRegistry>,
    project_path: String,
    screen_ids: Vec<String>,
    capture_manifest: String,
    intrinsics: Option<String>,
    intrinsics_crosscheck: Option<String>,
) -> VoloResult<MeshVisualJobResponse> {
    if screen_ids.is_empty() {
        return Err(volo_shared::error::VoloError::InvalidInput(
            "screen_ids must be non-empty".into(),
        ));
    }
    let capture_manifest = mesh_app::visual::prepare_capture_manifest(
        Path::new(&project_path),
        &screen_ids,
        Path::new(&capture_manifest),
    )?;
    let intrinsics = mesh_app::visual::normalize_reconstruct_intrinsics(
        &capture_manifest,
        intrinsics.as_deref(),
    )?;
    let job_label = screen_ids.join("+");
    let job_id = format!("mesh-visual-reconstruct-{job_label}-{}", now_millis());

    let (cancel_tx, cancel_rx) = oneshot::channel();
    registry.insert(&job_id, cancel_tx).await;

    // Buffered so a burst of progress/warning events from the sidecar doesn't
    // drop under `try_send` (see mesh-adapter-visual-ba::sidecar::read_events).
    let (progress_tx, mut progress_rx) = mpsc::channel::<VbaEvent>(64);

    let app_for_progress = app.clone();
    let job_id_for_progress = job_id.clone();
    let progress_task = tokio::spawn(async move {
        while let Some(event) = progress_rx.recv().await {
            let _ = app_for_progress.emit(
                PROGRESS_EVENT,
                ProgressPayload {
                    job_id: &job_id_for_progress,
                    event: &event,
                },
            );
        }
    });

    let app_for_task = app.clone();
    let job_id_for_task = job_id.clone();
    tokio::spawn(async move {
        let outcome = mesh_app::visual::run_reconstruct_streaming(
            Path::new(&project_path),
            &screen_ids,
            &capture_manifest,
            intrinsics.as_deref(),
            intrinsics_crosscheck.as_deref(),
            Some(progress_tx),
            Some(cancel_rx),
        )
        .await;

        // `run_reconstruct_streaming` drops its `progress_tx` clone when it
        // returns, closing the channel; awaiting the drain task here just
        // guarantees every buffered event is emitted before `DONE_EVENT`.
        let _ = progress_task.await;

        let (result, error) = match outcome {
            Ok(r) => (Some(r), None),
            Err(e) => (None, Some(e.to_string())),
        };
        let _ = app_for_task.emit(
            DONE_EVENT,
            DonePayload {
                job_id: job_id_for_task.clone(),
                result,
                error,
            },
        );

        app_for_task
            .state::<MeshVisualJobRegistry>()
            .remove(&job_id_for_task)
            .await;
    });

    Ok(MeshVisualJobResponse { job_id })
}

/// Cancel an in-flight `mesh_visual_reconstruct` job. Returns `false` if the
/// job is unknown (already finished, or bad job_id) — not an error, since the
/// caller can't distinguish "just finished" from "never existed" anyway.
#[tauri::command]
pub async fn mesh_visual_cancel(
    registry: State<'_, MeshVisualJobRegistry>,
    job_id: String,
) -> VoloResult<bool> {
    Ok(registry.cancel(&job_id).await)
}

// ---------------------------------------------------------------------------
// synchronous group (thin wraps of mesh_app::visual::run_*)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn mesh_visual_generate_pattern(
    app: AppHandle,
    project_path: String,
    screen_id: String,
    method: String,
    screen_id_code: u8,
    screen_mapping_path: Option<String>,
) -> VoloResult<GeneratePatternResult> {
    let result = mesh_app::visual::run_generate_pattern(
        Path::new(&project_path),
        &screen_id,
        &method,
        screen_id_code,
        screen_mapping_path.as_deref().map(Path::new),
    )?;
    // The preview reader is allowlist-backed: only approve the exact PNG path
    // returned by the successful Rust-owned generation flow.
    crate::commands::sidecar_stream::approve_image_path(
        &app,
        &Path::new(&result.output_dir).join("full_screen.png"),
    )?;
    Ok(result)
}

/// App 重启后恢复「已生成测试图」状态：扫描 patterns/ 并把每张 full_screen.png
/// 重新放行进预览读图 allowlist（否则恢复后的预览会被 read_image_as_data_url 拒绝）。
#[tauri::command]
pub fn mesh_visual_scan_patterns(
    app: AppHandle,
    project_path: String,
) -> VoloResult<std::collections::BTreeMap<String, GeneratePatternResult>> {
    let found = mesh_app::visual::run_scan_patterns(Path::new(&project_path))?;
    for r in found.values() {
        crate::commands::sidecar_stream::approve_image_path(
            &app,
            &Path::new(&r.output_dir).join("full_screen.png"),
        )?;
    }
    Ok(found)
}

#[tauri::command]
pub fn mesh_visual_generate_structured_light(
    project_path: String,
    screen_id: String,
    dot_spacing_px: Option<u32>,
    dot_radius_px: u32,
    margin_px: Option<u32>,
    emit_tiff_seq: Option<bool>,
    screen_mapping_path: Option<String>,
) -> VoloResult<GenerateStructuredLightResult> {
    mesh_app::visual::run_generate_structured_light(
        Path::new(&project_path),
        &screen_id,
        dot_spacing_px,
        dot_radius_px,
        margin_px,
        emit_tiff_seq,
        screen_mapping_path.as_deref().map(Path::new),
    )
}

#[tauri::command]
pub fn mesh_visual_decode_structured_light(
    input_path: String,
    sl_meta_path: String,
    output_path: String,
    sentinel_threshold: Option<f64>,
    screen_roi: Option<[u32; 4]>,
    emit_debug_image: bool,
) -> VoloResult<DecodeStructuredLightResult> {
    mesh_app::visual::run_decode_structured_light(
        Path::new(&input_path),
        Path::new(&sl_meta_path),
        Path::new(&output_path),
        sentinel_threshold,
        screen_roi,
        emit_debug_image,
    )
}

#[tauri::command]
pub fn mesh_visual_calibrate(
    project_path: String,
    screen_id: String,
    checkerboard_dir: String,
    square_mm: f64,
    inner: String,
) -> VoloResult<CalibrateResult> {
    mesh_app::visual::run_calibrate(
        Path::new(&project_path),
        &screen_id,
        Path::new(&checkerboard_dir),
        square_mm,
        &inner,
    )
}

#[tauri::command]
pub fn mesh_visual_calibrate_structured_light(
    project_path: String,
    screen_id: String,
    sl_meta: String,
    correspondences: Vec<String>,
    out: Option<String>,
    force: bool,
    max_rms_px: f64,
    intrinsics_crosscheck: Option<String>,
) -> VoloResult<CalibrateResult> {
    mesh_app::visual::run_calibrate_structured_light(
        Path::new(&project_path),
        &screen_id,
        Path::new(&sl_meta),
        &correspondences,
        out.as_deref().map(Path::new),
        force,
        max_rms_px,
        intrinsics_crosscheck.as_deref(),
    )
}

/// Not streamed (unlike `mesh_visual_reconstruct`): same BA cost profile, but
/// this session's scope only asked for the charuco/vpqsp path to stream.
/// Revisit if SL reconstructions prove long-running enough in practice to need it.
#[tauri::command]
pub fn mesh_visual_reconstruct_structured_light(
    project_path: String,
    screen_id: String,
    sl_meta: String,
    intrinsics: String,
    intrinsics_crosscheck: Option<String>,
    correspondences: Vec<String>,
) -> VoloResult<VisualReconstructResult> {
    mesh_app::visual::run_reconstruct_structured_light(
        Path::new(&project_path),
        &screen_id,
        Path::new(&sl_meta),
        &intrinsics,
        intrinsics_crosscheck.as_deref(),
        &correspondences,
    )
}

#[tauri::command]
pub fn mesh_visual_simulate(config_path: String, out_dir: String) -> VoloResult<SimulateResult> {
    mesh_app::visual::run_simulate(Path::new(&config_path), Path::new(&out_dir))
}

#[tauri::command]
pub fn mesh_visual_eval(
    dataset_dir: String,
    method: String,
    seed_matrix: Vec<i64>,
    init: String,
) -> VoloResult<EvalResult> {
    mesh_app::visual::run_eval(Path::new(&dataset_dir), &method, seed_matrix, &init)
}

#[tauri::command]
pub fn mesh_visual_compare_known(
    report_path: String,
    known_path: String,
    max_size_mm: Option<f64>,
    max_dist_mm: Option<f64>,
    max_angle_deg: Option<f64>,
) -> VoloResult<CompareKnownResult> {
    mesh_app::visual::run_compare_known(
        Path::new(&report_path),
        Path::new(&known_path),
        max_size_mm,
        max_dist_mm,
        max_angle_deg,
    )
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn mesh_visual_plan_capture(
    project_path: String,
    screen_id: String,
    image_size: String,
    hfov_deg: Option<f64>,
    vfov_deg: Option<f64>,
    standoff: String,
    height: String,
    target_p95_residual_mm: f64,
    trials: u32,
    seed: u32,
    min_views: Option<u32>,
) -> VoloResult<CapturePlan> {
    mesh_app::visual::run_plan_capture(
        Path::new(&project_path),
        &screen_id,
        &image_size,
        hfov_deg,
        vfov_deg,
        &standoff,
        &height,
        target_p95_residual_mm,
        trials,
        seed,
        min_views,
    )
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn mesh_visual_capture_card(
    project_path: String,
    screen_id: String,
    image_size: String,
    hfov_deg: Option<f64>,
    vfov_deg: Option<f64>,
    standoff: String,
    height: String,
    target_p95_residual_mm: f64,
    trials: u32,
    seed: u32,
) -> VoloResult<CaptureCardResult> {
    mesh_app::visual::run_capture_card(
        Path::new(&project_path),
        &screen_id,
        &image_size,
        hfov_deg,
        vfov_deg,
        &standoff,
        &height,
        target_p95_residual_mm,
        trials,
        seed,
    )
}

#[tauri::command]
pub fn mesh_visual_load_pose_report(
    pose_report_path: String,
) -> VoloResult<CabinetPoseReportFile> {
    mesh_app::visual::load_pose_report(Path::new(&pose_report_path))
}

#[tauri::command]
pub fn mesh_visual_load_screen_transforms(path: String) -> VoloResult<ScreenTransformsFile> {
    mesh_app::visual::load_screen_transforms(Path::new(&path))
}

#[tauri::command]
pub async fn mesh_visual_register_run(
    state: State<'_, crate::commands::mesh::MeshDb>,
    project_path: String,
    screen_id: String,
    pose_report_path: String,
    visual_solve_path: Option<String>,
) -> VoloResult<ReconstructionResult> {
    let db = state.0.clone();
    tokio::task::spawn_blocking(move || {
        let solve = visual_solve_path.as_deref().map(Path::new);
        mesh_app::visual::register_visual_run(
            db,
            Path::new(&project_path),
            &screen_id,
            Path::new(&pose_report_path),
            solve,
        )
    })
    .await
    .map_err(|e| volo_shared::error::VoloError::Other(format!("register visual task join: {e}")))?
}

#[tauri::command]
pub fn mesh_visual_persist_solve(
    project_path: String,
    result: VisualReconstructResult,
) -> VoloResult<String> {
    let path = mesh_app::visual::persist_visual_solve_digest(Path::new(&project_path), &result)?;
    Ok(path.display().to_string())
}

#[tauri::command]
pub fn mesh_visual_load_solve(path: String) -> VoloResult<VisualSolveDigest> {
    mesh_app::visual::load_visual_solve_digest(Path::new(&path))
}

#[tauri::command]
pub async fn mesh_visual_register_empty_run(
    state: State<'_, crate::commands::mesh::MeshDb>,
    project_path: String,
    screen_id: String,
    visual_solve_path: String,
) -> VoloResult<i64> {
    let db = state.0.clone();
    tokio::task::spawn_blocking(move || {
        mesh_app::visual::register_empty_visual_run(
            db,
            Path::new(&project_path),
            &screen_id,
            Path::new(&visual_solve_path),
        )
    })
    .await
    .map_err(|e| volo_shared::error::VoloError::Other(format!("register empty visual task join: {e}")))?
}

#[tauri::command]
pub fn mesh_visual_export_pose_obj(
    pose_report_path: String,
    target: String,
    out_file: String,
    root: Option<String>,
    ground: bool,
    split: bool,
    screen_mapping: Option<String>,
) -> VoloResult<ExportPoseObjResult> {
    mesh_app::export::run_export_pose_obj(
        Path::new(&pose_report_path),
        &target,
        Path::new(&out_file),
        root.as_deref(),
        ground,
        split,
        screen_mapping.as_deref().map(Path::new),
    )
}
