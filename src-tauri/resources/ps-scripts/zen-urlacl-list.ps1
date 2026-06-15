# Plan 7 T2.4 sidecar - list zen-shaped URL ACL reservations.
#
# Purpose:
#   Run `netsh http show urlacl` and parse the output into structured records.
#   System reservations (IIS / WCF / Windows components) are skipped; only
#   zen-shaped prefixes (http(s)://(+|*):PORT/) are returned.
#
# Parameters:
#   -PortFilter <string>  optional substring match on port number. When
#                         supplied, only reservations whose URL contains the
#                         literal ":<port>/" segment are kept.
#
# Output (single JSON object on stdout):
#   {
#     "ok": true,
#     "reservations": [
#       {
#         "url": "http://+:8558/",
#         "user": "NT SERVICE\\ZenServer",
#         "listen": true,
#         "delegate": false,
#         "sddl": "D:(A;;GX;;;S-1-5-...)"
#       }
#     ]
#   }
#
# Rust parser: core::zen::urlacl::parse_list_response (T2.5).
#
# netsh output layout (each block):
#   Reserved URL            : http://+:8558/
#       User: NT SERVICE\ZenServer
#           Listen: Yes
#           Delegate: No
#           SDDL: D:(A;;GX;;;...)
#
# Usage:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File zen-urlacl-list.ps1
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File zen-urlacl-list.ps1 -PortFilter 8558

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 | Out-Null

$ErrorActionPreference = 'Stop'

function Test-ZenShapedUrl {
    param([string]$Url)
    if ([string]::IsNullOrWhiteSpace($Url)) { return $false }
    # Match http(s)://(+|*):PORT/ - zen always binds wildcards, never DNS names.
    # IIS / WCF reservations look like http://+:80/Temporary_Listen_Addresses/
    # etc.; we skip anything that has a non-empty path component after the port.
    if ($Url -notmatch '^https?://[+*]:\d+/$') { return $false }
    return $true
}

function Add-ReservationIfZen {
    param(
        [System.Collections.ArrayList]$Sink,
        [string]$Url,
        [string]$User,
        $Listen,
        $Delegate,
        [string]$Sddl,
        [string]$PortFilter
    )
    if ([string]::IsNullOrEmpty($Url)) { return }
    if (-not (Test-ZenShapedUrl -Url $Url)) { return }
    if (-not [string]::IsNullOrEmpty($PortFilter)) {
        if ($Url -notmatch (":" + [regex]::Escape($PortFilter) + "/")) { return }
    }
    $entry = @{
        url = $Url
        user = if ($null -eq $User) { '' } else { $User }
        listen = if ($null -eq $Listen) { $false } else { [bool]$Listen }
        delegate = if ($null -eq $Delegate) { $false } else { [bool]$Delegate }
        sddl = if ($null -eq $Sddl) { '' } else { $Sddl }
    }
    [void]$Sink.Add($entry)
}

try {
    $p = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $PortFilter = $p.PortFilter
    $stdoutFile = [System.IO.Path]::GetTempFileName()
    $stderrFile = [System.IO.Path]::GetTempFileName()
    $proc = Start-Process -FilePath 'netsh.exe' `
        -ArgumentList @('http', 'show', 'urlacl') `
        -NoNewWindow -Wait -PassThru `
        -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile

    $raw = ''
    if (Test-Path -LiteralPath $stdoutFile) {
        $raw = (Get-Content -LiteralPath $stdoutFile -Raw -ErrorAction SilentlyContinue)
        if ($null -eq $raw) { $raw = '' }
        Remove-Item -LiteralPath $stdoutFile -Force -ErrorAction SilentlyContinue
    }
    $stderr = ''
    if (Test-Path -LiteralPath $stderrFile) {
        $stderr = (Get-Content -LiteralPath $stderrFile -Raw -ErrorAction SilentlyContinue)
        if ($null -eq $stderr) { $stderr = '' }
        Remove-Item -LiteralPath $stderrFile -Force -ErrorAction SilentlyContinue
    }

    $exitCode = [int]$proc.ExitCode
    if ($exitCode -ne 0) {
        @{
            ok = $false
            message = "netsh http show urlacl failed (exit $exitCode): $stderr"
        } | ConvertTo-Json -Compress
        exit 0
    }

    $reservations = New-Object System.Collections.ArrayList

    $currentUrl = $null
    $currentUser = $null
    $currentListen = $null
    $currentDelegate = $null
    $currentSddl = $null

    # Split on either CRLF or LF; netsh on Win uses CRLF but be defensive.
    $lines = $raw -split "`r?`n"
    foreach ($line in $lines) {
        $trimmed = $line.Trim()
        if ([string]::IsNullOrEmpty($trimmed)) { continue }

        if ($trimmed -match '^Reserved\s+URL\s*:\s*(.+)$') {
            # Flush previous block before starting a new one.
            Add-ReservationIfZen -Sink $reservations -Url $currentUrl -User $currentUser `
                -Listen $currentListen -Delegate $currentDelegate -Sddl $currentSddl `
                -PortFilter $PortFilter
            $currentUrl = $Matches[1].Trim()
            $currentUser = $null
            $currentListen = $null
            $currentDelegate = $null
            $currentSddl = $null
            continue
        }

        if ($trimmed -match '^User\s*:\s*(.+)$') {
            $currentUser = $Matches[1].Trim()
            continue
        }
        if ($trimmed -match '^Listen\s*:\s*(Yes|No)\b') {
            $currentListen = ($Matches[1] -ieq 'Yes')
            continue
        }
        if ($trimmed -match '^Delegate\s*:\s*(Yes|No)\b') {
            $currentDelegate = ($Matches[1] -ieq 'Yes')
            continue
        }
        if ($trimmed -match '^SDDL\s*:\s*(.+)$') {
            $currentSddl = $Matches[1].Trim()
            continue
        }
    }
    # Flush final block.
    Add-ReservationIfZen -Sink $reservations -Url $currentUrl -User $currentUser `
        -Listen $currentListen -Delegate $currentDelegate -Sddl $currentSddl `
        -PortFilter $PortFilter

    # Locale sanity check: if `netsh` produced substantial output but we
    # parsed zero reservations, the English-only regex above likely failed
    # to match localized labels (e.g. `URL réservée` / `URL reservada`).
    # Surface this as a warning instead of silently returning an empty list
    # — the operator might be looking for an ACL that exists but won't show
    # up here.
    $warnings = New-Object System.Collections.ArrayList
    if ($reservations.Count -eq 0) {
        # netsh always prints at least a header; a real "no reservations"
        # response is ~200 chars total. If we see way more output than that
        # without any parses, that's the localized-labels case.
        $rawLength = if ($null -eq $raw) { 0 } else { $raw.Length }
        if ($rawLength -gt 400) {
            [void]$warnings.Add(
                "netsh produced $rawLength bytes of output but no Zen-shaped " +
                "reservations parsed — likely localized labels. Run from an " +
                "English-locale shell to enumerate reservations reliably.")
        }
    }

    $payload = @{
        ok = $true
        reservations = @($reservations)
        warnings = @($warnings)
    }
    $payload | ConvertTo-Json -Compress -Depth 6
}
catch {
    @{ ok = $false; message = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
    exit 0
}
