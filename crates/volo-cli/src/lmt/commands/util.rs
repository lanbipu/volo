//! 子命令共用的工具:DB 解析、destructive 守门、输入文件读取。

use volo_shared::data::{self, Db};
use volo_shared::envelope::{error_codes, ApiError};
use std::io::Read;
use std::path::{Path, PathBuf};

/// 打开并迁移 sqlite DB。
///
/// 路径解析顺序:`cli_db` (`--db`) > [`data::connection::default_db_path`]
/// (OS 标准位置,默认与 Tauri GUI 共用)。父目录会被按需创建。
pub fn open_db(cli_db: Option<&Path>) -> Result<Db, ApiError> {
    let path: PathBuf = match cli_db {
        Some(p) => p.to_path_buf(),
        None => data::connection::default_db_path()
            .map_err(|e| ApiError::new(error_codes::INTERNAL, e.to_string()))?,
    };
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| {
                ApiError::new(error_codes::IO, format!("create db parent dir: {e}"))
            })?;
        }
    }
    let db = data::open(&path).map_err(|e| {
        ApiError::new(error_codes::DB, format!("open db {}: {e}", path.display()))
    })?;
    {
        let mut conn = db.lock().unwrap();
        data::schema::migrate(&mut conn)
            .map_err(|e| ApiError::new(error_codes::DB, format!("migrate: {e}")))?;
    }
    Ok(db)
}

/// 只读打开 DB,**不**创建、不 migrate、不写 WAL——专给 dry-run 校验路径用。
///
/// 返回 `Ok(None)` 表示 DB 文件不存在(对 dry-run 来说不是错误,只是
/// "存在性未知"的信号,caller 把它当 false 处理)。`Ok(Some(_))` 表示
/// 已打开只读连接。
pub fn open_db_readonly(cli_db: Option<&Path>) -> Result<Option<Db>, ApiError> {
    let path: PathBuf = match cli_db {
        Some(p) => p.to_path_buf(),
        None => data::connection::default_db_path()
            .map_err(|e| ApiError::new(error_codes::INTERNAL, e.to_string()))?,
    };
    // 区分三种状态:
    // - 路径完全不存在:返回 None(dry-run 当 "empty DB" 处理,不算错)
    // - 路径存在但不是 regular file(目录 / symlink-broken / socket 等):
    //   报 invalid_input,跟 execute path 一致地让用户改 --db
    // - 路径是 file:走 readonly open
    if !path.exists() {
        return Ok(None);
    }
    if !path.is_file() {
        return Err(ApiError::new(
            error_codes::INVALID_INPUT,
            format!(
                "--db path exists but is not a regular file: {}",
                path.display()
            ),
        ));
    }
    let db = data::open_readonly(&path).map_err(|e| {
        ApiError::new(
            error_codes::DB,
            format!("open db {} readonly: {e}", path.display()),
        )
    })?;
    Ok(Some(db))
}

/// Destructive operation 守门。`--yes` 与 `--dry-run` 至少传一个,否则报
/// `invalid_input` 拒绝执行。
#[derive(Debug, Clone, Copy)]
pub enum DestructiveDecision {
    /// 用户传了 `--yes`:正常执行。
    Execute,
    /// 用户传了 `--dry-run`:跑校验路径但不写盘 / DB。
    DryRun,
}

pub fn gate_destructive(
    yes: bool,
    dry_run: bool,
    action_desc: &str,
) -> Result<DestructiveDecision, ApiError> {
    match (dry_run, yes) {
        (true, _) => Ok(DestructiveDecision::DryRun),
        (false, true) => Ok(DestructiveDecision::Execute),
        (false, false) => Err(ApiError::new(
            error_codes::INVALID_INPUT,
            format!(
                "{action_desc} is destructive; pass --yes to execute or --dry-run to preview"
            ),
        )),
    }
}

/// 把 relative 路径转成 absolute,**不**解析 symlink、**不**要求文件存在。
/// 用 Rust 1.79+ stable 的 [`std::path::absolute`]。
///
/// 给 `export --dst` 这种"未来文件"的 destination 用,保证写进 DB 的字符串
/// 与 cwd 无关。
pub fn absolutize(p: &Path) -> Result<PathBuf, ApiError> {
    std::path::absolute(p).map_err(|e| {
        ApiError::new(
            error_codes::IO,
            format!("absolutize path {}: {e}", p.display()),
        )
    })
}

/// 给已存在的目录 / 文件做 canonicalize(解析 symlink + 去 . / ..)。
/// reconstruct dry-run / list-runs 等需要"和 DB 写入键一致"的路径用之。
pub fn canonicalize_existing(p: &Path) -> Result<PathBuf, ApiError> {
    std::fs::canonicalize(p).map_err(|e| {
        ApiError::new(
            error_codes::IO,
            format!("canonicalize {}: {e}", p.display()),
        )
    })
}

/// 用于持久化到 DB 的路径规范化:存在就 canonicalize(解析 symlink),
/// 不存在就 absolutize(基于 cwd 转绝对)。这样 `recent_projects.abs_path`
/// 永远是 absolute 字符串,跨 cwd 调用看到的是同一条记录。
pub fn normalize_for_db(p: &Path) -> Result<PathBuf, ApiError> {
    if p.exists() {
        canonicalize_existing(p)
    } else {
        absolutize(p)
    }
}

/// 读取 `--input <path>` 或 stdin 的全部字节。供 `project save` 这类
/// 从外部喂 YAML / JSON 的命令使用。
pub fn read_input_bytes(input: Option<&Path>) -> Result<Vec<u8>, ApiError> {
    match input {
        Some(p) => std::fs::read(p)
            .map_err(|e| ApiError::new(error_codes::IO, format!("read {}: {e}", p.display()))),
        None => {
            let mut buf = Vec::new();
            std::io::stdin()
                .read_to_end(&mut buf)
                .map_err(|e| ApiError::new(error_codes::IO, format!("read stdin: {e}")))?;
            Ok(buf)
        }
    }
}
