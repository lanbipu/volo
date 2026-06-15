//! Flag-based secret redaction for command-line strings and captured PS output.
//!
//! Plan 7 §12 (Red Lines) says secret values must never reach
//! `operations.log_text`. The existing value-based redactors in
//! `cli/domain_ini.rs::redact_in_string` and the copy in `cli/domain_env.rs`
//! only help when the caller already has the secret in hand (so they can ask
//! "scrub this exact string"). When the zen domain forwards command lines /
//! stderr snippets to logs, the caller may not be threading the value through
//! — but the *flag name* is always present. This module redacts based on the
//! flag name and rewrites whatever follows.
//!
//! # Supported syntaxes
//!
//! For each flag in [`SENSITIVE_FLAGS`]:
//!
//! ```text
//! --flag=value             -> --flag=[REDACTED]
//! --flag value             -> --flag [REDACTED]
//! --flag "value"           -> --flag "[REDACTED]"
//! --flag 'value'           -> --flag '[REDACTED]'
//! --flag="quoted value"    -> --flag="[REDACTED]"
//! --flag='quoted value'    -> --flag='[REDACTED]'
//! ```
//!
//! Inside a double-quoted span, BOTH POSIX-style `\"` AND PowerShell-style
//! `` `" `` escapes are respected — the value span extends past either form
//! and only terminates on a non-escaped matching quote. PowerShell sidecars
//! in T2.4 are the realistic source of command lines this redactor sees,
//! and a `` `" `` slipping past the scanner would leak the secret tail to
//! `operations.log_text`.
//!
//! # Edge cases
//!
//! - Flag at end of string with no value → left unchanged.
//! - Flag appears as a substring of a larger word (e.g. `--access-token-store`)
//!   → NOT redacted. The byte preceding the flag must be start-of-string,
//!   whitespace, or one of `;` / `&` / `|`. The byte following the flag name
//!   must be `=`, whitespace, or end-of-string.
//! - Multiple flags in one string → all redacted.
//! - Already-redacted strings (`--access-token [REDACTED]`) → no change.
//!   Redaction is idempotent: `redact(redact(s)) == redact(s)`.
//! - Empty value after `=` followed by whitespace / EOF
//!   (`--access-token= rest`) → becomes `--access-token=[REDACTED] rest`.
//!   A zero-length secret is still "a secret was present".
//!
//! # Case sensitivity
//!
//! Strict case-sensitive match against the lowercase entries in
//! [`SENSITIVE_FLAGS`]. Plan §12 lists the flags in lowercase only; mixed
//! case (e.g. `--Access-Token`) is *not* redacted. The PS sidecars in T2.4
//! standardize on lowercase, so this is safe. If a future caller introduces
//! a casing variant, add it explicitly to [`SENSITIVE_FLAGS`].

/// Flags whose values are treated as secrets and redacted by [`redact`].
///
/// Adding to this list is the recommended way to extend coverage. Match is
/// case-sensitive — include aliases explicitly.
pub const SENSITIVE_FLAGS: &[&str] = &["--access-token", "--password", "--api-key"];

/// Sentinel inserted in place of a redacted value.
pub const REDACTED: &str = "[REDACTED]";

/// Return `input` with the values of any [`SENSITIVE_FLAGS`] flag replaced
/// by [`REDACTED`]. See module docs for the full set of supported syntaxes.
///
/// Idempotent: redacting an already-redacted string returns it unchanged.
pub fn redact(input: &str) -> String {
    redact_with(input, SENSITIVE_FLAGS)
}

/// Single-flag variant — redacts one flag without scanning for any of the
/// others. Almost every caller wants [`redact`] instead; this is provided
/// for tests and for the rare case where a domain wants to scrub one
/// specific knob.
pub fn redact_flag(input: &str, flag: &str) -> String {
    redact_with(input, &[flag])
}

fn redact_with(input: &str, flags: &[&str]) -> String {
    if input.is_empty() || flags.is_empty() {
        return input.to_string();
    }

    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    // Track the last byte offset we've already committed to `out`. When we
    // hit a redaction transition, flush `&input[last_emit..i]` verbatim
    // before emitting the replacement. Because `last_emit` and `i` are
    // always at UTF-8 char boundaries (see invariants below), this slice
    // is safe and preserves multi-byte chars intact — fixing the previous
    // byte-by-byte cast that turned non-ASCII text into mojibake.
    //
    // Boundary invariants:
    //   - `i` starts at 0 (always a boundary).
    //   - `match_flag_at` only matches when `bytes[i..i+len]` equals a
    //     pure-ASCII flag string, so bytes[i] is `-` (ASCII) ⇒ boundary.
    //   - `consume_and_emit_value` returns the offset of an ASCII byte
    //     (whitespace / quote) or end-of-string ⇒ boundary.
    //   - Non-match path advances by `utf8_char_len(bytes[i])` ⇒ boundary.
    let mut i = 0usize;
    let mut last_emit = 0usize;

    while i < bytes.len() {
        // Probe for a flag match starting at byte `i`.
        if let Some(flag) = match_flag_at(bytes, i, flags) {
            // Need word-boundary before the flag.
            if !is_left_boundary(bytes, i) {
                // Not a flag — advance past one full UTF-8 char and continue.
                i += utf8_char_len(bytes[i]);
                continue;
            }

            let flag_end = i + flag.len();

            // Need word-boundary after the flag name: must be `=`, whitespace,
            // or end-of-string. Otherwise this is e.g. `--access-token-store`.
            let after = bytes.get(flag_end).copied();
            match after {
                None => {
                    // Flag at end of string with no value — leave unchanged.
                    // Just advance the cursor; defer flush.
                    i = flag_end;
                }
                Some(b'=') => {
                    // `--flag=value` form. Flush pre-flag span, then emit
                    // flag + `=` + redacted value.
                    out.push_str(&input[last_emit..i]);
                    out.push_str(flag);
                    out.push('=');
                    i = consume_and_emit_value(bytes, flag_end + 1, &mut out, flags);
                    last_emit = i;
                }
                Some(c) if is_ws(c) => {
                    // `--flag value` form. Peek past whitespace to see what
                    // the next token looks like. There are three cases:
                    //
                    // 1. End of input → no value, leave the flag unchanged
                    //    (same as the EOL `None` case).
                    //
                    // 2. Next token is another **known sensitive flag**
                    //    (matches one of `flags` exactly with proper
                    //    boundaries) → don't eat it as a value. If we did,
                    //    the scanner would skip past it and its real secret
                    //    value would leak verbatim. So we treat the current
                    //    flag as having no value (no [REDACTED] emitted)
                    //    and let the natural flush re-emit the whitespace
                    //    before the next flag.
                    //
                    // 3. Anything else (real value, unknown long flag,
                    //    short flag, dash-prefixed password) → redact as
                    //    the value. We can't tell whether `--hunter2` is a
                    //    real-but-unknown flag or a dash-prefixed password,
                    //    and over-redaction is safer than leaking.
                    let mut j = flag_end;
                    while j < bytes.len() && is_ws(bytes[j]) {
                        j += 1;
                    }
                    if j >= bytes.len() {
                        i = j;
                    } else if next_is_sensitive_flag(bytes, j, flags) {
                        i = flag_end;
                    } else {
                        out.push_str(&input[last_emit..i]);
                        out.push_str(flag);
                        out.push_str(&input[flag_end..j]);
                        i = consume_and_emit_value(bytes, j, &mut out, flags);
                        last_emit = i;
                    }
                }
                Some(_) => {
                    // Some non-boundary char (letter, digit, `-`, etc.) →
                    // not a real flag boundary. Advance past one char.
                    i += utf8_char_len(bytes[i]);
                }
            }
        } else {
            // No flag here — advance one full UTF-8 char.
            i += utf8_char_len(bytes[i]);
        }
    }

    // Final flush of any tail bytes that didn't trigger a redaction.
    out.push_str(&input[last_emit..]);
    out
}

/// Length in bytes of the UTF-8 codepoint that starts with `b`. Caller
/// guarantees `b` is the first byte of a UTF-8 sequence (a char boundary).
/// Defensive fallback for malformed input (continuation byte at boundary)
/// is `1` — keeps progress and avoids panics.
#[inline]
fn utf8_char_len(b: u8) -> usize {
    if b < 0x80 {
        1
    } else if b < 0xC0 {
        // Continuation byte at boundary = malformed UTF-8. Step by 1 to
        // make progress; the slice flush will then panic loudly if the
        // input was truly malformed (better than silent corruption).
        1
    } else if b < 0xE0 {
        2
    } else if b < 0xF0 {
        3
    } else {
        4
    }
}

/// If any flag in `flags` starts at `bytes[i]`, return it. Strict
/// case-sensitive match. Returns the longest-matching flag if multiple
/// would match (defensive — current SENSITIVE_FLAGS has no prefix
/// overlap).
fn match_flag_at<'a>(bytes: &[u8], i: usize, flags: &'a [&'a str]) -> Option<&'a str> {
    let mut best: Option<&str> = None;
    for &flag in flags {
        let fb = flag.as_bytes();
        if i + fb.len() <= bytes.len() && &bytes[i..i + fb.len()] == fb {
            if best.map_or(true, |b| flag.len() > b.len()) {
                best = Some(flag);
            }
        }
    }
    best
}

/// True if the byte preceding offset `i` is start-of-string, whitespace,
/// or one of `;` / `&` / `|` / `=` / `]` / `'` / `"`.
///
/// The `=` case matters when an operator (or buggy caller) writes
/// `--password=--api-key sk_live`: we want `--api-key` to be recognized
/// as a separate flag so its `sk_live` value gets redacted too.
///
/// The `]` case keeps `redact(redact(s)) == redact(s)` idempotent. After
/// a first pass, an input like `--password=--api-key sk_live` becomes
/// `--password=[REDACTED]--api-key [REDACTED]` with no whitespace between
/// `]` and `--api-key`. Without `]` as a boundary, a second pass would
/// fail to recognize `--api-key` as a flag.
///
/// The `'` / `"` cases handle log wrappers that quote an entire command
/// line: `args '--password hunter2'` or `"--api-key=sk"`. Without these,
/// the flag wouldn't be recognized and the secret would leak verbatim.
/// Inside such wrappers we also treat the matching close quote as a
/// value terminator (see `is_value_terminator`).
///
/// `--foo--access-token` still won't match because the byte before
/// `--access-token` would be `o` (not in the allowed set).
fn is_left_boundary(bytes: &[u8], i: usize) -> bool {
    if i == 0 {
        return true;
    }
    let p = bytes[i - 1];
    is_ws(p)
        || p == b';'
        || p == b'&'
        || p == b'|'
        || p == b'='
        || p == b']'
        || p == b'\''
        || p == b'"'
}

#[inline]
fn is_ws(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\r' | b'\n')
}

#[inline]
fn is_shell_separator(b: u8) -> bool {
    b == b';' || b == b'&' || b == b'|'
}

/// True if a sensitive flag follows the shell separator at `sep_pos`
/// (possibly after extra separators / whitespace). Used by the unquoted
/// value scan to decide whether a metacharacter in the value is a real
/// command separator (stop scanning, let the next sensitive flag be
/// detected) or just a literal byte inside the secret (keep consuming
/// so the tail doesn't leak).
///
/// Example: `--password foo;--api-key sk_live` → `sep_pos` points at `;`,
/// after-separator position is `--api-key` which IS sensitive → stop at
/// `;`. Example: `--password pa&ss next` → after `&` is `ss`, not a
/// sensitive flag → don't stop, consume entire `pa&ss` as value.
fn separator_leads_to_sensitive_flag(
    bytes: &[u8],
    sep_pos: usize,
    flags: &[&str],
) -> bool {
    let mut k = sep_pos + 1;
    while k < bytes.len() && (is_ws(bytes[k]) || is_shell_separator(bytes[k])) {
        k += 1;
    }
    if k >= bytes.len() {
        return false;
    }
    next_is_sensitive_flag(bytes, k, flags)
}

/// True when position `j` is the start of one of the known sensitive
/// flag names AND has a real word-boundary right after the flag name
/// (`=`, whitespace, or EOF). Used to detect a "next sensitive flag"
/// token after a missing-value flag.
fn next_is_sensitive_flag(bytes: &[u8], j: usize, flags: &[&str]) -> bool {
    if let Some(flag) = match_flag_at(bytes, j, flags) {
        let flag_end = j + flag.len();
        match bytes.get(flag_end).copied() {
            None => true,
            Some(b'=') => true,
            Some(c) if is_ws(c) => true,
            Some(_) => false,
        }
    } else {
        false
    }
}

/// Starting at `i`, examine the value that follows (possibly quoted) and
/// emit the replacement into `out`. Returns the new cursor position
/// (one past the end of the consumed value).
///
/// Handles three forms:
///   - `"..."` — emit `"[REDACTED]"`, skip to past matching close quote
///     (POSIX `\"` and PowerShell `` `" `` escapes inside are honored).
///   - `'...'` — emit `'[REDACTED]'`, skip to past matching close quote
///     (PowerShell `''` doubled-quote escape honored; POSIX literal otherwise).
///   - otherwise — emit `[REDACTED]`, skip to next whitespace / EOF.
///
/// `flags` lets the unquoted branch peek for "next token is another
/// sensitive flag, don't eat it" (mirroring the ws-form path so the
/// `=` form is equally safe).
///
/// If `bytes[i]` is whitespace or `i >= len`, treats the value as
/// empty: emits `[REDACTED]` and returns `i` unchanged.
fn consume_and_emit_value(bytes: &[u8], i: usize, out: &mut String, flags: &[&str]) -> usize {
    if i >= bytes.len() {
        // No value present at all — emit the sentinel anyway. A flag with a
        // trailing `=` and nothing after still signals "a secret was here".
        out.push_str(REDACTED);
        return i;
    }
    let first = bytes[i];
    if is_ws(first) {
        // `--flag= value` — empty value, then a normal token follows.
        out.push_str(REDACTED);
        return i;
    }

    match first {
        b'"' => {
            out.push('"');
            out.push_str(REDACTED);
            // Skip past the original value, respecting BOTH POSIX `\"` AND
            // PowerShell `` `" `` escape forms inside the double-quoted span.
            //
            // PowerShell is the realistic source of command lines we'll
            // redact (PS sidecars in T2.4). PowerShell uses backtick as the
            // escape character — `` `" `` is a literal quote inside a
            // double-quoted string, and `` `` `` is a literal backtick.
            // Without the backtick branch, `--password "ab`"cd"` would
            // terminate the value early and leak `cd"` into the log.
            //
            // POSIX `\"` is kept too because the redactor is also used on
            // captured stderr that may originate from bash / cmd.exe wrappers
            // that pre-escape with `\`.
            let mut j = i + 1;
            while j < bytes.len() {
                let b = bytes[j];
                if (b == b'\\' || b == b'`') && j + 1 < bytes.len() {
                    // Skip the escape character AND the escaped byte
                    // (typically the escaped quote or escape char itself).
                    // Keeps the value span intact so the closing quote is
                    // recognized at the right offset.
                    j += 2;
                    continue;
                }
                if b == b'"' {
                    break;
                }
                j += 1;
            }
            // Emit closing quote if we actually found one; if we ran off the
            // end of the string the input was malformed but we still leave a
            // syntactically tidy redaction in the output.
            out.push('"');
            if j < bytes.len() {
                j + 1
            } else {
                j
            }
        }
        b'\'' => {
            out.push('\'');
            out.push_str(REDACTED);
            // Single-quoted strings:
            //   - POSIX: no escape processing — first `'` ends the span.
            //   - PowerShell: `''` (doubled quote) is a literal single quote
            //     inside the value. Stopping at the first inner `'` would
            //     leak the suffix to the log, so consume doubled quotes as
            //     a non-terminator.
            //
            // The two dialects don't conflict: in POSIX `'ab''cd'` is two
            // adjacent single-quoted strings (= literal `abcd`), which is
            // exotic but rare in PS sidecar invocations. Erring on the side
            // of "redact more" is the right call for a secret scrubber:
            // worse case for PowerShell users is a slightly over-eager
            // redaction; worse case for POSIX users is identical because
            // the entire concatenated value is still the secret.
            let mut j = i + 1;
            while j < bytes.len() {
                if bytes[j] == b'\'' {
                    // Doubled `''` → literal quote inside PS single-quoted
                    // string. Skip both bytes and keep scanning.
                    if j + 1 < bytes.len() && bytes[j + 1] == b'\'' {
                        j += 2;
                        continue;
                    }
                    break;
                }
                j += 1;
            }
            out.push('\'');
            if j < bytes.len() {
                j + 1
            } else {
                j
            }
        }
        _ => {
            out.push_str(REDACTED);
            // Defense-in-depth for the `=` form: if the apparent value is
            // another KNOWN sensitive flag (e.g.,
            // `--password=--api-key sk_live`), don't consume past it. If
            // we did, the next flag's real secret would leak. Match logic
            // mirrors the ws-form's `next_is_sensitive_flag` check so the
            // `=` and ` ` forms are equally safe.
            //
            // Unknown `--xxx` tokens and dash-prefixed values (`-hunter2`)
            // are still consumed as values — they're more likely real
            // passwords than legitimate "next flag" tokens, and erring
            // toward over-redaction beats leaking.
            if next_is_sensitive_flag(bytes, i, flags) {
                return i;
            }
            // Unquoted: consume up to the next value terminator.
            //
            // Terminators (in order of check):
            // - Whitespace always ends the token (standard shell splitting).
            // - Shell separators (`;` / `&` / `|`) end the token ONLY when
            //   they're followed by another sensitive flag — otherwise a
            //   secret literally containing `&` or `;` (e.g. `pa&ss`) would
            //   be truncated and the tail would leak.
            // - A sensitive flag starting at a left-boundary position
            //   (e.g., right after `]` from a previous `[REDACTED]`
            //   sentinel) also terminates — without this, the second pass
            //   of `redact(redact(input))` would consume the
            //   `--api-key`-style flag glued to the previous sentinel,
            //   breaking idempotency.
            let mut j = i;
            while j < bytes.len() {
                let b = bytes[j];
                if is_ws(b) {
                    break;
                }
                if is_shell_separator(b)
                    && separator_leads_to_sensitive_flag(bytes, j, flags)
                {
                    break;
                }
                // Close-quote of a log wrapper terminates the unquoted
                // value (matches the `'` / `"` left-boundary cases).
                if b == b'\'' || b == b'"' {
                    break;
                }
                if j > i
                    && is_left_boundary(bytes, j)
                    && next_is_sensitive_flag(bytes, j, flags)
                {
                    break;
                }
                j += 1;
            }
            j
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // -------- UTF-8 preservation (Codex review fix) --------

    #[test]
    fn preserves_chinese_text_around_redacted_flag() {
        // PowerShell localized errors / project paths often contain CJK.
        // Byte-by-byte casting would have turned each multi-byte char into
        // mojibake; the span-flush implementation keeps them intact.
        let input = "运行命令 cmd --password 我的秘密 完成";
        let out = redact(input);
        assert_eq!(out, "运行命令 cmd --password [REDACTED] 完成");
    }

    #[test]
    fn preserves_emoji_around_redacted_flag() {
        // 4-byte UTF-8 codepoint (U+1F512 🔒) — exercises the 4-byte branch
        // of utf8_char_len.
        let input = "before 🔒 cmd --api-key=xyz 🚀 after";
        let out = redact(input);
        assert_eq!(out, "before 🔒 cmd --api-key=[REDACTED] 🚀 after");
    }

    #[test]
    fn preserves_latin_diacritics_in_unredacted_text() {
        // 2-byte UTF-8 codepoints (Café = U+00E9 é).
        let input = "Café --password='secret café' bistro";
        let out = redact(input);
        assert_eq!(out, "Café --password='[REDACTED]' bistro");
    }

    #[test]
    fn input_with_only_cjk_and_no_flags_round_trips_byte_identical() {
        let input = "完全没有标志的中文字符串";
        assert_eq!(redact(input), input);
    }

    #[test]
    fn cjk_value_in_quoted_password_is_replaced() {
        // The value itself contains CJK; redaction still produces [REDACTED]
        // and the surrounding text stays intact.
        let input = r#"cmd --password "中文密码 with spaces" rest"#;
        let out = redact(input);
        assert_eq!(out, r#"cmd --password "[REDACTED]" rest"#);
    }

    // -------- PowerShell-escaped quote (Codex P1 fix) --------

    #[test]
    fn powershell_backtick_escaped_quote_does_not_leak_secret_tail() {
        // PowerShell uses backtick as escape: `--password "ab`"cd"` means
        // the value is literally `ab"cd`. Before the fix the scanner
        // terminated at the inner `"` and flushed `cd"` to the output,
        // leaking the suffix of the secret. After the fix, the entire
        // span is consumed.
        let input = "cmd --password \"ab`\"cd\" rest";
        let out = redact(input);
        assert_eq!(out, "cmd --password \"[REDACTED]\" rest");
        assert!(
            !out.contains("cd"),
            "redacted output must not contain any portion of the secret value, got {out:?}"
        );
    }

    #[test]
    fn powershell_backtick_escaped_backtick_inside_value_handled() {
        // ` `` ` inside a "..." span is a literal backtick. Must not
        // terminate the value or leak the tail.
        let input = "cmd --api-key \"x``y\" rest";
        let out = redact(input);
        assert_eq!(out, "cmd --api-key \"[REDACTED]\" rest");
    }

    #[test]
    fn posix_backslash_escaped_quote_still_works() {
        // Adding the backtick branch must not regress the POSIX-style
        // escape path.
        let input = "cmd --password \"a\\\"b\" rest";
        let out = redact(input);
        assert_eq!(out, "cmd --password \"[REDACTED]\" rest");
    }

    #[test]
    fn powershell_doubled_single_quote_does_not_leak_secret_tail() {
        // PowerShell single-quoted: `''` is a literal `'`. Before the fix,
        // the scanner stopped at the first inner `'` and leaked `cd' rest`
        // into the output. After the fix, the entire `ab''cd` span is
        // consumed and replaced.
        let input = "cmd --password 'ab''cd' rest";
        let out = redact(input);
        assert_eq!(out, "cmd --password '[REDACTED]' rest");
        assert!(
            !out.contains("cd"),
            "redacted output must not leak any portion of the secret value, got {out:?}"
        );
    }

    #[test]
    fn multiple_doubled_single_quotes_inside_value() {
        // Multiple `''` runs in one value — each must be consumed as escape.
        let input = "cmd --api-key 'a''b''c' rest";
        let out = redact(input);
        assert_eq!(out, "cmd --api-key '[REDACTED]' rest");
    }

    // -------- Missing-value swallowing next flag (Codex P1 fix) --------

    #[test]
    fn missing_value_does_not_swallow_next_sensitive_flag() {
        // Pre-fix bug: `--password` had no value, so the scanner consumed
        // `--api-key` as its (unquoted) value and then `sk_live` was
        // flushed verbatim → secret leak. After fix, `--password` is left
        // alone (no value present) and `--api-key sk_live` is redacted
        // normally.
        let input = "cmd --password --api-key sk_live";
        let out = redact(input);
        assert_eq!(out, "cmd --password --api-key [REDACTED]");
        assert!(
            !out.contains("sk_live"),
            "secret leaked through missing-value fallback, got {out:?}"
        );
    }

    #[test]
    fn dash_prefixed_password_is_redacted_not_treated_as_flag() {
        // Legitimate dash-prefixed password (e.g., `-hunter2`) MUST be
        // redacted, not left as bait for the next flag. Without this we
        // leak the secret directly into the log.
        let input = "cmd --password -hunter2 rest";
        let out = redact(input);
        assert_eq!(out, "cmd --password [REDACTED] rest");
        assert!(
            !out.contains("hunter2"),
            "dash-prefixed secret leaked, got {out:?}"
        );
    }

    #[test]
    fn equals_form_dash_prefixed_secret_is_redacted() {
        // `--password=-hunter2` same principle in the `=` form.
        let input = "cmd --password=-hunter2 rest";
        let out = redact(input);
        assert_eq!(out, "cmd --password=[REDACTED] rest");
        assert!(!out.contains("hunter2"));
    }

    #[test]
    fn missing_value_then_sensitive_flag_is_not_swallowed() {
        // The "next token is another flag" detection only triggers when
        // the next token EXACTLY matches a known sensitive flag. Here
        // `--api-key` IS in SENSITIVE_FLAGS, so `--password` is treated
        // as having no value and `--api-key sk_live` is redacted on its
        // own iteration.
        let input = "cmd --password --api-key sk_live";
        let out = redact(input);
        assert_eq!(out, "cmd --password --api-key [REDACTED]");
        assert!(!out.contains("sk_live"));
    }

    #[test]
    fn double_dash_unknown_value_is_redacted_as_password() {
        // `--hunter2` is NOT in SENSITIVE_FLAGS, so it's treated as the
        // value of `--password` and redacted — better than leaking what
        // might be a legitimate `--`-prefixed password.
        let input = "cmd --password --hunter2 rest";
        let out = redact(input);
        assert_eq!(out, "cmd --password [REDACTED] rest");
        assert!(
            !out.contains("hunter2"),
            "double-dash unknown value leaked, got {out:?}"
        );
    }

    #[test]
    fn equals_form_double_dash_unknown_value_is_redacted() {
        // Same principle, `=` form: `--password=--hunter2` redacts
        // `--hunter2` because it's not a known sensitive flag.
        let input = "cmd --password=--hunter2 rest";
        let out = redact(input);
        assert_eq!(out, "cmd --password=[REDACTED] rest");
        assert!(!out.contains("hunter2"));
    }

    // -------- Shell command separators in unquoted values (Codex P1 fix) --------

    #[test]
    fn semicolon_separator_does_not_swallow_next_sensitive_flag() {
        // Without the separator stop, `foo;--api-key` would be consumed as
        // the unquoted value of `--password`, then `sk_live` would flush
        // verbatim → secret leak. After the fix, the unquoted scan stops
        // at `;` and the scanner picks up `--api-key sk_live` on the next
        // iteration.
        let input = "cmd --password=foo;--api-key sk_live";
        let out = redact(input);
        assert_eq!(out, "cmd --password=[REDACTED];--api-key [REDACTED]");
        assert!(
            !out.contains("sk_live"),
            "semicolon-separated second secret leaked, got {out:?}"
        );
    }

    #[test]
    fn ampersand_separator_does_not_swallow_next_sensitive_flag() {
        // `&&` is a bash chain operator; the scanner sees two `&` bytes,
        // both of which are value terminators.
        let input = "cmd --password=foo&&--api-key sk_live";
        let out = redact(input);
        assert_eq!(out, "cmd --password=[REDACTED]&&--api-key [REDACTED]");
        assert!(!out.contains("sk_live"));
    }

    #[test]
    fn pipe_separator_does_not_swallow_next_sensitive_flag() {
        let input = "cmd --password=foo|--api-key sk_live";
        let out = redact(input);
        assert_eq!(out, "cmd --password=[REDACTED]|--api-key [REDACTED]");
        assert!(!out.contains("sk_live"));
    }

    #[test]
    fn ws_form_separator_does_not_swallow_next_sensitive_flag() {
        // Same defense in the ` ` form path.
        let input = "cmd --password foo;--api-key sk_live";
        let out = redact(input);
        assert_eq!(out, "cmd --password [REDACTED];--api-key [REDACTED]");
        assert!(!out.contains("sk_live"));
    }

    #[test]
    fn secret_containing_ampersand_is_redacted_completely() {
        // A password with `&` in it (e.g. `pa&ss`) was previously
        // truncated at the separator, leaking the tail. Now the
        // separator only terminates the value when it's followed by
        // another sensitive flag.
        let input = "cmd --password pa&ss next";
        let out = redact(input);
        assert_eq!(out, "cmd --password [REDACTED] next");
        // assert_eq above is the strict check; can't use a substring
        // assertion here because the word `password` itself contains "ss".
    }

    #[test]
    fn secret_containing_semicolon_is_redacted_completely() {
        // Similar: `--password pa;ss next` shouldn't leak `ss`.
        let input = "cmd --password pa;ss next";
        let out = redact(input);
        assert_eq!(out, "cmd --password [REDACTED] next");
        // strict assert_eq above suffices (`password` contains "ss").
    }

    #[test]
    fn secret_containing_pipe_is_redacted_completely() {
        let input = "cmd --password pa|ss next";
        let out = redact(input);
        assert_eq!(out, "cmd --password [REDACTED] next");
        // strict assert_eq above suffices (`password` contains "ss").
    }

    #[test]
    fn secret_containing_separator_then_sensitive_flag_chain() {
        // `--password pa&ss --api-key sk_live` — the separator is part
        // of the password, but `--api-key sk_live` after whitespace is a
        // separate sensitive flag. Both get redacted, the password's `&`
        // is preserved inside the redacted span (not split).
        let input = "cmd --password pa&ss --api-key sk_live";
        let out = redact(input);
        assert_eq!(out, "cmd --password [REDACTED] --api-key [REDACTED]");
        // strict assert_eq above suffices (`password` contains "ss").
        assert!(!out.contains("sk_live"));
    }

    // -------- Idempotency under adjacent flags (Codex P3 fix) --------

    #[test]
    fn double_redact_is_idempotent_for_adjacent_flag_edge_case() {
        // `--password=--api-key sk_live` produces
        // `--password=[REDACTED]--api-key [REDACTED]` on first pass. The
        // second pass must NOT consume `--api-key` as part of the first
        // value (without the `]` left-boundary, it would).
        let input = "cmd --password=--api-key sk_live";
        let pass1 = redact(input);
        let pass2 = redact(&pass1);
        assert_eq!(
            pass1, pass2,
            "redact() must be idempotent — got pass1={pass1:?} pass2={pass2:?}"
        );
    }

    // -------- Quoted command-line wrappers (Codex P1 fix) --------

    #[test]
    fn flag_inside_single_quoted_log_wrapper_is_redacted() {
        // Log wrappers commonly print `args '--password hunter2'`. The
        // flag is preceded by `'` rather than whitespace; without `'`
        // in the left-boundary set, the flag wouldn't be recognized and
        // the secret would leak.
        let input = "args '--password hunter2'";
        let out = redact(input);
        assert_eq!(out, "args '--password [REDACTED]'");
    }

    #[test]
    fn flag_inside_double_quoted_log_wrapper_is_redacted() {
        let input = "args \"--api-key=sk\"";
        let out = redact(input);
        assert_eq!(out, "args \"--api-key=[REDACTED]\"");
    }

    #[test]
    fn redacted_marker_does_not_swallow_following_flag_on_rescan() {
        // Directly check the second-pass scenario: input already has
        // `[REDACTED]` glued to `--api-key`. The scanner must see
        // `--api-key` as a flag.
        let input = "cmd --password=[REDACTED]--api-key plain";
        let out = redact(input);
        // `--password=` followed by `[REDACTED]` is just a literal value
        // that gets redacted again to `[REDACTED]`. `--api-key plain` is
        // a real sensitive-flag occurrence and `plain` gets redacted too.
        assert_eq!(out, "cmd --password=[REDACTED]--api-key [REDACTED]");
        assert!(!out.contains("plain"));
    }

    #[test]
    fn equals_form_with_flag_lookalike_value_does_not_swallow_next() {
        // `--password=--api-key x` — the `=` form reaches consume_and_emit_value
        // directly. The unquoted branch must refuse to consume a `-`-prefixed
        // token as a value.
        let input = "cmd --password=--api-key sk_live";
        let out = redact(input);
        assert_eq!(out, "cmd --password=[REDACTED]--api-key [REDACTED]");
        assert!(!out.contains("sk_live"));
    }

    #[test]
    fn quoted_flag_lookalike_value_is_still_redacted() {
        // If a flag-looking string is INSIDE quotes, it IS the value and
        // must be redacted. The dash-check applies only to unquoted values.
        let input = "cmd --password \"--api-key fakevalue\" rest";
        let out = redact(input);
        assert_eq!(out, "cmd --password \"[REDACTED]\" rest");
    }

    // -------- --flag=value form --------

    #[test]
    fn redacts_access_token_eq_value() {
        assert_eq!(
            redact("cmd --access-token=abc123"),
            "cmd --access-token=[REDACTED]"
        );
    }

    #[test]
    fn redacts_password_eq_value() {
        assert_eq!(redact("cmd --password=hunter2"), "cmd --password=[REDACTED]");
    }

    #[test]
    fn redacts_api_key_eq_value() {
        assert_eq!(
            redact("cmd --api-key=sk-abc-123"),
            "cmd --api-key=[REDACTED]"
        );
    }

    // -------- --flag value (space-separated) form --------

    #[test]
    fn redacts_access_token_space_value() {
        assert_eq!(
            redact("cmd --access-token abc123"),
            "cmd --access-token [REDACTED]"
        );
    }

    #[test]
    fn redacts_password_space_value() {
        assert_eq!(redact("cmd --password hunter2"), "cmd --password [REDACTED]");
    }

    #[test]
    fn redacts_api_key_space_value() {
        assert_eq!(
            redact("cmd --api-key sk-abc-123"),
            "cmd --api-key [REDACTED]"
        );
    }

    // -------- --flag "value" (double-quoted) form --------

    #[test]
    fn redacts_access_token_double_quoted() {
        assert_eq!(
            redact("cmd --access-token \"abc 123\""),
            "cmd --access-token \"[REDACTED]\""
        );
    }

    #[test]
    fn redacts_password_double_quoted() {
        assert_eq!(
            redact("cmd --password \"p@ss word\""),
            "cmd --password \"[REDACTED]\""
        );
    }

    #[test]
    fn redacts_api_key_double_quoted() {
        assert_eq!(
            redact("cmd --api-key \"sk abc 123\""),
            "cmd --api-key \"[REDACTED]\""
        );
    }

    // -------- --flag 'value' (single-quoted) form --------

    #[test]
    fn redacts_access_token_single_quoted() {
        assert_eq!(
            redact("cmd --access-token 'abc 123'"),
            "cmd --access-token '[REDACTED]'"
        );
    }

    #[test]
    fn redacts_password_single_quoted() {
        assert_eq!(
            redact("cmd --password 'p@ss word'"),
            "cmd --password '[REDACTED]'"
        );
    }

    #[test]
    fn redacts_api_key_single_quoted() {
        assert_eq!(
            redact("cmd --api-key 'sk abc 123'"),
            "cmd --api-key '[REDACTED]'"
        );
    }

    // -------- --flag='value' (= with single quote) form --------

    #[test]
    fn redacts_access_token_eq_single_quoted() {
        assert_eq!(
            redact("cmd --access-token='abc 123'"),
            "cmd --access-token='[REDACTED]'"
        );
    }

    #[test]
    fn redacts_password_eq_single_quoted() {
        assert_eq!(
            redact("cmd --password='p@ss word'"),
            "cmd --password='[REDACTED]'"
        );
    }

    #[test]
    fn redacts_api_key_eq_single_quoted() {
        assert_eq!(
            redact("cmd --api-key='sk abc 123'"),
            "cmd --api-key='[REDACTED]'"
        );
    }

    // -------- --flag="value" (= with double quote) form --------

    #[test]
    fn redacts_access_token_eq_double_quoted() {
        assert_eq!(
            redact("cmd --access-token=\"abc 123\""),
            "cmd --access-token=\"[REDACTED]\""
        );
    }

    #[test]
    fn redacts_password_eq_double_quoted() {
        assert_eq!(
            redact("cmd --password=\"p@ss word\""),
            "cmd --password=\"[REDACTED]\""
        );
    }

    #[test]
    fn redacts_api_key_eq_double_quoted() {
        assert_eq!(
            redact("cmd --api-key=\"sk abc 123\""),
            "cmd --api-key=\"[REDACTED]\""
        );
    }

    // -------- end-of-line / EOF cases --------

    #[test]
    fn flag_at_eof_with_no_value_left_unchanged() {
        // Plan: "Flag at end of line with no value → leave unchanged".
        assert_eq!(redact("cmd --access-token"), "cmd --access-token");
    }

    #[test]
    fn flag_with_eq_and_no_value_redacted_with_empty() {
        // Plan: "Empty value (`--access-token=` followed by space / EOL) →
        // redact to `--access-token=[REDACTED]`".
        assert_eq!(redact("cmd --access-token="), "cmd --access-token=[REDACTED]");
    }

    #[test]
    fn flag_with_eq_then_space_then_more_redacts_empty() {
        assert_eq!(
            redact("cmd --access-token= other"),
            "cmd --access-token=[REDACTED] other"
        );
    }

    #[test]
    fn flag_at_eof_with_value() {
        assert_eq!(
            redact("cmd --access-token sekrit"),
            "cmd --access-token [REDACTED]"
        );
    }

    // -------- multiple flags in one string --------

    #[test]
    fn multiple_flags_all_redacted() {
        let input = "cmd --access-token=tok --password p1 --api-key 'a b'";
        let expected =
            "cmd --access-token=[REDACTED] --password [REDACTED] --api-key '[REDACTED]'";
        assert_eq!(redact(input), expected);
    }

    #[test]
    fn flag_then_other_arg_then_flag() {
        let input = "tool --verbose --access-token=secret --output /tmp/x --password hunter";
        let expected =
            "tool --verbose --access-token=[REDACTED] --output /tmp/x --password [REDACTED]";
        assert_eq!(redact(input), expected);
    }

    // -------- idempotency --------

    #[test]
    fn idempotent_already_redacted() {
        let s = "cmd --access-token=[REDACTED]";
        assert_eq!(redact(s), s);
    }

    #[test]
    fn idempotent_double_redact_eq_single() {
        let s = "cmd --access-token=abc --password sek";
        let once = redact(s);
        let twice = redact(&once);
        assert_eq!(once, twice);
    }

    #[test]
    fn idempotent_quoted() {
        let s = "cmd --password \"[REDACTED]\"";
        assert_eq!(redact(s), s);
    }

    // -------- word boundary --------

    #[test]
    fn word_boundary_suffix_not_redacted() {
        // `--access-token-store` is NOT a redacted flag.
        let s = "cmd --access-token-store /var/secrets";
        assert_eq!(redact(s), s);
    }

    #[test]
    fn flag_not_redacted_when_glued_to_prev_word() {
        // No leading boundary → not a real flag start.
        let s = "x--access-token=foo";
        assert_eq!(redact(s), s);
    }

    #[test]
    fn flag_after_semicolon_is_redacted() {
        assert_eq!(
            redact("cmd;--access-token=abc"),
            "cmd;--access-token=[REDACTED]"
        );
    }

    #[test]
    fn flag_after_pipe_is_redacted() {
        assert_eq!(
            redact("a|--password=p"),
            "a|--password=[REDACTED]"
        );
    }

    #[test]
    fn flag_after_amp_is_redacted() {
        assert_eq!(
            redact("a&--api-key=k"),
            "a&--api-key=[REDACTED]"
        );
    }

    // -------- case sensitivity (strict — document) --------

    #[test]
    fn uppercase_flag_not_redacted_strict() {
        // Case-sensitive: --Access-Token is left alone.
        let s = "cmd --Access-Token=secret";
        assert_eq!(redact(s), s);
    }

    #[test]
    fn mixed_case_flag_not_redacted_strict() {
        let s = "cmd --API-KEY=k";
        assert_eq!(redact(s), s);
    }

    // -------- empty / no-flag input --------

    #[test]
    fn empty_input() {
        assert_eq!(redact(""), "");
    }

    #[test]
    fn string_with_no_flags_unchanged() {
        let s = "cmd --verbose --output /tmp/x";
        assert_eq!(redact(s), s);
    }

    #[test]
    fn string_with_only_token_word_unchanged() {
        // The word "token" alone is not a redacted flag.
        let s = "access token retrieved";
        assert_eq!(redact(s), s);
    }

    // -------- backslash-quote inside double-quoted value --------

    #[test]
    fn double_quoted_value_with_escaped_quote() {
        // Input: --password "a\"b c"
        // The value span should consume `\"` and stop at the unescaped `"`.
        let input = "cmd --password \"a\\\"b c\" more";
        let expected = "cmd --password \"[REDACTED]\" more";
        assert_eq!(redact(input), expected);
    }

    #[test]
    fn double_quoted_value_with_escaped_backslash() {
        // Trailing `\\` before `"`. With our escape handling we consume the
        // pair and then the next `"` closes the span.
        let input = "cmd --password \"a\\\\\" tail";
        let expected = "cmd --password \"[REDACTED]\" tail";
        assert_eq!(redact(input), expected);
    }

    // -------- redact_flag (single-flag) --------

    #[test]
    fn redact_flag_only_targets_named_flag() {
        let input = "cmd --access-token=a --password=p";
        // Only redact --password, leave --access-token alone.
        assert_eq!(
            redact_flag(input, "--password"),
            "cmd --access-token=a --password=[REDACTED]"
        );
    }

    #[test]
    fn redact_flag_for_unknown_flag_is_noop() {
        let input = "cmd --access-token=a";
        assert_eq!(redact_flag(input, "--never-existing-flag"), input);
    }

    // -------- misc realism --------

    #[test]
    fn powershell_style_invocation() {
        let input = "powershell -File .\\Zen-CacheStats.ps1 -Endpoint http://host:8558 --access-token abcd1234";
        let expected = "powershell -File .\\Zen-CacheStats.ps1 -Endpoint http://host:8558 --access-token [REDACTED]";
        assert_eq!(redact(input), expected);
    }

    #[test]
    fn quoted_value_with_spaces_only() {
        let input = "cmd --password '   ' rest";
        let expected = "cmd --password '[REDACTED]' rest";
        assert_eq!(redact(input), expected);
    }

    #[test]
    fn flag_value_then_arg_unaffected() {
        // After redacting --access-token's value, --output and its arg are
        // emitted verbatim.
        let input = "cmd --access-token=abc --output /tmp/log.txt";
        let expected = "cmd --access-token=[REDACTED] --output /tmp/log.txt";
        assert_eq!(redact(input), expected);
    }

    #[test]
    fn sensitive_flags_constant_contains_three() {
        // Guardrail — if the plan-listed flag set changes, update both the
        // constant and the doc comment.
        assert_eq!(SENSITIVE_FLAGS.len(), 3);
        assert!(SENSITIVE_FLAGS.contains(&"--access-token"));
        assert!(SENSITIVE_FLAGS.contains(&"--password"));
        assert!(SENSITIVE_FLAGS.contains(&"--api-key"));
    }
}
