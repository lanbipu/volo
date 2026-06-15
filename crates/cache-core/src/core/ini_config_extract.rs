//! Extract DDC / PSO / Zen config entries from a parsed INI file for
//! `ini_config_snapshots`. Captures the *actual* configured values
//! (not just rule findings). See spec §4.1.

use crate::core::ini_diagnostics::ParsedFile;

/// One captured config key, tagged with the concern domain. `scan_run_id` /
/// `machine_id` / `ue_version` are filled by the caller (DB context).
#[derive(Debug, Clone, PartialEq)]
pub struct ConfigEntry {
    pub domain: &'static str, // "ddc" | "pso" | "zen"
    pub file_path: String,
    pub section: String,
    pub key_name: String,
    pub value: String,
    pub line_number: i64,
}

const DDC_SECTIONS: &[&str] = &[
    "DerivedDataBackendGraph",
    "/Script/UnrealEd.DerivedDataCacheSettings",
];
const INSTALLED_DDBG: &str = "InstalledDerivedDataBackendGraph";
const INSTALLED_LEGACY_DDC_KEYS: &[&str] = &["Shared", "Pak", "CompressedPak"];
// Modern UE 5.4+ DDC server connection settings. `zen enable` writes the shared
// Zen upstream here as `Shared=(Host="http://...", ...)`; the default ZenShared
// node references it via ServerID. Capture every entry as a `zen` config snapshot
// so diagnostics (e.g. R026 dual-config) can see the new-form upstream too.
const STORAGE_SERVERS: &str = "StorageServers";

fn is_pso_cvar(key: &str) -> bool {
    // Case-insensitive: UE INI keys are case-insensitive in practice.
    let lower = key.to_ascii_lowercase();
    lower.starts_with("r.psoprecaching")
        || lower.starts_with("r.psoprecache.")
        || lower.starts_with("r.shaderpipelinecache.")
}

/// Returns config entries for the three concern domains. A single key may
/// yield multiple entries (dual-tag): InstalledDerivedDataBackendGraph's
/// legacy DDC keys (Shared/Pak/CompressedPak) are tagged both `ddc` and `zen`.
pub fn extract(pf: &ParsedFile) -> Vec<ConfigEntry> {
    let mut out = Vec::new();
    for sec in &pf.sections {
        let sname = sec.name.as_str();
        let is_ddc_section = DDC_SECTIONS.iter().any(|s| s.eq_ignore_ascii_case(sname));
        let is_installed = sname.eq_ignore_ascii_case(INSTALLED_DDBG);
        let is_storage_servers = sname.eq_ignore_ascii_case(STORAGE_SERVERS);
        for k in &sec.keys {
            let mk = |domain: &'static str| ConfigEntry {
                domain,
                file_path: pf.path.clone(),
                section: sname.to_string(),
                key_name: k.name.clone(),
                value: k.value.clone(),
                line_number: k.line_number as i64,
            };
            if is_ddc_section {
                out.push(mk("ddc"));
            }
            if is_installed {
                out.push(mk("zen"));
                if INSTALLED_LEGACY_DDC_KEYS.iter().any(|s| s.eq_ignore_ascii_case(&k.name)) {
                    out.push(mk("ddc")); // dual-tag
                }
            }
            if is_storage_servers {
                out.push(mk("zen"));
            }
            if is_pso_cvar(&k.name) {
                out.push(mk("pso"));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::ini_diagnostics::{Category, ParsedFile, ParsedKey, ParsedSection};

    fn key(name: &str, value: &str, line: usize) -> ParsedKey {
        ParsedKey { name: name.into(), value: value.into(), line_number: line }
    }
    fn pf(sections: Vec<ParsedSection>) -> ParsedFile {
        ParsedFile { path: "C:\\Proj\\Config\\DefaultEngine.ini".into(),
            category: Category::Project, sections }
    }

    #[test]
    fn extracts_ddc_backend_graph() {
        let f = pf(vec![ParsedSection {
            name: "DerivedDataBackendGraph".into(),
            keys: vec![key("Root", "(Type=KeyLength)", 3)],
            ..Default::default()
        }]);
        let e = extract(&f);
        assert_eq!(e.len(), 1);
        assert_eq!(e[0].domain, "ddc");
        assert_eq!(e[0].key_name, "Root");
        assert!(e[0].file_path.ends_with("DefaultEngine.ini"));
    }

    #[test]
    fn extracts_pso_cvars_any_section() {
        let f = pf(vec![ParsedSection {
            name: "SystemSettings".into(),
            keys: vec![
                key("r.ShaderPipelineCache.Enabled", "1", 5),
                key("r.PSOPrecache.Compile", "1", 6),
                key("Unrelated", "x", 7),
            ],
            ..Default::default()
        }]);
        let e = extract(&f);
        assert_eq!(e.len(), 2);
        assert!(e.iter().all(|x| x.domain == "pso"));
    }

    #[test]
    fn extracts_ddc_section_case_insensitive() {
        let f = pf(vec![ParsedSection {
            name: "deriveddatabackendgraph".into(), // all-lowercase variant
            keys: vec![key("Root", "(Type=KeyLength)", 3)],
            ..Default::default()
        }]);
        let e = extract(&f);
        assert_eq!(e.len(), 1);
        assert_eq!(e[0].domain, "ddc");
    }

    #[test]
    fn extracts_installed_ddbg_case_insensitive() {
        let f = pf(vec![ParsedSection {
            name: "installedderiveddatabackendgraph".into(), // all-lowercase variant
            keys: vec![
                key("zenshared", "(Type=Zen)", 2),   // lowercase key
                key("shared", "(Type=FileSystem)", 3), // lowercase legacy key
            ],
            ..Default::default()
        }]);
        let e = extract(&f);
        // zenshared → zen; shared → zen + ddc = 3 total
        assert_eq!(e.len(), 3);
        assert!(e.iter().any(|x| x.key_name == "zenshared" && x.domain == "zen"));
        let shared: Vec<_> = e.iter().filter(|x| x.key_name == "shared").map(|x| x.domain).collect();
        assert!(shared.contains(&"ddc"));
        assert!(shared.contains(&"zen"));
    }

    #[test]
    fn pso_cvar_extraction_case_insensitive() {
        let f = pf(vec![ParsedSection {
            name: "SystemSettings".into(),
            keys: vec![
                key("R.PSOPrecache.Compile", "1", 5),        // uppercase R
                key("r.ShaderPipelineCache.ENABLED", "1", 6), // mixed case suffix
                key("Unrelated", "x", 7),
            ],
            ..Default::default()
        }]);
        let e = extract(&f);
        assert_eq!(e.len(), 2);
        assert!(e.iter().all(|x| x.domain == "pso"));
    }

    #[test]
    fn installed_ddbg_legacy_keys_dual_tag_ddc_and_zen() {
        let f = pf(vec![ParsedSection {
            name: "InstalledDerivedDataBackendGraph".into(),
            keys: vec![
                key("Shared", "(Type=FileSystem)", 2),   // legacy DDC → dual
                key("ZenShared", "(Type=Zen)", 3),       // zen only
            ],
            ..Default::default()
        }]);
        let e = extract(&f);
        // Shared: zen + ddc (2); ZenShared: zen (1) = 3 total
        assert_eq!(e.len(), 3);
        let shared: Vec<_> = e.iter().filter(|x| x.key_name == "Shared").map(|x| x.domain).collect();
        assert!(shared.contains(&"ddc"));
        assert!(shared.contains(&"zen"));
        let zenshared: Vec<_> = e.iter().filter(|x| x.key_name == "ZenShared").map(|x| x.domain).collect();
        assert_eq!(zenshared, vec!["zen"]);
    }

    #[test]
    fn extracts_storage_servers_shared_as_zen() {
        // Modern `zen enable` writes the shared upstream as
        // `[StorageServers] Shared=(Host="http://...", ...)`. It must be
        // captured as a `zen` config snapshot so R026 / diagnostics see it.
        let f = pf(vec![ParsedSection {
            name: "StorageServers".into(),
            keys: vec![key(
                "Shared",
                "(Host=\"http://192.168.10.20:8558\", Namespace=\"ue.ddc\", DeactivateAt=60)",
                2,
            )],
            ..Default::default()
        }]);
        let e = extract(&f);
        assert_eq!(e.len(), 1);
        assert_eq!(e[0].domain, "zen");
        assert_eq!(e[0].section, "StorageServers");
        assert_eq!(e[0].key_name, "Shared");
    }

    #[test]
    fn extracts_storage_servers_case_insensitive() {
        let f = pf(vec![ParsedSection {
            name: "storageservers".into(), // all-lowercase variant
            keys: vec![key("shared", "(Host=\"http://h:8558\")", 1)],
            ..Default::default()
        }]);
        let e = extract(&f);
        assert_eq!(e.len(), 1);
        assert_eq!(e[0].domain, "zen");
    }
}
