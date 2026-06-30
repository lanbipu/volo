param([string]$ConfigFile = 'C:\ProgramData\UECM\modeb-disconnect.json')

# Mode B (managed) WORKER (teardown) — undo modeb-svc-connect.ps1 IN the
# INTERACTIVE user's session.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$statusDir = 'C:\ProgramData\UECM\status'
$base = 'C:\ProgramData\UECM'

function Write-DebugLog([string]$msg, [hashtable]$data) {
    # #region agent log
    try {
        $line = (@{ sessionId = 'fb81f3'; hypothesisId = 'H2'; location = 'modeb-svc-disconnect.ps1'; message = $msg; data = $data; timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress)
        Add-Content -LiteralPath (Join-Path $base 'volo-debug-fb81f3.log') -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue
    } catch {}
    # #endregion
}

function Get-CmdkeyTargetsMatching([string[]]$needles) {
    $out = @()
    $raw = (cmdkey /list 2>&1 | Out-String)
    $current = $null
    foreach ($line in ($raw -split "`r?`n")) {
        if ($line -match '^\s*Target:\s*(.+)$') {
            $current = $Matches[1].Trim()
        } elseif ($line -match '^\s*$' -and $current) {
            foreach ($n in $needles) {
                if ($n -and ($current -match [regex]::Escape($n))) {
                    $out += $current
                    break
                }
            }
            $current = $null
        }
    }
    if ($current) {
        foreach ($n in $needles) {
            if ($n -and ($current -match [regex]::Escape($n))) { $out += $current }
        }
    }
    @($out | Select-Object -Unique)
}

function Get-ServerNeedles([string[]]$extra, [string[]]$targets) {
    $set = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($t in $extra) { if ($t) { [void]$set.Add($t.Trim()) } }
    foreach ($u in $targets) {
        if ($u -match '^\\\\([^\\]+)\\') { [void]$set.Add($Matches[1]) }
    }
    @($set)
}

function Remove-SmbConnectionsForServers([string[]]$needles, [System.Collections.Generic.List[string]]$removed) {
    if (-not (Get-Command Get-SmbConnection -ErrorAction SilentlyContinue)) { return }
    $conns = @(Get-SmbConnection -ErrorAction SilentlyContinue | Where-Object {
        $server = $_.ServerName
        foreach ($n in $needles) { if ($n -and $server -ieq $n) { return $true } }
        $false
    })
    foreach ($c in $conns) {
        $unc = "\\$($c.ServerName)\$($c.ShareName)"
        if (Get-Command Remove-SmbMapping -ErrorAction SilentlyContinue) {
            Remove-SmbMapping -RemotePath $unc -Force -UpdateProfile -ErrorAction SilentlyContinue
            $removed.Add("Remove-SmbMapping $unc") | Out-Null
        }
        cmd.exe /c "net use `"$unc`" /delete /y" 2>&1 | Out-Null
        $removed.Add("net use $unc") | Out-Null
    }
}

try {
    $cfg = Get-Content -LiteralPath $ConfigFile -Raw -ErrorAction Stop | ConvertFrom-Json
    $targets = @($cfg.TargetUncs | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $cmdkeyTargets = @($cfg.CmdkeyTargets | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $key = [string]$cfg.Key
} catch {
    $targets = @(); $cmdkeyTargets = @(); $key = ''
}

$needles = @($cmdkeyTargets + $targets)
Write-DebugLog 'disconnect_start' @{ whoami = (whoami); targetCount = $targets.Count; needles = $needles }

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

$allCmdkey = @($cmdkeyTargets + (Get-CmdkeyTargetsMatching $needles))
foreach ($t in @($allCmdkey | Select-Object -Unique)) {
    if ([string]::IsNullOrWhiteSpace($t)) { continue }
    cmd.exe /c "cmdkey /delete:`"$t`"" 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        cmd.exe /c "cmdkey /delete:$t" 2>&1 | Out-Null
    }
    $r['removed'] += "cmdkey $t"
}

$serverNeedles = @(Get-ServerNeedles $cmdkeyTargets $targets)
Remove-SmbConnectionsForServers $serverNeedles ([System.Collections.Generic.List[string]]$r['removed'])

foreach ($u in $targets) {
    if (Test-Path -LiteralPath $u -ErrorAction SilentlyContinue) {
        $r['reachable_after'] += $u
    }
}

if ($r['reachable_after'].Count -gt 0) {
    try {
        Restart-Service -Name LanmanWorkstation -Force -ErrorAction Stop
        $r['removed'] += 'Restart-Service LanmanWorkstation'
        Start-Sleep -Seconds 2
        $r['reachable_after'] = @()
        foreach ($u in $targets) {
            if (Test-Path -LiteralPath $u -ErrorAction SilentlyContinue) {
                $r['reachable_after'] += $u
            }
        }
    } catch {
        $r['removed'] += "Restart-Service failed: $($_.Exception.Message)"
    }
}

$r['ok'] = ($r['reachable_after'].Count -eq 0)
Write-DebugLog 'disconnect_done' @{ ok = $r['ok']; before = $r['reachable_before']; after = $r['reachable_after']; removedCount = $r['removed'].Count }

New-Item -ItemType Directory -Path $statusDir -Force | Out-Null
$statusFile = Join-Path $statusDir ("modeb-disc-$sid-$key.json")
($r | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath $statusFile -Encoding UTF8
