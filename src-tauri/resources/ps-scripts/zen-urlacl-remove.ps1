# Plan 7 T2.4 sidecar - remove a URL ACL reservation.
#
# Purpose:
#   Wrap `netsh http delete urlacl url=<UrlPrefix>` so the Rust core can
#   tear down reservations made by zen-urlacl-add.ps1. Not-found is treated
#   as success with was_present=false (idempotent).
#
# Parameters:
#   -UrlPrefix <string>  URL prefix to remove, e.g. "http://+:8558/".
#
# Output (single JSON object on stdout):
#   {
#     "ok": true,
#     "url": "http://+:8558/",
#     "was_present": true   # false iff netsh reported the URL was not reserved
#   }
#
# Rust parser: core::zen::urlacl::parse_remove_response (T2.5).
#
# Usage:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File zen-urlacl-remove.ps1 `
#       -UrlPrefix "http://+:8558/"

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 | Out-Null

$ErrorActionPreference = 'Stop'

try {
    $p = [Console]::In.ReadToEnd() | ConvertFrom-Json
    if ([string]::IsNullOrWhiteSpace($p.UrlPrefix)) { throw "UrlPrefix is required" }
    $UrlPrefix = $p.UrlPrefix
    if ([string]::IsNullOrWhiteSpace($UrlPrefix)) {
        throw "UrlPrefix must be non-empty"
    }

    $urlArg = "url=$UrlPrefix"

    $stdoutFile = [System.IO.Path]::GetTempFileName()
    $stderrFile = [System.IO.Path]::GetTempFileName()
    $proc = Start-Process -FilePath 'netsh.exe' `
        -ArgumentList @('http', 'delete', 'urlacl', $urlArg) `
        -NoNewWindow -Wait -PassThru `
        -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile

    $stdout = ''
    $stderr = ''
    if (Test-Path -LiteralPath $stdoutFile) {
        $stdout = (Get-Content -LiteralPath $stdoutFile -Raw -ErrorAction SilentlyContinue)
        if ($null -eq $stdout) { $stdout = '' }
        Remove-Item -LiteralPath $stdoutFile -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $stderrFile) {
        $stderr = (Get-Content -LiteralPath $stderrFile -Raw -ErrorAction SilentlyContinue)
        if ($null -eq $stderr) { $stderr = '' }
        Remove-Item -LiteralPath $stderrFile -Force -ErrorAction SilentlyContinue
    }

    $exitCode = [int]$proc.ExitCode
    $combined = "$stdout`n$stderr"

    # netsh emits "The system cannot find the file specified" / "URL not found"
    # for missing reservations. Match both patterns.
    $wasPresent = $true
    if ($combined -match 'cannot\s+find\s+the\s+file' -or
        $combined -match 'not\s+found' -or
        $combined -match 'Error:\s*2\b') {
        $wasPresent = $false
    }

    if ($exitCode -ne 0 -and $wasPresent) {
        @{
            ok = $false
            message = "netsh http delete urlacl failed (exit $exitCode)"
            netsh_stdout = $stdout
            netsh_stderr = $stderr
        } | ConvertTo-Json -Compress -Depth 4
        exit 0
    }

    $payload = @{
        ok = $true
        url = $UrlPrefix
        was_present = $wasPresent
    }
    $payload | ConvertTo-Json -Compress -Depth 4
}
catch {
    @{ ok = $false; message = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
    exit 0
}
