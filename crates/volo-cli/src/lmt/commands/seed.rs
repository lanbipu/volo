//! `lmt seed-example <name> <dst>` —— 释放内置 example 到目标目录。
//!
//! 业务逻辑(嵌入资源 + 释放)在 `mesh_app::projects`;本文件只做 transport:
//! destructive 守门 + dry-run 预览 + envelope 输出。未来 MCP server 调用
//! 同一个 `mesh_app::projects::seed_embedded_example`,无需重复嵌入。
//! side_effect: destructive。

use crate::lmt::commands::util::{self, DestructiveDecision};
use crate::lmt::output::{self, Mode};
use volo_shared::envelope::{error_codes, ApiError};
use std::io::Write;
use std::path::Path;

pub fn run(mode: Mode, name: &str, dst: &Path, yes: bool, dry_run: bool) -> i32 {
    let decision = match util::gate_destructive(yes, dry_run, "seed-example") {
        Ok(d) => d,
        Err(e) => return output::err(mode, e),
    };
    match decision {
        DestructiveDecision::DryRun => {
            // dry-run 是真正的 preflight:未知 name 与已存在目标都要在这里失败,
            // 不能报 ok 让 agent 以为安全、然后 --yes 才炸(破坏 dry-run 契约)。
            let names = mesh_app::projects::embedded_example_names();
            if !names.iter().any(|n| n == name) {
                return output::err(
                    mode,
                    ApiError::new(
                        error_codes::NOT_FOUND,
                        format!("example '{name}' not found; available: {names:?}"),
                    ),
                );
            }
            let target = dst.join(name);
            if target.exists() {
                return output::err(
                    mode,
                    ApiError::new(
                        error_codes::INVALID_INPUT,
                        format!(
                            "destination already exists: {} (remove it first to re-seed)",
                            target.display()
                        ),
                    ),
                );
            }
            let payload = serde_json::json!({
                "dry_run": true,
                "would_seed": name,
                "would_write_under": target.display().to_string(),
            });
            output::ok(mode, payload, |_| {
                let _ = writeln!(
                    std::io::stdout(),
                    "[dry-run] would seed example '{name}' into {}",
                    target.display()
                );
            })
        }
        DestructiveDecision::Execute => {
            match mesh_app::projects::seed_embedded_example(name, dst) {
                Ok(seeded) => output::ok(
                    mode,
                    serde_json::json!({"seeded": name, "path": seeded.display().to_string()}),
                    |_| {
                        let _ = writeln!(
                            std::io::stdout(),
                            "seeded example '{name}' into {}",
                            seeded.display()
                        );
                    },
                ),
                Err(e) => output::err(mode, ApiError::from(e)),
            }
        }
    }
}
