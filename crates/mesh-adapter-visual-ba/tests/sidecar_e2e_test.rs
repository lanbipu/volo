//! Spawn a mock sidecar (shell script), parse its NDJSON stream.
//!
//! Unix-only: every test points `LMT_VBA_SIDECAR_PATH` at a `.sh` mock fixture
//! and spawns it. Windows has no `.sh` runner, so the file is excluded from
//! compilation there (the NDJSON stream path is exercised on macOS CI).
#![cfg(unix)]

use std::env;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use mesh_adapter_visual_ba::sidecar::{run_sidecar, SidecarRequest};
use serde_json::json;
use tokio::sync::mpsc;

static ENV_LOCK: Mutex<()> = Mutex::new(());

fn mock_path() -> PathBuf {
    fixture("mock_sidecar.sh")
}

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

#[tokio::test]
async fn mock_sidecar_round_trip() {
    let _guard = ENV_LOCK.lock().unwrap();
    env::set_var("LMT_VBA_SIDECAR_PATH", mock_path().to_str().unwrap());
    let (tx, mut rx) = mpsc::channel(16);
    let payload = json!({"command":"reconstruct","version":1});

    let task = tokio::spawn(async move {
        run_sidecar(SidecarRequest {
            subcommand: "reconstruct".into(),
            payload,
            progress_tx: Some(tx),
            cancel: None,
        })
        .await
    });

    let mut events = Vec::new();
    while let Ok(Some(ev)) = tokio::time::timeout(Duration::from_secs(5), rx.recv()).await {
        events.push(ev);
    }

    let value = task.await.unwrap().unwrap();
    let result: mesh_adapter_visual_ba::ipc::ResultData =
        serde_json::from_value(value.data).unwrap();
    assert!(events
        .iter()
        .any(|e| matches!(e, mesh_adapter_visual_ba::Event::Progress(_))));
    assert!(result.frame_strategy_used == mesh_adapter_visual_ba::FrameStrategy::NominalAnchoring);
    env::remove_var("LMT_VBA_SIDECAR_PATH");
}

#[tokio::test]
async fn run_sidecar_collects_warnings_off_stream_when_headless() {
    // The headless CLI/app path passes progress_tx: None, so the sidecar's live
    // WarningEvents are NOT forwarded anywhere. They must still be collected onto
    // SidecarOutput.warnings (in stream order, cabinet field preserved) — this is the
    // durable carrier the general warnings channel relies on.
    let _guard = ENV_LOCK.lock().unwrap();
    env::set_var(
        "LMT_VBA_SIDECAR_PATH",
        fixture("mock_sidecar_warning.sh").to_str().unwrap(),
    );
    let out = run_sidecar(SidecarRequest {
        subcommand: "reconstruct".into(),
        payload: json!({"command":"reconstruct","version":1}),
        progress_tx: None,
        cancel: None,
    })
    .await
    .unwrap();
    let codes: Vec<&str> = out.warnings.iter().map(|w| w.code.as_str()).collect();
    assert_eq!(codes, ["no_intrinsics_anchor", "high_rejection"]);
    assert_eq!(out.warnings[0].cabinet, None);
    assert_eq!(out.warnings[1].cabinet.as_deref(), Some("MAIN_V000_R000"));
    env::remove_var("LMT_VBA_SIDECAR_PATH");
}

#[tokio::test]
async fn stderr_is_drained_and_included_in_failure_message() {
    let _guard = ENV_LOCK.lock().unwrap();
    env::set_var(
        "LMT_VBA_SIDECAR_PATH",
        fixture("mock_sidecar_stderr.sh").to_str().unwrap(),
    );
    let payload = serde_json::json!({"command":"reconstruct","version":1});

    let result = run_sidecar(SidecarRequest {
        subcommand: "reconstruct".into(),
        payload,
        progress_tx: None,
        cancel: None,
    })
    .await;

    env::remove_var("LMT_VBA_SIDECAR_PATH");

    let err = result.unwrap_err();
    let s = format!("{err}");
    assert!(s.contains("non-zero"), "expected non-zero in error: {s}");
    assert!(
        s.contains("stderr-line-"),
        "expected stderr tail in error: {s}"
    );
}

#[tokio::test]
async fn slow_progress_consumer_does_not_block_stdout() {
    use mesh_adapter_visual_ba::Event;
    let _guard = ENV_LOCK.lock().unwrap();
    env::set_var("LMT_VBA_SIDECAR_PATH", mock_path().to_str().unwrap());
    // Bounded channel, capacity 1 — the mock emits 3 events, so try_send must
    // drop overflow; if read_events did .send(.).await this test would hang.
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Event>(1);

    let task = tokio::spawn(async move {
        run_sidecar(SidecarRequest {
            subcommand: "reconstruct".into(),
            payload: serde_json::json!({"command":"reconstruct","version":1}),
            progress_tx: Some(tx),
            cancel: None,
        })
        .await
    });

    // Don't drain rx during the run — simulating a slow consumer.
    let value = tokio::time::timeout(std::time::Duration::from_secs(5), task)
        .await
        .expect("must not hang on slow consumer")
        .expect("task panicked")
        .expect("sidecar should still complete");
    let result: mesh_adapter_visual_ba::ipc::ResultData =
        serde_json::from_value(value.data).unwrap();
    assert_eq!(
        result.frame_strategy_used,
        mesh_adapter_visual_ba::FrameStrategy::NominalAnchoring
    );

    // Drain whatever did make it (≤ capacity).
    let mut count = 0;
    while rx.try_recv().is_ok() {
        count += 1;
    }
    assert!(count <= 1, "channel cap should bound buffered events");
    env::remove_var("LMT_VBA_SIDECAR_PATH");
}
