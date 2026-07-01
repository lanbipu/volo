//! Zen-specific INI diagnostics (Plan 7 §M4 T4.1).
//!
//! Sister module to [`crate::core::ini_diagnostics`]. The base module already
//! ships R001-R010 against the cluster's legacy DDC + PSO surface. This file
//! adds R012-R018 which target the ZenShared upstream + the legacy DDC bits
//! that conflict with it.
//!
//! ## Why a sister module
//!
//! The base rule engine has no knowledge of:
//!   * which UE version the project targets (drives `applies_to`),
//!   * which zen endpoint is registered for the cluster master,
//!   * whether that endpoint has a recent reachable probe,
//!   * the per-machine zen install binary sha,
//!   * the multi-machine `zenserver_build_version` distribution.
//!
//! Plumbing all of that through `run_rules(&ParsedFile, &EnvVarState)` would
//! either inflate `EnvVarState` (it's supposed to be the env var snapshot
//! only) or change the existing public signature in ways that ripple through
//! `core::ini_scanner` and every caller. Instead this file exposes
//! [`evaluate_with_zen_context`] — a sibling entry point that callers who
//! have the extra inputs handy can call; everyone else keeps using
//! `ini_diagnostics::run_rules` unchanged.
//!
//! ## Rule data
//!
//! All section / key / value-template strings come from
//! [`crate::core::zen::rules_loader::ResolvedRules`]. The YAML is the single
//! source of truth (frozen contract — Plan 7 T0.5). This file does NOT
//! hardcode `"ZenShared"` / `"InstalledDerivedDataBackendGraph"` / etc.; the
//! YAML's defaults happen to use those names but a future override could
//! change the section / key shape and these rules must keep working.

use crate::core::ini_diagnostics::{
    Category, EnvVarState, Finding, ParsedFile, ParsedKey, ParsedSection, RecommendedAction,
    Severity,
};
use crate::core::zen::rules_loader::ResolvedRules;

/// Per-machine + cluster context required to run the zen rules.
///
/// A caller that doesn't have all of these (e.g. CLI run that only has the
/// project INI and no endpoint state yet) can still call
/// [`evaluate_with_zen_context`] — rules whose inputs are missing are simply
/// skipped (no false-positive findings).
#[derive(Debug, Clone)]
pub struct ZenRuleContext<'a> {
    /// Resolved rule set for the project's UE version. Provides the section,
    /// key, and value-template names. When `None` the engine cannot tell
    /// whether the project's UE version is in scope, so R012-R015 are
    /// skipped. R016-R018 still run (they don't depend on the rule set).
    pub resolved: Option<&'a ResolvedRules>,

    /// Whether the cluster has at least one zen endpoint registered. R012
    /// only fires when an endpoint exists; otherwise "ZenShared missing"
    /// would scold a project that has no upstream to point at.
    pub endpoint_registered: bool,

    /// `(host, has_recent_reachable_probe)` for the host the resolved rule's
    /// value would point at. R014 uses this to decide whether the host name
    /// in the existing `ZenShared` value matches a known-good endpoint.
    /// Empty = no endpoint info available → R014 skipped.
    pub endpoint_reachability: Vec<EndpointReachability>,

    /// `(zenserver_sha256, expected_sha256)` for the install path on this
    /// machine. Both must be present for R016 to fire (Some/Some +
    /// mismatch → finding). InTree drift is handled by the caller (log
    /// only — see T4.3 doc-comment on
    /// [`crate::core::health_check::zen_health_for_machine`]).
    pub install_binary: Option<InstallBinaryCheck>,

    /// Per-machine `zenserver_build_version` for the cluster. R018 only
    /// fires when at least 3 entries are present — anything less can't
    /// support a "majority" claim. The current machine's hostname is the
    /// scope key the caller can use to map a R018 finding back to the
    /// outlier; this module just emits one finding per outlier.
    pub cluster_versions: Vec<MachineZenVersion>,

    /// The machine these rules are being evaluated against. Used to gate
    /// R018 — only the outlier machine sees its own finding.
    pub current_machine_id: Option<i64>,
}

/// (host, port, namespace, reachable-in-window) tuple for R014.
///
/// `port` and `namespace` are optional so callers that only have a host can
/// still populate the row. When both sides are present the rule additionally
/// verifies the value's `Port=` / `Namespace=` match a known-good endpoint;
/// a mismatch is treated the same as "host not reachable" (= R014 fires).
#[derive(Debug, Clone)]
pub struct EndpointReachability {
    pub host: String,
    pub port: Option<i64>,
    pub namespace: Option<String>,
    pub recent_reachable: bool,
}

/// Install binary baseline check inputs for R016.
#[derive(Debug, Clone)]
pub struct InstallBinaryCheck {
    /// sha256 of `zenserver.exe` recorded in
    /// `machine_zen_install.zenserver_sha256`.
    pub actual_sha256: String,
    /// sha256 from the `zen_binary_expected` baseline for the same
    /// `zen_build_version` + `binary_kind="zenserver"`.
    pub expected_sha256: String,
    /// Build version that was matched, for the message.
    pub build_version: String,
}

/// One machine's reported zen server version, used by R018.
#[derive(Debug, Clone)]
pub struct MachineZenVersion {
    pub machine_id: i64,
    pub zenserver_build_version: String,
}

impl<'a> Default for ZenRuleContext<'a> {
    fn default() -> Self {
        Self {
            resolved: None,
            endpoint_registered: false,
            endpoint_reachability: Vec::new(),
            install_binary: None,
            cluster_versions: Vec::new(),
            current_machine_id: None,
        }
    }
}

/// Evaluate R012-R015 + R017 against one parsed INI file plus the context.
///
/// R012-R015 + R017 are project-INI rules; they only fire on
/// `Category::Project` files and only on the canonical `DefaultEngine.ini`.
///
/// `env_state` is the same snapshot used by `core::ini_diagnostics::run_rules`.
/// R015 inspects it to detect the env-var-route variant of the legacy SMB
/// upstream (`UE-SharedDataCachePath` set + ZenShared also configured →
/// both backends fight). The INI-key variant of R015 (legacy `Shared=` key
/// alongside ZenShared) is independent of env state.
///
/// R016 (zenserver.exe sha256 vs baseline) and R018 (cluster version
/// majority) are machine-level rules — calling them per-file would
/// duplicate findings (one per scanned INI). Use
/// [`evaluate_machine_zen`] once per machine for those.
pub fn run_zen_rules_for_file(
    file: &ParsedFile,
    env_state: &EnvVarState,
    ctx: &ZenRuleContext<'_>,
) -> Vec<Finding> {
    let mut out = Vec::new();
    out.extend(rule_r012(file, ctx));
    out.extend(rule_r013(file, ctx));
    out.extend(rule_r014(file, ctx));
    out.extend(rule_r015(file, env_state, ctx));
    out.extend(rule_r017(file, ctx));
    out
}

/// Run every machine-level zen rule (R016 + R018). These don't depend on
/// any INI file content but the callers need a `Finding` shape, so a
/// synthetic [`ParsedFile`] is used internally. The returned findings
/// carry `file_path` markers like `<machine:...>` so a downstream UI
/// can group them under the machine row instead of mixing them in with
/// per-file results.
pub fn evaluate_machine_zen(ctx: &ZenRuleContext<'_>) -> Vec<Finding> {
    let marker = synthetic_machine_marker(
        ctx.current_machine_id
            .map(|id| format!("{}", id))
            .as_deref()
            .unwrap_or("unknown"),
    );
    let mut out = Vec::new();
    out.extend(rule_r016(&marker, ctx));
    out.extend(rule_r018(&marker, ctx));
    out
}

/// Owned snapshot of all DB-derived inputs the zen rules need for one
/// machine. Lives independently of [`ZenRuleContext`] (which borrows from
/// this) so the caller can hand a single value across the scan loop.
///
/// Usage:
///
/// ```ignore
/// let owned = ZenRuleContextOwned::for_machine(&db, machine_id, "5.7")?;
/// let ctx: ZenRuleContext<'_> = owned.as_ctx();
/// inputs.zen_ctx = Some(&ctx);
/// ```
pub struct ZenRuleContextOwned {
    pub resolved: Option<ResolvedRules>,
    pub endpoint_registered: bool,
    pub endpoint_reachability: Vec<EndpointReachability>,
    pub install_binary: Option<InstallBinaryCheck>,
    pub cluster_versions: Vec<MachineZenVersion>,
    pub current_machine_id: Option<i64>,
}

impl ZenRuleContextOwned {
    pub fn as_ctx(&self) -> ZenRuleContext<'_> {
        ZenRuleContext {
            resolved: self.resolved.as_ref(),
            endpoint_registered: self.endpoint_registered,
            endpoint_reachability: self.endpoint_reachability.clone(),
            install_binary: self.install_binary.clone(),
            cluster_versions: self.cluster_versions.clone(),
            current_machine_id: self.current_machine_id,
        }
    }

    /// Auto-enabled posture: returns an owned context with `resolved=None`
    /// and empty endpoint state. Callers use [`auto_enabled`] when they
    /// have decided zen rules should run but can't (or don't want to)
    /// query the DB themselves.
    pub fn empty(machine_id: i64) -> Self {
        Self {
            resolved: None,
            endpoint_registered: false,
            endpoint_reachability: Vec::new(),
            install_binary: None,
            cluster_versions: Vec::new(),
            current_machine_id: Some(machine_id),
        }
    }
}

/// Run only the cluster-aggregate version-consistency rule (R018). Kept as a
/// separate entry point so callers that only want this signal can opt in
/// without also computing the binary-baseline check (R016). The supplied
/// `file` lets callers stamp a meaningful `file_path` into the finding —
/// usually [`synthetic_machine_marker`].
pub fn evaluate_cluster_zen_consistency(
    file: &ParsedFile,
    ctx: &ZenRuleContext<'_>,
) -> Vec<Finding> {
    rule_r018(file, ctx)
}

/// Convenience: build a "virtual" `ParsedFile` for callers that want to run
/// cluster-aggregate rules without an actual INI on disk (R018 reports on
/// the machine's overall posture, not a file). The returned `ParsedFile`
/// has a stable, recognizable path so a downstream UI can group it.
pub fn synthetic_machine_marker(machine_hint: &str) -> ParsedFile {
    ParsedFile {
        path: format!("<machine:{}>", machine_hint),
        category: Category::Project,
        sections: Vec::new(),
    }
}

// --- Helpers --------------------------------------------------------------

/// Case-insensitive section lookup. `find_ddc` in the base module is hard-
/// coded to the legacy DDC section; we need a generic helper because the
/// section name is data-driven from the YAML.
fn find_section<'a>(file: &'a ParsedFile, name: &str) -> Option<&'a ParsedSection> {
    file.sections.iter().find(|s| s.name.eq_ignore_ascii_case(name))
}

fn find_key<'a>(section: &'a ParsedSection, name: &str) -> Option<&'a ParsedKey> {
    section.keys.iter().find(|k| k.name.eq_ignore_ascii_case(name))
}

/// Parse `Host="foo"` (or `Host=foo`) out of a value like
/// `(Type=Zen, Host="render-master", Port=8558, Namespace="ue.ddc")`.
/// Returns `None` if the field is absent.
///
/// Zen's value grammar is flat `key=value` separated by commas, optionally
/// double-quoted, no nesting. We tokenize on commas + any leading `(` /
/// trailing `)` then split each token on `=` and match the field name
/// **exactly** (case-insensitive). A naive substring search (`lower.find("host=")`)
/// would mis-match `ProxyHost=...` / `BackupHost=...` — boundary matching
/// is required.
fn extract_field(value: &str, field: &str) -> Option<String> {
    let trimmed = value.trim().trim_start_matches('(').trim_end_matches(')');
    for token in trimmed.split(',') {
        let (raw_key, raw_val) = match token.split_once('=') {
            Some(p) => p,
            None => continue,
        };
        let key = raw_key.trim();
        if !key.eq_ignore_ascii_case(field) {
            continue;
        }
        // Trim surrounding whitespace + optional quotes from the value.
        let mut v = raw_val.trim();
        if let Some(inner) = v.strip_prefix('"') {
            if let Some(end) = inner.find('"') {
                v = &inner[..end];
            }
        }
        let v = v.trim();
        if v.is_empty() {
            return None;
        }
        return Some(v.to_string());
    }
    None
}

/// Parse a `[StorageServers]` Host value into `(host_without_scheme, port)`.
///
/// UE's `FHttpHostBuilder::AddFromString` treats the Host as a `;`-separated
/// list of full-URL candidates (`http://host:port`). For diagnostics we only
/// look at the first candidate and recover the bare host + the embedded port
/// so R014 can compare them against a registered endpoint (whose host/port are
/// stored unscheme'd). Handles bracketed IPv6 literals (`http://[::1]:8558`).
///
/// Returns `None` when the value is empty. `port` is `None` when no `:port`
/// suffix is present in the authority.
fn parse_storage_host_uri(host_value: &str) -> Option<(String, Option<i64>)> {
    let first = host_value.split(';').next()?.trim();
    if first.is_empty() {
        return None;
    }
    // Strip an optional scheme (`http://` / `https://`).
    let after_scheme = first.split_once("://").map(|(_, rest)| rest).unwrap_or(first);
    // Drop any path/query: keep only the authority (host[:port]).
    let authority = after_scheme
        .split(['/', '?'])
        .next()
        .unwrap_or(after_scheme)
        .trim();
    // Bracketed IPv6 literal: [host]:port
    if let Some(rest) = authority.strip_prefix('[') {
        let end = rest.find(']')?;
        let host = format!("[{}]", &rest[..end]);
        let port = rest[end + 1..]
            .strip_prefix(':')
            .and_then(|p| p.parse::<i64>().ok());
        return Some((host, port));
    }
    // Plain host[:port] — the port is the trailing `:NNN` when numeric.
    if let Some((h, p)) = authority.rsplit_once(':') {
        if let Ok(port) = p.parse::<i64>() {
            return Some((h.to_string(), Some(port)));
        }
    }
    Some((authority.to_string(), None))
}

/// Is `value` shaped like a valid `[StorageServers]` `Shared` entry, i.e.
/// `(Host="http://host:port", Namespace="...", ...)`?
///
/// Modern UE (5.4+) wires the shared Zen DDC through the default
/// `ZenShared=(Type=Zen, ServerID=Shared)` node + a `[StorageServers] Shared`
/// override. The override entry is type-less (the consuming store's `Type=`
/// lives on the graph node, not here) and has NO bare `Port=` — the port MUST
/// be embedded in the Host URI (`FZenCacheStoreParams` has no Port field).
/// So well-formed = a Host URI that carries a scheme **and** an embedded port,
/// is not the `None` disable sentinel, plus a non-empty Namespace. A bare
/// host (`Host="render-master"`) or a stray `Port=` token is flagged malformed
/// — that is exactly the broken legacy shape this fix replaces.
fn is_well_formed_zen_shared(value: &str) -> bool {
    let v = value.trim();
    if !v.starts_with('(') || !v.ends_with(')') {
        return false;
    }
    let Some(host) = extract_field(v, "Host") else {
        return false;
    };
    // `Host=None` is UE's disable sentinel — not a wired upstream.
    if host.eq_ignore_ascii_case("None") {
        return false;
    }
    // Host must be a full URI with scheme + embedded port.
    if !host.contains("://") {
        return false;
    }
    match parse_storage_host_uri(&host) {
        Some((h, Some(_port))) if !h.is_empty() => {}
        _ => return false,
    }
    if extract_field(v, "Namespace").is_none() {
        return false;
    }
    true
}

// --- Rules ----------------------------------------------------------------

fn rule_r012(file: &ParsedFile, ctx: &ZenRuleContext<'_>) -> Vec<Finding> {
    if file.category != Category::Project {
        return vec![];
    }
    if !ctx.endpoint_registered {
        return vec![];
    }
    let Some(resolved) = ctx.resolved else { return vec![] };
    let rule = &resolved.rules.enable_zen_shared;
    // R012 only applies to the canonical enable_zen_shared INI file.
    if !path_matches_target_ini(&file.path, &rule.ini_file) {
        return vec![];
    }
    let section = find_section(file, &rule.section);
    let key_present = section.and_then(|s| find_key(s, &rule.key)).is_some();
    if key_present {
        return vec![];
    }

    vec![Finding {
        rule_id: "R012".into(),
        severity: Severity::Warning,
        category: file.category,
        file_path: file.path.clone(),
        section: Some(rule.section.clone()),
        key_name: Some(rule.key.clone()),
        line_number: None,
        snippet_before: "（未设置）".into(),
        // Show the raw template in the suggested snippet (placeholders are
        // informative for an operator reading the report) but DO NOT set
        // `recommended_value` — `ini_apply::apply` would write the raw
        // template into the INI verbatim. Wiring ZenShared requires
        // materialized host/port/namespace which only `voloctl cache zen enable`
        // has; mark this finding `Manual` so auto-apply skips it.
        snippet_after: Some(format!(
            "[{}]\n{}={}",
            rule.section, rule.key, rule.value_template
        )),
        recommended_action: RecommendedAction::Manual,
        recommended_value: None,
        symptom: format!(
            "工程是 UE {}+ 且已登记集群 zen 端点，但没接上 `{}` 上游。",
            resolved.matched_version, rule.key
        ),
        rationale: "没有 [StorageServers] Shared 上游时，工程只能用本地 zen，集群间不共享任何缓存。运行 `voloctl cache zen enable` 从集群主端点生成该值。".into(),
    }]
}

fn rule_r013(file: &ParsedFile, ctx: &ZenRuleContext<'_>) -> Vec<Finding> {
    if file.category != Category::Project {
        return vec![];
    }
    let Some(resolved) = ctx.resolved else { return vec![] };
    let rule = &resolved.rules.enable_zen_shared;
    if !path_matches_target_ini(&file.path, &rule.ini_file) {
        return vec![];
    }
    let Some(section) = find_section(file, &rule.section) else { return vec![] };
    let Some(k) = find_key(section, &rule.key) else { return vec![] };
    if is_well_formed_zen_shared(&k.value) {
        return vec![];
    }
    vec![Finding {
        rule_id: "R013".into(),
        severity: Severity::Critical,
        category: file.category,
        file_path: file.path.clone(),
        section: Some(section.name.clone()),
        key_name: Some(k.name.clone()),
        line_number: Some(k.line_number as i64),
        snippet_before: format!("{}={}", k.name, k.value),
        snippet_after: Some(format!("{}={}", rule.key, rule.value_template)),
        // Same auto-apply hazard as R012: the template still has
        // `{host}` / `{port}` / `{namespace}` placeholders. Mark Manual so
        // `ini_apply::apply` skips it; the operator must re-run
        // `voloctl cache zen enable` to wire a materialized value.
        recommended_action: RecommendedAction::Manual,
        recommended_value: None,
        symptom: format!(
            "`{}` 的值不符合 [StorageServers] 的格式（Host=\"http://host:port\", Namespace=...）。裸主机名或单独的 `Port=` 都是错的 —— 端口必须写进 Host URI 里。",
            rule.key
        ),
        rationale: "值解析不了时 Zen 会拒绝接入后端（URI 缺端口时还会连错端口），工程会悄悄回退到只用本地 DDC。重跑 `voloctl cache zen enable` 用生成的值覆盖。".into(),
    }]
}

fn rule_r014(file: &ParsedFile, ctx: &ZenRuleContext<'_>) -> Vec<Finding> {
    if file.category != Category::Project {
        return vec![];
    }
    let Some(resolved) = ctx.resolved else { return vec![] };
    let rule = &resolved.rules.enable_zen_shared;
    if !path_matches_target_ini(&file.path, &rule.ini_file) {
        return vec![];
    }
    if ctx.endpoint_reachability.is_empty() {
        return vec![];
    }
    let Some(section) = find_section(file, &rule.section) else { return vec![] };
    let Some(k) = find_key(section, &rule.key) else { return vec![] };
    let Some(host_field) = extract_field(&k.value, "Host") else { return vec![] };

    // The StorageServers Host is a full URI (`http://host:port`); recover the
    // bare host + embedded port to compare against the registered endpoint
    // (stored unscheme'd). There is no separate `Port=` token in the modern
    // form. Host match is case-insensitive; resolving DNS / IP equivalence is
    // out of scope (operators register endpoints by the name they intend to
    // use in the Host URI).
    let (host_in_value, value_port) = match parse_storage_host_uri(&host_field) {
        Some((h, p)) => (h, p),
        None => (host_field.clone(), None),
    };
    let value_namespace = extract_field(&k.value, "Namespace");

    // Look for an endpoint that matches host AND (if both sides have it) port
    // + namespace. Without the full tuple a malformed `Port=9999` would slip
    // past R013 and be silently suppressed here just because the host matches.
    let matching = ctx.endpoint_reachability.iter().find(|er| {
        if !er.host.eq_ignore_ascii_case(host_in_value.trim()) {
            return false;
        }
        // Port comparison only enforced when both sides know the port.
        if let (Some(vp), Some(ep)) = (value_port, er.port) {
            if vp != ep {
                return false;
            }
        }
        // Same for namespace.
        if let (Some(vn), Some(en)) = (value_namespace.as_deref(), er.namespace.as_deref()) {
            if !vn.eq_ignore_ascii_case(en) {
                return false;
            }
        }
        true
    });
    let (status, detail) = match matching {
        Some(er) if er.recent_reachable => return vec![],
        Some(_) => ("不可达", "最近没有成功的可达探测".to_string()),
        None => (
            "无匹配端点",
            format!(
                "没有已登记的端点匹配主机 '{}'（端口 / 命名空间在存在时也会一并比对）",
                host_in_value
            ),
        ),
    };

    vec![Finding {
        rule_id: "R014".into(),
        severity: Severity::Warning,
        category: file.category,
        file_path: file.path.clone(),
        section: Some(section.name.clone()),
        key_name: Some(k.name.clone()),
        line_number: Some(k.line_number as i64),
        snippet_before: format!("{}={}", k.name, k.value),
        snippet_after: None,
        recommended_action: RecommendedAction::Manual,
        recommended_value: None,
        symptom: format!(
            "`{}` 上游 '{}' {}。",
            rule.key, host_in_value, status
        ),
        rationale: format!(
            "{}；UE 将无法从集群主节点拉取缓存。",
            detail
        ),
    }]
}

fn rule_r015(
    file: &ParsedFile,
    env_state: &EnvVarState,
    ctx: &ZenRuleContext<'_>,
) -> Vec<Finding> {
    if file.category != Category::Project {
        return vec![];
    }
    let Some(resolved) = ctx.resolved else { return vec![] };
    let smb = &resolved.rules.disable_legacy_smb_shared;
    if !path_matches_target_ini(&file.path, &smb.ini_file) {
        return vec![];
    }
    let zen_enable = &resolved.rules.enable_zen_shared;

    // Codex P2 (round 14): R015 / R017 cleanup rules must NOT recommend
    // `Remove` for the legacy `Shared=` / `Pak=` / `CompressedPak=` keys
    // until `ZenShared` is actually wired in the same file. Without this
    // gate, a freshly-registered endpoint with `zen enable` not yet run
    // would see both R012 (missing ZenShared, Manual) AND R015/R017
    // (remove legacy, auto-applyable) — auto-apply would tear out the
    // only working DDC path before the zen replacement materializes.
    let zen_shared_configured = find_section(file, &zen_enable.section)
        .and_then(|s| find_key(s, &zen_enable.key))
        .is_some();

    let mut out = Vec::new();

    // Arm 1: legacy `Shared=` key sits in the same backend section as
    // ZenShared. This is the historical R015 — operator-visible in the INI.
    if let Some(section) = find_section(file, &smb.section) {
        if let Some(k) = find_key(section, &smb.key) {
            // Only recommend Remove once ZenShared is wired. Before that,
            // mark it Manual so the operator sees the legacy key but
            // auto-apply can't strip it prematurely.
            let (action, snippet_after_extra) = if zen_shared_configured {
                (
                    RecommendedAction::Remove,
                    format!("(remove `{}` from [{}])", smb.key, smb.section),
                )
            } else {
                (
                    RecommendedAction::Manual,
                    format!(
                        "(legacy `{}` will be removed once `zen enable` writes ZenShared into [{}])",
                        smb.key, smb.section
                    ),
                )
            };
            out.push(Finding {
                rule_id: "R015".into(),
                severity: Severity::Warning,
                category: file.category,
                file_path: file.path.clone(),
                section: Some(section.name.clone()),
                key_name: Some(k.name.clone()),
                line_number: Some(k.line_number as i64),
                snippet_before: format!("{}={}", k.name, k.value),
                snippet_after: Some(snippet_after_extra),
                recommended_action: action,
                recommended_value: None,
                symptom: if zen_shared_configured {
                    format!(
                        "旧式 SMB 的 `{}` 键和 ZenShared 同时存在。",
                        smb.key
                    )
                } else {
                    format!(
                        "存在旧式 SMB 的 `{}` 键；ZenShared 还没接上 —— 先运行 `zen enable`，再重新扫描以移除它。",
                        smb.key
                    )
                },
                rationale: "Volo 在启用 Zen 共享后会清理并存的旧式 SMB 路径，避免集群内两套上游配置混用、命中不一致（UE 过渡期内可共存；这是 Volo 的配置管理策略，非引擎禁止双后端）。".into(),
            });
        }
    }

    // Arm 2: env-var route. UE-SharedDataCachePath is the env-var equivalent
    // of the legacy `Shared=` key — it activates the SMB upstream invisibly
    // from the INI's perspective. Only fire when ZenShared is ALSO configured
    // (i.e. the cluster has switched to zen but the env var is lingering).
    // If env var is set but ZenShared is absent, the project is purely on the
    // legacy SMB path and `core::ini_diagnostics::rule_r007` already covers
    // it as a healthy / configured signal — R015 should stay quiet there.
    let env_var_name = smb
        .env_cleanup
        .iter()
        .find(|c| c.var.eq_ignore_ascii_case("UE-SharedDataCachePath"))
        .map(|c| c.var.clone());
    if let Some(var_name) = env_var_name {
        let env_active = env_state.shared_data_cache_path.is_some();
        let zen_shared_configured = find_section(file, &zen_enable.section)
            .and_then(|s| find_key(s, &zen_enable.key))
            .is_some();
        if env_active && zen_shared_configured {
            let env_value = env_state
                .shared_data_cache_path
                .clone()
                .unwrap_or_default();
            out.push(Finding {
                rule_id: "R015".into(),
                severity: Severity::Warning,
                category: file.category,
                file_path: file.path.clone(),
                section: Some(zen_enable.section.clone()),
                // No INI key for the env-var arm — synthesize a stable marker
                // so downstream UI / dedupe logic doesn't collide with arm 1.
                key_name: Some(format!("<env:{}>", var_name)),
                line_number: None,
                snippet_before: format!("{}={}", var_name, env_value),
                snippet_after: Some(format!(
                    "（在这台机器上清除 `{}` 环境变量 —— 机器级和用户级都要清）",
                    var_name
                )),
                // Env-var cleanup is not an INI edit — `ini_apply::apply`
                // can't fix it. Mark Manual so auto-apply skips it; the
                // operator routes through the env-var management surface.
                recommended_action: RecommendedAction::Manual,
                recommended_value: None,
                symptom: format!(
                    "已配置 ZenShared 上游，但旧式 `{}` 环境变量还设着（{}）。",
                    var_name, env_value
                ),
                rationale: "Volo 建议只保留 Zen 共享上游：旧式环境变量会让 UE 同时写 Zen 与 SMB 两路缓存，集群命中不一致。清除该环境变量（机器级 + 用户级），只保留 [StorageServers] Shared（UE 过渡期内可共存；此为 Volo 运维建议）。".into(),
            });
        }
    }

    out
}

fn rule_r016(file: &ParsedFile, ctx: &ZenRuleContext<'_>) -> Vec<Finding> {
    let Some(check) = &ctx.install_binary else { return vec![] };
    if check.actual_sha256.eq_ignore_ascii_case(&check.expected_sha256) {
        return vec![];
    }
    // Build a synthetic per-machine finding — zenserver.exe is an install
    // artifact, not an INI key, but operators want it surfaced alongside
    // other zen findings. The Finding path / section fields are populated
    // with stable, non-empty markers so downstream renderers don't choke.
    //
    // Codex round-20 P2: use the synthetic per-machine marker from
    // `evaluate_machine_zen` (e.g. `<machine:5>`) instead of the
    // hard-coded `<machine:zenserver.exe>` string. Multi-machine scans
    // now produce per-machine findings that the UI can group / dedupe
    // by `file_path`, matching the R018 promise above and the
    // `evaluate_machine_zen` doc.
    vec![Finding {
        rule_id: "R016".into(),
        severity: Severity::Warning,
        category: Category::Engine,
        file_path: file.path.clone(),
        section: None,
        key_name: Some("zenserver.exe".into()),
        line_number: None,
        snippet_before: format!("actual sha256={}", check.actual_sha256),
        snippet_after: Some(format!(
            "期望 sha256={}（{} 的基线）",
            check.expected_sha256, check.build_version
        )),
        recommended_action: RecommendedAction::Manual,
        recommended_value: None,
        symptom: format!(
            "zenserver.exe 安装路径的 sha256 与 build {} 的基线不一致。",
            check.build_version
        ),
        rationale: "不一致可能意味着升级只完成了一半、文件被手动重拷过、或被篡改。从标准安装源重新同步，再跑 `zen detect-binary`。".into(),
    }]
}

fn rule_r017(file: &ParsedFile, ctx: &ZenRuleContext<'_>) -> Vec<Finding> {
    if file.category != Category::Project {
        return vec![];
    }
    let Some(resolved) = ctx.resolved else { return vec![] };
    let pak = &resolved.rules.disable_legacy_pak;
    if !path_matches_target_ini(&file.path, &pak.ini_file) {
        return vec![];
    }
    let Some(section) = find_section(file, &pak.section) else { return vec![] };

    // Codex P2 (round 14): same gate as R015 — only recommend Remove
    // once ZenShared is configured. Pre-zen-enable, pak/CompressedPak
    // are the project's only working DDC path; stripping them before
    // the zen replacement exists kills cache entirely.
    let zen_enable = &resolved.rules.enable_zen_shared;
    let zen_shared_configured = find_section(file, &zen_enable.section)
        .and_then(|s| find_key(s, &zen_enable.key))
        .is_some();

    let mut out = Vec::new();
    for key_name in &pak.keys {
        if let Some(k) = find_key(section, key_name) {
            let (action, snippet_after_extra, symptom) = if zen_shared_configured {
                (
                    RecommendedAction::Remove,
                    format!("（从 [{}] 移除 `{}`）", section.name, k.name),
                    format!(
                        "旧式 Pak DDC 键 `{}` 和 ZenShared 同时存在。",
                        k.name
                    ),
                )
            } else {
                (
                    RecommendedAction::Manual,
                    format!(
                        "（`zen enable` 把 ZenShared 写进 [{}] 后，旧式 `{}` 会被移除）",
                        section.name, k.name
                    ),
                    format!(
                        "存在旧式 Pak DDC 键 `{}`；ZenShared 还没接上 —— 先运行 `zen enable`，再重新扫描以移除它。",
                        k.name
                    ),
                )
            };
            out.push(Finding {
                rule_id: "R017".into(),
                severity: Severity::Warning,
                category: file.category,
                file_path: file.path.clone(),
                section: Some(section.name.clone()),
                key_name: Some(k.name.clone()),
                line_number: Some(k.line_number as i64),
                snippet_before: format!("{}={}", k.name, k.value),
                snippet_after: Some(snippet_after_extra),
                recommended_action: action,
                recommended_value: None,
                symptom,
                rationale: "即使接上了 ZenShared，UE 仍会继续加载 .ddp pak 文件，掩盖集群缓存未命中。".into(),
            });
        }
    }
    out
}

fn rule_r018(file: &ParsedFile, ctx: &ZenRuleContext<'_>) -> Vec<Finding> {
    // Need at least 3 reports to compute majority.
    if ctx.cluster_versions.len() < 3 {
        return vec![];
    }
    let Some(current_id) = ctx.current_machine_id else { return vec![] };
    let current = ctx
        .cluster_versions
        .iter()
        .find(|m| m.machine_id == current_id);
    let Some(current) = current else { return vec![] };

    // Compute version distribution.
    let mut counts: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for v in &ctx.cluster_versions {
        *counts.entry(v.zenserver_build_version.as_str()).or_insert(0) += 1;
    }
    let mut ranked: Vec<(&&str, &usize)> = counts.iter().collect();
    ranked.sort_by(|a, b| b.1.cmp(a.1));
    if ranked.len() < 2 {
        // All machines agree → no finding.
        return vec![];
    }
    let top = ranked[0];
    // Strict majority: top count must be > half the cluster. A plurality
    // (e.g. 2 of {2,1,1}) isn't enough — that's still mixed versions and
    // we have no clear "right" answer to call other machines outliers
    // against.
    let strict_majority = *top.1 * 2 > ctx.cluster_versions.len();

    if !strict_majority {
        // Split (e.g. 2-2). Health contract is "everyone on the same build";
        // a tie still means mixed zen versions across the cluster. Warn
        // every machine in the split so the operator sees it on the run
        // they are looking at.
        return vec![Finding {
            rule_id: "R018".into(),
            severity: Severity::Warning,
            category: Category::Engine,
            file_path: file.path.clone(),
            section: None,
            key_name: Some("zenserver_build_version".into()),
            line_number: None,
            snippet_before: format!("本机：{}", current.zenserver_build_version),
            snippet_after: Some(format!(
                "集群分裂：{} 个版本分布在 {} 台机器上（没有绝对多数）",
                ranked.len(),
                ctx.cluster_versions.len()
            )),
            recommended_action: RecommendedAction::Manual,
            recommended_value: None,
            symptom: "集群里有多个 zen 版本，且没有明显的多数版本。".into(),
            rationale: "集群内 zen 版本混杂可能造成细微的协议格式不兼容；选定一个 build，让每台机器对齐。".into(),
        }];
    }

    let majority: &str = *top.0;
    if current.zenserver_build_version.as_str() == majority {
        return vec![];
    }
    vec![Finding {
        rule_id: "R018".into(),
        severity: Severity::Warning,
        category: Category::Engine,
        file_path: file.path.clone(),
        section: None,
        key_name: Some("zenserver_build_version".into()),
        line_number: None,
        snippet_before: format!("本机：{}", current.zenserver_build_version),
        snippet_after: Some(format!(
            "集群多数：{}（{} / {} 台机器）",
            majority,
            top.1,
            ctx.cluster_versions.len()
        )),
        recommended_action: RecommendedAction::Manual,
        recommended_value: None,
        symptom: format!(
            "zenserver_build_version `{}` 与集群多数版本 `{}` 不一致。",
            current.zenserver_build_version, majority
        ),
        rationale: "集群内 zen 版本混杂可能造成细微的协议格式不兼容；在依赖共享 DDC 之前先对齐 build。".into(),
    }]
}

/// Does `file_path` end with the rule's `ini_file` (e.g. `DefaultEngine.ini`)?
/// The YAML stores the bare filename; the scanner reads from absolute Windows
/// paths like `C:\Project\Config\DefaultEngine.ini`. Case-insensitive match
/// against the trailing path segment.
fn path_matches_target_ini(file_path: &str, target: &str) -> bool {
    let target_lower = target.to_ascii_lowercase();
    let path_lower = file_path.to_ascii_lowercase();
    // Match either the exact path or the trailing segment.
    if path_lower == target_lower {
        return true;
    }
    // Tolerate both `\\` and `/` separators.
    path_lower.ends_with(&format!("\\{}", target_lower))
        || path_lower.ends_with(&format!("/{}", target_lower))
}

/// R026 — warns when both `UserEngine.ini` (global) and at least one project's
/// `DefaultEngine.ini` contain a `ZenShared` key on the same machine.
///
/// UE Config merge order (later files override earlier): project
/// `DefaultEngine.ini` loads before user-scoped `UserEngine.ini` (Engine
/// category positions ~5 vs ~10–12), so **UserEngine wins** on conflicting keys.
/// Having ZenShared in both files is redundant; edits to DefaultEngine may
/// appear to have no effect while UserEngine still holds the upstream.
pub fn evaluate_r026(
    host: &str,
    user_engine_ini_path: &str,
    config_snapshots: &[crate::core::ini_config_extract::ConfigEntry],
    _machine_id: i64,
) -> Vec<Finding> {
    // A "zen shared upstream" entry is either the modern `[StorageServers]`
    // `Shared` override (what `zen enable` writes now) or the legacy
    // `[InstalledDerivedDataBackendGraph]` `ZenShared` node (pre-migration
    // projects). Recognize BOTH so the redundancy check keeps working across
    // the format switch.
    let is_zen_shared = |section: &str, key: &str| -> bool {
        (section.eq_ignore_ascii_case("StorageServers") && key.eq_ignore_ascii_case("Shared"))
            || (section.eq_ignore_ascii_case("InstalledDerivedDataBackendGraph")
                && key.eq_ignore_ascii_case("ZenShared"))
    };

    // R026 only fires when a project DefaultEngine.ini also has a zen upstream.
    let project_has_zen_shared = config_snapshots
        .iter()
        .any(|e| e.domain == "zen" && is_zen_shared(&e.section, &e.key_name));
    if !project_has_zen_shared {
        return vec![];
    }

    // Read UserEngine.ini for a zen upstream in either section form.
    let global_section = ["StorageServers", "InstalledDerivedDataBackendGraph"]
        .into_iter()
        .find(|section| {
            crate::core::ini_editor::read_section(host, user_engine_ini_path, section)
                .map(|keys| keys.iter().any(|k| is_zen_shared(section, &k.name)))
                .unwrap_or(false)
        });
    let Some(global_section) = global_section else {
        return vec![]; // file absent/unreadable or no global zen upstream — not an error
    };
    let global_key = if global_section.eq_ignore_ascii_case("StorageServers") {
        "Shared"
    } else {
        "ZenShared"
    };

    vec![Finding {
        rule_id: "R026".to_string(),
        severity: Severity::Warning,
        category: crate::core::ini_diagnostics::Category::User,
        file_path: user_engine_ini_path.to_string(),
        section: Some(global_section.to_string()),
        key_name: Some(global_key.to_string()),
        line_number: None,
        snippet_before: String::new(),
        snippet_after: None,
        recommended_action: RecommendedAction::Manual,
        recommended_value: None,
        symptom: "全局 UserEngine.ini 与工程 DefaultEngine.ini 中同时存在 ZenShared \
                  —— UserEngine 后加载、优先级更高，工程级条目对同名键实际不生效"
            .to_string(),
        rationale: "UE 按 Config 加载顺序合并 INI：工程 DefaultEngine.ini（约第 5 位）先于 \
                    用户 UserEngine.ini（约第 10–12 位）加载，后加载的覆盖先加载的。\
                    两处都写容易造成「改了工程 DefaultEngine 却不生效」的误解；保留一处即可。"
            .to_string(),
    }]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::ini_diagnostics::{ParsedKey, ParsedSection};
    use crate::core::zen::rules_loader::{
        DisablePakRule, DisableRule, EnableZenSharedRule, EnvCleanup, ResolvedRules, RuleSet,
    };

    fn make_rules() -> ResolvedRules {
        ResolvedRules {
            rules: RuleSet {
                enable_zen_shared: EnableZenSharedRule {
                    ini_file: "DefaultEngine.ini".into(),
                    section: "StorageServers".into(),
                    key: "Shared".into(),
                    value_template:
                        "(Host=\"http://{host}:{port}\", Namespace=\"{namespace}\", EnvHostOverride=UE-ZenSharedDataCacheHost, CommandLineHostOverride=ZenSharedDataCacheHost, DeactivateAt=60)"
                            .into(),
                    backup: true,
                },
                disable_legacy_smb_shared: DisableRule {
                    ini_file: "DefaultEngine.ini".into(),
                    section: "InstalledDerivedDataBackendGraph".into(),
                    key: "Shared".into(),
                    action: "remove".into(),
                    backup: true,
                    // Mirror the real YAML's env_cleanup list so R015's
                    // env-var arm can find the variable name to inspect.
                    env_cleanup: vec![EnvCleanup {
                        var: "UE-SharedDataCachePath".into(),
                        scopes: vec!["machine".into(), "user".into()],
                    }],
                },
                disable_legacy_pak: DisablePakRule {
                    ini_file: "DefaultEngine.ini".into(),
                    section: "InstalledDerivedDataBackendGraph".into(),
                    keys: vec!["Pak".into(), "CompressedPak".into()],
                    action: "remove".into(),
                    backup: true,
                },
            },
            warnings: Vec::new(),
            matched_version: "5.7".into(),
        }
    }

    fn project_ini(section_keys: &[(&str, &[(&str, &str)])]) -> ParsedFile {
        ParsedFile {
            path: "C:\\Project\\Config\\DefaultEngine.ini".into(),
            category: Category::Project,
            sections: section_keys
                .iter()
                .map(|(s_name, keys)| ParsedSection {
                    name: s_name.to_string(),
                    keys: keys
                        .iter()
                        .enumerate()
                        .map(|(i, (k, v))| ParsedKey {
                            name: k.to_string(),
                            value: v.to_string(),
                            line_number: i + 1,
                        })
                        .collect(),
                    backend_nodes: Vec::new(),
                })
                .collect(),
        }
    }

    fn ctx_with(resolved: &ResolvedRules) -> ZenRuleContext<'_> {
        ZenRuleContext {
            resolved: Some(resolved),
            endpoint_registered: true,
            endpoint_reachability: Vec::new(),
            install_binary: None,
            cluster_versions: Vec::new(),
            current_machine_id: None,
        }
    }

    // ----- R012 ------------------------------------------------------------

    #[test]
    fn r012_fires_when_zen_shared_missing_and_endpoint_registered() {
        let rules = make_rules();
        let file = project_ini(&[("InstalledDerivedDataBackendGraph", &[])]);
        let ctx = ctx_with(&rules);
        let findings = run_zen_rules_for_file(&file, &EnvVarState::default(), &ctx);
        assert!(
            findings.iter().any(|f| f.rule_id == "R012" && f.severity == Severity::Warning),
            "expected R012 warning, got: {:?}",
            findings.iter().map(|f| &f.rule_id).collect::<Vec<_>>()
        );
    }

    #[test]
    fn r012_silent_when_zen_shared_present() {
        let rules = make_rules();
        let file = project_ini(&[(
            "StorageServers",
            &[(
                "Shared",
                "(Host=\"http://render-master:8558\", Namespace=\"ue.ddc\", EnvHostOverride=UE-ZenSharedDataCacheHost, CommandLineHostOverride=ZenSharedDataCacheHost, DeactivateAt=60)",
            )],
        )]);
        let ctx = ctx_with(&rules);
        let findings = run_zen_rules_for_file(&file, &EnvVarState::default(), &ctx);
        assert!(!findings.iter().any(|f| f.rule_id == "R012"));
    }

    #[test]
    fn r012_silent_when_no_endpoint_registered() {
        let rules = make_rules();
        let file = project_ini(&[("InstalledDerivedDataBackendGraph", &[])]);
        let mut ctx = ctx_with(&rules);
        ctx.endpoint_registered = false;
        let findings = run_zen_rules_for_file(&file, &EnvVarState::default(), &ctx);
        assert!(!findings.iter().any(|f| f.rule_id == "R012"));
    }

    #[test]
    fn r012_silent_on_non_default_engine_ini() {
        let rules = make_rules();
        let mut file = project_ini(&[("InstalledDerivedDataBackendGraph", &[])]);
        file.path = "C:\\Project\\Config\\ConsoleVariables.ini".into();
        let ctx = ctx_with(&rules);
        let findings = run_zen_rules_for_file(&file, &EnvVarState::default(), &ctx);
        assert!(!findings.iter().any(|f| f.rule_id == "R012"));
    }

    // ----- R013 ------------------------------------------------------------

    #[test]
    fn r013_fires_when_zen_shared_value_malformed() {
        let rules = make_rules();
        let file = project_ini(&[(
            "StorageServers",
            &[("Shared", "Type=Bogus,Host=foo")],
        )]);
        let ctx = ctx_with(&rules);
        let findings = run_zen_rules_for_file(&file, &EnvVarState::default(), &ctx);
        assert!(
            findings.iter().any(|f| f.rule_id == "R013" && f.severity == Severity::Critical),
            "expected R013 critical, got: {:?}",
            findings.iter().map(|f| (&f.rule_id, &f.severity)).collect::<Vec<_>>()
        );
    }

    #[test]
    fn r013_fires_when_host_uri_missing_port() {
        // The whole point of the StorageServers fix: the port must be embedded
        // in the Host URI. A scheme'd host with no port (`http://render-master`)
        // would connect to the wrong port (80, not 8558) — flag it malformed.
        let rules = make_rules();
        let file = project_ini(&[(
            "StorageServers",
            &[(
                "Shared",
                "(Host=\"http://render-master\", Namespace=\"ue.ddc\")",
            )],
        )]);
        let ctx = ctx_with(&rules);
        let findings = run_zen_rules_for_file(&file, &EnvVarState::default(), &ctx);
        assert!(findings.iter().any(|f| f.rule_id == "R013"));
    }

    #[test]
    fn r013_fires_when_host_missing_scheme() {
        // A bare host (the broken legacy shape) has no scheme — malformed.
        let rules = make_rules();
        let file = project_ini(&[(
            "StorageServers",
            &[(
                "Shared",
                "(Host=\"render-master:8558\", Namespace=\"ue.ddc\")",
            )],
        )]);
        let ctx = ctx_with(&rules);
        let findings = run_zen_rules_for_file(&file, &EnvVarState::default(), &ctx);
        assert!(findings.iter().any(|f| f.rule_id == "R013"));
    }

    #[test]
    fn r013_silent_on_well_formed_value() {
        let rules = make_rules();
        let file = project_ini(&[(
            "StorageServers",
            &[(
                "Shared",
                "(Host=\"http://render-master:8558\", Namespace=\"ue.ddc\", EnvHostOverride=UE-ZenSharedDataCacheHost, CommandLineHostOverride=ZenSharedDataCacheHost, DeactivateAt=60)",
            )],
        )]);
        let ctx = ctx_with(&rules);
        let findings = run_zen_rules_for_file(&file, &EnvVarState::default(), &ctx);
        assert!(!findings.iter().any(|f| f.rule_id == "R013"));
    }

    // ----- R014 ------------------------------------------------------------

    #[test]
    fn r014_fires_when_host_not_reachable_per_probes() {
        let rules = make_rules();
        let file = project_ini(&[(
            "StorageServers",
            &[(
                "Shared",
                "(Host=\"http://render-master:8558\", Namespace=\"ue.ddc\", EnvHostOverride=UE-ZenSharedDataCacheHost, CommandLineHostOverride=ZenSharedDataCacheHost, DeactivateAt=60)",
            )],
        )]);
        let mut ctx = ctx_with(&rules);
        ctx.endpoint_reachability.push(EndpointReachability {
            host: "render-master".into(),
            port: Some(8558),
            namespace: Some("ue.ddc".into()),
            recent_reachable: false,
        });
        let findings = run_zen_rules_for_file(&file, &EnvVarState::default(), &ctx);
        assert!(
            findings.iter().any(|f| f.rule_id == "R014" && f.severity == Severity::Warning),
            "expected R014 warning, got: {:?}",
            findings.iter().map(|f| &f.rule_id).collect::<Vec<_>>()
        );
    }

    #[test]
    fn r014_silent_when_host_reachable() {
        let rules = make_rules();
        let file = project_ini(&[(
            "StorageServers",
            &[(
                "Shared",
                "(Host=\"http://render-master:8558\", Namespace=\"ue.ddc\", EnvHostOverride=UE-ZenSharedDataCacheHost, CommandLineHostOverride=ZenSharedDataCacheHost, DeactivateAt=60)",
            )],
        )]);
        let mut ctx = ctx_with(&rules);
        ctx.endpoint_reachability.push(EndpointReachability {
            host: "render-master".into(),
            port: Some(8558),
            namespace: Some("ue.ddc".into()),
            recent_reachable: true,
        });
        let findings = run_zen_rules_for_file(&file, &EnvVarState::default(), &ctx);
        assert!(!findings.iter().any(|f| f.rule_id == "R014"));
    }

    #[test]
    fn r014_fires_when_port_mismatches_registered_endpoint() {
        // Codex P2: ZenShared with wrong Port should produce a finding even
        // though the host matches a registered + reachable endpoint.
        let rules = make_rules();
        let file = project_ini(&[(
            "StorageServers",
            &[(
                "Shared",
                "(Host=\"http://render-master:9999\", Namespace=\"ue.ddc\")",
            )],
        )]);
        let mut ctx = ctx_with(&rules);
        ctx.endpoint_reachability.push(EndpointReachability {
            host: "render-master".into(),
            port: Some(8558),
            namespace: Some("ue.ddc".into()),
            recent_reachable: true,
        });
        let findings = run_zen_rules_for_file(&file, &EnvVarState::default(), &ctx);
        assert!(
            findings.iter().any(|f| f.rule_id == "R014"),
            "port mismatch should fire R014, got: {:?}",
            findings.iter().map(|f| &f.rule_id).collect::<Vec<_>>()
        );
    }

    #[test]
    fn r014_fires_when_namespace_mismatches_registered_endpoint() {
        let rules = make_rules();
        let file = project_ini(&[(
            "StorageServers",
            &[(
                "Shared",
                "(Host=\"http://render-master:8558\", Namespace=\"wrong.ns\")",
            )],
        )]);
        let mut ctx = ctx_with(&rules);
        ctx.endpoint_reachability.push(EndpointReachability {
            host: "render-master".into(),
            port: Some(8558),
            namespace: Some("ue.ddc".into()),
            recent_reachable: true,
        });
        let findings = run_zen_rules_for_file(&file, &EnvVarState::default(), &ctx);
        assert!(findings.iter().any(|f| f.rule_id == "R014"));
    }

    // ----- R015 ------------------------------------------------------------

    #[test]
    fn r015_fires_when_legacy_shared_key_present() {
        let rules = make_rules();
        let file = project_ini(&[(
            "InstalledDerivedDataBackendGraph",
            &[("Shared", "(Type=FileSystem, Path=\"\\\\HOST\\Share\")")],
        )]);
        let ctx = ctx_with(&rules);
        let findings = run_zen_rules_for_file(&file, &EnvVarState::default(), &ctx);
        assert!(findings.iter().any(|f| f.rule_id == "R015" && f.severity == Severity::Warning));
    }

    #[test]
    fn r015_silent_when_legacy_shared_absent() {
        let rules = make_rules();
        let file = project_ini(&[("InstalledDerivedDataBackendGraph", &[])]);
        let ctx = ctx_with(&rules);
        let findings = run_zen_rules_for_file(&file, &EnvVarState::default(), &ctx);
        assert!(!findings.iter().any(|f| f.rule_id == "R015"));
    }

    #[test]
    fn r015_fires_for_env_var_when_zen_shared_also_configured() {
        // UE-SharedDataCachePath env var + ZenShared INI key → both backends
        // fight. The INI looks clean (only ZenShared) but the env var
        // silently keeps the legacy SMB path alive.
        let rules = make_rules();
        let file = project_ini(&[(
            "StorageServers",
            &[(
                "Shared",
                "(Host=\"http://render-master:8558\", Namespace=\"ue.ddc\", EnvHostOverride=UE-ZenSharedDataCacheHost, CommandLineHostOverride=ZenSharedDataCacheHost, DeactivateAt=60)",
            )],
        )]);
        let ctx = ctx_with(&rules);
        let env = EnvVarState {
            shared_data_cache_path: Some("\\\\NAS\\DDC".into()),
            local_data_cache_path: None,
        };
        let findings = run_zen_rules_for_file(&file, &env, &ctx);
        let r015s: Vec<_> = findings.iter().filter(|f| f.rule_id == "R015").collect();
        assert_eq!(
            r015s.len(),
            1,
            "expected exactly one R015 (env-var arm), got {:?}",
            r015s.iter().map(|f| &f.symptom).collect::<Vec<_>>()
        );
        let f = r015s[0];
        assert_eq!(f.severity, Severity::Warning);
        // The env-var arm uses a synthetic `<env:...>` key marker so it
        // doesn't collide with the INI-key arm's `Shared` key_name.
        assert!(
            f.key_name.as_deref().unwrap_or("").starts_with("<env:"),
            "env-var arm should mark key_name with `<env:` prefix, got {:?}",
            f.key_name
        );
        assert_eq!(f.recommended_action, RecommendedAction::Manual);
        assert!(
            f.symptom.contains("UE-SharedDataCachePath"),
            "symptom should name the env var, got: {}",
            f.symptom
        );
    }

    #[test]
    fn r015_silent_for_env_var_when_zen_shared_absent() {
        // Env var alone (no ZenShared) = legacy-only setup; R007 in the base
        // scanner reports the env-var presence as healthy. R015 should stay
        // quiet here so we don't double-flag the same posture.
        let rules = make_rules();
        let file = project_ini(&[("InstalledDerivedDataBackendGraph", &[])]);
        let ctx = ctx_with(&rules);
        let env = EnvVarState {
            shared_data_cache_path: Some("\\\\NAS\\DDC".into()),
            local_data_cache_path: None,
        };
        let findings = run_zen_rules_for_file(&file, &env, &ctx);
        assert!(
            !findings.iter().any(|f| f.rule_id == "R015"),
            "R015 must not fire when ZenShared is absent, got: {:?}",
            findings.iter().map(|f| &f.rule_id).collect::<Vec<_>>()
        );
    }

    #[test]
    fn r015_emits_two_findings_when_both_arms_apply() {
        // Worst case: legacy Shared= key still in INI AND UE-SharedDataCachePath
        // env var also set AND ZenShared also configured. Both arms fire so the
        // operator sees both surfaces in the report.
        let rules = make_rules();
        let file = project_ini(&[
            (
                "InstalledDerivedDataBackendGraph",
                &[("Shared", "(Type=FileSystem, Path=\"\\\\HOST\\Share\")")],
            ),
            (
                "StorageServers",
                &[(
                    "Shared",
                    "(Host=\"http://render-master:8558\", Namespace=\"ue.ddc\", EnvHostOverride=UE-ZenSharedDataCacheHost, CommandLineHostOverride=ZenSharedDataCacheHost, DeactivateAt=60)",
                )],
            ),
        ]);
        let ctx = ctx_with(&rules);
        let env = EnvVarState {
            shared_data_cache_path: Some("\\\\NAS\\DDC".into()),
            local_data_cache_path: None,
        };
        let findings = run_zen_rules_for_file(&file, &env, &ctx);
        let r015s: Vec<_> = findings.iter().filter(|f| f.rule_id == "R015").collect();
        assert_eq!(r015s.len(), 2, "both arms should fire");
    }

    // ----- R016 ------------------------------------------------------------

    #[test]
    fn r016_fires_when_install_sha_mismatches_baseline() {
        let rules = make_rules();
        let mut ctx = ctx_with(&rules);
        ctx.current_machine_id = Some(1);
        ctx.install_binary = Some(InstallBinaryCheck {
            actual_sha256: "aaaa".into(),
            expected_sha256: "bbbb".into(),
            build_version: "5.8.10".into(),
        });
        let findings = evaluate_machine_zen(&ctx);
        assert!(findings.iter().any(|f| f.rule_id == "R016" && f.severity == Severity::Warning));
    }

    #[test]
    fn r016_silent_when_install_sha_matches_baseline() {
        let rules = make_rules();
        let mut ctx = ctx_with(&rules);
        ctx.current_machine_id = Some(1);
        ctx.install_binary = Some(InstallBinaryCheck {
            actual_sha256: "aaaa".into(),
            expected_sha256: "AAAA".into(), // case-insensitive
            build_version: "5.8.10".into(),
        });
        let findings = evaluate_machine_zen(&ctx);
        assert!(!findings.iter().any(|f| f.rule_id == "R016"));
    }

    #[test]
    fn r016_emits_once_when_machine_entry_point_used() {
        // Codex P2: R016 doesn't depend on file content; running through
        // `run_zen_rules_for_file` (the per-file loop) used to inflate the
        // count. The machine entry point should produce exactly one row.
        let rules = make_rules();
        let mut ctx = ctx_with(&rules);
        ctx.current_machine_id = Some(1);
        ctx.install_binary = Some(InstallBinaryCheck {
            actual_sha256: "aaaa".into(),
            expected_sha256: "bbbb".into(),
            build_version: "5.8.10".into(),
        });
        // Call run_zen_rules_for_file across all 4 typical INI categories
        // and confirm none emit R016 — they used to.
        for path in [
            "C:\\Engine\\Config\\BaseEngine.ini",
            "C:\\User\\EditorPerProjectUserSettings.ini",
            "C:\\Project\\Config\\DefaultEngine.ini",
            "C:\\Project\\Config\\ConsoleVariables.ini",
        ] {
            let mut f = project_ini(&[]);
            f.path = path.into();
            f.category = if path.contains("Engine\\Config\\Base") {
                Category::Engine
            } else if path.contains("EditorPerProject") {
                Category::User
            } else {
                Category::Project
            };
            let findings = run_zen_rules_for_file(&f, &EnvVarState::default(), &ctx);
            assert!(
                !findings.iter().any(|f| f.rule_id == "R016"),
                "{} emitted R016 in per-file loop; should be machine-only",
                path
            );
        }
        // And exactly one R016 from the machine entry point.
        let findings = evaluate_machine_zen(&ctx);
        let r016s: Vec<_> = findings.iter().filter(|f| f.rule_id == "R016").collect();
        assert_eq!(r016s.len(), 1);
    }

    // Codex round-20 P2: R016 must carry the per-machine marker
    // (`<machine:{id}>`) on its `file_path`, not a hard-coded
    // `<machine:zenserver.exe>`. Without that, multi-machine scans
    // produce indistinguishable findings the UI can't group or dedupe.
    #[test]
    fn r016_finding_carries_per_machine_marker() {
        let rules = make_rules();
        let mut ctx = ctx_with(&rules);
        ctx.install_binary = Some(InstallBinaryCheck {
            actual_sha256: "aaaa".into(),
            expected_sha256: "bbbb".into(),
            build_version: "5.8.10".into(),
        });

        ctx.current_machine_id = Some(5);
        let findings_m5 = evaluate_machine_zen(&ctx);
        let r016_m5 = findings_m5.iter().find(|f| f.rule_id == "R016").unwrap();
        assert_eq!(r016_m5.file_path, "<machine:5>");

        ctx.current_machine_id = Some(7);
        let findings_m7 = evaluate_machine_zen(&ctx);
        let r016_m7 = findings_m7.iter().find(|f| f.rule_id == "R016").unwrap();
        assert_eq!(r016_m7.file_path, "<machine:7>");

        // Sanity: two machines produce DIFFERENT file_paths so a UI
        // grouping by (rule_id, file_path) sees two distinct rows.
        assert_ne!(r016_m5.file_path, r016_m7.file_path);
    }

    // ----- R017 ------------------------------------------------------------

    #[test]
    fn r017_fires_when_pak_key_present() {
        let rules = make_rules();
        let file = project_ini(&[(
            "InstalledDerivedDataBackendGraph",
            &[("Pak", "(Type=FileSystem, Path=\"DerivedDataCache/DDC.ddp\")")],
        )]);
        let ctx = ctx_with(&rules);
        let findings = run_zen_rules_for_file(&file, &EnvVarState::default(), &ctx);
        assert!(findings.iter().any(|f| f.rule_id == "R017"));
    }

    #[test]
    fn r017_fires_for_each_listed_legacy_pak_key() {
        let rules = make_rules();
        let file = project_ini(&[(
            "InstalledDerivedDataBackendGraph",
            &[("Pak", "x"), ("CompressedPak", "y")],
        )]);
        let ctx = ctx_with(&rules);
        let findings = run_zen_rules_for_file(&file, &EnvVarState::default(), &ctx);
        let r017s: Vec<_> = findings.iter().filter(|f| f.rule_id == "R017").collect();
        assert_eq!(r017s.len(), 2, "both pak keys should produce findings");
    }

    // Codex round-14 P2: cleanup rules must not recommend `Remove` until
    // `ZenShared` is wired. Pre-zen-enable, the legacy keys are the only
    // working DDC path — auto-applying Remove would tear them out before
    // the zen replacement materializes.
    #[test]
    fn r015_recommends_manual_when_zen_shared_absent() {
        let rules = make_rules();
        let file = project_ini(&[(
            "InstalledDerivedDataBackendGraph",
            &[("Shared", "(Type=FileSystem, Path=\"\\\\HOST\\Share\")")],
        )]);
        let ctx = ctx_with(&rules);
        let findings = run_zen_rules_for_file(&file, &EnvVarState::default(), &ctx);
        let f = findings
            .iter()
            .find(|f| f.rule_id == "R015")
            .expect("R015 should still fire");
        assert_eq!(
            f.recommended_action,
            RecommendedAction::Manual,
            "before ZenShared is wired, Remove would kill the legacy DDC path"
        );
    }

    #[test]
    fn r015_recommends_remove_when_zen_shared_configured() {
        let rules = make_rules();
        let file = project_ini(&[
            (
                "InstalledDerivedDataBackendGraph",
                &[("Shared", "(Type=FileSystem, Path=\"\\\\HOST\\Share\")")],
            ),
            (
                "StorageServers",
                &[(
                    "Shared",
                    "(Host=\"http://render-master:8558\", Namespace=\"ue.ddc\", EnvHostOverride=UE-ZenSharedDataCacheHost, CommandLineHostOverride=ZenSharedDataCacheHost, DeactivateAt=60)",
                )],
            ),
        ]);
        let ctx = ctx_with(&rules);
        let findings = run_zen_rules_for_file(&file, &EnvVarState::default(), &ctx);
        let f = findings
            .iter()
            .find(|f| f.rule_id == "R015" && f.key_name.as_deref() == Some("Shared"))
            .expect("R015 arm 1 should fire on legacy `Shared` key");
        assert_eq!(f.recommended_action, RecommendedAction::Remove);
    }

    #[test]
    fn r017_recommends_manual_when_zen_shared_absent() {
        let rules = make_rules();
        let file = project_ini(&[(
            "InstalledDerivedDataBackendGraph",
            &[("Pak", "(Type=FileSystem, Path=\"DerivedDataCache/DDC.ddp\")")],
        )]);
        let ctx = ctx_with(&rules);
        let findings = run_zen_rules_for_file(&file, &EnvVarState::default(), &ctx);
        let f = findings
            .iter()
            .find(|f| f.rule_id == "R017")
            .expect("R017 should still fire");
        assert_eq!(
            f.recommended_action,
            RecommendedAction::Manual,
            "before ZenShared is wired, the .ddp pak is the project's only DDC"
        );
    }

    #[test]
    fn r017_recommends_remove_when_zen_shared_configured() {
        let rules = make_rules();
        let file = project_ini(&[
            (
                "InstalledDerivedDataBackendGraph",
                &[("Pak", "(Type=FileSystem, Path=\"DerivedDataCache/DDC.ddp\")")],
            ),
            (
                "StorageServers",
                &[(
                    "Shared",
                    "(Host=\"http://render-master:8558\", Namespace=\"ue.ddc\", EnvHostOverride=UE-ZenSharedDataCacheHost, CommandLineHostOverride=ZenSharedDataCacheHost, DeactivateAt=60)",
                )],
            ),
        ]);
        let ctx = ctx_with(&rules);
        let findings = run_zen_rules_for_file(&file, &EnvVarState::default(), &ctx);
        let f = findings
            .iter()
            .find(|f| f.rule_id == "R017")
            .expect("R017 should fire");
        assert_eq!(f.recommended_action, RecommendedAction::Remove);
    }

    // ----- R018 ------------------------------------------------------------

    fn mv(machine_id: i64, version: &str) -> MachineZenVersion {
        MachineZenVersion {
            machine_id,
            zenserver_build_version: version.into(),
        }
    }

    #[test]
    fn r018_fires_for_outlier_in_three_machine_cluster() {
        let rules = make_rules();
        let mut ctx = ctx_with(&rules);
        ctx.cluster_versions = vec![mv(1, "5.8.10"), mv(2, "5.8.10"), mv(3, "5.8.9")];
        ctx.current_machine_id = Some(3);
        let file = synthetic_machine_marker("RENDER-03");
        let findings = evaluate_cluster_zen_consistency(&file, &ctx);
        assert!(findings.iter().any(|f| f.rule_id == "R018" && f.severity == Severity::Warning));
    }

    #[test]
    fn r018_silent_for_majority_member() {
        let rules = make_rules();
        let mut ctx = ctx_with(&rules);
        ctx.cluster_versions = vec![mv(1, "5.8.10"), mv(2, "5.8.10"), mv(3, "5.8.9")];
        ctx.current_machine_id = Some(1);
        let file = synthetic_machine_marker("RENDER-01");
        let findings = evaluate_cluster_zen_consistency(&file, &ctx);
        assert!(!findings.iter().any(|f| f.rule_id == "R018"));
    }

    #[test]
    fn r018_silent_with_fewer_than_three_machines() {
        let rules = make_rules();
        let mut ctx = ctx_with(&rules);
        ctx.cluster_versions = vec![mv(1, "5.8.10"), mv(2, "5.8.9")];
        ctx.current_machine_id = Some(2);
        let file = synthetic_machine_marker("RENDER-02");
        let findings = evaluate_cluster_zen_consistency(&file, &ctx);
        assert!(!findings.iter().any(|f| f.rule_id == "R018"));
    }

    #[test]
    fn r018_warns_every_machine_in_a_split_cluster() {
        // Codex P2: 4 machines, 2-2 split — mixed zen versions across the
        // cluster is still a problem; warn every machine in the split so
        // the operator sees it on whatever machine they're looking at.
        let rules = make_rules();
        let mut ctx = ctx_with(&rules);
        ctx.cluster_versions = vec![
            mv(1, "5.8.10"),
            mv(2, "5.8.10"),
            mv(3, "5.8.9"),
            mv(4, "5.8.9"),
        ];
        let file = synthetic_machine_marker("any");
        for current in [1, 2, 3, 4] {
            ctx.current_machine_id = Some(current);
            let findings = evaluate_cluster_zen_consistency(&file, &ctx);
            assert!(
                findings.iter().any(|f| f.rule_id == "R018" && f.severity == Severity::Warning),
                "machine {} should see a split warning",
                current
            );
        }
    }

    // ----- helper -----------------------------------------------------------

    #[test]
    fn extract_field_handles_quoted_and_unquoted() {
        let v = "(Type=Zen, Host=\"render-master\", Port=8558, Namespace=\"ue.ddc\")";
        assert_eq!(extract_field(v, "Host").as_deref(), Some("render-master"));
        assert_eq!(extract_field(v, "Port").as_deref(), Some("8558"));
        assert_eq!(extract_field(v, "Namespace").as_deref(), Some("ue.ddc"));
        assert_eq!(extract_field(v, "Type").as_deref(), Some("Zen"));
        assert_eq!(extract_field(v, "Missing"), None);
    }

    #[test]
    fn extract_field_does_not_match_substring_suffix() {
        // Codex P2: naive `find("host=")` would catch `ProxyHost=` too. The
        // field name must be an exact token, not a substring.
        let v = "(Type=Zen, ProxyHost=\"sneaky\", Namespace=\"ue.ddc\")";
        assert_eq!(extract_field(v, "Host"), None, "Host must NOT match ProxyHost");
    }

    #[test]
    fn r013_fires_when_host_field_missing_even_with_proxyhost() {
        // Same boundary concern, exercised through the rule. ProxyHost is
        // not a recognized Zen field; absence of `Host=` must make this
        // value malformed.
        let rules = make_rules();
        let file = project_ini(&[(
            "StorageServers",
            &[(
                "Shared",
                "(Type=Zen, ProxyHost=\"sneaky\", Port=8558, Namespace=\"ue.ddc\")",
            )],
        )]);
        let ctx = ctx_with(&rules);
        let findings = run_zen_rules_for_file(&file, &EnvVarState::default(), &ctx);
        assert!(
            findings.iter().any(|f| f.rule_id == "R013"),
            "expected R013 for missing Host=, got: {:?}",
            findings.iter().map(|f| &f.rule_id).collect::<Vec<_>>()
        );
    }

    // ----- R018 plurality boundary ----------------------------------------

    #[test]
    fn r018_warns_on_plurality_with_no_strict_majority() {
        // Codex P2: 4 machines `A,A,B,C` — A has 2/4 = 50%, NOT majority.
        // Previous logic (`top > second`) would have called A a majority and
        // greened the two A machines. Strict majority requires >50%.
        let rules = make_rules();
        let mut ctx = ctx_with(&rules);
        ctx.cluster_versions = vec![
            mv(1, "5.8.10"),
            mv(2, "5.8.10"),
            mv(3, "5.8.9"),
            mv(4, "5.8.8"),
        ];
        let file = synthetic_machine_marker("any");
        for current in [1, 2, 3, 4] {
            ctx.current_machine_id = Some(current);
            let findings = evaluate_cluster_zen_consistency(&file, &ctx);
            assert!(
                findings.iter().any(|f| f.rule_id == "R018"),
                "machine {} should see the plurality warning",
                current
            );
        }
    }

    #[test]
    fn r018_silent_for_majority_in_three_with_lone_outlier() {
        // 2 of 3 (66%) is a strict majority; outlier should still see R018,
        // majority members should not.
        let rules = make_rules();
        let mut ctx = ctx_with(&rules);
        ctx.cluster_versions = vec![mv(1, "5.8.10"), mv(2, "5.8.10"), mv(3, "5.8.9")];
        ctx.current_machine_id = Some(1);
        let file = synthetic_machine_marker("RENDER-01");
        let findings = evaluate_cluster_zen_consistency(&file, &ctx);
        assert!(!findings.iter().any(|f| f.rule_id == "R018"));
    }

    #[test]
    fn path_matches_target_ini_accepts_trailing_segment() {
        assert!(path_matches_target_ini(
            "C:\\Project\\Config\\DefaultEngine.ini",
            "DefaultEngine.ini"
        ));
        assert!(path_matches_target_ini(
            "/tmp/Project/Config/DefaultEngine.ini",
            "DefaultEngine.ini"
        ));
        assert!(!path_matches_target_ini(
            "C:\\Project\\Config\\ConsoleVariables.ini",
            "DefaultEngine.ini"
        ));
    }

    // ZEN-1: direct coverage for the StorageServers Host URI parser — the IPv6,
    // semicolon-list and path-stripping branches are otherwise only exercised
    // indirectly through R013/R014.
    #[test]
    fn parse_storage_host_uri_covers_scheme_port_ipv6_semicolon_and_path() {
        assert_eq!(parse_storage_host_uri("render-master"), Some(("render-master".into(), None)));
        assert_eq!(parse_storage_host_uri("http://h:8558"), Some(("h".into(), Some(8558))));
        assert_eq!(parse_storage_host_uri("10.0.0.5:9000"), Some(("10.0.0.5".into(), Some(9000))));
        // Trailing path/query dropped.
        assert_eq!(parse_storage_host_uri("http://h:8558/api/v1"), Some(("h".into(), Some(8558))));
        // Bracketed IPv6, with and without a port.
        assert_eq!(parse_storage_host_uri("http://[::1]:8558"), Some(("[::1]".into(), Some(8558))));
        assert_eq!(parse_storage_host_uri("[::1]"), Some(("[::1]".into(), None)));
        // Semicolon candidate list → first candidate (UE FHttpHostBuilder semantics).
        assert_eq!(
            parse_storage_host_uri("http://a:8558;http://b:8558"),
            Some(("a".into(), Some(8558)))
        );
        assert_eq!(parse_storage_host_uri(""), None);
    }

    // ZEN-1 read-side: R026 must fire for the NEW `[StorageServers] Shared` form
    // (the shape `zen enable` now writes) present in both UserEngine.ini and the
    // project snapshot — not just the legacy InstalledDerivedDataBackendGraph form.
    #[test]
    fn r026_fires_on_new_storage_servers_form() {
        use crate::core::ini_config_extract::ConfigEntry;
        let dir = tempfile::tempdir().unwrap();
        let user_ini = dir.path().join("UserEngine.ini");
        std::fs::write(
            &user_ini,
            "[StorageServers]\nShared=(Host=\"http://10.0.0.9:8558\", Namespace=\"ue.ddc\")\n",
        )
        .unwrap();
        let snapshots = vec![ConfigEntry {
            domain: "zen",
            file_path: "C:\\Proj\\Config\\DefaultEngine.ini".into(),
            section: "StorageServers".into(),
            key_name: "Shared".into(),
            value: "(Host=\"http://10.0.0.9:8558\", Namespace=\"ue.ddc\")".into(),
            line_number: 2,
        }];
        let findings = evaluate_r026("127.0.0.1", user_ini.to_str().unwrap(), &snapshots, 1);
        assert!(
            findings.iter().any(|f| f.rule_id == "R026"),
            "R026 must fire for the modern [StorageServers] Shared form, got: {:?}",
            findings.iter().map(|f| &f.rule_id).collect::<Vec<_>>()
        );
    }

    // R026 must NOT fire when only the project side has a zen upstream (no global).
    #[test]
    fn r026_silent_when_only_project_side_present() {
        use crate::core::ini_config_extract::ConfigEntry;
        let dir = tempfile::tempdir().unwrap();
        let user_ini = dir.path().join("UserEngine.ini"); // absent on disk
        let snapshots = vec![ConfigEntry {
            domain: "zen",
            file_path: "C:\\Proj\\Config\\DefaultEngine.ini".into(),
            section: "StorageServers".into(),
            key_name: "Shared".into(),
            value: "(Host=\"http://10.0.0.9:8558\")".into(),
            line_number: 2,
        }];
        let findings = evaluate_r026("127.0.0.1", user_ini.to_str().unwrap(), &snapshots, 1);
        assert!(!findings.iter().any(|f| f.rule_id == "R026"));
    }
}
