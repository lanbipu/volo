//! `lmt reconstruct ...` 子命令。

use crate::lmt::cli::ReconstructCmd;
use crate::lmt::commands::util::{self, DestructiveDecision};
use crate::lmt::output::{self, Mode};
use volo_shared::envelope::{error_codes, ApiError};
use std::io::Write as _;
use std::path::Path;

pub fn run(cmd: ReconstructCmd, mode: Mode, db_arg: Option<&Path>, yes: bool, dry_run: bool) -> i32 {
    match cmd {
        ReconstructCmd::Surface {
            project_path,
            screen_id,
            measurements_path,
        } => surface(
            mode,
            db_arg,
            &project_path,
            &screen_id,
            &measurements_path,
            yes,
            dry_run,
        ),
        ReconstructCmd::ListRuns {
            project_path,
            screen_id,
        } => list_runs(mode, db_arg, &project_path, screen_id.as_deref()),
        ReconstructCmd::GetRunReport { run_id } => get_run_report(mode, db_arg, run_id),
    }
}

fn surface(
    mode: Mode,
    db_arg: Option<&Path>,
    project_path: &str,
    screen_id: &str,
    measurements_rel_path: &str,
    yes: bool,
    dry_run: bool,
) -> i32 {
    let decision = match util::gate_destructive(yes, dry_run, "reconstruct surface") {
        Ok(d) => d,
        Err(e) => return output::err(mode, e),
    };

    match decision {
        DestructiveDecision::DryRun => {
            // 校验输入文件 + screen 存在;不真跑算法。
            // 跟 execute path 一样先 canonicalize project_path —— 否则
            // preview 报的 `would_write_report_under` 跟 `run_reconstruction`
            // 真实写入的目录不一致,agent 会按错误路径继续操作。
            let project = match util::canonicalize_existing(Path::new(project_path)) {
                Ok(p) => p,
                Err(e) => return output::err(mode, e),
            };
            let cfg = match mesh_app::projects::load_project_yaml_from_path(&project) {
                Ok(c) => c,
                Err(e) => return output::err(mode, ApiError::from(e)),
            };
            if !cfg.screens.contains_key(screen_id) {
                return output::err(
                    mode,
                    ApiError::new(
                        error_codes::NOT_FOUND,
                        format!("screen '{screen_id}' not in project"),
                    ),
                );
            }
            let m_abs = project.join(measurements_rel_path);
            if !m_abs.is_file() {
                return output::err(
                    mode,
                    ApiError::new(
                        error_codes::NOT_FOUND,
                        format!("measurements file not found: {}", m_abs.display()),
                    ),
                );
            }
            let project_display = project.display().to_string();
            let payload = serde_json::json!({
                "dry_run": true,
                "would_write_report_under": format!("{}/reports/", project_display),
                "would_insert_run_for": {"project": project_display, "screen": screen_id},
                "measurements_path": measurements_rel_path,
            });
            output::ok(mode, payload, |_| {
                let _ = writeln!(
                    std::io::stdout(),
                    "[dry-run] would write report.json under {project_path}/reports/ and insert a new run for screen {screen_id}"
                );
            })
        }
        DestructiveDecision::Execute => {
            // canonicalize 已经被 lmt-app 内部统一做了(GUI 与 CLI 共享),
            // CLI 这层直接传原始 Path 即可。
            let db = match util::open_db(db_arg) {
                Ok(d) => d,
                Err(e) => return output::err(mode, e),
            };
            match mesh_app::reconstruct::run_reconstruction(
                db,
                Path::new(project_path),
                screen_id,
                measurements_rel_path,
            ) {
                Ok(r) => {
                    // `r.surface` 嵌入 lmt-core 类型,故意没派生 JsonSchema。
                    // 走 ApiError-friendly 的轻量 payload(关键 IDs + 路径),
                    // agent 想拿完整 report 用 `lmt reconstruct get-run-report`。
                    let payload = serde_json::json!({
                        "run_id": r.run_id,
                        "report_json_path": r.report_json_path,
                        "vertices": r.surface.vertices.len(),
                        "method": r.surface.quality_metrics.method,
                        "estimated_rms_mm": r.surface.quality_metrics.estimated_rms_mm,
                        "estimated_p95_mm": r.surface.quality_metrics.estimated_p95_mm,
                    });
                    output::ok(mode, payload, |p| {
                        // FIX-12: rms/p95 是真实拟合残差;精确插值方法无 holdout
                        // 时为 null → 人类输出打 "n/a" 而不是假数。
                        let fmt_mm = |v: &serde_json::Value| match v.as_f64() {
                            Some(x) => format!("{x:.3}mm"),
                            None => "n/a".to_string(),
                        };
                        let _ = writeln!(
                            std::io::stdout(),
                            "run #{} written ({})\n  method={} fit_rms={} fit_p95={} vertices={}",
                            p["run_id"],
                            p["report_json_path"].as_str().unwrap_or(""),
                            p["method"].as_str().unwrap_or("?"),
                            fmt_mm(&p["estimated_rms_mm"]),
                            fmt_mm(&p["estimated_p95_mm"]),
                            p["vertices"],
                        );
                    })
                }
                Err(e) => output::err(mode, ApiError::from(e)),
            }
        }
    }
}

fn list_runs(mode: Mode, db_arg: Option<&Path>, project_path: &str, screen_id: Option<&str>) -> i32 {
    // read_only command —— readonly DB,缺失时返回空列表。
    // canonicalize 由 lmt-app 内部统一处理(跟 run_reconstruction 写入时一致)。
    let db_opt = match util::open_db_readonly(db_arg) {
        Ok(o) => o,
        Err(e) => return output::err(mode, e),
    };
    let rows = match db_opt {
        None => Ok(Vec::new()),
        Some(db) => mesh_app::reconstruct::list_runs_for(db, project_path, screen_id),
    };
    match rows {
        Ok(rows) => output::ok(mode, rows, |list| {
            if list.is_empty() {
                let _ = writeln!(std::io::stdout(), "(no runs)");
                return;
            }
            for r in list {
                let rms = match r.estimated_rms_mm {
                    Some(x) => format!("{x:.3}mm"),
                    None => "n/a".to_string(),
                };
                let _ = writeln!(
                    std::io::stdout(),
                    "#{:>4}  screen={}  method={}  fit_rms={}  vertices={}  ({})",
                    r.id,
                    r.screen_id,
                    r.method,
                    rms,
                    r.vertex_count,
                    r.created_at
                );
            }
        }),
        Err(e) => output::err(mode, ApiError::from(e)),
    }
}

fn get_run_report(mode: Mode, db_arg: Option<&Path>, run_id: i64) -> i32 {
    // read_only command —— readonly DB;缺失时直接 not_found。
    let db_opt = match util::open_db_readonly(db_arg) {
        Ok(o) => o,
        Err(e) => return output::err(mode, e),
    };
    let db = match db_opt {
        Some(d) => d,
        None => {
            return output::err(
                mode,
                ApiError::new(error_codes::NOT_FOUND, format!("run id {run_id}")),
            );
        }
    };
    match mesh_app::reconstruct::read_run_report(db, run_id) {
        Ok(v) => output::ok(mode, v, |json| {
            // human 模式直接 pretty-print JSON,agent 会用 --json 拿稳定 envelope。
            let _ = writeln!(
                std::io::stdout(),
                "{}",
                serde_json::to_string_pretty(json).unwrap_or_else(|_| json.to_string())
            );
        }),
        Err(e) => output::err(mode, ApiError::from(e)),
    }
}
