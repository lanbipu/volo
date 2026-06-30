param([string]$ConfigFile = 'C:\ProgramData\UECM\modea-disconnect.json')

# Mode A (open/guest) WORKER (teardown) — undo modea-guest-connect.ps1 IN the
# INTERACTIVE user's session. The SSH-driven unprepare runs as uecm-svc (network
# logon, Type 3) and cannot drop the /persistent:no guest net use the worker
# created in the desktop user's own logon session, so that live mapping survives
# a plain SSH teardown until the user next logs off. This worker, launched by an
# Interactive scheduled task, deletes it from inside the user's session.
# No cmdkey to clear: Mode A guest auth never wrote one (see modea-guest-connect.ps1).
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$statusDir = 'C:\ProgramData\UECM\status'

try {
    $cfg = Get-Content -LiteralPath $ConfigFile -Raw -ErrorAction Stop | ConvertFrom-Json
    $targets = @($cfg.TargetUncs | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $key = [string]$cfg.Key
} catch {
    $targets = @(); $key = ''
}

$r = [ordered]@{}
$r['whoami'] = (whoami)
$r['ts'] = (Get-Date).ToString('o')
$sid = ([System.Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
$r['sid'] = $sid
$r['removed'] = @()

foreach ($u in $targets) {
    cmd.exe /c "net use `"$u`" /delete /y" 2>&1 | Out-Null
    $r['removed'] += "net use $u"
}
$r['ok'] = $true

New-Item -ItemType Directory -Path $statusDir -Force | Out-Null
$statusFile = Join-Path $statusDir ("modea-disc-$sid-$key.json")
($r | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath $statusFile -Encoding UTF8
