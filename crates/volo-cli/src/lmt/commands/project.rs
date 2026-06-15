//! `lmt project ...` 子命令。

use crate::lmt::cli::ProjectCmd;
use crate::lmt::commands::util::{self, DestructiveDecision};
use crate::lmt::output::{self, Mode};
use volo_shared::data::recent_projects;
use volo_shared::dto::ProjectConfig;
use volo_shared::envelope::{error_codes, ApiError};
use std::path::{Path, PathBuf};

pub fn run(cmd: ProjectCmd, mode: Mode, db_arg: Option<&Path>, yes: bool, dry_run: bool) -> i32 {
    match cmd {
        ProjectCmd::ListRecent => list_recent(mode, db_arg),
        ProjectCmd::AddRecent {
            abs_path,
            display_name,
        } => add_recent(mode, db_arg, &abs_path, &display_name, dry_run),
        ProjectCmd::RemoveRecent { id } => remove_recent(mode, db_arg, id, yes, dry_run),
        ProjectCmd::Load { abs_path } => load(mode, &abs_path),
        ProjectCmd::Save { abs_path, input } => save(mode, &abs_path, input, yes, dry_run),
    }
}

fn list_recent(mode: Mode, db_arg: Option<&Path>) -> i32 {
    // read_only command —— 走 readonly,不创建/不 migrate DB。
    // DB 缺失时返回空列表(逻辑上等价于"还没用过 GUI / CLI",非错误)。
    let db_opt = match util::open_db_readonly(db_arg) {
        Ok(o) => o,
        Err(e) => return output::err(mode, e),
    };
    let rows = match db_opt {
        None => Ok(Vec::new()),
        Some(db) => {
            let conn = db.lock().unwrap();
            recent_projects::list(&conn)
        }
    };
    match rows {
        Ok(rows) => output::ok(mode, rows, |list| {
            if list.is_empty() {
                let _ = writeln!(std::io::stdout(), "(no recent projects)");
                return;
            }
            for r in list {
                let _ = writeln!(
                    std::io::stdout(),
                    "{:>4}  {}  {}  ({})",
                    r.id,
                    r.last_opened_at,
                    r.display_name,
                    r.abs_path
                );
            }
        }),
        Err(e) => output::err(mode, ApiError::from(e)),
    }
}

fn add_recent(
    mode: Mode,
    db_arg: Option<&Path>,
    abs_path: &str,
    display_name: &str,
    dry_run: bool,
) -> i32 {
    // Path normalization 在 volo_shared::data::recent_projects::upsert_normalized
    // 内部统一处理,GUI 与 CLI 共用 DB 时 abs_path 落到同一字符串。dry-run
    // 这里手动 normalize 一次给 preview 显示用,跟 execute path 走的字符串一致。
    let normalized = match util::normalize_for_db(Path::new(abs_path)) {
        Ok(p) => p,
        Err(e) => return output::err(mode, e),
    };
    let normalized_str = normalized.display().to_string();

    // add-recent 是 write_safe(upsert),所以默认不要 --yes;但 --dry-run
    // 仍需被尊重:全局 flag 的"预演不写盘 / 不动 DB"契约任何写命令都得遵守,
    // 否则 agent 用一份脚本预演时会无声更新共享 DB。
    if dry_run {
        let db_opt = match util::open_db_readonly(db_arg) {
            Ok(o) => o,
            Err(e) => return output::err(mode, e),
        };
        let existed = match &db_opt {
            Some(db) => {
                let conn = db.lock().unwrap();
                conn.query_row(
                    "SELECT 1 FROM recent_projects WHERE abs_path = ?1",
                    [&normalized_str],
                    |_| Ok(true),
                )
                .unwrap_or(false)
            }
            None => false,
        };
        let payload = serde_json::json!({
            "dry_run": true,
            "would_upsert": {"abs_path": normalized_str, "display_name": display_name},
            "would_update_existing": existed,
            "db_exists": db_opt.is_some(),
        });
        return output::ok(mode, payload, |_| {
            let _ = writeln!(
                std::io::stdout(),
                "[dry-run] would upsert recent_projects abs_path={normalized_str} display_name={display_name} (existed: {existed})"
            );
        });
    }
    let db = match util::open_db(db_arg) {
        Ok(d) => d,
        Err(e) => return output::err(mode, e),
    };
    let conn = db.lock().unwrap();
    match recent_projects::upsert_normalized(&conn, abs_path, display_name) {
        Ok(row) => output::ok(mode, row, |r| {
            let _ = writeln!(
                std::io::stdout(),
                "upserted id={} display_name={} abs_path={}",
                r.id,
                r.display_name,
                r.abs_path
            );
        }),
        Err(e) => output::err(mode, ApiError::from(e)),
    }
}

fn remove_recent(mode: Mode, db_arg: Option<&Path>, id: i64, yes: bool, dry_run: bool) -> i32 {
    let decision = match util::gate_destructive(yes, dry_run, "project remove-recent") {
        Ok(d) => d,
        Err(e) => return output::err(mode, e),
    };
    match decision {
        DestructiveDecision::DryRun => {
            // 用 readonly 路径,**不**触发 DB 创建 / migration / WAL 写盘。
            let db_opt = match util::open_db_readonly(db_arg) {
                Ok(o) => o,
                Err(e) => return output::err(mode, e),
            };
            let (exists, db_exists) = match &db_opt {
                Some(db) => {
                    let conn = db.lock().unwrap();
                    // 表可能不存在(旧 DB 没跑 migration),容错查询。
                    let ex: bool = conn
                        .query_row(
                            "SELECT 1 FROM recent_projects WHERE id = ?1",
                            [id],
                            |_| Ok(true),
                        )
                        .unwrap_or(false);
                    (ex, true)
                }
                None => (false, false),
            };
            let payload = serde_json::json!({
                "dry_run": true,
                "would_delete_id": id,
                "exists": exists,
                "db_exists": db_exists,
            });
            output::ok(mode, payload, |_| {
                let _ = writeln!(
                    std::io::stdout(),
                    "[dry-run] would delete recent_projects id={id} (exists: {exists}, db_exists: {db_exists})"
                );
            })
        }
        DestructiveDecision::Execute => {
            let db = match util::open_db(db_arg) {
                Ok(d) => d,
                Err(e) => return output::err(mode, e),
            };
            let conn = db.lock().unwrap();
            match recent_projects::delete(&conn, id) {
                Ok(()) => output::ok(mode, serde_json::json!({"deleted_id": id}), |_| {
                    let _ = writeln!(std::io::stdout(), "deleted recent_projects id={id}");
                }),
                Err(e) => output::err(mode, ApiError::from(e)),
            }
        }
    }
}

fn load(mode: Mode, abs_path: &str) -> i32 {
    match mesh_app::projects::load_project_yaml_from_path(Path::new(abs_path)) {
        Ok(cfg) => output::ok(mode, cfg, |c| {
            let _ = writeln!(
                std::io::stdout(),
                "project: {} ({}); {} screens; target={}",
                c.project.name,
                c.project.unit,
                c.screens.len(),
                c.output.target
            );
        }),
        Err(e) => output::err(mode, ApiError::from(e)),
    }
}

fn save(
    mode: Mode,
    abs_path: &str,
    input: Option<PathBuf>,
    yes: bool,
    dry_run: bool,
) -> i32 {
    let decision = match util::gate_destructive(yes, dry_run, "project save") {
        Ok(d) => d,
        Err(e) => return output::err(mode, e),
    };
    let bytes = match util::read_input_bytes(input.as_deref()) {
        Ok(b) => b,
        Err(e) => return output::err(mode, e),
    };
    // 先按 YAML 试,失败再按 JSON。两边都用 lmt-shared 的 DTO,schema 一致。
    let cfg: ProjectConfig = match serde_yaml::from_slice::<ProjectConfig>(&bytes) {
        Ok(c) => c,
        Err(_) => match serde_json::from_slice::<ProjectConfig>(&bytes) {
            Ok(c) => c,
            Err(e) => {
                return output::err(
                    mode,
                    ApiError::new(
                        error_codes::SERIALIZATION,
                        format!("input is neither valid YAML nor JSON for ProjectConfig: {e}"),
                    ),
                );
            }
        },
    };
    match decision {
        DestructiveDecision::DryRun => {
            let payload = serde_json::json!({
                "dry_run": true,
                "would_write": format!("{}/project.yaml", abs_path),
                "screens": cfg.screens.keys().collect::<Vec<_>>(),
                "project_name": cfg.project.name,
            });
            output::ok(mode, payload, |_| {
                let _ = writeln!(
                    std::io::stdout(),
                    "[dry-run] would write {}/project.yaml ({} screens, name={})",
                    abs_path,
                    cfg.screens.len(),
                    cfg.project.name
                );
            })
        }
        DestructiveDecision::Execute => {
            match mesh_app::projects::save_project_yaml_to_path(Path::new(abs_path), &cfg) {
                Ok(()) => output::ok(
                    mode,
                    serde_json::json!({"written": format!("{abs_path}/project.yaml")}),
                    |_| {
                        let _ = writeln!(
                            std::io::stdout(),
                            "wrote {}/project.yaml",
                            abs_path
                        );
                    },
                ),
                Err(e) => output::err(mode, ApiError::from(e)),
            }
        }
    }
}

// std::io::Write trait scope for writeln! macros above.
use std::io::Write as _;
