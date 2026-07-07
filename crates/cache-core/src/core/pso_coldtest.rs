//! PSO coldtest helpers: clear driver cache, run warm-up, verify growth.

use crate::core::{
    driver_cache_clear::{self, DriverCacheClearResult},
    pso_warmup::{self, PsoWarmupSpec},
    ue_runner::{self, UeRunSpec, UeRunnerBackend},
};
use crate::error::VoloResult;
use serde::{Deserialize, Serialize};

pub const COLDTEST_MODE: &str = "coldtest";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
pub struct PsoColdtestClearDecision {
    pub clear_result: DriverCacheClearResult,
    pub can_run: bool,
    pub error_message: Option<String>,
}

pub fn clear_and_decide(host: &str) -> VoloResult<PsoColdtestClearDecision> {
    let clear_result = driver_cache_clear::clear(host)?;
    Ok(decide_clear(clear_result))
}

pub fn decide_clear(clear_result: DriverCacheClearResult) -> PsoColdtestClearDecision {
    let can_run = clear_result.ok;
    let error_message = if can_run {
        None
    } else {
        Some(clear_result.message.clone().unwrap_or_else(|| {
            format!(
                "driver cache residual {} bytes exceeds threshold {}",
                clear_result.residual_bytes, clear_result.residual_threshold_bytes
            )
        }))
    };
    PsoColdtestClearDecision {
        clear_result,
        can_run,
        error_message,
    }
}

pub fn launch_coldtest_run(
    backend: UeRunnerBackend,
    host: &str,
    engine_path: &str,
    project_path: &str,
    spec: &PsoWarmupSpec,
) -> VoloResult<ue_runner::RunnerHandle> {
    pso_warmup::validate_warmup_spec(spec)?;
    Ok(ue_runner::run(UeRunSpec {
        backend,
        host: host.into(),
        engine_path: engine_path.into(),
        project_path: project_path.into(),
        extra_args: pso_warmup::build_warmup_args(spec),
        credential_user: None,
        credential_pass: None,
        interactive: false,
        hold_ssh_session: true,
    }))
}

pub fn driver_cache_growth_bytes(after_clear_bytes: i64, after_run_bytes: i64) -> i64 {
    after_run_bytes.saturating_sub(after_clear_bytes).max(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::driver_cache_clear::{
        DriverCacheClearDirectoryResult, DriverCacheClearStats, RESIDUAL_OK_THRESHOLD_BYTES,
    };

    fn clear_result(residual_bytes: i64) -> DriverCacheClearResult {
        DriverCacheClearResult {
            ok: residual_bytes < RESIDUAL_OK_THRESHOLD_BYTES,
            message: None,
            residual_threshold_bytes: RESIDUAL_OK_THRESHOLD_BYTES,
            before_file_count: 3,
            before_bytes: 100,
            after_file_count: 1,
            after_bytes: residual_bytes,
            cleared_file_count: 2,
            cleared_bytes: 80,
            failed_file_count: 1,
            failed_bytes: residual_bytes,
            residual_file_count: 1,
            residual_bytes,
            directories: vec![DriverCacheClearDirectoryResult {
                kind: driver_cache_clear::local_dxcache_kind().into(),
                path: r"C:\Users\a\AppData\Local\NVIDIA\DXCache".into(),
                before: DriverCacheClearStats {
                    exists: true,
                    file_count: 3,
                    total_bytes: 100,
                    newest_mtime: None,
                },
                after: DriverCacheClearStats {
                    exists: true,
                    file_count: 1,
                    total_bytes: residual_bytes,
                    newest_mtime: None,
                },
                cleared_file_count: 2,
                cleared_bytes: 80,
                failed_file_count: 1,
                failed_bytes: residual_bytes,
                residual_file_count: 1,
                residual_bytes,
            }],
        }
    }

    #[test]
    fn clear_decision_allows_p0_locked_residual_budget() {
        let decision = decide_clear(clear_result(2_840_000));
        assert!(decision.can_run);
        assert!(decision.error_message.is_none());
    }

    #[test]
    fn clear_decision_blocks_large_residual() {
        let decision = decide_clear(clear_result(RESIDUAL_OK_THRESHOLD_BYTES));
        assert!(!decision.can_run);
        assert!(decision
            .error_message
            .as_deref()
            .unwrap()
            .contains("exceeds threshold"));
    }

    #[test]
    fn growth_is_never_negative() {
        assert_eq!(driver_cache_growth_bytes(100, 150), 50);
        assert_eq!(driver_cache_growth_bytes(150, 100), 0);
    }
}
