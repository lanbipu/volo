//! Dedicated local Windows service account provisioning for ZenServer's
//! "专用本地账号" tier — Epic's officially-recommended least-privilege
//! alternative to running the shared cache service as SYSTEM (see
//! `core::zen::lua_config`'s module doc for the citation trail on the
//! adjacent `zen_config.lua` format; the account-permission requirements
//! this module exists to satisfy come from the same Epic "Shared DDC" guide:
//! `log on as a service`, read access to `{ZenInstall}`, read+write access
//! to `{ZenData}`, and a urlacl reservation — the last two are granted by
//! `zen-service-install.ps1` / `zen_urlacl_add` respectively, not here).
//!
//! This module only creates the account and stores its generated password;
//! it does not touch `zen_endpoints` — callers persist the returned
//! `username` / `cred_alias` onto whichever endpoint ends up using the
//! account (account creation can happen before an endpoint is registered).

use crate::core::secrets::SecretStore;
use crate::core::shares::generate_svc_password;
use crate::error::UecmResult;
use rand::distributions::Alphanumeric;
use rand::Rng;

/// Generate a random dedicated-account username: `zen-svc-` + 6 lowercase
/// alphanumeric characters. Collisions are harmless — `zen-account-create.ps1`
/// is idempotent (`Set-LocalUser` on conflict), same as `setup-share-mode-b.ps1`.
pub fn generate_dedicated_service_account_username() -> String {
    let suffix: String = rand::thread_rng()
        .sample_iter(Alphanumeric)
        .take(6)
        .map(char::from)
        .collect::<String>()
        .to_ascii_lowercase();
    format!("zen-svc-{suffix}")
}

/// `SecretStore` alias a dedicated account's password is stored under.
/// Keyed by machine + username (not endpoint_id) so account creation isn't
/// blocked on an endpoint already existing.
pub fn cred_alias_for(machine_id: i64, username: &str) -> String {
    format!("zen-svc:{machine_id}:{username}")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DedicatedAccountResult {
    pub username: String,
    pub cred_alias: String,
}

/// Create (or refresh the password of, if it already exists) a dedicated
/// local Windows account on `host` for running the ZenServer service — the
/// same `New-LocalUser`/`Set-LocalUser` idempotent pattern
/// `setup-share-mode-b.ps1` already uses for share accounts. The generated
/// password is stored in `SecretStore` and never returned to the caller.
///
/// Stores the password in `SecretStore` *before* creating the remote
/// account: if the remote step then fails, the only leftover is a harmless
/// unused secret entry (each attempt generates a fresh username/alias, so it
/// never collides with a later retry). Doing it the other way around would
/// risk the opposite failure mode — a remote account created with a
/// password nobody can retrieve if the `SecretStore` write then failed.
pub fn create_dedicated_account(machine_id: i64, host: &str) -> UecmResult<DedicatedAccountResult> {
    let username = generate_dedicated_service_account_username();
    let password = generate_svc_password();
    let cred_alias = cred_alias_for(machine_id, &username);
    SecretStore::from_config()?.put(&cred_alias, &password)?;

    let args = serde_json::json!({ "Username": username, "Password": password });
    let raw = super::ops::run_node(host, "zen-account-create.ps1", args)?;
    super::ops::parse_envelope(&raw, "zen-account-create")?;

    Ok(DedicatedAccountResult { username, cred_alias })
}

/// Look up a previously-stored dedicated/domain service-account password by
/// its `SecretStore` alias. Returns `Ok(None)` if the alias was never set
/// (e.g. an operator-supplied manual account that was never routed through
/// `create_dedicated_account`).
pub fn resolve_password(cred_alias: &str) -> UecmResult<Option<String>> {
    SecretStore::from_config()?.get(cred_alias)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_username_has_expected_shape() {
        let u = generate_dedicated_service_account_username();
        assert!(u.starts_with("zen-svc-"));
        let suffix = u.strip_prefix("zen-svc-").unwrap();
        assert_eq!(suffix.len(), 6);
        assert!(suffix.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()));
    }

    #[test]
    fn generated_usernames_differ() {
        let a = generate_dedicated_service_account_username();
        let b = generate_dedicated_service_account_username();
        assert_ne!(a, b);
    }

    #[test]
    fn cred_alias_is_scoped_by_machine_and_username() {
        assert_eq!(cred_alias_for(3, "zen-svc-ab12cd"), "zen-svc:3:zen-svc-ab12cd");
        assert_ne!(cred_alias_for(3, "zen-svc-ab12cd"), cred_alias_for(4, "zen-svc-ab12cd"));
    }
}
