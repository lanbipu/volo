//! Plan 7 T1.5: HTTP probe of zen's `/stats` + `/stats/<provider>` endpoints.
//!
//! Pipeline per call:
//!
//! 1. GET `/stats` → CB blob carrying a `providers` array.
//! 2. For each provider matching `z$` (the cache provider — others like
//!    `dashboard` / `http` / `prj` aren't cache metrics so we don't persist
//!    rows for them, but we still surface their names in
//!    [`CacheStatsOutcome::providers`] for plan §3 health check 4).
//! 3. GET `/stats/<provider>` → CB blob. Extract the frozen baseline fields
//!    (`cache.hit_ratio`, `cache.size.disk`, `cache.size.memory`) into flat
//!    columns and stash the raw bytes for offline forensics.
//!
//! Error semantics mirror [`crate::core::zen::probe`]:
//!
//! - Network / parse failures NEVER bubble up as `Err` from
//!   [`fetch_cache_stats`]. We always return an outcome so the caller can
//!   record the attempt and surface `error_message` to the operator.
//! - Provider-level failures (404 on `/stats/<provider>`, CB parse failure
//!   on a provider blob) don't cancel the whole call — we just skip / store
//!   raw and append a note to `error_message`.
//! - The only `Err` path is from the database layer in [`persist`].

use std::time::Duration;

use crate::core::zen::cb_parser::{self, CbValue};
use crate::data;
use crate::error::VoloResult;

/// The cache provider name used by zen. Plan §1.1 baseline only persists
/// stats for this provider; other names from `/stats` are tracked in
/// `outcome.providers` for the readiness check but produce no DB rows.
const CACHE_PROVIDER_NAME: &str = "z$";

/// Outcome of one `fetch_cache_stats` call.
///
/// `records` is the set of provider rows ready to insert (currently only the
/// `z$` provider). `providers` lists every name pulled from `/stats`,
/// regardless of whether we managed to fetch its stats — health check 4 in
/// plan §3 reads this list to confirm `z$` is registered.
#[derive(Debug, Clone)]
pub struct CacheStatsOutcome {
    pub records: Vec<data::zen_cache_stats::ZenCacheStats>,
    pub providers: Vec<String>,
    pub error_message: Option<String>,
}

/// Probe `/stats` and (for the cache provider) `/stats/z$`. See module docs
/// for error semantics.
///
/// `host` is the resolved hostname or IPv4 address used to construct URLs.
/// Caller (CLI / Tauri layer) is responsible for machine → host resolution.
pub fn fetch_cache_stats(
    endpoint: &data::zen_endpoints::ZenEndpoint,
    host: &str,
    timeout: Duration,
) -> CacheStatsOutcome {
    let endpoint_id = endpoint
        .id
        .expect("ZenEndpoint passed to fetch_cache_stats must have id");
    let base_url = format!("{}://{}:{}", endpoint.scheme, host, endpoint.declared_port);

    let client = match reqwest::blocking::Client::builder()
        .timeout(timeout)
        .connect_timeout(timeout)
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return unreachable_outcome(format!("failed to build http client: {e}"));
        }
    };

    // Step 1: /stats — provider list.
    let stats_url = format!("{}/stats", base_url);
    let stats_bytes = match get_bytes_ok(&client, &stats_url) {
        Ok(bytes) => bytes,
        Err(reason) => {
            return unreachable_outcome(format!("GET /stats failed: {reason}"));
        }
    };

    let providers = match cb_parser::parse(&stats_bytes) {
        Ok((value, _)) => extract_provider_names(&value),
        Err(e) => {
            return CacheStatsOutcome {
                records: Vec::new(),
                providers: Vec::new(),
                error_message: Some(format!("CB parse of /stats failed: {e}")),
            };
        }
    };

    // Step 2: per-provider stats. We only persist rows for the cache
    // provider; other entries (dashboard / http / prj / sessions / ws) are
    // tracked in `providers` for the readiness check but generate no rows.
    let mut records = Vec::new();
    let mut partial_errors = Vec::new();

    for provider in providers.iter().filter(|p| p.as_str() == CACHE_PROVIDER_NAME) {
        let encoded = url_encode_provider(provider);
        let provider_url = format!("{}/stats/{}", base_url, encoded);
        let provider_path = format!("/stats/{}", provider);

        match get_bytes_ok(&client, &provider_url) {
            Ok(bytes) => {
                let (hit_ratio, disk, memory, parse_err) =
                    extract_cache_metrics(&bytes, &provider_path);
                if let Some(err) = parse_err {
                    partial_errors.push(err);
                }
                records.push(data::zen_cache_stats::ZenCacheStats {
                    id: None,
                    endpoint_id,
                    sampled_at: None,
                    cache_hit_ratio: hit_ratio,
                    cache_disk_size_bytes: disk,
                    cache_memory_size_bytes: memory,
                    provider_path,
                    raw_cb: bytes,
                    schema_version: 1,
                });
            }
            Err(reason) => {
                partial_errors.push(format!("GET /stats/{} failed: {}", provider, reason));
            }
        }
    }

    let error_message = if partial_errors.is_empty() {
        None
    } else {
        Some(partial_errors.join("; "))
    };

    CacheStatsOutcome {
        records,
        providers,
        error_message,
    }
}

/// Persist every record in `outcome` via `data::zen_cache_stats::insert`.
/// Returns the new row ids in insertion order.
pub fn persist(db: &data::Db, outcome: &CacheStatsOutcome) -> VoloResult<Vec<i64>> {
    let mut ids = Vec::with_capacity(outcome.records.len());
    for record in &outcome.records {
        ids.push(data::zen_cache_stats::insert(db, record)?);
    }
    Ok(ids)
}

/// Convenience wrapper: fetch + persist in one call.
pub fn fetch_and_persist(
    db: &data::Db,
    endpoint: &data::zen_endpoints::ZenEndpoint,
    host: &str,
    timeout: Duration,
) -> VoloResult<Vec<i64>> {
    let outcome = fetch_cache_stats(endpoint, host, timeout);
    persist(db, &outcome)
}

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

fn unreachable_outcome(error: String) -> CacheStatsOutcome {
    CacheStatsOutcome {
        records: Vec::new(),
        providers: Vec::new(),
        error_message: Some(error),
    }
}

fn extract_provider_names(value: &CbValue) -> Vec<String> {
    value
        .get("providers")
        .and_then(CbValue::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(CbValue::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Returns `(hit_ratio, disk_bytes, memory_bytes, parse_error)`.
///
/// When CB parsing fails the flat columns are all `None`; the raw bytes are
/// preserved by the caller. A missing individual field is `None` without
/// flagging a parse error — only an outright CB decode failure is reported.
fn extract_cache_metrics(
    bytes: &[u8],
    provider_path: &str,
) -> (Option<f64>, Option<i64>, Option<i64>, Option<String>) {
    let value = match cb_parser::parse(bytes) {
        Ok((value, _)) => value,
        Err(e) => {
            return (
                None,
                None,
                None,
                Some(format!("CB parse of {} failed: {}", provider_path, e)),
            );
        }
    };
    let hit_ratio = value.get("cache.hit_ratio").and_then(CbValue::as_f64);
    let disk = value
        .get("cache.size.disk")
        .and_then(CbValue::as_u64)
        .and_then(|v| i64::try_from(v).ok());
    let memory = value
        .get("cache.size.memory")
        .and_then(CbValue::as_u64)
        .and_then(|v| i64::try_from(v).ok());
    (hit_ratio, disk, memory, None)
}

/// Hand-rolled percent-encoder for provider names. zen's cache provider name
/// is literally `z$`, and `$` is the only reserved character we need to deal
/// with for the current providers list. Adding the `percent-encoding` crate
/// for one character is overkill; if more reserved characters show up in
/// future zen builds the caller should pull in the crate proper.
fn url_encode_provider(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for b in name.bytes() {
        // RFC 3986 unreserved set plus '-', '_', '.', '~' get through
        // untouched; everything else is %HH-encoded. That's stricter than
        // the bare minimum but matches what reqwest's url crate would do.
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

fn get_bytes_ok(client: &reqwest::blocking::Client, url: &str) -> Result<Vec<u8>, String> {
    let resp = client.get(url).send().map_err(format_reqwest_err)?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("HTTP {}", status.as_u16()));
    }
    let bytes = resp.bytes().map_err(format_reqwest_err)?;
    Ok(bytes.to_vec())
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
        machines, open_in_memory, schema, zen_cache_stats, zen_endpoints, Machine,
    };
    use base64::Engine;
    use std::net::TcpListener;

    // C.4 fixture (50 bytes): providers = ["dashboard","http","prj","sessions","ws","z$"]
    const STATS_B64: &str =
        "AzCFCXByb3ZpZGVycyQGBwlkYXNoYm9hcmQEaHR0cANwcmoIc2Vzc2lvbnMCd3MCeiQ=";

    // C.5 fixture (481 bytes): real /stats/z$ capture used for the frozen
    // baseline assertions.
    const STATS_Z_B64: &str = "AoHegghyZXF1ZXN0c4C3iAVjb3VudINZiwlyYXRlX21lYW4/sRvepVM8E4sGcmF0ZV8xMdJAynniMQGLBnJhdGVfNTzUFQfVPXqeiwdyYXRlXzE1PrFufSN0GBmLBXRfYXZnP/3Cj4aCHnaLBXRfbWluPuI+xuUsPyOLBXRfbWF4QEqkuVh7whiLBXRfcDc1P5dCyn/rcqqLBXRfcDk1QCeU9w+WdfiLBXRfcDk5QEPpUaeSgLKLBnRfcDk5OUBJ+/x3tUNDggVjYWNoZYDbiA9iYWRyZXF1ZXN0Y291bnQAggNycGNXiAVjb3VudIMpiANvcHOFhoMHcmVjb3Jkcw+IBWNvdW50gmgDb3BzhMWDBnZhbHVlcw+IBWNvdW50gMEDb3BzgMGDBmNodW5rcw2IBWNvdW50AANvcHMAgwRzaXplFYgEZGlza/Ajm9ljBm1lbW9yecVnMIgEaGl0c4VdiAZtaXNzZXMniAZ3cml0ZXMCiwloaXRfcmF0aW8/7x271Hy8jogHY2lkaGl0c4nHiAljaWRtaXNzZXMAiAljaWR3cml0ZXMAgwNjaWQxgwRzaXplKogEdGlueeBu5XEFc21hbGzwHJ6sUAVsYXJnZeWSyLEFdG90YWzwIqBacg==";

    fn decode_b64(s: &str) -> Vec<u8> {
        base64::engine::general_purpose::STANDARD
            .decode(s)
            .expect("valid fixture base64")
    }

    fn stats_bytes() -> Vec<u8> {
        decode_b64(STATS_B64)
    }

    fn stats_z_bytes() -> Vec<u8> {
        decode_b64(STATS_Z_B64)
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

    /// Standard happy-path routes: /stats lists all 6 providers, /stats/z%24
    /// (URL-encoded) returns the captured stats blob.
    fn healthy_routes() -> Vec<(&'static str, Route)> {
        vec![
            ("/stats", (200u16, "application/octet-stream", stats_bytes())),
            (
                "/stats/z%24",
                (200u16, "application/octet-stream", stats_z_bytes()),
            ),
        ]
    }

    // -------------------------------------------------------------------------
    // Tests
    // -------------------------------------------------------------------------

    #[test]
    fn fetch_cache_stats_extracts_providers_from_stats_cb() {
        let server = TestServer::new(healthy_routes(), Duration::ZERO);
        let endpoint = make_endpoint(7, server.port() as i64);
        let outcome = fetch_cache_stats(&endpoint, "127.0.0.1", Duration::from_secs(2));
        assert_eq!(
            outcome.providers,
            vec!["dashboard", "http", "prj", "sessions", "ws", "z$"]
        );
    }

    #[test]
    fn fetch_cache_stats_records_only_z_dollar_provider() {
        let server = TestServer::new(healthy_routes(), Duration::ZERO);
        let endpoint = make_endpoint(8, server.port() as i64);
        let outcome = fetch_cache_stats(&endpoint, "127.0.0.1", Duration::from_secs(2));
        assert_eq!(outcome.records.len(), 1, "only z$ should produce a record");
        assert_eq!(outcome.records[0].provider_path, "/stats/z$");
        assert_eq!(outcome.records[0].endpoint_id, 8);
        assert_eq!(outcome.records[0].schema_version, 1);
        assert_eq!(outcome.records[0].raw_cb, stats_z_bytes());
    }

    #[test]
    fn extracts_frozen_baseline_columns_from_z_dollar() {
        let server = TestServer::new(healthy_routes(), Duration::ZERO);
        let endpoint = make_endpoint(9, server.port() as i64);
        let outcome = fetch_cache_stats(&endpoint, "127.0.0.1", Duration::from_secs(2));
        let record = &outcome.records[0];
        let ratio = record.cache_hit_ratio.expect("hit_ratio present");
        // Expected bit pattern 0x3FEF1DBBD47CBC8E → 0.9723796033994334
        assert!(
            (ratio - 0.9723796033994334).abs() < 1e-15,
            "hit_ratio drifted: got {ratio}"
        );
        let disk = record.cache_disk_size_bytes.expect("disk present");
        assert!(disk > 0, "disk size positive");
        let memory = record.cache_memory_size_bytes.expect("memory present");
        assert!(memory > 0, "memory size positive");
        assert_eq!(outcome.error_message, None);
    }

    #[test]
    fn fetch_cache_stats_unreachable_when_stats_offline() {
        // Bind a listener, capture its port, then drop it so the port is
        // free again. The probe should fail to connect within the timeout.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let endpoint = make_endpoint(10, port as i64);
        let outcome = fetch_cache_stats(&endpoint, "127.0.0.1", Duration::from_secs(2));
        assert!(outcome.records.is_empty());
        assert!(outcome.providers.is_empty());
        let msg = outcome.error_message.as_deref().unwrap_or("");
        assert!(
            msg.starts_with("GET /stats failed"),
            "expected 'GET /stats failed' prefix, got: {msg}"
        );
    }

    #[test]
    fn fetch_cache_stats_stats_500_returns_clean_error() {
        let routes = vec![(
            "/stats",
            (500u16, "text/plain", b"internal error".to_vec()),
        )];
        let server = TestServer::new(routes, Duration::ZERO);
        let endpoint = make_endpoint(11, server.port() as i64);
        let outcome = fetch_cache_stats(&endpoint, "127.0.0.1", Duration::from_secs(2));
        assert!(outcome.records.is_empty());
        assert!(outcome.providers.is_empty());
        let msg = outcome.error_message.as_deref().unwrap_or("");
        assert!(msg.starts_with("GET /stats failed"), "msg={msg}");
        assert!(msg.contains("500"), "msg={msg}");
    }

    #[test]
    fn fetch_cache_stats_stats_404_returns_clean_error() {
        // Server has no routes registered → every path 404s.
        let server = TestServer::new(Vec::new(), Duration::ZERO);
        let endpoint = make_endpoint(12, server.port() as i64);
        let outcome = fetch_cache_stats(&endpoint, "127.0.0.1", Duration::from_secs(2));
        assert!(outcome.records.is_empty());
        assert!(outcome.providers.is_empty());
        let msg = outcome.error_message.as_deref().unwrap_or("");
        assert!(msg.starts_with("GET /stats failed"), "msg={msg}");
        assert!(msg.contains("404"), "msg={msg}");
    }

    #[test]
    fn fetch_cache_stats_z_dollar_404_logs_in_error() {
        // /stats returns the provider list, /stats/z%24 is missing.
        let routes = vec![("/stats", (200u16, "application/octet-stream", stats_bytes()))];
        let server = TestServer::new(routes, Duration::ZERO);
        let endpoint = make_endpoint(13, server.port() as i64);
        let outcome = fetch_cache_stats(&endpoint, "127.0.0.1", Duration::from_secs(2));
        assert!(outcome.records.is_empty(), "no records when z$ unavailable");
        assert!(outcome.providers.contains(&"z$".to_string()));
        let msg = outcome.error_message.as_deref().unwrap_or("");
        assert!(
            msg.contains("/stats/z$") && msg.contains("404"),
            "expected /stats/z$ + 404 in error, got: {msg}"
        );
    }

    #[test]
    fn z_dollar_cb_parse_failure_preserves_raw() {
        let garbage = vec![0xFFu8, 0xFF, 0xFF, 0xFF];
        let routes = vec![
            ("/stats", (200u16, "application/octet-stream", stats_bytes())),
            (
                "/stats/z%24",
                (200u16, "application/octet-stream", garbage.clone()),
            ),
        ];
        let server = TestServer::new(routes, Duration::ZERO);
        let endpoint = make_endpoint(14, server.port() as i64);
        let outcome = fetch_cache_stats(&endpoint, "127.0.0.1", Duration::from_secs(2));
        assert_eq!(outcome.records.len(), 1, "row inserted even on parse failure");
        let record = &outcome.records[0];
        assert_eq!(record.raw_cb, garbage, "raw bytes preserved verbatim");
        assert!(record.cache_hit_ratio.is_none());
        assert!(record.cache_disk_size_bytes.is_none());
        assert!(record.cache_memory_size_bytes.is_none());
        let msg = outcome.error_message.as_deref().unwrap_or("");
        assert!(
            msg.to_lowercase().contains("parse") || msg.to_lowercase().contains("cb"),
            "expected parser error mention, got: {msg}"
        );
    }

    #[test]
    fn provider_name_with_dollar_url_encoded() {
        let server = TestServer::new(healthy_routes(), Duration::ZERO);
        let endpoint = make_endpoint(15, server.port() as i64);
        let outcome = fetch_cache_stats(&endpoint, "127.0.0.1", Duration::from_secs(2));
        // If the URL encoding broke, the server would have seen /stats/z$
        // (unmatched → 404) and we'd have an error_message. Healthy outcome
        // means the encoded path matched.
        assert_eq!(outcome.error_message, None);
        let paths = server.request_paths();
        assert!(paths.contains(&"/stats".to_string()), "paths={paths:?}");
        assert!(
            paths.contains(&"/stats/z%24".to_string()),
            "expected /stats/z%24 (URL-encoded $), got paths={paths:?}"
        );
        assert!(
            !paths.contains(&"/stats/z$".to_string()),
            "raw '$' must NOT be on the wire, got paths={paths:?}"
        );
    }

    #[test]
    fn fetch_cache_stats_respects_timeout() {
        // Server sleeps 1s before responding; probe times out at 150ms.
        let server = TestServer::new(healthy_routes(), Duration::from_millis(1000));
        let endpoint = make_endpoint(16, server.port() as i64);
        let outcome = fetch_cache_stats(&endpoint, "127.0.0.1", Duration::from_millis(150));
        assert!(outcome.records.is_empty());
        assert!(outcome.providers.is_empty());
        let msg = outcome
            .error_message
            .as_deref()
            .unwrap_or("")
            .to_lowercase();
        assert!(
            msg.contains("timeout") || msg.contains("timed out"),
            "expected timeout mention, got: {msg}"
        );
    }

    #[test]
    fn persist_writes_record_returns_id() {
        let db = open_in_memory().unwrap();
        {
            let mut conn = db.lock().unwrap();
            schema::migrate(&mut conn).unwrap();
        }
        let machine_id =
            machines::insert(&db, &Machine::new("ZEN-T5", "192.168.10.50")).unwrap();
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
        let ids = fetch_and_persist(
            &db,
            &probe_endpoint_input,
            "127.0.0.1",
            Duration::from_secs(2),
        )
        .unwrap();
        assert_eq!(ids.len(), 1);
        assert!(ids[0] > 0);

        let recent = zen_cache_stats::list_recent(&db, endpoint_id, 1).unwrap();
        assert_eq!(recent.len(), 1);
        let row = &recent[0];
        assert_eq!(row.endpoint_id, endpoint_id);
        assert_eq!(row.provider_path, "/stats/z$");
        let ratio = row.cache_hit_ratio.expect("hit_ratio");
        assert!((ratio - 0.9723796033994334).abs() < 1e-15);
        assert!(row.cache_disk_size_bytes.unwrap() > 0);
        assert!(row.cache_memory_size_bytes.unwrap() > 0);
        assert_eq!(row.raw_cb, stats_z_bytes());
    }

    #[test]
    fn prefers_endpoint_scheme_and_declared_port_for_url() {
        // Sanity: declared_port + scheme land in the URL. Running a probe
        // end-to-end against a server bound to a known port and checking
        // request_paths confirms the URL was built correctly.
        let server = TestServer::new(healthy_routes(), Duration::ZERO);
        let endpoint = make_endpoint(17, server.port() as i64);
        let outcome = fetch_cache_stats(&endpoint, "127.0.0.1", Duration::from_secs(2));
        assert_eq!(outcome.error_message, None);
        assert_eq!(outcome.records.len(), 1);
        let paths = server.request_paths();
        assert_eq!(paths[0], "/stats");
    }

    #[test]
    fn non_z_dollar_providers_in_provider_list_dont_generate_rows() {
        // Build a minimal /stats CB blob listing exactly ["dashboard", "z$"]:
        //   top-level Object containing a field `providers` (Array of String)
        let body = build_providers_object(&["dashboard", "z$"]);
        let stats_blob = wrap_top_object(&body);
        let routes = vec![
            ("/stats", (200u16, "application/octet-stream", stats_blob)),
            // Serve dashboard with garbage to confirm it's never fetched.
            (
                "/stats/dashboard",
                (200u16, "application/octet-stream", vec![0xFFu8; 4]),
            ),
            (
                "/stats/z%24",
                (200u16, "application/octet-stream", stats_z_bytes()),
            ),
        ];
        let server = TestServer::new(routes, Duration::ZERO);
        let endpoint = make_endpoint(18, server.port() as i64);
        let outcome = fetch_cache_stats(&endpoint, "127.0.0.1", Duration::from_secs(2));
        assert_eq!(outcome.providers, vec!["dashboard", "z$"]);
        assert_eq!(outcome.records.len(), 1);
        assert_eq!(outcome.records[0].provider_path, "/stats/z$");
        // The server should never have seen /stats/dashboard — we don't
        // generate rows for non-cache providers.
        let paths = server.request_paths();
        assert!(
            !paths.iter().any(|p| p == "/stats/dashboard"),
            "dashboard should not be fetched, paths={paths:?}"
        );
    }

    #[test]
    fn url_encode_provider_handles_dollar_sign() {
        assert_eq!(url_encode_provider("z$"), "z%24");
        assert_eq!(url_encode_provider("dashboard"), "dashboard");
        assert_eq!(url_encode_provider("foo-bar.baz_qux~v1"), "foo-bar.baz_qux~v1");
        // Slash and space encode too — defensive, even though zen never
        // emits providers with these characters.
        assert_eq!(url_encode_provider("a/b"), "a%2Fb");
        assert_eq!(url_encode_provider("a b"), "a%20b");
    }

    // -------------------------------------------------------------------------
    // Minimal CB encoders for synthetic /stats fixtures (parallel to those in
    // probe.rs). Only what these tests need — keep it small.
    // -------------------------------------------------------------------------

    /// Build a `/stats`-shaped CB blob with the given provider names.
    ///
    /// Mirrors the wire shape of the real C.4 fixture: top-level Object
    /// containing a field `providers` whose value is a UniformArray<String>.
    /// Field type byte is `T_UNIFORM_ARRAY | FLAG_HAS_FIELD_NAME` (0x85),
    /// the array element type is `T_STRING` (0x07).
    fn build_providers_object(names: &[&str]) -> Vec<u8> {
        // Inner: UniformArray<String> payload = VarUInt(count) + 0x07 +
        // (VarUInt(len) + bytes) per element.
        let mut array_payload = Vec::new();
        push_varuint(&mut array_payload, names.len() as u64);
        array_payload.push(0x07); // T_STRING, no flags (uniform array field type)
        for name in names {
            push_varuint(&mut array_payload, name.len() as u64);
            array_payload.extend_from_slice(name.as_bytes());
        }

        // Field "providers" of type T_UNIFORM_ARRAY | FLAG_HAS_FIELD_NAME (0x85).
        let mut field = Vec::new();
        field.push(0x85);
        let field_name = b"providers";
        push_varuint(&mut field, field_name.len() as u64);
        field.extend_from_slice(field_name);
        push_varuint(&mut field, array_payload.len() as u64);
        field.extend_from_slice(&array_payload);
        field
    }

    fn wrap_top_object(body: &[u8]) -> Vec<u8> {
        // T_OBJECT (non-uniform) at top level with no field name. Real
        // /stats uses T_UNIFORM_OBJECT but T_OBJECT round-trips the same
        // through the parser and is simpler to emit for one field.
        let mut buf = Vec::new();
        buf.push(0x02);
        push_varuint(&mut buf, body.len() as u64);
        buf.extend_from_slice(body);
        buf
    }

    fn push_varuint(out: &mut Vec<u8>, v: u64) {
        // Minimal CB VarUInt encoder (matches spec §2).
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
        let prefix: u8 = if bytes_needed == 9 {
            0xFF
        } else {
            (((1u16 << extra) - 1) << (8 - extra)) as u8
        };
        let head_bits = (8 - extra) as u32;
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
}
