# Plan 7 T2.4 sidecar - start the zen Windows service.
#
# Purpose:
#   Call Start-Service on the zen service. Idempotent: if the service is
#   already running, was_already_running=true and exit cleanly.
#
# Parameters:
#   -ServiceName <string>  Windows service name. Default "ZenServer".
#
# Output (single JSON object on stdout):
#   {
#     "ok": true,
#     "status": "Running",
#     "was_already_running": false
#   }
#
# Error envelope:
#   {
#     "ok": false,
#     "message": "service not installed" | "Start-Service failed: ..."
#   }
#
# Rust parser: core::zen::service::parse_up_response (T2.5).
#
# Usage:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File zen-up.ps1
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File zen-up.ps1 -ServiceName "ZenServer"

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 | Out-Null

$ErrorActionPreference = 'Stop'

try {
    $p = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $ServiceName = if ($p.ServiceName) { $p.ServiceName } else { 'ZenServer' }
    if ([string]::IsNullOrWhiteSpace($ServiceName)) {
        throw "ServiceName must be non-empty"
    }
    # Reject PowerShell wildcards in ServiceName: Get-Service / Start-Service
    # / Stop-Service all interpret `*` and `?` as wildcards, so a stray
    # `Zen*` would touch every matching service on the host. This sidecar
    # is meant to operate on ONE literal service identifier.
    if ($ServiceName -match '[\*\?\[\]]') {
        throw "ServiceName must be a literal name (no wildcards `*` `?` `[` `]`), got: $ServiceName"
    }

    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($null -eq $svc) {
        @{ ok = $false; message = "service not installed: $ServiceName" } | ConvertTo-Json -Compress
        exit 0
    }

    $wasAlreadyRunning = $false
    if ("$($svc.Status)" -eq 'Running') {
        $wasAlreadyRunning = $true
    } else {
        # Start-Service returns when SCM accepts the start request; we then
        # WaitForStatus to make sure the service actually transitioned. A
        # 30s ceiling matches the WinRM default and is generous for zen,
        # which typically starts in <2s. A timeout / WaitForStatus exception
        # is NOT silently swallowed — the post-start re-query below treats
        # any state that isn't `Running` as failure so the caller doesn't
        # mistake a crash / StartPending hang for a successful start.
        # -WarningAction SilentlyContinue: on a slow (cold-cache) start the
        # service sits in START_PENDING and Start-Service emits a LOCALIZED
        # "Waiting for service ... to start" warning. The transport merges the
        # warning stream into stdout, so that non-JSON text corrupts the
        # envelope the Rust side parses (Bug B, 2026-06-05 lanPC E2E). The
        # post-start WaitForStatus + re-query below is the real success check,
        # so suppressing the warning stream is safe.
        Start-Service -Name $ServiceName -WarningAction SilentlyContinue -ErrorAction Stop
        try {
            $svc.WaitForStatus('Running', (New-TimeSpan -Seconds 30))
        } catch {
            # Re-queried below; we don't bail here so the caller still gets
            # the observed final state in the error envelope.
        }
    }

    # Re-query to capture the post-start state.
    $svc2 = Get-Service -Name $ServiceName -ErrorAction Stop
    $finalStatus = "$($svc2.Status)"

    if ($finalStatus -ne 'Running') {
        @{
            ok = $false
            message = "service did not reach Running state: observed=$finalStatus"
            status = $finalStatus
            was_already_running = $wasAlreadyRunning
        } | ConvertTo-Json -Compress -Depth 4
        exit 0
    }

    $payload = @{
        ok = $true
        status = $finalStatus
        was_already_running = $wasAlreadyRunning
    }
    $payload | ConvertTo-Json -Compress -Depth 4
}
catch {
    @{ ok = $false; message = "Start-Service failed: $($_.Exception.Message)" } | ConvertTo-Json -Compress
    exit 0
}
