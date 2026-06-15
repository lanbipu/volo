//! `lmt version` —— 机器可读版本元信息(--version 纯文本出口保留)。
//! side_effect: read_only。

use crate::lmt::output::{self, Mode};
use serde::Serialize;
use std::io::Write;

#[derive(Serialize)]
struct VersionInfo {
    version: String,
    schema_version: String,
    contract_version: String,
}

pub fn run(mode: Mode) -> i32 {
    let info = VersionInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        schema_version: volo_shared::envelope::SCHEMA_VERSION.to_string(),
        contract_version: volo_shared::manifest::build().contract_version,
    };
    output::ok(mode, info, |i| {
        let _ = writeln!(
            std::io::stdout(),
            "lmt {} (schema v{}, contract v{})",
            i.version, i.schema_version, i.contract_version
        );
    })
}
