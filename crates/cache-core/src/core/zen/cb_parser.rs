//! Read-only mini-parser for UE Compact Binary (CB).
//!
//! Spec source of truth: `vp/zen/docs/specs/CompactBinary.md`. The reference
//! reader in `vp/UnrealEngine/.../CompactBinary.h` is used to disambiguate
//! places where the spec is fuzzy (notably: the per-field `HasFieldType`
//! flag is **not** set on object fields in the real zen wire output even
//! though the spec text in §5.1 suggests it should be — UE's writer only
//! sets `HasFieldName` for object fields and only `HasFieldType` for the
//! top-level / non-uniform-array case).
//!
//! This module is read-only. We never produce CB. Anything we can't classify
//! confidently lands in [`CbValue::Unknown`] so callers can still walk past it.
//!
//! API summary:
//! - [`parse`] decodes a single top-level CB value (with leading type byte).
//! - [`parse_object`] convenience for the very common "whole buffer is one
//!   Object" case zen uses for all of its HTTP endpoints.
//! - [`CbValue::get`] dotted-path navigation for extraction.
//! - `CbValue::as_*` helpers for cheap type coercion.

use std::str::Utf8Error;

use thiserror::Error;

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

/// Decoded CB value tree.
///
/// Owned: strings/bytes/arrays/objects are copies. Zero-copy borrowing is out
/// of scope for v1 — the database persists the raw bytes anyway (plan §1.1
/// `raw_cb` BLOB), and a few hundred KB per probe is fine in exchange for
/// readability.
#[derive(Debug, Clone, PartialEq)]
pub enum CbValue {
    Null,
    Bool(bool),
    /// Signed integer (only produced for `IntegerNegative` type).
    Int(i64),
    /// Unsigned integer (produced for `IntegerPositive`).
    Uint(u64),
    /// Single decode type for both `Float32` and `Float64` payloads
    /// (f32 widened to f64).
    Float(f64),
    String(String),
    Binary(Vec<u8>),
    /// Raw hash / attachment / ObjectId / Uuid bytes. We deliberately do not
    /// try to format these — callers that need a hex view convert themselves.
    /// The byte length depends on which type produced the value (20 for Hash
    /// and attachments, 16 for Uuid, 12 for ObjectId).
    Hash(Vec<u8>),
    /// Ordered list of decoded items.
    Array(Vec<CbValue>),
    /// Field list in wire order (CB does not prescribe field ordering but
    /// preserving it makes diffing / hashing trivial and matches UE's reader).
    Object(Vec<(String, CbValue)>),
    /// Forward-compat escape hatch: a type byte the parser knows how to skip
    /// but does not have a strongly-typed variant for (e.g. DateTime / TimeSpan
    /// / Custom*). Raw payload bytes are recorded so callers can still display
    /// or persist them.
    Unknown { type_byte: u8, raw: Vec<u8> },
}

/// Parser errors.
///
/// Everything carries the offset where the failure was detected so a future
/// hex-dump dumper can render the offending region.
#[derive(Debug, Error)]
pub enum CbError {
    #[error("unexpected EOF at offset {0}")]
    UnexpectedEof(usize),
    #[error("invalid VarUInt at offset {0}")]
    InvalidVarUInt(usize),
    #[error("invalid UTF-8 in string at offset {0}: {1}")]
    InvalidUtf8(usize, Utf8Error),
    #[error("declared length {declared} exceeds remaining {remaining} at offset {offset}")]
    LengthOverflow {
        offset: usize,
        declared: u64,
        remaining: usize,
    },
    #[error("malformed payload at offset {0}: {1}")]
    Malformed(usize, &'static str),
}

pub type CbResult<T> = Result<T, CbError>;

// -----------------------------------------------------------------------------
// Type constants (see spec §3.3)
// -----------------------------------------------------------------------------

/// Spec §3.2 calls this flag "transient" and notes it's set on fields in
/// non-uniform containers when the type byte is stored inline. Real zen
/// output never sets it (UE's writer omits it for HasFieldName-only fields),
/// so the parser doesn't need to inspect it. Kept named for documentation.
#[allow(dead_code)]
const FLAG_HAS_FIELD_TYPE: u8 = 0x40;
const FLAG_HAS_FIELD_NAME: u8 = 0x80;

/// Mask isolating the type ID. UE source uses 5 bits (`0x1F`); the spec leaves
/// bit `0x20` reserved. We mirror UE's mask so a writer that ever sets `0x20`
/// doesn't get silently mis-typed by us.
const TYPE_MASK: u8 = 0x1F;

const T_NONE: u8 = 0x00;
const T_NULL: u8 = 0x01;
const T_OBJECT: u8 = 0x02;
const T_UNIFORM_OBJECT: u8 = 0x03;
const T_ARRAY: u8 = 0x04;
const T_UNIFORM_ARRAY: u8 = 0x05;
const T_BINARY: u8 = 0x06;
const T_STRING: u8 = 0x07;
const T_INT_POS: u8 = 0x08;
const T_INT_NEG: u8 = 0x09;
const T_FLOAT32: u8 = 0x0A;
const T_FLOAT64: u8 = 0x0B;
const T_BOOL_FALSE: u8 = 0x0C;
const T_BOOL_TRUE: u8 = 0x0D;
const T_OBJECT_ATTACHMENT: u8 = 0x0E;
const T_BINARY_ATTACHMENT: u8 = 0x0F;
const T_HASH: u8 = 0x10;
const T_UUID: u8 = 0x11;
const T_DATETIME: u8 = 0x12;
const T_TIMESPAN: u8 = 0x13;
const T_OBJECT_ID: u8 = 0x14;
const T_CUSTOM_BY_ID: u8 = 0x1E;
const T_CUSTOM_BY_NAME: u8 = 0x1F;

// -----------------------------------------------------------------------------
// Public entry points
// -----------------------------------------------------------------------------

/// Parse a single root CB value from `bytes`.
///
/// Returns the decoded tree and the number of bytes actually consumed.
/// Callers can verify `consumed == bytes.len()` if they want to reject
/// trailing junk (spec §9 "Padding" validation mode).
///
/// The first byte at the top level is treated as a type byte with neither
/// flag — i.e. the "with type" form from spec §7. Real zen responses (e.g.
/// `/health/info` starts with `0x02`) match this shape.
pub fn parse(bytes: &[u8]) -> CbResult<(CbValue, usize)> {
    let mut cur = Cursor::new(bytes);
    let type_byte = cur.read_u8()?;
    // Strip the optional HasFieldType flag (spec §3.2 calls it "transient").
    // Field name at the top level doesn't make sense so we reject it.
    if type_byte & FLAG_HAS_FIELD_NAME != 0 {
        return Err(CbError::Malformed(
            0,
            "top-level field unexpectedly carries HasFieldName",
        ));
    }
    let type_id = type_byte & TYPE_MASK;
    let value = read_payload(&mut cur, type_id)?;
    Ok((value, cur.pos))
}

/// Convenience: require the buffer to decode as a single Object and return
/// its field list directly.
///
/// Both `Object` and `UniformObject` are accepted; the returned field list
/// is in wire order.
pub fn parse_object(bytes: &[u8]) -> CbResult<Vec<(String, CbValue)>> {
    let (value, _consumed) = parse(bytes)?;
    match value {
        CbValue::Object(fields) => Ok(fields),
        _ => Err(CbError::Malformed(0, "expected top-level Object")),
    }
}

// -----------------------------------------------------------------------------
// Cursor: minimal big-endian byte reader with offset tracking
// -----------------------------------------------------------------------------

struct Cursor<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn new(buf: &'a [u8]) -> Self {
        Self { buf, pos: 0 }
    }

    fn remaining(&self) -> usize {
        self.buf.len().saturating_sub(self.pos)
    }

    fn read_u8(&mut self) -> CbResult<u8> {
        if self.pos >= self.buf.len() {
            return Err(CbError::UnexpectedEof(self.pos));
        }
        let v = self.buf[self.pos];
        self.pos += 1;
        Ok(v)
    }

    fn read_bytes(&mut self, n: usize) -> CbResult<&'a [u8]> {
        if self.remaining() < n {
            return Err(CbError::UnexpectedEof(self.pos));
        }
        let slice = &self.buf[self.pos..self.pos + n];
        self.pos += n;
        Ok(slice)
    }

    /// Read a VarUInt per spec §2. Returns the decoded value.
    ///
    /// We deliberately do not enforce canonical (minimal-byte) form here:
    /// readers should be liberal in what they accept, and any non-canonical
    /// input still has a well-defined value.
    fn read_varuint(&mut self) -> CbResult<u64> {
        let start = self.pos;
        let first = self.read_u8()?;
        // CountLeadingOnes(first)
        let extra = (!first).leading_zeros() as usize; // 0..=8
        if extra > 8 {
            // Not reachable for u8 (max leading_zeros is 8) but be explicit.
            return Err(CbError::InvalidVarUInt(start));
        }
        // Mask out the leading-1 prefix bits.
        let mask: u8 = if extra >= 8 { 0 } else { 0xFF >> extra };
        let mut value: u64 = u64::from(first & mask);
        if self.remaining() < extra {
            return Err(CbError::UnexpectedEof(self.pos));
        }
        for _ in 0..extra {
            value = (value << 8) | u64::from(self.read_u8()?);
        }
        Ok(value)
    }

    /// Read a VarUInt and immediately bound-check it against the remaining
    /// buffer. Used everywhere a VarUInt is a payload length (most places).
    fn read_varuint_as_len(&mut self) -> CbResult<usize> {
        let offset = self.pos;
        let raw = self.read_varuint()?;
        let remaining = self.remaining();
        if raw > remaining as u64 {
            return Err(CbError::LengthOverflow {
                offset,
                declared: raw,
                remaining,
            });
        }
        Ok(raw as usize)
    }
}

// -----------------------------------------------------------------------------
// Payload readers (one per type family)
// -----------------------------------------------------------------------------

/// Dispatch on `type_id` and read the payload from `cur`. `cur` is positioned
/// at the first byte of the payload.
fn read_payload(cur: &mut Cursor<'_>, type_id: u8) -> CbResult<CbValue> {
    match type_id {
        T_NONE => Err(CbError::Malformed(
            cur.pos.saturating_sub(1),
            "encountered None type (invalid in valid data)",
        )),
        T_NULL => Ok(CbValue::Null),
        T_BOOL_FALSE => Ok(CbValue::Bool(false)),
        T_BOOL_TRUE => Ok(CbValue::Bool(true)),
        T_INT_POS => {
            let v = cur.read_varuint()?;
            Ok(CbValue::Uint(v))
        }
        T_INT_NEG => {
            // Spec §4.5: stored as VarUInt(~Value). Decode: Value = !M, i.e. -(M+1).
            let m = cur.read_varuint()?;
            // Saturate-check: the only encodable magnitude is up to 2^63 - 1
            // (since min value is -2^63 == !(2^63 - 1)). Anything larger
            // we report as malformed rather than silently wrapping.
            if m > i64::MAX as u64 {
                return Err(CbError::Malformed(
                    cur.pos,
                    "IntegerNegative magnitude exceeds i64 range",
                ));
            }
            // CB encodes -1 as magnitude 0, so the decoded value is
            // `-(m + 1)`. At m == i64::MAX the naive `(m as i64) + 1` would
            // overflow, so handle the i64::MIN boundary explicitly.
            let value: i64 = if m == i64::MAX as u64 {
                i64::MIN
            } else {
                -((m as i64) + 1)
            };
            Ok(CbValue::Int(value))
        }
        T_FLOAT32 => {
            let bytes = cur.read_bytes(4)?;
            let mut buf = [0u8; 4];
            buf.copy_from_slice(bytes);
            Ok(CbValue::Float(f64::from(f32::from_be_bytes(buf))))
        }
        T_FLOAT64 => {
            let bytes = cur.read_bytes(8)?;
            let mut buf = [0u8; 8];
            buf.copy_from_slice(bytes);
            Ok(CbValue::Float(f64::from_be_bytes(buf)))
        }
        T_STRING => {
            let len = cur.read_varuint_as_len()?;
            let str_offset = cur.pos;
            let bytes = cur.read_bytes(len)?;
            let s = std::str::from_utf8(bytes)
                .map_err(|e| CbError::InvalidUtf8(str_offset, e))?
                .to_string();
            Ok(CbValue::String(s))
        }
        T_BINARY => {
            let len = cur.read_varuint_as_len()?;
            let bytes = cur.read_bytes(len)?;
            Ok(CbValue::Binary(bytes.to_vec()))
        }
        T_OBJECT => read_object_nonuniform(cur),
        T_UNIFORM_OBJECT => read_object_uniform(cur),
        T_ARRAY => read_array_nonuniform(cur),
        T_UNIFORM_ARRAY => read_array_uniform(cur),
        T_HASH | T_OBJECT_ATTACHMENT | T_BINARY_ATTACHMENT => {
            // Fixed 20-byte hash per spec §4.9.
            let bytes = cur.read_bytes(20)?;
            Ok(CbValue::Hash(bytes.to_vec()))
        }
        T_UUID => {
            // Fixed 16 bytes per spec §4.10.
            let bytes = cur.read_bytes(16)?;
            Ok(CbValue::Hash(bytes.to_vec()))
        }
        T_OBJECT_ID => {
            // Fixed 12 bytes per spec §4.13.
            let bytes = cur.read_bytes(12)?;
            Ok(CbValue::Hash(bytes.to_vec()))
        }
        T_DATETIME | T_TIMESPAN => {
            // 8-byte BE int64 ticks. We don't have a strong type for these
            // in this v1 — record raw bytes via Unknown so callers can decide
            // how to surface them.
            let type_byte = type_id;
            let bytes = cur.read_bytes(8)?;
            Ok(CbValue::Unknown {
                type_byte,
                raw: bytes.to_vec(),
            })
        }
        T_CUSTOM_BY_ID | T_CUSTOM_BY_NAME => {
            // VarUInt(TotalSize) + opaque payload. Skip safely.
            let len = cur.read_varuint_as_len()?;
            let bytes = cur.read_bytes(len)?;
            Ok(CbValue::Unknown {
                type_byte: type_id,
                raw: bytes.to_vec(),
            })
        }
        // Everything else (including the reserved 0x20+ range): we don't know
        // the framing rule. Per the task spec we MUST be able to skip the
        // payload safely. The CB spec only guarantees safe-skip for "size-
        // prefixed" types; truly unknown bit patterns are a hard error.
        other => Err(CbError::Malformed(
            cur.pos.saturating_sub(1),
            other_to_message(other),
        )),
    }
}

fn other_to_message(_type_id: u8) -> &'static str {
    "unrecognised type id (no known framing rule)"
}

// -----------------------------------------------------------------------------
// Object / Array readers
// -----------------------------------------------------------------------------

/// Non-uniform Object: `VarUInt(PayloadSize) + Fields*`. Each field carries
/// its type byte with `HasFieldName` set (real zen wire data does *not* also
/// set `HasFieldType`, despite the spec text — see module-level docs).
fn read_object_nonuniform(cur: &mut Cursor<'_>) -> CbResult<CbValue> {
    let payload_len = cur.read_varuint_as_len()?;
    let end = cur.pos + payload_len;
    let mut fields = Vec::new();
    while cur.pos < end {
        let type_byte_offset = cur.pos;
        let type_byte = cur.read_u8()?;
        if type_byte & FLAG_HAS_FIELD_NAME == 0 {
            return Err(CbError::Malformed(
                type_byte_offset,
                "object field missing HasFieldName flag",
            ));
        }
        let type_id = type_byte & TYPE_MASK;
        let name = read_field_name(cur)?;
        let value = read_payload(cur, type_id)?;
        fields.push((name, value));
    }
    if cur.pos != end {
        // We over-read past the declared payload — shouldn't happen unless
        // a child read past its own size budget.
        return Err(CbError::Malformed(
            end,
            "object child read overran declared size",
        ));
    }
    Ok(CbValue::Object(fields))
}

/// Uniform Object: `VarUInt(PayloadSize) + FieldType(1) + Fields*`. Field
/// type byte must have `HasFieldName` set; each child field is
/// `VarUInt(NameLen) + Name + Payload`.
fn read_object_uniform(cur: &mut Cursor<'_>) -> CbResult<CbValue> {
    let payload_len = cur.read_varuint_as_len()?;
    let end = cur.pos + payload_len;
    let field_type_offset = cur.pos;
    let field_type = cur.read_u8()?;
    if field_type & FLAG_HAS_FIELD_NAME == 0 {
        return Err(CbError::Malformed(
            field_type_offset,
            "uniform object field type missing HasFieldName flag",
        ));
    }
    let type_id = field_type & TYPE_MASK;
    let mut fields = Vec::new();
    while cur.pos < end {
        let name = read_field_name(cur)?;
        let value = read_payload(cur, type_id)?;
        fields.push((name, value));
    }
    if cur.pos != end {
        return Err(CbError::Malformed(
            end,
            "uniform object child read overran declared size",
        ));
    }
    Ok(CbValue::Object(fields))
}

/// Non-uniform Array: `VarUInt(PayloadSize) + VarUInt(ItemCount) + Fields*`.
/// Each field has a type byte WITHOUT `HasFieldName` (no names in arrays).
fn read_array_nonuniform(cur: &mut Cursor<'_>) -> CbResult<CbValue> {
    let payload_len = cur.read_varuint_as_len()?;
    let end = cur.pos + payload_len;
    let count = cur.read_varuint()? as usize;
    let mut items = Vec::with_capacity(count.min(1024));
    while cur.pos < end {
        let type_byte_offset = cur.pos;
        let type_byte = cur.read_u8()?;
        if type_byte & FLAG_HAS_FIELD_NAME != 0 {
            return Err(CbError::Malformed(
                type_byte_offset,
                "array element unexpectedly carries HasFieldName",
            ));
        }
        let type_id = type_byte & TYPE_MASK;
        let value = read_payload(cur, type_id)?;
        items.push(value);
    }
    if cur.pos != end {
        return Err(CbError::Malformed(
            end,
            "array child read overran declared size",
        ));
    }
    if items.len() != count {
        return Err(CbError::Malformed(
            end,
            "array item count mismatch vs declared count",
        ));
    }
    Ok(CbValue::Array(items))
}

/// Uniform Array: `VarUInt(PayloadSize)`, `VarUInt(ItemCount)`, one
/// FieldType byte, then `ItemCount` payloads. Each item is just its
/// payload bytes, typed by the shared field type.
fn read_array_uniform(cur: &mut Cursor<'_>) -> CbResult<CbValue> {
    let payload_len = cur.read_varuint_as_len()?;
    let end = cur.pos + payload_len;
    let count = cur.read_varuint()? as usize;
    let field_type_offset = cur.pos;
    let field_type = cur.read_u8()?;
    if field_type & FLAG_HAS_FIELD_NAME != 0 {
        return Err(CbError::Malformed(
            field_type_offset,
            "uniform array field type unexpectedly carries HasFieldName",
        ));
    }
    let type_id = field_type & TYPE_MASK;
    // Count-based iteration: zero-width payload types (Null, BoolFalse,
    // BoolTrue) would never advance `cur.pos`, so a `while cur.pos < end`
    // loop on a malformed buffer of those types hangs. Read exactly `count`
    // items and verify the cursor lands exactly on `end`.
    let mut items = Vec::with_capacity(count.min(1024));
    for _ in 0..count {
        if cur.pos > end {
            return Err(CbError::Malformed(
                end,
                "uniform array child read overran declared size",
            ));
        }
        let value = read_payload(cur, type_id)?;
        items.push(value);
    }
    if cur.pos != end {
        return Err(CbError::Malformed(
            end,
            "uniform array trailing bytes after declared count consumed",
        ));
    }
    Ok(CbValue::Array(items))
}

/// Read a `VarUInt(NameLen) + utf8 name` pair as used by every named field.
fn read_field_name(cur: &mut Cursor<'_>) -> CbResult<String> {
    let len = cur.read_varuint_as_len()?;
    let name_offset = cur.pos;
    let bytes = cur.read_bytes(len)?;
    let name = std::str::from_utf8(bytes)
        .map_err(|e| CbError::InvalidUtf8(name_offset, e))?
        .to_string();
    Ok(name)
}

// -----------------------------------------------------------------------------
// Extraction helpers — used by T1.4 / T1.5
// -----------------------------------------------------------------------------

impl CbValue {
    /// Navigate a dotted path through nested objects.
    ///
    /// `get("RuntimeConfig.EffectivePort")` walks `self.RuntimeConfig` then
    /// returns the `EffectivePort` child. Returns `None` if any segment is
    /// missing or the intermediate type doesn't have named fields.
    ///
    /// Empty path returns `Some(self)` for caller convenience.
    pub fn get(&self, path: &str) -> Option<&CbValue> {
        if path.is_empty() {
            return Some(self);
        }
        let mut cur = self;
        for segment in path.split('.') {
            let fields = match cur {
                CbValue::Object(fields) => fields,
                _ => return None,
            };
            cur = fields.iter().find(|(k, _)| k == segment).map(|(_, v)| v)?;
        }
        Some(cur)
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            CbValue::String(s) => Some(s.as_str()),
            _ => None,
        }
    }

    pub fn as_u64(&self) -> Option<u64> {
        match self {
            CbValue::Uint(v) => Some(*v),
            CbValue::Int(v) if *v >= 0 => Some(*v as u64),
            _ => None,
        }
    }

    pub fn as_i64(&self) -> Option<i64> {
        match self {
            CbValue::Int(v) => Some(*v),
            // u64 → i64 only if it fits.
            CbValue::Uint(v) if *v <= i64::MAX as u64 => Some(*v as i64),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            CbValue::Float(v) => Some(*v),
            // Integers convert to float per spec §3.4 (Float family includes
            // Integer types). We accept the conversion even for large u64
            // values; precision loss is the caller's problem.
            CbValue::Uint(v) => Some(*v as f64),
            CbValue::Int(v) => Some(*v as f64),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            CbValue::Bool(b) => Some(*b),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[CbValue]> {
        match self {
            CbValue::Array(items) => Some(items.as_slice()),
            _ => None,
        }
    }

    pub fn as_object(&self) -> Option<&[(String, CbValue)]> {
        match self {
            CbValue::Object(fields) => Some(fields.as_slice()),
            _ => None,
        }
    }
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    fn decode_b64(s: &str) -> Vec<u8> {
        base64::engine::general_purpose::STANDARD
            .decode(s.trim())
            .expect("valid base64 fixture")
    }

    // -------------------------------------------------------------------------
    // VarUInt unit tests (spec §2.7 table)
    // -------------------------------------------------------------------------

    #[test]
    fn varuint_decodes_single_byte_values() {
        // 0x01 → 1; 0x7F → 127 (boundary of 1-byte form)
        let mut c = Cursor::new(&[0x01]);
        assert_eq!(c.read_varuint().unwrap(), 0x01);
        let mut c = Cursor::new(&[0x7F]);
        assert_eq!(c.read_varuint().unwrap(), 0x7F);
    }

    #[test]
    fn varuint_decodes_two_byte_values() {
        // 0x80 80 → 0x80; 0x81 23 → 0x123
        let mut c = Cursor::new(&[0x80, 0x80]);
        assert_eq!(c.read_varuint().unwrap(), 0x80);
        let mut c = Cursor::new(&[0x81, 0x23]);
        assert_eq!(c.read_varuint().unwrap(), 0x123);
        let mut c = Cursor::new(&[0x92, 0x34]);
        assert_eq!(c.read_varuint().unwrap(), 0x1234);
    }

    #[test]
    fn varuint_decodes_three_to_nine_byte_values() {
        let mut c = Cursor::new(&[0xC1, 0x23, 0x45]);
        assert_eq!(c.read_varuint().unwrap(), 0x12345);
        let mut c = Cursor::new(&[0xD2, 0x34, 0x56]);
        assert_eq!(c.read_varuint().unwrap(), 0x123456);
        let mut c = Cursor::new(&[0xE1, 0x23, 0x45, 0x67]);
        assert_eq!(c.read_varuint().unwrap(), 0x1234567);
        let mut c = Cursor::new(&[0xF0, 0x12, 0x34, 0x56, 0x78]);
        assert_eq!(c.read_varuint().unwrap(), 0x12345678);
        let mut c = Cursor::new(&[0xFF, 0x12, 0x34, 0x56, 0x78, 0x9A, 0xBC, 0xDE, 0xF0]);
        assert_eq!(c.read_varuint().unwrap(), 0x123456789ABCDEF0);
    }

    #[test]
    fn varuint_errors_on_truncated_input() {
        // 0x80 announces 2 bytes but only 1 provided.
        let mut c = Cursor::new(&[0x80]);
        let err = c.read_varuint().unwrap_err();
        assert!(matches!(err, CbError::UnexpectedEof(_)));
    }

    // -------------------------------------------------------------------------
    // Hand-crafted simple object (matches spec §11.1)
    // -------------------------------------------------------------------------

    #[test]
    fn parses_simple_object_with_hasfieldtype_flag() {
        // Spec §11.1 shows fields encoded with `HasFieldType | HasFieldName`
        // (0xC0 mask) — that flag is meaningful in some serializers even
        // though real zen wire data only sets HasFieldName. We still accept
        // it: low 5 bits identify the type regardless of the flag bit.
        //
        // (Note: the spec text in 11.1 claims payload size = 0x17 / 23, but
        // counting the bytes in the spec's own hex block gives 18 — the spec
        // has an arithmetic error. We use the byte-exact size here.)
        let bytes = [
            0x02, // Object type
            0x12, // payload size = 18 (= field1(12) + field2(6))
            // field 1: String "name" = "Alice"
            0xC7, 0x04, b'n', b'a', b'm', b'e', 0x05, b'A', b'l', b'i', b'c', b'e',
            // field 2: IntegerPositive "age" = 30
            0xC8, 0x03, b'a', b'g', b'e', 0x1E,
        ];
        let (val, consumed) = parse(&bytes).unwrap();
        assert_eq!(consumed, bytes.len());
        let fields = val.as_object().unwrap();
        assert_eq!(fields.len(), 2);
        assert_eq!(fields[0].0, "name");
        assert_eq!(fields[0].1.as_str(), Some("Alice"));
        assert_eq!(fields[1].0, "age");
        assert_eq!(fields[1].1.as_u64(), Some(30));
    }

    #[test]
    fn parses_simple_object_without_hasfieldtype_flag() {
        // Zen's real wire output uses HasFieldName only (no HasFieldType).
        // Same object as above with 0x87/0x88 instead of 0xC7/0xC8.
        let bytes = [
            0x02, 0x12, 0x87, 0x04, b'n', b'a', b'm', b'e', 0x05, b'A', b'l', b'i', b'c', b'e',
            0x88, 0x03, b'a', b'g', b'e', 0x1E,
        ];
        let (val, _) = parse(&bytes).unwrap();
        let fields = val.as_object().unwrap();
        assert_eq!(fields[0].1.as_str(), Some("Alice"));
        assert_eq!(fields[1].1.as_u64(), Some(30));
    }

    #[test]
    fn parses_negative_integer_spec_example_11_3() {
        // -42 standalone = 0x09 0x29
        // (Top-level value with type byte but no name.)
        let (val, _) = parse(&[0x09, 0x29]).unwrap();
        assert_eq!(val.as_i64(), Some(-42));
        // -1 → 0x09 0x00
        let (val, _) = parse(&[0x09, 0x00]).unwrap();
        assert_eq!(val.as_i64(), Some(-1));
    }

    #[test]
    fn parses_uniform_array_of_ints() {
        // [1, 2, 3] as UniformArray:
        //   05 = UniformArray type, 05 = payload size, 03 = count, 08 = item type,
        //   01 02 03 = three IntegerPositive payloads.
        // (Spec §11.2 also has an off-by-one in its size byte — uses 0x06 where
        // the actual payload is 5 bytes. We mirror what's actually correct.)
        let bytes = [0x05, 0x05, 0x03, 0x08, 0x01, 0x02, 0x03];
        let (val, consumed) = parse(&bytes).unwrap();
        assert_eq!(consumed, bytes.len());
        let items = val.as_array().unwrap();
        assert_eq!(items.len(), 3);
        assert_eq!(items[0].as_u64(), Some(1));
        assert_eq!(items[1].as_u64(), Some(2));
        assert_eq!(items[2].as_u64(), Some(3));
    }

    #[test]
    fn parses_nested_object() {
        // Outer { inner: { x: 10 } } using HasFieldName-only style.
        // Inner field "x = 10" = 0x88 0x01 'x' 0x0A → 4 bytes.
        // Inner Object payload = VarUInt(4) + 4 child bytes = 5 bytes.
        // Outer "inner" field header = 0x82 (Object|HasFieldName) + 0x05 (namelen)
        //                              + "inner" (5 bytes) + 5 (inner Object payload)
        //                            = 12 bytes total.
        let bytes = [
            0x02, 0x0C, // Outer Object, size = 12
            0x82, 0x05, b'i', b'n', b'n', b'e', b'r', // inner field header
            0x04, // inner Object's VarUInt(payload size) = 4
            0x88, 0x01, b'x', 0x0A, // IntegerPositive|HasFieldName "x" = 10
        ];
        let (val, _) = parse(&bytes).unwrap();
        assert_eq!(val.get("inner.x").unwrap().as_u64(), Some(10));
    }

    #[test]
    fn parses_empty_non_uniform_object() {
        let (val, consumed) = parse(&[0x02, 0x00]).unwrap();
        assert_eq!(consumed, 2);
        assert_eq!(val.as_object().unwrap().len(), 0);
    }

    #[test]
    fn parses_empty_non_uniform_array() {
        // 04 01 00 → Array, payload size 1, item count 0
        let (val, consumed) = parse(&[0x04, 0x01, 0x00]).unwrap();
        assert_eq!(consumed, 3);
        assert_eq!(val.as_array().unwrap().len(), 0);
    }

    #[test]
    fn parses_floats_both_widths() {
        // Float32 1.5 → bit pattern 0x3FC00000
        let bytes = [0x0A, 0x3F, 0xC0, 0x00, 0x00];
        let (val, _) = parse(&bytes).unwrap();
        assert_eq!(val.as_f64(), Some(1.5));
        // Float64 0.972... (the hit_ratio bit pattern from stats_z.cb)
        let bytes = [0x0B, 0x3F, 0xEF, 0x1D, 0xBB, 0xD4, 0x7C, 0xBC, 0x8E];
        let (val, _) = parse(&bytes).unwrap();
        let f = val.as_f64().unwrap();
        assert!((f - 0.9723796033994334).abs() < 1e-15);
    }

    #[test]
    fn parses_null_and_bools() {
        let (val, _) = parse(&[0x01]).unwrap();
        assert_eq!(val, CbValue::Null);
        let (val, _) = parse(&[0x0C]).unwrap();
        assert_eq!(val.as_bool(), Some(false));
        let (val, _) = parse(&[0x0D]).unwrap();
        assert_eq!(val.as_bool(), Some(true));
    }

    // -------------------------------------------------------------------------
    // C.4 fixture: /stats — providers array
    // -------------------------------------------------------------------------

    const STATS_B64: &str =
        "AzCFCXByb3ZpZGVycyQGBwlkYXNoYm9hcmQEaHR0cANwcmoIc2Vzc2lvbnMCd3MCeiQ=";

    #[test]
    fn parses_fixture_stats_cb() {
        let bytes = decode_b64(STATS_B64);
        assert_eq!(bytes.len(), 50);
        let (val, consumed) = parse(&bytes).unwrap();
        assert_eq!(consumed, 50);
        let providers = val
            .get("providers")
            .expect("providers field")
            .as_array()
            .expect("providers is array");
        let names: Vec<&str> = providers.iter().filter_map(CbValue::as_str).collect();
        assert_eq!(
            names,
            vec!["dashboard", "http", "prj", "sessions", "ws", "z$"]
        );
    }

    // -------------------------------------------------------------------------
    // C.3 fixture: /health/info — the big one
    // -------------------------------------------------------------------------

    const HEALTH_INFO_B64: &str = "AoSFhwhEYXRhUm9vdBNcXD9cRjpcRXBpY1xERENcWmVuhwpBYnNMb2dQYXRoJlxcP1xGOlxFcGljXEREQ1xaZW5cbG9nc1x6ZW5zZXJ2ZXIubG9nhwxCdWlsZFZlcnNpb24wNS44LjEwLTIwMjYwNTA3MTkzOC13aW5kb3dzLXg2NC1yZWxlYXNlLWZiYWNkZWNkhw9IdHRwU2VydmVyQ2xhc3MEYXNpb4gEUG9ydKFuiANQaWTAfDCMC0lzRGVkaWNhdGVkiAtTdGFydFRpbWVNc/meObwl7IMNUnVudGltZUNvbmZpZ4Flhw1TeXN0ZW1Sb290RGlyF0M6XFByb2dyYW1EYXRhXEVwaWNcWmVuCkNvbnRlbnREaXIADUVmZmVjdGl2ZVBvcnQEODU1OAhCYXNlUG9ydAQ4NTU4CUNvcmVMaW1pdAEwD01lbW9yeUFsbG9jYXRvcg5taW1hbGxvYyAyLjIuNwtBc2lvVmVyc2lvbgYxLjM4LjAHSXNEZWJ1ZwVmYWxzZQxJc0NsZWFuU3RhcnQFZmFsc2UGSXNUZXN0BWZhbHNlBkRldGFjaAR0cnVlD05vQ29uc29sZU91dHB1dAVmYWxzZQxRdWlldENvbnNvbGUEdHJ1ZQdDaGlsZElkEVplbl8yNzMwNF9TdGFydHVwBUxvZ0lkAApTZW50cnkgRFNOB25vdCBzZXQSU2VudHJ5IEVudmlyb25tZW50AA5TdGF0c2QgRW5hYmxlZAVmYWxzZRJTZWN1cml0eUNvbmZpZ1BhdGgAggtCdWlsZENvbmZpZ4ELjBVaRU5fQUREUkVTU19TQU5JVElaRVKMFFpFTl9USFJFQURfU0FOSVRJWkVSjBRaRU5fTUVNT1JZX1NBTklUSVpFUowSWkVOX0xFQUtfU0FOSVRJWkVSjQ5aRU5fVVNFX1NFTlRSWYwOWkVOX1dJVEhfVEVTVFONEFpFTl9VU0VfTUlNQUxMT0ONEFpFTl9VU0VfUlBNQUxMT0ONEFpFTl9XSVRIX0hUVFBTWVONEVpFTl9XSVRIX01FTVRSQUNLjQ5aRU5fV0lUSF9UUkFDRYwZWkVOX1dJVEhfQ09NUFVURV9TRVJWSUNFU4wOWkVOX1dJVEhfSE9SREWMDlpFTl9XSVRIX05PTUFEhwhIb3N0bmFtZQVMQU5QQ4ULSXBBZGRyZXNzZXMQAQcNMTkyLjE2OC4xMC4yMIcIUGxhdGZvcm0Hd2luZG93c4cEQXJjaAN4NjSHAk9TGFdpbmRvd3MgMTAuMCBCdWlsZCAyNjIwMIMGU3lzdGVtgK6ICWNwdV9jb3VudAEKY29yZV9jb3VudBAIbHBfY291bnQgD3RvdGFsX21lbW9yeV9tYsD8QA9hdmFpbF9tZW1vcnlfbWLAjcgQdG90YWxfdmlydHVhbF9tYuf///8QYXZhaWxfdmlydHVhbF9tYuf/4pcRdG90YWxfcGFnZWZpbGVfbWLCPEARYXZhaWxfcGFnZWZpbGVfbWLBs58OdXB0aW1lX3NlY29uZHPAb70=";

    #[test]
    fn parses_fixture_health_info_top_level_strings() {
        let bytes = decode_b64(HEALTH_INFO_B64);
        assert_eq!(bytes.len(), 1160);
        let (val, consumed) = parse(&bytes).unwrap();
        assert_eq!(consumed, 1160);

        assert_eq!(val.get("DataRoot").and_then(CbValue::as_str), Some(r"\\?\F:\Epic\DDC\Zen"));
        assert_eq!(
            val.get("AbsLogPath").and_then(CbValue::as_str),
            Some(r"\\?\F:\Epic\DDC\Zen\logs\zenserver.log")
        );
        // NB: the research doc claims this starts with "05." but the actual
        // string-length byte on the wire is 0x30 (48), and the bytes that
        // follow decode to "5.8.10-..." (no leading zero — the doc had an
        // off-by-one in the byte-count, treating the length byte as part
        // of the value).
        assert_eq!(
            val.get("BuildVersion").and_then(CbValue::as_str),
            Some("5.8.10-202605071938-windows-x64-release-fbacdecd")
        );
        assert_eq!(
            val.get("HttpServerClass").and_then(CbValue::as_str),
            Some("asio")
        );
        assert_eq!(val.get("Hostname").and_then(CbValue::as_str), Some("LANPC"));
        assert_eq!(
            val.get("Platform").and_then(CbValue::as_str),
            Some("windows")
        );
        assert_eq!(val.get("Arch").and_then(CbValue::as_str), Some("x64"));
        assert_eq!(
            val.get("OS").and_then(CbValue::as_str),
            Some("Windows 10.0 Build 26200")
        );
    }

    #[test]
    fn parses_fixture_health_info_numeric_and_bool_fields() {
        let bytes = decode_b64(HEALTH_INFO_B64);
        let (val, _) = parse(&bytes).unwrap();
        assert_eq!(val.get("Port").and_then(CbValue::as_u64), Some(8558));
        // Pid wire bytes are 0xC0 0x7C 0x30 (3-byte VarUInt → 0x7C30 = 31792).
        // The research doc speculated 27304 but the actual wire value at
        // probe time was 31792 — the ChildId string "Zen_27304_Startup"
        // refers to an earlier launch generation, not the live PID.
        assert_eq!(val.get("Pid").and_then(CbValue::as_u64), Some(31792));
        // Wire byte for IsDedicated is 0x8C = HasFieldName|BoolFalse (the doc
        // assumed true; the real probe captured the daemon launched without
        // a dedicated workspace flag, hence false).
        assert_eq!(
            val.get("IsDedicated").and_then(CbValue::as_bool),
            Some(false)
        );
    }

    #[test]
    fn parses_fixture_health_info_runtime_config_nested() {
        let bytes = decode_b64(HEALTH_INFO_B64);
        let (val, _) = parse(&bytes).unwrap();
        assert_eq!(
            val.get("RuntimeConfig.EffectivePort").and_then(CbValue::as_str),
            Some("8558")
        );
        assert_eq!(
            val.get("RuntimeConfig.BasePort").and_then(CbValue::as_str),
            Some("8558")
        );
        assert_eq!(
            val.get("RuntimeConfig.MemoryAllocator").and_then(CbValue::as_str),
            Some("mimalloc 2.2.7")
        );
        assert_eq!(
            val.get("RuntimeConfig.ChildId").and_then(CbValue::as_str),
            Some("Zen_27304_Startup")
        );
        // Detach=true is one of the few bools-as-strings that zen serialises
        assert_eq!(
            val.get("RuntimeConfig.Detach").and_then(CbValue::as_str),
            Some("true")
        );
    }

    #[test]
    fn parses_fixture_health_info_system_subobject() {
        let bytes = decode_b64(HEALTH_INFO_B64);
        let (val, _) = parse(&bytes).unwrap();
        // System sub-object — integers
        assert_eq!(
            val.get("System.cpu_count").and_then(CbValue::as_u64),
            Some(1)
        );
        assert_eq!(
            val.get("System.core_count").and_then(CbValue::as_u64),
            Some(16)
        );
        assert_eq!(val.get("System.lp_count").and_then(CbValue::as_u64), Some(32));
        // uptime_seconds is a 2-byte VarUInt for typical 1-65535 s ranges.
        let uptime = val
            .get("System.uptime_seconds")
            .and_then(CbValue::as_u64)
            .expect("uptime_seconds present");
        assert!(uptime > 0, "uptime should be non-zero");
    }

    #[test]
    fn parses_fixture_health_info_ip_addresses_array() {
        let bytes = decode_b64(HEALTH_INFO_B64);
        let (val, _) = parse(&bytes).unwrap();
        let ips = val.get("IpAddresses").and_then(CbValue::as_array).unwrap();
        // Single IP per the fixture
        assert_eq!(ips.len(), 1);
        assert_eq!(ips[0].as_str(), Some("192.168.10.20"));
    }

    // -------------------------------------------------------------------------
    // C.5 fixture: /stats/z$ — cache stats with floats
    // -------------------------------------------------------------------------

    const STATS_Z_B64: &str = "AoHegghyZXF1ZXN0c4C3iAVjb3VudINZiwlyYXRlX21lYW4/sRvepVM8E4sGcmF0ZV8xMdJAynniMQGLBnJhdGVfNTzUFQfVPXqeiwdyYXRlXzE1PrFufSN0GBmLBXRfYXZnP/3Cj4aCHnaLBXRfbWluPuI+xuUsPyOLBXRfbWF4QEqkuVh7whiLBXRfcDc1P5dCyn/rcqqLBXRfcDk1QCeU9w+WdfiLBXRfcDk5QEPpUaeSgLKLBnRfcDk5OUBJ+/x3tUNDggVjYWNoZYDbiA9iYWRyZXF1ZXN0Y291bnQAggNycGNXiAVjb3VudIMpiANvcHOFhoMHcmVjb3Jkcw+IBWNvdW50gmgDb3BzhMWDBnZhbHVlcw+IBWNvdW50gMEDb3BzgMGDBmNodW5rcw2IBWNvdW50AANvcHMAgwRzaXplFYgEZGlza/Ajm9ljBm1lbW9yecVnMIgEaGl0c4VdiAZtaXNzZXMniAZ3cml0ZXMCiwloaXRfcmF0aW8/7x271Hy8jogHY2lkaGl0c4nHiAljaWRtaXNzZXMAiAljaWR3cml0ZXMAgwNjaWQxgwRzaXplKogEdGlueeBu5XEFc21hbGzwHJ6sUAVsYXJnZeWSyLEFdG90YWzwIqBacg==";

    #[test]
    fn parses_fixture_stats_z_request_count() {
        let bytes = decode_b64(STATS_Z_B64);
        assert_eq!(bytes.len(), 481);
        let (val, consumed) = parse(&bytes).unwrap();
        assert_eq!(consumed, 481);
        // Wire bytes for requests.count are 0x83 0x59 = 2-byte VarUInt → 0x359 = 857.
        // (Research doc speculated 89 by reading just 0x59 — but 0x83 marks
        // the value as a 2-byte VarUInt, so the prefix nibble carries an
        // extra `0x3` in the high bits.)
        assert_eq!(
            val.get("requests.count").and_then(CbValue::as_u64),
            Some(0x359)
        );
    }

    #[test]
    fn parses_fixture_stats_z_cache_counters() {
        let bytes = decode_b64(STATS_Z_B64);
        let (val, _) = parse(&bytes).unwrap();
        // Same VarUInt-prefix re-interpretation as requests.count above.
        // cache.hits   0x85 0x5D → 0x55D = 1373
        // cache.misses 0x27       → 39   (1-byte; doc was right here)
        // cache.writes 0x02       → 2
        assert_eq!(val.get("cache.hits").and_then(CbValue::as_u64), Some(0x55D));
        assert_eq!(val.get("cache.misses").and_then(CbValue::as_u64), Some(39));
        assert_eq!(val.get("cache.writes").and_then(CbValue::as_u64), Some(2));
        // badrequestcount is 0 (1-byte VarUInt 0x00)
        assert_eq!(
            val.get("cache.badrequestcount").and_then(CbValue::as_u64),
            Some(0)
        );
    }

    #[test]
    fn parses_fixture_stats_z_hit_ratio_float() {
        let bytes = decode_b64(STATS_Z_B64);
        let (val, _) = parse(&bytes).unwrap();
        let ratio = val.get("cache.hit_ratio").and_then(CbValue::as_f64).unwrap();
        // Expected bit pattern 0x3FEF1DBBD47CBC8E → 0.9723796033994334
        assert!(
            (ratio - 0.9723796033994334).abs() < 1e-15,
            "ratio={ratio}"
        );
    }

    #[test]
    fn parses_fixture_stats_z_cache_size_subobject() {
        let bytes = decode_b64(STATS_Z_B64);
        let (val, _) = parse(&bytes).unwrap();
        // Both size.disk and size.memory are large uints; just assert they
        // decode without overflow and are non-zero. The exact values shift
        // every snapshot so we don't hard-code.
        let disk = val
            .get("cache.size.disk")
            .and_then(CbValue::as_u64)
            .expect("cache.size.disk");
        assert!(disk > 0);
        let mem = val
            .get("cache.size.memory")
            .and_then(CbValue::as_u64)
            .expect("cache.size.memory");
        assert!(mem > 0);
    }

    #[test]
    fn parses_fixture_stats_z_rpc_count_under_cache() {
        // The doc claimed `rpc.count` lived at top level but the real wire
        // tree has `cache.rpc.count`. Top-level fields are just
        // {requests, cache, cid}; rpc is one of cache's children.
        let bytes = decode_b64(STATS_Z_B64);
        let (val, _) = parse(&bytes).unwrap();
        let count = val
            .get("cache.rpc.count")
            .and_then(CbValue::as_u64)
            .expect("cache.rpc.count");
        // Actual decoded value from the wire (2-byte VarUInt 0x83 0x29).
        assert_eq!(count, 0x329);
    }

    // -------------------------------------------------------------------------
    // Malformed-input safety tests
    //
    // The parser must NEVER panic / OOM on garbage. Each of these inputs is
    // designed to trip a different failure mode; the assertion is just
    // "returned an error rather than panicking".
    // -------------------------------------------------------------------------

    #[test]
    fn malformed_truncated_object_size() {
        // Object with declared size 100 but only 2 bytes of payload.
        let bytes = [0x02, 0x64, 0x00, 0x00];
        assert!(matches!(
            parse(&bytes).unwrap_err(),
            CbError::LengthOverflow { .. }
        ));
    }

    #[test]
    fn malformed_truncated_string() {
        // String type with size 10 but only 3 bytes follow.
        let bytes = [0x07, 0x0A, b'a', b'b', b'c'];
        assert!(matches!(
            parse(&bytes).unwrap_err(),
            CbError::LengthOverflow { .. }
        ));
    }

    #[test]
    fn malformed_invalid_utf8_in_string() {
        // Length 2, payload 0xFF 0xFE (invalid UTF-8)
        let bytes = [0x07, 0x02, 0xFF, 0xFE];
        let err = parse(&bytes).unwrap_err();
        assert!(matches!(err, CbError::InvalidUtf8(_, _)));
    }

    #[test]
    fn malformed_empty_buffer() {
        assert!(matches!(parse(&[]).unwrap_err(), CbError::UnexpectedEof(_)));
    }

    #[test]
    fn malformed_huge_declared_length_does_not_oom() {
        // String type, then a VarUInt that decodes to ~10^17. The parser
        // must reject the length without trying to allocate that much.
        let bytes = [
            0x07, // String
            0xFF, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // 9-byte VarUInt
            b'x', b'y', // only 2 bytes of payload
        ];
        let err = parse(&bytes).unwrap_err();
        assert!(matches!(err, CbError::LengthOverflow { .. }));
    }

    #[test]
    fn malformed_unrecognised_type_is_error_not_panic() {
        // Type IDs 0x15..=0x1D are gaps in the spec (between ObjectId 0x14
        // and Custom* 0x1E). We don't know the framing rule for them, so
        // the parser must reject rather than guess.
        let bytes = [0x15];
        assert!(matches!(parse(&bytes).unwrap_err(), CbError::Malformed(_, _)));
        // Same for 0x1C — far enough from any handled type to be safe.
        assert!(matches!(parse(&[0x1C]).unwrap_err(), CbError::Malformed(_, _)));
    }

    #[test]
    fn malformed_none_type_is_rejected() {
        // 0x00 (None) is explicitly invalid in valid data per spec §3.3.
        assert!(matches!(
            parse(&[0x00]).unwrap_err(),
            CbError::Malformed(_, _)
        ));
    }

    #[test]
    fn malformed_object_field_missing_name_flag() {
        // Object with one field whose type byte lacks HasFieldName.
        // size = 3 bytes (type + 1-byte VarUInt name + 1-byte payload).
        let bytes = [0x02, 0x03, 0x07, 0x01, b'x'];
        assert!(matches!(
            parse(&bytes).unwrap_err(),
            CbError::Malformed(_, _)
        ));
    }

    // -------------------------------------------------------------------------
    // Helper API exercise tests
    // -------------------------------------------------------------------------

    #[test]
    fn get_returns_none_for_missing_segments() {
        let bytes = decode_b64(STATS_B64);
        let (val, _) = parse(&bytes).unwrap();
        assert!(val.get("nope").is_none());
        assert!(val.get("providers.nested").is_none()); // providers is array, not object
        // Empty path returns self
        assert!(val.get("").is_some());
    }

    #[test]
    fn coercion_helpers_reject_wrong_types() {
        let v = CbValue::String("abc".into());
        assert!(v.as_u64().is_none());
        assert!(v.as_bool().is_none());
        assert_eq!(v.as_str(), Some("abc"));

        let v = CbValue::Uint(42);
        assert_eq!(v.as_u64(), Some(42));
        assert_eq!(v.as_i64(), Some(42));
        assert_eq!(v.as_f64(), Some(42.0));
        assert!(v.as_str().is_none());

        // Negative int doesn't coerce to u64
        let v = CbValue::Int(-5);
        assert!(v.as_u64().is_none());
        assert_eq!(v.as_i64(), Some(-5));

        // Very large u64 doesn't coerce to i64
        let v = CbValue::Uint(u64::MAX);
        assert!(v.as_i64().is_none());
        assert_eq!(v.as_u64(), Some(u64::MAX));
    }

    #[test]
    fn parse_object_helper_rejects_non_object_root() {
        // Top-level null is not an object
        assert!(matches!(
            parse_object(&[0x01]).unwrap_err(),
            CbError::Malformed(_, _)
        ));
        // Top-level string is not an object
        assert!(matches!(
            parse_object(&[0x07, 0x01, b'x']).unwrap_err(),
            CbError::Malformed(_, _)
        ));
    }

    #[test]
    fn uniform_array_zero_width_with_trailing_bytes_errors_not_hangs() {
        // A malformed UniformArray whose element type is zero-width
        // (BoolFalse / BoolTrue / Null) would let `while pos < end` loop
        // forever because each element advances pos by zero. We require
        // count-based iteration with a tail-length check, so this kind of
        // malformed buffer must return a Malformed error promptly.
        //
        // Layout:
        //   0x05  T_UNIFORM_ARRAY (root, no field-name)
        //   0x05  payload_len = 5 (single-byte VarUInt)
        //   0x02  count = 2
        //   0x0C  element type = T_BOOL_FALSE (zero-width)
        //   0xFF 0xFF 0xFF  three trailing bytes that must not be consumed
        let bytes = [0x05, 0x05, 0x02, 0x0C, 0xFF, 0xFF, 0xFF];
        let err = parse(&bytes).unwrap_err();
        assert!(
            matches!(err, CbError::Malformed(_, _)),
            "expected Malformed, got {err:?}"
        );
    }

    #[test]
    fn integer_negative_decodes_i64_min_without_overflow() {
        // CB encodes IntegerNegative as (magnitude - 1), so i64::MIN has
        // magnitude = i64::MAX. The decoder previously did
        // `-((m as i64) + 1)` which overflows in debug builds at this
        // boundary; the explicit i64::MIN branch makes the conversion safe.
        //
        // VarUInt encoding of i64::MAX (= 0x7FFF_FFFF_FFFF_FFFF) is the
        // 9-byte form: prefix 0xFF, then 8 payload bytes 0x7F 0xFF * 7.
        let bytes = [
            T_INT_NEG, 0xFF, 0x7F, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
        ];
        let (value, consumed) = parse(&bytes).unwrap();
        assert_eq!(consumed, bytes.len());
        assert_eq!(value.as_i64(), Some(i64::MIN));
    }
}
