# Write (or clear) UE's DDC registry override for a machine's UE runtime user:
#   HKCU\SOFTWARE\Epic Games\GlobalDataCachePath  UE-LocalDataCachePath / UE-SharedDataCachePath
#
# Purpose (Cache · 文件系统 DDC ③ 本地 DDC / ② 共享 DDC · DDC 配置通道详情 · 注册表通道设置/清除):
#   Write-side companion of ddc-read-registry.ps1. Registry-only — does NOT
#   touch the Machine env var (the env var is a separate, independent channel
#   in the 4-channel priority model: ini > command line > registry > env var,
#   see FFileSystemCacheStoreParams::Parse). Each channel is set/cleared
#   independently on purpose so overrides/conflicts surface in the UI instead
#   of being silently kept in sync.
#
# Node-pure: runs locally on the target (shipped + executed via SSH -File),
# as uecm-svc (admin) — NOT as the UE runtime user.
#
# Parameters (stdin JSON):
#   -RuntimeUser <string>  Windows username whose HKCU hosts the key
#                          (machines.ue_runtime_user).
#   -Value <string>        Path to write, or "" to clear the value.
#   -Field <string>        Registry value name to write — "UE-LocalDataCachePath"
#                          or "UE-SharedDataCachePath". Omitted/blank defaults
#                          to "UE-LocalDataCachePath" (existing local-DDC caller
#                          compatibility — it never sends this field).
#
# Output (single JSON object on stdout):
#   { "ok": true,  "message": "..." }
#   { "ok": false, "message": "..." }   -- SID translate failed, user hive not
#                                          loaded (not logged on), or invalid input
#
# Rust callers: commands::ddc_channels::set_ddc_registry_local_path /
#               set_ddc_registry_shared_path (Tauri).

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 | Out-Null

$ErrorActionPreference = 'Stop'

try {
    $p = [Console]::In.ReadLine() | ConvertFrom-Json
    $RuntimeUser = if ($p.RuntimeUser) { "$($p.RuntimeUser)" } else { '' }
    $Value = if ($null -ne $p.Value) { "$($p.Value)".Trim() } else { '' }
    $Field = if ($p.Field) { "$($p.Field)" } else { 'UE-LocalDataCachePath' }

    if ([string]::IsNullOrWhiteSpace($RuntimeUser)) {
        throw "RuntimeUser is required"
    }
    if ($RuntimeUser -match '[\\/:\*\?"<>\|]' -or $RuntimeUser.Contains('..')) {
        throw "RuntimeUser contains invalid characters: $RuntimeUser"
    }
    if ($Field -ne 'UE-LocalDataCachePath' -and $Field -ne 'UE-SharedDataCachePath') {
        throw "unsupported Field: $Field"
    }

    # Microsoft-account-linked local users can fail the bare NTAccount
    # lookup — retry machine-qualified (same as ddc-read-registry.ps1).
    try {
        $sid = (New-Object System.Security.Principal.NTAccount($RuntimeUser)).Translate(
            [System.Security.Principal.SecurityIdentifier]).Value
    } catch {
        $sid = (New-Object System.Security.Principal.NTAccount($env:COMPUTERNAME, $RuntimeUser)).Translate(
            [System.Security.Principal.SecurityIdentifier]).Value
    }
    if (-not (Test-Path -LiteralPath "Registry::HKEY_USERS\$sid")) {
        throw "registry hive for user $RuntimeUser not loaded (user not logged on)"
    }
    $key = "Registry::HKEY_USERS\$sid\SOFTWARE\Epic Games\GlobalDataCachePath"

    if ($Value -eq '') {
        # Idempotent: a concurrent clear (Local/Shared share this key; another
        # clear-all running close behind this one) may have already removed
        # $Field between this script reading its config and running -- treat
        # "already absent" as success rather than a spurious clear-failed error.
        if (Test-Path -LiteralPath $key) {
            $existing = Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue
            if ($existing -and ($existing.PSObject.Properties.Name -contains $Field)) {
                Remove-ItemProperty -LiteralPath $key -Name $Field -ErrorAction Stop
                $rb = (Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue).$Field
                if ($null -ne $rb -and $rb -ne '') { throw "registry clear verify failed: still '$rb'" }
            }
        }
        @{ ok = $true; message = "cleared $Field registry override" } | ConvertTo-Json -Compress
    }
    else {
        if (-not (Test-Path -LiteralPath $key)) {
            New-Item -Path $key -Force | Out-Null
        }
        Set-ItemProperty -LiteralPath $key -Name $Field -Value $Value -Type String
        $rb = (Get-ItemProperty -LiteralPath $key).$Field
        if ($rb -ne $Value) { throw "registry verify failed: read '$rb', expected '$Value'" }
        @{ ok = $true; message = "set $Field = $Value" } | ConvertTo-Json -Compress
    }
}
catch {
    @{ ok = $false; message = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
    exit 0
}
