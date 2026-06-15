//! Map ue_log_verify::VerifyReport + ddc_file_stats::Stats to advisories.
//! Pure — no I/O.

use crate::core::{ddc_file_stats::Stats, ue_log_verify::VerifyReport};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct Advisory {
    pub id: String,
    pub severity: &'static str,
    pub title: String,
    pub explanation: String,
    pub remediation: Vec<String>,
}

pub fn analyze(verify: &VerifyReport, stats: Option<&Stats>) -> Vec<Advisory> {
    let mut out = Vec::new();

    if let Some(reason) = verify.shared_deactivated_reason.as_deref() {
        out.push(Advisory {
            id: "S001".into(),
            severity: "critical",
            title: "Shared backend deactivated by UE".into(),
            explanation: format!("UE reported: {}", reason),
            remediation: vec![
                "Lower ConsiderSlowAt or fix the network latency to NAS".into(),
                "Check `health scan-command-line` for hard-coded -SharedDataCachePath".into(),
            ],
        });
    }

    if verify.move_collision_count > 50 {
        out.push(Advisory {
            id: "S002".into(),
            severity: "warning",
            title: "Many Move collision warnings".into(),
            explanation: format!("{} Move collision lines in startup log.", verify.move_collision_count),
            remediation: vec![
                "Likely two hosts wrote to Shared concurrently before it was populated. Stagger initial open, or run `ddc generate` then `ddc distribute`.".into(),
            ],
        });
    }

    if let Some(s) = stats {
        if let Some(im) = crate::core::ddc_file_stats::classify_imbalance(s) {
            out.push(Advisory {
                id: "S003".into(),
                severity: im.severity,
                title: "Shared DDC near-empty vs Local".into(),
                explanation: im.message,
                remediation: vec![
                    "Re-open the project on the host that first compiled, with Shared already configured.".into(),
                    "Or run `uecm-cli ddc generate` + `ddc distribute` to seed Shared from Local.".into(),
                ],
            });
        }
    }

    if verify.local_path.is_none() {
        out.push(Advisory {
            id: "S004".into(),
            severity: "critical",
            title: "UE did not load a Local DDC path".into(),
            explanation: "LogDerivedDataCache contained no `Using Local data cache path` line.".into(),
            remediation: vec![
                "Check that UE-LocalDataCachePath is set Machine-scope (and not just user-scope).".into(),
                "Verify ProjectLocalDDCPath in EditorPerProjectUserSettings.ini is empty.".into(),
            ],
        });
    }

    if verify.shared_path.is_none() && verify.shared_deactivated_reason.is_none() {
        out.push(Advisory {
            id: "S005".into(),
            severity: "warning",
            title: "UE did not load a Shared DDC path".into(),
            explanation: "LogDerivedDataCache contained no `Using Shared data cache path` line.".into(),
            remediation: vec![
                "Confirm UE-SharedDataCachePath is set and the BackendGraph Shared node has Path / EnvPathOverride configured.".into(),
                "Make sure the RenderStream service account can reach the UNC share.".into(),
            ],
        });
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::ddc_file_stats::{LayerStat, Stats};

    fn empty_verify() -> VerifyReport {
        VerifyReport {
            host: "X".into(),
            local_path: None,
            local_writable: None,
            shared_path: None,
            shared_writable: None,
            shared_deactivated_reason: None,
            move_collision_count: 0,
            maintenance: vec![],
            paks_opened: vec![],
            truncated: false,
            log_path: None,
        }
    }

    #[test]
    fn detects_deactivation() {
        let mut v = empty_verify();
        v.shared_deactivated_reason = Some("latency".into());
        let a = analyze(&v, None);
        assert!(a.iter().any(|x| x.id == "S001"));
    }

    #[test]
    fn detects_many_move_collisions() {
        let mut v = empty_verify();
        v.local_path = Some("D:\\DDC".into());
        v.shared_path = Some("\\\\NAS\\DDC".into());
        v.move_collision_count = 75;
        let a = analyze(&v, None);
        assert!(a.iter().any(|x| x.id == "S002"));
    }

    #[test]
    fn does_not_fire_s002_for_few_collisions() {
        let mut v = empty_verify();
        v.local_path = Some("D:\\DDC".into());
        v.shared_path = Some("\\\\NAS\\DDC".into());
        v.move_collision_count = 10;
        let a = analyze(&v, None);
        assert!(!a.iter().any(|x| x.id == "S002"));
    }

    #[test]
    fn detects_imbalance_when_stats_provided() {
        let mut v = empty_verify();
        v.local_path = Some("D:\\DDC".into());
        v.shared_path = Some("\\\\NAS\\DDC".into());
        let stats = Stats {
            ok: true,
            local: LayerStat { path: "D:\\DDC".into(), ok: true, file_count: 25065, total_bytes: 1_000_000, error: None },
            shared: LayerStat { path: "\\\\NAS\\DDC".into(), ok: true, file_count: 152, total_bytes: 30_000, error: None },
        };
        let a = analyze(&v, Some(&stats));
        assert!(a.iter().any(|x| x.id == "S003"));
    }

    #[test]
    fn detects_no_local_path() {
        let a = analyze(&empty_verify(), None);
        assert!(a.iter().any(|x| x.id == "S004"));
    }

    #[test]
    fn detects_no_shared_path_when_not_deactivated() {
        let a = analyze(&empty_verify(), None);
        assert!(a.iter().any(|x| x.id == "S005"));
    }

    #[test]
    fn no_s005_when_deactivated() {
        let mut v = empty_verify();
        v.local_path = Some("D:\\DDC".into());
        v.shared_deactivated_reason = Some("latency".into());
        let a = analyze(&v, None);
        assert!(!a.iter().any(|x| x.id == "S005"));
        assert!(a.iter().any(|x| x.id == "S001"));
    }
}
