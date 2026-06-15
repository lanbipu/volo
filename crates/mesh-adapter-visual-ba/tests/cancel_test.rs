//! Cancel + protocol error path coverage.
//!
//! Unix-only: every test points `LMT_VBA_SIDECAR_PATH` at a `.sh` mock fixture
//! and spawns it. Windows has no `.sh` runner, so the file is excluded from
//! compilation there (cancel/kill semantics are exercised on macOS CI).
#![cfg(unix)]

use std::env;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use mesh_adapter_visual_ba::sidecar::{run_sidecar, SidecarRequest};
use serde_json::json;
use tokio::sync::{mpsc, oneshot};

static ENV_LOCK: Mutex<()> = Mutex::new(());

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

#[tokio::test]
async fn cancel_kills_child_within_5_seconds() {
    let _guard = ENV_LOCK.lock().unwrap();
    env::set_var("LMT_VBA_SIDECAR_PATH", fixture("mock_sidecar_slow.sh"));
    let (cancel_tx, cancel_rx) = oneshot::channel();

    let task = tokio::spawn(async move {
        run_sidecar(SidecarRequest {
            subcommand: "reconstruct".into(),
            payload: json!({"command":"reconstruct","version":1}),
            progress_tx: None,
            cancel: Some(cancel_rx),
        })
        .await
    });

    tokio::time::sleep(Duration::from_millis(500)).await;
    let start = Instant::now();
    let _ = cancel_tx.send(());
    let result = task.await.unwrap();
    let elapsed = start.elapsed();

    assert!(matches!(
        result,
        Err(mesh_adapter_visual_ba::VbaError::Cancelled)
    ));
    assert!(elapsed < Duration::from_secs(5), "cancel took {elapsed:?}");

    env::remove_var("LMT_VBA_SIDECAR_PATH");
}

/// A long-running `reconstruct` (slow mock: emits a progress event then
/// `sleep 30`) must be cancellable mid-stream. We wait for the FIRST progress
/// event to confirm the child is actually running, fire the cancel, and assert
/// the call returns `VbaError::Cancelled` in well under the mock's 30s sleep.
/// The child is killed via `start_kill` + `wait` inside `run_sidecar`'s cancel
/// branch (`kill_on_drop(true)` is a backstop); reaching `Cancelled` proves the
/// kill+reap path ran, not that the child finished on its own.
#[tokio::test]
async fn reconstruct_cancel_kills_child_mid_progress() {
    let _guard = ENV_LOCK.lock().unwrap();
    env::set_var("LMT_VBA_SIDECAR_PATH", fixture("mock_sidecar_slow.sh"));

    let (cancel_tx, cancel_rx) = oneshot::channel();
    // Buffer >= 1 so the single progress event is delivered without try_send drops.
    let (progress_tx, mut progress_rx) = mpsc::channel(8);

    let task = tokio::spawn(async move {
        run_sidecar(SidecarRequest {
            subcommand: "reconstruct".into(),
            payload: json!({"command": "reconstruct", "version": 1}),
            progress_tx: Some(progress_tx),
            cancel: Some(cancel_rx),
        })
        .await
    });

    // Wait for the first progress event so we cancel a child that is genuinely
    // running (the mock sleeps 30s after this event). Bound the wait so a hung
    // mock fails the test rather than hanging forever.
    let first = tokio::time::timeout(Duration::from_secs(3), progress_rx.recv())
        .await
        .expect("first progress event should arrive within 3s")
        .expect("progress channel should yield one event before cancel");
    assert!(
        matches!(first, mesh_adapter_visual_ba::ipc::Event::Progress(_)),
        "expected a Progress event, got {first:?}"
    );

    let start = Instant::now();
    let _ = cancel_tx.send(());

    // The whole cancel + child-kill + reap must finish far below the mock's 30s
    // sleep. 5s is the contract budget for this task.
    let result = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .expect("cancel must resolve within 5s (child not killed?)")
        .expect("spawned task should not panic");
    let elapsed = start.elapsed();

    assert!(
        matches!(result, Err(mesh_adapter_visual_ba::VbaError::Cancelled)),
        "expected VbaError::Cancelled, got {result:?}"
    );
    // The 5s timeout above is the hard gate (child not killed => task hangs =>
    // timeout fires). This assert is a separate, tighter regression signal:
    // cancel resolves in ~0.5s in practice, so < 3s catches a real slowdown
    // without being so loose it never trips before the 5s timeout.
    assert!(
        elapsed < Duration::from_secs(3),
        "cancel should resolve fast, took {elapsed:?}"
    );

    env::remove_var("LMT_VBA_SIDECAR_PATH");
}

#[tokio::test]
async fn protocol_error_returns_typed_error() {
    let _guard = ENV_LOCK.lock().unwrap();
    env::set_var("LMT_VBA_SIDECAR_PATH", fixture("mock_sidecar_error.sh"));
    let result = run_sidecar(SidecarRequest {
        subcommand: "reconstruct".into(),
        payload: json!({"command":"reconstruct","version":1}),
        progress_tx: None,
        cancel: None,
    })
    .await;
    match result {
        Err(mesh_adapter_visual_ba::VbaError::Protocol { code, .. }) => {
            assert_eq!(code, "detection_failed");
        }
        other => panic!("expected Protocol error, got {other:?}"),
    }
    env::remove_var("LMT_VBA_SIDECAR_PATH");
}
