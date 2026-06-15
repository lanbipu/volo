//! 退出码表(见 `cli_spec`)。Agent 调用 CLI 时按这套退出码分类失败。
//!
//! 设计:
//! - 0 = success
//! - 1 = 未分类失败,保留给意外 panic 或上游未映射的错误
//! - 2+ = 分类失败,每类一个稳定数字
//!
//! 与 [`crate::envelope::error_codes`] 字符串码一一对应。新增 code 时同步
//! 这里、`From<LmtError> for ApiError`、AGENTS.md 三处。

pub const OK: i32 = 0;
pub const UNKNOWN: i32 = 1;
pub const INVALID_INPUT: i32 = 2;
pub const NOT_FOUND: i32 = 3;
pub const IO: i32 = 4;
pub const DB: i32 = 5;
pub const SERIALIZATION: i32 = 6;
pub const UNSUPPORTED: i32 = 7;
pub const CANCELLED: i32 = 8;
pub const TIMEOUT: i32 = 9;
pub const CONFLICT: i32 = 10;
pub const INTERNAL: i32 = 11;
pub const SURFACE_FIT_FAILED: i32 = 12;
pub const DETECTION_FAILED: i32 = 13;
pub const BA_DIVERGED: i32 = 14;
pub const PROCRUSTES_FAILED: i32 = 15;
pub const INTRINSICS_INVALID: i32 = 16;
pub const OBSERVABILITY_FAILED: i32 = 17;
pub const DECODE_FAILED: i32 = 18;

/// 把 [`crate::envelope::ApiError`] 的 string code 转成退出码;未知 code
/// 一律 [`UNKNOWN`],方便老 CLI / 老 agent 在新版本里至少能识别"出错了"。
pub fn from_api_error_code(code: &str) -> i32 {
    use crate::envelope::error_codes as ec;
    match code {
        c if c == ec::INVALID_INPUT => INVALID_INPUT,
        c if c == ec::NOT_FOUND => NOT_FOUND,
        c if c == ec::IO => IO,
        c if c == ec::DB => DB,
        c if c == ec::SERIALIZATION => SERIALIZATION,
        c if c == ec::UNSUPPORTED => UNSUPPORTED,
        c if c == ec::CANCELLED => CANCELLED,
        c if c == ec::TIMEOUT => TIMEOUT,
        c if c == ec::CONFLICT => CONFLICT,
        c if c == ec::SURFACE_FIT_FAILED => SURFACE_FIT_FAILED,
        c if c == ec::DETECTION_FAILED => DETECTION_FAILED,
        c if c == ec::BA_DIVERGED => BA_DIVERGED,
        c if c == ec::PROCRUSTES_FAILED => PROCRUSTES_FAILED,
        c if c == ec::INTRINSICS_INVALID => INTRINSICS_INVALID,
        c if c == ec::OBSERVABILITY_FAILED => OBSERVABILITY_FAILED,
        c if c == ec::DECODE_FAILED => DECODE_FAILED,
        c if c == ec::INTERNAL => INTERNAL,
        _ => UNKNOWN,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::envelope::error_codes as ec;

    #[test]
    fn each_known_error_code_maps_to_distinct_exit_code() {
        let pairs = [
            (ec::INVALID_INPUT, INVALID_INPUT),
            (ec::NOT_FOUND, NOT_FOUND),
            (ec::IO, IO),
            (ec::DB, DB),
            (ec::SERIALIZATION, SERIALIZATION),
            (ec::UNSUPPORTED, UNSUPPORTED),
            (ec::CANCELLED, CANCELLED),
            (ec::TIMEOUT, TIMEOUT),
            (ec::CONFLICT, CONFLICT),
            (ec::INTERNAL, INTERNAL),
            (ec::SURFACE_FIT_FAILED, SURFACE_FIT_FAILED),
            (ec::DETECTION_FAILED, DETECTION_FAILED),
            (ec::BA_DIVERGED, BA_DIVERGED),
            (ec::PROCRUSTES_FAILED, PROCRUSTES_FAILED),
            (ec::INTRINSICS_INVALID, INTRINSICS_INVALID),
            (ec::OBSERVABILITY_FAILED, OBSERVABILITY_FAILED),
            (ec::DECODE_FAILED, DECODE_FAILED),
        ];
        // 顺带反推 distinct,防止哪天有人复制粘贴写错把两个 code 映射到同一个数字。
        let mut seen = std::collections::HashSet::new();
        for (code, exit) in pairs {
            assert_eq!(from_api_error_code(code), exit, "code={code}");
            assert!(seen.insert(exit), "exit code {exit} duplicated for {code}");
        }
    }

    #[test]
    fn unknown_code_falls_back_to_unknown() {
        assert_eq!(from_api_error_code("totally_made_up"), UNKNOWN);
        assert_eq!(from_api_error_code(""), UNKNOWN);
    }
}
