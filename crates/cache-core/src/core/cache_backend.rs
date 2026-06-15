//! Backend routing for the project × machine cache pair (plan §4.1 / §4.2).
//!
//! Decides whether a `LegacyPak` or `Zen` backend should be used for a given
//! (project, machine) pair based on:
//!
//! 1. An explicit operator override row in `project_cache_backend`
//!    (`backend = 'zen' | 'legacy_pak'` always wins; `'auto'` and absent rows
//!    fall through to the decision table).
//! 2. The project's UE version (`ue_version_major / ue_version_minor` parsed
//!    from `EngineAssociation`; `NULL` → conservative fall-back to legacy_pak).
//! 3. The "best" UE install on the machine — the highest installed version
//!    that's ≥ 5.4, else the highest overall (drives the
//!    "machine only has < 5.4 → legacy_pak" branch).
//! 4. Whether at least one zen endpoint on the machine was probed reachable in
//!    the last 5 minutes. No probes / stale probes → treat as unreachable
//!    (don't gamble on an unprobed endpoint — explicit, not "maybe").
//!
//! All decision logic lives in [`decide`] (pure, no DB). [`resolve_for`] is a
//! thin DB-fetching wrapper that builds the inputs then calls `decide`.
//!
//! T3.6 will consume this module from the cache-management commands; T3.5
//! intentionally ships zero CLI / Tauri surface.

use crate::data::{
    machine_ue_installs, machines, project_cache_backend, projects, zen_endpoints, Db,
};
use crate::error::{UecmError, UecmResult};
use rusqlite::params;
use serde::{Deserialize, Serialize};

/// Threshold below which a `zen_probes.reachable=1` row is still considered
/// "live evidence" of the endpoint being up. Kept as a module-level constant
/// (not config-surface) — operators tune probe cadence, not the freshness
/// window. If a future task needs to tune this per-deployment, lift it into
/// a settings table; for now 5 min matches plan §4.2 verbatim.
pub const ZEN_PROBE_FRESHNESS_WINDOW: &str = "-5 minutes";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Backend {
    LegacyPak,
    Zen,
}

impl Backend {
    /// Canonical wire / DB string for this backend (matches the values stored
    /// in `project_cache_backend.backend`).
    pub fn as_str(self) -> &'static str {
        match self {
            Backend::LegacyPak => "legacy_pak",
            Backend::Zen => "zen",
        }
    }
}

/// Result of routing. Carries the chosen backend plus the inputs that fed the
/// decision — operators reading `uecm cache status` (T3.6) need to see *why*
/// a backend was picked, not just *what*.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Routing {
    pub backend: Backend,
    pub reason: String,
    pub override_source: Option<String>,
    pub project_ue: Option<(i64, i64)>,
    pub machine_best_ue: Option<(i64, i64)>,
    pub zen_reachable: bool,
}

/// Pure decision-table helper. No DB access; suitable for exhaustive table
/// testing. Takes the already-resolved inputs and returns the same `Routing`
/// payload that [`resolve_for`] returns.
///
/// `explicit_override` accepts the raw `backend` column value from
/// `project_cache_backend`: `Some("zen")`, `Some("legacy_pak")`, `Some("auto")`,
/// or `None`. Anything else returns an `InvalidInput` error so a corrupted
/// override row surfaces loudly instead of silently falling through to
/// legacy_pak.
pub fn decide(
    project_ue: Option<(i64, i64)>,
    machine_best_ue: Option<(i64, i64)>,
    zen_reachable: bool,
    explicit_override: Option<&str>,
) -> UecmResult<Routing> {
    // (1) Explicit override row in project_cache_backend always wins. "auto"
    // and absent both fall through to the decision table.
    if let Some(raw) = explicit_override {
        match raw {
            "zen" => {
                return Ok(Routing {
                    backend: Backend::Zen,
                    reason: "explicit override (project_cache_backend.backend=zen)".into(),
                    override_source: Some("project_cache_backend row".into()),
                    project_ue,
                    machine_best_ue,
                    zen_reachable,
                });
            }
            "legacy_pak" => {
                return Ok(Routing {
                    backend: Backend::LegacyPak,
                    reason: "explicit override (project_cache_backend.backend=legacy_pak)".into(),
                    override_source: Some("project_cache_backend row".into()),
                    project_ue,
                    machine_best_ue,
                    zen_reachable,
                });
            }
            "auto" => { /* fall through */ }
            other => {
                return Err(UecmError::InvalidInput(format!(
                    "project_cache_backend.backend has unsupported value {other:?} (expected 'zen' | 'legacy_pak' | 'auto')"
                )));
            }
        }
    }

    // (2) Project UE NULL → conservative legacy. We *could* fall through to
    // checking zen_reachable, but plan §1.3 / §4.2 explicitly say: if we
    // can't tell the project's UE version, don't take any risk.
    let Some((p_major, p_minor)) = project_ue else {
        return Ok(Routing {
            backend: Backend::LegacyPak,
            reason: "project UE version unknown: conservative fall-back to legacy_pak".into(),
            override_source: None,
            project_ue,
            machine_best_ue,
            zen_reachable,
        });
    };

    // (3) Project UE < 5.4 → zen is unsupported regardless of machine state.
    if (p_major, p_minor) < (5, 4) {
        return Ok(Routing {
            backend: Backend::LegacyPak,
            reason: format!(
                "project UE {p_major}.{p_minor} < 5.4: zen unsupported"
            ),
            override_source: None,
            project_ue,
            machine_best_ue,
            zen_reachable,
        });
    }

    // (4) Machine has no UE installs recorded → can't confirm zen-capable
    // engine is present. Legacy is the only safe pick.
    let Some((m_major, m_minor)) = machine_best_ue else {
        return Ok(Routing {
            backend: Backend::LegacyPak,
            reason: "machine has no UE installs recorded".into(),
            override_source: None,
            project_ue,
            machine_best_ue,
            zen_reachable,
        });
    };

    // (5) Machine's best UE < 5.4 → engine on disk can't speak zen.
    if (m_major, m_minor) < (5, 4) {
        return Ok(Routing {
            backend: Backend::LegacyPak,
            reason: format!(
                "machine has no UE 5.4+ install (best is {m_major}.{m_minor}): zen unsupported"
            ),
            override_source: None,
            project_ue,
            machine_best_ue,
            zen_reachable,
        });
    }

    // (6) No reachable zen endpoint on the machine → operator hasn't probed
    // recently, or every endpoint is down. Either way we don't route writes
    // through a dead path.
    if !zen_reachable {
        return Ok(Routing {
            backend: Backend::LegacyPak,
            reason: "no reachable zen endpoint on machine in the last 5 minutes".into(),
            override_source: None,
            project_ue,
            machine_best_ue,
            zen_reachable,
        });
    }

    // (7) All preconditions cleared → zen.
    Ok(Routing {
        backend: Backend::Zen,
        reason: format!(
            "UE {p_major}.{p_minor} project + UE {m_major}.{m_minor} on machine + reachable zen endpoint: routing to zen"
        ),
        override_source: None,
        project_ue,
        machine_best_ue,
        zen_reachable,
    })
}

/// DB-fetching wrapper around [`decide`]. Gathers the four routing inputs
/// (project UE, best machine UE, zen reachability, explicit override) and
/// returns the final [`Routing`].
///
/// Errors:
/// - `InvalidInput` if the project / machine doesn't exist, or if the override
///   row carries an unknown backend string.
/// - `Database` on SQL failure.
pub fn resolve_for(db: &Db, project_id: i64, machine_id: i64) -> UecmResult<Routing> {
    // Project UE (Option<(major, minor)>).
    let project = projects::get(db, project_id)?.ok_or_else(|| {
        UecmError::InvalidInput(format!("project_id {project_id} not found"))
    })?;
    let project_ue = match (project.ue_version_major, project.ue_version_minor) {
        (Some(maj), Some(min)) => Some((maj, min)),
        _ => None,
    };

    // Validate machine_id explicitly — `list_for_machine` returns Ok(vec![])
    // for unknown ids, which would silently route to legacy_pak and let
    // callers display "valid legacy fallback" for a typo. Mirror the
    // project_id check so both invalid foreign keys fail loudly.
    if machines::find_by_id(db, machine_id)?.is_none() {
        return Err(UecmError::InvalidInput(format!(
            "machine_id {machine_id} not found"
        )));
    }

    // Explicit override row — read BEFORE the auto-mode probe / install scan.
    // When the operator has pinned a backend ('zen' | 'legacy_pak'), we must
    // not let an auto-mode-only DB hiccup (e.g. a probe row with a malformed
    // probed_at that breaks `datetime()`) drop the override on the floor.
    // 'auto' / absent still fall through to the decision table below.
    let override_row = project_cache_backend::find(db, project_id, machine_id)?;
    let explicit = override_row.as_ref().map(|r| r.backend.as_str());
    let is_pinned = matches!(explicit, Some("zen") | Some("legacy_pak"));

    // For pinned overrides, machine_best_ue and zen_reachable are only
    // populated for context (so `uecm cache status` can still show "you
    // pinned zen but the machine has no fresh probe"). For auto, they
    // *drive* the decision — so any read error must bubble.
    let machine_best_ue;
    let zen_reachable;
    if is_pinned {
        // Best-effort: failures are tolerated because the override is the
        // source of truth. Routing must remain stable even if the auto
        // signals are temporarily broken.
        machine_best_ue = machine_ue_installs::list_for_machine(db, machine_id)
            .ok()
            .map(|installs| best_machine_ue(&installs))
            .unwrap_or(None);
        zen_reachable = machine_zen_reachable(db, machine_id).unwrap_or(false);
    } else {
        // Best machine UE — highest version ≥ 5.4 if any, else highest
        // overall. Tie-breaks on the same (major, minor) don't matter for
        // the decision because the routing only looks at the tuple; if
        // multiple installs share a version, the first one returned wins
        // by `list_for_machine` ordering (`ORDER BY version DESC`, a string
        // sort but deterministic given the UNIQUE (machine_id, version)
        // index).
        let installs = machine_ue_installs::list_for_machine(db, machine_id)?;
        machine_best_ue = best_machine_ue(&installs);

        // Zen reachability — *latest* probe per endpoint must be both fresh
        // (within the 5-min window) AND reachable=1. Errors bubble up — a
        // DB lock / corruption while reading probes is a real failure and
        // shouldn't silently degrade to "legacy fallback".
        zen_reachable = machine_zen_reachable(db, machine_id)?;
    }

    decide(project_ue, machine_best_ue, zen_reachable, explicit)
}

/// Returns `true` iff at least one zen endpoint on `machine_id` has a latest
/// probe that is both fresh (within `ZEN_PROBE_FRESHNESS_WINDOW`) and
/// `reachable=1`. Helper extracted from `resolve_for` so the pinned-override
/// branch can call it with best-effort semantics (`.unwrap_or(false)`) while
/// the auto branch propagates errors.
fn machine_zen_reachable(db: &Db, machine_id: i64) -> UecmResult<bool> {
    let endpoints = zen_endpoints::list_for_machine(db, machine_id)?;
    for ep in &endpoints {
        let Some(endpoint_id) = ep.id else { continue };
        if endpoint_latest_probe_is_fresh_and_reachable(db, endpoint_id)? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Pick the highest UE version ≥ 5.4 from the install list. Falls back to the
/// overall highest if nothing is ≥ 5.4 (lets `decide` see the "only legacy
/// engines on this machine" case). Returns `None` if the list is empty or
/// every row has an unparseable `version` string.
fn best_machine_ue(installs: &[machine_ue_installs::UeInstall]) -> Option<(i64, i64)> {
    let parsed: Vec<(i64, i64)> = installs
        .iter()
        .filter_map(|i| parse_ue_version(&i.version))
        .collect();
    if parsed.is_empty() {
        return None;
    }
    // Prefer the highest version ≥ 5.4; if nothing qualifies, fall back to
    // the highest overall so the decision table can still see "best is <5.4".
    let modern = parsed.iter().copied().filter(|v| *v >= (5, 4)).max();
    modern.or_else(|| parsed.iter().copied().max())
}

/// Parse the `machine_ue_installs.version` string into `(major, minor)`.
/// Accepts both `"5.4"` (clean major.minor) and `"5.7.2"` (with patch
/// suffix) — the patch component is discarded so the router doesn't
/// misclassify a Zen-capable 5.7.x install as "unparseable" and fall
/// back to legacy_pak. Returns `None` for malformed values rather than
/// failing the whole routing — a single garbage row shouldn't break the
/// decision (codex P2).
fn parse_ue_version(s: &str) -> Option<(i64, i64)> {
    let mut parts = s.split('.');
    let major: i64 = parts.next()?.parse().ok()?;
    let minor: i64 = parts.next()?.parse().ok()?;
    // Validate that any remaining components are integer-shaped so we
    // don't silently accept gibberish like "5.7.abc" — we just don't
    // need them to compute the routing decision.
    for trailing in parts {
        if trailing.parse::<i64>().is_err() {
            return None;
        }
    }
    Some((major, minor))
}

/// Returns `true` iff the **latest** probe row for the endpoint (by
/// `probed_at`, with `id` as tiebreaker for same-second writes) is both
/// reachable AND inside the freshness window. Looking at "any fresh reachable
/// probe" would mis-route: an endpoint that succeeded at T-4min and then
/// failed at T-30s would still get classified as reachable. Using the latest
/// row mirrors operator intuition — "what's the most recent thing we know".
///
/// Uses SQLite `datetime()` to handle both ISO-8601 'T...Z' strings (CRUD
/// inserts) and space-separated CURRENT_TIMESTAMP output uniformly — same
/// trick `core::zen::retention` uses.
fn endpoint_latest_probe_is_fresh_and_reachable(
    db: &Db,
    endpoint_id: i64,
) -> UecmResult<bool> {
    let conn = db.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT reachable, datetime(probed_at) > datetime('now', ?2) AS fresh
         FROM zen_probes
         WHERE endpoint_id = ?1
         ORDER BY datetime(probed_at) DESC, id DESC
         LIMIT 1",
    )?;
    let mut rows = stmt.query(params![endpoint_id, ZEN_PROBE_FRESHNESS_WINDOW])?;
    let Some(row) = rows.next()? else {
        return Ok(false); // no probes at all
    };
    let reachable: i64 = row.get(0)?;
    let fresh: i64 = row.get(1)?;
    Ok(reachable != 0 && fresh != 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    // -------- pure decision-table tests (no DB) --------

    #[test]
    fn decide_project_below_54_routes_to_legacy_regardless_of_machine_or_zen() {
        // Even with a modern machine + reachable zen, a < 5.4 project must
        // never get routed to zen — zen is a UE 5.4+ feature.
        let r = decide(Some((4, 27)), Some((5, 7)), true, None).unwrap();
        assert_eq!(r.backend, Backend::LegacyPak);
        assert!(r.reason.contains("4.27"));
    }

    #[test]
    fn decide_modern_project_only_legacy_machine_routes_to_legacy() {
        // Project says 5.7 but the machine only has 5.3 installed → operator
        // would hit a missing-engine error before zen could even start.
        let r = decide(Some((5, 7)), Some((5, 3)), true, None).unwrap();
        assert_eq!(r.backend, Backend::LegacyPak);
        assert!(r.reason.contains("5.3"));
    }

    #[test]
    fn decide_modern_project_modern_machine_no_zen_routes_to_legacy() {
        let r = decide(Some((5, 7)), Some((5, 7)), false, None).unwrap();
        assert_eq!(r.backend, Backend::LegacyPak);
        assert!(r.reason.contains("no reachable zen endpoint"));
    }

    #[test]
    fn decide_modern_project_modern_machine_with_zen_routes_to_zen() {
        let r = decide(Some((5, 7)), Some((5, 4)), true, None).unwrap();
        assert_eq!(r.backend, Backend::Zen);
        assert!(r.override_source.is_none());
        assert!(r.zen_reachable);
    }

    #[test]
    fn decide_project_ue_none_routes_to_legacy() {
        let r = decide(None, Some((5, 7)), true, None).unwrap();
        assert_eq!(r.backend, Backend::LegacyPak);
        assert!(r.reason.contains("unknown"));
    }

    #[test]
    fn decide_machine_best_ue_none_routes_to_legacy() {
        let r = decide(Some((5, 7)), None, true, None).unwrap();
        assert_eq!(r.backend, Backend::LegacyPak);
        assert!(r.reason.contains("no UE installs"));
    }

    #[test]
    fn decide_explicit_override_zen_wins_over_decision_table() {
        // Even with every input pointing at legacy (no machine UE, no zen),
        // an operator override to zen must win.
        let r = decide(Some((4, 27)), None, false, Some("zen")).unwrap();
        assert_eq!(r.backend, Backend::Zen);
        assert_eq!(r.override_source.as_deref(), Some("project_cache_backend row"));
    }

    #[test]
    fn decide_explicit_override_legacy_pak_wins_over_decision_table() {
        // Conversely, even with a perfect zen setup, an operator override
        // to legacy_pak must win (e.g. operator debugging a zen regression).
        let r = decide(Some((5, 7)), Some((5, 7)), true, Some("legacy_pak")).unwrap();
        assert_eq!(r.backend, Backend::LegacyPak);
        assert_eq!(r.override_source.as_deref(), Some("project_cache_backend row"));
    }

    #[test]
    fn decide_explicit_override_auto_falls_through_to_decision_table() {
        // "auto" is the documented "use the decision table" value — it must
        // behave exactly the same as no override row.
        let with_auto = decide(Some((5, 7)), Some((5, 7)), true, Some("auto")).unwrap();
        let without = decide(Some((5, 7)), Some((5, 7)), true, None).unwrap();
        assert_eq!(with_auto.backend, without.backend);
        assert_eq!(with_auto.backend, Backend::Zen);
        assert!(with_auto.override_source.is_none());
    }

    #[test]
    fn decide_invalid_override_returns_invalid_input_error() {
        let err = decide(Some((5, 7)), Some((5, 7)), true, Some("nope")).unwrap_err();
        match err {
            UecmError::InvalidInput(msg) => assert!(msg.contains("nope")),
            other => panic!("expected InvalidInput, got {other:?}"),
        }
    }

    #[test]
    fn decide_modern_project_boundary_54_routes_to_zen() {
        // Boundary check: exactly 5.4 must qualify (plan says "≥ 5.4").
        let r = decide(Some((5, 4)), Some((5, 4)), true, None).unwrap();
        assert_eq!(r.backend, Backend::Zen);
    }

    // -------- DB-driven integration tests --------

    use crate::data::{
        machines, open_in_memory, schema, zen_endpoints, zen_probes, Machine,
    };

    fn setup_db() -> Db {
        let db = open_in_memory().unwrap();
        {
            let mut conn = db.lock().unwrap();
            schema::migrate(&mut conn).unwrap();
        }
        db
    }

    fn seed_project(db: &Db, stem: &str, ue: Option<(i64, i64)>) -> i64 {
        projects::upsert(
            db,
            &projects::Project {
                id: None,
                uproject_name: format!("{stem}.uproject"),
                uproject_stem_lower: stem.to_string(),
                uproject_guid: None,
                display_name: None,
                first_seen_at: None,
                last_seen_at: None,
                ue_version_major: ue.map(|(m, _)| m),
                ue_version_minor: ue.map(|(_, n)| n),
                engine_association_raw: ue.map(|(m, n)| format!("{m}.{n}")),
                engine_association_kind: ue.map(|_| "version".into()),
            },
        )
        .unwrap()
    }

    fn seed_machine(db: &Db, name: &str, ip: &str) -> i64 {
        machines::insert(db, &Machine::new(name, ip)).unwrap()
    }

    fn seed_ue_install(db: &Db, machine_id: i64, version: &str) {
        machine_ue_installs::upsert(
            db,
            &machine_ue_installs::UeInstall {
                id: None,
                machine_id,
                version: version.to_string(),
                install_path: format!("C:\\UE_{version}"),
                is_primary: true,
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

    fn seed_endpoint(db: &Db, machine_id: i64, port: i64) -> i64 {
        zen_endpoints::upsert(
            db,
            &zen_endpoints::ZenEndpoint {
                id: None,
                machine_id,
                declared_port: port,
                scheme: "http".into(),
                role: "primary".into(),
                upstream_endpoint_id: None,
                data_dir: format!("C:\\ZenData{port}"),
                httpserverclass: "asio".into(),
                lifecycle_mode: "managed".into(),
                created_at: None,
                updated_at: None,
            },
        )
        .unwrap()
    }

    /// Insert a probe at an explicit `probed_at` so we can control freshness
    /// in test. `CURRENT_TIMESTAMP` formatted strings (e.g. "2026-05-19 12:00:00")
    /// work fine because the production query wraps probed_at in `datetime()`.
    fn seed_probe(db: &Db, endpoint_id: i64, probed_at: &str, reachable: bool) {
        zen_probes::insert(
            db,
            &zen_probes::ZenProbe {
                id: None,
                endpoint_id,
                probed_at: Some(probed_at.to_string()),
                reachable,
                schema_version: 1,
                effective_port: None,
                pid: None,
                uptime_seconds: None,
                data_root: None,
                is_dedicated: None,
                build_version: None,
                health_info_cb: None,
                health_version_text: None,
                stats_providers_cb: None,
                error_message: None,
            },
        )
        .unwrap();
    }

    /// Build an ISO-8601 'Z' timestamp `offset_seconds` away from now.
    /// Positive = future, negative = past.
    fn ts_offset_from_now(offset_seconds: i64) -> String {
        let dt = chrono::Utc::now() + chrono::Duration::seconds(offset_seconds);
        dt.format("%Y-%m-%dT%H:%M:%SZ").to_string()
    }

    #[test]
    fn resolve_for_missing_project_returns_invalid_input() {
        // Empty DB → no project row → InvalidInput surfaces (caller can map
        // to a clean CLI error). Documented behaviour per the task spec.
        let db = setup_db();
        let machine_id = seed_machine(&db, "EMPTY", "10.0.0.1");
        let err = resolve_for(&db, 999, machine_id).unwrap_err();
        match err {
            UecmError::InvalidInput(msg) => assert!(msg.contains("999")),
            other => panic!("expected InvalidInput, got {other:?}"),
        }
    }

    #[test]
    fn resolve_for_happy_path_routes_to_zen() {
        let db = setup_db();
        let project_id = seed_project(&db, "demo", Some((5, 7)));
        let machine_id = seed_machine(&db, "RENDER-01", "10.0.0.10");
        seed_ue_install(&db, machine_id, "5.7");
        let endpoint_id = seed_endpoint(&db, machine_id, 8558);
        seed_probe(&db, endpoint_id, &ts_offset_from_now(-30), true); // 30s ago, reachable

        let r = resolve_for(&db, project_id, machine_id).unwrap();
        assert_eq!(r.backend, Backend::Zen);
        assert_eq!(r.project_ue, Some((5, 7)));
        assert_eq!(r.machine_best_ue, Some((5, 7)));
        assert!(r.zen_reachable);
        assert!(r.override_source.is_none());
    }

    #[test]
    fn resolve_for_stale_probe_treated_as_unreachable() {
        // Probe is reachable=1 but 10 minutes old — outside the 5-min window,
        // so we must not route to zen.
        let db = setup_db();
        let project_id = seed_project(&db, "demo", Some((5, 7)));
        let machine_id = seed_machine(&db, "RENDER-01", "10.0.0.10");
        seed_ue_install(&db, machine_id, "5.7");
        let endpoint_id = seed_endpoint(&db, machine_id, 8558);
        seed_probe(&db, endpoint_id, &ts_offset_from_now(-600), true); // 10 min ago

        let r = resolve_for(&db, project_id, machine_id).unwrap();
        assert_eq!(r.backend, Backend::LegacyPak);
        assert!(!r.zen_reachable);
        assert!(r.reason.contains("no reachable zen endpoint"));
    }

    #[test]
    fn resolve_for_no_probes_treats_endpoint_as_unreachable() {
        // Endpoint exists but no probe row → zen_reachable=false. We must
        // not "trust" an unprobed endpoint just because the row exists.
        let db = setup_db();
        let project_id = seed_project(&db, "demo", Some((5, 7)));
        let machine_id = seed_machine(&db, "RENDER-01", "10.0.0.10");
        seed_ue_install(&db, machine_id, "5.7");
        let _ep = seed_endpoint(&db, machine_id, 8558);

        let r = resolve_for(&db, project_id, machine_id).unwrap();
        assert_eq!(r.backend, Backend::LegacyPak);
        assert!(!r.zen_reachable);
    }

    #[test]
    fn resolve_for_explicit_override_row_wins() {
        // Project UE is 4.27 (would route to legacy) but operator pinned
        // backend=zen via project_cache_backend → override must win.
        let db = setup_db();
        let project_id = seed_project(&db, "demo", Some((4, 27)));
        let machine_id = seed_machine(&db, "RENDER-01", "10.0.0.10");
        project_cache_backend::upsert(
            &db,
            &project_cache_backend::ProjectCacheBackend {
                project_id,
                machine_id,
                backend: "zen".into(),
                zen_endpoint_id: None,
                notes: Some("operator override".into()),
                updated_at: None,
            },
        )
        .unwrap();

        let r = resolve_for(&db, project_id, machine_id).unwrap();
        assert_eq!(r.backend, Backend::Zen);
        assert_eq!(r.override_source.as_deref(), Some("project_cache_backend row"));
    }

    #[test]
    fn resolve_for_auto_override_falls_through_to_decision_table() {
        // backend='auto' must be treated identically to no override row.
        let db = setup_db();
        let project_id = seed_project(&db, "demo", Some((5, 7)));
        let machine_id = seed_machine(&db, "RENDER-01", "10.0.0.10");
        seed_ue_install(&db, machine_id, "5.7");
        let endpoint_id = seed_endpoint(&db, machine_id, 8558);
        seed_probe(&db, endpoint_id, &ts_offset_from_now(-30), true);
        project_cache_backend::upsert(
            &db,
            &project_cache_backend::ProjectCacheBackend {
                project_id,
                machine_id,
                backend: "auto".into(),
                zen_endpoint_id: None,
                notes: None,
                updated_at: None,
            },
        )
        .unwrap();

        let r = resolve_for(&db, project_id, machine_id).unwrap();
        assert_eq!(r.backend, Backend::Zen);
        assert!(r.override_source.is_none());
    }

    #[test]
    fn resolve_for_picks_highest_modern_ue_when_multiple_installs() {
        // Machine has 5.3 + 5.5 + 5.7 installed. best_machine_ue must pick
        // 5.7 (highest ≥ 5.4), not 5.5.
        let db = setup_db();
        let project_id = seed_project(&db, "demo", Some((5, 7)));
        let machine_id = seed_machine(&db, "RENDER-01", "10.0.0.10");
        seed_ue_install(&db, machine_id, "5.3");
        seed_ue_install(&db, machine_id, "5.5");
        seed_ue_install(&db, machine_id, "5.7");
        let endpoint_id = seed_endpoint(&db, machine_id, 8558);
        seed_probe(&db, endpoint_id, &ts_offset_from_now(-30), true);

        let r = resolve_for(&db, project_id, machine_id).unwrap();
        assert_eq!(r.backend, Backend::Zen);
        assert_eq!(r.machine_best_ue, Some((5, 7)));
    }

    #[test]
    fn resolve_for_falls_back_to_highest_overall_when_no_modern_installs() {
        // Machine only has 5.2 + 5.3 → best_machine_ue returns 5.3 (so the
        // decision table can phrase "best is 5.3" in the reason).
        let db = setup_db();
        let project_id = seed_project(&db, "demo", Some((5, 7)));
        let machine_id = seed_machine(&db, "RENDER-01", "10.0.0.10");
        seed_ue_install(&db, machine_id, "5.2");
        seed_ue_install(&db, machine_id, "5.3");

        let r = resolve_for(&db, project_id, machine_id).unwrap();
        assert_eq!(r.backend, Backend::LegacyPak);
        assert_eq!(r.machine_best_ue, Some((5, 3)));
        assert!(r.reason.contains("5.3"));
    }

    #[test]
    fn resolve_for_unreachable_probe_does_not_count_as_reachable() {
        // Fresh probe but reachable=0 → must not satisfy the zen-reachable
        // check. Edge case: a 30-second-old probe that says "endpoint is
        // down" is *more* recent than the freshness window but it's still
        // a "no" signal.
        let db = setup_db();
        let project_id = seed_project(&db, "demo", Some((5, 7)));
        let machine_id = seed_machine(&db, "RENDER-01", "10.0.0.10");
        seed_ue_install(&db, machine_id, "5.7");
        let endpoint_id = seed_endpoint(&db, machine_id, 8558);
        seed_probe(&db, endpoint_id, &ts_offset_from_now(-30), false);

        let r = resolve_for(&db, project_id, machine_id).unwrap();
        assert_eq!(r.backend, Backend::LegacyPak);
        assert!(!r.zen_reachable);
    }

    #[test]
    fn resolve_for_pinned_legacy_override_survives_unparseable_probe_timestamp() {
        // Operator pinned backend='legacy_pak'. A garbage probed_at value
        // would make datetime() return NULL and the auto path would error
        // (or worse, silently flip behaviour). The override must remain the
        // source of truth and short-circuit before we ever touch probes.
        let db = setup_db();
        let project_id = seed_project(&db, "demo", Some((5, 7)));
        let machine_id = seed_machine(&db, "RENDER-01", "10.0.0.10");
        seed_ue_install(&db, machine_id, "5.7");
        let endpoint_id = seed_endpoint(&db, machine_id, 8558);
        // Insert a probe with a garbage timestamp. SQLite `datetime()` will
        // return NULL for this; the auto-path comparison would yield NULL
        // (which `i64` `row.get` chokes on). With override-first, this row
        // is never read.
        {
            let conn = db.lock().unwrap();
            conn.execute(
                "INSERT INTO zen_probes (endpoint_id, probed_at, reachable, schema_version)
                 VALUES (?, 'not-a-timestamp', 1, 1)",
                params![endpoint_id],
            )
            .unwrap();
        }
        project_cache_backend::upsert(
            &db,
            &project_cache_backend::ProjectCacheBackend {
                project_id,
                machine_id,
                backend: "legacy_pak".into(),
                zen_endpoint_id: None,
                notes: None,
                updated_at: None,
            },
        )
        .unwrap();

        // Override must win even with broken probe data underneath.
        let r = resolve_for(&db, project_id, machine_id).unwrap();
        assert_eq!(r.backend, Backend::LegacyPak);
        assert_eq!(r.override_source.as_deref(), Some("project_cache_backend row"));
    }

    #[test]
    fn resolve_for_invalid_machine_id_returns_invalid_input() {
        // Mirror the project-id check: an unknown machine_id must surface as
        // InvalidInput, not silently route to legacy_pak.
        let db = setup_db();
        let project_id = seed_project(&db, "demo", Some((5, 7)));
        let err = resolve_for(&db, project_id, 999).unwrap_err();
        match err {
            UecmError::InvalidInput(msg) => assert!(msg.contains("999")),
            other => panic!("expected InvalidInput, got {other:?}"),
        }
    }

    #[test]
    fn resolve_for_latest_probe_overrules_earlier_in_window() {
        // 4 min ago: reachable=1. 30 s ago: reachable=0. Both inside the
        // 5-min window. Latest wins → must route to legacy_pak.
        let db = setup_db();
        let project_id = seed_project(&db, "demo", Some((5, 7)));
        let machine_id = seed_machine(&db, "RENDER-01", "10.0.0.10");
        seed_ue_install(&db, machine_id, "5.7");
        let endpoint_id = seed_endpoint(&db, machine_id, 8558);
        seed_probe(&db, endpoint_id, &ts_offset_from_now(-240), true); // older, succeeded
        seed_probe(&db, endpoint_id, &ts_offset_from_now(-30), false); // newer, failed

        let r = resolve_for(&db, project_id, machine_id).unwrap();
        assert_eq!(r.backend, Backend::LegacyPak);
        assert!(!r.zen_reachable);
    }

    #[test]
    fn resolve_for_multiple_endpoints_one_reachable_is_enough() {
        // Two endpoints; only one has a fresh reachable probe → still counts
        // as zen-reachable.
        let db = setup_db();
        let project_id = seed_project(&db, "demo", Some((5, 7)));
        let machine_id = seed_machine(&db, "RENDER-01", "10.0.0.10");
        seed_ue_install(&db, machine_id, "5.7");
        let ep1 = seed_endpoint(&db, machine_id, 8558);
        let ep2 = seed_endpoint(&db, machine_id, 8559);
        seed_probe(&db, ep1, &ts_offset_from_now(-600), true); // stale
        seed_probe(&db, ep2, &ts_offset_from_now(-30), true); // fresh

        let r = resolve_for(&db, project_id, machine_id).unwrap();
        assert_eq!(r.backend, Backend::Zen);
        assert!(r.zen_reachable);
    }

    // -------- pure helpers --------

    #[test]
    fn parse_ue_version_handles_garbage_gracefully() {
        assert_eq!(parse_ue_version("5.4"), Some((5, 4)));
        assert_eq!(parse_ue_version("5.10"), Some((5, 10)));
        // Codex P2: accept patch-suffixed versions; UE installs commonly
        // surface "5.7.2" style and a strict split-once parse would drop
        // the install and mis-route to legacy_pak.
        assert_eq!(parse_ue_version("5.7.2"), Some((5, 7)));
        assert_eq!(parse_ue_version("5.4.0"), Some((5, 4)));
        assert_eq!(parse_ue_version("5.7.4.1"), Some((5, 7)));
        // Still reject trailing garbage in patch position.
        assert_eq!(parse_ue_version("5.7.abc"), None);
        assert_eq!(parse_ue_version("garbage"), None);
        assert_eq!(parse_ue_version(""), None);
        assert_eq!(parse_ue_version("5"), None);
        assert_eq!(parse_ue_version("5.x"), None);
    }

    #[test]
    fn best_machine_ue_returns_none_when_list_empty() {
        assert_eq!(best_machine_ue(&[]), None);
    }
}
