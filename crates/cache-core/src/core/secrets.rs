//! Cross-platform secret store: AES-GCM-256 encrypted file, key in a 0600 file
//! next to the config dir. Replaces DPAPI (Windows-only). Holds managed-share /
//! SMB / service secrets that the operator must keep (not just re-provision).
use crate::error::{VoloError, VoloResult};
use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Key, Nonce,
};
use rand::RngCore;
use std::collections::BTreeMap;
use std::path::PathBuf;

pub struct SecretStore {
    dir: PathBuf,
}

impl SecretStore {
    pub fn from_config() -> VoloResult<Self> {
        Ok(Self {
            dir: crate::startup::resolve_config_dir()?,
        })
    }

    fn key_path(&self) -> PathBuf {
        self.dir.join("uecm_secrets.key")
    }
    fn store_path(&self) -> PathBuf {
        self.dir.join("uecm_secrets.bin")
    }

    fn load_or_create_key(&self) -> VoloResult<[u8; 32]> {
        let kp = self.key_path();
        if kp.exists() {
            let b = std::fs::read(&kp)?;
            if b.len() != 32 {
                return Err(VoloError::Configuration("bad secrets key length".into()));
            }
            let mut k = [0u8; 32];
            k.copy_from_slice(&b);
            Ok(k)
        } else {
            std::fs::create_dir_all(&self.dir)?;
            let mut k = [0u8; 32];
            rand::rngs::OsRng.fill_bytes(&mut k);
            // Create the key file atomically with 0600 so the raw AES key is
            // never world-readable, not even for the window between create and
            // chmod. create_new also rejects a pre-existing file (TOCTOU).
            #[cfg(unix)]
            {
                use std::io::Write;
                use std::os::unix::fs::OpenOptionsExt;
                let mut f = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .open(&kp)?;
                if let Err(e) = f.write_all(&k) {
                    let _ = std::fs::remove_file(&kp);
                    return Err(e.into());
                }
            }
            #[cfg(not(unix))]
            {
                std::fs::write(&kp, k)?;
            }
            Ok(k)
        }
    }

    fn read_all(&self) -> VoloResult<BTreeMap<String, String>> {
        let sp = self.store_path();
        if !sp.exists() {
            return Ok(BTreeMap::new());
        }
        let key = self.load_or_create_key()?;
        let blob = std::fs::read(&sp)?;
        if blob.len() < 12 {
            return Err(VoloError::Configuration("secrets store too short".into()));
        }
        let (nonce, ct) = blob.split_at(12);
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
        let pt = cipher
            .decrypt(Nonce::from_slice(nonce), ct)
            .map_err(|_| VoloError::Configuration("secrets decrypt failed".into()))?;
        serde_json::from_slice(&pt)
            .map_err(|e| VoloError::Configuration(format!("secrets parse: {e}")))
    }

    fn write_all(&self, map: &BTreeMap<String, String>) -> VoloResult<()> {
        let key = self.load_or_create_key()?;
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
        let mut nonce = [0u8; 12];
        rand::rngs::OsRng.fill_bytes(&mut nonce);
        let pt = serde_json::to_vec(map)
            .map_err(|e| VoloError::Configuration(format!("secrets serialize: {e}")))?;
        let ct = cipher
            .encrypt(Nonce::from_slice(&nonce), pt.as_ref())
            .map_err(|_| VoloError::Configuration("secrets encrypt failed".into()))?;
        let mut out = nonce.to_vec();
        out.extend_from_slice(&ct);
        std::fs::write(self.store_path(), out)?;
        Ok(())
    }

    pub fn put(&self, alias: &str, secret: &str) -> VoloResult<()> {
        let mut m = self.read_all()?;
        m.insert(alias.to_string(), secret.to_string());
        self.write_all(&m)
    }
    pub fn get(&self, alias: &str) -> VoloResult<Option<String>> {
        Ok(self.read_all()?.get(alias).cloned())
    }
    pub fn delete(&self, alias: &str) -> VoloResult<()> {
        let mut m = self.read_all()?;
        m.remove(alias);
        self.write_all(&m)
    }
    /// List all stored aliases (keys only — never the secrets), sorted. Backs the
    /// `secret list` CLI command without exposing any plaintext.
    pub fn list(&self) -> VoloResult<Vec<String>> {
        let mut keys: Vec<String> = self.read_all()?.into_keys().collect();
        keys.sort();
        Ok(keys)
    }
}

/// Read a share's svc secret from the SecretStore. Returns `None` when the
/// alias has no stored secret.
///
/// (Kept its name across the SSH migration for its four call sites. The legacy
/// DPAPI fallback + self-healing migration were removed in P5b — the
/// cross-platform SecretStore is the only home now.)
pub fn get_share_secret_migrating(alias: &str) -> VoloResult<Option<String>> {
    SecretStore::from_config()?.get(alias)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_in(dir: &std::path::Path) -> SecretStore {
        SecretStore {
            dir: dir.to_path_buf(),
        }
    }

    #[test]
    fn put_get_delete_round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        let s = store_in(tmp.path());
        assert_eq!(s.get("smb-ddc").unwrap(), None);
        s.put("smb-ddc", "Sup3r$ecret!").unwrap();
        assert_eq!(s.get("smb-ddc").unwrap().as_deref(), Some("Sup3r$ecret!"));
        s.put("other", "second").unwrap();
        assert_eq!(s.get("other").unwrap().as_deref(), Some("second"));
        // overwrite keeps the rest
        s.put("smb-ddc", "rotated").unwrap();
        assert_eq!(s.get("smb-ddc").unwrap().as_deref(), Some("rotated"));
        assert_eq!(s.get("other").unwrap().as_deref(), Some("second"));
        s.delete("smb-ddc").unwrap();
        assert_eq!(s.get("smb-ddc").unwrap(), None);
        assert_eq!(s.get("other").unwrap().as_deref(), Some("second"));
    }

    #[test]
    fn store_file_is_encrypted_not_plaintext() {
        let tmp = tempfile::tempdir().unwrap();
        let s = store_in(tmp.path());
        s.put("alias", "PlaintextNeedle42").unwrap();
        let blob = std::fs::read(tmp.path().join("uecm_secrets.bin")).unwrap();
        assert!(
            !blob.windows(b"PlaintextNeedle42".len()).any(|w| w == b"PlaintextNeedle42"),
            "secret leaked in plaintext"
        );
    }

    #[cfg(unix)]
    #[test]
    fn key_file_is_created_0600() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let s = store_in(tmp.path());
        s.put("a", "b").unwrap();
        let mode = std::fs::metadata(tmp.path().join("uecm_secrets.key"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600, "key file must be 0600, got {mode:o}");
    }

    #[test]
    fn bad_key_length_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("uecm_secrets.key"), b"too-short").unwrap();
        let s = store_in(tmp.path());
        assert!(s.put("a", "b").is_err());
    }
}
