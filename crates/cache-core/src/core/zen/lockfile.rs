//! Decoder for zen daemon's `<data-dir>\.lock` file.
//!
//! The zen daemon writes a Compact Binary (CB) object recording the live
//! process's owner-pid, effective HTTP port, executable path, and assorted
//! launch metadata. The CLI `zen status --data-dir <dir>` claims to read this
//! but in practice returns "No Zen state found" even when the file is present
//! (Plan v4 T0.4b fact-find, `docs/research/zen-launch-mechanism.md` §5.2), so
//! Volo reads the file directly using [`cb_parser`].
//!
//! ## Scope
//!
//! This module owns only the in-memory decoder. The PS sidecar that snatches
//! the bytes off disk while zen holds an exclusive lock (Win32 `BackupRead` +
//! `SeBackupPrivilege`) is T1.8. Wiring the parsed [`LockfileInfo`] into the
//! probe pipeline is T1.4. Real-file integration acceptance lands on a Windows
//! host in T1.11.
//!
//! ## Field-name guesswork
//!
//! Until we have a real `.lock` byte-dump we don't know which exact names
//! zen's writer emits. We accept any of a small set of plausible candidates
//! ([`PORT_NAMES`], [`PID_NAMES`], [`EXE_NAMES`]) in case-insensitive
//! first-match-wins order. The order also encodes a preference (e.g.
//! `EffectivePort` is preferred over `BasePort` because plan §1.1 calls for
//! the actual bound port, not the requested one).

use std::fmt::Write as _;

use thiserror::Error;

use crate::core::zen::cb_parser::{self, CbValue};

// -----------------------------------------------------------------------------
// Field name candidates
//
// Order matters: first hit wins. Put the most specific / preferred name first.
// -----------------------------------------------------------------------------

// `effective_port` must mean "the port the daemon actually bound" — auto-pick
// (`--port 0`) makes BasePort the *requested* port, not the bound one, so we
// won't fall back to it. If the lockfile lacks EffectivePort / Port the field
// stays None ("unknown") rather than alias the requested value.
const PORT_NAMES: &[&str] = &["EffectivePort", "Port"];

// `OwnerPid` is the sponsor UE editor PID (the `--owner-pid <N>` flag visible
// in zen's command line), NOT the zenserver daemon PID. Aliasing it would let
// liveness checks target the wrong process. Keep this list strictly to fields
// that describe the daemon itself.
const PID_NAMES: &[&str] = &["Pid", "ProcessId"];
const EXE_NAMES: &[&str] = &["Executable", "ServerPath", "ExePath", "ImagePath"];

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct LockfileInfo {
    /// Effective HTTP port the daemon bound (may differ from declared port if
    /// `--port 0` auto-pick was used). Maps to plan §1.1
    /// `zen_probes.effective_port`.
    pub effective_port: Option<u16>,

    /// OS pid of the zenserver process.
    pub pid: Option<u32>,

    /// Absolute path of the executable that owns this data-dir,
    /// e.g. `C:\Users\...\Common\Zen\Install\zenserver.exe`.
    pub executable: Option<String>,

    /// All recognised top-level fields from the lockfile, kept verbatim in
    /// wire order so future zen revisions adding fields surface in probes
    /// without parser changes. Maps `field name -> textual representation`.
    pub fields: Vec<(String, String)>,

    /// Set when one or more top-level fields landed on the parser's
    /// [`CbValue::Unknown`] branch (DateTime/TimeSpan/Custom*/etc.). The
    /// field is still recorded in [`Self::fields`] as a hex summary so the
    /// value survives for diagnostics.
    pub has_unknown_fields: bool,
}

#[derive(Debug, Error)]
pub enum LockfileError {
    #[error("CB parse failed: {0}")]
    Parse(#[from] cb_parser::CbError),
    #[error("lockfile root must be a CB object, got {0}")]
    NotAnObject(&'static str),
}

pub type LockfileResult<T> = Result<T, LockfileError>;

// -----------------------------------------------------------------------------
// Entry point
// -----------------------------------------------------------------------------

/// Parse a raw `.lock` CB blob (already read from disk by the PS sidecar).
///
/// Robust to unknown / extra fields: missing well-known fields produce `None`
/// rather than error, and unrecognised types are surfaced via
/// [`LockfileInfo::has_unknown_fields`] without aborting the parse.
pub fn parse(bytes: &[u8]) -> LockfileResult<LockfileInfo> {
    let (root, _consumed) = cb_parser::parse(bytes)?;
    let fields_owned = match root {
        CbValue::Object(f) => f,
        other => return Err(LockfileError::NotAnObject(value_kind(&other))),
    };

    let mut info = LockfileInfo {
        effective_port: None,
        pid: None,
        executable: None,
        fields: Vec::with_capacity(fields_owned.len()),
        has_unknown_fields: false,
    };

    for (name, value) in &fields_owned {
        if matches!(value, CbValue::Unknown { .. }) {
            info.has_unknown_fields = true;
        }
        info.fields.push((name.clone(), format_value(value)));
    }

    info.effective_port = lookup_u16(&fields_owned, PORT_NAMES);
    info.pid = lookup_u32(&fields_owned, PID_NAMES);
    info.executable = lookup_string(&fields_owned, EXE_NAMES);

    Ok(info)
}

// -----------------------------------------------------------------------------
// Lookup helpers
// -----------------------------------------------------------------------------

/// Find the first field whose name matches any candidate in `names`
/// (case-insensitive). Returns the matched value reference.
fn lookup<'a>(
    fields: &'a [(String, CbValue)],
    names: &[&str],
) -> Option<&'a CbValue> {
    for candidate in names {
        for (name, value) in fields {
            if name.eq_ignore_ascii_case(candidate) {
                return Some(value);
            }
        }
    }
    None
}

fn lookup_u16(fields: &[(String, CbValue)], names: &[&str]) -> Option<u16> {
    let v = lookup(fields, names)?;
    coerce_u64(v).and_then(|n| u16::try_from(n).ok())
}

fn lookup_u32(fields: &[(String, CbValue)], names: &[&str]) -> Option<u32> {
    let v = lookup(fields, names)?;
    coerce_u64(v).and_then(|n| u32::try_from(n).ok())
}

fn lookup_string(fields: &[(String, CbValue)], names: &[&str]) -> Option<String> {
    let v = lookup(fields, names)?;
    v.as_str().map(|s| s.to_string())
}

/// Coerce a CB value to a u64. Accepts both unsigned-int and decimal-string
/// representations; zen's `/health/info` mixes the two (e.g. top-level `Port`
/// is `Uint(8558)`, `RuntimeConfig.EffectivePort` is `String("8558")`).
fn coerce_u64(v: &CbValue) -> Option<u64> {
    if let Some(n) = v.as_u64() {
        return Some(n);
    }
    v.as_str().and_then(|s| s.parse().ok())
}

// -----------------------------------------------------------------------------
// Value formatting (for the `fields` Vec)
// -----------------------------------------------------------------------------

fn format_value(value: &CbValue) -> String {
    match value {
        CbValue::Null => "null".to_string(),
        CbValue::Bool(b) => if *b { "true" } else { "false" }.to_string(),
        CbValue::Int(n) => n.to_string(),
        CbValue::Uint(n) => n.to_string(),
        CbValue::Float(f) => format!("{f:?}"),
        CbValue::String(s) => s.clone(),
        CbValue::Binary(b) => hex_of(b),
        CbValue::Hash(b) => hex_of(b),
        CbValue::Array(items) => format!("<array[{}]>", items.len()),
        CbValue::Object(_) => "<object>".to_string(),
        CbValue::Unknown { type_byte, raw } => {
            // Preserve raw bytes as hex so schema drift can be diagnosed from
            // the persisted probe record. Cap to a reasonable size to keep
            // log lines / DB fields workable; if the value is larger, render
            // the head + tail with a length marker so the structure is still
            // visible without dumping multi-KB blobs.
            const HEX_INLINE_BYTES: usize = 64;
            if raw.len() <= HEX_INLINE_BYTES {
                format!(
                    "<unknown type 0x{:02X}, {} bytes: {}>",
                    type_byte,
                    raw.len(),
                    hex_of(raw)
                )
            } else {
                format!(
                    "<unknown type 0x{:02X}, {} bytes: {}...{}>",
                    type_byte,
                    raw.len(),
                    hex_of(&raw[..32]),
                    hex_of(&raw[raw.len() - 32..])
                )
            }
        }
    }
}

fn hex_of(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(out, "{b:02x}");
    }
    out
}

fn value_kind(v: &CbValue) -> &'static str {
    match v {
        CbValue::Null => "null",
        CbValue::Bool(_) => "bool",
        CbValue::Int(_) => "int",
        CbValue::Uint(_) => "uint",
        CbValue::Float(_) => "float",
        CbValue::String(_) => "string",
        CbValue::Binary(_) => "binary",
        CbValue::Hash(_) => "hash",
        CbValue::Array(_) => "array",
        CbValue::Object(_) => "object",
        CbValue::Unknown { .. } => "unknown",
    }
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::zen::cb_parser::parse as cb_parse;

    // -------------------------------------------------------------------------
    // CB byte-stream builders.
    //
    // We intentionally produce HasFieldName-only encodings (no HasFieldType
    // flag) because that's what real zen wire data does (see cb_parser.rs
    // module docs).
    // -------------------------------------------------------------------------

    /// VarUInt encoder. Mirrors spec §2 — minimum-byte form.
    fn varuint(value: u64) -> Vec<u8> {
        // Choose smallest N where value fits in N*7+? bits. Encoding for an
        // N-byte form: N leading 1-bits, then a 0, then 7*N+? data bits.
        // The simplest correct encoder:
        if value < 0x80 {
            return vec![value as u8];
        }
        if value < 0x4000 {
            return vec![0x80 | (value >> 8) as u8, (value & 0xFF) as u8];
        }
        if value < 0x20_0000 {
            return vec![
                0xC0 | (value >> 16) as u8,
                (value >> 8) as u8,
                (value & 0xFF) as u8,
            ];
        }
        if value < 0x1000_0000 {
            return vec![
                0xE0 | (value >> 24) as u8,
                (value >> 16) as u8,
                (value >> 8) as u8,
                (value & 0xFF) as u8,
            ];
        }
        // 5-byte form covers up to 2^35; good enough for everything we test.
        vec![
            0xF0,
            (value >> 24) as u8,
            (value >> 16) as u8,
            (value >> 8) as u8,
            (value & 0xFF) as u8,
        ]
    }

    /// Field type bytes (HasFieldName=0x80 OR'd with the type id).
    const F_STRING: u8 = 0x80 | 0x07;
    const F_INT_POS: u8 = 0x80 | 0x08;
    const F_HASH: u8 = 0x80 | 0x10;

    /// Build a field body: VarUInt(name_len) + name bytes + payload.
    fn field(name: &str, type_byte: u8, payload: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        out.push(type_byte);
        out.extend_from_slice(&varuint(name.len() as u64));
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(payload);
        out
    }

    fn string_field(name: &str, value: &str) -> Vec<u8> {
        let mut payload = varuint(value.len() as u64);
        payload.extend_from_slice(value.as_bytes());
        field(name, F_STRING, &payload)
    }

    fn uint_field(name: &str, value: u64) -> Vec<u8> {
        field(name, F_INT_POS, &varuint(value))
    }

    /// Build a fixed-20-byte hash field. The exact bytes don't matter for our
    /// "unknown type doesn't actually go through Unknown" check — Hash is its
    /// own strong-typed variant — but we use it elsewhere too. For
    /// `unknown_fields_set_flag` we use a different type (T_DATETIME=0x12)
    /// which the parser routes into CbValue::Unknown.
    fn hash_field(name: &str, raw: [u8; 20]) -> Vec<u8> {
        field(name, F_HASH, &raw)
    }

    /// Field with a DateTime payload (type 0x12, 8-byte BE int64). The parser
    /// surfaces this as CbValue::Unknown so we use it to drive the
    /// has_unknown_fields flag.
    fn datetime_field(name: &str, ticks: i64) -> Vec<u8> {
        const F_DATETIME: u8 = 0x80 | 0x12;
        field(name, F_DATETIME, &ticks.to_be_bytes())
    }

    /// Wrap a list of field byte-strings into a top-level Object (type 0x02,
    /// VarUInt payload size, then fields).
    fn wrap_object(fields: &[Vec<u8>]) -> Vec<u8> {
        let mut payload = Vec::new();
        for f in fields {
            payload.extend_from_slice(f);
        }
        let mut out = Vec::new();
        out.push(0x02);
        out.extend_from_slice(&varuint(payload.len() as u64));
        out.extend_from_slice(&payload);
        out
    }

    /// Sanity check: feed our hand-built bytes back through cb_parser and
    /// assert it parses as an object with the expected number of fields.
    /// Catches builder bugs before the lockfile-specific assertions run.
    fn assert_roundtrip(bytes: &[u8], expected_fields: usize) {
        let (val, consumed) = cb_parse(bytes).expect("builder produced valid CB");
        assert_eq!(consumed, bytes.len(), "builder over- or under-counted size");
        let fields = val.as_object().expect("expected top-level object");
        assert_eq!(fields.len(), expected_fields);
    }

    // -------------------------------------------------------------------------
    // Tests
    // -------------------------------------------------------------------------

    #[test]
    fn parses_all_three_well_known_fields() {
        let bytes = wrap_object(&[
            uint_field("EffectivePort", 8558),
            uint_field("Pid", 27304),
            string_field("Executable", r"C:\Users\u\AppData\Local\UnrealEngine\Common\Zen\Install\zenserver.exe"),
        ]);
        assert_roundtrip(&bytes, 3);

        let info = parse(&bytes).expect("parse should succeed");
        assert_eq!(info.effective_port, Some(8558));
        assert_eq!(info.pid, Some(27304));
        assert_eq!(
            info.executable.as_deref(),
            Some(r"C:\Users\u\AppData\Local\UnrealEngine\Common\Zen\Install\zenserver.exe")
        );
        assert!(!info.has_unknown_fields);
        assert_eq!(info.fields.len(), 3);
    }

    #[test]
    fn accepts_port_as_string_form() {
        // Mirrors how /health/info's RuntimeConfig.EffectivePort is encoded
        // (string "8558", not Uint(8558)).
        let bytes = wrap_object(&[string_field("EffectivePort", "8558")]);
        assert_roundtrip(&bytes, 1);

        let info = parse(&bytes).expect("parse should succeed");
        assert_eq!(info.effective_port, Some(8558));
    }

    #[test]
    fn prefers_effective_port_over_port() {
        // Build with both fields present; EffectivePort comes first in the
        // PORT_NAMES list, so it wins regardless of wire order.
        let bytes = wrap_object(&[
            uint_field("Port", 8558),
            uint_field("EffectivePort", 9000),
        ]);
        assert_roundtrip(&bytes, 2);

        let info = parse(&bytes).expect("parse should succeed");
        assert_eq!(info.effective_port, Some(9000));

        // Same outcome when wire order is flipped — preference is by candidate
        // list order, not wire order.
        let bytes = wrap_object(&[
            uint_field("EffectivePort", 9000),
            uint_field("Port", 8558),
        ]);
        let info = parse(&bytes).expect("parse should succeed");
        assert_eq!(info.effective_port, Some(9000));
    }

    #[test]
    fn owner_pid_field_is_not_aliased_to_daemon_pid() {
        // OwnerPid is the sponsor UE editor PID (zen's --owner-pid flag), NOT
        // the zenserver process. Daemon pid must come from the Pid field only;
        // a lockfile carrying only OwnerPid must surface pid as None so
        // downstream liveness checks don't target the wrong process.
        let bytes_only_owner = wrap_object(&[uint_field("OwnerPid", 27304)]);
        let info = parse(&bytes_only_owner).expect("parse should succeed");
        assert_eq!(info.pid, None);

        // Mixed: when both fields exist, Pid is taken; OwnerPid is ignored.
        let bytes_both = wrap_object(&[
            uint_field("OwnerPid", 27304),
            uint_field("Pid", 31792),
        ]);
        assert_roundtrip(&bytes_both, 2);
        let info = parse(&bytes_both).expect("parse should succeed");
        assert_eq!(info.pid, Some(31792));
    }

    #[test]
    fn base_port_field_is_not_aliased_to_effective_port() {
        // BasePort is the requested port (--port <N> or 0 for auto-pick).
        // When zen auto-picks, BasePort and EffectivePort differ. A lockfile
        // carrying only BasePort must surface effective_port as None so
        // downstream register/probe code doesn't trust a stale request value.
        let bytes_only_base = wrap_object(&[uint_field("BasePort", 8558)]);
        let info = parse(&bytes_only_base).expect("parse should succeed");
        assert_eq!(info.effective_port, None);
    }

    #[test]
    fn missing_fields_yield_none_not_error() {
        let bytes = wrap_object(&[]);
        assert_roundtrip(&bytes, 0);

        let info = parse(&bytes).expect("empty object should still parse");
        assert_eq!(info.effective_port, None);
        assert_eq!(info.pid, None);
        assert_eq!(info.executable, None);
        assert!(info.fields.is_empty());
        assert!(!info.has_unknown_fields);
    }

    #[test]
    fn unknown_fields_set_flag() {
        // DateTime (type 0x12) is one of the families cb_parser surfaces via
        // CbValue::Unknown. Pair it with a known string field so we can
        // confirm both the flag flips and the value appears in the fields
        // Vec with its hex summary.
        let bytes = wrap_object(&[
            string_field("Executable", "zenserver.exe"),
            datetime_field("StartTime", 0x1234_5678_9ABC_DEF0_i64),
        ]);
        assert_roundtrip(&bytes, 2);

        let info = parse(&bytes).expect("parse should succeed");
        assert!(info.has_unknown_fields, "DateTime should trigger flag");

        let start_time_text = info
            .fields
            .iter()
            .find(|(n, _)| n == "StartTime")
            .map(|(_, v)| v.as_str())
            .expect("StartTime field preserved in fields Vec");
        assert!(
            start_time_text.starts_with("<unknown type 0x12,"),
            "unknown rendering should mention the type byte, got {start_time_text}"
        );
        assert!(
            start_time_text.contains("8 bytes:"),
            "rendering should declare the byte count, got {start_time_text}"
        );
        // P3: payload bytes must be preserved as hex so schema-drift events
        // can be diagnosed from the persisted probe record. DateTime ticks
        // 0x1234_5678_9ABC_DEF0 → big-endian bytes → hex "123456789abcdef0".
        assert!(
            start_time_text.contains("123456789abcdef0"),
            "rendering should embed the raw payload as hex, got {start_time_text}"
        );

        // The recognised string field is unaffected.
        assert_eq!(info.executable.as_deref(), Some("zenserver.exe"));
    }

    #[test]
    fn non_object_root_errors() {
        // Top-level string "855": type 0x07, len 3, then "855".
        let bytes = [0x07, 0x03, b'8', b'5', b'5'];
        let err = parse(&bytes).unwrap_err();
        match err {
            LockfileError::NotAnObject(kind) => assert_eq!(kind, "string"),
            other => panic!("expected NotAnObject, got {other:?}"),
        }
    }

    #[test]
    fn bytes_are_preserved_in_fields_list() {
        // Multi-field object exercising different value families; verify the
        // Vec preserves wire order and each value renders to the expected
        // text form.
        let bytes = wrap_object(&[
            string_field("Executable", "zenserver.exe"),
            uint_field("Pid", 42),
            uint_field("EffectivePort", 8558),
            hash_field("SomeHash", [0xDE; 20]),
        ]);
        assert_roundtrip(&bytes, 4);

        let info = parse(&bytes).expect("parse should succeed");
        let names: Vec<&str> = info.fields.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, vec!["Executable", "Pid", "EffectivePort", "SomeHash"]);

        let values: Vec<&str> = info.fields.iter().map(|(_, v)| v.as_str()).collect();
        assert_eq!(values[0], "zenserver.exe");
        assert_eq!(values[1], "42");
        assert_eq!(values[2], "8558");
        // Hash is 20 bytes of 0xDE → 40-char lowercase hex.
        assert_eq!(values[3], "de".repeat(20));

        // Hash is a strong-typed variant, not Unknown, so the flag stays off.
        assert!(!info.has_unknown_fields);
    }

    #[test]
    fn parse_propagates_cb_errors() {
        // Truncated object → CbError::LengthOverflow → LockfileError::Parse
        let bytes = [0x02, 0x64, 0x00];
        let err = parse(&bytes).unwrap_err();
        assert!(matches!(err, LockfileError::Parse(_)));
    }
}
