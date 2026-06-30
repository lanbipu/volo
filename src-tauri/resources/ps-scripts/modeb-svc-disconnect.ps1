param([string]$ConfigFile = 'C:\ProgramData\UECM\modeb-disconnect.json')

# Mode B (managed) WORKER (teardown) — undo modeb-svc-connect.ps1 IN the
# INTERACTIVE user's session. The SSH-driven unprepare runs as uecm-svc (network
# logon, Type 3) and cannot reach the desktop user's credential vault, so the
# cmdkey entries + /persistent net use that modeb-svc-connect.ps1 created there
# survive a plain SSH teardown. This worker, launched by an Interactive scheduled
# task, deletes them from inside the user's own session.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$statusDir = 'C:\ProgramData\UECM\status'

try {
    $cfg = Get-Content -LiteralPath $ConfigFile -Raw -ErrorAction Stop | ConvertFrom-Json
    $targets = @($cfg.TargetUncs | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $cmdkeyTargets = @($cfg.CmdkeyTargets | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $key = [string]$cfg.Key
} catch {
    $targets = @(); $cmdkeyTargets = @(); $key = ''
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
foreach ($t in $cmdkeyTargets) {
    cmd.exe /c "cmdkey /delete:$t" 2>&1 | Out-Null
    $r['removed'] += "cmdkey $t"
}
$r['ok'] = $true

New-Item -ItemType Directory -Path $statusDir -Force | Out-Null
$statusFile = Join-Path $statusDir ("modeb-disc-$sid-$key.json")
($r | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath $statusFile -Encoding UTF8
