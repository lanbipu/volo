//! Plan 7 T1.4: HTTP probe of a zen daemon.
//!
//! Hits the three diagnostic endpoints exposed by zen
//! (`/health`, `/health/version`, `/health/info`), extracts flat health
//! metadata from the CB blob returned by `/health/info`, and assembles a
//! [`data::zen_probes::ZenProbe`] record ready to be persisted.
//!
//! Design rules carried over from the plan:
//!
//! - Network / parse failures NEVER propagate as `Err` from [`probe_endpoint`].
//!   We always produce a probe record (reachable=0 if `/health` itself failed)
//!   so the operator can see a continuous time-series even when zen is down.
//!   `Err` is reserved for `persist`'s database failures.
//! - The raw `/health/info` body is stored verbatim in `health_info_cb`
//!   whenever `/health/info` returned 200 — even if our CB parser couldn't
//!   make sense of it. That way offline forensics still has the bytes.
//! - `stats_providers_cb` is owned by Plan 7 T1.5; this module always leaves
//!   it `None`.

use std::time::Duration;

use crate::core::zen::cb_parser::{self, CbValue};
use crate::data;
use crate::error::UecmResult;

/// Result of one round-trip probe. The record is ready to insert as-is.
///
/// `provider_paths_hint` is reserved for T1.5 (which decodes `/stats`).
/// T1.4 always returns `None` here.
#[derive(Debug, Clone)]
pub struct ProbeOutcome {
    pub record: data::zen_probes::ZenProbe,
    pub provider_paths_hint: Option<Vec<String>>,
}

/// Probe a single endpoint and return an assembled (but not yet persisted)
/// probe record. See module docs for error semantics.
///
/// `host` is the resolved hostname or IPv4 address used to construct URLs.
/// Caller (CLI / Tauri layer) is responsible for machine → host resolution.
pub fn probe_endpoint(
    endpoint: &data::zen_endpoints::ZenEndpoint,
    host: &str,
    timeout: Duration,
) -> ProbeOutcome {
    let endpoint_id = endpoint
        .id
        .expect("ZenEndpoint passed to probe_endpoint must have id");
    let base_url = format!("{}://{}:{}", endpoint.scheme, host, endpoint.declared_port);

    // Each call uses a fresh client. The probe runs at most every few seconds
    // per endpoint, and reqwest's blocking client owns a tokio runtime under
    // the hood — sharing one across threads requires locking we don't need.
    let client = match reqwest::blocking::Client::builder()
        .timeout(timeout)
        .connect_timeout(timeout)
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return ProbeOutcome {
                record: unreachable_record(
                    endpoint_id,
                    format!("failed to build http client: {e}"),
                ),
                provider_paths_hint: None,
            };
        }
    };

    // Step 1: /health. zen's heartbeat contract is a fixed-text body "OK!"
    // (see docs/research/zen-launch-mechanism.md §4). A 2xx response alone is
    // not enough to confirm we hit a zenserver — any other HTTP service on
    // the same port could return 200, so we must check the body. Failure
    // here is treated as unreachable and we skip /health/version + /health/info.
    let health_url = format!("{}/health", base_url);
    match get_text_ok(&client, &health_url) {
        Ok(body) if body.trim() == "OK!" => {}
        Ok(body) => {
            // Server is up but does not look like zen — report distinctly.
            let preview: String = body.chars().take(40).collect();
            return ProbeOutcome {
                record: unreachable_record(
                    endpoint_id,
                    format!("GET /health returned 2xx but body is not zen heartbeat \"OK!\" (got {preview:?})"),
                ),
                provider_paths_hint: None,
            };
        }
        Err(reason) => {
            return ProbeOutcome {
                record: unreachable_record(endpoint_id, format!("GET /health failed: {reason}")),
                provider_paths_hint: None,
            };
        }
    }

    // Step 2: /health/version. Plain text body like "5.8.10". Failure is
    // non-fatal — we record the issue in error_message but keep going.
    let version_url = format!("{}/health/version", base_url);
    let (health_version_text, version_err) = match get_text_ok(&client, &version_url) {
        Ok(text) => (Some(text.trim().to_string()), None),
        Err(reason) => (None, Some(format!("GET /health/version failed: {reason}"))),
    };

    // Step 3: /health/info. CB blob. Failure non-fatal; bytes get preserved.
    let info_url = format!("{}/health/info", base_url);
    let (health_info_cb, info_err) = match get_bytes_ok(&client, &info_url) {
        Ok(bytes) => (Some(bytes), None),
        Err(reason) => (None, Some(format!("GET /health/info failed: {reason}"))),
    };

    // Extract flat fields. Parse failure preserves raw bytes but leaves
    // structured columns NULL.
    let mut extracted = ExtractedFields::default();
    let mut parse_err: Option<String> = None;
    if let Some(bytes) = health_info_cb.as_deref() {
        match cb_parser::parse(bytes) {
            Ok((value, _consumed)) => {
                extracted = ExtractedFields::from_cb(&value);
            }
            Err(e) => {
                parse_err = Some(format!("CB parse of /health/info failed: {e}"));
            }
        }
    }

    // Prefer the build version embedded in /health/info; only fall back to
    // the plain-text endpoint when the CB blob didn't carry one.
    let build_version = extracted
        .build_version
        .clone()
        .or_else(|| health_version_text.clone());

    // Stitch together any sub-endpoint / parser errors that fired despite
    // /health succeeding so the operator sees them in one place.
    let error_message = compose_partial_error(&[version_err, info_err, parse_err]);

    let record = data::zen_probes::ZenProbe {
        id: None,
        endpoint_id,
        probed_at: None,
        reachable: true,
        schema_version: 1,
        effective_port: extracted.effective_port.map(|p| p as i64),
        pid: extracted.pid.map(|p| p as i64),
        uptime_seconds: extracted.uptime_seconds,
        data_root: extracted.data_root,
        is_dedicated: extracted.is_dedicated,
        build_version,
        health_info_cb,
        health_version_text,
        stats_providers_cb: None,
        error_message,
    };

    ProbeOutcome {
        record,
        provider_paths_hint: None,
    }
}

/// Persist `outcome.record` via `data::zen_probes::insert`. Returns the
/// new row id.
pub fn persist(db: &data::Db, outcome: &ProbeOutcome) -> UecmResult<i64> {
    data::zen_probes::insert(db, &outcome.record)
}

/// Convenience wrapper: probe and persist in one call.
pub fn probe_and_persist(
    db: &data::Db,
    endpoint: &data::zen_endpoints::ZenEndpoint,
    host: &str,
    timeout: Duration,
) -> UecmResult<i64> {
    let outcome = probe_endpoint(endpoint, host, timeout);
    persist(db, &outcome)
}

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

#[derive(Default, Debug)]
struct ExtractedFields {
    effective_port: Option<u16>,
    pid: Option<u32>,
    uptime_seconds: Option<i64>,
    data_root: Option<String>,
    is_dedicated: Option<bool>,
    build_version: Option<String>,
}

impl ExtractedFields {
    fn from_cb(value: &CbValue) -> Self {
        let effective_port = extract_effective_port(value);
        let pid = value
            .get("Pid")
            .and_then(CbValue::as_u64)
            .and_then(|v| u32::try_from(v).ok());
        let uptime_seconds = value
            .get("System.uptime_seconds")
            .and_then(CbValue::as_i64);
        let data_root = value
            .get("DataRoot")
            .and_then(CbValue::as_str)
            .map(str::to_string);
        let is_dedicated = value.get("IsDedicated").and_then(CbValue::as_bool);
        let build_version = value
            .get("BuildVersion")
            .and_then(CbValue::as_str)
            .map(str::to_string);
        ExtractedFields {
            effective_port,
            pid,
            uptime_seconds,
            data_root,
            is_dedicated,
            build_version,
        }
    }
}

/// `RuntimeConfig.EffectivePort` is a string on real zen output; the
/// top-level `Port` uint is the historical fallback. RuntimeConfig wins
/// when both are present because it reflects the actually-bound port
/// after any auto-shift, while `Port` is the operator's declared intent.
fn extract_effective_port(value: &CbValue) -> Option<u16> {
    if let Some(port_str) = value
        .get("RuntimeConfig.EffectivePort")
        .and_then(CbValue::as_str)
    {
        if let Ok(p) = port_str.parse::<u16>() {
            return Some(p);
        }
    }
    value
        .get("Port")
        .and_then(CbValue::as_u64)
        .and_then(|v| u16::try_from(v).ok())
}

fn compose_partial_error(parts: &[Option<String>]) -> Option<String> {
    let collected: Vec<&str> = parts.iter().filter_map(|x| x.as_deref()).collect();
    if collected.is_empty() {
        None
    } else {
        Some(collected.join("; "))
    }
}

fn unreachable_record(endpoint_id: i64, error: String) -> data::zen_probes::ZenProbe {
    data::zen_probes::ZenProbe {
        id: None,
        endpoint_id,
        probed_at: None,
        reachable: false,
        schema_version: 1,
        effective_port: None,
        pid: None,
        uptime_seconds: None,
        data_root: None,
        is_dedicated: None,
        build_version: None,
        health_info_cb: None,
        health_version_text: None,
        stats_providers_cb: None,
        error_message: Some(error),
    }
}

fn get_text_ok(client: &reqwest::blocking::Client, url: &str) -> Result<String, String> {
    let resp = client.get(url).send().map_err(format_reqwest_err)?;
    require_2xx(&resp)?;
    resp.text().map_err(format_reqwest_err)
}

fn get_bytes_ok(client: &reqwest::blocking::Client, url: &str) -> Result<Vec<u8>, String> {
    let resp = client.get(url).send().map_err(format_reqwest_err)?;
    require_2xx(&resp)?;
    let bytes = resp.bytes().map_err(format_reqwest_err)?;
    Ok(bytes.to_vec())
}

fn require_2xx(resp: &reqwest::blocking::Response) -> Result<(), String> {
    let status = resp.status();
    if status.is_success() {
        Ok(())
    } else {
        Err(format!("HTTP {}", status.as_u16()))
    }
}

fn format_reqwest_err(e: reqwest::Error) -> String {
    if e.is_timeout() {
        format!("timeout: {e}")
    } else if e.is_connect() {
        format!("connect error: {e}")
    } else {
        e.to_string()
    }
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::zen::test_http::{Route, TestServer};
    use crate::data::{
        machines, open_in_memory, schema, zen_endpoints, zen_probes, Machine,
    };
    use base64::Engine;
    use std::net::TcpListener;
    use std::time::Duration;

    // -------------------------------------------------------------------------
    // Fixtures
    // -------------------------------------------------------------------------

    // Same /health/info CB as cb_parser::tests::HEALTH_INFO_B64 (the C.3
    // fixture). We reuse it here to drive the full probe path.
    const HEALTH_INFO_B64: &str = "AoSFhwhEYXRhUm9vdBNcXD9cRjpcRXBpY1xERENcWmVuhwpBYnNMb2dQYXRoJlxcP1xGOlxFcGljXEREQ1xaZW5cbG9nc1x6ZW5zZXJ2ZXIubG9nhwxCdWlsZFZlcnNpb24wNS44LjEwLTIwMjYwNTA3MTkzOC13aW5kb3dzLXg2NC1yZWxlYXNlLWZiYWNkZWNkhw9IdHRwU2VydmVyQ2xhc3MEYXNpb4gEUG9ydKFuiANQaWTAfDCMC0lzRGVkaWNhdGVkiAtTdGFydFRpbWVNc/meObwl7IMNUnVudGltZUNvbmZpZ4Flhw1TeXN0ZW1Sb290RGlyF0M6XFByb2dyYW1EYXRhXEVwaWNcWmVuCkNvbnRlbnREaXIADUVmZmVjdGl2ZVBvcnQEODU1OAhCYXNlUG9ydAQ4NTU4CUNvcmVMaW1pdAEwD01lbW9yeUFsbG9jYXRvcg5taW1hbGxvYyAyLjIuNwtBc2lvVmVyc2lvbgYxLjM4LjAHSXNEZWJ1ZwVmYWxzZQxJc0NsZWFuU3RhcnQFZmFsc2UGSXNUZXN0BWZhbHNlBkRldGFjaAR0cnVlD05vQ29uc29sZU91dHB1dAVmYWxzZQxRdWlldENvbnNvbGUEdHJ1ZQdDaGlsZElkEVplbl8yNzMwNF9TdGFydHVwBUxvZ0lkAApTZW50cnkgRFNOB25vdCBzZXQSU2VudHJ5IEVudmlyb25tZW50AA5TdGF0c2QgRW5hYmxlZAVmYWxzZRJTZWN1cml0eUNvbmZpZ1BhdGgAggtCdWlsZENvbmZpZ4ELjBVaRU5fQUREUkVTU19TQU5JVElaRVKMFFpFTl9USFJFQURfU0FOSVRJWkVSjBRaRU5fTUVNT1JZX1NBTklUSVpFUowSWkVOX0xFQUtfU0FOSVRJWkVSjQ5aRU5fVVNFX1NFTlRSWYwOWkVOX1dJVEhfVEVTVFONEFpFTl9VU0VfTUlNQUxMT0ONEFpFTl9VU0VfUlBNQUxMT0ONEFpFTl9XSVRIX0hUVFBTWVONEVpFTl9XSVRIX01FTVRSQUNLjQ5aRU5fV0lUSF9UUkFDRYwZWkVOX1dJVEhfQ09NUFVURV9TRVJWSUNFU4wOWkVOX1dJVEhfSE9SREWMDlpFTl9XSVRIX05PTUFEhwhIb3N0bmFtZQVMQU5QQ4ULSXBBZGRyZXNzZXMQAQcNMTkyLjE2OC4xMC4yMIcIUGxhdGZvcm0Hd2luZG93c4cEQXJjaAN4NjSHAk9TGFdpbmRvd3MgMTAuMCBCdWlsZCAyNjIwMIMGU3lzdGVtgK6ICWNwdV9jb3VudAEKY29yZV9jb3VudBAIbHBfY291bnQgD3RvdGFsX21lbW9yeV9tYsD8QA9hdmFpbF9tZW1vcnlfbWLAjcgQdG90YWxfdmlydHVhbF9tYuf///8QYXZhaWxfdmlydHVhbF9tYuf/4pcRdG90YWxfcGFnZWZpbGVfbWLCPEARYXZhaWxfcGFnZWZpbGVfbWLBs58OdXB0aW1lX3NlY29uZHPAb70=";

    fn health_info_bytes() -> Vec<u8> {
        base64::engine::general_purpose::STANDARD
            .decode(HEALTH_INFO_B64)
            .expect("valid fixture base64")
    }

    fn make_endpoint(id: i64, port: i64) -> data::zen_endpoints::ZenEndpoint {
        data::zen_endpoints::ZenEndpoint {
            id: Some(id),
            machine_id: 1,
            declared_port: port,
            scheme: "http".into(),
            role: "primary".into(),
            upstream_endpoint_id: None,
            data_dir: r"C:\ZenData".into(),
            httpserverclass: "asio".into(),
            lifecycle_mode: "managed".into(),
            created_at: None,
            updated_at: None,
            ..Default::default()
        }
    }

    fn healthy_routes() -> Vec<(&'static str, Route)> {
        vec![
            ("/health", (200u16, "text/plain", b"OK!".to_vec())),
            (
                "/health/version",
                (200u16, "text/plain", b"5.8.10".to_vec()),
            ),
            (
                "/health/info",
                (200u16, "application/octet-stream", health_info_bytes()),
            ),
        ]
    }

    // -------------------------------------------------------------------------
    // Tests
    // -------------------------------------------------------------------------

    #[test]
    fn probe_endpoint_marks_reachable_on_healthy_zen() {
        let server = TestServer::new(healthy_routes(), Duration::ZERO);
        let endpoint = make_endpoint(7, server.port() as i64);
        let outcome = probe_endpoint(&endpoint, "127.0.0.1", Duration::from_secs(2));
        let r = &outcome.record;
        assert!(r.reachable);
        assert_eq!(r.endpoint_id, 7);
        assert_eq!(r.effective_port, Some(8558));
        assert_eq!(r.pid, Some(31792));
        assert_eq!(r.data_root.as_deref(), Some(r"\\?\F:\Epic\DDC\Zen"));
        assert_eq!(r.is_dedicated, Some(false));
        assert!(r
            .build_version
            .as_deref()
            .unwrap()
            .starts_with("5.8.10-202605071938"));
        assert_eq!(r.health_version_text.as_deref(), Some("5.8.10"));
        assert_eq!(r.health_info_cb.as_deref(), Some(health_info_bytes().as_slice()));
        assert_eq!(r.stats_providers_cb, None);
        assert_eq!(r.error_message, None);
        let uptime = r.uptime_seconds.expect("uptime present");
        assert!(uptime > 0);
        assert!(outcome.provider_paths_hint.is_none());
    }

    #[test]
    fn probe_endpoint_unreachable_when_server_offline() {
        // Bind a listener, capture its port, then drop it so the port is
        // free again. The probe should fail to connect within the timeout.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let endpoint = make_endpoint(11, port as i64);
        let outcome = probe_endpoint(&endpoint, "127.0.0.1", Duration::from_secs(2));
        let r = &outcome.record;
        assert!(!r.reachable);
        let msg = r.error_message.as_deref().unwrap_or("");
        assert!(
            msg.starts_with("GET /health failed"),
            "expected 'GET /health failed' prefix, got: {msg}"
        );
        assert!(r.effective_port.is_none());
        assert!(r.pid.is_none());
        assert!(r.data_root.is_none());
        assert!(r.build_version.is_none());
        assert!(r.health_info_cb.is_none());
        assert!(r.health_version_text.is_none());
    }

    #[test]
    fn probe_endpoint_5xx_response_marks_unreachable() {
        let routes = vec![(
            "/health",
            (500u16, "text/plain", b"internal error".to_vec()),
        )];
        let server = TestServer::new(routes, Duration::ZERO);
        let endpoint = make_endpoint(12, server.port() as i64);
        let outcome = probe_endpoint(&endpoint, "127.0.0.1", Duration::from_secs(2));
        let r = &outcome.record;
        assert!(!r.reachable);
        let msg = r.error_message.as_deref().unwrap_or("");
        assert!(msg.starts_with("GET /health failed"), "msg={msg}");
        assert!(msg.contains("500"), "msg={msg}");
    }

    #[test]
    fn probe_endpoint_partial_failure_health_info_404() {
        let routes = vec![
            ("/health", (200u16, "text/plain", b"OK!".to_vec())),
            (
                "/health/version",
                (200u16, "text/plain", b"5.8.10".to_vec()),
            ),
            // /health/info intentionally omitted → server returns 404.
        ];
        let server = TestServer::new(routes, Duration::ZERO);
        let endpoint = make_endpoint(13, server.port() as i64);
        let outcome = probe_endpoint(&endpoint, "127.0.0.1", Duration::from_secs(2));
        let r = &outcome.record;
        assert!(r.reachable, "should still be reachable: /health succeeded");
        assert!(r.health_info_cb.is_none());
        // Flat fields all absent because no CB to parse.
        assert!(r.effective_port.is_none());
        assert!(r.pid.is_none());
        let msg = r.error_message.as_deref().unwrap_or("");
        assert!(
            msg.contains("/health/info"),
            "expected /health/info in error_message, got: {msg}"
        );
        // build_version should still fall back from /health/version.
        assert_eq!(r.build_version.as_deref(), Some("5.8.10"));
    }

    #[test]
    fn probe_endpoint_cb_parse_failure_preserves_raw() {
        let garbage = vec![0xFFu8, 0xFF, 0xFF, 0xFF];
        let routes = vec![
            ("/health", (200u16, "text/plain", b"OK!".to_vec())),
            (
                "/health/version",
                (200u16, "text/plain", b"5.8.10".to_vec()),
            ),
            (
                "/health/info",
                (200u16, "application/octet-stream", garbage.clone()),
            ),
        ];
        let server = TestServer::new(routes, Duration::ZERO);
        let endpoint = make_endpoint(14, server.port() as i64);
        let outcome = probe_endpoint(&endpoint, "127.0.0.1", Duration::from_secs(2));
        let r = &outcome.record;
        assert!(r.reachable);
        // Raw bytes preserved.
        assert_eq!(r.health_info_cb.as_deref(), Some(garbage.as_slice()));
        // Flat extraction stayed None.
        assert!(r.effective_port.is_none());
        assert!(r.pid.is_none());
        assert!(r.data_root.is_none());
        assert!(r.is_dedicated.is_none());
        let msg = r.error_message.as_deref().unwrap_or("");
        assert!(
            msg.to_lowercase().contains("parse")
                || msg.to_lowercase().contains("cb")
                || msg.to_lowercase().contains("malformed"),
            "expected parser error mention, got: {msg}"
        );
        // build_version still falls back to /health/version.
        assert_eq!(r.build_version.as_deref(), Some("5.8.10"));
    }

    #[test]
    fn probe_endpoint_respects_timeout() {
        // Server sleeps 1s before responding; probe times out at 150ms.
        let server = TestServer::new(healthy_routes(), Duration::from_millis(1000));
        let endpoint = make_endpoint(15, server.port() as i64);
        let outcome =
            probe_endpoint(&endpoint, "127.0.0.1", Duration::from_millis(150));
        let r = &outcome.record;
        assert!(!r.reachable);
        let msg = r.error_message.as_deref().unwrap_or("").to_lowercase();
        assert!(
            msg.contains("timeout") || msg.contains("timed out"),
            "expected timeout mention, got: {msg}"
        );
    }

    #[test]
    fn probe_endpoint_url_uses_declared_port_and_scheme() {
        // Sanity: declared_port lands in the URL. We assert by running a
        // probe end-to-end against a server bound to a known port.
        let server = TestServer::new(healthy_routes(), Duration::ZERO);
        let endpoint = make_endpoint(16, server.port() as i64);
        let outcome = probe_endpoint(&endpoint, "127.0.0.1", Duration::from_secs(2));
        assert!(outcome.record.reachable);
        assert_eq!(outcome.record.effective_port, Some(8558));
    }

    // -------------------------------------------------------------------------
    // Field-extraction unit tests (operate directly on hand-built CB blobs)
    // -------------------------------------------------------------------------

    fn build_string_field(name: &str, val: &str) -> Vec<u8> {
        // type=String|HasFieldName (0x87), VarUInt(name_len), name bytes,
        // VarUInt(val_len), val bytes. Both lengths fit in a single byte for
        // every input we feed it.
        let mut buf = Vec::new();
        buf.push(0x87);
        push_varuint(&mut buf, name.len() as u64);
        buf.extend_from_slice(name.as_bytes());
        push_varuint(&mut buf, val.len() as u64);
        buf.extend_from_slice(val.as_bytes());
        buf
    }

    fn build_uint_field(name: &str, val: u64) -> Vec<u8> {
        // type=IntegerPositive|HasFieldName (0x88), VarUInt(name_len), name,
        // VarUInt(val).
        let mut buf = Vec::new();
        buf.push(0x88);
        push_varuint(&mut buf, name.len() as u64);
        buf.extend_from_slice(name.as_bytes());
        push_varuint(&mut buf, val);
        buf
    }

    fn build_object_field(name: &str, inner_body: &[u8]) -> Vec<u8> {
        // 0x82 = Object|HasFieldName.
        let mut buf = Vec::new();
        buf.push(0x82);
        push_varuint(&mut buf, name.len() as u64);
        buf.extend_from_slice(name.as_bytes());
        // Inner Object: VarUInt(payload_len) + body.
        push_varuint(&mut buf, inner_body.len() as u64);
        buf.extend_from_slice(inner_body);
        buf
    }

    fn wrap_top_object(body: &[u8]) -> Vec<u8> {
        let mut buf = Vec::new();
        buf.push(0x02); // top-level Object (no name)
        push_varuint(&mut buf, body.len() as u64);
        buf.extend_from_slice(body);
        buf
    }

    fn push_varuint(out: &mut Vec<u8>, v: u64) {
        // Minimal CB VarUInt encoder for tests: matches spec §2.
        // 0..=0x7F          → 1 byte:  0xxxxxxx
        // 0x80..=0x3FFF     → 2 bytes: 10xxxxxx xxxxxxxx
        // 0x4000..=0x1FFFFF → 3 bytes: 110xxxxx xxxxxxxx xxxxxxxx
        // ... up to 9 bytes. We only need small values here, but the encoder
        // handles the full range so tests can grow without surprises.
        let bytes_needed = if v <= 0x7F {
            1
        } else if v <= 0x3FFF {
            2
        } else if v <= 0x1F_FFFF {
            3
        } else if v <= 0x0FFF_FFFF {
            4
        } else if v <= 0x07_FFFF_FFFF {
            5
        } else if v <= 0x03FF_FFFF_FFFF {
            6
        } else if v <= 0x01_FFFF_FFFF_FFFF {
            7
        } else if v <= 0xFF_FFFF_FFFF_FFFF {
            8
        } else {
            9
        };
        let extra = bytes_needed - 1;
        // Leading-1 prefix is `extra` ones followed by a zero (for bytes_needed<=8).
        // For the 9-byte form the entire first byte is 0xFF.
        let prefix: u8 = if bytes_needed == 9 {
            0xFF
        } else {
            (((1u16 << extra) - 1) << (8 - extra)) as u8
        };
        // Top bits of `v` that fit into the first byte alongside the prefix.
        let head_bits = (8 - extra) as u32; // bits of `v` in the first byte (or 0 if 9-byte form)
        let head_mask: u8 = if bytes_needed == 9 {
            0
        } else {
            ((1u16 << head_bits) - 1) as u8
        };
        let head_val: u8 = ((v >> (8 * extra)) as u8) & head_mask;
        out.push(prefix | head_val);
        for i in (0..extra).rev() {
            out.push((v >> (8 * i)) as u8);
        }
    }

    #[test]
    fn extracts_effective_port_from_runtime_config_string() {
        let inner = build_string_field("EffectivePort", "8558");
        let runtime_cfg = build_object_field("RuntimeConfig", &inner);
        let blob = wrap_top_object(&runtime_cfg);
        let (val, _) = cb_parser::parse(&blob).unwrap();
        let extracted = ExtractedFields::from_cb(&val);
        assert_eq!(extracted.effective_port, Some(8558));
    }

    #[test]
    fn extracts_effective_port_from_top_level_port_uint() {
        let port_field = build_uint_field("Port", 8558);
        let blob = wrap_top_object(&port_field);
        let (val, _) = cb_parser::parse(&blob).unwrap();
        let extracted = ExtractedFields::from_cb(&val);
        assert_eq!(extracted.effective_port, Some(8558));
    }

    #[test]
    fn prefers_runtime_config_effective_port_over_top_level_port() {
        let mut body = Vec::new();
        body.extend(build_uint_field("Port", 7000));
        let inner = build_string_field("EffectivePort", "9000");
        body.extend(build_object_field("RuntimeConfig", &inner));
        let blob = wrap_top_object(&body);
        let (val, _) = cb_parser::parse(&blob).unwrap();
        let extracted = ExtractedFields::from_cb(&val);
        assert_eq!(extracted.effective_port, Some(9000));
    }

    #[test]
    fn is_dedicated_false_serialises_to_zero() {
        // Round-trip through ZenProbe → CRUD insert → SELECT and verify
        // the SQLite-side encoding is 0 for `false`.
        let db = open_in_memory().unwrap();
        {
            let mut conn = db.lock().unwrap();
            schema::migrate(&mut conn).unwrap();
        }
        let machine_id =
            machines::insert(&db, &Machine::new("ZEN-T1", "192.168.10.40")).unwrap();
        let endpoint_id = zen_endpoints::upsert(
            &db,
            &zen_endpoints::ZenEndpoint {
                id: None,
                machine_id,
                declared_port: 8558,
                scheme: "http".into(),
                role: "primary".into(),
                upstream_endpoint_id: None,
                data_dir: r"C:\ZenData".into(),
                httpserverclass: "asio".into(),
                lifecycle_mode: "managed".into(),
                created_at: None,
                updated_at: None,
                ..Default::default()
            },
        )
        .unwrap();
        let probe = data::zen_probes::ZenProbe {
            id: None,
            endpoint_id,
            probed_at: None,
            reachable: true,
            schema_version: 1,
            effective_port: Some(8558),
            pid: Some(1),
            uptime_seconds: Some(1),
            data_root: Some("dr".into()),
            is_dedicated: Some(false),
            build_version: Some("v".into()),
            health_info_cb: Some(vec![0x01]),
            health_version_text: Some("v".into()),
            stats_providers_cb: None,
            error_message: None,
        };
        let id = data::zen_probes::insert(&db, &probe).unwrap();
        let conn = db.lock().unwrap();
        let raw: i64 = conn
            .query_row(
                "SELECT is_dedicated FROM zen_probes WHERE id = ?",
                rusqlite::params![id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(raw, 0);
    }

    #[test]
    fn build_version_falls_back_to_text_endpoint() {
        // /health/info has no BuildVersion field but /health/version returns
        // "5.8.10". Final record should pick up the text-endpoint value.
        let inner = build_string_field("DataRoot", "X");
        let blob = wrap_top_object(&inner);
        let routes = vec![
            ("/health", (200u16, "text/plain", b"OK!".to_vec())),
            (
                "/health/version",
                (200u16, "text/plain", b"5.8.10".to_vec()),
            ),
            (
                "/health/info",
                (200u16, "application/octet-stream", blob),
            ),
        ];
        let server = TestServer::new(routes, Duration::ZERO);
        let endpoint = make_endpoint(21, server.port() as i64);
        let outcome = probe_endpoint(&endpoint, "127.0.0.1", Duration::from_secs(2));
        let r = &outcome.record;
        assert!(r.reachable);
        assert_eq!(r.build_version.as_deref(), Some("5.8.10"));
        // And the structured DataRoot we synthesised in CB parsed fine.
        assert_eq!(r.data_root.as_deref(), Some("X"));
    }

    #[test]
    fn persist_writes_record_and_returns_id() {
        let db = open_in_memory().unwrap();
        {
            let mut conn = db.lock().unwrap();
            schema::migrate(&mut conn).unwrap();
        }
        let machine_id =
            machines::insert(&db, &Machine::new("ZEN-T2", "192.168.10.41")).unwrap();
        let endpoint_id = zen_endpoints::upsert(
            &db,
            &zen_endpoints::ZenEndpoint {
                id: None,
                machine_id,
                declared_port: 8558,
                scheme: "http".into(),
                role: "primary".into(),
                upstream_endpoint_id: None,
                data_dir: r"C:\ZenData".into(),
                httpserverclass: "asio".into(),
                lifecycle_mode: "managed".into(),
                created_at: None,
                updated_at: None,
                ..Default::default()
            },
        )
        .unwrap();
        let endpoint = zen_endpoints::get(&db, endpoint_id).unwrap().unwrap();

        let server = TestServer::new(healthy_routes(), Duration::ZERO);
        let mut probe_endpoint_input = endpoint.clone();
        probe_endpoint_input.declared_port = server.port() as i64;
        let id = probe_and_persist(
            &db,
            &probe_endpoint_input,
            "127.0.0.1",
            Duration::from_secs(2),
        )
        .unwrap();
        assert!(id > 0);
        let recent = zen_probes::list_recent(&db, endpoint_id, 1).unwrap();
        assert_eq!(recent.len(), 1);
        let r = &recent[0];
        assert!(r.reachable);
        assert_eq!(r.effective_port, Some(8558));
        assert_eq!(r.data_root.as_deref(), Some(r"\\?\F:\Epic\DDC\Zen"));
    }

    #[test]
    fn probe_endpoint_2xx_with_wrong_body_marks_unreachable() {
        // Another HTTP service may be holding zen's port and returning 200 for
        // every request. The /health contract is specifically the fixed-text
        // body "OK!"; anything else means this isn't zen and we must not
        // mark the endpoint reachable just because we got a 2xx status.
        let routes = vec![(
            "/health",
            (200u16, "text/html", b"<html>not zen</html>".to_vec()),
        )];
        let server = TestServer::new(routes, Duration::ZERO);
        let endpoint = make_endpoint(99, server.port() as i64);
        let outcome = probe_endpoint(&endpoint, "127.0.0.1", Duration::from_secs(2));
        let r = &outcome.record;
        assert!(!r.reachable, "wrong /health body must NOT count as reachable");
        let msg = r.error_message.as_deref().unwrap_or("");
        assert!(
            msg.contains("not zen heartbeat"),
            "error should mention heartbeat mismatch, got {msg}"
        );
        assert!(r.health_info_cb.is_none(), "must skip /health/info on wrong body");
        assert!(r.health_version_text.is_none(), "must skip /health/version on wrong body");
    }
}
