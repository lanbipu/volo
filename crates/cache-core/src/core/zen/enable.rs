//! Project-level ZenShared enable / disable orchestration (Plan 7 T3.2 / T3.3 / T3.8).
//!
//! Given:
//! * a remote Windows host + credentials,
//! * a project's `DefaultEngine.ini` path on that host,
//! * a [`ResolvedRules`](crate::core::zen::rules_loader::ResolvedRules)
//!   (already version-gated by `rules_loader::resolve`),
//! * the cluster master endpoint info ([`ClusterMaster`]),
//!
//! this module drives the three rule actions:
//!   1. `enable_zen_shared`  → substitute `{host}` / `{port}` / `{namespace}`
//!      into the value template and `set_key_with_credential` the result.
//!   2. `disable_legacy_smb_shared` → `remove_key_with_credential` the key.
//!      Env-var cleanup (T3.4) is recorded as
//!      [`EnvCleanupRequest`] metadata in the outcome but is *not* executed
//!      here — a separate PS sidecar owns that side effect.
//!   3. `disable_legacy_pak` → `remove_key_with_credential` for each key.
//!
//! ## Idempotency (T3.8)
//!
//! Both [`enable_project`] and [`disable_project`] do a single
//! `read_section_with_credential` up-front and compute the diff against the
//! desired state. If nothing would change, they return an `EnableOutcome` /
//! `DisableOutcome` with `changed: false` and no write helpers are invoked.
//! Re-running the same command is therefore a no-op (modulo a single read).
//!
//! ## Disable semantics (T3.3 — "narrow disable")
//!
//! [`disable_project`] only removes the `ZenShared` key that `enable_project`
//! added. It does NOT auto-restore the legacy `Pak` / `CompressedPak` /
//! `Shared` entries that `enable_project` stripped. Auto-restore would
//! require persistent state tracking of pre-enable values across enable
//! cycles, which is operationally fragile — instead the per-key PS sidecar
//! already writes a `.bak.<timestamp>` next to the INI on every mutation,
//! and the operator can `git restore` / `cp DefaultEngine.ini.bak.*` if they
//! really want the prior config back. A warning is attached to the outcome
//! explaining this.

use crate::core::ini_editor::{read_section, remove_key, set_key, IniKey};
use crate::core::zen::rules_loader::ResolvedRules;
use crate::error::{VoloError, VoloResult};

/// Cluster master endpoint info used to materialize the ZenShared value.
#[derive(Debug, Clone)]
pub struct ClusterMaster {
    /// Hostname or IP — e.g. `"render-master.uecm.local"` or `"192.168.10.20"`.
    pub host: String,
    /// Master zen port — default UE 5.4+ value is `8558`.
    pub port: i64,
    /// DDC namespace — UE default `"ue.ddc"`.
    pub namespace: String,
}

/// One concrete INI mutation that was applied (or would have been applied if
/// we weren't in dry-run / idempotent-no-op mode).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyApplyRecord {
    pub section: String,
    pub key: String,
    /// `"set"` for `enable_zen_shared`; `"remove"` for the legacy clean-up rules.
    pub action: String,
    /// Pre-change value if the key existed; `None` if the key wasn't present.
    pub previous_value: Option<String>,
    /// New value for `set`; `None` for `remove`.
    pub new_value: Option<String>,
}

/// Env vars that the legacy SMB-shared rule wants cleaned up. Actual cleanup
/// is performed by the T3.4 PowerShell sidecar — this struct is metadata the
/// orchestrator hands back to the caller for the next stage.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnvCleanupRequest {
    pub var: String,
    /// `"machine"` and / or `"user"`.
    pub scopes: Vec<String>,
}

/// Outcome of [`enable_project`].
#[derive(Debug, Clone)]
pub struct EnableOutcome {
    /// `false` when the INI was already at the target state.
    pub changed: bool,
    /// Absolute path to the INI on the remote host (echoed for logging).
    pub ini_file: String,
    /// `.bak.<timestamp>` paths returned by each write helper invocation.
    pub backups: Vec<String>,
    /// Env-var cleanup requests captured from the rule set. The PS sidecar
    /// (T3.4) is responsible for actually clearing these.
    pub env_cleanup_planned: Vec<EnvCleanupRequest>,
    /// `set` records — one per key successfully written.
    pub keys_set: Vec<KeyApplyRecord>,
    /// `remove` records — one per legacy key successfully stripped.
    pub keys_removed: Vec<KeyApplyRecord>,
    /// Carried over from `ResolvedRules.warnings` plus anything we emit here.
    pub warnings: Vec<String>,
}

/// Outcome of [`disable_project`].
#[derive(Debug, Clone)]
pub struct DisableOutcome {
    pub changed: bool,
    pub ini_file: String,
    pub backups: Vec<String>,
    pub keys_removed: Vec<KeyApplyRecord>,
    pub warnings: Vec<String>,
}

/// Internal diff produced by [`compute_enable_diff`] — drives both the
/// idempotency check and the per-write loop in [`enable_project`].
#[derive(Debug, Clone, PartialEq, Eq)]
struct EnableDiff {
    /// `Some` if we need to write the ZenShared key; `None` if it's already
    /// at the desired value.
    set_zen_shared: Option<KeyApplyRecord>,
    /// One per legacy key that currently exists and needs to be removed.
    remove_legacy: Vec<KeyApplyRecord>,
}

impl EnableDiff {
    fn is_noop(&self) -> bool {
        self.set_zen_shared.is_none() && self.remove_legacy.is_empty()
    }
}

// --- Public API -----------------------------------------------------------

/// Apply ZenShared upstream config to a project's `DefaultEngine.ini`.
///
/// Reads the configured section once, computes the diff vs. the desired
/// state, and applies any mutations via the per-key PS sidecar (which also
/// handles backups). If the file is already in the desired state, returns
/// [`EnableOutcome::changed`] = `false` without invoking any write helper.
///
/// `host` and credentials are forwarded to the underlying
/// `*_with_credential` helpers — loopback targets (`127.0.0.1`, `localhost`,
/// matched via [`crate::core::loopback`]) short-circuit to in-process file
/// I/O, which is what the test suite relies on.
pub fn enable_project(
    host: &str,
    ini_path: &str,
    rules: &ResolvedRules,
    master: &ClusterMaster,
) -> VoloResult<EnableOutcome> {
    let enable_rule = &rules.rules.enable_zen_shared;
    let smb_rule = &rules.rules.disable_legacy_smb_shared;
    let pak_rule = &rules.rules.disable_legacy_pak;

    // Codex P2: read each rule's `section` independently. The YAML schema
    // (`rules_loader::PartialRuleSet`) lets `overrides."5.9"` move
    // `disable_legacy_smb_shared.section` or `disable_legacy_pak.section`
    // away from `enable_zen_shared.section`. If we read only the enable
    // section we'd plan zero removes for legacy keys that actually live
    // in another section, and the apply step would silently leave the
    // legacy DDC backends in place.
    let section = &enable_rule.section;
    let smb_section = smb_rule.section.as_str();
    let pak_section = pak_rule.section.as_str();

    // Substitute placeholders early so a malformed template fails before any
    // I/O.
    let desired_value = apply_value_template(&enable_rule.value_template, master)?;

    // 1. Read each distinct section. The enable rule now targets
    // `[StorageServers]` (key `Shared`) while the legacy-cleanup rules target
    // `[InstalledDerivedDataBackendGraph]`, so a typical install does two
    // distinct reads; the read cache below collapses duplicates and honors
    // per-section overrides without hitting the remote more than necessary.
    let mut section_cache: std::collections::HashMap<String, Vec<IniKey>> =
        std::collections::HashMap::new();
    for sec in [section.as_str(), smb_section, pak_section] {
        if section_cache.contains_key(sec) {
            continue;
        }
        let rows = read_section(host, ini_path, sec)?;
        section_cache.insert(sec.to_string(), rows);
    }
    let zen_section_keys = section_cache.get(section.as_str()).cloned().unwrap_or_default();
    let smb_section_keys = section_cache.get(smb_section).cloned().unwrap_or_default();
    let pak_section_keys = section_cache.get(pak_section).cloned().unwrap_or_default();

    let diff = compute_enable_diff(
        &zen_section_keys,
        section,
        &enable_rule.key,
        &desired_value,
        &smb_section_keys,
        &smb_rule.key,
        smb_section,
        &pak_section_keys,
        &pak_rule.keys,
        pak_section,
    );

    let env_cleanup_planned: Vec<EnvCleanupRequest> = smb_rule
        .env_cleanup
        .iter()
        .map(|e| EnvCleanupRequest {
            var: e.var.clone(),
            scopes: e.scopes.clone(),
        })
        .collect();

    // Always echo any resolver warnings into the outcome.
    let mut warnings = rules.warnings.clone();

    if diff.is_noop() {
        return Ok(EnableOutcome {
            changed: false,
            ini_file: ini_path.to_string(),
            backups: Vec::new(),
            env_cleanup_planned,
            keys_set: Vec::new(),
            keys_removed: Vec::new(),
            warnings,
        });
    }

    // 2. Apply mutations. We invoke set BEFORE removes so that — if the
    // remove step fails — the ZenShared upstream is already wired and the
    // engine can still resolve the cache (any leftover legacy key is
    // harmless because UE picks the named DDC backend).
    let mut backups = Vec::new();
    let mut keys_set = Vec::new();
    let mut keys_removed = Vec::new();

    if let Some(rec) = diff.set_zen_shared.clone() {
        let backup = set_key(
            host,
            ini_path,
            section,
            &enable_rule.key,
            &desired_value,
        )
        .map_err(|e| {
            VoloError::OperationFailed(format!(
                "enable_project: set {}={} in [{}] failed: {}",
                enable_rule.key, desired_value, section, e
            ))
        })?;
        backups.push(backup);
        keys_set.push(rec);
    }

    // SMB-shared rule lives in `smb_rule.section` (same as `section` in
    // practice, but we honor what the rule says).
    for rec in diff.remove_legacy.iter().cloned() {
        let backup = remove_key(
            host,
            ini_path,
            &rec.section,
            &rec.key,
        )
        .map_err(|e| {
            VoloError::OperationFailed(format!(
                "enable_project: remove {} from [{}] failed: {}",
                rec.key, rec.section, e
            ))
        })?;
        backups.push(backup);
        keys_removed.push(rec);
    }

    if !env_cleanup_planned.is_empty() {
        warnings.push(format!(
            "{} env var(s) flagged for cleanup ({}); run the zen env-cleanup PS sidecar (T3.4) to apply",
            env_cleanup_planned.len(),
            env_cleanup_planned
                .iter()
                .map(|c| c.var.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }

    Ok(EnableOutcome {
        changed: true,
        ini_file: ini_path.to_string(),
        backups,
        env_cleanup_planned,
        keys_set,
        keys_removed,
        warnings,
    })
}

/// Reverse half of [`enable_project`] — removes the ZenShared key only.
///
/// **Narrow disable**: legacy `Pak` / `CompressedPak` / `Shared` keys that
/// the enable flow may have stripped are NOT auto-restored. See module
/// docs for the rationale. A warning is attached to the outcome.
///
/// Idempotent: if the ZenShared key is already absent, returns
/// `changed: false` without invoking any write helper.
pub fn disable_project(
    host: &str,
    ini_path: &str,
    rules: &ResolvedRules,
) -> VoloResult<DisableOutcome> {
    let enable_rule = &rules.rules.enable_zen_shared;
    let section = &enable_rule.section;
    let key = &enable_rule.key;

    let mut warnings = rules.warnings.clone();
    warnings.push(
        "narrow disable: only the ZenShared upstream is removed; legacy Pak / CompressedPak / Shared entries are NOT auto-restored. \
         If you need the prior DDC config back, restore from the per-key .bak.<timestamp> sibling files or `git restore` the INI."
            .to_string(),
    );

    let current = read_section(host, ini_path, section)?;

    // Case-insensitive INI key match per codex P2 — UE / write-ini-key.ps1
    // both treat key names case-insensitively. Using `==` would let a
    // `zenshared` row escape the disable.
    let existing = current.iter().find(|k| k.name.eq_ignore_ascii_case(key));
    let Some(existing) = existing else {
        return Ok(DisableOutcome {
            changed: false,
            ini_file: ini_path.to_string(),
            backups: Vec::new(),
            keys_removed: Vec::new(),
            warnings,
        });
    };

    let record = KeyApplyRecord {
        section: section.clone(),
        key: key.clone(),
        action: "remove".to_string(),
        previous_value: Some(existing.value.clone()),
        new_value: None,
    };

    let backup = remove_key(host, ini_path, section, key)
        .map_err(|e| {
            VoloError::OperationFailed(format!(
                "disable_project: remove {} from [{}] failed: {}",
                key, section, e
            ))
        })?;

    let backups = vec![backup];
    let keys_removed = vec![record];

    Ok(DisableOutcome {
        changed: true,
        ini_file: ini_path.to_string(),
        backups,
        keys_removed,
        warnings,
    })
}

// --- Internals ------------------------------------------------------------

/// Codex round-14 P2: validate `host` / `namespace` against a conservative
/// grammar BEFORE substitution so a hostile or accidentally-malformed value
/// (containing `"`, `,`, `)`, `(`, `;`, `=`, `\n`, `\r`, control chars,
/// whitespace) can't break the resulting INI line. UE parses the ZenShared
/// value as a parenthesized struct of `Key=Value` pairs with quoted strings;
/// any of the above chars inside a substituted field would land outside the
/// intended quotes and either fail the parse or alter the meaning.
///
/// Host charset: DNS / IP literal characters (letters, digits, `.`, `-`,
/// `_`, `:` for IPv6, `[` `]` for bracketed IPv6).
/// Namespace charset: project-id-style (letters, digits, `.`, `-`, `_`).
fn validate_zen_field(name: &str, value: &str, allow_ip_literals: bool) -> VoloResult<()> {
    if value.is_empty() {
        return Err(VoloError::Configuration(format!(
            "ZenShared `{name}` must be non-empty"
        )));
    }
    for ch in value.chars() {
        let ok = ch.is_ascii_alphanumeric()
            || ch == '.'
            || ch == '-'
            || ch == '_'
            || (allow_ip_literals && (ch == ':' || ch == '[' || ch == ']'));
        if !ok {
            return Err(VoloError::Configuration(format!(
                "ZenShared `{name}` contains disallowed character {ch:?}; \
                 only {}letters / digits / '.' / '-' / '_'{} are accepted to \
                 keep the rendered INI line well-formed",
                if allow_ip_literals { "" } else { "" },
                if allow_ip_literals {
                    " (plus ':' '[' ']' for IPv6 literals)"
                } else {
                    ""
                }
            )));
        }
    }
    Ok(())
}

/// Substitute `{host}` / `{port}` / `{namespace}` in `template` using
/// `master`. Any other `{...}` placeholder is rejected so a future YAML
/// typo (`{name_space}`, `{server}`, …) fails loudly instead of leaving a
/// literal `{name_space}` in the INI value.
///
/// Substitution is case-sensitive — `{Host}` is treated as unknown.
fn apply_value_template(template: &str, master: &ClusterMaster) -> VoloResult<String> {
    validate_zen_field("host", &master.host, true)?;
    validate_zen_field("namespace", &master.namespace, false)?;

    // Scan for `{...}` segments; replace recognized names; bail on unknown.
    let mut out = String::with_capacity(template.len() + 32);
    let bytes = template.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'{' {
            // Find matching `}`.
            if let Some(rel_close) = template[i + 1..].find('}') {
                let close = i + 1 + rel_close;
                let name = &template[i + 1..close];
                match name {
                    "host" => out.push_str(&master.host),
                    "port" => out.push_str(&master.port.to_string()),
                    "namespace" => out.push_str(&master.namespace),
                    other => {
                        return Err(VoloError::Configuration(format!(
                            "value_template references unknown placeholder '{{{}}}'; \
                             supported placeholders are {{host}}, {{port}}, {{namespace}}",
                            other
                        )));
                    }
                }
                i = close + 1;
                continue;
            }
            // Unmatched `{` — pass through literally. Unlikely in practice
            // (the rule schema validates templates by convention) but no
            // reason to fail closed here.
            out.push('{');
            i += 1;
            continue;
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    Ok(out)
}

/// Pure diff computation — given the current `[section]` contents plus the
/// desired ZenShared value and the set of legacy keys to strip, produce the
/// list of mutations needed.
///
/// All inputs are by reference and no I/O happens here so this is the
/// natural unit-test seam (and the basis of the idempotency check).
#[allow(clippy::too_many_arguments)]
fn compute_enable_diff(
    zen_section_keys: &[IniKey],
    zen_section: &str,
    zen_key: &str,
    desired_zen_value: &str,
    smb_section_keys: &[IniKey],
    smb_key: &str,
    smb_section: &str,
    pak_section_keys: &[IniKey],
    pak_keys: &[String],
    pak_section: &str,
) -> EnableDiff {
    // INI key names match case-insensitively (codex P2): UE itself reads
    // `ZenShared` / `zenshared` / `ZENSHARED` as the same key, and our
    // sister modules `core::ini_diagnostics` and `write-ini-key.ps1` do
    // the same. Using `==` here would let a differently-cased existing
    // key bypass the diff.
    let existing_zen = zen_section_keys
        .iter()
        .find(|k| k.name.eq_ignore_ascii_case(zen_key));
    let set_zen_shared = match existing_zen {
        Some(k) if k.value == desired_zen_value => None,
        Some(k) => Some(KeyApplyRecord {
            section: zen_section.to_string(),
            key: zen_key.to_string(),
            action: "set".to_string(),
            previous_value: Some(k.value.clone()),
            new_value: Some(desired_zen_value.to_string()),
        }),
        None => Some(KeyApplyRecord {
            section: zen_section.to_string(),
            key: zen_key.to_string(),
            action: "set".to_string(),
            previous_value: None,
            new_value: Some(desired_zen_value.to_string()),
        }),
    };

    let mut remove_legacy = Vec::new();

    // SMB-shared single key — looked up in SMB rule's own section.
    // Case-insensitive match per the same reasoning as the zen lookup above.
    if let Some(k) = smb_section_keys
        .iter()
        .find(|k| k.name.eq_ignore_ascii_case(smb_key))
    {
        remove_legacy.push(KeyApplyRecord {
            section: smb_section.to_string(),
            key: smb_key.to_string(),
            action: "remove".to_string(),
            previous_value: Some(k.value.clone()),
            new_value: None,
        });
    }

    // Pak / CompressedPak / etc. — looked up in pak rule's own section.
    // Case-insensitive match per the same reasoning.
    for legacy_key in pak_keys {
        if let Some(k) = pak_section_keys
            .iter()
            .find(|k| k.name.eq_ignore_ascii_case(legacy_key))
        {
            remove_legacy.push(KeyApplyRecord {
                section: pak_section.to_string(),
                key: legacy_key.clone(),
                action: "remove".to_string(),
                previous_value: Some(k.value.clone()),
                new_value: None,
            });
        }
    }

    EnableDiff {
        set_zen_shared,
        remove_legacy,
    }
}

/// Apply ZenShared upstream config to a machine's global `UserEngine.ini`.
///
/// Identical to [`enable_project`] except:
/// 1. A missing `UserEngine.ini` is treated as an empty file rather than an
///    error — the file (and its parent directory) are created by `set_key_create`.
/// 2. The ZenShared key is written via [`crate::core::ini_editor::set_key_create`]
///    instead of [`crate::core::ini_editor::set_key`].
pub fn enable_global(
    host: &str,
    ini_path: &str,
    rules: &ResolvedRules,
    master: &ClusterMaster,
) -> VoloResult<EnableOutcome> {
    let enable_rule = &rules.rules.enable_zen_shared;
    let smb_rule = &rules.rules.disable_legacy_smb_shared;
    let pak_rule = &rules.rules.disable_legacy_pak;

    let section = &enable_rule.section;
    let smb_section = smb_rule.section.as_str();
    let pak_section = pak_rule.section.as_str();

    let desired_value = apply_value_template(&enable_rule.value_template, master)?;

    // For global enable, a missing file is not an error — treat it as empty.
    let mut section_cache: std::collections::HashMap<String, Vec<IniKey>> =
        std::collections::HashMap::new();
    for sec in [section.as_str(), smb_section, pak_section] {
        if section_cache.contains_key(sec) {
            continue;
        }
        let rows = read_section(host, ini_path, sec).unwrap_or_default();
        section_cache.insert(sec.to_string(), rows);
    }
    let zen_section_keys = section_cache.get(section.as_str()).cloned().unwrap_or_default();
    let smb_section_keys = section_cache.get(smb_section).cloned().unwrap_or_default();
    let pak_section_keys = section_cache.get(pak_section).cloned().unwrap_or_default();

    let diff = compute_enable_diff(
        &zen_section_keys,
        section,
        &enable_rule.key,
        &desired_value,
        &smb_section_keys,
        &smb_rule.key,
        smb_section,
        &pak_section_keys,
        &pak_rule.keys,
        pak_section,
    );

    let env_cleanup_planned: Vec<EnvCleanupRequest> = smb_rule
        .env_cleanup
        .iter()
        .map(|e| EnvCleanupRequest {
            var: e.var.clone(),
            scopes: e.scopes.clone(),
        })
        .collect();

    let mut warnings = rules.warnings.clone();

    if diff.is_noop() {
        return Ok(EnableOutcome {
            changed: false,
            ini_file: ini_path.to_string(),
            backups: Vec::new(),
            env_cleanup_planned,
            keys_set: Vec::new(),
            keys_removed: Vec::new(),
            warnings,
        });
    }

    let mut backups = Vec::new();
    let mut keys_set = Vec::new();
    let mut keys_removed = Vec::new();

    if let Some(rec) = diff.set_zen_shared.clone() {
        let backup = crate::core::ini_editor::set_key_create(
            host,
            ini_path,
            section,
            &enable_rule.key,
            &desired_value,
        )
        .map_err(|e| {
            VoloError::OperationFailed(format!(
                "enable_global: set {}={} in [{}] failed: {}",
                enable_rule.key, desired_value, section, e
            ))
        })?;
        backups.push(backup);
        keys_set.push(rec);
    }

    for rec in diff.remove_legacy.iter().cloned() {
        let backup = remove_key(host, ini_path, &rec.section, &rec.key)
            .map_err(|e| {
                VoloError::OperationFailed(format!(
                    "enable_global: remove {} from [{}] failed: {}",
                    rec.key, rec.section, e
                ))
            })?;
        backups.push(backup);
        keys_removed.push(rec);
    }

    if !env_cleanup_planned.is_empty() {
        warnings.push(format!(
            "{} env var(s) flagged for cleanup ({}); run the zen env-cleanup PS sidecar (T3.4) to apply",
            env_cleanup_planned.len(),
            env_cleanup_planned
                .iter()
                .map(|c| c.var.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }

    Ok(EnableOutcome {
        changed: true,
        ini_file: ini_path.to_string(),
        backups,
        env_cleanup_planned,
        keys_set,
        keys_removed,
        warnings,
    })
}

/// Reverse of [`enable_global`] — removes the ZenShared key from
/// `UserEngine.ini`. If the file does not exist, returns a no-op outcome
/// with a warning rather than an error.
pub fn disable_global(
    host: &str,
    ini_path: &str,
    rules: &ResolvedRules,
) -> VoloResult<DisableOutcome> {
    match disable_project(host, ini_path, rules) {
        Ok(out) => Ok(out),
        Err(VoloError::Io(ref io_err))
            if io_err.kind() == std::io::ErrorKind::NotFound =>
        {
            Ok(DisableOutcome {
                changed: false,
                ini_file: ini_path.to_string(),
                backups: vec![],
                keys_removed: vec![],
                warnings: vec![format!(
                    "UserEngine.ini not found at {ini_path} — nothing to disable (not an error)"
                )],
            })
        }
        Err(e) => Err(e),
    }
}

// --- Tests ----------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::zen::rules_loader::{
        DisablePakRule, DisableRule, EnableZenSharedRule, EnvCleanup, ResolvedRules, RuleSet,
    };

    fn sample_master() -> ClusterMaster {
        ClusterMaster {
            host: "render-master".to_string(),
            port: 8558,
            namespace: "ue.ddc".to_string(),
        }
    }

    fn sample_rules() -> ResolvedRules {
        ResolvedRules {
            rules: RuleSet {
                enable_zen_shared: EnableZenSharedRule {
                    ini_file: "DefaultEngine.ini".to_string(),
                    section: "StorageServers".to_string(),
                    key: "Shared".to_string(),
                    value_template:
                        "(Host=\"http://{host}:{port}\", Namespace=\"{namespace}\", EnvHostOverride=UE-ZenSharedDataCacheHost, CommandLineHostOverride=ZenSharedDataCacheHost, DeactivateAt=60)"
                            .to_string(),
                    backup: true,
                },
                disable_legacy_smb_shared: DisableRule {
                    ini_file: "DefaultEngine.ini".to_string(),
                    section: "InstalledDerivedDataBackendGraph".to_string(),
                    key: "Shared".to_string(),
                    action: "remove".to_string(),
                    backup: true,
                    env_cleanup: vec![EnvCleanup {
                        var: "UE-SharedDataCachePath".to_string(),
                        scopes: vec!["machine".to_string(), "user".to_string()],
                    }],
                },
                disable_legacy_pak: DisablePakRule {
                    ini_file: "DefaultEngine.ini".to_string(),
                    section: "InstalledDerivedDataBackendGraph".to_string(),
                    keys: vec!["Pak".to_string(), "CompressedPak".to_string()],
                    action: "remove".to_string(),
                    backup: true,
                },
            },
            warnings: Vec::new(),
            matched_version: "5.7".to_string(),
        }
    }

    fn rendered_zen_value() -> String {
        "(Host=\"http://render-master:8558\", Namespace=\"ue.ddc\", EnvHostOverride=UE-ZenSharedDataCacheHost, CommandLineHostOverride=ZenSharedDataCacheHost, DeactivateAt=60)".to_string()
    }

    // --- apply_value_template -------------------------------------------

    #[test]
    fn apply_value_template_substitutes_known_placeholders() {
        let m = sample_master();
        let out = apply_value_template(
            "(Host=\"http://{host}:{port}\", Namespace=\"{namespace}\", EnvHostOverride=UE-ZenSharedDataCacheHost, CommandLineHostOverride=ZenSharedDataCacheHost, DeactivateAt=60)",
            &m,
        )
        .unwrap();
        assert_eq!(out, rendered_zen_value());
    }

    #[test]
    fn apply_value_template_rejects_unknown_placeholder() {
        let m = sample_master();
        let err = apply_value_template("Host={server}", &m).unwrap_err();
        match err {
            VoloError::Configuration(msg) => {
                assert!(
                    msg.contains("{server}"),
                    "error should name the bad placeholder: {}",
                    msg
                );
                assert!(msg.contains("{host}"), "error should hint at supported set");
            }
            other => panic!("expected Configuration, got {:?}", other),
        }
    }

    #[test]
    fn apply_value_template_is_case_sensitive() {
        // Uppercase `{Host}` should be rejected — we don't second-guess case
        // because that would let typos silently match.
        let m = sample_master();
        let err = apply_value_template("Host={Host}", &m).unwrap_err();
        assert!(matches!(err, VoloError::Configuration(_)));
    }

    #[test]
    fn apply_value_template_passes_through_literal_braces() {
        // Stray `{` with no matching close is left in place; we don't fail
        // on it. This keeps the helper forgiving for edge formats.
        let m = sample_master();
        let out = apply_value_template("prefix{ suffix", &m).unwrap();
        assert_eq!(out, "prefix{ suffix");
    }

    // Codex round-14 P2: `host` / `namespace` must be validated before
    // substitution so a `"`, `,`, `)`, or control char inside the value
    // can't break the rendered INI line.
    #[test]
    fn apply_value_template_rejects_quote_in_host() {
        let mut m = sample_master();
        m.host = "bad\"host".into();
        let err = apply_value_template(
            "(Host=\"http://{host}:{port}\", Namespace=\"{namespace}\", EnvHostOverride=UE-ZenSharedDataCacheHost, CommandLineHostOverride=ZenSharedDataCacheHost, DeactivateAt=60)",
            &m,
        )
        .unwrap_err();
        assert!(matches!(err, VoloError::Configuration(_)));
    }

    #[test]
    fn apply_value_template_rejects_paren_in_namespace() {
        let mut m = sample_master();
        m.namespace = "foo)bar".into();
        let err = apply_value_template(
            "(Host=\"http://{host}:{port}\", Namespace=\"{namespace}\", EnvHostOverride=UE-ZenSharedDataCacheHost, CommandLineHostOverride=ZenSharedDataCacheHost, DeactivateAt=60)",
            &m,
        )
        .unwrap_err();
        assert!(matches!(err, VoloError::Configuration(_)));
    }

    #[test]
    fn apply_value_template_rejects_newline_in_host() {
        let mut m = sample_master();
        m.host = "host\nattack".into();
        let err = apply_value_template(
            "(Host=\"http://{host}:{port}\", Namespace=\"{namespace}\", EnvHostOverride=UE-ZenSharedDataCacheHost, CommandLineHostOverride=ZenSharedDataCacheHost, DeactivateAt=60)",
            &m,
        )
        .unwrap_err();
        assert!(matches!(err, VoloError::Configuration(_)));
    }

    #[test]
    fn apply_value_template_accepts_ipv6_literal_host() {
        // Bracketed IPv6 literal `[::1]` must still be accepted as a host.
        let mut m = sample_master();
        m.host = "[::1]".into();
        let out = apply_value_template(
            "(Host=\"http://{host}:{port}\", Namespace=\"{namespace}\", EnvHostOverride=UE-ZenSharedDataCacheHost, CommandLineHostOverride=ZenSharedDataCacheHost, DeactivateAt=60)",
            &m,
        )
        .unwrap();
        assert!(out.contains("Host=\"http://[::1]:8558\""));
    }

    #[test]
    fn apply_value_template_rejects_colon_in_namespace() {
        // Namespaces are NOT IP literals — `:` should be rejected to keep
        // the grammar tight.
        let mut m = sample_master();
        m.namespace = "a:b".into();
        let err = apply_value_template(
            "(Host=\"http://{host}:{port}\", Namespace=\"{namespace}\", EnvHostOverride=UE-ZenSharedDataCacheHost, CommandLineHostOverride=ZenSharedDataCacheHost, DeactivateAt=60)",
            &m,
        )
        .unwrap_err();
        assert!(matches!(err, VoloError::Configuration(_)));
    }

    #[test]
    fn apply_value_template_rejects_empty_host() {
        let mut m = sample_master();
        m.host = "".into();
        let err = apply_value_template(
            "(Host=\"http://{host}:{port}\", Namespace=\"{namespace}\", EnvHostOverride=UE-ZenSharedDataCacheHost, CommandLineHostOverride=ZenSharedDataCacheHost, DeactivateAt=60)",
            &m,
        )
        .unwrap_err();
        assert!(matches!(err, VoloError::Configuration(_)));
    }

    // --- compute_enable_diff ---------------------------------------------

    /// Default helper: all three rules target the same section, mirroring
    /// the v1 yaml. For section-override tests use [`diff_for_split`].
    fn diff_for(current: &[IniKey]) -> EnableDiff {
        compute_enable_diff(
            current,
            "InstalledDerivedDataBackendGraph",
            "ZenShared",
            &rendered_zen_value(),
            current, // smb section keys = same section
            "Shared",
            "InstalledDerivedDataBackendGraph",
            current, // pak section keys = same section
            &["Pak".to_string(), "CompressedPak".to_string()],
            "InstalledDerivedDataBackendGraph",
        )
    }

    /// Section-split variant: enables a test to assert that legacy keys in
    /// a *different* section than `enable_zen_shared` are still found and
    /// planned for removal (codex P2 regression guard).
    #[allow(dead_code)]
    fn diff_for_split(
        zen_keys: &[IniKey],
        smb_keys: &[IniKey],
        pak_keys: &[IniKey],
    ) -> EnableDiff {
        compute_enable_diff(
            zen_keys,
            "InstalledDerivedDataBackendGraph",
            "ZenShared",
            &rendered_zen_value(),
            smb_keys,
            "Shared",
            "LegacySmbBackend",
            pak_keys,
            &["Pak".to_string(), "CompressedPak".to_string()],
            "LegacyPakBackend",
        )
    }

    #[test]
    fn compute_diff_on_empty_section_plans_set_only() {
        let diff = diff_for(&[]);
        assert!(diff.set_zen_shared.is_some(), "must plan ZenShared set");
        assert!(
            diff.remove_legacy.is_empty(),
            "no legacy keys present => no removes"
        );
        let rec = diff.set_zen_shared.unwrap();
        assert_eq!(rec.action, "set");
        assert!(rec.previous_value.is_none());
        assert_eq!(rec.new_value.as_deref(), Some(rendered_zen_value().as_str()));
    }

    #[test]
    fn compute_diff_when_zen_already_correct_returns_noop() {
        let diff = diff_for(&[IniKey {
            name: "ZenShared".to_string(),
            value: rendered_zen_value(),
        }]);
        assert!(diff.is_noop(), "diff should be a no-op");
        assert!(diff.set_zen_shared.is_none());
        assert!(diff.remove_legacy.is_empty());
    }

    #[test]
    fn compute_diff_when_zen_has_stale_value_plans_set_with_previous() {
        let diff = diff_for(&[IniKey {
            name: "ZenShared".to_string(),
            value: "(Type=Zen, Host=\"old\", Port=1, Namespace=\"x\")".to_string(),
        }]);
        let rec = diff.set_zen_shared.expect("must replan set");
        assert_eq!(
            rec.previous_value.as_deref(),
            Some("(Type=Zen, Host=\"old\", Port=1, Namespace=\"x\")")
        );
        assert_eq!(rec.new_value.as_deref(), Some(rendered_zen_value().as_str()));
    }

    #[test]
    fn compute_diff_strips_all_legacy_keys_when_present() {
        let diff = diff_for(&[
            IniKey {
                name: "Pak".to_string(),
                value: "(Type=Pak, Path=\"E:/Pak\")".to_string(),
            },
            IniKey {
                name: "CompressedPak".to_string(),
                value: "(Type=Pak, Compressed=true)".to_string(),
            },
            IniKey {
                name: "Shared".to_string(),
                value: "(Type=FileSystem, Path=\"\\\\srv\\share\")".to_string(),
            },
        ]);
        assert!(diff.set_zen_shared.is_some());
        let removed: Vec<_> = diff.remove_legacy.iter().map(|r| r.key.as_str()).collect();
        assert!(removed.contains(&"Shared"));
        assert!(removed.contains(&"Pak"));
        assert!(removed.contains(&"CompressedPak"));
        assert_eq!(removed.len(), 3);
        for rec in &diff.remove_legacy {
            assert_eq!(rec.action, "remove");
            assert!(rec.previous_value.is_some());
            assert!(rec.new_value.is_none());
        }
    }

    #[test]
    fn compute_diff_partial_legacy_only_strips_present_ones() {
        let diff = diff_for(&[IniKey {
            name: "Pak".to_string(),
            value: "(Type=Pak)".to_string(),
        }]);
        assert_eq!(diff.remove_legacy.len(), 1);
        assert_eq!(diff.remove_legacy[0].key, "Pak");
    }

    #[test]
    fn compute_diff_finds_legacy_keys_in_overridden_sections() {
        // Codex P2 regression guard: when overrides put SMB / Pak rules in
        // different sections than enable_zen_shared, the diff must consult
        // each rule's own section, not just the enable section.
        let zen_keys: Vec<IniKey> = Vec::new(); // ZenShared not present yet.
        let smb_keys = vec![IniKey {
            name: "Shared".to_string(),
            value: "(Type=Filesystem)".to_string(),
        }];
        let pak_keys = vec![
            IniKey {
                name: "Pak".to_string(),
                value: "(Type=Pak)".to_string(),
            },
            IniKey {
                name: "CompressedPak".to_string(),
                value: "(Type=Pak)".to_string(),
            },
        ];

        let diff = diff_for_split(&zen_keys, &smb_keys, &pak_keys);
        assert!(diff.set_zen_shared.is_some());
        // 1 SMB + 2 Pak removes, each in its own section.
        let removed: Vec<(&str, &str)> = diff
            .remove_legacy
            .iter()
            .map(|r| (r.section.as_str(), r.key.as_str()))
            .collect();
        assert!(removed.contains(&("LegacySmbBackend", "Shared")));
        assert!(removed.contains(&("LegacyPakBackend", "Pak")));
        assert!(removed.contains(&("LegacyPakBackend", "CompressedPak")));
        assert_eq!(removed.len(), 3);
    }

    #[test]
    fn compute_diff_matches_keys_case_insensitively() {
        // Codex P2: UE / write-ini-key.ps1 treat key names case-insensitively.
        // A project INI with `zenshared=`, `SHARED=`, or `pAk=` MUST be
        // picked up by the diff, otherwise enable/disable would leave the
        // legacy backends active or fail to remove a differently-cased
        // ZenShared row.
        let lowered_zen = rendered_zen_value();
        let zen_keys = vec![IniKey {
            name: "zenshared".to_string(), // existing key, wrong case
            value: "(Type=Zen, Host=\"old\", Port=1, Namespace=\"x\")".to_string(),
        }];
        let smb_keys = vec![IniKey {
            name: "SHARED".to_string(),
            value: "(Type=Filesystem)".to_string(),
        }];
        let pak_keys_keys = vec![IniKey {
            name: "pAk".to_string(),
            value: "(Type=Pak)".to_string(),
        }];
        let diff = diff_for_split(&zen_keys, &smb_keys, &pak_keys_keys);
        // Zen value differs → plan a set.
        let set = diff.set_zen_shared.expect("zen set planned");
        assert_eq!(set.action, "set");
        assert!(set.previous_value.is_some());
        assert_eq!(set.new_value.as_deref(), Some(lowered_zen.as_str()));
        // Both legacy keys found despite case mismatch.
        let removed_keys: Vec<&str> = diff
            .remove_legacy
            .iter()
            .map(|r| r.key.as_str())
            .collect();
        assert!(removed_keys.contains(&"Shared"));
        assert!(removed_keys.contains(&"Pak"));
    }

    #[test]
    fn compute_diff_ignores_legacy_keys_in_unrelated_sections() {
        // If a legacy key sits in the enable section (cross-contamination
        // by mistake), the SMB / Pak diff still only consults their own
        // section slices and should NOT plan a remove.
        let zen_keys = vec![IniKey {
            name: "Pak".to_string(), // ← accidentally in the zen section
            value: "(Type=Pak)".to_string(),
        }];
        let smb_keys: Vec<IniKey> = Vec::new();
        let pak_keys: Vec<IniKey> = Vec::new();

        let diff = diff_for_split(&zen_keys, &smb_keys, &pak_keys);
        // The mis-placed Pak key in the zen section is NOT in pak_section_keys,
        // so the diff plans no removes. (Operator can clean that up manually.)
        assert!(diff.remove_legacy.is_empty());
    }

    // --- enable_project (loopback-driven integration) --------------------

    /// Write `contents` to a temp file, run `enable_project` against it
    /// using `127.0.0.1` so the editor's loopback short-circuit kicks in,
    /// then return the updated INI contents and the outcome.
    fn run_enable(contents: &str) -> (String, EnableOutcome) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("DefaultEngine.ini");
        std::fs::write(&path, contents).unwrap();
        let outcome = enable_project(
            "127.0.0.1",
            path.to_str().unwrap(),
            &sample_rules(),
            &sample_master(),
        )
        .expect("enable_project ok");
        let final_contents = std::fs::read_to_string(&path).unwrap();
        // Hold tempdir alive for the read; close after.
        drop(dir);
        (final_contents, outcome)
    }

    #[test]
    fn enable_project_on_fresh_ini_adds_zen_shared_only() {
        let initial = "[InstalledDerivedDataBackendGraph]\nLocal=(Type=FileSystem)\n";
        let (after, outcome) = run_enable(initial);
        assert!(outcome.changed, "fresh INI must change");
        assert_eq!(outcome.keys_set.len(), 1, "StorageServers Shared only");
        assert_eq!(outcome.keys_set[0].key, "Shared");
        assert!(outcome.keys_removed.is_empty(), "no legacy keys to remove");
        assert!(after.contains("[StorageServers]"), "StorageServers section created");
        assert!(after.contains("Host=\"http://render-master:8558\""));
        assert!(after.contains("Local=(Type=FileSystem)"), "untouched key stays");
        assert_eq!(outcome.backups.len(), 1, "one backup per write");
        // Env cleanup metadata is captured even when no env action was taken.
        assert_eq!(outcome.env_cleanup_planned.len(), 1);
        assert_eq!(outcome.env_cleanup_planned[0].var, "UE-SharedDataCachePath");
    }

    #[test]
    fn enable_project_is_idempotent_when_already_applied() {
        let initial = format!(
            "[StorageServers]\nShared={}\n",
            rendered_zen_value()
        );
        let (after, outcome) = run_enable(&initial);
        assert!(!outcome.changed, "fully-applied INI must be a no-op");
        assert!(outcome.keys_set.is_empty());
        assert!(outcome.keys_removed.is_empty());
        assert!(outcome.backups.is_empty(), "no writes => no backups");
        assert_eq!(after, initial, "no-op must not rewrite the file");
    }

    #[test]
    fn enable_project_strips_legacy_pak_and_smb() {
        let initial = "[InstalledDerivedDataBackendGraph]\n\
                       Pak=(Type=Pak, Path=\"E:/Pak\")\n\
                       CompressedPak=(Type=Pak)\n\
                       Shared=(Type=FileSystem, Path=\"\\\\srv\\share\")\n";
        let (after, outcome) = run_enable(initial);
        assert!(outcome.changed);
        assert_eq!(outcome.keys_set.len(), 1, "StorageServers Shared");
        assert_eq!(outcome.keys_removed.len(), 3, "Pak + CompressedPak + Shared");
        assert!(!after.contains("Pak=(Type=Pak"));
        assert!(!after.contains("CompressedPak="));
        assert!(!after.contains("Shared=(Type=FileSystem"));
        assert!(after.contains("[StorageServers]"));
        assert!(after.contains("Shared=(Host=\"http://render-master:8558\""));
        // One backup per mutation: 1 set + 3 removes.
        assert_eq!(outcome.backups.len(), 4);
        // Outcome should include a warning about env cleanup being needed.
        assert!(
            outcome.warnings.iter().any(|w| w.contains("env var")),
            "expected env-cleanup warning; got {:?}",
            outcome.warnings
        );
    }

    #[test]
    fn enable_project_propagates_resolver_warnings() {
        // Simulate the warn-policy path: ResolvedRules carries an inbound
        // warning that the orchestrator must echo back.
        let mut rules = sample_rules();
        rules
            .warnings
            .push("UE 5.8 not in verified_versions; applying defaults".to_string());
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("DefaultEngine.ini");
        std::fs::write(&path, "[InstalledDerivedDataBackendGraph]\n").unwrap();
        let outcome = enable_project(
            "127.0.0.1",
            path.to_str().unwrap(),
            &rules,
            &sample_master(),
        )
        .unwrap();
        assert!(
            outcome
                .warnings
                .iter()
                .any(|w| w.contains("not in verified_versions")),
            "inbound resolver warning must be carried over"
        );
    }

    // --- disable_project --------------------------------------------------

    #[test]
    fn disable_project_removes_zen_shared_when_present() {
        let initial = format!(
            "[StorageServers]\nShared={}\nLocal=(Type=FileSystem)\n",
            rendered_zen_value()
        );
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("DefaultEngine.ini");
        std::fs::write(&path, &initial).unwrap();
        let outcome = disable_project(
            "127.0.0.1",
            path.to_str().unwrap(),
            &sample_rules(),
        )
        .unwrap();
        let after = std::fs::read_to_string(&path).unwrap();
        assert!(outcome.changed);
        assert_eq!(outcome.keys_removed[0].key, "Shared");
        assert!(!after.contains("Shared="));
        assert!(after.contains("Local=(Type=FileSystem)"));
        // Narrow-disable warning must be present.
        assert!(
            outcome
                .warnings
                .iter()
                .any(|w| w.contains("narrow disable")),
            "expected narrow-disable warning; got {:?}",
            outcome.warnings
        );
    }

    #[test]
    fn disable_project_is_idempotent_when_zen_absent() {
        let initial = "[InstalledDerivedDataBackendGraph]\nLocal=(Type=FileSystem)\n";
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("DefaultEngine.ini");
        std::fs::write(&path, initial).unwrap();
        let outcome = disable_project(
            "127.0.0.1",
            path.to_str().unwrap(),
            &sample_rules(),
        )
        .unwrap();
        let after = std::fs::read_to_string(&path).unwrap();
        assert!(!outcome.changed);
        assert!(outcome.keys_removed.is_empty());
        assert!(outcome.backups.is_empty());
        assert_eq!(after, initial);
        // Even the no-op path emits the narrow-disable warning so operators
        // are never confused about restore semantics.
        assert!(
            outcome
                .warnings
                .iter()
                .any(|w| w.contains("narrow disable"))
        );
    }

    // --- enable_global / disable_global ------------------------------------

    #[test]
    fn enable_global_creates_file_and_writes_zen_shared() {
        use tempfile::tempdir;
        let dir = tempdir().unwrap();
        let ini = dir.path().join("UserEngine.ini");
        let ini_str = ini.to_str().unwrap();
        assert!(!ini.exists());

        let rules = sample_rules();
        let master = ClusterMaster {
            host: "192.168.10.20".to_string(),
            port: 8558,
            namespace: "ue.ddc".to_string(),
        };
        let out = enable_global("127.0.0.1", ini_str, &rules, &master).unwrap();
        assert!(out.changed);
        let contents = std::fs::read_to_string(&ini).unwrap();
        assert!(contents.contains("[StorageServers]"));
        assert!(contents.contains("Shared=(Host=\"http://192.168.10.20:8558\""));
    }

    #[test]
    fn disable_global_is_noop_when_file_absent() {
        let rules = sample_rules();
        let out = disable_global("127.0.0.1", "/nonexistent/path/UserEngine.ini", &rules).unwrap();
        assert!(!out.changed);
        assert!(out.warnings.iter().any(|w| w.contains("not found")));
    }

    #[test]
    fn disable_project_does_not_restore_legacy_keys() {
        // Seed an INI that has BOTH ZenShared AND a stale `Pak=...` line as
        // if something else added it post-enable. Disable must remove only
        // ZenShared and leave the stray legacy key untouched.
        let initial = format!(
            "[StorageServers]\nShared={}\nPak=(Type=Pak)\n",
            rendered_zen_value()
        );
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("DefaultEngine.ini");
        std::fs::write(&path, &initial).unwrap();
        let outcome = disable_project(
            "127.0.0.1",
            path.to_str().unwrap(),
            &sample_rules(),
        )
        .unwrap();
        let after = std::fs::read_to_string(&path).unwrap();
        assert!(outcome.changed);
        assert!(outcome.keys_removed.iter().any(|r| r.key == "Shared"));
        assert!(!after.contains("Shared="));
        assert!(
            after.contains("Pak=(Type=Pak)"),
            "narrow disable must NOT restore or otherwise touch legacy Pak"
        );
    }
}
