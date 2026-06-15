//! lmt-cli E2E 测试 —— 直接 spawn `lmt` binary,模拟 agent 调用。
//!
//! 覆盖维度:
//! - `--version` / `--help` 出口
//! - `schema` 子命令 stdout 是合法 JSON envelope
//! - `total-station import` 完整路径:happy / dry-run / refuse-no-yes / cross-screen 冲突
//! - `project save` + `load` round-trip
//! - `reconstruct surface` → `list-runs` → `get-run-report` → `export obj` 全链路
//! - `--json` 模式下 stderr 只含一条 envelope(`reconstruct` 算法路径有 tracing,
//!   是 JSON 隔离测试的硬条件)
//! - `--timeout` 暴露为 unsupported(v0 未实现)
//! - 任意 destructive 命令在 `--dry-run` 下不创建 DB 文件

use assert_cmd::Command;
use serde_json::Value;
use std::path::Path;
use tempfile::TempDir;

/// 重用 workspace 内 `examples/curved-flat`,跟既有 src-tauri 集成测试一致。
fn examples_root() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../examples")
}

/// 复制一个 examples/<name> 到给定目录下。返回拷贝出的 project 根。
fn seed_project(into: &Path, example: &str) -> std::path::PathBuf {
    let src = examples_root().join(example);
    let dst = into.join(example);
    copy_dir(&src, &dst);
    dst
}

fn copy_dir(src: &Path, dst: &Path) {
    std::fs::create_dir_all(dst).unwrap();
    for entry in std::fs::read_dir(src).unwrap() {
        let entry = entry.unwrap();
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            copy_dir(&from, &to);
        } else {
            std::fs::copy(&from, &to).unwrap();
        }
    }
}

/// Drive the unified `voloctl` binary with the `lmt` subcommand pre-injected, so
/// every migrated call site (`lmt().args([...])`) becomes `voloctl lmt ...`
/// without touching the 99 individual tests. The lmt subtree's global flags
/// (`--json`, `--db`, `--yes`, …) are parsed *after* the `lmt` token, so callers
/// that pass them in `.args([...])` keep working unchanged.
fn lmt() -> Command {
    let mut c = Command::cargo_bin("voloctl").expect("voloctl binary should build");
    c.arg("lmt");
    c
}

// ── 版本 / schema ────────────────────────────────────────────────────────────

#[test]
fn version_prints_semver_line() {
    let out = lmt().arg("--version").assert().success().get_output().clone();
    let s = String::from_utf8_lossy(&out.stdout);
    assert!(s.contains("lmt "), "stdout: {s}");
}

#[test]
fn schema_json_envelope_has_known_types() {
    let out = lmt().args(["--json", "schema"]).assert().success().get_output().clone();
    let env: Value = serde_json::from_slice(&out.stdout).expect("stdout must be JSON envelope");
    assert_eq!(env["ok"], true);
    assert_eq!(env["meta"]["schema_version"], "1");
    let types = env["data"]["types"].as_object().expect("types map");
    for name in [
        "ProjectConfig",
        "TotalStationImportResult",
        "ReconstructionRun",
        "LmtError",
        "ApiError",
        "Envelope",
        "ErrorEnvelope",
    ] {
        assert!(types.contains_key(name), "missing schema for {name}: keys={:?}", types.keys().collect::<Vec<_>>());
    }
}

// ── version subcommand ────────────────────────────────────────────────────────

#[test]
fn version_subcommand_json_has_version_and_schema() {
    let out = lmt().args(["--json", "version"]).assert().success().get_output().clone();
    let env: Value = serde_json::from_slice(&out.stdout).expect("JSON envelope");
    assert_eq!(env["ok"], true);
    assert!(env["data"]["version"].as_str().unwrap().len() > 0);
    assert_eq!(env["data"]["schema_version"], "1");
    assert_eq!(env["data"]["contract_version"], "1.0");
}

// ── manifest ─────────────────────────────────────────────────────────────────

#[test]
fn manifest_json_lists_operations_with_ids() {
    let out = lmt().args(["--json", "manifest"]).assert().success().get_output().clone();
    let env: Value = serde_json::from_slice(&out.stdout).expect("stdout must be JSON envelope");
    assert_eq!(env["ok"], true);
    let ops = env["data"]["operations"].as_array().expect("operations array");
    let ids: Vec<&str> = ops.iter().map(|o| o["operation_id"].as_str().unwrap()).collect();
    assert!(ids.contains(&"reconstruct.surface"), "ids: {ids:?}");
    assert!(ids.contains(&"project.list_recent"), "ids: {ids:?}");
    assert_eq!(env["data"]["contract_version"], "1.0");
}

#[test]
fn manifest_human_mode_is_text_not_json() {
    let out = lmt().arg("manifest").assert().success().get_output().clone();
    let s = String::from_utf8_lossy(&out.stdout);
    assert!(serde_json::from_str::<Value>(&s).is_err(), "human mode should not be JSON: {s}");
    assert!(s.contains("reconstruct.surface"), "stdout: {s}");
}

// ── --timeout 未实现 ─────────────────────────────────────────────────────────

#[test]
fn timeout_flag_rejected_as_unsupported() {
    let assert = lmt().args(["--timeout", "5", "schema"]).assert().failure();
    let out = assert.get_output();
    // exit code 7 = UNSUPPORTED(见 lmt_shared::exit_codes)
    assert_eq!(out.status.code(), Some(7));
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("unsupported"), "stderr: {stderr}");
}

// ── total-station import: refuse / dry-run / execute / cross-screen 冲突 ────

#[test]
fn import_refuses_without_yes_or_dry_run() {
    let tmp = TempDir::new().unwrap();
    let proj = seed_project(tmp.path(), "curved-flat");
    let csv = proj.join("measurements").join("raw.csv");

    let assert = lmt()
        .args([
            "total-station",
            "import",
            proj.to_str().unwrap(),
            "MAIN",
            csv.to_str().unwrap(),
        ])
        .assert()
        .failure();
    // INVALID_INPUT = 2
    assert_eq!(assert.get_output().status.code(), Some(2));
}

#[test]
fn import_dry_run_does_not_write_files() {
    let tmp = TempDir::new().unwrap();
    let proj = seed_project(tmp.path(), "curved-flat");
    let csv = proj.join("measurements").join("raw.csv");

    lmt()
        .args([
            "--dry-run",
            "total-station",
            "import",
            proj.to_str().unwrap(),
            "MAIN",
            csv.to_str().unwrap(),
        ])
        .assert()
        .success();

    // 既有 measured.yaml 是 example 自带的,但 import_report.json 是 import 产物。
    // dry-run 必须不写 import_report.json(也不动 measured.yaml.bak 等)。
    assert!(
        !proj.join("measurements/import_report.json").exists(),
        "dry-run must not write import_report.json"
    );
    assert!(
        !proj.join("measurements/measured.yaml.bak").exists(),
        "dry-run must not create .bak"
    );
}

#[test]
fn import_dry_run_refuses_cross_screen_conflict() {
    let tmp = TempDir::new().unwrap();
    let proj = seed_project(tmp.path(), "curved-flat");
    // 把 measured.yaml 改成另一个 screen 的数据,模拟"被另一个 screen 占用"。
    let stale = "screen_id: FLOOR\ncoordinate_frame:\n  origin_world: [0.0, 0.0, 0.0]\npoints: []\n";
    std::fs::write(proj.join("measurements/measured.yaml"), stale).unwrap();

    let csv = proj.join("measurements").join("raw.csv");
    let assert = lmt()
        .args([
            "--dry-run",
            "total-station",
            "import",
            proj.to_str().unwrap(),
            "MAIN",
            csv.to_str().unwrap(),
        ])
        .assert()
        .failure();
    let out = assert.get_output();
    // INVALID_INPUT = 2(checkok 复用 run_import 的 cross-screen guard)
    assert_eq!(out.status.code(), Some(2));
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("FLOOR"), "stderr: {stderr}");
}

#[test]
fn import_yes_writes_artifacts_and_envelope() {
    let tmp = TempDir::new().unwrap();
    let proj = seed_project(tmp.path(), "curved-flat");
    let csv = proj.join("measurements").join("raw.csv");

    let assert = lmt()
        .args([
            "--yes",
            "--json",
            "total-station",
            "import",
            proj.to_str().unwrap(),
            "MAIN",
            csv.to_str().unwrap(),
        ])
        .assert()
        .success();
    let env: Value = serde_json::from_slice(&assert.get_output().stdout).unwrap();
    assert_eq!(env["ok"], true);
    assert!(env["data"]["measuredCount"].as_u64().unwrap() >= 3);
    assert!(proj.join("measurements/import_report.json").is_file());
}

// ── --json stderr 隔离:错误时 stderr 单条 envelope,无 tracing 噪音 ───────

#[test]
fn json_error_stderr_contains_only_envelope() {
    let tmp = TempDir::new().unwrap();
    let proj = seed_project(tmp.path(), "curved-flat");

    // 拿一个会失败的命令(unknown screen)。
    let assert = lmt()
        .args([
            "--json",
            "total-station",
            "instruction-card",
            proj.to_str().unwrap(),
            "BOGUS_SCREEN",
        ])
        .assert()
        .failure();
    let stderr = std::str::from_utf8(&assert.get_output().stderr).unwrap().trim_end();
    // 只有一行;且整行是合法 JSON envelope(ok=false)。
    assert!(
        !stderr.contains('\n'),
        "stderr must be a single line envelope; got:\n{stderr}"
    );
    let env: Value = serde_json::from_str(stderr).expect("stderr must be JSON envelope");
    assert_eq!(env["ok"], false);
    assert!(env["error"]["code"].as_str().unwrap_or("").len() > 0);
}

// ── project save → load round-trip(覆盖 --input + write_safe) ────────────

#[test]
fn project_save_load_roundtrip_via_input_file() {
    let tmp = TempDir::new().unwrap();
    let dst = tmp.path().join("new-project");
    let input = tmp.path().join("input.yaml");
    let yaml = r#"
project:
  name: RoundTrip
  unit: mm
screens:
  S1:
    cabinet_count: [2, 2]
    cabinet_size_mm: [500.0, 500.0]
    shape_prior:
      type: flat
    shape_mode: rectangle
    irregular_mask: []
coordinate_system:
  origin_point: S1_V001_R001
  x_axis_point: S1_V003_R001
  xy_plane_point: S1_V001_R003
output:
  target: neutral
  obj_filename: "{screen_id}.obj"
  weld_vertices_tolerance_mm: 1.0
  triangulate: true
"#;
    std::fs::write(&input, yaml).unwrap();

    // save 是 destructive,必须 --yes。
    lmt()
        .args([
            "--yes",
            "project",
            "save",
            dst.to_str().unwrap(),
            "--input",
            input.to_str().unwrap(),
        ])
        .assert()
        .success();
    assert!(dst.join("project.yaml").is_file());

    let load = lmt()
        .args(["--json", "project", "load", dst.to_str().unwrap()])
        .assert()
        .success();
    let env: Value = serde_json::from_slice(&load.get_output().stdout).unwrap();
    assert_eq!(env["data"]["project"]["name"], "RoundTrip");
}

// ── 全链路:import → reconstruct → list-runs → get-run-report → export ────

#[test]
fn full_pipeline_import_reconstruct_export() {
    let tmp = TempDir::new().unwrap();
    let proj = seed_project(tmp.path(), "curved-flat");
    let db = tmp.path().join("lmt.sqlite");
    let csv = proj.join("measurements").join("raw.csv");

    // 1) import
    lmt()
        .args([
            "--yes",
            "--db",
            db.to_str().unwrap(),
            "total-station",
            "import",
            proj.to_str().unwrap(),
            "MAIN",
            csv.to_str().unwrap(),
        ])
        .assert()
        .success();

    // 2) reconstruct surface
    let reconstruct = lmt()
        .args([
            "--yes",
            "--json",
            "--db",
            db.to_str().unwrap(),
            "reconstruct",
            "surface",
            proj.to_str().unwrap(),
            "MAIN",
            "measurements/measured.yaml",
        ])
        .assert()
        .success();
    let env: Value = serde_json::from_slice(&reconstruct.get_output().stdout).unwrap();
    let run_id = env["data"]["run_id"].as_i64().expect("run_id");
    assert!(run_id > 0);
    // FIX-12: grid 全采样走 direct_link(精确插值,无 holdout)→ 残差字段
    // 诚实为 null,不再是输入 σ 的回声。
    if env["data"]["method"] == "direct_link" {
        assert!(
            env["data"]["estimated_rms_mm"].is_null(),
            "direct_link must report null fit residual, got {}",
            env["data"]["estimated_rms_mm"]
        );
        assert!(env["data"]["estimated_p95_mm"].is_null());
    }

    // 3) list-runs(走 readonly DB,跟 reconstruct 同库)
    let list = lmt()
        .args([
            "--json",
            "--db",
            db.to_str().unwrap(),
            "reconstruct",
            "list-runs",
            proj.to_str().unwrap(),
        ])
        .assert()
        .success();
    let listed: Value = serde_json::from_slice(&list.get_output().stdout).unwrap();
    assert_eq!(listed["data"][0]["id"].as_i64(), Some(run_id));

    // 4) get-run-report(返回 report.json 原始 Value)
    let report = lmt()
        .args([
            "--json",
            "--db",
            db.to_str().unwrap(),
            "reconstruct",
            "get-run-report",
            &run_id.to_string(),
        ])
        .assert()
        .success();
    let rep_env: Value = serde_json::from_slice(&report.get_output().stdout).unwrap();
    assert_eq!(rep_env["data"]["screen_id"], "MAIN");

    // 5) export obj(destructive)
    let export = lmt()
        .args([
            "--yes",
            "--json",
            "--db",
            db.to_str().unwrap(),
            "export",
            "obj",
            &run_id.to_string(),
            "neutral",
        ])
        .assert()
        .success();
    let exp_env: Value = serde_json::from_slice(&export.get_output().stdout).unwrap();
    let written = exp_env["data"]["written"].as_str().expect("written path");
    assert!(Path::new(written).is_file(), "OBJ should exist at {written}");
}

// ── read-only / dry-run 不创建 default DB ─────────────────────────────────

#[test]
fn dry_run_remove_recent_does_not_create_db_file() {
    let tmp = TempDir::new().unwrap();
    let db = tmp.path().join("nonexistent.sqlite");
    lmt()
        .args([
            "--db",
            db.to_str().unwrap(),
            "--dry-run",
            "project",
            "remove-recent",
            "99",
        ])
        .assert()
        .success();
    assert!(!db.exists(), "dry-run must not create the DB file");
}

#[test]
fn list_recent_against_missing_db_returns_empty_envelope() {
    let tmp = TempDir::new().unwrap();
    let db = tmp.path().join("nonexistent.sqlite");
    let out = lmt()
        .args([
            "--json",
            "--db",
            db.to_str().unwrap(),
            "project",
            "list-recent",
        ])
        .assert()
        .success();
    let env: Value = serde_json::from_slice(&out.get_output().stdout).unwrap();
    assert_eq!(env["ok"], true);
    assert!(
        env["data"].as_array().unwrap().is_empty(),
        "list-recent against missing DB must yield []"
    );
    assert!(!db.exists(), "list-recent must not create the DB file");
}

// ── parse error 走 envelope when --json ──────────────────────────────────────

#[test]
fn parse_error_with_json_yields_envelope_on_stderr() {
    let assert = lmt()
        .args(["--json", "project", "load"]) // 缺 required ABS_PATH
        .assert()
        .failure();
    // INVALID_INPUT = 2
    assert_eq!(assert.get_output().status.code(), Some(2));
    let stderr = std::str::from_utf8(&assert.get_output().stderr).unwrap().trim_end();
    let env: Value = serde_json::from_str(stderr).expect("stderr must be JSON envelope");
    assert_eq!(env["ok"], false);
    assert_eq!(env["error"]["code"], "invalid_input");
}

// ── scatter 模式 E2E ──────────────────────────────────────────────────────────

/// 散点 fixture 的 project.yaml（curved 55×15，radius 9523mm）。
fn write_scatter_project_yaml(dir: &Path) {
    let yaml = r#"project: { name: ScatterArc, unit: mm }
screens:
  MAIN:
    cabinet_count: [55, 15]
    cabinet_size_mm: [500, 500]
    pixels_per_cabinet: [256, 256]
    shape_prior: { type: curved, radius_mm: 9523 }
    shape_mode: rectangle
    irregular_mask: []
coordinate_system:
  origin_point: MAIN_V001_R001
  x_axis_point: MAIN_V055_R001
  xy_plane_point: MAIN_V001_R015
output:
  target: neutral
  obj_filename: "{screen_id}.obj"
  weld_vertices_tolerance_mm: 1.0
  triangulate: true
"#;
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(dir.join("project.yaml"), yaml).unwrap();
    std::fs::create_dir_all(dir.join("measurements")).unwrap();
}

/// 散点 CSV fixture 绝对路径（crates/lmt-cli/tests/fixtures/scatter_arc.csv）。
fn scatter_csv_path() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/scatter_arc.csv")
}

/// 随机噪声散点：点散在 20m 立方体内，inlier < 50% → surface_fit_failed。
fn write_noise_csv(path: &Path) {
    use std::fmt::Write as _;
    let mut s = String::new();
    for i in 0..80 {
        // 随机但确定性的坐标：完全不在圆柱面上
        let x = (i as f64 * 1234.567 + 333.0) % 20000.0 - 10000.0;
        let y = (i as f64 * 987.654 + 111.0) % 20000.0 - 10000.0;
        let z = (i as f64 * 543.21 + 55.0) % 15000.0;
        writeln!(s, "P{i},,{x:.3},{y:.3},{z:.3}").unwrap();
    }
    std::fs::write(path, s).unwrap();
}

/// 1. scatter import → reconstruct surface → list-runs → export obj（全链路 happy）
#[test]
fn scatter_import_reconstruct_export_happy() {
    let tmp = TempDir::new().unwrap();
    let proj = tmp.path().join("scatter-arc");
    write_scatter_project_yaml(&proj);
    let db = tmp.path().join("lmt.sqlite");
    let csv = scatter_csv_path();

    // import --mode scatter --columns x=3,y=4,z=5,label=1 --yes
    lmt()
        .args([
            "--yes",
            "--json",
            "--db",
            db.to_str().unwrap(),
            "total-station",
            "import",
            "--mode",
            "scatter",
            "--columns",
            "x=3,y=4,z=5,label=1",
            proj.to_str().unwrap(),
            "MAIN",
            csv.to_str().unwrap(),
        ])
        .assert()
        .success();

    assert!(proj.join("measurements/measured.yaml").is_file(), "measured.yaml must exist");

    // reconstruct surface
    let reconstruct = lmt()
        .args([
            "--yes",
            "--json",
            "--db",
            db.to_str().unwrap(),
            "reconstruct",
            "surface",
            proj.to_str().unwrap(),
            "MAIN",
            "measurements/measured.yaml",
        ])
        .assert()
        .success();
    let rec_env: Value = serde_json::from_slice(&reconstruct.get_output().stdout).unwrap();
    let run_id = rec_env["data"]["run_id"].as_i64().expect("run_id in envelope");
    assert!(run_id > 0);
    // FIX-12: scatter 路径有真实拟合残差(inlier 到形状的距离)→ 必须是数值。
    assert!(
        rec_env["data"]["estimated_rms_mm"].is_f64(),
        "scatter surface_fit must report numeric fit residual, got {}",
        rec_env["data"]["estimated_rms_mm"]
    );

    // list-runs
    let list = lmt()
        .args([
            "--json",
            "--db",
            db.to_str().unwrap(),
            "reconstruct",
            "list-runs",
            proj.to_str().unwrap(),
        ])
        .assert()
        .success();
    let listed: Value = serde_json::from_slice(&list.get_output().stdout).unwrap();
    assert_eq!(listed["data"][0]["id"].as_i64(), Some(run_id));

    // export obj
    let out_obj = tmp.path().join("out.obj");
    let export = lmt()
        .args([
            "--yes",
            "--json",
            "--db",
            db.to_str().unwrap(),
            "export",
            "obj",
            &run_id.to_string(),
            "neutral",
            "--dst",
            out_obj.to_str().unwrap(),
        ])
        .assert()
        .success();
    let exp_env: Value = serde_json::from_slice(&export.get_output().stdout).unwrap();
    assert_eq!(exp_env["ok"], true);
    assert!(out_obj.is_file(), "OBJ file should exist at {:?}", out_obj);
}

/// 2. scatter import 无 --yes → exit 2（refuse）
#[test]
fn scatter_import_refuses_without_yes() {
    let tmp = TempDir::new().unwrap();
    let proj = tmp.path().join("scatter-arc");
    write_scatter_project_yaml(&proj);
    let csv = scatter_csv_path();

    let assert = lmt()
        .args([
            "total-station",
            "import",
            "--mode",
            "scatter",
            "--columns",
            "x=3,y=4,z=5,label=1",
            proj.to_str().unwrap(),
            "MAIN",
            csv.to_str().unwrap(),
        ])
        .assert()
        .failure();
    // INVALID_INPUT = 2（gate_destructive refuse）
    assert_eq!(assert.get_output().status.code(), Some(2));
    // measured.yaml 不能被创建
    assert!(
        !proj.join("measurements/measured.yaml").is_file(),
        "measured.yaml must not be created when refused"
    );
}

/// 3. scatter dry-run + bad columns 格式 → exit 2（invalid_input，列号非数字）
#[test]
fn scatter_import_dryrun_bad_columns() {
    let tmp = TempDir::new().unwrap();
    let proj = tmp.path().join("scatter-arc");
    write_scatter_project_yaml(&proj);
    let csv = scatter_csv_path();

    let assert = lmt()
        .args([
            "--dry-run",
            "--json",
            "total-station",
            "import",
            "--mode",
            "scatter",
            "--columns",
            "x=abc",  // 列号非数字
            proj.to_str().unwrap(),
            "MAIN",
            csv.to_str().unwrap(),
        ])
        .assert()
        .failure();
    assert_eq!(assert.get_output().status.code(), Some(2));
    let stderr = std::str::from_utf8(&assert.get_output().stderr).unwrap().trim_end();
    let env: Value = serde_json::from_str(stderr).expect("stderr must be JSON envelope");
    assert_eq!(env["ok"], false);
    assert_eq!(env["error"]["code"], "invalid_input");
}

// ── --output flag + ndjson mode ───────────────────────────────────────────────

#[test]
fn output_json_is_alias_for_legacy_json_flag() {
    let out = lmt().args(["--output", "json", "schema"]).assert().success().get_output().clone();
    let env: Value = serde_json::from_slice(&out.stdout).expect("stdout JSON envelope");
    assert_eq!(env["ok"], true);
}

#[test]
fn output_ndjson_schema_emits_result_event() {
    let out = lmt().args(["--output", "ndjson", "schema"]).assert().success().get_output().clone();
    let line = String::from_utf8_lossy(&out.stdout);
    let v: Value = serde_json::from_str(line.trim()).expect("one ndjson line");
    assert_eq!(v["type"], "result");
    assert_eq!(v["final"], true);
}

#[test]
fn legacy_json_flag_still_works() {
    lmt().args(["--json", "schema"]).assert().success();
}

#[test]
fn no_color_and_no_input_flags_accepted() {
    lmt().args(["--no-color", "--no-input", "schema"]).assert().success();
}

#[test]
fn output_equals_json_invalid_flag_yields_envelope_on_stderr() {
    // spec §3.1 要求 parser 接受 --key=value;machine 模式检测不能漏 --output=json,
    // 否则 parse error 会 fallback 到 human clap 输出而非 JSON envelope。
    let assert = lmt().args(["--output=json", "--bogus"]).assert().failure();
    let out = assert.get_output();
    assert_eq!(out.status.code(), Some(2));
    let env: Value = serde_json::from_slice(&out.stderr).expect("stderr JSON envelope");
    assert_eq!(env["ok"], false);
}

// ── completion ────────────────────────────────────────────────────────────────

#[test]
fn completion_bash_emits_script_to_stdout() {
    let out = lmt().args(["completion", "bash"]).assert().success().get_output().clone();
    let s = String::from_utf8_lossy(&out.stdout);
    assert!(s.contains("lmt"), "bash completion should mention lmt: first 80 = {:?}", &s[..s.len().min(80)]);
}

/// 4. 随机噪声散点 → import ok → reconstruct → exit 12 surface_fit_failed
#[test]
fn scatter_reconstruct_fit_failure_surface_fit_failed() {
    let tmp = TempDir::new().unwrap();
    let proj = tmp.path().join("scatter-noise");
    write_scatter_project_yaml(&proj);
    let db = tmp.path().join("lmt.sqlite");
    let csv = tmp.path().join("noise.csv");
    write_noise_csv(&csv);

    // import（应成功，import 只存原始散点）
    lmt()
        .args([
            "--yes",
            "--db",
            db.to_str().unwrap(),
            "total-station",
            "import",
            "--mode",
            "scatter",
            "--columns",
            "x=3,y=4,z=5",
            proj.to_str().unwrap(),
            "MAIN",
            csv.to_str().unwrap(),
        ])
        .assert()
        .success();

    // reconstruct → 应该失败 exit 12
    let reconstruct = lmt()
        .args([
            "--yes",
            "--json",
            "--db",
            db.to_str().unwrap(),
            "reconstruct",
            "surface",
            proj.to_str().unwrap(),
            "MAIN",
            "measurements/measured.yaml",
        ])
        .assert()
        .failure();
    let out = reconstruct.get_output();
    assert_eq!(out.status.code(), Some(12), "exit code must be 12 (surface_fit_failed)");
    let stderr = std::str::from_utf8(&out.stderr).unwrap().trim_end();
    let env: Value = serde_json::from_str(stderr).expect("stderr must be JSON envelope");
    assert_eq!(env["ok"], false);
    assert_eq!(env["error"]["code"], "surface_fit_failed");
}

// ── seed-example ──────────────────────────────────────────────────────────────

#[test]
fn seed_example_dry_run_does_not_write() {
    let tmp = TempDir::new().unwrap();
    let dst = tmp.path();
    let out = lmt()
        .args(["--json", "--dry-run", "seed-example", "curved-flat"])
        .arg(dst)
        .assert().success().get_output().clone();
    let env: Value = serde_json::from_slice(&out.stdout).expect("JSON envelope");
    assert_eq!(env["data"]["dry_run"], true);
    assert!(!dst.join("curved-flat/project.yaml").exists(), "dry-run must not write");
}

#[test]
fn seed_example_yes_writes_project_yaml() {
    let tmp = TempDir::new().unwrap();
    let dst = tmp.path();
    lmt().args(["--json", "--yes", "seed-example", "curved-flat"])
        .arg(dst)
        .assert().success();
    assert!(dst.join("curved-flat/project.yaml").is_file(), "expected seeded project.yaml");
    assert!(dst.join("curved-flat/measurements/measured.yaml").is_file(), "subdir file should be seeded recursively");
    assert!(dst.join("curved-flat/measurements/raw.csv").is_file(), "subdir file should be seeded recursively");
}

#[test]
fn seed_example_unknown_name_is_not_found() {
    let tmp = TempDir::new().unwrap();
    let assert = lmt()
        .args(["--json", "--yes", "seed-example", "does-not-exist"])
        .arg(tmp.path())
        .assert().failure();
    // not_found -> exit 3
    assert_eq!(assert.get_output().status.code(), Some(3));
}

#[test]
fn seed_example_dry_run_unknown_name_fails_fast() {
    // dry-run preflight 必须对未知 name 失败,而不是报 ok 让 agent 误以为安全。
    let tmp = TempDir::new().unwrap();
    let assert = lmt()
        .args(["--json", "--dry-run", "seed-example", "does-not-exist"])
        .arg(tmp.path())
        .assert().failure();
    assert_eq!(assert.get_output().status.code(), Some(3));
}

#[test]
fn seed_example_refuses_existing_destination_and_leaves_it_intact() {
    let tmp = TempDir::new().unwrap();
    let dst = tmp.path();
    // 第一次 seed 成功
    lmt().args(["--json", "--yes", "seed-example", "curved-flat"]).arg(dst).assert().success();
    // 在目标里放一个 sentinel,证明第二次 seed 不碰它
    let sentinel = dst.join("curved-flat/SENTINEL.txt");
    std::fs::write(&sentinel, "keep-me").unwrap();
    // 第二次 seed 同目标 -> 拒绝(invalid_input -> exit 2),sentinel 原样保留
    let assert = lmt()
        .args(["--json", "--yes", "seed-example", "curved-flat"]).arg(dst)
        .assert().failure();
    assert_eq!(assert.get_output().status.code(), Some(2));
    assert_eq!(std::fs::read_to_string(&sentinel).unwrap(), "keep-me");
}

// ── visual subcommand smoke tests (Task 1.9) ──────────────────────────────────

/// visual reconstruct with neither --capture-manifest nor --images →
/// INVALID_INPUT (exit 2). The method check (charuco) passes first, then
/// manifest resolution fails before gate_destructive is reached.
#[test]
fn visual_reconstruct_missing_manifest_is_invalid_input() {
    let tmp = TempDir::new().unwrap();
    let proj = tmp.path().join("proj");
    std::fs::create_dir_all(&proj).unwrap();

    let assert = lmt()
        .args([
            "--json",
            "visual",
            "reconstruct",
            proj.to_str().unwrap(),
            "MAIN",
            // no --capture-manifest, no --images, no --yes / --dry-run
        ])
        .assert()
        .failure();
    let out = assert.get_output();
    // invalid_input → exit 2
    assert_eq!(out.status.code(), Some(2), "expected exit 2 (invalid_input)");
    let stderr = std::str::from_utf8(&out.stderr).unwrap().trim_end();
    let env: Value = serde_json::from_str(stderr).expect("stderr must be JSON envelope");
    assert_eq!(env["ok"], false);
    assert_eq!(env["error"]["code"], "invalid_input");
}

/// visual reconstruct with --method structured-light → UNSUPPORTED (exit 7)
/// regardless of other flags.
#[test]
fn visual_reconstruct_structured_light_is_unsupported() {
    let tmp = TempDir::new().unwrap();
    let proj = tmp.path().join("proj");
    std::fs::create_dir_all(&proj).unwrap();
    // Create a dummy manifest file so we get past the path check.
    let manifest = tmp.path().join("manifest.json");
    std::fs::write(&manifest, "{}").unwrap();

    let assert = lmt()
        .args([
            "--json",
            "visual",
            "reconstruct",
            proj.to_str().unwrap(),
            "MAIN",
            "--capture-manifest",
            manifest.to_str().unwrap(),
            "--method",
            "structured-light",
            "--yes",
        ])
        .assert()
        .failure();
    let out = assert.get_output();
    // unsupported → exit 7
    assert_eq!(out.status.code(), Some(7), "expected exit 7 (unsupported)");
    let stderr = std::str::from_utf8(&out.stderr).unwrap().trim_end();
    let env: Value = serde_json::from_str(stderr).expect("stderr must be JSON envelope");
    assert_eq!(env["ok"], false);
    assert_eq!(env["error"]["code"], "unsupported");
}

// ── visual subcommand E2E tests (Task 1.10) ───────────────────────────────────

/// Build a sh wrapper at `<dir>/lmt-vba-sidecar` that execs the venv python as
/// `python -m lmt_vba_sidecar "$@"`.  We canonicalize only the `.venv/bin` dir
/// and re-append `python` so the symlink stays intact and `import lmt_vba_sidecar`
/// resolves correctly via the venv's sys.path.
///
/// Returns `None` if the python interpreter does not exist (CI without venv).
///
/// Unix-only: the wrapper is a POSIX `.sh` script (chmod 0o755) pointing at the
/// venv interpreter at `.venv/bin/python`. Windows lacks both, so this helper
/// and the real-sidecar tests below are excluded from compilation there.
#[cfg(unix)]
fn make_sidecar_wrapper(dir: &std::path::Path) -> Option<std::path::PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    // Rebased for the monorepo: the mesh-vba sidecar venv lives at
    // <root>/sidecars/mesh-vba/.venv (CARGO_MANIFEST_DIR = crates/volo-cli).
    let bin = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../sidecars/mesh-vba/.venv/bin");
    let bin = bin.canonicalize().ok()?;
    let python = bin.join("python");
    if !python.is_file() {
        return None;
    }
    let wrapper = dir.join("lmt-vba-sidecar");
    let script = format!(
        "#!/bin/sh\nexec \"{}\" -m lmt_vba_sidecar \"$@\"\n",
        python.display()
    );
    std::fs::write(&wrapper, &script).expect("write sidecar wrapper");
    let mut perms = std::fs::metadata(&wrapper).unwrap().permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(&wrapper, perms).expect("chmod sidecar wrapper");
    Some(wrapper)
}

/// Shared simulate config JSON (the `{scene, cameras, intrinsics, noise, seed}`
/// object; run_simulate injects out_dir). Reused by simulate + eval happy tests.
#[cfg(unix)]
fn sim_config_json() -> &'static str {
    r#"{"scene":{"cabinet_array":{"cols":2,"rows":1,"cabinet_size_mm":[600,340]},"shape_prior":"flat","inter_board_angle_deg":10.0},"cameras":{"n_views":20,"distance_mm_range":[1500,3000],"yaw_deg_range":[-40,40],"pitch_deg_range":[-20,20]},"intrinsics":{"K":[[2000,0,960],[0,2000,540],[0,0,1]],"dist_coeffs":[0,0,0,0,0],"image_size":[1920,1080]},"noise":{"pixel_sigma":0.3,"visibility_frac":0.8},"seed":2}"#
}

/// visual simulate — happy path (real sidecar).
/// Writes a simulate config, runs `lmt --json --yes visual simulate`, asserts
/// exit 0 + envelope ok + SimulateResult echo fields + scene.npz written to disk.
#[cfg(unix)]
#[test]
fn visual_simulate_happy() {
    let tmp = TempDir::new().unwrap();
    let wrapper = match make_sidecar_wrapper(tmp.path()) {
        Some(w) => w,
        None => {
            eprintln!("skipping visual_simulate_happy: python-sidecar venv not found");
            return;
        }
    };

    let config_path = tmp.path().join("sim_config.json");
    std::fs::write(&config_path, sim_config_json()).unwrap();
    let ds_dir = tmp.path().join("ds");

    let assert = lmt()
        .env("LMT_VBA_SIDECAR_PATH", &wrapper)
        .args([
            "--json",
            "--yes",
            "visual",
            "simulate",
            config_path.to_str().unwrap(),
            "--out",
            ds_dir.to_str().unwrap(),
        ])
        .assert()
        .success();

    let env: Value = serde_json::from_slice(&assert.get_output().stdout).unwrap();
    assert_eq!(env["ok"], true, "envelope ok: {env}");
    // SimulateResult echo field: n_views must round-trip the config through
    // output::ok wrapping (adapter-level test checks n_views==20 too).
    assert_eq!(env["data"]["n_views"], 20, "n_views must echo config");
    assert!(
        ds_dir.join("scene.npz").is_file(),
        "scene.npz must exist after simulate"
    );
}

/// visual eval — happy path (real sidecar, chained after simulate).
/// Runs simulate first to produce a dataset dir, then eval, asserting
/// exit 0 + envelope ok + max_distance_error_mm < 3.0 + method == "charuco".
#[cfg(unix)]
#[test]
fn visual_eval_happy() {
    let tmp = TempDir::new().unwrap();
    let wrapper = match make_sidecar_wrapper(tmp.path()) {
        Some(w) => w,
        None => {
            eprintln!("skipping visual_eval_happy: python-sidecar venv not found");
            return;
        }
    };

    // Step 1: simulate to produce the dataset.
    let config_path = tmp.path().join("sim_config.json");
    std::fs::write(&config_path, sim_config_json()).unwrap();
    let ds_dir = tmp.path().join("ds");

    lmt()
        .env("LMT_VBA_SIDECAR_PATH", &wrapper)
        .args([
            "--yes",
            "visual",
            "simulate",
            config_path.to_str().unwrap(),
            "--out",
            ds_dir.to_str().unwrap(),
        ])
        .assert()
        .success();

    // Step 2: eval against the simulated dataset.
    let assert = lmt()
        .env("LMT_VBA_SIDECAR_PATH", &wrapper)
        .args([
            "--json",
            "visual",
            "eval",
            ds_dir.to_str().unwrap(),
            "--method",
            "charuco",
            "--seed-matrix",
            "5",
        ])
        .assert()
        .success();

    let env: Value = serde_json::from_slice(&assert.get_output().stdout).unwrap();
    assert_eq!(env["ok"], true, "envelope ok: {env}");
    assert_eq!(env["data"]["method"], "charuco");
    let max_dist = env["data"]["max_distance_error_mm"]
        .as_f64()
        .expect("max_distance_error_mm must be f64");
    assert!(
        max_dist < 3.0,
        "max_distance_error_mm = {max_dist} should be < 3.0"
    );
    // FIX-9: the per-corner SE(3)-holdout headline rides the envelope and is
    // sane (clean synthetic scene -> small but present).
    let holdout = env["data"]["holdout_rms_mm"]
        .as_f64()
        .expect("holdout_rms_mm must be f64");
    assert!(
        holdout.is_finite() && holdout < 3.0,
        "holdout_rms_mm = {holdout} should be finite and < 3.0"
    );
    // FIX-9: seeds reports the dataset's actual seed (from meta.json: the sim
    // config used seed 2), not an echo of the requested seed_matrix [5].
    assert_eq!(env["data"]["seeds"], serde_json::json!([2]));
}

/// visual eval --init cold (FIX-10a) — real sidecar. Simulates a small TRUE-arc
/// wall with along-wall stations + FOV clipping, then evaluates through the
/// PRODUCTION init path (transitive bridging + nominal fallback + Stage-B).
#[cfg(unix)]
#[test]
fn visual_eval_cold_init_happy() {
    let tmp = TempDir::new().unwrap();
    let wrapper = match make_sidecar_wrapper(tmp.path()) {
        Some(w) => w,
        None => {
            eprintln!("skipping visual_eval_cold_init_happy: python-sidecar venv not found");
            return;
        }
    };

    let config_path = tmp.path().join("sim_arc.json");
    std::fs::write(
        &config_path,
        r#"{"scene":{"cabinet_array":{"cols":4,"rows":2,"cabinet_size_mm":[500,500]},"shape_prior":{"curved":{"radius_mm":1300.0}},"inter_board_angle_deg":0.0},"cameras":{"n_views":4,"distance_mm_range":[1400,1600],"yaw_deg_range":[-3,3],"pitch_deg_range":[-3,3],"trajectory":"along_wall"},"intrinsics":{"K":[[3000,0,2000],[0,3000,1500],[0,0,1]],"dist_coeffs":[0,0,0,0,0],"image_size":[4000,3000]},"noise":{"pixel_sigma":0.1,"visibility_frac":0.4},"seed":11}"#,
    )
    .unwrap();
    let ds_dir = tmp.path().join("ds_arc");

    lmt()
        .env("LMT_VBA_SIDECAR_PATH", &wrapper)
        .args([
            "--yes",
            "visual",
            "simulate",
            config_path.to_str().unwrap(),
            "--out",
            ds_dir.to_str().unwrap(),
        ])
        .assert()
        .success();

    let assert = lmt()
        .env("LMT_VBA_SIDECAR_PATH", &wrapper)
        .args([
            "--json",
            "visual",
            "eval",
            ds_dir.to_str().unwrap(),
            "--method",
            "charuco",
            "--init",
            "cold",
        ])
        .assert()
        .success();

    let env: Value = serde_json::from_slice(&assert.get_output().stdout).unwrap();
    assert_eq!(env["ok"], true, "envelope ok: {env}");
    let holdout = env["data"]["holdout_rms_mm"]
        .as_f64()
        .expect("holdout_rms_mm must be f64");
    assert!(
        holdout.is_finite() && holdout < 2.0,
        "cold-init holdout_rms_mm = {holdout} should be < 2.0"
    );
}

/// visual reconstruct dry-run — does NOT invoke the sidecar, does NOT write
/// measured.yaml. Verifies: exit 0, envelope ok == true, data.dry_run == true.
#[test]
fn visual_reconstruct_dry_run_writes_nothing() {
    let tmp = TempDir::new().unwrap();
    let proj = tmp.path().join("proj");
    std::fs::create_dir_all(&proj).unwrap();
    let manifest = tmp.path().join("manifest.json");
    std::fs::write(&manifest, "{}").unwrap();

    let assert = lmt()
        .args([
            "--json",
            "--dry-run",
            "visual",
            "reconstruct",
            proj.to_str().unwrap(),
            "MAIN",
            "--capture-manifest",
            manifest.to_str().unwrap(),
        ])
        .assert()
        .success();

    let env: Value = serde_json::from_slice(&assert.get_output().stdout).unwrap();
    assert_eq!(env["ok"], true, "envelope ok: {env}");
    assert_eq!(env["data"]["dry_run"], true);
    // No measured.yaml must have been written.
    assert!(
        !proj.join("measurements/measured.yaml").exists(),
        "dry-run must not write measured.yaml"
    );
}

/// visual reconstruct `--intrinsics auto` (+ `--intrinsics-crosscheck`) — clap must
/// accept the "auto" sentinel (no file needed) and both reach the dry-run payload
/// verbatim (the sidecar, not the CLI, branches on "auto"). No sidecar, no write.
#[test]
fn visual_reconstruct_auto_dry_run_writes_nothing() {
    let tmp = TempDir::new().unwrap();
    let proj = tmp.path().join("proj");
    std::fs::create_dir_all(&proj).unwrap();
    let manifest = tmp.path().join("manifest.json");
    std::fs::write(&manifest, "{}").unwrap();
    let anchor = tmp.path().join("anchor.json");
    std::fs::write(&anchor, "{}").unwrap();

    let assert = lmt()
        .args([
            "--json",
            "--dry-run",
            "visual",
            "reconstruct",
            proj.to_str().unwrap(),
            "MAIN",
            "--capture-manifest",
            manifest.to_str().unwrap(),
            "--intrinsics",
            "auto",
            "--intrinsics-crosscheck",
            anchor.to_str().unwrap(),
        ])
        .assert()
        .success();

    let env: Value = serde_json::from_slice(&assert.get_output().stdout).unwrap();
    assert_eq!(env["ok"], true, "envelope ok: {env}");
    assert_eq!(env["data"]["dry_run"], true);
    assert_eq!(env["data"]["intrinsics"], "auto");
    assert_eq!(env["data"]["intrinsics_crosscheck"], anchor.to_str().unwrap());
    assert!(
        !proj.join("measurements/measured.yaml").exists(),
        "dry-run must not write measured.yaml"
    );
}

/// visual simulate refuse — no --yes and no --dry-run → gate_destructive
/// refuses, exit 2 (invalid_input).
#[test]
fn visual_simulate_refuses_without_yes() {
    let tmp = TempDir::new().unwrap();
    let config_path = tmp.path().join("sim_config.json");
    std::fs::write(&config_path, "{}").unwrap();
    let ds_dir = tmp.path().join("ds");

    let assert = lmt()
        .args([
            "--json",
            "visual",
            "simulate",
            config_path.to_str().unwrap(),
            "--out",
            ds_dir.to_str().unwrap(),
        ])
        .assert()
        .failure();
    let out = assert.get_output();
    // gate_destructive refuse → INVALID_INPUT = 2
    assert_eq!(out.status.code(), Some(2));
    let stderr = std::str::from_utf8(&out.stderr).unwrap().trim_end();
    let env: Value = serde_json::from_str(stderr).expect("stderr must be JSON envelope");
    assert_eq!(env["ok"], false);
    assert_eq!(env["error"]["code"], "invalid_input");
    assert!(!ds_dir.exists(), "ds dir must not be created when refused");
}

/// Fix 1 regression: name 含路径分量 (e.g. "curved-flat/measurements") 必须被
/// 顶层白名单拒绝,execute 和 dry-run 都走同一个 not_found 路径 → exit 3,
/// 且 dst 目录不写任何内容。
#[test]
fn seed_example_rejects_path_component_name() {
    // -- execute path (--yes) --
    let tmp = TempDir::new().unwrap();
    let dst = tmp.path();
    let assert_yes = lmt()
        .args(["--json", "--yes", "seed-example", "curved-flat/measurements"])
        .arg(dst)
        .assert()
        .failure();
    let out_yes = assert_yes.get_output();
    // not_found -> exit 3
    assert_eq!(out_yes.status.code(), Some(3), "--yes path: expected exit 3");
    let stderr_yes = std::str::from_utf8(&out_yes.stderr).unwrap().trim_end();
    let env_yes: Value = serde_json::from_str(stderr_yes).expect("--yes path: stderr must be JSON envelope");
    assert_eq!(env_yes["ok"], false);
    assert_eq!(env_yes["error"]["code"], "not_found");
    // nothing written
    assert!(
        std::fs::read_dir(dst).unwrap().next().is_none(),
        "--yes path: dst must be empty after rejection"
    );

    // -- dry-run path --
    let tmp2 = TempDir::new().unwrap();
    let dst2 = tmp2.path();
    let assert_dry = lmt()
        .args(["--json", "--dry-run", "seed-example", "curved-flat/measurements"])
        .arg(dst2)
        .assert()
        .failure();
    let out_dry = assert_dry.get_output();
    // dry-run preflight also returns not_found -> exit 3
    assert_eq!(out_dry.status.code(), Some(3), "--dry-run path: expected exit 3");
    let stderr_dry = std::str::from_utf8(&out_dry.stderr).unwrap().trim_end();
    let env_dry: Value = serde_json::from_str(stderr_dry).expect("--dry-run path: stderr must be JSON envelope");
    assert_eq!(env_dry["ok"], false);
    assert_eq!(env_dry["error"]["code"], "not_found");
}

// ── visual compare-known E2E (Task 2.1) ───────────────────────────────────────

/// Shared cabinet_pose_report.json content for compare-known tests.
/// V001 is 702mm from V000 (known says 700 → 2mm distance error), both normals
/// +Z (angle error 0), both 600×340 (size error 0).
/// Unix-only: only consumed by the real-sidecar compare-known tests below.
#[cfg(unix)]
fn compare_known_report_json() -> &'static str {
    r#"{"schema_version":"visual_pose_report.v1","frame":{},"cabinet_poses":[{"cabinet_id":"V000_R000","position_mm":[0,0,0],"normal":[0,0,1],"rotation_matrix":[[1,0,0],[0,1,0],[0,0,1]],"corners_mm":[[-300,-170,0],[300,-170,0],[300,170,0],[-300,170,0]],"reprojection_rms_px":0.4,"observed_views":7,"observed_points":120,"quality":"ok"},{"cabinet_id":"V001_R000","position_mm":[702,0,0],"normal":[0.0,0.0,1.0],"rotation_matrix":[[1,0,0],[0,1,0],[0,0,1]],"corners_mm":[[-300,-170,0],[300,-170,0],[300,170,0],[-300,170,0]],"reprojection_rms_px":0.4,"observed_views":7,"observed_points":120,"quality":"ok"}]}"#
}

#[cfg(unix)]
fn compare_known_known_json() -> &'static str {
    r#"{"cabinets":{"V000_R000":{"size_mm":[600,340]},"V001_R000":{"size_mm":[600,340]}},"pairs":[{"a":"V000_R000","b":"V001_R000","distance_mm":700.0,"angle_deg":0.0}]}"#
}

/// visual compare-known — happy path (real sidecar). Writes report + known JSON,
/// runs `lmt --json visual compare-known <report> <known>`, asserts exit 0 +
/// envelope ok + data.passed present + a distance_error_mm of ~2.0.
#[cfg(unix)]
#[test]
fn visual_compare_known_happy() {
    let tmp = TempDir::new().unwrap();
    let wrapper = match make_sidecar_wrapper(tmp.path()) {
        Some(w) => w,
        None => {
            eprintln!("skipping visual_compare_known_happy: python-sidecar venv not found");
            return;
        }
    };

    let report_path = tmp.path().join("report.json");
    let known_path = tmp.path().join("known.json");
    std::fs::write(&report_path, compare_known_report_json()).unwrap();
    std::fs::write(&known_path, compare_known_known_json()).unwrap();

    let assert = lmt()
        .env("LMT_VBA_SIDECAR_PATH", &wrapper)
        .args([
            "--json",
            "visual",
            "compare-known",
            report_path.to_str().unwrap(),
            known_path.to_str().unwrap(),
        ])
        .assert()
        .success();

    let env: Value = serde_json::from_slice(&assert.get_output().stdout).unwrap();
    assert_eq!(env["ok"], true, "envelope ok: {env}");
    // data.passed present and true (2mm dist within default 3mm threshold).
    assert_eq!(env["data"]["passed"], true, "passed should be true: {env}");
    let dist_err = env["data"]["pairs"][0]["distance_error_mm"]
        .as_f64()
        .expect("distance_error_mm must be f64");
    assert!(
        (dist_err - 2.0).abs() < 1e-6,
        "distance_error_mm = {dist_err} should be 2.0"
    );
}

/// visual compare-known — missing report file → error envelope. The sidecar
/// emits invalid_input (exit 2) when a referenced file is absent.
#[cfg(unix)]
#[test]
fn visual_compare_known_missing_file_is_invalid_input() {
    let tmp = TempDir::new().unwrap();
    let wrapper = match make_sidecar_wrapper(tmp.path()) {
        Some(w) => w,
        None => {
            eprintln!("skipping visual_compare_known_missing_file_is_invalid_input: venv not found");
            return;
        }
    };
    // Only write the known file; report is missing.
    let known_path = tmp.path().join("known.json");
    std::fs::write(&known_path, compare_known_known_json()).unwrap();
    let missing_report = tmp.path().join("nope.json");

    let assert = lmt()
        .env("LMT_VBA_SIDECAR_PATH", &wrapper)
        .args([
            "--json",
            "visual",
            "compare-known",
            missing_report.to_str().unwrap(),
            known_path.to_str().unwrap(),
        ])
        .assert()
        .failure();
    let out = assert.get_output();
    // invalid_input → exit 2
    assert_eq!(out.status.code(), Some(2), "expected exit 2 (invalid_input)");
    let stderr = std::str::from_utf8(&out.stderr).unwrap().trim_end();
    let env: Value = serde_json::from_str(stderr).expect("stderr must be JSON envelope");
    assert_eq!(env["ok"], false);
    assert_eq!(env["error"]["code"], "invalid_input");
}

// ── visual error-code envelope coverage (Task 3.3) ────────────────────────────
//
// Deterministic E2E for the sidecar→adapter→lmt-app→CLI error chain:
//   sidecar emits {"event":"error","code":<X>,...} → adapter Protocol{code:X}
//   → map_vba_err → LmtError::<Variant> → ApiError{code:X}
//   → exit_codes::from_api_error_code → process exit N → ErrorEnvelope on stderr.
// A MOCK sidecar emits each code, so no fragile real-image construction is
// needed. The adapter returns the Protocol error as soon as it reads the error
// event (before checking exit status), so the mock just emits one line + exits.

/// Write an executable `lmt-vba-sidecar` mock at `<dir>` that drains stdin
/// (so the adapter's payload write doesn't SIGPIPE), emits a single fatal
/// error event with the given code, and exits 1. Returns the script path for
/// `LMT_VBA_SIDECAR_PATH`.
///
/// Unix-only: the mock is a POSIX `.sh` script (chmod 0o755). Windows has no
/// `.sh` runner, so this helper and the error-code tests below are excluded
/// from compilation there.
#[cfg(unix)]
fn write_error_mock(dir: &std::path::Path, code: &str) -> std::path::PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let wrapper = dir.join("lmt-vba-sidecar");
    // `cat > /dev/null` consumes the whole stdin payload before we emit + exit.
    let script = format!(
        "#!/bin/sh\ncat > /dev/null\nprintf '%s\\n' '{{\"event\":\"error\",\"code\":\"{code}\",\"message\":\"mock {code}\",\"fatal\":true}}'\nexit 1\n"
    );
    std::fs::write(&wrapper, &script).expect("write error mock");
    let mut perms = std::fs::metadata(&wrapper).unwrap().permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(&wrapper, perms).expect("chmod error mock");
    wrapper
}

/// Minimal valid project.yaml with a single `MAIN` screen — enough for
/// `run_reconstruct` / `run_calibrate` to pass `load_screen` before reaching
/// the sidecar. (calibrate doesn't read the screen, but reconstruct does.)
/// Unix-only: only consumed by the error-code tests that spawn a `.sh` mock.
#[cfg(unix)]
fn write_visual_project(dir: &std::path::Path) {
    let yaml = r#"project: { name: VisualErr, unit: mm }
screens:
  MAIN:
    cabinet_count: [2, 1]
    cabinet_size_mm: [600, 340]
    pixels_per_cabinet: [256, 256]
    shape_prior: { type: flat }
    shape_mode: rectangle
    irregular_mask: []
coordinate_system:
  origin_point: MAIN_V001_R001
  x_axis_point: MAIN_V002_R001
  xy_plane_point: MAIN_V001_R001
output:
  target: neutral
  obj_filename: "{screen_id}.obj"
  weld_vertices_tolerance_mm: 1.0
  triangulate: true
"#;
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(dir.join("project.yaml"), yaml).unwrap();
}

/// Drive `visual reconstruct` against an error-emitting mock and assert the
/// CLI exit code + ErrorEnvelope code. Used for detection_failed / ba_diverged
/// / observability_failed (reconstruct is a natural source; map_vba_err maps
/// the code regardless of op).
#[cfg(unix)]
fn assert_reconstruct_error_code(code: &str, expected_exit: i32) {
    let tmp = TempDir::new().unwrap();
    let proj = tmp.path().join("proj");
    write_visual_project(&proj);
    let manifest = tmp.path().join("manifest.json");
    std::fs::write(&manifest, "{}").unwrap();
    let mock = write_error_mock(tmp.path(), code);

    let assert = lmt()
        .env("LMT_VBA_SIDECAR_PATH", &mock)
        .args([
            "--json",
            "visual",
            "reconstruct",
            proj.to_str().unwrap(),
            "MAIN",
            "--capture-manifest",
            manifest.to_str().unwrap(),
            "--yes",
        ])
        .assert()
        .failure();
    let out = assert.get_output();
    assert_eq!(
        out.status.code(),
        Some(expected_exit),
        "code '{code}' should map to exit {expected_exit}"
    );
    let stderr = std::str::from_utf8(&out.stderr).unwrap().trim_end();
    let env: Value = serde_json::from_str(stderr).expect("stderr must be JSON envelope");
    assert_eq!(env["ok"], false);
    assert_eq!(env["error"]["code"], code, "envelope code mismatch");
}

/// detection_failed → exit 13.
#[cfg(unix)]
#[test]
fn visual_reconstruct_detection_failed_exit_13() {
    assert_reconstruct_error_code("detection_failed", 13);
}

/// ba_diverged → exit 14.
#[cfg(unix)]
#[test]
fn visual_reconstruct_ba_diverged_exit_14() {
    assert_reconstruct_error_code("ba_diverged", 14);
}

/// observability_failed → exit 17.
#[cfg(unix)]
#[test]
fn visual_reconstruct_observability_failed_exit_17() {
    assert_reconstruct_error_code("observability_failed", 17);
}

/// procrustes_failed → exit 15.
#[cfg(unix)]
#[test]
fn visual_reconstruct_procrustes_failed_exit_15() {
    assert_reconstruct_error_code("procrustes_failed", 15);
}

/// decode_failed → exit 18.
#[cfg(unix)]
#[test]
fn visual_reconstruct_decode_failed_exit_18() {
    assert_reconstruct_error_code("decode_failed", 18);
}

/// intrinsics_invalid → exit 16, driven via `visual calibrate` (its natural
/// source). calibrate requires a real checkerboard dir with >=1 image before
/// reaching the sidecar, so we seed one png (content irrelevant — the mock
/// ignores stdin and emits the error immediately).
#[cfg(unix)]
#[test]
fn visual_calibrate_intrinsics_invalid_exit_16() {
    let tmp = TempDir::new().unwrap();
    let proj = tmp.path().join("proj");
    write_visual_project(&proj);
    let cb_dir = tmp.path().join("checkerboard");
    std::fs::create_dir_all(&cb_dir).unwrap();
    std::fs::write(cb_dir.join("img0.png"), b"not-a-real-png").unwrap();
    let mock = write_error_mock(tmp.path(), "intrinsics_invalid");

    let assert = lmt()
        .env("LMT_VBA_SIDECAR_PATH", &mock)
        .args([
            "--json",
            "visual",
            "calibrate",
            proj.to_str().unwrap(),
            "MAIN",
            cb_dir.to_str().unwrap(),
            "--yes",
        ])
        .assert()
        .failure();
    let out = assert.get_output();
    assert_eq!(out.status.code(), Some(16), "intrinsics_invalid → exit 16");
    let stderr = std::str::from_utf8(&out.stderr).unwrap().trim_end();
    let env: Value = serde_json::from_str(stderr).expect("stderr must be JSON envelope");
    assert_eq!(env["ok"], false);
    assert_eq!(env["error"]["code"], "intrinsics_invalid");
}

// ---------------------------------------------------------------------------
// generate-pattern E2E (real Python sidecar). Gated on LMT_VBA_SIDECAR_PATH
// (point it at the sidecar binary / venv console script `lmt-vba-sidecar`);
// `#[ignore]` like the adapter real-binary tests so CI without a Python env
// stays green. Run with: cargo test -p lmt-cli --test cli_e2e -- --ignored
// These validate the Rust plumbing for PatternMeta v2 + --screen-mapping; the
// per-cabinet generation/placement/coverage logic is unit-tested in the sidecar.
// ---------------------------------------------------------------------------

fn gp_sidecar() -> Option<String> {
    std::env::var("LMT_VBA_SIDECAR_PATH").ok()
}

fn write_gp_project(dir: &Path, cols: u32, rows: u32) {
    let yaml = format!(
        "project: {{ name: GP, unit: mm }}
screens:
  MAIN:
    cabinet_count: [{cols}, {rows}]
    cabinet_size_mm: [500, 500]
    pixels_per_cabinet: [540, 540]
    shape_prior: {{ type: flat }}
    shape_mode: rectangle
    irregular_mask: []
coordinate_system:
  origin_point: MAIN_V000_R000
  x_axis_point: MAIN_V000_R000
  xy_plane_point: MAIN_V000_R000
output:
  target: neutral
  obj_filename: \"{{screen_id}}.obj\"
  weld_vertices_tolerance_mm: 1.0
  triangulate: true
"
    );
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(dir.join("project.yaml"), yaml).unwrap();
}

fn gp_stdout_env(out: &std::process::Output) -> Value {
    serde_json::from_str(std::str::from_utf8(&out.stdout).unwrap().trim_end())
        .expect("stdout must be a JSON envelope")
}

fn gp_stderr_env(out: &std::process::Output) -> Value {
    serde_json::from_str(std::str::from_utf8(&out.stderr).unwrap().trim_end())
        .expect("stderr must be a JSON envelope")
}

/// L4: the compare-known tolerance flags are registered + documented (no sidecar needed).
#[test]
fn compare_known_help_lists_tolerance_flags() {
    let assert = lmt().args(["visual", "compare-known", "--help"]).assert().success();
    let stdout = String::from_utf8_lossy(&assert.get_output().stdout);
    for flag in ["--max-size-mm", "--max-dist-mm", "--max-angle-deg"] {
        assert!(stdout.contains(flag), "compare-known --help must list {flag}:\n{stdout}");
    }
}

/// L3: the --min-views flag is registered + documented on plan-capture (no sidecar needed).
#[test]
fn plan_capture_help_lists_min_views() {
    let assert = lmt().args(["visual", "plan-capture", "--help"]).assert().success();
    let stdout = String::from_utf8_lossy(&assert.get_output().stdout);
    assert!(
        stdout.contains("--min-views"),
        "plan-capture --help must list --min-views:\n{stdout}"
    );
}

/// L3 end-to-end (real sidecar): `--min-views 3` is accepted and threads to the planner;
/// every reconstructable cabinet in the returned plan honors the raised view requirement.
#[test]
#[ignore = "requires LMT_VBA_SIDECAR_PATH set to a real sidecar binary/wrapper"]
fn plan_capture_min_views_threads_end_to_end() {
    let sidecar = match gp_sidecar() {
        Some(s) => s,
        None => { eprintln!("skip: LMT_VBA_SIDECAR_PATH unset"); return; }
    };
    let tmp = TempDir::new().unwrap();
    let proj = tmp.path().join("proj");
    write_gp_project(&proj, 2, 2);
    let assert = lmt()
        .env("LMT_VBA_SIDECAR_PATH", &sidecar)
        .args([
            "--json", "visual", "plan-capture", proj.to_str().unwrap(), "MAIN",
            "--image-size", "1920x1080", "--hfov-deg", "60", "--standoff", "2000..4000",
            "--height", "400..2200", "--trials", "6", "--min-views", "3",
        ])
        .assert()
        .success();
    let env = gp_stdout_env(assert.get_output());
    assert_eq!(env["ok"], true);
    for c in env["data"]["coverage"].as_array().unwrap() {
        if c["reconstructable"] == true {
            assert!(
                c["n_views"].as_u64().unwrap() >= 3,
                "min_views=3 not honored for a reconstructable cabinet: {c}"
            );
        }
    }
}

/// Happy uniform path: pattern_meta.json is schema v2 with per-cabinet geometry;
/// a 540px square cabinet reproduces the legacy 9x9 board.
#[test]
#[ignore = "requires LMT_VBA_SIDECAR_PATH set to a real sidecar binary/wrapper"]
fn generate_pattern_uniform_writes_v2_meta() {
    let sidecar = match gp_sidecar() {
        Some(s) => s,
        None => { eprintln!("skip: LMT_VBA_SIDECAR_PATH unset"); return; }
    };
    let tmp = TempDir::new().unwrap();
    let proj = tmp.path().join("proj");
    write_gp_project(&proj, 1, 2);
    let assert = lmt()
        .env("LMT_VBA_SIDECAR_PATH", &sidecar)
        .args(["--json", "visual", "generate-pattern", proj.to_str().unwrap(), "MAIN", "--method", "charuco", "--yes"])
        .assert()
        .success();
    let env = gp_stdout_env(assert.get_output());
    assert_eq!(env["ok"], true);
    assert_eq!(env["data"]["cabinet_count"], 2);
    let meta: Value = serde_json::from_str(
        &std::fs::read_to_string(proj.join("patterns/MAIN/pattern_meta.json")).unwrap(),
    ).unwrap();
    assert_eq!(meta["schema_version"], 2);
    assert_eq!(meta["cabinets"][0]["squares_x"], 9);
    assert_eq!(meta["cabinets"][0]["squares_y"], 9);
}

/// Happy mapped path with UNEQUAL cabinets (Codex fix #1 regression guard at the
/// CLI level): the two cabinets get different square counts from their own sizes.
#[test]
#[ignore = "requires LMT_VBA_SIDECAR_PATH set to a real sidecar binary/wrapper"]
fn generate_pattern_screen_mapping_unequal_cabinets() {
    let sidecar = match gp_sidecar() {
        Some(s) => s,
        None => { eprintln!("skip: LMT_VBA_SIDECAR_PATH unset"); return; }
    };
    let tmp = TempDir::new().unwrap();
    let proj = tmp.path().join("proj");
    write_gp_project(&proj, 1, 2);
    let sm = proj.join("screen_mapping.json");
    let sm_json = serde_json::json!({
        "screen_id": "MAIN", "expected_pattern_hash": "x",
        "cabinets": [
            {"cabinet_id": "V000_R000", "resolution_px": [1280, 720],
             "active_size_mm": [400.0, 225.0], "pixel_pitch_mm": [0.3125, 0.3125],
             "active_origin": "center", "input_rect_px": [0, 0, 1280, 720],
             "rotation": 0, "mirror_x": false, "mirror_y": false},
            {"cabinet_id": "V000_R001", "resolution_px": [720, 720],
             "active_size_mm": [225.0, 225.0], "pixel_pitch_mm": [0.3125, 0.3125],
             "active_origin": "center", "input_rect_px": [0, 760, 720, 720],
             "rotation": 0, "mirror_x": false, "mirror_y": false}
        ]
    });
    std::fs::write(&sm, serde_json::to_string(&sm_json).unwrap()).unwrap();
    lmt()
        .env("LMT_VBA_SIDECAR_PATH", &sidecar)
        .args(["--json", "visual", "generate-pattern", proj.to_str().unwrap(), "MAIN",
               "--method", "charuco", "--screen-mapping", sm.to_str().unwrap(), "--yes"])
        .assert()
        .success();
    let meta: Value = serde_json::from_str(
        &std::fs::read_to_string(proj.join("patterns/MAIN/pattern_meta.json")).unwrap(),
    ).unwrap();
    let by = |cr: usize| meta["cabinets"][cr].clone();
    assert_eq!(by(0)["squares_x"], 16);  // 1280x720 wide
    assert_eq!(by(0)["squares_y"], 9);
    assert_eq!(by(1)["squares_x"], 9);   // 720x720 square
    assert_eq!(by(1)["squares_y"], 9);
}

/// Issue 1 regression: a RELATIVE `--screen-mapping` must resolve against the
/// CURRENT WORKING DIRECTORY (like every other path arg), NOT be re-joined onto
/// `project_path`. The old code did `project_path.join(screen_mapping)`, so
/// passing `proj/screen_mapping.json` while `project_path = proj` double-
/// concatenated to `proj/proj/screen_mapping.json` → "No such file". Here CWD =
/// tmp and BOTH paths are CWD-relative; success proves no double-join.
#[test]
#[ignore = "requires LMT_VBA_SIDECAR_PATH set to a real sidecar binary/wrapper"]
fn generate_pattern_relative_screen_mapping_resolves_against_cwd() {
    let sidecar = match gp_sidecar() {
        Some(s) => s,
        None => { eprintln!("skip: LMT_VBA_SIDECAR_PATH unset"); return; }
    };
    let tmp = TempDir::new().unwrap();
    let proj = tmp.path().join("proj");
    write_gp_project(&proj, 1, 1);
    let sm = proj.join("screen_mapping.json");
    let sm_json = serde_json::json!({
        "screen_id": "MAIN", "expected_pattern_hash": "x",  // hash present: isolates the PATH concern
        "cabinets": [
            {"cabinet_id": "V000_R000", "resolution_px": [540, 540],
             "active_size_mm": [168.75, 168.75], "pixel_pitch_mm": [0.3125, 0.3125],
             "active_origin": "center", "input_rect_px": [0, 0, 540, 540],
             "rotation": 0, "mirror_x": false, "mirror_y": false}
        ]
    });
    std::fs::write(&sm, serde_json::to_string(&sm_json).unwrap()).unwrap();
    lmt()
        .current_dir(tmp.path())  // CWD-relative resolution is the whole point
        .env("LMT_VBA_SIDECAR_PATH", &sidecar)
        .args(["--json", "visual", "generate-pattern", "proj", "MAIN",
               "--screen-mapping", "proj/screen_mapping.json", "--yes"])
        .assert()
        .success();
}

/// Issue 2 regression: a screen_mapping may OMIT `expected_pattern_hash` at
/// generate-pattern time (the hash does not exist until the pattern is written).
/// Generate must NOT reject it as a required field.
#[test]
#[ignore = "requires LMT_VBA_SIDECAR_PATH set to a real sidecar binary/wrapper"]
fn generate_pattern_screen_mapping_without_hash_succeeds() {
    let sidecar = match gp_sidecar() {
        Some(s) => s,
        None => { eprintln!("skip: LMT_VBA_SIDECAR_PATH unset"); return; }
    };
    let tmp = TempDir::new().unwrap();
    let proj = tmp.path().join("proj");
    write_gp_project(&proj, 1, 1);
    let sm = proj.join("screen_mapping.json");
    let sm_json = serde_json::json!({
        "screen_id": "MAIN",  // NO expected_pattern_hash field
        "cabinets": [
            {"cabinet_id": "V000_R000", "resolution_px": [540, 540],
             "active_size_mm": [168.75, 168.75], "pixel_pitch_mm": [0.3125, 0.3125],
             "active_origin": "center", "input_rect_px": [0, 0, 540, 540],
             "rotation": 0, "mirror_x": false, "mirror_y": false}
        ]
    });
    std::fs::write(&sm, serde_json::to_string(&sm_json).unwrap()).unwrap();
    let assert = lmt()
        .env("LMT_VBA_SIDECAR_PATH", &sidecar)
        .args(["--json", "visual", "generate-pattern", proj.to_str().unwrap(), "MAIN",
               "--screen-mapping", sm.to_str().unwrap(), "--yes"])
        .assert()
        .success();
    assert_eq!(gp_stdout_env(assert.get_output())["ok"], true);
}

/// Over-capacity: 26 cabinets × 40 markers > 1000 → invalid_input envelope.
#[test]
#[ignore = "requires LMT_VBA_SIDECAR_PATH set to a real sidecar binary/wrapper"]
fn generate_pattern_over_capacity_invalid_input() {
    let sidecar = match gp_sidecar() {
        Some(s) => s,
        None => { eprintln!("skip: LMT_VBA_SIDECAR_PATH unset"); return; }
    };
    let tmp = TempDir::new().unwrap();
    let proj = tmp.path().join("proj");
    write_gp_project(&proj, 26, 1);
    let assert = lmt()
        .env("LMT_VBA_SIDECAR_PATH", &sidecar)
        .args(["--json", "visual", "generate-pattern", proj.to_str().unwrap(), "MAIN", "--method", "charuco", "--yes"])
        .assert()
        .failure();
    let env = gp_stderr_env(assert.get_output());
    assert_eq!(env["ok"], false);
    assert_eq!(env["error"]["code"], "invalid_input");
}

/// Missing cabinet in screen_mapping (Codex fix #2 regression guard at the CLI
/// level): single-source-of-truth requires exact coverage → invalid_input that
/// names the missing cabinet.
#[test]
#[ignore = "requires LMT_VBA_SIDECAR_PATH set to a real sidecar binary/wrapper"]
fn generate_pattern_missing_cabinet_invalid_input() {
    let sidecar = match gp_sidecar() {
        Some(s) => s,
        None => { eprintln!("skip: LMT_VBA_SIDECAR_PATH unset"); return; }
    };
    let tmp = TempDir::new().unwrap();
    let proj = tmp.path().join("proj");
    write_gp_project(&proj, 1, 2);  // grid needs V000_R000 AND V000_R001
    let sm = proj.join("screen_mapping.json");
    let sm_json = serde_json::json!({
        "screen_id": "MAIN", "expected_pattern_hash": "x",
        "cabinets": [
            {"cabinet_id": "V000_R000", "resolution_px": [720, 720],
             "active_size_mm": [225.0, 225.0], "pixel_pitch_mm": [0.3125, 0.3125],
             "active_origin": "center", "input_rect_px": [0, 0, 720, 720],
             "rotation": 0, "mirror_x": false, "mirror_y": false}
        ]
    });
    std::fs::write(&sm, serde_json::to_string(&sm_json).unwrap()).unwrap();
    let assert = lmt()
        .env("LMT_VBA_SIDECAR_PATH", &sidecar)
        .args(["--json", "visual", "generate-pattern", proj.to_str().unwrap(), "MAIN",
               "--method", "charuco", "--screen-mapping", sm.to_str().unwrap(), "--yes"])
        .assert()
        .failure();
    let env = gp_stderr_env(assert.get_output());
    assert_eq!(env["ok"], false);
    assert_eq!(env["error"]["code"], "invalid_input");
    assert!(env["error"]["message"].as_str().unwrap().contains("V000_R001"),
            "message should name the missing cabinet: {}", env["error"]["message"]);
}

// ── VP-QSP E2E (default method) ───────────────────────────────────────────────

/// generate-pattern HAPPY with VP-QSP (the default method): pattern_meta.json is
/// the vpqsp.v1 schema and carries the numeric screen_id_code (real sidecar).
#[test]
#[ignore = "requires LMT_VBA_SIDECAR_PATH set to a real sidecar binary/wrapper"]
fn generate_pattern_vpqsp_happy() {
    let sidecar = match gp_sidecar() {
        Some(s) => s,
        None => { eprintln!("skip: LMT_VBA_SIDECAR_PATH unset"); return; }
    };
    let tmp = TempDir::new().unwrap();
    let proj = tmp.path().join("proj");
    write_gp_project(&proj, 1, 2);
    let assert = lmt()
        .env("LMT_VBA_SIDECAR_PATH", &sidecar)
        // no --method => default vpqsp
        .args(["--json", "visual", "generate-pattern", proj.to_str().unwrap(), "MAIN",
               "--screen-id-code", "4", "--yes"])
        .assert()
        .success();
    let env = gp_stdout_env(assert.get_output());
    assert_eq!(env["ok"], true);
    assert_eq!(env["data"]["cabinet_count"], 2);
    let meta: Value = serde_json::from_str(
        &std::fs::read_to_string(proj.join("patterns/MAIN/pattern_meta.json")).unwrap(),
    ).unwrap();
    assert_eq!(meta["schema_version"], "vpqsp.v1");
    assert_eq!(meta["screen_id_code"], 4);
    assert!(meta["cabinets"][0]["markers_x"].as_u64().unwrap() >= 1);
}

/// VP-QSP has NO ArUco dictionary capacity ceiling: 26 cabinets (which overflow
/// ChArUco's ~13-cabinet limit) generate successfully (real sidecar).
#[test]
#[ignore = "requires LMT_VBA_SIDECAR_PATH set to a real sidecar binary/wrapper"]
fn generate_pattern_vpqsp_no_capacity_limit() {
    let sidecar = match gp_sidecar() {
        Some(s) => s,
        None => { eprintln!("skip: LMT_VBA_SIDECAR_PATH unset"); return; }
    };
    let tmp = TempDir::new().unwrap();
    let proj = tmp.path().join("proj");
    write_gp_project(&proj, 26, 1);  // would be invalid_input under --method charuco
    let assert = lmt()
        .env("LMT_VBA_SIDECAR_PATH", &sidecar)
        .args(["--json", "visual", "generate-pattern", proj.to_str().unwrap(), "MAIN", "--yes"])
        .assert()
        .success();
    let env = gp_stdout_env(assert.get_output());
    assert_eq!(env["ok"], true);
    assert_eq!(env["data"]["cabinet_count"], 26);
}

/// generate-pattern DRY-RUN (vpqsp default): exit 0, dry_run echo, no files written.
#[test]
fn generate_pattern_vpqsp_dry_run_writes_nothing() {
    let tmp = TempDir::new().unwrap();
    let proj = tmp.path().join("proj");
    std::fs::create_dir_all(&proj).unwrap();
    let assert = lmt()
        .args(["--json", "--dry-run", "visual", "generate-pattern",
               proj.to_str().unwrap(), "MAIN"])
        .assert()
        .success();
    let env: Value = serde_json::from_slice(&assert.get_output().stdout).unwrap();
    assert_eq!(env["ok"], true, "envelope ok: {env}");
    assert_eq!(env["data"]["dry_run"], true);
    assert_eq!(env["data"]["method"], "vpqsp");
    assert!(!proj.join("patterns/MAIN/pattern_meta.json").exists(),
            "dry-run must not write artifacts");
}

/// REFUSE: an unknown pattern method is UNSUPPORTED (exit 7) before any side effect.
#[test]
fn generate_pattern_unknown_method_is_unsupported() {
    let tmp = TempDir::new().unwrap();
    let proj = tmp.path().join("proj");
    std::fs::create_dir_all(&proj).unwrap();
    let assert = lmt()
        .args(["--json", "visual", "generate-pattern", proj.to_str().unwrap(), "MAIN",
               "--method", "gray_code", "--yes"])
        .assert()
        .failure();
    let out = assert.get_output();
    assert_eq!(out.status.code(), Some(7), "expected exit 7 (unsupported)");
    let env: Value = serde_json::from_str(std::str::from_utf8(&out.stderr).unwrap().trim_end()).unwrap();
    assert_eq!(env["ok"], false);
    assert_eq!(env["error"]["code"], "unsupported");
}

/// ERROR ENVELOPE: a VP-QSP reconstruct whose sidecar emits `detection_failed`
/// maps to exit 13 (the marker-decode failure mode). Mirrors the charuco
/// error-envelope harness with an explicit --method vpqsp.
#[cfg(unix)]
#[test]
fn visual_reconstruct_vpqsp_detection_failed_exit_13() {
    let tmp = TempDir::new().unwrap();
    let proj = tmp.path().join("proj");
    write_visual_project(&proj);
    let manifest = tmp.path().join("manifest.json");
    std::fs::write(&manifest, "{}").unwrap();
    let mock = write_error_mock(tmp.path(), "detection_failed");

    let assert = lmt()
        .env("LMT_VBA_SIDECAR_PATH", &mock)
        .args([
            "--json", "visual", "reconstruct",
            proj.to_str().unwrap(), "MAIN",
            "--capture-manifest", manifest.to_str().unwrap(),
            "--method", "vpqsp", "--yes",
        ])
        .assert()
        .failure();
    let out = assert.get_output();
    assert_eq!(out.status.code(), Some(13), "detection_failed -> exit 13");
    let env: Value = serde_json::from_str(std::str::from_utf8(&out.stderr).unwrap().trim_end()).unwrap();
    assert_eq!(env["ok"], false);
    assert_eq!(env["error"]["code"], "detection_failed");
}

/// `visual reconstruct --intrinsics auto` error envelope: a sidecar refusal (e.g.
/// the self-cal observability gate) must surface as `observability_failed` -> exit
/// 17 through the auto path, same as the file path.
#[cfg(unix)]
#[test]
fn visual_reconstruct_auto_observability_failed_exit_17() {
    let tmp = TempDir::new().unwrap();
    let proj = tmp.path().join("proj");
    write_visual_project(&proj);
    let manifest = tmp.path().join("manifest.json");
    std::fs::write(&manifest, "{}").unwrap();
    let mock = write_error_mock(tmp.path(), "observability_failed");

    let assert = lmt()
        .env("LMT_VBA_SIDECAR_PATH", &mock)
        .args([
            "--json", "visual", "reconstruct",
            proj.to_str().unwrap(), "MAIN",
            "--capture-manifest", manifest.to_str().unwrap(),
            "--intrinsics", "auto", "--yes",
        ])
        .assert()
        .failure();
    let out = assert.get_output();
    assert_eq!(out.status.code(), Some(17), "observability_failed -> exit 17");
    let env: Value = serde_json::from_str(std::str::from_utf8(&out.stderr).unwrap().trim_end()).unwrap();
    assert_eq!(env["ok"], false);
    assert_eq!(env["error"]["code"], "observability_failed");
}

// ── export pose-obj E2E (Task 2.3) ────────────────────────────────────────────

/// Pose report JSON for 2 cabinets used by export pose-obj tests.
fn pose_report_json() -> &'static str {
    r#"{"schema_version":"visual_pose_report.v1","frame":{},"cabinet_poses":[
 {"cabinet_id":"V000_R000","corners_mm":[[-300,-170,0],[300,-170,0],[300,170,0],[-300,170,0]]},
 {"cabinet_id":"V000_R001","corners_mm":[[321,-391,-4],[793,-376,-1117],[803,303,-1104],[331,289,8]]}]}"#
}

/// happy: 2-cabinet report → exit 0, envelope ok, cabinet_count==2, single OBJ exists.
#[test]
fn export_pose_obj_happy() {
    let tmp = TempDir::new().unwrap();
    let report = tmp.path().join("cabinet_pose_report.json");
    std::fs::write(&report, pose_report_json()).unwrap();
    let out = tmp.path().join("wall.obj");

    let assert = lmt()
        .args([
            "--json", "--yes", "export", "pose-obj",
            report.to_str().unwrap(), "neutral",
            "--out", out.to_str().unwrap(),
        ])
        .assert()
        .success();

    let env: Value = serde_json::from_slice(&assert.get_output().stdout).unwrap();
    assert_eq!(env["ok"], true, "envelope ok: {env}");
    assert_eq!(env["data"]["cabinet_count"], 2, "cabinet_count: {env}");
    assert!(out.is_file(), "merged OBJ must exist");
    let text = std::fs::read_to_string(&out).unwrap();
    assert_eq!(text.lines().filter(|l| l.starts_with("v ")).count(), 8);
}

/// dry-run: output file must NOT be created, exit 0, dry_run==true in envelope.
#[test]
fn export_pose_obj_dry_run_writes_nothing() {
    let tmp = TempDir::new().unwrap();
    let report = tmp.path().join("cabinet_pose_report.json");
    std::fs::write(&report, pose_report_json()).unwrap();
    let out = tmp.path().join("wall.obj");

    let assert = lmt()
        .args([
            "--json", "--dry-run", "export", "pose-obj",
            report.to_str().unwrap(), "neutral",
            "--out", out.to_str().unwrap(),
        ])
        .assert()
        .success();

    let env: Value = serde_json::from_slice(&assert.get_output().stdout).unwrap();
    assert_eq!(env["ok"], true, "envelope ok: {env}");
    assert_eq!(env["data"]["dry_run"], true, "dry_run flag: {env}");
    assert!(!out.exists(), "dry-run must not create the output file");
}

/// missing report → non-zero exit, envelope ok==false.
#[test]
fn export_pose_obj_missing_report_is_error() {
    let tmp = TempDir::new().unwrap();
    let missing = tmp.path().join("nope.json");
    let out = tmp.path().join("wall.obj");

    let assert = lmt()
        .args([
            "--json", "--yes", "export", "pose-obj",
            missing.to_str().unwrap(), "neutral",
            "--out", out.to_str().unwrap(),
        ])
        .assert()
        .failure();

    let out_assert = assert.get_output();
    assert_ne!(out_assert.status.code(), Some(0), "must be non-zero exit");
    let stderr = std::str::from_utf8(&out_assert.stderr).unwrap().trim_end();
    let env: Value = serde_json::from_str(stderr).expect("stderr must be JSON envelope");
    assert_eq!(env["ok"], false, "envelope ok must be false: {env}");
}

/// --root + --ground: reference panel axis-aligned (z≈0) with bottom edge at y=0.
#[test]
fn export_pose_obj_root_and_ground() {
    let tmp = TempDir::new().unwrap();
    let report = tmp.path().join("cabinet_pose_report.json");
    std::fs::write(&report, pose_report_json()).unwrap();
    let out = tmp.path().join("wall.obj");

    let assert = lmt()
        .args([
            "--json", "--yes", "export", "pose-obj",
            report.to_str().unwrap(), "neutral",
            "--out", out.to_str().unwrap(),
            "--root", "V000_R001", "--ground",
        ])
        .assert()
        .success();

    let env: Value = serde_json::from_slice(&assert.get_output().stdout).unwrap();
    assert_eq!(env["ok"], true, "envelope ok: {env}");

    let text = std::fs::read_to_string(&out).unwrap();
    let verts: Vec<[f64; 3]> = text
        .lines()
        .filter_map(|l| l.strip_prefix("v "))
        .map(|l| {
            let n: Vec<f64> = l.split_whitespace().map(|t| t.parse().unwrap()).collect();
            [n[0], n[1], n[2]]
        })
        .collect();
    assert_eq!(verts.len(), 8);
    let refp: Vec<[f64; 3]> = verts.into_iter().filter(|v| v[2].abs() < 1e-3).collect();
    assert_eq!(refp.len(), 4, "reference panel = 4 z≈0 verts: {refp:?}");
    let min_y = refp.iter().map(|v| v[1]).fold(f64::INFINITY, f64::min);
    assert!(min_y.abs() < 1e-3, "ground: ref min y should be 0, got {min_y}");
}

/// dry-run must reject an unknown --root (parity with execute), not green-light it.
#[test]
fn export_pose_obj_dry_run_validates_root() {
    let tmp = TempDir::new().unwrap();
    let report = tmp.path().join("cabinet_pose_report.json");
    std::fs::write(&report, pose_report_json()).unwrap();
    let out = tmp.path().join("wall.obj");

    let assert = lmt()
        .args([
            "--json", "--dry-run", "export", "pose-obj",
            report.to_str().unwrap(), "neutral",
            "--out", out.to_str().unwrap(),
            "--root", "NONEXISTENT_CAB",
        ])
        .assert()
        .failure();

    let out_assert = assert.get_output();
    assert_ne!(out_assert.status.code(), Some(0), "unknown --root must fail dry-run");
    let stderr = std::str::from_utf8(&out_assert.stderr).unwrap().trim_end();
    let env: Value = serde_json::from_str(stderr).expect("stderr must be JSON envelope");
    assert_eq!(env["ok"], false, "envelope ok must be false: {env}");
    assert!(!out.exists(), "dry-run must not create the output file");
}

/// disguise 不带摆放参数 → 标准摆法:贴地 + 水平居中。
#[test]
fn export_pose_obj_disguise_canonical_no_flags() {
    let tmp = TempDir::new().unwrap();
    let report = tmp.path().join("cabinet_pose_report.json");
    std::fs::write(&report, pose_report_json()).unwrap();
    let out = tmp.path().join("wall.obj");

    lmt()
        .args(["--json", "--yes", "export", "pose-obj",
               report.to_str().unwrap(), "disguise", "--out", out.to_str().unwrap()])
        .assert()
        .success();

    let text = std::fs::read_to_string(&out).unwrap();
    let ys: Vec<f64> = text.lines().filter_map(|l| l.strip_prefix("v "))
        .map(|l| l.split_whitespace().nth(1).unwrap().parse::<f64>().unwrap()).collect();
    let min_y = ys.iter().cloned().fold(f64::INFINITY, f64::min);
    assert!(min_y.abs() < 1e-3, "disguise canonical must be grounded, got min_y={min_y}");
}

/// 退化墙(全部面朝上)→ disguise 无法定向 → 非零退出 + envelope ok=false + 不写文件。
#[test]
fn export_pose_obj_disguise_degenerate_errors() {
    let tmp = TempDir::new().unwrap();
    let report = tmp.path().join("cabinet_pose_report.json");
    // 两块都躺平(法向 ≈ +Y)→ 水平法向 0
    std::fs::write(&report, r#"{"schema_version":"visual_pose_report.v1","frame":{},"cabinet_poses":[
 {"cabinet_id":"V000_R000","corners_mm":[[-300,0,-170],[300,0,-170],[300,0,170],[-300,0,170]]},
 {"cabinet_id":"V001_R000","corners_mm":[[400,0,-170],[1000,0,-170],[1000,0,170],[400,0,170]]}]}"#).unwrap();
    let out = tmp.path().join("wall.obj");

    let assert = lmt()
        .args(["--json", "--yes", "export", "pose-obj",
               report.to_str().unwrap(), "disguise", "--out", out.to_str().unwrap()])
        .assert()
        .failure();
    let env: Value = serde_json::from_str(
        std::str::from_utf8(&assert.get_output().stderr).unwrap().trim_end()
    ).expect("stderr JSON envelope");
    assert_eq!(env["ok"], false, "degenerate must error: {env}");
    assert!(!out.exists(), "must not write file on degenerate");
}

/// dry-run 也要拒退化 disguise 墙(与 execute 一致,否则放行 execute 会失败的导出)。
#[test]
fn export_pose_obj_disguise_degenerate_dry_run_also_errors() {
    let tmp = TempDir::new().unwrap();
    let report = tmp.path().join("cabinet_pose_report.json");
    std::fs::write(&report, r#"{"schema_version":"visual_pose_report.v1","frame":{},"cabinet_poses":[
 {"cabinet_id":"V000_R000","corners_mm":[[-300,0,-170],[300,0,-170],[300,0,170],[-300,0,170]]},
 {"cabinet_id":"V001_R000","corners_mm":[[400,0,-170],[1000,0,-170],[1000,0,170],[400,0,170]]}]}"#).unwrap();
    let out = tmp.path().join("wall.obj");

    let assert = lmt()
        .args(["--json", "--dry-run", "export", "pose-obj",
               report.to_str().unwrap(), "disguise", "--out", out.to_str().unwrap()])
        .assert()
        .failure();
    let env: Value = serde_json::from_str(
        std::str::from_utf8(&assert.get_output().stderr).unwrap().trim_end()
    ).expect("stderr JSON envelope");
    assert_eq!(env["ok"], false, "dry-run degenerate disguise must error: {env}");
    assert!(!out.exists(), "dry-run must not create file");
}

/// FIX-13 ②: pose-obj 的 unreal 是假出口 → exit 2 invalid_input,
/// execute 与 dry-run 一致,不写任何文件。
#[test]
fn export_pose_obj_unreal_is_invalid_input() {
    let tmp = TempDir::new().unwrap();
    let report = tmp.path().join("cabinet_pose_report.json");
    std::fs::write(&report, pose_report_json()).unwrap();
    let out = tmp.path().join("wall.obj");

    for flags in [&["--yes"][..], &["--dry-run"][..]] {
        let mut args = vec!["--json"];
        args.extend_from_slice(flags);
        args.extend_from_slice(&[
            "export", "pose-obj",
            report.to_str().unwrap(), "unreal",
            "--out", out.to_str().unwrap(),
        ]);
        let assert = lmt().args(&args).assert().failure();
        let o = assert.get_output();
        assert_eq!(o.status.code(), Some(2), "exit 2 for unreal ({flags:?})");
        let env: Value =
            serde_json::from_str(std::str::from_utf8(&o.stderr).unwrap().trim_end()).unwrap();
        assert_eq!(env["error"]["code"], "invalid_input", "{env}");
        assert!(!out.exists(), "must not write file for unreal");
    }
}

/// FIX-13 ①: --split disguise 出的逐箱体 OBJ 与合并导出对应箱体逐顶点一致
/// (split 不再跳过 disguise 补偿)。
#[test]
fn export_pose_obj_split_matches_merged_geometry() {
    let tmp = TempDir::new().unwrap();
    let report = tmp.path().join("cabinet_pose_report.json");
    std::fs::write(&report, pose_report_json()).unwrap();
    let merged = tmp.path().join("merged.obj");
    let split_dir = tmp.path().join("split");

    lmt()
        .args(["--json", "--yes", "export", "pose-obj",
               report.to_str().unwrap(), "disguise", "--out", merged.to_str().unwrap()])
        .assert()
        .success();
    let assert = lmt()
        .args(["--json", "--yes", "export", "pose-obj",
               report.to_str().unwrap(), "disguise",
               "--out", split_dir.to_str().unwrap(), "--split"])
        .assert()
        .success();
    let env: Value = serde_json::from_slice(&assert.get_output().stdout).unwrap();
    assert_eq!(env["data"]["files"].as_array().unwrap().len(), 2, "{env}");

    let parse_v = |text: &str| -> Vec<[f64; 3]> {
        text.lines()
            .filter_map(|l| l.strip_prefix("v "))
            .map(|l| {
                let n: Vec<f64> = l.split_whitespace().map(|t| t.parse().unwrap()).collect();
                [n[0], n[1], n[2]]
            })
            .collect()
    };
    let merged_verts = parse_v(&std::fs::read_to_string(&merged).unwrap());
    // pose 顺序 = merged 顶点顺序:0=V000_R000,1=V000_R001。
    for (i, name) in ["V000_R000", "V000_R001"].iter().enumerate() {
        let verts = parse_v(
            &std::fs::read_to_string(split_dir.join(format!("{name}.obj"))).unwrap(),
        );
        assert_eq!(verts.len(), 4);
        for (j, v) in verts.iter().enumerate() {
            for k in 0..3 {
                assert!(
                    (v[k] - merged_verts[4 * i + j][k]).abs() < 1e-6,
                    "split {name} vert {j} axis {k} must match merged"
                );
            }
        }
    }
}

/// FIX-13 ③: --screen-mapping happy(非均匀 V cell 反映进 vt)+
/// refuse(--split 互斥 / 缺箱体)。
#[test]
fn export_pose_obj_screen_mapping_happy_and_refuse() {
    let tmp = TempDir::new().unwrap();
    let report = tmp.path().join("cabinet_pose_report.json");
    std::fs::write(&report, pose_report_json()).unwrap();
    let mapping = tmp.path().join("screen_mapping.json");
    // row1 带 120px y 间隙的非均匀布局(画布 1080×2280)。
    std::fs::write(&mapping, r#"{"screen_id":"BENCH","cabinets":[
 {"cabinet_id":"V000_R000","input_rect_px":[0,0,1080,1080]},
 {"cabinet_id":"V000_R001","input_rect_px":[0,1200,1080,1080]}]}"#).unwrap();
    let out = tmp.path().join("mapped.obj");

    lmt()
        .args(["--json", "--yes", "export", "pose-obj",
               report.to_str().unwrap(), "neutral",
               "--out", out.to_str().unwrap(),
               "--screen-mapping", mapping.to_str().unwrap()])
        .assert()
        .success();
    let text = std::fs::read_to_string(&out).unwrap();
    let vts: Vec<f64> = text.lines().filter_map(|l| l.strip_prefix("vt "))
        .map(|l| l.split_whitespace().nth(1).unwrap().parse::<f64>().unwrap()).collect();
    let expect = 1200.0 / 2280.0;
    assert!(
        vts.iter().any(|v| (v - expect).abs() < 1e-4),
        "non-uniform V cell {expect} must appear in vt list: {vts:?}"
    );

    // refuse: --split 与 --screen-mapping 互斥 → exit 2。
    let assert = lmt()
        .args(["--json", "--yes", "export", "pose-obj",
               report.to_str().unwrap(), "neutral",
               "--out", tmp.path().join("s").to_str().unwrap(),
               "--split", "--screen-mapping", mapping.to_str().unwrap()])
        .assert()
        .failure();
    let o = assert.get_output();
    assert_eq!(o.status.code(), Some(2));
    let env: Value =
        serde_json::from_str(std::str::from_utf8(&o.stderr).unwrap().trim_end()).unwrap();
    assert_eq!(env["error"]["code"], "invalid_input", "{env}");

    // refuse: mapping 缺 pose 箱体 → dry-run 也拒(parity)。
    let partial = tmp.path().join("partial_mapping.json");
    std::fs::write(&partial, r#"{"cabinets":[
 {"cabinet_id":"V000_R000","input_rect_px":[0,0,1080,1080]}]}"#).unwrap();
    let assert = lmt()
        .args(["--json", "--dry-run", "export", "pose-obj",
               report.to_str().unwrap(), "neutral",
               "--out", tmp.path().join("p.obj").to_str().unwrap(),
               "--screen-mapping", partial.to_str().unwrap()])
        .assert()
        .failure();
    let o = assert.get_output();
    assert_eq!(o.status.code(), Some(2));
}

// ---------------------------------------------------------------------------
// generate-structured-light / decode-structured-light: refuse + dry-run.
// These validate the gate_destructive + dry-run plumbing with no sidecar
// (refuse/dry-run never spawn the sidecar). Happy-path generation/decode logic
// is unit-tested in the Python sidecar.
// ---------------------------------------------------------------------------

#[test]
fn generate_structured_light_refuses_without_yes() {
    let tmp = TempDir::new().unwrap();
    let proj = tmp.path().join("proj");
    write_gp_project(&proj, 1, 1);
    let assert = lmt().args(["--json", "visual", "generate-structured-light",
        proj.to_str().unwrap(), "MAIN"]).assert().failure();
    let out = assert.get_output();
    assert_eq!(out.status.code(), Some(2));
    let env: Value = serde_json::from_str(std::str::from_utf8(&out.stderr).unwrap().trim_end()).unwrap();
    assert_eq!(env["error"]["code"], "invalid_input");
}

#[test]
fn generate_structured_light_dry_run_writes_nothing() {
    let tmp = TempDir::new().unwrap();
    let proj = tmp.path().join("proj");
    write_gp_project(&proj, 1, 1);
    let assert = lmt().args(["--json", "--dry-run", "visual", "generate-structured-light",
        proj.to_str().unwrap(), "MAIN"]).assert().success();
    let env: Value = serde_json::from_slice(&assert.get_output().stdout).unwrap();
    assert_eq!(env["ok"], true);
    assert_eq!(env["data"]["dry_run"], true);
    assert!(!proj.join("patterns/MAIN/sl").exists());
}

/// generate-structured-light --seq-format tiff — real sidecar additionally emits
/// a disguise `<screen_id>.seq/` folder of TIFFs named from 0 (disguise ingest
/// convention). Validates the --seq-format plumbing end to end.
#[cfg(unix)]
#[test]
fn generate_structured_light_emits_tiff_seq() {
    let tmp = TempDir::new().unwrap();
    let wrapper = match make_sidecar_wrapper(tmp.path()) {
        Some(w) => w,
        None => {
            eprintln!("skipping generate_structured_light_emits_tiff_seq: venv not found");
            return;
        }
    };
    let proj = tmp.path().join("proj");
    write_gp_project(&proj, 1, 1);
    let assert = lmt()
        .env("LMT_VBA_SIDECAR_PATH", &wrapper)
        .args([
            "--json", "--yes", "visual", "generate-structured-light",
            proj.to_str().unwrap(), "MAIN", "--seq-format", "tiff",
        ])
        .assert()
        .success();
    let env: Value = serde_json::from_slice(&assert.get_output().stdout).unwrap();
    assert_eq!(env["ok"], true, "envelope ok: {env}");
    let n_frames = env["data"]["n_frames"]
        .as_u64()
        .expect("result must report n_frames") as usize;
    assert!(n_frames >= 4, "sentinel+anchor+code+sentinel >= 4 frames, got {n_frames}");
    let seq = proj.join("patterns/MAIN/sl/MAIN.seq");
    assert!(seq.is_dir(), "MAIN.seq dir must exist");
    // Disguise .seq ingest requires one TIFF per logical frame, numbered
    // contiguously from 0 with NO gaps — verify the whole set, not just frame 0.
    for i in 0..n_frames {
        let f = seq.join(format!("MAIN_{i:05}.tif"));
        assert!(f.is_file(), "missing contiguous TIFF frame {f:?}");
        assert!(
            std::fs::metadata(&f).unwrap().len() > 0,
            "TIFF frame must be non-empty: {f:?}"
        );
    }
    // No stray/duplicate numbering: exactly one TIFF per logical frame.
    let tif_count = std::fs::read_dir(&seq)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|x| x == "tif"))
        .count();
    assert_eq!(tif_count, n_frames, "exactly one TIFF per logical frame");
}

#[test]
fn decode_structured_light_refuses_without_yes() {
    let tmp = TempDir::new().unwrap();
    let meta = tmp.path().join("sl_meta.json");
    std::fs::write(&meta, "{}").unwrap();
    let assert = lmt().args(["--json", "visual", "decode-structured-light",
        tmp.path().to_str().unwrap(), meta.to_str().unwrap(),
        "--out", tmp.path().join("c.json").to_str().unwrap()]).assert().failure();
    let out = assert.get_output();
    assert_eq!(out.status.code(), Some(2));
    let env: Value = serde_json::from_str(std::str::from_utf8(&out.stderr).unwrap().trim_end()).unwrap();
    assert_eq!(env["error"]["code"], "invalid_input");
}

#[test]
fn decode_structured_light_dry_run_writes_nothing() {
    let tmp = TempDir::new().unwrap();
    let meta = tmp.path().join("sl_meta.json");
    std::fs::write(&meta, "{}").unwrap();
    let out_path = tmp.path().join("c.json");
    let assert = lmt().args(["--json", "--dry-run", "visual", "decode-structured-light",
        tmp.path().to_str().unwrap(), meta.to_str().unwrap(),
        "--out", out_path.to_str().unwrap()]).assert().success();
    let env: Value = serde_json::from_slice(&assert.get_output().stdout).unwrap();
    assert_eq!(env["ok"], true);
    assert_eq!(env["data"]["dry_run"], true);
    assert!(!out_path.exists());
}

#[test]
fn decode_structured_light_help_lists_new_flags() {
    let assert = lmt()
        .args(["visual", "decode-structured-light", "--help"])
        .assert()
        .success();
    let out = String::from_utf8_lossy(&assert.get_output().stdout);
    assert!(out.contains("--screen-roi"), "help must document --screen-roi: {out}");
    assert!(out.contains("--emit-debug-image"), "help must document --emit-debug-image: {out}");
}

/// Bad --screen-roi format is rejected as invalid_input (exit 2) BEFORE the
/// destructive gate — mirrors reconstruct-structured-light's >=2-corr pre-check.
#[test]
fn decode_structured_light_invalid_roi_format() {
    let tmp = TempDir::new().unwrap();
    let meta = tmp.path().join("sl_meta.json");
    std::fs::write(&meta, "{}").unwrap();
    let assert = lmt().args(["--json", "visual", "decode-structured-light",
        tmp.path().to_str().unwrap(), meta.to_str().unwrap(),
        "--out", tmp.path().join("c.json").to_str().unwrap(),
        "--screen-roi", "10,20,oops"]).assert().failure();
    let out = assert.get_output();
    assert_eq!(out.status.code(), Some(2), "bad ROI must be exit 2");
    let env: Value = serde_json::from_str(std::str::from_utf8(&out.stderr).unwrap().trim_end()).unwrap();
    assert_eq!(env["error"]["code"], "invalid_input");
}

/// dry-run with --emit-debug-image lists BOTH the corr file and <out>.debug.png
/// under would_write, and writes nothing.
#[test]
fn decode_structured_light_with_roi_and_debug_dry_run() {
    let tmp = TempDir::new().unwrap();
    let meta = tmp.path().join("sl_meta.json");
    std::fs::write(&meta, "{}").unwrap();
    let out_path = tmp.path().join("c.json");
    let assert = lmt().args(["--json", "--dry-run", "visual", "decode-structured-light",
        tmp.path().to_str().unwrap(), meta.to_str().unwrap(),
        "--out", out_path.to_str().unwrap(),
        "--screen-roi", "10,20,300,200", "--emit-debug-image"]).assert().success();
    let env: Value = serde_json::from_slice(&assert.get_output().stdout).unwrap();
    assert_eq!(env["ok"], true);
    assert_eq!(env["data"]["dry_run"], true);
    let ww = env["data"]["would_write"].as_array().expect("would_write is a list");
    let joined: Vec<String> = ww.iter().map(|v| v.as_str().unwrap().to_string()).collect();
    assert!(joined.iter().any(|s| s.ends_with("c.json")), "lists corr: {joined:?}");
    assert!(joined.iter().any(|s| s.ends_with("c.json.debug.png")), "lists debug png: {joined:?}");
    assert!(!out_path.exists());
    assert!(!tmp.path().join("c.json.debug.png").exists());
}

/// decode-structured-light happy path through the REAL sidecar: generate a
/// gray-background sequence, decode it, assert the envelope + corr.json carries
/// screen_roi provenance and the debug png lands at <out>.debug.png. This is the
/// CLI-seam check that the three-pass frontend still decodes the gray-bg material
/// (S1) end to end (per-pixel decode coverage is unit-tested in the sidecar).
#[cfg(unix)]
#[test]
fn decode_structured_light_happy_with_roi_provenance_and_debug() {
    let tmp = TempDir::new().unwrap();
    let wrapper = match make_sidecar_wrapper(tmp.path()) {
        Some(w) => w,
        None => {
            eprintln!("skipping decode_structured_light_happy: python-sidecar venv not found");
            return;
        }
    };
    let proj = tmp.path().join("proj");
    write_gp_project(&proj, 1, 1);
    // Generate the SL sequence (frames + sl_meta.json) via the real sidecar.
    lmt()
        .env("LMT_VBA_SIDECAR_PATH", &wrapper)
        .args(["--json", "--yes", "visual", "generate-structured-light",
            proj.to_str().unwrap(), "MAIN"])
        .assert()
        .success();
    let sl_dir = proj.join("patterns/MAIN/sl");
    let frames = sl_dir.join("frames");
    let meta = sl_dir.join("sl_meta.json");
    let out = tmp.path().join("corr.json");

    let assert = lmt()
        .env("LMT_VBA_SIDECAR_PATH", &wrapper)
        .args(["--json", "--yes", "visual", "decode-structured-light",
            frames.to_str().unwrap(), meta.to_str().unwrap(),
            "--out", out.to_str().unwrap(), "--emit-debug-image"])
        .assert()
        .success();
    let env: Value = serde_json::from_slice(&assert.get_output().stdout).unwrap();
    assert_eq!(env["ok"], true, "envelope ok: {env}");
    assert!(env["data"]["n_dots_decoded"].as_u64().unwrap() > 0);

    let corr: Value = serde_json::from_str(&std::fs::read_to_string(&out).unwrap()).unwrap();
    assert!(corr["screen_roi"].is_array(), "corr.json must stamp screen_roi: {corr}");
    assert!(out.with_extension("json.debug.png").is_file()
        || std::path::Path::new(&format!("{}.debug.png", out.display())).is_file(),
        "<out>.debug.png must exist");
}

/// decode-structured-light accepts a disguise-style .dpx frame DIRECTORY through
/// the REAL sidecar: generate PNG frames, transcode them to 10-bit Method-A DPX
/// via the test fixture writer (single source of truth), then decode the .dpx
/// directory. Asserts the CLI seam loads .dpx end to end (n_dots_decoded > 0).
#[cfg(unix)]
#[test]
fn decode_structured_light_accepts_dpx_dir() {
    let tmp = TempDir::new().unwrap();
    let wrapper = match make_sidecar_wrapper(tmp.path()) {
        Some(w) => w,
        None => {
            eprintln!("skipping decode_structured_light_accepts_dpx_dir: python-sidecar venv not found");
            return;
        }
    };
    let proj = tmp.path().join("proj");
    write_gp_project(&proj, 1, 1);
    lmt()
        .env("LMT_VBA_SIDECAR_PATH", &wrapper)
        .args(["--json", "--yes", "visual", "generate-structured-light",
            proj.to_str().unwrap(), "MAIN"])
        .assert()
        .success();
    let sl_dir = proj.join("patterns/MAIN/sl");
    let frames = sl_dir.join("frames");
    let dpx_dir = sl_dir.join("frames_dpx");
    let meta = sl_dir.join("sl_meta.json");
    let out = tmp.path().join("corr.json");

    // Transcode PNG frames -> .dpx using the venv python + the fixture writer.
    let py = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../sidecars/mesh-vba/.venv/bin/python");
    let fixtures = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../sidecars/mesh-vba/tests/_dpx_fixtures.py");
    let status = std::process::Command::new(&py)
        .arg(&fixtures)
        .arg(&frames)
        .arg(&dpx_dir)
        .status()
        .expect("run _dpx_fixtures.py converter");
    assert!(status.success(), "DPX conversion failed");
    assert!(dpx_dir.join("frame0000.dpx").is_file(), "converter wrote .dpx frames");

    let assert = lmt()
        .env("LMT_VBA_SIDECAR_PATH", &wrapper)
        .args(["--json", "--yes", "visual", "decode-structured-light",
            dpx_dir.to_str().unwrap(), meta.to_str().unwrap(),
            "--out", out.to_str().unwrap()])
        .assert()
        .success();
    let env: Value = serde_json::from_slice(&assert.get_output().stdout).unwrap();
    assert_eq!(env["ok"], true, "envelope ok: {env}");
    assert!(env["data"]["n_dots_decoded"].as_u64().unwrap() > 0,
        "decoded > 0 dots from .dpx dir");
}

/// The manifest's decode-structured-light CLI string documents the new flags and
/// keeps the exit-code set unchanged (no new error codes per spec A.3).
/// (Operations live under the `manifest` envelope, keyed by `operation_id`.)
#[test]
fn decode_structured_light_manifest_documents_new_flags() {
    let assert = lmt().args(["--json", "manifest"]).assert().success();
    let env: Value = serde_json::from_slice(&assert.get_output().stdout).unwrap();
    let ops = env["data"]["operations"].as_array()
        .expect("manifest envelope must list operations");
    let decode = ops.iter()
        .find(|o| o["operation_id"] == "visual.decode_structured_light")
        .expect("decode op present in manifest");
    let cli = decode["cli"].as_str().unwrap();
    assert!(cli.contains("--screen-roi"), "manifest CLI must mention --screen-roi: {cli}");
    assert!(cli.contains("--emit-debug-image"), "manifest CLI must mention --emit-debug-image: {cli}");
    let codes: Vec<i64> = decode["exit_codes"].as_array().unwrap()
        .iter().map(|c| c.as_i64().unwrap()).collect();
    assert_eq!(codes, vec![0, 2, 3, 4, 13, 18], "exit codes unchanged");
}

#[test]
fn reconstruct_structured_light_refuses_without_yes() {
    let tmp = TempDir::new().unwrap();
    let proj = tmp.path().join("proj");
    write_gp_project(&proj, 2, 1);
    let meta = tmp.path().join("sl_meta.json");
    std::fs::write(&meta, "{}").unwrap();
    let intr = tmp.path().join("intr.json");
    std::fs::write(&intr, "{}").unwrap();
    let c0 = tmp.path().join("c0.json");
    std::fs::write(&c0, "{}").unwrap();
    let c1 = tmp.path().join("c1.json");
    std::fs::write(&c1, "{}").unwrap();
    let assert = lmt().args(["--json", "visual", "reconstruct-structured-light",
        proj.to_str().unwrap(), "MAIN", "--sl-meta", meta.to_str().unwrap(),
        "--intrinsics", intr.to_str().unwrap(),
        "--corr", c0.to_str().unwrap(), "--corr", c1.to_str().unwrap()])
        .assert().failure();
    let out = assert.get_output();
    assert_eq!(out.status.code(), Some(2));
    let env: Value = serde_json::from_str(std::str::from_utf8(&out.stderr).unwrap().trim_end()).unwrap();
    assert_eq!(env["error"]["code"], "invalid_input");
}

#[test]
fn reconstruct_structured_light_dry_run_writes_nothing() {
    let tmp = TempDir::new().unwrap();
    let proj = tmp.path().join("proj");
    write_gp_project(&proj, 2, 1);
    let meta = tmp.path().join("sl_meta.json");
    std::fs::write(&meta, "{}").unwrap();
    let intr = tmp.path().join("intr.json");
    std::fs::write(&intr, "{}").unwrap();
    let c0 = tmp.path().join("c0.json");
    std::fs::write(&c0, "{}").unwrap();
    let c1 = tmp.path().join("c1.json");
    std::fs::write(&c1, "{}").unwrap();
    let assert = lmt().args(["--json", "--dry-run", "visual", "reconstruct-structured-light",
        proj.to_str().unwrap(), "MAIN", "--sl-meta", meta.to_str().unwrap(),
        "--intrinsics", intr.to_str().unwrap(),
        "--corr", c0.to_str().unwrap(), "--corr", c1.to_str().unwrap()])
        .assert().success();
    let env: Value = serde_json::from_slice(&assert.get_output().stdout).unwrap();
    assert_eq!(env["ok"], true);
    assert_eq!(env["data"]["dry_run"], true);
    assert!(!proj.join("measurements/measured.yaml").exists());
}

#[test]
fn reconstruct_structured_light_auto_dry_run_writes_nothing() {
    // `--intrinsics auto` must be accepted by clap (no file needed) and reach the
    // dry-run payload verbatim (the sidecar, not the CLI, branches on "auto").
    let tmp = TempDir::new().unwrap();
    let proj = tmp.path().join("proj");
    write_gp_project(&proj, 2, 1);
    let meta = tmp.path().join("sl_meta.json");
    std::fs::write(&meta, "{}").unwrap();
    let c0 = tmp.path().join("c0.json");
    std::fs::write(&c0, "{}").unwrap();
    let c1 = tmp.path().join("c1.json");
    std::fs::write(&c1, "{}").unwrap();
    let assert = lmt().args(["--json", "--dry-run", "visual", "reconstruct-structured-light",
        proj.to_str().unwrap(), "MAIN", "--sl-meta", meta.to_str().unwrap(),
        "--intrinsics", "auto",
        "--corr", c0.to_str().unwrap(), "--corr", c1.to_str().unwrap()])
        .assert().success();
    let env: Value = serde_json::from_slice(&assert.get_output().stdout).unwrap();
    assert_eq!(env["data"]["dry_run"], true);
    assert_eq!(env["data"]["intrinsics"], "auto");
    assert!(!proj.join("measurements/measured.yaml").exists());
}

#[test]
fn reconstruct_structured_light_single_corr_is_invalid_even_in_dry_run() {
    // >= 2 poses required; a single --corr must fail consistently in dry-run AND
    // execute (not falsely report a successful dry-run for a doomed command).
    let tmp = TempDir::new().unwrap();
    let proj = tmp.path().join("proj");
    write_gp_project(&proj, 2, 1);
    let meta = tmp.path().join("sl_meta.json");
    std::fs::write(&meta, "{}").unwrap();
    let intr = tmp.path().join("intr.json");
    std::fs::write(&intr, "{}").unwrap();
    let c0 = tmp.path().join("c0.json");
    std::fs::write(&c0, "{}").unwrap();
    let assert = lmt().args(["--json", "--dry-run", "visual", "reconstruct-structured-light",
        proj.to_str().unwrap(), "MAIN", "--sl-meta", meta.to_str().unwrap(),
        "--intrinsics", intr.to_str().unwrap(),
        "--corr", c0.to_str().unwrap()])
        .assert().failure();
    let out = assert.get_output();
    assert_eq!(out.status.code(), Some(2));
    let env: Value = serde_json::from_str(std::str::from_utf8(&out.stderr).unwrap().trim_end()).unwrap();
    assert_eq!(env["error"]["code"], "invalid_input");
}

/// Python helper that projects the sl_meta dots through a 4-pose camera ring into
/// per-view correspondence files (reusing the sidecar's OWN `sl_local_mm` /
/// `look_at_pose` / `project_point` so the synthetic geometry matches the
/// reconstruction math exactly), then injects ONE far-outlier point into view 0.
/// Run with the sidecar venv's `python` so the import path resolves.
const SL_CORR_GEN_PY: &str = r#"
import json, hashlib, sys
import numpy as np
from lmt_vba_sidecar.sl_geometry import sl_local_mm
from lmt_vba_sidecar.sl_feasibility import look_at_pose, project_point

meta_path, intr_path, out_dir = sys.argv[1], sys.argv[2], sys.argv[3]
meta = json.loads(open(meta_path).read())
K = np.array(json.loads(open(intr_path).read())["K"], float)
rect_by_cr = {(c["col"], c["row"]): c["input_rect_px"] for c in meta["cabinets"]}
pitch_by_cr = {(c["col"], c["row"]): c["pixel_pitch_mm"] for c in meta["cabinets"]}
cab_by_id = {d["id"]: tuple(d["cabinet"]) for d in meta["dots"]}
# Known world: root (0,0) = world gauge; cabinet (1,0) nominally +500mm x with a
# small known deviation. Identity cabinet rotation (flat wall).
cab_world_t = {(0, 0): np.zeros(3),
               (1, 0): np.array([500.0, 0.0, 0.0]) + np.array([3.0, 2.0, 1.0])}
truth_world = {}
for d in meta["dots"]:
    cr = cab_by_id[d["id"]]
    p_local = sl_local_mm(tuple(rect_by_cr[cr]), d["u"], d["v"],
                          pitch_by_cr[cr][0], pitch_by_cr[cr][1])
    truth_world[d["id"]] = p_local + cab_world_t[cr]
sha = hashlib.sha256(open(meta_path, "rb").read()).hexdigest()
poses = [look_at_pose(np.array([px, 0.0, -3500.0]), np.array([250.0, 0.0, 0.0]))
         for px in (-1200.0, -400.0, 400.0, 1200.0)]
rng = np.random.default_rng(0)
paths = []
for vi, (R, t) in enumerate(poses):
    pts = []
    for d in meta["dots"]:
        p = project_point(K, R, t, truth_world[d["id"]]) + rng.normal(0, 0.1, 2)
        pts.append({"id": d["id"], "u": d["u"], "v": d["v"],
                    "x": float(p[0]), "y": float(p[1])})
    # Inject ONE gross far-outlier (wrong-id pixel ~640px off) into view 0 only.
    if vi == 0:
        pts[10]["x"] += 500.0
        pts[10]["y"] -= 400.0
    cp = f"{out_dir}/corr_{vi}.json"
    open(cp, "w").write(json.dumps({
        "schema_version": 1, "screen_id": "MAIN", "sl_meta_sha256": sha,
        "screen_resolution": meta["screen_resolution"],
        "camera_image_size": [4000, 3000],
        "source_input": f"/cap/pose{vi}.mp4", "points": pts}))
    paths.append(cp)
print(json.dumps(paths))
"#;

/// Derive the venv `python` next to the sidecar binary/wrapper (the wrapper lives
/// in `.venv/bin/`, so `python` is its sibling) and run SL_CORR_GEN_PY to emit the
/// 4 correspondence files. Returns their paths in pose order.
fn write_sl_corr_with_outlier(dir: &Path, sidecar: &str, meta_path: &Path, intr: &Path) -> Vec<String> {
    let python = Path::new(sidecar)
        .parent()
        .expect("sidecar path has a parent dir")
        .join("python");
    let script = dir.join("gen_corr.py");
    std::fs::write(&script, SL_CORR_GEN_PY).unwrap();
    let out = Command::new(&python)
        .arg(&script)
        .arg(meta_path)
        .arg(intr)
        .arg(dir)
        .output()
        .expect("run corr generator with venv python");
    assert!(
        out.status.success(),
        "corr generator failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let paths: Vec<String> =
        serde_json::from_slice(out.stdout.trim_ascii_end()).expect("generator must print a JSON path array");
    assert_eq!(paths.len(), 4, "expected 4 corr files");
    paths
}

/// Real-sidecar happy path: a synthetic 2-cabinet SL scene with ONE injected
/// far-outlier correspondence must reconstruct successfully AND report the
/// outlier as rejected (Stage A PnP-RANSAC pre-clean + Stage B robust trim).
/// `#[ignore]` + gated on `LMT_VBA_SIDECAR_PATH` like the other real-sidecar tests.
#[test]
#[ignore = "requires LMT_VBA_SIDECAR_PATH set to a real sidecar binary/wrapper"]
fn reconstruct_structured_light_reports_rejection_stats() {
    let sidecar = match gp_sidecar() {
        Some(s) => s,
        None => {
            eprintln!("skip: LMT_VBA_SIDECAR_PATH unset");
            return;
        }
    };
    let tmp = TempDir::new().unwrap();
    let proj = tmp.path().join("proj");
    write_gp_project(&proj, 2, 1);

    // Generate the SL pattern (sl_meta.json) via the real sidecar.
    lmt()
        .env("LMT_VBA_SIDECAR_PATH", &sidecar)
        .args(["--json", "visual", "generate-structured-light",
               proj.to_str().unwrap(), "MAIN", "--yes"])
        .assert()
        .success();
    let meta_path = proj.join("patterns/MAIN/sl/sl_meta.json");
    assert!(meta_path.exists(), "sidecar must write sl_meta.json");

    // Intrinsics matching the synthetic 4000x3000 camera.
    let intr = tmp.path().join("intr.json");
    std::fs::write(
        &intr,
        serde_json::json!({
            "K": [[3000.0, 0, 2000.0], [0, 3000.0, 1500.0], [0, 0, 1.0]],
            "dist_coeffs": [0, 0, 0, 0, 0], "image_size": [4000, 3000]
        })
        .to_string(),
    )
    .unwrap();

    // Build 4 correspondence files with ONE injected far-outlier point in view 0.
    let corr = write_sl_corr_with_outlier(tmp.path(), &sidecar, &meta_path, &intr);

    let assert = lmt()
        .env("LMT_VBA_SIDECAR_PATH", &sidecar)
        .args(["--json", "visual", "reconstruct-structured-light",
               proj.to_str().unwrap(), "MAIN",
               "--sl-meta", meta_path.to_str().unwrap(),
               "--intrinsics", intr.to_str().unwrap(),
               "--corr", &corr[0], "--corr", &corr[1],
               "--corr", &corr[2], "--corr", &corr[3], "--yes"])
        .assert()
        .success();
    let env = gp_stdout_env(assert.get_output());
    assert_eq!(env["ok"], true, "envelope ok: {env}");
    // The injected outlier must be rejected by Stage A/B.
    assert!(
        env["data"]["ba_rejected"].as_u64().unwrap() >= 1,
        "expected ba_rejected>0, got {}",
        env["data"]
    );
    // used == total - rejected (counts are internally consistent).
    assert_eq!(
        env["data"]["ba_observations_used"].as_u64().unwrap(),
        env["data"]["ba_observations_total"].as_u64().unwrap()
            - env["data"]["ba_rejected"].as_u64().unwrap()
    );
    // Converged-equivalent: a finite low reprojection RMS + a written result.
    let rms = env["data"]["ba_rms_px"].as_f64().unwrap();
    assert!(rms.is_finite() && rms < 5.0, "expected converged low RMS, got {rms}");
    assert!(proj.join("measurements/measured.yaml").exists());
}


// ── plan-capture (visual capture guidance) ─────────────────────────────────────
// Uses a tiny inline 2x2 flat screen so the Monte-Carlo planner covers fast.

fn write_min_project(dir: &Path) -> std::path::PathBuf {
    let proj = dir.join("proj");
    std::fs::create_dir_all(&proj).unwrap();
    std::fs::write(
        proj.join("project.yaml"),
        r#"project:
  name: PlanCaptureE2E
  unit: mm
screens:
  MAIN:
    cabinet_count: [2, 2]
    cabinet_size_mm: [500, 500]
    shape_prior:
      type: flat
    shape_mode: rectangle
    irregular_mask: []
coordinate_system:
  origin_point: MAIN_V001_R001
  x_axis_point: MAIN_V002_R001
  xy_plane_point: MAIN_V001_R002
output:
  target: disguise
  obj_filename: "{screen_id}_mesh.obj"
  weld_vertices_tolerance_mm: 1.0
  triangulate: true
"#,
    )
    .unwrap();
    proj
}

#[cfg(unix)]
#[test]
fn visual_plan_capture_returns_plan() {
    let tmp = TempDir::new().unwrap();
    let proj = write_min_project(tmp.path());
    // Real sidecar: skip gracefully when the dev venv is absent (CI/fresh checkout).
    let wrapper = match make_sidecar_wrapper(tmp.path()) {
        Some(w) => w,
        None => {
            eprintln!("skipping visual_plan_capture_returns_plan: python-sidecar venv not found");
            return;
        }
    };
    let assert = lmt()
        .env("LMT_VBA_SIDECAR_PATH", &wrapper)
        .args([
            "--json", "visual", "plan-capture",
            proj.to_str().unwrap(), "MAIN",
            "--image-size", "1920x1080", "--hfov-deg", "60",
            "--standoff", "2000..4000", "--height", "400..2200",
            "--trials", "6",
        ])
        .assert()
        .success();
    let env: Value = serde_json::from_slice(&assert.get_output().stdout).unwrap();
    assert_eq!(env["ok"], true);
    assert!(env["data"]["stations"].as_array().unwrap().len() >= 5);
    assert_eq!(env["data"]["coverage"].as_array().unwrap().len(), 4);
    assert_eq!(env["data"]["all_pass"], true);
    // valid JSON end-to-end — no NaN leaked through (null p95 only)
    assert!(!std::str::from_utf8(&assert.get_output().stdout).unwrap().contains("NaN"));
}

#[test]
fn visual_plan_capture_bad_screen_is_error_envelope() {
    let tmp = TempDir::new().unwrap();
    let proj = write_min_project(tmp.path());
    let assert = lmt()
        .args([
            "--json", "visual", "plan-capture",
            proj.to_str().unwrap(), "BOGUS",
            "--image-size", "1920x1080", "--hfov-deg", "60",
            "--standoff", "2000..4000", "--height", "400..2200",
            "--trials", "6",
        ])
        .assert()
        .failure();
    let stderr = std::str::from_utf8(&assert.get_output().stderr).unwrap().trim_end();
    assert!(!stderr.contains('\n'), "stderr must be a single envelope line; got:\n{stderr}");
    let env: Value = serde_json::from_str(stderr).expect("stderr must be JSON envelope");
    assert_eq!(env["ok"], false);
    assert_eq!(env["error"]["code"], "not_found");
}

#[test]
fn visual_plan_capture_bad_image_size_is_invalid_input() {
    let tmp = TempDir::new().unwrap();
    let proj = write_min_project(tmp.path());
    let assert = lmt()
        .args([
            "--json", "visual", "plan-capture",
            proj.to_str().unwrap(), "MAIN",
            "--image-size", "nonsense", "--hfov-deg", "60",
            "--standoff", "2000..4000", "--height", "400..2200",
        ])
        .assert()
        .failure();
    let stderr = std::str::from_utf8(&assert.get_output().stderr).unwrap().trim_end();
    let env: Value = serde_json::from_str(stderr).unwrap();
    assert_eq!(env["error"]["code"], "invalid_input");
}

#[cfg(unix)]
#[test]
fn visual_capture_card_emits_self_contained_html() {
    let tmp = TempDir::new().unwrap();
    let proj = write_min_project(tmp.path());
    let wrapper = match make_sidecar_wrapper(tmp.path()) {
        Some(w) => w,
        None => {
            eprintln!("skipping visual_capture_card_emits_self_contained_html: venv not found");
            return;
        }
    };
    let assert = lmt()
        .env("LMT_VBA_SIDECAR_PATH", &wrapper)
        .args([
            "visual", "capture-card", proj.to_str().unwrap(), "MAIN",
            "--image-size", "1920x1080", "--hfov-deg", "60",
            "--standoff", "2000..4000", "--height", "400..2200", "--trials", "6",
        ])
        .assert()
        .success();
    let html = String::from_utf8(assert.get_output().stdout.clone()).unwrap();
    assert!(html.starts_with("<!DOCTYPE html>"));
    assert!(html.contains("window.THREE"), "Three.js bundle inlined");
    assert!(html.contains("OrbitControls"), "OrbitControls inlined");
    assert!(html.contains("PingFang SC"));
    assert!(!html.contains("/*__DATA__*/"), "DATA placeholder replaced");
    assert!(!html.contains("/*__THREE_BUNDLE__*/"), "THREE_BUNDLE placeholder replaced");
    assert!(!html.contains("unpkg.com") && !html.contains("cdn."), "no CDN references");
}
// ---------------------------------------------------------------------------
// calibrate-structured-light E2E (Task 8)
// ---------------------------------------------------------------------------

/// Python helper: project nominal dot 3D (3×3 curved wall, radius 6000mm) through a
/// known K from 6 oblique multi-distance poses and write 6 corr files.
/// This geometry mirrors the `_well_meta` / `_well_poses` substrate in
/// python-sidecar/tests/test_calibrate_sl.py — the proven well-conditioned envelope
/// that passes all hardened observability gates.
/// argv: meta_path intr_path out_dir.  Prints the JSON path array.
const SL_CALIB_CORR_GEN_PY: &str = r#"
import json, hashlib, sys
import numpy as np
from lmt_vba_sidecar.ipc import StructuredLightMeta, CabinetArray, ShapePriorCurved, ShapePriorCurvedBody
from lmt_vba_sidecar.nominal import nominal_dot_positions_world
from lmt_vba_sidecar.sl_feasibility import look_at_pose, project_point

meta_path, intr_path, out_dir = sys.argv[1], sys.argv[2], sys.argv[3]
meta = StructuredLightMeta.model_validate_json(open(meta_path).read())
K = np.array(json.loads(open(intr_path).read())["K"], float)
# 3x3 curved wall, radius 6000mm — matches _well_meta() in test_calibrate_sl.py
cab = CabinetArray(cols=3, rows=3, cabinet_size_mm=[500.0, 500.0])
shape = ShapePriorCurved(curved=ShapePriorCurvedBody(radius_mm=6000.0))
world = nominal_dot_positions_world(meta, cab, shape)
center = np.array(list(world.values())).mean(0)
cx, cy, cz = center
sha = hashlib.sha256(open(meta_path, "rb").read()).hexdigest()
# 6 oblique poses at 2 distinct distances — mirrors _well_poses() in test_calibrate_sl.py
pose_params = [(-25, -12, 4.5), (20, 10, 4.5), (-15, 15, 8.0),
               (30, -18, 8.0), (0, 0, 6.0), (-35, 5, 5.5)]
poses = []
for az, el, dist in pose_params:
    a, e = np.radians(az), np.radians(el)
    pos = np.array([cx + dist * np.sin(a) * np.cos(e),
                    cy + dist * np.sin(e),
                    cz - dist * np.cos(a) * np.cos(e)])
    poses.append(look_at_pose(pos, center))
rng = np.random.default_rng(0)
paths = []
for vi, (R, t) in enumerate(poses):
    pts = []
    for d in meta.dots:
        p = project_point(K, R, t, world[d.id]) + rng.normal(0, 0.2, 2)
        pts.append({"id": d.id, "u": d.u, "v": d.v, "x": float(p[0]), "y": float(p[1])})
    cp = f"{out_dir}/ccorr_{vi}.json"
    open(cp, "w").write(json.dumps({
        "schema_version": 1, "screen_id": "MAIN", "sl_meta_sha256": sha,
        "screen_resolution": meta.screen_resolution, "camera_image_size": [4000, 3000],
        "source_input": f"/cap/pose{vi}.mp4", "points": pts}))
    paths.append(cp)
print(json.dumps(paths))
"#;

/// Write a minimal curved-screen project.yaml (3×3 cabinets, radius 6000mm).
/// Matches the `_well_meta()` substrate in test_calibrate_sl.py — the
/// well-conditioned geometry the hardened gates require.
/// shape_prior uses `{ type: curved, radius_mm: N }` — the Rust dto is a
/// serde "internally-tagged" enum (`#[serde(tag = "type", rename_all = "snake_case")]`).
fn write_curved_project(dir: &Path) {
    let yaml =
        "project: { name: GP, unit: mm }\nscreens:\n  MAIN:\n    cabinet_count: [3, 3]\n    cabinet_size_mm: [500, 500]\n    pixels_per_cabinet: [540, 540]\n    shape_prior: { type: curved, radius_mm: 6000 }\n    shape_mode: rectangle\n    irregular_mask: []\ncoordinate_system:\n  origin_point: MAIN_V000_R000\n  x_axis_point: MAIN_V000_R000\n  xy_plane_point: MAIN_V000_R000\noutput:\n  target: neutral\n  obj_filename: \"{screen_id}.obj\"\n  weld_vertices_tolerance_mm: 1.0\n  triangulate: true\n";
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(dir.join("project.yaml"), yaml).unwrap();
}

/// Run SL_CALIB_CORR_GEN_PY via the venv python sibling of the sidecar wrapper.
/// Returns the 4 corr file paths in pose order.
fn write_sl_calib_corr(dir: &Path, sidecar: &str, meta_path: &Path, intr: &Path) -> Vec<String> {
    let python = Path::new(sidecar)
        .parent()
        .expect("sidecar path has a parent dir")
        .join("python");
    let script = dir.join("gen_ccorr.py");
    std::fs::write(&script, SL_CALIB_CORR_GEN_PY).unwrap();
    let out = Command::new(&python)
        .arg(&script)
        .arg(meta_path)
        .arg(intr)
        .arg(dir)
        .output()
        .expect("run calib corr generator");
    assert!(
        out.status.success(),
        "calib corr gen failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let paths: Vec<String> =
        serde_json::from_slice(out.stdout.trim_ascii_end()).expect("JSON path array");
    assert_eq!(paths.len(), 6, "expected 6 corr files (6 oblique poses)");
    paths
}

/// Real-sidecar happy path: a synthetic 3×3 curved-wall SL scene (radius 6000mm)
/// calibrated from 6 oblique multi-distance poses must recover the ground-truth
/// focal within 2% and write _sl_intrinsics.json.
/// Geometry mirrors `_well_meta` + `_well_poses` in test_calibrate_sl.py —
/// the well-conditioned envelope that passes all hardened observability gates.
#[test]
#[ignore = "requires LMT_VBA_SIDECAR_PATH set to a real sidecar binary/wrapper"]
fn calibrate_structured_light_recovers_focal() {
    let sidecar = match gp_sidecar() {
        Some(s) => s,
        None => {
            eprintln!("skip: LMT_VBA_SIDECAR_PATH unset");
            return;
        }
    };
    let tmp = TempDir::new().unwrap();
    let proj = tmp.path().join("proj");
    write_curved_project(&proj);

    lmt()
        .env("LMT_VBA_SIDECAR_PATH", &sidecar)
        .args(["--json", "visual", "generate-structured-light",
               proj.to_str().unwrap(), "MAIN", "--yes"])
        .assert()
        .success();
    let meta_path = proj.join("patterns/MAIN/sl/sl_meta.json");
    assert!(meta_path.exists(), "sidecar must write sl_meta.json");

    let intr = tmp.path().join("truthK.json");
    std::fs::write(
        &intr,
        serde_json::json!({
            "K": [[3000.0, 0, 2000.0], [0, 3000.0, 1500.0], [0, 0, 1.0]],
            "dist_coeffs": [0, 0, 0, 0, 0], "image_size": [4000, 3000]
        })
        .to_string(),
    )
    .unwrap();
    let corr = write_sl_calib_corr(tmp.path(), &sidecar, &meta_path, &intr);

    let mut args = vec![
        "--json", "visual", "calibrate-structured-light",
        proj.to_str().unwrap(), "MAIN",
        "--sl-meta", meta_path.to_str().unwrap(),
    ];
    for c in &corr {
        args.push("--corr");
        args.push(c);
    }
    args.push("--yes");
    let assert = lmt()
        .env("LMT_VBA_SIDECAR_PATH", &sidecar)
        .args(&args)
        .assert()
        .success();

    let env = gp_stdout_env(assert.get_output());
    assert_eq!(env["ok"], true, "envelope ok: {env}");
    let out_file = proj.join("calibration/MAIN_sl_intrinsics.json");
    assert!(out_file.exists(), "must write _sl_intrinsics.json");
    let intr_out: Value =
        serde_json::from_slice(&std::fs::read(&out_file).unwrap()).unwrap();
    let fx = intr_out["K"][0][0].as_f64().unwrap();
    assert!(
        (fx - 3000.0).abs() / 3000.0 < 0.02,
        "focal within 2%, got {fx}"
    );
    assert_eq!(intr_out["calibration_method"], "structured_light_nominal");
}

/// No --yes and no --dry-run → gate_destructive refuses (exit 2, invalid_input).
#[test]
fn calibrate_structured_light_refuses_without_yes() {
    let tmp = TempDir::new().unwrap();
    let proj = tmp.path().join("proj");
    write_gp_project(&proj, 2, 1);
    let meta = tmp.path().join("sl_meta.json");
    std::fs::write(&meta, "{}").unwrap();
    let c0 = tmp.path().join("c0.json");
    std::fs::write(&c0, "{}").unwrap();
    let assert = lmt()
        .args(["--json", "visual", "calibrate-structured-light",
               proj.to_str().unwrap(), "MAIN",
               "--sl-meta", meta.to_str().unwrap(),
               "--corr", c0.to_str().unwrap()])
        .assert()
        .failure();
    let out = assert.get_output();
    assert_eq!(out.status.code(), Some(2));
    let env: Value =
        serde_json::from_str(std::str::from_utf8(&out.stderr).unwrap().trim_end()).unwrap();
    assert_eq!(env["error"]["code"], "invalid_input");
}

/// --dry-run: exit 0, envelope ok==true, data.dry_run==true, no file written.
#[test]
fn calibrate_structured_light_dry_run_writes_nothing() {
    let tmp = TempDir::new().unwrap();
    let proj = tmp.path().join("proj");
    write_gp_project(&proj, 2, 1);
    let meta = tmp.path().join("sl_meta.json");
    std::fs::write(&meta, "{}").unwrap();
    let c0 = tmp.path().join("c0.json");
    std::fs::write(&c0, "{}").unwrap();
    let assert = lmt()
        .args(["--json", "--dry-run", "visual", "calibrate-structured-light",
               proj.to_str().unwrap(), "MAIN",
               "--sl-meta", meta.to_str().unwrap(),
               "--corr", c0.to_str().unwrap()])
        .assert()
        .success();
    let env: Value = serde_json::from_slice(&assert.get_output().stdout).unwrap();
    assert_eq!(env["ok"], true);
    assert_eq!(env["data"]["dry_run"], true);
    assert!(!proj.join("calibration/MAIN_sl_intrinsics.json").exists());
}

/// Output file exists + no --force → invalid_input (exit 2) before the sidecar
/// is invoked (guard at run_calibrate_structured_light line that checks
/// output_path.exists() && !force before constructing the adapter args).
#[cfg(unix)]
#[test]
fn calibrate_structured_light_refuses_overwrite_without_force() {
    let tmp = TempDir::new().unwrap();
    let proj = tmp.path().join("proj");
    write_gp_project(&proj, 2, 1);
    // Pre-create the default output path so the guard fires.
    std::fs::create_dir_all(proj.join("calibration")).unwrap();
    std::fs::write(proj.join("calibration/MAIN_sl_intrinsics.json"), "{}").unwrap();
    let meta = tmp.path().join("sl_meta.json");
    std::fs::write(&meta, "{}").unwrap();
    let c0 = tmp.path().join("c0.json");
    std::fs::write(&c0, "{}").unwrap();
    // Provide an error mock as the sidecar; if the guard doesn't fire first, the
    // mock ensures the test still fails predictably (not accidentally succeeds).
    let mock = write_error_mock(tmp.path(), "internal_error");
    let assert = lmt()
        .env("LMT_VBA_SIDECAR_PATH", &mock)
        .args(["--json", "visual", "calibrate-structured-light",
               proj.to_str().unwrap(), "MAIN",
               "--sl-meta", meta.to_str().unwrap(),
               "--corr", c0.to_str().unwrap(),
               "--yes"])
        .assert()
        .failure();
    let out = assert.get_output();
    assert_eq!(out.status.code(), Some(2));
    let env: Value =
        serde_json::from_str(std::str::from_utf8(&out.stderr).unwrap().trim_end()).unwrap();
    assert_eq!(env["error"]["code"], "invalid_input");
}

/// --dry-run + output file already exists + no --force → invalid_input (exit 2).
/// Mirrors calibrate_structured_light_refuses_overwrite_without_force but with
/// --dry-run, proving that dry-run and execute agree on the clobber refusal.
#[cfg(unix)]
#[test]
fn calibrate_structured_light_dry_run_refuses_overwrite_without_force() {
    let tmp = TempDir::new().unwrap();
    let proj = tmp.path().join("proj");
    write_gp_project(&proj, 2, 1);
    // Pre-create the default output path so the pre-gate check fires.
    std::fs::create_dir_all(proj.join("calibration")).unwrap();
    std::fs::write(proj.join("calibration/MAIN_sl_intrinsics.json"), "{}").unwrap();
    let meta = tmp.path().join("sl_meta.json");
    std::fs::write(&meta, "{}").unwrap();
    let c0 = tmp.path().join("c0.json");
    std::fs::write(&c0, "{}").unwrap();
    let assert = lmt()
        .args(["--json", "--dry-run", "visual", "calibrate-structured-light",
               proj.to_str().unwrap(), "MAIN",
               "--sl-meta", meta.to_str().unwrap(),
               "--corr", c0.to_str().unwrap()])
        .assert()
        .failure();
    let out = assert.get_output();
    assert_eq!(out.status.code(), Some(2));
    let env: Value =
        serde_json::from_str(std::str::from_utf8(&out.stderr).unwrap().trim_end()).unwrap();
    assert_eq!(env["error"]["code"], "invalid_input");
}
