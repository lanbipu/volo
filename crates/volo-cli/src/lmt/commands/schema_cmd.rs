//! `lmt schema` —— dump lmt-shared 全部公开类型的 JSON Schema。
//!
//! side_effect: read_only;不需要 DB / project / network。

use crate::lmt::output::{self, Mode};
use std::io::Write;

pub fn run(mode: Mode) -> i32 {
    let schemas = volo_shared::schema::dump_all();
    output::ok(mode, schemas, |s| {
        // human 模式:列出类型清单 + 提示如何拿完整 schema。
        // 完整 schema 通过 --json 输出,人读没意义。
        //
        // 用 writeln!() 而非 println!() —— 后者在 BrokenPipe(常见于
        // `lmt schema | head -n1`)时会 panic,绕过了 output::ok 想吞掉
        // stdout 写入失败的约定。
        let mut out = std::io::stdout();
        let types = s["types"].as_object();
        match types {
            Some(map) => {
                let _ = writeln!(
                    out,
                    "Available type schemas (schema_version: {}):",
                    s["schema_version"].as_str().unwrap_or("?")
                );
                let mut names: Vec<&String> = map.keys().collect();
                names.sort();
                for name in names {
                    let _ = writeln!(out, "  - {name}");
                }
                if let Some(incomplete) = s["incomplete"].as_array() {
                    if !incomplete.is_empty() {
                        let _ = writeln!(out);
                        let _ = writeln!(out, "Types without schema (embed lmt-core types):");
                        for x in incomplete {
                            if let Some(name) = x.as_str() {
                                let _ = writeln!(out, "  - {name}");
                            }
                        }
                    }
                }
                let _ = writeln!(out);
                let _ = writeln!(out, "Run `lmt --json schema` for full JsonSchema dump.");
            }
            None => {
                let _ = writeln!(out, "(no types available)");
            }
        }
    })
}
