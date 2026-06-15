//! Stable JSON envelope shared by CLI 与日后的 HTTP API。
//!
//! 见 `cli_spec` / `api_spec` 的 JSON 约定:
//! - 成功:`{ "ok": true, "data": ..., "meta": { "schema_version": "1" } }`
//! - 失败:`{ "ok": false, "error": { "code": ..., "message": ..., "details"? } }`
//!
//! `ok` 字段被显式建模成数据成员(而不是用 serde tag),让客户端解析
//! 时无需 sniff 字段差异——一次 `serde_json::from_str::<Envelope<T>>` 或
//! `from_str::<ErrorEnvelope>` 即可。

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// 当前 envelope schema 版本。任何不兼容的字段变更都要 bump 这个常量
/// 并在 AGENTS.md 写好升级路径。
pub const SCHEMA_VERSION: &str = "1";

/// 成功响应。`ok` 永远为 true,但仍序列化出去,与 [`ErrorEnvelope`] 形成
/// 对偶 discriminator。
/// 注意:struct 定义本身**不写** `T: JsonSchema` bound——这样 CLI 可以
/// 包装那些故意没派生 JsonSchema 的 DTO(e.g. `ReconstructionReport`,
/// 它嵌入了 mesh-core 域类型,见 `schema::dump_all` 的 `incomplete` 列表)。
/// `derive(JsonSchema)` 展开后只会在 `impl JsonSchema for Envelope<T>` 上
/// 自带 `where T: JsonSchema` bound,影响的是 schema 生成而非 runtime 包装。
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Envelope<T> {
    pub ok: bool,
    pub data: T,
    pub meta: Meta,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Meta {
    pub schema_version: String,
}

impl<T> Envelope<T> {
    pub fn ok(data: T) -> Self {
        Self {
            ok: true,
            data,
            meta: Meta {
                schema_version: SCHEMA_VERSION.into(),
            },
        }
    }
}

/// 失败响应。
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ErrorEnvelope {
    pub ok: bool,
    pub error: ApiError,
}

impl ErrorEnvelope {
    pub fn from_error(error: ApiError) -> Self {
        Self { ok: false, error }
    }
}

/// 机器可读错误。
///
/// - `code` 是稳定的 snake_case 枚举字符串(见 [`error_codes`]),供客户端
///   按 code 分支处理。
/// - `message` 给人看的,可以包含具体路径 / 数值;不要在 message 里塞结构化
///   payload——那种东西放到 `details`。
/// - `details` 选填、自由 JSON,用于结构化补充(e.g. 多 outlier 的列表)。
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ApiError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

impl ApiError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: None,
        }
    }

    pub fn with_details(mut self, details: serde_json::Value) -> Self {
        self.details = Some(details);
        self
    }
}

/// 稳定的错误码常量。CLI / HTTP / MCP wrapper 共用同一份字符串。
///
/// 新增 code 时,记得同步 [`crate::exit_codes`] 的退出码映射与 AGENTS.md
/// 的错误码表。
pub mod error_codes {
    /// 输入 / 参数 / 配置错误——用户能改。
    pub const INVALID_INPUT: &str = "invalid_input";
    /// 资源 / 实体不存在。
    pub const NOT_FOUND: &str = "not_found";
    /// 文件系统 / IO 错误。
    pub const IO: &str = "io";
    /// SQLite 错误。
    pub const DB: &str = "db";
    /// YAML / JSON 序列化或反序列化错误。
    pub const SERIALIZATION: &str = "serialization";
    /// 工具暂不支持该操作(e.g. CLI 不支持 PDF 渲染)。
    pub const UNSUPPORTED: &str = "unsupported";
    /// 长任务被调用方取消。
    pub const CANCELLED: &str = "cancelled";
    /// 长任务超时。
    pub const TIMEOUT: &str = "timeout";
    /// 写冲突(e.g. 别的 screen 的 measured.yaml 已经在那里)。
    pub const CONFLICT: &str = "conflict";
    /// 未分类内部错误——后台 bug,记 log。
    pub const INTERNAL: &str = "internal";
    /// 散点曲面拟合失败(数据不成形 / inlier 太少 / 边界 reject)——与 invalid_input 区分。
    pub const SURFACE_FIT_FAILED: &str = "surface_fit_failed";
    /// ChArUco / structured-light corner detection produced too few usable corners.
    pub const DETECTION_FAILED: &str = "detection_failed";
    /// Bundle adjustment failed to converge.
    pub const BA_DIVERGED: &str = "ba_diverged";
    /// Rigid alignment (procrustes) degenerate / failed.
    pub const PROCRUSTES_FAILED: &str = "procrustes_failed";
    /// Camera intrinsics invalid (calibration RMS / coverage gate failed).
    pub const INTRINSICS_INVALID: &str = "intrinsics_invalid";
    /// Observation graph not connected / per-cabinet coverage insufficient.
    pub const OBSERVABILITY_FAILED: &str = "observability_failed";
    /// Structured-light Gray-code decode failed.
    pub const DECODE_FAILED: &str = "decode_failed";
}

impl From<crate::error::VoloError> for ApiError {
    fn from(e: crate::error::VoloError) -> Self {
        use crate::error::VoloError as E;
        let (code, message) = match &e {
            E::Io(m) => (error_codes::IO, m.clone()),
            E::Yaml(m) => (error_codes::SERIALIZATION, m.clone()),
            E::Core(m) => (error_codes::INVALID_INPUT, m.clone()),
            E::Db(m) => (error_codes::DB, m.clone()),
            E::NotFound(m) => (error_codes::NOT_FOUND, m.clone()),
            E::InvalidInput(m) => (error_codes::INVALID_INPUT, m.clone()),
            E::SurfaceFitFailed(m) => (error_codes::SURFACE_FIT_FAILED, m.clone()),
            E::DetectionFailed(m) => (error_codes::DETECTION_FAILED, m.clone()),
            E::BaDiverged(m) => (error_codes::BA_DIVERGED, m.clone()),
            E::ProcrustesFailed(m) => (error_codes::PROCRUSTES_FAILED, m.clone()),
            E::IntrinsicsInvalid(m) => (error_codes::INTRINSICS_INVALID, m.clone()),
            E::ObservabilityFailed(m) => (error_codes::OBSERVABILITY_FAILED, m.clone()),
            E::DecodeFailed(m) => (error_codes::DECODE_FAILED, m.clone()),
            E::Other(m) => (error_codes::INTERNAL, m.clone()),
        };
        ApiError::new(code, message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn envelope_ok_serializes_with_schema_version() {
        let env = Envelope::ok(serde_json::json!({"foo": 1}));
        let v = serde_json::to_value(&env).unwrap();
        assert_eq!(v["ok"], true);
        assert_eq!(v["data"]["foo"], 1);
        assert_eq!(v["meta"]["schema_version"], "1");
    }

    #[test]
    fn error_envelope_serializes_ok_false() {
        let err = ApiError::new(error_codes::INVALID_INPUT, "bad input");
        let env = ErrorEnvelope::from_error(err);
        let v = serde_json::to_value(&env).unwrap();
        assert_eq!(v["ok"], false);
        assert_eq!(v["error"]["code"], "invalid_input");
        assert_eq!(v["error"]["message"], "bad input");
        // details 缺省时应当不出现,避免客户端 schema 误以为是 null vs absent。
        assert!(
            !v["error"].as_object().unwrap().contains_key("details"),
            "details should be omitted when None: {v}"
        );
    }

    #[test]
    fn api_error_with_details_keeps_structured_payload() {
        let err = ApiError::new(error_codes::CONFLICT, "screen mismatch")
            .with_details(json!({"existing": "FLOOR", "incoming": "MAIN"}));
        let v = serde_json::to_value(&err).unwrap();
        assert_eq!(v["details"]["existing"], "FLOOR");
        assert_eq!(v["details"]["incoming"], "MAIN");
    }

    #[test]
    fn envelope_wraps_non_jsonschema_type() {
        // 防止有人再次在 struct/impl 上加 `T: JsonSchema` bound —— 那会让
        // CLI 在包装 `ReconstructionReport` / `ReconstructionResult`(故意
        // 没派生 schema 的 DTO)时直接编译失败。
        #[allow(dead_code)]
        struct NoSchema(i32);
        let _ = Envelope::ok(NoSchema(42));
    }

    #[test]
    fn lmt_error_maps_each_variant_to_expected_code() {
        use crate::error::VoloError;
        let cases: Vec<(VoloError, &str)> = vec![
            (VoloError::Io("x".into()), error_codes::IO),
            (VoloError::Yaml("x".into()), error_codes::SERIALIZATION),
            (VoloError::Core("x".into()), error_codes::INVALID_INPUT),
            (VoloError::Db("x".into()), error_codes::DB),
            (VoloError::NotFound("x".into()), error_codes::NOT_FOUND),
            (
                VoloError::InvalidInput("x".into()),
                error_codes::INVALID_INPUT,
            ),
            (
                VoloError::SurfaceFitFailed("x".into()),
                error_codes::SURFACE_FIT_FAILED,
            ),
            (
                VoloError::DetectionFailed("x".into()),
                error_codes::DETECTION_FAILED,
            ),
            (VoloError::BaDiverged("x".into()), error_codes::BA_DIVERGED),
            (
                VoloError::ProcrustesFailed("x".into()),
                error_codes::PROCRUSTES_FAILED,
            ),
            (
                VoloError::IntrinsicsInvalid("x".into()),
                error_codes::INTRINSICS_INVALID,
            ),
            (
                VoloError::ObservabilityFailed("x".into()),
                error_codes::OBSERVABILITY_FAILED,
            ),
            (
                VoloError::DecodeFailed("x".into()),
                error_codes::DECODE_FAILED,
            ),
            (VoloError::Other("x".into()), error_codes::INTERNAL),
        ];
        for (lmt, expected) in cases {
            let api: ApiError = lmt.into();
            assert_eq!(api.code, expected);
            assert_eq!(api.message, "x");
        }
    }
}
