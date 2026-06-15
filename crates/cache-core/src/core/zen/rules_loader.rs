//! Loader + resolver for the Plan 7 zen INI rules YAML
//! (`docs/research/zen-ini-rules.yaml`).
//!
//! The YAML is a curated rulebook that says: for a given UE version, which
//! INI keys to write to enable ZenShared and which legacy DDC entries to
//! strip. This module parses that file and resolves the effective `RuleSet`
//! for a caller-supplied UE version, honoring:
//!   * `applies_to` — semver range gate; UE < 5.4 is rejected outright.
//!   * `verified_versions` — list of UE major.minor that have been validated
//!     on real hardware. Unlisted versions are subject to `unverified_policy`.
//!   * `unverified_policy` — `refuse` (default) errors out for unlisted
//!     versions; `warn` returns the default rules with a warning attached
//!     so the CLI / Tauri layer can surface it.
//!   * `overrides` — per-version partial overlays. Only the fields named in
//!     the override replace the default; everything else inherits.
//!
//! Tasks T3.2 / T3.3 consume `ResolvedRules` to drive the enable / disable
//! flows. This module deliberately does NOT touch INI files or shell out;
//! it is pure parsing + lookup so it can be exercised on macOS.
//!
//! ## Default-file discovery
//!
//! [`load_default`] searches in order:
//!   1. `$UECM_ZEN_RULES_PATH` env override — exact file path.
//!   2. `<exe-dir>/zen-ini-rules.yaml` — flat copy next to the binary
//!      (Tauri `resources` / CLI install layout).
//!   3. `<exe-dir>/docs/research/zen-ini-rules.yaml` — preserves the repo
//!      sub-path if the bundler keeps it.
//!   4. `<repo-root>/docs/research/zen-ini-rules.yaml` via `CARGO_MANIFEST_DIR`
//!      (the dev / cargo-test path).
//!   5. `<current_dir>/docs/research/zen-ini-rules.yaml` — last-ditch when
//!      a user runs the binary from a directory that contains the file.
//!   6. **Embedded copy** baked in at build time via `include_str!` — last
//!      resort that guarantees `load_default()` never fails on a clean
//!      install where the operator hasn't dropped a YAML next to the
//!      binary and hasn't set the env override.
//!
//! The embedded copy is the build-time snapshot of `zen-ini-rules.yaml`. If
//! ops want to tweak rules without a rebuild they can still drop a file at
//! one of the on-disk candidates (which win, in order). This guarantees a
//! packaged Tauri app or installed CLI always has *some* valid rule set,
//! while preserving the override path Plan §6.1 contemplates.
//!
//! ## Semver matcher
//!
//! Only the `>=X.Y` form is supported (the only form the current YAML uses).
//! A hand-rolled comparator avoids pulling in the `semver` crate for the
//! single use site. Any other shape (`<`, `^`, `~`, ranges, wildcards) is
//! rejected with a clear error so an operator that hand-edits the YAML to
//! something unsupported fails fast instead of silently matching everything.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::error::{UecmError, UecmResult};

/// Behaviour when the requested UE version is not in `verified_versions`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum UnverifiedPolicy {
    /// Error out — only verified versions are allowed.
    Refuse,
    /// Apply the default rules anyway and attach a warning.
    Warn,
}

/// The `enable_zen_shared` rule — writes a single `Shared=(...)` line into
/// `[StorageServers]` (the modern UE 5.4+ form). The shipped default
/// `ZenShared=(Type=Zen, ServerID=Shared)` backend node references it by
/// ServerID, so overriding the entry's Host activates the shared Zen DDC.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct EnableZenSharedRule {
    pub ini_file: String,
    pub section: String,
    pub key: String,
    /// May contain `{host}`, `{port}`, `{namespace}` placeholders. T3.2 fills.
    pub value_template: String,
    pub backup: bool,
}

/// The `disable_legacy_smb_shared` rule — removes a single key from a section
/// and optionally clears env vars.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct DisableRule {
    pub ini_file: String,
    pub section: String,
    pub key: String,
    pub action: String,
    pub backup: bool,
    #[serde(default)]
    pub env_cleanup: Vec<EnvCleanup>,
}

/// The `disable_legacy_pak` rule — removes one or more keys from the same
/// section in a single pass.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct DisablePakRule {
    pub ini_file: String,
    pub section: String,
    pub keys: Vec<String>,
    pub action: String,
    pub backup: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct EnvCleanup {
    pub var: String,
    pub scopes: Vec<String>,
}

/// Full, materialized rule set for one UE version.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct RuleSet {
    pub enable_zen_shared: EnableZenSharedRule,
    pub disable_legacy_smb_shared: DisableRule,
    pub disable_legacy_pak: DisablePakRule,
}

/// Partial overlay used by `overrides`. Each field is optional; missing fields
/// inherit from the default `RuleSet`. `deny_unknown_fields` catches typos —
/// a misspelled override key would otherwise be silently ignored and the
/// default rule would still apply.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct PartialRuleSet {
    pub enable_zen_shared: Option<PartialEnableZenSharedRule>,
    pub disable_legacy_smb_shared: Option<PartialDisableRule>,
    pub disable_legacy_pak: Option<PartialDisablePakRule>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct PartialEnableZenSharedRule {
    pub ini_file: Option<String>,
    pub section: Option<String>,
    pub key: Option<String>,
    pub value_template: Option<String>,
    pub backup: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct PartialDisableRule {
    pub ini_file: Option<String>,
    pub section: Option<String>,
    pub key: Option<String>,
    pub action: Option<String>,
    pub backup: Option<bool>,
    pub env_cleanup: Option<Vec<EnvCleanup>>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct PartialDisablePakRule {
    pub ini_file: Option<String>,
    pub section: Option<String>,
    pub keys: Option<Vec<String>>,
    pub action: Option<String>,
    pub backup: Option<bool>,
}

/// Top-level parsed view of `zen-ini-rules.yaml`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ZenRules {
    pub applies_to: String,
    pub default: RuleSet,
    pub verified_versions: Vec<String>,
    pub unverified_policy: UnverifiedPolicy,
    pub overrides: HashMap<String, PartialRuleSet>,
}

/// Output of [`resolve`] — the effective rule set plus any warnings the caller
/// should surface (e.g. "version not on the verified list").
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ResolvedRules {
    pub rules: RuleSet,
    pub warnings: Vec<String>,
    /// The major.minor key used to look up overrides (e.g. `"5.7"` even when
    /// the caller passed `"5.7.4"`).
    pub matched_version: String,
}

// --- Wire-format helpers --------------------------------------------------

/// Wire shape that mirrors the YAML 1:1. Internal — converted into [`ZenRules`]
/// after parsing so callers see a flat, pleasant API.
///
/// All wire structs use `deny_unknown_fields` so a typo (`enable_zen_share`
/// instead of `enable_zen_shared`, `verified_versons` instead of
/// `verified_versions`, …) is rejected at parse time. The only documented
/// "extra" field is `verified_by` — explicitly captured under a renamed
/// `_verified_by` so it doesn't trip the deny.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ZenRulesWire {
    zen_ini: ZenIniWire,
    #[serde(default)]
    verified_versions: Vec<String>,
    unverified_policy: UnverifiedPolicy,
    #[serde(default)]
    overrides: HashMap<String, PartialRuleSet>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ZenIniWire {
    applies_to: String,
    rules: RuleSetWire,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RuleSetWire {
    enable_zen_shared: EnableZenSharedWire,
    disable_legacy_smb_shared: DisableRuleWire,
    disable_legacy_pak: DisablePakRuleWire,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct EnableZenSharedWire {
    ini_file: String,
    section: String,
    key: String,
    value_template: String,
    backup: bool,
    #[serde(default, rename = "verified_by")]
    _verified_by: serde_yaml::Value,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DisableRuleWire {
    ini_file: String,
    section: String,
    key: String,
    action: String,
    backup: bool,
    #[serde(default)]
    env_cleanup: Vec<EnvCleanup>,
    #[serde(default, rename = "verified_by")]
    _verified_by: serde_yaml::Value,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DisablePakRuleWire {
    ini_file: String,
    section: String,
    keys: Vec<String>,
    action: String,
    backup: bool,
    #[serde(default, rename = "verified_by")]
    _verified_by: serde_yaml::Value,
}

impl From<ZenRulesWire> for ZenRules {
    fn from(w: ZenRulesWire) -> Self {
        ZenRules {
            applies_to: w.zen_ini.applies_to,
            default: RuleSet {
                enable_zen_shared: EnableZenSharedRule {
                    ini_file: w.zen_ini.rules.enable_zen_shared.ini_file,
                    section: w.zen_ini.rules.enable_zen_shared.section,
                    key: w.zen_ini.rules.enable_zen_shared.key,
                    value_template: w.zen_ini.rules.enable_zen_shared.value_template,
                    backup: w.zen_ini.rules.enable_zen_shared.backup,
                },
                disable_legacy_smb_shared: DisableRule {
                    ini_file: w.zen_ini.rules.disable_legacy_smb_shared.ini_file,
                    section: w.zen_ini.rules.disable_legacy_smb_shared.section,
                    key: w.zen_ini.rules.disable_legacy_smb_shared.key,
                    action: w.zen_ini.rules.disable_legacy_smb_shared.action,
                    backup: w.zen_ini.rules.disable_legacy_smb_shared.backup,
                    env_cleanup: w.zen_ini.rules.disable_legacy_smb_shared.env_cleanup,
                },
                disable_legacy_pak: DisablePakRule {
                    ini_file: w.zen_ini.rules.disable_legacy_pak.ini_file,
                    section: w.zen_ini.rules.disable_legacy_pak.section,
                    keys: w.zen_ini.rules.disable_legacy_pak.keys,
                    action: w.zen_ini.rules.disable_legacy_pak.action,
                    backup: w.zen_ini.rules.disable_legacy_pak.backup,
                },
            },
            verified_versions: w.verified_versions,
            unverified_policy: w.unverified_policy,
            overrides: w.overrides,
        }
    }
}

// --- Public API -----------------------------------------------------------

/// Read and parse the rules YAML at `path`.
pub fn load_from_path(path: &Path) -> UecmResult<ZenRules> {
    let text = std::fs::read_to_string(path).map_err(|e| {
        UecmError::Configuration(format!(
            "failed to read zen rules file {}: {}",
            path.display(),
            e
        ))
    })?;
    parse_str(&text).map_err(|e| {
        // Surface the file path so an operator can find the offending YAML.
        UecmError::Configuration(format!(
            "failed to parse zen rules file {}: {}",
            path.display(),
            e
        ))
    })
}

/// Parse a YAML string into [`ZenRules`]. Useful for tests; production code
/// goes through [`load_from_path`] / [`load_default`].
pub fn parse_str(text: &str) -> UecmResult<ZenRules> {
    let wire: ZenRulesWire = serde_yaml::from_str(text)
        .map_err(|e| UecmError::Configuration(format!("zen rules yaml: {}", e)))?;
    let rules: ZenRules = wire.into();

    // Override keys must be exactly `major.minor`. The resolver looks them
    // up by the patch-stripped string, so an override keyed by `"5.7.4"`
    // would never be hit when the caller passes `"5.7.4"` — it would be
    // silently ignored. Reject at parse time so the operator finds out now.
    for key in rules.overrides.keys() {
        validate_override_key(key)?;
    }

    Ok(rules)
}

/// Override keys are `major.minor` only — anything else (`"5.7.4"`, `"5.7-pre"`,
/// `"5"`, `"foo"`) is rejected with a clear error so an operator doesn't
/// configure an override that silently never matches.
fn validate_override_key(key: &str) -> UecmResult<()> {
    // Reuse the same strictness as the version parser: reject patch, suffix,
    // empty parts. Then explicitly check the key has exactly two dot-parts.
    let parts: Vec<&str> = key.split('.').collect();
    if parts.len() != 2 {
        return Err(UecmError::Configuration(format!(
            "override key '{}' must be exactly 'major.minor' \
             (patch components or missing minor are not supported)",
            key
        )));
    }
    let _: u32 = parts[0].parse().map_err(|_| {
        UecmError::Configuration(format!(
            "override key '{}': major component '{}' is not a number",
            key, parts[0]
        ))
    })?;
    let _: u32 = parts[1].parse().map_err(|_| {
        UecmError::Configuration(format!(
            "override key '{}': minor component '{}' is not a number",
            key, parts[1]
        ))
    })?;
    Ok(())
}

/// Build-time snapshot of the rules YAML. Acts as the final fallback in
/// `load_default()` so a packaged binary always has a valid rule set even
/// when the operator hasn't dropped a YAML next to the exe / set the env
/// override. Path is relative to this source file's directory.
const EMBEDDED_RULES_YAML: &str =
    include_str!("../../../../docs/research/zen-ini-rules.yaml");

/// Load from the canonical project location:
///   `$UECM_ZEN_RULES_PATH` ▸ `<exe-dir>/zen-ini-rules.yaml`
///   ▸ `<exe-dir>/docs/research/zen-ini-rules.yaml`
///   ▸ `<manifest>/../docs/research/zen-ini-rules.yaml`
///   ▸ `<cwd>/docs/research/zen-ini-rules.yaml`
///   ▸ embedded build-time copy (last-resort).
///
/// If `UECM_ZEN_RULES_PATH` is set but the path is missing / unreadable, this
/// returns a `Configuration` error rather than silently falling back to the
/// embedded copy — otherwise a typo in the override would have the operator
/// thinking custom rules are in effect when in fact the build-time snapshot
/// is.
pub fn load_default() -> UecmResult<ZenRules> {
    if let Ok(over) = std::env::var("UECM_ZEN_RULES_PATH") {
        let p = PathBuf::from(&over);
        if !p.is_file() {
            return Err(UecmError::Configuration(format!(
                "UECM_ZEN_RULES_PATH points at '{}' but that file does not exist; \
                 fix the override or unset it to use defaults",
                p.display()
            )));
        }
        return load_from_path(&p);
    }
    let path = default_path();
    if path.is_file() {
        return load_from_path(&path);
    }
    // No on-disk candidate found and no explicit override — fall back to the
    // embedded snapshot so packaged binaries always have a rule set.
    parse_str(EMBEDDED_RULES_YAML).map_err(|e| match e {
        // Tag the message so an operator can tell the embedded copy was used.
        UecmError::Configuration(msg) => UecmError::Configuration(format!(
            "embedded zen rules (build-time snapshot): {}",
            msg
        )),
        other => other,
    })
}

/// Discovery for [`load_default`] — exposed for tests / diagnostics.
///
/// Returns the first existing candidate; if none exist, returns the
/// dev-manifest path so the subsequent `read_to_string` failure surfaces
/// a useful "this is where I looked" error message.
pub fn default_path() -> PathBuf {
    if let Ok(over) = std::env::var("UECM_ZEN_RULES_PATH") {
        return PathBuf::from(over);
    }
    // Packaged-app candidates: file lives next to the binary, either flat or
    // preserving the repo sub-path. Both are checked since the bundler's
    // exact layout is still in flux (Tauri `resources` rules don't include
    // the YAML yet — see tauri.conf.json).
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let flat = parent.join("zen-ini-rules.yaml");
            if flat.is_file() {
                return flat;
            }
            let nested = parent.join("docs/research/zen-ini-rules.yaml");
            if nested.is_file() {
                return nested;
            }
        }
    }
    // Dev / cargo-test path. `env!` is resolved at build time; CARGO_MANIFEST_DIR
    // always points at `src-tauri/`, so `parent()` is the worktree root.
    let manifest_candidate = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("docs/research/zen-ini-rules.yaml");
    if manifest_candidate.is_file() {
        return manifest_candidate;
    }
    // Production fallback. `cwd` is whatever the operator launched from —
    // useful for ad-hoc testing but not depended on in normal usage.
    let cwd_candidate = std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("docs/research/zen-ini-rules.yaml");
    if cwd_candidate.is_file() {
        return cwd_candidate;
    }
    // Nothing found — return the dev path so the error names the build-time
    // location an engineer will recognize.
    manifest_candidate
}

/// Best-effort variant of [`resolve`] for read-only diagnostic callers.
///
/// Diagnostic surfaces (e.g. `core::ini_scanner` → R012-R015) describe what
/// they observe; they do not write changes. Applying `unverified_policy:
/// refuse` to those callers means an unverified UE major.minor would silently
/// drop ALL zen-rule findings — masking missing or malformed `ZenShared`
/// entries on every 5.4 / 5.5 / 5.6 / 5.8+ project. This wrapper downgrades
/// `refuse` → `warn` for the scope of the call so diagnostics still run,
/// while [`resolve`] (used by destructive paths like `zen enable`) keeps
/// the strict refuse semantics. Codex round-14 P2.
pub fn resolve_for_diagnostics(rules: &ZenRules, ue_version: &str) -> UecmResult<ResolvedRules> {
    let mut relaxed = rules.clone();
    relaxed.unverified_policy = UnverifiedPolicy::Warn;
    resolve(&relaxed, ue_version)
}

/// Compute the effective rules for `ue_version` (e.g. `"5.7"` or `"5.7.4"`).
///
/// The patch component is discarded — overrides and verified-version lookups
/// are keyed by `major.minor` only.
pub fn resolve(rules: &ZenRules, ue_version: &str) -> UecmResult<ResolvedRules> {
    let (major, minor) = parse_version(ue_version).map_err(|msg| {
        UecmError::InvalidInput(format!("invalid UE version '{}': {}", ue_version, msg))
    })?;
    let major_minor = format!("{}.{}", major, minor);

    // 1. applies_to gate.
    let (req_major, req_minor) = parse_applies_to(&rules.applies_to)?;
    if (major, minor) < (req_major, req_minor) {
        return Err(UecmError::InvalidInput(format!(
            "UE {} is below the supported floor (applies_to: {})",
            ue_version, rules.applies_to
        )));
    }

    // 2. verified_versions check (major.minor comparison only).
    let is_verified = rules
        .verified_versions
        .iter()
        .filter_map(|v| parse_version(v).ok())
        .any(|(vm, vn)| vm == major && vn == minor);

    let mut warnings = Vec::new();
    if !is_verified {
        match rules.unverified_policy {
            UnverifiedPolicy::Refuse => {
                return Err(UecmError::InvalidInput(format!(
                    "UE {} not in verified_versions {:?}; \
                     unverified_policy=refuse (set policy=warn after fact-finding)",
                    major_minor, rules.verified_versions
                )));
            }
            UnverifiedPolicy::Warn => {
                warnings.push(format!(
                    "UE {} not in verified_versions {:?}; applying default rules under unverified_policy=warn",
                    major_minor, rules.verified_versions
                ));
            }
        }
    }

    // 3. Start from defaults, overlay any override for this exact major.minor.
    let mut effective = rules.default.clone();
    if let Some(overlay) = rules.overrides.get(&major_minor) {
        apply_overlay(&mut effective, overlay);
    }

    Ok(ResolvedRules {
        rules: effective,
        warnings,
        matched_version: major_minor,
    })
}

// --- Internals ------------------------------------------------------------

/// Parse `"5.7"` or `"5.7.4"` (or `"5.7.4-foo"`) → `(major, minor)`. Patch /
/// pre-release suffix is permitted but must itself be well-formed:
///   * major and minor must be non-negative integers,
///   * if a third dot-separated component exists, it must parse as a
///     non-negative integer (with an optional `-pre` / `+meta` suffix).
///
/// Anything else (`"5.7.foo"`, `"5.7.4.1"`, `"5.x"`, `"5"`, `""`) is rejected.
fn parse_version(v: &str) -> Result<(u32, u32), String> {
    let trimmed = v.trim();
    if trimmed.is_empty() {
        return Err("empty version string".into());
    }
    let mut parts = trimmed.split('.');
    let major = parts
        .next()
        .ok_or_else(|| "missing major component".to_string())?;
    let minor = parts
        .next()
        .ok_or_else(|| "missing minor component (expected major.minor)".to_string())?;
    let patch_opt = parts.next();
    if parts.next().is_some() {
        return Err(format!(
            "too many components — expected major.minor[.patch], got '{}'",
            trimmed
        ));
    }
    let major_n: u32 = major
        .parse()
        .map_err(|_| format!("major component '{}' is not a number", major))?;
    let minor_n: u32 = minor
        .parse()
        .map_err(|_| format!("minor component '{}' is not a number", minor))?;
    if let Some(patch_raw) = patch_opt {
        // Strip semver-style `-pre` / `+meta` suffixes before checking digits.
        let patch_clean = patch_raw
            .split(['-', '+'])
            .next()
            .unwrap_or(patch_raw);
        if patch_clean.is_empty() {
            return Err(format!("patch component is empty in '{}'", trimmed));
        }
        let _: u32 = patch_clean.parse().map_err(|_| {
            format!("patch component '{}' is not a number", patch_raw)
        })?;
    }
    Ok((major_n, minor_n))
}

/// Parse `">=5.4"` → `(5, 4)`. Only `>=X.Y` is supported (the only form the
/// current YAML uses); any other operator, or a patch component (`>=5.4.2`),
/// returns an error so the floor doesn't silently widen.
fn parse_applies_to(spec: &str) -> UecmResult<(u32, u32)> {
    let trimmed = spec.trim();
    let rest = trimmed.strip_prefix(">=").ok_or_else(|| {
        UecmError::Configuration(format!(
            "applies_to '{}' is unsupported; only '>=X.Y' is implemented",
            spec
        ))
    })?;
    let rest_trim = rest.trim();
    // Reject patch / pre-release / build-metadata components — this matcher
    // only enforces major.minor floors. If we silently dropped a patch
    // component, a tightened floor like ">=5.4.2" would still accept 5.4.0.
    if rest_trim.contains('.') {
        let dot_count = rest_trim.chars().filter(|c| *c == '.').count();
        if dot_count > 1 {
            return Err(UecmError::Configuration(format!(
                "applies_to '{}' must be exactly '>=major.minor' \
                 (patch / pre-release components are not supported)",
                spec
            )));
        }
    }
    if rest_trim.contains(['-', '+']) {
        return Err(UecmError::Configuration(format!(
            "applies_to '{}' must be exactly '>=major.minor' \
             (pre-release / build-metadata suffixes are not supported)",
            spec
        )));
    }
    parse_version(rest_trim).map_err(|msg| {
        UecmError::Configuration(format!("applies_to '{}': {}", spec, msg))
    })
}

fn apply_overlay(base: &mut RuleSet, overlay: &PartialRuleSet) {
    if let Some(o) = &overlay.enable_zen_shared {
        if let Some(v) = &o.ini_file {
            base.enable_zen_shared.ini_file = v.clone();
        }
        if let Some(v) = &o.section {
            base.enable_zen_shared.section = v.clone();
        }
        if let Some(v) = &o.key {
            base.enable_zen_shared.key = v.clone();
        }
        if let Some(v) = &o.value_template {
            base.enable_zen_shared.value_template = v.clone();
        }
        if let Some(v) = o.backup {
            base.enable_zen_shared.backup = v;
        }
    }
    if let Some(o) = &overlay.disable_legacy_smb_shared {
        if let Some(v) = &o.ini_file {
            base.disable_legacy_smb_shared.ini_file = v.clone();
        }
        if let Some(v) = &o.section {
            base.disable_legacy_smb_shared.section = v.clone();
        }
        if let Some(v) = &o.key {
            base.disable_legacy_smb_shared.key = v.clone();
        }
        if let Some(v) = &o.action {
            base.disable_legacy_smb_shared.action = v.clone();
        }
        if let Some(v) = o.backup {
            base.disable_legacy_smb_shared.backup = v;
        }
        if let Some(v) = &o.env_cleanup {
            base.disable_legacy_smb_shared.env_cleanup = v.clone();
        }
    }
    if let Some(o) = &overlay.disable_legacy_pak {
        if let Some(v) = &o.ini_file {
            base.disable_legacy_pak.ini_file = v.clone();
        }
        if let Some(v) = &o.section {
            base.disable_legacy_pak.section = v.clone();
        }
        if let Some(v) = &o.keys {
            base.disable_legacy_pak.keys = v.clone();
        }
        if let Some(v) = &o.action {
            base.disable_legacy_pak.action = v.clone();
        }
        if let Some(v) = o.backup {
            base.disable_legacy_pak.backup = v;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ENV_TEST_LOCK;

    /// Panic-safe `UECM_ZEN_RULES_PATH` override: restores the prior value
    /// (or removes the var) on drop, even if the test panics.
    struct EnvVarGuard {
        key: &'static str,
        prev: Option<String>,
    }
    impl EnvVarGuard {
        fn set(key: &'static str, val: &Path) -> Self {
            let prev = std::env::var(key).ok();
            std::env::set_var(key, val);
            Self { key, prev }
        }
        fn unset(key: &'static str) -> Self {
            let prev = std::env::var(key).ok();
            std::env::remove_var(key);
            Self { key, prev }
        }
    }
    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            match self.prev.take() {
                Some(v) => std::env::set_var(self.key, v),
                None => std::env::remove_var(self.key),
            }
        }
    }

    /// Minimal but complete YAML covering all three rule kinds. Used as a
    /// dropped-in fixture to avoid coupling unit tests to evolving
    /// `verified_by` documentation on the real file.
    const SAMPLE_YAML: &str = r#"
zen_ini:
  applies_to: ">=5.4"
  rules:
    enable_zen_shared:
      ini_file: DefaultEngine.ini
      section: StorageServers
      key: Shared
      value_template: '(Host="http://{host}:{port}", Namespace="{namespace}", EnvHostOverride=UE-ZenSharedDataCacheHost, CommandLineHostOverride=ZenSharedDataCacheHost, DeactivateAt=60)'
      backup: true
    disable_legacy_smb_shared:
      ini_file: DefaultEngine.ini
      section: InstalledDerivedDataBackendGraph
      key: Shared
      action: remove
      backup: true
      env_cleanup:
        - var: UE-SharedDataCachePath
          scopes: [machine, user]
    disable_legacy_pak:
      ini_file: DefaultEngine.ini
      section: InstalledDerivedDataBackendGraph
      keys: [Pak, CompressedPak]
      action: remove
      backup: true

verified_versions:
  - "5.7"

unverified_policy: refuse

overrides: {}
"#;

    fn sample() -> ZenRules {
        parse_str(SAMPLE_YAML).expect("sample yaml must parse")
    }

    #[test]
    fn parses_real_yaml_from_repo() {
        // Both this test and `load_default_respects_env_override` consult
        // `UECM_ZEN_RULES_PATH` via `default_path()`. Serialize them and
        // make sure the env var is clear so we get the repo file, not a
        // tempdir fixture from a racing test.
        let _lock = ENV_TEST_LOCK.lock().unwrap();
        let _guard = EnvVarGuard::unset("UECM_ZEN_RULES_PATH");
        let path = default_path();
        let rules = load_from_path(&path).expect("real yaml parses");
        assert_eq!(rules.applies_to, ">=5.4");
        assert_eq!(rules.default.enable_zen_shared.section, "StorageServers");
        assert_eq!(rules.default.enable_zen_shared.key, "Shared");
        assert!(rules
            .default
            .enable_zen_shared
            .value_template
            .contains("{host}"));
        // The port must be embedded in the Host URI (no separate Port= field).
        assert!(rules
            .default
            .enable_zen_shared
            .value_template
            .contains("http://{host}:{port}"));
        assert_eq!(rules.default.disable_legacy_pak.keys, vec!["Pak", "CompressedPak"]);
        assert_eq!(rules.unverified_policy, UnverifiedPolicy::Refuse);
        assert!(rules.verified_versions.contains(&"5.7".to_string()));
    }

    #[test]
    fn serialize_round_trip_preserves_data() {
        let parsed = sample();
        // Serialize the parsed RuleSet (not the wire form) and re-parse via
        // serde_yaml directly — this confirms the public types are
        // serde-symmetric and the round trip is lossless.
        let yaml = serde_yaml::to_string(&parsed).expect("serialize");
        let again: ZenRules = serde_yaml::from_str::<ZenRulesPublicWire>(&yaml)
            .expect("re-parse")
            .into();
        assert_eq!(parsed, again);
    }

    /// The public `ZenRules` Serializes to a flat shape; this is the same flat
    /// shape parsed back. (We don't claim the YAML is wire-identical to the
    /// rules file — that would require keeping `verified_by` etc.)
    #[derive(Debug, Deserialize)]
    struct ZenRulesPublicWire {
        applies_to: String,
        default: RuleSet,
        verified_versions: Vec<String>,
        unverified_policy: UnverifiedPolicy,
        #[serde(default)]
        overrides: HashMap<String, PartialRuleSet>,
    }
    impl From<ZenRulesPublicWire> for ZenRules {
        fn from(w: ZenRulesPublicWire) -> Self {
            ZenRules {
                applies_to: w.applies_to,
                default: w.default,
                verified_versions: w.verified_versions,
                unverified_policy: w.unverified_policy,
                overrides: w.overrides,
            }
        }
    }

    #[test]
    fn resolve_verified_version_returns_default_no_warnings() {
        let rules = sample();
        let r = resolve(&rules, "5.7").expect("5.7 resolves");
        assert!(r.warnings.is_empty());
        assert_eq!(r.matched_version, "5.7");
        assert_eq!(r.rules, rules.default);
    }

    #[test]
    fn resolve_is_patch_tolerant() {
        let rules = sample();
        let r = resolve(&rules, "5.7.4").expect("5.7.4 resolves");
        assert!(r.warnings.is_empty());
        assert_eq!(r.matched_version, "5.7");
    }

    #[test]
    fn resolve_unverified_with_refuse_policy_errors() {
        let rules = sample();
        let err = resolve(&rules, "5.8").unwrap_err();
        match err {
            UecmError::InvalidInput(msg) => {
                assert!(msg.contains("5.8"));
                assert!(msg.contains("verified_versions"));
            }
            other => panic!("expected InvalidInput, got {:?}", other),
        }
    }

    #[test]
    fn resolve_unverified_with_warn_policy_returns_warning() {
        let mut rules = sample();
        rules.unverified_policy = UnverifiedPolicy::Warn;
        let r = resolve(&rules, "5.8").expect("warn policy yields ok");
        assert_eq!(r.warnings.len(), 1);
        assert!(r.warnings[0].contains("5.8"));
        assert_eq!(r.rules, rules.default);
    }

    // Codex round-14 P2: read-only diagnostic callers must NOT be blocked
    // by `unverified_policy: refuse`. The strict `resolve` refuses the
    // unverified version but `resolve_for_diagnostics` downgrades to warn.
    #[test]
    fn resolve_for_diagnostics_bypasses_refuse_policy() {
        let rules = sample();
        // Sanity: strict `resolve` refuses the unverified 5.8.
        assert!(resolve(&rules, "5.8").is_err());
        // Diagnostic variant returns Ok with a warning so scanners still run.
        let r = resolve_for_diagnostics(&rules, "5.8")
            .expect("diagnostics path must not be blocked by refuse policy");
        assert!(
            r.warnings.iter().any(|w| w.contains("5.8")),
            "warning should name the unverified version: {:?}",
            r.warnings
        );
        assert_eq!(r.matched_version, "5.8");
        assert_eq!(r.rules, rules.default);
    }

    #[test]
    fn resolve_for_diagnostics_still_enforces_applies_to_floor() {
        // The applies_to floor is structural — even diagnostics can't pull
        // rules for a UE version that predates the rule set's coverage.
        let rules = sample();
        assert!(resolve_for_diagnostics(&rules, "4.27").is_err());
    }

    #[test]
    fn resolve_rejects_below_applies_to() {
        let rules = sample();
        for low in ["5.3", "5.0", "4.27"] {
            let err = resolve(&rules, low).unwrap_err();
            assert!(
                matches!(err, UecmError::InvalidInput(_)),
                "{} should be refused under applies_to",
                low
            );
        }
    }

    #[test]
    fn resolve_accepts_at_or_above_applies_to() {
        // Construct a Warn-policy rules so the verified gate doesn't intercept.
        let mut rules = sample();
        rules.unverified_policy = UnverifiedPolicy::Warn;
        for ok in ["5.4", "5.7", "5.20", "6.0"] {
            let r = resolve(&rules, ok).unwrap_or_else(|e| {
                panic!("{} should be accepted, got {:?}", ok, e);
            });
            assert_eq!(r.matched_version.split('.').next().unwrap().parse::<u32>().unwrap() >= 5, true);
        }
    }

    #[test]
    fn override_merges_per_field() {
        // Add an override that *only* changes the section of enable_zen_shared.
        let mut rules = sample();
        rules.unverified_policy = UnverifiedPolicy::Warn; // so 5.9 isn't refused
        let mut overlay = PartialRuleSet::default();
        overlay.enable_zen_shared = Some(PartialEnableZenSharedRule {
            section: Some("SomeNewName".to_string()),
            ..Default::default()
        });
        rules.overrides.insert("5.9".to_string(), overlay);

        let r = resolve(&rules, "5.9").expect("5.9 resolves under warn");
        assert_eq!(r.rules.enable_zen_shared.section, "SomeNewName");
        // Other enable_zen_shared fields inherit.
        assert_eq!(r.rules.enable_zen_shared.key, rules.default.enable_zen_shared.key);
        assert_eq!(
            r.rules.enable_zen_shared.value_template,
            rules.default.enable_zen_shared.value_template
        );
        // Other rules untouched.
        assert_eq!(r.rules.disable_legacy_smb_shared, rules.default.disable_legacy_smb_shared);
        assert_eq!(r.rules.disable_legacy_pak, rules.default.disable_legacy_pak);
    }

    #[test]
    fn override_for_unrelated_version_does_not_apply() {
        let mut rules = sample();
        let mut overlay = PartialRuleSet::default();
        overlay.enable_zen_shared = Some(PartialEnableZenSharedRule {
            section: Some("SomeNewName".to_string()),
            ..Default::default()
        });
        rules.overrides.insert("5.9".to_string(), overlay);

        let r = resolve(&rules, "5.7").expect("5.7 ok");
        // Default section, NOT overridden.
        assert_eq!(r.rules.enable_zen_shared.section, "StorageServers");
    }

    #[test]
    fn empty_yaml_errors_clearly() {
        let err = parse_str("").unwrap_err();
        assert!(matches!(err, UecmError::Configuration(_)));
    }

    #[test]
    fn missing_required_field_names_it() {
        // Strip `value_template` from enable_zen_shared.
        let bad = r#"
zen_ini:
  applies_to: ">=5.4"
  rules:
    enable_zen_shared:
      ini_file: DefaultEngine.ini
      section: InstalledDerivedDataBackendGraph
      key: ZenShared
      backup: true
    disable_legacy_smb_shared:
      ini_file: DefaultEngine.ini
      section: X
      key: Shared
      action: remove
      backup: true
    disable_legacy_pak:
      ini_file: DefaultEngine.ini
      section: X
      keys: [Pak]
      action: remove
      backup: true
verified_versions: ["5.7"]
unverified_policy: refuse
overrides: {}
"#;
        let err = parse_str(bad).unwrap_err();
        let msg = format!("{}", err);
        assert!(msg.contains("value_template"), "msg should name the missing field: {}", msg);
    }

    #[test]
    fn applies_to_rejects_patch_or_prerelease() {
        // `>=5.4.2` should fail closed rather than be silently treated as `>=5.4`.
        for bad in [">=5.4.2", ">=5.4-pre", ">=5.4+build"] {
            let yaml = format!(
                r#"
zen_ini:
  applies_to: "{}"
  rules:
    enable_zen_shared:
      ini_file: x
      section: x
      key: x
      value_template: x
      backup: true
    disable_legacy_smb_shared:
      ini_file: x
      section: x
      key: x
      action: remove
      backup: true
    disable_legacy_pak:
      ini_file: x
      section: x
      keys: [x]
      action: remove
      backup: true
verified_versions: ["5.7"]
unverified_policy: refuse
overrides: {{}}
"#,
                bad
            );
            let rules = parse_str(&yaml).expect("yaml parses");
            let err = resolve(&rules, "5.7").unwrap_err();
            match err {
                UecmError::Configuration(msg) => {
                    assert!(
                        msg.contains(bad),
                        "expected error to name '{}', got: {}",
                        bad,
                        msg
                    );
                }
                other => panic!("expected Configuration error for {}, got {:?}", bad, other),
            }
        }
    }

    #[test]
    fn applies_to_rejects_unsupported_operators() {
        let bad = r#"
zen_ini:
  applies_to: "^5.4"
  rules:
    enable_zen_shared:
      ini_file: x
      section: x
      key: x
      value_template: x
      backup: true
    disable_legacy_smb_shared:
      ini_file: x
      section: x
      key: x
      action: remove
      backup: true
    disable_legacy_pak:
      ini_file: x
      section: x
      keys: [x]
      action: remove
      backup: true
verified_versions: ["5.7"]
unverified_policy: refuse
overrides: {}
"#;
        let rules = parse_str(bad).expect("yaml itself is valid");
        // applies_to is validated at resolve() time.
        let err = resolve(&rules, "5.7").unwrap_err();
        match err {
            UecmError::Configuration(msg) => assert!(msg.contains("^5.4")),
            other => panic!("expected Configuration error, got {:?}", other),
        }
    }

    #[test]
    fn invalid_version_string_errors() {
        let rules = sample();
        // Includes malformed patch / over-long versions that an earlier
        // splitn(3) parser silently truncated to "5.7" — Codex P2 finding.
        for bad in [
            "",
            "foo",
            "5",
            "5.x",
            "x.7",
            "5.7.foo",   // patch is not a number
            "5.7.4.1",   // too many components
            "5.7.",      // empty patch
            "5..7",      // empty minor
        ] {
            let err = resolve(&rules, bad).unwrap_err();
            assert!(
                matches!(err, UecmError::InvalidInput(_)),
                "{:?} should be rejected, got {:?}",
                bad,
                err
            );
        }
    }

    #[test]
    fn semver_style_patch_suffix_accepted() {
        // The parser keeps the existing tolerance for `-pre` / `+build` so
        // existing fixtures (and future UE pre-release naming) still resolve.
        let mut rules = sample();
        rules.unverified_policy = UnverifiedPolicy::Warn;
        let r = resolve(&rules, "5.7.4-pre").expect("pre-release patch ok");
        assert_eq!(r.matched_version, "5.7");
    }

    #[test]
    fn override_key_with_patch_component_is_rejected() {
        // `"5.7.4"` is a footgun — resolver looks up by major.minor only, so
        // the override would silently never apply. Catch it at parse time.
        let bad = r#"
zen_ini:
  applies_to: ">=5.4"
  rules:
    enable_zen_shared:
      ini_file: x
      section: x
      key: x
      value_template: x
      backup: true
    disable_legacy_smb_shared:
      ini_file: x
      section: x
      key: x
      action: remove
      backup: true
    disable_legacy_pak:
      ini_file: x
      section: x
      keys: [x]
      action: remove
      backup: true
verified_versions: ["5.7"]
unverified_policy: refuse
overrides:
  "5.7.4":
    enable_zen_shared:
      section: SomeNewName
"#;
        let err = parse_str(bad).unwrap_err();
        match err {
            UecmError::Configuration(msg) => {
                assert!(msg.contains("5.7.4"), "should name the bad key: {}", msg);
            }
            other => panic!("expected Configuration error, got {:?}", other),
        }
    }

    #[test]
    fn override_key_non_numeric_is_rejected() {
        let bad = r#"
zen_ini:
  applies_to: ">=5.4"
  rules:
    enable_zen_shared:
      ini_file: x
      section: x
      key: x
      value_template: x
      backup: true
    disable_legacy_smb_shared:
      ini_file: x
      section: x
      key: x
      action: remove
      backup: true
    disable_legacy_pak:
      ini_file: x
      section: x
      keys: [x]
      action: remove
      backup: true
verified_versions: ["5.7"]
unverified_policy: refuse
overrides:
  "five.seven":
    enable_zen_shared:
      section: SomeNewName
"#;
        let err = parse_str(bad).unwrap_err();
        assert!(matches!(err, UecmError::Configuration(_)));
    }

    #[test]
    fn unknown_top_level_field_is_rejected() {
        // A typo at the top level should fail loudly, not be silently dropped.
        let bad = r#"
zen_ini:
  applies_to: ">=5.4"
  rules:
    enable_zen_shared:
      ini_file: x
      section: x
      key: x
      value_template: x
      backup: true
    disable_legacy_smb_shared:
      ini_file: x
      section: x
      key: x
      action: remove
      backup: true
    disable_legacy_pak:
      ini_file: x
      section: x
      keys: [x]
      action: remove
      backup: true
verified_versions: ["5.7"]
unverified_policy: refuse
overrides: {}
verified_versons_typo: ["5.8"]
"#;
        let err = parse_str(bad).unwrap_err();
        let msg = format!("{}", err);
        assert!(
            msg.contains("verified_versons_typo") || msg.contains("unknown field"),
            "expected error to name the unknown field, got: {}",
            msg
        );
    }

    #[test]
    fn unknown_override_field_is_rejected() {
        // Typos inside an override entry must also be caught so a misspelled
        // override key (e.g. `enable_zen_share` instead of `enable_zen_shared`)
        // doesn't silently inherit defaults.
        let bad = r#"
zen_ini:
  applies_to: ">=5.4"
  rules:
    enable_zen_shared:
      ini_file: x
      section: x
      key: x
      value_template: x
      backup: true
    disable_legacy_smb_shared:
      ini_file: x
      section: x
      key: x
      action: remove
      backup: true
    disable_legacy_pak:
      ini_file: x
      section: x
      keys: [x]
      action: remove
      backup: true
verified_versions: ["5.7"]
unverified_policy: refuse
overrides:
  "5.9":
    enable_zen_share:   # <-- typo, missing 'd'
      section: SomeNewName
"#;
        let err = parse_str(bad).unwrap_err();
        let msg = format!("{}", err);
        assert!(
            msg.contains("enable_zen_share") || msg.contains("unknown field"),
            "expected typo to be caught, got: {}",
            msg
        );
    }

    #[test]
    fn load_default_errors_when_env_override_points_at_missing_file() {
        // A typo in the env override must fail loudly — not silently fall
        // back to the embedded snapshot. Otherwise operators think their
        // custom rule file is in effect when it isn't.
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("definitely-not-here.yaml");
        let _lock = ENV_TEST_LOCK.lock().unwrap();
        let _guard = EnvVarGuard::set("UECM_ZEN_RULES_PATH", &missing);
        let err = load_default().unwrap_err();
        match err {
            UecmError::Configuration(msg) => {
                assert!(msg.contains("UECM_ZEN_RULES_PATH"));
                assert!(msg.contains("definitely-not-here.yaml"));
            }
            other => panic!("expected Configuration error, got {:?}", other),
        }
    }

    #[test]
    fn embedded_fallback_parses() {
        // Embedded copy must be valid by itself — guarantees a clean install
        // (no env override, no on-disk file) still resolves a rule set. Tests
        // the embedded YAML directly so we don't depend on filesystem
        // discovery state.
        let rules = parse_str(EMBEDDED_RULES_YAML).expect("embedded yaml parses");
        assert_eq!(rules.applies_to, ">=5.4");
        assert!(rules.verified_versions.contains(&"5.7".to_string()));
    }

    #[test]
    fn load_default_respects_env_override() {
        // Point the loader at an explicit fixture file in tempdir.
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("custom.yaml");
        std::fs::write(&p, SAMPLE_YAML).unwrap();

        // Serialize with the other tests that read the same env var, and
        // restore on drop so a panic doesn't pollute later tests.
        let _lock = ENV_TEST_LOCK.lock().unwrap();
        let _guard = EnvVarGuard::set("UECM_ZEN_RULES_PATH", &p);
        let rules = load_default().expect("env-overridden load works");
        assert_eq!(rules.applies_to, ">=5.4");
        assert_eq!(rules.verified_versions, vec!["5.7".to_string()]);
    }
}
