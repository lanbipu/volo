//! PSO warm-up & verification runs.
//!
//! Runs UE `-game` ON each render node itself so the node's own GPU driver
//! cache gets filled, while counting PSO creation hitches from
//! `-LogCmds="LogPSOHitching Verbose"`. First run absorbs hitches, a re-run
//! with hitch_count == 0 is the "ready for show" green light.
//!
//! 启动形态 = **交互式计划任务**（start-ue-interactive.ps1）：驱动缓存按
//! Windows 账户隔离，warmup 必须以与生产（Switchboard 交互用户）相同的账户
//! 跑 UE。SSH 直启（held session）虽然渲染正常，但 UE 会以 SSH 服务账户
//! （uecm-svc）运行、把缓存填进错误账户的 profile——2026-07-08 真机 E2E 实锤
//! （uecm-svc 33MB 独立增长、lanPC 36MB 纹丝不动）。
//! (Replaces the falsified collect→distribute file pipeline: distributed
//! `.upipelinecache` files are never consumed by uncooked `-game` builds.)

use crate::core::ue_runner::{self, UeRunSpec, UeRunnerBackend};
use crate::error::{VoloError, VoloResult};
use serde::{Deserialize, Serialize};

use std::sync::Arc;
use tokio::sync::Mutex;

/// Max-minutes watchdog shared by warmup/coldtest (and the deploy
/// workflow's legacy collect path): flags a planned-duration stop so
/// consumers can tell it apart from an operator cancel.
pub fn spawn_watchdog(
    cancel: Arc<Mutex<crate::core::ue_runner::RunnerCancel>>,
    max_minutes: u32,
    job_id: String,
) {
    if max_minutes == 0 {
        return;
    }
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(max_minutes as u64 * 60)).await;
        let mut state = cancel.lock().await;
        if !state.requested {
            state.requested = true;
            // Planned-duration stop, not an abort — consumers (warmup finalize)
            // distinguish this from a user cancel via the flag.
            state.watchdog = true;
            tracing::info!("pso warmup watchdog fired for job {}", job_id);
        }
    });
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PsoWarmupSpec {
    pub project_id: i64,
    pub machine_id: i64,
    pub resolution: (u32, u32),
    pub max_minutes: u32,
    pub dc_cfg_path: Option<String>,
    pub dc_node: Option<String>,
    pub offscreen: bool,
    pub extra_args: Vec<String>,
}

impl Default for PsoWarmupSpec {
    fn default() -> Self {
        Self {
            project_id: 0,
            machine_id: 0,
            resolution: (1920, 1080),
            max_minutes: 20,
            dc_cfg_path: None,
            dc_node: None,
            offscreen: true,
            extra_args: Vec::new(),
        }
    }
}

impl PsoWarmupSpec {
    pub fn mode(&self) -> &'static str {
        if self.offscreen {
            "ndisplay_offscreen"
        } else {
            "ndisplay_fullscreen"
        }
    }
}

/// `-LogCmds` value is passed WITHOUT embedded quotes; node scripts re-render
/// spaced `-Key=value` args into `-Key="value"` form. The local/loopback spawn
/// can still quote the whole token in a way UE rejects, so the space-free
/// `-ini:Engine:[Core.Log]:...` override raises the same verbosity and survives
/// every quoting path.
pub fn build_warmup_args(spec: &PsoWarmupSpec) -> Vec<String> {
    let dc_cfg_path = spec.dc_cfg_path.as_deref().unwrap_or_default();
    let dc_node = spec.dc_node.as_deref().unwrap_or_default();
    let log_name = warmup_log_name(spec);
    let mut args = vec![
        "-messaging".into(),
        "-dc_cluster".into(),
        "-nosplash".into(),
        "-fixedseed".into(),
        "-NoVerifyGC".into(),
        "-noxrstereo".into(),
        "-xrtrackingonly".into(),
        "-RemoteControlIsHeadless".into(),
        "-RCWebControlEnable".into(),
        "-LogCmds=LogPSOHitching Verbose".into(),
        format!("-StageFriendlyName={}", dc_node),
        "-MaxGPUCount=2".into(),
        format!("-dc_cfg={}", dc_cfg_path),
        "-dx12".into(),
        "-dc_dev_mono".into(),
        "-nosound".into(),
        "-NoLoadingScreen".into(),
        "-DisablePython".into(),
        format!("-dc_node={}", dc_node),
        format!("Log={}", log_name),
        "-ini:Engine:[/Script/Engine.Engine]:GameEngine=/Script/DisplayCluster.DisplayClusterGameEngine,[/Script/Engine.Engine]:GameViewportClientClassName=/Script/DisplayCluster.DisplayClusterViewportClient,[/Script/Engine.UserInterfaceSettings]:bAllowHighDPIInGameMode=True".into(),
        "-ini:Input:[/Script/Engine.InputSettings]:DefaultPlayerInputClass=/Script/DisplayCluster.DisplayClusterPlayerInput".into(),
        "-unattended".into(),
        "-NoScreenMessages".into(),
        "-handleensurepercent=0".into(),
        "-ExecCmds=DisableAllScreenMessages".into(),
        if spec.offscreen {
            "-RenderOffscreen".into()
        } else {
            "-fullscreen".into()
        },
        "-game".into(),
        "-ini:Engine:[Core.Log]:LogPSOHitching=Verbose".into(),
    ];
    args.extend(spec.extra_args.iter().filter_map(|arg| {
        let trimmed = arg.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    }));
    args
}

pub fn validate_warmup_spec(spec: &PsoWarmupSpec) -> VoloResult<()> {
    if spec
        .dc_cfg_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_none()
    {
        return Err(VoloError::InvalidInput(
            "dc_cfg_path is required for PSO nDisplay warmup".into(),
        ));
    }
    if spec
        .dc_node
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_none()
    {
        return Err(VoloError::InvalidInput(
            "dc_node is required for PSO nDisplay warmup".into(),
        ));
    }
    Ok(())
}

fn warmup_log_name(spec: &PsoWarmupSpec) -> String {
    let node = spec
        .dc_node
        .as_deref()
        .map(safe_log_fragment)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "node".into());
    format!(
        "VoloPsoWarmup_p{}_m{}_{}.log",
        spec.project_id, spec.machine_id, node
    )
}

fn safe_log_fragment(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

/// Default verify-phase window. P0 measured: a warm baseline shows 0 hitches
/// within 90s; 2 minutes gives comfortable margin without stretching the job.
pub const DEFAULT_VERIFY_MINUTES: u32 = 2;

/// Green-light judgement for a verify phase that ran to planned completion:
/// zero hitches = ready, anything else = the run finished but the node is
/// NOT ready (distinct from a broken run, which stays Err).
pub fn verify_outcome(verify_hitch_count: i64) -> crate::data::pso_warmup_runs::WarmupStatus {
    use crate::data::pso_warmup_runs::WarmupStatus;
    if verify_hitch_count == 0 {
        WarmupStatus::Ok
    } else {
        WarmupStatus::NotReady
    }
}

/// A line counts as a hitch only on the LogPSOHitching channel itself —
/// command-line echoes and the LogHAL verbosity notice must not match.
pub fn is_hitch_line(line: &str) -> bool {
    line.contains("LogPSOHitching: ") && line.contains("PSO creation hitch")
}

/// Preflight for the "nDisplay config 已配置且存在" rule: the path lives on the
/// render node, so existence can only be checked over SSH. UE does not fail
/// fast on a missing `-dc_cfg` — the run would silently degrade to a
/// non-cluster shape and warm the wrong PSO set.
pub fn check_dc_cfg_exists(host: &str, dc_cfg_path: &str) -> VoloResult<bool> {
    let exec = crate::core::ssh::SshExecutor::from_config()?;
    let ps = format!(
        "if (Test-Path -LiteralPath '{}' -PathType Leaf) {{ 'DC_CFG_EXISTS' }} else {{ 'DC_CFG_MISSING' }}",
        dc_cfg_path.replace('\'', "''")
    );
    let out = exec.run_inline_powershell(host, &ps)?;
    Ok(out.stdout.contains("DC_CFG_EXISTS"))
}

/// 在目标机的工程根目录下递归发现 .ndisplay 配置资产（用于「设置」子视图 nDisplay
/// 配置来源单选的「工程内自动发现」选项）。只列举存在性，不解析内容。
pub fn discover_ndisplay_assets(host: &str, project_root: &str) -> VoloResult<Vec<String>> {
    let exec = crate::core::ssh::SshExecutor::from_config()?;
    let ps = format!(
        "Get-ChildItem -LiteralPath '{}' -Recurse -Filter *.ndisplay -File -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName",
        project_root.replace('\'', "''")
    );
    let out = exec.run_inline_powershell(host, &ps)?;
    Ok(out
        .stdout
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect())
}

pub fn launch_warmup(
    backend: UeRunnerBackend,
    host: &str,
    engine_path: &str,
    project_path: &str,
    spec: &PsoWarmupSpec,
) -> VoloResult<ue_runner::RunnerHandle> {
    validate_warmup_spec(spec)?;
    Ok(ue_runner::run(UeRunSpec {
        backend,
        host: host.into(),
        engine_path: engine_path.into(),
        project_path: project_path.into(),
        extra_args: build_warmup_args(spec),
        credential_user: None,
        credential_pass: None,
        // 交互式计划任务：与生产同账户（驱动缓存按账户隔离，见模块头注释）。
        interactive: true,
        hold_ssh_session: false,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_warmup_args_uses_ndisplay_template_and_hitch_logging() {
        let spec = PsoWarmupSpec {
            project_id: 7,
            machine_id: 9,
            dc_cfg_path: Some(r"C:\Temp\stage.ndisplay".into()),
            dc_node: Some("Node_0".into()),
            ..PsoWarmupSpec::default()
        };
        let args = build_warmup_args(&spec);
        assert!(args.iter().any(|a| a == "-game"));
        assert!(args.iter().any(|a| a == "-dc_cluster"));
        assert!(args.iter().any(|a| a == "-RenderOffscreen"));
        assert!(args.iter().any(|a| a == "-RCWebControlEnable"));
        assert!(args.iter().any(|a| a == "-dc_cfg=C:\\Temp\\stage.ndisplay"));
        assert!(args.iter().any(|a| a == "-dc_node=Node_0"));
        assert!(args
            .iter()
            .any(|a| a == "Log=VoloPsoWarmup_p7_m9_Node_0.log"));
        assert!(args.iter().any(|a| a == "-LogCmds=LogPSOHitching Verbose"));
        // space-free fallback must survive quoting on the local spawn path
        let ini_override = args
            .iter()
            .find(|a| a.as_str() == "-ini:Engine:[Core.Log]:LogPSOHitching=Verbose")
            .unwrap();
        assert!(!ini_override.contains(' '));
        assert!(args
            .iter()
            .any(|a| a == "-ini:Engine:[Core.Log]:LogPSOHitching=Verbose"));
        assert!(!args.iter().any(|a| a.starts_with("-resx=")));
        // warm-up relies on driver cache only; no old ShaderPipelineCache CVars.
        assert!(!args.iter().any(|a| a.contains("ShaderPipelineCache")));
    }

    #[test]
    fn validate_warmup_spec_requires_ndisplay_identity() {
        assert!(validate_warmup_spec(&PsoWarmupSpec::default()).is_err());
        let spec = PsoWarmupSpec {
            dc_cfg_path: Some(r"C:\Temp\stage.ndisplay".into()),
            dc_node: Some("Node_0".into()),
            ..PsoWarmupSpec::default()
        };
        assert!(validate_warmup_spec(&spec).is_ok());
    }

    #[test]
    fn build_warmup_args_honours_fullscreen_and_extra_args() {
        let spec = PsoWarmupSpec {
            dc_cfg_path: Some(r"C:\Temp\stage.ndisplay".into()),
            dc_node: Some("Node 0".into()),
            offscreen: false,
            extra_args: vec!["/Game/Maps/Main".into(), " ".into(), "-Foo=Bar".into()],
            ..PsoWarmupSpec::default()
        };
        let args = build_warmup_args(&spec);
        assert!(args.iter().any(|a| a == "-fullscreen"));
        assert!(!args.iter().any(|a| a == "-RenderOffscreen"));
        assert!(args
            .iter()
            .any(|a| a == "Log=VoloPsoWarmup_p0_m0_Node_0.log"));
        assert!(args.ends_with(&["/Game/Maps/Main".into(), "-Foo=Bar".into()]));
    }

    #[test]
    fn verify_outcome_zero_is_green_anything_else_not_ready() {
        use crate::data::pso_warmup_runs::WarmupStatus;
        assert_eq!(verify_outcome(0), WarmupStatus::Ok);
        assert_eq!(verify_outcome(1), WarmupStatus::NotReady);
        assert_eq!(verify_outcome(119), WarmupStatus::NotReady);
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
