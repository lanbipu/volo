//! DDC 留存策略：把"缓存永不过期 / 恢复默认"的写操作集中到服务层，
//! 让 CLI (`ini gc-pause|gc-resume|zen-gc-*`) 与 Tauri 命令都做薄翻译。
//!
//! 两条留存通道（字段名以 UE 源码为准，已实测）：
//!   * **FileSystem DDC** —— `[DerivedDataBackendGraph]` 的 `Shared` 节点。GC 真正的
//!     总开关是 `DeleteUnused`（UE 默认 `true`，且 `= !ReadOnly`）。"永不过期" =
//!     `DeleteUnused=false`（停 GC），比设一个巨大的 `UnusedFileAge` 更干净，也绕开
//!     `UnusedFileAge ∈ [1,365]` 那条 R016 范围规则。`UnusedFileAge` 的引擎默认是
//!     15 天（`FileSystemCacheStore.cpp` 注释），`BaseEngine.ini` 里 `Shared` 出厂为 10。
//!   * **Zen Server** —— `[Zen.AutoLaunch]` 的 `ExtraArgs` 命令行串里的
//!     `--gc-cache-duration-seconds`（`BaseEngine.ini` 默认 1209600 秒 = 14 天）。Zen 没有
//!     `DeleteUnused` 等价物，"永不过期"只能把这个秒数设得极大。
//!
//! 注意：UE 配置有继承层级（BaseEngine → DefaultEngine → 用户层）。本模块只写
//! **项目 `DefaultEngine.ini`**（最常见的覆盖点）；探测侧（R027/R028）同样只看显式声明，
//! 不做全层级合并——纯继承引擎默认值的情况是已知盲区（见 ini_diagnostics 规则注释）。

use crate::core::ini_editor;
use crate::data::{machines as data_machines, project_locations, Db};
use crate::error::{UecmError, UecmResult};

/// `[Zen.AutoLaunch]` `ExtraArgs` 里控制 Zen GC 留存窗口的 flag。
pub const GC_DURATION_FLAG: &str = "--gc-cache-duration-seconds";
/// UE `BaseEngine.ini` `[Zen.AutoLaunch]` 出厂的 GC 留存窗口：14 天。
pub const ZEN_DEFAULT_GC_SECONDS: u64 = 1_209_600;
/// ≤ 30 天的 Zen 留存窗口视为"默认/过短"，触发提醒。
pub const ZEN_REMINDER_MAX_SECONDS: u64 = 2_592_000;
/// "永不过期"用的 Zen 留存窗口：约 100 年。
pub const ZEN_NEVER_EXPIRE_SECONDS: u64 = 3_153_600_000;
/// FileSystem `Shared` 的 `UnusedFileAge` ≤ 30 天（或缺失）视为"默认/过短"。
pub const FS_REMINDER_MAX_DAYS: i64 = 30;
/// `gc-resume` 恢复 GC 时写回的 `UnusedFileAge` 默认值（与 CLI 默认、BaseEngine Shared 一致）。
pub const FS_DEFAULT_RESUME_DAYS: u32 = 10;

const BACKEND_GRAPH_SECTION: &str = "DerivedDataBackendGraph";
const SHARED_NODE: &str = "Shared";
const ZEN_AUTOLAUNCH_SECTION: &str = "Zen.AutoLaunch";
const EXTRA_ARGS_KEY: &str = "ExtraArgs";

/// 解析 host(ip) + project_id → 该机器上项目的 `DefaultEngine.ini` 绝对路径。
fn project_default_engine_ini(db: &Db, project_id: i64, host: &str) -> UecmResult<String> {
    let machine = data_machines::find_by_ip(db, host)?.ok_or_else(|| {
        UecmError::InvalidInput(format!("machine {} not in inventory", host))
    })?;
    let machine_id = machine
        .id
        .ok_or_else(|| UecmError::InvalidInput("machine has no id".into()))?;
    let location = project_locations::get_for_project_machine(db, project_id, machine_id)?
        .ok_or_else(|| {
            UecmError::InvalidInput(format!("project {} not located on {}", project_id, host))
        })?;
    Ok(format!(
        "{}\\Config\\DefaultEngine.ini",
        location.abs_path.trim_end_matches('\\')
    ))
}

/// 停 FileSystem Shared DDC 的 GC（`DeleteUnused=false`）—— 项目期内缓存常驻。
pub fn pause_gc(db: &Db, project_id: i64, host: &str) -> UecmResult<String> {
    let ini = project_default_engine_ini(db, project_id, host)?;
    ini_editor::set_backend_field(
        host, &ini, BACKEND_GRAPH_SECTION, SHARED_NODE, "DeleteUnused", "false",
    )
}

/// 恢复 FileSystem Shared DDC 的 GC（`DeleteUnused=true` + 回填 `UnusedFileAge`）。
pub fn resume_gc(
    db: &Db,
    project_id: i64,
    host: &str,
    unused_file_age: u32,
) -> UecmResult<String> {
    let ini = project_default_engine_ini(db, project_id, host)?;
    ini_editor::set_backend_field(
        host, &ini, BACKEND_GRAPH_SECTION, SHARED_NODE, "DeleteUnused", "true",
    )?;
    ini_editor::set_backend_field(
        host, &ini, BACKEND_GRAPH_SECTION, SHARED_NODE, "UnusedFileAge",
        &unused_file_age.to_string(),
    )
}

/// 设置 Zen Server 的 GC 留存窗口（`[Zen.AutoLaunch] ExtraArgs` 内的
/// `--gc-cache-duration-seconds`）。传 [`ZEN_NEVER_EXPIRE_SECONDS`] 即"永不过期"。
pub fn set_zen_gc_duration(
    db: &Db,
    project_id: i64,
    host: &str,
    seconds: u64,
) -> UecmResult<String> {
    let ini = project_default_engine_ini(db, project_id, host)?;
    let current = ini_editor::read_section(host, &ini, ZEN_AUTOLAUNCH_SECTION)?
        .into_iter()
        .find(|k| k.name.eq_ignore_ascii_case(EXTRA_ARGS_KEY))
        .map(|k| k.value)
        .unwrap_or_default();
    let updated = upsert_extra_args_flag(&current, GC_DURATION_FLAG, &seconds.to_string());
    ini_editor::set_key(host, &ini, ZEN_AUTOLAUNCH_SECTION, EXTRA_ARGS_KEY, &updated)
}

/// 在 `ExtraArgs` 命令行串里把 `flag <value>` 改写为新值；flag 不存在则追加到末尾。
/// 纯函数：只做 token 级替换，不感知具体 flag 语义。
pub fn upsert_extra_args_flag(extra_args: &str, flag: &str, value: &str) -> String {
    let tokens: Vec<&str> = extra_args.split_whitespace().collect();
    let mut out: Vec<String> = Vec::with_capacity(tokens.len() + 2);
    let mut i = 0;
    let mut replaced = false;
    while i < tokens.len() {
        if tokens[i] == flag {
            out.push(flag.to_string());
            out.push(value.to_string());
            replaced = true;
            // 跳过旧值 token（紧跟其后、且不是另一个 flag 的那个）。
            if i + 1 < tokens.len() && !tokens[i + 1].starts_with("--") {
                i += 2;
            } else {
                i += 1;
            }
        } else {
            out.push(tokens[i].to_string());
            i += 1;
        }
    }
    if !replaced {
        out.push(flag.to_string());
        out.push(value.to_string());
    }
    out.join(" ")
}

/// 从 `ExtraArgs` 串里读出 `--gc-cache-duration-seconds` 的秒数（缺失返回 `None`）。
pub fn parse_gc_cache_duration_seconds(extra_args: &str) -> Option<u64> {
    let tokens: Vec<&str> = extra_args.split_whitespace().collect();
    tokens
        .windows(2)
        .find(|w| w[0] == GC_DURATION_FLAG)
        .and_then(|w| w[1].parse::<u64>().ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upsert_replaces_existing_flag_value() {
        let s = "--http asio --gc-cache-duration-seconds 1209600 --quiet";
        let got = upsert_extra_args_flag(s, GC_DURATION_FLAG, "3153600000");
        assert_eq!(got, "--http asio --gc-cache-duration-seconds 3153600000 --quiet");
    }

    #[test]
    fn upsert_appends_when_flag_absent() {
        let s = "--http asio --quiet";
        let got = upsert_extra_args_flag(s, GC_DURATION_FLAG, "3153600000");
        assert_eq!(got, "--http asio --quiet --gc-cache-duration-seconds 3153600000");
    }

    #[test]
    fn upsert_into_empty_string() {
        let got = upsert_extra_args_flag("", GC_DURATION_FLAG, "42");
        assert_eq!(got, "--gc-cache-duration-seconds 42");
    }

    #[test]
    fn upsert_flag_last_without_value() {
        let s = "--quiet --gc-cache-duration-seconds";
        let got = upsert_extra_args_flag(s, GC_DURATION_FLAG, "42");
        assert_eq!(got, "--quiet --gc-cache-duration-seconds 42");
    }

    #[test]
    fn parse_reads_value() {
        assert_eq!(
            parse_gc_cache_duration_seconds("--http asio --gc-cache-duration-seconds 1209600 --quiet"),
            Some(1_209_600)
        );
        assert_eq!(parse_gc_cache_duration_seconds("--http asio --quiet"), None);
    }
}
