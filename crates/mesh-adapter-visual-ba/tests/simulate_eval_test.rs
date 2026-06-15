//! Real-sidecar round-trip for the simulate → eval pipeline.
//!
//! Unlike the shell mocks elsewhere, this drives the actual Python sidecar via
//! a dev wrapper that execs `python -m lmt_vba_sidecar`. It proves the new
//! `simulate` / `eval` api fns build the right payload, parse the right result
//! shape, and that the synthetic ChArUco pipeline reconstructs within tolerance.
//!
//! Unix-only: the wrapper is a POSIX `.sh` script (chmod 0o755) pointing at the
//! venv interpreter at `.venv/bin/python`. Windows has neither a `.sh` runner
//! nor that venv layout (`.venv/Scripts/`), so the whole file is excluded from
//! compilation there. Windows CI coverage comes from pytest + the cross-platform
//! Rust tests + the PyInstaller packaging smoke.
#![cfg(unix)]

use std::env;
use std::path::PathBuf;
use std::sync::Mutex;

use mesh_adapter_visual_ba::api::{
    compare_known, eval, simulate, CompareKnownArgs, EvalArgs, SimulateArgs,
};
use serde_json::json;

// Serialize env-var mutation across tests in this binary (and with any other
// test that touches LMT_VBA_SIDECAR_PATH in the same process group is N/A —
// integration tests run as separate binaries — but multiple tests here share
// the process, so the lock is still needed).
static ENV_LOCK: Mutex<()> = Mutex::new(());

/// Path to the project's python-sidecar venv interpreter, computed from this
/// crate's manifest dir. Returns None (caller skips) if it doesn't exist.
///
/// We canonicalize only the parent `.venv/bin` directory and KEEP the `python`
/// basename: that file is a symlink to the system interpreter, but launching it
/// via the venv path is what activates the venv's `sys.path` (so
/// `import lmt_vba_sidecar` resolves). Canonicalizing the file itself would
/// resolve the symlink to the bare system python and break the venv.
fn sidecar_python() -> Option<PathBuf> {
    let bin = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../python-sidecar/.venv/bin");
    let bin = bin.canonicalize().ok()?;
    let py = bin.join("python");
    if py.is_file() {
        Some(py)
    } else {
        None
    }
}

/// Write a `sh` wrapper into `dir` that execs `python -m lmt_vba_sidecar "$@"`,
/// chmod 0o755, and return its path. locate_sidecar requires an existing FILE,
/// so a script (not the bare interpreter) is what we point the env var at.
fn write_wrapper(dir: &std::path::Path, python: &std::path::Path) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let wrapper = dir.join("lmt-vba-sidecar");
    let script = format!(
        "#!/bin/sh\nexec \"{}\" -m lmt_vba_sidecar \"$@\"\n",
        python.display()
    );
    std::fs::write(&wrapper, script).expect("write wrapper");
    let mut perms = std::fs::metadata(&wrapper).unwrap().permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(&wrapper, perms).expect("chmod wrapper");
    wrapper
}

#[tokio::test]
async fn simulate_then_eval_roundtrip() {
    let _guard = ENV_LOCK.lock().unwrap();

    let python = match sidecar_python() {
        Some(p) => p,
        None => {
            eprintln!("skipping simulate_then_eval_roundtrip: python-sidecar venv not found");
            return;
        }
    };

    let tmp = tempfile::tempdir().expect("tmpdir");
    let wrapper = write_wrapper(tmp.path(), &python);
    let dataset_dir = tmp.path().join("dataset");
    let dataset_str = dataset_dir.to_str().unwrap().to_string();

    env::set_var("LMT_VBA_SIDECAR_PATH", wrapper.to_str().unwrap());

    // --- simulate ---
    let sim = simulate(SimulateArgs {
        config: json!({
            "scene": {
                "cabinet_array": {"cols": 2, "rows": 1, "cabinet_size_mm": [600, 340]},
                "shape_prior": "flat",
                "inter_board_angle_deg": 10.0
            },
            "cameras": {
                "n_views": 20,
                "distance_mm_range": [1500, 3000],
                "yaw_deg_range": [-40, 40],
                "pitch_deg_range": [-20, 20]
            },
            "intrinsics": {
                "K": [[2000, 0, 960], [0, 2000, 540], [0, 0, 1]],
                "dist_coeffs": [0, 0, 0, 0, 0],
                "image_size": [1920, 1080]
            },
            "noise": {"pixel_sigma": 0.3, "visibility_frac": 0.8},
            "seed": 2,
            "out_dir": dataset_str
        }),
        progress_tx: None,
        cancel: None,
    })
    .await;

    let sim = match sim {
        Ok(s) => s,
        Err(e) => {
            env::remove_var("LMT_VBA_SIDECAR_PATH");
            panic!("simulate failed: {e}");
        }
    };
    assert_eq!(sim.n_views, 20, "n_views");
    assert_eq!(sim.dataset_dir, dataset_str, "dataset_dir echoes out_dir");

    // --- eval ---
    let ev = eval(EvalArgs {
        dataset_dir: dataset_str.clone(),
        method: "charuco".into(),
        seed_matrix: vec![2],
        init: "near_truth".into(),
        progress_tx: None,
        cancel: None,
    })
    .await;

    env::remove_var("LMT_VBA_SIDECAR_PATH");

    let ev = ev.expect("eval should succeed");
    assert_eq!(ev.method, "charuco");
    assert!(
        ev.max_distance_error_mm < 3.0,
        "max_distance_error_mm = {} should be < 3.0",
        ev.max_distance_error_mm
    );
}

#[tokio::test]
async fn compare_known_roundtrip() {
    let _guard = ENV_LOCK.lock().unwrap();

    let python = match sidecar_python() {
        Some(p) => p,
        None => {
            eprintln!("skipping compare_known_roundtrip: python-sidecar venv not found");
            return;
        }
    };

    let tmp = tempfile::tempdir().expect("tmpdir");
    let wrapper = write_wrapper(tmp.path(), &python);

    let report = json!({
        "schema_version": "visual_pose_report.v1",
        "frame": {},
        "cabinet_poses": [
            {
                "cabinet_id": "V000_R000",
                "position_mm": [0, 0, 0],
                "normal": [0, 0, 1],
                "rotation_matrix": [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                "corners_mm": [[-300, -170, 0], [300, -170, 0], [300, 170, 0], [-300, 170, 0]],
                "reprojection_rms_px": 0.4,
                "observed_views": 7,
                "observed_points": 120,
                "quality": "ok"
            },
            {
                "cabinet_id": "V001_R000",
                "position_mm": [702, 0, 0],
                "normal": [0.0, 0.0, 1.0],
                "rotation_matrix": [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                "corners_mm": [[-300, -170, 0], [300, -170, 0], [300, 170, 0], [-300, 170, 0]],
                "reprojection_rms_px": 0.4,
                "observed_views": 7,
                "observed_points": 120,
                "quality": "ok"
            }
        ]
    });
    let known = json!({
        "cabinets": {"V000_R000": {"size_mm": [600, 340]}, "V001_R000": {"size_mm": [600, 340]}},
        "pairs": [{"a": "V000_R000", "b": "V001_R000", "distance_mm": 700.0, "angle_deg": 0.0}]
    });
    let report_path = tmp.path().join("report.json");
    let known_path = tmp.path().join("known.json");
    std::fs::write(&report_path, serde_json::to_string(&report).unwrap()).unwrap();
    std::fs::write(&known_path, serde_json::to_string(&known).unwrap()).unwrap();

    env::set_var("LMT_VBA_SIDECAR_PATH", wrapper.to_str().unwrap());

    let res = compare_known(CompareKnownArgs {
        report_path: report_path.to_str().unwrap().to_string(),
        known_path: known_path.to_str().unwrap().to_string(),
        max_size_mm: None,
        max_dist_mm: None,
        max_angle_deg: None,
        progress_tx: None,
        cancel: None,
    })
    .await;

    env::remove_var("LMT_VBA_SIDECAR_PATH");

    let res = res.expect("compare_known should succeed");
    assert!(res.passed, "2mm distance error within default 3mm threshold");
    assert_eq!(res.pairs.len(), 1);
    assert!(
        (res.pairs[0].distance_error_mm - 2.0).abs() < 1e-6,
        "distance_error_mm = {} should be 2.0",
        res.pairs[0].distance_error_mm
    );
}
