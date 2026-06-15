use schemars::JsonSchema;
use serde::Serialize;

/// Feature-neutral base error for the volo workspace (review #17: renamed from
/// `LmtError`, since this is the shared base used across the mesh feature + DTO
/// layer, not lmt-specific). The wire shape is the contract: `{ "kind":
/// "<snake_case_variant>", "message": "…" }`, where `kind` matches the
/// `error_codes::*` strings — so the *type* rename is invisible on the wire. The
/// `schema` command still registers this under the key "LmtError" for client
/// compatibility (see `schema.rs`).
#[derive(Debug, thiserror::Error, Serialize, JsonSchema)]
#[serde(tag = "kind", content = "message", rename_all = "snake_case")]
#[schemars(rename_all = "snake_case")]
pub enum VoloError {
    #[error("io: {0}")]
    Io(String),
    #[error("yaml: {0}")]
    Yaml(String),
    #[error("core: {0}")]
    Core(String),
    #[error("db: {0}")]
    Db(String),
    #[error("not_found: {0}")]
    NotFound(String),
    #[error("invalid_input: {0}")]
    InvalidInput(String),
    #[error("surface_fit_failed: {0}")]
    SurfaceFitFailed(String),
    #[error("detection_failed: {0}")]
    DetectionFailed(String),
    #[error("ba_diverged: {0}")]
    BaDiverged(String),
    #[error("procrustes_failed: {0}")]
    ProcrustesFailed(String),
    #[error("intrinsics_invalid: {0}")]
    IntrinsicsInvalid(String),
    #[error("observability_failed: {0}")]
    ObservabilityFailed(String),
    #[error("decode_failed: {0}")]
    DecodeFailed(String),
    #[error("{0}")]
    Other(String),
}

pub type VoloResult<T> = Result<T, VoloError>;

impl From<std::io::Error> for VoloError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e.to_string())
    }
}

impl From<serde_yaml::Error> for VoloError {
    fn from(e: serde_yaml::Error) -> Self {
        Self::Yaml(e.to_string())
    }
}

impl From<serde_json::Error> for VoloError {
    fn from(e: serde_json::Error) -> Self {
        Self::Yaml(format!("json: {e}"))
    }
}

impl From<rusqlite::Error> for VoloError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Db(e.to_string())
    }
}

impl From<mesh_core::CoreError> for VoloError {
    fn from(e: mesh_core::CoreError) -> Self {
        Self::Core(e.to_string())
    }
}

impl From<mesh_adapter_total_station::AdapterError> for VoloError {
    fn from(e: mesh_adapter_total_station::AdapterError) -> Self {
        use mesh_adapter_total_station::AdapterError as A;
        match e {
            A::InvalidInput(s) => Self::InvalidInput(s),
            A::Csv(err) => Self::InvalidInput(format!("csv: {err}")),
            A::Yaml(err) => Self::Yaml(err.to_string()),
            A::Json(err) => Self::Yaml(format!("json: {err}")),
            A::Io(err) => Self::Io(err.to_string()),
            A::Core(err) => Self::Core(err.to_string()),
            other => Self::Other(other.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_with_kind_and_message() {
        let err = VoloError::NotFound("foo".into());
        let s = serde_json::to_string(&err).unwrap();
        assert_eq!(s, r#"{"kind":"not_found","message":"foo"}"#);
    }

    #[test]
    fn io_error_converts() {
        let io = std::io::Error::new(std::io::ErrorKind::NotFound, "x");
        let lmt: VoloError = io.into();
        assert!(matches!(lmt, VoloError::Io(_)));
    }

    #[test]
    fn adapter_invalid_input_maps_to_invalid_input_with_kind() {
        use mesh_adapter_total_station::AdapterError;
        let lmt: VoloError = AdapterError::InvalidInput("bad row".into()).into();
        assert!(matches!(lmt, VoloError::InvalidInput(_)));
        let json = serde_json::to_string(&lmt).unwrap();
        assert!(json.contains(r#""kind":"invalid_input""#), "got: {json}");
        assert!(json.contains("bad row"), "got: {json}");
    }

    #[test]
    fn adapter_io_maps_to_io_with_kind() {
        use mesh_adapter_total_station::AdapterError;
        let io = std::io::Error::new(std::io::ErrorKind::NotFound, "missing.csv");
        let lmt: VoloError = AdapterError::Io(io).into();
        assert!(matches!(lmt, VoloError::Io(_)));
        let json = serde_json::to_string(&lmt).unwrap();
        assert!(json.contains(r#""kind":"io""#), "got: {json}");
    }

    #[test]
    fn surface_fit_failed_serializes_with_kind() {
        let err = VoloError::SurfaceFitFailed("inlier ratio too low".into());
        let s = serde_json::to_string(&err).unwrap();
        assert_eq!(s, r#"{"kind":"surface_fit_failed","message":"inlier ratio too low"}"#);
    }

    #[test]
    fn visual_variants_serialize_with_snake_case_kind() {
        // The snake_case `kind` is the error-code contract: it must match the
        // `error_codes::*` strings the envelope maps to (Task 1.6/1.8).
        let cases = [
            (VoloError::DetectionFailed("x".into()), "detection_failed"),
            (VoloError::BaDiverged("x".into()), "ba_diverged"),
            (VoloError::ProcrustesFailed("x".into()), "procrustes_failed"),
            (VoloError::IntrinsicsInvalid("x".into()), "intrinsics_invalid"),
            (
                VoloError::ObservabilityFailed("x".into()),
                "observability_failed",
            ),
            (VoloError::DecodeFailed("x".into()), "decode_failed"),
        ];
        for (err, kind) in cases {
            let s = serde_json::to_string(&err).unwrap();
            assert_eq!(s, format!(r#"{{"kind":"{kind}","message":"x"}}"#));
        }
    }
}
