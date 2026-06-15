//! 把 volo-shared 公开类型的 JSON Schema 一次性 dump 出来,供 CLI 的
//! `schema` 子命令 / 日后 HTTP API 的 `/schema` / MCP wrapper 注册时用。
//!
//! 输出结构:
//!
//! ```json
//! {
//!   "schema_version": "1",
//!   "types": {
//!     "RecentProject": { ... JsonSchema ... },
//!     "ProjectConfig": { ... },
//!     ...
//!   },
//!   "incomplete": ["ReconstructionResult", "ReconstructionReport"],
//!   "incomplete_reason": "..."
//! }
//! ```
//!
//! `incomplete` 列表里的类型嵌入了 mesh-core domain 类型;为保持 core
//! transport-free,本轮没有给 core 类型派生 `JsonSchema`。这些类型仍可
//! 通过 `serde_json::to_value` 序列化,只是 schema 暂时空缺。后续如果
//! Agent / MCP 真的需要它们的 schema,再决定:
//! - A. 给 mesh-core 加 schemars(可选 feature),最干净;
//! - B. 在 volo-shared 写 hand-rolled schema(快但易漂移)。

use crate::{dto, envelope, error, manifest};
use schemars::schema_for;
use serde_json::{json, Map, Value};

/// Dump 所有可派生类型的 JSON Schema。
pub fn dump_all() -> Value {
    let mut types: Map<String, Value> = Map::new();

    macro_rules! add {
        ($name:literal, $t:ty) => {
            types.insert(
                $name.to_string(),
                serde_json::to_value(schema_for!($t))
                    .expect("JsonSchema serialization is infallible for derived types"),
            );
        };
    }

    // DTO
    add!("ScatterFitInfo", dto::ScatterFitInfo);
    add!("ScatterShapeInfo", dto::ScatterShapeInfo);
    add!("ScatterOutlierInfo", dto::ScatterOutlierInfo);
    add!("FrameDerivationInfo", dto::FrameDerivationInfo);
    add!("BoundaryCheckInfo", dto::BoundaryCheckInfo);
    add!("SamplingModeInfo", dto::SamplingModeInfo);
    add!("RecentProject", dto::RecentProject);
    add!("ProjectConfig", dto::ProjectConfig);
    add!("ProjectMeta", dto::ProjectMeta);
    add!("SurveyMethod", dto::SurveyMethod);
    add!("ScreenConfig", dto::ScreenConfig);
    add!("ShapePriorConfig", dto::ShapePriorConfig);
    add!("ShapeMode", dto::ShapeMode);
    add!("BottomCompletionConfig", dto::BottomCompletionConfig);
    add!("CoordinateSystemConfig", dto::CoordinateSystemConfig);
    add!("OutputConfig", dto::OutputConfig);
    add!("ReconstructionRun", dto::ReconstructionRun);
    add!("TotalStationImportResult", dto::TotalStationImportResult);
    add!("InstructionCardResult", dto::InstructionCardResult);

    // Visual reconstruction (camera-branch)
    add!("WarningDto", dto::WarningDto);
    add!("CabinetPoseSummary", dto::CabinetPoseSummary);
    add!("VisualReconstructResult", dto::VisualReconstructResult);
    add!("SimulateResult", dto::SimulateResult);
    add!("EvalResult", dto::EvalResult);
    add!("CompareKnownResult", dto::CompareKnownResult);
    add!("CabinetSizeCheck", dto::CabinetSizeCheck);
    add!("PairCheck", dto::PairCheck);
    add!("CalibrateResult", dto::CalibrateResult);
    add!("GeneratePatternResult", dto::GeneratePatternResult);
    add!("GenerateStructuredLightResult", dto::GenerateStructuredLightResult);
    add!("DecodeStructuredLightResult", dto::DecodeStructuredLightResult);
    add!("CabinetPoseReportFile", dto::CabinetPoseReportFile);
    add!("PoseReportFrame", dto::PoseReportFrame);
    add!("PoseReportGauge", dto::PoseReportGauge);
    add!("CabinetPoseEntry", dto::CabinetPoseEntry);
    add!("ExportPoseObjResult", dto::ExportPoseObjResult);
    add!("ScreenMappingFile", dto::ScreenMappingFile);
    add!("ScreenMappingCabinetRect", dto::ScreenMappingCabinetRect);

    // Capture guidance planner
    add!("CapturePlan", dto::CapturePlan);
    add!("CaptureStation", dto::CaptureStation);
    add!("CabinetCoverage", dto::CabinetCoverage);
    add!("UnreachableRegion", dto::UnreachableRegion);
    add!("CaptureCardResult", dto::CaptureCardResult);

    // 错误模型
    add!("LmtError", error::LmtError);
    add!("ApiError", envelope::ApiError);

    // Envelope:Envelope<T> 是泛型,这里以 `Envelope<serde_json::Value>` 形态
    // dump 一份"任意 data"的骨架,客户端配合 types map 里的具体 type schema
    // 推断 data 字段。
    add!("Envelope", envelope::Envelope<serde_json::Value>);
    add!("ErrorEnvelope", envelope::ErrorEnvelope);

    // Contract Manifest
    add!("ContractManifest", manifest::ContractManifest);
    add!("Operation", manifest::Operation);

    json!({
        "schema_version": envelope::SCHEMA_VERSION,
        "types": types,
        "incomplete": ["ReconstructionResult", "ReconstructionReport"],
        "incomplete_reason":
            "these types embed mesh-core domain types (ReconstructedSurface, \
             QualityMetrics, CabinetArray); schemars derive deferred to keep \
             crates/core transport-free per project scope",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dump_contains_known_types_and_incomplete_list() {
        let v = dump_all();
        assert_eq!(v["schema_version"], "1");

        let types = v["types"].as_object().expect("types should be an object");
        for expected in [
            "RecentProject",
            "ProjectConfig",
            "TotalStationImportResult",
            "InstructionCardResult",
            "ReconstructionRun",
            "LmtError",
            "ApiError",
            "Envelope",
            "ErrorEnvelope",
            "ContractManifest",
            "Operation",
            "VisualReconstructResult",
            "EvalResult",
            "CompareKnownResult",
            "CabinetPoseReportFile",
            "CabinetPoseEntry",
            "ExportPoseObjResult",
            "CapturePlan",
        ] {
            assert!(types.contains_key(expected), "missing schema for {expected}");
        }

        let incomplete = v["incomplete"].as_array().unwrap();
        let names: Vec<&str> = incomplete.iter().map(|x| x.as_str().unwrap()).collect();
        // 这两个嵌入了 core 类型,故意没派生 — 文档化在输出里,而不是悄悄漏。
        assert!(names.contains(&"ReconstructionResult"));
        assert!(names.contains(&"ReconstructionReport"));
    }

    #[test]
    fn visual_reconstruct_result_schema_has_rejection_fields() {
        let v = dump_all();
        let props = v["types"]["VisualReconstructResult"]["properties"]
            .as_object()
            .unwrap();
        assert!(props.contains_key("ba_observations_total"));
        assert!(props.contains_key("ba_observations_used"));
        assert!(props.contains_key("ba_rejected"));
    }

    #[test]
    fn visual_reconstruct_result_schema_has_intrinsics_source() {
        let v = dump_all();
        let props = v["types"]["VisualReconstructResult"]["properties"]
            .as_object()
            .unwrap();
        assert!(props.contains_key("intrinsics_source"));
        assert!(props.contains_key("warnings"));
    }

    #[test]
    fn calibrate_result_schema_has_distortion_fields() {
        let v = dump_all();
        let props = v["types"]["CalibrateResult"]["properties"]
            .as_object()
            .unwrap();
        assert!(props.contains_key("distortion_model"));
        assert!(props.contains_key("focal_stddev_px"));
        assert!(props.contains_key("pp_stddev_px"));
    }

    #[test]
    fn lmt_error_schema_carries_kind_tag() {
        // 校验 schemars 正确尊重了 LmtError 上的 `#[serde(tag = "kind", content = "message")]`,
        // 这样客户端按 schema 解析时 discriminator 与运行时输出一致。
        let v = dump_all();
        let s = serde_json::to_string(&v["types"]["LmtError"]).unwrap();
        assert!(s.contains("kind"), "LmtError schema should mention 'kind'");
        assert!(
            s.contains("invalid_input") || s.contains("not_found"),
            "LmtError schema should enumerate snake_case variant names: {s}"
        );
    }
}
