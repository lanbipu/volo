//! Username normalization for credential metadata.
//!
//! The cmdkey + DPAPI secret store was removed in the SSH migration (P5b);
//! secrets now live in the cross-platform `core::secrets::SecretStore`. The only
//! thing left here is the username normalizer used when persisting credential
//! alias metadata (kind + display username) to SQLite.

pub fn normalize_username_for_storage(username: &str) -> String {
    let trimmed = username.trim();
    trimmed
        .strip_prefix(".\\")
        .or_else(|| trimmed.strip_prefix("./"))
        .unwrap_or(trimmed)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_username_for_storage_strips_dot_slash_prefix() {
        assert_eq!(normalize_username_for_storage(".\\uecm-test"), "uecm-test");
        assert_eq!(normalize_username_for_storage("./uecm-test"), "uecm-test");
    }

    #[test]
    fn normalize_username_for_storage_preserves_domain_and_upn() {
        assert_eq!(normalize_username_for_storage("LANPC\\uecm-test"), "LANPC\\uecm-test");
        assert_eq!(
            normalize_username_for_storage("uecm-test@example.local"),
            "uecm-test@example.local"
        );
    }
}
