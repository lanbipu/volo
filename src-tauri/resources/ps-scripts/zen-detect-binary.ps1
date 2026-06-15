# Plan 7 T1.8 sidecar - small metadata.
#
# Purpose:
#   Inspect this Windows host for zen binaries in two locations:
#     1. The single "install" copy under
#        %LOCALAPPDATA%\UnrealEngine\Common\Zen\Install\  (this is the path
#        zenserver.exe actually launches from per docs/research/zen-launch-mechanism.md §3).
#     2. Per-UE "InTree" copies at <UE_root>\Engine\Binaries\Win64\{zen,zenserver}.exe
#        plus the sibling zen.version file. UE installs are discovered via
#        HKLM:\SOFTWARE\EpicGames\Unreal Engine\<ver> (appendix A in the same doc).
#
# Parameters: (none)
#
# Output (single JSON object on stdout). Field-by-field schema is owned by
# core/zen/binary.rs::parse_detection_json. Summary:
#   {
#     "ok": true,
#     "install": {
#       "install_dir": "...",
#       "zen_cli":   { "path": "...", "build_version": "...", "sha256": "..." } | null,
#       "zenserver": { "path": "...", "build_version": "...", "sha256": "..." } | null
#     } | null,
#     "intree": [
#       { "ue_major": 5, "ue_minor": 7, "ue_install_path": "...",
#         "zen_cli":   { "path", "version", "sha256" } | null,
#         "zenserver": { "path", "version", "sha256" } | null }
#     ],
#     "warnings": ["UE_5.5 zenserver.exe missing"]
#   }
#
# Missing files are NOT errors - the corresponding sub-object collapses to
# null and a string is appended to "warnings" so operators see which file
# was absent. Uncaught errors emit { ok:false, message:"..." }.
#
# Usage:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File zen-detect-binary.ps1

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 | Out-Null

$ErrorActionPreference = 'Stop'

function Get-Sha256Lower {
    param([string]$Path)
    # Get-FileHash emits upper-case hex; Rust's format!("{:x}", ...) emits
    # lower-case. Normalise here so sha256 comparisons across the wire work
    # without an extra ToLowerInvariant() on the Rust side.
    $h = Get-FileHash -LiteralPath $Path -Algorithm SHA256 -ErrorAction Stop
    return $h.Hash.ToLowerInvariant()
}

function Read-VersionFile {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    try {
        $text = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop
        if ($null -eq $text) { return $null }
        $trimmed = $text.Trim()
        if ([string]::IsNullOrEmpty($trimmed)) { return $null }
        return $trimmed
    } catch {
        return $null
    }
}

function Build-BinaryRecord {
    param(
        [string]$BinPath,
        [string]$VersionPath,
        [string]$WarnLabel,
        [System.Collections.ArrayList]$Warnings
    )
    if (-not (Test-Path -LiteralPath $BinPath)) {
        [void]$Warnings.Add("$WarnLabel missing: $BinPath")
        return $null
    }
    $sha = $null
    try {
        $sha = Get-Sha256Lower -Path $BinPath
    } catch {
        [void]$Warnings.Add("$WarnLabel sha256 failed: $($_.Exception.Message)")
    }
    $ver = Read-VersionFile -Path $VersionPath
    if ($null -eq $ver) {
        [void]$Warnings.Add("$WarnLabel version file missing or empty: $VersionPath")
    }
    return @{
        path = $BinPath
        version = $ver
        sha256 = $sha
    }
}

try {
    $warnings = New-Object System.Collections.ArrayList

    # --- (1) Install dir under any user's %LOCALAPPDATA% ----------------------
    # F5: SSH logs in as uecm-svc, whose LOCALAPPDATA never holds the UE-user's
    # zen install. Enumerate every profile (uecm-svc is a local admin) and pick
    # the first that actually has the install binary.
    $installDir = $null
    $selfLocal = Join-Path -Path $env:LOCALAPPDATA -ChildPath 'UnrealEngine\Common\Zen\Install'
    $candidates = @($selfLocal)
    try {
        $candidates += Get-ChildItem 'C:\Users' -Directory -ErrorAction SilentlyContinue |
            ForEach-Object { Join-Path $_.FullName 'AppData\Local\UnrealEngine\Common\Zen\Install' }
    } catch { }
    foreach ($c in ($candidates | Select-Object -Unique)) {
        if (Test-Path -LiteralPath (Join-Path $c 'zenserver.exe')) { $installDir = $c; break }
        if (Test-Path -LiteralPath (Join-Path $c 'zen.exe'))       { $installDir = $c; break }
    }
    if ($null -eq $installDir) { $installDir = $selfLocal }  # keep old behavior when nothing found
    $installRecord = $null
    if (Test-Path -LiteralPath $installDir) {
        $cliExe = Join-Path -Path $installDir -ChildPath 'zen.exe'
        $srvExe = Join-Path -Path $installDir -ChildPath 'zenserver.exe'
        $verFile = Join-Path -Path $installDir -ChildPath 'zen.version'

        # The install dir uses a single zen.version file shared by both
        # binaries. Build the records by hand so both binaries pick up the
        # same version string (avoids duplicate Warn entries for the same
        # missing file).
        $sharedVersion = Read-VersionFile -Path $verFile
        if ($null -eq $sharedVersion) {
            [void]$warnings.Add("install zen.version missing or empty: $verFile")
        }

        $cliRec = $null
        if (Test-Path -LiteralPath $cliExe) {
            $sha = $null
            try { $sha = Get-Sha256Lower -Path $cliExe } catch {
                [void]$warnings.Add("install zen.exe sha256 failed: $($_.Exception.Message)")
            }
            $cliRec = @{ path = $cliExe; build_version = $sharedVersion; sha256 = $sha }
        } else {
            [void]$warnings.Add("install zen.exe missing: $cliExe")
        }

        $srvRec = $null
        if (Test-Path -LiteralPath $srvExe) {
            $sha = $null
            try { $sha = Get-Sha256Lower -Path $srvExe } catch {
                [void]$warnings.Add("install zenserver.exe sha256 failed: $($_.Exception.Message)")
            }
            $srvRec = @{ path = $srvExe; build_version = $sharedVersion; sha256 = $sha }
        } else {
            [void]$warnings.Add("install zenserver.exe missing: $srvExe")
        }

        # Even if both binaries are absent we still report install_dir; the
        # Rust persist step uses install presence as a signal that UE 5.4+
        # has been opened on this host at least once.
        $installRecord = @{
            install_dir = $installDir
            zen_cli = $cliRec
            zenserver = $srvRec
        }
    }
    # else: install_record stays $null - host has never opened a UE 5.4+
    # editor. Not a warning; this is the default state of a fresh box.

    # --- (2) InTree copies per UE install -------------------------------------
    $intreeList = New-Object System.Collections.ArrayList
    $regKeys = @(
        'HKLM:\SOFTWARE\EpicGames\Unreal Engine',
        'HKLM:\SOFTWARE\WOW6432Node\EpicGames\Unreal Engine'
    )
    foreach ($keyPath in $regKeys) {
        if (-not (Test-Path -LiteralPath $keyPath)) { continue }
        Get-ChildItem -LiteralPath $keyPath -ErrorAction SilentlyContinue | ForEach-Object {
            $childKey = $_
            $verName = $childKey.PSChildName    # e.g. "5.7"
            $installedDir = $null
            try {
                $installedDir = (Get-ItemProperty -LiteralPath $childKey.PSPath -Name 'InstalledDirectory' -ErrorAction SilentlyContinue).InstalledDirectory
            } catch {
                # Ignore - missing property handled below.
                $installedDir = $null
            }
            if ([string]::IsNullOrEmpty($installedDir)) { return }

            # Parse "<major>.<minor>" - skip stub entries (e.g. "4.0" launcher
            # placeholder) that fail the version split or never installed an
            # editor binary.
            $parts = $verName -split '\.'
            if ($parts.Length -lt 2) {
                [void]$warnings.Add("registry key '$verName' under ${keyPath}: not a major.minor version, skipped")
                return
            }
            $major = 0; $minor = 0
            if (-not [int]::TryParse($parts[0], [ref]$major)) {
                [void]$warnings.Add("registry key '$verName': major not int, skipped")
                return
            }
            if (-not [int]::TryParse($parts[1], [ref]$minor)) {
                [void]$warnings.Add("registry key '$verName': minor not int, skipped")
                return
            }

            $win64 = Join-Path -Path $installedDir -ChildPath 'Engine\Binaries\Win64'
            if (-not (Test-Path -LiteralPath $win64)) {
                # Stub registry entry (e.g. Epic Games Launcher placeholder).
                # Skip silently - emitting a warning per stub clutters output
                # on hosts with the launcher installed but no engines.
                return
            }

            $cliExe = Join-Path -Path $win64 -ChildPath 'zen.exe'
            $srvExe = Join-Path -Path $win64 -ChildPath 'zenserver.exe'
            $verFile = Join-Path -Path $win64 -ChildPath 'zen.version'

            # InTree uses the same single zen.version file (shared).
            $sharedVersion = Read-VersionFile -Path $verFile

            $cliRec = $null
            if (Test-Path -LiteralPath $cliExe) {
                $sha = $null
                try { $sha = Get-Sha256Lower -Path $cliExe } catch {
                    [void]$warnings.Add("UE_$verName zen.exe sha256 failed: $($_.Exception.Message)")
                }
                $cliRec = @{ path = $cliExe; version = $sharedVersion; sha256 = $sha }
            } else {
                [void]$warnings.Add("UE_$verName zen.exe missing: $cliExe")
            }

            $srvRec = $null
            if (Test-Path -LiteralPath $srvExe) {
                $sha = $null
                try { $sha = Get-Sha256Lower -Path $srvExe } catch {
                    [void]$warnings.Add("UE_$verName zenserver.exe sha256 failed: $($_.Exception.Message)")
                }
                $srvRec = @{ path = $srvExe; version = $sharedVersion; sha256 = $sha }
            } else {
                [void]$warnings.Add("UE_$verName zenserver.exe missing: $srvExe")
            }

            if ($null -ne $sharedVersion -or $null -ne $cliRec -or $null -ne $srvRec) {
                # Only emit an InTree entry if at least one piece of evidence
                # exists (version file OR a binary). Pure-stub keys produce
                # nothing.
                [void]$intreeList.Add(@{
                    ue_major = $major
                    ue_minor = $minor
                    ue_install_path = $installedDir
                    zen_cli = $cliRec
                    zenserver = $srvRec
                })
            }
        }
    }

    # Dedup InTree entries by (major, minor, install_path). Both registry
    # views (native + WOW6432Node) usually surface the same engines, and we
    # don't want duplicates downstream. Last write wins; in practice both
    # views point at the same files so the records are identical.
    $deduped = @{}
    foreach ($entry in $intreeList) {
        $k = "{0}.{1}|{2}" -f $entry.ue_major, $entry.ue_minor, $entry.ue_install_path
        $deduped[$k] = $entry
    }
    $finalIntree = @($deduped.Values)

    $payload = @{
        ok = $true
        install = $installRecord
        intree = $finalIntree
        warnings = @($warnings)
    }
    $payload | ConvertTo-Json -Compress -Depth 10
}
catch {
    # Keep exit code 0 so the JSON envelope reaches the Rust caller via
    # winrm::invoke_json. The `ok` flag in JSON is the source of truth.
    @{ ok = $false; message = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
    exit 0
}
