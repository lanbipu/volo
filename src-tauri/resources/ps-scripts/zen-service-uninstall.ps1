# Plan 7 T2.4 sidecar - uninstall the zen Windows service.
#
# Purpose:
#   Stop and remove the UECM-managed ZenServer Windows service via sc.exe.
#   Idempotent: if the service was never installed, the script reports
#   was_present=false rather than failing.
#
# Parameters:
#   -ServiceName <string>  Windows service name. Default "UECMZenServer".
#
# Note: ZenExePath is accepted for backward compatibility but no longer
# required — sc.exe delete does not need the binary path.
#
# Output (single JSON object on stdout):
#   {
#     "ok": true,
#     "was_present": true,
#     "service_name": "UECMZenServer"
#   }
#
# Rust parser: core::zen::service::parse_uninstall_response (T2.5).

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 | Out-Null

$ErrorActionPreference = 'Stop'

try {
    $p = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $ServiceName = if ($p.ServiceName) { $p.ServiceName } else { 'UECMZenServer' }
    if ([string]::IsNullOrWhiteSpace($ServiceName)) {
        throw "ServiceName must be non-empty"
    }
    if ($ServiceName -match '[\*\?\[\]]') {
        throw "ServiceName must be a literal name (no wildcards), got: $ServiceName"
    }

    # Pre-check: is the service installed?
    $existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    # Legacy fallback: check for the pre-migration "ZenServer" name.
    $legacyServiceName = 'ZenServer'
    if ($null -eq $existing -and $ServiceName -ne $legacyServiceName) {
        $legacy = Get-Service -Name $legacyServiceName -ErrorAction SilentlyContinue
        if ($null -ne $legacy) {
            $ServiceName = $legacyServiceName
            $existing = $legacy
        }
    }
    if ($null -eq $existing) {
        @{
            ok = $true
            was_present = $false
            service_name = $ServiceName
        } | ConvertTo-Json -Compress -Depth 4
        exit 0
    }

    # Stop the service if running.
    if ($existing.Status -eq 'Running') {
        & sc.exe stop $ServiceName 2>&1 | Out-Null
        # Wait briefly for the service to stop.
        $timeout = 15
        while ($timeout -gt 0) {
            $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
            if ($null -eq $svc -or $svc.Status -eq 'Stopped') { break }
            Start-Sleep -Seconds 1
            $timeout--
        }
    }

    # Delete the service registration.
    $combined = (& sc.exe delete $ServiceName 2>&1 | Out-String)
    $exitCode = [int]$LASTEXITCODE
    if ($null -eq $combined) { $combined = '' }

    if ($exitCode -ne 0) {
        @{
            ok = $false
            message = "sc delete failed (exit $exitCode)"
            service_name = $ServiceName
            sc_output = $combined
        } | ConvertTo-Json -Compress -Depth 4
        exit 0
    }

    @{
        ok = $true
        was_present = $true
        service_name = $ServiceName
    } | ConvertTo-Json -Compress -Depth 4
}
catch {
    @{ ok = $false; message = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
    exit 0
}
