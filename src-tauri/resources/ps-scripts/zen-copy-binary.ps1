# Copies zen.exe + zenserver.exe from wherever `zen detect-binary` found them
# (SourceDir — typically the UE-intree Engine\Binaries\Win64, or an existing
# install-copy) into the operator-chosen {ZenInstall} directory
# (core::zen::ops::resolve_install_paths / ResolvedZenPaths.needs_copy).
#
# Only these two files are copied — NOT the whole SourceDir, which for the
# intree case is the engine's entire Binaries\Win64 folder (many GB of
# unrelated binaries). zen-service-install.ps1 always derives zenserver.exe
# as zen.exe's sibling (Normalize-ZenExe), so both must land side by side in
# TargetDir for `--config=` + `sc create` to find them.
#
# Known limitation: if a Windows service is currently running zenserver.exe
# from TargetDir (a re-apply on an already-installed endpoint), the copy of
# zenserver.exe will fail with a file-in-use error — this script does not
# stop the service first. Re-run after `zen service stop`.
#
# Parameters (stdin JSON):
#   SourceDir <string>  directory containing zen.exe / zenserver.exe today.
#   TargetDir <string>  {ZenInstall} destination directory (created if missing).
#
# Output (single JSON object on stdout):
#   { "ok": true, "copied": ["zen.exe", "zenserver.exe"], "target_dir": "..." }
#   { "ok": false, "message": "..." }

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 | Out-Null

$ErrorActionPreference = 'Stop'

try {
    $p = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $SourceDir = $p.SourceDir
    $TargetDir = $p.TargetDir
    if ([string]::IsNullOrWhiteSpace($SourceDir)) {
        @{ ok = $false; message = "SourceDir is required" } | ConvertTo-Json -Compress
        exit 0
    }
    if ([string]::IsNullOrWhiteSpace($TargetDir)) {
        @{ ok = $false; message = "TargetDir is required" } | ConvertTo-Json -Compress
        exit 0
    }
    if (-not (Test-Path -LiteralPath $SourceDir -PathType Container)) {
        @{ ok = $false; message = "SourceDir not found: $SourceDir" } | ConvertTo-Json -Compress
        exit 0
    }

    $sourceFull = [System.IO.Path]::GetFullPath($SourceDir).TrimEnd('\')
    $targetFull = [System.IO.Path]::GetFullPath($TargetDir).TrimEnd('\')

    $copied = @()
    if ($sourceFull -ieq $targetFull) {
        # Already the same directory — nothing to do (defense in depth; the
        # Rust caller already gates this via ResolvedZenPaths.needs_copy).
        @{ ok = $true; copied = $copied; target_dir = $targetFull } | ConvertTo-Json -Compress
        exit 0
    }

    if (-not (Test-Path -LiteralPath $targetFull -PathType Container)) {
        New-Item -ItemType Directory -Path $targetFull -Force | Out-Null
    }

    foreach ($name in @('zen.exe', 'zenserver.exe')) {
        $src = Join-Path $sourceFull $name
        if (Test-Path -LiteralPath $src -PathType Leaf) {
            Copy-Item -LiteralPath $src -Destination (Join-Path $targetFull $name) -Force
            $copied += $name
        }
    }

    if (-not (Test-Path -LiteralPath (Join-Path $targetFull 'zenserver.exe') -PathType Leaf)) {
        @{
            ok = $false
            message = "zenserver.exe not found in SourceDir ($sourceFull) after copy — cannot install the service without it"
        } | ConvertTo-Json -Compress
        exit 0
    }

    @{ ok = $true; copied = $copied; target_dir = $targetFull } | ConvertTo-Json -Compress
}
catch {
    @{ ok = $false; message = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
    exit 0
}
