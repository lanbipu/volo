# Plan 7 T3.4 sidecar - delete a Windows environment variable at the
# requested scope(s).
#
# Purpose:
#   `zen enable` strips the legacy SMB-shared DDC path
#   (`UE-SharedDataCachePath` by default) from BOTH the Machine and User
#   scope on the target host. Clearing only one scope leaves the legacy
#   path reactivated when UE re-reads the environment block — operators
#   typically set the var via `setx` (no /M flag), which writes to User
#   scope, while UECM's existing `setx-machine.ps1` writes to Machine
#   scope. Either origin must be wiped to fully disable the legacy path.
#
# Parameters:
#   -Name   <string>  env var name (e.g. "UE-SharedDataCachePath").
#   -Scopes <string[]> one or more of "machine" / "user" (case-insensitive).
#                     Default: "machine","user".
#
# Output (single JSON object on stdout):
#   {
#     "ok": true,
#     "name": "UE-SharedDataCachePath",
#     "scopes": [
#       { "scope": "Machine", "was_present": true,  "previous_value": "\\\\nas\\Docs\\DDC", "cleared": true },
#       { "scope": "User",    "was_present": false, "previous_value": null,                 "cleared": false }
#     ]
#   }
#
#   `cleared` reports whether the var existed before this call AND was
#   removed by it. `was_present=false` means there was nothing to clean
#   (idempotent no-op for that scope).
#
# Rust parser: core::zen::env_cleanup::parse_response (T3.7).
#
# Usage:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass `
#       -File zen-env-cleanup.ps1 -Name "UE-SharedDataCachePath"
#   powershell.exe -NoProfile -ExecutionPolicy Bypass `
#       -File zen-env-cleanup.ps1 -Name "UE-SharedDataCachePath" -Scopes "machine"
#
# Security:
#   Machine-scope deletion needs administrator rights. The script does
#   NOT escalate — if the caller's session lacks privilege, the matching
#   scope entry returns `cleared=false` with `error="access denied: ..."`
#   and the script's overall `ok` flag stays `true` so the operator can
#   still process whichever scope succeeded. Set `-Scopes "user"` for
#   non-admin contexts.

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 | Out-Null

$ErrorActionPreference = 'Stop'

function Normalize-Scope {
    param([string]$Raw)
    switch -Regex ($Raw.Trim().ToLowerInvariant()) {
        '^machine$' { return 'Machine' }
        '^user$'    { return 'User' }
        default     { return $null }
    }
}

try {
    $p = [Console]::In.ReadLine() | ConvertFrom-Json
    if ([string]::IsNullOrWhiteSpace($p.Name)) { throw "Name is required" }
    $Name = $p.Name
    $Scopes = if ($null -ne $p.Scopes) { $p.Scopes } else { @('machine', 'user') }
    if ([string]::IsNullOrWhiteSpace($Name)) {
        throw "Name must be non-empty"
    }
    # Reject env var names that PowerShell or .NET would silently mangle.
    # The legitimate use case here is `UE-SharedDataCachePath` (letters,
    # digits, underscore, hyphen). Wildcard / control chars are refused
    # so a typo can't accidentally wipe unrelated vars via
    # SetEnvironmentVariable's broader matching rules (defense in depth —
    # .NET itself doesn't actually wildcard, but the sidecar should
    # refuse anything that looks suspicious).
    if ($Name -match '[\*\?\[\]]' -or $Name -match '[\x00-\x1f]') {
        throw "Name must not contain wildcards or control characters, got: $Name"
    }

    $normalized = New-Object System.Collections.ArrayList
    foreach ($s in $Scopes) {
        $n = Normalize-Scope -Raw $s
        if ($null -eq $n) {
            throw "Unknown scope '$s' — expected 'machine' or 'user'"
        }
        # Skip duplicates so `-Scopes machine,Machine` doesn't double-process.
        if (-not $normalized.Contains($n)) {
            [void]$normalized.Add($n)
        }
    }
    if ($normalized.Count -eq 0) {
        throw "At least one scope is required"
    }

    $results = New-Object System.Collections.ArrayList
    foreach ($scope in $normalized) {
        $previous = $null
        $wasPresent = $false
        $cleared = $false
        $errorMsg = $null
        try {
            $previous = [System.Environment]::GetEnvironmentVariable($Name, $scope)
            # Codex P3: an env var SET to an empty string still exists in
            # the registry and triggers the empty-var health warning. Only
            # `$null` means "absent" — `IsNullOrEmpty` would skip cleanup
            # for an already-empty-but-present var.
            $wasPresent = $null -ne $previous
            if ($wasPresent) {
                # Passing `$null` as the value deletes the variable per
                # .NET docs. Verify the readback to catch silent failures
                # (rare but possible if another process re-sets it mid-call).
                # Per codex P3, an empty-string previous_value is still a
                # legitimate cleanup target, so we accept `$null` readback
                # as success (var no longer exists) but reject `''`
                # readback (var still exists, just empty).
                [System.Environment]::SetEnvironmentVariable($Name, $null, $scope)
                $readback = [System.Environment]::GetEnvironmentVariable($Name, $scope)
                if ($null -eq $readback) {
                    $cleared = $true
                } else {
                    $errorMsg = "verify failed: var still present after delete (readback='$readback')"
                }
            }
            # else: was_present=false, cleared=false — idempotent no-op.
        } catch {
            $errorMsg = $_.Exception.Message
        }

        $entry = @{
            scope = $scope
            was_present = $wasPresent
            previous_value = $previous
            cleared = $cleared
        }
        if ($null -ne $errorMsg) {
            $entry['error'] = $errorMsg
        }
        [void]$results.Add($entry)
    }

    $payload = @{
        ok = $true
        name = $Name
        scopes = @($results)
    }
    $payload | ConvertTo-Json -Compress -Depth 5
}
catch {
    @{ ok = $false; message = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
    exit 0
}
