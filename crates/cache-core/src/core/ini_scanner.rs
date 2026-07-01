//! INI scanner orchestration: enumerate target files for one machine, read
//! them via `read-ini-file.ps1`, and run the pure rule engine over the result.

use crate::core::ini_diagnostics::{
    self, Category, EnvVarState, Finding, ParsedFile, ParsedKey, ParsedSection,
};
use crate::core::ini_diagnostics_zen::{
    evaluate_machine_zen, run_zen_rules_for_file, EndpointReachability, InstallBinaryCheck,
    MachineZenVersion, ZenRuleContext, ZenRuleContextOwned,
};
use crate::core::zen::rules_loader as zen_rules_loader;
use crate::core::loopback;
use crate::core::ssh::{run_json, NodeScript, SshExecutor};
use crate::data::{machine_zen_install, zen_binary_expected, zen_endpoints, Db};
use crate::error::{VoloError, VoloResult};
use rusqlite::params;
use serde::Deserialize;
use std::io::ErrorKind;

#[derive(Debug, Clone, PartialEq)]
pub struct TargetFile {
    pub path: String,
    pub category: Category,
}

pub fn enumerate_engine_paths(installs: &[(String, String)]) -> Vec<TargetFile> {
    installs.iter().map(|(_, root)| TargetFile {
        path: format!("{}\\Engine\\Config\\BaseEngine.ini", root.trim_end_matches('\\')),
        category: Category::Engine,
    }).collect()
}

pub fn enumerate_user_paths(installs: &[(String, String)], user_profile: &str) -> Vec<TargetFile> {
    installs.iter().map(|(version, _)| TargetFile {
        path: format!(
            "{}\\AppData\\Local\\UnrealEngine\\{}\\Saved\\Config\\WindowsEditor\\EditorPerProjectUserSettings.ini",
            user_profile.trim_end_matches('\\'),
            version
        ),
        category: Category::User,
    }).collect()
}

pub fn enumerate_project_paths(project_roots: &[String]) -> Vec<TargetFile> {
    let mut out = Vec::new();
    for root in project_roots {
        let r = root.trim_end_matches('\\');
        out.push(TargetFile { path: format!("{}\\Config\\DefaultEngine.ini", r), category: Category::Project });
        out.push(TargetFile { path: format!("{}\\Config\\ConsoleVariables.ini", r), category: Category::Project });
        out.push(TargetFile { path: format!("{}\\Config\\Windows\\WindowsEngine.ini", r), category: Category::Project });
    }
    out
}

#[derive(Debug, Deserialize)]
struct ReadFileResult {
    pub ok: bool,
    pub found: bool,
    #[serde(default)]
    pub sections: Vec<RawSection>,
    #[serde(default)]
    pub message: String,
}

#[derive(Debug, Deserialize)]
struct RawSection {
    pub name: String,
    #[serde(default)]
    pub keys: Vec<RawKey>,
}

#[derive(Debug, Deserialize)]
struct RawKey {
    pub name: String,
    pub value: String,
    pub line_number: usize,
}

pub fn read_file(
    host: &str,
    target: &TargetFile,
    cred: Option<(&str, &str)>,
) -> VoloResult<Option<ParsedFile>> {
    // SSH key auth: per-call WinRM cred no longer used (param kept until A5 cleanup).
    let _ = cred;
    if loopback::is_loopback_target(host) {
        return read_local_file(target);
    }

    let exec = SshExecutor::from_config()?;
    let result: ReadFileResult = run_json(
        &exec,
        host,
        &NodeScript {
            name: "read-ini-file.ps1",
            args: serde_json::json!({ "FilePath": target.path }),
            ssh_user: None,
        },
    )?;
    if !result.ok {
        return Err(VoloError::OperationFailed(format!(
            "read-ini-file failed: {}",
            result.message
        )));
    }
    if !result.found {
        return Ok(None);
    }
    Ok(Some(ParsedFile {
        path: target.path.clone(),
        category: target.category,
        sections: result.sections.into_iter().map(|s| ParsedSection {
            name: s.name,
            keys: s.keys.into_iter().map(|k| ParsedKey {
                name: k.name,
                value: k.value,
                line_number: k.line_number,
            }).collect(),
            backend_nodes: vec![],
        }).collect(),
    }))
}

fn read_local_file(target: &TargetFile) -> VoloResult<Option<ParsedFile>> {
    let raw = match std::fs::read_to_string(&target.path) {
        Ok(contents) => contents,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            return Err(VoloError::OperationFailed(format!(
                "read local INI failed: {}",
                e
            )));
        }
    };
    // UE editors save user INI files as UTF-8 with a BOM. read_to_string keeps
    // the BOM as U+FEFF, which makes the first line not start with '[' and the
    // parser drops the entire file. The remote PowerShell path strips the BOM
    // via `Get-Content -Encoding UTF8`, so do the same here for parity.
    let contents = raw.strip_prefix('\u{feff}').unwrap_or(&raw);
    Ok(Some(parse_ini_contents(target, contents)))
}

fn parse_ini_contents(target: &TargetFile, contents: &str) -> ParsedFile {
    let mut sections = Vec::new();
    let mut current: Option<ParsedSection> = None;

    for (idx, line) in contents.lines().enumerate() {
        let line_number = idx + 1;
        let trim = line.trim();
        if trim.starts_with('[') && trim.ends_with(']') && trim.len() > 2 {
            if let Some(section) = current.take() {
                sections.push(section);
            }
            current = Some(ParsedSection {
                name: trim[1..trim.len() - 1].to_string(),
                keys: Vec::new(),
                backend_nodes: Vec::new(),
            });
            continue;
        }

        let Some(section) = current.as_mut() else {
            continue;
        };
        if trim.is_empty()
            || trim.starts_with(';')
            || trim.starts_with('#')
            || trim.starts_with("//")
        {
            continue;
        }
        if let Some(eq) = trim.find('=') {
            if eq > 0 {
                section.keys.push(ParsedKey {
                    name: trim[..eq].trim().to_string(),
                    value: trim[eq + 1..].trim().to_string(),
                    line_number,
                });
            }
        }
    }

    if let Some(section) = current {
        sections.push(section);
    }

    let mut parsed = ParsedFile {
        path: target.path.clone(),
        category: target.category,
        sections,
    };

    // Tuple-node post-pass. A key whose value starts with `(` and ends with `)`
    // is re-parsed as a BackendNode. The key entry is preserved in `keys` so
    // existing rules keep working; backend_nodes is additive.
    for section in &mut parsed.sections {
        for k in &section.keys {
            if is_tuple_value(&k.value) {
                let synthetic = format!("{}={}", k.name, k.value);
                if let Ok(node) = crate::core::ini_backend_graph::parse_node(&synthetic, k.line_number as u32) {
                    section.backend_nodes.push(node);
                }
            }
        }
    }
    parsed
}

/// Public wrapper for callers outside this module that need a parsed file.
/// Used by CLI `ini backend-graph scan` (M1.5).
pub fn parse_for_diagnostics(target: &TargetFile, contents: &str) -> ParsedFile {
    parse_ini_contents(target, contents)
}

pub struct ScanInputs<'a> {
    pub host: &'a str,
    pub credential: Option<(&'a str, &'a str)>,
    pub installs: &'a [(String, String)],
    pub user_profile: &'a str,
    pub project_roots: &'a [String],
    pub env_state: EnvVarState,
    /// Optional zen-rule context (R012-R018). When `Some`, every parsed file
    /// is also evaluated against [`run_zen_rules_for_file`] and a single
    /// machine-level pass through [`evaluate_machine_zen`] is appended after
    /// the per-file loop. When `None`, zen rules are skipped entirely —
    /// preserving the original behavior for callers that have no endpoint
    /// state to seed the context.
    pub zen_ctx: Option<&'a ZenRuleContext<'a>>,
    /// Absolute path to `UserEngine.ini` on the remote host (from
    /// `machines.ue_runtime_user`). When `Some`, `scan_machine` evaluates
    /// R026 after the per-file loop. When `None`, R026 is skipped.
    pub user_engine_ini_path: Option<&'a str>,
    /// Machine row id for R026 finding attribution. Use 0 when unknown.
    pub machine_id: i64,
}

/// Per-file outcome of one scan pass for a single machine.
///
/// `errors` carries hard read failures (WinRM down, permission denied, etc.).
/// `not_found` carries paths the scanner attempted but the file did not exist —
/// kept separate so the wizard can show "X files missing" without misclassifying
/// them as errors, and so a fully-empty scan never looks "healthy" by default.
#[derive(Debug, Default)]
pub struct ScanOutcome {
    pub findings: Vec<Finding>,
    pub errors: Vec<String>,
    pub not_found: Vec<String>,
    pub read_count: usize,
    pub config_snapshots: Vec<crate::core::ini_config_extract::ConfigEntry>,
}

pub fn scan_machine(inputs: &ScanInputs) -> VoloResult<ScanOutcome> {
    let mut targets: Vec<TargetFile> = Vec::new();
    targets.extend(enumerate_engine_paths(inputs.installs));
    targets.extend(enumerate_user_paths(inputs.installs, inputs.user_profile));
    targets.extend(enumerate_project_paths(inputs.project_roots));

    let mut outcome = ScanOutcome::default();
    for tf in &targets {
        match read_file(inputs.host, tf, inputs.credential) {
            Ok(Some(pf)) => {
                outcome.read_count += 1;
                outcome.config_snapshots.extend(crate::core::ini_config_extract::extract(&pf));
                outcome.findings.extend(ini_diagnostics::run_rules(&pf, &inputs.env_state));
                // Zen per-file rules (R012-R015 + R017) run on the same
                // parsed file. They share the env-var snapshot so R015's
                // env-var arm can detect `UE-SharedDataCachePath` set
                // alongside ZenShared.
                if let Some(ctx) = inputs.zen_ctx {
                    outcome
                        .findings
                        .extend(run_zen_rules_for_file(&pf, &inputs.env_state, ctx));
                }
            }
            Ok(None) => outcome.not_found.push(tf.path.clone()),
            Err(e) => {
                let msg = format!("{}: {}", tf.path, e);
                tracing::warn!(target: "ini_scanner", "{}", msg);
                outcome.errors.push(msg);
            }
        }
    }
    // Machine-level zen rules (R016 binary sha + R018 cluster version
    // majority) emit at most one finding each and don't depend on any
    // single INI file, so run them exactly once per machine.
    if let Some(ctx) = inputs.zen_ctx {
        outcome.findings.extend(evaluate_machine_zen(ctx));
    }
    // R026: global (UserEngine.ini) + project-level ZenShared coexistence warning.
    if let Some(user_ini) = inputs.user_engine_ini_path {
        outcome.findings.extend(
            crate::core::ini_diagnostics_zen::evaluate_r026(
                inputs.host,
                user_ini,
                &outcome.config_snapshots,
                inputs.machine_id,
            )
        );
    }
    Ok(outcome)
}

/// Build a [`ZenRuleContextOwned`] for one machine from the live DB. Returns
/// `Ok(None)` when zen rules should NOT run for this machine — i.e. there
/// are no registered endpoints. Auto-enabling on endpoint presence keeps the
/// caller surface flag-free: the moment an operator registers a zen endpoint,
/// the INI scan starts producing R012-R018 findings without needing a
/// `--with-zen` toggle.
///
/// `ue_version_hint` should be a major.minor string (e.g. `"5.7"`) — the
/// caller usually picks it from `machine_ue_installs.version`. When `None`,
/// `resolved` stays empty and R012-R015 are skipped (R016 + R018 still run).
///
/// The function is best-effort: any individual sub-query failure (probes,
/// expected baselines, …) is downgraded to "skip that rule" rather than
/// failing the whole scan. The scan itself is the operator's primary
/// signal — silent missing pieces are preferable to a hard failure that
/// nukes the entire run.
/// `cluster_scope` (Codex round-21 P2): if `Some(&[..])`, R018's
/// `cluster_versions` is restricted to those machine ids so an unrelated
/// cluster's installs in the same DB don't pollute the majority vote.
/// Pass `None` to consider every install row in the DB (legacy default
/// for single-cluster setups).
pub fn build_zen_ctx_for_machine(
    db: &Db,
    machine_id: i64,
    ue_version_hint: Option<&str>,
    cluster_scope: Option<&[i64]>,
) -> VoloResult<Option<ZenRuleContextOwned>> {
    let endpoints = zen_endpoints::list_for_machine(db, machine_id)?;
    if endpoints.is_empty() {
        // Auto-enable contract: no endpoint registered → no zen rules.
        return Ok(None);
    }

    // Resolve rule set against the supplied UE version. The rule loader
    // shipped with this binary is the source of truth — passing `None`
    // leaves `resolved=None` so R012-R015 stay quiet for callers that
    // can't safely pick a version.
    //
    // Codex round-14 P2: use `resolve_for_diagnostics` (not the strict
    // `resolve`) so an `unverified_policy: refuse` setting doesn't
    // silently drop the entire ruleset for unverified UE major.minors.
    // The scan is read-only and best-effort — even an unverified
    // version's default rules tell the operator "this looks wrong";
    // the destructive `zen enable` path still calls strict `resolve`.
    let resolved = match ue_version_hint {
        Some(v) => {
            let rules = zen_rules_loader::load_default()?;
            zen_rules_loader::resolve_for_diagnostics(&rules, v).ok()
        }
        None => None,
    };

    // Resolve THIS machine's hostname + IP (for its own endpoints), AND
    // collect the cluster master(s) for any endpoint that has an
    // upstream_endpoint_id — workers' `ZenShared.Host` points at the
    // master, not at themselves. Both lookups happen BEFORE the probe
    // lock to avoid the deadlock pattern: `lookup_machine_*` re-locks
    // the same `Db`.
    let (host, ip) = lookup_machine_addresses(db, machine_id)?;
    // Gather upstream endpoint info so R014 has the right host to match
    // against when the project's ZenShared points at a master on another
    // machine.
    let mut upstream_targets: Vec<(i64, String, String, i64)> = Vec::new(); // (endpoint_id, host, ip, port)
    for ep in &endpoints {
        if let Some(upstream_id) = ep.upstream_endpoint_id {
            if let Ok(Some(up_ep)) = zen_endpoints::get(db, upstream_id) {
                let (up_host, up_ip) = lookup_machine_addresses(db, up_ep.machine_id)?;
                upstream_targets.push((upstream_id, up_host, up_ip, up_ep.declared_port));
            }
        }
    }

    // Per-endpoint reachability: pull the **latest** probe per endpoint and
    // check reachable + freshness via `datetime()` so we don't get tripped
    // up by mixed timestamp formats (the same trick `core::cache_backend`
    // uses for routing).
    //
    // Emit BOTH hostname and ip aliases as separate `EndpointReachability`
    // rows so the rule's `host == value.host` test matches whichever form
    // the operator used in `ZenShared.Host` (codex P2). Empty addresses
    // are filtered out.
    let mut endpoint_reachability = Vec::with_capacity(endpoints.len() * 2);
    {
        let conn = db.lock().unwrap();
        let probe_for = |endpoint_id: i64| -> VoloResult<bool> {
            let mut stmt = conn.prepare(
                "SELECT reachable,
                        datetime(probed_at) > datetime('now', ?2) AS fresh
                 FROM zen_probes
                 WHERE endpoint_id = ?1
                 ORDER BY datetime(probed_at) DESC, id DESC
                 LIMIT 1",
            )?;
            let mut rows = stmt.query(params![
                endpoint_id,
                crate::core::cache_backend::ZEN_PROBE_FRESHNESS_WINDOW
            ])?;
            if let Some(row) = rows.next()? {
                let reachable: i64 = row.get(0)?;
                let fresh: i64 = row.get(1)?;
                Ok(reachable != 0 && fresh != 0)
            } else {
                Ok(false)
            }
        };

        for ep in &endpoints {
            let Some(endpoint_id) = ep.id else { continue };
            let recent_reachable = probe_for(endpoint_id)?;
            for alias in [host.as_str(), ip.as_str()] {
                if alias.is_empty() {
                    continue;
                }
                endpoint_reachability.push(EndpointReachability {
                    host: alias.to_string(),
                    port: Some(ep.declared_port),
                    namespace: None,
                    recent_reachable,
                });
            }
        }

        // Upstream targets (workers pointing at masters): R014 should
        // accept both the master's hostname and ip.
        for (up_endpoint_id, up_host, up_ip, up_port) in &upstream_targets {
            let recent_reachable = probe_for(*up_endpoint_id)?;
            for alias in [up_host.as_str(), up_ip.as_str()] {
                if alias.is_empty() {
                    continue;
                }
                endpoint_reachability.push(EndpointReachability {
                    host: alias.to_string(),
                    port: Some(*up_port),
                    namespace: None,
                    recent_reachable,
                });
            }
        }
    }

    // R016 inputs: install row + matching baseline. Both must be present
    // with non-empty sha + version, else R016 is skipped.
    let install_binary = machine_zen_install::find(db, machine_id)?.and_then(|install| {
        let version = install.zenserver_build_version.clone()?;
        let actual = install.zenserver_sha256.clone()?;
        let expected = zen_binary_expected::find(db, &version, "zenserver")
            .ok()
            .flatten()?;
        Some(InstallBinaryCheck {
            actual_sha256: actual,
            expected_sha256: expected.sha256,
            build_version: version,
        })
    });

    // R018 input: every machine's recorded zenserver build version. Skip
    // rows missing a version — R018's strict-majority math counts only
    // recorded versions.
    //
    // Codex round-21 P2: filter to the scan's `cluster_scope` so a
    // separate cluster's machines in the same DB don't vote in R018's
    // majority. The current machine is always included.
    let cluster_versions = machine_zen_install::list(db)?
        .into_iter()
        .filter(|i| {
            i.machine_id == machine_id
                || cluster_scope.map_or(true, |s| s.contains(&i.machine_id))
        })
        .filter_map(|i| {
            i.zenserver_build_version.map(|v| MachineZenVersion {
                machine_id: i.machine_id,
                zenserver_build_version: v,
            })
        })
        .collect();

    Ok(Some(ZenRuleContextOwned {
        resolved,
        endpoint_registered: true,
        endpoint_reachability,
        install_binary,
        cluster_versions,
        current_machine_id: Some(machine_id),
    }))
}

/// Helper for the endpoint reachability builder — resolve a machine_id
/// back to its hostname so R014 can match against the host string in
/// `ZenShared=(Host="...")`. We pull this lazily from `machines` to keep
/// the SQL footprint minimal.
/// Pick the highest UE version from a list of `(version_string, install_path)`
/// pairs using numeric `(major, minor)` ordering.
///
/// Codex P2 fix: a plain `installs.iter().map(|(v, _)| v.clone()).max()`
/// returns "5.9" instead of "5.10" because string ordering is
/// lexicographic, not numeric. That misroutes `rules_loader::resolve`
/// through the wrong override / verified-version policy when a machine
/// has both 5.9 and 5.10 installed. Accepts patch suffixes ("5.7.4")
/// and ignores malformed entries.
///
/// Returns `None` when no version parses; callers treat that as "skip
/// rule resolution" (R012-R015 silently no-op).
pub fn pick_highest_ue_version(installs: &[(String, String)]) -> Option<String> {
    fn parse(v: &str) -> Option<(i64, i64)> {
        let mut parts = v.split('.');
        let major: i64 = parts.next()?.parse().ok()?;
        let minor: i64 = parts.next()?.parse().ok()?;
        for trailing in parts {
            if trailing.parse::<i64>().is_err() {
                return None;
            }
        }
        Some((major, minor))
    }
    installs
        .iter()
        .filter_map(|(v, _)| parse(v).map(|n| (n, v.clone())))
        .max_by_key(|(n, _)| *n)
        .map(|(_, v)| v)
}

// (review #12) `lookup_machine_hostname` removed — superseded by
// `lookup_machine_addresses` below, which returns hostname AND ip so R014 can
// match either form. The single-column lookup had no remaining callers.

/// Return (hostname, ip) for a machine — both columns may be non-empty so
/// R014 can match either. Codex P2 fix: `zen enable` writes the cluster
/// master's `machine.ip` into `ZenShared.Host`, but the scanner's
/// reachability table held only the hostname → R014 reported "no match"
/// for an otherwise-correct deployment. Return both addresses so the
/// rule's host-equality check accepts whichever form the operator used.
fn lookup_machine_addresses(db: &Db, machine_id: i64) -> VoloResult<(String, String)> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare("SELECT hostname, ip FROM machines WHERE id = ?1")?;
    let mut rows = stmt.query(params![machine_id])?;
    if let Some(row) = rows.next()? {
        let host: String = row.get(0).unwrap_or_default();
        let ip: String = row.get(1).unwrap_or_default();
        Ok((host, ip))
    } else {
        Ok((String::new(), String::new()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pick_highest_ue_version_uses_numeric_order() {
        // Lexicographic comparison would pick "5.9" because '9' > '1';
        // numeric (major, minor) ordering picks "5.10".
        let installs = vec![
            ("5.9".into(), "/p1".into()),
            ("5.10".into(), "/p2".into()),
        ];
        assert_eq!(pick_highest_ue_version(&installs), Some("5.10".into()));
    }

    #[test]
    fn pick_highest_ue_version_accepts_patch_suffix() {
        let installs = vec![
            ("5.7.4".into(), "/p1".into()),
            ("5.10.0".into(), "/p2".into()),
        ];
        assert_eq!(pick_highest_ue_version(&installs), Some("5.10.0".into()));
    }

    #[test]
    fn pick_highest_ue_version_skips_garbage() {
        let installs = vec![
            ("garbage".into(), "/p1".into()),
            ("5.4".into(), "/p2".into()),
        ];
        assert_eq!(pick_highest_ue_version(&installs), Some("5.4".into()));
    }

    #[test]
    fn pick_highest_ue_version_returns_none_for_all_invalid() {
        let installs = vec![("garbage".into(), "/p1".into())];
        assert_eq!(pick_highest_ue_version(&installs), None);
    }

    #[test]
    fn pick_highest_ue_version_returns_none_for_empty() {
        assert_eq!(pick_highest_ue_version(&[]), None);
    }

    #[test]
    fn enumerate_engine_paths_returns_baseengine_per_install() {
        let installs = vec![
            ("5.4".to_string(), "C:\\Program Files\\Epic Games\\UE_5.4".to_string()),
            ("5.5".to_string(), "D:\\UE\\UE_5.5".to_string()),
        ];
        let paths = enumerate_engine_paths(&installs);
        assert_eq!(paths.len(), 2);
        assert!(paths[0].path.contains("UE_5.4"));
        assert!(paths[0].path.ends_with("Engine\\Config\\BaseEngine.ini"));
    }

    #[test]
    fn enumerate_user_paths_returns_one_per_version() {
        let installs = vec![
            ("5.4".to_string(), "C:\\anything".to_string()),
        ];
        let paths = enumerate_user_paths(&installs, "C:\\Users\\lanpc");
        assert_eq!(paths.len(), 1);
        assert!(paths[0].path.contains("AppData\\Local\\UnrealEngine\\5.4"));
        assert_eq!(paths[0].category, crate::core::ini_diagnostics::Category::User);
    }

    #[test]
    fn enumerate_project_paths_returns_three_files_per_project_path() {
        let projects = vec!["E:\\Work\\EXLY".to_string()];
        let paths = enumerate_project_paths(&projects);
        assert_eq!(paths.len(), 3);
        assert!(paths.iter().any(|p| p.path.ends_with("DefaultEngine.ini")));
        assert!(paths.iter().any(|p| p.path.ends_with("ConsoleVariables.ini")));
        assert!(paths.iter().any(|p| p.path.ends_with("WindowsEngine.ini")));
    }

    #[test]
    fn read_file_uses_local_filesystem_for_loopback_target() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("DefaultEngine.ini");
        std::fs::write(
            &path,
            "[/Script/Engine.RendererSettings]\nr.PSOPrecaching=1\n",
        )
        .unwrap();

        let target = TargetFile {
            path: path.to_string_lossy().to_string(),
            category: Category::Project,
        };
        let parsed = read_file("localhost", &target, Some(("ignored", "ignored")))
            .unwrap()
            .unwrap();

        assert_eq!(parsed.sections[0].name, "/Script/Engine.RendererSettings");
        assert_eq!(parsed.sections[0].keys[0].name, "r.PSOPrecaching");
        assert_eq!(parsed.sections[0].keys[0].value, "1");
    }

    // -------- production wiring smoke tests (Plan 7 §M4 follow-up) --------

    use crate::data::{
        machines as machines_data, open_in_memory, schema,
        zen_endpoints::ZenEndpoint,
    };

    fn wiring_db() -> Db {
        let db = open_in_memory().unwrap();
        {
            let mut conn = db.lock().unwrap();
            schema::migrate(&mut conn).unwrap();
        }
        db
    }

    #[test]
    fn build_zen_ctx_for_machine_returns_none_when_no_endpoint_registered() {
        // Auto-enable contract: no endpoint registered → builder returns
        // None so `scan_machine` skips R012-R018 entirely.
        let db = wiring_db();
        let mid =
            machines_data::insert(&db, &crate::data::Machine::new("R-01", "10.0.0.1")).unwrap();
        let out = build_zen_ctx_for_machine(&db, mid, Some("5.7"), None).unwrap();
        assert!(out.is_none(), "expected None when no endpoint, got Some");
    }

    #[test]
    fn build_zen_ctx_for_machine_returns_some_when_endpoint_registered() {
        let db = wiring_db();
        let mid =
            machines_data::insert(&db, &crate::data::Machine::new("R-01", "10.0.0.1")).unwrap();
        zen_endpoints::upsert(
            &db,
            &ZenEndpoint {
                id: None,
                machine_id: mid,
                declared_port: 8558,
                scheme: "http".into(),
                role: "primary".into(),
                upstream_endpoint_id: None,
                data_dir: "C:\\ZenData".into(),
                httpserverclass: "asio".into(),
                lifecycle_mode: "managed".into(),
                created_at: None,
                updated_at: None,
                ..Default::default()
            },
        )
        .unwrap();
        // ue_version_hint=None → resolved stays None so R012-R015 skip.
        let owned = build_zen_ctx_for_machine(&db, mid, None, None).unwrap().unwrap();
        assert!(owned.endpoint_registered);
        // Codex P2 fix: one row per (hostname, ip) alias so R014's host
        // match accepts whichever form the operator put in ZenShared.Host.
        assert_eq!(owned.endpoint_reachability.len(), 2);
        let aliases: Vec<&str> = owned
            .endpoint_reachability
            .iter()
            .map(|r| r.host.as_str())
            .collect();
        assert!(aliases.contains(&"R-01"));
        assert!(aliases.contains(&"10.0.0.1"));
        assert!(owned.resolved.is_none());
        for entry in &owned.endpoint_reachability {
            assert_eq!(entry.port, Some(8558));
        }
    }

    #[test]
    fn scan_machine_emits_r012_when_zen_endpoint_registered_and_zen_shared_missing() {
        // Production wiring smoke test: seed a registered endpoint, supply a
        // project DefaultEngine.ini with the legacy backend section but no
        // ZenShared key, and verify scan_machine produces an R012 finding.
        //
        // `enumerate_project_paths` always builds paths with backslash
        // separators (Windows production target). On a Unix test box we
        // create files whose literal name embeds the backslash so the
        // string match used by the local-fs loopback read path succeeds.
        // The behavior we're testing is the WIRING (zen_ctx fires when set),
        // not the path-separator choice — that's covered by the
        // enumerate_*_paths tests above.
        let db = wiring_db();
        let mid =
            machines_data::insert(&db, &crate::data::Machine::new("R-01", "127.0.0.1")).unwrap();
        zen_endpoints::upsert(
            &db,
            &ZenEndpoint {
                id: None,
                machine_id: mid,
                declared_port: 8558,
                scheme: "http".into(),
                role: "primary".into(),
                upstream_endpoint_id: None,
                data_dir: "C:\\ZenData".into(),
                httpserverclass: "asio".into(),
                lifecycle_mode: "managed".into(),
                created_at: None,
                updated_at: None,
                ..Default::default()
            },
        )
        .unwrap();

        // Stage the file at the literal `<tmpdir>\Config\DefaultEngine.ini`
        // path — backslashes are part of the filename on Unix, mirroring
        // what `enumerate_project_paths` produces.
        let project_dir = tempfile::tempdir().unwrap();
        let project_root = project_dir.path().to_string_lossy().to_string();
        std::fs::create_dir_all(project_dir.path().join("Config")).unwrap();
        let default_engine_path = format!("{}\\Config\\DefaultEngine.ini", project_root);
        std::fs::write(
            &default_engine_path,
            "[InstalledDerivedDataBackendGraph]\n;empty\n",
        )
        .unwrap();

        // Build the context as the production callers do. ue_version_hint
        // is required so `resolved` populates and R012 can fire.
        let owned = build_zen_ctx_for_machine(&db, mid, Some("5.7"), None).unwrap().unwrap();
        let ctx = owned.as_ctx();
        let inputs = ScanInputs {
            host: "localhost",
            credential: None,
            installs: &[],
            user_profile: "",
            project_roots: &[project_root.clone()],
            env_state: EnvVarState::default(),
            zen_ctx: Some(&ctx),
            user_engine_ini_path: None,
            machine_id: 0,
        };
        let outcome = scan_machine(&inputs).unwrap();
        assert!(
            outcome.findings.iter().any(|f| f.rule_id == "R012"),
            "expected R012 in scan output, got rule_ids: {:?}",
            outcome
                .findings
                .iter()
                .map(|f| f.rule_id.clone())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn scan_machine_skips_zen_rules_when_zen_ctx_is_none() {
        // Inverse of the wiring test: with `zen_ctx=None`, the same INI must
        // not produce R012 (or any zen rule). This guards against any
        // accidental "always run zen rules" regression in `scan_machine`.
        let project_dir = tempfile::tempdir().unwrap();
        let project_root = project_dir.path().to_string_lossy().to_string();
        std::fs::create_dir_all(project_dir.path().join("Config")).unwrap();
        let default_engine_path = format!("{}\\Config\\DefaultEngine.ini", project_root);
        std::fs::write(
            &default_engine_path,
            "[InstalledDerivedDataBackendGraph]\n;empty\n",
        )
        .unwrap();

        let inputs = ScanInputs {
            host: "localhost",
            credential: None,
            installs: &[],
            user_profile: "",
            project_roots: &[project_root],
            env_state: EnvVarState::default(),
            zen_ctx: None,
            user_engine_ini_path: None,
            machine_id: 0,
        };
        let outcome = scan_machine(&inputs).unwrap();
        // None of R012-R018 should appear when zen_ctx is None.
        for f in &outcome.findings {
            assert!(
                !matches!(
                    f.rule_id.as_str(),
                    "R012" | "R013" | "R014" | "R015" | "R016" | "R017" | "R018"
                ),
                "unexpected zen rule {} fired with zen_ctx=None",
                f.rule_id
            );
        }
    }

    #[test]
    fn parse_extracts_backend_nodes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("DefaultEngine.ini");
        std::fs::write(&path, "[DerivedDataBackendGraph]\nShared=(Type=FileSystem, Path=\\\\NAS\\DDC, ReadOnly=false)\nBoot=(Type=Boot, Filename=DDC)\n").unwrap();
        let target = TargetFile {
            path: path.to_string_lossy().to_string(),
            category: crate::core::ini_diagnostics::Category::Project,
        };
        let body = std::fs::read_to_string(&path).unwrap();
        let parsed = parse_ini_contents(&target, &body);
        let bg = parsed.sections.iter().find(|s| s.name.eq_ignore_ascii_case("DerivedDataBackendGraph")).unwrap();
        assert_eq!(bg.backend_nodes.len(), 2);
        let shared = bg.backend_nodes.iter().find(|n| n.name == "Shared").unwrap();
        assert_eq!(crate::core::ini_backend_graph::get_field(shared, "ReadOnly"), Some("false"));
    }

    #[test]
    fn scan_machine_collects_config_snapshots() {
        // Mirror the harness from `scan_machine_skips_zen_rules_when_zen_ctx_is_none`:
        // write a file at the literal backslash path that enumerate_project_paths
        // produces, then assert config_snapshots is populated by extract().
        let project_dir = tempfile::tempdir().unwrap();
        let project_root = project_dir.path().to_string_lossy().to_string();
        std::fs::create_dir_all(project_dir.path().join("Config")).unwrap();
        let default_engine_path = format!("{}\\Config\\DefaultEngine.ini", project_root);
        std::fs::write(
            &default_engine_path,
            "[DerivedDataBackendGraph]\nRoot=(Type=KeyLength)\n",
        )
        .unwrap();

        let inputs = ScanInputs {
            host: "localhost",
            credential: None,
            installs: &[],
            user_profile: "",
            project_roots: &[project_root],
            env_state: EnvVarState::default(),
            zen_ctx: None,
            user_engine_ini_path: None,
            machine_id: 0,
        };
        let outcome = scan_machine(&inputs).unwrap();
        assert!(
            outcome
                .config_snapshots
                .iter()
                .any(|c| c.domain == "ddc" && c.key_name == "Root"),
            "expected ddc/Root in config_snapshots, got: {:?}",
            outcome
                .config_snapshots
                .iter()
                .map(|c| (c.domain, &c.key_name))
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn non_tuple_keys_stay_out_of_backend_nodes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("DefaultEngine.ini");
        std::fs::write(&path, "[Foo]\nBar=baz\n").unwrap();
        let target = TargetFile {
            path: path.to_string_lossy().to_string(),
            category: crate::core::ini_diagnostics::Category::Project,
        };
        let body = std::fs::read_to_string(&path).unwrap();
        let parsed = parse_ini_contents(&target, &body);
        assert!(parsed.sections.iter().all(|s| s.backend_nodes.is_empty()));
    }

    #[test]
    fn scan_machine_emits_r019_when_global_and_project_both_have_zen_shared() {
        use tempfile::tempdir;
        let dir = tempdir().unwrap();

        // UserEngine.ini at the root of the temp dir (used directly via path).
        let user_ini = dir.path().join("UserEngine.ini");
        std::fs::write(
            &user_ini,
            "[InstalledDerivedDataBackendGraph]\nZenShared=(Type=Zen, Host=\"192.168.10.20\", Port=8558, Namespace=\"ue.ddc\")\n",
        )
        .unwrap();

        // DefaultEngine.ini at the backslash path enumerate_project_paths produces.
        // Must create the Config subdirectory first because std::fs::write does
        // not create intermediate directories.
        let project_root = dir.path().to_str().unwrap().to_string();
        let config_dir = dir.path().join("Config");
        std::fs::create_dir_all(&config_dir).unwrap();
        let default_engine_path = format!("{}\\Config\\DefaultEngine.ini", project_root);
        std::fs::write(
            &default_engine_path,
            "[InstalledDerivedDataBackendGraph]\nZenShared=(Type=Zen, Host=\"192.168.10.20\", Port=8558, Namespace=\"ue.ddc\")\n",
        )
        .unwrap();

        let inputs = ScanInputs {
            host: "127.0.0.1",
            credential: None,
            installs: &[],
            user_profile: "",
            project_roots: &[project_root],
            env_state: EnvVarState::default(),
            zen_ctx: None,
            user_engine_ini_path: Some(user_ini.to_str().unwrap()),
            machine_id: 42,
        };

        let outcome = scan_machine(&inputs).unwrap();
        assert!(
            outcome.findings.iter().any(|f| f.rule_id == "R026"),
            "expected R026, got: {:?}",
            outcome.findings.iter().map(|f| &f.rule_id).collect::<Vec<_>>()
        );
    }

    #[test]
    fn scan_machine_does_not_emit_r026_when_only_project_has_zen_shared() {
        use tempfile::tempdir;
        let dir = tempdir().unwrap();

        let project_root = dir.path().to_str().unwrap().to_string();
        let config_dir = dir.path().join("Config");
        std::fs::create_dir_all(&config_dir).unwrap();
        let default_engine_path = format!("{}\\Config\\DefaultEngine.ini", project_root);
        std::fs::write(
            &default_engine_path,
            "[InstalledDerivedDataBackendGraph]\nZenShared=(Type=Zen, Host=\"192.168.10.20\", Port=8558, Namespace=\"ue.ddc\")\n",
        )
        .unwrap();

        let inputs = ScanInputs {
            host: "127.0.0.1",
            credential: None,
            installs: &[],
            user_profile: "",
            project_roots: &[project_root],
            env_state: EnvVarState::default(),
            zen_ctx: None,
            user_engine_ini_path: None,
            machine_id: 42,
        };
        let outcome = scan_machine(&inputs).unwrap();
        assert!(
            !outcome.findings.iter().any(|f| f.rule_id == "R026"),
            "R026 must not fire when user_engine_ini_path is None"
        );
    }
}

/// True if a raw value string looks like a `(K1=V1, K2=V2)` tuple.
fn is_tuple_value(v: &str) -> bool {
    let v = v.trim();
    v.starts_with('(') && v.ends_with(')')
}

#[cfg(test)]
mod tuple_detector_tests {
    use super::is_tuple_value;

    #[test]
    fn detects_paren_wrapped() {
        assert!(is_tuple_value("(Type=FileSystem)"));
    }

    #[test]
    fn rejects_plain() {
        assert!(!is_tuple_value("FileSystem"));
    }

    #[test]
    fn rejects_half_open() {
        assert!(!is_tuple_value("(Type=FileSystem"));
        assert!(!is_tuple_value("Type=FileSystem)"));
    }
}
