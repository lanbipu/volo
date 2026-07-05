//! SSH-push transport for DDC pak / PSO cache distribution.
//!
//! Default distribute path since 2026-07 (see
//! docs/changes/2026-07-05-ssh-push-distribute-plan.md): the data follows the
//! SAME trust channel as control — the operator's uecm SSH key — instead of a
//! second SMB channel. No source share, no `share_configs` row, no guest
//! policy is involved; machine onboarding is the only prerequisite.
//!
//! Flow per job:
//! 1. Acquire the source file on the operator: loopback source → read the file
//!    in place; remote source → `stage-transfer-out.ps1` copies it to the
//!    node's space-free staging dir, then scp-pull to a local temp dir.
//! 2. Per target: `receive-transfer.ps1 PreflightOnly` (creates the staging
//!    dir + write-probes the final dir), scp-push the file into staging, then
//!    `receive-transfer.ps1` verifies size and Move-Items into place (atomic:
//!    a partial transfer never lands at the final path).
//!
//! The legacy SMB-pull path (`pak_distribute::run_one_with_profile`) remains
//! as an explicit escape hatch when a caller passes `named_share_unc` /
//! `--source-smb-cred-alias`.

use crate::core::pak_distribute::{DistributeOutcome, DistributePlanItem};
use crate::core::ssh::{self, run_json, NodeScript, SshExecutor};
use crate::data::{machines as data_machines, project_locations, Db};
use crate::error::{VoloError, VoloResult};
use serde::Deserialize;
use std::path::{Path, PathBuf};

/// Outbound staging root on remote source nodes (created by
/// `stage-transfer-out.ps1`).
const TRANSFER_OUT_ROOT_FWD: &str = "C:/ProgramData/UECM/transfer/out";

/// Inbound staging dir on a target node, chosen on the SAME volume as the
/// final path so `Move-Item` is a rename, not a second full copy of a
/// multi-GB file (staging on `C:` while the target sits on `D:` doubled the
/// write). Space-free so scp needs no remote quoting. The dir is FIXED (no
/// per-job subdir — a skipped transfer would leave an empty dir behind every
/// repeat distribute); concurrency safety comes from the job-unique staged
/// file name instead. `receive-transfer.ps1` creates it in preflight and
/// removes the staged FILE after install. Falls back to `C:` when the target
/// path isn't drive-rooted.
fn staging_dir_win(target_local: &str) -> String {
    let drive = target_local
        .as_bytes()
        .first()
        .copied()
        .filter(|c| c.is_ascii_alphabetic() && target_local.as_bytes().get(1) == Some(&b':'))
        .map(|c| c as char)
        .unwrap_or('C');
    format!("{drive}:\\VoloTransfer\\in")
}

fn staging_dir_fwd(target_local: &str) -> String {
    staging_dir_win(target_local).replace('\\', "/")
}

/// The job-unique staged file name on targets (scp names the remote file
/// explicitly, decoupled from the local file name).
pub fn staged_leaf(job_id: &str) -> String {
    format!("{job_id}.bin")
}

/// The source file resolved onto the operator machine, ready to push.
pub struct PushSource {
    pub local_file: PathBuf,
    pub expected_size: i64,
    /// Set when the file was pulled from a remote source into a temp dir the
    /// caller must clean up via `cleanup()` after the job.
    temp_dir: Option<PathBuf>,
}

impl PushSource {
    pub fn cleanup(&self) {
        if let Some(dir) = &self.temp_dir {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

/// Build per-target plan items for a push job. Same target validation as the
/// SMB `pak_distribute::plan` (every target must have a project location; the
/// source is skipped), but no share/UNC resolution — `source_unc` is a display
/// marker only.
pub fn plan_push(
    db: &Db,
    source_machine_id: i64,
    source_host: &str,
    target_machine_ids: &[i64],
    project_id: i64,
    target_subdir: &str,
    file_name: &str,
) -> VoloResult<Vec<DistributePlanItem>> {
    if target_machine_ids.is_empty() {
        return Err(VoloError::InvalidInput("no target machines".into()));
    }
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
            source_unc: format!("ssh-push://{}", source_host),
            target_local: join_win(&location.abs_path, target_subdir),
            file_name: Some(file_name.to_string()),
            source_smb_user: None,
            source_smb_pass: None,
        });
    }
    Ok(out)
}

fn join_win(base: &str, sub: &str) -> String {
    let base = base.trim_end_matches(['\\', '/']);
    let sub = sub.trim_matches(['\\', '/']).replace('/', "\\");
    if sub.is_empty() {
        base.to_string()
    } else {
        format!("{}\\{}", base, sub)
    }
}

#[derive(Debug, Deserialize)]
struct StageOutRaw {
    ok: bool,
    #[serde(default)]
    size: String,
    #[serde(default)]
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ReceiveRaw {
    ok: bool,
    #[serde(default)]
    exit_code: String,
    #[serde(default)]
    bytes_copied: String,
    #[serde(default)]
    stdout_tail: String,
    #[serde(default)]
    message: Option<String>,
    /// Preflight only: size of the file already at the final path, -1 if none.
    #[serde(default)]
    existing_size: String,
}

/// Resolve the source file onto the operator. `source_file` is the full
/// Windows path on the source machine (project dir + subdir + file name).
pub fn acquire_source(source_host: &str, source_file: &str, job_id: &str) -> VoloResult<PushSource> {
    if crate::core::loopback::is_loopback_target(source_host) {
        let meta = std::fs::metadata(source_file).map_err(|e| {
            VoloError::InvalidInput(format!("source file missing: {} ({e})", source_file))
        })?;
        return Ok(PushSource {
            local_file: PathBuf::from(source_file),
            expected_size: meta.len() as i64,
            temp_dir: None,
        });
    }
    let exec = SshExecutor::from_config()?;
    let staged_name = format!("{job_id}.bin");
    let raw: StageOutRaw = run_json(
        &exec,
        source_host,
        &NodeScript {
            name: "stage-transfer-out.ps1",
            args: serde_json::json!({ "SourcePath": source_file, "StagedName": staged_name }),
            ssh_user: None,
        },
    )?;
    if !raw.ok {
        return Err(VoloError::OperationFailed(format!(
            "staging source file on {} failed: {}",
            source_host,
            raw.message.unwrap_or_default()
        )));
    }
    let expected_size: i64 = raw.size.parse().unwrap_or(0);
    let temp_dir = std::env::temp_dir().join(format!("volo-push-{job_id}"));
    std::fs::create_dir_all(&temp_dir)
        .map_err(|e| VoloError::OperationFailed(format!("create temp dir failed: {e}")))?;
    let local_file = temp_dir.join(&staged_name);
    ssh::scp_pull(
        &exec.key_path,
        &exec.known_hosts,
        &exec.default_user,
        source_host,
        &format!("{TRANSFER_OUT_ROOT_FWD}/{staged_name}"),
        &local_file,
    )?;
    let pulled = std::fs::metadata(&local_file).map(|m| m.len() as i64).unwrap_or(-1);
    if expected_size > 0 && pulled != expected_size {
        let _ = std::fs::remove_dir_all(&temp_dir);
        return Err(VoloError::OperationFailed(format!(
            "pulled source file size mismatch: expected {expected_size}, got {pulled}"
        )));
    }
    Ok(PushSource {
        local_file,
        expected_size,
        temp_dir: Some(temp_dir),
    })
}

fn receive_args(item: &DistributePlanItem, job_id: &str, expected_size: i64, preflight: bool) -> serde_json::Value {
    serde_json::json!({
        "StagingDir": staging_dir_win(&item.target_local),
        "StagedName": staged_leaf(job_id),
        "TargetLocal": item.target_local,
        "FileName": item.file_name.as_deref().unwrap_or_default(),
        "ExpectedSize": expected_size,
        "PreflightOnly": preflight,
    })
}

/// Preflight one target: create the staging dir (so the scp that follows has
/// a destination) and write-probe the final dir — a permission problem
/// surfaces before the multi-GB transfer, not after it. Returns the size of
/// the file already at the final path (`None` if absent), so callers can skip
/// the transfer when the target already holds an identical-size copy — the
/// robocopy path's same-file skip semantics, and the reason repeat distributes
/// used to complete in seconds.
pub fn preflight_push_one(
    item: &DistributePlanItem,
    job_id: &str,
) -> VoloResult<Option<i64>> {
    if crate::core::loopback::is_loopback_target(&item.target_host) {
        std::fs::create_dir_all(&item.target_local).map_err(|e| {
            VoloError::OperationFailed(format!(
                "cannot create {}: {e}",
                item.target_local
            ))
        })?;
        let final_path = Path::new(&item.target_local)
            .join(item.file_name.as_deref().unwrap_or_default());
        return Ok(std::fs::metadata(final_path).ok().map(|m| m.len() as i64));
    }
    let exec = SshExecutor::from_config()?;
    let raw: ReceiveRaw = run_json(
        &exec,
        &item.target_host,
        &NodeScript {
            name: "receive-transfer.ps1",
            args: receive_args(item, job_id, 0, true),
            ssh_user: None,
        },
    )?;
    if !raw.ok {
        return Err(VoloError::OperationFailed(
            raw.message.unwrap_or_else(|| "push preflight failed".into()),
        ));
    }
    Ok(raw.existing_size.parse::<i64>().ok().filter(|s| *s >= 0))
}

/// Current byte count of the staged file on a target while scp is writing it
/// (-1 → not created yet). One cheap SSH round-trip; progress pollers call
/// this every few seconds and convert bytes into UI progress events.
pub fn query_staged_size(item: &DistributePlanItem, job_id: &str) -> VoloResult<i64> {
    #[derive(Deserialize)]
    struct SizeRaw {
        ok: bool,
        #[serde(default)]
        size: String,
    }
    let exec = SshExecutor::from_config()?;
    let path = format!("{}\\{}", staging_dir_win(&item.target_local), staged_leaf(job_id));
    let raw: SizeRaw = run_json(
        &exec,
        &item.target_host,
        &NodeScript {
            name: "probe-transfer-size.ps1",
            args: serde_json::json!({ "Path": path }),
            ssh_user: None,
        },
    )?;
    if !raw.ok {
        return Ok(-1);
    }
    Ok(raw.size.parse().unwrap_or(-1))
}

/// Push the source file to one target and install it at the final path.
pub fn push_one(item: &DistributePlanItem, source: &PushSource, job_id: &str) -> VoloResult<DistributeOutcome> {
    let file_name = item.file_name.clone().unwrap_or_default();
    if crate::core::loopback::is_loopback_target(&item.target_host) {
        // Local target: plain filesystem copy (no SSH round-trip to self).
        std::fs::create_dir_all(&item.target_local)
            .map_err(|e| VoloError::OperationFailed(format!("create {} failed: {e}", item.target_local)))?;
        let dest = Path::new(&item.target_local).join(&file_name);
        let bytes = std::fs::copy(&source.local_file, &dest)
            .map_err(|e| VoloError::OperationFailed(format!("copy to {} failed: {e}", dest.display())))?;
        return Ok(DistributeOutcome {
            target_machine_id: item.target_machine_id,
            ok: true,
            exit_code: 0,
            bytes_copied: bytes as i64,
            stdout_tail: format!("installed {}", dest.display()),
            message: None,
        });
    }
    let exec = SshExecutor::from_config()?;
    ssh::scp_push_file(
        &exec.key_path,
        &exec.known_hosts,
        &exec.default_user,
        &item.target_host,
        &source.local_file,
        &format!("{}/{}", staging_dir_fwd(&item.target_local), staged_leaf(job_id)),
    )?;
    let raw: ReceiveRaw = run_json(
        &exec,
        &item.target_host,
        &NodeScript {
            name: "receive-transfer.ps1",
            args: receive_args(item, job_id, source.expected_size, false),
            ssh_user: None,
        },
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

    #[test]
    fn plan_push_builds_targets_and_skips_source() {
        let (db, source, target, project_id) = setup();
        project_locations::upsert(
            &db,
            &crate::data::project_locations::ProjectLocation {
                id: None,
                project_id,
                machine_id: target,
                abs_path: "E:\\Unreal Projects\\X".into(),
                uproject_path: "E:\\Unreal Projects\\X\\X.uproject".into(),
                discovery_status: crate::data::DiscoveryStatus::Auto,
                discovered_at: None,
                ue_version_major: None,
                ue_version_minor: None,
            },
        )
        .unwrap();
        let items = plan_push(
            &db,
            source,
            "1.1.1.1",
            &[source, target],
            project_id,
            "DerivedDataCache",
            "DDC.ddp",
        )
        .unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].target_local, "E:\\Unreal Projects\\X\\DerivedDataCache");
        assert_eq!(items[0].file_name.as_deref(), Some("DDC.ddp"));
        assert_eq!(items[0].source_unc, "ssh-push://1.1.1.1");
    }

    #[test]
    fn plan_push_errors_on_missing_target_location() {
        let (db, source, target, project_id) = setup();
        let result = plan_push(&db, source, "1.1.1.1", &[target], project_id, "DerivedDataCache", "DDC.ddp");
        assert!(matches!(result, Err(VoloError::InvalidInput(_))));
    }

    #[test]
    fn receive_args_shape_matches_script_contract() {
        let item = DistributePlanItem {
            target_machine_id: 2,
            target_host: "2.2.2.2".into(),
            source_unc: "ssh-push://1.1.1.1".into(),
            target_local: "D:\\Unreal Projects\\X\\DerivedDataCache".into(),
            file_name: Some("DDC.ddp".into()),
            source_smb_user: None,
            source_smb_pass: None,
        };
        let v = receive_args(&item, "job1", 42, true);
        // Staging sits on the SAME volume as the final path (D:), so the
        // install Move-Item is a rename, not a second full copy; the staged
        // name is job-unique (fixed dir, no per-job subdir to leak).
        assert_eq!(v["StagingDir"], "D:\\VoloTransfer\\in");
        assert_eq!(v["StagedName"], "job1.bin");
        assert_eq!(v["FileName"], "DDC.ddp");
        assert_eq!(v["ExpectedSize"], 42);
        assert_eq!(v["PreflightOnly"], true);
    }
}
