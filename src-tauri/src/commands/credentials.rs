//! Tauri commands for credential management. The SQLite `credentials` row holds
//! the alias metadata (kind + username); the secret lives in the cross-platform
//! SecretStore (AES-GCM).

use cache_core::core::credentials as core_creds;
use cache_core::core::secrets::SecretStore;
use cache_core::data::{credentials as data_creds, CredentialKind, CredentialRecord, Db};
use cache_core::error::VoloResult;
use tauri::State;

#[tauri::command]
pub fn list_credentials(db: State<'_, Db>) -> VoloResult<Vec<CredentialRecord>> {
    data_creds::list_all(&db)
}

#[tauri::command]
pub fn save_credential(
    db: State<'_, Db>,
    alias: String,
    kind: CredentialKind,
    username: String,
    password: String,
) -> VoloResult<i64> {
    let username = core_creds::normalize_username_for_storage(&username);

    // Store the secret in the cross-platform SecretStore (AES-GCM), replacing the
    // Windows-only cmdkey + DPAPI writes. If this fails nothing else is written,
    // so the saved state stays consistent (no half-saved alias). SQLite then holds
    // the alias metadata that `list_credentials` surfaces.
    SecretStore::from_config()?.put(&alias, &password)?;

    let record = CredentialRecord {
        id: None,
        alias: alias.clone(),
        kind,
        username,
    };
    if data_creds::find_by_alias(&db, &alias)?.is_some() {
        data_creds::delete_by_alias(&db, &alias)?;
    }
    data_creds::insert(&db, &record)
}

#[tauri::command]
pub fn delete_credential(db: State<'_, Db>, alias: String) -> VoloResult<()> {
    // SQLite metadata is the UI source of truth — always clear it.
    data_creds::delete_by_alias(&db, &alias)?;

    // SecretStore (AES-GCM) is the only secret home now — best-effort orphan
    // cleanup so a deleted alias does not leave its secret on disk.
    if let Err(e) = SecretStore::from_config().and_then(|s| s.delete(&alias)) {
        tracing::warn!(alias = %alias, error = %e, "SecretStore delete failed; orphan secret may remain");
    }
    Ok(())
}
