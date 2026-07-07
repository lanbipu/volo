//! NVIDIA driver-cache probe for PSO green-light status.

use crate::core::{
    discovery,
    ssh::{map_exit, failure_detail, SshExecutor},
};
use crate::error::{VoloError, VoloResult};
use serde::{Deserialize, Serialize};

const LOCAL_DXCACHE_KIND: &str = "local_appdata_dxcache";
const LOW_DXCACHE_KIND: &str = "locallow_per_driver_dxcache";

const PROBE_PS: &str = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; chcp 65001 | Out-Null; $ErrorActionPreference='Stop'; function Snap($Kind,$Path){ if(Test-Path -LiteralPath $Path){ $files=@(Get-ChildItem -LiteralPath $Path -Recurse -File -Force -ErrorAction SilentlyContinue); $bytes=[int64]0; $newest=$null; foreach($f in $files){ $bytes += [int64]$f.Length; if($null -eq $newest -or $f.LastWriteTimeUtc -gt $newest){ $newest=$f.LastWriteTimeUtc } }; $mtime=$null; if($null -ne $newest){ $mtime=$newest.ToString('o') }; [PSCustomObject]@{ kind=$Kind; path=$Path; exists=$true; file_count=[int64]$files.Count; total_bytes=[int64]$bytes; newest_mtime=$mtime } } else { [PSCustomObject]@{ kind=$Kind; path=$Path; exists=$false; file_count=[int64]0; total_bytes=[int64]0; newest_mtime=$null } } }; $local=Join-Path $env:LOCALAPPDATA 'NVIDIA\\DXCache'; $lowRoot=[System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA '..\\LocalLow')); $low=Join-Path $lowRoot 'NVIDIA\\PerDriverVersion\\DXCache'; $user=(Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue).UserName; @{ ok=$true; interactive_user=$user; directories=@(Snap 'local_appdata_dxcache' $local; Snap 'locallow_per_driver_dxcache' $low) } | ConvertTo-Json -Compress -Depth 4";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
pub struct DriverCacheDirectorySnapshot {
    pub kind: String,
    pub path: String,
    pub exists: bool,
    pub file_count: i64,
    pub total_bytes: i64,
    pub newest_mtime: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
pub struct DriverCacheProbe {
    pub gpu_driver_version: Option<String>,
    pub gpu_model: Option<String>,
    pub interactive_user: Option<String>,
    pub directories: Vec<DriverCacheDirectorySnapshot>,
    pub total_file_count: i64,
    pub total_bytes: i64,
    pub newest_mtime: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawProbe {
    ok: bool,
    #[serde(default)]
    interactive_user: Option<String>,
    #[serde(default)]
    directories: Vec<DriverCacheDirectorySnapshot>,
    #[serde(default)]
    message: Option<String>,
}

pub fn probe(host: &str) -> VoloResult<DriverCacheProbe> {
    let exec = SshExecutor::from_config()?;
    let raw = run_cache_probe(&exec, host)?;
    let gpus = discovery::detect_gpus(&exec, host)?;
    let gpu_driver_version = gpus
        .iter()
        .find_map(|gpu| non_empty(&gpu.driver_version));
    let gpu_model = gpus.iter().find_map(|gpu| non_empty(&gpu.gpu_model));
    Ok(aggregate(raw, gpu_driver_version, gpu_model))
}

fn run_cache_probe(exec: &SshExecutor, host: &str) -> VoloResult<RawProbe> {
    let out = exec.run_inline_powershell(host, PROBE_PS)?;
    if !out.stdout.trim().is_empty() {
        if let Ok(parsed) = serde_json::from_str::<RawProbe>(&out.stdout) {
            if parsed.ok {
                return Ok(parsed);
            }
            return Err(VoloError::OperationFailed(
                parsed.message.unwrap_or_else(|| "driver cache probe failed".into()),
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
        stderr: format!("bad JSON from driver cache probe: {e} (stdout: {})", out.stdout),
    })
}

fn aggregate(
    raw: RawProbe,
    gpu_driver_version: Option<String>,
    gpu_model: Option<String>,
) -> DriverCacheProbe {
    let total_file_count = raw.directories.iter().map(|dir| dir.file_count).sum();
    let total_bytes = raw.directories.iter().map(|dir| dir.total_bytes).sum();
    let newest_mtime = raw
        .directories
        .iter()
        .filter_map(|dir| dir.newest_mtime.as_deref())
        .max()
        .map(str::to_string);
    DriverCacheProbe {
        gpu_driver_version,
        gpu_model,
        interactive_user: raw.interactive_user.and_then(|value| non_empty(&value)),
        directories: raw.directories,
        total_file_count,
        total_bytes,
        newest_mtime,
    }
}

fn non_empty(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

pub fn local_dxcache_kind() -> &'static str {
    LOCAL_DXCACHE_KIND
}

pub fn low_dxcache_kind() -> &'static str {
    LOW_DXCACHE_KIND
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_script_is_single_line_and_mentions_both_cache_dirs() {
        assert!(!PROBE_PS.contains('\n'));
        assert!(PROBE_PS.contains("$env:LOCALAPPDATA"));
        assert!(PROBE_PS.contains("NVIDIA\\DXCache"));
        assert!(PROBE_PS.contains("PerDriverVersion\\DXCache"));
        assert!(PROBE_PS.contains("Win32_ComputerSystem"));
    }

    #[test]
    fn aggregate_keeps_missing_vs_empty_dirs_and_totals() {
        let raw = RawProbe {
            ok: true,
            interactive_user: Some("DOMAIN\\artist".into()),
            message: None,
            directories: vec![
                DriverCacheDirectorySnapshot {
                    kind: local_dxcache_kind().into(),
                    path: r"C:\Users\a\AppData\Local\NVIDIA\DXCache".into(),
                    exists: true,
                    file_count: 24,
                    total_bytes: 35_800_000,
                    newest_mtime: Some("2026-07-07T01:00:00.0000000Z".into()),
                },
                DriverCacheDirectorySnapshot {
                    kind: low_dxcache_kind().into(),
                    path: r"C:\Users\a\AppData\LocalLow\NVIDIA\PerDriverVersion\DXCache".into(),
                    exists: false,
                    file_count: 0,
                    total_bytes: 0,
                    newest_mtime: None,
                },
            ],
        };
        let got = aggregate(raw, Some("32.0.15.7652".into()), Some("RTX 3080".into()));
        assert_eq!(got.total_file_count, 24);
        assert_eq!(got.total_bytes, 35_800_000);
        assert_eq!(got.gpu_driver_version.as_deref(), Some("32.0.15.7652"));
        assert_eq!(got.interactive_user.as_deref(), Some("DOMAIN\\artist"));
        assert_eq!(got.directories[1].exists, false);
    }
}
