# Plan 7 T2.4 sidecar - report Windows service state for zen.
#
# Purpose:
#   Look up the zen service via Get-Service and return its status, start type,
#   and display name. If the service isn't installed, return found=false (not
#   an error).
#
# Parameters:
#   -ServiceName <string>  Windows service name. Default "ZenServer".
#
# Output (single JSON object on stdout):
#   When installed:
#     {
#       "ok": true,
#       "found": true,
#       "name": "ZenServer",
#       "status": "Running",            # one of Running|Stopped|Paused|StartPending|...
#       "start_type": "Automatic",      # one of Automatic|Manual|Disabled|...
#       "display_name": "Unreal Zen Server"
#     }
#   When NOT installed:
#     { "ok": true, "found": false }
#
# Rust parser: core::zen::service::parse_status_response (T2.5).
#
# Usage:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File zen-service-status.ps1
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File zen-service-status.ps1 -ServiceName "ZenServer"

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 | Out-Null

$ErrorActionPreference = 'Stop'

try {
    $p = [Console]::In.ReadLine() | ConvertFrom-Json
    $ServiceName = if ($p.ServiceName) { $p.ServiceName } else { 'ZenServer' }
    if ([string]::IsNullOrWhiteSpace($ServiceName)) {
        throw "ServiceName must be non-empty"
    }
    # Reject wildcards: Get-Service -Name with `*` / `?` matches multiple
    # services and would conflate their states. This sidecar reports on
    # ONE literal service identifier.
    if ($ServiceName -match '[\*\?\[\]]') {
        throw "ServiceName must be a literal name (no wildcards `*` `?` `[` `]`), got: $ServiceName"
    }

    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($null -eq $svc) {
        @{ ok = $true; found = $false } | ConvertTo-Json -Compress
        exit 0
    }

    # StartType is on the Service object in PS 5.1+. Wrap in try as some
    # service principals can deny that read.
    $startType = $null
    try {
        $startType = "$($svc.StartType)"
    } catch {
        $startType = $null
    }
    if ([string]::IsNullOrEmpty($startType)) {
        # Fall back to Win32_Service for older PS versions / restricted hosts.
        try {
            $w = Get-CimInstance -ClassName Win32_Service -Filter "Name='$ServiceName'" -ErrorAction SilentlyContinue
            if ($null -ne $w) { $startType = "$($w.StartMode)" }
        } catch {
            $startType = $null
        }
    }

    $payload = @{
        ok = $true
        found = $true
        name = "$($svc.Name)"
        status = "$($svc.Status)"
        start_type = if ($null -eq $startType) { '' } else { $startType }
        display_name = "$($svc.DisplayName)"
    }
    $payload | ConvertTo-Json -Compress -Depth 4
}
catch {
    @{ ok = $false; message = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
    exit 0
}
