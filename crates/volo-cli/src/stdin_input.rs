//! Structured stdin reader for `--input-format` (spec §3.3). Currently has no
//! command consumer; provided so future nested-input commands parse stdin via
//! one shared, format-aware path instead of ad-hoc flags.

use crate::args::InputFormat;
use cache_core::error::{VoloError, VoloResult};
use std::io::Read;

/// Parse an in-memory byte buffer per the declared input format into a JSON value.
/// (Separated from stdin I/O so it is unit-testable without a real stdin.)
pub fn parse(buf: &str, fmt: InputFormat) -> VoloResult<serde_json::Value> {
    match fmt {
        InputFormat::Json => serde_json::from_str(buf)
            .map_err(|e| VoloError::InvalidInput(format!("parse json stdin: {}", e))),
        InputFormat::Yaml => serde_yaml::from_str(buf)
            .map_err(|e| VoloError::InvalidInput(format!("parse yaml stdin: {}", e))),
        InputFormat::Ndjson => {
            let mut items = Vec::new();
            for (n, line) in buf.lines().enumerate() {
                if line.trim().is_empty() {
                    continue;
                }
                let v: serde_json::Value = serde_json::from_str(line).map_err(|e| {
                    VoloError::InvalidInput(format!("parse ndjson stdin line {}: {}", n + 1, e))
                })?;
                items.push(v);
            }
            Ok(serde_json::Value::Array(items))
        }
    }
}

/// Read all of stdin and parse it. Thin I/O wrapper over [`parse`].
pub fn read_stdin(fmt: InputFormat) -> VoloResult<serde_json::Value> {
    let mut buf = String::new();
    std::io::stdin()
        .read_to_string(&mut buf)
        .map_err(|e| VoloError::InvalidInput(format!("read stdin: {}", e)))?;
    parse(&buf, fmt)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_json_object() {
        let v = parse(r#"{"a":1}"#, InputFormat::Json).unwrap();
        assert_eq!(v["a"], 1);
    }

    #[test]
    fn parse_yaml_object() {
        let v = parse("a: 1\n", InputFormat::Yaml).unwrap();
        assert_eq!(v["a"], 1);
    }

    #[test]
    fn parse_ndjson_to_array() {
        let v = parse("{\"a\":1}\n{\"a\":2}\n", InputFormat::Ndjson).unwrap();
        assert_eq!(v.as_array().unwrap().len(), 2);
    }

    #[test]
    fn parse_bad_json_is_invalid_input() {
        let err = parse("{not json", InputFormat::Json).unwrap_err();
        assert!(matches!(err, VoloError::InvalidInput(_)));
    }
}
