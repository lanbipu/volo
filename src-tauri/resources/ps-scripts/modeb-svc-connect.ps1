param([string]$ConfigFile = 'C:\ProgramData\UECM\modeb-targets.json')

# Mode B (managed) WORKER — cmdkey + net use in the INTERACTIVE user's session.
# Driven by prepare-managed-share-client.ps1 (OnLogon + immediate verify tasks).
#
# Uses SERVER\ddc-svc (not bare ddc-svc) so remote SMB auth succeeds.
# net use with explicit password avoids cmdkey-only paths that fail to map drives.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$statusDir = 'C:\ProgramData\UECM\status'
$base = 'C:\ProgramData\UECM'

try {
    $cfg = Get-Content -LiteralPath $ConfigFile -Raw -ErrorAction Stop | ConvertFrom-Json
    $targets = @($cfg.TargetUncs | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $cmdkeyTargets = @($cfg.CmdkeyTargets | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $serverName = [string]$cfg.SvcServerName
    $user = [string]$cfg.SvcUsername
    $key = [string]$cfg.Key
    $secretFile = [string]$cfg.SecretFile
} catch {
    $targets = @(); $cmdkeyTargets = @(); $serverName = ''; $user = ''; $key = ''; $secretFile = ''
}

function Connect-Managed([string]$unc) {
    $qualified = "$serverName\$user"
    $pass = (Get-Content -LiteralPath $secretFile -Raw -ErrorAction SilentlyContinue).Trim()
    if ([string]::IsNullOrEmpty($pass)) {
        return [ordered]@{ unc = $unc; code = 1; testpath = $false; netuse = 'secret file missing' }
    }
    foreach ($t in $cmdkeyTargets) {
        cmd.exe /c "cmdkey /add:$t /user:$qualified /pass:$pass" 2>&1 | Out-Null
    }
    cmd.exe /c "net use `"$unc`" /delete /y" 2>&1 | Out-Null
    $out = ((cmd.exe /c "net use `"$unc`" `"$pass`" /user:$qualified /persistent:no" 2>&1) | Out-String).Trim()
    $code = $LASTEXITCODE
    return [ordered]@{ unc = $unc; code = $code; testpath = [bool](Test-Path -LiteralPath $unc); netuse = $out }
}

$r = [ordered]@{}
$r['whoami'] = (whoami)
$r['ts'] = (Get-Date).ToString('o')
$sid = ([System.Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
$r['sid'] = $sid
$r['conn'] = @()
$r['ok'] = $false

New-Item -ItemType Directory -Path $statusDir -Force | Out-Null
$statusFile = Join-Path $statusDir ("modeb-$sid-$key.json")

if ($targets.Count -gt 0 -and -not [string]::IsNullOrWhiteSpace($serverName)) {
    $primary = Connect-Managed $targets[0]
    $r['conn'] += $primary
    $r['ok'] = (($primary.code -eq 0) -and $primary.testpath)
    if ($r['ok']) {
        try {
            $f = Join-Path $targets[0] ('__volo_' + ([guid]::NewGuid().ToString('N').Substring(0, 8)) + '.tmp')
            Set-Content -LiteralPath $f -Value 'volo' -ErrorAction Stop
            Remove-Item -LiteralPath $f -Force -ErrorAction Stop
            $r['write'] = 'OK'
        } catch {
            $r['write'] = "read-only or no-write: $($_.Exception.Message)"
        }
    }
    ($r | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath $statusFile -Encoding UTF8
    foreach ($u in @($targets | Select-Object -Skip 1)) {
        $r['conn'] += (Connect-Managed $u)
    }
    ($r | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath $statusFile -Encoding UTF8
} else {
    ($r | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath $statusFile -Encoding UTF8
}
