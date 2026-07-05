//! Plan 7 T2.1: business-layer API for `zen_endpoints`.
//!
//! The raw SQL CRUD lives in [`crate::data::zen_endpoints`] and is intentionally
//! permissive — it stores whatever role / scheme / lifecycle string the caller
//! supplies. This module enforces the v4 plan §1.1 contract on top:
//!
//! - canonical `role` values (`local` | `shared_upstream`) and the transitions
//!   between them,
//! - canonical `scheme` (`http` | `https`), `httpserverclass`
//!   (`asio` | `httpsys`), and `lifecycle_mode`
//!   (`editor_owned` | `installed_service`),
//! - `declared_port` in 1..=65535,
//! - non-empty `data_dir` (the safe-path check on `C:\Windows` etc. is T2.8's
//!   job — we only reject empty / whitespace here),
//! - `upstream_endpoint_id` must reference an existing `shared_upstream`
//!   endpoint, must not be self, and must be `None` when this endpoint is
//!   itself `shared_upstream` (a cluster master can't point upstream),
//! - `unregister` refuses if any other endpoint references the target as its
//!   upstream — the DB has no ON DELETE CASCADE, but silently breaking a
//!   cluster topology is worse than asking the operator to un-point first.
//!
//! ## Concurrency
//!
//! Every mutation in this module performs its validation reads, idempotency
//! check, and write under a **single** `MutexGuard<Connection>` + rusqlite
//! transaction. Other modules calling `data::zen_endpoints::*` directly will
//! block on the mutex until the transaction commits or rolls back, so a
//! concurrent `change_role` cannot demote a master between this caller's
//! upstream validation and the row insertion.
//!
//! Other modules (CLI / Tauri commands / lua_config) call into this module
//! rather than touching [`crate::data::zen_endpoints`] directly.

use crate::data::zen_endpoints::{self, ZenEndpoint};
use crate::data::Db;
use crate::error::{VoloError, VoloResult};
use rusqlite::Connection;

/// Canonical role: this machine runs its own zen and (optionally) forwards
/// misses to a `shared_upstream`.
pub const ROLE_LOCAL: &str = "local";

/// Canonical role: this endpoint IS the cluster master. Other `local`
/// endpoints in the cluster forward their misses here. A `shared_upstream`
/// must NOT itself have an upstream pointer.
pub const ROLE_SHARED_UPSTREAM: &str = "shared_upstream";

const ALLOWED_SCHEMES: &[&str] = &["http", "https"];
const ALLOWED_HTTPSERVERCLASSES: &[&str] = &["asio", "httpsys"];
const ALLOWED_LIFECYCLE_MODES: &[&str] = &["editor_owned", "installed_service"];

/// Caller-supplied parameters for [`register`]. Mirrors the DB shape but drops
/// server-assigned columns (`id`, `created_at`, `updated_at`).
#[derive(Debug, Clone, PartialEq)]
pub struct EndpointInput {
    pub machine_id: i64,
    pub declared_port: i64,
    pub scheme: String,
    pub role: String,
    pub upstream_endpoint_id: Option<i64>,
    pub data_dir: String,
    pub httpserverclass: String,
    pub lifecycle_mode: String,
    /// `{ZenInstall}` — see `zen_endpoints::ZenEndpoint::install_dir`. `None`
    /// preserves the legacy derive-from-detected-binary behavior.
    pub install_dir: Option<String>,
    /// See `zen_endpoints::ZenEndpoint::config_path_override`.
    pub config_path_override: Option<String>,
}

/// Result of [`register`]. `inserted == false` means the row already existed
/// and the supplied fields were ignored (plan §7.2 idempotency contract);
/// callers that need to change role / upstream of an existing endpoint must
/// use [`change_role`] instead.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RegisterOutcome {
    pub id: i64,
    pub inserted: bool,
}

/// Validate `input` and insert a new endpoint row, returning the id and an
/// `inserted` flag.
///
/// **Idempotent on conflict** (plan §7.2): if `(machine_id, declared_port)`
/// already maps to an endpoint, `register` returns `inserted = false` with
/// the existing row's id and does NOT touch any fields. Callers that want
/// to change `role` / `upstream_endpoint_id` must use [`change_role`].
///
/// Validation runs unconditionally — even on the no-op conflict path — so a
/// caller can't smuggle garbage past `register` just because the row already
/// exists.
///
/// The validation reads, conflict probe, and insert all run inside one
/// SQLite transaction so concurrent mutators cannot invalidate the upstream /
/// self-id invariants between the checks and the write.
pub fn register(db: &Db, input: &EndpointInput) -> VoloResult<RegisterOutcome> {
    // Field-level validation needs no DB access — do it before grabbing the
    // mutex so obviously bad input bails fast.
    validate_port(input.declared_port)?;
    validate_enum("scheme", &input.scheme, ALLOWED_SCHEMES)?;
    validate_role(&input.role)?;
    validate_enum(
        "httpserverclass",
        &input.httpserverclass,
        ALLOWED_HTTPSERVERCLASSES,
    )?;
    validate_enum("lifecycle_mode", &input.lifecycle_mode, ALLOWED_LIFECYCLE_MODES)?;
    validate_role_lifecycle(&input.role, &input.lifecycle_mode)?;
    validate_data_dir(&input.data_dir)?;

    let conn = db.lock().unwrap();
    let tx = conn.unchecked_transaction()?;

    // Resolve self_id (if any) so the upstream check rejects self-loops on
    // re-register too, and so the upstream validation runs against current
    // state even on the conflict path.
    let self_id = lookup_existing_id_tx(&tx, input.machine_id, input.declared_port)?;
    validate_upstream_tx(&tx, &input.role, input.upstream_endpoint_id, self_id)?;

    let record = ZenEndpoint {
        id: None,
        machine_id: input.machine_id,
        declared_port: input.declared_port,
        scheme: input.scheme.clone(),
        role: input.role.clone(),
        upstream_endpoint_id: input.upstream_endpoint_id,
        data_dir: input.data_dir.clone(),
        httpserverclass: input.httpserverclass.clone(),
        lifecycle_mode: input.lifecycle_mode.clone(),
        created_at: None,
        updated_at: None,
        install_dir: input.install_dir.clone(),
        gc_interval_seconds: None,
        gc_lightweight_interval_seconds: None,
        cache_max_duration_seconds: None,
        service_account_username: None,
        service_account_cred_alias: None,
        config_path_override: input.config_path_override.clone(),
    };
    let (id, inserted) = zen_endpoints::insert_only_tx(&tx, &record)?;
    tx.commit()?;
    Ok(RegisterOutcome { id, inserted })
}

/// Caller-supplied fields for [`update_deploy_config`] — the subset of
/// [`EndpointInput`] that describes *how* an already-registered endpoint is
/// deployed (as opposed to its cluster topology, which [`change_role`] owns,
/// or its GC/service-account bookkeeping, which their own setters own).
#[derive(Debug, Clone, PartialEq)]
pub struct DeployConfigPatch {
    pub scheme: String,
    pub data_dir: String,
    pub httpserverclass: String,
    pub install_dir: Option<String>,
    pub config_path_override: Option<String>,
}

/// Outcome of [`update_deploy_config`]: the persisted row after the write,
/// plus which categories of change the caller needs to react to.
#[derive(Debug, Clone, PartialEq)]
pub struct DeployConfigOutcome {
    pub endpoint: ZenEndpoint,
    /// `install_dir` changed — the service's zenserver.exe lives there, so
    /// `zen-service-install.ps1`'s idempotency guard will refuse an in-place
    /// ImagePath patch and the caller must uninstall the existing SCM
    /// registration before reinstalling (see `zen_service_install`'s
    /// auto-recovery in `commands/zen.rs`).
    pub install_dir_changed: bool,
    /// `data_dir` changed — the old cache contents are stranded under
    /// `previous_data_dir` unless the caller migrates them.
    pub data_dir_changed: bool,
    pub previous_data_dir: String,
}

/// Persist new deployment-shape fields (`scheme` / `data_dir` /
/// `httpserverclass` / `install_dir` / `config_path_override`) onto an
/// EXISTING endpoint row.
///
/// Unlike [`register`] (insert-only, plan §7.2 idempotency contract — a
/// duplicate register must never silently overwrite an existing row), this
/// is an explicit update: callers use it once they already hold an
/// `endpoint_id` and want a "change deploy config, then redeploy" flow to
/// actually take effect. Role / upstream / GC settings / service account are
/// carried over unchanged from the current row (struct-update, not caller
/// input), so this can't drift those the way a full re-register with blank
/// fields would.
pub fn update_deploy_config(
    db: &Db,
    endpoint_id: i64,
    patch: &DeployConfigPatch,
) -> VoloResult<DeployConfigOutcome> {
    validate_enum("scheme", &patch.scheme, ALLOWED_SCHEMES)?;
    validate_enum(
        "httpserverclass",
        &patch.httpserverclass,
        ALLOWED_HTTPSERVERCLASSES,
    )?;
    validate_data_dir(&patch.data_dir)?;

    let conn = db.lock().unwrap();
    let tx = conn.unchecked_transaction()?;
    let current = zen_endpoints::get_tx(&tx, endpoint_id)?.ok_or_else(|| {
        VoloError::InvalidInput(format!("zen endpoint {endpoint_id} does not exist"))
    })?;

    let install_dir_changed =
        normalize_opt_path(&current.install_dir) != normalize_opt_path(&patch.install_dir);
    let data_dir_changed = current.data_dir.trim() != patch.data_dir.trim();
    let previous_data_dir = current.data_dir.clone();

    let updated = ZenEndpoint {
        scheme: patch.scheme.clone(),
        data_dir: patch.data_dir.clone(),
        httpserverclass: patch.httpserverclass.clone(),
        install_dir: patch.install_dir.clone(),
        config_path_override: patch.config_path_override.clone(),
        updated_at: None,
        ..current
    };
    zen_endpoints::upsert_tx(&tx, &updated)?;
    tx.commit()?;

    Ok(DeployConfigOutcome {
        endpoint: updated,
        install_dir_changed,
        data_dir_changed,
        previous_data_dir,
    })
}

/// Case/trailing-slash-insensitive comparison for an optional Windows path
/// field (`install_dir`) — `None` vs `None` is unchanged; `Some("C:\\Foo")` vs
/// `Some("C:\\Foo\\")` is also unchanged.
fn normalize_opt_path(p: &Option<String>) -> Option<String> {
    p.as_ref()
        .map(|s| s.trim().trim_end_matches(['\\', '/']).to_lowercase())
}

/// Delete `endpoint_id`. Fails if any other endpoint references it as their
/// upstream — the operator must un-point dependents first. The DB has no
/// ON DELETE CASCADE, so the alternative would be a dangling reference.
///
/// Existence check, dependents scan, and the delete all run in one
/// transaction.
pub fn unregister(db: &Db, endpoint_id: i64) -> VoloResult<()> {
    let conn = db.lock().unwrap();
    let tx = conn.unchecked_transaction()?;

    if zen_endpoints::get_tx(&tx, endpoint_id)?.is_none() {
        return Err(VoloError::InvalidInput(format!(
            "zen endpoint {endpoint_id} does not exist"
        )));
    }

    let dependents = list_dependents_of_tx(&tx, endpoint_id)?;
    if !dependents.is_empty() {
        let ids: Vec<String> = dependents
            .iter()
            .filter_map(|e| e.id.map(|i| i.to_string()))
            .collect();
        return Err(VoloError::InvalidInput(format!(
            "cannot unregister zen endpoint {endpoint_id}: still referenced as upstream by endpoint(s) [{}]; un-point them first",
            ids.join(", ")
        )));
    }
    zen_endpoints::delete_tx(&tx, endpoint_id)?;
    tx.commit()?;
    Ok(())
}

/// Apply a role transition with full validation. `new_upstream` is the desired
/// upstream pointer AFTER the transition.
///
/// Allowed transitions (all combinations of `local` / `shared_upstream`):
///
/// - `local → local` — may change upstream pointer.
/// - `local → shared_upstream` — caller MUST pass `new_upstream = None`
///   (a master can't itself forward upstream).
/// - `shared_upstream → local` — may set a new upstream or stay standalone.
/// - `shared_upstream → shared_upstream` — `new_upstream` must be `None`.
///
/// In every case `new_upstream` (when `Some`) must point at an existing
/// `shared_upstream` endpoint that is not this endpoint itself.
///
/// Read of current row, upstream/dependent checks, and the write all run in
/// one transaction so a concurrent demote of the target upstream cannot slip
/// in between the validation and the update.
pub fn change_role(
    db: &Db,
    endpoint_id: i64,
    new_role: &str,
    new_upstream: Option<i64>,
) -> VoloResult<()> {
    validate_role(new_role)?;

    let conn = db.lock().unwrap();
    let tx = conn.unchecked_transaction()?;

    let current = validate_change_role_tx(&tx, endpoint_id, new_role, new_upstream)?;

    // Struct-update syntax so fields this function doesn't touch (GC
    // settings, install_dir, service account) survive a role change instead
    // of silently resetting to None — the ever-growing manual field list
    // above was exactly the kind of drift risk that pattern invites.
    let updated = ZenEndpoint {
        role: new_role.to_string(),
        upstream_endpoint_id: new_upstream,
        updated_at: None,
        ..current
    };
    zen_endpoints::upsert_tx(&tx, &updated)?;
    tx.commit()?;
    Ok(())
}

/// Thin pass-through to [`zen_endpoints::get`].
pub fn get(db: &Db, endpoint_id: i64) -> VoloResult<Option<ZenEndpoint>> {
    zen_endpoints::get(db, endpoint_id)
}

/// Thin pass-through to [`zen_endpoints::list`].
pub fn list(db: &Db) -> VoloResult<Vec<ZenEndpoint>> {
    zen_endpoints::list(db)
}

/// Thin pass-through to [`zen_endpoints::list_for_machine`].
pub fn list_for_machine(db: &Db, machine_id: i64) -> VoloResult<Vec<ZenEndpoint>> {
    zen_endpoints::list_for_machine(db, machine_id)
}

/// Validate a `change_role` transition without writing. Used by CLI /
/// Tauri dry-run paths so a preview can't promise success when the real
/// apply would refuse the transition (codex P2 — `--dry-run` previously
/// emitted the plan before the `lifecycle_mode != installed_service` /
/// dependents-on-demote / bad-upstream checks ran).
///
/// Returns the current endpoint row when all validation passes, so the
/// caller has the same "before" snapshot the real `change_role` would
/// see — useful for building the plan JSON without a second DB read.
pub fn validate_change_role(
    db: &Db,
    endpoint_id: i64,
    new_role: &str,
    new_upstream: Option<i64>,
) -> VoloResult<ZenEndpoint> {
    validate_role(new_role)?;
    let conn = db.lock().unwrap();
    // The read-only path doesn't need a transaction (no writes), but
    // grabbing one keeps a consistent snapshot across the multi-query
    // checks below (mirrors `change_role`'s real-apply path).
    let tx = conn.unchecked_transaction()?;
    let current = validate_change_role_tx(&tx, endpoint_id, new_role, new_upstream)?;
    // Don't commit — there were no writes.
    Ok(current)
}

/// Inner helper shared by `change_role` (write) and `validate_change_role`
/// (read-only). Returns the current row when all validation passes.
fn validate_change_role_tx(
    tx: &Connection,
    endpoint_id: i64,
    new_role: &str,
    new_upstream: Option<i64>,
) -> VoloResult<ZenEndpoint> {
    let current = zen_endpoints::get_tx(tx, endpoint_id)?.ok_or_else(|| {
        VoloError::InvalidInput(format!("zen endpoint {endpoint_id} does not exist"))
    })?;

    // The new role must be compatible with the current lifecycle_mode.
    // (Plan §634: promoting to `shared_upstream` while the row is still
    // `editor_owned` would advertise a cluster master that is loopback-only
    // and editor-tied — unreachable / unstable for remote clients.)
    validate_role_lifecycle(new_role, &current.lifecycle_mode)?;
    validate_upstream_tx(tx, new_role, new_upstream, Some(endpoint_id))?;

    // Demoting `shared_upstream → local` while children still point here
    // would leave them referencing a `local` endpoint. Refuse and make the
    // operator un-point dependents first (same policy as `unregister`).
    if current.role == ROLE_SHARED_UPSTREAM && new_role != ROLE_SHARED_UPSTREAM {
        ensure_no_dependents_on_demote_tx(tx, endpoint_id)?;
    }

    Ok(current)
}

// ---- internal helpers ------------------------------------------------------

fn validate_port(port: i64) -> VoloResult<()> {
    if !(1..=65535).contains(&port) {
        return Err(VoloError::InvalidInput(format!(
            "declared_port must be in 1..=65535, got {port}"
        )));
    }
    Ok(())
}

fn validate_enum(field: &str, value: &str, allowed: &[&str]) -> VoloResult<()> {
    if !allowed.contains(&value) {
        return Err(VoloError::InvalidInput(format!(
            "{field} must be one of {allowed:?}, got {value:?}"
        )));
    }
    Ok(())
}

fn validate_role(role: &str) -> VoloResult<()> {
    validate_enum("role", role, &[ROLE_LOCAL, ROLE_SHARED_UPSTREAM])
}

/// Per plan §634: a `shared_upstream` cluster master MUST be
/// `installed_service`. Editor-sponsored zen is loopback-only (127.0.0.1)
/// and tied to the sponsoring Editor's lifecycle — remote render nodes cannot
/// reach it, and it is not a stable Shared upstream. `local` endpoints can run
/// either lifecycle.
fn validate_role_lifecycle(role: &str, lifecycle_mode: &str) -> VoloResult<()> {
    if role == ROLE_SHARED_UPSTREAM && lifecycle_mode != "installed_service" {
        return Err(VoloError::InvalidInput(format!(
            "shared_upstream endpoint must have lifecycle_mode {:?} (got {:?}); \
             editor-sponsored zen is loopback-only and editor-tied, not a stable LAN Shared upstream",
            "installed_service", lifecycle_mode
        )));
    }
    Ok(())
}

/// Validate the endpoint's `data_dir` field.
///
/// Plan §8 T2.8: reject unsafe paths at `register` time, BEFORE the row
/// hits the DB. The cli / Tauri / PS-sidecar layers all already do their
/// own checks (defense in depth), but having `core::zen::endpoint` reject
/// up-front means an unsafe path never gets persisted — operators get
/// the error at register time instead of at apply time, and stale rows
/// can't reference paths under `C:\Windows` etc.
///
/// What's rejected:
/// - Empty / whitespace-only.
/// - Win32 device namespace prefixes (`\\?\` / `\\.\` and their forward-
///   slash variants). These bypass Windows path canonicalization and
///   would let `\\?\C:\Windows\Zen` slip past the system-root check
///   below — refuse outright.
/// - Paths under `C:\Windows` / `C:\Program Files` /
///   `C:\Program Files (x86)`, including the exact roots themselves
///   (without trailing slash). Comparison is case-insensitive and runs
///   AFTER `..`-segment collapse so `C:\Foo\..\Windows\Zen` is also
///   rejected.
///
/// What's rejected:
/// - Drive-relative (`D:ZenCache`) or root-relative (`\ZenCache`) paths.
///   Codex round-16 P2: these survive register, persist through the DB,
///   and later get rendered straight into `server.datadir` by
///   `zen-write-lua-config.ps1` (which only validates `dest_path`).
///   zen then resolves them against the editor / service process CWD,
///   producing different data dirs depending on who launched the
///   process. The strict `zen-service-install.ps1` guard catches the
///   same path later, but `editor_owned` / `local` lifecycles never
///   reach that guard. Refuse at register time so every code path
///   sees a fully-qualified path.
fn validate_data_dir(data_dir: &str) -> VoloResult<()> {
    let trimmed = data_dir.trim();
    if trimmed.is_empty() {
        return Err(VoloError::InvalidInput(
            "data_dir must not be empty or whitespace".to_string(),
        ));
    }
    // Normalize separators FIRST so mixed-separator device prefixes like
    // `\\?/C:/Windows/Zen` or `//?\C:\Windows\Zen` get caught by the
    // device-prefix check below. Without unifying first, the prefix check
    // would miss those variants and the system-root check would
    // misinterpret them as UNC `\\?\` with the host `?` (codex P2).
    let normalized = trimmed.replace('/', r"\");
    if normalized.starts_with(r"\\?\") || normalized.starts_with(r"\\.\") {
        return Err(VoloError::InvalidInput(format!(
            "data_dir {data_dir:?} uses a Win32 device namespace prefix \
             (\\\\?\\ or \\\\.\\); these bypass path canonicalization and \
             would defeat the system-root safety check. Register without \
             the prefix."
        )));
    }
    // Codex round-16 P2: require a fully-qualified absolute path. Two
    // shapes accepted — drive-absolute (`X:\...`) and UNC (`\\host\...`).
    // Anything else is ambiguous (drive-relative `D:ZenCache`,
    // root-relative `\ZenCache`, bare `ZenCache`) and resolves against
    // process CWD on Windows.
    let bytes = normalized.as_bytes();
    let is_drive_absolute = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && bytes[2] == b'\\';
    let is_unc = normalized.starts_with(r"\\");
    if !(is_drive_absolute || is_unc) {
        return Err(VoloError::InvalidInput(format!(
            "data_dir {data_dir:?} must be a fully-qualified absolute path \
             (e.g. 'D:\\ZenCache' or '\\\\host\\share\\Zen'); drive-relative \
             or root-relative paths resolve against process CWD on Windows \
             and produce different data dirs depending on the launcher"
        )));
    }
    let canonical = collapse_path_segments(&normalized);
    let canonical_lower = canonical.trim_end_matches('\\').to_lowercase();
    const FORBIDDEN: &[&str] = &[
        r"c:\windows",
        r"c:\program files",
        r"c:\program files (x86)",
    ];
    for root in FORBIDDEN {
        if canonical_lower == *root || canonical_lower.starts_with(&format!("{root}\\")) {
            return Err(VoloError::InvalidInput(format!(
                "data_dir {data_dir:?} resolves under a forbidden system location ({root}); \
                 pick a writable path on a non-system drive (e.g. D:\\ZenCache)"
            )));
        }
    }
    Ok(())
}

/// Collapse `..` / `.` segments in a backslash-delimited Windows path so
/// the system-root check in [`validate_data_dir`] sees the effective path.
/// `C:\Foo\..\Windows` → `C:\Windows`. Conservative: leading `..` segments
/// stay (we don't try to resolve against a CWD here — that's the sidecar's
/// job on the remote host). UNC roots (`\\host\share\...`) are preserved.
pub(crate) fn collapse_path_segments(p: &str) -> String {
    if p.starts_with(r"\\") {
        // UNC: preserve the leading `\\<host>\<share>` then collapse the rest.
        let after = &p[2..];
        let split: Vec<&str> = after.splitn(3, '\\').collect();
        if split.len() < 2 {
            return p.to_string();
        }
        let head = format!(r"\\{}\{}", split[0], split[1]);
        if split.len() < 3 {
            return head;
        }
        let tail_collapsed = collapse_segments_inner(split[2]);
        if tail_collapsed.is_empty() {
            head
        } else {
            format!(r"{head}\{tail_collapsed}")
        }
    } else if p.len() >= 3
        && p.as_bytes()[0].is_ascii_alphabetic()
        && p.as_bytes()[1] == b':'
        && p.as_bytes()[2] == b'\\'
    {
        // Drive-absolute: `C:\foo\..\bar` → `C:\bar`.
        let head = &p[..3];
        let tail_collapsed = collapse_segments_inner(&p[3..]);
        if tail_collapsed.is_empty() {
            head.to_string()
        } else {
            format!("{head}{tail_collapsed}")
        }
    } else {
        // Relative / unrecognized — collapse what we can and leave the rest.
        collapse_segments_inner(p)
    }
}

fn collapse_segments_inner(rest: &str) -> String {
    let mut stack: Vec<&str> = Vec::new();
    for seg in rest.split('\\') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            if !stack.is_empty() {
                stack.pop();
            }
            // Else: leading `..` survives; we don't have a parent to pop.
            continue;
        }
        stack.push(seg);
    }
    stack.join("\\")
}

/// Enforce upstream-pointer rules:
/// - `shared_upstream` endpoints must have `None`,
/// - `local` endpoints may have `Some(id)` but the id must exist, be
///   `shared_upstream`, and not equal `self_id`.
///
/// Runs against `conn` (a transaction) so the existence + role checks are
/// observed in the same DB snapshot as the subsequent write.
fn validate_upstream_tx(
    conn: &Connection,
    role: &str,
    upstream: Option<i64>,
    self_id: Option<i64>,
) -> VoloResult<()> {
    match (role, upstream) {
        (ROLE_SHARED_UPSTREAM, Some(id)) => Err(VoloError::InvalidInput(format!(
            "shared_upstream endpoint must not have an upstream_endpoint_id (got {id}); cluster master cannot forward upstream"
        ))),
        (_, None) => Ok(()),
        (ROLE_LOCAL, Some(target_id)) => {
            if let Some(s) = self_id {
                if s == target_id {
                    return Err(VoloError::InvalidInput(format!(
                        "upstream_endpoint_id {target_id} cannot point at self"
                    )));
                }
            }
            let target = zen_endpoints::get_tx(conn, target_id)?.ok_or_else(|| {
                VoloError::InvalidInput(format!(
                    "upstream_endpoint_id {target_id} does not exist"
                ))
            })?;
            if target.role != ROLE_SHARED_UPSTREAM {
                return Err(VoloError::InvalidInput(format!(
                    "upstream_endpoint_id {target_id} has role {:?}; must be {:?}",
                    target.role, ROLE_SHARED_UPSTREAM
                )));
            }
            Ok(())
        }
        // Any unknown role is rejected earlier by validate_role; this arm keeps
        // the match exhaustive without an unreachable!.
        (_, Some(_)) => Err(VoloError::InvalidInput(format!(
            "role {role:?} cannot carry an upstream_endpoint_id"
        ))),
    }
}

/// Return the id of an existing endpoint matching `(machine_id, declared_port)`,
/// or `None` if this would be a fresh insert.
fn lookup_existing_id_tx(
    conn: &Connection,
    machine_id: i64,
    declared_port: i64,
) -> VoloResult<Option<i64>> {
    let rows = zen_endpoints::list_for_machine_tx(conn, machine_id)?;
    Ok(rows
        .into_iter()
        .find(|e| e.declared_port == declared_port)
        .and_then(|e| e.id))
}

/// Return all endpoints whose `upstream_endpoint_id == Some(target)`. Used by
/// [`unregister`] to refuse deletion when dependents exist. With cluster-scale
/// endpoint counts (10s), a full table scan + filter is fine.
fn list_dependents_of_tx(conn: &Connection, target: i64) -> VoloResult<Vec<ZenEndpoint>> {
    let all = zen_endpoints::list_tx(conn)?;
    Ok(all
        .into_iter()
        .filter(|e| e.upstream_endpoint_id == Some(target))
        .collect())
}

/// Refuse a demote (`shared_upstream → anything-else`) if other endpoints
/// still reference `id` as their upstream. Keeps the topology invariant
/// "an upstream pointer must reference a `shared_upstream` row" intact
/// without silently mutating dependents.
fn ensure_no_dependents_on_demote_tx(conn: &Connection, id: i64) -> VoloResult<()> {
    let dependents = list_dependents_of_tx(conn, id)?;
    if dependents.is_empty() {
        return Ok(());
    }
    let ids: Vec<String> = dependents
        .iter()
        .filter_map(|e| e.id.map(|i| i.to_string()))
        .collect();
    Err(VoloError::InvalidInput(format!(
        "cannot demote zen endpoint {id} from shared_upstream: still referenced as upstream by endpoint(s) [{}]; un-point them first",
        ids.join(", ")
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::{machines, open_in_memory, schema, Machine};

    fn setup() -> (Db, i64) {
        let db = open_in_memory().unwrap();
        {
            let mut conn = db.lock().unwrap();
            schema::migrate(&mut conn).unwrap();
        }
        let machine_id =
            machines::insert(&db, &Machine::new("ZEN-01", "192.168.10.30")).unwrap();
        (db, machine_id)
    }

    /// Test helper: callers that only need the id can drop `inserted`.
    fn register_id(db: &Db, input: &EndpointInput) -> VoloResult<i64> {
        register(db, input).map(|o| o.id)
    }

    fn valid_local(machine_id: i64, port: i64) -> EndpointInput {
        EndpointInput {
            machine_id,
            declared_port: port,
            scheme: "http".into(),
            role: ROLE_LOCAL.into(),
            upstream_endpoint_id: None,
            data_dir: "C:\\ZenData".into(),
            httpserverclass: "asio".into(),
            lifecycle_mode: "editor_owned".into(),
            install_dir: None,
            config_path_override: None,
        }
    }

    fn valid_master(machine_id: i64, port: i64) -> EndpointInput {
        EndpointInput {
            machine_id,
            declared_port: port,
            scheme: "http".into(),
            role: ROLE_SHARED_UPSTREAM.into(),
            upstream_endpoint_id: None,
            data_dir: "C:\\ZenData\\master".into(),
            httpserverclass: "asio".into(),
            lifecycle_mode: "installed_service".into(),
            install_dir: None,
            config_path_override: None,
        }
    }

    fn assert_invalid_input(err: &VoloError, needle: &str) {
        match err {
            VoloError::InvalidInput(msg) => assert!(
                msg.contains(needle),
                "expected InvalidInput message to contain {needle:?}, got {msg:?}"
            ),
            other => panic!("expected InvalidInput, got {other:?}"),
        }
    }

    #[test]
    fn register_valid_local_returns_id_and_inserted_true() {
        let (db, m) = setup();
        let outcome = register(&db, &valid_local(m, 8558)).unwrap();
        assert!(outcome.id > 0);
        assert!(outcome.inserted);
        let got = get(&db, outcome.id).unwrap().unwrap();
        assert_eq!(got.role, ROLE_LOCAL);
        assert_eq!(got.declared_port, 8558);
        assert_eq!(got.scheme, "http");
        assert!(got.upstream_endpoint_id.is_none());
    }

    #[test]
    fn register_valid_master_returns_id() {
        let (db, m) = setup();
        let id = register_id(&db, &valid_master(m, 8558)).unwrap();
        let got = get(&db, id).unwrap().unwrap();
        assert_eq!(got.role, ROLE_SHARED_UPSTREAM);
        assert_eq!(got.lifecycle_mode, "installed_service");
    }

    #[test]
    fn register_rejects_port_zero() {
        let (db, m) = setup();
        let mut input = valid_local(m, 0);
        input.declared_port = 0;
        let err = register(&db, &input).unwrap_err();
        assert_invalid_input(&err, "declared_port");
    }

    #[test]
    fn register_rejects_port_over_max() {
        let (db, m) = setup();
        let mut input = valid_local(m, 65536);
        input.declared_port = 65536;
        let err = register(&db, &input).unwrap_err();
        assert_invalid_input(&err, "declared_port");
    }

    #[test]
    fn register_accepts_privileged_port() {
        // Plan note: privileged ports <1024 are allowed (Windows service can bind).
        let (db, m) = setup();
        let id = register_id(&db, &valid_local(m, 80)).unwrap();
        assert!(id > 0);
    }

    #[test]
    fn register_rejects_invalid_scheme() {
        let (db, m) = setup();
        let mut input = valid_local(m, 8558);
        input.scheme = "ftp".into();
        let err = register(&db, &input).unwrap_err();
        assert_invalid_input(&err, "scheme");
    }

    #[test]
    fn register_rejects_invalid_role() {
        let (db, m) = setup();
        let mut input = valid_local(m, 8558);
        input.role = "primary".into(); // pre-v4 placeholder, no longer accepted
        let err = register(&db, &input).unwrap_err();
        assert_invalid_input(&err, "role");
    }

    #[test]
    fn register_rejects_invalid_httpserverclass() {
        let (db, m) = setup();
        let mut input = valid_local(m, 8558);
        input.httpserverclass = "kestrel".into();
        let err = register(&db, &input).unwrap_err();
        assert_invalid_input(&err, "httpserverclass");
    }

    #[test]
    fn register_rejects_invalid_lifecycle_mode() {
        let (db, m) = setup();
        let mut input = valid_local(m, 8558);
        input.lifecycle_mode = "managed".into(); // pre-v4 placeholder
        let err = register(&db, &input).unwrap_err();
        assert_invalid_input(&err, "lifecycle_mode");
    }

    #[test]
    fn register_rejects_empty_data_dir() {
        let (db, m) = setup();
        let mut input = valid_local(m, 8558);
        input.data_dir = "".into();
        let err = register(&db, &input).unwrap_err();
        assert_invalid_input(&err, "data_dir");
    }

    #[test]
    fn register_rejects_whitespace_data_dir() {
        let (db, m) = setup();
        let mut input = valid_local(m, 8558);
        input.data_dir = "   \t  ".into();
        let err = register(&db, &input).unwrap_err();
        assert_invalid_input(&err, "data_dir");
    }

    // -------- T2.8 datadir safety --------

    #[test]
    fn register_rejects_data_dir_under_windows() {
        let (db, m) = setup();
        for path in &[
            r"C:\Windows\Zen",
            r"C:\WINDOWS\Zen",
            r"c:\windows\system32\Zen",
            r"C:\Windows",
            r"C:\Windows\",
        ] {
            let mut input = valid_local(m, 8558);
            input.data_dir = (*path).into();
            register(&db, &input).expect_err(&format!("expected reject for {path}"));
        }
    }

    #[test]
    fn register_rejects_data_dir_under_program_files() {
        let (db, m) = setup();
        for path in &[
            r"C:\Program Files\Zen",
            r"C:\Program Files (x86)\Zen",
            r"C:\Program Files",
            r"c:\PROGRAM FILES\Zen",
        ] {
            let mut input = valid_local(m, 8558);
            input.data_dir = (*path).into();
            register(&db, &input).expect_err(&format!("expected reject for {path}"));
        }
    }

    #[test]
    fn register_rejects_traversal_into_system_root() {
        // After collapsing `..` segments, this resolves to `C:\Windows\Zen`.
        let (db, m) = setup();
        let mut input = valid_local(m, 8558);
        input.data_dir = r"C:\Foo\..\Windows\Zen".into();
        let err = register(&db, &input).unwrap_err();
        assert_invalid_input(&err, "forbidden system location");
    }

    #[test]
    fn register_rejects_win32_device_namespace_prefix() {
        let (db, m) = setup();
        for prefix in &[
            r"\\?\C:\Windows\Zen",
            r"\\.\C:\Zen",
            r"//?/C:/Zen",
            // Mixed-separator variants (codex P2): normalize first so
            // both forms are caught.
            r"\\?/C:/Windows/Zen",
            r"//?\C:\Windows\Zen",
            r"\\.\C:/Zen",
            r"//./C:\Zen",
        ] {
            let mut input = valid_local(m, 8558);
            input.data_dir = (*prefix).into();
            let err = register(&db, &input).unwrap_err();
            assert_invalid_input(&err, "Win32 device namespace");
        }
    }

    // Codex round-16 P2: drive-relative and root-relative paths must be
    // rejected at register time. Without this, `editor_owned` / `local`
    // endpoints would persist an ambiguous data_dir and lua-config
    // render would write it into `server.datadir` for zen to resolve
    // against process CWD — different launchers see different data
    // dirs. The strict `zen-service-install.ps1` guard catches the
    // same shape but only on the service-install lifecycle.
    #[test]
    fn register_rejects_drive_relative_data_dir() {
        let (db, m) = setup();
        let mut input = valid_local(m, 8558);
        input.data_dir = "D:ZenCache".into();
        let err = register(&db, &input).unwrap_err();
        assert_invalid_input(&err, "fully-qualified absolute path");
    }

    #[test]
    fn register_rejects_root_relative_data_dir() {
        let (db, m) = setup();
        let mut input = valid_local(m, 8559);
        input.data_dir = r"\ZenCache".into();
        let err = register(&db, &input).unwrap_err();
        assert_invalid_input(&err, "fully-qualified absolute path");
    }

    #[test]
    fn register_rejects_bare_relative_data_dir() {
        let (db, m) = setup();
        let mut input = valid_local(m, 8560);
        input.data_dir = "ZenCache".into();
        let err = register(&db, &input).unwrap_err();
        assert_invalid_input(&err, "fully-qualified absolute path");
    }

    #[test]
    fn register_accepts_safe_data_dirs() {
        let (db, m) = setup();
        for path in &[
            r"D:\ZenData",
            r"D:\ZenData\sub",
            r"E:\App Data\Zen",
            r"\\fileserver\zen\cache",
            r"C:\Tools\UECM\Zen",
            // forward slashes accepted (normalized internally).
            r"D:/ZenData",
        ] {
            let mut input = valid_local(m, 8558);
            input.data_dir = (*path).into();
            // Use a distinct port per path so each registers cleanly.
            input.declared_port = 8558 + (path.len() as i64);
            register(&db, &input).unwrap_or_else(|e| {
                panic!("expected {path} to be accepted, got {e:?}")
            });
        }
    }


    #[test]
    fn register_rejects_upstream_pointing_at_nonexistent() {
        let (db, m) = setup();
        let mut input = valid_local(m, 8558);
        input.upstream_endpoint_id = Some(9999);
        let err = register(&db, &input).unwrap_err();
        assert_invalid_input(&err, "does not exist");
    }

    #[test]
    fn register_rejects_upstream_pointing_at_local() {
        let (db, m) = setup();
        let peer = register_id(&db, &valid_local(m, 8559)).unwrap();
        let mut input = valid_local(m, 8558);
        input.upstream_endpoint_id = Some(peer);
        let err = register(&db, &input).unwrap_err();
        assert_invalid_input(&err, "shared_upstream");
    }

    #[test]
    fn register_rejects_upstream_pointing_at_self() {
        // After the row exists, re-register with `upstream_endpoint_id = self`
        // must reject — validation runs even on the conflict path.
        let (db, m) = setup();
        let self_id = register_id(&db, &valid_local(m, 8558)).unwrap();
        let mut input = valid_local(m, 8558);
        input.upstream_endpoint_id = Some(self_id);
        let err = register(&db, &input).unwrap_err();
        assert_invalid_input(&err, "self");
    }

    #[test]
    fn register_validates_upstream_even_on_conflict_path() {
        // Existing row + retry with `upstream_endpoint_id` pointing at a
        // non-existent endpoint must still fail rather than silently no-op.
        let (db, m) = setup();
        register(&db, &valid_local(m, 8558)).unwrap();
        let mut input = valid_local(m, 8558);
        input.upstream_endpoint_id = Some(9999);
        let err = register(&db, &input).unwrap_err();
        assert_invalid_input(&err, "does not exist");
    }

    #[test]
    fn register_is_idempotent_on_natural_key_conflict() {
        // Plan §7.2: re-register with same (machine_id, declared_port) returns
        // the existing id and does NOT overwrite role / data_dir / etc.
        let (db, m) = setup();
        let first = register(&db, &valid_local(m, 8558)).unwrap();
        assert!(first.inserted);
        let mut conflicting = valid_local(m, 8558);
        conflicting.scheme = "https".into();
        conflicting.data_dir = "D:\\Other".into();
        let second = register(&db, &conflicting).unwrap();
        assert_eq!(first.id, second.id);
        assert!(!second.inserted, "second register must report inserted=false");
        let got = get(&db, first.id).unwrap().unwrap();
        // Fields unchanged from the original insert.
        assert_eq!(got.scheme, "http");
        assert_eq!(got.data_dir, "C:\\ZenData");
    }

    #[test]
    fn register_rejects_shared_upstream_with_upstream_set() {
        let (db, m) = setup();
        let master = register_id(&db, &valid_master(m, 8559)).unwrap();
        let mut input = valid_master(m, 8558);
        input.upstream_endpoint_id = Some(master);
        let err = register(&db, &input).unwrap_err();
        assert_invalid_input(&err, "cluster master");
    }

    #[test]
    fn register_local_pointing_at_master_succeeds() {
        let (db, m) = setup();
        let master = register_id(&db, &valid_master(m, 8559)).unwrap();
        let mut input = valid_local(m, 8558);
        input.upstream_endpoint_id = Some(master);
        let id = register_id(&db, &input).unwrap();
        let got = get(&db, id).unwrap().unwrap();
        assert_eq!(got.upstream_endpoint_id, Some(master));
    }

    #[test]
    fn change_role_local_to_shared_upstream_with_none_succeeds() {
        let (db, m) = setup();
        // The row must already be `installed_service` before it can be
        // promoted to `shared_upstream` (plan §634).
        let mut input = valid_local(m, 8558);
        input.lifecycle_mode = "installed_service".into();
        let id = register_id(&db, &input).unwrap();
        change_role(&db, id, ROLE_SHARED_UPSTREAM, None).unwrap();
        let got = get(&db, id).unwrap().unwrap();
        assert_eq!(got.role, ROLE_SHARED_UPSTREAM);
        assert!(got.upstream_endpoint_id.is_none());
    }

    #[test]
    fn change_role_local_to_shared_upstream_with_some_fails() {
        let (db, m) = setup();
        let master = register_id(&db, &valid_master(m, 8559)).unwrap();
        let mut input = valid_local(m, 8558);
        input.lifecycle_mode = "installed_service".into();
        let id = register_id(&db, &input).unwrap();
        let err = change_role(&db, id, ROLE_SHARED_UPSTREAM, Some(master)).unwrap_err();
        assert_invalid_input(&err, "cluster master");
    }

    #[test]
    fn register_rejects_shared_upstream_with_editor_owned() {
        // Plan §634: cluster master MUST be installed_service.
        let (db, m) = setup();
        let mut input = valid_master(m, 8558);
        input.lifecycle_mode = "editor_owned".into();
        let err = register(&db, &input).unwrap_err();
        assert_invalid_input(&err, "installed_service");
    }

    #[test]
    fn change_role_rejects_promote_when_lifecycle_is_editor_owned() {
        let (db, m) = setup();
        // Default `valid_local` is `editor_owned`; promoting to
        // `shared_upstream` should fail until lifecycle is upgraded.
        let id = register_id(&db, &valid_local(m, 8558)).unwrap();
        let err = change_role(&db, id, ROLE_SHARED_UPSTREAM, None).unwrap_err();
        assert_invalid_input(&err, "installed_service");
    }

    #[test]
    fn register_accepts_local_with_installed_service() {
        // Local endpoints can run either lifecycle.
        let (db, m) = setup();
        let mut input = valid_local(m, 8558);
        input.lifecycle_mode = "installed_service".into();
        let id = register_id(&db, &input).unwrap();
        assert!(id > 0);
    }

    #[test]
    fn change_role_shared_upstream_to_local_with_new_upstream_succeeds() {
        let (db, m) = setup();
        let master = register_id(&db, &valid_master(m, 8559)).unwrap();
        let id = register_id(&db, &valid_master(m, 8558)).unwrap();
        change_role(&db, id, ROLE_LOCAL, Some(master)).unwrap();
        let got = get(&db, id).unwrap().unwrap();
        assert_eq!(got.role, ROLE_LOCAL);
        assert_eq!(got.upstream_endpoint_id, Some(master));
    }

    #[test]
    fn change_role_local_to_local_updates_upstream() {
        let (db, m) = setup();
        let master_a = register_id(&db, &valid_master(m, 8560)).unwrap();
        let master_b = register_id(&db, &valid_master(m, 8561)).unwrap();
        let mut input = valid_local(m, 8558);
        input.upstream_endpoint_id = Some(master_a);
        let id = register_id(&db, &input).unwrap();
        change_role(&db, id, ROLE_LOCAL, Some(master_b)).unwrap();
        let got = get(&db, id).unwrap().unwrap();
        assert_eq!(got.upstream_endpoint_id, Some(master_b));
    }

    #[test]
    fn change_role_rejects_self_loop() {
        let (db, m) = setup();
        let id = register_id(&db, &valid_local(m, 8558)).unwrap();
        let err = change_role(&db, id, ROLE_LOCAL, Some(id)).unwrap_err();
        assert_invalid_input(&err, "self");
    }

    #[test]
    fn unregister_refuses_when_dependents_exist() {
        let (db, m) = setup();
        let master = register_id(&db, &valid_master(m, 8559)).unwrap();
        let mut child = valid_local(m, 8558);
        child.upstream_endpoint_id = Some(master);
        let _child_id = register_id(&db, &child).unwrap();
        let err = unregister(&db, master).unwrap_err();
        assert_invalid_input(&err, "referenced as upstream");
    }

    #[test]
    fn unregister_succeeds_when_no_dependents() {
        let (db, m) = setup();
        let master = register_id(&db, &valid_master(m, 8559)).unwrap();
        unregister(&db, master).unwrap();
        assert!(get(&db, master).unwrap().is_none());
    }

    #[test]
    fn unregister_succeeds_after_dependents_unpointed() {
        let (db, m) = setup();
        let master = register_id(&db, &valid_master(m, 8559)).unwrap();
        let mut child = valid_local(m, 8558);
        child.upstream_endpoint_id = Some(master);
        let child_id = register_id(&db, &child).unwrap();
        // Un-point the child, then master is deletable.
        change_role(&db, child_id, ROLE_LOCAL, None).unwrap();
        unregister(&db, master).unwrap();
        assert!(get(&db, master).unwrap().is_none());
    }

    #[test]
    fn change_role_rejects_demote_when_dependents_exist() {
        let (db, m) = setup();
        let master = register_id(&db, &valid_master(m, 8559)).unwrap();
        let mut child = valid_local(m, 8558);
        child.upstream_endpoint_id = Some(master);
        let _child_id = register_id(&db, &child).unwrap();
        let err = change_role(&db, master, ROLE_LOCAL, None).unwrap_err();
        assert_invalid_input(&err, "still referenced as upstream");
    }

    #[test]
    fn register_does_not_demote_via_conflict() {
        // A retried `register` with role=local must NOT silently demote an
        // existing `shared_upstream` row — idempotency contract (plan §7.2)
        // says the existing row stays intact.
        let (db, m) = setup();
        let master = register_id(&db, &valid_master(m, 8559)).unwrap();
        let conflicting = EndpointInput {
            machine_id: m,
            declared_port: 8559,
            scheme: "http".into(),
            role: ROLE_LOCAL.into(),
            upstream_endpoint_id: None,
            data_dir: "C:\\ZenData\\master".into(),
            httpserverclass: "asio".into(),
            lifecycle_mode: "installed_service".into(),
            install_dir: None,
            config_path_override: None,
        };
        let outcome = register(&db, &conflicting).unwrap();
        assert_eq!(outcome.id, master);
        assert!(!outcome.inserted);
        let got = get(&db, master).unwrap().unwrap();
        assert_eq!(got.role, ROLE_SHARED_UPSTREAM);
    }

    // -------- update_deploy_config --------

    fn patch_from(ep: &EndpointInput) -> DeployConfigPatch {
        DeployConfigPatch {
            scheme: ep.scheme.clone(),
            data_dir: ep.data_dir.clone(),
            httpserverclass: ep.httpserverclass.clone(),
            install_dir: ep.install_dir.clone(),
            config_path_override: ep.config_path_override.clone(),
        }
    }

    #[test]
    fn update_deploy_config_persists_new_fields() {
        let (db, m) = setup();
        let id = register_id(&db, &valid_local(m, 8558)).unwrap();
        let patch = DeployConfigPatch {
            scheme: "http".into(),
            data_dir: "D:\\NewData".into(),
            httpserverclass: "httpsys".into(),
            install_dir: Some("D:\\NewInstall".into()),
            config_path_override: Some("D:\\NewInstall\\zen_config.lua".into()),
        };
        let outcome = update_deploy_config(&db, id, &patch).unwrap();
        assert!(outcome.data_dir_changed);
        assert!(outcome.install_dir_changed);
        assert_eq!(outcome.previous_data_dir, "C:\\ZenData");
        let got = get(&db, id).unwrap().unwrap();
        assert_eq!(got.data_dir, "D:\\NewData");
        assert_eq!(got.httpserverclass, "httpsys");
        assert_eq!(got.install_dir.as_deref(), Some("D:\\NewInstall"));
        assert_eq!(
            got.config_path_override.as_deref(),
            Some("D:\\NewInstall\\zen_config.lua")
        );
    }

    #[test]
    fn update_deploy_config_reports_unchanged_fields_as_unchanged() {
        let (db, m) = setup();
        let input = valid_local(m, 8558);
        let id = register_id(&db, &input).unwrap();
        let outcome = update_deploy_config(&db, id, &patch_from(&input)).unwrap();
        assert!(!outcome.data_dir_changed);
        assert!(!outcome.install_dir_changed);
    }

    #[test]
    fn update_deploy_config_preserves_role_upstream_and_service_account() {
        let (db, m) = setup();
        let master = register_id(&db, &valid_master(m, 8559)).unwrap();
        let mut input = valid_local(m, 8558);
        input.upstream_endpoint_id = Some(master);
        let id = register_id(&db, &input).unwrap();
        update_service_account_for_test(&db, id);

        let mut patch = patch_from(&input);
        patch.data_dir = "D:\\NewData".into();
        update_deploy_config(&db, id, &patch).unwrap();

        let got = get(&db, id).unwrap().unwrap();
        assert_eq!(got.role, ROLE_LOCAL);
        assert_eq!(got.upstream_endpoint_id, Some(master));
        assert_eq!(got.service_account_username.as_deref(), Some("zen-svc-test"));
    }

    fn update_service_account_for_test(db: &Db, endpoint_id: i64) {
        zen_endpoints::update_service_account(
            db,
            endpoint_id,
            Some("zen-svc-test"),
            Some("zen-svc:1:zen-svc-test"),
        )
        .unwrap();
    }

    #[test]
    fn update_deploy_config_rejects_unsafe_data_dir() {
        let (db, m) = setup();
        let input = valid_local(m, 8558);
        let id = register_id(&db, &input).unwrap();
        let mut patch = patch_from(&input);
        patch.data_dir = r"C:\Windows\Zen".into();
        let err = update_deploy_config(&db, id, &patch).unwrap_err();
        assert_invalid_input(&err, "forbidden system location");
    }

    #[test]
    fn update_deploy_config_rejects_invalid_httpserverclass() {
        let (db, m) = setup();
        let input = valid_local(m, 8558);
        let id = register_id(&db, &input).unwrap();
        let mut patch = patch_from(&input);
        patch.httpserverclass = "kestrel".into();
        let err = update_deploy_config(&db, id, &patch).unwrap_err();
        assert_invalid_input(&err, "httpserverclass");
    }

    #[test]
    fn update_deploy_config_rejects_unknown_endpoint() {
        let (db, m) = setup();
        let input = valid_local(m, 8558);
        let err = update_deploy_config(&db, 9999, &patch_from(&input)).unwrap_err();
        assert_invalid_input(&err, "does not exist");
    }

    #[test]
    fn unregister_rejects_unknown_id() {
        let (db, _m) = setup();
        let err = unregister(&db, 9999).unwrap_err();
        assert_invalid_input(&err, "does not exist");
    }

    #[test]
    fn list_and_list_for_machine_passthrough() {
        let (db, m) = setup();
        register(&db, &valid_master(m, 8559)).unwrap();
        register(&db, &valid_local(m, 8558)).unwrap();
        assert_eq!(list(&db).unwrap().len(), 2);
        assert_eq!(list_for_machine(&db, m).unwrap().len(), 2);
        assert_eq!(list_for_machine(&db, 9999).unwrap().len(), 0);
    }
}
