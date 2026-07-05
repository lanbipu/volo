//! Robocopy fan-out planning and per-target execution for DDC Pak files.

use crate::core::powershell; // run_json_stdin/script_path, used by the loopback distribute path
use crate::core::ssh::{run_json, NodeScript, SshExecutor};
use crate::data::{
    machines as data_machines,
    project_locations::{self, ProjectLocation},
    Db,
};
use crate::error::{VoloError, VoloResult};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
struct DistributeRaw {
    ok: bool,
    #[serde(default)]
    exit_code: String,
    #[serde(default)]
    bytes_copied: String,
    #[serde(default)]
    stdout_tail: String,
    #[serde(default)]
    message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DistributeOutcome {
    pub target_machine_id: i64,
    pub ok: bool,
    pub exit_code: i32,
    pub bytes_copied: i64,
    pub stdout_tail: String,
    pub message: Option<String>,
}

#[derive(Clone, Debug)]
pub struct DistributeProfile {
    pub source_subdir: String,
    /// One or more glob patterns.  Each element is a single Robocopy file-pattern
    /// argument (no spaces within an element).  The loopback path (`run_local_robocopy`)
    /// passes only the first pattern; callers that need all patterns must iterate and
    /// call `run_one_with_profile` once per pattern — see `pso_cache_profiles()`.
    pub file_globs: Vec<String>,
    pub ps_script: &'static str,
}

impl DistributeProfile {
    pub fn ddc_pak() -> Self {
        Self {
            source_subdir: "DerivedDataCache".into(),
            file_globs: vec!["DDC.ddp".into()],
            ps_script: "distribute-pak-file.ps1",
        }
    }

    /// PSO cache covers two extensions.  Use `pso_cache_profiles()` when you need
    /// a separate Robocopy invocation per pattern; this constructor is kept for
    /// code that only needs to inspect the profile shape.
    pub fn pso_cache() -> Self {
        Self {
            source_subdir: "Saved\\CollectedPSOs".into(),
            file_globs: vec!["*.upipelinecache".into(), "*.stablepc.csv".into()],
            ps_script: "distribute-pso-cache.ps1",
        }
    }

    /// Returns one `DistributeProfile` per PSO extension so each gets its own
    /// Robocopy invocation and there is no ambiguity about single-string patterns.
    pub fn pso_cache_profiles() -> Vec<Self> {
        ["*.upipelinecache", "*.stablepc.csv"]
            .iter()
            .map(|glob| Self {
                source_subdir: "Saved\\CollectedPSOs".into(),
                file_globs: vec![(*glob).into()],
                ps_script: "distribute-pso-cache.ps1",
            })
            .collect()
    }

    /// The first (and for DDC pak, only) file-glob pattern.
    pub fn primary_glob(&self) -> &str {
        self.file_globs.first().map(String::as_str).unwrap_or("")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DistributePlanItem {
    pub target_machine_id: i64,
    pub target_host: String,
    pub source_unc: String,
    pub target_local: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    pub source_smb_user: Option<String>,
    #[serde(skip_serializing)]
    pub source_smb_pass: Option<String>,
}

#[allow(clippy::too_many_arguments)]
pub fn plan(
    profile: &DistributeProfile,
    db: &Db,
    source_machine_id: i64,
    source_host: &str,
    source_location: &ProjectLocation,
    target_machine_ids: &[i64],
    project_id: i64,
    named_share_unc: Option<&str>,
    source_smb_user: Option<String>,
    source_smb_pass: Option<String>,
) -> VoloResult<Vec<DistributePlanItem>> {
    if target_machine_ids.is_empty() {
        return Err(VoloError::InvalidInput("no target machines".into()));
    }

    let source_unc = if let Some(unc) = named_share_unc {
        append_source_subdir_once(unc, &profile.source_subdir)
    } else {
        admin_share_unc(source_host, &source_location.abs_path, &profile.source_subdir)?
    };

    let mut out = Vec::new();
    for target_id in target_machine_ids {
        if *target_id == source_machine_id {
            continue;
        }
        let location = project_locations::get_for_project_machine(db, project_id, *target_id)?
            .ok_or_else(|| {
                VoloError::InvalidInput(format!(
                    "project {} has no location on machine {}",
                    project_id, target_id
                ))
            })?;
        let target = data_machines::find_by_id(db, *target_id)?.ok_or_else(|| {
            VoloError::InvalidInput(format!("target machine {} not found", target_id))
        })?;
        out.push(DistributePlanItem {
            target_machine_id: *target_id,
            target_host: target.ip,
            source_unc: source_unc.clone(),
            target_local: append_source_subdir_once(&location.abs_path, &profile.source_subdir),
            file_name: None,
            source_smb_user: source_smb_user.clone(),
            source_smb_pass: source_smb_pass.clone(),
        });
    }
    Ok(out)
}

fn admin_share_unc(source_host: &str, abs_path: &str, source_subdir: &str) -> VoloResult<String> {
    let normalized = abs_path.replace('/', "\\");
    let mut chars = normalized.chars();
    let drive = chars.next().ok_or_else(|| {
        VoloError::InvalidInput(format!("abs_path not drive-rooted: {}", abs_path))
    })?;
    if chars.next() != Some(':') {
        return Err(VoloError::InvalidInput(format!(
            "abs_path not a drive-rooted Windows path: {}",
            abs_path
        )));
    }
    let rest = &normalized[2..];
    let base_unc = format!("\\\\{}\\{}$\\{}", source_host, drive, rest.trim_start_matches('\\'));
    Ok(append_source_subdir_once(&base_unc, source_subdir))
}

fn append_source_subdir_once(base_path: &str, source_subdir: &str) -> String {
    let base = base_path.trim_end_matches(['\\', '/']);
    let subdir = source_subdir.trim_matches(['\\', '/']).replace('/', "\\");
    if subdir.is_empty() || path_ends_with_segments(base, &subdir) {
        return base.to_string();
    }
    format!("{}\\{}", base, subdir)
}

fn path_ends_with_segments(path: &str, suffix: &str) -> bool {
    let path_segments: Vec<_> = path
        .split(['\\', '/'])
        .filter(|segment| !segment.is_empty())
        .collect();
    let suffix_segments: Vec<_> = suffix
        .split(['\\', '/'])
        .filter(|segment| !segment.is_empty())
        .collect();
    if suffix_segments.is_empty() || suffix_segments.len() > path_segments.len() {
        return false;
    }
    path_segments[path_segments.len() - suffix_segments.len()..]
        .iter()
        .zip(suffix_segments.iter())
        .all(|(left, right)| left.eq_ignore_ascii_case(right))
}

/// True when `candidate` names the registered share `share_unc` — matched by
/// leading path segments, case-insensitively, ignoring trailing separators and
/// any appended source subdir. The distribute path appends the profile's source
/// subdir to a share UNC, and operators may type a different case or a trailing
/// slash, so an explicit `named_share_unc` must be matched to its share this way
/// rather than by exact string compare (which would drop the credential for a
/// valid Mode B share). Segment-wise matching also avoids a string-prefix false
/// positive (e.g. `\\H\DDC` must not match the share `\\H\D`).
pub fn unc_names_share(candidate: &str, share_unc: &str) -> bool {
    let cand: Vec<_> = candidate
        .split(['\\', '/'])
        .filter(|segment| !segment.is_empty())
        .collect();
    let base: Vec<_> = share_unc
        .split(['\\', '/'])
        .filter(|segment| !segment.is_empty())
        .collect();
    if base.is_empty() || base.len() > cand.len() {
        return false;
    }
    cand[..base.len()]
        .iter()
        .zip(base.iter())
        .all(|(left, right)| left.eq_ignore_ascii_case(right))
}

/// Source-share SMB access for a distribute run: the share UNC the target pulls
/// from, plus the credential to mount it. An open (Mode A) share has a UNC but
/// no credential; a managed (Mode B) share has both.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SourceSmb {
    pub named_share_unc: Option<String>,
    pub user: Option<String>,
    pub pass: Option<String>,
}

/// DB-only source-share decision: which share UNC the target pulls from, and
/// which SecretStore alias (if any) holds its credential. No secret read, so
/// `--dry-run` and the real path share the exact same share/UNC selection and
/// the same validation errors. The `ddc-svc` account only has rights to its
/// managed share (not the admin `D$`), so under SSH key auth a source with no
/// usable share is an error, never a silent `\\host\D$` fallback.
fn resolve_source_share(
    db: &Db,
    source_machine_id: i64,
    explicit_alias: Option<&str>,
) -> VoloResult<(Option<String>, Option<String>)> {
    use crate::data::share_configs::{self, ShareMode};
    let shares = share_configs::find_by_host(db, source_machine_id)?;

    // Explicit alias: must name a share registered on the source host, so its
    // UNC pairs with the cred (no admin-D$ fallback the target can't read).
    if let Some(alias) = explicit_alias {
        let share = shares
            .iter()
            .find(|s| s.credential_alias.as_deref() == Some(alias))
            .ok_or_else(|| {
                VoloError::InvalidInput(format!(
                    "source SMB alias '{alias}' matches no share on the source host; \
                     register it with `share create --mode b` first"
                ))
            })?;
        return Ok((Some(share.unc_path.clone()), Some(alias.to_string())));
    }

    // Auto-derive: a single Mode B share, else a single Mode A share. Never
    // guess between several — the CLI has no per-share selector.
    let managed: Vec<&share_configs::ShareConfig> = shares
        .iter()
        .filter(|s| s.mode == ShareMode::Managed && s.credential_alias.is_some())
        .collect();
    if managed.len() > 1 {
        return Err(VoloError::InvalidInput(format!(
            "source host has {} Mode B shares; pass --source-smb-cred-alias to choose one",
            managed.len()
        )));
    }
    if let Some(share) = managed.first() {
        return Ok((Some(share.unc_path.clone()), share.credential_alias.clone()));
    }

    let open: Vec<&share_configs::ShareConfig> =
        shares.iter().filter(|s| s.mode == ShareMode::Open).collect();
    if open.len() > 1 {
        return Err(VoloError::InvalidInput(format!(
            "source host has {} Mode A shares; keep one open share, or use a Mode B \
             share with --source-smb-cred-alias",
            open.len()
        )));
    }
    if let Some(share) = open.first() {
        return Ok((Some(share.unc_path.clone()), None));
    }

    Err(VoloError::InvalidInput(
        "source host has no registered share; create one with `share create` \
         (Mode A open or Mode B managed) before distributing"
            .to_string(),
    ))
}

/// Resolve how the target node reads the source share, including the SMB
/// credential. Set `read_secret = false` for dry-run previews: the share/UNC
/// selection and all validation still run, but the SecretStore password is not
/// read (so the cred fields stay `None`). Mode B svc account is `ddc-svc` by
/// convention; the SecretStore holds only the password, so the user is fixed.
pub fn resolve_source_smb(
    db: &Db,
    source_machine_id: i64,
    explicit_alias: Option<&str>,
    read_secret: bool,
) -> VoloResult<SourceSmb> {
    let (named_share_unc, secret_alias) =
        resolve_source_share(db, source_machine_id, explicit_alias)?;
    let (user, pass) = match (secret_alias, read_secret) {
        (Some(alias), true) => {
            let pass = crate::core::secrets::get_share_secret_migrating(&alias)?
                .ok_or_else(|| {
                    VoloError::InvalidInput(format!(
                        "Mode B share secret '{alias}' missing from SecretStore; \
                         re-run `share create --mode b`"
                    ))
                })?;
            // Use the share's actual service account from its credential record
            // (the alias IS the credential alias) — a managed-share ACL only
            // grants that account, so a non-default svc_username must not be sent
            // as the hardcoded `ddc-svc`. Fall back to the convention only if no
            // record exists.
            let user = crate::data::credentials::find_by_alias(db, &alias)
                .ok()
                .flatten()
                .map(|c| c.username)
                .unwrap_or_else(|| "ddc-svc".to_string());
            (Some(user), Some(pass))
        }
        _ => (None, None),
    };
    Ok(SourceSmb {
        named_share_unc,
        user,
        pass,
    })
}

/// SMB credential for a target pulling **project-local** artifacts (DDC.ddp under
/// `{project}/DerivedDataCache`, PSO files under `{project}/Saved/...`) from the
/// source host's admin share (`\\host\D$\...`). The registered DDC SMB share
/// points at the fleet shared-cache folder and does not contain per-project paks.
///
/// Uses the fleet `uecm-svc` password from SecretStore (same value as
/// `UECM-Bootstrap.cmd`) qualified as `HOST\uecm-svc` for cross-machine admin-share
/// auth — mirroring `modeb-svc-connect.ps1`.
pub fn resolve_admin_pull_smb(
    db: &Db,
    source_machine_id: i64,
    read_secret: bool,
) -> VoloResult<(Option<String>, Option<String>)> {
    let server = crate::core::shares::smb_server_name_for_machine(db, source_machine_id)?;
    let qualified = qualify_smb_user(&server, "uecm-svc");
    if !read_secret {
        return Ok((Some(qualified), None));
    }
    let pass = find_fleet_uecm_svc_secret(db)?;
    Ok((Some(qualified), Some(pass)))
}

fn qualify_smb_user(server: &str, username: &str) -> String {
    if username.contains('\\') {
        username.to_string()
    } else {
        format!(r"{server}\{username}")
    }
}

fn find_fleet_uecm_svc_secret(db: &Db) -> VoloResult<String> {
    let creds = crate::data::credentials::list_all(db)?;
    let matches: Vec<_> = creds
        .iter()
        .filter(|c| {
            c.username.eq_ignore_ascii_case("uecm-svc")
                || c.username.to_ascii_lowercase().ends_with(r"\uecm-svc")
        })
        .collect();
    match matches.len() {
        0 => Err(VoloError::InvalidInput(
            "no uecm-svc fleet transport password in SecretStore; register the same \
             password used in UECM-Bootstrap.cmd via 凭据管理 (username uecm-svc)"
                .into(),
        )),
        1 => {
            let alias = &matches[0].alias;
            crate::core::secrets::SecretStore::from_config()?
                .get(alias)?
                .ok_or_else(|| {
                    VoloError::InvalidInput(format!(
                        "credential alias '{alias}' has no secret in SecretStore"
                    ))
                })
        }
        n => Err(VoloError::InvalidInput(format!(
            "found {n} uecm-svc credentials; keep exactly one fleet transport password"
        ))),
    }
}

/// stdin JSON for the node-pure distribute scripts. Operator→target auth is
/// SSH key based and needs no forwarded credential; only the target→source
/// SMB cred is forwarded.
fn build_distribute_payload(item: &DistributePlanItem, preflight: bool) -> serde_json::Value {
    let mut obj = serde_json::json!({
        "SourceUnc": item.source_unc,
        "TargetLocal": item.target_local,
        "PreflightOnly": preflight,
    });
    let map = obj.as_object_mut().expect("json object");
    if let Some(file_name) = &item.file_name {
        map.insert("FileName".into(), file_name.clone().into());
    }
    if let (Some(user), Some(pass)) =
        (item.source_smb_user.as_deref(), item.source_smb_pass.as_deref())
    {
        map.insert("SourceSmbUser".into(), user.into());
        map.insert("SourceSmbPass".into(), pass.into());
    }
    obj
}

pub async fn preflight_one(item: &DistributePlanItem) -> VoloResult<()> {
    let profile = DistributeProfile::ddc_pak();
    preflight_one_with_profile(&profile, item).await
}

pub async fn preflight_one_with_profile(
    profile: &DistributeProfile,
    item: &DistributePlanItem,
) -> VoloResult<()> {
    if crate::core::loopback::is_loopback_target(&item.target_host) {
        let result = run_local_robocopy(profile, item, true)?;
        if !result.ok {
            return Err(VoloError::OperationFailed(
                result
                    .message
                    .unwrap_or_else(|| format!("local preflight failed: {}", result.stdout_tail)),
            ));
        }
        return Ok(());
    }

    let exec = SshExecutor::from_config()?;
    let result: DistributeRaw = run_json(
        &exec,
        &item.target_host,
        &NodeScript {
            name: profile.ps_script,
            args: build_distribute_payload(item, true),
            ssh_user: None,
        },
    )?;
    if !result.ok {
        return Err(VoloError::OperationFailed(
            result
                .message
                .unwrap_or_else(|| format!("preflight failed: {}", result.stdout_tail)),
        ));
    }
    Ok(())
}

pub async fn run_one(item: DistributePlanItem) -> VoloResult<DistributeOutcome> {
    let profile = DistributeProfile::ddc_pak();
    run_one_with_profile(&profile, item).await
}

pub async fn run_one_with_profile(
    profile: &DistributeProfile,
    item: DistributePlanItem,
) -> VoloResult<DistributeOutcome> {
    if crate::core::loopback::is_loopback_target(&item.target_host) {
        return run_local_robocopy(profile, &item, false);
    }

    let exec = SshExecutor::from_config()?;
    let result: DistributeRaw = run_json(
        &exec,
        &item.target_host,
        &NodeScript {
            name: profile.ps_script,
            args: build_distribute_payload(&item, false),
            ssh_user: None,
        },
    )?;
    Ok(DistributeOutcome {
        target_machine_id: item.target_machine_id,
        ok: result.ok,
        exit_code: result.exit_code.parse().unwrap_or(-1),
        bytes_copied: result.bytes_copied.parse().unwrap_or_default(),
        stdout_tail: result.stdout_tail,
        message: result.message,
    })
}

/// Loopback distribution: run the SAME node-pure script the remote SSH path
/// uses, but locally on the operator host (no SSH round-trip to self). The script
/// mounts the source share with the forwarded SourceSmb credential (New-PSDrive)
/// before robocopy, so a managed (Mode B) source authenticates exactly as it does
/// on a remote target — the SSH migration dropped the operator-side `cmdkey`
/// persistence that the old bespoke local robocopy silently relied on.
fn run_local_robocopy(
    profile: &DistributeProfile,
    item: &DistributePlanItem,
    preflight: bool,
) -> VoloResult<DistributeOutcome> {
    let payload = build_distribute_payload(item, preflight).to_string();
    let raw: DistributeRaw = powershell::run_json_stdin(
        &powershell::script_path(profile.ps_script),
        &payload,
    )?;
    Ok(DistributeOutcome {
        target_machine_id: item.target_machine_id,
        ok: raw.ok,
        exit_code: raw.exit_code.parse().unwrap_or(-1),
        bytes_copied: raw.bytes_copied.parse().unwrap_or_default(),
        stdout_tail: raw.stdout_tail,
        message: raw.message,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::{machines, open_in_memory, projects, schema, Machine, Project};

    fn setup() -> (Db, i64, i64, i64) {
        let db = open_in_memory().unwrap();
        {
            let mut conn = db.lock().unwrap();
            schema::migrate(&mut conn).unwrap();
        }
        let source = machines::insert(&db, &Machine::new("SOURCE", "1.1.1.1")).unwrap();
        let target = machines::insert(&db, &Machine::new("TARGET", "2.2.2.2")).unwrap();
        let project_id = projects::upsert(
            &db,
            &Project {
                id: None,
                uproject_name: "X.uproject".into(),
                uproject_stem_lower: "x".into(),
                uproject_guid: None,
                display_name: None,
                first_seen_at: None,
                last_seen_at: None,
                ue_version_major: None,
                ue_version_minor: None,
                engine_association_raw: None,
                engine_association_kind: None,
            },
        )
        .unwrap();
        (db, source, target, project_id)
    }

    fn source_loc(project_id: i64, source: i64) -> ProjectLocation {
        ProjectLocation {
            id: Some(0),
            project_id,
            machine_id: source,
            abs_path: "D:\\X".into(),
            uproject_path: "D:\\X\\X.uproject".into(),
            discovery_status: crate::data::DiscoveryStatus::Auto,
            discovered_at: None,
        }
    }

    fn share(host: i64, name: &str, mode: crate::data::share_configs::ShareMode, alias: Option<&str>) -> crate::data::share_configs::ShareConfig {
        crate::data::share_configs::ShareConfig {
            id: None,
            host_machine_id: host,
            share_name: name.into(),
            unc_path: format!("\\\\SOURCE\\{name}"),
            local_path: format!("D:\\{name}"),
            mode,
            credential_alias: alias.map(str::to_string),
        }
    }

    #[test]
    fn resolve_source_smb_errors_without_any_share() {
        let (db, source, _t, _p) = setup();
        // No share on the source: the SSH target can't read admin D$ → error,
        // and dry-run (read_secret=false) catches it too.
        assert!(resolve_source_smb(&db, source, None, false).is_err());
        assert!(resolve_source_smb(&db, source, None, true).is_err());
    }

    #[test]
    fn resolve_source_smb_uses_open_share_unc_without_cred() {
        use crate::data::share_configs::{insert, ShareMode};
        let (db, source, _t, _p) = setup();
        insert(&db, &share(source, "DDC", ShareMode::Open, None)).unwrap();
        let smb = resolve_source_smb(&db, source, None, true).unwrap();
        assert_eq!(smb.named_share_unc.as_deref(), Some("\\\\SOURCE\\DDC"));
        assert_eq!(smb.user, None);
        assert_eq!(smb.pass, None);
    }

    #[test]
    fn resolve_source_smb_errors_with_multiple_managed_or_open_shares() {
        use crate::data::share_configs::{insert, ShareMode};
        let (db, source, _t, _p) = setup();
        insert(&db, &share(source, "DDC", ShareMode::Managed, Some("share-SOURCE-DDC"))).unwrap();
        insert(&db, &share(source, "PSO", ShareMode::Managed, Some("share-SOURCE-PSO"))).unwrap();
        assert!(resolve_source_smb(&db, source, None, false).is_err());

        let (db2, src2, _t2, _p2) = setup();
        insert(&db2, &share(src2, "A", ShareMode::Open, None)).unwrap();
        insert(&db2, &share(src2, "B", ShareMode::Open, None)).unwrap();
        assert!(resolve_source_smb(&db2, src2, None, false).is_err());
    }

    #[test]
    fn resolve_source_smb_explicit_alias_requires_matching_share() {
        let (db, source, _t, _p) = setup();
        // Alias given but no share row references it → error (no admin-D$ fallback).
        assert!(resolve_source_smb(&db, source, Some("share-SOURCE-DDC"), false).is_err());
    }

    #[test]
    fn plan_rejects_empty_targets() {
        let (db, source, _, project_id) = setup();
        let result = plan(
            &DistributeProfile::ddc_pak(),
            &db,
            source,
            "1.1.1.1",
            &source_loc(project_id, source),
            &[],
            project_id,
            None,
            None,
            None,
        );
        assert!(matches!(result, Err(VoloError::InvalidInput(_))));
    }

    #[test]
    fn plan_skips_source_in_targets() {
        let (db, source, target, project_id) = setup();
        project_locations::upsert(
            &db,
            &ProjectLocation {
                id: None,
                project_id,
                machine_id: target,
                abs_path: "E:\\Y".into(),
                uproject_path: "E:\\Y\\X.uproject".into(),
                discovery_status: crate::data::DiscoveryStatus::Auto,
                discovered_at: None,
            },
        )
        .unwrap();
        let items = plan(
            &DistributeProfile::ddc_pak(),
            &db,
            source,
            "1.1.1.1",
            &source_loc(project_id, source),
            &[source, target],
            project_id,
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].source_unc, "\\\\1.1.1.1\\D$\\X\\DerivedDataCache");
        assert_eq!(items[0].target_local, "E:\\Y\\DerivedDataCache");
    }

    #[test]
    fn plan_uses_named_share_when_provided() {
        let (db, source, target, project_id) = setup();
        project_locations::upsert(
            &db,
            &ProjectLocation {
                id: None,
                project_id,
                machine_id: target,
                abs_path: "E:\\Y".into(),
                uproject_path: "E:\\Y\\X.uproject".into(),
                discovery_status: crate::data::DiscoveryStatus::Auto,
                discovered_at: None,
            },
        )
        .unwrap();
        let items = plan(
            &DistributeProfile::ddc_pak(),
            &db,
            source,
            "1.1.1.1",
            &source_loc(project_id, source),
            &[target],
            project_id,
            Some("\\\\HOST\\DDC"),
            None,
            None,
        )
        .unwrap();
        assert_eq!(items[0].source_unc, "\\\\HOST\\DDC\\DerivedDataCache");
    }

    #[test]
    fn plan_does_not_duplicate_named_share_suffix() {
        let (db, source, target, project_id) = setup();
        project_locations::upsert(
            &db,
            &ProjectLocation {
                id: None,
                project_id,
                machine_id: target,
                abs_path: "E:\\Y\\DerivedDataCache".into(),
                uproject_path: "E:\\Y\\X.uproject".into(),
                discovery_status: crate::data::DiscoveryStatus::Auto,
                discovered_at: None,
            },
        )
        .unwrap();
        let items = plan(
            &DistributeProfile::ddc_pak(),
            &db,
            source,
            "1.1.1.1",
            &source_loc(project_id, source),
            &[target],
            project_id,
            Some("\\\\HOST\\DDC\\DerivedDataCache"),
            None,
            None,
        )
        .unwrap();
        assert_eq!(items[0].source_unc, "\\\\HOST\\DDC\\DerivedDataCache");
        assert_eq!(items[0].target_local, "E:\\Y\\DerivedDataCache");
    }

    #[test]
    fn pso_profile_does_not_duplicate_nested_suffix() {
        assert_eq!(
            append_source_subdir_once("\\\\HOST\\PSO\\Saved\\CollectedPSOs", "Saved\\CollectedPSOs"),
            "\\\\HOST\\PSO\\Saved\\CollectedPSOs"
        );
    }

    #[test]
    fn pso_cache_profile_includes_both_pso_extensions() {
        let profile = DistributeProfile::pso_cache();
        assert!(
            profile.file_globs.iter().any(|g| g == "*.upipelinecache"),
            "pso_cache profile must include *.upipelinecache"
        );
        assert!(
            profile.file_globs.iter().any(|g| g == "*.stablepc.csv"),
            "pso_cache profile must include *.stablepc.csv"
        );
        // No single element should contain a space (that would be the old broken shape)
        for g in &profile.file_globs {
            assert!(!g.contains(' '), "glob pattern must not contain a space: {:?}", g);
        }
    }

    #[test]
    fn pso_cache_profiles_returns_one_profile_per_extension() {
        let profiles = DistributeProfile::pso_cache_profiles();
        assert_eq!(profiles.len(), 2);
        let globs: Vec<&str> = profiles.iter().map(|p| p.primary_glob()).collect();
        assert!(globs.contains(&"*.upipelinecache"));
        assert!(globs.contains(&"*.stablepc.csv"));
        // Each profile has exactly one glob (no space-separated multi-pattern)
        for p in &profiles {
            assert_eq!(p.file_globs.len(), 1);
            assert!(!p.file_globs[0].contains(' '));
        }
    }

    #[test]
    fn ddc_pak_profile_has_single_glob() {
        let profile = DistributeProfile::ddc_pak();
        assert_eq!(profile.file_globs.len(), 1);
        assert_eq!(profile.primary_glob(), "DDC.ddp");
    }

    #[test]
    fn unc_names_share_matches_case_trailing_sep_and_appended_subdir() {
        let share = "\\\\HOST\\DDC";
        // exact, casing, trailing separator, and the appended source subdir all match.
        assert!(unc_names_share("\\\\HOST\\DDC", share));
        assert!(unc_names_share("\\\\host\\ddc", share));
        assert!(unc_names_share("\\\\HOST\\DDC\\", share));
        assert!(unc_names_share("\\\\HOST\\DDC\\DerivedDataCache", share));
        assert!(unc_names_share("//HOST/DDC/DerivedDataCache", share));
        // a different share must NOT match, and a string-prefix is not a segment prefix.
        assert!(!unc_names_share("\\\\HOST\\OTHER", share));
        assert!(!unc_names_share("\\\\HOST\\DDCX", share));
        assert!(!unc_names_share("\\\\HOST", share));
    }

    #[test]
    fn qualify_smb_user_adds_server_prefix() {
        assert_eq!(qualify_smb_user("LANPC", "uecm-svc"), r"LANPC\uecm-svc");
        assert_eq!(
            qualify_smb_user("LANPC", r"OTHER\uecm-svc"),
            r"OTHER\uecm-svc"
        );
    }

    #[test]
    fn resolve_admin_pull_smb_errors_without_fleet_password() {
        let (db, source, _t, _p) = setup();
        assert!(resolve_admin_pull_smb(&db, source, true).is_err());
        let (user, pass) = resolve_admin_pull_smb(&db, source, false).unwrap();
        assert_eq!(user.as_deref(), Some(r"SOURCE\uecm-svc"));
        assert!(pass.is_none());
    }

    #[test]
    fn resolve_admin_pull_smb_reads_fleet_uecm_svc_secret() {
        use crate::core::secrets::SecretStore;
        use crate::data::credentials::{self, CredentialKind, CredentialRecord};
        let (db, source, _t, _p) = setup();
        credentials::insert(
            &db,
            &CredentialRecord {
                id: None,
                alias: "UECM:transport".into(),
                kind: CredentialKind::Winrm,
                username: "uecm-svc".into(),
            },
        )
        .unwrap();
        SecretStore::from_config()
            .unwrap()
            .put("UECM:transport", "fleet-pass")
            .unwrap();
        let (user, pass) = resolve_admin_pull_smb(&db, source, true).unwrap();
        assert_eq!(user.as_deref(), Some(r"SOURCE\uecm-svc"));
        assert_eq!(pass.as_deref(), Some("fleet-pass"));
    }

    #[test]
    fn plan_default_uses_admin_share_for_project_pak() {
        let (db, source, target, project_id) = setup();
        use crate::data::share_configs::{insert, ShareMode};
        insert(&db, &share(source, "DDC", ShareMode::Managed, Some("share-SOURCE-DDC"))).unwrap();
        project_locations::upsert(
            &db,
            &ProjectLocation {
                id: None,
                project_id,
                machine_id: target,
                abs_path: "E:\\Y".into(),
                uproject_path: "E:\\Y\\X.uproject".into(),
                discovery_status: crate::data::DiscoveryStatus::Auto,
                discovered_at: None,
            },
        )
        .unwrap();
        let items = plan(
            &DistributeProfile::ddc_pak(),
            &db,
            source,
            "1.1.1.1",
            &source_loc(project_id, source),
            &[target],
            project_id,
            None,
            Some(r"SOURCE\uecm-svc".into()),
            Some("pw".into()),
        )
        .unwrap();
        assert_eq!(items[0].source_unc, "\\\\1.1.1.1\\D$\\X\\DerivedDataCache");
    }
}
