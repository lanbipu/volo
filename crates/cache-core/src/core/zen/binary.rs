//! Zen binary detection: parse + persist for the PS sidecar's scan output.
//!
//! Plan 7 v4 install-path-primary semantics (see
//! `docs/research/zen-launch-mechanism.md` §3):
//!
//!   * One running zen install per host at
//!     `%LOCALAPPDATA%\UnrealEngine\Common\Zen\Install\` — this is what
//!     `zenserver.exe` actually launches from. Version follows "max version
//!     seen": the install upgrades whenever a newer UE editor is opened and
//!     stays at that version.
//!   * Each UE install ships its own InTree copy at
//!     `<UE_root>\Engine\Binaries\Win64\{zen.exe, zenserver.exe}` plus a
//!     sidecar `zen.version`. UE editor picks install vs InTree at startup by
//!     version compare.
//!
//! R016 / R018 integrity checks consult the **install** copy. InTree copies
//! are reference-only (drift = informational, not alarm).
//!
//! # JSON contract with the PS sidecar (T1.8 `zen-detect-binary.ps1`)
//!
//! This module is the source of truth for the schema:
//!
//! ```json
//! {
//!   "install": {
//!     "install_dir": "C:\\Users\\foo\\AppData\\Local\\UnrealEngine\\Common\\Zen\\Install",
//!     "zen_cli":   { "path": "...", "build_version": "5.8.10-202605071938-...", "sha256": "925cb..." },
//!     "zenserver": { "path": "...", "build_version": "...", "sha256": "..." }
//!   },
//!   "intree": [
//!     {
//!       "ue_major": 5, "ue_minor": 7,
//!       "ue_install_path": "D:\\Program Files\\Epic Games\\UE_5.7",
//!       "zen_cli":   { "path": "...", "version": "5.7.6-...", "sha256": "..." },
//!       "zenserver": { "path": "...", "version": "...", "sha256": "..." }
//!     }
//!   ],
//!   "warnings": ["UE_5.5 zenserver.exe missing"]
//! }
//! ```
//!
//! - `install` is null/absent when the install dir doesn't exist on the host
//!   (machine has never opened a UE 5.4+ editor).
//! - Per-binary sub-objects can have any subset of nullable fields. An absent
//!   file collapses the whole sub-object to null. The parser is intentionally
//!   lenient — a missing field becomes `None`, never an error.
//! - `warnings` is optional; treated as empty Vec when absent.
//!
//! # TODO(plan7 T1.9)
//!
//! Wire up the actual remote invocation: run `zen-detect-binary.ps1` via
//! `core::powershell`, feed stdout to [`parse_detection_json`], then call
//! [`persist`]. This module deliberately stops at the parse + persist
//! boundary so it stays unit-testable without WinRM.

use crate::data::{
    machine_ue_installs::{self, UeInstall},
    machine_zen_install::{self, MachineZenInstall},
    zen_binary_expected::{self, ZenBinaryExpected},
    zen_binary_intree::{self, ZenBinaryIntree},
    Db,
};
use crate::error::{VoloError, VoloResult};
use serde::Deserialize;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// One full remote scan: a single install record (or none, when the install
/// dir is absent) plus N InTree records (one per UE install detected on the
/// host).
#[derive(Debug, Clone, PartialEq)]
pub struct BinaryDetection {
    pub install: Option<InstallBinaries>,
    pub intree: Vec<IntreeBinaries>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct InstallBinaries {
    pub install_dir: String,
    pub zen_cli_path: Option<String>,
    pub zen_cli_build_version: Option<String>,
    pub zen_cli_sha256: Option<String>,
    pub zenserver_path: Option<String>,
    pub zenserver_build_version: Option<String>,
    pub zenserver_sha256: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct IntreeBinaries {
    pub ue_version_major: i64,
    pub ue_version_minor: i64,
    pub ue_install_path: String, // e.g. D:\Program Files\Epic Games\UE_5.7
    pub zen_cli_path: Option<String>,
    pub zen_cli_version: Option<String>,
    pub zen_cli_sha256: Option<String>,
    pub zenserver_path: Option<String>,
    pub zenserver_version: Option<String>,
    pub zenserver_sha256: Option<String>,
}

/// Bookkeeping for [`persist`]: lets the caller assert about side-effects
/// without having to round-trip the DB.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PersistReport {
    /// Set when the install record was written (i.e. detection.install was
    /// Some).
    pub install_record_written: bool,
    /// Set when a previously-persisted `machine_zen_install` row was removed
    /// because detection.install came back None — guards against stale
    /// state surviving uninstalls.
    pub install_record_cleared: bool,
    /// Number of `machine_ue_installs` rows updated with intree_* columns.
    pub intree_records_written: usize,
    /// Number of fresh baseline rows recorded in `zen_binary_expected`. Reads
    /// out as 0 on subsequent scans of the same machine (first-write-wins).
    pub baseline_new_rows: usize,
    /// Number of reference rows written/refreshed in `zen_binary_intree`.
    pub intree_ref_rows: usize,
    /// Per-row issues observed while persisting (e.g. an InTree entry for a
    /// UE version that hasn't been discovered yet via the UE-installs scan
    /// path). These bubble up alongside any warnings the PS sidecar reported.
    pub warnings: Vec<String>,
}

// Binary kind discriminators used in `zen_binary_expected` and
// `zen_binary_intree`. Keep these stable — they're persisted in SQLite.
const KIND_ZEN_CLI: &str = "zen_cli";
const KIND_ZENSERVER: &str = "zenserver";

// ---------------------------------------------------------------------------
// JSON DTOs (deserialize-only; we never produce this shape)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct DetectionJson {
    #[serde(default)]
    install: Option<InstallJson>,
    #[serde(default)]
    intree: Vec<IntreeJson>,
    #[serde(default)]
    warnings: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct InstallJson {
    install_dir: String,
    #[serde(default)]
    zen_cli: Option<InstallBinaryJson>,
    #[serde(default)]
    zenserver: Option<InstallBinaryJson>,
}

#[derive(Debug, Deserialize)]
struct InstallBinaryJson {
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    build_version: Option<String>,
    #[serde(default)]
    sha256: Option<String>,
}

#[derive(Debug, Deserialize)]
struct IntreeJson {
    ue_major: i64,
    ue_minor: i64,
    ue_install_path: String,
    #[serde(default)]
    zen_cli: Option<IntreeBinaryJson>,
    #[serde(default)]
    zenserver: Option<IntreeBinaryJson>,
}

#[derive(Debug, Deserialize)]
struct IntreeBinaryJson {
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    sha256: Option<String>,
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Parse the JSON payload emitted by `zen-detect-binary.ps1`. Returns
/// [`VoloError::InvalidInput`] with the underlying parse error wrapped in the
/// message when the input is malformed.
pub fn parse_detection_json(json: &str) -> VoloResult<BinaryDetection> {
    let raw: DetectionJson = serde_json::from_str(json)
        .map_err(|e| VoloError::InvalidInput(format!("zen-detect-binary JSON parse error: {e}")))?;

    let install = raw.install.map(|i| {
        let (cli_path, cli_ver, cli_sha) = split_install_bin(i.zen_cli);
        let (srv_path, srv_ver, srv_sha) = split_install_bin(i.zenserver);
        InstallBinaries {
            install_dir: i.install_dir,
            zen_cli_path: cli_path,
            zen_cli_build_version: cli_ver,
            zen_cli_sha256: cli_sha,
            zenserver_path: srv_path,
            zenserver_build_version: srv_ver,
            zenserver_sha256: srv_sha,
        }
    });

    let intree = raw
        .intree
        .into_iter()
        .map(|t| {
            let (cli_path, cli_ver, cli_sha) = split_intree_bin(t.zen_cli);
            let (srv_path, srv_ver, srv_sha) = split_intree_bin(t.zenserver);
            IntreeBinaries {
                ue_version_major: t.ue_major,
                ue_version_minor: t.ue_minor,
                ue_install_path: t.ue_install_path,
                zen_cli_path: cli_path,
                zen_cli_version: cli_ver,
                zen_cli_sha256: cli_sha,
                zenserver_path: srv_path,
                zenserver_version: srv_ver,
                zenserver_sha256: srv_sha,
            }
        })
        .collect();

    Ok(BinaryDetection {
        install,
        intree,
        warnings: raw.warnings,
    })
}

/// Persist a [`BinaryDetection`]. Writes:
///
///   1. `machine_zen_install` (one row, only when `detection.install` is Some).
///   2. `zen_binary_expected` baselines via [`zen_binary_expected::insert_baseline`]
///      (first-write-wins — never overwrites a recorded baseline).
///   3. `zen_binary_intree` reference rows (one per InTree binary).
///   4. `machine_ue_installs` intree_* columns for each InTree entry **only
///      when the UE row already exists**. T1.6 intentionally does NOT
///      synthesise UE-installs rows from binary scans; UE discovery owns that
///      table. Missing rows are recorded in `PersistReport.warnings` and
///      skipped silently otherwise.
///
/// Returns a [`PersistReport`] describing exactly what touched the DB.
pub fn persist(
    db: &Db,
    machine_id: i64,
    detection: &BinaryDetection,
) -> VoloResult<PersistReport> {
    let mut report = PersistReport {
        warnings: detection.warnings.clone(),
        ..Default::default()
    };

    match &detection.install {
        Some(install) => {
            write_install_record(db, machine_id, install)?;
            report.install_record_written = true;
            report.baseline_new_rows += write_install_baselines(db, install)?;
        }
        None => {
            // Machine no longer reports an install dir (UE 5.4+ never opened,
            // or %LOCALAPPDATA%\UnrealEngine\Common\Zen\Install was wiped).
            // Drop any stale row so R016 / R018 don't keep checking a path
            // and sha256 that no longer exist on the host.
            let removed = machine_zen_install::delete(db, machine_id)?;
            if removed {
                report.install_record_cleared = true;
                report.warnings.push(format!(
                    "machine {} no longer reports a zen install dir; cleared stale machine_zen_install row",
                    machine_id
                ));
                tracing::warn!(
                    target: "zen.binary",
                    machine_id,
                    "cleared stale machine_zen_install row (install dir gone)"
                );
            }
        }
    }

    for entry in &detection.intree {
        // Reference table first — it's the cheap, no-precondition write.
        report.intree_ref_rows += write_intree_reference(db, entry)?;
        // Then the per-machine join row, but only if discovery already
        // recorded the UE install. We never invent rows from thin air here.
        match machine_ue_installs::find(db, machine_id, entry.ue_version_major, entry.ue_version_minor)? {
            Some(existing) => {
                let updated = with_intree_columns(existing, entry);
                machine_ue_installs::upsert(db, &updated)?;
                report.intree_records_written += 1;
            }
            None => {
                let warn = format!(
                    "skipping intree update for UE {}.{}: no machine_ue_installs row \
                     for machine_id={} (run discovery first)",
                    entry.ue_version_major, entry.ue_version_minor, machine_id
                );
                tracing::warn!("{warn}");
                report.warnings.push(warn);
            }
        }
    }

    Ok(report)
}

/// True when a detect-binary run produced nothing usable: it saw intree
/// candidates but skipped them all (no `machine_ue_installs` row → operator
/// forgot `machine refresh`) AND wrote no install-dir record either. Callers
/// turn this into a per-machine failure so the empty result never looks like
/// success and silently breaks the downstream service install.
pub fn detect_yielded_nothing(detection: &BinaryDetection, report: &PersistReport) -> bool {
    !report.install_record_written
        && !detection.intree.is_empty()
        && report.intree_records_written == 0
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn split_install_bin(
    bin: Option<InstallBinaryJson>,
) -> (Option<String>, Option<String>, Option<String>) {
    match bin {
        Some(b) => (b.path, b.build_version, b.sha256),
        None => (None, None, None),
    }
}

fn split_intree_bin(
    bin: Option<IntreeBinaryJson>,
) -> (Option<String>, Option<String>, Option<String>) {
    match bin {
        Some(b) => (b.path, b.version, b.sha256),
        None => (None, None, None),
    }
}

fn write_install_record(db: &Db, machine_id: i64, install: &InstallBinaries) -> VoloResult<()> {
    machine_zen_install::upsert(
        db,
        &MachineZenInstall {
            machine_id,
            install_dir: Some(install.install_dir.clone()),
            zen_cli_path: install.zen_cli_path.clone(),
            zen_cli_build_version: install.zen_cli_build_version.clone(),
            zen_cli_sha256: install.zen_cli_sha256.clone(),
            zenserver_path: install.zenserver_path.clone(),
            zenserver_build_version: install.zenserver_build_version.clone(),
            zenserver_sha256: install.zenserver_sha256.clone(),
            last_detected_at: None,
        },
    )
}

/// Insert baseline rows for each install binary that has both a version and a
/// sha256 to anchor. Returns the number of *new* rows written (first-write-
/// wins; duplicate PKs are no-ops).
fn write_install_baselines(db: &Db, install: &InstallBinaries) -> VoloResult<usize> {
    let mut n = 0;
    if let (Some(v), Some(s)) = (
        install.zen_cli_build_version.as_ref(),
        install.zen_cli_sha256.as_ref(),
    ) {
        let inserted = zen_binary_expected::insert_baseline(
            db,
            &ZenBinaryExpected {
                zen_build_version: v.clone(),
                binary_kind: KIND_ZEN_CLI.to_string(),
                sha256: s.clone(),
                locked_by: None,
                first_seen_at: None,
            },
        )?;
        if inserted {
            n += 1;
        }
    }
    if let (Some(v), Some(s)) = (
        install.zenserver_build_version.as_ref(),
        install.zenserver_sha256.as_ref(),
    ) {
        let inserted = zen_binary_expected::insert_baseline(
            db,
            &ZenBinaryExpected {
                zen_build_version: v.clone(),
                binary_kind: KIND_ZENSERVER.to_string(),
                sha256: s.clone(),
                locked_by: None,
                first_seen_at: None,
            },
        )?;
        if inserted {
            n += 1;
        }
    }
    Ok(n)
}

/// Writes reference rows for whichever InTree binaries are present. Returns
/// the count of rows touched (upsert doesn't distinguish insert vs update;
/// callers just need a non-zero signal that the reference table was hit).
fn write_intree_reference(db: &Db, entry: &IntreeBinaries) -> VoloResult<usize> {
    let mut n = 0;
    if entry.zen_cli_path.is_some()
        || entry.zen_cli_version.is_some()
        || entry.zen_cli_sha256.is_some()
    {
        zen_binary_intree::upsert(
            db,
            &ZenBinaryIntree {
                ue_version_major: entry.ue_version_major,
                ue_version_minor: entry.ue_version_minor,
                binary_kind: KIND_ZEN_CLI.to_string(),
                build_version: entry.zen_cli_version.clone(),
                sha256: entry.zen_cli_sha256.clone(),
                last_seen_at: None,
            },
        )?;
        n += 1;
    }
    if entry.zenserver_path.is_some()
        || entry.zenserver_version.is_some()
        || entry.zenserver_sha256.is_some()
    {
        zen_binary_intree::upsert(
            db,
            &ZenBinaryIntree {
                ue_version_major: entry.ue_version_major,
                ue_version_minor: entry.ue_version_minor,
                binary_kind: KIND_ZENSERVER.to_string(),
                build_version: entry.zenserver_version.clone(),
                sha256: entry.zenserver_sha256.clone(),
                last_seen_at: None,
            },
        )?;
        n += 1;
    }
    Ok(n)
}

fn with_intree_columns(mut existing: UeInstall, entry: &IntreeBinaries) -> UeInstall {
    existing.zen_cli_intree_path = entry.zen_cli_path.clone();
    existing.zen_cli_intree_version = entry.zen_cli_version.clone();
    existing.zen_cli_intree_sha256 = entry.zen_cli_sha256.clone();
    existing.zenserver_intree_path = entry.zenserver_path.clone();
    existing.zenserver_intree_version = entry.zenserver_version.clone();
    existing.zenserver_intree_sha256 = entry.zenserver_sha256.clone();
    existing
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::{machines, open_in_memory, schema, Machine};

    // ----- Test fixtures ----------------------------------------------------

    fn db_with_machine() -> (Db, i64) {
        let db = open_in_memory().unwrap();
        {
            let mut conn = db.lock().unwrap();
            schema::migrate(&mut conn).unwrap();
        }
        let machine_id =
            machines::insert(&db, &Machine::new("ZEN-01", "192.168.10.30")).unwrap();
        (db, machine_id)
    }

    fn seed_ue_install(db: &Db, machine_id: i64, major: i64, minor: i64, path: &str) {
        machine_ue_installs::upsert(
            db,
            &UeInstall {
                id: None,
                machine_id,
                version: format!("{major}.{minor}"),
                install_path: path.into(),
                is_primary: false,
                zen_cli_intree_path: None,
                zen_cli_intree_version: None,
                zen_cli_intree_sha256: None,
                zenserver_intree_path: None,
                zenserver_intree_version: None,
                zenserver_intree_sha256: None,
            },
        )
        .unwrap();
    }

    fn full_install() -> InstallBinaries {
        InstallBinaries {
            install_dir: "C:\\Users\\foo\\AppData\\Local\\UnrealEngine\\Common\\Zen\\Install".into(),
            zen_cli_path: Some("...\\zen.exe".into()),
            zen_cli_build_version: Some("5.8.10-202605071938-windows-x64-release-fbacdecd".into()),
            zen_cli_sha256: Some("aaaa1111".into()),
            zenserver_path: Some("...\\zenserver.exe".into()),
            zenserver_build_version: Some("5.8.10-202605071938-windows-x64-release-fbacdecd".into()),
            zenserver_sha256: Some("bbbb2222".into()),
        }
    }

    fn full_detection() -> BinaryDetection {
        BinaryDetection {
            install: Some(full_install()),
            intree: vec![],
            warnings: vec![],
        }
    }

    // ----- JSON parse tests -------------------------------------------------

    #[test]
    fn parse_detection_json_happy_path() {
        let json = r#"{
            "install": {
                "install_dir": "C:\\Users\\foo\\AppData\\Local\\UnrealEngine\\Common\\Zen\\Install",
                "zen_cli":   { "path": "C:\\zen.exe",       "build_version": "5.8.10-aaa", "sha256": "925cb272" },
                "zenserver": { "path": "C:\\zenserver.exe", "build_version": "5.8.10-aaa", "sha256": "abcdef01" }
            },
            "intree": [
                {
                    "ue_major": 5, "ue_minor": 7,
                    "ue_install_path": "D:\\Program Files\\Epic Games\\UE_5.7",
                    "zen_cli":   { "path": "D:\\57\\zen.exe",       "version": "5.7.6-x", "sha256": "deadbeef" },
                    "zenserver": { "path": "D:\\57\\zenserver.exe", "version": "5.7.6-x", "sha256": "feedface" }
                },
                {
                    "ue_major": 5, "ue_minor": 8,
                    "ue_install_path": "D:\\Program Files\\Epic Games\\UE_5.8",
                    "zen_cli":   { "path": "D:\\58\\zen.exe",       "version": "5.8.10-x", "sha256": "11112222" },
                    "zenserver": { "path": "D:\\58\\zenserver.exe", "version": "5.8.10-x", "sha256": "33334444" }
                }
            ],
            "warnings": ["UE_5.5 zenserver.exe missing"]
        }"#;
        let got = parse_detection_json(json).unwrap();
        let install = got.install.as_ref().expect("install present");
        assert_eq!(install.zen_cli_build_version.as_deref(), Some("5.8.10-aaa"));
        assert_eq!(install.zenserver_sha256.as_deref(), Some("abcdef01"));
        assert_eq!(got.intree.len(), 2);
        assert_eq!(got.intree[0].ue_version_major, 5);
        assert_eq!(got.intree[0].ue_version_minor, 7);
        assert_eq!(got.intree[1].zen_cli_sha256.as_deref(), Some("11112222"));
        assert_eq!(got.warnings, vec!["UE_5.5 zenserver.exe missing".to_string()]);
    }

    #[test]
    fn parse_detection_json_missing_install_yields_none() {
        let json = r#"{ "install": null, "intree": [], "warnings": [] }"#;
        let got = parse_detection_json(json).unwrap();
        assert!(got.install.is_none());
        assert!(got.intree.is_empty());
        assert!(got.warnings.is_empty());

        // Same when the install key is absent entirely.
        let json2 = r#"{ "intree": [] }"#;
        let got2 = parse_detection_json(json2).unwrap();
        assert!(got2.install.is_none());
    }

    #[test]
    fn parse_detection_json_missing_intree_yields_empty_vec() {
        let json = r#"{ "install": null }"#;
        let got = parse_detection_json(json).unwrap();
        assert!(got.intree.is_empty());
    }

    #[test]
    fn parse_detection_json_warnings_optional() {
        let json = r#"{ "install": null, "intree": [] }"#;
        let got = parse_detection_json(json).unwrap();
        assert!(got.warnings.is_empty());
    }

    #[test]
    fn parse_detection_json_individual_binary_missing() {
        // install present, but zen_cli is null → install.zen_cli_* fields None,
        // zenserver_* populated.
        let json = r#"{
            "install": {
                "install_dir": "C:\\Install",
                "zen_cli": null,
                "zenserver": { "path": "C:\\zenserver.exe", "build_version": "5.8.10", "sha256": "ddee" }
            }
        }"#;
        let got = parse_detection_json(json).unwrap();
        let i = got.install.unwrap();
        assert!(i.zen_cli_path.is_none());
        assert!(i.zen_cli_build_version.is_none());
        assert!(i.zen_cli_sha256.is_none());
        assert_eq!(i.zenserver_path.as_deref(), Some("C:\\zenserver.exe"));
        assert_eq!(i.zenserver_sha256.as_deref(), Some("ddee"));
    }

    #[test]
    fn parse_detection_json_rejects_malformed() {
        let err = parse_detection_json("not json at all").unwrap_err();
        match err {
            VoloError::InvalidInput(msg) => {
                assert!(
                    msg.contains("zen-detect-binary JSON parse error"),
                    "expected wrapped parse error, got: {msg}"
                );
            }
            other => panic!("expected InvalidInput, got {other:?}"),
        }
    }

    // ----- Persistence tests ------------------------------------------------

    #[test]
    fn persist_writes_install_row() {
        let (db, machine_id) = db_with_machine();
        let report = persist(&db, machine_id, &full_detection()).unwrap();
        assert!(report.install_record_written);

        let got = machine_zen_install::find(&db, machine_id).unwrap().unwrap();
        assert_eq!(
            got.install_dir.as_deref(),
            Some("C:\\Users\\foo\\AppData\\Local\\UnrealEngine\\Common\\Zen\\Install")
        );
        assert_eq!(got.zen_cli_sha256.as_deref(), Some("aaaa1111"));
        assert_eq!(got.zenserver_sha256.as_deref(), Some("bbbb2222"));
    }

    #[test]
    fn persist_creates_baseline_rows_first_time() {
        let (db, machine_id) = db_with_machine();
        let report = persist(&db, machine_id, &full_detection()).unwrap();

        // Both zen_cli and zenserver baselines should be fresh writes.
        assert_eq!(report.baseline_new_rows, 2);

        let cli = zen_binary_expected::find(
            &db,
            "5.8.10-202605071938-windows-x64-release-fbacdecd",
            KIND_ZEN_CLI,
        )
        .unwrap()
        .unwrap();
        assert_eq!(cli.sha256, "aaaa1111");

        let srv = zen_binary_expected::find(
            &db,
            "5.8.10-202605071938-windows-x64-release-fbacdecd",
            KIND_ZENSERVER,
        )
        .unwrap()
        .unwrap();
        assert_eq!(srv.sha256, "bbbb2222");
    }

    #[test]
    fn persist_does_not_overwrite_existing_baseline() {
        // R016 contract: a tampered scan must NOT clobber the baseline.
        let (db, machine_id) = db_with_machine();
        zen_binary_expected::insert_baseline(
            &db,
            &ZenBinaryExpected {
                zen_build_version: "5.8.10-202605071938-windows-x64-release-fbacdecd".into(),
                binary_kind: KIND_ZENSERVER.into(),
                sha256: "GOOD_SHA".into(),
                locked_by: None,
                first_seen_at: None,
            },
        )
        .unwrap();

        // Detection ships a different (tampered) sha256 for the same version.
        let mut det = full_detection();
        det.install.as_mut().unwrap().zenserver_sha256 = Some("BAD_SHA".into());
        let report = persist(&db, machine_id, &det).unwrap();

        // Only the cli baseline should be a fresh write; zenserver was a no-op.
        assert_eq!(report.baseline_new_rows, 1);
        let srv = zen_binary_expected::find(
            &db,
            "5.8.10-202605071938-windows-x64-release-fbacdecd",
            KIND_ZENSERVER,
        )
        .unwrap()
        .unwrap();
        assert_eq!(srv.sha256, "GOOD_SHA", "baseline must stay frozen");
    }

    #[test]
    fn persist_intree_rows_skip_when_no_machine_ue_installs_row() {
        let (db, machine_id) = db_with_machine();
        // No UE install seeded. The InTree entry should produce a warning and
        // not touch machine_ue_installs; zen_binary_intree DOES get a row.
        let det = BinaryDetection {
            install: None,
            intree: vec![IntreeBinaries {
                ue_version_major: 5,
                ue_version_minor: 7,
                ue_install_path: "D:\\UE_5.7".into(),
                zen_cli_path: Some("D:\\UE_5.7\\Engine\\Binaries\\Win64\\zen.exe".into()),
                zen_cli_version: Some("5.7.6".into()),
                zen_cli_sha256: Some("cafef00d".into()),
                zenserver_path: None,
                zenserver_version: None,
                zenserver_sha256: None,
            }],
            warnings: vec![],
        };
        let report = persist(&db, machine_id, &det).unwrap();
        assert_eq!(report.intree_records_written, 0);
        assert_eq!(report.intree_ref_rows, 1);
        assert!(
            report.warnings.iter().any(|w| w.contains("UE 5.7")),
            "expected skip warning for UE 5.7, got: {:?}",
            report.warnings
        );

        // Reference row landed.
        let ref_row = zen_binary_intree::find(&db, 5, 7, KIND_ZEN_CLI).unwrap().unwrap();
        assert_eq!(ref_row.sha256.as_deref(), Some("cafef00d"));

        // machine_ue_installs untouched.
        let ue_rows = machine_ue_installs::list_for_machine(&db, machine_id).unwrap();
        assert!(ue_rows.is_empty());
    }

    #[test]
    fn persist_intree_rows_update_existing_machine_ue_installs() {
        let (db, machine_id) = db_with_machine();
        seed_ue_install(&db, machine_id, 5, 7, "D:\\UE_5.7");

        let det = BinaryDetection {
            install: None,
            intree: vec![IntreeBinaries {
                ue_version_major: 5,
                ue_version_minor: 7,
                ue_install_path: "D:\\UE_5.7".into(),
                zen_cli_path: Some("D:\\UE_5.7\\Engine\\Binaries\\Win64\\zen.exe".into()),
                zen_cli_version: Some("5.7.6".into()),
                zen_cli_sha256: Some("cafef00d".into()),
                zenserver_path: Some("D:\\UE_5.7\\Engine\\Binaries\\Win64\\zenserver.exe".into()),
                zenserver_version: Some("5.7.6".into()),
                zenserver_sha256: Some("deadbeef".into()),
            }],
            warnings: vec![],
        };
        let report = persist(&db, machine_id, &det).unwrap();
        assert_eq!(report.intree_records_written, 1);
        assert_eq!(report.intree_ref_rows, 2);

        let got = machine_ue_installs::find(&db, machine_id, 5, 7).unwrap().unwrap();
        assert_eq!(got.zen_cli_intree_sha256.as_deref(), Some("cafef00d"));
        assert_eq!(got.zenserver_intree_sha256.as_deref(), Some("deadbeef"));
        assert_eq!(got.zen_cli_intree_version.as_deref(), Some("5.7.6"));
    }

    #[test]
    fn persist_install_record_no_baseline_when_version_missing() {
        let (db, machine_id) = db_with_machine();
        let det = BinaryDetection {
            install: Some(InstallBinaries {
                install_dir: "C:\\Install".into(),
                zen_cli_path: None,
                zen_cli_build_version: None,
                zen_cli_sha256: None,
                // zenserver has a sha256 but no build_version → can't anchor a
                // baseline row.
                zenserver_path: Some("C:\\zenserver.exe".into()),
                zenserver_build_version: None,
                zenserver_sha256: Some("orphan_sha".into()),
            }),
            intree: vec![],
            warnings: vec![],
        };
        let report = persist(&db, machine_id, &det).unwrap();
        assert!(report.install_record_written);
        assert_eq!(report.baseline_new_rows, 0);

        // The install row still landed even though we recorded no baseline.
        let row = machine_zen_install::find(&db, machine_id).unwrap().unwrap();
        assert_eq!(row.zenserver_sha256.as_deref(), Some("orphan_sha"));

        // Nothing in zen_binary_expected.
        let baselines = zen_binary_expected::list(&db).unwrap();
        assert!(baselines.is_empty());
    }

    #[test]
    fn persist_count_in_report_is_accurate() {
        let (db, machine_id) = db_with_machine();
        seed_ue_install(&db, machine_id, 5, 7, "D:\\UE_5.7");
        seed_ue_install(&db, machine_id, 5, 8, "D:\\UE_5.8");

        let det = BinaryDetection {
            install: Some(full_install()),
            intree: vec![
                IntreeBinaries {
                    ue_version_major: 5,
                    ue_version_minor: 7,
                    ue_install_path: "D:\\UE_5.7".into(),
                    zen_cli_path: Some("D:\\UE_5.7\\zen.exe".into()),
                    zen_cli_version: Some("5.7.6".into()),
                    zen_cli_sha256: Some("aa".into()),
                    zenserver_path: Some("D:\\UE_5.7\\zenserver.exe".into()),
                    zenserver_version: Some("5.7.6".into()),
                    zenserver_sha256: Some("bb".into()),
                },
                IntreeBinaries {
                    ue_version_major: 5,
                    ue_version_minor: 8,
                    ue_install_path: "D:\\UE_5.8".into(),
                    zen_cli_path: Some("D:\\UE_5.8\\zen.exe".into()),
                    zen_cli_version: Some("5.8.10".into()),
                    zen_cli_sha256: Some("cc".into()),
                    zenserver_path: None,
                    zenserver_version: None,
                    zenserver_sha256: None,
                },
            ],
            warnings: vec!["pre-existing".into()],
        };

        let report = persist(&db, machine_id, &det).unwrap();
        assert!(report.install_record_written);
        assert_eq!(report.intree_records_written, 2);
        // 5.7 writes both kinds (2), 5.8 writes only zen_cli (1) → 3 reference rows.
        assert_eq!(report.intree_ref_rows, 3);
        assert_eq!(report.baseline_new_rows, 2);
        assert_eq!(report.warnings, vec!["pre-existing".to_string()]);

        // Verify DB matches the report counts.
        let baselines = zen_binary_expected::list(&db).unwrap();
        assert_eq!(baselines.len(), 2);
        let refs = zen_binary_intree::list(&db).unwrap();
        assert_eq!(refs.len(), 3);

        // Both UE rows now carry intree_* data.
        let ue57 = machine_ue_installs::find(&db, machine_id, 5, 7).unwrap().unwrap();
        assert_eq!(ue57.zen_cli_intree_sha256.as_deref(), Some("aa"));
        assert_eq!(ue57.zenserver_intree_sha256.as_deref(), Some("bb"));
        let ue58 = machine_ue_installs::find(&db, machine_id, 5, 8).unwrap().unwrap();
        assert_eq!(ue58.zen_cli_intree_sha256.as_deref(), Some("cc"));
        assert!(ue58.zenserver_intree_sha256.is_none());
    }

    #[test]
    fn intree_fallback_picks_highest_version_zen_cli() {
        use crate::data::machine_ue_installs::{self, UeInstall};
        let (db, machine_id) = db_with_machine();
        for (ver, path) in [
            ("5.2", r"D:\Epic\UE_5.2\Engine\Binaries\Win64\zen.exe"),
            ("5.8", r"D:\Epic\UE_5.8\Engine\Binaries\Win64\zen.exe"),
        ] {
            machine_ue_installs::upsert(&db, &UeInstall {
                id: None, machine_id, version: ver.into(),
                install_path: format!(r"D:\Epic\UE_{ver}"), is_primary: false,
                zen_cli_intree_path: Some(path.into()),
                zen_cli_intree_version: Some(format!("{ver}.0")),
                zen_cli_intree_sha256: Some("deadbeef".into()),
                zenserver_intree_path: None, zenserver_intree_version: None, zenserver_intree_sha256: None,
            }).unwrap();
        }
        let picked = machine_ue_installs::list_for_machine(&db, machine_id).unwrap()
            .into_iter().find_map(|i| i.zen_cli_intree_path);
        assert_eq!(picked.as_deref(), Some(r"D:\Epic\UE_5.8\Engine\Binaries\Win64\zen.exe"));
    }

    #[test]
    fn intree_fallback_none_when_no_intree_rows() {
        let (db, machine_id) = db_with_machine();
        let picked = crate::data::machine_ue_installs::list_for_machine(&db, machine_id).unwrap()
            .into_iter().find_map(|i| i.zen_cli_intree_path);
        assert!(picked.is_none());
    }

    #[test]
    fn persist_clears_stale_install_row_when_detection_install_is_none() {
        // Plan §1.1 R016/R018 read the install row to check binary integrity.
        // If a machine that had a Zen install (someone opened UE 5.4+ once)
        // later loses %LOCALAPPDATA%\UnrealEngine\Common\Zen\Install (manual
        // wipe / fresh OS image), the next detect-binary scan returns
        // detection.install == None — that stale row must be removed, not
        // silently preserved, or downstream checks compare against a path
        // and sha256 that no longer exist on the host.
        let (db, machine_id) = db_with_machine();

        // First scan: install present, row written.
        persist(&db, machine_id, &full_detection()).unwrap();
        assert!(
            machine_zen_install::find(&db, machine_id).unwrap().is_some(),
            "first persist should record the install"
        );

        // Second scan: install dir gone.
        let detection = BinaryDetection {
            install: None,
            intree: vec![],
            warnings: vec![],
        };
        let report = persist(&db, machine_id, &detection).unwrap();
        assert!(
            machine_zen_install::find(&db, machine_id).unwrap().is_none(),
            "second persist with install=None must clear the row"
        );
        assert!(report.install_record_cleared, "report flags the cleared row");
        assert!(!report.install_record_written);
        assert!(
            report.warnings.iter().any(|w| w.contains("stale machine_zen_install")),
            "warnings must surface the cleared state: {:?}",
            report.warnings
        );

        // Third scan: still no install — should not flip install_record_cleared
        // back on because there's nothing left to clear (idempotent).
        let report = persist(&db, machine_id, &detection).unwrap();
        assert!(
            !report.install_record_cleared,
            "second consecutive no-install run is idempotent — nothing to clear"
        );
    }

    #[test]
    fn detect_yielded_nothing_true_when_intree_all_skipped_and_no_install() {
        let det = BinaryDetection {
            install: None,
            intree: vec![IntreeBinaries {
                ue_version_major: 5, ue_version_minor: 7,
                ue_install_path: "D:\\UE_5.7".into(),
                zen_cli_path: Some("D:\\UE_5.7\\Engine\\Binaries\\Win64\\zen.exe".into()),
                zen_cli_version: Some("5.7.6".into()), zen_cli_sha256: Some("c0ffee".into()),
                zenserver_path: None, zenserver_version: None, zenserver_sha256: None,
            }],
            warnings: vec![],
        };
        let report = PersistReport { install_record_written: false, intree_records_written: 0, ..Default::default() };
        assert!(detect_yielded_nothing(&det, &report));
    }

    #[test]
    fn detect_yielded_nothing_false_when_install_or_intree_written_or_empty() {
        let intree = vec![IntreeBinaries {
            ue_version_major: 5, ue_version_minor: 7, ue_install_path: "D:\\UE_5.7".into(),
            zen_cli_path: None, zen_cli_version: None, zen_cli_sha256: None,
            zenserver_path: None, zenserver_version: None, zenserver_sha256: None,
        }];
        // install record written → false
        let d1 = BinaryDetection { install: None, intree: intree.clone(), warnings: vec![] };
        let r1 = PersistReport { install_record_written: true, intree_records_written: 0, ..Default::default() };
        assert!(!detect_yielded_nothing(&d1, &r1));
        // some intree written → false
        let r2 = PersistReport { install_record_written: false, intree_records_written: 1, ..Default::default() };
        assert!(!detect_yielded_nothing(&d1, &r2));
        // no intree candidates at all (empty machine) → false
        let d3 = BinaryDetection { install: None, intree: vec![], warnings: vec![] };
        let r3 = PersistReport { install_record_written: false, intree_records_written: 0, ..Default::default() };
        assert!(!detect_yielded_nothing(&d3, &r3));
    }
}
