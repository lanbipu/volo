//! Canonical probe registry. Every probe name + layer assignment + creds-required flag
//! lives here exactly once. PS1 scripts, Rust constants, TS layer maps, locale labels
//! all derive from or are validated against this list — there is no second source of truth.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Layer {
    L1Port,        // Rust TCP probes, no creds
    L2Bootstrap,   // PowerShell via WinRM — registry + service + firewall
    L3Business,    // PowerShell via WinRM — share + cred + env + WMI
    L3Derived,     // computed in Rust from other DB tables (no PS call)
}

#[derive(Debug, Clone, Copy)]
pub struct ProbeSpec {
    pub key: &'static str,
    pub layer: Layer,
    /// `true` if running this probe requires authenticated WinRM (so the no-creds
    /// branch should mark it `na`). L1Port is always `false`; L3Derived is always
    /// `false` (computed from local DB).
    pub requires_creds: bool,
    /// `true` if the PowerShell health-probes.ps1 emits this key into the
    /// `$results` hashtable. Most L2/L3 business probes are PS-emitted; a few
    /// L3Business probes are augmented in Rust after the round-trip
    /// (e.g. rs_service via core::renderstream_service). Drift test only
    /// validates ps_emitted == true.
    pub ps_emitted: bool,
}

pub const PROBE_REGISTRY: &[ProbeSpec] = &[
    // L1 — port reachability (Rust TCP, no creds)
    ProbeSpec { key: "tcp_5985", layer: Layer::L1Port, requires_creds: false, ps_emitted: false },
    ProbeSpec { key: "tcp_445",  layer: Layer::L1Port, requires_creds: false, ps_emitted: false },
    ProbeSpec { key: "tcp_135",  layer: Layer::L1Port, requires_creds: false, ps_emitted: false },

    // L2 — bootstrap configuration (PowerShell via WinRM)
    ProbeSpec { key: "firewall_445",               layer: Layer::L2Bootstrap, requires_creds: true, ps_emitted: true },
    ProbeSpec { key: "local_account_token_filter", layer: Layer::L2Bootstrap, requires_creds: true, ps_emitted: true },
    ProbeSpec { key: "long_paths_enabled",         layer: Layer::L2Bootstrap, requires_creds: true, ps_emitted: true },
    ProbeSpec { key: "lanman_server",              layer: Layer::L2Bootstrap, requires_creds: true, ps_emitted: true },

    // L3 — business workflow (PowerShell via WinRM)
    ProbeSpec { key: "share_reachable", layer: Layer::L3Business, requires_creds: true, ps_emitted: true },
    ProbeSpec { key: "ntfs_perm",       layer: Layer::L3Business, requires_creds: true, ps_emitted: true },
    ProbeSpec { key: "cred_user",       layer: Layer::L3Business, requires_creds: true, ps_emitted: true },
    ProbeSpec { key: "cred_system",     layer: Layer::L3Business, requires_creds: true, ps_emitted: true },
    ProbeSpec { key: "env_vars",        layer: Layer::L3Business, requires_creds: true, ps_emitted: true },
    ProbeSpec { key: "env_local",       layer: Layer::L3Business, requires_creds: true, ps_emitted: true },
    ProbeSpec { key: "env_shared",      layer: Layer::L3Business, requires_creds: true, ps_emitted: true },
    ProbeSpec { key: "system_write",    layer: Layer::L3Business, requires_creds: true, ps_emitted: true },
    ProbeSpec { key: "winmgmt",         layer: Layer::L3Business, requires_creds: true, ps_emitted: true },
    // rs_service: augmented in Rust post-roundtrip via core::renderstream_service::report().
    // Marked as L3Business + requires_creds so the no-creds branch fills it with a placeholder
    // and offline_probe_keys() includes it, but ps_emitted=false so the drift test
    // does NOT require the PS script to emit it.
    ProbeSpec { key: "rs_service",      layer: Layer::L3Business, requires_creds: true, ps_emitted: false },

    // L3 — derived (computed in Rust)
    ProbeSpec { key: "ini_consistency", layer: Layer::L3Derived, requires_creds: false, ps_emitted: false },
    ProbeSpec { key: "pso_precaching",  layer: Layer::L3Derived, requires_creds: false, ps_emitted: false },
    ProbeSpec { key: "gpu_consistency", layer: Layer::L3Derived, requires_creds: false, ps_emitted: false },
];

/// Keys that the offline / no-creds fallback should fill with placeholder outcomes
/// (everything that runs via WinRM — i.e. requires_creds == true).
pub fn offline_probe_keys() -> Vec<&'static str> {
    PROBE_REGISTRY.iter()
        .filter(|p| p.requires_creds)
        .map(|p| p.key)
        .collect()
}

/// Keys the PowerShell script returns (L2 + L3-business that is actually PS-emitted,
/// not Rust-augmented post-roundtrip).
pub fn powershell_probe_keys() -> Vec<&'static str> {
    PROBE_REGISTRY.iter()
        .filter(|p| matches!(p.layer, Layer::L2Bootstrap | Layer::L3Business))
        .filter(|p| p.ps_emitted)
        .map(|p| p.key)
        .collect()
}

/// Look up the layer for a given probe key. `None` for unknown keys.
pub fn layer_for(key: &str) -> Option<Layer> {
    PROBE_REGISTRY.iter().find(|p| p.key == key).map(|p| p.layer)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_contains_three_l1_port_probes() {
        let l1: Vec<_> = PROBE_REGISTRY.iter().filter(|p| p.layer == Layer::L1Port).collect();
        assert_eq!(l1.len(), 3, "expected exactly 3 L1 port probes, got {:?}", l1);
    }

    #[test]
    fn registry_contains_four_l2_bootstrap_probes() {
        let l2: Vec<_> = PROBE_REGISTRY.iter().filter(|p| p.layer == Layer::L2Bootstrap).collect();
        assert_eq!(l2.len(), 4, "expected exactly 4 L2 bootstrap probes, got {:?}", l2);
    }

    #[test]
    fn registry_contains_ten_l3_business_probes_plus_three_derived() {
        let l3: Vec<_> = PROBE_REGISTRY.iter().filter(|p| p.layer == Layer::L3Business).collect();
        assert_eq!(l3.len(), 10, "expected 10 L3 business probes (7 base + env_local + env_shared + rs_service), got {:?}", l3);
        let derived: Vec<_> = PROBE_REGISTRY.iter().filter(|p| p.layer == Layer::L3Derived).collect();
        assert_eq!(derived.len(), 3, "expected 3 L3 derived probes, got {:?}", derived);
    }

    #[test]
    fn no_duplicate_keys() {
        let mut seen = std::collections::HashSet::new();
        for spec in PROBE_REGISTRY {
            assert!(seen.insert(spec.key), "duplicate key in registry: {}", spec.key);
        }
    }

    #[test]
    fn powershell_probe_keys_returns_only_winrm_ps_emitted_probes() {
        let ps_keys = powershell_probe_keys();
        // 4 L2 + 9 L3Business (rs_service excluded because ps_emitted=false)
        assert_eq!(ps_keys.len(), 13, "expected 13 PS-emitted keys (4 L2 + 9 L3Business), got {:?}", ps_keys);
        assert!(!ps_keys.iter().any(|k| k.starts_with("tcp_")), "PS keys must not include L1 TCP keys");
        assert!(!ps_keys.iter().any(|k| *k == "rs_service"), "rs_service is Rust-augmented, not PS-emitted");
    }

    #[test]
    fn offline_probe_keys_includes_rs_service_and_envs() {
        let off = offline_probe_keys();
        assert!(off.contains(&"env_local"), "offline keys must include env_local");
        assert!(off.contains(&"env_shared"), "offline keys must include env_shared");
        assert!(off.contains(&"rs_service"), "offline keys must include rs_service");
    }

    #[test]
    fn powershell_script_results_hashtable_matches_registry() {
        // Parse ps-scripts/health-probes.ps1 looking for the line
        //     <key> = (Probe-<Name>)
        // inside the $results hashtable. Build the key set, compare to powershell_probe_keys().
        // step 2c: scripts live at <workspace>/src-tauri/resources/ps-scripts;
        // CARGO_MANIFEST_DIR = <workspace>/crates/cache-core → up two to root.
        let ps1_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent().unwrap()
            .parent().unwrap()
            .join("src-tauri/resources/ps-scripts").join("health-probes.ps1");
        let body = std::fs::read_to_string(&ps1_path)
            .unwrap_or_else(|e| panic!("read {:?}: {}", ps1_path, e));

        let start = body.find("$results = @{").expect("no $results = @{ block");
        let after_start = &body[start + "$results = @{".len()..];
        let end = after_start.find('}').expect("no closing } for $results");
        let block = &after_start[..end];

        let key_re = regex::Regex::new(r"(?m)^\s*([a-z_]+[a-z0-9_]*)\s*=\s*\(Probe-").unwrap();
        let mut ps_keys: Vec<String> = key_re
            .captures_iter(block)
            .map(|c| c[1].to_string())
            .collect();
        ps_keys.sort();

        let mut expected: Vec<String> = super::powershell_probe_keys()
            .iter().map(|s| s.to_string()).collect();
        expected.sort();

        assert_eq!(ps_keys, expected,
            "ps1 $results keys drifted from PROBE_REGISTRY\n  ps1:      {:?}\n  registry: {:?}",
            ps_keys, expected);
    }
}
