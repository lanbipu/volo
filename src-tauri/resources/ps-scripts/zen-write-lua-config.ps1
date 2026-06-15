# Plan 7 T2.4 sidecar - write zen Lua config file.
#
# Purpose:
#   Write a pre-rendered Lua config text (produced by core::zen::lua_config on
#   the Rust side) to a destination path on this Windows host. The caller is
#   responsible for rendering the Lua body; this script only writes bytes and
#   reports a SHA256 so the Rust side can verify the file landed intact.
#
# Parameters:
#   -LuaText  <string>  literal Lua config text (already rendered).
#   -DestPath <string>  absolute Windows path to write to (e.g.
#                       %LOCALAPPDATA%\UnrealEngine\Common\Zen\Install\zen.lua).
#
# Output (single JSON object on stdout):
#   {
#     "ok": true,
#     "path": "C:\\...\\zen.lua",
#     "bytes_written": 1234,
#     "sha256": "<lowercase hex>"
#   }
#
# Safety:
#   - DestPath is rejected if it lies under C:\Windows, C:\Program Files, or
#     C:\Program Files (x86). The T2.8 datadir guard owns the canonical list;
#     this is defense in depth so a misconfigured caller can't drop a Lua
#     payload into a system location.
#   - File is written UTF-8 *without* BOM via [System.IO.File]::WriteAllText
#     (Set-Content emits a BOM by default - zen's Lua parser tolerates it but
#     the Rust-side hash should match the rendered string exactly).
#
# Rust parser: core::zen::lua_config::parse_write_response (T2.5).
#
# Usage:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File zen-write-lua-config.ps1 `
#       -LuaText "..." -DestPath "C:\Users\me\AppData\Local\UnrealEngine\Common\Zen\Install\zen.lua"

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 | Out-Null

$ErrorActionPreference = 'Stop'

try {
    $p = [Console]::In.ReadToEnd() | ConvertFrom-Json
    if ($null -eq $p.LuaText) { throw "LuaText is required" }
    if ([string]::IsNullOrWhiteSpace($p.DestPath)) { throw "DestPath is required" }
    $LuaText = $p.LuaText
    $DestPath = $p.DestPath
    # --- Validate DestPath is absolute and not under a system location -------
    if ([string]::IsNullOrWhiteSpace($DestPath)) {
        throw "DestPath must be a non-empty absolute path"
    }
    # `IsPathRooted` accepts drive-relative paths like `C:zen.lua` and
    # root-relative paths like `\Temp\zen.lua`. Both would be resolved by
    # `GetFullPath` against whatever the remote PowerShell session's
    # current location happens to be — non-deterministic. Require a
    # fully-qualified path: `<letter>:\...` or `\\<host>\<share>\...`.
    $destTrim = $DestPath.Trim()
    if ($destTrim -match '^\\\\[\?\.]\\' -or $destTrim -match '^//[\?\.]/') {
        throw "DestPath must not use Win32 device namespace prefixes (\\?\\ / \\.\\); got: $DestPath"
    }
    $isDriveAbsolute = $destTrim -match '^[A-Za-z]:[\\/]'
    $isUnc = $destTrim.StartsWith('\\') -or $destTrim.StartsWith('//')
    if (-not ($isDriveAbsolute -or $isUnc)) {
        throw ("DestPath must be a fully-qualified absolute path " +
               "(e.g. 'C:\Zen\zen.lua' or '\\host\share\zen.lua'); " +
               "drive-relative or root-relative paths are not accepted. Got: $DestPath")
    }

    $normalized = [System.IO.Path]::GetFullPath($destTrim)
    # Compare with and without trailing slash so the exact system root
    # itself is rejected too, not just child paths.
    $lower = $normalized.TrimEnd('\').ToLowerInvariant()

    $forbiddenRoots = @(
        'c:\windows',
        'c:\program files',
        'c:\program files (x86)'
    )
    foreach ($root in $forbiddenRoots) {
        if ($lower -eq $root -or $lower.StartsWith($root + '\')) {
            throw "DestPath '$normalized' is under a forbidden system location ($root)"
        }
    }

    # --- Ensure parent directory exists --------------------------------------
    $parent = [System.IO.Path]::GetDirectoryName($normalized)
    if ([string]::IsNullOrEmpty($parent)) {
        throw "DestPath '$normalized' has no parent directory"
    }
    if (-not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }

    # --- Write UTF-8 NO BOM --------------------------------------------------
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($normalized, $LuaText, $utf8NoBom)

    # --- Hash + size readback ------------------------------------------------
    $info = Get-Item -LiteralPath $normalized -ErrorAction Stop
    $bytesWritten = [int64]$info.Length

    $hash = Get-FileHash -LiteralPath $normalized -Algorithm SHA256 -ErrorAction Stop
    $sha = $hash.Hash.ToLowerInvariant()

    $payload = @{
        ok = $true
        path = $normalized
        bytes_written = $bytesWritten
        sha256 = $sha
    }
    $payload | ConvertTo-Json -Compress -Depth 4
}
catch {
    # Keep exit 0 so the JSON envelope reaches winrm::invoke_json.
    @{ ok = $false; message = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
    exit 0
}
