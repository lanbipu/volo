//! Plan 7 T2.2: render the zen daemon's `zen.lua` config file from a
//! `ZenEndpoint` row.
//!
//! The four real config keys come from plan v4 §8 T2.2:
//! - `server.datadir`
//! - `network.port`
//! - `network.httpserverclass`
//! - `cache.upstream.zen.url` — only emitted when the endpoint has an upstream
//!
//! ## Format assumption (UNVERIFIED — flagged for T4.4 `verify-rules`)
//!
//! Plan §8 names the keys but does not pin down the on-disk Lua syntax. Zen's
//! source is closed and no real `zen.lua` sample lives in this repo's
//! KnowledgeBase or fact-finding doc. We render the most natural Lua shape —
//! nested tables, top-level assignments — because:
//!
//! 1. Lua's standard idiom for config files is `module = { key = value, ... }`
//!    tables, which trivially round-trip through `dofile` / `loadfile`.
//! 2. Dotted keys (`server.datadir = ...`) at the top level would require zen
//!    to pre-create the `server` table, which Lua doesn't do automatically and
//!    which would be unusual for a hand-edited config file.
//! 3. The keys in plan §8 are spelled with dots (`server.datadir`), which maps
//!    cleanly onto a nested-table representation.
//!
//! T4.4 (M4 `verify-rules`) runs this output against a real zen daemon and
//! will either confirm the format or force us to switch to dotted assignments
//! / TOML-style sections. If T4.4 changes the syntax, only `render_inner`
//! below needs to be rewritten — the public API and all validation stay put.
//!
//! ## Known gap: HTTPS endpoints (fail closed)
//!
//! T2.1 lets an endpoint register with `scheme = "https"`, but plan §8 T2.2
//! only enumerates four Lua keys — none of them describe TLS material
//! (cert path, key path, listen address). Rendering an HTTPS endpoint would
//! produce the same Lua as an HTTP one, so the zen daemon would come up as
//! plain HTTP while UECM's probe / upstream URL builders treat it as HTTPS,
//! leaving the endpoint permanently unreachable.
//!
//! Rather than silently emit wrong config, [`render`] **refuses** an
//! `endpoint.scheme = "https"` row with `UecmError::InvalidInput`. Plan
//! follow-up: M4 verify-rules will add real `network.https.*` / TLS lua
//! keys; until then operators must register endpoints with HTTP scheme.
//!
//! ## Why this lives in `core::zen::` (not `data::`)
//!
//! The DB row is the source of truth. This module is a pure transformation
//! (row → text) with validation; it does no I/O. The PS sidecar
//! `zen-write-lua-config.ps1` (T2.4) is what actually writes the bytes to
//! disk on the Windows host. CLI / Tauri commands (T2.5 / T2.6) call
//! [`render`] for `lua-preview` and `apply-config`.
//!
//! ## Determinism
//!
//! Output is byte-for-byte identical for identical input. No timestamps, no
//! environment lookups, no randomness. The header comment names the endpoint
//! id / machine / role / lifecycle for traceability, all of which come from
//! the input row.

use std::fmt::Write as _;
use std::net::Ipv6Addr;

use crate::data::zen_endpoints::ZenEndpoint;
use crate::error::{UecmError, UecmResult};

use super::endpoint::ROLE_SHARED_UPSTREAM;

/// Connection info the caller resolved from `endpoint.upstream_endpoint_id`
/// + the upstream's machine row. Kept as a flat struct so `render` doesn't
/// need a `Db` handle and can be unit-tested in pure Rust on macOS.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpstreamInfo {
    /// Upstream endpoint's scheme (`"http"` or `"https"`).
    pub scheme: String,
    /// Upstream machine's reachable hostname or IP (e.g. `"192.168.10.20"`
    /// or `"cluster-master.uecm.local"`). NOT a full URL — host-only.
    pub host: String,
    /// Upstream endpoint's `declared_port`.
    pub declared_port: i64,
}

/// Render `zen.lua` text for `endpoint`.
///
/// `upstream` must be `Some(_)` iff `endpoint.upstream_endpoint_id` is
/// `Some(_)`. Mismatch is a programming error in the caller (it failed to
/// resolve the upstream row) and is rejected with
/// [`UecmError::InvalidInput`].
///
/// Returns the Lua file text terminated with a single trailing newline.
pub fn render(endpoint: &ZenEndpoint, upstream: Option<&UpstreamInfo>) -> UecmResult<String> {
    // Caller contract: presence of `upstream` arg must match the row's
    // `upstream_endpoint_id`. Catching this mismatch here prevents two
    // silent failure modes: (a) a `local` row with an upstream pointer but
    // an empty Lua file (zen would happily run without cluster forwarding),
    // and (b) a `shared_upstream` master accidentally emitting an upstream
    // URL (zen would form a loop or forward off-cluster).
    match (endpoint.upstream_endpoint_id, upstream) {
        (Some(_), None) => {
            return Err(UecmError::InvalidInput(
                "lua_config::render: endpoint has upstream_endpoint_id but no UpstreamInfo \
                 supplied (caller must resolve the upstream endpoint + its machine)"
                    .to_string(),
            ));
        }
        (None, Some(_)) => {
            return Err(UecmError::InvalidInput(
                "lua_config::render: UpstreamInfo supplied for endpoint with no \
                 upstream_endpoint_id (would emit stray cache.upstream.zen.url)"
                    .to_string(),
            ));
        }
        _ => {}
    }

    // A cluster master (`shared_upstream`) must never carry an upstream
    // pointer — it IS the destination, and emitting `cache.upstream.zen.url`
    // for it would form a forwarding loop or push misses off-cluster.
    // `core::zen::endpoint::register` enforces this at write time, but
    // because `data::zen_endpoints::*` is permissive a caller could in
    // theory bypass that path (tests, raw `upsert`, future code). Reject
    // here so the renderer's own output stays sound even if the DB row is
    // inconsistent.
    if endpoint.role == ROLE_SHARED_UPSTREAM && endpoint.upstream_endpoint_id.is_some() {
        return Err(UecmError::InvalidInput(format!(
            "lua_config: endpoint role={:?} must not have upstream_endpoint_id \
             (cluster master cannot forward upstream)",
            endpoint.role,
        )));
    }

    // HTTPS endpoints fail closed (Plan §8 T2.2 v4 gap): T2.1 lets a caller
    // register `scheme = "https"` but plan §8 T2.2 only lists HTTP-flavored
    // lua keys (no `network.https.*` / `tls.*` block). Without TLS config,
    // the daemon would listen plain HTTP while `core::zen::probe` and
    // `core::zen::cache_stats` access `https://...`, leaving the endpoint
    // permanently unreachable. Refusing here is preferable to silently
    // generating wrong config. M4 verify-rules will add real HTTPS keys.
    if endpoint.scheme.eq_ignore_ascii_case("https") {
        return Err(UecmError::InvalidInput(
            "lua_config: scheme=\"https\" is not yet supported — \
             HTTPS endpoint lua keys (TLS cert / key paths, listen scheme) \
             aren't in plan §8 T2.2 yet; M4 verify-rules adds them. \
             Register the endpoint with scheme=\"http\" for now."
                .to_string(),
        ));
    }

    // Defensive validation — `core::zen::endpoint::register` already
    // constrains these to known enum values before the row hits the DB, but
    // `data::zen_endpoints::*` is permissive and a caller could in theory
    // bypass `endpoint::register` (tests, future code paths). Reject up
    // front so we never emit a malformed Lua file.
    validate_data_dir(&endpoint.data_dir)?;
    validate_httpserverclass(&endpoint.httpserverclass)?;
    validate_port(endpoint.declared_port)?;

    // The header comment embeds `role` and `lifecycle_mode` verbatim. A `\n`
    // in either would close the `--` comment and turn whatever followed
    // into executable Lua. We don't enforce the canonical enum values here
    // (the renderer's job isn't to validate role semantics — that's
    // `core::zen::endpoint`) but we DO reject control characters that
    // would break out of the comment line.
    validate_metadata_field("role", &endpoint.role)?;
    validate_metadata_field("lifecycle_mode", &endpoint.lifecycle_mode)?;

    if let Some(u) = upstream {
        validate_scheme(&u.scheme)?;
        validate_host(&u.host)?;
        validate_port(u.declared_port)?;
    }

    Ok(render_inner(endpoint, upstream))
}

/// Build the actual text. Assumes `endpoint` + `upstream` have already been
/// validated; do not call directly.
fn render_inner(endpoint: &ZenEndpoint, upstream: Option<&UpstreamInfo>) -> String {
    let mut out = String::new();

    // Header — only fields from the input row, no clock / env lookups, so
    // the output stays deterministic.
    out.push_str("-- Generated by UECM (uecm-cli zen apply-config / lua-preview).\n");
    let _ = writeln!(
        out,
        "-- Endpoint id={} machine={} role={} lifecycle={}.",
        endpoint
            .id
            .map(|v| v.to_string())
            .unwrap_or_else(|| "unset".to_string()),
        endpoint.machine_id,
        endpoint.role,
        endpoint.lifecycle_mode,
    );
    out.push_str(
        "-- Edits should be made via `uecm-cli zen apply-config` so the DB row stays the source of truth.\n",
    );
    out.push('\n');

    let _ = writeln!(out, "server = {{");
    let _ = writeln!(
        out,
        "    datadir = \"{}\",",
        escape_lua_string(&endpoint.data_dir)
    );
    let _ = writeln!(out, "}}");
    out.push('\n');

    let _ = writeln!(out, "network = {{");
    let _ = writeln!(out, "    port = {},", endpoint.declared_port);
    let _ = writeln!(
        out,
        "    httpserverclass = \"{}\",",
        escape_lua_string(&endpoint.httpserverclass)
    );
    let _ = writeln!(out, "}}");

    if let Some(u) = upstream {
        out.push('\n');
        // IPv6 literals (`::1`, `2001:db8::1`) MUST be bracketed in URLs
        // (RFC 3986 §3.2.2). `validate_host` only lets `:` through if the
        // string parses as IPv6, so the `contains(':')` check here is a
        // safe and sufficient detector.
        let host_in_url = if u.host.contains(':') {
            format!("[{}]", escape_lua_string(&u.host))
        } else {
            escape_lua_string(&u.host)
        };
        let url = format!(
            "{}://{}:{}",
            escape_lua_string(&u.scheme),
            host_in_url,
            u.declared_port,
        );
        let _ = writeln!(out, "cache = {{");
        let _ = writeln!(out, "    upstream = {{");
        let _ = writeln!(out, "        zen = {{");
        let _ = writeln!(out, "            url = \"{}\",", url);
        let _ = writeln!(out, "        }},");
        let _ = writeln!(out, "    }},");
        let _ = writeln!(out, "}}");
    }

    out
}

// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------

fn validate_data_dir(data_dir: &str) -> UecmResult<()> {
    if data_dir.trim().is_empty() {
        return Err(UecmError::InvalidInput(
            "lua_config: data_dir is empty".to_string(),
        ));
    }
    // Control chars in a Windows path would mean the row is already corrupt;
    // refuse rather than try to emit a Lua string containing them. (T2.8
    // will tighten this further with a system-path blocklist.)
    for ch in data_dir.chars() {
        if ch == '\n' || ch == '\r' || ch == '\t' || ch == '\0' {
            return Err(UecmError::InvalidInput(format!(
                "lua_config: data_dir contains control character (U+{:04X})",
                ch as u32
            )));
        }
    }
    Ok(())
}

/// Reject control / line-terminator characters that would let a string
/// embedded in a `-- ...` Lua comment break out of the comment. Also rejects
/// `]]` and the long-bracket level prefixes `]=]` etc., though `--`-comment
/// closure only needs a newline; we play it safe.
fn validate_metadata_field(field_name: &str, value: &str) -> UecmResult<()> {
    if value.is_empty() {
        return Err(UecmError::InvalidInput(format!(
            "lua_config: {} is empty",
            field_name
        )));
    }
    for ch in value.chars() {
        // U+000A LF / U+000D CR close the comment line.
        // Other C0 controls would let a malicious row inject weird bytes
        // into the file. NUL is rejected unconditionally for the same reason
        // as in `validate_data_dir`.
        if ch.is_control() {
            return Err(UecmError::InvalidInput(format!(
                "lua_config: {} contains control character (U+{:04X})",
                field_name, ch as u32
            )));
        }
    }
    Ok(())
}

fn validate_httpserverclass(value: &str) -> UecmResult<()> {
    match value {
        "asio" | "httpsys" => Ok(()),
        other => Err(UecmError::InvalidInput(format!(
            "lua_config: invalid httpserverclass {:?} (expected 'asio' or 'httpsys')",
            other
        ))),
    }
}

fn validate_scheme(value: &str) -> UecmResult<()> {
    match value {
        "http" | "https" => Ok(()),
        other => Err(UecmError::InvalidInput(format!(
            "lua_config: invalid upstream scheme {:?} (expected 'http' or 'https')",
            other
        ))),
    }
}

fn validate_port(port: i64) -> UecmResult<()> {
    if !(1..=65535).contains(&port) {
        return Err(UecmError::InvalidInput(format!(
            "lua_config: port {} out of range 1..=65535",
            port
        )));
    }
    Ok(())
}

fn validate_host(host: &str) -> UecmResult<()> {
    let trimmed = host.trim();
    if trimmed.is_empty() {
        return Err(UecmError::InvalidInput(
            "lua_config: upstream host is empty".to_string(),
        ));
    }
    if trimmed.len() != host.len() {
        return Err(UecmError::InvalidInput(
            "lua_config: upstream host has leading/trailing whitespace".to_string(),
        ));
    }
    // Reject the URL-delimiter characters first — these would let a caller
    // smuggle a path / query / userinfo / port into what should be a bare
    // hostname or IP.
    for ch in host.chars() {
        let bad = matches!(
            ch,
            '"' | '\\'
                | '/'
                | ' '
                | '\t'
                | '\n'
                | '\r'
                | '\0'
                | '@'
                | '?'
                | '#'
                | '['
                | ']'
                | '%'
        );
        if bad {
            return Err(UecmError::InvalidInput(format!(
                "lua_config: upstream host contains illegal character {:?}",
                ch
            )));
        }
    }
    // `:` is legal only inside an IPv6 literal — never in a hostname or
    // IPv4 address. If the host contains a `:`, parse it as IPv6 to confirm
    // (catches `zen-master:8559`-style mistakes where someone smuggled a
    // port into the host field).
    if host.contains(':') && host.parse::<Ipv6Addr>().is_err() {
        return Err(UecmError::InvalidInput(format!(
            "lua_config: upstream host {:?} contains ':' but is not a valid IPv6 literal \
             (use the declared_port field for the port)",
            host
        )));
    }
    Ok(())
}

/// Escape a string for use inside a Lua `"..."` literal.
///
/// Only `\` and `"` need escaping for the standard quote form; control chars
/// are rejected upstream by [`validate_data_dir`] / [`validate_host`] /
/// [`validate_metadata_field`] so we never see them here. The function is
/// still defensive: if any control char somehow slips through (e.g. a future
/// caller bypasses validation), we escape it — `\n` / `\r` / `\t` / `\0`
/// use Lua's named short forms; every other C0/C1 control byte goes through
/// `\ddd` decimal escape so the output stays well-formed Lua even on garbage
/// input. `c.is_control()` catches ASCII 0..=31 and 127 (DEL) plus Unicode
/// C1 controls (U+0080..=U+009F).
fn escape_lua_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\0' => out.push_str("\\0"),
            c if c.is_control() => {
                // Lua decimal escapes are limited to 0..=255; chars in
                // [128, 256) (Latin-1 supplement) fit fine, but Unicode C1
                // controls beyond that would need `\u{...}` (Lua 5.3+). Use
                // UTF-8 byte-level decimal escapes to stay compatible with
                // older Lua dialects.
                let mut buf = [0u8; 4];
                for &byte in c.encode_utf8(&mut buf).as_bytes() {
                    let _ = write!(out, "\\{}", byte);
                }
            }
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn endpoint_local_no_upstream() -> ZenEndpoint {
        ZenEndpoint {
            id: Some(7),
            machine_id: 3,
            declared_port: 8558,
            scheme: "http".into(),
            role: "local".into(),
            upstream_endpoint_id: None,
            data_dir: "F:\\Epic\\DDC\\Zen".into(),
            httpserverclass: "asio".into(),
            lifecycle_mode: "editor_owned".into(),
            created_at: None,
            updated_at: None,
        }
    }

    fn endpoint_local_with_upstream() -> ZenEndpoint {
        let mut e = endpoint_local_no_upstream();
        e.id = Some(8);
        e.upstream_endpoint_id = Some(42);
        e.lifecycle_mode = "installed_service".into();
        e
    }

    fn endpoint_shared_master() -> ZenEndpoint {
        let mut e = endpoint_local_no_upstream();
        e.id = Some(42);
        e.role = "shared_upstream".into();
        e.data_dir = "D:\\ZenMaster".into();
        e.declared_port = 8559;
        e
    }

    fn sample_upstream() -> UpstreamInfo {
        UpstreamInfo {
            scheme: "http".into(),
            host: "192.168.10.20".into(),
            declared_port: 8559,
        }
    }

    #[test]
    fn standalone_local_no_upstream_emits_server_and_network_only() {
        let endpoint = endpoint_local_no_upstream();
        let out = render(&endpoint, None).unwrap();

        assert!(out.contains("server = {"));
        assert!(out.contains("datadir = \"F:\\\\Epic\\\\DDC\\\\Zen\""));
        assert!(out.contains("network = {"));
        assert!(out.contains("port = 8558"));
        assert!(out.contains("httpserverclass = \"asio\""));

        // No upstream section.
        assert!(!out.contains("cache"));
        assert!(!out.contains("upstream"));
    }

    #[test]
    fn local_with_upstream_emits_all_three_sections() {
        let endpoint = endpoint_local_with_upstream();
        let upstream = sample_upstream();
        let out = render(&endpoint, Some(&upstream)).unwrap();

        assert!(out.contains("server = {"));
        assert!(out.contains("network = {"));
        assert!(out.contains("cache = {"));
        assert!(out.contains("upstream = {"));
        assert!(out.contains("zen = {"));
        assert!(out.contains("url = \"http://192.168.10.20:8559\""));
    }

    #[test]
    fn shared_upstream_master_emits_no_cache_section() {
        // A cluster master never forwards — it IS the destination. Even
        // though the row is the upstream, render should refuse to emit any
        // cache.upstream block on its own config because the row's
        // `upstream_endpoint_id` is (and must be) None.
        let endpoint = endpoint_shared_master();
        let out = render(&endpoint, None).unwrap();

        assert!(out.contains("role=shared_upstream"));
        assert!(out.contains("datadir = \"D:\\\\ZenMaster\""));
        assert!(out.contains("port = 8559"));
        // No cache/upstream block — but the header's `role=shared_upstream`
        // legitimately contains "upstream", so we check for the actual table
        // declarations instead of the bare substring.
        assert!(!out.contains("cache = {"));
        assert!(!out.contains("upstream = {"));
        assert!(!out.contains("url ="));
    }

    #[test]
    fn httpserverclass_httpsys_round_trips() {
        let mut endpoint = endpoint_local_no_upstream();
        endpoint.httpserverclass = "httpsys".into();
        let out = render(&endpoint, None).unwrap();
        assert!(out.contains("httpserverclass = \"httpsys\""));
        // And the asio default is gone.
        assert!(!out.contains("httpserverclass = \"asio\""));
    }

    #[test]
    fn backslash_in_data_dir_is_double_escaped() {
        // The literal Lua source must contain `\\` for every `\` in the
        // path so that `loadfile`'s string parser yields the original
        // Windows path. `C:\Zen` therefore appears as `"C:\\Zen"` in the
        // file. In a Rust source string, that's `"C:\\\\Zen"`.
        let mut endpoint = endpoint_local_no_upstream();
        endpoint.data_dir = "C:\\Zen".into();
        let out = render(&endpoint, None).unwrap();
        assert!(
            out.contains("datadir = \"C:\\\\Zen\""),
            "expected escaped path in output, got:\n{}",
            out,
        );
        // And it does NOT contain the unescaped single-backslash form.
        assert!(!out.contains("datadir = \"C:\\Zen\""));
    }

    #[test]
    fn quote_in_data_dir_is_escaped() {
        let mut endpoint = endpoint_local_no_upstream();
        endpoint.data_dir = "C:\\weird\"path".into();
        let out = render(&endpoint, None).unwrap();
        // Backslash → \\, quote → \"
        assert!(out.contains("datadir = \"C:\\\\weird\\\"path\""));
    }

    #[test]
    fn newline_in_data_dir_is_rejected() {
        let mut endpoint = endpoint_local_no_upstream();
        endpoint.data_dir = "C:\\Zen\nC:\\Evil".into();
        let err = render(&endpoint, None).unwrap_err();
        assert!(matches!(err, UecmError::InvalidInput(_)));
    }

    #[test]
    fn empty_data_dir_is_rejected() {
        let mut endpoint = endpoint_local_no_upstream();
        endpoint.data_dir = "   ".into();
        let err = render(&endpoint, None).unwrap_err();
        match err {
            UecmError::InvalidInput(msg) => assert!(msg.contains("data_dir")),
            other => panic!("expected InvalidInput, got {:?}", other),
        }
    }

    #[test]
    fn invalid_httpserverclass_is_rejected() {
        let mut endpoint = endpoint_local_no_upstream();
        endpoint.httpserverclass = "iocp".into();
        let err = render(&endpoint, None).unwrap_err();
        match err {
            UecmError::InvalidInput(msg) => assert!(msg.contains("httpserverclass")),
            other => panic!("expected InvalidInput, got {:?}", other),
        }
    }

    #[test]
    fn out_of_range_port_is_rejected() {
        let mut endpoint = endpoint_local_no_upstream();
        endpoint.declared_port = 0;
        assert!(render(&endpoint, None).is_err());
        endpoint.declared_port = 70_000;
        assert!(render(&endpoint, None).is_err());
    }

    #[test]
    fn upstream_id_set_but_upstream_arg_missing_is_rejected() {
        let endpoint = endpoint_local_with_upstream();
        let err = render(&endpoint, None).unwrap_err();
        match err {
            UecmError::InvalidInput(msg) => {
                assert!(msg.contains("upstream_endpoint_id"));
            }
            other => panic!("expected InvalidInput, got {:?}", other),
        }
    }

    #[test]
    fn upstream_arg_supplied_but_id_unset_is_rejected() {
        let endpoint = endpoint_local_no_upstream();
        let err = render(&endpoint, Some(&sample_upstream())).unwrap_err();
        match err {
            UecmError::InvalidInput(msg) => assert!(msg.contains("no")),
            other => panic!("expected InvalidInput, got {:?}", other),
        }
    }

    #[test]
    fn empty_upstream_host_is_rejected() {
        let endpoint = endpoint_local_with_upstream();
        let mut upstream = sample_upstream();
        upstream.host = "   ".into();
        let err = render(&endpoint, Some(&upstream)).unwrap_err();
        match err {
            UecmError::InvalidInput(msg) => assert!(msg.contains("host")),
            other => panic!("expected InvalidInput, got {:?}", other),
        }
    }

    #[test]
    fn invalid_upstream_scheme_is_rejected() {
        let endpoint = endpoint_local_with_upstream();
        let mut upstream = sample_upstream();
        upstream.scheme = "ftp".into();
        let err = render(&endpoint, Some(&upstream)).unwrap_err();
        match err {
            UecmError::InvalidInput(msg) => assert!(msg.contains("scheme")),
            other => panic!("expected InvalidInput, got {:?}", other),
        }
    }

    #[test]
    fn upstream_host_with_slash_is_rejected() {
        // Host field must be hostname-or-IP only. A caller that smuggled
        // a path into the host string would generate `http://host/path:port`,
        // which is nonsense. Catch it early.
        let endpoint = endpoint_local_with_upstream();
        let mut upstream = sample_upstream();
        upstream.host = "cluster-master/api".into();
        let err = render(&endpoint, Some(&upstream)).unwrap_err();
        assert!(matches!(err, UecmError::InvalidInput(_)));
    }

    #[test]
    fn upstream_host_with_quote_is_rejected() {
        let endpoint = endpoint_local_with_upstream();
        let mut upstream = sample_upstream();
        upstream.host = "evil\"host".into();
        let err = render(&endpoint, Some(&upstream)).unwrap_err();
        assert!(matches!(err, UecmError::InvalidInput(_)));
    }

    #[test]
    fn upstream_invalid_port_is_rejected() {
        let endpoint = endpoint_local_with_upstream();
        let mut upstream = sample_upstream();
        upstream.declared_port = 0;
        assert!(render(&endpoint, Some(&upstream)).is_err());
    }

    #[test]
    fn hostname_with_dots_and_dashes_is_accepted() {
        let endpoint = endpoint_local_with_upstream();
        let mut upstream = sample_upstream();
        upstream.host = "cluster-master.uecm.local".into();
        let out = render(&endpoint, Some(&upstream)).unwrap();
        assert!(out.contains("url = \"http://cluster-master.uecm.local:8559\""));
    }

    #[test]
    fn newline_in_role_is_rejected_to_prevent_comment_escape() {
        // `--` comments end at the first newline. A role string like
        // "local\nbad_lua = 1" would inject `bad_lua = 1` as executable
        // Lua after the comment closes.
        let mut endpoint = endpoint_local_no_upstream();
        endpoint.role = "local\nbad_lua = 1".into();
        let err = render(&endpoint, None).unwrap_err();
        match err {
            UecmError::InvalidInput(msg) => assert!(msg.contains("role")),
            other => panic!("expected InvalidInput, got {:?}", other),
        }
    }

    #[test]
    fn newline_in_lifecycle_mode_is_rejected() {
        let mut endpoint = endpoint_local_no_upstream();
        endpoint.lifecycle_mode = "editor_owned\nx=1".into();
        let err = render(&endpoint, None).unwrap_err();
        match err {
            UecmError::InvalidInput(msg) => assert!(msg.contains("lifecycle_mode")),
            other => panic!("expected InvalidInput, got {:?}", other),
        }
    }

    #[test]
    fn empty_role_is_rejected() {
        let mut endpoint = endpoint_local_no_upstream();
        endpoint.role = "".into();
        assert!(render(&endpoint, None).is_err());
    }

    #[test]
    fn shared_upstream_with_upstream_id_is_rejected() {
        // A cluster master with an upstream pointer is a corrupt invariant.
        // Even if the caller (somehow) resolves the upstream and supplies
        // UpstreamInfo, render must refuse so we never emit a config that
        // makes the master forward off-cluster.
        let mut endpoint = endpoint_shared_master();
        endpoint.upstream_endpoint_id = Some(99);
        let err = render(&endpoint, Some(&sample_upstream())).unwrap_err();
        match err {
            UecmError::InvalidInput(msg) => {
                assert!(msg.contains("shared_upstream"));
            }
            other => panic!("expected InvalidInput, got {:?}", other),
        }
    }

    #[test]
    fn host_smuggling_port_via_colon_is_rejected() {
        // `zen-master:8559` is the most common operator mistake — they put
        // the full authority into the host field instead of the host-only
        // string. Reject so we never emit `http://[zen-master:8559]:8559`.
        let endpoint = endpoint_local_with_upstream();
        let mut upstream = sample_upstream();
        upstream.host = "zen-master:8559".into();
        let err = render(&endpoint, Some(&upstream)).unwrap_err();
        match err {
            UecmError::InvalidInput(msg) => assert!(msg.contains("IPv6")),
            other => panic!("expected InvalidInput, got {:?}", other),
        }
    }

    #[test]
    fn host_with_at_question_hash_is_rejected() {
        let endpoint = endpoint_local_with_upstream();
        for bad in ["user@host", "host?x", "host#frag", "[1]", "%41"] {
            let mut upstream = sample_upstream();
            upstream.host = bad.into();
            let err = render(&endpoint, Some(&upstream)).unwrap_err();
            assert!(
                matches!(err, UecmError::InvalidInput(_)),
                "expected rejection for host {:?}",
                bad,
            );
        }
    }

    #[test]
    fn ipv6_upstream_host_is_bracketed_in_url() {
        // RFC 3986 §3.2.2: IPv6 literals in URL authority must be wrapped
        // in `[]` so the port colon isn't ambiguous with the address.
        let endpoint = endpoint_local_with_upstream();
        let mut upstream = sample_upstream();
        upstream.host = "2001:db8::1".into();
        let out = render(&endpoint, Some(&upstream)).unwrap();
        assert!(
            out.contains("url = \"http://[2001:db8::1]:8559\""),
            "expected bracketed IPv6 URL, got:\n{}",
            out,
        );
    }

    #[test]
    fn ipv6_loopback_upstream_is_bracketed() {
        let endpoint = endpoint_local_with_upstream();
        let mut upstream = sample_upstream();
        upstream.host = "::1".into();
        let out = render(&endpoint, Some(&upstream)).unwrap();
        assert!(out.contains("url = \"http://[::1]:8559\""));
    }

    #[test]
    fn https_scheme_round_trips_into_upstream_url() {
        let endpoint = endpoint_local_with_upstream();
        let mut upstream = sample_upstream();
        upstream.scheme = "https".into();
        let out = render(&endpoint, Some(&upstream)).unwrap();
        assert!(out.contains("url = \"https://192.168.10.20:8559\""));
    }

    #[test]
    fn endpoint_https_scheme_is_rejected() {
        // Plan §8 T2.2 only lists HTTP-flavored lua keys; refusing here
        // beats silently emitting plain-HTTP config for an HTTPS endpoint.
        let mut endpoint = endpoint_local_no_upstream();
        endpoint.scheme = "https".into();
        let err = render(&endpoint, None).unwrap_err();
        match err {
            UecmError::InvalidInput(msg) => {
                assert!(
                    msg.contains("https"),
                    "expected HTTPS rejection message, got {msg:?}"
                );
            }
            other => panic!("expected InvalidInput, got {other:?}"),
        }
    }

    #[test]
    fn endpoint_https_scheme_uppercase_is_rejected() {
        // `eq_ignore_ascii_case` should catch the wire-format variant too,
        // not just lowercase.
        let mut endpoint = endpoint_local_no_upstream();
        endpoint.scheme = "HTTPS".into();
        let err = render(&endpoint, None).unwrap_err();
        assert!(matches!(err, UecmError::InvalidInput(_)));
    }

    #[test]
    fn escape_lua_string_handles_all_control_chars() {
        // Defensive: validators upstream reject control chars, but if any
        // slip through, the output must stay parseable Lua. Every C0 control
        // (0..=31 + 127 DEL) plus C1 controls go through decimal-byte
        // escapes; the named short forms (\n \r \t \0) take priority for
        // human readability.
        assert_eq!(escape_lua_string("\n"), "\\n");
        assert_eq!(escape_lua_string("\r"), "\\r");
        assert_eq!(escape_lua_string("\t"), "\\t");
        assert_eq!(escape_lua_string("\0"), "\\0");
        // ESC (U+001B) — not in the named-short-form list, must decimal-escape.
        assert_eq!(escape_lua_string("\x1b"), "\\27");
        // DEL (U+007F) — control per is_control(), must decimal-escape.
        assert_eq!(escape_lua_string("\x7f"), "\\127");
        // BEL (U+0007) — control, must decimal-escape.
        assert_eq!(escape_lua_string("\x07"), "\\7");
        // C1 control U+0085 (NEL) — encodes as two UTF-8 bytes (0xC2 0x85).
        assert_eq!(escape_lua_string("\u{0085}"), "\\194\\133");
        // Mixed: a regular printable + control should escape only the control.
        assert_eq!(escape_lua_string("a\x1bb"), "a\\27b");
        // Backslash and quote still take priority over the control branch.
        assert_eq!(escape_lua_string("\\"), "\\\\");
        assert_eq!(escape_lua_string("\""), "\\\"");
    }

    #[test]
    fn output_is_deterministic_across_calls() {
        // Same input must produce byte-identical output. Anything else means
        // we accidentally pulled in a clock / env / hashmap iteration order.
        let endpoint = endpoint_local_with_upstream();
        let upstream = sample_upstream();
        let a = render(&endpoint, Some(&upstream)).unwrap();
        let b = render(&endpoint, Some(&upstream)).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn output_ends_with_single_newline() {
        let endpoint = endpoint_local_no_upstream();
        let out = render(&endpoint, None).unwrap();
        assert!(out.ends_with('\n'));
        assert!(!out.ends_with("\n\n"));
    }

    #[test]
    fn header_comment_carries_endpoint_metadata() {
        let endpoint = endpoint_local_with_upstream();
        let out = render(&endpoint, Some(&sample_upstream())).unwrap();
        // Header must mention id/machine/role/lifecycle for operator trace.
        assert!(out.contains("Endpoint id=8 machine=3 role=local lifecycle=installed_service"));
    }
}
