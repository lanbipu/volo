//! Three-level project identity matcher: by-name, manual alias, manual path.
//! The v1 automatic matcher groups by `.uproject` filename stem.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DiscoveredUproject {
    pub machine_id: i64,
    pub abs_path: String,
    pub uproject_path: String,
    pub uproject_filename: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MatchKind {
    Auto,
    ManualAlias,
    ManualPath,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MatchedProject {
    pub stem_lower: String,
    pub canonical_filename: String,
    pub locations: Vec<DiscoveredUproject>,
    pub match_kind: MatchKind,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MatchOutcome {
    pub matched: Vec<MatchedProject>,
    pub ambiguous: Vec<DiscoveredUproject>,
}

pub fn stem_lower(filename: &str) -> String {
    let stem = filename
        .strip_suffix(".uproject")
        .or_else(|| filename.strip_suffix(".UPROJECT"))
        .unwrap_or(filename);
    stem.to_lowercase()
}

/// Result of classifying a `.uproject` EngineAssociation field.
///
/// EngineAssociation has four forms in the wild:
/// - empty string (project sitting next to the engine source tree)
/// - "5.7" / "5.7.0" (standard launcher install reference)
/// - "{GUID}" (custom build, looked up via Windows registry — out of scope here)
/// - anything else (treat as unknown)
///
/// `raw` always carries the input verbatim for audit/debug; version fields are
/// only populated for kind="version" so downstream routing can safely treat
/// NULL major/minor as "force legacy backend".
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedEngineAssociation {
    pub raw: Option<String>,
    pub kind: &'static str,
    pub ue_version_major: Option<i64>,
    pub ue_version_minor: Option<i64>,
}

impl ParsedEngineAssociation {
    fn empty(raw: Option<String>) -> Self {
        Self {
            raw,
            kind: "empty",
            ue_version_major: None,
            ue_version_minor: None,
        }
    }

    fn unknown(raw: Option<String>) -> Self {
        Self {
            raw,
            kind: "unknown",
            ue_version_major: None,
            ue_version_minor: None,
        }
    }

    fn guid(raw: Option<String>) -> Self {
        Self {
            raw,
            kind: "guid",
            ue_version_major: None,
            ue_version_minor: None,
        }
    }

    fn version(raw: Option<String>, major: i64, minor: i64) -> Self {
        Self {
            raw,
            kind: "version",
            ue_version_major: Some(major),
            ue_version_minor: Some(minor),
        }
    }
}

pub fn parse_engine_association(raw: Option<&str>) -> ParsedEngineAssociation {
    let Some(input) = raw else {
        return ParsedEngineAssociation::empty(None);
    };
    let raw_owned = Some(input.to_string());
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return ParsedEngineAssociation::empty(raw_owned);
    }
    if is_guid_form(trimmed) {
        return ParsedEngineAssociation::guid(raw_owned);
    }
    if let Some((major, minor)) = parse_version_form(trimmed) {
        return ParsedEngineAssociation::version(raw_owned, major, minor);
    }
    ParsedEngineAssociation::unknown(raw_owned)
}

/// Accepts both `{xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx}` and the bare form.
/// We do not validate the UUID variant/version bits — Unreal generates them,
/// we just need to recognize the shape.
fn is_guid_form(value: &str) -> bool {
    let inner = value.strip_prefix('{').and_then(|s| s.strip_suffix('}'));
    let candidate = inner.unwrap_or(value);
    let bytes = candidate.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (i, b) in bytes.iter().enumerate() {
        let is_dash_slot = matches!(i, 8 | 13 | 18 | 23);
        if is_dash_slot {
            if *b != b'-' {
                return false;
            }
        } else if !b.is_ascii_hexdigit() {
            return false;
        }
    }
    true
}

/// Parses `^\d+\.\d+(\.\d+)?$` and returns `(major, minor)`. The optional
/// patch component is accepted but discarded — UECM only routes on major/minor.
fn parse_version_form(value: &str) -> Option<(i64, i64)> {
    let mut parts = value.split('.');
    let major_str = parts.next()?;
    let minor_str = parts.next()?;
    let patch_str = parts.next();
    if parts.next().is_some() {
        return None;
    }
    let major: i64 = major_str.parse().ok()?;
    let minor: i64 = minor_str.parse().ok()?;
    if let Some(patch) = patch_str {
        let _: i64 = patch.parse().ok()?;
    }
    if major < 0 || minor < 0 {
        return None;
    }
    Some((major, minor))
}

pub fn match_by_filename(items: Vec<DiscoveredUproject>) -> MatchOutcome {
    let mut groups: BTreeMap<String, Vec<DiscoveredUproject>> = BTreeMap::new();
    for item in items {
        let key = stem_lower(&item.uproject_filename);
        groups.entry(key).or_default().push(item);
    }

    let matched = groups
        .into_iter()
        .map(|(stem, locations)| MatchedProject {
            canonical_filename: locations[0].uproject_filename.clone(),
            stem_lower: stem,
            locations,
            match_kind: MatchKind::Auto,
        })
        .collect();

    MatchOutcome {
        matched,
        ambiguous: Vec::new(),
    }
}

pub fn manual_alias(
    stem_lower: String,
    canonical_filename: String,
    locations: Vec<DiscoveredUproject>,
) -> MatchedProject {
    MatchedProject {
        stem_lower,
        canonical_filename,
        locations,
        match_kind: MatchKind::ManualAlias,
    }
}

pub fn manual_path(
    stem_lower: String,
    canonical_filename: String,
    locations: Vec<DiscoveredUproject>,
) -> MatchedProject {
    MatchedProject {
        stem_lower,
        canonical_filename,
        locations,
        match_kind: MatchKind::ManualPath,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn discovered(machine_id: i64, abs_path: &str, filename: &str) -> DiscoveredUproject {
        DiscoveredUproject {
            machine_id,
            abs_path: abs_path.into(),
            uproject_path: format!("{}\\{}", abs_path, filename),
            uproject_filename: filename.into(),
        }
    }

    #[test]
    fn stem_lower_strips_extension_and_lowercases() {
        assert_eq!(stem_lower("Plurality.uproject"), "plurality");
        assert_eq!(stem_lower("MyProj.UPROJECT"), "myproj");
        assert_eq!(stem_lower("Already_lower.uproject"), "already_lower");
    }

    #[test]
    fn matches_two_machines_with_same_filename() {
        let out = match_by_filename(vec![
            discovered(1, "D:\\Work\\Plurality", "Plurality.uproject"),
            discovered(2, "E:\\Projects\\Plurality", "Plurality.uproject"),
        ]);
        assert_eq!(out.matched.len(), 1);
        assert_eq!(out.matched[0].locations.len(), 2);
        assert_eq!(out.matched[0].stem_lower, "plurality");
        assert_eq!(out.matched[0].match_kind, MatchKind::Auto);
    }

    #[test]
    fn separates_distinct_filenames() {
        let out = match_by_filename(vec![
            discovered(1, "D:\\X", "X.uproject"),
            discovered(2, "D:\\Y", "Y.uproject"),
        ]);
        assert_eq!(out.matched.len(), 2);
    }

    #[test]
    fn case_insensitive_grouping() {
        let out = match_by_filename(vec![
            discovered(1, "D:\\X", "MyProj.uproject"),
            discovered(2, "E:\\Y", "myproj.uproject"),
        ]);
        assert_eq!(out.matched.len(), 1);
        assert_eq!(out.matched[0].locations.len(), 2);
    }

    #[test]
    fn empty_input_yields_empty_outcome() {
        let out = match_by_filename(vec![]);
        assert!(out.matched.is_empty());
        assert!(out.ambiguous.is_empty());
    }

    #[test]
    fn manual_helpers_stamp_match_kind() {
        let loc = discovered(1, "D:\\X", "X.uproject");
        assert_eq!(
            manual_alias("x".into(), "X.uproject".into(), vec![loc.clone()]).match_kind,
            MatchKind::ManualAlias
        );
        assert_eq!(
            manual_path("x".into(), "X.uproject".into(), vec![loc]).match_kind,
            MatchKind::ManualPath
        );
    }

    #[test]
    fn parse_engine_association_none_is_empty() {
        let parsed = parse_engine_association(None);
        assert_eq!(parsed.kind, "empty");
        assert!(parsed.raw.is_none());
        assert!(parsed.ue_version_major.is_none());
        assert!(parsed.ue_version_minor.is_none());
    }

    #[test]
    fn parse_engine_association_empty_string_is_empty() {
        let parsed = parse_engine_association(Some(""));
        assert_eq!(parsed.kind, "empty");
        assert_eq!(parsed.raw.as_deref(), Some(""));
        assert!(parsed.ue_version_major.is_none());
        assert!(parsed.ue_version_minor.is_none());
    }

    #[test]
    fn parse_engine_association_whitespace_is_empty() {
        let parsed = parse_engine_association(Some("   "));
        assert_eq!(parsed.kind, "empty");
        // raw preserves the original whitespace for audit.
        assert_eq!(parsed.raw.as_deref(), Some("   "));
    }

    #[test]
    fn parse_engine_association_two_part_version() {
        let parsed = parse_engine_association(Some("5.7"));
        assert_eq!(parsed.kind, "version");
        assert_eq!(parsed.ue_version_major, Some(5));
        assert_eq!(parsed.ue_version_minor, Some(7));
        assert_eq!(parsed.raw.as_deref(), Some("5.7"));
    }

    #[test]
    fn parse_engine_association_three_part_version_drops_patch() {
        let parsed = parse_engine_association(Some("5.7.2"));
        assert_eq!(parsed.kind, "version");
        assert_eq!(parsed.ue_version_major, Some(5));
        assert_eq!(parsed.ue_version_minor, Some(7));
        assert_eq!(parsed.raw.as_deref(), Some("5.7.2"));
    }

    #[test]
    fn parse_engine_association_curly_guid() {
        let parsed = parse_engine_association(Some("{12345678-1234-1234-1234-123456789abc}"));
        assert_eq!(parsed.kind, "guid");
        assert!(parsed.ue_version_major.is_none());
        assert!(parsed.ue_version_minor.is_none());
        assert_eq!(
            parsed.raw.as_deref(),
            Some("{12345678-1234-1234-1234-123456789abc}")
        );
    }

    #[test]
    fn parse_engine_association_bare_guid() {
        let parsed = parse_engine_association(Some("12345678-1234-1234-1234-123456789ABC"));
        assert_eq!(parsed.kind, "guid");
    }

    #[test]
    fn parse_engine_association_garbage_is_unknown() {
        let parsed = parse_engine_association(Some("garbage"));
        assert_eq!(parsed.kind, "unknown");
        assert_eq!(parsed.raw.as_deref(), Some("garbage"));
        assert!(parsed.ue_version_major.is_none());
    }

    #[test]
    fn parse_engine_association_partial_version_is_unknown() {
        // single-component version is not a real UE association string.
        let parsed = parse_engine_association(Some("5"));
        assert_eq!(parsed.kind, "unknown");
    }

    #[test]
    fn parse_engine_association_four_part_version_is_unknown() {
        let parsed = parse_engine_association(Some("5.7.0.1"));
        assert_eq!(parsed.kind, "unknown");
    }

    #[test]
    fn parse_engine_association_malformed_guid_is_unknown() {
        // missing one hex digit at the end.
        let parsed = parse_engine_association(Some("{12345678-1234-1234-1234-123456789ab}"));
        assert_eq!(parsed.kind, "unknown");
    }
}
