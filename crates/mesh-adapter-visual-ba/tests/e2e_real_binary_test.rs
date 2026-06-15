//! End-to-end test that uses the actual PyInstaller-built sidecar (or a
//! dev wrapper that invokes `python -m lmt_vba_sidecar`) — proves the
//! wire protocol works against a real Python process, not just shell mocks.
//!
//! Skipped by default. Set `LMT_VBA_SIDECAR_PATH` to enable. Useful as a
//! smoke check after PyInstaller builds.

use std::env;

use mesh_adapter_visual_ba::sidecar::{run_sidecar, SidecarRequest};
use serde_json::json;

#[tokio::test]
#[ignore = "requires LMT_VBA_SIDECAR_PATH set to a real sidecar binary or wrapper"]
async fn real_sidecar_handles_invalid_input_gracefully() {
    let exe = match env::var("LMT_VBA_SIDECAR_PATH") {
        Ok(p) => p,
        Err(_) => {
            eprintln!("skipping: LMT_VBA_SIDECAR_PATH not set");
            return;
        }
    };
    env::set_var("LMT_VBA_SIDECAR_PATH", &exe);

    // Send a valid JSON object that fails schema validation (missing fields).
    // The sidecar must respond with an `error` event having code `invalid_input`,
    // exit non-zero, and our adapter must surface it as VbaError::Protocol.
    let result = run_sidecar(SidecarRequest {
        subcommand: "reconstruct".into(),
        payload: json!({"command":"reconstruct","version":1}),
        progress_tx: None,
        cancel: None,
    })
    .await;

    match result {
        Err(mesh_adapter_visual_ba::VbaError::Protocol { code, .. }) => {
            assert_eq!(code, "invalid_input", "expected invalid_input, got {code}");
        }
        other => panic!("expected Protocol(invalid_input), got {other:?}"),
    }
}

#[tokio::test]
#[ignore = "requires LMT_VBA_SIDECAR_PATH set to a real sidecar binary or wrapper"]
async fn real_sidecar_generate_pattern_exercises_cv2_and_submodules() {
    // Goes deeper than the invalid_input path: this actually invokes
    // `lmt_vba_sidecar.pattern` (which imports cv2 + uses cv2.aruco). If
    // PyInstaller missed `--collect-submodules lmt_vba_sidecar` or `--collect-all cv2`,
    // this test surfaces the regression in CI before users hit it.
    let exe = match env::var("LMT_VBA_SIDECAR_PATH") {
        Ok(p) => p,
        Err(_) => {
            eprintln!("skipping: LMT_VBA_SIDECAR_PATH not set");
            return;
        }
    };
    env::set_var("LMT_VBA_SIDECAR_PATH", &exe);

    let tmp = tempfile::tempdir().expect("tmpdir");
    let out_dir = tmp.path().join("patterns");
    let payload = json!({
        "command": "generate_pattern",
        "version": 1,
        "project": {
            "screen_id": "MAIN",
            "cabinet_array": {"cols": 1, "rows": 1, "cabinet_size_mm": [500.0, 500.0]}
        },
        "output_dir": out_dir.to_str().unwrap(),
        "screen_resolution": [360, 360]
    });

    let result = run_sidecar(SidecarRequest {
        subcommand: "generate_pattern".into(),
        payload,
        progress_tx: None,
        cancel: None,
    })
    .await;

    match result {
        Ok(_) => {
            // generate_pattern returns an empty result envelope on success.
            // The proof is the produced files.
            assert!(
                out_dir.join("full_screen.png").exists(),
                "full_screen.png not produced — cv2 likely missing from build"
            );
            assert!(out_dir.join("pattern_meta.json").exists());
            assert!(out_dir.join("cabinets/V000_R000.png").exists());
        }
        Err(e) => panic!("expected success, got {e}"),
    }
}
