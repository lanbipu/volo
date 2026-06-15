//! `lmt manifest` —— dump Contract Manifest(operation 清单)。
//!
//! side_effect: read_only;不需要 DB / project / network。
//! 与 `schema` 互补:manifest 答 "有哪些操作",schema 答 "数据形状"。

use crate::lmt::output::{self, Mode};
use std::io::Write;

pub fn run(mode: Mode) -> i32 {
    let manifest = volo_shared::manifest::build();
    output::ok(mode, manifest, |m| {
        // human 模式:每行一个操作的紧凑摘要。用 writeln! 避免 BrokenPipe panic。
        let mut out = std::io::stdout();
        let _ = writeln!(
            out,
            "Contract v{} (schema v{}) — {} operations:",
            m.contract_version,
            m.schema_version,
            m.operations.len()
        );
        for op in &m.operations {
            let _ = writeln!(
                out,
                "  {:<32} [{:?}]  {}",
                op.operation_id, op.side_effect, op.cli
            );
        }
        let _ = writeln!(out);
        let _ = writeln!(out, "Run `lmt --json manifest` for the machine-readable form.");
    })
}
