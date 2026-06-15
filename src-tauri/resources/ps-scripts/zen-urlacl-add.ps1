# Plan 7 T2.4 sidecar - add a URL ACL reservation for zen.
#
# Purpose:
#   Register an HTTP.sys URL reservation so the zen service account can bind
#   the given URL prefix without admin rights at runtime. Wraps:
#       netsh http add urlacl url=<UrlPrefix> user=<UserAccount>
#
# Parameters:
#   -UrlPrefix   <string>  the URL prefix to reserve, e.g.
#                          "http://+:8558/" or "https://*:8559/".
#   -UserAccount <string>  the principal that may bind the prefix, e.g.
#                          "DOMAIN\zenrunner" or "NT SERVICE\ZenServer".
#
# Output (single JSON object on stdout):
#   {
#     "ok": true,
#     "url": "http://+:8558/",
#     "user": "NT SERVICE\\ZenServer",
#     "already_exists": false        # true iff netsh said the URL is reserved
#   }
#
# Error envelope (still exit 0 - JSON ok flag is source of truth):
#   {
#     "ok": false,
#     "message": "netsh failed: ...",
#     "netsh_stdout": "...",
#     "netsh_stderr": "..."
#   }
#
# Rust parser: core::zen::urlacl::parse_add_response (T2.5).
#
# Usage:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File zen-urlacl-add.ps1 `
#       -UrlPrefix "http://+:8558/" -UserAccount "NT SERVICE\ZenServer"

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 | Out-Null

$ErrorActionPreference = 'Stop'

try {
    $p = [Console]::In.ReadToEnd() | ConvertFrom-Json
    if ([string]::IsNullOrWhiteSpace($p.UrlPrefix)) { throw "UrlPrefix is required" }
    if ([string]::IsNullOrWhiteSpace($p.UserAccount)) { throw "UserAccount is required" }
    $UrlPrefix = $p.UrlPrefix
    $UserAccount = $p.UserAccount
    if ([string]::IsNullOrWhiteSpace($UrlPrefix)) {
        throw "UrlPrefix must be non-empty"
    }
    if ([string]::IsNullOrWhiteSpace($UserAccount)) {
        throw "UserAccount must be non-empty"
    }

    # Use the call operator with separate string args so PowerShell's argument
    # quoting handles space-containing principals correctly. Start-Process
    # `-ArgumentList` would flatten the array and `NT SERVICE\ZenServer` would
    # hit netsh as two tokens (`user=NT` + `SERVICE\ZenServer`), making the
    # reservation either fail or land on the wrong account.
    $urlArg  = "url=$UrlPrefix"
    $userArg = "user=$UserAccount"

    # Capture both streams via the `2>&1` redirection operator. `netsh.exe`
    # writes its real error text to stdout in most locales, so a single
    # combined stream is what we want for the already-exists / conflict
    # detection below.
    $combined = (& netsh.exe http add urlacl $urlArg $userArg 2>&1 | Out-String)
    $exitCode = [int]$LASTEXITCODE
    if ($null -eq $combined) { $combined = '' }

    # netsh emits localized "URL reservation already exists" / "already reserved"
    # strings. Match the English variants and Win32 error 183
    # (ERROR_ALREADY_EXISTS). Do NOT match 1789 (ERROR_TRUSTED_DOMAIN_FAILURE):
    # that's an account/SID resolution failure, not an existing reservation.
    # If we treated it as already-exists, the urlacl add would silently
    # report ok=true while no reservation was actually created.
    $alreadyExists = $false
    if ($combined -match 'already\s+reserved' -or
        $combined -match 'already\s+exists' -or
        $combined -match 'Error:\s*183') {
        $alreadyExists = $true
    }

    # If the URL is already reserved, verify the existing owner matches the
    # requested principal. If a *different* account owns it, returning ok=true
    # would mislead the caller into thinking its service account has bind
    # rights — the subsequent service bind would then fail at runtime with a
    # confusing "access denied". `netsh http show urlacl url=<prefix>` echoes
    # the owning principal so we can compare.
    #
    # If `show urlacl` succeeds but the owner line can't be parsed (localized
    # Windows output, format drift), fail closed — treating an unparseable
    # owner as a "match" would leak the same access-denied scenario we're
    # trying to prevent.
    $existingOwner = $null
    $existingListen = $null
    $ownerLookupAttempted = $false
    $showOutput = ''
    if ($alreadyExists) {
        $ownerLookupAttempted = $true
        $showOutput = (& netsh.exe http show urlacl url=$UrlPrefix 2>&1 | Out-String)
        if ($showOutput -match 'User:\s*(.+?)\r?\n') {
            $existingOwner = $matches[1].Trim()
        }
        # Listen: Yes | No — required for the principal to actually bind
        # the prefix. A reservation with the right owner but Listen=No is
        # still effectively useless to zen.
        if ($showOutput -match 'Listen:\s*(Yes|No)\b') {
            $existingListen = $matches[1].Trim()
        }
    }

    # Compare principals by SID, not string.  Windows built-in accounts
    # have multiple name forms that resolve to the same SID:
    #   "NT AUTHORITY\LocalService" vs "NT AUTHORITY\LOCAL SERVICE"
    # A naive -ieq comparison would treat these as different principals and
    # falsely report a conflict. Translating both to SID handles all aliases.
    function Test-SamePrincipal ($a, $b) {
        if ($a -ieq $b) { return $true }
        try {
            $sidA = ([System.Security.Principal.NTAccount]$a).Translate(
                [System.Security.Principal.SecurityIdentifier]).Value
            $sidB = ([System.Security.Principal.NTAccount]$b).Translate(
                [System.Security.Principal.SecurityIdentifier]).Value
            return ($sidA -eq $sidB)
        } catch {
            return $false
        }
    }

    if ($alreadyExists -and $ownerLookupAttempted -and $null -eq $existingOwner) {
        @{
            ok = $false
            message = ("URL reservation already exists but the owning principal could not be " +
                       "determined from `netsh http show urlacl` output (likely a localized " +
                       "Windows locale). Cannot safely confirm requested user has bind rights. " +
                       "Remove the existing reservation first or run from an English-locale shell.")
            url = $UrlPrefix
            requested_user = $UserAccount
            netsh_show_output = $showOutput
            netsh_combined = $combined
        } | ConvertTo-Json -Compress -Depth 4
        exit 0
    }

    if ($alreadyExists -and $null -ne $existingOwner -and
        -not (Test-SamePrincipal $existingOwner $UserAccount)) {
        @{
            ok = $false
            message = ("URL reservation already exists but is owned by '{0}', not '{1}'. " +
                       "Remove the existing reservation first or change the requested principal.") `
                      -f $existingOwner, $UserAccount
            url = $UrlPrefix
            existing_owner = $existingOwner
            requested_user = $UserAccount
            netsh_combined = $combined
        } | ConvertTo-Json -Compress -Depth 4
        exit 0
    }

    # Owner matches BUT Listen=No
    if ($alreadyExists -and $null -ne $existingOwner -and
        (Test-SamePrincipal $existingOwner $UserAccount) -and
        $null -ne $existingListen -and $existingListen -ieq 'No') {
        @{
            ok = $false
            message = ("URL reservation exists for the requested user '{0}' but Listen=No. " +
                       "zen will be unable to bind. Remove and re-add the reservation, " +
                       "or fix the Listen flag manually.") -f $UserAccount
            url = $UrlPrefix
            existing_owner = $existingOwner
            existing_listen = $existingListen
            requested_user = $UserAccount
            netsh_combined = $combined
        } | ConvertTo-Json -Compress -Depth 4
        exit 0
    }

    if ($exitCode -ne 0 -and -not $alreadyExists) {
        @{
            ok = $false
            message = "netsh http add urlacl failed (exit $exitCode)"
            netsh_combined = $combined
        } | ConvertTo-Json -Compress -Depth 4
        exit 0
    }

    $payload = @{
        ok = $true
        url = $UrlPrefix
        user = $UserAccount
        already_exists = $alreadyExists
    }
    $payload | ConvertTo-Json -Compress -Depth 4
}
catch {
    @{ ok = $false; message = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
    exit 0
}
