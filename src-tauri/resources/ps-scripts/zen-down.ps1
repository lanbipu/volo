# Plan 7 T2.4 sidecar - stop the zen Windows service.
#
# Purpose:
#   Call Stop-Service -Force on the zen service. Idempotent: if the service
#   is already stopped, was_already_stopped=true. Not-installed is an error.
#
# Parameters:
#   -ServiceName <string>  Windows service name. Default "ZenServer".
#
# Output (single JSON object on stdout):
#   {
#     "ok": true,
#     "status": "Stopped",
#     "was_already_stopped": false
#   }
#
# Error envelope:
#   {
#     "ok": false,
#     "message": "service not installed" | "Stop-Service failed: ..."
#   }
#
# Rust parser: core::zen::service::parse_down_response (T2.5).
#
# Usage:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File zen-down.ps1
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File zen-down.ps1 -ServiceName "ZenServer"

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 | Out-Null

$ErrorActionPreference = 'Stop'

try {
    $p = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $ServiceName = if ($p.ServiceName) { $p.ServiceName } else { 'ZenServer' }
    if ([string]::IsNullOrWhiteSpace($ServiceName)) {
        throw "ServiceName must be non-empty"
    }
    # Reject PowerShell wildcards: Stop-Service -Name with `*` or `Zen*`
    # would match and stop every matching service on the host. This sidecar
    # operates on ONE literal service identifier.
    if ($ServiceName -match '[\*\?\[\]]') {
        throw "ServiceName must be a literal name (no wildcards `*` `?` `[` `]`), got: $ServiceName"
    }

    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($null -eq $svc) {
        @{ ok = $false; message = "service not installed: $ServiceName" } | ConvertTo-Json -Compress
        exit 0
    }

    $wasAlreadyStopped = $false
    if ("$($svc.Status)" -eq 'Stopped') {
        $wasAlreadyStopped = $true
    } else {
        Stop-Service -Name $ServiceName -Force -ErrorAction Stop
        try {
            $svc.WaitForStatus('Stopped', (New-TimeSpan -Seconds 30))
        } catch {
            # Re-queried below; we don't bail here so the caller still gets
            # the observed final state in the error envelope.
        }
    }

    $svc2 = Get-Service -Name $ServiceName -ErrorAction Stop
    $finalStatus = "$($svc2.Status)"

    if ($finalStatus -ne 'Stopped') {
        @{
            ok = $false
            message = "service did not reach Stopped state: observed=$finalStatus"
            status = $finalStatus
            was_already_stopped = $wasAlreadyStopped
        } | ConvertTo-Json -Compress -Depth 4
        exit 0
    }

    $payload = @{
        ok = $true
        status = $finalStatus
        was_already_stopped = $wasAlreadyStopped
    }
    $payload | ConvertTo-Json -Compress -Depth 4
}
catch {
    @{ ok = $false; message = "Stop-Service failed: $($_.Exception.Message)" } | ConvertTo-Json -Compress
    exit 0
}
