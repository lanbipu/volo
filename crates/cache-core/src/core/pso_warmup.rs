//! PSO warm-up & verification runs.
//!
//! Runs UE `-game` ON each render node itself (interactive session) so the
//! node's own PSO precache + GPU driver cache get filled, while counting PSO
//! creation hitches from `-LogCmds="LogPSOHitching Verbose"`. First run absorbs
//! hitches, a re-run with hitch_count == 0 is the "ready for show" green light.
//! (Replaces the falsified collect→distribute file pipeline: distributed
//! `.upipelinecache` files are never consumed by uncooked `-game` builds.)

use crate::core::ue_runner::{self, UeRunSpec, UeRunnerBackend};
use serde::{Deserialize, Serialize};

pub use crate::core::pso_collect::spawn_watchdog;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PsoWarmupSpec {
    pub project_id: i64,
    pub machine_id: i64,
    pub resolution: (u32, u32),
    pub max_minutes: u32,
}

impl Default for PsoWarmupSpec {
    fn default() -> Self {
        Self {
            project_id: 0,
            machine_id: 0,
            resolution: (1920, 1080),
            max_minutes: 20,
        }
    }
}

/// `-LogCmds` value is passed WITHOUT embedded quotes; the interactive start
/// script re-renders spaced `-Key=value` args into `-Key="value"` form. That
/// re-render only happens on the interactive path — the local/loopback spawn
/// (tokio Command / plain Start-Process) quotes the whole token, which UE's
/// parser rejects. The space-free `-ini:Engine:[Core.Log]:...` override raises
/// the same verbosity and survives every quoting path, so hitch logging works
/// even where -LogCmds breaks.
pub fn build_warmup_args(spec: &PsoWarmupSpec) -> Vec<String> {
    let (width, height) = spec.resolution;
    vec![
        "-game".into(),
        "-windowed".into(),
        format!("-resx={}", width),
        format!("-resy={}", height),
        "-log".into(),
        "-unattended".into(),
        "-LogCmds=LogPSOHitching Verbose".into(),
        "-ini:Engine:[Core.Log]:LogPSOHitching=Verbose".into(),
    ]
}

/// A line counts as a hitch only on the LogPSOHitching channel itself —
/// command-line echoes and the LogHAL verbosity notice must not match.
pub fn is_hitch_line(line: &str) -> bool {
    line.contains("LogPSOHitching: ") && line.contains("PSO creation hitch")
}

pub fn launch_warmup(
    backend: UeRunnerBackend,
    host: &str,
    engine_path: &str,
    project_path: &str,
    spec: &PsoWarmupSpec,
) -> ue_runner::RunnerHandle {
    ue_runner::run(UeRunSpec {
        backend,
        host: host.into(),
        engine_path: engine_path.into(),
        project_path: project_path.into(),
        extra_args: build_warmup_args(spec),
        credential_user: None,
        credential_pass: None,
        interactive: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_warmup_args_has_hitch_logging_and_no_execcmds() {
        let spec = PsoWarmupSpec::default();
        let args = build_warmup_args(&spec);
        assert!(args.iter().any(|a| a == "-game"));
        assert!(args.iter().any(|a| a == "-resx=1920"));
        assert!(args.iter().any(|a| a == "-LogCmds=LogPSOHitching Verbose"));
        // space-free fallback must survive quoting on the local spawn path
        let ini_override = args.iter().find(|a| a.starts_with("-ini:")).unwrap();
        assert!(!ini_override.contains(' '));
        assert_eq!(ini_override, "-ini:Engine:[Core.Log]:LogPSOHitching=Verbose");
        // warm-up relies on driver cache + precache only; no ShaderPipelineCache CVars
        assert!(!args.iter().any(|a| a.starts_with("-ExecCmds")));
    }

    #[test]
    fn is_hitch_line_matches_real_hitches_only() {
        assert!(is_hitch_line(
            "[2026.07.02-02.24.22:873][  0]LogPSOHitching: Verbose: Runtime graphics PSO creation hitch (29.86 msec) for Resource"
        ));
        assert!(is_hitch_line(
            "[2026.07.02-02.24.22:873][  0]LogPSOHitching: Verbose: Runtime compute PSO creation hitch (22.35 msec) for Resource"
        ));
        assert!(!is_hitch_line(
            "LogHAL: Log category LogPSOHitching verbosity has been raised to Verbose."
        ));
        assert!(!is_hitch_line(
            "LogInit: Command Line: -LogCmds=\"LogPSOHitching Verbose\" -game"
        ));
    }
}
