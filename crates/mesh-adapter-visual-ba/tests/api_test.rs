//! Unix-only: every test points `LMT_VBA_SIDECAR_PATH` at a `.sh` mock fixture
//! and spawns it. Windows has no `.sh` runner, so the file is excluded from
//! compilation there (the api-fn payload/result mapping is exercised on macOS CI).
#![cfg(unix)]

use std::env;
use std::path::PathBuf;
use std::sync::Mutex;

use mesh_adapter_visual_ba::api::{calibrate, reconstruct, CalibrateArgs, ReconstructArgs};
use mesh_adapter_visual_ba::ipc::{CabinetArray, FlatTag, ReconstructProject, ShapePrior};

static ENV_LOCK: Mutex<()> = Mutex::new(());

fn mock_path_with_result() -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    dir.join("tests/fixtures/mock_sidecar_with_point.sh")
}

#[tokio::test]
async fn reconstruct_returns_ir_measured_points() {
    let _guard = ENV_LOCK.lock().unwrap();
    env::set_var(
        "LMT_VBA_SIDECAR_PATH",
        mock_path_with_result().to_str().unwrap(),
    );
    let project = ReconstructProject {
        screen_id: "MAIN".into(),
        cabinet_array: CabinetArray {
            cols: 1,
            rows: 1,
            cabinet_size_mm: [500.0, 500.0],
            absent_cells: vec![],
        },
        shape_prior: ShapePrior::Flat(FlatTag::Flat),
    };
    // The mock ignores stdin, so the manifest / pose-report paths need not
    // exist; a missing pose report just yields empty cabinet_summaries.
    let args = ReconstructArgs {
        project,
        capture_manifest_path: "/nonexistent/manifest.json".into(),
        screen_mapping_path: None,
        intrinsics_path: None,
        crosscheck_intrinsics_path: None,
        pose_report_path: "/nonexistent/pose_report.json".into(),
        progress_tx: None,
        cancel: None,
    };
    let out = reconstruct(args).await.unwrap();
    assert_eq!(out.measured_points.points.len(), 1);
    assert_eq!(out.measured_points.points[0].name, "MAIN_V000_R000");
    // ba_rms_px comes from the mock's ba_stats.rms_reprojection_px (0.3).
    assert!((out.ba_rms_px - 0.3).abs() < 1e-9);
    // Output frame is the identity screen-local frame.
    assert_eq!(out.measured_points.coordinate_frame.origin_world, [0.0; 3]);
    // Missing pose report → empty summaries, not an error.
    assert!(out.cabinet_summaries.is_empty());
    // covariance was 1e-6 m² → after into_ir conversion, 1.0 mm²
    match &out.measured_points.points[0].uncertainty {
        mesh_core::uncertainty::Uncertainty::Covariance3x3(m) => {
            assert!((m[(0, 0)] - 1.0).abs() < 1e-6);
        }
        _ => panic!("expected covariance"),
    }
    env::remove_var("LMT_VBA_SIDECAR_PATH");
}

#[tokio::test]
async fn reconstruct_payload_is_new_capture_manifest_shape() {
    // Capture the JSON the api fn writes to the sidecar's stdin (the echo mock
    // dumps it to $MOCK_PAYLOAD_OUT) and assert the NEW payload contract:
    // capture_manifest_path / screen_mapping_path / pose_report_path, and a
    // project WITHOUT coordinate_frame / frame_strategy / frame_anchors.
    let _guard = ENV_LOCK.lock().unwrap();
    let mock = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/mock_sidecar_echo_payload.sh");
    let payload_out = tempfile::Builder::new()
        .suffix(".json")
        .tempfile()
        .unwrap();
    env::set_var("LMT_VBA_SIDECAR_PATH", mock.to_str().unwrap());
    env::set_var("MOCK_PAYLOAD_OUT", payload_out.path());

    let project = ReconstructProject {
        screen_id: "MAIN".into(),
        cabinet_array: CabinetArray {
            cols: 2,
            rows: 1,
            cabinet_size_mm: [600.0, 340.0],
            absent_cells: vec![],
        },
        shape_prior: ShapePrior::Flat(FlatTag::Flat),
    };
    let args = ReconstructArgs {
        project,
        capture_manifest_path: "/tmp/manifest.json".into(),
        screen_mapping_path: Some("/tmp/screen_mapping.json".into()),
        intrinsics_path: Some("auto".into()),
        crosscheck_intrinsics_path: Some("/tmp/anchor.json".into()),
        pose_report_path: "/tmp/does_not_exist_pose_report.json".into(),
        progress_tx: None,
        cancel: None,
    };
    let out = reconstruct(args).await.unwrap();
    assert_eq!(out.measured_points.screen_id, "MAIN");
    assert_eq!(out.pose_report_path, "/tmp/does_not_exist_pose_report.json");

    let sent: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(payload_out.path()).unwrap()).unwrap();
    assert_eq!(sent["command"], "reconstruct");
    assert_eq!(sent["version"], 1);
    assert_eq!(sent["capture_manifest_path"], "/tmp/manifest.json");
    assert_eq!(sent["screen_mapping_path"], "/tmp/screen_mapping.json");
    // intrinsics override + crosscheck anchor are forwarded verbatim ("auto" sentinel).
    assert_eq!(sent["intrinsics_path"], "auto");
    assert_eq!(sent["crosscheck_intrinsics_path"], "/tmp/anchor.json");
    assert_eq!(
        sent["pose_report_path"],
        "/tmp/does_not_exist_pose_report.json"
    );
    assert_eq!(sent["project"]["screen_id"], "MAIN");
    assert_eq!(sent["project"]["cabinet_array"]["cols"], 2);
    // Removed fields must be absent from the new project shape.
    assert!(sent["project"]["coordinate_frame"].is_null());
    assert!(sent["project"]["frame_strategy"].is_null());
    assert!(sent["project"]["frame_anchors"].is_null());

    env::remove_var("MOCK_PAYLOAD_OUT");
    env::remove_var("LMT_VBA_SIDECAR_PATH");
}

#[tokio::test]
async fn invalid_cabinet_size_returns_error_not_panic() {
    use mesh_adapter_visual_ba::error::VbaError;
    let _guard = ENV_LOCK.lock().unwrap();
    env::set_var(
        "LMT_VBA_SIDECAR_PATH",
        mock_path_with_result().to_str().unwrap(),
    );
    let project = ReconstructProject {
        screen_id: "MAIN".into(),
        cabinet_array: CabinetArray {
            cols: 1,
            rows: 1,
            // Non-positive size: core IR validator must reject before spawning.
            cabinet_size_mm: [0.0, 500.0],
            absent_cells: vec![],
        },
        shape_prior: ShapePrior::Flat(FlatTag::Flat),
    };
    let args = ReconstructArgs {
        project,
        capture_manifest_path: "/nonexistent/manifest.json".into(),
        screen_mapping_path: None,
        intrinsics_path: None,
        crosscheck_intrinsics_path: None,
        pose_report_path: "/nonexistent/pose_report.json".into(),
        progress_tx: None,
        cancel: None,
    };
    let result = reconstruct(args).await;
    env::remove_var("LMT_VBA_SIDECAR_PATH");
    match result {
        Err(VbaError::InvalidInput(_)) => {}
        other => panic!("expected InvalidInput, got {other:?}"),
    }
}

#[tokio::test]
async fn calibrate_reads_frames_used_from_intrinsics_file_not_ba_stats() {
    // Regression: the sidecar hard-codes ba_stats.iterations = 0, so the real
    // frame count lives only in the intrinsics JSON (`frames_used`). The mock
    // emits iterations=0 in the result event but writes frames_used=12 to the
    // file; CalibrateOut.frames_used must be 12, not 0.
    let _guard = ENV_LOCK.lock().unwrap();
    let mock = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/mock_sidecar_calibrate.sh");
    let intrinsics_out = tempfile::Builder::new()
        .suffix(".json")
        .tempfile()
        .unwrap();
    let out_path = intrinsics_out.path().to_str().unwrap().to_string();

    env::set_var("LMT_VBA_SIDECAR_PATH", mock.to_str().unwrap());
    // The mock writes the intrinsics JSON to this same path (== output_path).
    env::set_var("MOCK_INTRINSICS_OUT", &out_path);

    let out = calibrate(CalibrateArgs {
        checkerboard_images: vec![
            "a.jpg".into(),
            "b.jpg".into(),
            "c.jpg".into(),
            "d.jpg".into(),
            "e.jpg".into(),
        ],
        inner_corners: [9, 6],
        square_size_mm: 25.0,
        output_path: out_path.clone(),
        progress_tx: None,
        cancel: None,
    })
    .await
    .unwrap();

    env::remove_var("MOCK_INTRINSICS_OUT");
    env::remove_var("LMT_VBA_SIDECAR_PATH");

    assert_eq!(out.intrinsics_path, out_path);
    assert_eq!(out.frames_used, 12, "frames_used must come from the file");
    assert!((out.reproj_error_px - 0.42).abs() < 1e-9);
}
