//! Test the PoC compare logic: read two MeasuredPoints sets, compute holdout RMS.

use std::process::Command;

#[test]
fn poc_compare_emits_holdout_rms_in_c_mode() {
    let out = Command::new(env!("CARGO_BIN_EXE_mesh-poc-compare"))
        .args([
            "--ground-truth",
            "tests/fixtures/poc_gt.json",
            "--measured",
            "tests/fixtures/poc_visual_c.json",
            "--frame-strategy",
            "three_points",
            "--anchor-ids",
            "MAIN_V000_R000_AR0,MAIN_V001_R000_AR64,MAIN_V000_R001_AR128",
        ])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let report: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert!(report.get("holdout_rms_mm").is_some());
    assert!(report.get("holdout_p95_mm").is_some());
    assert!(report.get("anchor_residual_rms_mm").is_some());
    assert_eq!(report["frame_strategy"], "three_points");
}

#[test]
fn poc_compare_empty_match_set_fails() {
    // Finding 1 regression: with totally unrelated names in the measured file,
    // no points match → the tool must fail closed, not report RMS=0.0.
    let out = Command::new(env!("CARGO_BIN_EXE_mesh-poc-compare"))
        .args([
            "--ground-truth",
            "tests/fixtures/poc_gt.json",
            "--measured",
            "tests/fixtures/poc_visual_mismatched_names.json",
            "--frame-strategy",
            "nominal_anchoring",
        ])
        .output()
        .unwrap();
    assert!(!out.status.success());
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(
        err.contains("no MeasuredPoint names matched"),
        "stderr: {err}"
    );
}

#[test]
fn poc_compare_three_points_with_wrong_anchor_count_fails() {
    // Finding 1 regression: three_points requires exactly 3 anchors.
    let out = Command::new(env!("CARGO_BIN_EXE_mesh-poc-compare"))
        .args([
            "--ground-truth",
            "tests/fixtures/poc_gt.json",
            "--measured",
            "tests/fixtures/poc_visual_c.json",
            "--frame-strategy",
            "three_points",
            "--anchor-ids",
            "MAIN_V000_R000_AR0,MAIN_V001_R000_AR64", // only 2
        ])
        .output()
        .unwrap();
    assert!(!out.status.success());
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.contains("exactly 3"), "stderr: {err}");
}

#[test]
fn poc_compare_low_coverage_fails_without_allow_partial() {
    // Finding (round 2): 1 of 4 GT points matched = 25% coverage; default
    // 90% threshold must reject.
    let out = Command::new(env!("CARGO_BIN_EXE_mesh-poc-compare"))
        .args([
            "--ground-truth",
            "tests/fixtures/poc_gt.json",
            "--measured",
            "tests/fixtures/poc_visual_partial.json",
            "--frame-strategy",
            "nominal_anchoring",
        ])
        .output()
        .unwrap();
    assert!(!out.status.success());
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(
        err.contains("coverage") && err.contains("below"),
        "stderr: {err}"
    );
}

#[test]
fn poc_compare_low_coverage_allowed_with_allow_partial() {
    // Same 25% coverage, but explicit --allow-partial → succeeds.
    let out = Command::new(env!("CARGO_BIN_EXE_mesh-poc-compare"))
        .args([
            "--ground-truth",
            "tests/fixtures/poc_gt.json",
            "--measured",
            "tests/fixtures/poc_visual_partial.json",
            "--frame-strategy",
            "nominal_anchoring",
            "--allow-partial",
        ])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let report: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(report["n_compared"], 1);
}

#[test]
fn poc_compare_three_points_with_unmatched_anchor_names_fails() {
    // Finding 1 regression: if user supplies anchor IDs that don't match any
    // measured point name (e.g. raw numeric ArUco IDs), the tool fails closed
    // instead of returning an undefined gate metric.
    let out = Command::new(env!("CARGO_BIN_EXE_mesh-poc-compare"))
        .args([
            "--ground-truth",
            "tests/fixtures/poc_gt.json",
            "--measured",
            "tests/fixtures/poc_visual_c.json",
            "--frame-strategy",
            "three_points",
            "--anchor-ids",
            "0,64,128", // numeric IDs — won't match names
        ])
        .output()
        .unwrap();
    assert!(!out.status.success());
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.contains("anchor name"), "stderr: {err}");
}

#[test]
fn poc_compare_a_mode_uses_all_points() {
    let out = Command::new(env!("CARGO_BIN_EXE_mesh-poc-compare"))
        .args([
            "--ground-truth",
            "tests/fixtures/poc_gt.json",
            "--measured",
            "tests/fixtures/poc_visual_a.json",
            "--frame-strategy",
            "nominal_anchoring",
        ])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let report: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert!(report.get("rms_mm").is_some());
    assert!(report.get("p95_mm").is_some());
}
