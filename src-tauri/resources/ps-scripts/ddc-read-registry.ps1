# Read UE's DDC registry overrides for a machine's UE runtime user:
#   HKCU\SOFTWARE\Epic Games\GlobalDataCachePath
#     UE-LocalDataCachePath / UE-SharedDataCachePath
#
# Purpose (Cache machine detail (5) DDC config readback):
#   The editor preferences "Global Local/Shared DDC Path" fields read/write
#   THIS registry key only (UE 5.5 EditorSettings.cpp, via
#   FPlatformMisc::Get/SetStoredValue) -- never an ini. In UE's
#   FFileSystemCacheStoreParams::Parse the registry value also BEATS the
#   same-named env var. Volo previously probed only the Machine env vars,
#   so a registry-configured local DDC showed as "unset" (verified on lanPC
#   2026-07-12: registry UE-LocalDataCachePath=F:/Epic/DDC, env var absent).
#
# Parameters (stdin JSON):
#   -RuntimeUser <string>  Windows username whose HKCU hosts the key
#                          (machines.ue_runtime_user).
#
# Output (single JSON object on stdout):
#   { "ok": true, "found": false,
#     "local_path": null, "shared_path": null }   -- key absent (editor prefs
#                                                    Global fields never set)
#   { "ok": true, "found": true,
#     "local_path": "F:/Epic/DDC", "shared_path": null }
#   { "ok": false, "message": "..." }             -- SID translate failed OR
#                                                    user hive not loaded
#                                                    (user not logged on):
#                                                    fail loudly, a null here
#                                                    would read as "unset".
#
# Rust parser: commands::env_vars::get_ddc_registry_overrides (Tauri).

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 | Out-Null

$ErrorActionPreference = 'Stop'

$p = [Console]::In.ReadLine() | ConvertFrom-Json
$RuntimeUser = if ($p.RuntimeUser) { "$($p.RuntimeUser)" } else { '' }

try {
    if ([string]::IsNullOrWhiteSpace($RuntimeUser)) {
        throw "RuntimeUser is required"
    }
    if ($RuntimeUser -match '[\\/:\*\?"<>\|]' -or $RuntimeUser.Contains('..')) {
        throw "RuntimeUser contains invalid characters: $RuntimeUser"
    }
    # Microsoft-account-linked local users can fail the bare NTAccount
    # lookup -- retry machine-qualified (same as zen-read-runcontext.ps1).
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
    if (-not (Test-Path -LiteralPath $key)) {
        @{ ok = $true; found = $false; local_path = $null; shared_path = $null } | ConvertTo-Json -Compress
        exit 0
    }
    $props = Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue
    $localPath = $props.'UE-LocalDataCachePath'
    $sharedPath = $props.'UE-SharedDataCachePath'
    if ([string]::IsNullOrWhiteSpace($localPath)) { $localPath = $null }
    if ([string]::IsNullOrWhiteSpace($sharedPath)) { $sharedPath = $null }
    @{
        ok = $true
        found = $true
        local_path = $localPath
        shared_path = $sharedPath
    } | ConvertTo-Json -Compress
}
catch {
    @{ ok = $false; message = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
    exit 0
}
