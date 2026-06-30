# Mode A (open/guest) CLIENT teardown — undo what prepare-open-share-client.ps1 did
# for ONE share, so leaving / tearing down a share stops the client auto-reconnecting
# to a (possibly decommissioned) host at every logon.
#
# Removes the per-share targets file + both scheduled tasks (keyed on the primary
# UNC host), and drops any live guest net use sessions to the share UNCs — both in
# the SSH/SYSTEM contexts AND, via an Interactive scheduled task, in the console
# user's own session (where the /persistent:no guest mapping otherwise lingers
# until logoff). Mirrors the Mode B teardown; no cmdkey (Mode A never wrote one).
#
# stdin: JSON { "TargetUncs": ["\\\\HOST\\Share", "\\\\10.0.0.1\\Share"] }
# Output: JSON { ok, message }
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; chcp 65001 | Out-Null
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Get-UncHost([string]$u) {
    if ($u -match '^\\\\([^\\]+)\\') { return $Matches[1] } else { return $null }
}

try {
    $p = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $targets = @($p.TargetUncs | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if (-not $targets.Count) { throw 'TargetUncs is required (at least one \\HOST\Share UNC)' }

    $base = 'C:\ProgramData\UECM'
    $primaryHost = Get-UncHost $targets[0]
    if (-not $primaryHost) { throw "cannot parse host from primary UNC '$($targets[0])'" }
    $key = ($primaryHost -replace '[^A-Za-z0-9]', '_')

    $steps = New-Object System.Collections.Generic.List[string]

    # 1) Interactive cleanup — drop the desktop user's live guest net use from
    #    inside their own session (SSH/SYSTEM below can't reach that logon).
    $worker = Join-Path $PSScriptRoot 'modea-guest-disconnect.ps1'
    $discConfig = Join-Path $base ("modea-disconnect-$key.json")
    $taskDiscNow = "UECM-ModeA-Disc-$key-Now"
    $consoleUser = (Get-CimInstance Win32_ComputerSystem).UserName
    $discDone = $false
    if ((Test-Path -LiteralPath $worker) -and -not [string]::IsNullOrWhiteSpace($consoleUser)) {
        try {
            @{ TargetUncs = $targets; Key = $key } |
                ConvertTo-Json -Compress | Set-Content -LiteralPath $discConfig -Encoding UTF8
            $sid = (New-Object System.Security.Principal.NTAccount($consoleUser)).Translate([System.Security.Principal.SecurityIdentifier]).Value
            $statusDir = Join-Path $base 'status'
            New-Item -ItemType Directory -Path $statusDir -Force | Out-Null
            $statusFile = Join-Path $statusDir "modea-disc-$sid-$key.json"
            Remove-Item -LiteralPath $statusFile -Force -ErrorAction SilentlyContinue
            $workerArg = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$worker`" -ConfigFile `"$discConfig`""
            $actN = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $workerArg
            $prnN = New-ScheduledTaskPrincipal -UserId $consoleUser -LogonType Interactive -RunLevel Limited
            Register-ScheduledTask -TaskName $taskDiscNow -Action $actN -Principal $prnN -Force | Out-Null
            Start-ScheduledTask -TaskName $taskDiscNow
            $deadline = (Get-Date).AddSeconds(30)
            while ((Get-Date) -lt $deadline) {
                Start-Sleep -Milliseconds 1500
                if (Test-Path -LiteralPath $statusFile) { break }
            }
            if (Test-Path -LiteralPath $statusFile) {
                $steps.Add("interactive $consoleUser cleaned") | Out-Null
                # Verified done — safe to drop the one-shot task + its config.
                Unregister-ScheduledTask -TaskName $taskDiscNow -Confirm:$false -ErrorAction SilentlyContinue
                $discDone = $true
            } else {
                # Slow worker — leave the task AND $discConfig so it can still
                # finish (mirrors prepare's "DON'T tear down a possibly-running
                # worker"). -Force replaces it on the next teardown.
                $steps.Add('interactive cleanup deferred (no status within timeout)') | Out-Null
            }
        } catch {
            $steps.Add("interactive cleanup skipped: $($_.Exception.Message)") | Out-Null
            Unregister-ScheduledTask -TaskName $taskDiscNow -Confirm:$false -ErrorAction SilentlyContinue
        }
    } else {
        $steps.Add('no console user / worker missing; live guest session left to expire at logoff') | Out-Null
    }

    # 2) Remove the prepare-side tasks so nothing reconnects at logon.
    foreach ($t in @("UECM-ModeA-Guest-$key-Now", "UECM-ModeA-Guest-$key")) {
        if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) {
            Unregister-ScheduledTask -TaskName $t -Confirm:$false -ErrorAction SilentlyContinue
            $steps.Add("removed task $t") | Out-Null
        }
    }

    # Keep $discConfig if a deferred worker may still be reading it (step 1).
    $cleanupFiles = @((Join-Path $base ("modea-targets-$key.json")))
    if ($discDone) { $cleanupFiles += $discConfig }
    foreach ($f in $cleanupFiles) {
        if (Test-Path -LiteralPath $f) {
            Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue
            $steps.Add("removed $([System.IO.Path]::GetFileName($f))") | Out-Null
        }
    }

    # Drop live guest sessions (uecm-svc context here; SYSTEM via PsExec). The
    # interactive user's current /persistent:no session dies at next logoff and,
    # with the OnLogon task gone, is never recreated.
    $psexec = Join-Path $base 'PsExec64.exe'
    $eap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    foreach ($u in $targets) {
        cmd.exe /c "net use `"$u`" /delete /y" 2>&1 | Out-Null
        if (Test-Path -LiteralPath $psexec) {
            & $psexec -accepteula -nobanner -s cmd.exe /c "net use `"$u`" /delete /y >nul 2>&1" 2>&1 | Out-Null
        }
    }
    $ErrorActionPreference = $eap
    $steps.Add('net use sessions removed') | Out-Null

    @{ ok = $true; message = ($steps -join '; ') } | ConvertTo-Json -Compress
}
catch {
    @{ ok = $false; message = $_.Exception.Message } | ConvertTo-Json -Compress
    exit 1
}
