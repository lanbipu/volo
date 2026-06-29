param([string]$TargetsFile = 'C:\ProgramData\UECM\modea-targets.json')

# Mode A (open/guest) WORKER — establishes a passwordless guest SMB session to
# each target UNC, then writes a per-SID status file.
#
# Runs IN a logged-on user's interactive session (scheduled task, InteractiveToken)
# or as SYSTEM (PsExec -s). Driven by prepare-open-share-client.ps1, which writes
# the per-share target list to -TargetsFile and registers the tasks.
#
# Uses `net use ... "" /user:<host>\Guest` — NOT cmdkey. `cmdkey /add /pass:`
# (blank) PROMPTS for a password in a non-interactive task and hangs forever;
# `net use` with an explicit empty password does not prompt. Validated Win11 25H2.
#
# /persistent:no — the OnLogon task re-establishes the session every logon, so a
# persistent (auto-restored) mapping is unnecessary and only invites the
# "could not reconnect all network drives" popup when the host is briefly offline.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$statusDir = 'C:\ProgramData\UECM\status'
try {
    $targets = @((Get-Content -LiteralPath $TargetsFile -Raw -ErrorAction Stop | ConvertFrom-Json).TargetUncs | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
} catch {
    $targets = @()
}

function Connect-Guest([string]$u) {
    $h = if ($u -match '^\\\\([^\\]+)\\') { $Matches[1] } else { $u }
    cmd.exe /c "net use `"$u`" /delete /y" 2>&1 | Out-Null
    $out = ((cmd.exe /c "net use `"$u`" `"`" /user:$h\Guest /persistent:no" 2>&1) | Out-String).Trim()
    $code = $LASTEXITCODE
    return [ordered]@{ unc = $u; code = $code; testpath = [bool](Test-Path -LiteralPath $u); netuse = $out }
}

# Status file is keyed per-user AND per-share (primary host) so concurrent
# prepares for different shares by the same user never collide on one file.
$key = ''
if ($targets.Count -gt 0 -and $targets[0] -match '^\\\\([^\\]+)\\') { $key = ($Matches[1] -replace '[^A-Za-z0-9]', '_') }

$r = [ordered]@{}
$r['whoami'] = (whoami)
$r['ts'] = (Get-Date).ToString('o')
$sid = ([System.Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
$r['sid'] = $sid
$r['conn'] = @()
$r['ok'] = $false

New-Item -ItemType Directory -Path $statusDir -Force | Out-Null
$statusFile = Join-Path $statusDir ("modea-$sid-$key.json")

if ($targets.Count -gt 0) {
    # PRIMARY first (targets[0] = the host UE uses via UE-SharedDataCachePath).
    # Gate success on the net use exit code AND reachability, then write status
    # EARLY — so the orchestrator never waits on a slow/unreachable SECONDARY
    # variant before learning the primary already came up.
    $primary = Connect-Guest $targets[0]
    $r['conn'] += $primary
    $r['ok'] = (($primary.code -eq 0) -and $primary.testpath)
    if ($r['ok']) {
        # Write probe is advisory: a guest share can legitimately be read-only for
        # consumers, so a write failure is recorded but does NOT fail verification.
        try {
            $f = Join-Path $targets[0] ('__volo_' + ([guid]::NewGuid().ToString('N').Substring(0, 8)) + '.tmp')
            Set-Content -LiteralPath $f -Value 'volo' -ErrorAction Stop
            $null = Get-Content -LiteralPath $f -Raw -ErrorAction Stop
            Remove-Item -LiteralPath $f -Force -ErrorAction Stop
            $r['write'] = 'OK'
        } catch {
            $r['write'] = "read-only or no-write: $($_.Exception.Message)"
        }
    }
    ($r | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath $statusFile -Encoding UTF8

    # SECONDARY variants — best-effort, AFTER status is written.
    foreach ($u in @($targets | Select-Object -Skip 1)) {
        $r['conn'] += (Connect-Guest $u)
    }
    ($r | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath $statusFile -Encoding UTF8
} else {
    ($r | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath $statusFile -Encoding UTF8
}
