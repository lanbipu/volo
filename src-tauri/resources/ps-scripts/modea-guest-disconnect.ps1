param([string]$ConfigFile = 'C:\ProgramData\UECM\modea-disconnect.json')

# Mode A (open/guest) WORKER (teardown) — undo modea-guest-connect.ps1 IN the
# INTERACTIVE user's session.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$statusDir = 'C:\ProgramData\UECM\status'
$base = 'C:\ProgramData\UECM'

function Write-DebugLog([string]$msg, [hashtable]$data) {
    # #region agent log
    try {
        $line = (@{ sessionId = 'fb81f3'; hypothesisId = 'H2'; location = 'modea-guest-disconnect.ps1'; message = $msg; data = $data; timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress)
        Add-Content -LiteralPath (Join-Path $base 'volo-debug-fb81f3.log') -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue
    } catch {}
    # #endregion
}

try {
    $cfg = Get-Content -LiteralPath $ConfigFile -Raw -ErrorAction Stop | ConvertFrom-Json
    $targets = @($cfg.TargetUncs | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $key = [string]$cfg.Key
} catch {
    $targets = @(); $key = ''
}

Write-DebugLog 'disconnect_start' @{ whoami = (whoami); targetCount = $targets.Count }

$r = [ordered]@{}
$r['whoami'] = (whoami)
$r['ts'] = (Get-Date).ToString('o')
$sid = ([System.Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
$r['sid'] = $sid
$r['removed'] = @()
$r['reachable_before'] = @()
$r['reachable_after'] = @()

foreach ($u in $targets) {
    if (Test-Path -LiteralPath $u -ErrorAction SilentlyContinue) {
        $r['reachable_before'] += $u
    }
}

foreach ($u in $targets) {
    cmd.exe /c "net use `"$u`" /delete /y" 2>&1 | Out-Null
    $r['removed'] += "net use $u"
}
cmd.exe /c "net use * /delete /y" 2>&1 | Out-Null
$r['removed'] += 'net use *'

if (Get-Command Get-SmbMapping -ErrorAction SilentlyContinue) {
    foreach ($u in $targets) {
        Get-SmbMapping -RemotePath $u -ErrorAction SilentlyContinue |
            Remove-SmbMapping -Force -UpdateProfile -ErrorAction SilentlyContinue
        $r['removed'] += "Remove-SmbMapping $u"
    }
}

foreach ($u in $targets) {
    if (Test-Path -LiteralPath $u -ErrorAction SilentlyContinue) {
        $r['reachable_after'] += $u
    }
}

$r['ok'] = ($r['reachable_after'].Count -eq 0)
Write-DebugLog 'disconnect_done' @{ ok = $r['ok']; before = $r['reachable_before']; after = $r['reachable_after'] }

New-Item -ItemType Directory -Path $statusDir -Force | Out-Null
$statusFile = Join-Path $statusDir ("modea-disc-$sid-$key.json")
($r | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath $statusFile -Encoding UTF8
