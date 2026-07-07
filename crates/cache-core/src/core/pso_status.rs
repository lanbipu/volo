//! PSO green-light status and conservative invalidation checks.

use crate::data::{
    driver_cache_snapshots, project_locations, pso_invalidation_events, Db, DriverCacheSnapshot,
    PsoInvalidationEvent, PsoInvalidationReason,
};
use crate::error::VoloResult;
use chrono::{DateTime, Duration, NaiveDateTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PsoGreenlightStatus {
    Ok,
    Degraded,
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
pub struct PsoStatusCell {
    pub project_id: i64,
    pub machine_id: i64,
    pub status: PsoGreenlightStatus,
    pub green_run_id: Option<i64>,
    pub green_verified_at: Option<String>,
    pub baseline_snapshot_id: Option<i64>,
    pub latest_snapshot_id: Option<i64>,
    pub invalidation_reasons: Vec<PsoInvalidationEvent>,
}

#[derive(Debug, Clone)]
struct GreenRun {
    id: i64,
    project_id: i64,
    machine_id: i64,
    started_at: String,
    duration_secs: Option<i64>,
}

pub fn list_pso_status(
    db: &Db,
    project_id: i64,
    machine_ids: Option<Vec<i64>>,
) -> VoloResult<Vec<PsoStatusCell>> {
    let target_ids = match machine_ids {
        Some(ids) => dedup(ids),
        None => project_locations::list_by_project(db, project_id)?
            .into_iter()
            .map(|loc| loc.machine_id)
            .collect(),
    };

    let mut out = Vec::with_capacity(target_ids.len());
    for machine_id in target_ids {
        out.push(status_for_machine(db, project_id, machine_id)?);
    }
    Ok(out)
}

fn status_for_machine(db: &Db, project_id: i64, machine_id: i64) -> VoloResult<PsoStatusCell> {
    let Some(green) = latest_green_run(db, project_id, machine_id)? else {
        return Ok(PsoStatusCell {
            project_id,
            machine_id,
            status: PsoGreenlightStatus::None,
            green_run_id: None,
            green_verified_at: None,
            baseline_snapshot_id: None,
            latest_snapshot_id: driver_cache_snapshots::latest_for_machine(db, machine_id)?
                .and_then(|snapshot| snapshot.id),
            invalidation_reasons: Vec::new(),
        });
    };

    let green_verified_at = green_verified_at(&green);
    let baseline =
        driver_cache_snapshots::latest_at_or_before(db, machine_id, &green_verified_at)?;
    let latest = driver_cache_snapshots::latest_for_machine(db, machine_id)?;
    if let (Some(base), Some(current)) = (&baseline, &latest) {
        generate_events(db, &green, &green_verified_at, base, current)?;
    }
    let invalidation_reasons =
        pso_invalidation_events::list_for_warmup(db, project_id, machine_id, green.id)?;
    let status = if invalidation_reasons.is_empty() {
        PsoGreenlightStatus::Ok
    } else {
        PsoGreenlightStatus::Degraded
    };
    Ok(PsoStatusCell {
        project_id: green.project_id,
        machine_id: green.machine_id,
        status,
        green_run_id: Some(green.id),
        green_verified_at: Some(green_verified_at),
        baseline_snapshot_id: baseline.and_then(|snapshot| snapshot.id),
        latest_snapshot_id: latest.and_then(|snapshot| snapshot.id),
        invalidation_reasons,
    })
}

fn latest_green_run(db: &Db, project_id: i64, machine_id: i64) -> VoloResult<Option<GreenRun>> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, project_id, machine_id, started_at, duration_secs
         FROM pso_warmup_runs
         WHERE project_id = ?
           AND machine_id = ?
           AND status = 'ok'
           AND hitch_count = 0
         ORDER BY datetime(started_at) DESC, id DESC
         LIMIT 1",
    )?;
    let mut rows = stmt.query(rusqlite::params![project_id, machine_id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(GreenRun {
            id: row.get(0)?,
            project_id: row.get(1)?,
            machine_id: row.get(2)?,
            started_at: row.get(3)?,
            duration_secs: row.get(4)?,
        }))
    } else {
        Ok(None)
    }
}

fn generate_events(
    db: &Db,
    green: &GreenRun,
    green_verified_at: &str,
    baseline: &DriverCacheSnapshot,
    current: &DriverCacheSnapshot,
) -> VoloResult<()> {
    let Some(snapshot_id) = current.id else {
        return Ok(());
    };
    if baseline.id == current.id {
        return Ok(());
    }
    if changed(&baseline.gpu_driver_version, &current.gpu_driver_version) {
        insert_event(
            db,
            green,
            snapshot_id,
            PsoInvalidationReason::GpuDriverChanged,
            format!(
                "gpu driver changed: {} -> {}",
                display_opt(&baseline.gpu_driver_version),
                display_opt(&current.gpu_driver_version)
            ),
        )?;
    }
    if baseline.total_bytes > 0 && current.total_bytes * 2 < baseline.total_bytes {
        insert_event(
            db,
            green,
            snapshot_id,
            PsoInvalidationReason::CacheShrunk,
            format!("driver cache shrank: {} -> {} bytes", baseline.total_bytes, current.total_bytes),
        )?;
    }
    for detail in missing_directory_details(baseline, current) {
        insert_event(
            db,
            green,
            snapshot_id,
            PsoInvalidationReason::CacheDirectoryMissing,
            detail,
        )?;
    }
    if account_changed(&baseline.interactive_user, &current.interactive_user) {
        insert_event(
            db,
            green,
            snapshot_id,
            PsoInvalidationReason::InteractiveUserChanged,
            format!(
                "interactive user changed: {} -> {}",
                display_opt(&baseline.interactive_user),
                display_opt(&current.interactive_user)
            ),
        )?;
    }
    if rebooted_after_green(current, green_verified_at) {
        insert_event(
            db,
            green,
            snapshot_id,
            PsoInvalidationReason::NodeRebooted,
            format!(
                "node boot time {} is after green light {}",
                display_opt(&current.node_last_boot_time),
                green_verified_at
            ),
        )?;
    }
    Ok(())
}

fn insert_event(
    db: &Db,
    green: &GreenRun,
    snapshot_id: i64,
    reason: PsoInvalidationReason,
    detail: String,
) -> VoloResult<()> {
    pso_invalidation_events::insert_if_absent(
        db,
        &PsoInvalidationEvent {
            id: None,
            project_id: green.project_id,
            machine_id: green.machine_id,
            warmup_run_id: green.id,
            driver_cache_snapshot_id: snapshot_id,
            reason,
            detail,
            detected_at: None,
        },
    )
}

fn missing_directory_details(
    baseline: &DriverCacheSnapshot,
    current: &DriverCacheSnapshot,
) -> Vec<String> {
    let mut out = Vec::new();
    if baseline.local_appdata_dxcache.exists && !current.local_appdata_dxcache.exists {
        out.push(format!(
            "driver cache directory missing: {}",
            current.local_appdata_dxcache.path
        ));
    }
    if baseline.locallow_per_driver_dxcache.exists && !current.locallow_per_driver_dxcache.exists {
        out.push(format!(
            "driver cache directory missing: {}",
            current.locallow_per_driver_dxcache.path
        ));
    }
    out
}

fn changed(before: &Option<String>, after: &Option<String>) -> bool {
    match (before.as_deref().map(str::trim), after.as_deref().map(str::trim)) {
        (Some(a), Some(b)) if !a.is_empty() && !b.is_empty() => a != b,
        _ => false,
    }
}

fn account_changed(before: &Option<String>, after: &Option<String>) -> bool {
    before.as_deref().map(str::trim).unwrap_or_default()
        != after.as_deref().map(str::trim).unwrap_or_default()
}

fn rebooted_after_green(current: &DriverCacheSnapshot, green_verified_at: &str) -> bool {
    let Some(boot) = current.node_last_boot_time.as_deref().and_then(parse_ts) else {
        return false;
    };
    let Some(green) = parse_ts(green_verified_at) else {
        return false;
    };
    boot > green
}

fn green_verified_at(green: &GreenRun) -> String {
    let Some(started) = parse_ts(&green.started_at) else {
        return green.started_at.clone();
    };
    let duration = Duration::seconds(green.duration_secs.unwrap_or(0).max(0));
    started
        .checked_add_signed(duration)
        .unwrap_or(started)
        .format("%Y-%m-%d %H:%M:%S")
        .to_string()
}

fn parse_ts(value: &str) -> Option<DateTime<Utc>> {
    if let Ok(dt) = DateTime::parse_from_rfc3339(value) {
        return Some(dt.with_timezone(&Utc));
    }
    if let Ok(dt) = NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S") {
        return Some(Utc.from_utc_datetime(&dt));
    }
    None
}

fn display_opt(value: &Option<String>) -> &str {
    value.as_deref().unwrap_or("<unknown>")
}

fn dedup(mut ids: Vec<i64>) -> Vec<i64> {
    ids.sort_unstable();
    ids.dedup();
    ids
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::driver_cache_snapshots::{
        DriverCacheDirectorySnapshot, DriverCacheSnapshotInput,
    };
    use crate::data::{
        driver_cache_snapshots, machines, open_in_memory, projects, pso_warmup_runs, schema,
        Machine, Project, WarmupStatus,
    };

    fn setup() -> (Db, i64, i64, i64) {
        let db = open_in_memory().unwrap();
        {
            let mut conn = db.lock().unwrap();
            schema::migrate(&mut conn).unwrap();
        }
        let machine_id = machines::insert(&db, &Machine::new("RENDER-01", "192.168.10.21")).unwrap();
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
        let run_id = pso_warmup_runs::insert_started(
            &db,
            project_id,
            machine_id,
            (1920, 1080),
            1,
            "ndisplay_offscreen",
            Some("Node_0"),
        )
        .unwrap();
        pso_warmup_runs::finish(&db, run_id, WarmupStatus::Ok, Some(0), None, 60, None).unwrap();
        {
            let conn = db.lock().unwrap();
            conn.execute(
                "UPDATE pso_warmup_runs SET started_at = '2026-07-07 10:00:00' WHERE id = ?",
                [run_id],
            )
            .unwrap();
        }
        (db, project_id, machine_id, run_id)
    }

    fn snapshot_input(machine_id: i64, driver: &str, user: &str, bytes: i64) -> DriverCacheSnapshotInput {
        DriverCacheSnapshotInput {
            machine_id,
            gpu_model: Some("RTX 3080".into()),
            gpu_driver_version: Some(driver.into()),
            interactive_user: Some(user.into()),
            node_last_boot_time: Some("2026-07-07T09:00:00Z".into()),
            local_appdata_dxcache: DriverCacheDirectorySnapshot {
                kind: "local_appdata_dxcache".into(),
                path: "A".into(),
                exists: true,
                file_count: 10,
                total_bytes: bytes,
                newest_mtime: None,
            },
            locallow_per_driver_dxcache: DriverCacheDirectorySnapshot {
                kind: "locallow_per_driver_dxcache".into(),
                path: "B".into(),
                exists: false,
                file_count: 0,
                total_bytes: 0,
                newest_mtime: None,
            },
            total_file_count: 10,
            total_bytes: bytes,
            newest_mtime: None,
        }
    }

    fn set_snapshot_time(db: &Db, snapshot_id: i64, captured_at: &str) {
        let conn = db.lock().unwrap();
        conn.execute(
            "UPDATE driver_cache_snapshots SET captured_at = ? WHERE id = ?",
            rusqlite::params![captured_at, snapshot_id],
        )
        .unwrap();
    }

    #[test]
    fn status_is_none_without_green_run() {
        let db = open_in_memory().unwrap();
        {
            let mut conn = db.lock().unwrap();
            schema::migrate(&mut conn).unwrap();
        }
        let rows = list_pso_status(&db, 99, Some(vec![1])).unwrap();
        assert_eq!(rows[0].status, PsoGreenlightStatus::None);
        assert!(rows[0].invalidation_reasons.is_empty());
    }

    #[test]
    fn status_degrades_and_persists_events_for_conservative_invalidations() {
        let (db, project_id, machine_id, _run_id) = setup();
        let baseline = driver_cache_snapshots::insert(
            &db,
            &snapshot_input(machine_id, "546.01", "LANPC\\artist", 1000),
        )
        .unwrap();
        set_snapshot_time(&db, baseline.id.unwrap(), "2026-07-07 10:01:00");
        let mut current_input = snapshot_input(machine_id, "560.02", "LANPC\\other", 100);
        current_input.node_last_boot_time = Some("2026-07-07T10:30:00Z".into());
        current_input.local_appdata_dxcache.exists = false;
        let current = driver_cache_snapshots::insert(&db, &current_input).unwrap();
        set_snapshot_time(&db, current.id.unwrap(), "2026-07-07 11:00:00");

        let rows = list_pso_status(&db, project_id, Some(vec![machine_id])).unwrap();
        assert_eq!(rows[0].status, PsoGreenlightStatus::Degraded);
        let reasons: Vec<PsoInvalidationReason> = rows[0]
            .invalidation_reasons
            .iter()
            .map(|event| event.reason)
            .collect();
        assert!(reasons.contains(&PsoInvalidationReason::GpuDriverChanged));
        assert!(reasons.contains(&PsoInvalidationReason::CacheShrunk));
        assert!(reasons.contains(&PsoInvalidationReason::CacheDirectoryMissing));
        assert!(reasons.contains(&PsoInvalidationReason::InteractiveUserChanged));
        assert!(reasons.contains(&PsoInvalidationReason::NodeRebooted));

        let again = list_pso_status(&db, project_id, Some(vec![machine_id])).unwrap();
        assert_eq!(again[0].invalidation_reasons.len(), rows[0].invalidation_reasons.len());
    }
}
