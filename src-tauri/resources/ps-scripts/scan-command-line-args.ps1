# Scans Desktop + Public Desktop + Start Menu shortcuts, common .bat folders,
# and all installed Win32_Service ImagePaths for -LocalDataCachePath= and
# -SharedDataCachePath= command-line arguments.
#
# Node-pure: runs locally on the target (shipped + executed via SSH -File).
# Takes no args. Output: JSON { ok, findings: [...] }
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; chcp 65001 | Out-Null
# Best-effort scan: the body relies on per-item try/catch + -ErrorAction
# SilentlyContinue (it ran via Invoke-Command under the remote session's default
# 'Continue' before). Do NOT use 'Stop' here or tolerated errors (e.g. WScript.Shell
# COM in a non-interactive SSH session) abort the whole scan.
$ErrorActionPreference = 'Continue'

try {
    function MatchArgs($cmd) {
        $out = @{}
        # Some Win32_Service rows (driver services) have a null PathName; regex on
        # $null throws a terminating type-mismatch error. Guard it.
        if ([string]::IsNullOrEmpty($cmd)) { return $out }
        $patterns = @{
            local  = '-LocalDataCachePath=("[^"]+"|[^\s]+)'
            shared = '-SharedDataCachePath=("[^"]+"|[^\s]+)'
        }
        foreach ($k in $patterns.Keys) {
            $m = [regex]::Match($cmd, $patterns[$k], 'IgnoreCase')
            if ($m.Success) { $out[$k] = ($m.Groups[1].Value).Trim('"') }
        }
        $out
    }

    # ArrayList (not Generic.List): Windows PowerShell 5.1 ConvertTo-Json throws a
    # type-mismatch ArgumentException when serializing a live Generic.List that holds
    # pscustomobjects with nested hashtables. The original ran via Invoke-Command, which
    # deserialized the list before serializing; node-pure runs serialize the live list.
    $findings = New-Object System.Collections.ArrayList

    # Shortcuts
    $shortcutRoots = @(
        [Environment]::GetFolderPath('Desktop'),
        [Environment]::GetFolderPath('CommonDesktopDirectory'),
        [Environment]::GetFolderPath('Programs'),
        [Environment]::GetFolderPath('CommonPrograms')
    )
    $shell = New-Object -ComObject WScript.Shell
    foreach ($root in $shortcutRoots) {
        if (-not $root -or -not (Test-Path -LiteralPath $root)) { continue }
        Get-ChildItem -LiteralPath $root -Recurse -Filter *.lnk -ErrorAction SilentlyContinue | ForEach-Object {
            try {
                $lnk = $shell.CreateShortcut($_.FullName)
                $cmd = "$($lnk.TargetPath) $($lnk.Arguments)"
                $hits = MatchArgs $cmd
                if ($hits.Count -gt 0) {
                    [void]$findings.Add([pscustomobject]@{ source = 'shortcut'; path = $_.FullName; cmd = $cmd; matches = $hits })
                }
            } catch {}
        }
    }

    # BAT files
    $batRoots = @('C:\Tools', 'C:\Scripts', "$env:USERPROFILE\Desktop")
    foreach ($root in $batRoots) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        Get-ChildItem -LiteralPath $root -Recurse -Filter *.bat -ErrorAction SilentlyContinue | ForEach-Object {
            try {
                $body = Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8
                $hits = MatchArgs $body
                if ($hits.Count -gt 0) {
                    [void]$findings.Add([pscustomobject]@{ source = 'bat'; path = $_.FullName; cmd = $body.Substring(0, [Math]::Min(400, $body.Length)); matches = $hits })
                }
            } catch {}
        }
    }

    # Services
    Get-CimInstance Win32_Service -ErrorAction SilentlyContinue | ForEach-Object {
        $cmd = $_.PathName
        $hits = MatchArgs $cmd
        if ($hits.Count -gt 0) {
            [void]$findings.Add([pscustomobject]@{ source = 'service'; name = $_.Name; path = $cmd; matches = $hits })
        }
    }

    @{ ok = $true; findings = @($findings) } | ConvertTo-Json -Compress -Depth 6
}
catch {
    @{ ok = $false; message = $_.Exception.Message; findings = @() } | ConvertTo-Json -Compress
    exit 1
}
