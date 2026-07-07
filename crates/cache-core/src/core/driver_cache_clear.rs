//! Clear NVIDIA driver DXCache files on a render node.
//!
//! The remote script computes the two allowed DXCache roots from
//! `$env:LOCALAPPDATA` and deletes files under those roots one-by-one. No path
//! is accepted from callers, so the clear operation cannot be redirected.

use crate::core::ssh::{failure_detail, map_exit, SshExecutor};
use crate::error::{VoloError, VoloResult};
use serde::{Deserialize, Serialize};

pub const RESIDUAL_OK_THRESHOLD_BYTES: i64 = 5 * 1024 * 1024;

const CLEAR_PS: &str = r#"[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; chcp 65001 | Out-Null; $ErrorActionPreference='Stop'; $threshold=[int64]5242880; function EmptyStats($Exists){ [PSCustomObject]@{ exists=$Exists; file_count=[int64]0; total_bytes=[int64]0; newest_mtime=$null } }; function Snap($Path){ if(Test-Path -LiteralPath $Path){ $files=@(Get-ChildItem -LiteralPath $Path -Recurse -File -Force -ErrorAction SilentlyContinue); $bytes=[int64]0; $newest=$null; foreach($f in $files){ $bytes += [int64]$f.Length; if($null -eq $newest -or $f.LastWriteTimeUtc -gt $newest){ $newest=$f.LastWriteTimeUtc } }; $mtime=$null; if($null -ne $newest){ $mtime=$newest.ToUniversalTime().ToString('o') }; [PSCustomObject]@{ exists=$true; file_count=[int64]$files.Count; total_bytes=[int64]$bytes; newest_mtime=$mtime } } else { EmptyStats $false } }; function RequireRoot($Path,$Allowed){ $full=[System.IO.Path]::GetFullPath($Path); foreach($root in $Allowed){ if([System.StringComparer]::OrdinalIgnoreCase.Equals($full,$root)){ return $full } }; throw "refusing non-whitelisted DXCache path: $full" }; function IsChild($Root,$Path){ $rootWithSep=$Root; if(-not $rootWithSep.EndsWith('\')){ $rootWithSep += '\' }; return $Path.StartsWith($rootWithSep,[System.StringComparison]::OrdinalIgnoreCase) }; function ClearRoot($Kind,$Path,$Allowed){ $full=RequireRoot $Path $Allowed; $before=Snap $full; $clearedCount=[int64]0; $clearedBytes=[int64]0; $failedCount=[int64]0; $failedBytes=[int64]0; if($before.exists){ $files=@(Get-ChildItem -LiteralPath $full -Recurse -File -Force -ErrorAction SilentlyContinue); foreach($f in $files){ $fileFull=[System.IO.Path]::GetFullPath($f.FullName); if(-not (IsChild $full $fileFull)){ throw "refusing to delete outside DXCache root: $fileFull" }; $len=[int64]$f.Length; try { Remove-Item -LiteralPath $fileFull -Force -ErrorAction Stop; $clearedCount += 1; $clearedBytes += $len } catch { $failedCount += 1; $failedBytes += $len } } }; $after=Snap $full; [PSCustomObject]@{ kind=$Kind; path=$full; before=$before; after=$after; cleared_file_count=$clearedCount; cleared_bytes=$clearedBytes; failed_file_count=$failedCount; failed_bytes=$failedBytes; residual_file_count=$after.file_count; residual_bytes=$after.total_bytes } }; try { if([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)){ throw 'LOCALAPPDATA is empty' }; $local=[System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'NVIDIA\DXCache')); $lowRoot=[System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA '..\LocalLow')); $low=[System.IO.Path]::GetFullPath((Join-Path $lowRoot 'NVIDIA\PerDriverVersion\DXCache')); $allowed=@($local,$low); $dirs=@(ClearRoot 'local_appdata_dxcache' $local $allowed; ClearRoot 'locallow_per_driver_dxcache' $low $allowed); $beforeFiles=[int64]0; $beforeBytes=[int64]0; $afterFiles=[int64]0; $afterBytes=[int64]0; $clearedFiles=[int64]0; $clearedBytes=[int64]0; $failedFiles=[int64]0; $failedBytes=[int64]0; foreach($d in $dirs){ $beforeFiles += [int64]$d.before.file_count; $beforeBytes += [int64]$d.before.total_bytes; $afterFiles += [int64]$d.after.file_count; $afterBytes += [int64]$d.after.total_bytes; $clearedFiles += [int64]$d.cleared_file_count; $clearedBytes += [int64]$d.cleared_bytes; $failedFiles += [int64]$d.failed_file_count; $failedBytes += [int64]$d.failed_bytes }; $ok=($afterBytes -lt $threshold); $message=$null; if(-not $ok){ $message="driver cache residual ${afterBytes} bytes exceeds threshold ${threshold}" }; @{ ok=$ok; message=$message; residual_threshold_bytes=$threshold; before_file_count=$beforeFiles; before_bytes=$beforeBytes; after_file_count=$afterFiles; after_bytes=$afterBytes; cleared_file_count=$clearedFiles; cleared_bytes=$clearedBytes; failed_file_count=$failedFiles; failed_bytes=$failedBytes; residual_file_count=$afterFiles; residual_bytes=$afterBytes; directories=$dirs } | ConvertTo-Json -Compress -Depth 6; exit 0 } catch { @{ ok=$false; message=$_.Exception.Message; residual_threshold_bytes=$threshold; before_file_count=[int64]0; before_bytes=[int64]0; after_file_count=[int64]0; after_bytes=[int64]0; cleared_file_count=[int64]0; cleared_bytes=[int64]0; failed_file_count=[int64]0; failed_bytes=[int64]0; residual_file_count=[int64]0; residual_bytes=[int64]0; directories=@() } | ConvertTo-Json -Compress -Depth 6; exit 1 }"#;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
pub struct DriverCacheClearStats {
    pub exists: bool,
    pub file_count: i64,
    pub total_bytes: i64,
    pub newest_mtime: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
pub struct DriverCacheClearDirectoryResult {
    pub kind: String,
    pub path: String,
    pub before: DriverCacheClearStats,
    pub after: DriverCacheClearStats,
    pub cleared_file_count: i64,
    pub cleared_bytes: i64,
    pub failed_file_count: i64,
    pub failed_bytes: i64,
    pub residual_file_count: i64,
    pub residual_bytes: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
pub struct DriverCacheClearResult {
    pub ok: bool,
    pub message: Option<String>,
    pub residual_threshold_bytes: i64,
    pub before_file_count: i64,
    pub before_bytes: i64,
    pub after_file_count: i64,
    pub after_bytes: i64,
    pub cleared_file_count: i64,
    pub cleared_bytes: i64,
    pub failed_file_count: i64,
    pub failed_bytes: i64,
    pub residual_file_count: i64,
    pub residual_bytes: i64,
    pub directories: Vec<DriverCacheClearDirectoryResult>,
}

pub fn clear(host: &str) -> VoloResult<DriverCacheClearResult> {
    let exec = SshExecutor::from_config()?;
    let out = exec.run_inline_powershell(host, CLEAR_PS)?;
    if !out.stdout.trim().is_empty() {
        if let Ok(parsed) = serde_json::from_str::<DriverCacheClearResult>(&out.stdout) {
            if out.exit_code == 0 {
                return Ok(parsed);
            }
            return Err(VoloError::OperationFailed(
                parsed.message.unwrap_or_else(|| "driver cache clear failed".into()),
            ));
        }
    }
    if out.exit_code != 0 {
        return Err(map_exit(
            out.exit_code,
            &failure_detail(&out.stdout, &out.stderr),
        ));
    }
    serde_json::from_str(&out.stdout).map_err(|e| VoloError::NodeScript {
        exit: 0,
        stderr: format!("bad JSON from driver cache clear: {e} (stdout: {})", out.stdout),
    })
}

pub fn residual_is_ok(bytes: i64) -> bool {
    bytes < RESIDUAL_OK_THRESHOLD_BYTES
}

pub fn local_dxcache_kind() -> &'static str {
    "local_appdata_dxcache"
}

pub fn low_dxcache_kind() -> &'static str {
    "locallow_per_driver_dxcache"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clear_script_is_single_line_and_deletes_files_only_under_whitelist() {
        assert!(!CLEAR_PS.contains('\n'));
        assert!(CLEAR_PS.contains("$env:LOCALAPPDATA"));
        assert!(CLEAR_PS.contains("NVIDIA\\DXCache"));
        assert!(CLEAR_PS.contains("PerDriverVersion\\DXCache"));
        assert!(CLEAR_PS.contains("Remove-Item -LiteralPath $fileFull -Force -ErrorAction Stop"));
        assert!(CLEAR_PS.contains("refusing non-whitelisted DXCache path"));
        assert!(CLEAR_PS.contains("refusing to delete outside DXCache root"));
        assert!(!CLEAR_PS.contains("param("));
        assert!(!CLEAR_PS.contains("Remove-Item -LiteralPath $full"));
    }

    #[test]
    fn residual_threshold_matches_p0_budget() {
        assert!(residual_is_ok(4_999_999));
        assert!(!residual_is_ok(RESIDUAL_OK_THRESHOLD_BYTES));
    }
}
